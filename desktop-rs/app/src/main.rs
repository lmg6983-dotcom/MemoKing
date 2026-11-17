// 메모킹 데스크탑 (Rust + Tauri 2) — Electron 의 desktop/ 을 옮기는 중. 화면은 ../../app 그대로.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;

use tauri::{http, AppHandle, WebviewUrl, WebviewWindowBuilder};

// desktop/preload.cjs 를 그대로 끼워 넣는다 (shim.js 가 require('electron') 을 Tauri 로 바꿔 줌)
fn init_script() -> String {
    let mut s = include_str!("../shim.js").replace("/*PRELOAD*/", include_str!("../../../desktop/preload.cjs"));
    if ipc::smoke() {
        s.push_str(include_str!("../smoke.js"));
    }
    s
}

/// 메모킹 창의 공통 바탕: 테두리 없음 · window.memoking · 화면이 직접 받는 끌어 놓기
pub fn window<'a>(app: &'a AppHandle, label: &str, page: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .decorations(false)
        .initialization_script(init_script())
        // 사진 · 파일 끌어 넣기를 Tauri 가 가로채지 않게 (화면의 drop 이벤트가 받는다)
        .disable_drag_drop_handler()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        // memoking://localhost/… (Windows: http://memoking.localhost/…) — Electron 의 memoking:// 자리
        //   sync/<채널>: 동기 호출 (shim.js sendSync). 채널 이름은 영문 · ':' · '-' 뿐이라 주소에 그대로 싣는다
        .register_uri_scheme_protocol("memoking", |ctx, req| {
            let label = ctx.webview_label().to_string();
            let Some(channel) = req.uri().path().strip_prefix("/sync/").map(str::to_string) else {
                return http::Response::builder().status(404).body(Vec::new()).unwrap();
            };
            let args = serde_json::from_slice(req.body()).unwrap_or_default();
            let body = match ipc::dispatch(ctx.app_handle(), &label, &channel, args) {
                Ok(v) => serde_json::json!({ "v": v }),
                Err(e) => serde_json::json!({ "err": e }),
            };
            http::Response::builder()
                .header("Content-Type", "application/json")
                .header("Access-Control-Allow-Origin", "*")
                .body(body.to_string().into_bytes())
                .unwrap()
        })
        .setup(|app| {
            let app = app.handle();
            window(app, "list", "index.html").title("메모킹").inner_size(440.0, 680.0).min_inner_size(440.0, 380.0).build()?;
            if ipc::smoke() {
                // 0단계 확인용: 메모 창(테두리 없음) + 그 위 가장자리에 걸친 왕관 스티커(투명 · 클릭 통과) — 화면 사진으로 본다
                let note = window(app, "note", "note.html").title("메모").inner_size(320.0, 300.0).min_inner_size(240.0, 200.0).position(520.0, 160.0).build()?;
                let crown = window(app, "sticker", "sticker.html?kind=crown")
                    .parent(&note)?
                    .transparent(true)
                    .shadow(false)
                    .resizable(false)
                    .focusable(false)
                    .skip_taskbar(true)
                    .inner_size(64.0, 52.0)
                    .position(640.0, 134.0)
                    .build()?;
                crown.set_ignore_cursor_events(true)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("메모킹을 켜지 못했어요");
}

