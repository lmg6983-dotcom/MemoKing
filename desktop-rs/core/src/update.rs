//! 자동 업데이트에 보일 말 — desktop/updater.js (updateErrorText · isSnoozed · notesText).
use crate::js::{re, slice16};
use fancy_regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub const SNOOZE_MS: i64 = 24 * 60 * 60_000;

static NETWORK: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|net::ERR_|network|socket"));
static SIGN: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)sign|certificate|publisherName|not signed"));
static MISSING: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)404|latest\.yml|Cannot find"));
static BLOCK_END: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)</(p|li|h\d)>"));
static BR: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)<br\s*/?>"));
static TAG: LazyLock<Regex> = LazyLock::new(|| re(r"<[^>]+>"));
static BLANK: LazyLock<Regex> = LazyLock::new(|| re(r"[ \t]*\n[\s]*\n"));

/// 오류 → 사용자에게 보일 말 (네트워크 · 서명 · 그 밖)
pub fn update_error_text(msg: &str) -> &'static str {
    let hit = |r: &Regex| r.is_match(msg).unwrap_or(false);
    if hit(&NETWORK) {
        "인터넷에 연결되지 않아 업데이트를 확인하지 못했어요. 지금 버전은 그대로 쓸 수 있어요"
    } else if hit(&SIGN) {
        "새 설치 파일의 서명을 확인하지 못해 설치하지 않았어요. 지금 버전은 그대로 쓸 수 있어요"
    } else if hit(&MISSING) {
        "업데이트 정보를 찾지 못했어요. 잠시 뒤 다시 확인해 주세요"
    } else {
        "업데이트 중 문제가 생겼어요. 지금 버전은 그대로 쓸 수 있어요"
    }
}

/// 이 버전 알림을 지금 숨길까 ("나중에" 를 고른 지 24시간 안)
pub fn is_snoozed(snooze: &Value, version: &Value, now_ms: f64) -> bool {
    snooze.is_object() && snooze["version"] == *version && snooze["until"].as_f64().is_some_and(|u| now_ms < u)
}

/// 릴리스 노트 → 글 (GitHub 이 HTML 로 줄 때가 있다 — 태그는 벗기고 &amp; 같은 글자는 되돌린다)
pub fn notes_text(raw: &str) -> String {
    let s = BLOCK_END.replace_all(raw, "\n");
    let s = BR.replace_all(&s, "\n");
    let s = TAG.replace_all(&s, "");
    let s = crate::body::decode_entities(&s, true);
    slice16(crate::js::trim(&BLANK.replace_all(&s, "\n")), 4000)
}
