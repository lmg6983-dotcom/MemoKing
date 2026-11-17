// 곁가지 기능 — 화면 캡처 메모. Electron 의 window-manager.js(startAreaCapture · finishAreaCapture · openCaptureMemo) 자리.
use crate::state::State;
use serde_json::{json, Value};
use std::collections::HashMap;
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

pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    Some(match channel {
        "capture:done" => finish_area_capture(app, label, args.first().unwrap_or(&Value::Null)),
        "capture:cancel" => {
            end_area_capture(app);
            Ok(Value::Null)
        }
        _ => return None,
    })
}
