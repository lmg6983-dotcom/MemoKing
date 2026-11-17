// window.memoking 의 모든 채널이 들어오는 곳 — Electron 의 ipcMain.handle 들 (desktop/ipc-handlers.js · main.js) 자리.
//   옮긴 채널은 dispatch 의 match 에 한 줄씩. 어디까지 옮겼는지는 desktop-rs/checklist.mjs 가 이 파일에서 센다.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Webview};

#[tauri::command]
pub fn ipc(app: AppHandle, webview: Webview, channel: String, args: Vec<Value>) -> Result<Value, String> {
    dispatch(&app, webview.label(), &channel, args)
}

/// memoking --smoke : 앱 안 점검 (smoke.js)
pub fn smoke() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::args().any(|a| a == "--smoke"))
}

pub fn dispatch(app: &AppHandle, label: &str, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    match channel {
        "smoke:emit" if smoke() => app.emit_to(label, args[0].as_str().unwrap_or_default(), [42]).map(|_| Value::Null).map_err(|e| e.to_string()),
        "smoke:done" if smoke() => {
            let results = args.into_iter().next().unwrap_or_default();
            let mut failed = 0;
            for r in results.as_array().into_iter().flatten() {
                let ok = r["ok"].as_bool() == Some(true);
                failed += usize::from(!ok);
                println!("{} {} {}", if ok { "✔" } else { "✖" }, r["name"].as_str().unwrap_or("?"), r["detail"].as_str().unwrap_or(""));
            }
            app.exit(i32::from(failed > 0));
            Ok(Value::Null)
        }
        "app:info" => Ok(json!({
            "vaultPath": null, "vaultError": null, "missingPath": null, "suggestedPath": null,
            "version": app.package_info().version.to_string(), "sandbox": false, "settingsReset": false,
        })),
        _ => Err(unported(channel)),
    }
}

// 아직 옮기지 않은 채널 — 화면은 Electron 때처럼 실패한 약속(reject)으로 받는다. 처음 한 번만 적는다
fn unported(channel: &str) -> String {
    static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    if SEEN.lock().unwrap().get_or_insert_with(HashSet::new).insert(channel.to_string()) {
        eprintln!("[ipc] 아직 옮기지 않음: {channel}");
    }
    format!("아직 옮기지 않은 기능이에요 ({channel})")
}
