import { useEffect, useMemo, useRef, useState } from "react";
import backendService from "../services/backendService";
import {
  ensureArray,
  safeBigIntToNumber,
  toOptionalBigInt,
  normalizeMeme,
  deriveWeekIdFromMs,
  PAGE_SIZE,
  loadLeaderboardCache,
  persistLeaderboardCache,
  clearLeaderboardCache,
} from "../utils/marketplaceUtils";

export const useMarketplaceData = (isAuthenticated, hasProfileName, page, sort, searchQuery) => {
  const leaderboardCacheRef = useRef(loadLeaderboardCache());
  const cachedLeaderboard = leaderboardCacheRef.current;
  const cachedWeekId = Number.isFinite(Number(cachedLeaderboard?.weekId))
    ? Number(cachedLeaderboard.weekId)
    : null;
  const cachedTopMemes = Array.isArray(cachedLeaderboard?.memes)
    ? cachedLeaderboard.memes
    : [];

  const [topMemes, setTopMemesState] = useState(cachedTopMemes);
  const [memes, setMemes] = useState([]);
  const [total, setTotal] = useState(0);
  const [loadingTop, setLoadingTop] = useState(cachedTopMemes.length === 0);
  const [loadingList, setLoadingList] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [marketplaceCount, setMarketplaceCount] = useState(0);
  const [leaderboardCount, setLeaderboardCount] = useState(cachedTopMemes.length);
  const defaultWeekStatus = useMemo(
    () => ({ weekId: null, remainingNs: 0, endTimeNs: 0, isCompleted: false }),
    []
  );
  const [currentWeekStatus, setCurrentWeekStatus] = useState(defaultWeekStatus);
  const [currentWeekId, setCurrentWeekId] = useState(null);
  const [previousWeekId, setPreviousWeekId] = useState(null);
  const [clearedWeekId, setClearedWeekId] = useState(cachedWeekId);
  const [clearedCompletionWeekId, setClearedCompletionWeekId] = useState(null);
  const [finalizeAckWeekId, setFinalizeAckWeekId] = useState(null);

  const setTopMemes = (value) => {
    setTopMemesState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      const arr = Array.isArray(next) ? next : ensureArray(next);
      const filtered = arr.filter(Boolean);
      setLeaderboardCount(filtered.length);

      const activeWeekIdCandidate = (() => {
        const statusWeek = Number(currentWeekStatus?.weekId);
        if (Number.isFinite(statusWeek)) return statusWeek;
        if (Number.isFinite(Number(currentWeekId))) return Number(currentWeekId);
        const cachedWeek = Number(leaderboardCacheRef.current?.weekId);
        if (Number.isFinite(cachedWeek)) return cachedWeek;
        return null;
      })();

      if (activeWeekIdCandidate != null) {
        const payload = persistLeaderboardCache(activeWeekIdCandidate, filtered);
        if (payload) {
          leaderboardCacheRef.current = payload;
        }
      } else if (filtered.length === 0) {
        clearLeaderboardCache();
        leaderboardCacheRef.current = null;
      }

      return filtered;
    });
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await backendService.ensureReady();
        const status = await backendService.getCurrentWeekStatus();
        const previousWeek = await backendService.getPreviousWeekId();
        if (!cancelled) {
          const weekId = Number(status?.weekId);
          const normalizedWeekId = Number.isFinite(weekId) ? weekId : null;
          const normalizedPreviousWeekId = previousWeek ? Number(previousWeek) : null;

          setCurrentWeekId(normalizedWeekId);
          setPreviousWeekId(normalizedPreviousWeekId);
          setCurrentWeekStatus({
            weekId: normalizedWeekId,
            remainingNs: Number(status?.remainingNs) || 0,
            endTimeNs: Number(status?.endTimeNs) || 0,
            isCompleted: Boolean(status?.isCompleted),
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("Failed to fetch week status:", error);
          setCurrentWeekId(null);
          setPreviousWeekId(null);
          setCurrentWeekStatus(defaultWeekStatus);
        }
      }
    })();

    // Poll status periodically to detect rollover promptly
    const intervalId = setInterval(async () => {
      try {
        const status = await backendService.getCurrentWeekStatus();
        const previousWeek = await backendService.getPreviousWeekId();
        if (!cancelled) {
          const weekId = Number(status?.weekId);
          const normalizedWeekId = Number.isFinite(weekId) ? weekId : null;
          const normalizedPreviousWeekId = previousWeek ? Number(previousWeek) : null;

          setCurrentWeekId((prev) => (prev !== normalizedWeekId ? normalizedWeekId : prev));
          setPreviousWeekId(normalizedPreviousWeekId);
          setCurrentWeekStatus({
            weekId: normalizedWeekId,
            remainingNs: Number(status?.remainingNs) || 0,
            endTimeNs: Number(status?.endTimeNs) || 0,
            isCompleted: Boolean(status?.isCompleted),
          });
        }
      } catch (e) {
        // swallow
      }
    }, 10000); // every 10s

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [defaultWeekStatus]);

  // Fetch total memes created in the current week (marketplace count)
  useEffect(() => {
    const weekId = currentWeekStatus?.weekId;
    if (weekId == null) {
      setMarketplaceCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const count = await backendService.getCurrentWeekMemeCount();
        if (!cancelled) setMarketplaceCount(Number(count) || 0);
      } catch {
        if (!cancelled) setMarketplaceCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWeekStatus?.weekId]);

  useEffect(() => {
    const weekId = currentWeekStatus?.weekId;
    if (weekId == null) {
      return;
    }

    // Only clear if this is actually a different week (not just a refresh)
    if (clearedWeekId !== null && clearedWeekId !== weekId) {
      setTopMemes([]);
      setMemes([]);
      setTotal(0);
    }
    setClearedWeekId(weekId);
  }, [clearedWeekId, currentWeekStatus?.weekId, previousWeekId]);

  useEffect(() => {
    const { isCompleted, weekId } = currentWeekStatus ?? {};
    if (!isCompleted || weekId == null) {
      return;
    }

    if (clearedCompletionWeekId !== weekId) {
      setTopMemes([]);
      setMemes([]);
      setTotal(0);
      setClearedCompletionWeekId(weekId);
    }
  }, [clearedCompletionWeekId, currentWeekStatus, previousWeekId]);

  // Auto-finalize only when backend reports completion; avoid remainingNs<=0 heuristic
  useEffect(() => {
    const { weekId, isCompleted } = currentWeekStatus ?? {};
    if (weekId == null) return;
    if (finalizeAckWeekId === weekId) return; // already attempted for this week
    if (!isCompleted) return;

    let cancelled = false;
    (async () => {
      try {
        await backendService.ensureReady();
        // Best-effort finalize; backend may no-op if already finalized
        await backendService.forceFinalizeCurrentWeek();
      } catch (e) {
        // Ignore errors; timer or permissions may handle rollover elsewhere
      } finally {
        if (!cancelled) setFinalizeAckWeekId(weekId);
        // Refresh status and reset lists to reflect new week
        try {
          const status = await backendService.getCurrentWeekStatus();
          const prev = await backendService.getPreviousWeekId();
          if (!cancelled) {
            const normalizedWeekId = Number.isFinite(Number(status?.weekId)) ? Number(status.weekId) : null;
            const normalizedPreviousWeekId = prev ? Number(prev) : null;
            setCurrentWeekId(normalizedWeekId);
            setPreviousWeekId(normalizedPreviousWeekId);
            setCurrentWeekStatus({
              weekId: normalizedWeekId,
              remainingNs: Number(status?.remainingNs) || 0,
              endTimeNs: Number(status?.endTimeNs) || 0,
              isCompleted: Boolean(status?.isCompleted),
            });
            setTopMemes([]);
            setMemes([]);
            setTotal(0);
          }
        } catch {}
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentWeekStatus, finalizeAckWeekId]);

  // Fetch Top 3
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingTop((prev) => (topMemes.length === 0 ? true : prev));
      setErrorMsg("");
      try {
        const leaderboard = await backendService.getCurrentLeaderboard(0, 1000);
        const entries = ensureArray(leaderboard);

        if (entries.length === 0) {
          if (!cancelled) setTopMemes([]);
          return;
        }

        const resolved = await Promise.all(
          entries.map(async (entry) => {
            const rawId = Array.isArray(entry?.meme_id)
              ? entry.meme_id[0]
              : entry?.meme_id;
            const memeId = safeBigIntToNumber(rawId);
            if (!Number.isFinite(memeId) || memeId <= 0) {
              return null;
            }
            try {
              const meme = await backendService.getMeme(memeId);
              return meme ? { entry, meme } : null;
            } catch (error) {
              console.warn(`Failed to fetch meme ${memeId} for leaderboard:`, error);
              return null;
            }
          })
        );

        const valid = resolved.filter(Boolean);
        if (valid.length === 0) {
          if (!cancelled) setTopMemes([]);
          return;
        }

        const uniqueOwners = [
          ...new Set(
            valid
              .map(({ meme }) => {
                const owner = meme?.owner ?? meme?.meme_data?.owner ?? meme?.creator;
                if (owner) {
                  if (typeof owner === "string") return owner;
                  if (typeof owner === "object" && owner.toText) return owner.toText();
                  return String(owner);
                }
                return null;
              })
              .filter(Boolean)
          ),
        ];

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

        const arr = valid.map(({ entry, meme }) => {
          const upvotes = safeBigIntToNumber(entry?.votes ?? entry?.votes?.upvotes ?? 0);
          const normalized = normalizeMeme(
            meme,
            { rank: entry?.rank, votes: { upvotes } },
            userProfiles
          );

          return {
            ...normalized,
            votes: upvotes,
            likeCount: upvotes,
            downvoteCount: 0,
            voteScore: upvotes,
            voteDetails: { upvotes, downvotes: 0 },
          };
        });

        // Trust backend current leaderboard snapshot; only remove invalid entries locally
        // Filter out finalized, week-ended memes, and memes with 0 votes from leaderboard
        const cleanedFiltered = arr.filter((meme) => {
          const isFinalized = Boolean(meme?.finalized);
          const isWeekEnded = Boolean(meme?.week_ended);
          const hasVotes = (meme?.votes ?? 0) > 0;
          return !isFinalized && !isWeekEnded && hasVotes;
        });

        if (!cancelled) {
          setTopMemes(cleanedFiltered);
          setLeaderboardCount(cleanedFiltered.length);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg("Failed to load top memes.");
      } finally {
        if (!cancelled) setLoadingTop(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWeekId]);

  // Fetch paginated list
  const fetchList = async ({ reset = false } = {}) => {
    if (!isAuthenticated || !hasProfileName) {
      if (reset) {
        setMemes([]);
        setTotal(0);
      }
      setLoadingList(false);
      if (!isAuthenticated || !hasProfileName) {
        setErrorMsg("Please login to view the marketplace.");
      }
      return;
    }

    // Do not hard-block listing on isCompleted; status may be stale right after rollover.

    setLoadingList(true);
    setErrorMsg("");
    try {
      const pageSize = PAGE_SIZE;
      const offset = (page - 1) * pageSize;
      const cards = await backendService.listPremarketMemes(offset, pageSize);
      const entries = ensureArray(cards);

      if (entries.length === 0) {
        if (reset || page === 1) {
          setMemes([]);
        }
        setTotal(offset);
        setLoadingList(false);
        return;
      }

      const resolved = await Promise.all(
        entries.map(async (card) => {
          const rawId = Array.isArray(card?.id) ? card.id[0] : card?.id;
          const memeId = safeBigIntToNumber(rawId);
          if (!Number.isFinite(memeId) || memeId <= 0) {
            return null;
          }
          try {
            const detail = await backendService.getMeme(memeId);
            return detail ? { detail } : null;
          } catch (error) {
            console.warn(`Failed to fetch meme ${memeId}:`, error);
            return null;
          }
        })
      );

      const valid = resolved.filter(Boolean);
      if (valid.length === 0) {
        if (reset || page === 1) {
          setMemes([]);
        }
        setTotal(offset);
        setLoadingList(false);
        return;
      }

      const uniqueOwners = [
        ...new Set(
          valid
            .map(({ detail }) => {
              const owner = detail?.owner ?? detail?.meme_data?.owner ?? detail?.creator;
              if (owner) {
                if (typeof owner === "string") return owner;
                if (typeof owner === "object" && owner.toText) return owner.toText();
                return String(owner);
              }
              return null;
            })
            .filter(Boolean)
        ),
      ];

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

      const arr = valid.map(({ detail }) => normalizeMeme(detail, {}, userProfiles));

      const getCreatedAt = (meme) => safeBigIntToNumber(meme?.created_at || 0);
      const getVotes = (meme) => safeBigIntToNumber(meme?.votes || 0);
      const getViews = (meme) => safeBigIntToNumber(meme?.views || 0);
      const getSale = (meme) => meme?.sale_metadata ?? meme?.market_data;

      if (sort === "newest") {
        arr.sort((a, b) => {
          const dateDiff = getCreatedAt(b) - getCreatedAt(a);
          if (dateDiff !== 0) return dateDiff;
          return getVotes(b) - getVotes(a);
        });
      } else if (sort === "top") {
        arr.sort((a, b) => {
          const voteDiff = getVotes(b) - getVotes(a);
          if (voteDiff !== 0) return voteDiff;
          return getViews(b) - getViews(a);
        });
      } else if (sort === "listed") {
        arr.sort((a, b) => {
          const aListed = getSale(a)?.is_listed ? 1 : 0;
          const bListed = getSale(b)?.is_listed ? 1 : 0;
          if (aListed !== bListed) return bListed - aListed;
          const voteDiff = getVotes(b) - getVotes(a);
          if (voteDiff !== 0) return voteDiff;
          return getCreatedAt(b) - getCreatedAt(a);
        });
      } else {
        arr.sort((a, b) => {
          const scoreA = getVotes(a) * 2 + getViews(a);
          const scoreB = getVotes(b) * 2 + getViews(b);
          if (scoreB !== scoreA) return scoreB - scoreA;
          return getCreatedAt(b) - getCreatedAt(a);
        });
      }

      const filteredByWeek =
        currentWeekId == null
          ? arr
          : arr.filter((meme) => {
              const week = deriveWeekIdFromMs(meme?.created_at);
              // Only include memes from the current week
              // Exclude all memes from previous weeks
              return week === currentWeekId;
            });

        const filteredForListing = filteredByWeek.filter((meme) => {
          const sale = meme?.sale_metadata ?? meme?.market_data ?? {};
          const isListed = Boolean(sale?.is_listed ?? sale?.isListed);
          const isFinalized = Boolean(meme?.finalized); // Don't show finalized memes from completed weeks
          const isWeekEnded = Boolean(meme?.week_ended); // Don't show memes from ended weeks
          return !isListed && !isFinalized && !isWeekEnded;
        });

        const slice = filteredForListing;

        setTotal(offset + filteredForListing.length);
        setMemes((prev) =>
          page === 1 || reset ? filteredForListing : [...ensureArray(prev), ...filteredForListing]
        );

      // Refresh vote counts for newly loaded memes
      if (slice.length > 0) {
        setTimeout(async () => {
          try {
            const currentMemeIds = slice.map((m) => m.id);
            const updatedMemes = await Promise.all(
              currentMemeIds.map(async (memeId) => {
                try {
                  const bid = toOptionalBigInt(String(memeId));
                  if (!bid) return slice.find((m) => m.id === memeId);
                  const voteData = await backendService.getMemeVotes(bid);
                  if (voteData) {
                    return {
                      ...slice.find((m) => m.id === memeId),
                      votes:
                        safeBigIntToNumber(voteData.upvotes) -
                        safeBigIntToNumber(voteData.downvotes),
                    };
                  }
                  return slice.find((m) => m.id === memeId);
                } catch (error) {
                  console.warn(
                    `Failed to get initial votes for meme ${memeId}:`,
                    error
                  );
                  return slice.find((m) => m.id === memeId);
                }
              })
            );
            const sanitizedUpdates = updatedMemes.filter((meme) => {
              const sale = meme?.sale_metadata ?? meme?.market_data ?? {};
              const isListed = sale?.is_listed ?? sale?.isListed;
              const isFinalized = meme?.finalized; // Filter out finalized memes
              const isWeekEnded = meme?.week_ended; // Filter out memes from ended weeks
              
              // Also filter by week - only include current week memes
              const week = deriveWeekIdFromMs(meme?.created_at);
              const isCurrentWeek = currentWeekId == null || week === currentWeekId;
              
              return !isListed && !isFinalized && !isWeekEnded && isCurrentWeek;
            });

            setMemes((prev) => {
              if (page === 1 || reset) {
                return sanitizedUpdates;
              }

              const preserved = ensureArray(prev)
                .slice(0, -slice.length)
                .filter((meme) => {
                  const sale = meme?.sale_metadata ?? meme?.market_data ?? {};
                  const isListed = sale?.is_listed ?? sale?.isListed;
                  const isFinalized = meme?.finalized; // Filter out finalized memes
                  const isWeekEnded = meme?.week_ended; // Filter out memes from ended weeks
                  
                  // Also filter by week - only include current week memes
                  const week = deriveWeekIdFromMs(meme?.created_at);
                  const isCurrentWeek = currentWeekId == null || week === currentWeekId;
                  
                  return !isListed && !isFinalized && !isWeekEnded && isCurrentWeek;
                });

              return [...preserved, ...sanitizedUpdates];
            });
          } catch (error) {
            console.warn("Failed to refresh initial vote counts:", error);
          }
        }, 500);
      }
    } catch (e) {
      console.error("Failed to load memes:", e);
      setErrorMsg("Failed to load memes. Please try again.");
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    fetchList({ reset: page === 1 });
  }, [page, sort, currentWeekId, previousWeekId]);

  useEffect(() => {
    if (isAuthenticated && hasProfileName) {
      fetchList({ reset: true });
    }
  }, [isAuthenticated, hasProfileName, currentWeekId, previousWeekId]);

  return {
    topMemes,
    memes,
    total,
    loadingTop,
    loadingList,
    errorMsg,
    fetchList,
    setTopMemes,
    setMemes,
    marketplaceCount,
    leaderboardCount,
    currentWeekStatus,
  };
};