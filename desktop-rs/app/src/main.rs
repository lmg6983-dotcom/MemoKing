// 메모킹 데스크탑 (Rust + Tauri 2) — Electron 의 desktop/ 을 옮기는 중. 화면은 ../../app 그대로.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod files;
mod index;
mod ipc;
mod memos;
mod os;
mod reminders;
mod settings;
mod shortcuts;
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

/// 앱 화면의 주소인가 (Windows: http://tauri.localhost, 그 밖: tauri://localhost)
fn is_app_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

/// memoking 주소를 부른 곳이 앱 화면인가 — 아니면(끌어 놓은 웹 페이지 등) 메모를 읽고 쓰지 못하게
fn is_app_origin(origin: &str) -> bool {
    tauri::Url::parse(origin).is_ok_and(|u| is_app_url(&u))
}

/// 메모킹 창의 공통 바탕: 테두리 없음 · window.memoking · 화면이 직접 받는 끌어 놓기
///   앱 화면 밖으로는 넘어가지 않는다 — 웹 주소는 브라우저로 (Electron guardWindow 와 같게)
pub fn window<'a>(app: &'a AppHandle, label: &str, page: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let opener = app.clone();
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .decorations(false)
        .initialization_script(init_script())
        // 사진 · 파일 끌어 넣기를 Tauri 가 가로채지 않게 (화면의 drop 이벤트가 받는다)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if is_app_url(url) || url.as_str() == "about:blank" {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                use tauri_plugin_opener::OpenerExt;
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
}

fn main() {
    let mut builder = tauri::Builder::default();
    // 두 번 켜면 이미 켜진 메모킹이 그 인자를 받는다 (점검 --smoke 는 켜 둔 메모킹과 상관없이 따로)
    if !ipc::smoke() {
        builder = builder.plugin(tauri_plugin_single_instance::init(os::second_launch));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        // memoking://localhost/… (Windows: http://memoking.localhost/…) — Electron 의 memoking:// 자리
        //   sync/<채널>: 동기 호출 (shim.js sendSync) · vault/<경로>: 메모 폴더의 그림 · 소리 · 영상
        .register_uri_scheme_protocol("memoking", |ctx, req| {
            let path = req.uri().path().to_string();
            let status = |code| http::Response::builder().status(code).body(Vec::new()).unwrap();
            // 앱 화면만 (출처 없는 <img> 는 그림만 보일 뿐 읽지 못한다 — 동기 호출은 늘 출처가 있다)
            let origin = req.headers().get("origin").and_then(|o| o.to_str().ok()).map(str::to_string);
            if origin.as_deref().is_some_and(|o| !is_app_origin(o)) {
                return status(403);
            }
            let allow = origin.clone().unwrap_or_default();
            if let Some(rel) = path.strip_prefix("/vault/") {
                return match memos::serve_vault(ctx.app_handle(), rel) {
                    Some((bytes, mime)) => http::Response::builder().header("Content-Type", mime).header("Access-Control-Allow-Origin", allow).body(bytes).unwrap(),
                    None => status(404),
                };
            }
            // 채널 이름은 영문 · ':' · '-' 뿐이라 주소에 그대로 싣는다
            let (Some(channel), Some(_)) = (path.strip_prefix("/sync/"), &origin) else { return status(404) };
            let label = ctx.webview_label().to_string();
            let args = serde_json::from_slice(req.body()).unwrap_or_default();
            let body = match ipc::dispatch(ctx.app_handle(), &label, channel, args) {
                Ok(v) => serde_json::json!({ "v": v }),
                Err(e) => serde_json::json!({ "err": e }),
            };
            http::Response::builder()
                .header("Content-Type", "application/json")
                .header("Access-Control-Allow-Origin", allow)
                .body(body.to_string().into_bytes())
                .unwrap()
        })
        .setup(|app| {
            let app = app.handle();
            app.manage(state::State::load(app));
            memos::start(app);
            let list = os::place_list(app, window(app, "list", "index.html").title("메모킹").inner_size(440.0, 680.0).min_inner_size(440.0, 380.0)).build()?;
            os::start(app, &list);
            reminders::start(app);
            shortcuts::start(app);
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

#[cfg(test)]
mod tests {
    use super::is_app_origin;

    #[test]
    fn only_app_pages_reach_memos() {
        assert!(is_app_origin("http://tauri.localhost") && is_app_origin("tauri://localhost") && is_app_origin("https://tauri.localhost"));
        for bad in ["null", "https://evil.example", "http://tauri.localhost.evil.example", "http://memoking.localhost", "file://"] {
            assert!(!is_app_origin(bad), "{bad}");
        }
    }
}
