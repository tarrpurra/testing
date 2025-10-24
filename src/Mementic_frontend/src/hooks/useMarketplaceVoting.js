import { useEffect, useRef, useState } from "react";
import backendService from "../services/backendService";
import { useToast } from "../hooks/use-toast";
import { safeBigIntToNumber, toOptionalBigInt, ensureArray, normalizeMeme } from "../utils/marketplaceUtils";

// Accept voting power controls from parent to keep UI in sync
export const useMarketplaceVoting = (
  isAuthenticated,
  hasProfileName,
  memes,
  setMemes,
  setTopMemes,
  votingControls
) => {
  // Ensure parameters are properly initialized (safe versions)
  const safeIsAuthenticated = Boolean(isAuthenticated);
  const safeHasProfileName = Boolean(hasProfileName);
  const {
    power,
    VOTE_COST,
    canAfford,
    consume,
    refund,
    refresh,
  } = votingControls || {};

  const votingLock = useRef(false);

  const { toast } = useToast();

  const checkMemeOwnership = (meme, principal) => {
    if (!principal || !meme) return false;

    // Method 1: Check meme.owner
    if (meme.owner) {
      const ownerText =
        typeof meme.owner === "object" && meme.owner.toText
          ? meme.owner.toText()
          : String(meme.owner).trim();
      if (ownerText && principal === ownerText) return true;
    }

    // Method 2: Check meme.creator (already string-shortened in normalizeMeme)
    if (meme.creator) {
      const creatorText = String(meme.creator).trim();
      if (creatorText && principal === creatorText) return true;
    }

    // Method 3: Check raw meme data
    if (meme.__raw) {
      const raw = meme.__raw;
      if (raw.owner) {
        const rawOwnerText =
          typeof raw.owner === "object" && raw.owner.toText
            ? raw.owner.toText()
            : String(raw.owner).trim();
        if (rawOwnerText && principal === rawOwnerText) return true;
      }
      if (raw.meme_data?.owner) {
        const memeDataOwnerText =
          typeof raw.meme_data.owner === "object" && raw.meme_data.owner.toText
            ? raw.meme_data.owner.toText()
            : String(raw.meme_data.owner).trim();
        if (memeDataOwnerText && principal === memeDataOwnerText) return true;
      }
    }

    return false;
  };

  const handleVote = async (memeId, currentVotes = 0, memeOwner = null, principal) => {
    if (!safeIsAuthenticated) {
      toast({
        title: "Authentication Required",
        description: "Please login to vote on memes",
        variant: "destructive",
      });
      return;
    }

    if (!safeHasProfileName) {
      toast({
        title: "Set a username first",
        description: "Choose a username before interacting with marketplace memes.",
      });
      return;
    }

    // Enhanced self-voting prevention
    const isOwnMeme = checkMemeOwnership({
      owner: memeOwner,
      creator: memeOwner,
    }, principal);
    if (isOwnMeme) {
      toast({
        title: "Cannot Vote on Own Meme",
        description:
          "You cannot vote on your own memes to maintain fair competition",
        variant: "destructive",
      });
      return;
    }

    // Enforce voting power requirement
    if (!canAfford) {
      toast({
        title: "Insufficient voting power",
        description: `You need ${VOTE_COST} power to vote. Please wait for next week reset.`,
        variant: "destructive",
      });
      return;
    }

    // Inform user that voting will consume power
    const confirmCost = window.confirm(
      `Casting this vote will use ${VOTE_COST} voting power. Continue?`
    );
    if (!confirmCost) return;

    if (votingLock.current) return;
    votingLock.current = true;

    // optimistic update
    setMemes((prev) =>
      ensureArray(prev).map((m) => {
        if (String(m.id) !== String(memeId)) return m;
        const currentLikes = safeBigIntToNumber(m.likeCount ?? m.votes ?? 0);
        return {
          ...m,
          votes: currentLikes + 1,
          likeCount: currentLikes + 1,
        };
      })
    );

    // Also update top memes if this meme is in the top 3
    setTopMemes((prev) =>
      ensureArray(prev).map((m) => {
        if (String(m.id) !== String(memeId)) return m;
        const currentLikes = safeBigIntToNumber(m.likeCount ?? m.votes ?? 0);
        return {
          ...m,
          votes: currentLikes + 1,
          likeCount: currentLikes + 1,
        };
      })
    );

    try {
      const bid = toOptionalBigInt(String(memeId));
      if (!bid) {
        // Non-numeric/sample ids cannot be voted via backend
        throw new Error("Invalid meme id (non-numeric) for voting");
      }
      // Pre-consume locally to reflect instantly
      if (typeof consume === "function") consume(VOTE_COST);
      await backendService.voteWithPower(bid, "Upvote", VOTE_COST);
      toast({
        title: "Voted! ",
        description: "Your vote has been recorded successfully",
      });
      // Refresh backend power in background
      if (typeof refresh === "function") refresh().catch(() => {});

      // Refresh the current-week leaderboard after successful vote
      setTimeout(async () => {
        try {
          // Fetch a larger slice to ensure newly voted memes appear
          const res = await backendService.getCurrentLeaderboard(0, 1000);
          const entries = ensureArray(res);

          // Fetch full meme data for each leaderboard entry
          const resolved = await Promise.all(
            entries.map(async (entry) => {
              const rawId = Array.isArray(entry?.meme_id) ? entry.meme_id[0] : entry?.meme_id;
              const memeIdNum = safeBigIntToNumber(rawId);
              if (!Number.isFinite(memeIdNum) || memeIdNum <= 0) return null;
              try {
                const meme = await backendService.getMeme(memeIdNum);
                return meme ? { entry, meme } : null;
              } catch (error) {
                console.warn(`Failed to fetch meme ${memeIdNum} for leaderboard:`, error);
                return null;
              }
            })
          );

          const valid = resolved.filter(Boolean);

          // Optionally fetch profiles (kept minimal for speed)
          const userProfiles = new Map();

          // Build normalized top list with filters: only show current, active, and with votes > 0
          let top = valid
            .filter(({ meme, entry }) => {
              const isFinalized = meme?.finalized || meme?.meme_data?.finalized;
              const isWeekEnded = meme?.week_ended || meme?.meme_data?.week_ended;
              const voteCount = safeBigIntToNumber(entry?.votes ?? 0);
              return !isFinalized && !isWeekEnded && voteCount > 0;
            })
            .map(({ entry, meme }) => {
              const normalized = normalizeMeme(
                meme,
                { rank: entry?.rank, votes: entry?.votes },
                userProfiles
              );
              const likeCount = safeBigIntToNumber(entry?.votes ?? normalized.votes ?? 0);
              return {
                ...normalized,
                votes: likeCount,
                likeCount,
                downvoteCount: 0,
                voteScore: likeCount,
                voteDetails: null,
              };
            });

          // Ensure the just-voted meme is present with updated count even if not returned by backend
          const votedIdStr = String(memeId);
          const hasVotedMeme = top.some((m) => String(m.id) === votedIdStr);
          if (!hasVotedMeme) {
            try {
              const votedDetail = await backendService.getMeme(Number(memeId));
              if (votedDetail) {
                const normalized = normalizeMeme(votedDetail, {}, userProfiles);
                const likeCount = (Number.isFinite(currentVotes) ? currentVotes : 0) + 1;
                top = [
                  {
                    ...normalized,
                    votes: likeCount,
                    likeCount,
                    downvoteCount: 0,
                    voteScore: likeCount,
                  },
                  ...top,
                ];
              }
            } catch {}
          }

          setTopMemes(top);
        } catch (err) {
          console.warn("Failed to refresh leaderboard:", err);
        }
      }, 800);
    } catch (error) {
      console.error("Voting failed:", error);

      // revert optimistic update
      setMemes((prev) =>
        ensureArray(prev).map((m) =>
          String(m.id) === String(memeId)
            ? { ...m, votes: currentVotes, likeCount: currentVotes }
            : m
        )
      );

      // refund local power on failure
      if (typeof refund === "function") refund(VOTE_COST);

      setTopMemes((prev) =>
        ensureArray(prev).map((m) =>
          String(m.id) === String(memeId)
            ? { ...m, votes: currentVotes, likeCount: currentVotes }
            : m
        )
      );

      // Provide user-friendly error messages
      let errorTitle = "Voting Failed";
      let errorDescription = "Failed to vote on meme";

      if (error?.message) {
        if (error.message.includes("Cannot vote on your own meme")) {
          errorTitle = "Cannot Vote";
          errorDescription = "You cannot vote on your own memes";
        } else if (
          error.message.includes("Can only vote on memes from the current week")
        ) {
          errorTitle = "Voting Period Ended";
          errorDescription =
            "This meme is from a previous week and voting has ended";
        } else if (
          error.message.includes("Voting period for the current week has ended")
        ) {
          errorTitle = "Voting Period Ended";
          errorDescription = "The voting period for this week has ended";
        } else if (error.message.includes("Authentication required")) {
          errorTitle = "Authentication Required";
          errorDescription = "Please login to vote on memes";
        } else if (error.message.includes("Insufficient voting power")) {
          errorTitle = "Insufficient voting power";
          errorDescription = `You need ${VOTE_COST} power to vote.`;
        } else {
          errorDescription = error.message;
        }
      }

      toast({
        title: errorTitle,
        description: errorDescription,
        variant: "destructive",
      });
    } finally {
      votingLock.current = false;
    }
  };

  return {
    handleVote,
    checkMemeOwnership,
    votingPower: power,
    votingCost: VOTE_COST,
    consume,
    refund,
    refresh,
  };
};