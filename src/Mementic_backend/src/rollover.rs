use crate::index::week_meme_ids;
use crate::leaderboard::{
    clear_live_votes, snapshot_weekly_leaderboard, store_weekly_leaderboard, DEFAULT_TOP_N,
};
use crate::model::{MemeStatus, WeekId};
use crate::state::{get_active_week_id, set_active_week_id, MEMES};
use crate::time::{current_week_id, now_secs};
use ic_cdk::println;
use ic_cdk_timers::{clear_timer, set_timer_interval, TimerId};
use std::cell::RefCell;
use std::time::Duration;

thread_local! {
    static TIMER: RefCell<Option<TimerId>> = RefCell::new(None);
}

pub fn start_rollover_timer() {
    TIMER.with(|cell| {
        if let Some(id) = cell.borrow_mut().take() {
            clear_timer(id);
        }
        // Check periodically (once per hour) to detect week rollovers promptly.
        let interval_secs = (crate::time::WEEK_SECONDS / 168).max(1); // 168 hours per week
        let id = set_timer_interval(Duration::from_secs(interval_secs), || {
            maybe_perform_rollover(DEFAULT_TOP_N);
        });
        cell.borrow_mut().replace(id);
    });

    // Perform an immediate check so that deployments catch up to the
    // correct active week without waiting for the first timer tick.
    maybe_perform_rollover(DEFAULT_TOP_N);
}

pub fn maybe_perform_rollover(top_n: usize) -> Option<WeekId> {
    let current = current_week_id();
    let active = get_active_week_id();

    if active == 0 {
        set_active_week_id(current);
        return None;
    }

    if current <= active {
        return None;
    }

    let finalized_week = active;
    
    // CRITICAL: Advance to the new week BEFORE finalizing
    // This ensures all queries (list_premarket_memes, get_top_liked_memes, etc.)
    // see the new week ID during cleanup, preventing old memes from appearing
    set_active_week_id(current);
    
    // Now finalize the old week
    finalize_week(finalized_week, top_n);

    println!(
        "Finalized week {} -> new active week {}",
        finalized_week, current
    );
    Some(finalized_week)
}

fn finalize_week(week_id: WeekId, top_n: usize) {
    let finalized_at = now_secs();

    finalize_memes_for_week(week_id, finalized_at);

    // Create leaderboard snapshot
    let board = if let Some(existing_board) = crate::leaderboard::get_weekly_leaderboard(week_id) {
        existing_board
    } else {
        let new_board = snapshot_weekly_leaderboard(week_id, finalized_at, top_n);
        store_weekly_leaderboard(new_board.clone());
        new_board
    };

    // CRITICAL: Create mint entitlements for top 3 winners
    if board.top.len() > 0 {
        let top3: Vec<crate::model::TopEntry> = board.top.iter().take(3).map(|e| {
            crate::model::TopEntry {
                meme_id: e.meme_id,
                votes: e.votes,
                rank: e.rank,
            }
        }).collect();

        match crate::entitlements::create_entitlements_for_week(week_id, &top3) {
            Ok(entitlements) => {
                println!(
                    "Created {} mint entitlements for week {} winners",
                    entitlements.len(),
                    week_id
                );
            }
            Err(e) => {
                println!(
                    "Failed to create mint entitlements for week {}: {}",
                    week_id, e
                );
            }
        }
    }

    clear_live_votes();
}

pub(crate) fn finalize_memes_for_week(week_id: WeekId, finalized_at: u64) {
    let meme_ids = week_meme_ids(week_id);
    
    // Update state::MEMES (MemoryId 60)
    MEMES.with(|memes| {
        let mut memes = memes.borrow_mut();
        for meme_id in meme_ids.iter() {
            if let Some(mut meme) = memes.get(meme_id) {
                meme.status = MemeStatus::Finalized;
                meme.week_ended = true;
                meme.finalized_at = Some(finalized_at);
                meme.finalized = true; // Mark as finalized to hide from pre-marketplace
                memes.insert(*meme_id, meme);
            }
        }
    });
    
    // CRITICAL: Also update http_outcall::MEMES (MemoryId 21) to keep storages in sync
    // This ensures the leaderboard and other queries see the finalized status
    crate::http_outcall::MEMES.with(|memes| {
        let mut memes = memes.borrow_mut();
        for meme_id in meme_ids.iter() {
            if let Some(mut stored_meme) = memes.get(meme_id) {
                // Now StoredMeme has finalized/week_ended fields - update them!
                stored_meme.finalized = true;
                stored_meme.week_ended = true;
                stored_meme.finalized_at = Some(finalized_at);
                memes.insert(*meme_id, stored_meme);
            }
        }
    });
}

pub fn admin_rollover_now() -> Option<WeekId> {
    maybe_perform_rollover(DEFAULT_TOP_N)
}

pub fn ensure_active_week_initialized() {
    if get_active_week_id() == 0 {
        set_active_week_id(current_week_id());
    }
}
