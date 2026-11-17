// 메모 채널 — 메모 폴더 · 목록 · 메모 창 열고 닫기 · 저장. Electron 의 ipc-handlers.js · window-manager.js 의 그 부분.
use crate::state::State;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

fn state(app: &AppHandle) -> tauri::State<'_, State> {
    app.state::<State>()
}

// 1×1 빨간 점 (점검용 그림)
const DOT_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

const NO_VAULT: &str = "메모 폴더가 아직 없어요. 먼저 메모 폴더를 골라 주세요";

fn arg_str(args: &[Value], i: usize) -> String {
    args.get(i).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// 메모 폴더를 쓰는 일 (없으면 Err)
fn with_vault<T>(app: &AppHandle, f: impl FnOnce(&mut memoking_core::vault::Vault) -> Result<T, String>) -> Result<T, String> {
    let st = state(app);
    let mut guard = st.vault.lock().unwrap();
    f(guard.as_mut().ok_or(NO_VAULT)?)
}

/// 켤 때: 설정의 메모 폴더를 연다 (없으면 화면이 고르게 둔다)
pub fn start(app: &AppHandle) {
    let st = state(app);
    if let Some(dir) = st.setting("vaultPath").as_str().filter(|d| !d.is_empty()) {
        st.open_vault(PathBuf::from(dir));
    } else if crate::ipc::smoke() {
        // 점검용 메모 폴더: 그림이 든 메모 하나 (smoke.js 가 목록 · 그림 · 새 메모 · 저장을 본다)
        let dir = State::suggested_vault(app);
        let _ = std::fs::create_dir_all(dir.join("attachments"));
        let _ = std::fs::write(dir.join("시험 메모.md"), "---\nid: smoke-seed\ncolor: green\n---\n# 시험 메모\n\n#점검 ![점](attachments/dot.png)\n");
        let _ = std::fs::write(dir.join("attachments/dot.png"), DOT_PNG);
        st.open_vault(dir);
    }
    // 다른 기기 · 탐색기에서 바뀐 메모 — 2초마다 다시 읽는다
    // shortcut: 파일 감시(fs.watch)는 아직 — 다시 읽기는 파일 시각만 보므로 가볍다. 늦다는 말이 나오면 notify 로
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        rescan(&app);
    });
}

fn rescan(app: &AppHandle) {
    let st = state(app);
    let (changed, external, removed) = {
        let mut guard = st.vault.lock().unwrap();
        let Some(v) = guard.as_mut() else { return };
        let c = v.scan();
        if c.is_empty() {
            return;
        }
        let ext: Vec<(String, Value)> = c.external.iter().filter(|id| !c.removed.contains(id)).map(|id| (id.clone(), v.get(id).unwrap_or(Value::Null))).collect();
        (c.ids, ext, c.removed)
    };
    let _ = changed;
    for (id, memo) in external {
        send_to_note(app, &id, "memo:external", [memo]);
    }
    for id in removed {
        send_to_note(app, &id, "memo:removed", [Value::Null; 0]);
    }
    push_list(app);
}

fn send_to_note<S: serde::Serialize + Clone>(app: &AppHandle, id: &str, event: &str, payload: S) {
    if let Some(label) = state(app).note_labels.lock().unwrap().get(id) {
        let _ = app.emit_to(label.as_str(), event, payload);
    }
}

/// 목록 창의 메모 카드들 (열린 메모 표시와 함께)
fn list_memos(app: &AppHandle) -> Value {
    let st = state(app);
    let open: Vec<String> = st.note_labels.lock().unwrap().keys().cloned().collect();
    let views = st.setting("viewCounts");
    let list = st.vault.lock().unwrap().as_ref().map(|v| v.list()).unwrap_or_default();
    Value::Array(
        list.into_iter()
            .map(|mut m| {
                let id = m["id"].as_str().unwrap_or_default().to_string();
                let o = m.as_object_mut().unwrap();
                o.insert("open".into(), open.contains(&id).into());
                o.insert("stack".into(), 0.into());
                o.insert("hotkey".into(), Value::Null);
                o.insert("views".into(), views.get(&id).cloned().unwrap_or(0.into()));
                m
            })
            .collect(),
    )
}

pub fn push_list(app: &AppHandle) {
    let _ = app.emit_to("list", "memos:changed", [list_memos(app)]);
}

// 창 이름에 쓸 수 있는 글자만 — 메모 id 는 다른 앱이 쓴 아무 글자일 수 있다
static NEXT_NOTE: AtomicU64 = AtomicU64::new(1);

fn query_escape(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// 메모 창 열기 (이미 열려 있으면 앞으로)
pub fn open_note(app: &AppHandle, id: &str) -> Result<bool, String> {
    let st = state(app);
    if !with_vault(app, |v| Ok(v.entry(id).is_some()))? {
        return Ok(false);
    }
    if let Some(label) = st.note_labels.lock().unwrap().get(id) {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return Ok(true);
        }
    }
    let label = format!("note-{}", NEXT_NOTE.fetch_add(1, Ordering::Relaxed));
    let title = with_vault(app, |v| Ok(v.get(id).and_then(|m| m["title"].as_str().map(str::to_string)).unwrap_or_default()))?;
    // shortcut: 창 자리 기억(noteBounds) · 예비 창 · 스택 탭 · 왕관 · 테이프는 2단계 — 지금은 기본 크기로 화면 가운데쯤
    let win = crate::window(app, &label, &format!("note.html?id={}", query_escape(id)))
        .title(title)
        .inner_size(340.0, 380.0)
        .min_inner_size(240.0, 200.0)
        .build()
        .map_err(|e| e.to_string())?;
    st.note_labels.lock().unwrap().insert(id.to_string(), label);
    let (app2, id2) = (app.clone(), id.to_string());
    win.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            closed_note(&app2, &id2);
        }
    });
    push_list(app);
    Ok(true)
}

// 메모 창이 닫혔다: 빈 메모는 치우고 제목에 맞춰 파일 이름을
fn closed_note(app: &AppHandle, id: &str) {
    state(app).note_labels.lock().unwrap().remove(id);
    let _ = with_vault(app, |v| v.finalize(id).map_err(|e| e.to_string()));
    push_list(app);
}

fn create_memo(app: &AppHandle, opts: &Value) -> Result<Value, String> {
    let id = with_vault(app, |v| Ok(v.create(opts["color"].as_str(), opts["mode"].as_str(), opts["folder"].as_str().unwrap_or(""))))?;
    open_note(app, &id)?;
    Ok(id.into())
}

/// 메모 채널 — 이 파일이 맡지 않는 채널이면 None
pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let st = state(app);
    Some(match channel {
        "app:info" => Ok(st.vault_info(app)),
        "vault:use" => {
            let dir = arg_str(args, 0);
            let dir = if dir.is_empty() { State::suggested_vault(app) } else { PathBuf::from(dir) };
            st.open_vault(dir);
            push_list(app);
            Ok(st.vault_info(app))
        }
        "memos:list" => Ok(list_memos(app)),
        "memos:folders" => with_vault(app, |v| Ok(json!(v.folders()))),
        "memo:get" => with_vault(app, |v| {
            let Some(mut m) = v.get(&arg_str(args, 0)) else { return Ok(Value::Null) };
            // shortcut: 왕관 · 테이프 · 알림 · 캡처 · 스택은 2단계 — 화면이 읽는 모양만 기본값으로
            let o = m.as_object_mut().unwrap();
            for (k, val) in [("top", json!(false)), ("bottom", json!(false)), ("canTape", json!(false)), ("onTop", json!(false)), ("alarm", Value::Null), ("capture", Value::Null), ("command", Value::Null), ("insert", Value::Null)] {
                o.insert(k.into(), val);
            }
            let stack = json!({ "members": [], "active": o["id"] });
            o.insert("stack".into(), stack);
            m["linkPreviews"] = (st.setting("linkPreviews") != false).into();
            m["workLife"] = (st.setting("workLife") == true).into();
            Ok(m)
        }),
        "memo:open" => open_note(app, &arg_str(args, 0)).map(Value::from),
        "memo:create" => create_memo(app, args.first().unwrap_or(&Value::Null)),
        "memo:save" => {
            let id = arg_str(args, 0);
            let Some(body) = args.get(1).and_then(Value::as_str) else { return Some(Err("본문이 문자열이 아닙니다.".into())) };
            let (card, changed) = match with_vault(app, |v| v.save(&id, body).map_err(|e| e.to_string())) {
                Ok(r) => r,
                Err(e) => return Some(Err(e)),
            };
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.set_title(card["title"].as_str().unwrap_or_default());
            }
            if changed {
                push_list(app);
            }
            Ok(card)
        }
        // 창을 닫는 순간의 저장 — 저장하지 못한 글은 사본 메모로라도 남긴다 (잃지 않게)
        "memo:save-sync" => {
            let id = arg_str(args, 0);
            let Some(body) = args.get(1).and_then(Value::as_str).map(str::to_string) else { return Some(Ok(true.into())) };
            let r = with_vault(app, |v| {
                let mut r = v.save(&id, &body).map_err(|e| e.to_string())?;
                if r.0["retry"] == true {
                    v.scan();
                    r = v.save(&id, &body).map_err(|e| e.to_string())?;
                }
                if r.0["refused"] == true && r.0["invalid"] != true && !memoking_core::body::is_blank_body(&body) {
                    let color = v.entry(&id).map(|e| e.meta.color.clone());
                    v.import(&body, color.as_deref()).map_err(|e| e.to_string())?;
                }
                Ok(())
            });
            push_list(app);
            r.map(|()| true.into())
        }
        "win:close" => {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.close();
            }
            Ok(Value::Null)
        }
        "win:minimize" => {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.minimize();
            }
            Ok(Value::Null)
        }
        // 예비 창은 아직 — 메모 창은 늘 주소의 id 로 연다
        "win:spare" => Ok(Value::Null),
        "win:painted" => Ok(Value::Null),
        _ => return None,
    })
}

/// memoking://localhost/vault/<경로> — 메모 폴더 안 파일만 (그림 · 소리 · 영상). 화면이 캔버스로 읽게 CORS 허락
pub fn serve_vault(app: &AppHandle, rel: &str, origin: Option<&str>) -> Option<(Vec<u8>, &'static str, String)> {
    let rel = crate::percent_decode(rel);
    let file = state(app).vault.lock().unwrap().as_ref()?.resolve(&rel)?;
    let bytes = std::fs::read(&file).ok()?;
    let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    Some((bytes, mime, origin.unwrap_or("*").to_string()))
}
