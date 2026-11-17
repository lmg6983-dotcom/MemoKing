// 메모킹 데스크탑 (Rust + Tauri 2) — Electron 의 desktop/ 을 옮기는 중. 화면은 ../../app 그대로.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;
mod memos;
mod state;

use tauri::{http, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        // memoking://localhost/… (Windows: http://memoking.localhost/…) — Electron 의 memoking:// 자리
        //   sync/<채널>: 동기 호출 (shim.js sendSync). 채널 이름은 영문 · ':' · '-' 뿐이라 주소에 그대로 싣는다
        // memoking://localhost/… (Windows: http://memoking.localhost/…) — Electron 의 memoking:// 자리
        //   sync/<채널>: 동기 호출 (shim.js sendSync) · vault/<경로>: 메모 폴더의 그림 · 소리 · 영상
        .register_uri_scheme_protocol("memoking", |ctx, req| {
            let path = req.uri().path().to_string();
            let not_found = || http::Response::builder().status(404).body(Vec::new()).unwrap();
            if let Some(rel) = path.strip_prefix("/vault/") {
                let origin = req.headers().get("origin").and_then(|o| o.to_str().ok());
                return match memos::serve_vault(ctx.app_handle(), rel, origin) {
                    Some((bytes, mime, allow)) => http::Response::builder().header("Content-Type", mime).header("Access-Control-Allow-Origin", allow).body(bytes).unwrap(),
                    None => not_found(),
                };
            }
            // 채널 이름은 영문 · ':' · '-' 뿐이라 주소에 그대로 싣는다
            let Some(channel) = path.strip_prefix("/sync/") else { return not_found() };
            let label = ctx.webview_label().to_string();
            let args = serde_json::from_slice(req.body()).unwrap_or_default();
            let body = match ipc::dispatch(ctx.app_handle(), &label, channel, args) {
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
            app.manage(state::State::load(app));
            memos::start(app);
            window(app, "list", "index.html").title("메모킹").inner_size(440.0, 680.0).min_inner_size(440.0, 380.0).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("메모킹을 켜지 못했어요");
}


/// 주소의 %XX 풀기 (메모 폴더 파일 이름은 한글이라 UTF-8 로 적혀 온다)
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%').then(|| s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())).flatten();
        match hex {
            Some(v) => {
                out.push(v);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
