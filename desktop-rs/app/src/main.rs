// 메모킹 데스크탑 (Rust + Tauri 2) — Electron 의 desktop/ 을 옮기는 중. 화면은 ../../app 그대로.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;

use tauri::{http, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

// desktop/preload.cjs 를 그대로 끼워 넣는다 (shim.js 가 require('electron') 을 Tauri 로 바꿔 줌)
fn init_script() -> String {
    let mut s = include_str!("../shim.js").replace("/*PRELOAD*/", include_str!("../../../desktop/preload.cjs"));
    if ipc::smoke() {
        s.push_str(include_str!("../smoke.js"));
    }
    s
}

pub fn open_window(app: &AppHandle, label: &str, page: &str, title: &str, size: (f64, f64)) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(label) {
        return w.set_focus();
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .decorations(false)
        .initialization_script(&init_script())
        // 화면이 직접 받는 HTML 끌어 놓기(사진 · 파일 넣기)를 Tauri 가 가로채지 않게
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        .register_uri_scheme_protocol("memoking-sync", |ctx, req| {
            let label = ctx.webview_label().to_string();
            // 채널 이름은 영문 · ':' · '-' 뿐이라 주소에 그대로 싣는다 (shim.js sendSync)
            let channel = req.uri().path().trim_start_matches('/').to_string();
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
            open_window(app.handle(), "list", "index.html", "메모킹", (440.0, 680.0))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("메모킹을 켜지 못했어요");
}

