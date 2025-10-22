use crate::index::week_meme_ids;
use crate::model::{MemeId, Timestamp, TopEntry, WeekId, WeeklyLeaderboard};
use crate::state::{get_active_week_id, FINALIZED_LEADERBOARDS, LIVE_VOTES};

pub const DEFAULT_TOP_N: usize = 50;

fn sort_entries(entries: &mut Vec<(MemeId, u64)>) {
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
}

pub fn apply_vote(meme_id: MemeId, up: bool) -> u64 {
    LIVE_VOTES.with(|votes| {
        let mut votes = votes.borrow_mut();
        let current = votes.get(&meme_id).unwrap_or(0);
        let updated = if up {
            current.saturating_add(1)
        } else {
            current.saturating_sub(1)
        };
        if updated == 0 {
            votes.remove(&meme_id);
        } else {
            votes.insert(meme_id, updated);
        }
        updated
    })
}

pub fn set_vote_count(meme_id: MemeId, value: u64) {
    LIVE_VOTES.with(|votes| {
        let mut votes = votes.borrow_mut();
        if value == 0 {
            votes.remove(&meme_id);
        } else {
            votes.insert(meme_id, value);
        }
    });
}

pub fn get_vote_count(meme_id: MemeId) -> u64 {
    LIVE_VOTES.with(|votes| votes.borrow().get(&meme_id).unwrap_or(0))
}

pub fn clear_live_votes() {
    LIVE_VOTES.with(|votes| {
        let mut votes = votes.borrow_mut();
        let keys: Vec<MemeId> = votes.iter().map(|entry| *entry.key()).collect();
        for key in keys {
            votes.remove(&key);
        }
    });
}

fn live_vote_entries_for_week(week_id: WeekId) -> Vec<(MemeId, u64)> {
    let mut entries: Vec<(MemeId, u64)> = week_meme_ids(week_id)
        .into_iter()
        .map(|meme_id| (meme_id, get_vote_count(meme_id)))
        .collect();

    sort_entries(&mut entries);
    entries
}

pub fn current_leaderboard(offset: u32, limit: u32) -> Vec<TopEntry> {
    let week_id = get_active_week_id();
    let mut entries = live_vote_entries_for_week(week_id);
    let start = offset as usize;
    let end = (start + limit as usize).min(entries.len());
    if start >= entries.len() {
        return Vec::new();
    }
    entries[start..end]
        .iter()
        .enumerate()
        .map(|(idx, (meme_id, votes))| TopEntry {
            meme_id: *meme_id,
            votes: *votes,
            rank: (start + idx + 1) as u32,
        })
        .collect()
}

pub fn snapshot_weekly_leaderboard(
    week_id: WeekId,
    finalized_at: Timestamp,
    top_n: usize,
) -> WeeklyLeaderboard {
    let mut entries = live_vote_entries_for_week(week_id);
    entries.truncate(top_n);

    let top = entries
        .iter()
        .enumerate()
        .map(|(idx, (meme_id, votes))| TopEntry {
            meme_id: *meme_id,
            votes: *votes,
            rank: (idx + 1) as u32,
        })
        .collect();

    WeeklyLeaderboard {
        week_id,
        finalized_at,
        top,
    }
}

pub fn store_weekly_leaderboard(board: WeeklyLeaderboard) {
    FINALIZED_LEADERBOARDS.with(|map| {
        map.borrow_mut().insert(board.week_id, board);
    });
}

pub fn get_weekly_leaderboard(week_id: WeekId) -> Option<WeeklyLeaderboard> {
    FINALIZED_LEADERBOARDS.with(|map| map.borrow().get(&week_id))
}

pub fn list_finalized_weeks(offset: u32, limit: u32) -> Vec<WeekId> {
    FINALIZED_LEADERBOARDS.with(|map| {
        let map = map.borrow();
        let mut weeks: Vec<WeekId> = map.iter().map(|entry| *entry.key()).collect();
        weeks.sort_unstable();
        weeks.reverse();
        let start = offset as usize;
        let end = (start + limit as usize).min(weeks.len());
        if start >= weeks.len() {
            return Vec::new();
        }
        weeks[start..end].to_vec()
    })
}
