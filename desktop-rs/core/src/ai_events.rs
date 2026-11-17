//! 글 속 일정 자동 등록 (app/js/core/ai-events.js) — 날짜 해석기가 앞으로의 날짜가 있는 줄을 찾고, AI 는 그중 진짜 일정만 번호로 고르고 짧은 이름을 짓는다.
//!   날짜 계산은 해석기가 (작은 모델은 날짜 계산을 자주 틀림). 본 줄은 머리말 aiEvents 에 남겨 다시 넣지 않는다 (지운 일정이 되살아나지 않게).
use crate::date_detect::{find_dates, guess_title, Found};
use crate::js::{self, re};
use crate::reminders::event_from_date;
use chrono::{DateTime, Local, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const MAX_SEEN: usize = 300; // 기억해 둘 본 줄 (오래된 것부터 잊음)

pub struct Candidate {
    pub key: String, // 본 줄 표시 (줄 앞 120자) — 모델에도 이 글을 보인다
    pub date: Found, // 줄 전체에서 찾은 첫 날짜
    pub line: String, // 날짜를 찾은 줄 전체
}

/// 아직 보지 않은 줄 중 앞으로의 날짜가 있는 것 (줄마다 첫 날짜 하나)
pub fn event_candidates(body: &str, seen: &[String], now: DateTime<Local>) -> Vec<Candidate> {
    let mut done: HashSet<String> = seen.iter().cloned().collect();
    let mut out = vec![];
    for line in crate::body::plain_lines(body, usize::MAX) {
        let key = js::slice16(js::trim(&line), 120);
        if !done.insert(key.clone()) {
            continue;
        }
        if let Some(date) = find_dates(&line, now).into_iter().next() {
            out.push(Candidate { key, date, line });
        }
    }
    out
}

/// → (messages, schema)
pub fn ai_event_request(cands: &[Candidate]) -> (Value, Value) {
    let schema = json!({
        "type": "object",
        "properties": {
            "events": {
                "type": "array",
                "maxItems": cands.len(),
                "items": {
                    "type": "object",
                    "properties": { "n": { "type": "integer", "minimum": 1, "maximum": cands.len() }, "title": { "type": "string", "maxLength": 30 } },
                    "required": ["n", "title"],
                },
            },
        },
        "required": ["events"],
    });
    let lines: Vec<String> = cands.iter().enumerate().map(|(i, c)| format!("{}. {}", i + 1, c.key)).collect();
    let messages = json!([
        { "role": "system", "content": "너는 메모에서 일정을 고르는 도우미다. 번호 붙은 줄 중 약속, 회의, 마감, 해야 할 일처럼 그때 무엇을 하는 줄만 고른다. 날씨, 지난 이야기, 날짜만 나온 줄은 고르지 않는다. 고른 줄마다 날짜와 시각을 뺀 짧은 한국어 일정 이름(15자 안팎)을 title에 쓴다." },
        { "role": "user", "content": lines.join("\n") },
    ]);
    (messages, schema)
}

/// 날짜 자리(줄의 바이트)를 본 줄 표시(key)의 같은 UTF-16 자리로 — JS 는 줄에서 찾은 자리로 key 를 자른다
fn key_pos(c: &Candidate, at: usize) -> usize {
    let units = c.line[..at].encode_utf16().count();
    let mut n = 0;
    c.key.char_indices().find(|(_, ch)| {
        n += ch.len_utf16();
        n > units
    }).map_or(c.key.len(), |(i, _)| i)
}

/// 모델 답(JSON 글) → 넣을 일정들 — 번호 밖 · 겹치는 번호는 빼고, 이름이 비면 줄에서 짐작, 이미 있는 일정과 같은 때 · 이미 지난 때는 뺀다
pub fn ai_event_result(answer: &str, cands: &[Candidate], existing: &[Value], now: DateTime<Local>) -> Vec<Value> {
    let Ok(data) = serde_json::from_str::<Value>(answer) else { return vec![] };
    let same = |a: &Value, b: &Value| a["kind"] == b["kind"] && if a["kind"] == "at" { a["at"] == b["at"] } else { a["repeat"] == b["repeat"] };
    let han = re(r"\p{Script=Han}");
    let mut out: Vec<Value> = vec![];
    let mut used = HashSet::new();
    for e in data["events"].as_array().into_iter().flatten() {
        let n = js::number(&e["n"]) - 1.0;
        if !(n >= 0.0 && n.fract() == 0.0 && (n as usize) < cands.len()) || !used.insert(n as usize) {
            continue;
        }
        let c = &cands[n as usize];
        let named = if e["title"].is_null() { String::new() } else { js::string(&e["title"]) };
        let mut title = js::slice16(js::trim(&han.replace_all(&named, "")), 30);
        if title.is_empty() {
            title = guess_title(&c.key, key_pos(c, c.date.from), key_pos(c, c.date.to));
        }
        let iso = |t: DateTime<Local>| t.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let d = json!({ "at": iso(c.date.at), "hasTime": c.date.has_time, "repeat": c.date.repeat, "end": c.date.end.map(iso), "title": title });
        let Some(r) = event_from_date(&d, now) else { continue };
        let past = r["kind"] == "at"
            && crate::time::parse_js_date(r["at"].as_str().unwrap_or_default()).is_some_and(|at| at.timestamp_millis() + if r["allDay"] == true { 86_400_000 } else { 0 } <= now.timestamp_millis());
        if !past && !existing.iter().chain(&out).any(|x| same(x, &r)) {
            out.push(r);
        }
    }
    out
}

/// 본 줄 목록 갱신 (새로 본 줄을 뒤에, MAX_SEEN 까지)
pub fn next_seen(seen: &[String], cands: &[Candidate]) -> Vec<String> {
    let all: Vec<String> = seen.iter().cloned().chain(cands.iter().map(|c| c.key.clone())).collect();
    all[all.len().saturating_sub(MAX_SEEN)..].to_vec()
}
