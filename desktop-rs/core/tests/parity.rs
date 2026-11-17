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
