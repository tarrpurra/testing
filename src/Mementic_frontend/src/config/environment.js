// environment.ts (or .js)

const NETWORK = import.meta.env?.VITE_NETWORK || 'ic'; // 'local' | 'ic' | 'mainnet' | 'playground'
const CANISTER_ID = 'g3bm6-baaaa-aaaaa-qcexq-cai';

export const isDevMode = () => {
  // Check if we're on mainnet by looking at the hostname or environment
  if (typeof window !== 'undefined') {
    return window.location.hostname.includes('localhost') ||
           window.location.hostname === '127.0.0.1' ||
           import.meta.env?.DEV === 'false' ||
           import.meta.env?.VITE_NETWORK === 'local';
  }
  return import.meta.env?.DEV === 'true' || import.meta.env?.VITE_NETWORK === 'local';
};

// Agent host: must match the page origin for delegation verification
export const getAgentHost = () => {
  if (import.meta.env?.VITE_AGENT_HOST) return import.meta.env.VITE_AGENT_HOST;

  // In development, default to local replica if not provided
  if (isDevMode()) {
    return "http://127.0.0.1:4943";
  }

  // Fallback for production
  return "https://icp-api.io";
};

// Internet Identity provider
export const getIdentityProvider = () => {
  if (import.meta.env.VITE_INTERNET_IDENTITY_HOST) {
    return import.meta.env.VITE_INTERNET_IDENTITY_HOST;
  }
  // For local development, use local Internet Identity canister
  if (isDevMode()) {
    return "http://127.0.0.1:4943/?canisterId=rdmx6-jaaaa-aaaaa-aaadq-cai";
  }

  // Use Internet Identity 2.0 with Google support for production
  return "https://id.ai/";
};

// Export canister id
export const Id =
  import.meta.env?.CANISTER_ID_MEMENTIC_BACKEND ||
  CANISTER_ID;

// Debug logs
console.log("All environment variables:", import.meta.env);
console.log("Final configuration:", {
  Id,
  agentHost: getAgentHost(),
  identityProvider: getIdentityProvider(),
  isDevMode: isDevMode(),
  network: NETWORK,
  VITE_CANISTER_ID_MEMENTIC_BACKEND: import.meta.env.VITE_CANISTER_ID_MEMENTIC_BACKEND,
  CANISTER_ID_MEMENTIC_BACKEND: import.meta.env.CANISTER_ID_MEMENTIC_BACKEND
});

// Helpers and optional bundled object
export const getCanisterId = () => Id;

export const hasBackendCanisterId = () =>
  Boolean(
      import.meta.env?.CANISTER_ID_MEMENTIC_BACKEND
  );

export const hasFrontendCanisterId = () =>
  Boolean(
      import.meta.env?.CANISTER_ID_MEMENTIC_FRONTEND
  );

export const config = {
  isDevMode: isDevMode(),
  agentHost: getAgentHost(),
  identityProvider: getIdentityProvider(),
  Id,
};
