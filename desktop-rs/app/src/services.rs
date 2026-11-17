// 곁가지 기능 — 화면 캡처 메모 · AI 비서 연결(MCP) · PDF · 자동 업데이트.
//   Electron 의 window-manager.js(startAreaCapture · finishAreaCapture · openCaptureMemo · openPdfWindow) · utils.js(mcpStatus · mcpConnect) · office-pdf.js · updater.js 자리.
use crate::state::State;
use memoking_core::vault::write_atomic;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

fn st(app: &AppHandle) -> tauri::State<'_, State> {
    app.state::<State>()
}

// ---------- 영역 캡처 (Ctrl+Alt+C 두 번 · 트레이) ----------

/// 모니터 창 하나: 찍어 둔 화면(실제 픽셀)과 창의 크기(화면 좌표 = CSS px)
struct Shot {
    label: String,
    image: image::RgbaImage,
    width: f64,
    height: f64,
}

static AREA: Mutex<Option<Vec<Shot>>> = Mutex::new(None);
/// 메모 창이 열리며 넣을 캡처 (memo:get 의 capture)
static CAPTURES: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

pub fn take_capture(id: &str) -> Value {
    CAPTURES.lock().unwrap().get_or_insert_with(HashMap::new).remove(id).unwrap_or(Value::Null)
}

// 모니터마다의 화면 사진 (실제 픽셀, 왼쪽 위 자리로 Tauri 모니터와 맞춘다)
#[cfg(windows)]
fn screens() -> Vec<((i32, i32), image::RgbaImage)> {
    xcap::Monitor::all().unwrap_or_default().iter().filter_map(|m| Some(((m.x().ok()?, m.y().ok()?), m.capture_image().ok()?))).collect()
}

// shortcut: 화면 찍기는 Windows 만 (xcap 은 Linux 에서 pipewire 가 있어야 빌드된다) — 다른 OS 를 내놓을 때 그 OS 의 찍기를 더한다
#[cfg(not(windows))]
fn screens() -> Vec<((i32, i32), image::RgbaImage)> {
    Vec::new()
}

/// 모니터마다 찍은 화면을 띄우고 사각형을 고르게 한다 (capture.html) — 창 만들기라 이벤트 처리 밖의 스레드에서 부른다
pub fn start_area_capture(app: &AppHandle) -> bool {
    if st(app).vault.lock().unwrap().is_none() {
        return false;
    }
    {
        let mut area = AREA.lock().unwrap();
        if area.is_some() {
            return false;
        }
        *area = Some(Vec::new());
    }
    let mut shots = screens();
    for (i, m) in app.available_monitors().unwrap_or_default().into_iter().enumerate() {
        let (pos, size, scale) = (*m.position(), *m.size(), m.scale_factor());
        let Some(k) = shots.iter().position(|s| s.0 == (pos.x, pos.y)) else { continue };
        let image = shots.swap_remove(k).1;
        let mut jpeg = Vec::new();
        if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 92).encode_image(&image::DynamicImage::ImageRgba8(image.clone()).to_rgb8()).is_err() {
            continue;
        }
        use base64::Engine;
        let src = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg));
        let label = format!("capture-{i}");
        let win = crate::window(app, &label, "capture.html")
            .visible(false)
            .resizable(false)
            .shadow(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .on_page_load(move |w, p| {
                if p.event() == tauri::webview::PageLoadEvent::Finished && AREA.lock().unwrap().is_some() {
                    let _ = w.emit_to(w.label(), "capture:image", [json!({ "src": src })]);
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            })
            .build();
        let Ok(win) = win else { continue };
        let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = win.set_size(PhysicalSize::new(size.width, size.height));
        let shot = Shot { label, image, width: f64::from(size.width) / scale, height: f64::from(size.height) / scale };
        AREA.lock().unwrap().get_or_insert_with(Vec::new).push(shot);
    }
    let mut area = AREA.lock().unwrap();
    if area.as_ref().is_none_or(Vec::is_empty) {
        *area = None;
        eprintln!("[화면 캡처] 화면을 캡처하지 못했어요");
        return false;
    }
    true
}

fn end_area_capture(app: &AppHandle) -> Vec<Shot> {
    let shots = AREA.lock().unwrap().take().unwrap_or_default();
    for s in &shots {
        if let Some(w) = app.get_webview_window(&s.label) {
            let _ = w.destroy();
        }
    }
    shots
}

// 고른 사각형(그 모니터 창의 CSS px)을 원래 해상도로 잘라 새 메모로 → 메모 id | null
fn finish_area_capture(app: &AppHandle, label: &str, rect: &Value) -> Result<Value, String> {
    let shot = end_area_capture(app).into_iter().find(|s| s.label == label);
    let r: Option<Vec<f64>> = ["x", "y", "width", "height"].iter().map(|k| rect[*k].as_f64().filter(|v| v.is_finite())).collect();
    let (Some(shot), Some(r)) = (shot, r) else { return Ok(Value::Null) };
    let (iw, ih) = (i64::from(shot.image.width()), i64::from(shot.image.height()));
    let (rx, ry) = (iw as f64 / shot.width, ih as f64 / shot.height);
    let (x, y) = ((r[0] * rx).round().max(0.0) as i64, (r[1] * ry).round().max(0.0) as i64);
    let (w, h) = (((r[2] * rx).round() as i64).min(iw - x), ((r[3] * ry).round() as i64).min(ih - y));
    if w < 2 || h < 2 {
        return Ok(Value::Null);
    }
    let crop = image::imageops::crop_imm(&shot.image, x as u32, y as u32, w as u32, h as u32).to_image();
    let mut png = std::io::Cursor::new(Vec::new());
    crop.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let _ = app.clipboard().write_image(&tauri::image::Image::new(crop.as_raw(), crop.width(), crop.height()));
    let (id, src) = {
        let state = st(app);
        let mut guard = state.vault.lock().unwrap();
        let Some(v) = guard.as_mut() else { return Ok(Value::Null) };
        let src = v.save_attachment(png.get_ref(), "png").map_err(|e| e.to_string())?;
        (v.create(None, None, ""), src)
    };
    let now = chrono::Local::now();
    let capture = json!({
        "heading": "화면 캡처",
        "html": null,
        "text": null,
        "items": [{ "kind": "image", "src": src, "alt": "화면 캡처" }],
        "skipped": [],
        "source": { "window": "화면 캡처", "process": "", "url": null, "time": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "copied": false },
        "sourceMd": format!("> 출처: 화면 캡처, {}", now.format("%Y.%-m.%-d %H:%M")),
    });
    CAPTURES.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), capture);
    // shortcut: Electron 은 숨긴 메모 창 + 알림(누르면 보임)이었다 — 알림을 옮기기 전까지 메모 창을 바로 띄운다
    crate::memos::open_note(app, &id)?;
    Ok(id.into())
}

// ---------- AI 비서 연결 (MCP) ----------

const MCP_NAME: &str = "memoking";

fn claude_config_file(app: &AppHandle) -> PathBuf {
    match std::env::var_os("MEMOKING_CLAUDE_CONFIG") {
        Some(f) => f.into(),
        None => app.path().config_dir().unwrap_or_default().join("Claude").join("claude_desktop_config.json"),
    }
}

// AI 비서가 띄울 것: 메모킹 옆의 memoking-mcp (desktop-rs/mcp)
// shortcut: 설치 파일에 memoking-mcp 를 넣는 일(tauri.conf.json externalBin)은 릴리스를 Tauri 로 바꿀 때 — 그때까지는 빌드 폴더의 것을 가리킨다
fn mcp_entry(app: &AppHandle) -> Value {
    let exe = std::env::current_exe().unwrap_or_default().with_file_name(format!("memoking-mcp{}", std::env::consts::EXE_SUFFIX));
    let settings = st(app).settings_dir.join("settings.json");
    json!({ "command": exe, "args": ["--settings", settings, "--version", app.package_info().version.to_string()] })
}

/// Claude 데스크톱 설정 (없거나 비었으면 {}, 객체가 아니면 Err — 건드리지 않는다)
fn read_claude_config(app: &AppHandle) -> Result<Map<String, Value>, ()> {
    let Ok(text) = std::fs::read_to_string(claude_config_file(app)) else { return Ok(Map::new()) };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str(&text) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(()),
    }
}

pub fn mcp_status(app: &AppHandle) -> Value {
    let config = read_claude_config(app);
    let entry = config.as_ref().ok().and_then(|c| c.get("mcpServers")?.get(MCP_NAME).cloned()).filter(|e| !e.is_null());
    json!({
        "claudeFound": claude_config_file(app).parent().is_some_and(Path::exists),
        "connected": entry.is_some(),
        "stale": entry.is_some_and(|e| e["command"] != mcp_entry(app)["command"]),
        "broken": config.is_err(),
        "write": st(app).setting("mcp")["write"] != false,
    })
}

fn mcp_connect(app: &AppHandle, on: bool) -> Value {
    let file = claude_config_file(app);
    let Ok(mut config) = read_claude_config(app) else {
        return with_error(mcp_status(app), "Claude 데스크톱 설정 파일을 읽지 못해서 건드리지 않았어요. \"설정 복사\" 로 직접 넣어 주세요".into());
    };
    let mut servers = config.get("mcpServers").and_then(Value::as_object).cloned().unwrap_or_default();
    if on {
        servers.insert(MCP_NAME.into(), mcp_entry(app));
    } else {
        servers.remove(MCP_NAME);
    }
    config.insert("mcpServers".into(), servers.into());
    let backup = PathBuf::from(format!("{}.memoking-backup", file.display()));
    let r = (|| {
        std::fs::create_dir_all(file.parent().unwrap_or(Path::new(".")))?;
        if file.exists() && !backup.exists() {
            std::fs::copy(&file, &backup)?;
        }
        // 임시 파일에 쓰고 바꿔치기 — 쓰는 도중 꺼져도 Claude 설정 파일이 깨지지 않게
        write_atomic(&file, format!("{}\n", serde_json::to_string_pretty(&config).unwrap()).as_bytes())
    })();
    match r {
        Ok(()) => mcp_status(app),
        Err(err) => with_error(mcp_status(app), format!("설정 파일에 쓰지 못했어요 ({err})")),
    }
}

fn with_error(mut status: Value, error: String) -> Value {
    status["error"] = error.into();
    status
}

/// 켤 때: 업데이트 확인을 걸고, 메모킹을 옮겨 설치했으면(연결된 실행 파일 자리가 다르면) 다시 연결
pub fn start(app: &AppHandle) {
    start_updates(app);
    let mcp = mcp_status(app);
    if !cfg!(debug_assertions) && mcp["stale"] == true && mcp["broken"] == false {
        mcp_connect(app, true);
    }
}

// ---------- PDF ----------

// PDF로 저장 창 (pdf.html 이 미리 보기와 고르기를 맡는다)
fn open_pdf_window(app: &AppHandle, id: &str) -> Result<Value, String> {
    if st(app).vault.lock().unwrap().as_ref().and_then(|v| v.get(id)).is_none() {
        return Ok(false.into());
    }
    if let Some(w) = app.get_webview_window("pdf") {
        let _ = w.destroy();
    }
    let page = format!("pdf.html?id={}", id.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>());
    crate::window(app, "pdf", &page).title("PDF로 저장").inner_size(820.0, 600.0).min_inner_size(640.0, 480.0).center().build().map_err(|e| e.to_string())?;
    Ok(true.into())
}

// Word · PowerPoint 문서 → PDF (이 PC 의 Office 로). 경로는 환경 변수로 넘긴다 (명령 줄에 끼우면 따옴표 · 특수 문자가 섞인다)
//   사용자가 이미 띄워 둔 PowerPoint 에 붙는 경우(PowerPoint 는 한 개만 뜬다) 사용자의 창은 닫지 않는다
const OFFICE_PDF: &str = r#"
$ErrorActionPreference = 'Stop'
$src = $env:MK_SRC; $out = $env:MK_OUT
if ($src -match '\.pptx$') {
  $running = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
  $app = New-Object -ComObject PowerPoint.Application
  try {
    $doc = $app.Presentations.Open($src, -1, 0, 0)
    try { $doc.SaveAs($out, 32) } finally { $doc.Close() }
  } finally { if (-not $running -and $app.Presentations.Count -eq 0) { $app.Quit() } }
} else {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false; $app.DisplayAlerts = 0
  try {
    $doc = $app.Documents.Open($src, $false, $true, $false, 'mk-no-password')
    try { $doc.ExportAsFixedFormat($out, 17) } finally { $doc.Close(0) }
  } finally { if ($app.Documents.Count -eq 0) { $app.Quit() } }
}
"#;

/// 메모 폴더의 Word · PowerPoint 첨부 → PDF 내용 | null (Windows 아님 · Office 없음 · 실패 → 화면이 직접 그린다)
fn office_to_pdf(app: &AppHandle, rel: &str) -> Value {
    let rel = memoking_core::js::decode_uri(rel).unwrap_or_else(|| rel.to_string());
    let file = st(app).vault.lock().unwrap().as_ref().filter(|_| rel.starts_with("attachments/")).and_then(|v| v.resolve(&rel)).filter(|f| f.is_file());
    let Some(src) = file.filter(|f| cfg!(windows) && !crate::ipc::smoke() && f.extension().is_some_and(|e| e.eq_ignore_ascii_case("docx") || e.eq_ignore_ascii_case("pptx"))) else { return Value::Null };
    let out = std::env::temp_dir().join(format!("memoking-pdf-{}-{}.pdf", chrono::Utc::now().timestamp_millis(), std::process::id()));
    let child = crate::history::powershell(false).args(["-Command", OFFICE_PDF]).env("MK_SRC", &src).env("MK_OUT", &out).stdout(std::process::Stdio::null()).spawn();
    // shortcut: 암호 걸린 PowerPoint 처럼 Office 가 물어보며 멈추면 90초 뒤 포기 (Office 프로그램은 남을 수 있음)
    let ok = child.is_ok_and(|mut c| {
        for _ in 0..900 {
            if let Ok(Some(status)) = c.try_wait() {
                return status.success();
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = c.kill();
        false
    });
    let pdf = std::fs::read(&out).ok().filter(|_| ok);
    let _ = std::fs::remove_file(&out);
    use base64::Engine;
    pdf.map_or(Value::Null, |b| json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(b) }))
}

// ---------- 자동 업데이트 ----------
// 켤 때(8초 뒤) · 4시간마다 · 설정의 "업데이트 확인" → 새 버전이 있으면 목록 창에 알림(버전 · 바뀐 점) → 받기를 고르면 진행률 → 다 받으면 설치하고 다시 켠다.
//   "나중에" 를 고른 그 버전은 24시간 동안 다시 묻지 않는다. 개발 중에는 확인하지 않는다. 오류는 알리기만 하고 지금 버전은 그대로.
// shortcut: 절전에서 깨어날 때 다시 보기(checkIfStale) · 목록 창이 없을 때 Windows 알림은 아직 — 전원 · 알림을 옮길 때

const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(4 * 60 * 60);
const REMIND_MS: f64 = (4.0 * 60.0 - 10.0) * 60_000.0; // 같은 버전을 저절로 다시 알리는 간격

#[derive(Default)]
struct Updates {
    state: Map<String, Value>,
    update: Option<tauri_plugin_updater::Update>,
    bytes: Option<Vec<u8>>,
    announced: Option<(String, f64)>,
}

static UPDATES: Mutex<Option<Updates>> = Mutex::new(None);

fn updates<T>(f: impl FnOnce(&mut Updates) -> T) -> T {
    f(UPDATES.lock().unwrap().get_or_insert_with(|| Updates { state: json!({ "status": "idle" }).as_object().unwrap().clone(), ..Default::default() }))
}

fn update_enabled() -> bool {
    !cfg!(debug_assertions) && !crate::ipc::smoke() // 개발 중에는 업데이트 정보가 없어 확인할 수 없다
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// 목록 창이 물어볼 때: 지금 상태 + 대화 상자를 띄울지 (숨겨 둔 버전이면 띄우지 않음)
fn update_state(app: &AppHandle) -> Value {
    let mut s = updates(|u| u.state.clone());
    let offering = s["status"] == "ready" || s["status"] == "available";
    let ask = offering && !memoking_core::update::is_snoozed(&st(app).setting("updateSnooze"), s.get("version").unwrap_or(&Value::Null), now_ms());
    s.insert("ask".into(), ask.into());
    s.insert("current".into(), app.package_info().version.to_string().into());
    s.insert("enabled".into(), update_enabled().into());
    s.into()
}

// 상태가 바뀌면 버전 · 바뀐 점만 이어 가고 (진행률 · 오류 글은 버림), 같은 상태면 덧붙인다
fn set_update(app: &AppHandle, patch: Value) {
    let state = updates(|u| {
        let changed = patch["status"].is_string() && patch["status"] != u.state["status"];
        if changed {
            u.state = ["version", "notes"].iter().filter_map(|k| Some((k.to_string(), u.state.get(*k)?.clone()))).collect();
        }
        u.state.extend(patch.as_object().cloned().unwrap_or_default());
        u.state.clone()
    });
    send_update(app, "update:state", state);
}

fn send_update(app: &AppHandle, event: &str, mut state: Map<String, Value>) {
    state.insert("current".into(), app.package_info().version.to_string().into());
    let _ = app.emit_to("list", event, [Value::Object(state)]);
}

/// 새 버전 · 받기 끝 — 목록 창을 (입력은 뺏지 않고) 보이게 해서 알린다
fn announce(app: &AppHandle, event: &str) {
    if let Some(w) = app.get_webview_window("list") {
        if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
            let _ = w.show();
        }
    }
    send_update(app, event, updates(|u| u.state.clone()));
}

// 비동기 일을 이 스레드에서 끝까지 (ipc 는 비동기 실행기 안이라 바로 block_on 하면 멈춘다)
fn wait<T: Send + 'static>(f: impl std::future::Future<Output = T> + Send + 'static) -> T {
    std::thread::spawn(move || tauri::async_runtime::block_on(f)).join().unwrap()
}

/// manual: 설정의 "업데이트 확인" (숨겨 둔 버전도 다시 보여 준다)
fn check_update(app: &AppHandle, manual: bool) {
    if ["downloading", "ready"].contains(&updates(|u| u.state["status"].as_str().unwrap_or_default().to_string()).as_str()) {
        return; // 이미 받는 중 · 받아 둠
    }
    set_update(app, json!({ "status": "checking" }));
    use tauri_plugin_updater::UpdaterExt;
    let app2 = app.clone();
    match wait(async move { app2.updater()?.check().await }) {
        Err(err) => {
            eprintln!("[update] {err}");
            set_update(app, json!({ "status": "error", "message": memoking_core::update::update_error_text(&err.to_string()) }));
        }
        Ok(None) => set_update(app, json!({ "status": "latest" })),
        Ok(Some(up)) => {
            let version = up.version.clone();
            let date = up.date.and_then(|d| chrono::DateTime::from_timestamp(d.unix_timestamp(), 0)).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default();
            set_update(app, json!({ "status": "available", "version": version, "notes": memoking_core::update::notes_text(up.body.as_deref().unwrap_or_default()), "date": date }));
            updates(|u| u.update = Some(up));
            if !manual && memoking_core::update::is_snoozed(&st(app).setting("updateSnooze"), &version.clone().into(), now_ms()) {
                return; // "나중에" 고른 버전 — 24시간 조용히
            }
            let fresh = updates(|u| {
                let recent = !manual && u.announced.as_ref().is_some_and(|(v, at)| *v == version && now_ms() - at < REMIND_MS);
                if !recent {
                    u.announced = Some((version.clone(), now_ms()));
                }
                !recent
            });
            if fresh {
                announce(app, "update:available");
            }
        }
    }
}

/// 받기: 진행률을 알리고, 다 받으면 설치하고 다시 켠다
fn download_update(app: &AppHandle) {
    let Some(up) = updates(|u| if u.state["status"] == "available" { u.update.clone() } else { None }) else { return };
    set_update(app, json!({ "status": "downloading", "percent": 0 }));
    let (app2, mut got) = (app.clone(), 0u64);
    let r = wait(async move {
        up.download(
            |chunk, total| {
                got += chunk as u64;
                let total = total.unwrap_or(0);
                let percent = if total > 0 { (got as f64 * 100.0 / total as f64).round() } else { 0.0 };
                set_update(&app2, json!({ "status": "downloading", "percent": percent, "transferred": got, "total": total }));
            },
            || {},
        )
        .await
    });
    match r {
        Err(err) => set_update(app, json!({ "status": "error", "message": memoking_core::update::update_error_text(&err.to_string()) })),
        Ok(bytes) => {
            updates(|u| u.bytes = Some(bytes));
            set_update(app, json!({ "status": "ready", "restarting": true }));
            announce(app, "update:ready");
            // "곧 다시 시작해요" 를 잠깐 보여 준 뒤
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                install_update(&app);
            });
        }
    }
}

/// 지금 재시작: 쓰던 메모를 저장하고 설치 → 다시 켬
fn install_update(app: &AppHandle) -> bool {
    let Some((up, bytes)) = updates(|u| if u.state["status"] == "ready" { u.update.clone().zip(u.bytes.clone()) } else { None }) else { return false };
    let labels: Vec<String> = st(app).note_labels.lock().unwrap().values().cloned().collect();
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.eval("window.mkFlushSync?.()");
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(500)); // 메모 창이 저장할 틈
    st(app).save_settings();
    // 설치 파일이 이전 설치 폴더를 지우려면 메모킹이 띄운 PowerShell 도우미가 꺼져 있어야 한다
    crate::history::stop_helpers();
    if let Err(err) = up.install(bytes) {
        set_update(app, json!({ "status": "error", "message": memoking_core::update::update_error_text(&err.to_string()) }));
        return false;
    }
    app.restart();
}

/// 켤 때: 8초 뒤 한 번, 그다음 4시간마다
fn start_updates(app: &AppHandle) {
    if !update_enabled() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        loop {
            check_update(&app, false);
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    Some(match channel {
        "capture:done" => finish_area_capture(app, label, args.first().unwrap_or(&Value::Null)),
        "capture:cancel" => {
            end_area_capture(app);
            Ok(Value::Null)
        }
        "mcp:connect" => Ok(mcp_connect(app, args.first() != Some(&Value::Bool(false)))),
        "mcp:copy" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let snippet = json!({ "mcpServers": { MCP_NAME: mcp_entry(app) } });
            app.clipboard().write_text(serde_json::to_string_pretty(&snippet).unwrap()).map(|()| Value::Bool(true)).map_err(|e| e.to_string())
        }
        "mcp:set-write" => {
            let mut mcp = st(app).setting("mcp").as_object().cloned().unwrap_or_default();
            mcp.insert("write".into(), crate::settings::truthy(args.first()).into());
            st(app).set_setting("mcp", mcp.into());
            Ok(mcp_status(app))
        }
        "pdf:open" => open_pdf_window(app, &memoking_core::js::string(args.first().unwrap_or(&Value::Null))),
        "pdf:memo" => {
            let m = st(app).vault.lock().unwrap().as_ref().and_then(|v| v.get(&memoking_core::js::string(args.first().unwrap_or(&Value::Null))));
            Ok(m.map_or(Value::Null, |m| json!({ "title": m["title"], "body": m["body"], "color": m["color"], "tables": m["tables"], "created": m["created"], "updated": m["updated"] })))
        }
        // shortcut: PDF 만들기는 Electron 의 printToPDF 자리 — Tauri 에는 없어 WebView2 PrintToPdf(webview2-com)로 옮길 때까지 실패(null)로 돌려준다
        "pdf:save" => Ok(Value::Null),
        "attachment:to-pdf" => Ok(office_to_pdf(app, args.first().and_then(Value::as_str).unwrap_or_default())),
        "update:state" => Ok(update_state(app)),
        "update:check" => {
            if !update_enabled() {
                let mut s = update_state(app);
                s["status"] = "dev".into();
                s["message"] = "개발 중에는 업데이트를 확인하지 않아요".into();
                return Some(Ok(s));
            }
            check_update(app, true);
            Ok(update_state(app))
        }
        "update:download" => {
            download_update(app);
            Ok(update_state(app))
        }
        // "나중에": 지금 제안 중인 버전을 24시간 숨긴다
        "update:later" => {
            let s = updates(|u| u.state.clone());
            if (s["status"] == "available" || s["status"] == "ready") && s.get("version").is_some_and(|v| !v.is_null()) {
                st(app).set_setting("updateSnooze", json!({ "version": s["version"], "until": now_ms() + memoking_core::update::SNOOZE_MS as f64 }));
            }
            Ok(update_state(app))
        }
        "update:install" => Ok(install_update(app).into()),
        _ => return None,
    })
}
