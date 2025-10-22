import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Flame,
  Loader2,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import PageShell from "../components/layout/PageShell";
import ListingModal from "../components/ListingModal";
import PreviewModal from "../components/marketplace/PreviewModal";
import backendService from "../services/backendService";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../hooks/use-toast";

const trendingMemes = [];

const marketFeed = [];

const slideVariants = {
  initial: { opacity: 0, scale: 0.96, y: 12 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: -12 },
};

const Marketplace = () => {
  const { principal, isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [currentSlide, setCurrentSlide] = useState(0);
  const totalSlides = trendingMemes.length;

  const [topWinners, setTopWinners] = useState([]);
  const [winnersLoading, setWinnersLoading] = useState(true);
  const [winnersError, setWinnersError] = useState(null);
  const [latestWeek, setLatestWeek] = useState(null);
  const [mintDialog, setMintDialog] = useState({
    open: false,
    winner: null,
    mode: "single",
    editions: 10,
    isSubmitting: false,
    error: null,
  });
  // Preview Modal (same component/UX as PreMarketplace)
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedMeme, setSelectedMeme] = useState(null);
  const [listingDialog, setListingDialog] = useState({
    open: false,
    winner: null,
    isSubmitting: false,
    error: null,
  });

  // All marketplace listings (not limited to Top 3 winners)
  const [listings, setListings] = useState([]);
  const [loadingListings, setLoadingListings] = useState(true);
  const [listingsError, setListingsError] = useState(null);

  const unwrapOptional = (value) =>
    Array.isArray(value) ? (value.length ? value[0] : null) : value ?? null;

  const toIcp = (value) => {
    const raw = unwrapOptional(value);
    if (raw == null) return null;
    if (typeof raw === "bigint") {
      return Number(raw) / 100000000;
    }
    const num = Number(raw);
    return Number.isFinite(num) ? num / 100000000 : null;
  };

  const resolveOwnerUsername = async (ownerPrincipal) => {
    if (!ownerPrincipal) return "Anonymous";
    try {
      const profile = await backendService.getUserProfileByPrincipal(ownerPrincipal);
      if (profile?.username) {
        return Array.isArray(profile.username) ? profile.username[0] : profile.username;
      }
    } catch {}
    return `${ownerPrincipal.slice(0, 8)}...${ownerPrincipal.slice(-6)}`;
  };

  const fetchMintMeta = async (memeId) => {
    try {
      const ents = await backendService.getEntitlementsForMeme(BigInt(memeId));
      if (Array.isArray(ents) && ents.length) {
        const usedList = ents
          .map((e) => ({ used: e?.used_at ? (Array.isArray(e.used_at) ? e.used_at[0] : e.used_at) : null }))
          .filter((e) => typeof e.used === "bigint" || typeof e.used === "number");
        const mintedAtNs = usedList.length
          ? Number(usedList.reduce((a, b) => (Number(b.used) > Number(a.used) ? b : a)).used)
          : null;

        // take the latest entitlement for expiry display
        const latestEnt = ents.reduce((a, b) => (Number(b?.expires_at ?? 0) > Number(a?.expires_at ?? 0) ? b : a));
        const expiresRaw = latestEnt?.expires_at;
        const expiresAtNs = Array.isArray(expiresRaw) ? expiresRaw[0] : expiresRaw;
        const expiresAtMs = typeof expiresAtNs === 'bigint' || typeof expiresAtNs === 'number'
          ? Math.floor(Number(expiresAtNs) / 1_000_000)
          : null;

        return { mintedAtNs, entitlementExpiresAtMs: expiresAtMs };
      }
    } catch {}
    return { mintedAtNs: null, entitlementExpiresAtMs: null };
  };

  const parseSaleMetadata = (raw) => {
    if (!raw) return null;
    let listingType = "None";
    if (raw.listing_type && typeof raw.listing_type === "object") {
      const keys = Object.keys(raw.listing_type);
      if (keys.length) {
        listingType = keys[0];
      }
    }

    return {
      isListed: Boolean(raw.is_listed),
      listingType,
      listingPriceIcp: toIcp(raw.listing_price),
      auctionStartIcp: toIcp(raw.auction_start_price),
      auctionHighestIcp: toIcp(raw.auction_highest_bid),
      bidCount: Number(raw.auction_bid_count ?? 0),
      raw,
    };
  };

  const formatIcpValue = (value) => {
    if (value == null) return "—";
    const display = Number(value);
    if (!Number.isFinite(display)) return "—";
    if (display >= 1) return display.toFixed(2);
    return display.toFixed(4);
  };

  const formatListingStatus = (snapshot) => {
    if (!snapshot || !snapshot.isListed) {
      return "Not listed";
    }
    if (snapshot.listingType === "FixedPrice") {
      const price = formatIcpValue(snapshot.listingPriceIcp);
      return `Fixed · ${price} ICP`;
    }
    if (snapshot.listingType === "Auction") {
      const start = formatIcpValue(snapshot.auctionStartIcp);
      const bids =
        snapshot.bidCount > 0 ? `${snapshot.bidCount} bids` : "0 bids";
      return `Auction · ${start} ICP · ${bids}`;
    }
    return "Not listed";
  };

  const normalizeMintedTokens = (tokens) =>
    Array.isArray(tokens)
      ? tokens.map((id) => {
          if (typeof id === "bigint") return id.toString();
          if (typeof id === "object" && id?.toString) return id.toString();
          return String(id);
        })
      : [];

  useEffect(() => {
    let cancelled = false;

    const fetchTopWinners = async () => {
      try {
        setWinnersLoading(true);
        setWinnersError(null);
        await backendService.ensureReady();

        const weeks = await backendService.getCompletedWeeks();
        if (!Array.isArray(weeks) || weeks.length === 0) {
          if (!cancelled) {
            setLatestWeek(null);
            setTopWinners([]);
          }
          return;
        }

        const sortedWeeks = [...weeks].sort(
          (a, b) => Number(b?.week_id ?? 0) - Number(a?.week_id ?? 0)
        );
        const latest = sortedWeeks[0];
        if (cancelled) return;
        setLatestWeek(latest);

        const winners = await backendService.getTop3ForWeek(latest.week_id);
        if (cancelled) return;

        const enriched = await Promise.all(
          (winners || []).map(async (entry, index) => {
            try {
              const meme = await backendService.getMeme(entry.meme_id);
              const mintedTokens = await backendService.getMintedTokens(
                entry.meme_id
              );
              let saleMetadata = null;
              try {
                saleMetadata = await backendService.getSaleMetadataForMeme(
                  entry.meme_id
                );
              } catch (saleError) {
                console.warn(
                  "Failed to fetch sale metadata for winner",
                  entry?.meme_id,
                  saleError
                );
              }
              const captionField = meme?.meme_data?.caption;
              const caption = Array.isArray(captionField)
                ? captionField[0]
                : captionField;
              const prompt = meme?.meme_data?.prompt ?? "";
              const ownerCandidate =
                meme?.owner ?? meme?.meme_data?.owner ?? null;
              const ownerPrincipal = ownerCandidate
                ? (typeof ownerCandidate === "object" && ownerCandidate.toText
                    ? ownerCandidate.toText()
                    : String(ownerCandidate))
                : "";
              const ownerUsername = await resolveOwnerUsername(ownerPrincipal);
              const imageUrl = meme?.meme_data?.image_url ?? null;

              return {
                memeId: Number(entry.meme_id),
                rank: index + 1,
                votes: Number(entry.votes ?? entry.upvotes ?? 0),
                ownerPrincipal,
                ownerUsername,
                meme,
                imageUrl,
                prompt,
                title:
                  (caption && String(caption).trim()) ||
                  (prompt && String(prompt).trim()) ||
                  `Meme #${entry.meme_id}`,
                mintedTokens: normalizeMintedTokens(mintedTokens),
                saleSnapshot: parseSaleMetadata(saleMetadata),
              };
            } catch (innerError) {
              console.warn(
                "Failed to enrich winner",
                entry?.meme_id,
                innerError
              );
              return {
                memeId: Number(entry.meme_id),
                rank: index + 1,
                votes: Number(entry.votes ?? entry.upvotes ?? 0),
                ownerPrincipal: "",
                ownerUsername: "Anonymous",
                meme: null,
                imageUrl: null,
                prompt: "",
                title: `Meme #${entry.meme_id}`,
                mintedTokens: [],
                saleSnapshot: null,
              };
            }
          })
        );

        if (!cancelled) {
          setTopWinners(enriched);
        }
      } catch (error) {
        console.error("Failed to load top winners:", error);
        if (!cancelled) {
          setWinnersError(error?.message ?? "Failed to load top winners");
          setTopWinners([]);
        }
      } finally {
        if (!cancelled) {
          setWinnersLoading(false);
        }
      }
    };

    fetchTopWinners();

    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for external listing updates to refresh marketplace activity
  useEffect(() => {
    const onListingsUpdated = async (e) => {
      try {
        await backendService.ensureReady();
        // Refresh all listings
        try {
          const raw = await backendService.getMarketplaceMemes();
          const items = Array.isArray(raw) ? raw : [];
          const enriched = await Promise.all(
            items.map(async (entry) => {
              try {
                let memeIdCandidate = entry;
                if (typeof entry === "object" && entry !== null) {
                  if (entry?.meme_id != null) {
                    memeIdCandidate = entry.meme_id;
                  } else if (entry?.id != null) {
                    memeIdCandidate = entry.id;
                  }
                }
                const idNum = Number(
                  typeof memeIdCandidate === "object" && memeIdCandidate?.toString
                    ? memeIdCandidate.toString()
                    : memeIdCandidate
                );
                const meme = await backendService.getMeme(BigInt(idNum));
                const sale = await backendService.getSaleMetadataForMeme(BigInt(idNum));
                const saleSnapshot = parseSaleMetadata(sale);
                const captionField = meme?.meme_data?.caption;
                const caption = Array.isArray(captionField) ? captionField[0] : captionField;
                const prompt = meme?.meme_data?.prompt ?? "";
                const title =
                  (caption && String(caption).trim()) ||
                  (prompt && String(prompt).trim()) ||
                  `Meme #${idNum}`;
                const imageUrl = meme?.meme_data?.image_url ?? null;
                const ownerCandidate = meme?.owner ?? meme?.meme_data?.owner ?? null;
                const ownerPrincipal = ownerCandidate
                  ? (typeof ownerCandidate === "object" && ownerCandidate.toText
                      ? ownerCandidate.toText()
                      : String(ownerCandidate))
                  : "";
                const ownerUsername = await resolveOwnerUsername(ownerPrincipal);
                const { mintedAtNs, entitlementExpiresAtMs } = await fetchMintMeta(idNum);
                return {
                  memeId: idNum,
                  title,
                  imageUrl,
                  ownerPrincipal,
                  ownerUsername,
                  saleSnapshot,
                  mintedAtNs,
                  entitlementExpiresAtMs,
                };
              } catch {
                return null;
              }
            })
          );
          const cleaned = enriched.filter(Boolean).filter((it) => it.saleSnapshot?.isListed);
          setListings(cleaned);
        } catch {}
        
        // Refresh sale snapshot for affected winner if applicable
        const changedId = Number(e?.detail?.memeId ?? 0);
        if (changedId) {
          try {
            const refreshed = await backendService.getSaleMetadataForMeme(
              BigInt(changedId)
            );
            const snap = parseSaleMetadata(refreshed);
            setTopWinners((prev) =>
              prev.map((w) =>
                w.memeId === changedId ? { ...w, saleSnapshot: snap } : w
              )
            );
          } catch {}
        }
      } catch {}
    };
    window.addEventListener("marketplace:listings-updated", onListingsUpdated);
    return () =>
      window.removeEventListener(
        "marketplace:listings-updated",
        onListingsUpdated
      );
  }, []);

  // Fetch all actively listed NFTs for the marketplace grid
  useEffect(() => {
    let cancelled = false;
    const fetchAllListings = async () => {
      try {
        setLoadingListings(true);
        setListingsError(null);
        await backendService.ensureReady();

        const raw = await backendService.getMarketplaceMemes();
        const items = Array.isArray(raw) ? raw : [];

        const enriched = await Promise.all(
          items.map(async (entry) => {
            try {
              // entry may be:
              // - raw meme id (number/bigint/string)
              // - sale record with meme_id
              // - meme object with id and sale_metadata
              let memeIdCandidate = entry;
              if (typeof entry === "object" && entry !== null) {
                if (entry?.meme_id != null) {
                  memeIdCandidate = entry.meme_id;
                } else if (entry?.id != null) {
                  memeIdCandidate = entry.id;
                }
              }
              const idNum = Number(
                typeof memeIdCandidate === "object" && memeIdCandidate?.toString
                  ? memeIdCandidate.toString()
                  : memeIdCandidate
              );
              const meme = await backendService.getMeme(BigInt(idNum));
              const sale = await backendService.getSaleMetadataForMeme(
                BigInt(idNum)
              );
              const saleSnapshot = parseSaleMetadata(sale);
              const captionField = meme?.meme_data?.caption;
              const caption = Array.isArray(captionField)
                ? captionField[0]
                : captionField;
              const prompt = meme?.meme_data?.prompt ?? "";
              const title =
                (caption && String(caption).trim()) ||
                (prompt && String(prompt).trim()) ||
                `Meme #${idNum}`;
              const imageUrl = meme?.meme_data?.image_url ?? null;
              const ownerCandidate =
                meme?.owner ?? meme?.meme_data?.owner ?? null;
              const ownerPrincipal = ownerCandidate
                ? typeof ownerCandidate === "object" && ownerCandidate.toText
                  ? ownerCandidate.toText()
                  : String(ownerCandidate)
                : "";
              const ownerUsername = await resolveOwnerUsername(ownerPrincipal);
              const { mintedAtNs, entitlementExpiresAtMs } = await fetchMintMeta(idNum);
              return {
                memeId: idNum,
                title,
                imageUrl,
                ownerPrincipal,
                ownerUsername,
                saleSnapshot,
                mintedAtNs,
                entitlementExpiresAtMs,
              };
            } catch (e) {
              return null;
            }
          })
        );

        const cleaned = enriched
          .filter(Boolean)
          .filter((it) => it.saleSnapshot?.isListed);
        if (!cancelled) setListings(cleaned);
      } catch (error) {
        if (!cancelled)
          setListingsError(error?.message ?? "Failed to load listings");
      } finally {
        if (!cancelled) setLoadingListings(false);
      }
    };

    fetchAllListings();
    return () => {
      cancelled = true;
    };
  }, []);

  const displayOwnerName = (winner) => {
    if (!winner) return "Unknown";
    return winner.ownerUsername || "Anonymous";
  };

  const formatTimestamp = (ns) => {
    if (!ns) return null;
    try {
      const ms = Number(ns) / 1_000_000;
      if (!Number.isFinite(ms)) return null;
      return new Date(ms).toLocaleString();
    } catch (error) {
      console.warn("Failed to format timestamp", ns, error);
      return null;
    }
  };

  const canMintWinner = (winner) => {
    if (!winner) return false;
    if (!isAuthenticated || authLoading) return false;
    if (!principal) return false;
    const mintedCount = winner.mintedTokens?.length ?? 0;
    return mintedCount === 0 && winner.ownerPrincipal === principal;
  };

  const canListWinner = (winner) => {
    if (!winner) return false;
    if (!isAuthenticated || authLoading) return false;
    if (!principal) return false;
    const mintedCount = winner.mintedTokens?.length ?? 0;
    if (mintedCount === 0) return false;
    if (winner.ownerPrincipal !== principal) return false;
    if (winner.saleSnapshot?.isListed) return false;
    return true;
  };

  const isOwnerAlreadyListed = (winner) => {
    if (!winner) return false;
    if (!principal) return false;
    return (
      winner.ownerPrincipal === principal &&
      Boolean(winner.saleSnapshot?.isListed)
    );
  };

  const openMintDialog = (winner) => {
    if (!winner) return;
    setMintDialog({
      open: true,
      winner,
      mode: "single",
      editions: 10,
      isSubmitting: false,
      error: null,
    });
  };

  const closeMintDialog = () => {
    setMintDialog({
      open: false,
      winner: null,
      mode: "single",
      editions: 10,
      isSubmitting: false,
      error: null,
    });
  };

  const openListingDialog = (winner) => {
    if (!winner) return;
    setListingDialog({
      open: true,
      winner,
      isSubmitting: false,
      error: null,
    });
  };

  const closeListingDialog = () => {
    setListingDialog({
      open: false,
      winner: null,
      isSubmitting: false,
      error: null,
    });
  };

  const handleListingSubmit = async (memeId, options = {}) => {
    if (!memeId) return;
    try {
      setListingDialog((prev) => ({
        ...prev,
        isSubmitting: true,
        error: null,
      }));
      const idText = typeof memeId === "string" ? memeId : String(memeId);
      if (!/^\d+$/.test(idText)) {
        throw new Error("Invalid meme identifier for listing");
      }

      const price = Number(
        options.price ?? options.listingPrice ?? options.amount
      );
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Marketplace listings require a positive price");
      }

      await backendService.listMemeForSale(BigInt(idText), { price });
      toast({
        title: "Listing published",
        description: "Your meme NFT is now trading on the marketplace.",
      });

      let refreshedSnapshot = null;
      try {
        const refreshed = await backendService.getSaleMetadataForMeme(
          BigInt(idText)
        );
        refreshedSnapshot = parseSaleMetadata(refreshed);
      } catch (refreshError) {
        console.warn("Failed to refresh sale metadata:", refreshError);
      }

      const numericId = Number(idText);
      setTopWinners((prev) =>
        prev.map((entry) =>
          entry.memeId === numericId
            ? {
                ...entry,
                saleSnapshot: refreshedSnapshot ?? entry.saleSnapshot,
              }
            : entry
        )
      );

      closeListingDialog();
      // Notify other views (e.g., Portfolio) and refresh marketplace activity listeners
      try {
        window.dispatchEvent(
          new CustomEvent("marketplace:listings-updated", {
            detail: { memeId: numericId },
          })
        );
      } catch {}
    } catch (error) {
      console.error("Listing submission failed:", error);
      setListingDialog((prev) => ({
        ...prev,
        error: error?.message ?? "Failed to list NFT",
      }));
    } finally {
      setListingDialog((prev) => ({ ...prev, isSubmitting: false }));
    }
  };

  const handleMintModeChange = (mode) => {
    setMintDialog((prev) => ({ ...prev, mode, error: null }));
  };

  const handleEditionChange = (value) => {
    setMintDialog((prev) => ({ ...prev, editions: value }));
  };

  const handleMintSubmit = async () => {
    const winner = mintDialog.winner;
    if (!winner) return;

    try {
      setMintDialog((prev) => ({ ...prev, isSubmitting: true, error: null }));

      let modePayload;
      if (mintDialog.mode === "single") {
        modePayload = { type: "single" };
      } else {
        const parsed = Number(mintDialog.editions);
        if (!Number.isInteger(parsed) || parsed < 2) {
          throw new Error("Collections require at least 2 editions.");
        }
        if (parsed > 50) {
          throw new Error("Collections are limited to 50 editions.");
        }
        modePayload = { type: "collection", editions: parsed };
      }

      const mintedTokens = await backendService.mintMeme(
        winner.memeId,
        modePayload
      );
      const normalized = normalizeMintedTokens(mintedTokens);

      setTopWinners((prev) =>
        prev.map((entry) =>
          entry.memeId === winner.memeId
            ? { ...entry, mintedTokens: normalized }
            : entry
        )
      );

      toast({
        title: "NFT mint successful",
        description:
          mintDialog.mode === "single"
            ? "Your 1/1 meme is now live on-chain."
            : `Minted ${normalized.length} editions ready for collectors.`,
      });

      closeMintDialog();
    } catch (error) {
      console.error("Minting failed:", error);
      setMintDialog((prev) => ({
        ...prev,
        error: error?.message ?? "Failed to mint NFT",
      }));
    } finally {
      setMintDialog((prev) => ({ ...prev, isSubmitting: false }));
      if (winner) {
        try {
          const refreshed = await backendService.getMintedTokens(winner.memeId);
          const normalized = normalizeMintedTokens(refreshed);
          setTopWinners((prev) =>
            prev.map((entry) =>
              entry.memeId === winner.memeId
                ? { ...entry, mintedTokens: normalized }
                : entry
            )
          );
        } catch (refreshError) {
          console.warn("Failed to refresh minted tokens:", refreshError);
        }
      }
    }
  };

  const openPreview = (memeLike) => {
    // Map winner/listing objects to `PreviewModal` meme shape
    const mapped = {
      id: memeLike.memeId ?? memeLike.id ?? 0,
      title: memeLike.title ?? "",
      image_url: memeLike.imageUrl ?? memeLike.image_url ?? null,
      caption: memeLike.caption ?? "",
      prompt: memeLike.prompt ?? "",
      creator: memeLike.ownerUsername || memeLike.ownerPrincipal || memeLike.creator || "Anonymous",
      votes: Number(memeLike.votes ?? 0),
      views: Number(memeLike.views ?? 0),
      mintedAtNs: memeLike.mintedAtNs || null,
      entitlementExpiresAtMs: memeLike.entitlementExpiresAtMs || null,
    };
    setSelectedMeme(mapped);
    setPreviewOpen(true);
  };

  const modalWinner = mintDialog.winner;
  const modalMintedCount = modalWinner?.mintedTokens?.length ?? 0;
  const allowMintAction = modalWinner
    ? canMintWinner(modalWinner) && modalMintedCount === 0
    : false;
  const listingTarget = listingDialog.winner
    ? {
        id: listingDialog.winner.memeId,
        title: listingDialog.winner.title,
        imageUrl: listingDialog.winner.imageUrl,
      }
    : null;

  useEffect(() => {
    if (totalSlides > 1) {
      const id = setInterval(() => {
        setCurrentSlide((prev) => (prev + 1) % totalSlides);
      }, 6000);
      return () => clearInterval(id);
    }
  }, [totalSlides]);

  const currentMeme = useMemo(
    () => trendingMemes[currentSlide] ?? trendingMemes[0],
    [currentSlide]
  );

  const goToSlide = (direction) => {
    setCurrentSlide((prev) => {
      if (direction === "next") {
        return (prev + 1) % totalSlides;
      }
      return (prev - 1 + totalSlides) % totalSlides;
    });
  };

  const tickerItems = useMemo(
    () =>
      topWinners.map((winner) => {
        const listing = winner.saleSnapshot;
        const priceDisplay = listing
          ? listing.listingType === "FixedPrice"
            ? `${formatIcpValue(listing.listingPriceIcp)} ICP`
            : formatListingStatus(listing)
          : "—";
        return {
          id: winner.memeId,
          rank: winner.rank,
          title: winner.title,
          votes: winner.votes,
          minted: winner.mintedTokens?.length ?? 0,
          listingLabel: formatListingStatus(listing),
          priceDisplay,
        };
      }),
    [topWinners]
  );

  const exchangeSummary = useMemo(() => {
    const totalVotes = topWinners.reduce(
      (sum, winner) => sum + Number(winner.votes ?? 0),
      0
    );
    const listed = topWinners.filter(
      (winner) => winner.saleSnapshot?.isListed
    ).length;
    const minted = topWinners.reduce(
      (sum, winner) => sum + (winner.mintedTokens?.length ?? 0),
      0
    );
    return { totalVotes, listed, minted };
  }, [topWinners]);

  // Marketplace metrics from live listings
  const marketMetrics = useMemo(() => {
    const listed = listings.filter((l) => l?.saleSnapshot?.isListed);
    const prices = listed
      .map((l) => Number(l?.saleSnapshot?.listingPriceIcp ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    const totalListings = listed.length;
    const floor = prices.length ? Math.min(...prices) : 0;
    const avg = prices.length
      ? prices.reduce((a, b) => a + b, 0) / prices.length
      : 0;
    return { totalListings, floor, avg };
  }, [listings]);

  return (
    <PageShell>
      <section className="page-section space-y-8">
        <div className="grid gap-8 lg:grid-cols-[1.2fr,0.8fr]">
          <div className="space-y-6 text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
              <Flame className="h-4 w-4 text-primary" />
              Meme Exchange
            </span>
            <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              Trade meme NFTs like it’s the opening bell
            </h1>
            <p className="text-lg text-muted-foreground sm:max-w-2xl">
              Monitor live drops, lock in fixed prices, and send bidding wars to
              the dedicated auction arena. Every weekly winner can mint and list
              directly without leaving the exchange view.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link to="/myplace">
                <Button variant="hero" size="xl" className="px-10">
                  Mint a Meme NFT
                </Button>
              </Link>
              <Link to="/auction">
                <Button
                  variant="outline"
                  size="lg"
                  className="rounded-full border-border/60 bg-background/70"
                >
                  View Live Auctions
                </Button>
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                  Total votes this week
                </p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  {exchangeSummary.totalVotes.toLocaleString()}
                </p>
              </div>
              <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                  Live listings
                </p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  {marketMetrics.totalListings}
                </p>
              </div>
              <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                  Floor / Avg
                </p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  {marketMetrics.floor.toFixed(2)} /{" "}
                  {marketMetrics.avg.toFixed(2)} ICP
                </p>
              </div>
            </div>
          </div>
          <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-border/60 bg-background/70">
            <div className="flex items-center justify-between border-b border-border/40 px-5 py-4 text-xs uppercase tracking-[0.3em] text-muted-foreground">
              <span>Live order tape</span>
              <span>{new Date().toLocaleTimeString()}</span>
            </div>
            <div className="divide-y divide-border/50">
              {tickerItems.length > 0 ? (
                tickerItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between px-5 py-4 transition hover:bg-background/60"
                  >
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {item.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        #{item.rank} • {item.listingLabel}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-primary">
                        {item.priceDisplay}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.votes.toLocaleString()} votes • {item.minted}{" "}
                        minted
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  Mint a meme winner to populate today’s trading tape.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* All Listings Section */}
      <section className="page-section space-y-6">
        <Card className="border-border/50 bg-background/80 shadow-card backdrop-blur-xl">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-3 text-xl font-semibold text-muted-foreground">
                <TrendingUp className="h-5 w-5 text-primary" />
                Live Listings
              </CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                All NFTs currently listed for sale.
              </p>
            </div>
          </CardHeader>
          <CardContent>
            {loadingListings ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={`skeleton-${i}`}
                    className="rounded-2xl border border-border/40 bg-card/50 overflow-hidden animate-pulse"
                  >
                    <div className="aspect-square bg-muted/50" />
                    <div className="p-4 space-y-3">
                      <div className="h-4 bg-muted/50 rounded w-3/4" />
                      <div className="h-3 bg-muted/50 rounded w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : listingsError ? (
              <div className="rounded-2xl border border-destructive/50 bg-destructive/10 p-6 text-center text-destructive">
                {listingsError}
              </div>
            ) : listings.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {listings.map((item) => (
                  <div
                    key={`listing-${item.memeId}`}
                    className="group relative rounded-2xl border border-border/40 bg-card overflow-hidden hover:border-primary/50 hover:shadow-2xl transition-all duration-300 cursor-pointer"
                    onClick={() => openPreview({
                      memeId: item.memeId,
                      title: item.title,
                      imageUrl: item.imageUrl,
                      ownerPrincipal: item.ownerPrincipal,
                      votes: item.votes ?? 0,
                    })}
                  >
                    <div className="relative aspect-square overflow-hidden bg-muted/20">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.title}
                          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-8xl">
                          🖼️
                        </div>
                      )}
                      {item.saleSnapshot?.isListed && (
                        <div className="absolute top-3 right-3 bg-emerald-500/90 text-white rounded-lg px-3 py-1.5 shadow-lg">
                          <span className="text-xs font-bold">LISTED</span>
                        </div>
                      )}
                    </div>
                    <div className="p-4 space-y-3">
                      <div>
                        <h3 className="font-bold text-foreground text-lg line-clamp-1 group-hover:text-primary transition-colors">
                          {item.title}
                        </h3>
                        <p className="text-xs text-muted-foreground mt-1">
                          Owner · {item.ownerPrincipal?.slice(0, 8)}...
                          {item.ownerPrincipal?.slice(-6)}
                        </p>
                      </div>
                      <div className="pt-3 border-t border-border/50">
                        <p className="text-xs text-muted-foreground">Price</p>
                        <p className="text-xl font-bold text-primary">
                          {formatIcpValue(item.saleSnapshot?.listingPriceIcp)}{" "}
                          ICP
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No live listings yet.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="px-5 pb-12 sm:px-8">
        <div className="mx-auto max-w-6xl space-y-8">
          {trendingMemes.length > 0 && (
            <div className="relative overflow-hidden rounded-3xl border border-border/60 bg-background/80 p-2 shadow-card backdrop-blur-xl">
              <div className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs uppercase tracking-[0.3em] text-primary">
                <TrendingUp className="h-3.5 w-3.5" /> Trending Memes
              </div>
              <button
                type="button"
                onClick={() => goToSlide("prev")}
                className="group absolute left-6 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground transition hover:border-primary/60 hover:text-primary"
                aria-label="Previous meme"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => goToSlide("next")}
                className="group absolute right-6 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground transition hover:border-primary/60 hover:text-primary"
                aria-label="Next meme"
              >
                <ArrowRight className="h-5 w-5" />
              </button>
              <div className="relative overflow-hidden rounded-[calc(theme(borderRadius.3xl)-0.5rem)]">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={currentMeme.id}
                    variants={slideVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    transition={{ duration: 0.5, ease: "easeOut" }}
                    className="grid gap-8 p-6 sm:p-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center"
                  >
                    <div className="overflow-hidden rounded-3xl border border-border/60 bg-background/60">
                      <motion.img
                        src={currentMeme.image}
                        alt={currentMeme.title}
                        className="h-full w-full object-cover"
                        initial={{ scale: 1.08 }}
                        animate={{ scale: 1 }}
                        transition={{ duration: 0.6, ease: "easeOut" }}
                      />
                    </div>
                    <div className="flex flex-col gap-6 text-left">
                      <div className="space-y-2">
                        <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs uppercase tracking-[0.3em] text-muted-foreground">
                          {currentMeme.collection}
                        </div>
                        <h2 className="text-3xl font-semibold text-foreground sm:text-4xl">
                          {currentMeme.title}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                          {currentMeme.description}
                        </p>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="rounded-2xl border border-border/60 bg-background/80 p-4">
                          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                            Creator
                          </p>
                          <p className="mt-2 text-lg font-semibold">
                            {currentMeme.creator}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border/60 bg-background/80 p-4">
                          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                            Floor
                          </p>
                          <p className="mt-2 text-lg font-semibold text-primary">
                            {currentMeme.floor}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border/60 bg-background/80 p-4">
                          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                            {currentMeme.priceLabel}
                          </p>
                          <p className="mt-2 text-lg font-semibold text-foreground">
                            {currentMeme.price}
                          </p>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="mt-3 flex justify-center gap-2 pb-2">
                {trendingMemes.map((meme, index) => (
                  <button
                    key={meme.id}
                    type="button"
                    onClick={() => setCurrentSlide(index)}
                    className={`h-2.5 rounded-full transition ${
                      index === currentSlide
                        ? "w-10 bg-primary"
                        : "w-5 bg-border hover:bg-primary/60"
                    }`}
                    aria-label={`Go to slide ${index + 1}`}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Modern NFT Grid Layout */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-foreground flex items-center gap-3">
                  <Trophy className="h-6 w-6 text-primary" />
                  Marketplace NFTs
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Top minted NFTs from this week's winners
                </p>
              </div>
            </div>

            {winnersLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="rounded-2xl border border-border/40 bg-card/50 overflow-hidden animate-pulse"
                  >
                    <div className="aspect-square bg-muted/50" />
                    <div className="p-4 space-y-3">
                      <div className="h-4 bg-muted/50 rounded w-3/4" />
                      <div className="h-3 bg-muted/50 rounded w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : winnersError ? (
              <div className="rounded-2xl border border-destructive/50 bg-destructive/10 p-6 text-center text-destructive">
                {winnersError}
              </div>
            ) : topWinners.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {topWinners.map((winner) => {
                  const mintedCount = winner.mintedTokens?.length ?? 0;
                  const listingPrice = winner.saleSnapshot?.price
                    ? (winner.saleSnapshot.price / 100000000).toFixed(2)
                    : null;
                  const isListed = winner.saleSnapshot?.isListed;

                  return (
                    <div
                      key={winner.memeId}
                      className="group relative rounded-2xl border border-border/40 bg-card overflow-hidden hover:border-primary/50 hover:shadow-2xl transition-all duration-300 cursor-pointer"
                      onClick={() => openPreview(winner)}
                    >
                      {/* NFT Image */}
                      <div className="relative aspect-square overflow-hidden bg-muted/20">
                        {winner.imageUrl ? (
                          <img
                            src={winner.imageUrl}
                            alt={winner.title}
                            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-8xl">
                            🖼️
                          </div>
                        )}

                        {/* Rank Badge */}
                        <div className="absolute top-3 left-3 bg-gradient-to-br from-amber-400 to-orange-500 text-white rounded-lg px-3 py-1.5 shadow-lg flex items-center gap-1.5">
                          <Trophy className="h-4 w-4" />
                          <span className="text-sm font-bold">
                            #{winner.rank}
                          </span>
                        </div>

                        {/* Listed Badge */}
                        {isListed && (
                          <div className="absolute top-3 right-3 bg-emerald-500/90 text-white rounded-lg px-3 py-1.5 shadow-lg">
                            <span className="text-xs font-bold">LISTED</span>
                          </div>
                        )}
                      </div>

                      {/* NFT Info */}
                      <div className="p-4 space-y-3">
                        {/* Title */}
                        <div>
                          <h3 className="font-bold text-foreground text-lg line-clamp-1 group-hover:text-primary transition-colors">
                            {winner.title}
                          </h3>
                          <p className="text-xs text-muted-foreground mt-1">
                            by {displayOwnerName(winner)}
                          </p>
                        </div>

                        {/* Stats */}
                        <div className="flex items-center justify-between text-sm">
                          <div>
                            <p className="text-xs text-muted-foreground">
                              Votes
                            </p>
                            <p className="font-bold text-foreground">
                              {Number(winner.votes ?? 0).toLocaleString()}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-muted-foreground">
                              Minted
                            </p>
                            <p className="font-bold text-foreground">
                              {mintedCount}
                            </p>
                          </div>
                        </div>

                        {/* Price or Status */}
                        {isListed && listingPrice ? (
                          <div className="pt-3 border-t border-border/50">
                            <p className="text-xs text-muted-foreground">
                              Price
                            </p>
                            <p className="text-xl font-bold text-primary">
                              {listingPrice} ICP
                            </p>
                          </div>
                        ) : (
                          <div className="pt-3 border-t border-border/50">
                            <p className="text-xs text-muted-foreground">
                              Status
                            </p>
                            <p className="text-sm font-semibold text-foreground">
                              Not Listed
                            </p>
                          </div>
                        )}

                        {/* Owner actions */}
                        {isAuthenticated &&
                          winner.ownerPrincipal === principal && (
                            <div className="pt-3">
                              {isOwnerAlreadyListed(winner) ? (
                                <Button variant="outline" size="sm" disabled>
                                  Already listed
                                </Button>
                              ) : canListWinner(winner) ? (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => openListingDialog(winner)}
                                >
                                  List on marketplace
                                </Button>
                              ) : null}
                            </div>
                          )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-2xl border border-border/40 bg-card/50 p-12 text-center">
                <Trophy className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
                <p className="text-muted-foreground">No NFTs available yet</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="page-section space-y-6">
        <Card className="border-border/50 bg-background/80 shadow-card backdrop-blur-xl">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-3 text-xl font-semibold text-muted-foreground">
                <TrendingUp className="h-5 w-5 text-primary" />
                Market Table
              </CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                Browse live NFT collections, track rankings, and discover
                trending meme drops in the marketplace.
              </p>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {tickerItems.length > 0 ? (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="min-w-full divide-y divide-border text-left text-sm">
                    <thead className="uppercase tracking-[0.3em] text-muted-foreground">
                      <tr>
                        <th className="py-3 pr-4 font-medium">Meme</th>
                        <th className="py-3 pr-4 font-medium">Last Price</th>
                        <th className="py-3 pr-4 font-medium">Votes</th>
                        <th className="py-3 pr-4 font-medium">Minted</th>
                        <th className="py-3 pr-4 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {tickerItems.map((item) => (
                        <tr
                          key={`order-${item.id}`}
                          className="transition hover:bg-background/50"
                        >
                          <td className="whitespace-nowrap py-4 pr-4 text-foreground">
                            #{item.rank} · {item.title}
                          </td>
                          <td className="whitespace-nowrap py-4 pr-4 font-semibold text-primary">
                            {item.priceDisplay}
                          </td>
                          <td className="whitespace-nowrap py-4 pr-4 text-foreground">
                            {item.votes.toLocaleString()}
                          </td>
                          <td className="whitespace-nowrap py-4 pr-4 text-foreground">
                            {item.minted}
                          </td>
                          <td className="whitespace-nowrap py-4 pr-4 text-muted-foreground">
                            {item.listingLabel}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid gap-3 md:hidden">
                  {tickerItems.map((item) => (
                    <div
                      key={`order-card-${item.id}`}
                      className="rounded-2xl border border-border/60 bg-background/70 p-4 shadow-card"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            #{item.rank} · {item.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.listingLabel}
                          </p>
                        </div>
                        <span className="rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs font-semibold text-primary">
                          {item.priceDisplay}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                        <div>
                          <p className="text-base font-semibold text-foreground">
                            {item.votes.toLocaleString()}
                          </p>
                          <p>Votes</p>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-foreground">
                            {item.minted}
                          </p>
                          <p>Editions</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Waiting for fresh listings. Mint a champion to open the order
                book.
              </p>
            )}
            {!isAuthenticated && (
              <p className="mt-3 text-xs text-muted-foreground">
                Connect your wallet to mint and stream your winners directly to
                the exchange board.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="page-section space-y-6 pb-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
            <Activity className="h-4 w-4 text-primary" />
            Market Feed
          </div>
          <h2 className="text-2xl font-semibold text-foreground sm:text-3xl">
            Watch the market feed in full fidelity
          </h2>
          <p className="text-sm text-muted-foreground sm:max-w-3xl">
            Discover trending NFT collections with detailed previews, creator
            stories, and marketplace analytics.
          </p>
        </div>

        {marketFeed.length > 0 ? (
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            {marketFeed.map((item) => (
              <motion.div
                key={item.id}
                whileHover={{ y: -6 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden rounded-3xl border border-border/60 bg-background/80 shadow-card"
              >
                <div className="relative h-56 overflow-hidden">
                  <img
                    src={item.image}
                    alt={item.title}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="space-y-2 p-5 text-sm">
                  <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                    {item.collection}
                  </p>
                  <h3 className="text-lg font-semibold text-foreground">
                    {item.title}
                  </h3>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Creator: {item.creator}</span>
                    <span className="text-primary">{item.price}</span>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No market feed available yet.
          </p>
        )}
      </section>

      {/* Unified Preview Modal (same as PreMarketplace) */}
      <PreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        meme={selectedMeme}
        // Disable voting in marketplace preview by passing inert props
        onLike={() => {}}
        isAuthenticated={false}
        isOwn={false}
        hasProfileName={false}
      />

      {mintDialog.open && modalWinner ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card className="w-full max-w-lg border-border/70 bg-background/95 shadow-2xl">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-muted-foreground">
                Mint #{modalWinner.memeId} · {modalWinner.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-2xl border border-border/60 bg-background/70 p-4 text-sm text-muted-foreground">
                <p className="font-semibold text-foreground">
                  {modalWinner.title}
                </p>
                <p className="mt-1 text-xs uppercase tracking-[0.3em]">
                  Owner · {displayOwnerName(modalWinner)}
                </p>
                {modalMintedCount > 0 ? (
                  <p className="mt-2 text-emerald-300">
                    Already minted {modalMintedCount}{" "}
                    {modalMintedCount === 1 ? "edition" : "editions"}.
                  </p>
                ) : (
                  <p className="mt-2">
                    Choose how you want to drop this meme on-chain—keep it a 1/1
                    or launch a limited collection.
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                    mintDialog.mode === "single"
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/60 bg-background/70 hover:border-primary/40"
                  }`}
                  onClick={() => handleMintModeChange("single")}
                  disabled={mintDialog.isSubmitting}
                >
                  <span className="block font-semibold">Single edition</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Mint a 1/1 masterpiece for collectors.
                  </span>
                </button>
                <button
                  type="button"
                  className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                    mintDialog.mode === "collection"
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/60 bg-background/70 hover:border-primary/40"
                  }`}
                  onClick={() => handleMintModeChange("collection")}
                  disabled={mintDialog.isSubmitting || modalMintedCount > 0}
                >
                  <span className="block font-semibold">
                    Limited collection
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Set a finite edition count for your drop.
                  </span>
                </button>
              </div>

              {mintDialog.mode === "collection" && (
                <div className="space-y-2 text-sm">
                  <label
                    className="text-xs font-medium text-muted-foreground"
                    htmlFor="mint-editions"
                  >
                    Edition count (2 – 50)
                  </label>
                  <Input
                    id="mint-editions"
                    type="number"
                    min={2}
                    max={50}
                    value={mintDialog.editions}
                    onChange={(event) =>
                      handleEditionChange(event.target.value)
                    }
                    disabled={mintDialog.isSubmitting}
                  />
                </div>
              )}

              {mintDialog.error ? (
                <p className="text-sm text-destructive">{mintDialog.error}</p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-3">
                <Button
                  variant="ghost"
                  onClick={closeMintDialog}
                  disabled={mintDialog.isSubmitting}
                >
                  Close
                </Button>
                <Button
                  onClick={handleMintSubmit}
                  disabled={mintDialog.isSubmitting || !allowMintAction}
                >
                  {mintDialog.isSubmitting ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Minting…
                    </span>
                  ) : allowMintAction ? (
                    "Mint now"
                  ) : modalMintedCount > 0 ? (
                    "Mint complete"
                  ) : (
                    "Mint locked"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
      <ListingModal
        isOpen={listingDialog.open}
        onClose={closeListingDialog}
        nft={listingTarget}
        onConfirm={handleListingSubmit}
        isProcessing={listingDialog.isSubmitting}
        error={listingDialog.error}
        allowedModes={["fixed"]}
        title="List on marketplace"
        confirmLabel="Publish listing"
      />
      
    </PageShell>
  );
};

export default Marketplace;
