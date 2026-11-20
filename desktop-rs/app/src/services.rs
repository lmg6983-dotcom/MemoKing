// 곁가지 기능: 화면 캡처 메모, PDF, 자동 업데이트.
//   Electron 의 window-manager.js(startAreaCapture · finishAreaCapture · openCaptureMemo · openPdfWindow) · office-pdf.js · updater.js 자리.
//   AI 비서 연결(MCP)은 Rust 판에 두지 않는다. AI 는 Google Drive 의 메모 폴더를 직접 읽고 쓴다 (Gemini 등)
use crate::state::state;
use memoking_core::time::now_ms;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

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

/// 메모 창이 열릴 때 넣을 캡처를 맡겨 둔다 (매직 카피 · 화면 캡처)
pub fn put_capture(id: &str, capture: Value) {
    CAPTURES.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.to_string(), capture);
}

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

/// 화면 캡처(사각형 고르기)가 떠 있는가
pub fn area_capturing() -> bool {
    AREA.lock().unwrap().is_some()
}

/// 모니터마다 찍은 화면을 띄우고 사각형을 고르게 한다 (capture.html) — 창 만들기라 이벤트 처리 밖의 스레드에서 부른다
pub fn start_area_capture(app: &AppHandle) -> bool {
    if state(app).vault.lock().unwrap().is_none() {
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
        elog!("[화면 캡처] 화면을 캡처하지 못했어요");
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
        let state = state(app);
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
    put_capture(&id, capture);
    // shortcut: Electron 은 숨긴 메모 창 + 알림(누르면 보임)이었다 — 알림을 옮기기 전까지 메모 창을 바로 띄운다
    crate::memos::open_note(app, &id)?;
    Ok(id.into())
}

/// 켤 때: 업데이트 확인을 건다
pub fn start(app: &AppHandle) {
    start_updates(app);
}

// ---------- PDF ----------

// PDF로 저장 창 (pdf.html 이 미리 보기와 고르기를 맡는다)
fn open_pdf_window(app: &AppHandle, id: &str) -> Result<Value, String> {
    if state(app).vault.lock().unwrap().as_ref().and_then(|v| v.get(id)).is_none() {
        return Ok(false.into());
    }
    if let Some(w) = app.get_webview_window("pdf") {
        let _ = w.destroy();
    }
    let page = format!("pdf.html?id={}", query_value(id));
    crate::window(app, "pdf", &page).title("PDF로 저장").inner_size(820.0, 600.0).min_inner_size(640.0, 480.0).center().build().map_err(|e| e.to_string())?;
    Ok(true.into())
}

fn query_value(v: &str) -> String {
    v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// pdf:save — 숨은 창에 print.html 을 그려 PDF 파일로 (Electron savePdf) → { file, pages } | { cancelled } | null
fn save_pdf(app: &AppHandle, id: &str, o: &Value) -> Value {
    let title = state(app).vault.lock().unwrap().as_ref().and_then(|v| v.get(id)).map(|m| m["title"].as_str().unwrap_or_default().to_string());
    let Some(title) = title else { return Value::Null };
    let file = if crate::ipc::smoke() {
        Some(std::env::temp_dir().join(format!("memoking-smoke-{}.pdf", chrono::Utc::now().timestamp_millis())))
    } else {
        use tauri_plugin_dialog::DialogExt;
        // 파일 이름 규칙은 그림 저장과 같다 (pdf-page.js pdfFileName)
        let name = format!("{}.pdf", crate::files::png_name(None, &title).trim_end_matches(".png"));
        let dir = app.path().document_dir().unwrap_or_else(|_| std::env::temp_dir());
        let picked = app.dialog().file().set_title("PDF로 저장").set_directory(dir).set_file_name(&name).add_filter("PDF", &["pdf"]).blocking_save_file();
        picked.and_then(|p| p.into_path().ok())
    };
    let Some(file) = file else { return json!({ "cancelled": true }) };
    // JS 의 Number(x) || 기본값
    let num = |k: &str, d: f64| o[k].as_f64().filter(|v| *v != 0.0).unwrap_or(d);
    let (w, h) = (num("width", 210.0), num("height", 297.0));
    let page = format!(
        "print.html?id={}&w={w}&h={h}&m={}&bg={}&date={}&fit={}&br={}&z={}",
        query_value(id),
        num("margin", 0.0).max(0.0),
        u8::from(crate::settings::truthy(Some(&o["bg"]))),
        u8::from(crate::settings::truthy(Some(&o["date"]))),
        u8::from(o["fit"] != false),
        u8::from(o["breaks"] == true),
        num("zoom", 1.0).clamp(0.5, 2.0),
    );
    let label = format!("print-{}", chrono::Utc::now().timestamp_millis());
    let mm = |v: f64| (v * 96.0 / 25.4).round();
    let Ok(win) = crate::window(app, &label, &page).visible(false).skip_taskbar(true).inner_size(mm(w), mm(h)).build() else { return Value::Null };
    let made = print_to_pdf(&win, &file, w, h);
    let _ = win.destroy();
    let Some(pdf) = made.then(|| std::fs::read(&file).ok()).flatten() else {
        elog!("PDF 만들기 실패: {}", file.display());
        return Value::Null;
    };
    let latin1: String = pdf.iter().map(|&b| b as char).collect();
    let pages = fancy_regex::Regex::new(r"/Type\s*/Page\b").unwrap().find_iter(&latin1).count();
    if o["open"] == true && !crate::ipc::smoke() {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_path(file.to_string_lossy(), None::<&str>);
    }
    json!({ "file": file.to_string_lossy(), "pages": pages })
}

/// 화면이 다 그려지면(data-ready, 늦어도 15초) WebView2 PrintToPdf — 쪽 크기는 mm, 여백 없이 바탕까지
#[cfg(windows)]
fn print_to_pdf(win: &tauri::WebviewWindow, file: &Path, w: f64, h: f64) -> bool {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7};
    use webview2_com::{ExecuteScriptCompletedHandler, PrintToPdfCompletedHandler};
    use windows::core::{Interface, HSTRING};
    let until = Instant::now() + Duration::from_secs(15);
    while Instant::now() < until {
        let (tx, rx) = mpsc::channel();
        let asked = win.with_webview(move |wv| unsafe {
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |_, r| {
                let _ = tx.send(r == "true");
                Ok(())
            }));
            if let Ok(core) = wv.controller().CoreWebView2() {
                let _ = core.ExecuteScript(&HSTRING::from("document.documentElement.dataset.ready === 'true'"), &handler);
            }
        });
        if asked.is_err() || rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let (tx, rx) = mpsc::channel();
    let path = HSTRING::from(file.as_os_str());
    let asked = win.with_webview(move |wv| unsafe {
        let done = tx.clone();
        let r = (|| -> windows::core::Result<()> {
            let core = wv.controller().CoreWebView2()?.cast::<ICoreWebView2_7>()?;
            let s = wv.environment().cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
            s.SetPageWidth(w / 25.4)?;
            s.SetPageHeight(h / 25.4)?;
            s.SetMarginTop(0.0)?;
            s.SetMarginBottom(0.0)?;
            s.SetMarginLeft(0.0)?;
            s.SetMarginRight(0.0)?;
            s.SetShouldPrintBackgrounds(true)?;
            s.SetShouldPrintHeaderAndFooter(false)?;
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |r, ok| {
                let _ = done.send(r.is_ok() && ok);
                Ok(())
            }));
            core.PrintToPdf(&path, &s, &handler)
        })();
        if r.is_err() {
            let _ = tx.send(false);
        }
    });
    asked.is_ok() && rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false)
}

#[cfg(not(windows))]
fn print_to_pdf(_: &tauri::WebviewWindow, _: &Path, _: f64, _: f64) -> bool {
    false
}

// Word · PowerPoint · Excel 문서 → PDF (이 PC 의 Office 로). 경로 · 고르기는 환경 변수로 넘긴다 (명령 줄에 끼우면 따옴표 · 특수 문자가 섞인다)
//   사용자가 이미 띄워 둔 PowerPoint 에 붙는 경우(PowerPoint 는 한 개만 뜬다) 사용자의 창은 닫지 않는다
//   MK_PROBE=1: 검토 메모 · 발표자 노트가 있으면 만들지 않고 "ASK comments=N notes=N" 만 알린다 (화면이 넣을지 묻고 다시 부른다)
//   MK_COMMENTS=1: 검토 메모를 함께 (Word 여백 · PowerPoint 말풍선) · MK_NOTES=1: PowerPoint 를 노트 페이지(슬라이드 + 노트)로
const OFFICE_PDF: &str = r#"
$ErrorActionPreference = 'Stop'
$src = $env:MK_SRC; $out = $env:MK_OUT; $probe = $env:MK_PROBE -eq '1'
$comments = $env:MK_COMMENTS -eq '1'; $notes = $env:MK_NOTES -eq '1'
$none = [Type]::Missing
if ($src -match '\.pptx?$') {
  $running = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
  $app = New-Object -ComObject PowerPoint.Application
  try {
    $doc = $app.Presentations.Open($src, -1, 0, 0)
    try {
      if ($probe) {
        $c = 0; $n = 0
        foreach ($s in $doc.Slides) {
          $c += $s.Comments.Count
          try { if ($s.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange.Text.Trim()) { $n++ } } catch {}
        }
        if ($c -or $n) { "ASK comments=$c notes=$n"; return }
      }
      if ($comments -or $notes) {
        $type = if ($notes) { 5 } else { 1 }
        try { $doc.ExportAsFixedFormat2($out, 2, 2, 0, 1, $type, 0, $none, 1, '', $false, $true, $true, $true, $false, $comments) }
        catch { $doc.ExportAsFixedFormat($out, 2, 2, 0, 1, $type) }
      } else { $doc.SaveAs($out, 32) }
    } finally { $doc.Close() }
  } finally { if (-not $running -and $app.Presentations.Count -eq 0) { $app.Quit() } }
} elseif ($src -match '\.xlsx?$') {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false; $app.DisplayAlerts = $false
  try {
    $book = $app.Workbooks.Open($src, 0, $true, $none, 'mk-no-password')
    try { $book.ExportAsFixedFormat(0, $out) } finally { $book.Close($false) }
  } finally { $app.Quit() }
} else {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false; $app.DisplayAlerts = 0
  try {
    $doc = $app.Documents.Open($src, $false, $true, $false, 'mk-no-password')
    try {
      if ($probe -and $doc.Comments.Count) { "ASK comments=$($doc.Comments.Count) notes=0"; return }
      $item = if ($comments) { 7 } else { 0 }
      $doc.ExportAsFixedFormat($out, 17, $false, 0, 0, 1, 1, $item)
    } finally { $doc.Close(0) }
  } finally { if ($app.Documents.Count -eq 0) { $app.Quit() } }
}
"#;

/// Office 로 PDF 를 만들 수 있는 문서 (doc-pages.js 는 doc · ppt · xls 를 직접 그리지 못한다 — core/file-kinds.js OFFICE_ONLY_EXTS)
const OFFICE_EXTS: [&str; 6] = ["docx", "doc", "pptx", "ppt", "xlsx", "xls"];

/// 메모 폴더의 Word · PowerPoint · Excel 첨부 → PDF 내용 | { ask: { comments, notes } } | null
///   opts 가 없으면 먼저 검토 메모 · 발표자 노트를 본다: 있으면 만들지 않고 ask (화면이 넣을지 묻고 { comments, notes } 로 다시 부른다)
///   null: Windows 아님 · Office 없음 · 실패 → 화면이 직접 그린다 (못 그리는 종류는 칩만)
fn office_to_pdf(app: &AppHandle, rel: &str, opts: Option<&Value>) -> Value {
    let rel = memoking_core::js::decode_uri(rel).unwrap_or_else(|| rel.to_string());
    let file = state(app).vault.lock().unwrap().as_ref().filter(|_| rel.starts_with("attachments/")).and_then(|v| v.resolve(&rel)).filter(|f| f.is_file());
    let office = |f: &std::path::PathBuf| f.extension().and_then(|e| e.to_str()).is_some_and(|e| OFFICE_EXTS.contains(&e.to_ascii_lowercase().as_str()));
    let Some(src) = file.filter(|f| cfg!(windows) && !crate::ipc::smoke() && office(f)) else { return Value::Null };
    let out = std::env::temp_dir().join(format!("memoking-pdf-{}-{}.pdf", chrono::Utc::now().timestamp_millis(), std::process::id()));
    let flag = |k: &str| if opts.is_some_and(|o| o[k] == true) { "1" } else { "0" };
    let child = crate::history::powershell(false)
        .args(["-Command", OFFICE_PDF])
        .env("MK_SRC", &src)
        .env("MK_OUT", &out)
        .env("MK_PROBE", if opts.is_some() { "0" } else { "1" })
        .env("MK_COMMENTS", flag("comments"))
        .env("MK_NOTES", flag("notes"))
        .stdout(std::process::Stdio::piped())
        .spawn();
    // shortcut: 암호 걸린 PowerPoint 처럼 Office 가 물어보며 멈추면 90초 뒤 포기 (Office 프로그램은 남을 수 있음)
    let mut said = String::new();
    let ok = child.is_ok_and(|mut c| {
        for _ in 0..900 {
            if let Ok(Some(status)) = c.try_wait() {
                use std::io::Read;
                let _ = c.stdout.take().map(|mut o| o.read_to_string(&mut said));
                return status.success();
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = c.kill();
        false
    });
    if let Some(ask) = said.lines().find_map(|l| l.trim().strip_prefix("ASK ")).filter(|_| ok) {
        let count = |k: &str| ask.split_whitespace().find_map(|kv| kv.strip_prefix(k)?.strip_prefix('=')?.parse::<u64>().ok()).unwrap_or(0);
        let _ = std::fs::remove_file(&out);
        return json!({ "ask": { "comments": count("comments"), "notes": count("notes") } });
    }
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

/// 목록 창이 물어볼 때: 지금 상태 + 대화 상자를 띄울지 (숨겨 둔 버전이면 띄우지 않음)
fn update_state(app: &AppHandle) -> Value {
    let mut s = updates(|u| u.state.clone());
    let offering = s["status"] == "ready" || s["status"] == "available";
    let ask = offering && !memoking_core::update::is_snoozed(&state(app).setting("updateSnooze"), s.get("version").unwrap_or(&Value::Null), now_ms() as f64);
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
            elog!("[update] {err}");
            set_update(app, json!({ "status": "error", "message": memoking_core::update::update_error_text(&err.to_string()) }));
        }
        Ok(None) => set_update(app, json!({ "status": "latest" })),
        Ok(Some(up)) => {
            let version = up.version.clone();
            let date = up.date.and_then(|d| chrono::DateTime::from_timestamp(d.unix_timestamp(), 0)).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default();
            set_update(app, json!({ "status": "available", "version": version, "notes": memoking_core::update::notes_text(up.body.as_deref().unwrap_or_default()), "date": date }));
            updates(|u| u.update = Some(up));
            if !manual && memoking_core::update::is_snoozed(&state(app).setting("updateSnooze"), &version.clone().into(), now_ms() as f64) {
                return; // "나중에" 고른 버전 — 24시간 조용히
            }
            let fresh = updates(|u| {
                let recent = !manual && u.announced.as_ref().is_some_and(|(v, at)| *v == version && now_ms() as f64 - at < REMIND_MS);
                if !recent {
                    u.announced = Some((version.clone(), now_ms() as f64));
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
    let (app2, mut got, mut shown) = (app.clone(), 0u64, u64::MAX);
    let r = wait(async move {
        up.download(
            |chunk, total| {
                got += chunk as u64;
                let total = total.unwrap_or(0);
                let percent = if total > 0 { got * 100 / total } else { 0 };
                // 받은 조각(수천 개)마다가 아니라 1% 오를 때만 (크기를 모르면 1MB 마다) — 화면이 조각마다 다시 그려 막대가 날뛰었다
                let step = if total > 0 { percent } else { got >> 20 };
                if step == shown {
                    return;
                }
                shown = step;
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
    let labels: Vec<String> = state(app).note_labels.lock().unwrap().values().cloned().collect();
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.eval("window.mkFlushSync?.()");
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(500)); // 메모 창이 저장할 틈
    state(app).save_settings();
    // 설치 파일이 이전 설치 폴더를 지우려면 메모킹이 띄운 PowerShell 도우미가 꺼져 있어야 한다
    crate::history::stop_helpers();
    // 업데이트 플러그인은 설치 파일을 띄우고 바로 끝내(Exit 이벤트 없음) 여기서 끈다. 남은 AI 엔진이 설치 폴더의 파일을 잡고 있지 않게
    crate::ai::stop();
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
        "pdf:open" => open_pdf_window(app, &memoking_core::js::string(args.first().unwrap_or(&Value::Null))),
        "pdf:memo" => {
            let m = state(app).vault.lock().unwrap().as_ref().and_then(|v| v.get(&memoking_core::js::string(args.first().unwrap_or(&Value::Null))));
            Ok(m.map_or(Value::Null, |m| json!({ "title": m["title"], "body": m["body"], "color": m["color"], "tables": m["tables"], "created": m["created"], "updated": m["updated"] })))
        }
        // shortcut: PDF 만들기는 WebView2(Windows)의 PrintToPdf 로만 — 그 밖(개발용 Linux)은 실패(null). 다른 OS 판을 낼 때 그 웹뷰의 인쇄로
        "pdf:save" if !cfg!(windows) => Ok(Value::Null),
        "pdf:save" => Ok(save_pdf(app, &memoking_core::js::string(args.first().unwrap_or(&Value::Null)), args.get(1).unwrap_or(&Value::Null))),
        "attachment:to-pdf" => Ok(office_to_pdf(app, args.first().and_then(Value::as_str).unwrap_or_default(), args.get(1).filter(|o| o.is_object()))),
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
                state(app).set_setting("updateSnooze", json!({ "version": s["version"], "until": now_ms() as f64 + memoking_core::update::SNOOZE_MS as f64 }));
            }
            Ok(update_state(app))
        }
        "update:install" => Ok(install_update(app).into()),
        _ => return None,
    })
}
