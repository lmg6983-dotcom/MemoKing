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

#[test]
fn accelerators() {
    use memoking_core::accelerators::{combo_from_accelerator, display_accelerator, is_valid_accelerator, normalize_shortcuts, with_shortcuts};
    let cases = fixtures("accelerators");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let acc = &c["acc"];
            // 글자가 아닌 값은 쓸 만한지만 (보이는 글자 · 메모 창 키는 늘 글자로 부른다)
            let s = acc.as_str();
            let got = json!({ "valid": is_valid_accelerator(acc), "display": s.map(display_accelerator), "combo": s.map(combo_from_accelerator) });
            let want = json!({ "valid": c["valid"], "display": s.map(|_| c["display"].clone()), "combo": s.map(|_| c["combo"].clone()) });
            (got != want).then(|| format!("{acc}\n  JS  : {want}\n  Rust: {got}"))
        })
        .collect();
    report("accelerators", fails, cases.len());
    let sets = fixtures("shortcuts");
    let guide = "글을 고르고 Ctrl+Alt+C, 매직키는 Ctrl+Alt+Space, 목록은 Ctrl+Alt+` — Ctrl+Alt+CC Ctrl+Alt+`Ctrl+Alt+C";
    let fails = sets
        .iter()
        .filter_map(|c| {
            let [q, m, l] = normalize_shortcuts(&c["value"]);
            let got = json!({ "normalized": { "quickMemo": q, "magic": m, "list": l }, "text": with_shortcuts(guide, &c["value"]) });
            let want = json!({ "normalized": c["normalized"], "text": c["text"] });
            (got != want).then(|| format!("{}\n  JS  : {want}\n  Rust: {got}", c["value"]))
        })
        .collect();
    report("shortcuts", fails, sets.len());
}

#[test]
fn memo_hotkeys() {
    use memoking_core::accelerators::{assign_hotkey, normalize_hotkeys};
    let cases = fixtures("memo_hotkeys");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let assigned = match assign_hotkey(&c["raw"], c["id"].as_str().unwrap(), c["slot"].as_str(), c["copy"] != false, c["show"] == true) {
                Ok(m) => Value::Object(m),
                Err(e) => json!({ "error": e }),
            };
            let got = json!({ "normalized": normalize_hotkeys(&c["raw"]), "assigned": assigned });
            let want = json!({ "normalized": c["normalized"], "assigned": c["assigned"] });
            (got != want).then(|| format!("{c}\n  Rust: {got}"))
        })
        .collect();
    report("memo_hotkeys", fails, cases.len());
}

#[test]
fn tutorial() {
    use memoking_core::tutorial::{advance, chapter, jumps, step_for, steps};
    let cases = fixtures("tutorial");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let index = c["index"].as_i64().unwrap();
            let step = usize::try_from(index).ok().and_then(|i| steps().get(i));
            let adv: serde_json::Map<String, Value> = c["advance"].as_object().unwrap().keys().map(|e| (e.clone(), advance(index, e).into())).collect();
            let got = json!({
                "advance": adv,
                "on": step.map(|s| step_for(s, |_| true)),
                "off": step.map(|s| step_for(s, |_| false)),
                "chapter": chapter(index),
                "jumps": jumps(),
            });
            let want = json!({ "advance": c["advance"], "on": c["on"], "off": c["off"], "chapter": c["chapter"], "jumps": c["jumps"] });
            (got != want).then(|| format!("{index}\n  JS  : {want}\n  Rust: {got}"))
        })
        .collect();
    report("tutorial", fails, cases.len());
}

#[test]
fn link_preview() {
    use memoking_core::link_preview::*;
    let cases = fixtures("link_preview");
    let oembeds = ["{\"title\":\" 제목\\n줄 \",\"author_name\":\"채널\"}", "{\"title\":5}", "null", "", &format!("{{\"title\":\"{}\"}}", "x".repeat(210))];
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = if let Some(html) = c["html"].as_str() {
                json!({ "html": html, "url": c["url"], "preview": parse_link_preview(html, c["url"].as_str().unwrap()) })
            } else if let Some(url) = c["url"].as_str() {
                let parsed: Vec<Value> = oembeds.iter().map(|j| parse_youtube_oembed(j, url)).collect();
                json!({ "url": url, "host": host_of(url), "oembedUrl": youtube_oembed_url(url), "stale": stale_youtube_entry(url, &json!({ "title": "x" })), "fresh": stale_youtube_entry(url, &json!({ "kind": "page" })), "oembeds": parsed })
            } else if let Some(head) = c["head"].as_str() {
                json!({ "type": c["type"], "head": head, "charset": detect_charset(c["type"].as_str().unwrap(), head) })
            } else if let Some(t) = c["type"].as_str() {
                json!({ "type": t, "ext": image_ext_from_type(t) })
            } else {
                json!({ "imageUrl": c["imageUrl"], "ext": image_ext_from_url(c["imageUrl"].as_str().unwrap()) })
            };
            (&got != c).then(|| format!("  JS  : {c}\n  Rust: {got}"))
        })
        .collect();
    report("link_preview", fails, cases.len());
}

#[test]
fn release_notes() {
    let cases = fixtures("release_notes");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = json!(memoking_core::release_notes::version_titles(c["readme"].as_str().unwrap(), c["from"].as_str(), c["to"].as_str().unwrap(), 5));
            (got != c["titles"]).then(|| format!("{} → {}\n  JS  : {}\n  Rust: {got}", c["from"], c["to"], c["titles"]))
        })
        .collect();
    report("release_notes", fails, cases.len());
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

// 숫자는 f64 로 맞춰 비교한다 (Rust 는 2.0, JS 는 2 로 적는다)
fn num_norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(num_norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), num_norm(v))).collect()),
        _ => v.clone(),
    }
}

#[test]
fn tag_suggest() {
    use memoking_core::tag_suggest::*;
    let sets: std::collections::HashMap<String, Vec<(String, String)>> = fixtures("tag_sets")
        .iter()
        .map(|s| (s["name"].as_str().unwrap().to_string(), s["memos"].as_array().unwrap().iter().map(|m| (m["id"].as_str().unwrap().to_string(), m["body"].as_str().unwrap().to_string())).collect()))
        .collect();
    let cases = fixtures("tag_suggest");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let (memos, body, id) = (&sets[c["set"].as_str().unwrap()], c["body"].as_str().unwrap(), c["id"].as_str());
            let suggest = json!(suggest_tags_for(body, memos, 3, id));
            let auto = json!(["capture", "link", "audio", "share", ""].map(|s| auto_tags_for(body, memos, s, id)));
            (suggest != c["suggest"] || auto != c["auto"]).then(|| format!("{} {body:?}\n  JS  : {} {}\n  Rust: {suggest} {auto}", c["set"], c["suggest"], c["auto"]))
        })
        .collect();
    report("tag_suggest", fails, cases.len());
    let cases = fixtures("tag_match");
    let tags: Vec<Existing> = [("MemoKing", 3), ("회의", 5), ("장보기", 2), ("프로젝트", 2), ("업무", 1), ("스크린샷", 1)].map(|(n, c)| Existing { name: n.into(), count: c }).into();
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = match_existing(c["word"].as_str().unwrap(), &tags).map_or(json!({ "name": null, "rank": null }), |(m, r)| json!({ "name": m.name, "rank": r }));
            (got["name"] != c["name"] || got["rank"] != c["rank"]).then(|| format!("{c} → {got}"))
        })
        .collect();
    report("tag_match", fails, cases.len());
}

#[test]
fn ai_text() {
    use memoking_core::ai::*;
    let cases = fixtures("ai_text");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let s = |k: &str| c[k].as_str().unwrap_or_default();
            let got = match s("kind") {
                "noThink" => json!(no_think(s("text"))),
                "sse" => json!(sse_text(s("text")).unwrap()),
                "engine" => json!(engine_error(s("text"), s("code"))),
                "clean" => json!(clean_write_output(s("text"))),
                "fix" => json!(plausible_fix(s("text"), s("after"))),
                "spell" => spell_messages(s("text")),
                "style" => style_messages(s("text"), s("style")),
                "draft" => draft_messages(s("title"), s("body"), s("request"), s("selection")),
                "append" | "remove" => {
                    use memoking_core::tag_suggest::{append_tags, remove_tags};
                    let names: Vec<String> = c["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect();
                    json!(if s("kind") == "append" { append_tags(s("text"), &names) } else { remove_tags(s("text"), &names) })
                }
                "body" => chat_body(&json!([{ "role": "user", "content": "x" }]), 80, 0.3, None, false),
                _ => chat_body(&json!([]), 60, 0.0, Some(&json!({ "type": "object" })), true),
            };
            (got != c["out"]).then(|| format!("{} {:?}\n  JS  : {}\n  Rust: {got}", s("kind"), s("text"), c["out"]))
        })
        .collect();
    report("ai_text", fails, cases.len());
}

#[test]
fn ai_tags() {
    use memoking_core::ai::*;
    let sets: std::collections::HashMap<String, Vec<(String, String)>> = fixtures("tag_sets")
        .iter()
        .map(|s| (s["name"].as_str().unwrap().to_string(), s["memos"].as_array().unwrap().iter().map(|m| (m["id"].as_str().unwrap().to_string(), m["body"].as_str().unwrap().to_string())).collect()))
        .collect();
    let answers = [r##"{"tags":["회의","#일정 관리","메모","프로잭트","캡쳐","x",5,null,"회의록","업무","가족"]}"##, r##"{"tags":[]}"##, "not json", r##"{"tags":"회의"}"##, r##"{"tags":["미팅","장보기","여행계획","스크린샷"]}"##];
    let cases = fixtures("ai_tags");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let (memos, body) = (&sets[c["set"].as_str().unwrap()], c["body"].as_str().unwrap());
            let req = ai_tag_request(body, memos, c["id"].as_str());
            let mut grounded: Vec<&String> = req.grounded.iter().collect();
            grounded.sort();
            let mut want: Vec<&str> = c["grounded"].as_array().unwrap().iter().map(|g| g.as_str().unwrap()).collect();
            want.sort();
            let got = json!({
                "messages": req.messages,
                "schema": req.schema,
                "existing": req.existing.iter().map(|e| json!({ "name": e.name, "count": e.count })).collect::<Vec<_>>(),
                "results": answers.map(|a| ai_tag_result(a, &req.existing, body, &req.grounded)),
            });
            let diff: Vec<String> = got.as_object().unwrap().iter().filter(|(k, v)| c[k.as_str()] != **v).map(|(k, v)| format!("  {k}\n    JS  : {}\n    Rust: {v}", c[k.as_str()])).collect();
            (!diff.is_empty() || grounded != want).then(|| format!("{} {body:?}\n{}", c["set"], diff.join("\n")))
        })
        .collect();
    report("ai_tags", fails, cases.len());
}

#[test]
fn rag() {
    use memoking_core::rag::*;
    let now = memoking_core::time::parse_js_date("2026-11-18T15:00:00+09:00").unwrap().with_timezone(&chrono::Local);
    let memos = fixtures("rag_chunks");
    let mut fails: Vec<String> = memos.iter().filter(|m| json!(chunk_memo(m["body"].as_str().unwrap())) != m["chunks"]).map(|m| format!("조각 {}", m["id"])).collect();
    let chunks: Vec<Chunk> = memos
        .iter()
        .flat_map(|m| {
            let title = memoking_core::body::extract_title(m["body"].as_str().unwrap());
            chunk_memo(m["body"].as_str().unwrap()).into_iter().map(move |text| Chunk { id: m["id"].as_str().unwrap().into(), title: title.clone(), text, updated: m["updated"].as_str().map(str::to_string) })
        })
        .collect();
    let index = build_index(chunks);
    let related = |id: &str| -> Vec<(String, f64)> {
        match id {
            "w" => vec![("m".into(), 0.8), ("zz".into(), 1.0), ("r".into(), 0.5)],
            "r" => vec![("t".into(), 0.4)],
            "m" => vec![("w".into(), 0.9)],
            _ => vec![],
        }
    };
    let answers = ["비밀번호는 abc12345예요 [1]", "메모에서 찾지 못했어요.", "답만 있어요", "[9] 없는 번호 [2]", "", "없어요", "첫째 [1][3] 둘째"];
    let cases = fixtures("rag");
    for c in &cases {
        let q = c["q"].as_str().unwrap();
        if q == "expand" {
            let got = json!(["{\"words\":[\"a\",\" b \",1,null,\"\",\"c\",\"d\",\"e\",\"f\",\"g\"]}", "{\"words\":\"x\"}", "nope"].map(expand_result));
            let (m, s) = expand_messages("질문");
            if got != c["expand"] || json!({ "messages": m, "schema": s }) != c["messages"] {
                fails.push(format!("expand {got}"));
            }
            continue;
        }
        let words = expand_result(&json!({ "words": c["words"] }).to_string());
        let picked = retrieve(q, &index, &words, &related, 4, now);
        let period = asked_period(q, now).map(|(f, t)| json!([f.timestamp_millis(), t.timestamp_millis()]));
        let got = json!({
            "expanded": words,
            "period": period,
            "picked": picked.iter().map(Picked::to_json).collect::<Vec<_>>(),
            "messages": rag_messages(q, &picked, now),
            "finished": answers.map(|a| {
                let (text, quoted) = finish_answer(a, q, &picked, &words);
                json!({ "text": text, "quoted": quoted })
            }),
        });
        // 점수는 끝자리만 다를 수 있다 (V8 Math.log 와 Rust ln 의 마지막 비트)
        let round = |v: &Value| {
            let mut v = v.clone();
            for p in v.as_array_mut().into_iter().flatten() {
                p["score"] = json!((p["score"].as_f64().unwrap() * 1e12).round());
            }
            v
        };
        let same = |k: &str, v: &Value| if k == "picked" { round(&c[k]) == round(v) } else { c[k] == *v };
        let diff: Vec<String> = got.as_object().unwrap().iter().filter(|(k, v)| !same(k, v)).map(|(k, v)| format!("  {k}\n    JS  : {}\n    Rust: {v}", c[k.as_str()])).collect();
        if !diff.is_empty() {
            fails.push(format!("{q:?} {}\n{}", c["words"], diff.join("\n")));
        }
    }
    report("rag", fails, cases.len());
}

#[test]
fn stacks() {
    use memoking_core::stacks::Stacks;
    let cases = fixtures("stacks");
    let memos = ["a", "b", "c", "d", "e", "f"];
    let open = |file: &Value| {
        let mut n = 0;
        let new_id = move || {
            n += 1;
            format!("s{n}")
        };
        Stacks::load(file.as_str(), |id| memos.contains(&id), Box::new(new_id))
    };
    let mut fails = vec![];
    for c in &cases {
        let loaded = open(&c["file"]).text();
        if loaded != c["loaded"].as_str().unwrap() {
            fails.push(format!("읽기 {}\n  JS  : {}\n  Rust: {loaded}", c["file"], c["loaded"]));
        }
        let mut s = open(&c["file"]);
        for (op, step) in c["ops"].as_array().unwrap().iter().zip(c["steps"].as_array().unwrap()) {
            let a = |i: usize| op[i].as_str().unwrap_or_default().to_string();
            let ret = match op[0].as_str().unwrap() {
                "merge" => {
                    let moving: Vec<String> = op[2].as_array().unwrap().iter().map(|m| m.as_str().unwrap().to_string()).collect();
                    json!(s.merge(&a(1), &moving, op.get(3).and_then(Value::as_str)))
                }
                "addAfter" => json!(s.add_after(&a(1), &a(2))),
                "reorder" => json!(s.reorder(&a(1), &op[2])),
                "setActive" => json!(s.set_active(&a(1))),
                "neighbor" => json!(s.neighbor(&a(1), op[2].as_i64().unwrap() as i32)),
                "remove" => json!(s.remove(&a(1))),
                other => panic!("{other}"),
            };
            let got = json!({ "ret": ret, "stacks": s.stacks });
            if num_norm(&got) != num_norm(step) {
                fails.push(format!("{} {op}\n  JS  : {step}\n  Rust: {got}", c["file"]));
            }
        }
    }
    report("stacks", fails, cases.len());
}

#[test]
fn placement() {
    use memoking_core::placement::{drop_bounds, is_inside, place_bubble};
    let r = |v: &Value| [v["x"].as_f64().unwrap(), v["y"].as_f64().unwrap(), v["width"].as_f64().unwrap(), v["height"].as_f64().unwrap()];
    let cases = fixtures("placement");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = if let Some(d) = c.get("drop") {
                let p = (d["p"]["x"].as_f64().unwrap(), d["p"]["y"].as_f64().unwrap());
                let [x, y, w, h] = drop_bounds(p, (d["s"]["width"].as_f64().unwrap(), d["s"]["height"].as_f64().unwrap()), r(&d["a"]));
                json!({ "drop": { "p": d["p"], "s": d["s"], "a": d["a"], "bounds": { "x": x, "y": y, "width": w, "height": h }, "inside": is_inside(p, r(&d["a"])) } })
            } else {
                let b = &c["bubble"];
                let sticker = (!b["sticker"].is_null()).then(|| r(&b["sticker"]));
                let mut out = b.clone();
                out["r"] = place_bubble(r(&b["b"]), r(&b["area"]), b["anchor"].as_f64().unwrap(), b["barH"].as_f64().unwrap(), sticker);
                json!({ "bubble": out })
            };
            (num_norm(&got) != num_norm(c)).then(|| format!("  JS  : {c}\n  Rust: {got}"))
        })
        .collect();
    report("placement", fails, cases.len());
}

#[test]
fn notify() {
    use memoking_core::notify::*;
    let cases = fixtures("notify");
    let s = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let fails = cases
        .iter()
        .filter_map(|c| {
            let o = &c["o"];
            let got = match c["kind"].as_str().unwrap() {
                "toast" => json!(parse_toast_xml(&s(&c["xml"]))),
                "app" => json!(fallback_app_name(&s(&c["id"]))),
                "query" => json!(matches_query(&c["e"], &s(&c["q"]))),
                "filetime" => json!(file_time_to_ms(s(&c["t"]).parse().unwrap())),
                "popupApp" => json!(popup_app_name(c["p"].as_str())),
                "lines" => json!(popup_to_entry(c["lines"].as_array().unwrap(), "앱")),
                "kakao" => json!(kakao_entry(c["boxes"].as_array().unwrap(), o["width"].as_f64().unwrap_or(0.0), o["height"].as_f64().unwrap_or(0.0), &s(&o["appName"]), o["profileTop"].as_f64().unwrap_or(0.0))),
                "repeat" => json!(find_repeat(c["recent"].as_array().unwrap(), &c["e"], c["now"].as_f64().unwrap(), 120_000.0).map_or(-1, |i| i as i64)),
                "better" => json!(better_reading(&json!({ "via": c["a"] }), &json!({ "via": c["b"] }))),
                "title" => json!(correct_title(&s(&c["t"]), &known_names(c["ts"].as_array().unwrap().iter().map(|t| t.as_str().unwrap())))),
                k => panic!("{k}"),
            };
            (got != c["out"]).then(|| format!("{}\n  JS  : {}\n  Rust: {got}", c, c["out"]))
        })
        .collect();
    report("notify", fails, cases.len());
}

#[test]
fn update() {
    use memoking_core::update::*;
    let cases = fixtures("update");
    let fails = cases
        .iter()
        .filter_map(|c| {
            let got = match c["kind"].as_str().unwrap() {
                "error" => json!(update_error_text(c["e"].as_str().unwrap())),
                "snooze" => json!(is_snoozed(&c["s"], &json!("1.2.0"), 1000.0)),
                _ => json!(notes_text(c["n"].as_str().unwrap())),
            };
            (got != c["out"]).then(|| format!("{}\n  JS  : {}\n  Rust: {got}", c, c["out"]))
        })
        .collect();
    report("update", fails, cases.len());
}

#[test]
fn date_detect() {
    use memoking_core::date_detect::*;
    let nows = ["2026-10-10T10:00:00+09:00", "2026-11-17T08:30:00+09:00", "2026-11-22T21:00:00+09:00", "2026-12-31T23:50:00+09:00", "2027-01-31T12:00:00+09:00"];
    let cases = fixtures("date_detect");
    let mut fails = vec![];
    for c in &cases {
        let text = c["text"].as_str().unwrap();
        let u16 = |b: usize| text[..b].encode_utf16().count();
        for (i, iso) in nows.iter().enumerate() {
            let now = memoking_core::time::parse_js_date(iso).unwrap().with_timezone(&chrono::Local);
            let got: Vec<Value> = find_dates(text, now)
                .iter()
                .map(|d| {
                    json!({
                        "from": u16(d.from), "to": u16(d.to), "text": d.text, "at": d.at.timestamp_millis(), "hasTime": d.has_time,
                        "end": d.end.map(|e| e.timestamp_millis()), "repeat": d.repeat, "title": guess_title(text, d.from, d.to),
                    })
                })
                .collect();
            if json!(got) != c["out"][i] {
                fails.push(format!("{text:?} @ {iso}\n  JS  : {}\n  Rust: {}", c["out"][i], json!(got)));
            }
        }
    }
    report("date_detect", fails, cases.len() * nows.len());
}

#[test]
fn agent() {
    use memoking_core::agent::*;
    use memoking_core::reminders::{event_from_date, occurrences_between};
    let local = |iso: &str| memoking_core::time::parse_js_date(iso).unwrap().with_timezone(&chrono::Local);
    let plan_answers = [
        r#"{"action":"event","title":"치과 검진"}"#, r#"{"action":"event"}"#, r#"{"action":"memo","title":"할 일","content":"견적서 보내기"}"#, r#"{"action":"memo","title":" 장보기 ","content":"우유, 계란이랑 빵"}"#,
        r#"{"action":"memo","content":5}"#, r#"{"action":"append","target":"회의록","content":" 발표  자료 "}"#, r#"{"action":"append","target":"","content":"x"}"#, r#"{"action":"summary"}"#, r#"{"action":"answer"}"#,
        r#"{"action":"뭐"}"#, "엉뚱한 답", "[]",
    ];
    let draft_answers = [r#"{"title":"다른 이름","items":["QA","공지"]}"#, r#"{"title":"새 이름","items":[" a  b ",null,"",3]}"#, r#"{"title":"x","items":[]}"#, r#"{"title":"초안","body":"  첫 줄\n둘째 줄  "}"#, r#"{"title":"t","body":""}"#, r#"{"body":7}"#, "엉뚱", "null", r#""글""#];
    let cases = fixtures("agent");
    let no_id = |r: Option<Value>| r.map(|mut r| {
        r.as_object_mut().unwrap().shift_remove("id");
        r
    });
    // 일정 묻기에 쓰는 일정들: 'event' 의 글 속 날짜를 그때 그대로 넣은 것 (JS agEvents 와 같은 차례)
    let all_for = |now: &str| -> Vec<Value> {
        cases.iter().filter(|c| c["kind"] == "event" && c["now"] == now).enumerate().filter_map(|(i, c)| {
            let r = event_from_date(&c["w"], local(now))?;
            Some(json!({ "memoId": format!("m{}", i % 3), "title": if i == 3 { String::new() } else { format!("메모{i}") }, "locked": i == 5, "reminder": r }))
        }).collect()
    };
    let mut fails = vec![];
    let mut check = |what: String, js: &Value, rust: Value| {
        if *js != rust {
            fails.push(format!("{what}\n  JS  : {js}\n  Rust: {rust}"));
        }
    };
    for c in &cases {
        match c["kind"].as_str().unwrap() {
            "text" => {
                let (text, iso) = (c["text"].as_str().unwrap(), c["now"].as_str().unwrap());
                let now = local(iso);
                let intent = detect_intent(text, now);
                check(format!("intent {text:?} @ {iso}"), &c["intent"], intent.clone());
                if !c["split"].is_null() {
                    check(format!("split {text:?}"), &c["split"], json!(split_items(text)));
                    check(format!("appendText {text:?}"), &c["appendText"], json!(append_text(text)));
                }
                check(format!("memoBody {text:?}"), &c["memoBody"], if intent["action"] == "memo" { json!(memo_body(&intent)) } else { Value::Null });
                let q = schedule_query(text, now);
                check(format!("query {text:?} @ {iso}"), &c["query"], q.as_ref().map_or(Value::Null, |q| json!({ "from": q.from.timestamp_millis(), "to": q.to.timestamp_millis(), "label": q.label, "words": q.words })));
                if let Some(q) = q {
                    let events = events_in(&all_for(iso), &q);
                    let got: Vec<Value> = events.iter().map(|e| json!({ "at": e.at.timestamp_millis(), "title": e.title, "memoId": e.memo_id, "allDay": e.all_day })).collect();
                    check(format!("events {text:?} @ {iso}"), &c["events"], json!(got));
                    check(format!("scheduleText {text:?} @ {iso}"), &c["scheduleText"], json!(schedule_text(&q, &events).0));
                }
                if !c["plans"].is_null() {
                    check(format!("plans {text:?}"), &c["plans"], json!(plan_answers.map(|a| plan_result(a, text, now))));
                }
            }
            "targets" => {
                let memos: Vec<(String, String, Option<String>)> = c["memos"].as_array().unwrap().iter().map(|m| (m["id"].as_str().unwrap().into(), m["body"].as_str().unwrap().into(), m["updated"].as_str().map(str::to_string))).collect();
                check(format!("targets {}", c["target"]), &c["out"], json!(append_targets(c["target"].as_str().unwrap(), &memos)));
            }
            "draft" => {
                let (m, s) = memo_draft_messages("부탁", &c["intent"]);
                check(format!("draft messages {}", c["intent"]), &c["messages"], json!({ "messages": m, "schema": s }));
                check(format!("draft {}", c["intent"]), &c["out"], json!(draft_answers.map(|a| memo_draft_result(a, &c["intent"]))));
                check(format!("draft body {}", c["intent"]), &c["bodies"], json!(draft_answers.map(|a| memo_body(&memo_draft_result(a, &c["intent"])))));
            }
            "plan" => {
                let (m, s) = plan_messages("x");
                check("plan messages".into(), &c["messages"], json!({ "messages": m, "schema": s }));
            }
            "summary" => {
                let picked: Vec<memoking_core::rag::Picked> = c["picked"].as_array().unwrap().iter().map(|p| memoking_core::rag::Picked {
                    id: p["id"].as_str().unwrap().into(), title: p["title"].as_str().unwrap().into(), score: 0.0, via: "match",
                    texts: p["texts"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect(),
                }).collect();
                check("summary messages".into(), &c["messages"], summary_messages("회의", &picked));
                let titles: Vec<String> = picked.iter().map(|p| p.title.clone()).collect();
                check("summary body".into(), &c["body"], json!(summary_body(&" 이번 주  회의 ".repeat(picked.len() + 1), "- 출시 확정 [1]\n- 담당 [2] [12]  ", &titles)));
            }
            "event" => check(format!("event {} @ {}", c["w"], c["now"]), &c["out"], json!(no_id(event_from_date(&c["w"], local(c["now"].as_str().unwrap()))))),
            "occ" => {
                let ranges = [("2026-10-20T00:00:00+09:00", "2026-10-27T00:00:00+09:00"), ("2026-10-26T00:00:00+09:00", "2026-10-26T23:00:00+09:00"), ("2026-10-01T00:00:00+09:00", "2027-03-01T00:00:00+09:00")];
                let got: Vec<Vec<i64>> = ranges.iter().map(|(f, t)| occurrences_between(&c["r"], local(f), local(t)).iter().map(|d| d.timestamp_millis()).collect()).collect();
                check(format!("occ {}", c["r"]), &c["out"], json!(got));
            }
            "append" => check(format!("append {:?}", c["body"]), &c["out"], json!(append_to_body(c["body"].as_str().unwrap(), c["text"].as_str().unwrap()))),
            k => panic!("{k}"),
        }
    }
    report("agent", fails, cases.len());
}

#[test]
fn ai_events() {
    use memoking_core::ai_events::*;
    let answers = [
        r#"{"events":[{"n":1,"title":"견적 미팅"},{"n":1,"title":"또"},{"n":3,"title":""},{"n":9,"title":"없는 줄"}]}"#,
        r#"{"events":[{"n":2,"title":"準備 파티"},{"n":"1","title":5},{"n":1.5},{"n":true,"title":"참"},null,3,{"n":4,"title":"漢字"},{"n":5}]}"#,
        r#"{"events":"x"}"#, r#"{"events":[]}"#, "엉뚱한 답", "[]",
    ];
    let no_id = |list: Vec<Value>| -> Value {
        json!(list.into_iter().map(|mut r| {
            r.as_object_mut().unwrap().shift_remove("id");
            r
        }).collect::<Vec<_>>())
    };
    let key = |c: &Candidate| json!({ "key": c.key, "line": c.key, "from": c.line[..c.date.from].encode_utf16().count(), "to": c.line[..c.date.to].encode_utf16().count(), "at": c.date.at.timestamp_millis() });
    let cases = fixtures("ai_events");
    let mut fails = vec![];
    for c in &cases {
        let body = c["body"].as_str().unwrap();
        let now = memoking_core::time::parse_js_date(c["now"].as_str().unwrap()).unwrap().with_timezone(&chrono::Local);
        let cands = event_candidates(body, &[], now);
        let first = ai_event_result(answers[0], &cands, &[], now);
        let (messages, schema) = ai_event_request(&cands);
        let old: Vec<String> = (0..299).map(|i| format!("줄{i}")).collect();
        let got = json!({
            "cands": cands.iter().map(key).collect::<Vec<_>>(),
            "again": event_candidates(body, &next_seen(&[], &cands[..cands.len().min(1)]), now).iter().map(key).collect::<Vec<_>>(),
            "request": { "messages": messages, "schema": schema },
            "results": answers.iter().map(|a| no_id(ai_event_result(a, &cands, &[], now))).collect::<Vec<_>>(),
            "existing": no_id(ai_event_result(answers[0], &cands, &first[..first.len().min(1)], now)),
            "later": no_id(ai_event_result(answers[0], &cands, &[], now + chrono::Duration::days(2))),
            "seen": next_seen(&old, &cands[..cands.len().min(2)]),
        });
        let diff: Vec<String> = got.as_object().unwrap().iter().filter(|(k, v)| c[k.as_str()] != **v).map(|(k, v)| format!("  {k}\n    JS  : {}\n    Rust: {v}", c[k.as_str()])).collect();
        if !diff.is_empty() {
            fails.push(format!("{body:?} @ {}\n{}", c["now"], diff.join("\n")));
        }
    }
    report("ai_events", fails, cases.len());
}
