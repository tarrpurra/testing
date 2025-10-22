// src/http_outcall.rs
#![allow(clippy::too_many_arguments)]

use candid::{CandidType, Nat, Principal};
use ic_cdk::api::management_canister::http_request::{
    http_request, CanisterHttpRequestArgument, HttpHeader, HttpMethod, HttpResponse, TransformArgs,
    TransformContext,
};
use ic_cdk::{api::time, caller};

use ic_cdk_macros::{query, update};
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    DefaultMemoryImpl, StableBTreeMap, Storable,
};

use ic_cdk::api::call::call;
use ic_cdk::api::call::call_with_payment;

use crate::api_create::register_meme_with_id;
use crate::nft_module::{ListingType, TokenSaleMetadata};
use ic_stable_structures::storable::Bound;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cell::RefCell;

// ---------- Type aliases ----------
type Memory = VirtualMemory<DefaultMemoryImpl>;

// ---------- Constants ----------
const OUTCALL_CYCLES: u128 = 6_000_000_000; // cycles per outcall
const MEME_WORKER_URL: &str = "https://dark-shape-faac.h28177922.workers.dev/generate_meme"; //https://plain-night-ff62.h28177922.workers.dev/generate_meme

// ---------- Storable wrapper for Principal ----------
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, CandidType, Serialize, Deserialize)]
pub struct StorablePrincipal(Principal);

impl Storable for StorablePrincipal {
    const BOUND: Bound = Bound::Bounded {
        max_size: 29,
        is_fixed_size: false,
    };
    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Borrowed(self.0.as_slice())
    }
    fn into_bytes(self) -> Vec<u8> {
        self.0.as_slice().to_vec()
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        StorablePrincipal(Principal::from_slice(bytes.as_ref()))
    }
}
impl From<Principal> for StorablePrincipal {
    fn from(p: Principal) -> Self {
        StorablePrincipal(p)
    }
}
impl From<StorablePrincipal> for Principal {
    fn from(sp: StorablePrincipal) -> Self {
        sp.0
    }
}

// ---------- Storable wrapper for Vec<u64> ----------
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StorableVecU64(pub Vec<u64>);
impl StorableVecU64 {
    pub const MAX_LEN: usize = 1024;
    #[inline]
    fn byte_capacity_for(len: usize) -> usize {
        4 + 8 * len
    }
}
impl Storable for StorableVecU64 {
    const BOUND: Bound = Bound::Bounded {
        max_size: (4 + 8 * Self::MAX_LEN) as u32,
        is_fixed_size: false,
    };
    fn to_bytes(&self) -> Cow<[u8]> {
        let mut len = self.0.len().min(Self::MAX_LEN);
        let mut bytes = Vec::with_capacity(Self::byte_capacity_for(len));
        bytes.extend_from_slice(&(len as u32).to_le_bytes());
        for &item in self.0.iter().take(len) {
            bytes.extend_from_slice(&item.to_le_bytes());
        }
        Cow::Owned(bytes)
    }
    fn into_bytes(self) -> Vec<u8> {
        let mut len = self.0.len().min(Self::MAX_LEN);
        let mut bytes = Vec::with_capacity(Self::byte_capacity_for(len));
        bytes.extend_from_slice(&(len as u32).to_le_bytes());
        for item in self.0.into_iter().take(len) {
            bytes.extend_from_slice(&item.to_le_bytes());
        }
        bytes
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let b = bytes.as_ref();
        if b.len() < 4 {
            return StorableVecU64(Vec::new());
        }
        let declared = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
        let len = declared.min(Self::MAX_LEN);
        let mut v = Vec::with_capacity(len);
        for i in 0..len {
            let start = 4 + i * 8;
            if start + 8 > b.len() {
                break;
            }
            let mut arr = [0u8; 8];
            arr.copy_from_slice(&b[start..start + 8]);
            v.push(u64::from_le_bytes(arr));
        }
        StorableVecU64(v)
    }
}
impl From<Vec<u64>> for StorableVecU64 {
    fn from(v: Vec<u64>) -> Self {
        StorableVecU64(v)
    }
}
impl From<StorableVecU64> for Vec<u64> {
    fn from(sv: StorableVecU64) -> Self {
        sv.0
    }
}

// ---------- Stable memory setup ----------
thread_local! {
    // CRITICAL: Use shared MEMORY_MANAGER from state module to prevent memory corruption
    static RATE: RefCell<StableBTreeMap<StorablePrincipal, DayUsage, Memory>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(20)))
        ));

    pub static MEMES: RefCell<StableBTreeMap<u64, StoredMeme, Memory>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(21)))
        ));

    static USER_MEMES: RefCell<StableBTreeMap<StorablePrincipal, StorableVecU64, Memory>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(22)))
        ));

    static MEME_COUNTER: RefCell<StableBTreeMap<u8, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(23)))
        ));

    // Track unique users who have created memes
    static UNIQUE_USERS: RefCell<StableBTreeMap<StorablePrincipal, bool, Memory>> =
        RefCell::new(StableBTreeMap::init(
            crate::state::MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(24)))
        ));
}

// ---------- Data structures ----------
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub enum ListingStrategy {
    FixedPrice { price_e8s: u64 },
    Auction { start_price_e8s: u64 },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, CandidType)]
struct DayUsage {
    day: u64,
    count: u8,
}
impl Storable for DayUsage {
    const BOUND: Bound = Bound::Bounded {
        max_size: 9,
        is_fixed_size: true,
    };
    fn to_bytes(&self) -> Cow<[u8]> {
        let mut bytes = Vec::with_capacity(9);
        bytes.extend_from_slice(&self.day.to_le_bytes());
        bytes.push(self.count);
        Cow::Owned(bytes)
    }
    fn into_bytes(self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(9);
        bytes.extend_from_slice(&self.day.to_le_bytes());
        bytes.push(self.count);
        bytes
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        if bytes.len() != 9 {
            return DayUsage::default();
        }
        let mut day_arr = [0u8; 8];
        day_arr.copy_from_slice(&bytes[0..8]);
        DayUsage {
            day: u64::from_le_bytes(day_arr),
            count: bytes[8],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct MemeData {
    pub prompt: String,
    pub name: Option<String>,
    pub caption: Option<String>,
    pub image_url: String,
    pub image_filename: String,
    pub image_format: String,
    pub metadata: PythonMetadata,
}
#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct PythonMetadata {
    pub processing_time: f64,
    pub timestamp: u64,
    pub file_size_bytes: u64,
    pub service: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct StoredMeme {
    pub id: u64,
    pub owner: StorablePrincipal,
    pub meme_data: MemeData,
    pub created_at: u64,
    pub canister_timestamp: u64,
    #[serde(default)]
    pub views: u64,
    #[serde(default)]
    pub finalized: bool,
    #[serde(default)]
    pub week_ended: bool,
    #[serde(default)]
    pub finalized_at: Option<u64>,
}
impl Storable for StoredMeme {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<[u8]> {
        Cow::Owned(serde_json::to_vec(self).unwrap_or_default())
    }
    fn into_bytes(self) -> Vec<u8> {
        serde_json::to_vec(&self).unwrap_or_default()
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        serde_json::from_slice(bytes.as_ref()).unwrap_or_else(|_| StoredMeme {
            id: 0,
            owner: StorablePrincipal(Principal::anonymous()),
            meme_data: MemeData {
                prompt: String::new(),
                name: None,
                caption: None,
                image_url: String::new(),
                image_filename: String::new(),
                image_format: String::new(),
                metadata: PythonMetadata {
                    processing_time: 0.0,
                    timestamp: 0,
                    file_size_bytes: 0,
                    service: String::new(),
                },
            },
            created_at: 0,
            canister_timestamp: 0,
            views: 0,
            finalized: false,
            week_ended: false,
            finalized_at: None,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct PublicStoredMeme {
    pub id: u64,
    pub owner: Principal,
    pub meme_data: MemeData,
    pub created_at: u64,
    pub canister_timestamp: u64,
    pub views: u64,
    pub sale_metadata: Option<TokenSaleMetadata>,
    pub finalized: bool,
    pub week_ended: bool,
    pub finalized_at: Option<u64>,
}
impl From<StoredMeme> for PublicStoredMeme {
    fn from(sm: StoredMeme) -> Self {
        PublicStoredMeme {
            id: sm.id,
            owner: sm.owner.into(),
            meme_data: sm.meme_data,
            created_at: sm.created_at,
            canister_timestamp: sm.canister_timestamp,
            views: sm.views,
            sale_metadata: crate::nft_module::get_sale_metadata_for_meme(sm.id),
            finalized: sm.finalized,
            week_ended: sm.week_ended,
            finalized_at: sm.finalized_at,
        }
    }
}

// ---------- Helpers ----------
fn is_url_allowed(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
}
fn url_encode(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "%20".to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

// ---------- Simple GET helper (Cloudflare Worker) ----------
#[update]
pub async fn generate_meme(prompt: String) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }

    // Authentication required
    let user = caller();
    ic_cdk::println!("Caller principal: {}", user.to_text());

    // Check if user is anonymous
    if user == Principal::anonymous() {
        ic_cdk::println!("Anonymous user detected, rejecting request");
        return Err("Authentication required".to_string());
    }

    ic_cdk::println!("Authenticated user: {}", user.to_text());
    let storable_user = StorablePrincipal::from(user);
    let now = time();
    let current_day = now / (24 * 60 * 60 * 1_000_000_000); // Convert ns to days

    // Check if user has exceeded daily limit
    let can_generate = RATE.with(|r| {
        let mut rate_map = r.borrow_mut();
        if let Some(usage) = rate_map.get(&storable_user) {
            if usage.day == current_day {
                // Same day, check if under limit
                usage.count < 3
            } else {
                // New day, reset count
                true
            }
        } else {
            // First time user
            true
        }
    });

    if !can_generate {
        return Err("Daily meme generation limit reached. Please try again tomorrow.".to_string());
    }

    let encoded = url_encode(&prompt);
    let url = format!("{base}?prompt={p}", base = MEME_WORKER_URL, p = encoded);

    if !is_url_allowed(&url) {
        return Err("URL not allowed by canister policy".to_string());
    }

    let headers = vec![
        HttpHeader {
            name: "User-Agent".into(),
            value: "mementic_canister".into(),
        },
        HttpHeader {
            name: "Accept".into(),
            value: "application/json".into(),
        },
    ];

    let req = CanisterHttpRequestArgument {
        url,
        method: HttpMethod::GET,
        body: None,
        headers,
        max_response_bytes: Some(512_000),
        transform: Some(TransformContext::from_name("transform".to_string(), vec![])),
    };

    let (resp,) = http_request(req, OUTCALL_CYCLES)
        .await
        .map_err(|(code, msg)| format!("HTTP outcall failed: {:?} - {}", code, msg))?;

    if resp.status < Nat::from(200u16) || resp.status >= Nat::from(300u16) {
        return Err(format!("HTTP {} from worker", resp.status));
    }

    // Update rate limiting after successful generation
    RATE.with(|r| {
        let mut rate_map = r.borrow_mut();
        if let Some(usage) = rate_map.get(&storable_user) {
            if usage.day == current_day {
                // Same day, increment count
                let mut new_usage = usage.clone();
                new_usage.count += 1;
                rate_map.insert(storable_user, new_usage);
            } else {
                // New day, reset count to 1
                rate_map.insert(
                    storable_user,
                    DayUsage {
                        day: current_day,
                        count: 1,
                    },
                );
            }
        } else {
            // First time user, start with count 1
            rate_map.insert(
                storable_user,
                DayUsage {
                    day: current_day,
                    count: 1,
                },
            );
        }
    });

    let response_text =
        String::from_utf8(resp.body).unwrap_or_else(|_| "<non-utf8-body>".to_string());
    ic_cdk::println!("Cloudflare Worker Response: {}", &response_text);

    // Parse the response to extract meme data
    // The response has a nested structure: { success: true, data: { ... } }
    let meme_data: MemeData = match serde_json::from_str::<serde_json::Value>(&response_text) {
        Ok(json_value) => {
            ic_cdk::println!("Successfully parsed JSON response");

            // Check if response has the nested structure with 'data' field
            if let Some(data_obj) = json_value.get("data") {
                ic_cdk::println!("Found nested 'data' object, extracting meme data from it");

                // Extract fields from the data object
                let prompt = data_obj
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&prompt)
                    .to_string();

                let image_url = data_obj
                    .get("image_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let image_filename = data_obj
                    .get("image_filename")
                    .and_then(|v| v.as_str())
                    .unwrap_or("generated_meme.png")
                    .to_string();

                let image_format = data_obj
                    .get("image_format")
                    .and_then(|v| v.as_str())
                    .unwrap_or("png")
                    .to_string();

                // Extract metadata from the data object
                let metadata_obj = data_obj.get("metadata");
                let metadata = if let Some(meta) = metadata_obj {
                    PythonMetadata {
                        processing_time: meta
                            .get("processing_time")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(1.0),
                        timestamp: meta
                            .get("timestamp")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(time()),
                        file_size_bytes: meta
                            .get("file_size_bytes")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(1024000),
                        service: meta
                            .get("service")
                            .and_then(|v| v.as_str())
                            .unwrap_or("icp-meme-generator")
                            .to_string(),
                    }
                } else {
                    PythonMetadata {
                        processing_time: 1.0,
                        timestamp: time(),
                        file_size_bytes: 1024000,
                        service: "icp-meme-generator".to_string(),
                    }
                };

                ic_cdk::println!("Extracted image URL: {}", image_url);
                ic_cdk::println!("Extracted prompt: {}", prompt);

                MemeData {
                    prompt,
                    name: None,
                    caption: None,
                    image_url,
                    image_filename,
                    image_format,
                    metadata,
                }
            } else {
                // Fallback: try to parse as direct MemeData structure
                ic_cdk::println!("No 'data' field found, trying direct parsing");
                match serde_json::from_str(&response_text) {
                    Ok(data) => data,
                    Err(e) => {
                        ic_cdk::println!("Failed to parse as MemeData: {}", e);
                        ic_cdk::println!("Response was: {}", &response_text);

                        // Last resort: extract fields from root level
                        let prompt = json_value
                            .get("prompt")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&prompt)
                            .to_string();

                        let image_url = json_value
                            .get("image_url")
                            .or_else(|| json_value.get("url"))
                            .or_else(|| json_value.get("image"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        let image_filename = json_value
                            .get("image_filename")
                            .or_else(|| json_value.get("filename"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("generated_meme.png")
                            .to_string();

                        let image_format = json_value
                            .get("image_format")
                            .or_else(|| json_value.get("format"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("png")
                            .to_string();

                        let metadata = PythonMetadata {
                            processing_time: json_value
                                .get("processing_time")
                                .and_then(|v| v.as_f64())
                                .unwrap_or(1.0),
                            timestamp: json_value
                                .get("timestamp")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(time()),
                            file_size_bytes: json_value
                                .get("file_size_bytes")
                                .or_else(|| json_value.get("file_size"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(1024000),
                            service: json_value
                                .get("service")
                                .and_then(|v| v.as_str())
                                .unwrap_or("icp-meme-generator")
                                .to_string(),
                        };

                        MemeData {
                            prompt,
                            name: None,
                            caption: None,
                            image_url,
                            image_filename,
                            image_format,
                            metadata,
                        }
                    }
                }
            }
        }
        Err(e) => {
            ic_cdk::println!("Failed to parse response as JSON: {}", e);
            ic_cdk::println!("Response was: {}", &response_text);
            return Err(format!("Invalid JSON response: {}", e));
        }
    };

    // Return the generated meme data as JSON for preview
    // User will decide whether to publish it to marketplace
    match serde_json::to_string(&meme_data) {
        Ok(json) => Ok(json),
        Err(e) => {
            ic_cdk::println!("Failed to serialize generated meme: {}", e);
            Ok(response_text) // fallback to original response
        }
    }
}

fn next_meme_id() -> u64 {
    MEME_COUNTER.with(|c| {
        let mut map = c.borrow_mut();
        let current = map.get(&0).unwrap_or(0);
        let next = current.saturating_add(1);
        map.insert(0, next);
        next
    })
}

pub fn reserve_meme_id() -> u64 {
    next_meme_id()
}

/// Check if a meme has been minted as an NFT
#[query]
pub fn is_meme_minted(meme_id: u64) -> bool {
    // Import the NFT module function
    use crate::nft_module::get_token_by_meme_id;
    get_token_by_meme_id(meme_id).is_some()
}

/// List a meme for sale on the marketplace
#[update]
pub fn list_meme_for_sale(meme_id: u64, strategy: ListingStrategy) -> Result<(), String> {
    let user = caller();
    if user == Principal::anonymous() {
        return Err("Authentication required".to_string());
    }

    let owner = MEMES.with(|m| m.borrow().get(&meme_id).map(|stored| stored.owner.0));
    let owner = owner.ok_or_else(|| "Meme not found".to_string())?;

    if owner != user {
        return Err("You don't own this meme".to_string());
    }

    let token_id = crate::nft_module::get_token_by_meme_id(meme_id)
        .ok_or_else(|| "Meme has not been minted as an NFT yet".to_string())?;

    let config = match strategy {
        ListingStrategy::FixedPrice { price_e8s } => {
            if price_e8s == 0 {
                return Err("Listing price must be greater than zero".to_string());
            }
            (Some(price_e8s), ListingType::FixedPrice, None)
        }
        ListingStrategy::Auction { start_price_e8s } => {
            if start_price_e8s == 0 {
                return Err("Starting bid must be greater than zero".to_string());
            }
            (
                Some(start_price_e8s),
                ListingType::Auction,
                Some(start_price_e8s),
            )
        }
    };

    let (price, listing_type, auction_start) = config;
    crate::nft_module::mutate_sale_metadata(&token_id, meme_id, |sale| {
        sale.is_listed = true;
        sale.listing_price = price;
        sale.listing_type = listing_type.clone();
        sale.auction_start_price = auction_start;
        sale.auction_highest_bid = None;
        sale.auction_highest_bidder = None;
        sale.auction_bid_count = 0;
        sale.listed_at = Some(time());
    });

    Ok(())
}

/// Remove a meme from the marketplace
#[update]
pub fn remove_meme_from_market(meme_id: u64) -> Result<(), String> {
    let user = caller();
    if user == Principal::anonymous() {
        return Err("Authentication required".to_string());
    }

    let owner = MEMES.with(|m| m.borrow().get(&meme_id).map(|stored| stored.owner.0));
    let owner = owner.ok_or_else(|| "Meme not found".to_string())?;

    if owner != user {
        return Err("You don't own this meme".to_string());
    }

    if let Some(token_id) = crate::nft_module::get_token_by_meme_id(meme_id) {
        crate::nft_module::mutate_sale_metadata(&token_id, meme_id, |sale| {
            sale.is_listed = false;
            sale.listing_price = None;
            sale.listed_at = None;
            sale.listing_type = ListingType::None;
            sale.auction_start_price = None;
            sale.auction_highest_bid = None;
            sale.auction_highest_bidder = None;
            sale.auction_bid_count = 0;
        });
        Ok(())
    } else {
        Err("Meme has not been minted as an NFT yet".to_string())
    }
}

/// Remove all memes from the marketplace (admin function)
#[update]
pub fn remove_all_memes_from_market() -> Result<u32, String> {
    let user = caller();
    if user == Principal::anonymous() {
        return Err("Authentication required".to_string());
    }

    // Admin check - only admin can perform this operation
    let admin = crate::nft_module::get_admin();
    if user != admin {
        return Err("Admin access required".to_string());
    }

    let keys_to_update: Vec<u64> = MEMES.with(|m| {
        let map = m.borrow();
        map.iter()
            .filter_map(|entry| {
                let meme_id = *entry.key();
                crate::nft_module::get_sale_metadata_for_meme(meme_id)
                    .filter(|sale| sale.is_listed)
                    .map(|_| meme_id)
            })
            .collect()
    });

    let mut removed_count = 0;
    for meme_id in keys_to_update {
        if let Some(token_id) = crate::nft_module::get_token_by_meme_id(meme_id) {
            crate::nft_module::mutate_sale_metadata(&token_id, meme_id, |sale| {
                sale.is_listed = false;
                sale.listing_price = None;
                sale.listed_at = None;
            });
            removed_count += 1;
        }
    }

    Ok(removed_count)
}

/// Delete a meme (owner only, if not minted as NFT)
#[update]
pub fn delete_meme(meme_id: u64) -> Result<(), String> {
    let user = caller();
    if user == Principal::anonymous() {
        return Err("Authentication required".to_string());
    }

    // Check if meme exists and verify ownership
    let meme = MEMES.with(|m| m.borrow().get(&meme_id));
    let stored_meme = match meme {
        Some(sm) => sm,
        None => return Err("Meme not found".to_string()),
    };

    if stored_meme.owner.0 != user {
        return Err("You don't own this meme".to_string());
    }

    // Check if meme is minted as NFT
    if is_meme_minted(meme_id) {
        return Err("Cannot delete a meme that has been minted as NFT".to_string());
    }

    // Remove from main MEMES storage
    MEMES.with(|m| {
        m.borrow_mut().remove(&meme_id);
    });

    // Remove from user's meme list
    USER_MEMES.with(|um| {
        let mut map = um.borrow_mut();
        let key = StorablePrincipal::from(user);
        if let Some(mut list) = map.get(&key) {
            let mut ids: Vec<u64> = list.into();
            ids.retain(|&id| id != meme_id);
            map.insert(key, StorableVecU64::from(ids));
        }
    });

    // Remove all voting data for this meme
    crate::voting::delete_meme_data(meme_id)?;

    Ok(())
}

/// Delete all memes in the system (admin function, deletes all memes regardless of ownership, except minted NFTs)
#[update]
pub fn delete_all_user_memes() -> Result<u32, String> {
    let user = caller();
    if user == Principal::anonymous() {
        return Err("Authentication required".to_string());
    }

    // Admin check - only admin can perform this operation
    let admin = crate::nft_module::get_admin();
    if user != admin {
        return Err("Admin access required".to_string());
    }

    // Get all meme IDs in the system
    let all_meme_ids: Vec<u64> =
        MEMES.with(|m| m.borrow().iter().map(|entry| *entry.key()).collect());

    let mut deleted_count = 0;
    let mut failed_deletions = Vec::new();

    for meme_id in all_meme_ids {
        // Check if meme exists
        if let Some(stored_meme) = MEMES.with(|m| m.borrow().get(&meme_id)) {
            // Check if meme is minted as NFT
            if is_meme_minted(meme_id) {
                failed_deletions.push(format!("Meme {}: cannot delete minted NFT", meme_id));
                continue;
            }

            // Remove from main MEMES storage
            MEMES.with(|m| {
                m.borrow_mut().remove(&meme_id);
            });

            // Remove from owner's meme list
            let owner = stored_meme.owner.0;
            let storable_owner = StorablePrincipal::from(owner);
            USER_MEMES.with(|um| {
                let mut map = um.borrow_mut();
                if let Some(mut list) = map.get(&storable_owner) {
                    let mut ids: Vec<u64> = list.into();
                    ids.retain(|&id| id != meme_id);
                    if ids.is_empty() {
                        map.remove(&storable_owner);
                    } else {
                        map.insert(storable_owner, StorableVecU64::from(ids));
                    }
                }
            });

            // Remove all voting data for this meme
            if let Err(e) = crate::voting::delete_meme_data(meme_id) {
                failed_deletions.push(format!(
                    "Meme {}: voting data deletion failed: {}",
                    meme_id, e
                ));
                continue;
            }

            deleted_count += 1;
        } else {
            failed_deletions.push(format!("Meme {}: not found", meme_id));
        }
    }

    // If there were any failures, return an error with details
    if !failed_deletions.is_empty() {
        return Err(format!(
            "Deleted {} memes, but failed to delete: {}",
            deleted_count,
            failed_deletions.join(", ")
        ));
    }

    Ok(deleted_count)
}

/// Record a sale (called internally or by marketplace canister)
#[update]
pub fn record_meme_sale(meme_id: u64, sale_price_e8s: u64) -> Result<(), String> {
    let exists = MEMES.with(|m| m.borrow().contains_key(&meme_id));
    if !exists {
        return Err("Meme not found".to_string());
    }

    if let Some(token_id) = crate::nft_module::get_token_by_meme_id(meme_id) {
        crate::nft_module::mutate_sale_metadata(&token_id, meme_id, |sale| {
            sale.total_sales = sale.total_sales.saturating_add(1);
            sale.total_earned = sale.total_earned.saturating_add(sale_price_e8s);
            sale.last_sale_price = Some(sale_price_e8s);
            sale.last_sale_at = Some(time());
            sale.is_listed = false;
            sale.listing_price = None;
            sale.listed_at = None;
            sale.listing_type = ListingType::None;
            sale.auction_start_price = None;
            sale.auction_highest_bid = None;
            sale.auction_highest_bidder = None;
            sale.auction_bid_count = 0;
        });
        Ok(())
    } else {
        Err("Meme has not been minted as an NFT yet".to_string())
    }
}

/// Increment view count for a meme
#[update]
pub fn increment_meme_views(meme_id: u64) -> Result<(), String> {
    MEMES.with(|m| {
        let mut map = m.borrow_mut();
        if let Some(mut stored) = map.get(&meme_id) {
            stored.views = stored.views.saturating_add(1);
            map.insert(meme_id, stored);
            Ok(())
        } else {
            Err("Meme not found".to_string())
        }
    })
}

/// Store a generated meme into marketplace (associated to caller)
#[update]
pub fn publish_meme(meme: MemeData) -> Result<PublicStoredMeme, String> {
    let user = caller();
    ic_cdk::println!("Publish meme - Caller principal: {}", user.to_text());

    if user == Principal::anonymous() {
        ic_cdk::println!("Publish meme - Anonymous user detected, rejecting request");
        return Err("Authentication required".to_string());
    }

    ic_cdk::println!("Publish meme - Authenticated user: {}", user.to_text());
    
    // CRITICAL: Check for duplicate - prevent publishing same meme multiple times
    // Search for existing meme with same image_url from this user
    let existing_meme = MEMES.with(|m| {
        let map = m.borrow();
        map.iter()
            .find(|entry| {
                let stored = entry.value();
                stored.owner == StorablePrincipal::from(user) 
                    && stored.meme_data.image_url == meme.image_url
            })
            .map(|entry| entry.value())
    });
    
    // If already published, return the existing meme
    if let Some(existing) = existing_meme {
        ic_cdk::println!("Publish meme - Duplicate detected, returning existing meme ID: {}", existing.id);
        return Ok(existing.into());
    }
    
    crate::rollover::maybe_perform_rollover(crate::leaderboard::DEFAULT_TOP_N);
    let now = time();

    // Allocate id
    let id = reserve_meme_id();

    // Create stored record
    let stored = StoredMeme {
        id,
        owner: StorablePrincipal::from(user),
        meme_data: meme,
        created_at: now,         // when published
        canister_timestamp: now, // canister-side write ts
        views: 0,
        finalized: false,
        week_ended: false,
        finalized_at: None,
    };

    // Insert into global index
    MEMES.with(|m| {
        m.borrow_mut().insert(id, stored.clone());
    });

    // Append into per-user index
    USER_MEMES.with(|um| {
        let mut map = um.borrow_mut();
        let key = StorablePrincipal::from(user);
        let mut list: Vec<u64> = map.get(&key).map(|sv| sv.into()).unwrap_or_default();
        list.push(id);
        map.insert(key, StorableVecU64::from(list));
    });

    // Track unique user
    UNIQUE_USERS.with(|uu| {
        uu.borrow_mut().insert(StorablePrincipal::from(user), true);
    });

    let caption = stored.meme_data.caption.clone().unwrap_or_else(String::new);
    let image_cid = stored.meme_data.image_url.clone();
    let created_secs = now / 1_000_000_000;
    register_meme_with_id(id, user, caption, image_cid, created_secs);

    Ok(stored.into())
}

/// List all memes for marketplace (newest first)
#[query]
pub fn get_all_memes() -> Vec<PublicStoredMeme> {
    MEMES.with(|m| {
        let map = m.borrow();
        let mut items: Vec<PublicStoredMeme> = map
            .iter()
            .map(|entry| {
                // In ic-stable-structures 0.7, value() yields owned value
                let sm = entry.value();
                let pm: PublicStoredMeme = sm.into();
                pm
            })
            .collect();

        // sort by id desc (newest first)
        items.sort_unstable_by(|a, b| b.id.cmp(&a.id));
        items
    })
}

/// Get only memes that are listed for sale on the marketplace
#[query]
pub fn get_marketplace_memes() -> Vec<PublicStoredMeme> {
    MEMES.with(|m| {
        let map = m.borrow();
        let mut items: Vec<PublicStoredMeme> = map
            .iter()
            .filter_map(|entry| {
                let sm = entry.value();
                let pm: PublicStoredMeme = sm.into();
                if pm
                    .sale_metadata
                    .as_ref()
                    .map(|sale| sale.is_listed)
                    .unwrap_or(false)
                {
                    Some(pm)
                } else {
                    None
                }
            })
            .collect();

        // sort by id desc (newest first)
        items.sort_unstable_by(|a, b| b.id.cmp(&a.id));
        items
    })
}

// ---------- Queries ----------
#[query]
pub fn get_meme(meme_id: u64) -> Option<PublicStoredMeme> {
    MEMES.with(|m| m.borrow().get(&meme_id).map(|stored| stored.into()))
}

#[query]
pub fn check_remaining_calls() -> u8 {
    let user = caller();
    let storable_user = StorablePrincipal::from(user);

    // Get current day (in nanoseconds since epoch, converted to days)
    let now = time();
    let current_day = now / (24 * 60 * 60 * 1_000_000_000); // Convert ns to days

    RATE.with(|r| {
        let rate_map = r.borrow();
        if let Some(usage) = rate_map.get(&storable_user) {
            if usage.day == current_day {
                // Same day, return remaining calls (max 3 per day)
                let max_calls = 3;
                if usage.count >= max_calls {
                    0 // No calls remaining
                } else {
                    max_calls - usage.count
                }
            } else {
                // New day, reset to max calls
                3
            }
        } else {
            // First time user, return max calls
            3
        }
    })
}
#[query]
pub fn get_user_memes() -> Vec<PublicStoredMeme> {
    let user = caller();
    let storable_user = StorablePrincipal::from(user);
    USER_MEMES.with(|um| {
        let map = um.borrow();
        if let Some(list) = map.get(&storable_user) {
            let mut ids: Vec<u64> = list.into();
            ids.sort_unstable_by(|a, b| b.cmp(a));
            MEMES.with(|m| {
                let mem = m.borrow();
                ids.into_iter()
                    .filter_map(|id| mem.get(&id).map(|sm| sm.into()))
                    .collect()
            })
        } else {
            Vec::new()
        }
    })
}
#[query]
pub fn get_total_memes() -> u64 {
    MEME_COUNTER.with(|c| c.borrow().get(&0).unwrap_or(0))
}
#[query]
pub fn get_user_meme_count() -> u32 {
    let user = caller();
    let storable_user = StorablePrincipal::from(user);
    USER_MEMES.with(|um| {
        um.borrow()
            .get(&storable_user)
            .map(|list| {
                let v: Vec<u64> = list.into();
                v.len() as u32
            })
            .unwrap_or(0)
    })
}
#[query]
pub fn get_total_users() -> u64 {
    UNIQUE_USERS.with(|uu| uu.borrow().len() as u64)
}
#[query]
pub fn health() -> String {
    format!("Meme Worker: {} - Status: Operational", MEME_WORKER_URL)
}

// ---------- Transform ----------
#[query]
fn transform(args: TransformArgs) -> HttpResponse {
    let mut r = args.response;
    r.headers.retain(|h| {
        matches!(
            h.name.to_ascii_lowercase().as_str(),
            "content-type" | "content-length"
        )
    });
    r
}

/// Clear all memes from HTTP outcall storage (admin function)
#[update]
pub fn clear_all_memes() -> Result<u32, String> {
    let user = caller();
    if user == Principal::anonymous() {
        return Err("Authentication required".to_string());
    }

    // Admin check - only admin can perform this operation
    let admin = crate::nft_module::get_admin();
    if user != admin {
        return Err("Admin access required".to_string());
    }

    let mut cleared_count = 0;

    // Clear USER_MEMES by removing each entry individually
    USER_MEMES.with(|um| {
        let mut map = um.borrow_mut();
        let keys_to_remove: Vec<_> = map.iter().map(|entry| entry.key().clone()).collect();
        for key in keys_to_remove {
            map.remove(&key);
            cleared_count += 1;
        }
    });

    // Clear UNIQUE_USERS by removing each entry individually
    UNIQUE_USERS.with(|uu| {
        let mut map = uu.borrow_mut();
        let keys_to_remove: Vec<_> = map.iter().map(|entry| entry.key().clone()).collect();
        for key in keys_to_remove {
            map.remove(&key);
        }
    });

    // Clear RATE by removing each entry individually
    RATE.with(|r| {
        let mut map = r.borrow_mut();
        let keys_to_remove: Vec<_> = map.iter().map(|entry| entry.key().clone()).collect();
        for key in keys_to_remove {
            map.remove(&key);
        }
    });

    // Clear MEME_COUNTER by removing each entry individually (u8 is Copy)
    MEME_COUNTER.with(|mc| {
        let mut map = mc.borrow_mut();
        let keys_to_remove: Vec<_> = map.iter().map(|entry| *entry.key()).collect();
        for key in keys_to_remove {
            map.remove(&key);
        }
    });

    Ok(cleared_count)
}

/// Fetch bytes from a given image URL
pub async fn fetch_image_bytes_from_image_storage(url: &str) -> Result<Vec<u8>, String> {
    let request: CanisterHttpRequestArgument = CanisterHttpRequestArgument {
        url: url.to_string(),
        method: HttpMethod::GET,
        headers: vec![
            HttpHeader { name: "User-Agent".into(), value: "mementic_canister".into() },
            HttpHeader { name: "Accept".into(), value: "image/*".into() },
        ],
        body: None,
        // Bound the response to a safe size; adjust if your images are larger
        max_response_bytes: Some(2_000_000),
        // Use the same transform to strip non-deterministic headers
        transform: Some(TransformContext::from_name("transform".to_string(), vec![])),
    };

    // Perform the async call to management canister
    let cycles: u64 = 21_000_000_000; // Attach enough cycles for HTTP outcall
    let (response,): (HttpResponse,) =
        call_with_payment::<(CanisterHttpRequestArgument,), (HttpResponse,)>(
            Principal::management_canister(),
            "http_request",
            (request,),
            cycles,
        )
        .await
        .map_err(|e| format!("http_request call failed: {:?}", e))?;

    Ok(response.body)
}
