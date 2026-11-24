//! 받은 메모 빈 칸 (_memoking/받은 메모/빈 메모 001~100.md) — app/js/core/inbox.js 와 같은 규칙 (tests/parity.rs inbox)
//!   AI 가 새로 만든 파일은 메모킹에 보이지 않으니(drive.file), 메모킹이 만든 빈 칸을 AI 가 그 자리에서 덮어쓰게 한다
use crate::js;
use crate::memo_file::parse_memo_file;

pub const INBOX_DIR: &str = "_memoking/받은 메모";
pub const INBOX_SLOTS: usize = 100;
pub const SLOT_TEXT: &str = "<!-- 메모킹 빈 칸: AI 비서(Gemini 등)는 새 메모를 쓸 때 이 파일 전체를 새 메모 글로 덮어쓰세요. 메모킹이 메모로 옮기고 다시 비워요 -->\n";

/// n 번째 칸의 파일 이름 (1 부터): "빈 메모 001.md"
pub fn slot_name(n: usize) -> String {
    format!("빈 메모 {n:03}.md")
}

/// 칸의 글 → 옮길 메모 (본문, 색) — 비었으면 None
pub fn slot_memo(text: &str) -> Option<(String, String)> {
    let raw = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n");
    let comment = js::trim(SLOT_TEXT);
    let cleaned = raw.split('\n').filter(|l| js::trim(l) != comment).collect::<Vec<_>>().join("\n");
    if js::trim(&cleaned).is_empty() {
        return None;
    }
    let (meta, body) = parse_memo_file(&cleaned);
    let b = js::trim(&body);
    (!b.is_empty()).then(|| (format!("{b}\n"), meta.color))
}
