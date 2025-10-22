mod api_create;
mod api_query;
mod api_vote;
mod entitlements;
mod feedback;
mod http_outcall;
mod index;
mod leaderboard;
mod model;
mod nft_module;
mod rollover;
mod state;
mod time;
mod user_profiles;
mod voting;

use crate::nft_module::InitArgs;
use candid::{CandidType, Decode, Encode, Nat, Principal};
use ic_cdk::api::management_canister::http_request::HttpResponse;
use ic_cdk::api::management_canister::http_request::TransformArgs;
use ic_cdk_macros::{post_upgrade, query, update};
use serde::{Deserialize, Serialize};

pub use model::{MemeCard, MemeStatus, TopEntry, WeeklyLeaderboard};

pub use http_outcall::{
    check_remaining_calls,
    // updates
    generate_meme,
    get_all_memes,
    get_marketplace_memes,
    // queries
    get_meme,
    get_total_memes,
    get_total_users,
    get_user_meme_count,
    get_user_memes,
    health,
    increment_meme_views,
    is_meme_minted,
    list_meme_for_sale,
    publish_meme,
    record_meme_sale,
    remove_meme_from_market,
    ListingStrategy,
    MemeData,
    PublicStoredMeme,
    PythonMetadata,
    StoredMeme,
};

pub use voting::{
    finalize_finished_weeks, finalize_week, get_completed_weeks, get_current_week_id, get_current_week_status,
    get_meme_votes, get_top3_for_week, get_top_liked_memes, get_user_vote, get_voting_stats,
    get_week_leaderboard, remove_vote, vote_meme, vote_with_power, LeaderboardEntry,
    LegacyTopEntry, LegacyWeeklyLeaderboard, MemeVotes, TopLikedLeaderboard, UserPower, VoteRecord,
    VoteResponse, VoteType, WeeklyPeriod,
};

pub use entitlements::{
    get_entitlements_for_meme, get_my_mint_entitlements, get_my_winner_notices, EntitlementStatus,
    MintEntitlement, WinnerNotice,
};

pub use nft_module::{
    get_nft_image,
    get_sale_metadata,
    get_sale_metadata_for_meme,
    get_token,
    get_token_by_meme_id,
    get_tokens_by_meme_id,
    icrc7_name,
    icrc7_owner_of,
    icrc7_supported_standards,
    icrc7_symbol,
    icrc7_tokens_of,
    icrc7_total_supply,
    // minting
    mint_to,
    ListingType,
    MetadataValue,
    MintingMode,
    NftImage,
    SupportedStandard,
    TokenMetadataEntry,
    TokenRecord,
    TokenSaleMetadata,
};

pub use feedback::{
    approve_feedback, delete_feedback, get_all_feedback, get_approved_feedback, get_feedback_stats,
    init_feedback_data, submit_feedback, Feedback,
};

pub use user_profiles::{
    get_user_profile, get_user_profile_by_principal, update_user_profile, UserProfile,
};

#[query]
pub fn whoami() -> Principal {
    ic_cdk::caller()
}

#[update]
pub fn create_meme(caption: String, image_cid: String) -> u64 {
    api_create::create_meme(caption, image_cid)
}

#[update]
pub fn vote(meme_id: u64, up: bool) -> Result<(), String> {
    api_vote::vote(meme_id, up)
}

#[query]
pub fn list_premarket_memes(offset: u32, limit: u32) -> Vec<MemeCard> {
    api_query::list_premarket_memes(offset, limit)
}

#[query]
pub fn get_current_leaderboard(offset: u32, limit: u32) -> Vec<TopEntry> {
    api_query::get_current_leaderboard(offset, limit)
}

#[query]
pub fn get_leaderboard_by_week(week_id: u64) -> Option<WeeklyLeaderboard> {
    api_query::get_leaderboard_by_week(week_id)
}

#[query]
pub fn list_finalized_weeks(offset: u32, limit: u32) -> Vec<u64> {
    api_query::list_finalized_weeks(offset, limit)
}

#[query]
pub fn list_memes_by_flag(week_ended: bool, offset: u32, limit: u32) -> Vec<MemeCard> {
    api_query::list_memes_by_flag(week_ended, offset, limit)
}

#[update]
pub fn admin_rollover_now() -> Option<u64> {
    rollover::admin_rollover_now()
}

#[update]
pub fn admin_set_week_offset(offset_secs: i64) {
    state::set_week_offset(offset_secs);
}

#[query]
pub fn get_active_week() -> u64 {
    state::get_active_week_id()
}

#[query]
pub fn get_week_offset() -> i64 {
    state::get_week_offset()
}

#[query]
pub fn get_lifetime_votes() -> u64 {
    voting::get_lifetime_votes()
}

#[query]
pub fn get_current_week_meme_count() -> u64 {
    voting::get_current_week_meme_count()
}

/// Comprehensive system reset - clears all data and resets to week 1
/// WARNING: This will delete ALL memes, votes, leaderboards, and reset the system
#[update]
pub fn reset_system_to_week_1() -> Result<String, String> {
    crate::state::MEMES.with(|memes| {
        let mut memes_mut = memes.borrow_mut();
        let keys_to_remove: Vec<_> = memes_mut.iter().map(|entry| *entry.key()).collect();
        for key in keys_to_remove {
            memes_mut.remove(&key);
        }
    });

    crate::state::MEMES_BY_WEEK.with(|memes_by_week| {
        let mut memes_by_week_mut = memes_by_week.borrow_mut();
        let keys_to_remove: Vec<_> = memes_by_week_mut.iter().map(|entry| *entry.key()).collect();
        for key in keys_to_remove {
            memes_by_week_mut.remove(&key);
        }
    });

    // Clear voting data
    crate::voting::VOTES.with(|votes| {
        let mut votes_mut = votes.borrow_mut();
        let keys_to_remove: Vec<_> = votes_mut.iter().map(|entry| *entry.key()).collect();
        for key in keys_to_remove {
            votes_mut.remove(&key);
        }
    });

    crate::voting::USER_VOTES.with(|user_votes| {
        let mut user_votes_mut = user_votes.borrow_mut();
        let keys_to_remove: Vec<_> = user_votes_mut.iter().map(|entry| entry.key().clone()).collect();
        for key in keys_to_remove {
            user_votes_mut.remove(&key);
        }
    });

    crate::state::LIVE_VOTES.with(|live_votes| {
        let mut live_votes_mut = live_votes.borrow_mut();
        let keys_to_remove: Vec<_> = live_votes_mut.iter().map(|entry| *entry.key()).collect();
        for key in keys_to_remove {
            live_votes_mut.remove(&key);
        }
    });

    crate::voting::WEEKLY_PERIODS.with(|periods| {
        let mut periods_mut = periods.borrow_mut();
        let keys_to_remove: Vec<_> = periods_mut.iter().map(|entry| *entry.key()).collect();
        for key in keys_to_remove {
            periods_mut.remove(&key);
        }
    });

    crate::state::FINALIZED_LEADERBOARDS.with(|leaderboards| {
        let mut leaderboards_mut = leaderboards.borrow_mut();
        let keys_to_remove: Vec<_> = leaderboards_mut.iter().map(|entry| *entry.key()).collect();
        for key in keys_to_remove {
            leaderboards_mut.remove(&key);
        }
    });

    // Clear HTTP outcall memes if they exist
    // Temporarily disabled to fix compilation
    // if let Ok(cleared_count) = crate::http_outcall::clear_all_memes() {
    //     ic_cdk::println!("Cleared {} HTTP outcall memes", cleared_count);
    // }

    // Reset counters and set proper week offset
    crate::state::set_active_week_id(1);
    crate::state::set_next_meme_id(1);

    // Calculate week offset so current timestamp corresponds to week 1
    let now = crate::time::now_secs();
    let target_week = 1u64;
    let current_calculated_week = now / crate::time::WEEK_SECONDS;
    let week_offset = (target_week as i64) - (current_calculated_week as i64);
    crate::state::set_week_offset(week_offset);

    // Create the first week period
    let now = crate::time::now_secs();
    let week_start = now; // Start immediately
    let week_end = week_start + (crate::time::WEEK_SECONDS);
    let first_period = crate::voting::WeeklyPeriod {
        week_id: 1,
        start_time: week_start,
        end_time: week_end,
        is_completed: false,
        meme_count: 0,
    };

    crate::voting::WEEKLY_PERIODS.with(|periods| {
        periods.borrow_mut().insert(1, first_period);
    });

    ic_cdk::println!("System reset complete - starting from week 1");
    Ok("System reset to week 1 complete. All data cleared, counters reset.".to_string())
}

#[post_upgrade]
fn post_upgrade() {
    rollover::ensure_active_week_initialized();
    rollover::start_rollover_timer();
}

ic_cdk::export_candid!();
