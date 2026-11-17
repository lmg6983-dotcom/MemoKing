//! 이어 쓰기 — 다른 기기(휴대폰 · AI 비서)에서 방금 고친 메모가 들어오면 알린다 (app/js/core/handoff.js)
use crate::time;

pub const HANDOFF_MS: i64 = 15 * 60_000;

/// 알릴 메모인지: 다른 곳에서, 최근(15분 안)에 고쳤으면 그 곳 이름
pub fn handoff_from(device: Option<&str>, updated: Option<&str>, now_ms: i64) -> Option<&'static str> {
    let name = match device? {
        "phone" => "휴대폰",
        "ai" => "AI 비서",
        _ => return None, // 이 PC 이거나 모르는 곳
    };
    let at = time::parse_js_date(updated?)?.timestamp_millis();
    (now_ms - at <= HANDOFF_MS && at - now_ms <= 5 * 60_000).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_recent_edits_from_elsewhere() {
        let now = time::parse_js_date("2026-11-17T12:00:00+09:00").unwrap().timestamp_millis();
        assert_eq!(handoff_from(Some("phone"), Some("2026-11-17T11:50:00+09:00"), now), Some("휴대폰"));
        assert_eq!(handoff_from(Some("ai"), Some("2026-11-17T12:03:00+09:00"), now), Some("AI 비서"));
        assert_eq!(handoff_from(Some("pc"), Some("2026-11-17T11:59:00+09:00"), now), None);
        assert_eq!(handoff_from(Some("phone"), Some("2026-11-17T11:40:00+09:00"), now), None, "15분 넘음");
        assert_eq!(handoff_from(Some("phone"), Some("2026-11-17T12:10:00+09:00"), now), None, "시계가 크게 앞섬");
        assert_eq!(handoff_from(None, Some("2026-11-17T11:59:00+09:00"), now), None);
    }
}
