// 운영체제와 붙는 곳 — 한 번만 켜기 · 실행 인자(MagicKey 약속, docs/magickey.md) · 알림 영역 아이콘 · 창 자리 기억.
//   Electron 의 main.js(handleLaunch · 트레이) · jump-list.js(launchAction · readMagicKeyFile) · window-manager.js(listBounds · noteBounds · openNotes) 자리.
use crate::memos;
use crate::state::state;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

type Builder<'a> = WebviewWindowBuilder<'a, Wry, AppHandle>;

/// 끝내는 중 — 이때 닫히는 메모는 "열려 있던 메모"로 남긴다 (다음에 켜면 다시 연다)
static QUITTING: AtomicBool = AtomicBool::new(false);

// ---------- 창 자리 ----------

/// Electron onScreen 그대로: 작업 영역에 창 윗막대를 잡을 만큼 걸쳐 있나 (논리 픽셀 { x, y, width, height })
pub fn on_screen(b: &Value, areas: &[[f64; 4]]) -> Option<[f64; 4]> {
    let n = |k: &str| b[k].as_f64();
    let (x, y, w, h) = (n("x")?, n("y")?, n("width")?, n("height")?);
    areas.iter().any(|&[ax, ay, aw, ah]| x < ax + aw - 40.0 && x + w > ax + 40.0 && y >= ay - 10.0 && y < ay + ah - 40.0).then_some([x, y, w, h])
}

// shortcut: 화면마다 배율이 다르면 논리 좌표가 Electron(DIP)과 조금 어긋날 수 있다 — 여러 배율 모니터에서 자리가 틀어지면 물리 좌표로 바꾸기
pub fn work_areas(app: &AppHandle) -> Vec<[f64; 4]> {
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

/// 목록 창: 기억한 자리에, 처음에는 숨겨서 (start 가 띄울지 정한다) · 늘 위에 두던 목록은 그대로
pub fn place_list<'a>(app: &AppHandle, b: Builder<'a>) -> Builder<'a> {
    place(app, b, &state(app).setting("listBounds")).visible(false).always_on_top(state(app).setting("listOnTop") == true)
}

pub fn place_note<'a>(app: &AppHandle, id: &str, b: Builder<'a>) -> Builder<'a> {
    place(app, b, &state(app).setting("noteBounds")[id])
}

// 창을 끄는 동안 Moved 가 줄줄이 온다 — 멈추고 잠깐 뒤에 한 번만 쓴다
//   기다리는 스레드는 하나만 (예전: 창을 끄는 동안 이벤트마다 스레드를 새로 띄웠다)
fn save_soon(app: &AppHandle) {
    static GEN: AtomicU64 = AtomicU64::new(0);
    static WAITING: AtomicBool = AtomicBool::new(false);
    GEN.fetch_add(1, Ordering::SeqCst);
    if WAITING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut seen = GEN.load(Ordering::SeqCst);
        loop {
            std::thread::sleep(Duration::from_millis(400));
            let now = GEN.load(Ordering::SeqCst);
            if now == seen {
                break;
            }
            seen = now;
        }
        WAITING.store(false, Ordering::SeqCst);
        state(&app).save_settings();
        // 쓰는 사이 또 바뀌었으면 한 번 더
        if GEN.load(Ordering::SeqCst) != seen {
            save_soon(&app);
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

pub fn set_open(app: &AppHandle, id: &str, open: bool) {
    let st = state(app);
    let mut list = st.setting("openNotes").as_array().cloned().unwrap_or_default();
    list.retain(|x| x != id);
    if open {
        list.push(id.into());
    }
    st.settings.lock().unwrap().insert("openNotes".into(), list.into());
    save_soon(app); // 메모 창을 닫을 때(메인 스레드) 설정 파일 쓰기를 기다리지 않게
}

/// 메모 창을 만들었다 (memos::create_note_window): 옮기면 자리를 기억한다. 열린 메모로는 보일 때 기억한다 (windows::shown)
pub fn track_note(app: &AppHandle, id: &str, win: &WebviewWindow) {
    let (app, id, label) = (app.clone(), id.to_string(), win.label().to_string());
    win.on_window_event(move |e| match e {
        // 예비 창으로 되돌려 이제 다른 메모의 창이면 그 메모 몫의 처리가 맡는다
        WindowEvent::Moved(_) | WindowEvent::Resized(_) if state(&app).note_labels.lock().unwrap().get(&id) == Some(&label) => remember(&app, &label, Some(&id)),
        // memos::closed_note 다음에 온다 (먼저 단 것이 먼저) — 비워서 치운 메모 · 휴지통으로 간 메모는 자리도 잊는다
        WindowEvent::Destroyed if !QUITTING.load(Ordering::SeqCst) => note_closed(&app, &id),
        _ => {}
    });
}

pub fn quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// 메모 창이 닫혔다 (없어졌거나 예비 창으로 되돌렸다): 열린 메모에서 빼고, 비워서 치운 메모면 자리도 잊는다
pub fn note_closed(app: &AppHandle, id: &str) {
    // 닫는 사이 다시 열어 새 창이 이어받았다 (memos::closed_note 가 그 창을 남겨 둔다)
    if state(app).note_labels.lock().unwrap().contains_key(id) {
        return;
    }
    forget_bounds_if_gone(app, id);
    set_open(app, id, false);
}

/// 비워서 치운 메모 · 휴지통으로 간 메모의 창 자리를 잊는다 (닫은 메모 정리가 끝난 뒤에도 다시 본다)
pub fn forget_bounds_if_gone(app: &AppHandle, id: &str) {
    let gone = state(app).vault.lock().unwrap().as_ref().is_some_and(|v| v.entry(id).is_none());
    if gone {
        if let Some(Value::Object(m)) = state(app).settings.lock().unwrap().get_mut("noteBounds") {
            m.remove(id);
        }
    }
}

// ---------- 목록 창 · 알림 영역 ----------

pub fn show_list(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    crate::windows::sync_list_crown(app);
}

pub fn toggle_list(app: &AppHandle) {
    let Some(w) = app.get_webview_window("list") else { return };
    if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
        crate::windows::sync_list_crown(app);
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
    // 닫기 길로 (windows::track: 숨기고 남은 글을 저장한 뒤 없앤다, 늦어도 3초). 자동 저장 전의 마지막 글을 잃지 않게
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.close();
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

/// Electron shorten: 28자(UTF-16)가 넘으면 27자 + …
fn shorten(t: &str) -> String {
    if t.encode_utf16().count() > 28 {
        format!("{}…", memoking_core::js::slice16(t, 27))
    } else {
        t.to_string()
    }
}

/// 목록 창을 그 탭으로 (Electron createListWindow(tab))
fn show_list_tab(app: &AppHandle, tab: &str) {
    show_list(app);
    let _ = app.emit_to("list", "list:tab", [tab]);
}

/// 열린 메모 모두 앞으로 (Electron showAllNotes). 숨은 창(스택의 다른 탭)은 그대로
fn show_all_notes(app: &AppHandle) {
    let labels: Vec<String> = state(app).note_labels.lock().unwrap().values().cloned().collect();
    for w in labels.iter().filter_map(|l| app.get_webview_window(l)).filter(|w| w.is_visible().unwrap_or(false)) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 알림 영역 메뉴 (Electron updateTrayMenu)
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let st = state(app);
    let recent: Option<Vec<(String, String)>> = st.vault.lock().unwrap().as_ref().map(|v| {
        let s = |m: &Value, k: &str| m[k].as_str().unwrap_or_default().to_string();
        v.list().iter().take(5).map(|m| (s(m, "id"), s(m, "title"))).collect()
    });
    let has_vault = recent.is_some();
    let item = |id: &str, text: &str, on: bool| MenuItem::with_id(app, format!("tray:{id}"), text, on, None::<&str>);
    let sep = || PredefinedMenuItem::separator(app);
    let recent: Vec<MenuItem<Wry>> = match recent.unwrap_or_default() {
        r if r.is_empty() => vec![MenuItem::new(app, "없음", false, None::<&str>)?],
        r => r.iter().map(|(id, title)| item(&format!("memo:{id}"), &shorten(title), true)).collect::<tauri::Result<_>>()?,
    };
    let recent: Vec<&dyn IsMenuItem<Wry>> = recent.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let quick = crate::shortcuts::status(app, "quickMemo");
    let quick_on = quick["enabled"] == true;
    let quick_held = quick_on && quick["registered"] == true;
    let quick_label = format!("매직 카피 {} (두 번: 화면 캡처){}", quick["label"].as_str().unwrap_or_default(), if quick_on && !quick_held { ", 다른 앱이 쓰는 중" } else { "" });
    let auto = crate::files::auto_start(app);
    let auto_ok = auto["available"] == true;
    let auto_label = if auto_ok { "PC를 켜면 메모킹도 함께 켜기" } else { "PC를 켜면 메모킹도 함께 켜기 (설치한 메모킹에서)" };
    let has_notes = !st.note_labels.lock().unwrap().is_empty();
    Menu::with_items(
        app,
        &[
            &item("list", "메모 목록 열기", true)?,
            &item("new", "새 메모", has_vault)?,
            &item("capture", "화면 캡처로 새 메모", has_vault)?,
            &item("clipboard", "복사해 둔 내용으로 새 메모", has_vault)?,
            &sep()?,
            // 들여 쓴 흐린 머리말 대신 하위 메뉴 (Windows 메뉴의 "최근 항목" 처럼)
            &Submenu::with_items(app, "최근 메모", true, &recent)?,
            &sep()?,
            &item("reminders", "일정", true)?,
            &item("history", "알림 보관함", true)?,
            &item("show-all", "열린 메모 모두 앞으로", has_notes)?,
            &item("folder", "메모 폴더 열기", has_vault)?,
            &sep()?,
            &CheckMenuItem::with_id(app, "tray:quick", quick_label, true, quick_held, None::<&str>)?,
            &CheckMenuItem::with_id(app, "tray:auto", auto_label, auto_ok, auto["enabled"] == true, None::<&str>)?,
            &sep()?,
            &item("tutorial", "사용법 둘러보기", has_vault)?,
            &item("quit", "메모킹 종료", true)?,
        ],
    )
}

/// 메모 · 열린 창 · 단축키 · 설정이 바뀌면 알림 영역 메뉴를 다시 만든다. 잇달아 불리면 0.3초 뒤 한 번만
pub fn refresh_tray(app: &AppHandle) {
    static GEN: AtomicU64 = AtomicU64::new(0);
    let n = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        if GEN.load(Ordering::SeqCst) != n {
            return;
        }
        if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), tray_menu(&app)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

fn tray_chosen(app: &AppHandle, id: &str) {
    match id {
        "list" => show_list(app),
        "new" => {
            if !new_memo(app) {
                show_list(app); // 메모 폴더가 없으면 고르는 화면으로
            }
        }
        "capture" => {
            crate::services::start_area_capture(app);
        }
        // 지금 클립보드의 글 · 파일 · 그림으로 (매직 카피에서 Ctrl+C 만 빼고, capture.rs)
        "clipboard" => {
            let app = app.clone();
            std::thread::spawn(move || crate::capture::magic_copy(&app, false));
        }
        "reminders" | "history" => show_list_tab(app, id),
        "show-all" => show_all_notes(app),
        "folder" => {
            let _ = crate::files::handle(app, "list", "vault:reveal", &[]);
        }
        // 누르기 전의 체크를 뒤집는다 (Electron item.checked)
        "quick" => {
            let s = crate::shortcuts::status(app, "quickMemo");
            let _ = crate::shortcuts::handle(app, "list", "app:set-quick-memo", &[(!(s["enabled"] == true && s["registered"] == true)).into()]);
        }
        "auto" => {
            let on = crate::files::auto_start(app)["enabled"] != true;
            let _ = crate::files::handle(app, "list", "app:set-auto-start", &[on.into()]);
        }
        "tutorial" => {
            crate::shortcuts::start_tutorial(app);
        }
        "quit" => quit(app),
        _ => {
            if let Some(memo) = id.strip_prefix("memo:") {
                let _ = memos::open_note(app, memo);
            }
        }
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon().cloned() else { return Ok(()) };
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("메모킹")
        .menu(&tray_menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| {
            // 창 만들기 · 단축키 잡기는 이벤트 처리(메인 스레드) 안에서 하면 Windows 에서 멈춘다. 다른 스레드에서
            if let Some(id) = e.id.as_ref().strip_prefix("tray:").map(str::to_string) {
                let app = app.clone();
                std::thread::spawn(move || tray_chosen(&app, &id));
            }
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

/// 글 첫 줄의 날짜 → { at, hasTime, repeat, end, title } (date-detect.js remindFromText) · 없으면 None
fn remind_from_text(text: &str, now: chrono::DateTime<chrono::Local>) -> Option<Value> {
    use memoking_core::date_detect::{find_dates, guess_title};
    let line = text.split('\n').next().unwrap_or_default();
    let w = find_dates(line, now).into_iter().next()?;
    let iso = |t: chrono::DateTime<chrono::Local>| t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut d = json!({ "at": iso(w.at), "hasTime": w.has_time, "repeat": w.repeat, "title": guess_title(line, w.from, w.to) });
    if let Some(end) = w.end {
        d["end"] = iso(end).into();
    }
    Some(d)
}

/// 실행 인자대로 (jump-list.js launchAction · main.js handleLaunch) — 메모 창을 열었으면 true (아니면 부르는 쪽이 목록을 띄운다)
fn launch(app: &AppHandle, args: &[String]) -> bool {
    let val = |p: &str| args.iter().find_map(|a| a.strip_prefix(p).map(str::to_string));
    if let Some(id) = val("--open-memo=").filter(|id| (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
        return memos::open_note(app, &id).unwrap_or(false);
    }
    if let Some(file) = val("--new-memo-file=").filter(|f| magickey_name(f)) {
        let Some((real, text)) = magickey_file(&file, &std::env::temp_dir()) else { return false };
        let open = args.iter().any(|a| a == "--open-new");
        let Some(Ok(id)) = memos::handle(app, "list", "memo:import", &[text.clone().into(), json!({ "open": open })]) else { return false };
        let _ = std::fs::remove_file(real); // 저장한 뒤에야 지운다 (실패하면 글이 남게)
        let id = id.as_str().unwrap_or_default().to_string();
        // "알림 맞춰 저장"(--remind): 첫 줄의 날짜로 일정 하나 (날짜를 못 찾으면 알림 없이 저장)
        let now = chrono::Local::now();
        let event = args.iter().any(|a| a == "--remind").then(|| remind_from_text(&text, now)).flatten().and_then(|d| memoking_core::reminders::event_from_date(&d, now));
        let saved = event.and_then(|r| crate::reminders::handle(app, "list", "reminders:set", &[id.clone().into(), json!([r])])).and_then(Result::ok).and_then(|v| v.get(0).cloned());
        // 열지 않으면 Windows 알림 (누르면 열기)
        if !open {
            let first: String = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().trim_start_matches('#').trim().chars().take(40).collect();
            let when = saved.map(|r| format!("알림: {}", memoking_core::reminders::describe_reminder(&r, now))).unwrap_or_default();
            crate::reminders::toast(app, &id, "메모를 만들었어요", &first, &if when.is_empty() { "눌러서 열기".to_string() } else { format!("{when} · 눌러서 열기") }, None);
        }
        return true;
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
        elog!("알림 영역 아이콘을 만들지 못했어요: {err}");
    }
    let app2 = app.clone();
    list.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            remember(&app2, "list", None);
            crate::windows::sync_list_crown(&app2);
        }
        // 목록을 닫아도 메모킹은 알림 영역에서 계속 (끝내기는 알림 영역 메뉴로)
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(w) = app2.get_webview_window("list") {
                let _ = w.hide();
            }
            crate::windows::sync_list_crown(&app2);
        }
        _ => {}
    });
    // 늘 위 목록 창의 왕관 (창이 보이면 붙는다 — show_list)
    if state(app).setting("listOnTop") == true {
        crate::windows::set_list_crown(app, true, false);
    }
    let args: Vec<String> = std::env::args().collect();
    let has_vault = state(app).vault.lock().unwrap().is_some();
    // --hidden: 로그인 때 자동 실행 — 창 없이 알림 영역에서 (메모 폴더가 없으면 고르게 띄운다)
    let show = !launch(app, &args) && !(has_vault && args.iter().any(|a| a == "--hidden"));
    let open: Vec<String> = state(app).setting("openNotes").as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    RESTORING.store(!open.is_empty(), Ordering::SeqCst);
    // 목록은 바로 — 앱 바탕색에 로딩 화면(index.html #boot)을 보이다가, 열어 둔 메모가 함께 뜰 때(app:ready) 걷는다
    if show {
        show_list(app);
    }
    if open.is_empty() {
        return;
    }
    // 지난번 열어 둔 메모: 숨긴 채 모두 만들어 다 그리면(늦어도 RESTORE_WAIT) 목록과 함께 한꺼번에 보인다 — 하나씩 뜨면 굼떠 보였다.
    //   창 만들기는 이벤트 처리 안에서 하면 Windows 에서 멈춘다 — 다른 스레드에서
    let app = app.clone();
    std::thread::spawn(move || restore_notes(&app, &open));
}

/// 다시 켤 때 메모 창들을 기다리는 최대 시간 — 넘으면 다 그리지 못한 창도 함께 보인다
const RESTORE_WAIT: Duration = Duration::from_millis(2500);

fn restore_notes(app: &AppHandle, open: &[String]) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut made = 0;
    for id in open {
        // 못 여는 메모(지웠거나 메모 폴더가 없음)는 기억에서 뺀다
        let exists = state(app).vault.lock().unwrap().as_ref().is_some_and(|v| v.entry(id).is_some());
        if !exists {
            set_open(app, id, false);
            continue;
        }
        let tx = tx.clone();
        let ready: crate::windows::Action = Box::new(move |_: &AppHandle| {
            let _ = tx.send(());
        });
        if memos::create_note_window(app, id, None, false, Some(ready)).is_ok() {
            made += 1;
        }
    }
    let until = std::time::Instant::now() + RESTORE_WAIT;
    for _ in 0..made {
        if rx.recv_timeout(until.saturating_duration_since(std::time::Instant::now())).is_err() {
            break;
        }
    }
    // 이제 한꺼번에: 메모들을 보이고 목록의 로딩 화면을 걷는다 (이미 만든 창을 보이기만 해서 거의 같은 순간에 뜬다 · 스택 탭은 그 자리 · 스티커와 함께)
    for id in open {
        if !memos::open_note(app, id).unwrap_or(false) {
            set_open(app, id, false);
        }
    }
    RESTORING.store(false, Ordering::SeqCst);
    let _ = app.emit_to("list", "app:ready", [Value::Null]);
}

/// 켤 때 열어 둔 메모 창들을 준비하는 중인가 — 목록의 로딩 화면이 묻는다 (app:restoring)
pub static RESTORING: AtomicBool = AtomicBool::new(false);

/// 창 바탕을 앱 바탕색으로 (base.css --surface-0) — 화면을 읽기 전부터 흰 창이 아니라 메모킹 색이 보이게
pub fn paint_bg(w: &WebviewWindow) {
    let dark = matches!(w.theme(), Ok(tauri::Theme::Dark));
    let c = if dark { tauri::window::Color(0x0e, 0x0e, 0x0d, 0xff) } else { tauri::window::Color(0xf6, 0xf5, 0xf1, 0xff) };
    let _ = w.set_background_color(Some(c));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remind_from_first_line_date() {
        use chrono::{Datelike, TimeZone, Timelike};
        let now = chrono::Local.with_ymd_and_hms(2026, 11, 18, 10, 0, 0).unwrap();
        let d = remind_from_text("내일 오후 3시 치과\n둘째 줄 모레 5시", now).unwrap();
        assert_eq!(d["title"], "치과");
        assert_eq!(d["hasTime"], true);
        // 화면 · 저장은 지역 시각: UTC 로 적은 at 이 이 PC 시각 내일 15:00 이어야 (시간대가 어긋나면 9시간 틀린다)
        let at = chrono::DateTime::parse_from_rfc3339(d["at"].as_str().unwrap()).unwrap().with_timezone(&chrono::Local);
        assert_eq!((at.day(), at.hour(), at.minute()), (19, 15, 0));
        let r = memoking_core::reminders::event_from_date(&d, now).unwrap();
        let start = chrono::DateTime::parse_from_rfc3339(r["at"].as_str().unwrap()).unwrap().with_timezone(&chrono::Local);
        assert_eq!((start.day(), start.hour()), (19, 15));
        assert_eq!(r["title"], "치과");
        assert!(remind_from_text("날짜 없는 글\n내일 3시", now).is_none()); // 첫 줄만 본다
    }

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
    fn tray_titles_like_electron_shorten() {
        assert_eq!(shorten("짧은 제목"), "짧은 제목");
        assert_eq!(shorten(&"가".repeat(28)), "가".repeat(28));
        assert_eq!(shorten(&"가".repeat(29)), format!("{}…", "가".repeat(27)));
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
