// window.memoking 의 모든 채널이 들어오는 곳 — Electron 의 ipcMain.handle 들 (desktop/ipc-handlers.js · main.js) 자리.
//   옮긴 채널은 dispatch 의 match 에 한 줄씩. 어디까지 옮겼는지는 desktop-rs/checklist.mjs 가 이 파일에서 센다.
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Webview};

// async: Windows 에서는 동기 명령 안에서 창을 만들면(메모 창 열기) 멈춘다 — 비동기 명령은 다른 스레드에서 돈다.
//   몇 분 걸리는 채널(AI 답 · 모델 받기)이 비동기 일꾼을 붙잡지 않게 막아도 되는 스레드에서
#[tauri::command]
pub async fn ipc(app: AppHandle, webview: Webview, channel: String, args: Vec<Value>) -> Result<Value, String> {
    // 막혀도 되는 스레드에서 — 링크 미리보기 · 그림 받기(몇 초)가 비동기 일꾼(코어 수만큼)을 다 붙잡아 다른 채널까지 멈추지 않게
    let label = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &label, &channel, args)).await.map_err(|e| e.to_string())?
}

/// memoking --smoke : 앱 안 점검 (smoke.js)
pub fn smoke() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::args().any(|a| a == "--smoke"))
}

/// 창 수를 세는 점검인가 — 끌어 놓기 재현(MEMOKING_DROPTEST)은 실제처럼 예비 창 · 창 재활용을 쓴다
pub fn counting_smoke() -> bool {
    smoke() && std::env::var_os("MEMOKING_DROPTEST").is_none()
}

pub fn dispatch(app: &AppHandle, label: &str, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    if let Some(r) = crate::memos::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::clipboard::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::ai::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::settings::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::reminders::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::shortcuts::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::files::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::drive::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::windows::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::history::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::services::handle(app, label, channel, &args) {
        return r;
    }
    if let Some(r) = crate::stt::handle(app, label, channel, &args) {
        return r;
    }
    match channel {
        // 매직 카피 도우미가 지금 클립보드를 읽어 오는지 (Ctrl+C 는 보내지 않는다 — 점검 PC 의 다른 앱에 키가 가지 않게)
        "smoke:clipboard-dump" if smoke() => crate::capture::smoke_dump(app),
        // 끌어 놓기 재현 (droptest-rs.yml): 켜졌나 · 창을 정해진 자리에 두고 바깥 도우미에게 놓을 곳(화면 좌표)을 알린다
        "smoke:droptest" if smoke() => Ok(std::env::var("MEMOKING_DROPTEST").ok().map_or(Value::Bool(false), Value::from)),
        "smoke:droptest-ready" if smoke() => {
            use tauri::Manager;
            let w = app.get_webview_window(label).ok_or("창 없음")?;
            let _ = w.set_size(tauri::PhysicalSize::new(420u32, 460u32));
            let _ = w.set_position(tauri::PhysicalPosition::new(480i32, 120i32));
            std::thread::sleep(std::time::Duration::from_millis(300));
            let (p, s) = (w.outer_position().map_err(|e| e.to_string())?, w.outer_size().map_err(|e| e.to_string())?);
            // 글 아래 빈 곳이 아니라 창 가운데보다 조금 위 (편집기 안)
            let line = format!("{} {}", p.x + s.width as i32 / 2, p.y + 150);
            std::fs::write(std::env::temp_dir().join("memoking-droptest-ready.txt"), &line).map_err(|e| e.to_string())?;
            println!("[droptest] 놓을 곳 {line} (창 {}x{} @ {},{})", s.width, s.height, p.x, p.y);
            Ok(Value::Null)
        }
        "smoke:emit" if smoke() => app.emit_to(label, args[0].as_str().unwrap_or_default(), [42]).map(|_| Value::Null).map_err(|e| e.to_string()),
        "smoke:done" if smoke() => {
            // 목록 · 메모 창이 다 알려 오면 찍고, 화면 사진을 찍을 틈(6초)을 두고 끝낸다
            static DONE: Mutex<(usize, usize)> = Mutex::new((0, 0)); // (알려 온 창, 실패)
            let results = args.into_iter().next().unwrap_or_default();
            let mut done = DONE.lock().unwrap();
            for r in results.as_array().into_iter().flatten() {
                let ok = r["ok"].as_bool() == Some(true);
                done.1 += usize::from(!ok);
                println!("{} {} {}", if ok { "✔" } else { "✖" }, r["name"].as_str().unwrap_or("?"), r["detail"].as_str().unwrap_or(""));
            }
            done.0 += 1;
            if label != "list" {
                let _ = app.emit_to("list", "smoke:note-done", ());
            }
            if done.0 == 2 {
                let (app, code) = (app.clone(), i32::from(done.1 > 0));
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    app.exit(code);
                });
            }
            Ok(Value::Null)
        }
        _ => Err(unported(channel)),
    }
}

// 아직 옮기지 않은 채널 — 화면은 Electron 때처럼 실패한 약속(reject)으로 받는다. 처음 한 번만 적는다
fn unported(channel: &str) -> String {
    static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    if SEEN.lock().unwrap().get_or_insert_with(HashSet::new).insert(channel.to_string()) {
        elog!("[ipc] 아직 옮기지 않음: {channel}");
    }
    format!("아직 옮기지 않은 기능이에요 ({channel})")
}
