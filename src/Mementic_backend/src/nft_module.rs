// src/lib.rs
use candid::{CandidType, Decode, Encode, Nat, Principal};
use ic_cdk::api::time;
use ic_cdk_macros::{init, query, update};
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::{Bound, Storable},
    DefaultMemoryImpl, StableBTreeMap,
};

use crate::{
    HttpResponse, MemeData, MemeVotes, TransformArgs, VoteRecord, VoteResponse, VoteType,
    WeeklyLeaderboard, WeeklyPeriod,
};

use serde::{Deserialize, Serialize};
use std::{borrow::Cow, cell::RefCell};

// Import shared types (must exist in your crate)
use crate::http_outcall::PublicStoredMeme;
use crate::TopEntry;

// ---------- Stable memory ----------
type Mem = VirtualMemory<DefaultMemoryImpl>;

// ---------- Wrappers to implement Storable ----------
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct SNat(pub Nat);

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct SPrincipal(pub Principal);

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize)]
pub struct OwnerTokens(pub Vec<Nat>);

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize)]
pub struct MemeTokenList(pub Vec<Nat>);

// Wrapper for storing image bytes in stable map (so Vec<u8> is Storable)
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct ImageBlob(pub Vec<u8>);

impl Storable for SNat {
    // Variable-length because Candid’s Nat encoding is arbitrary precision.
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Owned(candid::Encode!(&self).expect("encode SNat"))
    }

    fn into_bytes(self) -> Vec<u8> {
        candid::Encode!(&self).expect("encode SNat")
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::Decode!(&bytes, SNat).unwrap_or_else(|_| SNat(Nat::from(0u32)))
    }
}

impl Storable for SPrincipal {
    const BOUND: Bound = Bound::Bounded {
        max_size: 64,
        is_fixed_size: false,
    };

    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Owned(candid::Encode!(&self).expect("encode SPrincipal"))
    }

    fn into_bytes(self) -> Vec<u8> {
        candid::Encode!(&self).expect("encode SPrincipal")
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::Decode!(&bytes, SPrincipal).unwrap_or_else(|_| SPrincipal(Principal::anonymous()))
    }
}

impl Storable for OwnerTokens {
    // Arbitrary-length Candid serialization; okay for values.
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Owned(candid::Encode!(&self).expect("encode OwnerTokens"))
    }

    fn into_bytes(self) -> Vec<u8> {
        candid::Encode!(&self).expect("encode OwnerTokens")
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::Decode!(&bytes, OwnerTokens).unwrap_or_else(|_| OwnerTokens(Vec::new()))
    }
}

impl Storable for MemeTokenList {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Owned(candid::Encode!(&self).expect("encode MemeTokenList"))
    }

    fn into_bytes(self) -> Vec<u8> {
        candid::Encode!(&self).expect("encode MemeTokenList")
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::Decode!(&bytes, MemeTokenList).unwrap_or_else(|_| MemeTokenList(Vec::new()))
    }
}

impl Storable for ImageBlob {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Owned(candid::Encode!(&self).expect("encode ImageBlob"))
    }

    fn into_bytes(self) -> Vec<u8> {
        candid::Encode!(&self).expect("encode ImageBlob")
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::Decode!(&bytes, ImageBlob).unwrap_or_else(|_| ImageBlob(Vec::new()))
    }
}

// ---------- Collection state ----------
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct CollectionState {
    pub name: String,
    pub symbol: String,
    pub description: Option<String>,
    pub logo: Option<String>,
    pub total_supply: Nat,
    pub admin: Principal,
    pub created_at: u64,
}

impl Default for CollectionState {
    fn default() -> Self {
        Self {
            name: String::new(),
            symbol: String::new(),
            description: None,
            logo: None,
            total_supply: Nat::from(0u32),
            admin: Principal::anonymous(),
            created_at: 0,
        }
    }
}

// ---------- NFT metadata ----------
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct TokenMetadataEntry {
    pub name: String,
    pub immutable: bool,
    pub value: MetadataValue,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub enum MetadataValue {
    Text(String),
    Blob(Vec<u8>),
    Map(Vec<(String, MetadataValue)>),
    Array(Vec<MetadataValue>),
}

// Token record: note CandidType added and metadata uses Vec<TokenMetadataEntry>
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct TokenRecord {
    pub token_id: Nat,
    pub owner: Principal,
    pub minted_at: u64,
    pub meme_id: u64,
    pub metadata: Vec<TokenMetadataEntry>,
    pub mime_type: Option<String>, // small
    pub has_image: bool,           // indicates presence in STORED_IMAGES
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub enum ListingType {
    None,
    FixedPrice,
    Auction,
}

impl Default for ListingType {
    fn default() -> Self {
        ListingType::None
    }
}

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize)]
pub struct TokenSaleMetadata {
    pub token_id: Nat,
    pub meme_id: u64,
    pub is_listed: bool,
    pub listing_price: Option<u64>,
    pub listed_at: Option<u64>,
    pub total_sales: u64,
    pub total_earned: u64,
    pub last_sale_price: Option<u64>,
    pub last_sale_at: Option<u64>,
    pub listing_type: ListingType,
    pub auction_start_price: Option<u64>,
    pub auction_highest_bid: Option<u64>,
    pub auction_highest_bidder: Option<SPrincipal>,
    pub auction_bid_count: u32,
}

#[derive(Clone, CandidType, Deserialize)]
pub struct NftImage {
    pub mime_type: String,
    pub image: Vec<u8>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct SupportedStandard {
    pub name: String,
    pub url: String,
}

impl Storable for TokenRecord {
    // Variable-size Candid; fine for values (not keys).
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Owned(candid::Encode!(&self).expect("encode TokenRecord"))
    }

    fn into_bytes(self) -> Vec<u8> {
        candid::Encode!(&self).expect("encode TokenRecord")
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::Decode!(&bytes, TokenRecord).unwrap_or_else(|_| TokenRecord {
            token_id: Nat::from(0u32),
            owner: Principal::anonymous(),
            minted_at: 0,
            meme_id: 0,
            metadata: Vec::new(),
            mime_type: None,
            has_image: false,
        })
    }
}

impl Storable for TokenSaleMetadata {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Owned(candid::Encode!(&self).expect("encode TokenSaleMetadata"))
    }

    fn into_bytes(self) -> Vec<u8> {
        candid::Encode!(&self).expect("encode TokenSaleMetadata")
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::Decode!(&bytes, TokenSaleMetadata).unwrap_or_else(|_| TokenSaleMetadata::default())
    }
}

thread_local! {
    // CRITICAL: Use shared MEMORY_MANAGER from state module to prevent memory corruption
    static TOKENS: RefCell<StableBTreeMap<SNat, TokenRecord, Mem>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(0)))
        ));

    static OWNER_INDEX: RefCell<StableBTreeMap<SPrincipal, OwnerTokens, Mem>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(1)))
        ));

    static MINT_INDEX: RefCell<StableBTreeMap<u64, MemeTokenList, Mem>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(2)))
        ));

    static STATE: RefCell<CollectionState> = RefCell::new(CollectionState::default());

    // NEW: store actual image bytes (ImageBlob wraps Vec<u8>)
    static STORED_IMAGES: RefCell<StableBTreeMap<u64, ImageBlob, Mem>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(6)))
        ));

    static TOKEN_SALES: RefCell<StableBTreeMap<SNat, TokenSaleMetadata, Mem>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(5)))
        ));
}

// ---------- Init ----------
#[derive(CandidType, Deserialize)]
pub struct InitArgs {
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub description: Option<String>,
    pub logo: Option<String>,
    pub admin: Option<Principal>,
}

#[init]
fn init(args: Option<InitArgs>) {
    let caller = ic_cdk::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.name = args
            .as_ref()
            .and_then(|a| a.name.clone())
            .unwrap_or_else(|| "Mementic Top Memes".into());
        st.symbol = args
            .as_ref()
            .and_then(|a| a.symbol.clone())
            .unwrap_or_else(|| "MEME".into());
        st.description = args.as_ref().and_then(|a| a.description.clone());
        st.logo = args.as_ref().and_then(|a| a.logo.clone());
        st.admin = args.as_ref().and_then(|a| a.admin).unwrap_or(caller);
        st.total_supply = Nat::from(0u32);
        st.created_at = time();
    });

    // Initialize sample feedback data (project-specific)
    crate::init_feedback_data();

    crate::rollover::ensure_active_week_initialized();
    crate::rollover::start_rollover_timer();
}

fn assert_admin() {
    if ic_cdk::caller() != STATE.with(|s| s.borrow().admin) {
        ic_cdk::trap("Unauthorized: admin only");
    }
}

#[query]
pub fn get_admin() -> Principal {
    STATE.with(|s| s.borrow().admin)
}

// ---------- ICRC-7-ish queries ----------
#[query(name = "icrc7_name")]
pub fn icrc7_name() -> String {
    STATE.with(|s| s.borrow().name.clone())
}

#[query(name = "icrc7_symbol")]
pub fn icrc7_symbol() -> String {
    STATE.with(|s| s.borrow().symbol.clone())
}

#[query(name = "icrc7_total_supply")]
pub fn icrc7_total_supply() -> Nat {
    STATE.with(|s| s.borrow().total_supply.clone())
}

#[query(name = "icrc7_supported_standards")]
pub fn icrc7_supported_standards() -> Vec<SupportedStandard> {
    vec![
        SupportedStandard {
            name: "ICRC-7".into(),
            url: "https://github.com/dfinity/ICRC/ICRCs/ICRC-7".into(),
        },
        SupportedStandard {
            name: "ICRC-37".into(),
            url: "https://github.com/dfinity/ICRC/ICRCs/ICRC-37".into(),
        },
    ]
}

#[query(name = "icrc7_owner_of")]
pub fn icrc7_owner_of(token_ids: Vec<Nat>) -> Vec<Option<Principal>> {
    TOKENS.with(|t| {
        let map = t.borrow();
        token_ids
            .into_iter()
            .map(|id| map.get(&SNat(id)).map(|r| r.owner))
            .collect()
    })
}

#[query(name = "icrc7_tokens_of")]
pub fn icrc7_tokens_of(owner: Principal) -> Vec<Nat> {
    OWNER_INDEX.with(|idx| {
        idx.borrow()
            .get(&SPrincipal(owner))
            .map(|ot| ot.0.clone())
            .unwrap_or_default()
    })
}

#[query]
pub fn get_token(token_id: Nat) -> Option<TokenRecord> {
    TOKENS.with(|t| t.borrow().get(&SNat(token_id)))
}

#[query]
pub fn get_token_by_meme_id(meme_id: u64) -> Option<Nat> {
    MINT_INDEX
        .with(|m| m.borrow().get(&meme_id))
        .and_then(|list| list.0.first().cloned())
}

#[query]
pub fn get_tokens_by_meme_id(meme_id: u64) -> Vec<Nat> {
    MINT_INDEX
        .with(|m| m.borrow().get(&meme_id))
        .map(|list| list.0.clone())
        .unwrap_or_default()
}

#[query]
pub fn get_nft_image(token_id: Nat) -> Option<NftImage> {
    let rec_opt = TOKENS.with(|t| t.borrow().get(&SNat(token_id.clone())));
    let rec = rec_opt?;
    let mime = rec
        .mime_type
        .clone()
        .unwrap_or("application/octet-stream".to_string());
    let img_blob = STORED_IMAGES.with(|imgs| imgs.borrow().get(&rec.meme_id))?;
    Some(NftImage {
        mime_type: mime,
        image: img_blob.0.clone(),
    })
}

#[query]
pub fn get_sale_metadata(token_id: Nat) -> Option<TokenSaleMetadata> {
    TOKEN_SALES.with(|sales| sales.borrow().get(&SNat(token_id)))
}

#[query]
pub fn get_sale_metadata_for_meme(meme_id: u64) -> Option<TokenSaleMetadata> {
    let token_id = get_token_by_meme_id(meme_id)?;
    TOKEN_SALES.with(|sales| sales.borrow().get(&SNat(token_id)))
}

#[query]
pub fn get_all_minted_tokens() -> Vec<TokenRecord> {
    TOKENS.with(|t| {
        let map = t.borrow();
        map.iter().map(|entry| entry.value().clone()).collect()
    })
}

pub fn mutate_sale_metadata<F>(token_id: &Nat, meme_id: u64, mutator: F) -> TokenSaleMetadata
where
    F: FnOnce(&mut TokenSaleMetadata),
{
    TOKEN_SALES.with(|sales| {
        let mut map = sales.borrow_mut();
        let mut record = map
            .get(&SNat(token_id.clone()))
            .unwrap_or_else(|| TokenSaleMetadata {
                token_id: token_id.clone(),
                meme_id,
                ..Default::default()
            });
        record.token_id = token_id.clone();
        record.meme_id = meme_id;
        let mut_record = &mut record;
        mutator(mut_record);
        map.insert(SNat(token_id.clone()), record.clone());
        record
    })
}

// ---------- Internal helpers ----------
fn next_token_id() -> Nat {
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let tid = st.total_supply.clone();
        st.total_supply = st.total_supply.clone() + Nat::from(1u32);
        tid
    })
}

fn push_owner(owner: Principal, token_id: &Nat) {
    OWNER_INDEX.with(|idx| {
        let mut map = idx.borrow_mut();
        let mut list = map.get(&SPrincipal(owner)).unwrap_or_default();
        list.0.push(token_id.clone());
        map.insert(SPrincipal(owner), list);
    });
}

fn guess_content_type(ext: &str) -> Option<String> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png".into()),
        "jpg" | "jpeg" => Some("image/jpeg".into()),
        "webp" => Some("image/webp".into()),
        "gif" => Some("image/gif".into()),
        "bmp" => Some("image/bmp".into()),
        "tiff" | "tif" => Some("image/tiff".into()),
        _ => None,
    }
}

fn build_metadata(m: &PublicStoredMeme, token_id: &Nat) -> Vec<TokenMetadataEntry> {
    let ct = guess_content_type(&m.meme_data.image_format);

    let mut root: Vec<TokenMetadataEntry> = vec![
        TokenMetadataEntry {
            name: "icrc7:metadata:uri:image".into(),
            immutable: true,
            value: MetadataValue::Text(m.meme_data.image_url.clone()),
        },
        TokenMetadataEntry {
            name: "icrc7:token_metadata".into(),
            immutable: true,
            value: MetadataValue::Map(vec![
                ("meme:id".into(), MetadataValue::Text(m.id.to_string())),
                (
                    "meme:prompt".into(),
                    MetadataValue::Text(m.meme_data.prompt.clone()),
                ),
                (
                    "meme:caption".into(),
                    MetadataValue::Text(m.meme_data.caption.clone().unwrap_or_default()),
                ),
                (
                    "meme:filename".into(),
                    MetadataValue::Text(m.meme_data.image_filename.clone()),
                ),
                (
                    "meme:format".into(),
                    MetadataValue::Text(m.meme_data.image_format.clone()),
                ),
                (
                    "meme:service".into(),
                    MetadataValue::Text(m.meme_data.metadata.service.clone()),
                ),
                (
                    "meme:ai_timestamp_ns".into(),
                    MetadataValue::Text(m.meme_data.metadata.timestamp.to_string()),
                ),
                (
                    "meme:file_size_bytes".into(),
                    MetadataValue::Text(m.meme_data.metadata.file_size_bytes.to_string()),
                ),
                (
                    "meme:created_at_ns".into(),
                    MetadataValue::Text(m.created_at.to_string()),
                ),
                (
                    "meme:stored_at_ns".into(),
                    MetadataValue::Text(m.canister_timestamp.to_string()),
                ),
                (
                    "nft:token_id".into(),
                    MetadataValue::Text(token_id.to_string()),
                ),
            ]),
        },
    ];

    if let Some(ctext) = ct {
        root.push(TokenMetadataEntry {
            name: "icrc7:metadata:content_type".into(),
            immutable: true,
            value: MetadataValue::Text(ctext),
        });
    }

    root
}

// ---------- X-canister clients ----------
async fn voting_get_top3_for_week(
    voting_canister: Principal,
    week_id: u64,
) -> Result<Vec<TopEntry>, String> {
    use ic_cdk::api::call::call;
    call::<(u64,), (Result<Vec<TopEntry>, String>,)>(
        voting_canister,
        "get_top3_for_week",
        (week_id,),
    )
    .await
    .map(|(res,)| res)
    .map_err(|e| format!("get_top3_for_week call failed: {:?}", e))?
}

async fn voting_get_meme_data(
    voting_canister: Principal,
    meme_id: u64,
) -> Result<Option<PublicStoredMeme>, String> {
    use ic_cdk::api::call::call;
    call::<(u64,), (Option<PublicStoredMeme>,)>(voting_canister, "get_meme", (meme_id,))
        .await
        .map(|(res,)| res)
        .map_err(|e| format!("get_meme call failed: {:?}", e))
}

// ---------- Public: mint Top-3 (now fetches image bytes before minting) ----------
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub enum MintingMode {
    Single,
    Collection { editions: u32 },
}

// Normalize meme image URLs so management canister http_request accepts them.
// - Ensure https scheme for remote URLs
// - Convert ipfs://<cid> to a public HTTPS gateway URL
fn normalize_image_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Empty image URL".into());
    }

    if trimmed.starts_with("https://") {
        return Ok(trimmed.to_string());
    }

    // Allow localhost for local development
    if trimmed.starts_with("http://127.0.0.1") || trimmed.starts_with("http://localhost") {
        return Ok(trimmed.to_string());
    }

    if let Some(rest) = trimmed.strip_prefix("ipfs://") {
        // Basic CID/gateway mapping; consider making gateway configurable
        let cid_path = rest.trim_start_matches('/');
        return Ok(format!("https://ipfs.io/ipfs/{}", cid_path));
    }

    // Try to upgrade http -> https for non-local hosts
    if let Some(rest) = trimmed.strip_prefix("http://") {
        return Ok(format!("https://{}", rest));
    }

    Err("Url need to specify https scheme".into())
}

#[update]
pub async fn mint_to(meme_id: u64, mode: MintingMode) -> Result<Vec<Nat>, String> {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        return Err("Authentication required".into());
    }

    let existing_tokens = get_tokens_by_meme_id(meme_id);

    let to_mint = match mode {
        MintingMode::Single => {
            if !existing_tokens.is_empty() {
                return Err("Meme has already been minted as an NFT".into());
            }
            1usize
        }
        MintingMode::Collection { editions } => {
            if editions == 0 {
                return Err("Collection supply must be greater than zero".into());
            }
            if editions > 50 {
                return Err("Collection supply cannot exceed 50 editions".into());
            }
            if !existing_tokens.is_empty() {
                return Err("A collection has already been minted for this meme".into());
            }
            editions as usize
        }
    };

    let voting_canister = ic_cdk::api::id();
    let stored_meme_data = voting_get_meme_data(voting_canister, meme_id)
        .await?
        .ok_or_else(|| format!("StoredMeme {} not found in voting canister", meme_id))?;

    if caller != stored_meme_data.owner {
        return Err("Only the winning meme owner can mint this NFT".into());
    }

    // Eligibility is guaranteed by the active mint entitlement below.
    // Previously this validated via vote records and top3 snapshot, but
    // vote data is intentionally cleaned up after finalization.
    // The entitlement encodes the correct week and rank for this meme.

    let request_time = ic_cdk::api::time();
    let (entitlement_id, _entitlement) =
        crate::entitlements::require_active_entitlement(caller, meme_id, request_time)?;

    let image_url = stored_meme_data.meme_data.image_url.clone();
    let fetch_url = normalize_image_url(&image_url)?;
    let image_format = stored_meme_data.meme_data.image_format.clone();
    let mime_type =
        guess_content_type(&image_format).unwrap_or_else(|| "application/octet-stream".into());

    let image_bytes = match STORED_IMAGES.with(|imgs| imgs.borrow().get(&meme_id)) {
        Some(blob) => blob.0.clone(),
        None => match crate::http_outcall::fetch_image_bytes_from_image_storage(&fetch_url).await {
            Ok(b) => b,
            Err(e) => {
                return Err(format!(
                    "failed to fetch image for meme {} : {}",
                    meme_id, e
                ))
            }
        },
    };

    // Store image bytes so subsequent reads can use cached value
    STORED_IMAGES.with(|imgs| {
        imgs.borrow_mut()
            .insert(meme_id, ImageBlob(image_bytes.clone()));
    });

    let total_editions = existing_tokens.len() + to_mint;
    let mut all_tokens = existing_tokens.clone();
    let mut minted_tokens = Vec::with_capacity(to_mint);
    let minted_at = ic_cdk::api::time();

    for edition_offset in 0..to_mint {
        let token_id = next_token_id();
        let mut metadata = build_metadata(&stored_meme_data, &token_id);
        metadata.push(TokenMetadataEntry {
            name: "icrc7:metadata:content_type".into(),
            immutable: true,
            value: MetadataValue::Text(mime_type.clone()),
        });

        if total_editions > 1 {
            let edition_number = existing_tokens.len() + edition_offset + 1;
            metadata.push(TokenMetadataEntry {
                name: "meme:edition_number".into(),
                immutable: true,
                value: MetadataValue::Text(edition_number.to_string()),
            });
            metadata.push(TokenMetadataEntry {
                name: "meme:edition_total".into(),
                immutable: true,
                value: MetadataValue::Text(total_editions.to_string()),
            });
        }

        let rec = TokenRecord {
            token_id: token_id.clone(),
            owner: stored_meme_data.owner,
            minted_at,
            meme_id,
            metadata,
            mime_type: Some(mime_type.clone()),
            has_image: true,
        };

        TOKENS.with(|t| t.borrow_mut().insert(SNat(token_id.clone()), rec));
        push_owner(stored_meme_data.owner, &token_id);
        mutate_sale_metadata(&token_id, meme_id, |_| {});

        all_tokens.push(token_id.clone());
        minted_tokens.push(token_id);
    }

    MINT_INDEX.with(|mi| {
        mi.borrow_mut()
            .insert(meme_id, MemeTokenList(all_tokens.clone()));
    });

    crate::entitlements::mark_entitlement_used(entitlement_id, minted_tokens.clone())?;

    Ok(minted_tokens)
}

#[query]
// This need to be fixed
pub fn get_my_minted_tokens() -> Vec<TokenRecord> {
    let user = ic_cdk::caller();
    TOKENS.with(|t| {
        let map = t.borrow();
        map.iter()
            .filter_map(|entry| {
                let rec = entry.value();
                if rec.owner == user {
                    Some(rec.clone())
                } else {
                    None
                }
            })
            .collect()
    })
}
