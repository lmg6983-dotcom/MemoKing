// 메모킹 데스크탑 (Rust + Tauri 2) — Electron 의 desktop/ 을 옮기는 중. 화면은 ../../app 그대로.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 오류 한 줄: 콘솔에 더해 오류 기록 파일에도 (설정 › 문제 보내기로 꺼내 본다) — 예전에는 콘솔에만 나가 사용자 PC 에서는 사라졌다
macro_rules! elog {
    ($($t:tt)*) => {{
        let line = format!($($t)*);
        eprintln!("{line}");
        crate::files::log("오류", &line);
    }};
}

mod ai;
mod capture;
mod clipboard;
mod files;
mod drive;
mod history;
mod index;
mod ipc;
mod memos;
mod os;
mod reminders;
mod services;
mod settings;
mod shortcuts;
mod state;
mod stt;
mod video;
mod windows;

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
    url.port().is_none() && (url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
}

/// memoking 주소를 부른 곳이 앱 화면인가 — 아니면(끌어 놓은 웹 페이지 등) 메모를 읽고 쓰지 못하게
fn is_app_origin(origin: &str) -> bool {
    tauri::Url::parse(origin).is_ok_and(|u| is_app_url(&u))
}

/// 메모킹 창의 공통 바탕: 테두리 없음 · window.memoking · 화면이 직접 받는 끌어 놓기
///   앱 화면 밖으로는 넘어가지 않는다 — 웹 주소는 브라우저로 (Electron guardWindow 와 같게)
pub fn window<'a>(app: &'a AppHandle, label: &str, page: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let opener = app.clone();
    no_window_drop(shared_env(app, WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into())))
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
        }))
}

type Builder<'a> = WebviewWindowBuilder<'a, tauri::Wry, AppHandle>;

/// 모든 창이 WebView2 환경 하나를 함께 쓴다 — wry 는 창마다 환경을 새로 만든다 (만들 때마다 기다림 · 창이 늘수록 프로세스도).
///   첫 창은 환경을 만들며 렌더러 프로세스 수를 묶는다: 숨겨 둔 탭 · 예비 창 · 스티커 창이 저마다 프로세스를 띄워
///   작업 관리자에 WebView2 가 여럿 흩어져 보였다. 같은 메모킹 화면끼리는 넘치면 한 프로세스를 나눠 쓴다
#[cfg(windows)]
mod webview_env {
    use std::sync::Mutex;
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment;
    struct Env(ICoreWebView2Environment);
    // 환경은 wry 가 UI 스레드에서만 쓴다 — 여기서는 담아 두고 넘겨 줄 뿐 (AddRef · Release 만)
    unsafe impl Send for Env {}
    static ENV: Mutex<Option<Env>> = Mutex::new(None);
    pub fn get() -> Option<ICoreWebView2Environment> {
        ENV.lock().unwrap().as_ref().map(|e| e.0.clone())
    }
    /// 이미 있는 창에서 환경을 배운다 (UI 스레드에서 나중에 — 기다리지 않는다. 그 전에 만드는 창은 같은 설정의 새 환경)
    pub fn learn(app: &AppHandle) {
        if ENV.lock().unwrap().is_some() {
            return;
        }
        if let Some(w) = app.webview_windows().into_values().next() {
            let _ = w.with_webview(|wv| {
                let env = wv.environment();
                ENV.lock().unwrap().get_or_insert(Env(env));
            });
        }
    }
}
/// wry 의 기본 인자(미니 메뉴 · 스마트스크린 끄기)에 렌더러 프로세스 수 묶기를 더한다 — 인자를 주면 기본 인자를 대신하므로 그대로 옮겨 적는다
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --renderer-process-limit=4";
#[cfg(windows)]
fn shared_env<'a>(app: &AppHandle, b: Builder<'a>) -> Builder<'a> {
    match webview_env::get() {
        Some(env) => b.with_environment(env),
        None => {
            webview_env::learn(app);
            b.additional_browser_args(BROWSER_ARGS)
        }
    }
}
#[cfg(not(windows))]
fn shared_env<'a>(_app: &AppHandle, b: Builder<'a>) -> Builder<'a> {
    b
}

/// 바깥 창(tao)의 끌어 놓기 받개도 끈다. 켜 두면 WebView2 가 받기 전의 첫 끌기를 그쪽이 "복사" 로 받아 버리고, Tauri 는 그 소식을 아무 데도 보내지 않는다
///   (그래서 파일을 처음 놓을 때는 아무 일이 없고 두 번째부터 들어갔다). OLE 초기화는 main 이 먼저 한다
#[cfg(windows)]
fn no_window_drop(b: Builder) -> Builder {
    b.drag_and_drop(false)
}
#[cfg(not(windows))]
fn no_window_drop(b: Builder) -> Builder {
    b
}

fn main() {
    // 바깥 창의 끌어 놓기를 끄면 tao 가 OLE 를 초기화하지 않는다. WebView2 의 끌어 놓기 · 첨부 끌어내기(DoDragDrop)에 필요해 여기서 한 번
    #[cfg(windows)]
    unsafe {
        let _ = ::windows::Win32::System::Ole::OleInitialize(None);
    }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 로그인 때는 창 없이 알림 영역에서 (Electron LOGIN_ARGS)
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        // memoking://localhost/… (Windows: http://memoking.localhost/…) — Electron 의 memoking:// 자리
        //   sync/<채널>: 동기 호출 (shim.js sendSync) · vault/<경로>: 메모 폴더의 그림 · 소리 · 영상 · poster/<경로>: 동영상 첫 장면 · history/<이름>: 알림 보관함 그림
        .register_asynchronous_uri_scheme_protocol("memoking", |ctx, req, responder| {
            // 파일 읽기 · 동기 호출은 화면 스레드 밖에서 — 큰 영상을 읽거나 창을 만드는 호출이 화면을 멈추지 않게
            let (app, label) = (ctx.app_handle().clone(), ctx.webview_label().to_string());
            std::thread::spawn(move || {
                let res = memoking_uri(&app, &label, &req);
                // 점검 때는 오간 것을 남긴다 (WebView2 가 동영상을 어떻게 청하는지 CI 로그에서 보려고)
                if ipc::smoke() && !req.uri().path().starts_with("/sync/") {
                    let h = |m: &http::HeaderMap, k: &str| m.get(k).and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
                    println!("[memoking] {} {} range={} origin={} -> {} type={} len={} content-range={}", req.method(), req.uri().path(), h(req.headers(), "range"), h(req.headers(), "origin"), res.status().as_u16(), h(res.headers(), "content-type"), res.body().len(), h(res.headers(), "content-range"));
                }
                responder.respond(res)
            });
        })
        .setup(|app| {
            let app = app.handle();
            app.manage(state::State::load(app));
            files::init_log(app);
            // 멈추면(패닉) 어디서 왜 멈췄는지 기록에 남긴다 (기본 처리는 그대로)
            let default = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                files::log("멈춤", &info.to_string());
                default(info);
            }));
            memos::start(app);
            drive::start(app);
            history::start(app);
            services::start(app);
            std::thread::spawn({
                let app = app.clone();
                move || prune_thumbs(&app)
            });
            let list = os::place_list(app, window(app, "list", "index.html").title("메모킹").inner_size(440.0, 680.0).min_inner_size(440.0, 380.0)).build()?;
            os::paint_bg(&list);
            windows::sync_resize(&list);
            os::start(app, &list);
            reminders::start(app);
            shortcuts::start(app);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("메모킹을 켜지 못했어요")
        .run(|_, e| {
            // AI 엔진 · 팝업 알림 도우미는 따로 도는 프로세스라 메모킹을 꺼도 남는다
            if let tauri::RunEvent::Exit = e {
                ai::stop();
                capture::stop();
                history::stop_helpers();
                windows::stop();
            }
        });
}

/// memoking 주소 하나에 답한다 (main 의 register 설명)
fn memoking_uri(app: &AppHandle, label: &str, req: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let path = req.uri().path().to_string();
    let status = |code| http::Response::builder().status(code).body(Vec::new()).unwrap();
    // 앱 화면만 (출처 없는 <img> 는 그림만 보일 뿐 읽지 못한다 — 동기 호출은 늘 출처가 있다)
    let origin = req.headers().get("origin").and_then(|o| o.to_str().ok()).map(str::to_string);
    if origin.as_deref().is_some_and(|o| !is_app_origin(o)) {
        return status(403);
    }
    let allow = origin.clone().unwrap_or_default();
    // poster/<경로>: 동영상 첫 장면 JPG · 못 뽑으면 204 (화면이 스스로 그린다 — video-poster.js nativeFrame)
    if let Some(rel) = path.strip_prefix("/poster/") {
        let shot = memos::serve_vault(app, rel).filter(|(_, mime)| mime.starts_with("video/")).and_then(|(file, _)| video::poster(app, &file));
        return match shot {
            Some(jpg) => file_response(&jpg, "image/jpeg", None, allow).unwrap_or_else(|| status(404)),
            None => http::Response::builder().status(204).header("Access-Control-Allow-Origin", allow).body(Vec::new()).unwrap(),
        };
    }
    let served = match (path.strip_prefix("/vault/"), path.strip_prefix("/history/")) {
        (Some(rel), _) => Some(memos::serve_vault(app, rel)),
        (_, Some(name)) => Some(history::serve_image(app, name)),
        _ => None,
    };
    if let Some(served) = served {
        let range = req.headers().get("range").and_then(|r| r.to_str().ok());
        let Some((file, mime)) = served else { return status(404) };
        // HEVC 사본을 만드는 중이면 영상이 바로 실패하게 (다 되면 media:ready 로 다시 부른다, video.rs)
        let file = match path.strip_prefix("/vault/") {
            Some(rel) if mime.starts_with("video/") => video::playable(app, &percent_decode(rel), file),
            _ => Some(file),
        };
        let Some(file) = file else { return status(503) };
        // ?thumb=폭: 목록 카드 썸네일 — 줄인 그림 (못 만들면 원본)
        let thumb = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("thumb="))).and_then(|w| w.parse::<u32>().ok());
        let (file, mime) = match thumb.filter(|_| path.starts_with("/vault/")).and_then(|w| thumb_file(app, &file, mime, w)) {
            Some((t, m)) => (t, m),
            None => (file, mime),
        };
        return file_response(&file, mime, range, allow).unwrap_or_else(|| status(404));
    }
    // 채널 이름은 영문 · ':' · '-' 뿐이라 주소에 그대로 싣는다
    let (Some(channel), Some(_)) = (path.strip_prefix("/sync/"), &origin) else { return status(404) };
    let args = serde_json::from_slice(req.body()).unwrap_or_default();
    let body = match ipc::dispatch(app, label, channel, args) {
        Ok(v) => serde_json::json!({ "v": v }),
        Err(e) => serde_json::json!({ "err": e }),
    };
    http::Response::builder()
        .header("Content-Type", "application/json")
        .header("Access-Control-Allow-Origin", allow)
        .body(body.to_string().into_bytes())
        .unwrap()
}

/// 목록 카드 썸네일: 긴 변 w 이하로 줄인 그림 → (캐시 파일, 형식). 줄일 것이 없거나 못 읽으면 None (원본 그대로)
///   카드마다 원본 사진(휴대폰 사진 1,200만 화소 → 풀면 48MB)을 통째로 풀어 목록 창 메모리가 수백 MB 로 불었다.
///   캐시 폴더에 남겨 다음부터는 읽기만 (원본이 바뀌면 크기 · 시각이 달라 새로)
// shortcut: 지난 썸네일은 지우지 않는다 (한 장 수십 KB) — 캐시가 커졌다는 말이 나오면 오래된 것부터 지우기
fn thumb_file(app: &AppHandle, file: &std::path::Path, mime: &str, w: u32) -> Option<(std::path::PathBuf, &'static str)> {
    use image::ImageDecoder;
    use std::hash::{Hash, Hasher};
    // 움직이는 그림(gif) · 벡터(svg)는 그대로
    if !matches!(mime, "image/jpeg" | "image/png" | "image/webp" | "image/bmp") || !(64..=2048).contains(&w) {
        return None;
    }
    let meta = std::fs::metadata(file).ok()?;
    if meta.len() < 150 * 1024 {
        return None; // 작은 그림은 원본이 더 싸다
    }
    // 원본이 이미 w 이하면 원본 그대로 — 머리만 읽어 크기를 본다 (예전: 끝까지 풀어 본 뒤에야 알아 열 때마다 사진을 통째로 풀었다)
    if image::image_dimensions(file).is_ok_and(|(iw, ih)| iw.max(ih) <= w) {
        return None;
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (file, meta.len(), meta.modified().ok(), w).hash(&mut h);
    let dir = app.path().app_cache_dir().ok()?.join("thumbs");
    let key = format!("{:016x}", h.finish());
    for (ext, m) in [("jpg", "image/jpeg"), ("png", "image/png")] {
        let p = dir.join(format!("{key}.{ext}"));
        if p.exists() {
            return Some((p, m));
        }
    }
    // 큰 사진을 한꺼번에 여럿 풀면 그 순간 메모리가 튄다 — 하나씩
    static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = ONE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut dec = image::ImageReader::open(file).ok()?.with_guessed_format().ok()?.into_decoder().ok()?;
    let turn = dec.orientation().unwrap_or(image::metadata::Orientation::NoTransforms); // 휴대폰 사진의 돌림 (원본 <img> 처럼)
    let mut img = image::DynamicImage::from_decoder(dec).ok()?;
    if img.width().max(img.height()) <= w {
        return None;
    }
    img.apply_orientation(turn);
    let small = img.thumbnail(w, w);
    drop(img);
    std::fs::create_dir_all(&dir).ok()?;
    let (ext, m, fmt) = if small.color().has_alpha() { ("png", "image/png", image::ImageFormat::Png) } else { ("jpg", "image/jpeg", image::ImageFormat::Jpeg) };
    let out = dir.join(format!("{key}.{ext}"));
    let tmp = dir.join(format!("{key}.tmp"));
    let small = if fmt == image::ImageFormat::Jpeg { image::DynamicImage::ImageRgb8(small.to_rgb8()) } else { small };
    small.save_with_format(&tmp, fmt).ok()?;
    std::fs::rename(&tmp, &out).ok()?;
    Some((out, m))
}

/// 60일 넘게 다시 만들지 않은 썸네일은 지운다 (켤 때 한 번, 일꾼 스레드에서) — 원본이 바뀌거나 지워진 사진의 썸네일이 쌓이지 않게.
///   아직 쓰는 것도 지워질 수 있지만 다음에 볼 때 다시 만든다
fn prune_thumbs(app: &AppHandle) {
    let Ok(dir) = app.path().app_cache_dir().map(|d| d.join("thumbs")) else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let old = std::time::Duration::from_secs(60 * 24 * 3600);
    for e in entries.flatten() {
        if e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > old) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 파일 하나 — Range 가 있으면 그 조각만 206 (영상 · 소리를 끝까지 다 읽지 않고 넘겨 보게)
fn file_response(file: &std::path::Path, mime: &str, range: Option<&str>, allow: String) -> Option<http::Response<Vec<u8>>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file).ok()?;
    let len = f.metadata().ok()?.len();
    let res = http::Response::builder().header("Content-Type", mime).header("Access-Control-Allow-Origin", allow).header("Accept-Ranges", "bytes");
    let mut bytes = Vec::new();
    let Some((a, b)) = range.and_then(|r| byte_range(r, len)) else {
        f.read_to_end(&mut bytes).ok()?;
        return res.body(bytes).ok();
    };
    f.seek(SeekFrom::Start(a)).ok()?;
    f.take(b - a + 1).read_to_end(&mut bytes).ok()?;
    res.status(206).header("Content-Range", format!("bytes {a}-{b}/{len}")).body(bytes).ok()
}

/// Range: bytes=a-b · bytes=a- → (a, b) 끝 포함. 못 읽거나 파일 밖이면 None (통째로 200)
// shortcut: bytes=-n (끝에서 n) · 여러 조각은 통째로 — 그런 것을 청하는 화면이 생기면 더한다
fn byte_range(h: &str, len: u64) -> Option<(u64, u64)> {
    // 끝을 안 정한 청은 8MB 씩 — 영상은 보는 쪽이 이어서 다시 청한다
    const CHUNK: u64 = 8 << 20;
    let (a, b) = h.trim().strip_prefix("bytes=")?.split_once('-')?;
    let a: u64 = a.trim().parse().ok()?;
    let b = match b.trim() {
        "" => a.saturating_add(CHUNK - 1),
        b => b.parse().ok()?,
    };
    (a <= b && a < len).then(|| (a, b.min(len - 1)))
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
    use super::{byte_range, is_app_origin};

    #[test]
    fn only_app_pages_reach_memos() {
        assert!(is_app_origin("http://tauri.localhost") && is_app_origin("tauri://localhost"));
        for bad in ["null", "https://tauri.localhost", "http://tauri.localhost:8080", "tauri://localhost:1", "https://evil.example", "http://tauri.localhost.evil.example", "http://memoking.localhost", "file://"] {
            assert!(!is_app_origin(bad), "{bad}");
        }
    }

    #[test]
    fn byte_ranges() {
        assert_eq!(byte_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(byte_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(byte_range("bytes=0-", 100 << 20), Some((0, (8 << 20) - 1)));
        assert_eq!(byte_range("bytes=500-5000", 1000), Some((500, 999)));
        for bad in ["bytes=1000-", "bytes=5-2", "bytes=-100", "bytes=0-1,5-6", "items=0-1", ""] {
            assert_eq!(byte_range(bad, 1000), None, "{bad}");
        }
        assert_eq!(byte_range("bytes=0-", 0), None);
    }
}
