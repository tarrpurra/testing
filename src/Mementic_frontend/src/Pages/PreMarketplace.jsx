import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../hooks/use-toast";
import Navigation from "../components/Navigation";
import WeeklyLeaderboard from "../components/marketplace/WeeklyLeaderboard";
import MarketplaceFeed from "../components/marketplace/MarketplaceFeed";
import PreviewModal from "../components/marketplace/PreviewModal";
import backendService from "../services/backendService";
import useVotingPower from "../hooks/useVotingPower";
import { useMarketplaceData } from "../hooks/useMarketplaceData";
import { useMarketplaceVoting } from "../hooks/useMarketplaceVoting";
import { formatRemaining } from "../utils/marketplaceUtils";

const PreMarketplace = () => {
  const { principal, username, isLoading: authLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  // 3. Get profile name from username (safe versions)
  const sanitizedUsername = typeof username === "string" ? username.trim() : "";
  const safeHasProfileName = sanitizedUsername.length > 0;
  const safeIsAuthenticated = Boolean(isAuthenticated);

  // Add a console command for admin reset
  useEffect(() => {
    // Make reset function available in console for admin use
    if (typeof window !== 'undefined') {
      window.resetMementicSystem = async () => {
        try {
          console.log("Calling system reset...");
          const result = await backendService.resetSystemToWeek1();
          console.log("Reset result:", result);
          // Clear the cache to force refresh
          localStorage.removeItem('mementic::premarket::leaderboard');
          // Refresh the page to reload all data
          window.location.reload();
          return result;
        } catch (error) {
          console.error("Reset failed:", error);
          throw error;
        }
      };
      console.log("Admin command available: run resetMementicSystem() in console");
    }
  }, []);

  // UI State
  const [searchInput, setSearchInput] = useState("");
  const [sort, setSort] = useState("trending");
  const [selectedCreator, setSelectedCreator] = useState("all");
  const [page, setPage] = useState(1);

  // Debounce search
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      setSearchQuery(searchInput.trim());
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Custom hooks - moved after state variables to avoid temporal dead zone
  const {
    topMemes,
    memes,
    total,
    loadingTop,
    loadingList,
    errorMsg,
    setTopMemes,
    setMemes,
    currentWeekStatus,
  } = useMarketplaceData(safeIsAuthenticated, safeHasProfileName, page, sort, searchQuery);

  // Voting power
  const votingControls = useVotingPower();
  const { power: votingPower, WEEKLY_CAP, VOTE_COST } = votingControls;

  // Compute time left from backend-reported remainingNs (ns -> ms)
  const timeLeft = useMemo(() => {
    const ns = Number(currentWeekStatus?.remainingNs || 0);
    if (ns <= 0) {
      // Don't show "0d 0h 0m" - show loading state or appropriate message
      return "Loading...";
    }
    const ms = Math.floor(ns / 1_000_000);
    return formatRemaining(ms);
  }, [currentWeekStatus?.remainingNs]);

  // Treat week as completed only when backend reports it AND we're actually past the end time
  const weekCompleted = Boolean(currentWeekStatus?.isCompleted) &&
    Number(currentWeekStatus?.remainingNs || 0) <= 0;
  console.log('PreMarketplace: currentWeekStatus =', currentWeekStatus, 'weekCompleted =', weekCompleted);
  const activeMemes = memes;

  const {
    handleVote,
    checkMemeOwnership,
  } = useMarketplaceVoting(
    safeIsAuthenticated,
    safeHasProfileName,
    memes,
    setMemes,
    setTopMemes,
    votingControls
  );

  // Filter memes based on search query and creator
  const filteredMemes = useMemo(() => {
    let list = activeMemes;
    if (selectedCreator !== "all") {
      list = list.filter((meme) => meme.creator === selectedCreator);
    }
    if (!searchQuery.trim()) return list;
    const query = searchQuery.toLowerCase();
    return list.filter(
      (meme) =>
        (meme.title?.toLowerCase() ?? "").includes(query) ||
        (meme.caption?.toLowerCase() ?? "").includes(query) ||
        (meme.prompt?.toLowerCase() ?? "").includes(query)
    );
  }, [activeMemes, searchQuery, selectedCreator]);

  // Computed stats
  const totalVotes = useMemo(
    () => activeMemes.reduce((acc, meme) => acc + (meme?.votes || 0), 0),
    [activeMemes]
  );

  const totalViews = useMemo(
    () => activeMemes.reduce((acc, meme) => acc + (meme?.views || 0), 0),
    [activeMemes]
  );

  const listedCount = useMemo(
    () =>
      activeMemes.filter((meme) => {
        const sale = meme?.sale_metadata ?? meme?.market_data;
        return sale?.is_listed;
      }).length,
    [activeMemes]
  );

  const uniqueCreators = useMemo(() => {
    const creators = new Set();
    activeMemes.forEach((meme) => {
      if (meme?.creator) creators.add(meme.creator);
    });
    return creators.size;
  }, [activeMemes]);

  const creatorStats = useMemo(() => {
    const stats = new Map();
    activeMemes.forEach((meme) => {
      const creator = meme?.creator || "Anonymous";
      if (!stats.has(creator)) {
        stats.set(creator, { creator, count: 0, votes: 0 });
      }
      const entry = stats.get(creator);
      entry.count += 1;
      entry.votes += meme?.votes || 0;
    });
    return Array.from(stats.values())
      .sort((a, b) =>
        b.votes !== a.votes ? b.votes - a.votes : b.count - a.count
      )
      .slice(0, 6);
  }, [activeMemes]);

  const topTrending = useMemo(
    () => topMemes.filter(Boolean).slice(0, 3),
    [topMemes]
  );

  const shareOfTop = useMemo(() => {
    if (!totalVotes || topTrending.length === 0) return 0;
    const leadVotes = topTrending[0]?.votes || 0;
    return Math.round((leadVotes / totalVotes) * 100);
  }, [topTrending, totalVotes]);

  const sortOptions = useMemo(
    () => [
      {
        value: "trending",
        label: "Trending",
        icon: "TrendingUp",
        meta: `${totalVotes} votes`,
      },
      {
        value: "newest",
        label: "Newest",
        icon: "Sparkles",
        meta: `${activeMemes.length} drops`,
      },
      {
        value: "top",
        label: "Top Voted",
        icon: "Crown",
        meta: `${totalViews} views`,
      },
      {
        value: "listed",
        label: "Listed",
        icon: "Coins",
        meta: `${listedCount} live`,
      },
    ],
    [activeMemes.length, listedCount, totalViews, totalVotes]
  );

  const selectedCreatorLabel =
    selectedCreator === "all" ? "all creators" : selectedCreator;

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!safeIsAuthenticated) {
      toast({
        title: "Login required",
        description: "Sign in to access the marketplace.",
        variant: "destructive",
      });
      navigate("/login", {
        replace: true,
        state: { from: location.pathname },
      });
      return;
    }

    if (!safeHasProfileName) {
      toast({
        title: "Complete your profile",
        description: "Choose a username before exploring the marketplace.",
      });
      navigate("/portfolio", {
        replace: true,
        state: { from: location.pathname, requireUsername: true },
      });
    }
  }, [authLoading, safeHasProfileName, safeIsAuthenticated, location.pathname, navigate, toast]);

  // Add a console command for admin reset
  useEffect(() => {
    // Make reset function available in console for admin use
    if (typeof window !== 'undefined') {
      window.resetMementicSystem = async () => {
        try {
          console.log("Calling system reset...");
          const result = await backendService.resetSystemToWeek1();
          console.log("Reset result:", result);
          // Clear the cache to force refresh
          localStorage.removeItem('mementic::premarket::leaderboard');
          // Refresh the page to reload all data
          window.location.reload();
          return result;
        } catch (error) {
          console.error("Reset failed:", error);
          throw error;
        }
      };
      console.log("Admin command available: run resetMementicSystem() in console");
    }
  }, []);

  // Preview Modal State
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedMeme, setSelectedMeme] = useState(null);

  // Open preview modal
  const openPreview = (meme) => {
    setSelectedMeme(meme);
    setPreviewOpen(true);
  };

  const canLoadMore = memes.length < total;

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="mx-auto max-w-4xl px-6 py-24 text-center text-muted-foreground">
          Checking your session…
        </div>
      </div>
    );
  }

  if (!safeIsAuthenticated || !safeHasProfileName) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="mx-auto max-w-4xl px-6 py-24 text-center text-muted-foreground">
          Redirecting to login…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />

      <div className="w-screen flex flex-col gap-10 px-4 py-10 lg:px-6">
        <main className="w-full w- max-w-[200rem] space-y-6">
          {/* Voting power badge */}
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              Each vote uses <span className="font-semibold text-primary">{VOTE_COST}</span> voting power.
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              Voting Power: {Math.max(0, Number(votingPower ?? 0))}/{WEEKLY_CAP}
            </div>
          </div>
          {weekCompleted && (
            <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-6 text-center">
              <div className="flex items-center justify-center gap-3 mb-4">
                <div className="animate-spin h-8 w-8 border-2 border-amber-400 border-t-transparent rounded-full"></div>
                <h3 className="text-lg font-semibold text-amber-200">Voting ended</h3>
              </div>
              <p className="text-sm text-amber-200 mb-4">
                A new week will start in a moment. We’re finalizing winners and clearing the pre-marketplace.
              </p>
              <div className="bg-amber-500/20 rounded-lg p-4 border border-amber-400/30">
                <p className="text-xs text-amber-300">
                  ⏰ <strong>Next week starts soon!</strong> Be ready to submit your memes and vote on the latest drops.
                </p>
              </div>
            </div>
          )}
          <WeeklyLeaderboard
            timeLeft={timeLeft}
            onPreview={openPreview}
            isWeekCompleted={weekCompleted}
            externalTopMemes={topMemes}
            onTopMemesUpdate={setTopMemes}
          />

          <MarketplaceFeed
            memes={activeMemes}
            filteredMemes={filteredMemes}
            loadingList={loadingList}
            errorMsg={errorMsg}
            searchQuery={searchQuery}
            sort={sort}
            setSort={setSort}
            setPage={setPage}
            selectedCreator={selectedCreator}
            creatorStats={creatorStats}
            total={total}
            canLoadMore={canLoadMore}
            onVote={(id, votes, owner) => handleVote(id, votes, owner, principal)}
            onVoteSuccess={() => undefined}
            isAuthenticated={safeIsAuthenticated}
            currentUserPrincipal={principal}
            onOpenPreview={openPreview}
            setSelectedCreator={setSelectedCreator}
            onClearFilters={() => setSearchInput("")}
            isClearing={weekCompleted}
          />
        </main>

        <aside className="space-y-6">
        </aside>
      </div>

      <PreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        meme={selectedMeme}
        onLike={(id, votes, owner) => handleVote(id, votes, owner, principal)}
        isAuthenticated={safeIsAuthenticated}
        isOwn={selectedMeme ? checkMemeOwnership(selectedMeme, principal) : false}
        hasProfileName={safeHasProfileName}
      />
    </div>
  );
};

export default PreMarketplace;


