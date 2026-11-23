// AI 요청 메모 (_memoking/AI 요청.md) — AI 비서가 적은 요청으로 메모를 고치고, 결과를 적고 비운다
//   (core/src/ai_requests.rs · vault/ai_ops.rs, 휴대폰 android/web/js/vault.js aiRequests 와 같음)
//   2초마다의 다시 읽기 뒤에 본다: 파일이 바뀌었을 때만 읽는다. 없으면 만들어 둔다
//   (메모킹이 만든 파일이어야 Drive 에서 AI 가 고친 것이 이 PC 에 내려온다 — 권한이 drive.file)
use crate::memos::push_list;
use crate::state::State;
use memoking_core::ai_requests::{parse_requests, requests_text, REQUESTS_FILE};
use memoking_core::vault::write_atomic;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

static SEEN: Mutex<Option<(std::time::SystemTime, u64)>> = Mutex::new(None);

pub fn tick(app: &AppHandle) {
    let st = app.state::<State>();
    let mut touched: Vec<(String, Option<Value>)> = vec![];
    let lines = {
        let mut guard = st.vault.lock().unwrap();
        let Some(v) = guard.as_mut() else { return };
        let path = v.root.join(REQUESTS_FILE);
        let Ok(meta) = std::fs::metadata(&path) else {
            let _ = write_atomic(&path, requests_text(&[], "").as_bytes());
            return;
        };
        let stamp = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len());
        let mut seen = SEEN.lock().unwrap();
        if *seen == Some(stamp) {
            return;
        }
        *seen = Some(stamp);
        let (ops, error) = parse_requests(&std::fs::read_to_string(&path).unwrap_or_default());
        if ops.is_empty() && error.is_empty() {
            return;
        }
        let mut lines: Vec<String> = if error.is_empty() { vec![] } else { vec![format!("- ⚠️ {error}")] };
        let snap = |v: &memoking_core::vault::Vault| v.files().map(|e| (e.id.clone(), (e.file.clone(), e.body.clone()))).collect::<HashMap<_, _>>();
        let before = snap(v);
        lines.extend(v.apply_ai_ops(&ops));
        let after = snap(v);
        touched = before.keys().chain(after.keys()).filter(|id| before.get(*id) != after.get(*id)).map(|id| (id.clone(), v.get(id))).collect();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        if let Err(e) = write_atomic(&path, requests_text(&lines, &now).as_bytes()) {
            eprintln!("[AI 요청] 결과를 쓰지 못했어요: {e}");
        }
        *seen = None;
        lines
    };
    crate::index::mark();
    // 고친 메모를 열어 둔 창은 다른 기기에서 바뀐 것처럼 새 글을 받는다 (쓰던 글이 AI 가 고친 글을 덮지 않게)
    let labels = st.note_labels.lock().unwrap().clone();
    for (id, memo) in touched {
        if let Some(label) = labels.get(&id) {
            let _ = match memo {
                Some(m) => app.emit_to(label.as_str(), "memo:external", [m]),
                None => app.emit_to(label.as_str(), "memo:removed", [Value::Null; 0]),
            };
        }
    }
    push_list(app);
    let count = |icon: &str| lines.iter().filter(|l| l.starts_with(icon)).count();
    let _ = app.emit_to("list", "ai:requests", [json!({ "done": count("- ✅"), "failed": count("- ⚠️") })]);
}
