import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/Button";
import { Card, CardContent } from "../ui/Card";
import { Crown, User, Eye, Heart } from "lucide-react";
import { formatNumber, ensureArray, normalizeMeme, safeBigIntToNumber } from "../../utils/marketplaceUtils";
import backendService from "../../services/backendService";

const WeeklyLeaderboard = ({ timeLeft, onPreview, isWeekCompleted = false, externalTopMemes = null, onTopMemesUpdate = null }) => {
  const [topMemes, setTopMemes] = useState([]);
  const [loadingTop, setLoadingTop] = useState(true);
  const [currentWeekMemes, setCurrentWeekMemes] = useState(0);
  
  // Use external top memes if provided, otherwise use internal state
  const displayMemes = externalTopMemes !== null ? externalTopMemes : topMemes;

  const topTrending = useMemo(
    () => ensureArray(displayMemes).filter(Boolean).slice(0, 3),
    [displayMemes]
  );

  const totalVotes = useMemo(
    () =>
      ensureArray(displayMemes).reduce(
        (acc, meme) => acc + safeBigIntToNumber(meme?.likeCount ?? meme?.votes ?? 0),
        0
      ),
    [displayMemes]
  );

  const shareOfTop = useMemo(() => {
    if (!totalVotes || topTrending.length === 0) return 0;
    const leadVotes = safeBigIntToNumber(topTrending[0]?.likeCount ?? topTrending[0]?.votes ?? 0);
    return Math.round((leadVotes / totalVotes) * 100);
  }, [topTrending, totalVotes]);

  // Fetch Top 3 with live updates
  useEffect(() => {
    let cancelled = false;
    let intervalId;

    // Skip fetching if external memes are provided AND not empty
    if (externalTopMemes !== null && externalTopMemes.length > 0) {
      setLoadingTop(false);
      return () => {
        cancelled = true;
      };
    }

    // Debug: Log the week completion status
    console.log('WeeklyLeaderboard: isWeekCompleted =', isWeekCompleted, 'timeLeft =', timeLeft);

    // Always fetch from backend regardless of week completion status
    const fetchTopMemes = async () => {
      try {
        // Use the legacy function that returns complete meme data
        const res = await backendService.getCurrentLeaderboardLegacy(3);
        console.log('Legacy leaderboard raw data:', res);

        // The legacy function returns a LegacyWeeklyLeaderboard structure
        if (res && res.top_memes) {
          const entries = res.top_memes;
          console.log('Legacy leaderboard entries count:', entries.length);

          // Legacy format already includes complete meme data
          const resolved = entries.map((entry) => {
            if (entry.meme_data) {
              // Fetch user profile for the meme owner
              const owner = entry.meme_data.owner;
              const principal = owner
                ? (typeof owner === "string" ? owner : owner.toText())
                : null;

              return {
                entry,
                meme: entry.meme_data
              };
            }
            return null;
          }).filter(Boolean);

          console.log('Valid memes from legacy:', resolved.length);

          if (resolved.length === 0) {
            console.log('No valid memes found in legacy response');
            if (!cancelled) setTopMemes([]);
            return;
          }

          // Get unique owners for profile fetching
          const uniqueOwners = [...new Set(resolved.map(({ meme }) => {
            const owner = meme?.owner;
            if (owner) {
              if (typeof owner === "string") return owner;
              if (typeof owner === "object" && owner.toText) return owner.toText();
              return String(owner);
            }
            return null;
          }).filter(Boolean))];

          // Fetch user profiles for leaderboard owners
          const userProfiles = new Map();
          for (const principal of uniqueOwners) {
            try {
              const profile = await backendService.getUserProfileByPrincipal(principal);
              if (profile) {
                userProfiles.set(principal, profile);
              }
            } catch (error) {
              console.warn(`Failed to fetch profile for ${principal}:`, error);
            }
          }

          const arr = resolved
            .filter(({ meme, entry }) => {
              // Show all memes from backend, regardless of finalized/week_ended status
              // The backend should handle filtering appropriately
              const shouldInclude = true; // Always include
              console.log(`Meme ${meme?.id}: include=${shouldInclude}`);
              return shouldInclude;
            })
            .map(({ entry, meme }) => {
              // Normalize the meme data from legacy format
              const normalized = normalizeMeme(
                meme,
                { rank: entry?.rank, votes: entry?.votes?.upvotes || 0 },
                userProfiles
              );

              const likeCount = entry?.votes?.upvotes || 0;
              const downvoteCount = entry?.votes?.downvotes || 0;

              const result = {
                ...normalized,
                votes: likeCount,
                likeCount,
                downvoteCount,
                voteScore: likeCount,
                voteDetails: { upvotes: likeCount, downvotes: downvoteCount },
              };

              console.log('Normalized meme from legacy:', result);
              return result;
            });

          if (!cancelled) {
            console.log('Setting top memes from legacy:', arr);
            setTopMemes(arr);
            // Update parent component's topMemes state if callback provided
            if (onTopMemesUpdate) {
              onTopMemesUpdate(arr);
            }
          }
        } else {
          console.log('Legacy response missing top_memes:', res);
          if (!cancelled) setTopMemes([]);
        }
      } catch (e) {
        console.error("Failed to load top memes from legacy:", e);
        if (!cancelled) setTopMemes([]);
      } finally {
        if (!cancelled) setLoadingTop(false);
      }
    };

    setLoadingTop(true);
    fetchTopMemes();

    // Set up live updates every 30 seconds
    intervalId = setInterval(fetchTopMemes, 30000);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [externalTopMemes]); // Removed isWeekCompleted dependency

  // Fetch weekly meme count only
  useEffect(() => {
    let cancelled = false;
    const fetchWeekCount = async () => {
      try {
        const memeCount = await backendService.getCurrentWeekMemeCount();
        if (!cancelled) setCurrentWeekMemes(Number(memeCount) || 0);
      } catch (error) {
        console.warn("Failed to fetch current week meme count:", error);
      }
    };
    fetchWeekCount();
    const intervalId = setInterval(fetchWeekCount, 30000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  return (
    <Card className="overflow-hidden border-border bg-gradient-to-br from-primary/20 via-card/80 to-transparent w-full">
      <CardContent className="p-6 lg:p-8 w-full mx-auto">
        <div className="flex flex-col gap-8">
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-2 text-sm text-primary">
              <Crown className="h-5 w-5" />
              <span className="text-lg font-semibold text-foreground">Top Liked Leaderboard</span>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-center">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{isWeekCompleted ? "Next cycle begins" : "Voting resets in"}</p>
                <p className="text-xl font-semibold text-foreground">{isWeekCompleted ? "Starting soon!" : timeLeft}</p>
              </div>
            </div>
          </div>

          <div className="grid gap-8 lg:grid-cols-2">
            {/* Left Side: Main Leaderboard Content */}
            <div className="space-y-6">
              <div className="space-y-4">
                <h2 className="text-4xl font-bold text-foreground leading-tight">
                  {topTrending[0]?.title || "The leaderboard is ready"}
                </h2>
                <p className="text-base text-muted-foreground">
                  {topTrending[0]
                    ? `Leading with ${formatNumber(topTrending[0]?.likeCount ?? topTrending[0]?.votes ?? 0)} likes and ${formatNumber(topTrending[0]?.views || 0)} views.`
                    : "Publish your meme to claim the top spot on this week's board."}
                </p>
                <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Heart className="h-5 w-5 text-pink-300" />
                    <span className="font-semibold">{formatNumber(topTrending[0]?.likeCount ?? topTrending[0]?.votes ?? 0)}</span> likes
                  </span>
                  <span className="flex items-center gap-2">
                    <Eye className="h-5 w-5 text-blue-300" />
                    <span className="font-semibold">{formatNumber(topTrending[0]?.views || 0)}</span> views
                  </span>
                  <span className="flex items-center gap-2">
                    <User className="h-5 w-5 text-emerald-300" />
                    <span className="font-semibold">{topTrending[0]?.creator || "Anonymous"}</span>
                  </span>
                </div>
                <Button
                  onClick={() => topTrending[0] && onPreview(topTrending[0])}
                  disabled={!topTrending[0]}
                  className="rounded-xl bg-primary/80 px-6 py-3 text-white hover:bg-primary text-lg"
                >
                  View meme
                </Button>
              </div>

              {/* Market Stats Table */}
              <div className="bg-card/50 rounded-xl border border-border/40 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Metric</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Value</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/20">
                    <tr>
                      <td className="px-4 py-3 text-sm text-foreground/80">Total Memes</td>
                      <td className="px-4 py-3 text-lg font-semibold text-foreground">{formatNumber(ensureArray(topMemes).length)}</td>
                      <td className="px-4 py-3 text-sm text-emerald-500">Active</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-3 text-sm text-foreground/80">Top Share</td>
                      <td className="px-4 py-3 text-lg font-semibold text-foreground">{shareOfTop}%</td>
                      <td className="px-4 py-3 text-sm text-purple-500">Leading</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right Side: Featured Meme + Top 3 Trending */}
            <div className="space-y-6">
              {/* Featured Meme Image */}
              {topTrending[0]?.image_url && (
                <div className="relative w-full overflow-hidden rounded-2xl border border-border bg-card/20 aspect-[4/3] max-h-64">
                  <img
                    src={topTrending[0].image_url}
                    alt={topTrending[0].title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </div>
              )}

              {/* Top 3 Trending Memes */}
              <div className="bg-y rounded-xl border border-border/40 p-4 ">
                <h3 className="text-xl font-semibold text-foreground mb-4 flex items-center gap-2 ">
                  <Crown className="h-5 w-5 text-primary" />
                  Top 3 Most Liked
                </h3>
                <div className="space-y-3">
                  {loadingTop ? (
                    [...Array(3).keys()].map((index) => (
                      <div key={`top-loading-${index}`} className="rounded-xl border border-border/40 bg-card/50 p-3 animate-pulse">
                        <div className="flex gap-3">
                          <div className="w-12 h-12 bg-muted/50 rounded-lg flex-shrink-0"></div>
                          <div className="flex-1 space-y-2">
                            <div className="h-3 bg-muted/50 rounded"></div>
                            <div className="h-2 bg-muted/50 rounded w-3/4"></div>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : topTrending.length === 0 ? (
                    <div className="text-center py-6">
                      <p className="text-muted-foreground text-sm">No memes in current week yet</p>
                    </div>
                  ) : (
                    topTrending.slice(0, 3).map((meme, index) => (
                      <div
                        key={meme.id}
                        className="group rounded-xl border border-border/40 bg-card/50 p-3 cursor-pointer transition hover:border-primary/50 hover:bg-primary/5"
                        onClick={() => onPreview(meme)}
                      >
                        <div className="flex gap-3">
                          <div className="relative w-12 h-12 rounded-lg overflow-hidden bg-muted/20 flex-shrink-0">
                            {meme.image_url ? (
                              <img
                                src={meme.image_url}
                                alt={meme.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                                loading="lazy"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-lg">
                                {meme.emoji || "🖼️"}
                              </div>
                            )}
                            <div className="absolute -top-1 -left-1 bg-primary text-primary-foreground text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                              {index + 1}
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-semibold text-foreground line-clamp-1 text-sm mb-1">
                              {meme.title}
                            </h4>
                            <p className="text-xs text-muted-foreground mb-1">
                              by {meme.creator}
                            </p>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Heart className="h-3 w-3 text-red-500" />
                                {formatNumber(meme.likeCount ?? meme.votes ?? 0)}
                              </span>
                              <span className="flex items-center gap-1">
                                <Eye className="h-3 w-3 text-blue-500" />
                                {formatNumber(meme.views)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default WeeklyLeaderboard;