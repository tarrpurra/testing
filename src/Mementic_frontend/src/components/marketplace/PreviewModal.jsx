import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/Button";
import { X, Heart, Eye, Coins } from "lucide-react";
import backendService from "../../services/backendService";
import { toOptionalBigInt } from "../../utils/marketplaceUtils";

function PreviewModal({
  open,
  onClose,
  meme,
  onLike,
  isAuthenticated,
  isOwn,
  hasProfileName,
}) {
  const [hasVoted, setHasVoted] = useState(false);
  const [loadingVoteStatus, setLoadingVoteStatus] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Check vote status when meme changes
  useEffect(() => {
    if (!open || !meme || !isAuthenticated || isOwn) {
      setHasVoted(false);
      setLoadingVoteStatus(false);
      return;
    }

    const checkVoteStatus = async () => {
      setLoadingVoteStatus(true);
      try {
        const bid = toOptionalBigInt(String(meme.id));
        if (!bid) {
          setHasVoted(false);
        } else {
          const userVote = await backendService.getUserVote(bid);
          setHasVoted(!!userVote);
        }
      } catch (error) {
        console.warn("Failed to check vote status:", error);
        setHasVoted(false);
      } finally {
        setLoadingVoteStatus(false);
      }
    };

    checkVoteStatus();
  }, [open, meme, isAuthenticated, isOwn]);

  // Local state to enrich missing fields from marketplace list items
  const [mintedAtNsLocal, setMintedAtNsLocal] = useState(
    meme?.mintedAtNs ? Number(meme.mintedAtNs) : null
  );
  const [entitlementExpiresAtMsLocal, setEntitlementExpiresAtMsLocal] = useState(
    meme?.entitlementExpiresAtMs ? Number(meme.entitlementExpiresAtMs) : null
  );

  // Reset locals when meme changes
  useEffect(() => {
    setMintedAtNsLocal(meme?.mintedAtNs ? Number(meme.mintedAtNs) : null);
    setEntitlementExpiresAtMsLocal(
      meme?.entitlementExpiresAtMs ? Number(meme.entitlementExpiresAtMs) : null
    );
  }, [meme]);

  // Fetch entitlements (for minted time and countdown) if missing
  useEffect(() => {
    const fetchIfMissing = async () => {
      try {
        if (!meme) return;
        const idStr = String(meme.id ?? meme.memeId ?? "");
        if (!/^\d+$/.test(idStr)) return;
        const idBig = BigInt(idStr);

        const needMinted = mintedAtNsLocal == null || mintedAtNsLocal <= 0;
        const needExpiry = entitlementExpiresAtMsLocal == null || entitlementExpiresAtMsLocal <= 0;
        if (!needMinted && !needExpiry) return;

        const ents = await backendService.getEntitlementsForMeme(idBig);
        if (!Array.isArray(ents) || ents.length === 0) return;

        // Normalize helper: convert candid ns to ms number
        const toMs = (v) => {
          if (v == null) return 0;
          if (typeof v === "bigint") {
            return Number(v / 1_000_000n);
          }
          if (Array.isArray(v)) {
            const inner = v[0];
            if (typeof inner === "bigint") return Number(inner / 1_000_000n);
            const n = Number(inner);
            return Number.isFinite(n) ? n : 0;
          }
          const n = Number(v);
          return Number.isFinite(n) ? (n > 1e15 ? Math.floor(n / 1e6) : n) : 0;
        };

        // Pick latest Used for minted time; otherwise keep null
        const used = ents
          .map((e) => ({ usedAtMs: toMs(e?.used_at), expiresAtMs: toMs(e?.expires_at), status: e?.status }))
          .sort((a, b) => (b.usedAtMs || 0) - (a.usedAtMs || 0));

        if (needMinted) {
          const latestUsed = used.find((e) => e.usedAtMs && e.usedAtMs > 0);
          if (latestUsed) setMintedAtNsLocal(latestUsed.usedAtMs * 1_000_000); // store as ns to reuse existing ns->ms code
        }

        if (needExpiry) {
          // Prefer active entitlement expiry if present; otherwise latest future expiry
          const sortedByExpiry = ents
            .map((e) => ({ expiresAtMs: toMs(e?.expires_at), usedAtMs: toMs(e?.used_at) }))
            .sort((a, b) => (b.expiresAtMs || 0) - (a.expiresAtMs || 0));
          const best = sortedByExpiry.find((e) => e.expiresAtMs && e.expiresAtMs > Date.now());
          if (best) setEntitlementExpiresAtMsLocal(best.expiresAtMs);
        }
      } catch {}
    };
    fetchIfMissing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meme, mintedAtNsLocal, entitlementExpiresAtMsLocal]);

  const mintedNs = mintedAtNsLocal;
  const entitlementExpiresAtMs = entitlementExpiresAtMsLocal;
  const baseMs = mintedNs && Number.isFinite(mintedNs) && mintedNs > 0
    ? mintedNs / 1_000_000
    : (
        meme?.created_at && !isNaN(Number(meme.created_at)) && Number(meme.created_at) > 1000000000000
          ? Number(meme.created_at)
          : Date.now()
      );
  const createdDate = new Date(baseMs);
  const createdStr = createdDate.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const mintedLabel = mintedNs && Number.isFinite(mintedNs) && mintedNs > 0
    ? `Minted on ${createdStr}`
    : `Created on ${createdStr}`;

  const countdownLabel = useMemo(() => {
    if (!entitlementExpiresAtMs) return null;
    const remaining = entitlementExpiresAtMs - Date.now();
    if (remaining <= 0) return "Mint window expired";
    const minutes = Math.floor(remaining / 60000);
    if (minutes >= 1440) {
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      return `${days}d ${hours}h remaining`;
    }
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours}h ${mins}m remaining`;
    }
    return `${minutes}m remaining`;
  }, [entitlementExpiresAtMs]);

  if (!open || !meme) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center w-screen">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-[80vw] max-w-4xl h-[75vh] overflow-hidden">
        <div className="flex h-full">
          {/* Left Panel: Image */}
          <div className="flex-[3] flex items-center justify-center bg-muted p-4 overflow-auto ">
            {meme.image_url ? (
              <img
                src={meme.image_url}
                alt={meme.title}
                className="max-w-full max-h-[68vh] object-contain"
                loading="lazy"
              />
            ) : (
              <div className="text-7xl">
                {meme.emoji || "🖼️"}
              </div>
            )}
          </div>

          {/* Right Panel: Info */}
          <div className="w-96 flex flex-col border-l border-border">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary/60 to-primary/30 flex items-center justify-center text-card font-bold">
                  {meme.creator?.[0]?.toUpperCase() || "U"}
                </div>
                <div>
                  <div className="font-semibold">{meme.creator || "Unknown"}</div>
                  <div className="text-xs text-muted-foreground">
                    {countdownLabel ? countdownLabel : mintedLabel}
                  </div>
                </div>
              </div>
              <Button size="icon" variant="ghost" onClick={onClose} title="Close">
                <X className="w-5 h-5" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold mb-2">{meme.title}</h3>
                  {meme.caption ? (
                    <p className="text-sm text-muted-foreground mb-2">{meme.caption}</p>
                  ) : meme.prompt ? (
                    <p className="text-sm text-muted-foreground mb-2">{meme.prompt}</p>
                  ) : null}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-300">
                    <Heart className="w-3 h-3" /> {Number(meme.likeCount ?? meme.votes ?? 0)} likes
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-300">
                    <Eye className="w-3 h-3" /> {Number(meme.views ?? 0)} views
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-foreground/80">
                    by {meme.creator || "Anonymous"}
                  </span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="px-4 py-3 border-t border-border">
              <Button
                size="sm"
                variant={hasVoted ? "secondary" : (isAuthenticated && !isOwn ? "default" : "outline")}
                onClick={() => {
                  onLike(meme.id, meme.votes, meme.creator);
                  setHasVoted(true); // Optimistic update
                }}
                disabled={!isAuthenticated || !hasProfileName || isOwn || hasVoted || loadingVoteStatus}
                className={(!isAuthenticated || isOwn || hasVoted) ? "opacity-60" : ""}
                title={
                  !isAuthenticated
                    ? "Login to like"
                    : isOwn
                    ? "Can't like your own meme"
                    : hasVoted
                    ? "You have already voted on this meme"
                    : loadingVoteStatus
                    ? "Checking vote status..."
                    : "Like"
                }
              >
                <Heart className={`w-4 h-4 mr-2 ${hasVoted ? "fill-current" : ""}`} />
                {loadingVoteStatus ? (
                  <>
                    <div className="animate-spin h-3 w-3 border border-current border-t-transparent rounded-full mr-1" />
                    Loading...
                  </>
                ) : isOwn ? (
                  "Your Meme"
                ) : hasVoted ? (
                  `Voted (${meme.votes})`
                ) : (
                  `Vote (${meme.votes})`
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PreviewModal;