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

// ---------- Google Drive 동기화 (parity/drive.mjs 와 같은 가짜 Drive) ----------
mod drive {
    use memoking_core::drive_sync::{self, Changes, Remote, RemoteItem, SyncState};
    use serde_json::{json, Map, Value};
    use std::collections::{BTreeMap, HashSet};
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    struct Item {
        id: String,
        name: String,
        parent: Option<String>,
        folder: bool,
        data: Vec<u8>,
        gdoc: bool,
        modified: i64,
        trashed: bool,
    }

    struct Fake {
        items: Mutex<Vec<Item>>,
        raw: Option<Vec<Value>>,
        now: i64,
    }

    fn unique() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst))
    }

    fn md5(data: &[u8]) -> String {
        let f = std::env::temp_dir().join(format!("mk-md5-{}", unique()));
        std::fs::write(&f, data).unwrap();
        let h = drive_sync::md5_file(&f).unwrap();
        let _ = std::fs::remove_file(f);
        h
    }

    fn join(a: String, b: &str) -> String {
        if a.is_empty() { b.into() } else { format!("{a}/{b}") }
    }

    impl Fake {
        fn new(remote: &Map<String, Value>, raw: Option<Vec<Value>>, now: i64) -> Fake {
            let root = Item { id: "root0".into(), name: String::new(), parent: None, folder: true, data: vec![], gdoc: false, modified: 0, trashed: false };
            let f = Fake { items: Mutex::new(vec![root]), raw, now };
            for (p, v) in remote {
                let o = if v.is_string() { json!({ "text": v }) } else { v.clone() };
                let parts: Vec<&str> = p.trim_end_matches('/').split('/').collect();
                let mut parent = "root0".to_string();
                for i in 0..parts.len() - usize::from(!p.ends_with('/')) {
                    parent = f.folder(&parent, &parts[..=i].join("/"), parts[i]);
                }
                if p.ends_with('/') {
                    continue;
                }
                f.items.lock().unwrap().push(Item {
                    id: o["id"].as_str().map_or(format!("x:{p}"), str::to_string),
                    name: o["name"].as_str().unwrap_or(parts[parts.len() - 1]).into(),
                    parent: Some(parent),
                    folder: false,
                    data: o["text"].as_str().unwrap_or_default().as_bytes().to_vec(),
                    gdoc: o["gdoc"] == true,
                    modified: o["modified"].as_i64().unwrap_or(0),
                    trashed: false,
                });
            }
            f
        }

        fn folder(&self, parent: &str, rel: &str, name: &str) -> String {
            let id = format!("d:{rel}");
            let mut items = self.items.lock().unwrap();
            if !items.iter().any(|i| i.id == id) {
                items.push(Item { id: id.clone(), name: name.into(), parent: Some(parent.into()), folder: true, data: vec![], gdoc: false, modified: 0, trashed: false });
            }
            id
        }

        fn path_of(items: &[Item], id: &str) -> String {
            let it = items.iter().find(|i| i.id == id).unwrap();
            it.parent.as_ref().map_or_else(String::new, |p| join(Fake::path_of(items, p), &it.name))
        }

        fn out(it: &Item) -> RemoteItem {
            RemoteItem { id: it.id.clone(), name: it.name.clone(), folder: it.folder, md5: (!it.folder && !it.gdoc).then(|| md5(&it.data)), modified: it.modified, created: 0, size: it.data.len() as u64 }
        }

        fn tree(&self) -> Value {
            let items = self.items.lock().unwrap();
            let mut live = Map::new();
            let mut trashed = vec![];
            for it in items.iter().filter(|i| i.id != "root0") {
                let p = Fake::path_of(&items, &it.id);
                if it.trashed {
                    trashed.push(p);
                } else {
                    live.insert(if it.folder { format!("{p}/") } else { p }, String::from_utf8_lossy(&it.data).into());
                }
            }
            trashed.sort();
            json!({ "live": live, "trashed": trashed })
        }
    }

    impl Remote for Fake {
        fn list_children(&self, folder_id: &str) -> std::io::Result<Vec<RemoteItem>> {
            Ok(self.items.lock().unwrap().iter().filter(|i| i.parent.as_deref() == Some(folder_id) && !i.trashed).map(Fake::out).collect())
        }
        fn download(&self, id: &str, file: &Path) -> std::io::Result<()> {
            let data = self.items.lock().unwrap().iter().find(|i| i.id == id).unwrap().data.clone();
            std::fs::write(file, data)
        }
        fn upload(&self, parent: &str, name: &str, existing: Option<&str>, file: &Path) -> std::io::Result<RemoteItem> {
            let data = std::fs::read(file)?;
            let mut items = self.items.lock().unwrap();
            let id = match existing {
                Some(id) => {
                    let it = items.iter_mut().find(|i| i.id == id).unwrap();
                    (it.data, it.modified) = (data, self.now);
                    id.to_string()
                }
                None => {
                    let mut id = format!("x:{}", join(Fake::path_of(&items, parent), name));
                    while items.iter().any(|i| i.id == id) {
                        id.push('+');
                    }
                    items.push(Item { id: id.clone(), name: name.into(), parent: Some(parent.into()), folder: false, data, gdoc: false, modified: self.now, trashed: false });
                    id
                }
            };
            Ok(Fake::out(items.iter().find(|i| i.id == id).unwrap()))
        }
        fn create_folder(&self, parent: &str, name: &str) -> std::io::Result<RemoteItem> {
            let rel = join(Fake::path_of(&self.items.lock().unwrap(), parent), name);
            let id = self.folder(parent, &rel, name);
            Ok(Fake::out(self.items.lock().unwrap().iter().find(|i| i.id == id).unwrap()))
        }
        fn trash(&self, id: &str) -> std::io::Result<()> {
            self.items.lock().unwrap().iter_mut().find(|i| i.id == id).unwrap().trashed = true;
            Ok(())
        }
        fn changes_since(&self, token: Option<&str>, known: &HashSet<String>) -> std::io::Result<Changes> {
            let (Some(_), Some(raw)) = (token, &self.raw) else { return Ok(Changes { changed: true, token: "t1".into(), items: None }) };
            let items = drive_sync::pick_changes(raw, known);
            Ok(Changes { changed: !items.is_empty(), token: "t2".into(), items: Some(items) })
        }
    }

    fn local_tree(root: &Path, rel: &str, out: &mut Map<String, Value>) {
        for e in std::fs::read_dir(root.join(rel)).unwrap().flatten() {
            let r = join(rel.into(), &e.file_name().to_string_lossy());
            if e.file_type().unwrap().is_dir() {
                out.insert(format!("{r}/"), "".into());
                local_tree(root, &r, out);
            } else {
                out.insert(r, std::fs::read_to_string(e.path()).unwrap().into());
            }
        }
    }

    // 여러 줄(CONCURRENCY)로 돌려도 JS(한 줄)와 같은 끝 모습
    #[test]
    fn drive_sync() {
        let cases = super::fixtures("drive_sync");
        let fails = cases
            .iter()
            .filter_map(|c| {
                let root = std::env::temp_dir().join(format!("mk-drive-rs-{}", unique()));
                std::fs::create_dir_all(&root).unwrap();
                for (rel, v) in c["local"].as_object().unwrap() {
                    let file = root.join(rel);
                    if rel.ends_with('/') {
                        std::fs::create_dir_all(&file).unwrap();
                        continue;
                    }
                    let (text, mtime) = match v {
                        Value::Array(a) => (a[0].as_str().unwrap(), a[1].as_u64().unwrap()),
                        _ => (v.as_str().unwrap(), c["mtime"].as_u64().unwrap()),
                    };
                    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                    std::fs::write(&file, text).unwrap();
                    let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime);
                    std::fs::File::options().write(true).open(&file).unwrap().set_modified(t).unwrap();
                }
                let now = c["now"].as_i64().unwrap();
                let remote = Fake::new(c["remote"].as_object().unwrap(), c["raw"].as_array().cloned(), now);
                let mut state: SyncState = serde_json::from_value(c["state"].clone()).unwrap();
                let opts = drive_sync::Options {
                    full: c["opts"]["full"] == true,
                    local_clean: c["opts"]["localClean"] == true,
                    conflict_tag: "PC 충돌",
                    now: &move || now,
                    on_progress: &|_, _, _| {},
                    concurrency: drive_sync::CONCURRENCY,
                };
                let result = match drive_sync::run(&root, &remote, "root0", &mut state, &opts) {
                    Ok(mut r) => {
                        r.conflicts.sort();
                        serde_json::to_value(r).unwrap()
                    }
                    Err(e) => json!({ "error": e.to_string() }),
                };
                let mut local = Map::new();
                local_tree(&root, "", &mut local);
                let _ = std::fs::remove_dir_all(&root);
                let files: BTreeMap<_, _> = state.files.iter().map(|(rel, b)| (rel.clone(), json!({ "id": b.id, "md5": b.md5, "lsize": b.lsize }))).collect();
                let got = json!({
                    "result": result,
                    "local": local,
                    "remote": remote.tree(),
                    "state": { "pageToken": state.page_token, "files": files, "folders": state.folders, "dirs": state.dirs, "lastFullScan": state.last_full_scan, "keepMissing": state.keep_missing },
                });
                (got != c["out"]).then(|| format!("{}\n  JS  : {}\n  Rust: {got}", c["name"], c["out"]))
            })
            .collect();
        super::report("drive_sync", fails, cases.len());
    }
}
