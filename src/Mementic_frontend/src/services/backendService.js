import { Actor, HttpAgent} from "@dfinity/agent";
import { AuthClient } from "@dfinity/auth-client";
import { Principal } from "@dfinity/principal";
import { idlFactory } from "../../../declarations/mementic_backend";
import { getAgentHost, getIdentityProvider, isDevMode, Id } from "../config/environment";

// Disable noisy logs in production/runtime
if (typeof console !== "undefined" && typeof console.log === "function") {
  try { console.log = () => {}; } catch {}
}

/**
 * Backend Service for Mementic
 * Handles IC canister communication, authentication, and meme operations
 */
class BackendService {
  constructor() {
    this.agent = null;
    this.actor = null;
    this.authClient = null;
    this.isAuthenticated = false;
    this.initialized = false;
    this._initPromise = null;
  }

  /**
   * Current week status: { weekId, remainingNs, endTimeNs, isCompleted }
   */
  async getCurrentWeekStatus() {
    // Backend returns a tuple: (u64, u64, u64, bool)
    const tuple = await this._safeCall('get_current_week_status');
    if (!Array.isArray(tuple) || tuple.length < 4) {
      return { weekId: null, remainingNs: 0, endTimeNs: 0, isCompleted: false };
    }
    const [weekId, remainingNs, endTimeNs, isCompleted] = tuple;
    return {
      weekId: Number(weekId),
      remainingNs: Number(remainingNs),
      endTimeNs: Number(endTimeNs),
      isCompleted: Boolean(isCompleted),
    };
  }

  /**
   * Get previous week id for filtering
   */
  async getPreviousWeekId() {
    const result = await this._safeCall('get_previous_week_id');
    return result == null ? null : Number(result);
  }

  /**
   * Initialize the backend service
   */
  async initialize() {
    if (this.initialized) return true;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._initializeService();
    return this._initPromise.finally(() => (this._initPromise = null));
  }

  async _initializeService() {
    try {
      // Check if declarations are available
      if (!idlFactory || !Id) {
        throw new Error("Backend declarations not available. Please check your build configuration.");
      }

      // Check if storage is available (important for incognito/private browsing)
      const isStorageAvailable = this._checkStorageAvailability();
      if (!isStorageAvailable) {
        console.warn("Storage is not available (possibly incognito mode). Authentication will be limited.");
        // Create a minimal auth client that won't try to access storage
        this.authClient = {
          login: () => Promise.reject(new Error("Storage not available. Please disable incognito/private browsing mode.")),
          logout: () => Promise.resolve(),
          isAuthenticated: () => Promise.resolve(false),
          getIdentity: () => ({ getPrincipal: () => ({ toText: () => "2vxsx-fae" }) }),
        };
      } else {
        // Create auth client normally - allow it to restore identity from storage
        this.authClient = await AuthClient.create();
      }

      // Check if user is already authenticated (restored from storage)
      if (isStorageAvailable) {
        const isAlreadyAuth = await this.authClient.isAuthenticated();
        console.log("Checking for stored authentication:", isAlreadyAuth);

        if (isAlreadyAuth) {
          console.log("Found stored authentication, setting up authenticated agent");
          await this._setupAuthenticatedAgent();
        } else {
          console.log("No stored authentication found, skipping agent setup");
          this.isAuthenticated = false;
        }
      } else {
        console.log("Storage not available, skipping agent setup");
        this.isAuthenticated = false;
      }

      this.initialized = true;
      return true;
    } catch (error) {
      console.error("Backend service initialization failed:", error);
      // If it's a storage-related error, provide a more helpful message
      if (error.message && (error.message.includes('anchor_number') || error.message.includes('storage'))) {
        throw new Error("Authentication failed: Storage access is required. Please disable incognito/private browsing mode and try again.");
      }
      // If it's a declarations error, provide a helpful message
      if (error.message && error.message.includes('declarations')) {
        throw new Error("Backend configuration error. Please check that the canister is properly deployed and declarations are generated.");
      }
      throw error;
    }
  }

  /**
    * Ensure service is ready before making calls
    */
   async ensureReady() {
     // If already initialized and have an actor, we're ready
     if (this.initialized && this.actor) return true;

     // Initialize if needed
     if (!this.initialized) {
       await this.initialize();
     }

     // If still no actor (likely not authenticated), set up anonymous actor
     if (!this.actor) {
       try {
         await this._setupAnonymousAgent();
       } catch (e) {
         console.warn("Failed to set up anonymous agent:", e);
         throw e;
       }
     }

     return true;
   }

  /**
   * Check if localStorage and sessionStorage are available
   * This is important for incognito/private browsing modes
   */
  _checkStorageAvailability() {
    try {
      const testKey = '__storage_test__';
      localStorage.setItem(testKey, 'test');
      localStorage.removeItem(testKey);
      sessionStorage.setItem(testKey, 'test');
      sessionStorage.removeItem(testKey);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Create a properly configured agent for development
    */
   async _createAgent(identity = null) {
     console.log("Creating agent with host:", getAgentHost());
     console.log("Development mode:", isDevMode());

     // Determine the identity to use
     let finalIdentity = identity;
     if (!finalIdentity) {
       finalIdentity = this.authClient.getIdentity();
       console.log("Using anonymous identity:", finalIdentity.getPrincipal().toString());
     } else {
       console.log("Using provided identity:", finalIdentity.getPrincipal().toString());
     }

     const agentOptions = {
       host: getAgentHost(),
       identity: finalIdentity,
     };
     console.log("Agent options:", agentOptions);

     // Create the agent
     const agent = new HttpAgent(agentOptions);

     // CRITICAL: For development, we must fetch the root key
     if (isDevMode()) {
       console.log("Fetching root key for local development...");
       try {
         await agent.fetchRootKey();
         console.log("Root key fetched successfully");

         // Verify the agent configuration
         console.log("Agent configuration:", {
           identity: finalIdentity ? finalIdentity.getPrincipal().toString() : "anonymous",
           host: agent._host || agent.host,
           verifyQuerySignatures: agent._verifyQuerySignatures,
           rootKeyPresent: !!agent.rootKey,
           rootKeyLength: agent.rootKey?.byteLength || 0
         });

       } catch (error) {
         console.error("Root key fetch failed:", error);
         // In development, this is usually fatal
         throw new Error(`Root key fetch failed: ${error.message}`);
       }
     } else {
       console.log("Production mode: using mainnet certificates");
     }

     return agent;
   }

  /**
   * Setup authenticated agent with user identity
   */
  async _setupAuthenticatedAgent() {
    if (!idlFactory || !Id) {
      throw new Error("Backend service not properly configured");
    }

    console.log("Setting up authenticated agent");
    const identity = this.authClient.getIdentity();
    const principalText = identity.getPrincipal().toText();
    console.log("Identity principal:", principalText);

    // Verify this is not an anonymous identity
    if (principalText === "2vxsx-fae") {
      console.log("Anonymous identity detected, not setting up agent");
      this.isAuthenticated = false;
      return;
    }

    this.agent = await this._createAgent(identity);

    console.log("Creating authenticated actor with canisterId:", Id);
    this.actor = Actor.createActor(idlFactory, {
      agent: this.agent,
      canisterId: Id,
      identity
    });

    console.log("Authenticated agent setup complete");
    this.isAuthenticated = true;
  }

  /**
   * Setup anonymous agent for queries
   */
  async _setupAnonymousAgent() {
    if (!idlFactory || !Id) {
      throw new Error("Backend service not properly configured");
    }

    console.log("Setting up anonymous agent");

    this.agent = await this._createAgent();

    console.log("Creating anonymous actor with canisterId:", Id);
    this.actor = Actor.createActor(idlFactory, {
      agent: this.agent,
      canisterId: Id,
    });

    console.log("Anonymous agent setup complete");
    this.isAuthenticated = false;
  }

  async useExternalAgent(agent) {
    if (!agent) {
      throw new Error("An agent instance is required to use an external identity");
    }

    if (!idlFactory || !Id) {
      throw new Error("Backend service not properly configured");
    }

    console.log("Attaching external agent to backend service");
    this.agent = agent;
    this.actor = Actor.createActor(idlFactory, {
      agent,
      canisterId: Id,
    });
    this.isAuthenticated = true;
    this.initialized = true;
  }

  async resetToAnonymous() {
    console.log("Resetting backend service to anonymous mode");
    this.agent = null;
    this.actor = null;
    this.isAuthenticated = false;
    this.initialized = false;
    this.authClient = null;
    this._initPromise = null;
    // Don't initialize immediately, let ensureReady handle it when needed
  }

  /* ============ AUTHENTICATION METHODS ============ */

  /**
     * Login with Internet Identity
     */
  async login() {
    await this.ensureReady();

    // Check if storage is available
    if (!this._checkStorageAvailability()) {
      throw new Error("Storage not available. Please disable incognito/private browsing mode to login.");
    }

    // Use existing AuthClient or create new one for login
    if (!this.authClient) {
      try {
        this.authClient = await AuthClient.create();
        console.log("Created AuthClient for login");
      } catch (error) {
        console.error("Failed to create AuthClient:", error);
        throw error;
      }
    }

    return new Promise((resolve, reject) => {
      this.authClient.login({
        identityProvider: getIdentityProvider(),
        // Ensure delegation includes the backend canister
        delegationTargets: [Id],
        // Set derivation origin to current site to align with agent host/origin
        derivationOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
        maxTimeToLive: BigInt(30 * 24 * 60 * 60 * 1000 * 1000 * 1000), // 30 days
        windowOpenerFeatures: "toolbar=0,location=0,menubar=0,width=500,height=500,left=100,top=100",
        onSuccess: async () => {
          try {
            console.log("Login successful, setting up authenticated agent...");
            await this._setupAuthenticatedAgent();
            resolve(true);
          } catch (error) {
            console.error("Authenticated agent setup failed:", error);
            reject(error);
          }
        },
        onError: (error) => {
          console.error("Login failed:", error);
          if (error === "UserInterrupt") {
            reject(new Error("Login was cancelled. Please allow popups and try again."));
          } else {
            reject(new Error(`Login failed: ${error}`));
          }
        },
      });
    });
  }

  /**
    * Logout user
    */
  async logout() {
    await this.ensureReady();

    // Clear the stored identity and invalidate the current session
    if (this.authClient) {
      await this.authClient.logout();

      // Force clear any stored identity data
      try {
        // Clear localStorage entries related to Internet Identity
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.includes('internet_identity') || key.includes('authClient') || key.includes('delegation'))) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));

        // Clear sessionStorage as well
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key && (key.includes('internet_identity') || key.includes('authClient') || key.includes('delegation'))) {
            sessionStorage.removeItem(key);
          }
        }

        console.log("Cleared stored authentication data");
      } catch (error) {
        console.warn("Failed to clear stored auth data:", error);
      }
    }

    // Clear agent and actor - user must login again
    this.agent = null;
    this.actor = null;
    this.isAuthenticated = false;
    console.log("Logout complete - user must login to perform actions");
    return true;
  }

  /**
    * Check if user is authenticated
    */
  isUserAuthenticated() {
    return this.isAuthenticated;
  }

  /**
     * Debug authentication state
     */
  debugAuth() {
    return {
      isAuthenticated: this.isAuthenticated,
      actorInitialized: !!this.actor,
      authClientInitialized: !!this.authClient,
      canisterId: Id,
      agentHost: getAgentHost(),
      identityProvider: getIdentityProvider(),
      isDevMode: isDevMode(),
      storageAvailable: this._checkStorageAvailability(),
    };
  }

  /**
    * Get authentication status
    */
  async getAuthStatus() {
    await this.ensureReady();
    return {
      isAuthenticated: this.isAuthenticated,
      canisterId: Id,
    };
  }

  /* ============ SAFE CALL WRAPPER ============ */

  /**
   * Safe wrapper for canister calls with error handling and retries
   */
  async _safeCall(methodName, ...args) {
    const maxRetries = 2;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Calling ${methodName} (attempt ${attempt}/${maxRetries})`);
        
        // Ensure we're ready
        await this.ensureReady();
        
        const result = await this.actor[methodName](...args);
        console.log(`${methodName} succeeded on attempt ${attempt}`);
        return result;
        
      } catch (error) {
        console.error(`${methodName} failed on attempt ${attempt}:`, error);
        lastError = error;

        // If it's a certificate/signature error and we're in development, try recreating the agent
        if (error.message.includes('certificate') ||
            error.message.includes('signature') ||
            error.message.includes('verification') ||
            error.message.includes('delegation') ||
            error.message.includes('Invalid certificate')) {

          console.log(`Certificate/signature error on attempt ${attempt}:`, error.message);

          if (isDevMode() && attempt < maxRetries) {
            console.log("Recreating agent for local development...");
            try {
              // Force re-initialize the service
              this.initialized = false;
              this.agent = null;
              this.actor = null;
              await this.initialize();
              console.log("Agent recreated successfully, retrying call...");
            } catch (agentError) {
              console.error("Failed to recreate agent:", agentError);
              // Don't retry if agent recreation fails
              break;
            }
          } else if (!isDevMode()) {
            console.log("Certificate error in production - this might indicate network issues");
            // Don't retry certificate errors in production
            break;
          }
        }

        // Wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    throw lastError;
  }

  /* ============ MEME OPERATIONS ============ */

  /**
    * Generate a new meme
    */
  async generateMeme(prompt) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to generate memes");
    }
    const result = await this._safeCall('generate_meme', prompt);
    return this._unwrapResult(result, "generate_meme failed");
  }

  /**c
    * Get user's memes
    */
  async getUserMemes() {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to view your memes");
    }
    return await this._safeCall('get_user_memes');
  }

  /**
    * Get total number of memes
    */
  async getTotalMemes() {
    return await this._safeCall('get_total_memes');
  }

  /**
    * Get total number of users
    */
  async getTotalUsers() {
    return await this._safeCall('get_total_users');
  }

  /**
    * Get all memes for marketplace
    */
  async getAllMemes() {
    return await this._safeCall('get_all_memes');
  }

  /**
    * Get only memes that are listed for sale on the marketplace
    */
  async getMarketplaceMemes() {
    return await this._safeCall('get_marketplace_memes');
  }

  /**
   * List pre-market memes (non-finalized, current active week)
   */
  async listPremarketMemes(offset = 0, limit = 25) {
    // Backend API: list_memes_by_flag(week_ended: bool, offset: u32, limit: u32)
    // We pass week_ended = false to get current premarket memes
    const result = await this._safeCall('list_memes_by_flag', false, offset, limit);
    return Array.isArray(result) ? result : [];
  }

  /**
   * Get current weekly leaderboard snapshot with pagination
   */
  async getCurrentLeaderboard(offsetOrLimit = 0, maybeLimit = 50) {
    let offset = 0;
    let limit = 50;
    if (typeof offsetOrLimit === "number" && typeof maybeLimit === "number") {
      offset = offsetOrLimit;
      limit = maybeLimit;
    } else if (typeof offsetOrLimit === "number") {
      limit = offsetOrLimit;
    }
    const result = await this._safeCall('get_current_leaderboard', offset, limit);
    return Array.isArray(result) ? result : [];
  }

  /**
   * Get current weekly leaderboard with complete meme data (legacy function)
   */
  async getCurrentLeaderboardLegacy(limit = 10) {
    const limitOpt = typeof limit === "number" ? [limit] : [];
    return await this._safeCall('get_current_leaderboard_legacy', limitOpt);
  }

  /**
   * Retrieve a finalized leaderboard snapshot for a specific week
   */
  async getLeaderboardByWeek(weekId) {
    const result = await this._safeCall('get_leaderboard_by_week', weekId);
    return this._fromOpt(result);
  }

  /**
   * List archived weeks with finalized leaderboards
   */
  async listFinalizedWeeks(offset = 0, limit = 10) {
    const result = await this._safeCall('list_finalized_weeks', offset, limit);
    return Array.isArray(result) ? result : [];
  }

  /**
   * Get top liked memes across all weeks
   */
  async getTopLikedMemes(limit = 3) {
    const limitOpt = typeof limit === "number" ? [limit] : [];
    return await this._safeCall('get_top_liked_memes', limitOpt);
  }

  /**
   * Get total lifetime votes
   */
  async getLifetimeVotes() {
    return await this._safeCall('get_lifetime_votes');
  }

  /**
   * Get total memes in current week
   */
  async getCurrentWeekMemeCount() {
    return await this._safeCall('get_current_week_meme_count');
  }

  /**
    * Vote on a meme
    */
  async voteMeme(memeId, voteType) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to vote on memes");
    }
    const voteVariant = this._toVoteVariant(voteType);
    const result = await this._safeCall('vote_meme', memeId, voteVariant);
    return this._unwrapResult(result, "vote_meme failed");
  }

  /**
   * Get remaining weekly voting power for authenticated user
   * Graceful fallback to 100 if backend method not available.
   */
  async getVotingPower() {
    const fallback = { remaining: 100, cap: 100 };
    const toNumber = (value, defaultValue) => {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : defaultValue;
      }
      if (typeof value === 'bigint') {
        const max = BigInt(Number.MAX_SAFE_INTEGER);
        const bounded = value < BigInt(0) ? BigInt(0) : value > max ? max : value;
        return Number(bounded);
      }
      if (Array.isArray(value) && value.length > 0) {
        return toNumber(value[0], defaultValue);
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    };

    try {
      if (!this.actor || typeof this.actor['get_voting_power'] !== 'function') {
        return fallback;
      }

      const res = await this._safeCall('get_voting_power');

      if (typeof res === 'number') {
        return { ...fallback, remaining: toNumber(res, fallback.remaining) };
      }

      if (res && typeof res === 'object') {
        const remaining = toNumber(res.remaining, fallback.remaining);
        const cap = toNumber(res.cap, fallback.cap);
        return {
          remaining: Number.isFinite(remaining) ? remaining : fallback.remaining,
          cap: Number.isFinite(cap) && cap > 0 ? cap : fallback.cap,
        };
      }

      return fallback;
    } catch (e) {
      console.warn('get_voting_power failed, using default 100:', e);
      return fallback;
    }
  }

  /**
   * Vote with power cost enforcement on backend if available.
   * Falls back to vote_meme when new API is unavailable.
   */
  async voteWithPower(memeId, voteType, cost = 10) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to vote on memes");
    }
    const voteVariant = this._toVoteVariant(voteType);
    const normalizedCost = Math.max(1, Math.floor(Number(cost) || 0));
    try {
      if (this.actor && typeof this.actor['vote_with_power'] === 'function') {
        const result = await this._safeCall(
          'vote_with_power',
          memeId,
          voteVariant,
          BigInt(normalizedCost)
        );
        return this._unwrapResult(result, 'vote_with_power failed');
      }
    } catch (e) {
      console.warn('vote_with_power failed, falling back to vote_meme:', e);
    }
    // Fallback to legacy voting
    const result = await this._safeCall('vote_meme', memeId, voteVariant);
    return this._unwrapResult(result, 'vote_meme failed');
  }

  /**
    * Remove vote from a meme
    */
  async removeVote(memeId) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to remove votes");
    }
    const result = await this._safeCall('remove_vote', memeId);
    return this._unwrapResult(result, "remove_vote failed");
  }

  /**
   * Get specific meme by ID
   */
  async getMeme(memeId) {
    const result = await this._safeCall('get_meme', memeId);
    return this._fromOpt(result);
  }

  /**
     * Get meme votes
     */
  async getMemeVotes(memeId) {
    const result = await this._safeCall('get_meme_votes', memeId);
    return this._fromOpt(result);
  }

  /**
   * Retrieve mint entitlements for the authenticated user
   */
  async getMyMintEntitlements() {
    const result = await this._safeCall('get_my_mint_entitlements');
    return Array.isArray(result) ? result : [];
  }

  /**
   * Retrieve mint entitlements linked to a specific meme
   */
  async getEntitlementsForMeme(memeId) {
    const result = await this._safeCall('get_entitlements_for_meme', memeId);
    return Array.isArray(result) ? result : [];
  }

  /**
   * Winner notifications for the authenticated user
   */
  async getWinnerNotices() {
    const result = await this._safeCall('get_my_winner_notices');
    return Array.isArray(result) ? result : [];
  }

  /**
    * Check if a meme has been minted as NFT
    */
  async isMemeMinted(memeId) {
    try {
      const result = await this._safeCall('is_meme_minted', memeId);
      return Boolean(result);
    } catch (error) {
      console.warn(`isMemeMinted failed for ${memeId}:`, error);
      return false;
    }
  }

  /**
   * Retrieve all minted token IDs for a meme
   */
  async getMintedTokens(memeId) {
    const result = await this._safeCall('get_tokens_by_meme_id', memeId);
    return Array.isArray(result) ? result : [];
  }

  /**
   * Mint a top-ranked meme into an NFT (single or collection)
   */
  async mintMeme(memeId, mode = { type: "single" }) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to mint your meme as an NFT");
    }
    const candidMode = this._toMintingModeVariant(mode);
    const result = await this._safeCall('mint_to', memeId, candidMode);
    return this._unwrapResult(result, "mint_to failed");
  }

  /**
   * Fetch completed week periods
   */
  async getCompletedWeeks() {
    return await this._safeCall('get_completed_weeks');
  }

  /**
   * Fetch top 3 winners for a given week
   */
  async getTop3ForWeek(weekId) {
    const result = await this._safeCall('get_top3_for_week', weekId);
    return this._unwrapResult(result, "get_top3_for_week failed");
  }

  /**
   * Get the status for the active voting week
   */
  async getCurrentWeekStatus() {
    const result = await this._safeCall('get_current_week_status');
    if (!Array.isArray(result) || result.length < 4) {
      return {
        weekId: 0,
        remainingNs: 0,
        endTimeNs: 0,
        isCompleted: false,
      };
    }

    const [rawWeekId, rawRemaining, rawEndTime, completed] = result;
    const toNumber = (value) => {
      if (typeof value === 'bigint') {
        const max = BigInt(Number.MAX_SAFE_INTEGER);
        if (value > max) return Number.MAX_SAFE_INTEGER;
        if (value < BigInt(0)) return 0;
        return Number(value);
      }
      if (Array.isArray(value) && value.length) {
        return toNumber(value[0]);
      }
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    };

    return {
      weekId: toNumber(rawWeekId),
      remainingNs: toNumber(rawRemaining),
      endTimeNs: toNumber(rawEndTime),
      isCompleted: Boolean(completed),
    };
  }

  /**
    * Get user's vote on a specific meme
    */
  async getUserVote(memeId) {
    const result = await this._safeCall('get_user_vote', memeId);
    return this._fromOpt(result);
  }

  /**
     * Publish a meme to marketplace
     */
  async publishMeme(memeData) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to publish memes");
    }
    const result = await this._safeCall('publish_meme', memeData);
    return this._unwrapResult(result, "publish_meme failed");
  }

  /**
   * Force finalize current week for testing
   */
  async forceFinalizeCurrentWeek() {
    // Calls the admin update to immediately rollover/finalize the week if due
    const result = await this._safeCall('admin_rollover_now');
    // admin_rollover_now returns Option<week_id>; unwrap result is not needed
    return result;
  }

  /**
     * List a meme for sale
     */
  async listMemeForSale(memeId, options = {}) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to list memes");
    }

    const ensurePositive = (value, label) => {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        throw new Error(`${label} must be greater than zero`);
      }
      return num;
    };

    const explicitMode = (options.mode || options.type || options.listingType || "").toLowerCase();
    if (explicitMode.includes("auction")) {
      throw new Error(
        "Marketplace listings only support fixed prices. Launch auctions from the auction arena."
      );
    }

    const priceCandidate =
      options.price ?? options.listingPrice ?? options.amount ?? options.startingBid;
    const price = ensurePositive(priceCandidate, "Listing price");
    const priceE8s = BigInt(Math.round(price * 100000000));
    const strategy = { FixedPrice: { price_e8s: priceE8s } };

    const result = await this._safeCall('list_meme_for_sale', memeId, strategy);
    return this._unwrapResult(result, "list_meme_for_sale failed");
  }

  async startMemeAuction(memeId, options = {}) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to launch auctions");
    }

    const ensurePositive = (value, label) => {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        throw new Error(`${label} must be greater than zero`);
      }
      return num;
    };

    const startingBid = ensurePositive(
      options.startingBid ?? options.startPrice ?? options.price,
      "Starting bid"
    );
    const startE8s = BigInt(Math.round(startingBid * 100000000));
    const strategy = { Auction: { start_price_e8s: startE8s } };

    const result = await this._safeCall('list_meme_for_sale', memeId, strategy);
    return this._unwrapResult(result, "start_meme_auction failed");
  }

  /**
     * Remove meme from marketplace
     */
  async removeMemeFromMarket(memeId) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required: Please login to manage listings");
    }
    const result = await this._safeCall('remove_meme_from_market', memeId);
    return this._unwrapResult(result, "remove_meme_from_market failed");
  }

  /**
     * Record a meme sale
     */
  async recordMemeSale(memeId, salePriceE8s) {
    const result = await this._safeCall('record_meme_sale', memeId, salePriceE8s);
    return this._unwrapResult(result, "record_meme_sale failed");
  }

  /**
   * Get sale metadata for a meme (if minted)
   */
  async getSaleMetadataForMeme(memeId) {
    const result = await this._safeCall('get_sale_metadata_for_meme', memeId);
    return this._fromOpt(result);
  }

  /**
    * Increment view count for a meme
    */
  async incrementMemeViews(memeId) {
    try {
      const result = await this._safeCall('increment_meme_views', memeId);
      return this._unwrapResult(result, "increment_meme_views failed");
    } catch (error) {
      // Silently fail for view increments - not critical
      console.warn(`Failed to increment views for meme ${memeId}:`, error);
      return null;
    }
  }

  /* ============ FEEDBACK METHODS ============ */

  /**
    * Submit feedback
    */
  async submitFeedback(name, likes, dislikes, suggestions, willReturn) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required to submit feedback");
    }
    const result = await this._safeCall('submit_feedback', name, likes, dislikes, suggestions, willReturn);
    return this._unwrapResult(result, "submit_feedback failed");
  }

  /**
    * Get approved feedback for display
    */
  async getApprovedFeedback(limit = 10) {
    return await this._safeCall('get_approved_feedback', [limit]);
  }

  /**
   * Reset system to week 1 (admin function)
   */
  async resetSystemToWeek1() {
    const result = await this._safeCall('reset_system_to_week_1');
    return this._unwrapResult(result, "reset_system_to_week_1 failed");
  }
  async getAllFeedback() {
    return await this._safeCall('get_all_feedback');
  }

  /**
    * Get feedback statistics
    */
  async getFeedbackStats() {
    console.log("Getting feedback stats...");
    try {
      const result = await this._safeCall('get_feedback_stats');
      console.log("Feedback stats retrieved:", result);
      return result;
    } catch (error) {
      console.error("Failed to get feedback stats:", error);
      // Return default stats if the method fails
      return [0, 0, 0]; // [total_feedback, approved_count, approval_rate]
    }
  }

  /* ============ USER PROFILE METHODS ============ */

  /**
    * Update user profile
    */
  async updateUserProfile(username, displayName) {
    if (!this.isAuthenticated) {
      throw new Error("Authentication required to update profile");
    }
    const usernameOpt = username ? [username] : [];
    const displayNameOpt = displayName ? [displayName] : [];
    const result = await this._safeCall('update_user_profile', usernameOpt, displayNameOpt);
    return this._unwrapResult(result, "update_user_profile failed");
  }

  /**
    * Get user profile
    */
  async getUserProfile() {
    if (!this.isAuthenticated) {
      return null;
    }
    const result = await this._safeCall('get_user_profile');
    return this._fromOpt(result);
  }

  /**
    * Get user profile by principal
    */
  async getUserProfileByPrincipal(principalString) {
    try {
      const principal = Principal.fromText(principalString);
      const result = await this._safeCall('get_user_profile_by_principal', principal);
      return this._fromOpt(result);
    } catch (error) {
      console.warn(`Invalid principal string: ${principalString}`, error);
      return null;
    }
  }

  /* ============ UTILITY METHODS ============ */

  /**
   * Get remaining API calls
   */
  async getRemainingCalls() {
    return await this._safeCall('check_remaining_calls');
  }

  /**
   * Health check
   */
  async healthCheck() {
    console.log("Performing health check...");
    try {
      const result = await this._safeCall('health');
      console.log("Health check successful:", result);
      return result;
    } catch (error) {
      console.error("Health check failed:", error);
      throw error;
    }
  }

  /**
   * Test connection to canister
   */
  async testConnection() {
    try {
      console.log("Testing connection to canister...");
      console.log("Agent host:", this.agent?._host || this.agent?.host);
      console.log("Canister ID:", Id);
      console.log("Is development mode:", isDevMode());

      const result = await this.healthCheck();
      console.log("Connection test successful!");
      return { success: true, result };
    } catch (error) {
      console.error("Connection test failed:", error);
      return { success: false, error: error.message };
    }
  }

  /* ============ HELPER METHODS ============ */

  /**
   * Convert Candid optional to JavaScript value
   */
  _fromOpt(opt) {
    return Array.isArray(opt) && opt.length ? opt[0] : null;
  }

  /**
   * Unwrap Candid Result type
   */
  _unwrapResult(result, errorMessage = "Operation failed") {
    if (result && "Ok" in result) return result.Ok;
    const error = result?.Err ?? "Unknown error";
    throw new Error(`${errorMessage}: ${error}`);
  }

  /**
   * Convert vote type string to Candid variant
   */
  _toVoteVariant(voteType) {
    if (voteType && typeof voteType === "object") return voteType;
    if (voteType === "Upvote") return { Upvote: null };
    if (voteType === "Downvote") return { Downvote: null };
    throw new Error(`Invalid voteType: ${voteType} (expected "Upvote" or "Downvote")`);
  }

  _toMintingModeVariant(mode) {
    if (mode && typeof mode === "object" && ("Single" in mode || "Collection" in mode)) {
      return mode;
    }

    if (!mode || typeof mode !== "object") {
      throw new Error("Minting mode must be an object");
    }

    const normalized = (mode.type || mode.kind || "single").toString().toLowerCase();
    if (normalized === "single" || normalized === "1of1" || normalized === "one") {
      return { Single: null };
    }

    if (normalized === "collection" || normalized === "editions") {
      const editions = Number(mode.editions ?? mode.supply ?? 0);
      if (!Number.isInteger(editions) || editions <= 0) {
        throw new Error("Collection minting requires a positive integer edition count");
      }
      return { Collection: { editions } };
    }

    throw new Error(`Unsupported minting mode: ${JSON.stringify(mode)}`);
  }
}

/* ============ EXPORTS ============ */

const backendService = new BackendService();
export default backendService;

// Low-level accessors
export const getBackend = async () => {
  await backendService.ensureReady();
  return backendService.actor;
};

export const getNetwork = () =>
  window.location.hostname.includes("localhost") ||
  window.location.hostname.endsWith(".localhost")
    ? "local"
    : "ic";

// Test connection utility
export const testConnection = async () => {
  return await backendService.testConnection();
};