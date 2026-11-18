// 여러 창 — 메모 스택(탭) · 왕관 · 테이프 스티커 · 목록에서 끌어 놓기 미리보기 · 잠깐 알림 · 상태 말풍선.
//   Electron 의 window-manager.js · status-bubble-window.js · desktop-pin.js · foreground-watch.js 와 그 ipc (ipc-handlers.js) 자리.
//   스택은 Electron 처럼 탭마다 메모 창 하나 — 보이는 탭 창만 보이고 나머지는 같은 자리에 숨어 있다.
//   자리는 모두 화면 논리 좌표 [x, y, 폭, 높이] (Electron 의 DIP 처럼).
//   Tauri 에는 창 보이기 · 숨기기 이벤트가 없어 메모 창을 보이고 숨기는 곳에서 스티커도 직접 맞춘다 (shown · hide_note).
//   잠금 차례: 앱 상태(메모 폴더 · 설정 · note_labels)를 잡은 채로 WM 을 잡지 않고, WM 을 잡은 채로 창을 부르지 않는다.
use crate::state::state;
use memoking_core::placement::{drop_bounds, is_inside, place_bubble, Rect, BAR_H, BUBBLE_SIZE, DEFAULT_NOTE_SIZE};
use memoking_core::stacks::{Stack, Stacks};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard, Once};
use std::time::{Duration, Instant};
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow, WindowEvent, Wry};

const GHOST_MARGIN: f64 = 24.0;
/// 다른 메모 위에 이만큼 머물면 "놓으면 탭으로 합쳐요"
const STACK_DWELL: Duration = Duration::from_millis(100);

#[derive(Default)]
struct Hover {
    target: Option<String>,
    armed: bool,
    gen: u64,
}

/// 합칠 메모를 찾는 손: 목록에서 끌기 · 메모 창 끌기 · 탭 떼어 끌기
#[derive(Clone, Copy, PartialEq)]
enum Who {
    Drag,
    Window,
    Tear,
}

struct Drag {
    id: String,
    outside: bool,
    ready: bool,
    hover: Hover,
}

struct Tear {
    id: String,
    label: String,
    off: (f64, f64),
    hover: Hover,
}

struct Sticker {
    kind: &'static str,
    win: Option<String>,
    /// 목록 창 왕관이 잘려 제목 줄의 작은 왕관으로 들어가 있다 (스티커 창 없음)
    docked: bool,
}

/// PowerShell 도우미 (테이프: desktop-pin.ps1) — 붙여 둔 창은 도우미가 다시 뜨면 다시 알린다
#[derive(Default)]
struct PinHelper {
    stdin: Option<std::process::ChildStdin>,
    gen: u64,
    failed: bool,
    quick_exits: u32,
    pinned: HashSet<i64>,
    pairs: HashMap<i64, i64>,
}

/// PowerShell 도우미 (왕관: top-watch.ps1)
#[derive(Default)]
struct TopWatch {
    child: Option<std::process::Child>,
    watch: Vec<i64>,
    gen: u64,
}

pub type Action = Box<dyn FnOnce(&AppHandle) + Send>;

#[derive(Default)]
struct Wm {
    /// 메모 폴더 → 그 폴더의 스택 (_memoking/stacks.json)
    stacks: Option<(PathBuf, Stacks)>,
    /// 숨겨 만든 메모 창이 메모를 다 그리면 (win:painted) 할 일
    reveal: HashMap<String, Action>,
    /// 주인 창 이름 → 스티커
    stickers: HashMap<String, Sticker>,
    /// 테이프로 바탕화면 층에 붙인 메모 창 → HWND (점검에서는 -1)
    pinned: HashMap<String, i64>,
    drag: Option<Drag>,
    /// (메모 id, 합칠 곳)
    window_drag: Option<(String, Hover)>,
    tear: Option<Tear>,
    inking: HashSet<String>,
    closing: HashSet<String>,
    /// 닫는 중(숨기고 남은 글을 저장하는 중)인 메모 창. 없어질 때 뺀다
    closing_notes: HashSet<String>,
    /// 숨은 메모 창이 처음 숨은 것으로 보인 때 — 오래 숨은 스택 탭은 거둔다 (discard_tick)
    hidden_at: HashMap<String, Instant>,
    /// 예비 창으로 되돌려 다시 쓴 횟수 (창마다 RECYCLE_MAX 까지)
    recycled: HashMap<String, u32>,
    /// 오래 숨어 웹뷰에도 안 보임을 알린 창 (보일 때 되돌린다)
    deep: HashSet<String>,
    /// 화면을 다 불러온 덧창 (ghost · hud · bubble-…)
    loaded: HashSet<String>,
    /// 창 옮기기 · 늘이기가 멈췄는지 볼 차례 번호
    settle: HashMap<String, u64>,
    menu: HashMap<String, Action>,
    seq: u64,
    hud: u64,
    raise: u64,
    pin: PinHelper,
    top: TopWatch,
}

static WM: LazyLock<Mutex<Wm>> = LazyLock::new(Default::default);

fn wm() -> MutexGuard<'static, Wm> {
    WM.lock().unwrap()
}

fn next_seq() -> u64 {
    let mut g = wm();
    g.seq += 1;
    g.seq
}

fn later(ms: u64, f: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        f();
    });
}

fn emit(app: &AppHandle, label: &str, event: &str, payload: Value) {
    let _ = app.emit_to(label, event, [payload]);
}

// ---------- 창 · 자리 ----------

fn note_label(app: &AppHandle, id: &str) -> Option<String> {
    state(app).note_labels.lock().unwrap().get(id).cloned()
}

fn note_win(app: &AppHandle, id: &str) -> Option<WebviewWindow> {
    note_label(app, id).filter(|l| !is_closing(l)).and_then(|l| app.get_webview_window(&l))
}

/// 닫는 중인 메모 창은 곧 없어지니 없는 셈 친다 (다시 열면 새 창으로)
pub fn is_closing(label: &str) -> bool {
    wm().closing_notes.contains(label)
}

fn note_id(app: &AppHandle, label: &str) -> Option<String> {
    state(app).note_labels.lock().unwrap().iter().find(|(_, l)| *l == label).map(|(id, _)| id.clone())
}

fn is_shown(w: &WebviewWindow) -> bool {
    w.is_visible().unwrap_or(false)
}

fn on_screen(w: &WebviewWindow) -> bool {
    is_shown(w) && !w.is_minimized().unwrap_or(false)
}

pub fn bounds(w: &WebviewWindow) -> Option<Rect> {
    let s = w.scale_factor().ok()?;
    let p = w.outer_position().ok()?.to_logical::<f64>(s);
    let z = w.inner_size().ok()?.to_logical::<f64>(s);
    Some([p.x, p.y, z.width, z.height])
}

pub fn set_bounds(w: &WebviewWindow, [x, y, width, height]: Rect) {
    let _ = w.set_position(LogicalPosition::new(x, y));
    let _ = w.set_size(LogicalSize::new(width, height));
}

fn rect_json([x, y, w, h]: Rect) -> Value {
    json!({ "x": x.round() as i64, "y": y.round() as i64, "width": w.round() as i64, "height": h.round() as i64 })
}

fn point(v: &Value) -> Option<(f64, f64)> {
    Some((v["x"].as_f64()?.round(), v["y"].as_f64()?.round()))
}

/// 그 점이 있는 화면의 작업 영역 (없으면 첫 화면)
fn area_at(app: &AppHandle, p: (f64, f64)) -> Rect {
    let areas = crate::os::work_areas(app);
    areas.iter().copied().find(|&a| is_inside(p, a)).or(areas.first().copied()).unwrap_or([0.0, 0.0, 1920.0, 1080.0])
}

fn cursor(app: &AppHandle) -> Option<(f64, f64)> {
    let p = app.cursor_position().ok()?;
    let s = app.monitor_from_point(p.x, p.y).ok().flatten().map_or(1.0, |m| m.scale_factor());
    Some((p.x / s, p.y / s))
}

/// 기억한 이 메모 창 자리 (지금 있는 화면 안일 때만)
pub fn saved_bounds(app: &AppHandle, id: &str) -> Option<Rect> {
    crate::os::on_screen(&state(app).setting("noteBounds")[id], &crate::os::work_areas(app))
}

fn remember_bounds(app: &AppHandle, ids: &[String], b: Rect) {
    let st = state(app);
    {
        let mut s = st.settings.lock().unwrap();
        let all = s.entry("noteBounds").or_insert_with(|| json!({}));
        if !all.is_object() {
            *all = json!({});
        }
        for m in ids {
            all.as_object_mut().unwrap().insert(m.clone(), rect_json(b));
        }
    }
    st.save_settings();
}

// ---------- 스택 저장소 ----------

/// 지금 메모 폴더의 스택으로 f — 바뀌었으면 stacks.json 에 쓴다 (메모 폴더가 바뀌면 그 폴더 것을 읽는다)
fn stacks<T>(app: &AppHandle, f: impl FnOnce(&mut Stacks) -> T) -> Option<T> {
    let root = state(app).vault.lock().unwrap().as_ref()?.root.clone();
    let file = root.join(memoking_core::vault::APP_DIR).join("stacks.json");
    if !matches!(&wm().stacks, Some((r, _)) if *r == root) {
        let text = std::fs::read_to_string(&file).ok();
        let state = state(app);
        let loaded = {
            let g = state.vault.lock().unwrap();
            let v = g.as_ref()?;
            Stacks::load(text.as_deref(), |id| v.entry(id).is_some(), Box::new(memoking_core::stacks::random_id))
        };
        wm().stacks = Some((root.clone(), loaded));
    }
    let mut g = wm();
    let (_, s) = g.stacks.as_mut()?;
    let before = s.text();
    let r = f(s);
    let after = s.text();
    if after != before {
        if let Err(err) = memoking_core::vault::write_atomic(&file, after.as_bytes()) {
            elog!("스택 저장 실패: {err}");
        }
    }
    Some(r)
}

fn stack_of(app: &AppHandle, id: &str) -> Option<Stack> {
    stacks(app, |s| s.stack_of(id).cloned()).flatten()
}

pub fn in_stack(app: &AppHandle, id: &str) -> bool {
    stack_of(app, id).is_some()
}

/// 메모 창이 그리는 탭 줄 { active, members: [{ id, title, color }] } (스택이 아니면 빈 줄)
pub fn stack_state(app: &AppHandle, id: &str) -> Value {
    let Some(s) = stack_of(app, id) else { return json!({ "members": [], "active": id }) };
    let state = state(app);
    let g = state.vault.lock().unwrap();
    let members: Vec<Value> = s
        .memos
        .iter()
        .map(|m| match g.as_ref().and_then(|v| v.entry(m)) {
            Some(e) => json!({ "id": m, "title": memoking_core::body::extract_title(&e.body), "color": e.meta.color }),
            None => json!({ "id": m, "title": "제목 없음", "color": "yellow" }),
        })
        .collect();
    json!({ "active": s.active, "members": members })
}

fn push_stack_to(app: &AppHandle, ids: &[String]) {
    for m in ids {
        if let Some(l) = note_label(app, m) {
            emit(app, &l, "stack:state", stack_state(app, m));
        }
    }
}

/// 목록이 바뀔 때마다 (memos::push_list) — 탭 제목 · 색도 새로
pub fn push_all_stacks(app: &AppHandle) {
    let all: Vec<String> = stacks(app, |s| s.stacks.iter().flat_map(|x| x.memos.clone()).collect()).unwrap_or_default();
    push_stack_to(app, &all);
}

/// 목록 카드에 붙이는 것: 메모 id → [열림(창이 보임), 스택 탭 수, 테이프로 바탕화면에 붙어 있음]
pub fn card_flags(app: &AppHandle) -> impl Fn(&str) -> [Value; 3] {
    let labels: Vec<(String, String)> = state(app).note_labels.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let visible: HashSet<String> = labels.into_iter().filter(|(_, l)| app.get_webview_window(l).is_some_and(|w| is_shown(&w))).map(|(id, _)| id).collect();
    let all = stacks(app, |s| s.stacks.clone()).unwrap_or_default();
    let bottom = state(app).setting("onBottom");
    move |id| {
        let stack = all.iter().find(|s| s.memos.iter().any(|m| m == id));
        let taped = bottom[id] == true && stack.map_or(visible.contains(id), |s| s.memos.iter().any(|m| visible.contains(m)));
        [visible.contains(id).into(), stack.map_or(0, |s| s.memos.len()).into(), taped.into()]
    }
}

// ---------- 메모 창이 열리고 닫힐 때 ----------

/// 메모 창을 만들었다 (memos::create_note_window): 옮기기 · 포커스 · 닫기를 본다
pub fn track(app: &AppHandle, id: &str, win: &WebviewWindow) {
    sync_resize(win); // 같은 창을 다시 쓰면 같은 처리기를 다시 단다 (Windows 가 하나로 둔다)
    let (app, id, label) = (app.clone(), id.to_string(), win.label().to_string());
    win.on_window_event(move |e| match e {
        // 이 창이 이제 이 메모의 창이 아니다 (예비 창으로 되돌려 다른 메모가 쓴다) — 그 메모 몫의 처리가 맡는다
        _ if !matches!(e, WindowEvent::Destroyed) && note_label(&app, &id).as_deref() != Some(label.as_str()) => {}
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            sync_sticker(&app, &label);
            bubble_away(&app, &label);
            moving(&app, &id, &label, matches!(e, WindowEvent::Moved(_)));
        }
        // 포커스가 바뀔 때는 웹뷰를 건드리지 않는다 — 포커스를 받는 순간(첫 클릭)에 메모리 단계를 바꾸면 그 클릭이 먹혀
        //   닫기 · 단추를 두 번 눌러야 했다. 오래 숨어 안 보임으로 둔 창이 다른 길로 보였을 때만 되돌린다 (안전망)
        WindowEvent::Focused(true) => {
            if wm().deep.remove(&label) {
                if let Some(w) = app.get_webview_window(&label) {
                    webview_visible(&w, true);
                    memory_low(&w, false);
                }
            }
        }
        WindowEvent::Focused(false) => {
            bubble_away(&app, &label);
            // 테이프 메모: 쓰고 나서 다른 데를 누르면 다시 바탕화면 층으로
            let h = wm().pinned.get(&label).copied();
            if let Some(h) = h {
                pin_send(&app, "bottom", h, 0);
            }
        }
        // 스택의 탭 창 하나를 닫으면 스택 모두 (Electron 'close')
        //   창은 바로 숨기고, 남은 글을 동기 저장(mkFlushSync)한 뒤에 없앤다. 웹뷰를 닫는 동안의 beforeunload 저장을 기다리며 멈추지 않게
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            wm().closing_notes.insert(label.clone());
            close_stack(&app, &id);
            let Some(w) = app.get_webview_window(&label) else { return };
            hide_note(&app, &w);
            let destroy = {
                let (app, label) = (app.clone(), label.clone());
                let once = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                // 이벤트 처리 · 스크립트 답 안에서 웹뷰를 없애지 않는다. 저장 답 · 3초 중 먼저 온 쪽 한 번만
                move || {
                    if once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    let (app, label) = (app.clone(), label.clone());
                    std::thread::spawn(move || retire_note(&app, &label));
                }
            };
            // 화면이 멈춰 답이 없어도 3초 뒤에는 닫는다
            later(3000, destroy.clone());
            let fail = destroy.clone();
            if w.eval_with_callback("window.mkFlushSync?.()", move |_| destroy()).is_err() {
                fail();
            }
        }
        WindowEvent::Destroyed => destroyed(&app, &id, &label),
        _ => {}
    });
}

/// 메모 창이 보이게 됐다: 그 메모의 층(왕관 · 테이프)과 스티커
pub fn shown(app: &AppHandle, id: &str, win: &WebviewWindow) {
    // 미리 만든 숨은 탭이 아니라 보인 메모를 열린 메모로 (맨 뒤가 다음에 켤 때 보일 탭, Electron 처럼 show 때)
    crate::os::set_open(app, id, true);
    apply_layer(app, id, win, false);
    crate::memos::push_list_soon(app); // 목록의 열린 메모 표시 (숨겨 만든 창은 만들 때 알리지 않는다)
}

/// 이 창의 WebView2 에 메모리를 덜 쓰라고(low) · 보통으로 — 숨거나 포커스가 없는 창은 덜 (캐시 · 풀어 둔 그림을 놓는다).
///   다시 쓰면 조금 느릴 수 있어 포커스를 받는 순간 보통으로 되돌린다. 화면 · 상태는 그대로 (닫거나 멈추지 않는다)
#[cfg(windows)]
pub fn memory_low(w: &WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
    use windows::core::Interface;
    let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
    let _ = w.with_webview(move |wv| unsafe {
        // 오래된 WebView2 런타임(_19 없음)이면 그대로
        if let Ok(core) = wv.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_19>()) {
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
    });
}
#[cfg(not(windows))]
pub fn memory_low(_w: &WebviewWindow, _low: bool) {}

/// WebView2 에 이 창이 보이는지 알린다 — Tauri 는 창을 숨겨도 웹뷰에는 알리지 않아, 숨은 창도 그리기 자원(화면 조각 · GPU 메모리)을 쥐고 있었다
#[cfg(windows)]
fn webview_visible(w: &WebviewWindow, on: bool) {
    let win = w.clone();
    let _ = w.with_webview(move |wv| unsafe {
        // 끄기는 UI 스레드에서 그 순간에도 숨어 있을 때만 (그사이 보였으면 빈 화면이 되지 않게)
        if on || !win.is_visible().unwrap_or(true) {
            let _ = wv.controller().SetIsVisible(on);
        }
    });
}
#[cfg(not(windows))]
fn webview_visible(_w: &WebviewWindow, _on: bool) {}

/// 메모 창 보이기 — 웹뷰를 먼저 보이게 해 그리기를 시작시키고 창을 띄운다
pub fn show_note_win(w: &WebviewWindow) {
    {
        let mut g = wm();
        g.hidden_at.remove(w.label());
        g.deep.remove(w.label());
    }
    memory_low(w, false); // 숨는 동안 낮춰 둔 메모리 단계를 보통으로 (포커스 때가 아니라 보일 때)
    webview_visible(w, true);
    let _ = w.show();
}

/// 이 메모 창이 보이면 포커스를 지금 앞의 앱에 돌려준다 (창은 그 위에 보인 채로) — 메모 단축키로 복사하고 창도 띄울 때.
///   창은 여러 길(예비 창 · 재활용 · 그린 뒤 보이기)로 늦게 보여서 보일 때까지 잠깐 지켜본다
#[cfg(windows)]
pub fn keep_focus_after_show(app: &AppHandle, id: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow, SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
    // SAFETY: 인자 없는 조회
    let prev = unsafe { GetForegroundWindow() } as isize;
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(50));
            let label = state(&app).note_labels.lock().unwrap().get(&id).cloned();
            let Some(w) = label.and_then(|l| app.get_webview_window(&l)) else { continue };
            if !w.is_visible().unwrap_or(false) {
                continue;
            }
            std::thread::sleep(Duration::from_millis(50)); // 보인 뒤 set_focus 까지
            let Ok(hwnd) = w.hwnd() else { return };
            // SAFETY: prev 는 앞서 받은 창 핸들 (그새 닫혔으면 실패할 뿐), hwnd 는 살아 있는 이 창
            unsafe {
                SetForegroundWindow(prev as _);
                SetWindowPos(hwnd.0 as _, HWND_TOP, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
            }
            return;
        }
    });
}

#[cfg(not(windows))]
pub fn keep_focus_after_show(_: &AppHandle, _: &str) {}

/// 숨은 지 오래(60초)된 창은 웹뷰도 안 보임으로 — 바로 끄면 탭을 오갈 때 다시 그리느라 흰 화면이 비칠 수 있어 잠시 둔다
const DEEP_HIDE_MS: u64 = 60_000;
pub fn hide_deep_later(w: &WebviewWindow) {
    let w = w.clone();
    later(DEEP_HIDE_MS, move || {
        if !is_shown(&w) {
            wm().deep.insert(w.label().to_string());
            webview_visible(&w, false);
        }
    });
}

/// 아직 그리는 중인 창(미리 열기 · 숨겨 만든 창)을 열면: 바로 보이지 않고 다 그리면 보이게 바꿔 둔다 → 바꿨는가.
///   그리기 전에 보이면 투명 창이라 아무것도 없어 보여 한 번 더 눌러야 했다 (늦어도 when_painted 의 1.5초)
pub fn reveal_when_painted(label: &str, id: &str) -> bool {
    let mut g = wm();
    if !g.reveal.contains_key(label) {
        return false;
    }
    let (label2, id2) = (label.to_string(), id.to_string());
    g.reveal.insert(
        label.to_string(),
        Box::new(move |app: &AppHandle| {
            if let Some(w) = app.get_webview_window(&label2) {
                let _ = w.unminimize();
                show_note_win(&w);
                let _ = w.set_focus();
                shown(app, &id2, &w);
            }
        }),
    );
    true
}

/// 창 크기를 바꿀 때 웹뷰를 같은 박자로 — wry 는 WM_SIZE 에서 웹뷰를 담은 안쪽 창을 비동기(SWP_ASYNCWINDOWPOS)로 늘려,
///   바깥 창 · 안쪽 창 · 웹뷰가 따로 커지며 끈적이고 가장자리가 비었다 (tauri-apps/tauri#13270). wry 다음에 안쪽 창을 바로 맞추고
///   화면 합성 한 번을 기다린다 (DwmFlush — 끄는 동안 화면 주기에 맞춰 커진다)
#[cfg(windows)]
pub fn sync_resize(w: &WebviewWindow) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Dwm::DwmFlush;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClientRect, SetWindowPos, SIZE_MINIMIZED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, WM_NCDESTROY, WM_SIZE};
    const ID: usize = 0x4d4b_5253; // "MKRS"
    unsafe extern "system" fn on_msg(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, inner: usize) -> LRESULT {
        // SAFETY: Windows 가 부르는 창 처리기 — hwnd 는 살아 있는 이 창, inner 는 같은 스레드의 안쪽 창
        unsafe {
            let r = DefSubclassProc(hwnd, msg, wp, lp); // wry 먼저 (웹뷰 크기 · 안쪽 창 비동기)
            if msg == WM_SIZE && wp != SIZE_MINIMIZED as usize {
                let mut rc: RECT = std::mem::zeroed();
                if GetClientRect(hwnd, &mut rc) != 0 {
                    SetWindowPos(inner as HWND, std::ptr::null_mut(), 0, 0, rc.right - rc.left, rc.bottom - rc.top, SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE);
                    DwmFlush();
                }
            } else if msg == WM_NCDESTROY {
                RemoveWindowSubclass(hwnd, Some(on_msg), ID);
            }
            r
        }
    }
    let top = hwnd(w);
    if top == 0 {
        return;
    }
    let _ = w.with_webview(move |wv| unsafe {
        let mut inner = windows::Win32::Foundation::HWND::default();
        // 안쪽 창이 바깥 창 그 자체면 (wry 가 안쪽 창 없이 띄웠으면) 할 일이 없다 — 제 크기를 또 바꾸면 끝없이 돈다
        if wv.controller().ParentWindow(&mut inner).is_err() || inner.0.is_null() || inner.0 as isize as i64 == top {
            return;
        }
        SetWindowSubclass(top as isize as HWND, Some(on_msg), ID, inner.0 as usize);
    });
}
#[cfg(not(windows))]
pub fn sync_resize(_w: &WebviewWindow) {}

fn hide_note(app: &AppHandle, w: &WebviewWindow) {
    memory_low(w, true);
    hide_deep_later(w);
    let _ = w.hide();
    sync_sticker(app, w.label());
    bubble_away(app, w.label());
}

fn close_stack(app: &AppHandle, id: &str) {
    let Some(s) = stack_of(app, id) else { return };
    if !wm().closing.insert(s.id.clone()) {
        return;
    }
    for m in s.memos.iter().filter(|m| *m != id) {
        if let Some(w) = note_win(app, m) {
            let _ = w.close();
        }
    }
    later(1000, move || {
        wm().closing.remove(&s.id);
    });
}

// memos::closed_note 다음에 온다 (먼저 단 것이 먼저)
fn destroyed(app: &AppHandle, id: &str, label: &str) {
    let (sticker, pin) = {
        let mut g = wm();
        g.closing_notes.remove(label);
        g.inking.remove(label);
        g.reveal.remove(label);
        g.settle.remove(label);
        g.loaded.remove(&format!("bubble-{label}"));
        (g.stickers.remove(label).and_then(|s| s.win), g.pinned.remove(label))
    };
    for l in sticker.into_iter().chain([format!("bubble-{label}")]) {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.destroy();
        }
    }
    if let Some(h) = pin {
        pin_send(app, "unpin", h, 0); // 같은 번호를 다른 앱 창이 받아도 건드리지 않게
    }
    {
        let mut g = wm();
        g.hidden_at.remove(label);
    }
    forget_if_gone(app, id);
    refresh_top_watch(app);
}

/// 비워서 치운 메모 · 휴지통으로 간 메모는 스택에서도 뺀다 — 창이 없어질 때, 그리고 닫은 메모 정리(finalize)가 끝난 뒤에
///   (정리는 일꾼 스레드라 창이 없어질 때는 아직 남아 있을 수 있다)
pub fn forget_if_gone(app: &AppHandle, id: &str) {
    let gone = state(app).vault.lock().unwrap().as_ref().is_some_and(|v| v.entry(id).is_none());
    if gone {
        if let Some(r) = stacks(app, |s| s.stack_of(id).is_some().then(|| s.remove(id))).flatten() {
            push_stack_to(app, &r.rest.unwrap_or_default());
        }
    }
}

/// 예비 창으로 되돌려 쓰는 횟수 — 창마다 단 이벤트 처리가 쓸 때마다 늘어나 이만큼 쓰면 없앤다
const RECYCLE_MAX: u32 = 5;

/// 닫은 메모 창을 거둔다: 예비 창 자리가 있으면 닫힌 것처럼 정리한 뒤 예비 창으로 되돌려 다음 메모가 바로 쓰게 (웹뷰를 다시 만들지 않는다 —
///   만들기가 여는 시간의 대부분), 없으면 없앤다
pub fn retire_note(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let reuse = {
        let mut g = wm();
        let n = g.recycled.entry(label.to_string()).or_default();
        *n += 1;
        *n <= RECYCLE_MAX
    };
    match note_id(app, label).filter(|_| reuse && !crate::os::quitting() && !crate::ipc::smoke() && crate::memos::spare_room(app)) {
        Some(id) => {
            crate::memos::closed_note(app, &id, label);
            crate::os::note_closed(app, &id);
            destroyed(app, &id, label);
            crate::memos::recycle_spare(&w);
        }
        None => {
            wm().recycled.remove(label);
            let _ = w.destroy();
        }
    }
}

/// 오래(DISCARD_AFTER) 숨은 스택 탭은 거둔다 (브라우저의 탭 버리기) — 숨은 탭도 하나에 수십 MB.
///   보이는 탭의 바로 옆(Ctrl+Tab 으로 갈 곳) · 빈 메모(거두면 정리가 휴지통으로 보낸다)는 남긴다. 다시 누르면 예비 창으로 되살린다 (show_tab)
const DISCARD_AFTER: Duration = Duration::from_secs(10 * 60);
pub fn discard_tick(app: &AppHandle) {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    if !crate::memos::perf_on(app, "perfDiscard") {
        return;
    }
    {
        let mut last = LAST.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
            return;
        }
        *last = Some(Instant::now());
    }
    let labels: Vec<(String, String)> = state(app).note_labels.lock().unwrap().iter().map(|(i, l)| (i.clone(), l.clone())).collect();
    for (id, label) in labels {
        let Some(w) = app.get_webview_window(&label).filter(|w| !is_shown(w) && !is_closing(&label)) else { continue };
        let Some(s) = stack_of(app, &id) else { continue };
        let Some(active) = s.active.clone().filter(|a| *a != id) else { continue };
        let since = *wm().hidden_at.entry(label.clone()).or_insert_with(Instant::now);
        if since.elapsed() < DISCARD_AFTER {
            continue;
        }
        let (n, i, a) = (s.memos.len(), s.memos.iter().position(|m| *m == id), s.memos.iter().position(|m| *m == active));
        if let (Some(i), Some(a)) = (i, a) {
            if (i + 1) % n == a || (a + 1) % n == i {
                continue; // 바로 옆 탭
            }
        }
        let blank = state(app).vault.lock().unwrap().as_ref().and_then(|v| v.entry(&id).map(|e| e.body.trim().is_empty())).unwrap_or(true);
        if blank {
            continue;
        }
        // 남은 글을 동기 저장한 뒤 (답이 없어도 3초 뒤) 거둔다 — 닫기와 달리 스택은 그대로
        wm().closing_notes.insert(label.clone());
        let once = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let go = {
            let (app, label) = (app.clone(), label.clone());
            move || {
                if !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    let (app, label) = (app.clone(), label.clone());
                    std::thread::spawn(move || retire_note(&app, &label));
                }
            }
        };
        later(3000, go.clone());
        let fail = go.clone();
        if w.eval_with_callback("window.mkFlushSync?.()", move |_| go()).is_err() {
            fail();
        }
    }
}

/// 메모 창이 움직였다: 사람이 끄는 중이면 아래 메모와 합칠지 보고, 멈추면 스택 탭 모두 그 자리로
fn moving(app: &AppHandle, id: &str, label: &str, moved: bool) {
    let Some(w) = app.get_webview_window(label) else { return };
    // 포커스가 있는 창이 움직이면 사람이 끄는 것 (프로그램이 옮기는 창은 대개 포커스가 없다)
    // shortcut: Tauri 에는 Electron 의 will-move · moved(끌기 시작 · 끝)가 없어 포커스와 300ms 멈춤으로 가린다 — 틀리는 때가 보이면 WM_ENTERSIZEMOVE 를 windows-rs 로
    if moved && w.is_focused().unwrap_or(false) && !wm().inking.contains(label) {
        if let Some(p) = cursor(app) {
            let old = {
                let mut g = wm();
                if g.window_drag.as_ref().is_some_and(|(i, _)| i == id) {
                    None
                } else {
                    g.window_drag.replace((id.to_string(), Hover::default()))
                }
            };
            if let Some((_, h)) = old {
                clear_hover(app, &h);
            }
            track_hover(app, Who::Window, p, id);
        }
    }
    // 끄는 동안 이벤트가 줄줄이 온다 — 기다리는 스레드는 창마다 하나만 두고, 300ms 동안 더 오지 않으면 (예전: 이벤트마다 스레드를 새로 띄웠다)
    let gen = next_seq();
    if wm().settle.insert(label.to_string(), gen).is_some() {
        return;
    }
    let (app, id, label) = (app.clone(), id.to_string(), label.to_string());
    std::thread::spawn(move || {
        let mut seen = gen;
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let mut g = wm();
            match g.settle.get(&label).copied() {
                None => return, // 창이 없어졌다
                Some(now) if now != seen => seen = now,
                Some(_) => {
                    g.settle.remove(&label);
                    break;
                }
            }
        }
        end_window_drag(&app, &id);
        // 숨은 탭 창이 따라 움직이며 또 부르지 않게 보이는 창만
        let Some(w) = app.get_webview_window(&label).filter(is_shown) else { return };
        if let (Some(s), Some(b)) = (stack_of(&app, &id), bounds(&w)) {
            for m in s.memos.iter().filter(|m| **m != id) {
                if let Some(o) = note_win(&app, m).filter(|o| !is_shown(o)) {
                    set_bounds(&o, b);
                }
            }
            remember_bounds(&app, &s.memos, b);
        }
    });
}

fn end_window_drag(app: &AppHandle, id: &str) {
    let d = {
        let mut g = wm();
        if g.window_drag.as_ref().is_none_or(|(i, _)| i != id) {
            return;
        }
        g.window_drag.take()
    };
    let Some((_, h)) = d else { return };
    clear_hover(app, &h);
    if let (true, Some(t)) = (h.armed, &h.target) {
        stack_into(app, t, id);
    }
}

// ---------- 합칠 메모 찾기 ----------

fn hover(g: &mut Wm, who: Who) -> Option<&mut Hover> {
    match who {
        Who::Drag => g.drag.as_mut().map(|d| &mut d.hover),
        Who::Window => g.window_drag.as_mut().map(|w| &mut w.1),
        Who::Tear => g.tear.as_mut().map(|t| &mut t.hover),
    }
}

/// 이 점 아래의 다른 메모 창 (끄는 메모 · 그 스택은 빼고)
fn stack_target_at(app: &AppHandle, p: (f64, f64), exclude: &str) -> Option<String> {
    let own = stack_of(app, exclude).map_or_else(|| vec![exclude.to_string()], |s| s.memos);
    let labels: Vec<(String, String)> = state(app).note_labels.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let (inking, pinned) = {
        let g = wm();
        (g.inking.clone(), g.pinned.clone())
    };
    // 끄는 메모도 테이프면 테이프 메모끼리 합칠 수 있다. 보통 메모는 다른 앱 창에 가려 안 보이는 테이프 메모에 합치지 않는다
    let mover_taped = note_label(app, exclude).is_some_and(|l| pinned.contains_key(&l));
    labels.into_iter().find_map(|(mid, l)| {
        if own.contains(&mid) || inking.contains(&l) {
            return None;
        }
        let w = app.get_webview_window(&l).filter(on_screen)?;
        if pinned.contains_key(&l) && !mover_taped && !w.is_focused().unwrap_or(false) {
            return None;
        }
        bounds(&w).filter(|&b| is_inside(p, b)).map(|_| mid)
    })
}

fn set_stack_hover(app: &AppHandle, id: Option<&String>, on: bool) {
    if let Some(l) = id.and_then(|id| note_label(app, id)) {
        emit(app, &l, "stack:hover", on.into());
    }
}

fn on_armed(app: &AppHandle, who: Who, armed: bool) {
    // shortcut: 떼어 끄는 탭 창의 반투명(합쳐질 때 더 흐리게)은 아직 — Tauri 창에는 투명도가 없다. windows-rs 로 SetLayeredWindowAttributes 를 쓸 때
    if who == Who::Drag {
        emit(app, "ghost", "ghost:mode", json!({ "stack": armed }));
    }
}

fn track_hover(app: &AppHandle, who: Who, p: (f64, f64), exclude: &str) {
    let target = stack_target_at(app, p, exclude);
    let gen = next_seq();
    let (old, was_armed) = {
        let mut g = wm();
        let Some(h) = hover(&mut g, who) else { return };
        if h.target == target {
            return;
        }
        h.gen = gen;
        (std::mem::replace(&mut h.target, target.clone()), std::mem::take(&mut h.armed))
    };
    set_stack_hover(app, old.as_ref(), false);
    if was_armed {
        on_armed(app, who, false);
    }
    let Some(target) = target else { return };
    let app = app.clone();
    later(STACK_DWELL.as_millis() as u64, move || {
        let armed = match hover(&mut wm(), who) {
            Some(h) if h.gen == gen => {
                h.armed = true;
                true
            }
            _ => false,
        };
        if armed {
            set_stack_hover(&app, Some(&target), true);
            on_armed(&app, who, true);
        }
    });
}

fn clear_hover(app: &AppHandle, h: &Hover) {
    set_stack_hover(app, h.target.as_ref(), false);
}

// ---------- 탭 ----------

/// 숨겨 만든 메모 창 — 메모를 다 그리면(win:painted, 늦어도 1.5초) then
fn create_hidden(app: &AppHandle, id: &str, b: Option<Rect>, then: impl FnOnce(&AppHandle) + Send + 'static) -> Option<WebviewWindow> {
    crate::memos::create_note_window(app, id, b, false, Some(Box::new(then))).ok()
}

/// 이 메모 창이 메모를 다 그리면(win:painted, 늦어도 1.5초) then
pub fn when_painted(app: &AppHandle, label: &str, then: Action) {
    wm().reveal.insert(label.to_string(), then);
    let (app, label) = (app.clone(), label.to_string());
    later(1500, move || painted(&app, &label));
}

/// 메모 창이 메모를 그렸다 (win:painted)
pub fn painted(app: &AppHandle, label: &str) {
    let f = wm().reveal.remove(label);
    if let Some(f) = f {
        f(app);
    }
}

fn visible_stack_win(app: &AppHandle, s: &Stack, except: Option<&str>) -> Option<WebviewWindow> {
    s.memos.iter().filter(|m| Some(m.as_str()) != except).filter_map(|m| note_win(app, m)).find(is_shown)
}

/// 스택의 이 탭을 보인다 (처음 여는 탭은 숨겨 만들고 다 그린 뒤에) — Electron showTab
pub fn show_tab(app: &AppHandle, id: &str, at: Option<Rect>, focus: bool) -> bool {
    let Some(s) = stacks(app, |s| s.set_active(id)).flatten() else { return false };
    let b = at.or_else(|| visible_stack_win(app, &s, Some(id)).and_then(|w| bounds(&w))).or_else(|| saved_bounds(app, id));
    // 탭 모두 같은 층으로 (옮겨 온 탭 하나만 적혀 있던 때 등)
    let layer = stack_layer(app, &s.memos);
    if s.memos.iter().any(|m| layer_of(app, m) != layer) {
        for m in &s.memos {
            set_layer_flags(app, m, layer);
        }
        state(app).save_settings();
    }
    let ok = if note_win(app, id).is_some() {
        reveal_tab(app, id, b, focus);
        true
    } else {
        let id2 = id.to_string();
        create_hidden(app, id, b, move |app| reveal_tab(app, &id2, b, focus)).is_some()
    };
    push_stack_to(app, &s.memos);
    crate::memos::push_list_soon(app);
    prewarm(app, id);
    ok
}

/// 미리 만들어 둘 탭 창 수 (보이는 탭 빼고) — 넘는 탭은 누를 때 만든다 (창마다 웹뷰 메모리)
const PREWARM_MAX: usize = 2; // 숨은 탭도 하나에 수십 MB — 바로 옆 둘만 (그 밖은 누르면 예비 창으로, 오래 숨은 탭은 discard_tick 이 거둔다)

/// 스택의 다른 탭들을 숨긴 창으로 미리 만들어 둔다 (Electron prewarmStack) — 가까운 탭(Ctrl+Tab 으로 갈 곳)부터
///   바꿀 때 창을 새로 만들며 기다리지 않게. PREWARM_MAX 개까지, 하나씩 조금 쉬었다가 (보이는 탭을 그리는 데 방해되지 않게)
///   (예전: 앞 · 뒤 둘만 — 그 밖의 탭은 누르면 창을 새로 만들고 다 그릴 때까지 기다렸다)
fn prewarm(app: &AppHandle, id: &str) {
    let (app, id) = (app.clone(), id.to_string());
    later(400, move || {
        // 그사이 다른 탭으로 바꿨거나 스택을 닫았으면 그만
        let Some(s) = stack_of(&app, &id).filter(|s| s.active.as_deref() == Some(id.as_str())) else { return };
        let Some(b) = visible_stack_win(&app, &s, None).and_then(|w| bounds(&w)) else { return };
        let n = s.memos.len();
        let Some(i) = s.memos.iter().position(|m| *m == id) else { return };
        let warm = s.memos.iter().filter(|m| **m != id && note_win(&app, m).is_some()).count();
        if warm >= PREWARM_MAX {
            return;
        }
        // 오른쪽 · 왼쪽 번갈아 가까운 차례로
        let near = (1..n).flat_map(|k| [(i + k) % n, (i + n - k) % n]).map(|j| s.memos[j].clone());
        let exists = |m: &str| state(&app).vault.lock().unwrap().as_ref().is_some_and(|v| v.entry(m).is_some());
        let Some(m) = near.into_iter().find(|m| *m != id && note_win(&app, m).is_none() && exists(m)) else { return };
        // 예비 창은 남겨 둔다 (지금 열려는 다른 메모가 가져가게)
        if let Ok(w) = crate::memos::create_note_window(&app, &m, Some(b), false, None) {
            memory_low(&w, true);
            hide_deep_later(&w);
            prewarm(&app, &id);
        }
    });
}

// shortcut: Electron 은 다른 색 탭은 겹쳐 흐려지게 바꾼다. 여기서는 새 탭을 보이고 30ms 뒤 옛 탭을 숨긴다, 깜빡임이 보이면 투명도를 옮길 때
fn reveal_tab(app: &AppHandle, id: &str, b: Option<Rect>, focus: bool) {
    let Some(win) = note_win(app, id) else { return };
    let now = stack_of(app, id);
    if now.as_ref().is_some_and(|s| s.active.as_deref() != Some(id)) {
        return;
    }
    let _ = win.unminimize();
    let shown_win = now.as_ref().and_then(|s| visible_stack_win(app, s, Some(id)));
    if let Some(t) = shown_win.as_ref().and_then(bounds).or(b) {
        // 같은 자리 · 크기면 그대로 (다시 맞추면 한 번 출렁인다)
        if bounds(&win) != Some(t) {
            set_bounds(&win, t);
        }
    }
    emit(app, win.label(), "stack:activating", Value::Null);
    // 층은 보이기 전에, 스티커는 보이던 탭에서 넘겨받는다 (다시 만들지 않게)
    shown(app, id, &win);
    if let Some(from) = &shown_win {
        hand_over_sticker(app, from, &win);
    }
    show_note_win(&win);
    if focus {
        let _ = win.set_focus();
    }
    sync_sticker(app, win.label()); // 넘겨받지 못했으면 이제 띄운다
    emit(app, win.label(), "memo:layer", layer_state(app, id));
    if let Some(s) = &shown_win {
        emit(app, s.label(), "stack:leaving", Value::Null);
    }
    let (app, id) = (app.clone(), id.to_string());
    later(30, move || {
        let Some(s) = stack_of(&app, &id).filter(|s| s.active.as_deref() == Some(id.as_str())) else { return };
        for m in s.memos.iter().filter(|m| **m != id) {
            if let Some(w) = note_win(&app, m).filter(is_shown) {
                hide_note(&app, &w);
            }
        }
    });
}

/// moving 메모를 target 메모 창의 스택으로 (target 이 혼자면 새 스택) — 받는 쪽 자리 · 층을 따른다
fn stack_into(app: &AppHandle, target: &str, moving: &str) -> bool {
    let Some(target_win) = note_win(app, target) else { return false };
    let exists = state(app).vault.lock().unwrap().as_ref().is_some_and(|v| v.entry(moving).is_some());
    let Some(b) = bounds(&target_win).filter(|_| target != moving && exists) else { return false };
    let layer = stack_layer(app, &stack_of(app, target).map_or_else(|| vec![target.to_string()], |s| s.memos));
    let Some(Some(s)) = stacks(app, |s| s.merge(target, &[moving.to_string()], Some(moving))) else { return false };
    for m in &s.memos {
        set_layer_flags(app, m, layer);
        if m != moving && m != target {
            if let Some(w) = note_win(app, m).filter(is_shown) {
                hide_note(app, &w);
            }
        }
    }
    remember_bounds(app, &s.memos, b);
    let hide_target = {
        let app = app.clone();
        move || {
            if let Some(w) = app.get_webview_window(target_win.label()) {
                hide_note(&app, &w);
            }
        }
    };
    match note_win(app, moving) {
        Some(w) => {
            let _ = w.unminimize();
            set_bounds(&w, b);
            show_note_win(&w);
            let _ = w.set_focus();
            shown(app, moving, &w);
            emit(app, w.label(), "memo:layer", layer_state(app, moving));
            later(230, hide_target);
        }
        None => {
            let moving = moving.to_string();
            create_hidden(app, &moving.clone(), Some(b), move |app| {
                if let Some(w) = note_win(app, &moving) {
                    show_note_win(&w);
                    let _ = w.set_focus();
                    shown(app, &moving, &w);
                }
                later(30, hide_target);
            });
        }
    }
    push_stack_to(app, &s.memos);
    crate::memos::push_list_soon(app);
    true
}

/// 스택에서 뺀다 — mode: close(창도 닫음) · detach(옆에 따로) · tear(떼어 끄는 중) · none(휴지통)
pub fn remove_from_stack(app: &AppHandle, id: &str, mode: &str) -> bool {
    let Some(s) = stack_of(app, id) else { return false };
    let win = note_win(app, id);
    let was_visible = win.as_ref().is_some_and(is_shown);
    let b = if was_visible { win.as_ref().and_then(bounds) } else { visible_stack_win(app, &s, None).and_then(|w| bounds(&w)) }.or_else(|| saved_bounds(app, id));
    let Some(r) = stacks(app, |s| s.remove(id)) else { return false };
    let focus = mode != "tear";
    if let (true, Some(next)) = (was_visible, r.next_active.clone()) {
        if r.stack.is_some() {
            show_tab(app, &next, b, focus);
        } else {
            let reveal = move |app: &AppHandle| {
                if let Some(w) = note_win(app, &next) {
                    if let Some(b) = b {
                        set_bounds(&w, b);
                    }
                    show_note_win(&w);
                    if focus {
                        let _ = w.set_focus();
                    }
                    shown(app, &next, &w);
                }
            };
            if note_win(app, r.next_active.as_deref().unwrap_or_default()).is_some() {
                reveal(app);
            } else {
                create_hidden(app, r.next_active.as_deref().unwrap_or_default(), b, reveal);
            }
        }
    }
    let mut ids = r.rest.unwrap_or_default();
    ids.push(id.to_string());
    push_stack_to(app, &ids);
    match mode {
        "close" => {
            if let Some(w) = &win {
                let _ = w.close();
            }
        }
        // 화면이 저장 · 태그를 마저 하고 win:close 로 닫는다 — 그동안 숨겨 두고 닫는 중으로 (다시 열면 새 창)
        "hide" => {
            if let Some(w) = &win {
                hide_closing(app, w);
            }
        }
        "detach" => {
            let b = b.map(|[x, y, w, h]| [x + 28.0, y + 28.0, w, h]);
            if let Some(b) = b {
                remember_bounds(app, &[id.to_string()], b);
            }
            match win {
                Some(w) => {
                    if let Some(b) = b {
                        set_bounds(&w, b);
                    }
                    show_note_win(&w);
                    let _ = w.set_focus();
                    shown(app, id, &w);
                }
                None => {
                    if let Ok(w) = crate::memos::create_note_window(app, id, b, true, None) {
                        shown(app, id, &w);
                    }
                }
            }
        }
        _ => {}
    }
    crate::memos::push_list_soon(app);
    true
}

/// 윗막대 + · 탭 메뉴: 보이는 탭 바로 뒤에 새 메모 (같은 색)
fn new_tab_after(app: &AppHandle, from: &str) -> Value {
    let state = state(app);
    let id = {
        let mut g = state.vault.lock().unwrap();
        let Some(v) = g.as_mut() else { return Value::Null };
        let Some(color) = v.entry(from).map(|e| e.meta.color.clone()) else { return Value::Null };
        v.create(Some(&color), None, "")
    };
    if stacks(app, |s| s.add_after(from, &id)).is_none() {
        return Value::Null;
    }
    show_tab(app, &id, None, true);
    id.into()
}

fn tear_start(app: &AppHandle, id: &str, offset: &Value, p: (f64, f64)) -> bool {
    let Some(s) = stack_of(app, id) else { return false };
    if wm().tear.is_some() {
        return false;
    }
    let size = visible_stack_win(app, &s, None).or_else(|| note_win(app, id)).and_then(|w| bounds(&w)).or_else(|| saved_bounds(app, id)).map_or(DEFAULT_NOTE_SIZE, |b| (b[2], b[3]));
    let ox = offset["x"].as_f64().unwrap_or(60.0).round().min(size.0 - 40.0).max(12.0);
    let oy = offset["y"].as_f64().unwrap_or(17.0).round();
    let b = [(p.0 - ox).round(), (p.1 - oy).round(), size.0, size.1];
    remove_from_stack(app, id, "tear");
    // shortcut: Electron 은 떼어 낸 창을 포커스 없이(showInactive) 띄운다 — Tauri 의 show 는 창을 앞으로 가져온다. 끄는 손이 끊기면 windows-rs SW_SHOWNOACTIVATE 로
    let label = match note_win(app, id) {
        Some(w) => {
            set_bounds(&w, b);
            if !is_shown(&w) {
                show_note_win(&w);
                shown(app, id, &w);
            }
            w.label().to_string()
        }
        None => {
            let id2 = id.to_string();
            let reveal = move |app: &AppHandle| {
                if let Some(w) = note_win(app, &id2).filter(|w| !is_shown(w)) {
                    show_note_win(&w);
                    shown(app, &id2, &w);
                }
            };
            match create_hidden(app, id, Some(b), reveal) {
                Some(w) => w.label().to_string(),
                None => return false,
            }
        }
    };
    wm().tear = Some(Tear { id: id.into(), label, off: (ox, oy), hover: Hover::default() });
    true
}

fn tear_move(app: &AppHandle, p: (f64, f64)) {
    let Some((id, label, off)) = wm().tear.as_ref().map(|t| (t.id.clone(), t.label.clone(), t.off)) else { return };
    let Some(w) = app.get_webview_window(&label) else { return };
    let _ = w.set_position(LogicalPosition::new((p.0 - off.0).round(), (p.1 - off.1).round()));
    track_hover(app, Who::Tear, p, &id);
}

fn tear_end(app: &AppHandle, p: Option<(f64, f64)>) -> bool {
    if let Some(p) = p {
        tear_move(app, p);
    }
    let Some(t) = wm().tear.take() else { return false };
    clear_hover(app, &t.hover);
    let Some(w) = app.get_webview_window(&t.label) else { return false };
    if let (true, Some(target)) = (t.hover.armed, &t.hover.target) {
        return stack_into(app, target, &t.id);
    }
    if let Some(b) = bounds(&w) {
        remember_bounds(app, &[t.id], b);
    }
    let _ = w.set_focus();
    crate::memos::push_list_soon(app);
    true
}

// ---------- 탭 메뉴 (네이티브) ----------

fn menu_item(app: &AppHandle, text: &str, act: Option<Action>) -> tauri::Result<MenuItem<Wry>> {
    let enabled = act.is_some();
    let id = match act {
        Some(a) => {
            let mut g = wm();
            g.seq += 1;
            let id = format!("mk-menu-{}", g.seq);
            g.menu.insert(id.clone(), a);
            id
        }
        None => "mk-menu-off".into(),
    };
    MenuItem::with_id(app, id, text, enabled, None::<&str>)
}

/// 이 창을 합칠 수 있는 다른 메모 창들 (스택이면 하나로)
fn join_items(app: &AppHandle, me: &str) -> tauri::Result<Vec<MenuItem<Wry>>> {
    let mine = stack_of(app, me).map(|s| s.memos).unwrap_or_default();
    let labels: Vec<(String, String)> = state(app).note_labels.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut seen = HashSet::new();
    let mut items = vec![];
    for (m, l) in labels {
        if m == me || mine.contains(&m) || !app.get_webview_window(&l).is_some_and(|w| is_shown(&w)) {
            continue;
        }
        let s = stack_of(app, &m);
        if !seen.insert(s.as_ref().map_or(m.clone(), |s| s.memos[0].clone())) {
            continue;
        }
        let title = state(app).vault.lock().unwrap().as_ref().and_then(|v| v.entry(&m).map(|e| memoking_core::body::extract_title(&e.body))).filter(|t| !t.is_empty()).unwrap_or_else(|| "제목 없음".into());
        let count = s.map_or(1, |s| s.memos.len());
        let text = if count > 1 { format!("{title} (탭 {count}개)") } else { title };
        let me = me.to_string();
        items.push(menu_item(app, &text, Some(Box::new(move |app| {
            stack_into(app, &m, &me);
        })))?);
    }
    if items.is_empty() {
        items.push(menu_item(app, "합칠 수 있는 다른 메모 창이 없어요", None)?);
    }
    Ok(items)
}

fn popup(app: &AppHandle, label: &str, build: impl FnOnce() -> tauri::Result<Menu<Wry>>) -> Result<Value, String> {
    // 메뉴를 고르면 (Tauri 는 메뉴 이벤트를 앱 하나로 받는다) — 창을 만들 수 있어 다른 스레드에서
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        app.on_menu_event(|app, e| {
            let act = wm().menu.remove(e.id().as_ref());
            if let Some(act) = act {
                let app = app.clone();
                std::thread::spawn(move || act(&app));
            }
        });
    });
    wm().menu.clear();
    let menu = build().map_err(|e| e.to_string())?;
    if let Some(w) = app.get_webview_window(label) {
        w.popup_menu(&menu).map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}

fn stack_menu(app: &AppHandle, me: &str) -> tauri::Result<Menu<Wry>> {
    let act = |f: fn(&AppHandle, &str)| -> Option<Action> {
        let me = me.to_string();
        Some(Box::new(move |app| f(app, &me)))
    };
    let new = menu_item(app, "오른쪽에 새 탭", act(|app, me| {
        new_tab_after(app, me);
    }))?;
    let joins = join_items(app, me)?;
    let joins: Vec<&dyn IsMenuItem<Wry>> = joins.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let join = Submenu::with_items(app, "다른 창과 합치기", true, &joins)?;
    let detach = menu_item(app, "따로 떼어 보기", act(|app, me| {
        remove_from_stack(app, me, "detach");
    }))?;
    let close = menu_item(app, "탭 닫기", act(|app, me| {
        remove_from_stack(app, me, "close");
    }))?;
    Menu::with_items(app, &[&new, &join, &PredefinedMenuItem::separator(app)?, &detach, &close])
}

// ---------- 왕관(늘 위) · 테이프(바탕화면 층) ----------
// 메모 창 윗막대의 왕관 · 테이프 단추로 고르고, 창 위 가장자리에 붙은 스티커를 누르면 뗀다. 둘은 함께 붙지 않는다
//   (settings.onTop / settings.onBottom — 스택은 탭 모두 같게, 다시 켜도 그대로)

fn layer_of(app: &AppHandle, id: &str) -> Option<&'static str> {
    let st = state(app);
    if st.setting("onTop")[id] == true {
        Some("top")
    } else if st.setting("onBottom")[id] == true {
        Some("bottom")
    } else {
        None
    }
}

fn set_layer_flags(app: &AppHandle, id: &str, layer: Option<&str>) {
    let st = state(app);
    let mut s = st.settings.lock().unwrap();
    for (key, mine) in [("onTop", "top"), ("onBottom", "bottom")] {
        let m = s.entry(key).or_insert_with(|| json!({}));
        if !m.is_object() {
            *m = json!({});
        }
        let m = m.as_object_mut().unwrap();
        if layer == Some(mine) {
            m.insert(id.into(), true.into());
        } else {
            m.remove(id);
        }
    }
}

/// 스택의 층: 탭 하나라도 왕관이면 왕관, 아니면 테이프
fn stack_layer(app: &AppHandle, memos: &[String]) -> Option<&'static str> {
    let layers: Vec<_> = memos.iter().map(|m| layer_of(app, m)).collect();
    layers.iter().find(|l| **l == Some("top")).or_else(|| layers.iter().find(|l| **l == Some("bottom"))).copied().flatten()
}

/// 바탕화면 층에 붙일 수 있는 PC 인가 (Windows · 도우미가 막히지 않음). 점검(smoke)은 붙이는 흉내만
fn can_tape() -> bool {
    (cfg!(windows) && !wm().pin.failed) || crate::ipc::smoke()
}

/// 메모 창이 읽는 층 { top, bottom, canTape }
pub fn layer_state(app: &AppHandle, id: &str) -> Value {
    let layer = layer_of(app, id);
    json!({ "top": layer == Some("top"), "bottom": layer == Some("bottom") && can_tape(), "canTape": can_tape() })
}

/// 창을 그 메모의 층에 맞춘다 (늘 위 · 바탕화면 층 · 스티커)
fn apply_layer(app: &AppHandle, id: &str, w: &WebviewWindow, animate: bool) {
    let layer = layer_of(app, id);
    let bottom = layer == Some("bottom") && can_tape();
    if layer == Some("top") {
        let _ = w.set_always_on_top(true);
    } else if w.is_always_on_top().unwrap_or(false) {
        let _ = w.set_always_on_top(false); // 늘 위가 아니던 창에 끄기를 부르면 다른 앱 위로 올라온다
    }
    pin_to_desktop(app, w, bottom);
    set_sticker(app, w.label(), layer == Some("top") || bottom, if bottom { "tape" } else { "crown" }, animate);
    refresh_top_watch(app);
}

/// 왕관 · 테이프 · 없음 — 스택이면 탭 모두. 그 메모의 창만 붙고 떼어지는 모습을 보인다. note: 메모 창 상태 줄에 띄울 말
fn set_note_layer(app: &AppHandle, id: &str, layer: Option<&str>, note: &str) -> Value {
    let layer = layer.filter(|l| *l != "bottom" || can_tape());
    let members = stack_of(app, id).map_or_else(|| vec![id.to_string()], |s| s.memos);
    for m in &members {
        set_layer_flags(app, m, layer);
    }
    state(app).save_settings();
    for m in &members {
        let Some(w) = note_win(app, m) else { continue };
        apply_layer(app, m, &w, m == id);
        let mut state = layer_state(app, m);
        if !note.is_empty() {
            state["note"] = note.into();
        }
        emit(app, w.label(), "memo:layer", state);
    }
    crate::memos::push_list_soon(app); // 목록 카드의 바탕화면 표시
    layer_state(app, id)
}

/// 목록에서 고른 메모가 테이프로 바탕화면에 붙어 있으면 뗀다 (붙인 채로는 다른 창 뒤라 불러도 보이지 않는다)
pub fn untape_from_list(app: &AppHandle, id: &str) {
    let layer = stack_of(app, id).map_or_else(|| layer_of(app, id), |s| stack_layer(app, &s.memos));
    if layer == Some("bottom") && can_tape() {
        set_note_layer(app, id, None, "테이프가 떨어졌어요. 다시 붙이려면 위의 테이프 버튼을 눌러 주세요");
    }
}

fn hwnd(w: &WebviewWindow) -> i64 {
    #[cfg(windows)]
    return w.hwnd().map_or(0, |h| h.0 as isize as i64);
    #[cfg(not(windows))]
    {
        let _ = w;
        0
    }
}

fn pin_to_desktop(app: &AppHandle, w: &WebviewWindow, on: bool) {
    let label = w.label().to_string();
    let was = wm().pinned.get(&label).copied();
    match (on, was) {
        (true, None) => {
            let h = hwnd(w);
            if h == 0 && !crate::ipc::smoke() {
                return;
            }
            wm().pinned.insert(label.clone(), if h == 0 { -1 } else { h });
            if h > 0 {
                let _ = w.set_skip_taskbar(true); // 바탕화면의 일부처럼 — 작업 표시줄에는 없다
                pin_send(app, "pin", h, 0);
                sync_tape_pair(app, &label);
            }
        }
        (false, Some(h)) => {
            wm().pinned.remove(&label);
            let _ = w.set_skip_taskbar(false);
            pin_send(app, "unpin", h, 0);
            // 주인이 되돌려진 뒤에야 작업 표시줄 단추가 다시 붙는다 — 조금 뒤 한 번 더
            let app = app.clone();
            later(400, move || {
                if let Some(w) = app.get_webview_window(&label).filter(|_| !wm().pinned.contains_key(&label)) {
                    let _ = w.set_skip_taskbar(false);
                }
            });
        }
        _ => {}
    }
}

/// 바탕화면에 붙인 메모 창과 그 테이프 창을 도우미에 짝지어 둔다 (맨 아래로 보낼 때 테이프도 늘 메모 바로 위에)
fn sync_tape_pair(app: &AppHandle, owner: &str) {
    let (h, tape, paired) = {
        let g = wm();
        let Some(&h) = g.pinned.get(owner).filter(|h| **h > 0) else { return };
        let tape = g.stickers.get(owner).filter(|s| s.kind == "tape").and_then(|s| s.win.clone());
        (h, tape, g.pin.pairs.contains_key(&h))
    };
    let tape = tape.and_then(|l| app.get_webview_window(&l)).map_or(0, |w| hwnd(&w));
    if tape != 0 || paired {
        pin_send(app, "pair", h, tape);
    }
}

/// 도우미에 한 줄 ("pin <hwnd>" · "unpin" · "bottom" · "pair <hwnd> <테이프 hwnd>")
fn pin_send(app: &AppHandle, kind: &str, h: i64, companion: i64) {
    if h <= 0 || !cfg!(windows) {
        return;
    }
    let line = if kind == "pair" { format!("pair {h} {companion}") } else { format!("{kind} {h}") };
    let mut g = wm();
    if g.pin.failed {
        return;
    }
    match kind {
        "pin" => {
            g.pin.pinned.insert(h);
        }
        "unpin" => {
            g.pin.pinned.remove(&h);
            g.pin.pairs.remove(&h);
        }
        "pair" if companion != 0 => {
            g.pin.pairs.insert(h, companion);
        }
        "pair" => {
            g.pin.pairs.remove(&h);
        }
        _ => {}
    }
    if g.pin.stdin.is_none() && !start_pin_helper(app, &mut g) {
        drop(g);
        pin_failed(app);
        return;
    }
    if let Some(s) = g.pin.stdin.as_mut() {
        let _ = writeln!(s, "{line}").and_then(|()| s.flush());
    }
}

/// PowerShell 을 Electron 과 같게: 프로필 없이 · 묻지 않고 · 작업 폴더는 임시 폴더 · 창 없이
// shortcut: Electron 의 PowerShell + C# 도우미를 그대로 띄운다 — 켤 때 1~2초 걸린다. windows-rs 로 SetWindowLongPtr · SetWinEventHook 을 직접 부를 때 없애기
fn powershell(script: &str) -> std::process::Command {
    let mut c = std::process::Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).current_dir(std::env::temp_dir());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn start_pin_helper(app: &AppHandle, g: &mut Wm) -> bool {
    let child = powershell(include_str!("../desktop-pin.ps1")).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn();
    let Ok(mut child) = child else { return false }; // PowerShell 이 없으면 보통 창으로만
    let mut stdin = child.stdin.take().unwrap();
    // 다시 뜬 도우미는 아무것도 모른다 — 붙여 둔 창을 다시 붙인다
    for h in &g.pin.pinned {
        let _ = writeln!(stdin, "pin {h}");
    }
    for (h, c) in &g.pin.pairs {
        let _ = writeln!(stdin, "pair {h} {c}");
    }
    g.pin.stdin = Some(stdin);
    g.pin.gen += 1;
    let (gen, out, app, started) = (g.pin.gen, child.stdout.take().unwrap(), app.clone(), Instant::now());
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            if line.starts_with("err ") {
                elog!("메모 창을 바탕화면 층에 붙이지 못했어요 {line}");
            }
        }
        let _ = child.wait();
        // 도우미가 끝났다 — 다음 명령 때 다시 띄운다. 띄우자마자 두 번 죽으면(Add-Type 이 막힌 PC 등) 그만
        let fail = {
            let mut g = wm();
            if g.pin.gen != gen {
                return;
            }
            g.pin.stdin = None;
            if started.elapsed() < Duration::from_secs(10) {
                g.pin.quick_exits += 1;
            }
            g.pin.quick_exits >= 2
        };
        if fail {
            pin_failed(&app);
        }
    });
    true
}

/// 도우미를 더 띄우지 않는다 — 붙여 둔 창을 보통 창으로 (작업 표시줄 단추도 없고 바탕화면 층도 아닌 창이 남지 않게)
fn pin_failed(app: &AppHandle) {
    {
        let mut g = wm();
        if g.pin.failed {
            return;
        }
        g.pin.failed = true;
        g.pin.pinned.clear();
        g.pin.pairs.clear();
    }
    let pinned: Vec<String> = wm().pinned.keys().cloned().collect();
    for label in pinned {
        let (Some(id), Some(w)) = (note_id(app, &label), app.get_webview_window(&label)) else { continue };
        apply_layer(app, &id, &w, false);
        emit(app, &label, "memo:layer", layer_state(app, &id));
    }
    crate::memos::push_list_soon(app);
}

fn reassert_top(w: &WebviewWindow) {
    if on_screen(w) {
        let _ = w.set_always_on_top(false);
        let _ = w.set_always_on_top(true);
    }
}

fn on_top_wins(app: &AppHandle) -> Vec<WebviewWindow> {
    let on_top = state(app).setting("onTop");
    let labels: Vec<(String, String)> = state(app).note_labels.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    labels.into_iter().filter(|(id, _)| on_top[id] == true).filter_map(|(_, l)| app.get_webview_window(&l)).collect()
}

// 앞으로 와도 메모킹 창을 올리지 않는 프로그램 — 캡처 · 시작 메뉴 · 검색 · 작업 전환 · 화상 키보드 · 작업 관리자 등 (foreground-watch.js)
const LEAVE_ON_TOP: [&str; 24] = [
    "screenclippinghost", "snippingtool", "screensketch", "shellexperiencehost", "startmenuexperiencehost", "searchhost", "searchapp", "searchui", "explorer", "lockapp", "textinputhost", "magnify", "osk", "taskmgr", "sharex", "greenshot", "lightshot", "picpick", "obs64", "memoking", "electron", "applicationframehost", "widgets", "shellhost",
];

#[derive(Debug, PartialEq)]
enum TopEvent {
    Fg { hwnd: i64, topmost: bool, name: String },
    Lost(i64),
}

/// 도우미가 알린 한 줄: "fg <hwnd> <늘 위 0|1> <프로그램 이름>" · "lost <hwnd>" (foreground-watch.js parseLine)
fn parse_top_line(line: &str) -> Option<TopEvent> {
    static RE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| fancy_regex::Regex::new(r"^(fg|lost) (\d+)(?: ([01]) ?(.*))?$").unwrap());
    let m = RE.captures(line.trim()).ok()??;
    let hwnd = m[2].parse::<i64>().ok().filter(|h| *h != 0)?;
    Some(if &m[1] == "lost" {
        TopEvent::Lost(hwnd)
    } else {
        TopEvent::Fg { hwnd, topmost: m.get(3).is_some_and(|t| t.as_str() == "1"), name: m.get(4).map_or("", |n| n.as_str()).trim().to_lowercase() }
    })
}

/// 메모킹을 끌 때: 왕관 도우미(PowerShell)는 따로 도는 프로세스라 남는다
pub fn stop() {
    let c = {
        let mut g = wm();
        g.top.gen += 1; // 도우미가 끝나서 3초 뒤 다시 띄우는 것도 막는다
        g.top.child.take()
    };
    if let Some(mut c) = c {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// 왕관 창을 지키는 도우미를 지금 왕관 창들로 (다시) 띄운다 — 없으면 멈춘다
// 1) Windows 가 늘 위를 몰래 풀면(lost) 다시 켜고, 2) 다른 "늘 위" 앱 창이 앞으로 오는 순간 메모킹 왕관 창을 다시 맨 위로
fn refresh_top_watch(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let gen = {
        let mut g = wm();
        g.top.gen += 1;
        g.top.gen
    };
    let app = app.clone();
    later(300, move || {
        if wm().top.gen != gen {
            return;
        }
        let mut next: Vec<i64> = on_top_wins(&app).iter().map(hwnd).filter(|h| *h != 0).collect();
        next.sort_unstable();
        next.dedup();
        let mut g = wm();
        if g.top.child.is_some() && g.top.watch == next {
            return;
        }
        if let Some(mut c) = g.top.child.take() {
            let _ = c.kill();
        }
        g.top.watch = next.clone();
        if next.is_empty() {
            return;
        }
        let watch = next.iter().map(i64::to_string).collect::<Vec<_>>().join(", ");
        let Ok(mut child) = powershell(&include_str!("../top-watch.ps1").replace("{WATCH}", &watch)).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn() else { return };
        let out = child.stdout.take().unwrap();
        g.top.child = Some(child);
        drop(g);
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(e) = parse_top_line(&line) {
                    on_top_event(&app, e);
                }
            }
            // 도우미가 멈췄는데 아직 지킬 창이 있으면 잠시 뒤 다시
            let stale = {
                let mut g = wm();
                let mine = g.top.gen == gen;
                if mine {
                    g.top.child = None;
                }
                !mine
            };
            if !stale {
                later(3000, move || {
                    if wm().top.gen == gen {
                        refresh_top_watch(&app);
                    }
                });
            }
        });
    });
}

fn on_top_event(app: &AppHandle, e: TopEvent) {
    // 끌어 놓기 미리보기가 떠 있는 동안은 가만히
    if app.get_webview_window("ghost").is_some_and(|w| is_shown(&w)) {
        return;
    }
    match e {
        TopEvent::Lost(h) => {
            if let Some(w) = on_top_wins(app).into_iter().find(|w| hwnd(w) == h) {
                reassert_top(&w);
            }
        }
        TopEvent::Fg { hwnd: h, topmost, name } => {
            if !topmost || LEAVE_ON_TOP.contains(&name.as_str()) || app.webview_windows().values().any(|w| hwnd(w) == h) {
                return;
            }
            let gen = {
                let mut g = wm();
                g.raise += 1;
                g.raise
            };
            let app = app.clone();
            later(120, move || {
                if wm().raise == gen {
                    for w in on_top_wins(&app) {
                        reassert_top(&w);
                    }
                }
            });
        }
    }
}

// ---------- 스티커 창 ----------
// 창 위 가장자리에 반쯤 걸쳐 붙는 왕관 · 테이프 (sticker.html). 주인 창이 보일 때만 있다
// shortcut: Electron 은 스티커의 투명한 곳으로 마우스가 통과한다(forward) — Tauri 는 그 기능이 없어 스티커 창 네모 전체가 누름을 받는다. 거슬리면 windows-rs SetWindowRgn 으로 모양만

fn sticker_size(kind: &str) -> (f64, f64) {
    if kind == "tape" {
        (96.0, 30.0)
    } else {
        (64.0, 52.0)
    }
}

// 목록 창 제목 줄: 왼쪽은 로고 · Life/Work 스위치, 오른쪽은 단추 묶음 + 창 단추 — 스티커는 그 사이 빈 줄에
const LIST_STICKER_LEFT: f64 = 200.0;
const LIST_STICKER_RIGHT: f64 = 250.0;
// 다시 붙일 때는 빈 줄이 16px 더 넉넉해야 — 창 폭을 조금씩 바꾸는 동안 스티커와 작은 왕관을 오가며 깜빡이지 않게
const LIST_STICKER_SLACK: f64 = 16.0;

/// list: 목록 창 — 가운데 빈 줄 안으로 (모자라면 로고 오른쪽, 그때는 작은 왕관으로 접힌다)
fn sticker_bounds([x, y, w, _]: Rect, kind: &str, list: bool) -> Rect {
    let (sw, sh) = sticker_size(kind);
    let mut cx = w / 2.0;
    if list {
        let lo = LIST_STICKER_LEFT + sw / 2.0;
        cx = cx.min((w - LIST_STICKER_RIGHT - sw / 2.0).max(lo)).max(lo);
    }
    [(x + cx - sw / 2.0).round(), (y - sh / 2.0).round(), sw, sh]
}

/// 목록 창 왕관 스티커가 잘리지 않고 붙을 수 있는가 — docked: 지금 작은 왕관이면 여유(SLACK)를 더 본다
fn list_sticker_fits(app: &AppHandle, o: &WebviewWindow, docked: bool) -> bool {
    let Some(b) = bounds(o).filter(|_| !o.is_maximized().unwrap_or(false) && !o.is_fullscreen().unwrap_or(false)) else { return false };
    let (sw, _) = sticker_size("crown");
    if b[2] - LIST_STICKER_LEFT - LIST_STICKER_RIGHT - sw < if docked { LIST_STICKER_SLACK } else { 0.0 } {
        return false;
    }
    // 창 위 가장자리 밖으로 반쯤 나가는 스티커가 화면(작업 표시줄 뺀) 밖에 걸리면 잘린다
    let [sx, sy, sw, _] = sticker_bounds(b, "crown", true);
    let [ax, ay, aw, _] = area_at(app, (b[0] + b[2] / 2.0, b[1] + b[3] / 2.0));
    sy >= ay && sx >= ax && sx + sw <= ax + aw
}

/// 목록 창 왕관: 잘리면 바로 작은 왕관으로 접고, 자리가 나면 창을 옮기거나 늘이는 손이 멈춘 뒤(220ms) 다시 스티커로
fn place_list_crown(app: &AppHandle) {
    let Some(docked) = wm().stickers.get("list").filter(|s| s.kind == "crown").map(|s| s.docked) else { return };
    let Some(o) = app.get_webview_window("list").filter(on_screen) else { return };
    if !list_sticker_fits(app, &o, docked) {
        wm().settle.remove("list");
        return set_list_docked(app, true);
    }
    if docked {
        let gen = next_seq();
        wm().settle.insert("list".into(), gen);
        let app = app.clone();
        later(220, move || {
            let fits = app.get_webview_window("list").filter(on_screen).is_some_and(|o| list_sticker_fits(&app, &o, true));
            if fits && wm().settle.get("list") == Some(&gen) {
                wm().settle.remove("list");
                set_list_docked(&app, false);
            }
        });
    }
}

fn set_list_docked(app: &AppHandle, docked: bool) {
    let old = {
        let mut g = wm();
        let Some(s) = g.stickers.get_mut("list").filter(|s| s.docked != docked) else { return };
        s.docked = docked;
        s.win.take()
    };
    if let Some(l) = old {
        close_sticker_win(app, "list", &l, Some("sticker:dock"));
    }
    emit(app, "list", "list:crown-docked", json!({ "docked": docked, "animate": true }));
    if !docked {
        open_sticker_win(app, "list", true);
    }
}

/// 목록 창 늘 위 (files.rs list:toggle-top · 켤 때)
pub fn set_list_crown(app: &AppHandle, on: bool, animate: bool) {
    set_sticker(app, "list", on, "crown", animate);
}

/// 목록 창이 움직이거나 보이고 숨을 때 (os.rs)
pub fn sync_list_crown(app: &AppHandle) {
    sync_sticker(app, "list");
}

pub fn list_crown_docked() -> bool {
    wm().stickers.get("list").is_some_and(|s| s.docked)
}

/// 덧창 바탕: 투명 · 그림자 없음 · 작업 표시줄 없음 · 포커스 받지 않음
fn overlay<'a>(app: &'a AppHandle, label: &str, page: &str, (w, h): (f64, f64)) -> tauri::WebviewWindowBuilder<'a, Wry, AppHandle> {
    crate::window(app, label, page).transparent(true).shadow(false).resizable(false).skip_taskbar(true).focused(false).focusable(false).visible(false).inner_size(w, h)
}

/// kind: crown(늘 위) | tape(바탕화면 층) — 다른 스티커가 붙어 있으면 떼고 붙인다
fn set_sticker(app: &AppHandle, owner: &str, on: bool, kind: &'static str, animate: bool) {
    let (old, keep) = {
        let mut g = wm();
        match g.stickers.get(owner) {
            Some(s) if on && s.kind == kind => (None, true),
            _ => (g.stickers.remove(owner).and_then(|s| s.win), false),
        }
    };
    if let Some(l) = old {
        close_sticker_win(app, owner, &l, animate.then_some("sticker:peel"));
    }
    if keep {
        sync_sticker(app, owner);
        return;
    }
    if on {
        // 목록 창 왕관이 처음부터 잘릴 자리면 스티커 창 없이 작은 왕관으로
        let docked = owner == "list" && kind == "crown" && app.get_webview_window(owner).is_some_and(|o| !list_sticker_fits(app, &o, false));
        wm().stickers.insert(owner.into(), Sticker { kind, win: None, docked });
        if docked {
            emit(app, owner, "list:crown-docked", json!({ "docked": true, "animate": animate }));
        } else {
            open_sticker_win(app, owner, animate);
        }
    }
}

/// 주인 창이 움직이거나 보이고 숨을 때: 스티커 창도 따라 (최소화 · 숨김이면 거둔다)
fn sync_sticker(app: &AppHandle, owner: &str) {
    if owner == "list" {
        place_list_crown(app);
    }
    let Some((win, kind)) = wm().stickers.get(owner).map(|s| (s.win.clone(), s.kind)) else { return };
    let Some(o) = app.get_webview_window(owner) else { return };
    let sw = win.as_ref().and_then(|l| app.get_webview_window(l));
    if on_screen(&o) {
        match (sw, bounds(&o)) {
            (Some(sw), Some(b)) => set_bounds(&sw, sticker_bounds(b, kind, owner == "list")),
            (None, _) => {
                if let Some(s) = wm().stickers.get_mut(owner) {
                    s.win = None;
                }
                // 창 · 알림 영역 이벤트 처리 안에서 창을 만들면 Windows 에서 멈춘다 — 다른 스레드에서
                let (app, owner) = (app.clone(), owner.to_string());
                std::thread::spawn(move || open_sticker_win(&app, &owner, false));
            }
            _ => {}
        }
    } else if let Some(l) = win {
        if let Some(s) = wm().stickers.get_mut(owner) {
            s.win = None;
        }
        close_sticker_win(app, owner, &l, None);
    }
}

fn open_sticker_win(app: &AppHandle, owner: &str, animate: bool) {
    let Some(o) = app.get_webview_window(owner).filter(on_screen) else { return };
    let Some(b) = bounds(&o) else { return };
    let gen = next_seq();
    let label = format!("sticker-{gen}");
    let kind = {
        let mut g = wm();
        let Some(s) = g.stickers.get_mut(owner).filter(|s| s.win.is_none() && !s.docked) else { return };
        s.win = Some(label.clone());
        s.kind
    };
    let r = sticker_bounds(b, kind, owner == "list");
    let (app2, owner2, label2) = (app.clone(), owner.to_string(), label.clone());
    let built = overlay(app, &label, &format!("sticker.html?kind={kind}"), (r[2], r[3]))
        .position(r[0], r[1])
        .parent(&o)
        .and_then(|b| {
            b.on_page_load(move |w, p| {
                // 그사이 떼거나 바뀌었으면 띄우지 않는다
                let current = wm().stickers.get(&owner2).is_some_and(|s| s.win.as_deref() == Some(label2.as_str()));
                if p.event() != PageLoadEvent::Finished || !current {
                    return;
                }
                if let Some(o) = app2.get_webview_window(&owner2).and_then(|o| bounds(&o)) {
                    set_bounds(&w, sticker_bounds(o, kind, owner2 == "list"));
                }
                let _ = w.show();
                emit(&app2, &label2, "sticker:show", json!({ "animate": animate, "kind": kind }));
                sync_tape_pair(&app2, &owner2);
            })
            .build()
        });
    match built {
        Ok(w) => memory_low(&w, true), // 그림 한 장짜리 덧창
        Err(_) => {
            if let Some(s) = wm().stickers.get_mut(owner).filter(|s| s.win.as_deref() == Some(label.as_str())) {
                s.win = None;
            }
        }
    }
}

/// 보이던 탭의 스티커 창을 새 탭으로 옮긴다 (Electron handOverSticker): 새 탭에 같은 스티커가 창 없이 걸려 있을 때만
fn hand_over_sticker(app: &AppHandle, from: &WebviewWindow, to: &WebviewWindow) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let (a, b) = (from.label(), to.label());
    // 아직 화면을 불러오는 스티커 창은 다 불러와도 옛 탭 것이 아니면 뜨지 않는다 (open_sticker_win). 넘기지 않고 새로 띄우게
    let from_sticker = wm().stickers.get(a).and_then(|s| s.win.clone());
    if !from_sticker.and_then(|l| app.get_webview_window(&l)).is_some_and(|w| is_shown(&w)) {
        return false;
    }
    let (moved, kind) = {
        let mut g = wm();
        let kind = g.stickers.get(a).filter(|s| s.win.is_some()).map(|s| s.kind);
        if kind.is_none() || g.stickers.get(b).is_none_or(|s| s.win.is_some() || Some(s.kind) != kind) {
            return false;
        }
        let l = g.stickers.get_mut(a).and_then(|s| s.win.take());
        g.stickers.get_mut(b).unwrap().win = l.clone();
        (l, kind)
    };
    let Some(sw) = moved.and_then(|l| app.get_webview_window(&l)) else { return false };
    // 주인 창(owner)을 바꾼다: 새 탭 위에 있고, 옛 탭과 함께 숨거나 닫히지 않게
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(hwnd(&sw) as _, windows_sys::Win32::UI::WindowsAndMessaging::GWLP_HWNDPARENT, hwnd(to) as _);
    }
    if let Some(o) = bounds(to) {
        set_bounds(&sw, sticker_bounds(o, kind.unwrap_or("crown"), false));
    }
    sync_tape_pair(app, a);
    sync_tape_pair(app, b);
    true
}

/// 스티커 창 거두기 — how: 떼어지는(sticker:peel) · 작은 왕관으로 들어가는(sticker:dock) 모습 뒤에
fn close_sticker_win(app: &AppHandle, owner: &str, label: &str, how: Option<&str>) {
    let Some(w) = app.get_webview_window(label) else { return };
    let (app2, owner) = (app.clone(), owner.to_string());
    let destroy = move || {
        let _ = w.destroy();
        sync_tape_pair(&app2, &owner);
        // 늘 위인 창은 스티커 창이 사라질 때 맨 위를 다시
        if wm().stickers.get(&owner).is_some_and(|s| s.kind == "crown") {
            if let Some(o) = app2.get_webview_window(&owner) {
                reassert_top(&o);
            }
        }
    };
    if let Some(how) = how.filter(|_| app.get_webview_window(label).is_some_and(|w| is_shown(&w))) {
        emit(app, label, how, Value::Null);
        later(if how == "sticker:dock" { 160 } else { 220 }, destroy);
    } else {
        destroy();
    }
}

/// 스티커 창 이름 → (주인 창 이름, 종류)
fn sticker_owner(label: &str) -> Option<(String, &'static str)> {
    wm().stickers.iter().find(|(_, s)| s.win.as_deref() == Some(label)).map(|(o, s)| (o.clone(), s.kind))
}

fn peel_sticker(app: &AppHandle, label: &str) -> bool {
    let Some((owner, kind)) = sticker_owner(label) else { return false };
    if owner == "list" {
        return !crate::files::set_list_on_top(app, false);
    }
    let Some(id) = note_id(app, &owner) else { return false };
    let state = set_note_layer(app, &id, None, "");
    // 테이프를 떼면 바탕화면 층에서 보통 창으로 — 앞으로 가져와 떨어졌다는 것이 보이게
    if kind == "tape" {
        if let Some(o) = app.get_webview_window(&owner).filter(is_shown) {
            let _ = o.set_focus();
        }
    }
    state["top"] != true && state["bottom"] != true
}

// ---------- 끌어 놓기 미리보기 (목록 → 화면) ----------

/// 덧창을 하나 만들어 둔다 (이미 있으면 그대로) — 마우스는 통과, 늘 위
fn ensure_overlay(app: &AppHandle, label: &str, page: &str, size: (f64, f64), parent: Option<&WebviewWindow>) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        return Some(w);
    }
    let l2 = label.to_string();
    let b = overlay(app, label, page, size).on_page_load(move |_, p| {
        if p.event() == PageLoadEvent::Finished {
            wm().loaded.insert(l2.clone());
        }
    });
    let b = match parent {
        Some(p) => b.parent(p).ok()?,
        None => b.always_on_top(true),
    };
    let w = b.build().ok()?;
    let _ = w.set_ignore_cursor_events(true);
    memory_low(&w, true); // 글 몇 줄만 그리는 덧창
    Some(w)
}

/// 덧창 화면이 다 불러질 때까지 (늦어도 3초) — 메인 스레드에서는 부르지 않는다
fn wait_loaded(label: &str) -> bool {
    for _ in 0..150 {
        if wm().loaded.contains(label) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn hide_ghost(app: &AppHandle) {
    if let Some(g) = app.get_webview_window("ghost") {
        let _ = g.hide();
    }
}

fn drop_at(app: &AppHandle, id: &str, p: (f64, f64)) -> Rect {
    let saved = &state(app).setting("noteBounds")[id];
    let size = saved["width"].as_f64().zip(saved["height"].as_f64()).unwrap_or(DEFAULT_NOTE_SIZE);
    drop_bounds(p, size, area_at(app, p))
}

fn drag_start(app: &AppHandle, id: &str) -> bool {
    let memo = state(app).vault.lock().unwrap().as_ref().and_then(|v| v.get(id));
    let Some(memo) = memo.filter(|_| app.get_webview_window("list").is_some()) else { return false };
    let (w, h) = DEFAULT_NOTE_SIZE;
    if ensure_overlay(app, "ghost", "ghost.html", (w + GHOST_MARGIN * 2.0, h + GHOST_MARGIN * 2.0), None).is_none() {
        return false;
    }
    let old = wm().drag.replace(Drag { id: id.into(), outside: false, ready: false, hover: Hover::default() });
    if let Some(d) = old {
        clear_hover(app, &d.hover);
    }
    if !wait_loaded("ghost") || wm().drag.as_ref().is_none_or(|d| d.id != id) {
        return false;
    }
    let preview = if memo["locked"] == true { String::new() } else { memoking_core::body::extract_preview(memo["body"].as_str().unwrap_or_default(), 400) };
    emit(app, "ghost", "ghost:data", json!({ "color": memo["color"], "title": memo["title"], "preview": preview, "open": note_label(app, id).is_some() }));
    let outside = wm().drag.as_mut().is_some_and(|d| {
        d.ready = true;
        d.outside
    });
    if outside {
        emit(app, "ghost", "ghost:visible", true.into());
    }
    true
}

fn drag_move(app: &AppHandle, p: (f64, f64)) {
    let Some(id) = wm().drag.as_ref().map(|d| d.id.clone()) else { return };
    let (Some(list), Some(ghost)) = (app.get_webview_window("list"), app.get_webview_window("ghost")) else { return };
    let outside = !bounds(&list).is_some_and(|b| is_inside(p, b));
    let Some((was, ready)) = wm().drag.as_mut().map(|d| (std::mem::replace(&mut d.outside, outside), d.ready)) else { return };
    if outside {
        let [x, y, w, h] = drop_at(app, &id, p);
        set_bounds(&ghost, [x - GHOST_MARGIN, y - GHOST_MARGIN, w + GHOST_MARGIN * 2.0, h + GHOST_MARGIN * 2.0]);
        if !was {
            let _ = ghost.show();
            if ready {
                emit(app, "ghost", "ghost:visible", true.into());
            }
        }
    } else if was {
        emit(app, "ghost", "ghost:visible", false.into());
        let _ = ghost.hide();
    }
    if outside != was {
        emit(app, "list", "drag:state", json!({ "outside": outside }));
    }
    if outside {
        track_hover(app, Who::Drag, p, &id);
    } else {
        let old = wm().drag.as_mut().map(|d| std::mem::take(&mut d.hover)).filter(|h| h.target.is_some());
        if let Some(h) = old {
            clear_hover(app, &h);
            emit(app, "ghost", "ghost:mode", json!({ "stack": false }));
        }
    }
}

fn drag_end(app: &AppHandle, p: Option<(f64, f64)>) -> Value {
    let Some(d) = wm().drag.take() else { return json!({ "opened": false }) };
    clear_hover(app, &d.hover);
    emit(app, "ghost", "ghost:mode", json!({ "stack": false }));
    let list = app.get_webview_window("list").and_then(|l| bounds(&l));
    let Some(p) = p.filter(|&p| list.is_some_and(|b| !is_inside(p, b))) else {
        hide_ghost(app);
        return json!({ "opened": false });
    };
    if let (true, Some(t)) = (d.hover.armed, &d.hover.target) {
        hide_ghost(app);
        stack_into(app, t, &d.id);
        return json!({ "opened": true, "stacked": true });
    }
    let b = drop_at(app, &d.id, p);
    emit(app, "ghost", "ghost:drop", Value::Null);
    place_note(app, &d.id, b);
    json!({ "opened": true, "bounds": rect_json(b) })
}

/// 끌어 놓은 자리에 메모 창을 연다 (열려 있으면 옮긴다)
// shortcut: Electron 은 열려 있던 창을 부드럽게 옮긴다(animateBounds) — 여기서는 바로. 어색하다는 말이 나오면 placement tween 을 옮겨 몇 단계로
fn place_note(app: &AppHandle, id: &str, b: Rect) {
    if let Some(s) = stack_of(app, id) {
        hide_ghost(app);
        show_tab(app, id, Some(b), true);
        if let Some(w) = note_win(app, id) {
            set_bounds(&w, b);
        }
        remember_bounds(app, &s.memos, b);
        return;
    }
    remember_bounds(app, &[id.to_string()], b);
    if let Some(w) = note_win(app, id) {
        let _ = w.unminimize();
        hide_ghost(app);
        set_bounds(&w, b);
        let _ = w.show();
        let _ = w.set_focus();
        shown(app, id, &w);
        return;
    }
    let _ = crate::memos::open_note(app, id);
    // 새 창이 그 자리에 뜬 뒤 미리보기를 거둔다
    let app = app.clone();
    later(300, move || hide_ghost(&app));
}

// ---------- 잠깐 알림 (HUD) ----------
// 메모 단축키로 복사했을 때처럼 다른 앱을 쓰는 중에 "복사했어요" 만 잠깐 — 마우스 가까이, 포커스를 빼앗지 않고 1.6초 뒤 사라짐

/// kind: ok | warn
pub fn show_hud(app: &AppHandle, title: &str, body: &str, kind: &str) {
    let (w, h) = (340.0, 64.0);
    if ensure_overlay(app, "hud", "hud.html", (w, h), None).is_none() {
        return;
    }
    let Some((cx, cy)) = cursor(app) else { return };
    let [ax, ay, aw, ah] = area_at(app, (cx, cy));
    let x = (cx - w / 2.0).max(ax + 8.0).min(ax + aw - w - 8.0).round();
    let y = if cy + 28.0 + h <= ay + ah { cy + 28.0 } else { cy - 28.0 - h }.round();
    let seq = next_seq();
    wm().hud = seq; // 불러오는 사이 여러 번 불리면 마지막 것만
    let (app, payload) = (app.clone(), json!({ "title": title, "body": body, "kind": kind }));
    std::thread::spawn(move || {
        let Some(win) = app.get_webview_window("hud").filter(|_| wait_loaded("hud") && wm().hud == seq) else { return };
        set_bounds(&win, [x, y, w, h]);
        emit(&app, "hud", "hud:show", payload);
        let _ = win.show();
        std::thread::sleep(Duration::from_millis(1600));
        if wm().hud != seq {
            return;
        }
        emit(&app, "hud", "hud:hide", Value::Null);
        std::thread::sleep(Duration::from_millis(220));
        if wm().hud == seq {
            let _ = win.hide();
        }
    });
}

// ---------- 상태 말풍선 ----------
// 메모 창 상태 줄이 잘렸을 때 전문을 메모 창 바깥에 (bubble.html). 메모 창마다 하나, 처음 쓸 때 만들고 그 뒤로는 숨겼다 보였다

fn hide_bubble(app: &AppHandle, owner: &str) {
    let label = format!("bubble-{owner}");
    if let Some(w) = app.get_webview_window(&label) {
        emit(app, &label, "bubble:hide", Value::Null); // 먼저 비우고 숨긴다 (다음에 보일 때 지난 글이 비치지 않게)
        if is_shown(&w) {
            let _ = w.hide();
            // 숨은 채 30초면 없앤다 — 메모 창마다 말풍선 웹뷰가 하나씩 숨어 남았다 (다음에 뜰 때 다시 만든다)
            let app = app.clone();
            later(30_000, move || {
                if let Some(w) = app.get_webview_window(&label).filter(|w| !is_shown(w)) {
                    wm().loaded.remove(&label);
                    let _ = w.destroy();
                }
            });
        }
    }
}

/// 메모 창이 움직이거나 숨거나 포커스를 잃으면 말풍선은 거둔다 (따라다니지 않는다 — 잠깐 보이는 안내라서)
fn bubble_away(app: &AppHandle, owner: &str) {
    if app.get_webview_window(&format!("bubble-{owner}")).is_some_and(|w| is_shown(&w)) {
        hide_bubble(app, owner);
        emit(app, owner, "status-bubble:gone", Value::Null); // 메모 창은 감춰 둔 상태 줄 글을 다시 보인다
    }
}

/// 보이기 (글이 비면 숨김) → 보였는지 (상태 줄은 말풍선이 실제로 뜬 뒤에야 감춘다)
fn status_bubble(app: &AppHandle, owner: &str, b: &Value) -> Value {
    let Some(o) = app.get_webview_window(owner).filter(|_| note_id(app, owner).is_some()) else { return Value::Null };
    let Some(text) = b["text"].as_str().filter(|t| !t.is_empty()) else {
        hide_bubble(app, owner);
        return false.into();
    };
    // 바탕화면 층(테이프) 메모는 앞에 나와 있을 때만 — 다른 창 뒤에 있으면 말풍선만 혼자 떠 보인다
    // WM 을 놓고 창에 묻는다 — 창 묻기는 메인 스레드를 기다리고, 메인 스레드는 WM 을 기다릴 수 있다
    let pinned = wm().pinned.contains_key(owner);
    if pinned && !o.is_focused().unwrap_or(false) {
        return false.into();
    }
    let label = format!("bubble-{owner}");
    let (Some(w), Some(ob)) = (ensure_overlay(app, &label, "bubble.html", BUBBLE_SIZE, Some(&o)), bounds(&o)) else { return false.into() };
    // shortcut: 메모 창 확대(zoom)는 1 로 본다 — 확대한 창에서 꼬리가 어긋나면 화면이 확대율을 함께 보내게
    let anchor = ob[0] + b["x"].as_f64().unwrap_or(0.0);
    let sl = wm().stickers.get(owner).and_then(|s| s.win.clone());
    let sticker = sl.and_then(|l| app.get_webview_window(&l)).filter(is_shown).and_then(|s| bounds(&s));
    let mut spot = place_bubble(ob, area_at(app, (anchor.round(), ob[1] + 4.0)), anchor, BAR_H, sticker);
    let r = &spot["bounds"];
    set_bounds(&w, [r["x"].as_f64().unwrap_or(0.0), r["y"].as_f64().unwrap_or(0.0), BUBBLE_SIZE.0, BUBBLE_SIZE.1]);
    spot.as_object_mut().unwrap().remove("bounds");
    spot["text"] = text.chars().take(600).collect::<String>().into();
    spot["error"] = (b["error"] == true).into();
    if !wait_loaded(&label) {
        return false.into();
    }
    emit(app, &label, "bubble:show", spot);
    if !is_shown(&w) {
        // 숨겨 둔 창은 지난 글이 남은 그림으로 먼저 보일 수 있어 새 글을 그릴 틈을 준다
        std::thread::sleep(Duration::from_millis(40));
        let _ = w.show();
    }
    true.into()
}

// ---------- 그 밖의 창 일 ----------

/// 표가 넓어 창을 넓힌다 — 화면 안에서 (넘치면 왼쪽으로 옮겨) → 넓힌 폭
fn grow_width(app: &AppHandle, label: &str, extra: &Value) -> Value {
    let add = memoking_core::js::number(extra).ceil();
    let Some([x, y, w, h]) = app.get_webview_window(label).and_then(|w| bounds(&w)).filter(|_| add > 0.0) else { return 0.into() };
    let [ax, _, aw, _] = area_at(app, (x + w / 2.0, y + h / 2.0));
    let want = (aw - 24.0).min(w + add);
    if want <= w {
        return 0.into();
    }
    let nx = if x + want > ax + aw { ax.max(ax + aw - want) } else { x };
    if let Some(win) = app.get_webview_window(label) {
        set_bounds(&win, [nx, y, want, h]);
    }
    (want - w).into()
}

/// 닫는 중인 메모 창을 먼저 숨긴다 — 화면은 남은 일(녹음 마무리 · 태그 · 저장)을 숨은 채 마치고 win:close.
///   닫는 중으로 적어 두어 그사이 같은 메모를 열면 이 창 대신 새 창이 뜬다
fn hide_closing(app: &AppHandle, w: &WebviewWindow) {
    wm().closing_notes.insert(w.label().to_string());
    hide_note(app, w);
}

/// 메모 창 × · Ctrl+W: 스택이면 탭 모두 함께 숨긴다 (CloseRequested 가 스택을 모두 닫으므로)
fn hide_for_close(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    if let Some(s) = note_id(app, label).and_then(|id| stack_of(app, &id)) {
        for m in &s.memos {
            if let Some(t) = note_win(app, m).filter(|t| t.label() != label && is_shown(t)) {
                hide_note(app, &t);
            }
        }
    }
    hide_closing(app, &w);
}

/// PDF 미리보기: 문서를 100% 로 볼 만큼 창을 키운다 (작업 영역 안, 줄이지는 않음) → 키우기 전 자리 (그대로면 null)
fn fit_size(app: &AppHandle, label: &str, w: &Value, h: &Value) -> Value {
    let (want_w, want_h) = (memoking_core::js::number(w).ceil(), memoking_core::js::number(h).ceil());
    let Some(win) = app.get_webview_window(label) else { return Value::Null };
    let Some(old @ [x, y, cw, ch]) = bounds(&win) else { return Value::Null };
    let [ax, ay, aw, ah] = area_at(app, (x + cw / 2.0, y + ch / 2.0));
    let nw = want_w.min(aw - 24.0).max(cw);
    let nh = want_h.min(ah - 24.0).max(ch);
    if nw <= cw && nh <= ch {
        return Value::Null;
    }
    // 넘치면 화면 안으로 옮긴다
    let nx = x.min(ax + aw - nw).max(ax);
    let ny = y.min(ay + ah - nh).max(ay);
    set_bounds(&win, [nx, ny, nw, nh]);
    rect_json(old)
}

/// fit_size 가 돌려준 자리로 되돌린다 (미리보기를 닫을 때)
fn restore_bounds(app: &AppHandle, label: &str, b: &Value) {
    let n = |k: &str| b[k].as_f64();
    if let (Some(win), Some(x), Some(y), Some(w), Some(h)) = (app.get_webview_window(label), n("x"), n("y"), n("width"), n("height")) {
        if w >= 100.0 && h >= 100.0 {
            set_bounds(&win, [x, y, w, h]);
        }
    }
}

pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let arg = |i: usize| args.get(i).map(|v| v.as_str().map_or_else(|| memoking_core::js::string(v), str::to_string)).unwrap_or_default();
    let at = |i: usize| args.get(i).and_then(point);
    Some(Ok(match channel {
        "stack:activate" => crate::memos::open_note(app, &arg(0)).unwrap_or(false).into(),
        "stack:reorder" => {
            let s = stacks(app, |s| s.reorder(&arg(0), args.get(1).unwrap_or(&Value::Null))).flatten();
            if let Some(s) = &s {
                push_stack_to(app, &s.memos);
            }
            s.is_some().into()
        }
        "stack:new-tab" => new_tab_after(app, &arg(0)),
        "stack:remove" => remove_from_stack(app, &arg(0), "close").into(),
        "stack:remove-hidden" => remove_from_stack(app, &arg(0), "hide").into(),
        "stack:detach" => remove_from_stack(app, &arg(0), "detach").into(),
        "stack:tear-start" => at(2).is_some_and(|p| tear_start(app, &arg(0), args.get(1).unwrap_or(&Value::Null), p)).into(),
        "stack:tear-move" => {
            if let Some(p) = at(0) {
                tear_move(app, p);
            }
            Value::Null
        }
        "stack:tear-end" => tear_end(app, at(0)).into(),
        "stack:cycle" => {
            let dir = if memoking_core::js::number(args.get(1).unwrap_or(&Value::Null)) < 0.0 { -1 } else { 1 };
            stacks(app, |s| s.neighbor(&arg(0), dir)).flatten().is_some_and(|next| show_tab(app, &next, None, true)).into()
        }
        "stack:join-menu" => {
            let me = arg(0);
            return Some(popup(app, label, || {
                let items = join_items(app, &me)?;
                let items: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
                Menu::with_items(app, &items)
            }));
        }
        "stack:menu" => {
            let me = arg(0);
            return Some(popup(app, label, || stack_menu(app, &me)));
        }
        "sticker:hover" => {
            // 스티커에 마우스를 올리면 그 메모 창에 "누르면 떼어져요" 안내 (스티커 창은 글을 띄우지 못한다)
            if let Some((owner, kind)) = sticker_owner(label) {
                emit(app, &owner, "sticker:hover", json!({ "kind": kind, "over": args.first().is_some_and(|v| v == true) }));
            }
            Value::Null
        }
        "sticker:peel" => peel_sticker(app, label).into(),
        "drag:start" => drag_start(app, &arg(0)).into(),
        "drag:move" => {
            if let Some(p) = at(0) {
                drag_move(app, p);
            }
            Value::Null
        }
        "drag:end" => drag_end(app, at(0)),
        // 목록 창 제목 줄 어둡게(대화 상자 · 안내 뒤): Electron 은 Windows 가 그린 창 단추 색을 바꿨다. Tauri 는 화면이 단추를 그려(shim.js) 막이 함께 덮는다
        "win:dim-titlebar" => Value::Null,
        "win:grow-width" => grow_width(app, label, args.first().unwrap_or(&Value::Null)),
        "app:restoring" => crate::os::RESTORING.load(std::sync::atomic::Ordering::SeqCst).into(),
        "win:hide-closing" => {
            hide_for_close(app, label);
            Value::Null
        }
        "win:fit-size" => fit_size(app, label, args.first().unwrap_or(&Value::Null), args.get(1).unwrap_or(&Value::Null)),
        "win:restore-bounds" => {
            restore_bounds(app, label, args.first().unwrap_or(&Value::Null));
            Value::Null
        }
        // 손글씨를 쓰는 동안은 창을 끌어도 다른 메모와 합치지 않는다
        "win:inking" => {
            let on = args.first().is_some_and(|v| v == true);
            let dragging = {
                let mut g = wm();
                if on {
                    g.inking.insert(label.into());
                } else {
                    g.inking.remove(label);
                }
                g.window_drag.as_ref().map(|(id, _)| id.clone())
            };
            // note_labels 는 WM 을 놓고 본다 (잠금 차례)
            let mine = on && dragging.as_deref().is_some_and(|id| note_label(app, id).as_deref() == Some(label));
            let drag = if mine {
                let mut g = wm();
                if g.window_drag.as_ref().map(|(id, _)| id) == dragging.as_ref() { g.window_drag.take() } else { None }
            } else {
                None
            };
            if let Some((_, h)) = drag {
                clear_hover(app, &h);
            }
            Value::Null
        }
        "win:status-bubble" => status_bubble(app, label, args.first().unwrap_or(&Value::Null)),
        // 왕관 · 테이프: 붙어 있으면 떼고, 아니면 붙인다 (다른 하나가 붙어 있으면 바꿔 붙임) → { top, bottom, canTape }
        "win:toggle-layer" => {
            let id = arg(0);
            let want = if args.get(1).is_some_and(|l| l == "bottom") { "bottom" } else { "top" };
            // 붙일 수 없는 PC 에서 테이프는 아무 일도 하지 않는다 — 붙어 있던 왕관을 떼지 않게
            if want == "bottom" && !can_tape() {
                layer_state(app, &id)
            } else {
                set_note_layer(app, &id, (layer_of(app, &id) != Some(want)).then_some(want), "")
            }
        }
        _ => return None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_top_watch_lines() {
        assert_eq!(parse_top_line("fg 1234 1 Chrome\r\n"), Some(TopEvent::Fg { hwnd: 1234, topmost: true, name: "chrome".into() }));
        assert_eq!(parse_top_line("fg 77 0"), Some(TopEvent::Fg { hwnd: 77, topmost: false, name: String::new() }));
        assert_eq!(parse_top_line("fg 77"), Some(TopEvent::Fg { hwnd: 77, topmost: false, name: String::new() }));
        assert_eq!(parse_top_line("lost 99"), Some(TopEvent::Lost(99)));
        for bad in ["", "lost 0", "fg x 1 a", "fg 12 2 a", "up 12", "lost -3"] {
            assert_eq!(parse_top_line(bad), None, "{bad}");
        }
    }

    #[test]
    fn sticker_sits_on_top_edge() {
        assert_eq!(sticker_bounds([100.0, 200.0, 340.0, 380.0], "crown", false), [238.0, 174.0, 64.0, 52.0]);
        assert_eq!(sticker_bounds([100.0, 200.0, 340.0, 380.0], "tape", false), [222.0, 185.0, 96.0, 30.0]);
        // 목록 창: 넓으면 가운데, 좁으면 로고 오른쪽(200px)으로 밀린다
        assert_eq!(sticker_bounds([0.0, 100.0, 800.0, 600.0], "crown", true), [368.0, 74.0, 64.0, 52.0]);
        assert_eq!(sticker_bounds([0.0, 100.0, 440.0, 600.0], "crown", true), [200.0, 74.0, 64.0, 52.0]);
    }
}
