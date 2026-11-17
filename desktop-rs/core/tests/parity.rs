//! JS 규칙(app/js/core)과 같은 답인지 — fixtures 는 desktop-rs/parity/gen.mjs 가 만든다 (TZ=Asia/Seoul)
use serde_json::{json, Value};

fn fixtures(name: &str) -> Vec<Value> {
    let text = std::fs::read_to_string(format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
    serde_json::from_str(&text).unwrap()
}

// 다른 것을 모두 모아 한 번에 보여 준다 (처음 몇 개만)
fn report(name: &str, fails: Vec<String>, total: usize) {
    if !fails.is_empty() {
        panic!("{name}: {} / {total} 다름\n{}", fails.len(), fails.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
    }
}

#[test]
fn yaml_stringify() {
    let cases = fixtures("yaml_stringify");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = memoking_core::yaml::stringify(&json!({ "k": c["value"] }));
            (got != c["yaml"].as_str().unwrap()).then(|| format!("{:?}\n  JS  : {:?}\n  Rust: {got:?}", c["value"].as_str().unwrap(), c["yaml"].as_str().unwrap()))
        })
        .collect();
    report("yaml_stringify", fails, cases.len());
}

#[test]
fn yaml_roundtrip() {
    // 쓴 글을 다시 읽으면 같은 글자
    let cases = fixtures("yaml_stringify");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let back = memoking_core::yaml::parse(c["yaml"].as_str().unwrap()).map(|v| v["k"].clone());
            (back.as_ref() != Ok(&c["value"])).then(|| format!("{:?} → {back:?}", c["value"]))
        })
        .collect();
    report("yaml_roundtrip", fails, cases.len());
}

#[test]
fn memo_file() {
    let cases = fixtures("memo_file");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let (meta, body) = memoking_core::memo_file::parse_memo_file(c["text"].as_str().unwrap());
            let parsed = json!({ "meta": meta, "body": body });
            if parsed != c["parsed"] {
                return Some(format!("읽기 {:?}\n  JS  : {}\n  Rust: {parsed}", c["text"].as_str().unwrap().chars().take(80).collect::<String>(), c["parsed"]));
            }
            let out = memoking_core::memo_file::serialize_memo_file(&meta, &body);
            (out != c["serialized"].as_str().unwrap()).then(|| format!("쓰기 {:?}\n  JS  : {:?}\n  Rust: {out:?}", c["text"].as_str().unwrap().chars().take(80).collect::<String>(), c["serialized"].as_str().unwrap()))
        })
        .collect();
    report("memo_file", fails, cases.len());
}

#[test]
fn memo_body() {
    use memoking_core::body::*;
    let cases = fixtures("memo_body");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let body = c["body"].as_str().unwrap();
            let got = json!({
                "body": body,
                "plainLines": plain_lines(body, usize::MAX),
                "title": extract_title(body),
                "preview": extract_preview(body, 1200),
                "media": extract_media(body),
                "blank": is_blank_body(body),
                "tags": extract_tags(body),
                "tasks": task_progress(body),
                "locked": is_locked_body(body),
            });
            let diff: Vec<String> = got.as_object().unwrap().iter().filter(|(k, v)| c[k.as_str()] != **v).map(|(k, v)| format!("  {k}\n    JS  : {}\n    Rust: {v}", c[k.as_str()])).collect();
            (!diff.is_empty()).then(|| format!("{:?}\n{}", body.chars().take(60).collect::<String>(), diff.join("\n")))
        })
        .collect();
    report("memo_body", fails, cases.len());
}

#[test]
fn names() {
    use memoking_core::memo_file::{clean_folder_name, title_to_file_name};
    let cases = fixtures("names");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let s = c["s"].as_str().unwrap();
            let (file, folder) = (title_to_file_name(s), clean_folder_name(s));
            (file != c["file"] || folder != c["folder"]).then(|| format!("{s:?}\n  JS  : {} · {}\n  Rust: {file:?} · {folder:?}", c["file"], c["folder"]))
        })
        .collect();
    report("names", fails, cases.len());
}

#[test]
fn conflict_copy() {
    let cases = fixtures("conflict_copy");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = memoking_core::memo_file::conflict_copy_body(c["body"].as_str().unwrap(), "다른 기기 10월 5일 08:34");
            (got != c["copy"]).then(|| format!("{:?}\n  JS  : {:?}\n  Rust: {got:?}", c["body"], c["copy"]))
        })
        .collect();
    report("conflict_copy", fails, cases.len());
}

#[test]
fn search() {
    let cases = fixtures("search");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let (q, t) = (c["q"].as_str().unwrap(), c["t"].as_str().unwrap());
            let hit = memoking_core::search::matcher(q)(&[t]);
            (hit != c["hit"]).then(|| format!("{q:?} in {t:?}: JS {} Rust {hit}", c["hit"]))
        })
        .collect();
    report("search", fails, cases.len());
}

#[test]
fn lock() {
    use memoking_core::lock::*;
    let cases = fixtures("lock");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = open_lock(c["locked"].as_str().unwrap(), c["password"].as_str().unwrap()).map(|r| r.0);
            (got.as_deref() != Ok(c["plain"].as_str().unwrap())).then(|| format!("{:?}: {got:?}", c["password"]))
        })
        .collect();
    report("lock", fails, cases.len());
    let refs = fixtures("lock_ref");
    let fails = refs.iter().filter(|c| lock_ref_key(c["src"].as_str().unwrap(), c["salt"].as_str().unwrap()) != c["key"]).map(|c| c.to_string()).collect();
    report("lock_ref", fails, refs.len());
}

#[test]
fn program_files() {
    let cases = fixtures("program_files");
    let fails = cases.iter().filter(|c| memoking_core::vault::is_program_file(c["name"].as_str().unwrap()) != c["program"]).map(|c| c.to_string()).collect();
    report("program_files", fails, cases.len());
}

#[test]
fn reminders() {
    use memoking_core::reminders::*;
    let cases = fixtures("reminders");
    let ms = |t: Option<chrono::DateTime<chrono::Local>>| t.map(|t| t.timestamp_millis());
    let alert = |a: Option<Alert>, missed: Option<bool>| {
        a.map(|a| {
            let mut v = json!({ "at": a.at.timestamp_millis(), "start": a.start.timestamp_millis(), "offset": a.offset, "also": a.also.iter().map(|(s, o)| json!({ "start": s.timestamp_millis(), "offset": o })).collect::<Vec<_>>() });
            if let Some(m) = missed {
                v["missed"] = m.into();
            }
            v
        })
    };
    let fails = cases
        .iter()
        .filter_map(|c| {
            let r = &c["r"];
            let now = memoking_core::time::parse_js_date(c["now"].as_str().unwrap()).unwrap().with_timezone(&chrono::Local);
            let offs = alerts_of(r);
            let all_day = r["allDay"] == true;
            let start = r["at"].as_str().and_then(memoking_core::time::parse_js_date).map(|t| t.with_timezone(&chrono::Local)).or_else(|| next_occurrence(r, now));
            let due = due_occurrence(r, now);
            let got = json!({
                "r": r,
                "now": c["now"],
                "next": ms(next_occurrence(r, now)),
                "alert": alert(next_alert(r, now), None),
                "due": alert(due.clone().map(|d| d.0), due.map(|d| d.1)),
                "startup": due_at_startup(r, now),
                "fired": mark_fired(r, now),
                "live": is_live_cached(r, now),
                "nextTime": ms(next_time(r, now)),
                "pastEvent": is_past_event(r, now),
                "alerts": offs,
                "alertTimes": start.map(|s| offs.iter().map(|&o| alert_time(s, o, all_day).timestamp_millis()).collect::<Vec<_>>()),
                "text": alarm_text(r, "메모 제목", due_occurrence(r, now).as_ref(), now),
                "describe": describe_reminder(r, now),
                "pending": start.map(|s| pending_alerts(&offs, s, r["kind"] == "repeat", now, Some(fallback_alert(all_day)), all_day)),
            });
            let diff: Vec<String> = got.as_object().unwrap().iter().filter(|(k, v)| c[k.as_str()] != **v).map(|(k, v)| format!("  {k}\n    JS  : {}\n    Rust: {v}", c[k.as_str()])).collect();
            (!diff.is_empty()).then(|| format!("{} @ {}\n{}", r["id"], c["now"], diff.join("\n")))
        })
        .collect();
    report("reminders", fails, cases.len());
}

#[test]
fn indexer() {
    use memoking_core::indexer::*;
    use memoking_core::memo_file::parse_memo_file;
    let cases = fixtures("indexer");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let name = c["name"].as_str().unwrap();
            let want = c["text"].as_str().unwrap();
            if name == "guide" {
                return (AGENT_GUIDE != want).then(|| "AGENT_GUIDE 다름".to_string());
            }
            let parsed: Vec<(&str, &str, _)> = c["memos"].as_array().unwrap().iter().map(|m| (m["id"].as_str().unwrap(), m["file"].as_str().unwrap(), parse_memo_file(m["text"].as_str().unwrap()))).collect();
            let memos: Vec<IndexMemo> = parsed.iter().map(|(id, file, (meta, body))| IndexMemo { id, file, meta, body }).collect();
            let out = index_output(&memos, c["now"].as_str().unwrap());
            if out.text == want && out.key == c["key"].as_str().unwrap() {
                return None;
            }
            // 처음 다른 줄만 (색인 글은 길다)
            let line = want.lines().zip(out.text.lines()).position(|(a, b)| a != b).unwrap_or(0);
            let (js, rs) = (want.lines().nth(line), out.text.lines().nth(line));
            Some(format!("{name}: {line} 째 줄 (열쇠 같음: {})\n  JS  : {js:?}\n  Rust: {rs:?}", out.key == c["key"].as_str().unwrap()))
        })
        .collect();
    report("indexer", fails, cases.len());
}

#[test]
fn tokenize() {
    let cases = fixtures("tokenize");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = json!(memoking_core::indexer::tokenize(c["text"].as_str().unwrap()));
            (got != c["tokens"]).then(|| format!("{:?}\n  JS  : {}\n  Rust: {got}", c["text"].as_str().unwrap(), c["tokens"]))
        })
        .collect();
    report("tokenize", fails, cases.len());
}

#[test]
fn share_text() {
    use memoking_core::share_text::{hotkey_copy_text, share_text};
    let cases = fixtures("share_text");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let body = c["body"].as_str().unwrap();
            let (share, copy) = (share_text(body), hotkey_copy_text(body));
            (share != c["share"] || copy != c["copy"]).then(|| format!("{body:?}\n  JS  : {:?} / {:?}\n  Rust: {share:?} / {copy:?}", c["share"], c["copy"]))
        })
        .collect();
    report("share_text", fails, cases.len());
}

#[test]
fn calendar_feeds() {
    let cases = fixtures("calendar_feeds");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = json!(memoking_core::calendar_feeds::normalize_feeds(&c["list"]));
            (got != c["feeds"]).then(|| format!("{}\n  JS  : {}\n  Rust: {got}", c["list"], c["feeds"]))
        })
        .collect();
    report("calendar_feeds", fails, cases.len());
}
