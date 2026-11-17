// 운영체제와 붙는 곳 — 한 번만 켜기 · 실행 인자(MagicKey 약속, docs/magickey.md) · 알림 영역 아이콘 · 창 자리 기억.
//   Electron 의 main.js(handleLaunch · 트레이) · jump-list.js(launchAction · readMagicKeyFile) · window-manager.js(listBounds · noteBounds · openNotes) 자리.
use crate::memos;
use crate::state::State;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

type Builder<'a> = WebviewWindowBuilder<'a, Wry, AppHandle>;

/// 끝내는 중 — 이때 닫히는 메모는 "열려 있던 메모"로 남긴다 (다음에 켜면 다시 연다)
static QUITTING: AtomicBool = AtomicBool::new(false);

fn state(app: &AppHandle) -> tauri::State<'_, State> {
    app.state::<State>()
}

// ---------- 창 자리 ----------

/// Electron onScreen 그대로: 작업 영역에 창 윗막대를 잡을 만큼 걸쳐 있나 (논리 픽셀 { x, y, width, height })
fn on_screen(b: &Value, areas: &[[f64; 4]]) -> Option<[f64; 4]> {
    let n = |k: &str| b[k].as_f64();
    let (x, y, w, h) = (n("x")?, n("y")?, n("width")?, n("height")?);
    areas.iter().any(|&[ax, ay, aw, ah]| x < ax + aw - 40.0 && x + w > ax + 40.0 && y >= ay - 10.0 && y < ay + ah - 40.0).then_some([x, y, w, h])
}

// shortcut: 화면마다 배율이 다르면 논리 좌표가 Electron(DIP)과 조금 어긋날 수 있다 — 여러 배율 모니터에서 자리가 틀어지면 물리 좌표로 바꾸기
fn work_areas(app: &AppHandle) -> Vec<[f64; 4]> {
    let monitors = app.available_monitors().unwrap_or_default();
    monitors
        .iter()
        .map(|m| {
            let (s, a) = (m.scale_factor(), m.work_area());
            let (p, z) = (a.position.to_logical::<f64>(s), a.size.to_logical::<f64>(s));
            [p.x, p.y, z.width, z.height]
        })
        .collect()
}

/// 기억한 자리가 지금 있는 화면 안이면 그 자리로 (아니면 기본 크기 그대로 — 모니터를 뺀 뒤 화면 밖에 뜨지 않게)
fn place<'a>(app: &AppHandle, b: Builder<'a>, saved: &Value) -> Builder<'a> {
    match on_screen(saved, &work_areas(app)) {
        Some([x, y, w, h]) => b.position(x, y).inner_size(w, h),
        None => b,
    }
}

/// 목록 창: 기억한 자리에, 처음에는 숨겨서 (start 가 띄울지 정한다)
pub fn place_list<'a>(app: &AppHandle, b: Builder<'a>) -> Builder<'a> {
    place(app, b, &state(app).setting("listBounds")).visible(false)
}

pub fn place_note<'a>(app: &AppHandle, id: &str, b: Builder<'a>) -> Builder<'a> {
    place(app, b, &state(app).setting("noteBounds")[id])
}

// 창을 끄는 동안 Moved 가 줄줄이 온다 — 멈추고 잠깐 뒤에 한 번만 쓴다
fn save_soon(app: &AppHandle) {
    static GEN: AtomicU64 = AtomicU64::new(0);
    let n = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        if GEN.load(Ordering::SeqCst) == n {
            state(&app).save_settings();
        }
    });
}

/// 창 자리를 설정에 (Electron getNormalBounds 처럼 최소화 · 최대화 때는 그대로 둔다)
fn remember(app: &AppHandle, label: &str, id: Option<&str>) {
    let Some(w) = app.get_webview_window(label) else { return };
    if w.is_minimized().unwrap_or(true) || w.is_maximized().unwrap_or(true) {
        return;
    }
    let (Ok(s), Ok(p), Ok(z)) = (w.scale_factor(), w.outer_position(), w.inner_size()) else { return };
    let (p, z) = (p.to_logical::<f64>(s), z.to_logical::<f64>(s));
    let b = json!({ "x": p.x.round() as i64, "y": p.y.round() as i64, "width": z.width.round() as i64, "height": z.height.round() as i64 });
    {
        let st = state(app);
        let mut set = st.settings.lock().unwrap();
        match id {
            None => {
                set.insert("listBounds".into(), b);
            }
            Some(id) => {
                let all = set.entry("noteBounds").or_insert_with(|| json!({}));
                if !all.is_object() {
                    *all = json!({});
                }
                all.as_object_mut().unwrap().insert(id.into(), b);
            }
        }
    }
    save_soon(app);
}

fn set_open(app: &AppHandle, id: &str, open: bool) {
    let st = state(app);
    let mut list = st.setting("openNotes").as_array().cloned().unwrap_or_default();
    list.retain(|x| x != id);
    if open {
        list.push(id.into());
    }
    st.set_setting("openNotes", list.into());
}

/// 메모 창이 열렸다 (memos::open_note): 열린 메모로 기억하고, 옮기면 자리를 기억한다
pub fn track_note(app: &AppHandle, id: &str, win: &WebviewWindow) {
    set_open(app, id, true);
    let (app, id, label) = (app.clone(), id.to_string(), win.label().to_string());
    win.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => remember(&app, &label, Some(&id)),
        // memos::closed_note 다음에 온다 (먼저 단 것이 먼저) — 비워서 치운 메모 · 휴지통으로 간 메모는 자리도 잊는다
        WindowEvent::Destroyed if !QUITTING.load(Ordering::SeqCst) => {
            let gone = state(&app).vault.lock().unwrap().as_ref().is_some_and(|v| v.entry(&id).is_none());
            if gone {
                if let Some(Value::Object(m)) = state(&app).settings.lock().unwrap().get_mut("noteBounds") {
                    m.remove(&id);
                }
            }
            set_open(&app, &id, false);
        }
        _ => {}
    });
}

// ---------- 목록 창 · 알림 영역 ----------

pub fn show_list(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_list(app: &AppHandle) {
    let Some(w) = app.get_webview_window("list") else { return };
    if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        show_list(app);
    }
}

fn new_memo(app: &AppHandle) -> bool {
    matches!(memos::handle(app, "list", "memo:create", &[json!({})]), Some(Ok(_)))
}

/// 끝내기: 메모 창을 먼저 닫아 마무리(closed_note)한 뒤에 — app.exit 는 창의 Destroyed 를 기다리지 않는다
fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    let labels: Vec<String> = state(app).note_labels.lock().unwrap().values().cloned().collect();
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.destroy();
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for _ in 0..50 {
            if state(&app).note_labels.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        state(&app).save_settings();
        app.exit(0);
    });
}

// shortcut: Electron 트레이의 화면 캡처 · 최근 메모 · 일정 · 자동 실행 등은 아직 — 그 기능을 옮길 때 메뉴에 더하기
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon().cloned() else { return Ok(()) };
    let list = MenuItem::with_id(app, "list", "메모 목록", true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new", "새 메모", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "끝내기", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&list, &new, &PredefinedMenuItem::separator(app)?, &quit_item])?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("메모킹")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "list" => show_list(app),
            // 창 만들기는 이벤트 처리 안에서 하면 Windows 에서 멈춘다 — 다른 스레드에서
            "new" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    if !new_memo(&app) {
                        show_list(&app); // 메모 폴더가 없으면 고르는 화면으로
                    }
                });
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                toggle_list(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---------- 실행 인자 ----------

/// MagicKey 가 임시 폴더에 쓴 글 — 임시 폴더 바로 아래의 1MB 이하 magickey-*.txt 만 (링크는 따라간 실제 자리로 본다)
fn magickey_file(arg: &str, tmp: &Path) -> Option<(PathBuf, String)> {
    let real = std::fs::canonicalize(arg).ok()?;
    let same = |a: &Path, b: &Path| if cfg!(windows) { a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase() } else { a == b };
    if !same(real.parent()?, &std::fs::canonicalize(tmp).ok()?) || std::fs::metadata(&real).ok()?.len() > 1024 * 1024 {
        return None;
    }
    Some((real.clone(), std::fs::read_to_string(&real).ok()?))
}

/// jump-list.js MAGICKEY_FILE: /^magickey-[\w-]{1,64}\.txt$/i
fn magickey_name(arg: &str) -> bool {
    let name = arg.rsplit(['/', '\\']).next().unwrap_or_default().to_ascii_lowercase();
    let mid = name.strip_prefix("magickey-").and_then(|s| s.strip_suffix(".txt")).unwrap_or_default();
    (1..=64).contains(&mid.len()) && mid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 실행 인자대로 (jump-list.js launchAction · main.js handleLaunch) — 메모 창을 열었으면 true (아니면 부르는 쪽이 목록을 띄운다)
fn launch(app: &AppHandle, args: &[String]) -> bool {
    let val = |p: &str| args.iter().find_map(|a| a.strip_prefix(p).map(str::to_string));
    if let Some(id) = val("--open-memo=").filter(|id| (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
        return memos::open_note(app, &id).unwrap_or(false);
    }
    if let Some(file) = val("--new-memo-file=").filter(|f| magickey_name(f)) {
        let Some((real, text)) = magickey_file(&file, &std::env::temp_dir()) else { return false };
        // shortcut: 알림(토스트) · --remind(글 속 날짜로 알림)는 아직 — --open-new 가 없어도 연다 (Electron 의 토스트를 못 띄울 때처럼). 알림을 옮길 때 고치기
        let saved = matches!(memos::handle(app, "list", "memo:import", &[text.into(), json!({ "open": true })]), Some(Ok(_)));
        if saved {
            let _ = std::fs::remove_file(real); // 저장한 뒤에야 지운다 (실패하면 글이 남게)
        }
        return saved;
    }
    args.iter().any(|a| a == "--new-memo") && new_memo(app)
}

/// 두 번째로 켰다 (tauri-plugin-single-instance): 그 인자대로, 할 일이 없으면 목록을 앞으로
pub fn second_launch(app: &AppHandle, argv: Vec<String>, _cwd: String) {
    let app = app.clone();
    // 창 만들기는 이벤트 처리 안에서 하면 Windows 에서 멈춘다 — 다른 스레드에서
    std::thread::spawn(move || {
        if !launch(&app, &argv) {
            show_list(&app);
        }
    });
}

/// 켤 때 (setup, 메모 폴더를 연 뒤): 알림 영역 · 목록 창 닫기 = 숨기기 · 열려 있던 메모 · 실행 인자
pub fn start(app: &AppHandle, list: &WebviewWindow) {
    if let Err(err) = tray(app) {
        eprintln!("알림 영역 아이콘을 만들지 못했어요: {err}");
    }
    let app2 = app.clone();
    list.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => remember(&app2, "list", None),
        // 목록을 닫아도 메모킹은 알림 영역에서 계속 (끝내기는 알림 영역 메뉴로)
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(w) = app2.get_webview_window("list") {
                let _ = w.hide();
            }
        }
        _ => {}
    });
    // 못 여는 메모(지웠거나 메모 폴더가 없음)는 기억에서 뺀다
    let open = state(app).setting("openNotes").as_array().cloned().unwrap_or_default();
    for id in open.iter().filter_map(Value::as_str) {
        if !memos::open_note(app, id).unwrap_or(false) {
            set_open(app, id, false);
        }
    }
    let args: Vec<String> = std::env::args().collect();
    let has_vault = state(app).vault.lock().unwrap().is_some();
    // --hidden: 로그인 때 자동 실행 — 창 없이 알림 영역에서 (메모 폴더가 없으면 고르게 띄운다)
    if !launch(app, &args) && !(has_vault && args.iter().any(|a| a == "--hidden")) {
        show_list(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_only_bounds_on_a_screen() {
        let screen = [[0.0, 0.0, 1920.0, 1040.0]];
        assert_eq!(on_screen(&json!({ "x": 100, "y": 50, "width": 340, "height": 380 }), &screen), Some([100.0, 50.0, 340.0, 380.0]));
        for off in [json!({ "x": 2000, "y": 50, "width": 340, "height": 380 }), json!({ "x": 100, "y": 1030, "width": 340, "height": 380 }), json!({ "width": 440, "height": 680 }), Value::Null] {
            assert_eq!(on_screen(&off, &screen), None, "{off}");
        }
        // 둘째 모니터(왼쪽)에 있던 창은 그 모니터가 있을 때만
        let b = json!({ "x": -1500, "y": 100, "width": 340, "height": 380 });
        assert_eq!(on_screen(&b, &screen), None);
        assert!(on_screen(&b, &[screen[0], [-1920.0, 0.0, 1920.0, 1040.0]]).is_some());
    }

    #[test]
    fn magickey_files_only_from_temp() {
        assert!(magickey_name(r"C:\Users\a\AppData\Local\Temp\magickey-1731-ab_c.txt") && magickey_name("/tmp/MagicKey-x.TXT"));
        for bad in ["/tmp/magickey-.txt", "/tmp/magickey-a b.txt", "/tmp/other.txt", "/tmp/magickey-a.txt.exe", "/tmp/magickey-../x.txt"] {
            assert!(!magickey_name(bad), "{bad}");
        }
        let tmp = std::env::temp_dir();
        let dir = tmp.join(format!("memoking-os-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = tmp.join(format!("magickey-test-{}.txt", std::process::id()));
        let nested = dir.join("magickey-nested.txt");
        let big = tmp.join(format!("magickey-big-{}.txt", std::process::id()));
        std::fs::write(&ok, "# 글").unwrap();
        std::fs::write(&nested, "x").unwrap();
        std::fs::write(&big, vec![b'a'; 1024 * 1024 + 1]).unwrap();
        assert_eq!(magickey_file(ok.to_str().unwrap(), &tmp).map(|(_, t)| t).as_deref(), Some("# 글"));
        assert!(magickey_file(nested.to_str().unwrap(), &tmp).is_none());
        assert!(magickey_file(big.to_str().unwrap(), &tmp).is_none());
        assert!(magickey_file("/nowhere/magickey-x.txt", &tmp).is_none());
        for f in [&ok, &big] {
            let _ = std::fs::remove_file(f);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
