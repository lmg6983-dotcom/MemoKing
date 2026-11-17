// 곁가지 기능 — 화면 캡처 메모 · AI 비서 연결(MCP) · PDF.
//   Electron 의 window-manager.js(startAreaCapture · finishAreaCapture · openCaptureMemo · openPdfWindow) · utils.js(mcpStatus · mcpConnect) · office-pdf.js 자리.
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

/// 켤 때: 메모킹을 옮겨 설치했으면(연결된 실행 파일 자리가 다르면) 다시 연결
pub fn start(app: &AppHandle) {
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
        _ => return None,
    })
}
