// 비밀 폴더 채널 (목록 창 · 메모 창) — 저장 · 암호 규칙은 core/src/secret.rs · core/src/vault/secret_store.rs
//   열쇠는 메모킹이 켜 있는 동안 메모리에만. 목록 창을 닫거나(알림 영역으로) 5분 동안 아무것도 하지 않으면 모두 잠근다
//   잠글 때 열린 비밀 메모 창은 닫는다 (닫으며 마지막 글은 저장 — 그 뒤에 열쇠를 잊는다)
use crate::memos::{arg_str, push_list, with_vault};
use crate::state::state;
use memoking_core::secret;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const IDLE_LOCK: Duration = Duration::from_secs(5 * 60);
static LAST_USE: AtomicU64 = AtomicU64::new(0);

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// 화면에서 무엇이든 부르면 (ipc) — 쉬는 시간을 다시 센다
pub fn touch() {
    LAST_USE.store(now_s(), Ordering::Relaxed);
}

/// 5분 동안 아무것도 하지 않으면 잠근다
pub fn start(app: &AppHandle) {
    touch();
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        let idle = now_s().saturating_sub(LAST_USE.load(Ordering::Relaxed));
        if idle >= IDLE_LOCK.as_secs() && is_open(&app) {
            lock(&app, None);
        }
    });
}

fn is_open(app: &AppHandle) -> bool {
    with_vault(app, |v| Ok(v.secret_is_open())).unwrap_or(false)
}

/// 비밀 폴더를 잠근다 (None: 모두) — 그 폴더의 메모 창을 먼저 닫아 마지막 글을 저장하게 한 뒤 열쇠를 잊는다
pub fn lock(app: &AppHandle, fid: Option<&str>) {
    let labels: Vec<String> = {
        let st = state(app);
        let map = st.note_labels.lock().unwrap();
        map.iter()
            .filter(|(id, _)| secret::parse_id(id).is_some_and(|(f, _)| fid.is_none_or(|x| x == f)))
            .map(|(_, l)| l.clone())
            .collect()
    };
    for l in &labels {
        if let Some(w) = app.get_webview_window(l) {
            let _ = w.close(); // 닫으며 저장 (note.js — 동기 저장)
        }
    }
    let (app, fid) = (app.clone(), fid.map(str::to_string));
    std::thread::spawn(move || {
        if !labels.is_empty() {
            std::thread::sleep(Duration::from_millis(1500)); // 닫히는 창의 마지막 저장을 기다린다
        }
        let _ = with_vault(&app, |v| Ok(v.secret_lock(fid.as_deref())));
        push(&app);
    });
}

/// 목록 창에 비밀 폴더의 지금 모습 (모든 비밀 폴더 — 잠긴 것도 이름은 · 연 폴더의 메모 카드)
pub fn push(app: &AppHandle) {
    let _ = app.emit_to("list", "secret:changed", [snapshot(app)]);
}

fn snapshot(app: &AppHandle) -> Value {
    with_vault(app, |v| {
        let folders = v.secret_folders();
        let memos: serde_json::Map<String, Value> =
            folders.iter().filter(|f| f["open"] == true).filter_map(|f| f["fid"].as_str()).map(|fid| (fid.to_string(), json!(v.secret_list(fid)))).collect();
        Ok(json!({ "folders": folders, "memos": memos }))
    })
    .unwrap_or_else(|_| json!({ "folders": [], "memos": {} }))
}

/// 열려 있는 메모 창의 메모가 비밀 메모면 그 폴더 (첨부를 잠가 넣으려고)
pub fn folder_of_window(app: &AppHandle, label: &str) -> Option<String> {
    let st = state(app);
    let map = st.note_labels.lock().unwrap();
    let id = map.iter().find(|(_, l)| l.as_str() == label).map(|(id, _)| id.clone())?;
    secret::parse_id(&id).map(|(f, _)| f.to_string())
}

/// 잠근 첨부를 풀어 (memoking://vault/secret-file/…) — 디스크에는 풀린 채 두지 않는다. 잠겼으면 None
pub fn serve(app: &AppHandle, src: &str) -> Option<Vec<u8>> {
    with_vault(app, |v| Ok(v.secret_file_bytes(src))).ok().flatten()
}

pub fn handle(app: &AppHandle, _label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let done = |r: Result<Value, String>| {
        if r.is_ok() {
            push_list(app);
            push(app);
        }
        r
    };
    Some(match channel {
        "secret:state" => Ok(snapshot(app)),
        // 비밀번호에 맞는 비밀 폴더를 모두 연다 (폴더마다 비밀번호가 따로) — 열쇠 만들기(느림)는 메모 폴더를 붙잡지 않고
        // 잠긴 비밀 폴더 하나를 비밀번호로 연다 — 열쇠 만들기(느림)는 메모 폴더를 붙잡지 않고
        "secret:unlock" => {
            let (fid, password) = (arg_str(args, 0), arg_str(args, 1));
            let record = match with_vault(app, |v| Ok(v.secret_record(&fid))) {
                Ok(Some(r)) => r,
                Ok(None) => return Some(Err("비밀 폴더를 찾지 못했어요".into())),
                Err(e) => return Some(Err(e)),
            };
            match secret::unlock_record(&record, &password) {
                Err(e) => Err(e),
                Ok(f) => {
                    let name = f.name.clone();
                    done(with_vault(app, |v| {
                        v.secret_add(&fid, f);
                        Ok(json!({ "fid": fid, "name": name }))
                    }))
                }
            }
        }
        // 폴더 메뉴 › 비밀 폴더로 만들기: 안의 메모를 모두 잠가 같은 이름의 비밀 폴더로 (열린 메모 창은 먼저 닫는다 — 옛 id 로 저장하지 않게)
        "secret:make" => {
            let (folder, password) = (arg_str(args, 0), arg_str(args, 1));
            match secret::new_record(&folder, &password, secret::ITERATIONS) {
                Err(e) => Err(e),
                Ok((record, f)) => {
                    let ids: Vec<String> = with_vault(app, |v| Ok(v.list().into_iter().filter(|m| m["folder"] == folder.as_str()).filter_map(|m| m["id"].as_str().map(str::to_string)).collect())).unwrap_or_default();
                    close_windows(app, |id| ids.iter().any(|x| x == id));
                    done(with_vault(app, |v| v.secret_from_folder(&folder, &record, f)).map(|(fid, left)| json!({ "fid": fid, "left": left })))
                }
            }
        }
        // 비밀 폴더 메뉴 › 보통 폴더로 되돌리기
        "secret:unmake" => {
            let fid = arg_str(args, 0);
            close_windows(app, |id| secret::parse_id(id).is_some_and(|(f, _)| f == fid));
            done(with_vault(app, |v| v.secret_to_folder(&fid)).map(Value::from))
        }
        "secret:lock" => {
            let fid = args.first().and_then(Value::as_str).map(str::to_string);
            lock(app, fid.as_deref());
            Ok(Value::Null)
        }
        "secret:rename" => done(with_vault(app, |v| v.secret_rename(&arg_str(args, 0), &arg_str(args, 1))).map(Value::from)),
        "secret:remove" => {
            let fid = arg_str(args, 0);
            close_windows(app, |id| secret::parse_id(id).is_some_and(|(f, _)| f == fid));
            done(with_vault(app, |v| v.secret_remove_folder(&fid).map_err(|e| e.to_string())).map(|_| Value::Null))
        }
        "secret:move-in" => {
            let (id, fid) = (arg_str(args, 0), arg_str(args, 1));
            close_windows(app, |x| x == id);
            done(with_vault(app, |v| v.move_to_secret(&id, &fid).map_err(|e| e.to_string())).map(Value::from))
        }
        "secret:move-out" => {
            let (id, folder) = (arg_str(args, 0), arg_str(args, 1));
            close_windows(app, |x| x == id);
            done(with_vault(app, |v| v.move_out_of_secret(&id, &folder).map_err(|e| e.to_string())).map(Value::from))
        }
        _ => return None,
    })
}

/// 옮기거나 지우는 메모의 창을 바로 닫는다 (저장 없이 — 옮기기 전에 화면이 먼저 저장했다)
fn close_windows(app: &AppHandle, pick: impl Fn(&str) -> bool) {
    let labels: Vec<(String, String)> = state(app).note_labels.lock().unwrap().iter().filter(|(id, _)| pick(id)).map(|(id, l)| (id.clone(), l.clone())).collect();
    for (id, l) in labels {
        crate::windows::remove_from_stack(app, &id, "none");
        state(app).note_labels.lock().unwrap().remove(&id);
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.destroy();
        }
    }
}
