use crate::model::WeekId;
use crate::state;

/// Number of seconds in a full calendar week (7 days).
pub const WEEK_SECONDS: u64 = 7 * 24 * 60 * 60; // 604,800 seconds

fn adjust_with_offset(seconds: u64, offset: i64) -> u64 {
    if offset >= 0 {
        seconds.saturating_add(offset as u64)
    } else {
        seconds.saturating_sub(offset.unsigned_abs())
    }
}

pub fn now_secs() -> u64 {
    ic_cdk::api::time() / 1_000_000_000
}

pub fn current_week_id() -> WeekId {
    compute_week_id(now_secs())
}

pub fn compute_week_id(timestamp_secs: u64) -> WeekId {
    let offset = state::get_week_offset();
    let adjusted = adjust_with_offset(timestamp_secs, offset);
    adjusted / WEEK_SECONDS
}
