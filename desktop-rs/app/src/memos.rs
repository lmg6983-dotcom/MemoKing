// 메모 채널 — 메모 폴더 · 목록 · 메모 창 열고 닫기 · 저장. Electron 의 ipc-handlers.js · window-manager.js 의 그 부분.
use crate::state::{state, State};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

// 1×1 빨간 점 (점검용 그림)
const DOT_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

const NO_VAULT: &str = "메모 폴더가 아직 없어요. 먼저 메모 폴더를 골라 주세요";

pub(crate) fn arg_str(args: &[Value], i: usize) -> String {
    args.get(i).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// 메모 폴더를 쓰는 일 (없으면 Err)
pub(crate) fn with_vault<T>(app: &AppHandle, f: impl FnOnce(&mut memoking_core::vault::Vault) -> Result<T, String>) -> Result<T, String> {
    let st = state(app);
    let mut guard = st.vault.lock().unwrap();
    f(guard.as_mut().ok_or(NO_VAULT)?)
}

/// 켤 때: 설정의 메모 폴더를 연다 (없으면 화면이 고르게 둔다)
pub fn start(app: &AppHandle) {
    let st = state(app);
    if let Some(dir) = st.setting("vaultPath").as_str().filter(|d| !d.is_empty()) {
        // 쓰던 폴더가 없어졌으면 빈 폴더를 새로 만들지 않는다 — 동기화가 "모두 지웠다" 로 읽어 Drive · 휴대폰에서도 지우므로
        if Path::new(dir).exists() {
            st.open_vault(app, PathBuf::from(dir));
        } else {
            *st.vault_missing.lock().unwrap() = Some(dir.to_string());
        }
    } else if crate::ipc::smoke() {
        // 점검용 메모 폴더: 그림이 든 메모 하나 (smoke.js 가 목록 · 그림 · 새 메모 · 저장을 본다)
        let dir = State::suggested_vault(app);
        let _ = std::fs::create_dir_all(dir.join("attachments"));
        let _ = std::fs::write(dir.join("시험 메모.md"), "---\nid: smoke-seed\ncolor: green\n---\n# 시험 메모\n\n#점검 ![점](attachments/dot.png)\n");
        let _ = std::fs::write(dir.join("attachments/dot.png"), DOT_PNG);
        let _ = std::fs::write(dir.join("attachments/clip.mp4"), include_bytes!("../smoke-clip.mp4")); // 동영상 점검 (96x64 H.264 2초)
        let _ = std::fs::write(dir.join("attachments/clip-hevc.mp4"), include_bytes!("../smoke-clip-hevc.mp4")); // 같은 크기 HEVC 10비트 + 소리 (video.rs)
        st.open_vault(app, dir);
    }
    // 앱을 켤 때: 가장 최근에 고친 5개 중 다른 기기에서 방금 고친 것
    let recent: Vec<String> = st.vault.lock().unwrap().as_ref().map(|v| v.list()).unwrap_or_default().iter().take(5).filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
    show_handoff(app, recent);
    // 다른 기기 · 탐색기에서 바뀐 메모 — 2초마다 다시 읽는다
    schedule_spare(app, 3000);
    // shortcut: 파일 감시(fs.watch)는 아직 — 다시 읽기는 파일 시각만 보므로 가볍다. 늦다는 말이 나오면 notify 로
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        rescan(&app);
        crate::index::tick(&app);
        crate::windows::discard_tick(&app); // 오래 숨은 스택 탭 거두기 (30초마다 본다)
    });
}

pub fn rescan(app: &AppHandle) {
    let st = state(app);
    let (external, removed) = {
        let mut guard = st.vault.lock().unwrap();
        let Some(v) = guard.as_mut() else { return };
        let c = v.scan();
        if c.is_empty() {
            return;
        }
        let ext: Vec<(String, Value)> = c.external.iter().filter(|id| !c.removed.contains(id)).map(|id| (id.clone(), v.get(id).unwrap_or(Value::Null))).collect();
        (ext, c.removed)
    };
    show_handoff(app, external.iter().map(|(id, _)| id.clone()).collect());
    for (id, memo) in external {
        send_to_note(app, &id, "memo:external", [memo]);
    }
    for id in removed {
        send_to_note(app, &id, "memo:removed", [Value::Null; 0]);
    }
    crate::shortcuts::refresh(app); // 다른 기기에서 지운 메모의 단축키는 놓아 다른 앱이 쓰게
    push_list(app);
}

/// 이어 쓰기 안내: 다른 기기에서 방금 고친 메모 하나를 목록에 알린다 (열어 둔 메모는 화면이 새 글을 보여 주므로 본 것으로만)
fn show_handoff(app: &AppHandle, ids: Vec<String>) {
    let st = state(app);
    let now = chrono::Local::now().timestamp_millis();
    let open: Vec<String> = st.note_labels.lock().unwrap().keys().cloned().collect();
    for id in ids {
        let Ok(Some(m)) = with_vault(app, |v| Ok(v.get(&id))) else { continue };
        let Some(from) = memoking_core::handoff::handoff_from(m["device"].as_str(), m["updated"].as_str(), now) else { continue };
        if !st.handoff.lock().unwrap().0.insert(format!("{id}@{}", m["updated"])) || open.contains(&id) {
            continue;
        }
        let last = json!({ "id": id, "title": m["title"], "from": from, "at": now });
        st.handoff.lock().unwrap().1 = Some(last.clone());
        let _ = app.emit_to("list", "memo:handoff", [last]);
        return;
    }
}

fn send_to_note<S: serde::Serialize + Clone>(app: &AppHandle, id: &str, event: &str, payload: S) {
    if let Some(label) = state(app).note_labels.lock().unwrap().get(id) {
        let _ = app.emit_to(label.as_str(), event, payload);
    }
}

/// 목록 창의 메모 카드들 (열린 메모 표시와 함께)
fn list_memos(app: &AppHandle) -> Value {
    let list = state(app).vault.lock().unwrap().as_ref().map(|v| v.list()).unwrap_or_default();
    with_open_flag(app, list)
}

fn with_open_flag(app: &AppHandle, list: Vec<Value>) -> Value {
    let st = state(app);
    let flags = crate::windows::card_flags(app);
    let views = st.setting("viewCounts");
    let hotkeys = crate::shortcuts::hotkeys(app);
    Value::Array(
        list.into_iter()
            .map(|mut m| {
                let id = m["id"].as_str().unwrap_or_default().to_string();
                let o = m.as_object_mut().unwrap();
                let [open, stack, taped] = flags(&id);
                o.insert("open".into(), open);
                o.insert("stack".into(), stack);
                o.insert("taped".into(), taped);
                o.insert("hotkey".into(), memoking_core::accelerators::slot_of(&hotkeys, &id).into());
                o.insert("views".into(), views.get(&id).cloned().unwrap_or(0.into()));
                m
            })
            .collect(),
    )
}

/// 곧 push_list: 창을 열고 닫고 탭을 바꿀 때 몇 번씩 불러도 목록은 한 번만 새로, 부른 스레드(메인 스레드일 수 있다)를 붙잡지 않고 (Electron pushList 처럼 80ms 모아서)
pub fn push_list_soon(app: &AppHandle) {
    static GEN: AtomicU64 = AtomicU64::new(0);
    let n = GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        if GEN.load(Ordering::Relaxed) == n {
            push_list(&app);
        }
    });
}

// 폴더가 바뀌었다 — 열린 메모 창의 폴더 표시도 새로
fn refresh_note_files(app: &AppHandle) {
    let labels: Vec<(String, String)> = state(app).note_labels.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (id, label) in labels {
        let file = with_vault(app, |v| Ok(v.get(&id).map(|m| m["file"].clone()).unwrap_or(Value::Null))).unwrap_or(Value::Null);
        let _ = app.emit_to(label.as_str(), "memo:meta", [json!({ "file": file })]);
    }
}

/// 설정 화면이 읽는 것 (utils.js appSettings) — 아직 옮기지 않은 것은 "쓸 수 없음" 으로
fn app_settings(app: &AppHandle) -> Value {
    let st = state(app);
    let s = |k: &str| st.setting(k);
    let not_false = |k: &str| s(k) != false;
    let status = |name| crate::shortcuts::status(app, name);
    let quick = status("quickMemo");
    json!({
        "trashDays": s("trashDays").as_u64().unwrap_or(30),
        "trashCount": with_vault(app, |v| Ok(v.trash_list().len())).unwrap_or(0),
        "autoStart": crate::files::auto_start(app),
        "historyEnabled": s("historyEnabled") == true,
        "quickMemo": { "enabled": not_false("quickMemo"), "registered": quick["registered"], "key": quick["label"] },
        "shortcuts": { "quickMemo": quick, "magic": status("magic"), "list": status("list") },
        "magicPolish": not_false("magicPolish"),
        // 나눠 쓰지 않으면 늘 Life (Electron viewMode)
        "mode": if s("workLife") == true && s("mode") == "work" { "work" } else { "life" },
        "workLife": s("workLife") == true,
        "workHours": crate::settings::normalize_hours(&s("workHours")),
        "keymap": Value::Object(crate::settings::clean_overrides(&s("keymap"))),
        "version": app.package_info().version.to_string(),
    })
}

pub fn push_list(app: &AppHandle) {
    crate::index::mark(); // 메모가 바뀌면 목록에 알릴 때마다 — 색인도 다시
    crate::drive::request(1000); // Google Drive 에도 (메모 저장은 이미 0.6초 모아서 오므로 1초면 충분)
    let _ = app.emit_to("list", "memos:changed", [list_memos(app)]);
    crate::secret::push(app); // 비밀 폴더 · 비밀 메모 카드도 (목록(list)에는 들지 않는다 — 다른 기기에서 만든 비밀 폴더도 보이게)
    crate::windows::push_all_stacks(app);
    crate::os::refresh_tray(app); // 알림 영역의 최근 메모 · 열린 메모 (메모 창을 열고 닫을 때도 여기로 온다)
}

// 창 이름에 쓸 수 있는 글자만 — 메모 id 는 다른 앱이 쓴 아무 글자일 수 있다
static NEXT_NOTE: AtomicU64 = AtomicU64::new(1);

pub fn query_escape(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// 메모 창 열기 (이미 열려 있으면 앞으로, 스택의 탭이면 그 탭을 보인다)
pub fn open_note(app: &AppHandle, id: &str) -> Result<bool, String> {
    let st = state(app);
    if !with_vault(app, |v| Ok(v.entry(id).is_some()))? {
        return Ok(false);
    }
    if crate::windows::in_stack(app, id) {
        return Ok(crate::windows::show_tab(app, id, None, true));
    }
    let label = st.note_labels.lock().unwrap().get(id).cloned();
    if label.as_deref().and_then(|l| crate::windows::reopen_closing(app, id, l)).is_some() {
        return Ok(true); // 문서를 PDF 로 바꾸느라 숨은 채 닫는 중이던 창 — 그 창을 다시
    }
    if let Some(w) = label.filter(|l| !crate::windows::is_closing(l)).and_then(|l| app.get_webview_window(&l)) {
        // 마우스를 올려 미리 그리는 중인 창: 다 그리면 보인다 (그리기 전에 보이면 빈 투명 창 — 두 번 눌러야 열렸다)
        PRELOADED.lock().unwrap().retain(|l| l != w.label()); // 미리 그린 창을 연다 — 거두지 않게
        if crate::windows::reveal_when_painted(w.label(), id) {
            return Ok(true);
        }
        let _ = w.unminimize();
        crate::windows::show_note_win(&w);
        let _ = w.set_focus();
        crate::windows::shown(app, id, &w);
        return Ok(true);
    }
    let win = create_note_window(app, id, None, true, None)?;
    crate::windows::shown(app, id, &win);
    Ok(true)
}

// 메모 창은 투명 창으로 만든다 — WebView2 가 창 크기보다 한 프레임 늦게 그려 크기를 바꿀 때 끈적이고 가장자리에 검은 · 흰 띠가 비치던 것
//   (tauri-apps/tauri#13270: 투명 창이면 부드럽다). 화면(note.css)이 바탕을 칠하고, 창은 다 그린 뒤에 보인다 (예비 창 · 숨겨 만든 창)

/// 미리 불러 둔 메모 창 (Electron makeSpare): 편집기를 다 읽어 두고 열 메모를 기다린다
struct Spare {
    label: String,
    /// 화면이 메모를 기다리는 중이면(win:spare) 메모를 건넬 곳
    assign: Option<std::sync::mpsc::Sender<Value>>,
}

static SPARE: Mutex<Vec<Spare>> = Mutex::new(Vec::new());
/// 예비 창 수 — 메모를 연달아 열어도(목록에서 둘 · 셋) 매번 창을 새로 만들며 기다리지 않게
const SPARE_MAX: usize = 1; // 닫은 창을 예비 창으로 되돌려 쓰므로 하나면 된다 (windows::retire_note)
/// 예비 창을 쓴 뒤 다음 것을 만들기까지 — 방금 연 메모를 그리는 동안은 비켜 준다 (예전 3초: 그 안에 또 열면 새 창을 처음부터 만들었다)
const SPARE_REFILL_MS: u64 = 600;
static SPARE_GEN: AtomicU64 = AtomicU64::new(0);

/// ms 뒤 예비 창을 하나 만들어 둔다 (그사이 또 부르면 그 뒤로 미룬다)
fn schedule_spare(app: &AppHandle, ms: u64) {
    let n = SPARE_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        if SPARE_GEN.load(Ordering::Relaxed) == n {
            make_spare(&app);
        }
    });
}

fn make_spare(app: &AppHandle) {
    // 점검(smoke)은 창마다 점검을 돌려 알려 온 창 수를 센다. 예비 창을 섞지 않는다
    if crate::ipc::smoke() || state(app).vault.lock().unwrap().is_none() {
        return;
    }
    let label = format!("note-{}", NEXT_NOTE.fetch_add(1, Ordering::Relaxed));
    let more = {
        let mut g = SPARE.lock().unwrap();
        g.retain(|s| app.get_webview_window(&s.label).is_some());
        if g.len() >= SPARE_MAX {
            return;
        }
        g.push(Spare { label: label.clone(), assign: None });
        g.len() < SPARE_MAX
    };
    let forget = move |label: &str| {
        SPARE.lock().unwrap().retain(|s| s.label != label); // 기다리던 win:spare 는 null 을 받고 창을 닫는다
    };
    match crate::window(app, &label, "note.html?spare=1").inner_size(340.0, 380.0).min_inner_size(240.0, 200.0).visible(false).transparent(true).build() {
        Ok(w) => {
            crate::windows::memory_low(&w, true); // 기다리는 동안은 덜 (메모를 건네받아 포커스를 받으면 보통)
            let l = label.clone();
            w.on_window_event(move |e| {
                if let WindowEvent::Destroyed = e {
                    forget(&l);
                }
            });
        }
        Err(_) => forget(&label),
    }
    // 둘째 예비 창은 첫 창이 편집기를 다 읽은 뒤에 (동시에 만들면 둘 다 늦다)
    if more {
        schedule_spare(app, 1500);
    }
}

/// 예비 창 자리가 남았나 (닫은 창을 되돌려 넣을 수 있나)
pub fn spare_room(app: &AppHandle) -> bool {
    let mut g = SPARE.lock().unwrap();
    g.retain(|s| app.get_webview_window(&s.label).is_some()); // 되돌려 쓴 예비 창은 없어질 때 알려 주지 않는다 — 없어진 것은 빼고 센다
    g.len() < SPARE_MAX
}

/// 닫은 메모 창을 예비 창으로: 화면을 예비 창 모드로 다시 읽는다 (웹뷰 · 창은 그대로 — 다시 만드는 것이 여는 시간의 대부분)
pub fn recycle_spare(w: &tauri::WebviewWindow) {
    let label = w.label().to_string();
    {
        let mut g = SPARE.lock().unwrap();
        if g.len() >= SPARE_MAX || g.iter().any(|s| s.label == label) {
            drop(g);
            let _ = w.destroy();
            return;
        }
        g.push(Spare { label: label.clone(), assign: None });
    }
    let _ = w.set_always_on_top(false);
    let _ = w.set_title("메모킹");
    crate::windows::memory_low(w, true);
    let url = w.url().ok().map(|mut u| {
        u.set_query(Some("spare=1"));
        u
    });
    if url.is_none_or(|u| w.navigate(u).is_err()) {
        SPARE.lock().unwrap().retain(|s| s.label != label);
        let _ = w.destroy();
    }
}

/// 쓸 수 있는 예비 창 (화면이 메모를 기다리는 중일 때만). 가져가면 다음 것은 새로
fn take_spare(app: &AppHandle) -> Option<(tauri::WebviewWindow, std::sync::mpsc::Sender<Value>)> {
    let mut g = SPARE.lock().unwrap();
    let i = g.iter().position(|s| s.assign.is_some() && app.get_webview_window(&s.label).is_some())?;
    let s = g.remove(i);
    Some((app.get_webview_window(&s.label)?, s.assign?))
}

/// 메모 창 만들기: bounds 가 없으면 기억한 자리, show 가 false 면 숨겨서. ready: 메모를 다 그리면 (스택 탭: windows.rs 가 그때 보인다)
///   보이거나 ready 가 있는 창은 예비 창을 쓴다 (편집기를 새로 읽지 않아 바로 뜬다). 둘 다 없으면(옆 탭 미리 만들기) 예비 창은 남겨 둔다
// shortcut: 기억한 자리(noteBounds)가 없으면 기본 크기로 화면 가운데쯤 (예비 창이면 그 창이 만들어진 자리)
pub fn create_note_window(app: &AppHandle, id: &str, bounds: Option<[f64; 4]>, show: bool, ready: Option<crate::windows::Action>) -> Result<tauri::WebviewWindow, String> {
    // memo:open 이 둘 겹치면(채널은 spawn_blocking) 둘 다 창이 없다고 보고 하나씩 만든다 — 확인부터 note_labels 넣기까지 한 번에 하나만
    static CREATING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let one = CREATING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let st = state(app);
    let open = st.note_labels.lock().unwrap().get(id).cloned();
    if let Some(w) = open.as_deref().and_then(|l| crate::windows::reopen_closing(app, id, l)) {
        return Ok(w);
    }
    if let Some(w) = open.filter(|l| !crate::windows::is_closing(l)).and_then(|l| app.get_webview_window(&l)) {
        return Ok(w);
    }
    let started = std::time::Instant::now(); // 속도 기록: 창 만들기 (예비 창이면 거의 0)
    let title = with_vault(app, |v| Ok(v.get(id).and_then(|m| m["title"].as_str().map(str::to_string)).unwrap_or_default()))?;
    let on_top = st.setting("onTop")[id] == true;
    let spare = if show || ready.is_some() { take_spare(app) } else { None };
    let win = match &spare {
        Some((w, _)) => {
            if let Some(b) = bounds.or_else(|| crate::windows::saved_bounds(app, id)) {
                crate::windows::set_bounds(w, b);
            }
            let _ = w.set_title(&title);
            if on_top {
                let _ = w.set_always_on_top(true);
            }
            w.clone()
        }
        None => {
            let label = format!("note-{}", NEXT_NOTE.fetch_add(1, Ordering::Relaxed));
            let b = crate::window(app, &label, &format!("note.html?id={}", query_escape(id)))
                .title(title)
                .inner_size(340.0, 380.0)
                .min_inner_size(240.0, 200.0)
                .transparent(true)
                .visible(false) // 투명 창은 다 그린 뒤에 보인다 (아래 ready) — 그 전에는 뒤가 비친다
                .always_on_top(on_top);
            let b = match bounds {
                Some([x, y, w, h]) => b.position(x, y).inner_size(w, h),
                None => crate::os::place_note(app, id, b),
            };
            b.build().map_err(|e| e.to_string())?
        }
    };
    let label = win.label().to_string();
    let how = if spare.is_some() { "예비 창" } else if show { "새 창" } else { "숨겨 만든 창" };
    crate::files::perf_log(&format!("창 준비 {}ms ({how})", started.elapsed().as_millis()));
    st.note_labels.lock().unwrap().insert(id.to_string(), label.clone());
    drop(one);
    let (app2, id2, label2) = (app.clone(), id.to_string(), label.clone());
    win.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            closed_note(&app2, &id2, &label2);
        }
    });
    crate::os::track_note(app, id, &win);
    crate::windows::track(app, id, &win);
    // 예비 창은 이미 한 번 그린 창이라 숨겨 두었다가 메모를 다 그리면 보인다. 메모를 건네기 전에 걸어 둔다 (그리기가 먼저 끝나지 않게)
    let ready = if show {
        let id = id.to_string();
        Some(Box::new(move |app: &AppHandle| {
            if let Some(w) = app.get_webview_window(&label) {
                crate::windows::show_note_win(&w);
                let _ = w.set_focus();
                crate::windows::shown(app, &id, &w);
            }
        }) as crate::windows::Action)
    } else {
        ready
    };
    if let Some(f) = ready {
        crate::windows::when_painted(app, win.label(), f);
    }
    if let Some((_, assign)) = spare {
        // 메모도 함께 — 화면이 받자마자 다시 묻지 않게 (memo:get 은 넣을 글 · 알람 같은 한 번만 주는 것도 꺼내므로 여기서 한 번만)
        let memo = handle(app, win.label(), "memo:get", &[id.into()]).and_then(Result::ok).unwrap_or(Value::Null);
        let _ = assign.send(json!({ "id": id, "memo": memo }));
    }
    // 숨겨 만드는 창(미리 열기 · 옆 탭 · 다시 켤 때)은 목록에 알릴 것이 없다 — 보일 때 shown() 이 열림을 알린다 (마우스를 올릴 때마다 목록을 다시 그렸다)
    if show {
        push_list_soon(app);
    }
    schedule_spare(app, SPARE_REFILL_MS);
    Ok(win)
}

// 메모 창이 닫혔다: 빈 메모는 치우고 제목에 맞춰 파일 이름을
pub fn closed_note(app: &AppHandle, id: &str, label: &str) {
    let st = state(app);
    {
        let mut labels = st.note_labels.lock().unwrap();
        // 닫는 사이 다시 열어 새 창이 이어받았다: 마무리는 그 창이 닫힐 때
        if labels.get(id).is_some_and(|l| l != label) {
            return;
        }
        labels.remove(id);
    }
    // 정리(빈 메모 치우기 · 제목에 맞춰 파일 이름)는 일꾼 스레드에서 — 이 함수는 창 이벤트(UI 스레드)에서 불려,
    //   메모 폴더 잠금 · 파일 이름 바꾸기를 기다리는 동안 다른 창 그리기 · 탭 전환이 멈췄다
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        let _ = with_vault(&app, |v| {
            v.close_lock(&id); // 닫은 잠긴 메모의 열쇠를 남기지 않는다
            v.finalize(&id).map_err(|e| e.to_string())
        });
        // 비워서 치웠으면 스택 · 창 자리에서도 (창이 없어질 때는 정리가 아직이었을 수 있다)
        crate::windows::forget_if_gone(&app, &id);
        crate::os::forget_bounds_if_gone(&app, &id);
        push_list_soon(&app);
    });
}

/// from: 새 메모를 만든 창 — 새 창은 그 창 옆에 겹치지 않게 (windows::new_memo_spot)
fn create_memo(app: &AppHandle, from: &str, opts: &Value) -> Result<Value, String> {
    let folder = opts["folder"].as_str().unwrap_or("");
    let id = match folder.strip_prefix("secret:") {
        // 비밀 폴더를 보는 중이면 그 폴더에 (잠가서 — secret_store.rs)
        Some(fid) => with_vault(app, |v| v.secret_create_memo(fid, opts["color"].as_str(), opts["mode"].as_str()).map_err(|e| e.to_string()))?,
        None => with_vault(app, |v| Ok(v.create(opts["color"].as_str(), opts["mode"].as_str(), folder)))?,
    };
    crate::windows::place_new_memo(app, &id, from);
    open_note(app, &id)?;
    Ok(id.into())
}

// 메모 창의 지우기: 휴지통으로 옮기고 창을 닫는다 — 목록이 되돌리기 띠를 띄운다
fn remove_memo(app: &AppHandle, id: &str) -> Result<Value, String> {
    crate::windows::remove_from_stack(app, id, "none");
    let title = with_vault(app, |v| Ok(v.get(id).map(|m| m["title"].clone()).unwrap_or_default()))?;
    let label = state(app).note_labels.lock().unwrap().remove(id);
    let r = with_vault(app, |v| v.trash(id).map_err(|e| e.to_string()));
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.destroy();
    }
    if let Ok(Some(name)) = &r {
        let _ = app.emit_to("list", "memo:trashed", [json!({ "name": name, "title": title })]);
    }
    push_list(app);
    r.map(|n| n.is_some().into())
}

// 비밀번호로 잠긴 메모 열기 → 풀린 메모 | { error }
fn open_locked(app: &AppHandle, id: &str, password: &str) -> Result<Value, String> {
    let sealed = with_vault(app, |v| Ok(v.entry(id).map(|e| e.body.clone())))?;
    Ok(match sealed {
        Some(b) if !memoking_core::body::is_locked_body(&b) => with_vault(app, |v| Ok(v.get(id).unwrap_or(Value::Null)))?,
        Some(b) => match memoking_core::lock::open_lock(&b, password) {
            Err(e) => json!({ "error": e }),
            Ok(_) if !state(app).note_labels.lock().unwrap().contains_key(id) => json!({ "error": "메모 창이 닫혔어요" }),
            Ok((_, s)) => with_vault(app, |v| Ok(v.open_lock(id, s)))?.unwrap_or_else(|| json!({ "error": "메모를 열지 못했어요" })),
        },
        None => json!({ "error": "메모를 찾지 못했어요" }),
    })
}

/// { $bytes: base64 } → 바이트 (shim.js 가 감싼 Uint8Array)
fn arg_bytes(args: &[Value], i: usize) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(args.get(i)?["$bytes"].as_str()?).ok()
}

fn bytes_value(b: &[u8]) -> Value {
    use base64::Engine;
    json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(b) })
}

const NOT_FOUND: &str = "파일을 찾지 못했어요. 메모 폴더에서 옮겨졌거나 삭제됐는지 확인해 주세요";

/// 메모 폴더 attachments/ 안의 파일 (화면이 이미 풀어 보낸 경로)
pub(crate) fn attachment_file(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let file = with_vault(app, |v| Ok(rel.starts_with("attachments/").then(|| v.resolve(rel)).flatten()))?;
    file.filter(|f| f.is_file()).ok_or_else(|| NOT_FOUND.into())
}

fn read_attachment(app: &AppHandle, rel: &str) -> Result<Value, String> {
    let file = with_vault(app, |v| Ok(v.resolve(rel)))?.filter(|f| f.is_file()).ok_or("파일을 찾지 못했어요. 메모 폴더에서 삭제됐거나 옮겨졌는지 확인해 주세요")?;
    if std::fs::metadata(&file).map_or(0, |m| m.len()) > 500 * 1024 * 1024 {
        return Err("파일이 너무 커요 (500MB 넘음). 더 작은 파일로 해 주세요".into());
    }
    std::fs::read(&file).map(|b| bytes_value(&b)).map_err(|e| e.to_string())
}

/// 그림을 오른쪽으로 90도 돌린 새 첨부 → 그 자리 (원본은 그대로 — 메모의 되돌리기로 원래 장).
///   예전에는 메모 창이 화면 스레드에서 캔버스로 풀고 돌려, 큰 사진이면 그동안 창이 멈췄다. 사진의 방향(EXIF)을 반영하고 긴 변 4096 까지.
///   못 읽는 형식(HEIC 등)은 오류 — 화면이 예전처럼 돌린다
fn rotate_attachment(app: &AppHandle, rel: &str) -> Result<Value, String> {
    use image::ImageDecoder;
    let fail = |e: &dyn std::fmt::Display| format!("이미지를 돌리지 못했어요 ({e})");
    let file = with_vault(app, |v| Ok(v.resolve(rel)))?.filter(|f| f.is_file()).ok_or("이미지를 찾지 못했어요")?;
    let ext = rel.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    if ext == "gif" {
        return Err("움직이는 이미지(GIF)는 돌리면 멈춘 이미지가 돼서 돌리지 않았어요".into());
    }
    let mut dec = image::ImageReader::open(&file).map_err(|e| fail(&e))?.with_guessed_format().map_err(|e| fail(&e))?.into_decoder().map_err(|e| fail(&e))?;
    let turn = dec.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(dec).map_err(|e| fail(&e))?;
    img.apply_orientation(turn);
    if img.width().max(img.height()) > 4096 {
        img = img.resize(4096, 4096, image::imageops::FilterType::Lanczos3); // 메모리 · 시간 — 4096 이면 화면 · 인쇄에 충분
    }
    let img = img.rotate90();
    let mut out = std::io::Cursor::new(Vec::new());
    // 사진은 JPEG, 그 밖(투명한 곳이 있을 수 있는 그림)은 PNG
    let ext = if matches!(ext.as_str(), "jpg" | "jpeg") {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92).encode_image(&img.to_rgb8()).map_err(|e| fail(&e))?;
        "jpg"
    } else {
        img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| fail(&e))?;
        "png"
    };
    with_vault(app, |v| v.save_attachment(out.get_ref(), ext).map(Value::from).map_err(|e| e.to_string()))
}

/// 첨부를 그 파일의 프로그램으로 연다 → "" (열림) · "cancelled" · 까닭
fn open_attachment(app: &AppHandle, rel: &str) -> Result<Value, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_opener::OpenerExt;
    let rel = memoking_core::js::decode_uri(rel).unwrap_or_else(|| rel.to_string());
    let Some(file) = with_vault(app, |v| Ok(v.resolve(&rel)))?.filter(|f| f.is_file()) else { return Ok(format!("{NOT_FOUND}.").into()) };
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // 다른 기기와 함께 쓰는 폴더라 — 프로그램 파일은 실행하기 전에 묻는다
    if memoking_core::vault::is_program_file(&name) {
        let ok = app
            .dialog()
            .message(format!("\"{name}\"은(는) 프로그램 파일이에요. 실행할까요?\n\n다른 기기와 함께 쓰는 폴더예요. 직접 넣은 파일이 맞는지 확인해 주세요."))
            .title("메모킹")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("실행".into(), "취소".into()))
            .blocking_show();
        if !ok {
            return Ok("cancelled".into());
        }
    }
    Ok(match app.opener().open_path(file.to_string_lossy(), None::<&str>) {
        Ok(()) => "".into(),
        Err(_) => "파일을 열지 못했어요. 이 파일을 열 수 있는 프로그램이 있는지 확인해 주세요.".into(),
    })
}

/// 파일 이름으로 쓸 수 있게 (Electron safeName: 경로 앞은 떼고, 못 쓰는 글자 묶음은 빈칸, 다 지워지면 "메모 내용")
pub fn safe_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let name = base.split(|c| "\\/:*?\"<>|".contains(c)).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
    let name = name.trim();
    if name.is_empty() { "메모 내용".into() } else { name.into() }
}

/// 내용 저장(저장 단추): { name, mime, rel? | base64? } → { name } | { cancelled } | { error }
fn save_attachment_as(app: &AppHandle, f: &Value) -> Result<Value, String> {
    use base64::Engine;
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    let name = safe_name(f["name"].as_str().unwrap_or("메모 내용"));
    let source = match (f["rel"].as_str(), f["base64"].as_str()) {
        (Some(rel), _) if !rel.is_empty() => match attachment_file(app, rel) {
            Ok(p) => Ok(p),
            Err(e) => return Ok(json!({ "error": e })),
        },
        (_, Some(b)) => Err(base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| e.to_string())?),
        _ => return Ok(json!({ "error": "저장할 내용이 없어요" })),
    };
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
    let image = f["mime"].as_str().is_some_and(|m| m.starts_with("image/")) || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&ext.to_lowercase().as_str());
    let dir = if image { app.path().picture_dir() } else { app.path().download_dir() }.unwrap_or_else(|_| std::env::temp_dir());
    let target = if crate::ipc::smoke() {
        Some(std::env::temp_dir().join(format!("memoking-smoke-save-{name}")))
    } else {
        let mut d = app.dialog().file().set_title("저장").set_directory(dir).set_file_name(&name);
        if !ext.is_empty() {
            d = d.add_filter(format!("{} 파일", ext.to_uppercase()), &[ext.as_str()]).add_filter("모든 파일", &["*"]);
        }
        d.blocking_save_file().and_then(|p| p.into_path().ok())
    };
    let Some(target) = target else { return Ok(json!({ "cancelled": true })) };
    let r = match source {
        Ok(file) => std::fs::copy(file, &target).map(|_| ()),
        Err(bytes) => std::fs::write(&target, bytes),
    };
    Ok(match r {
        Ok(()) => json!({ "name": if crate::ipc::smoke() { name } else { target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name) } }),
        Err(_) => json!({ "error": "저장하지 못했어요. 다른 폴더를 골라 주세요" }),
    })
}

/// 첨부를 메모 밖(탐색기 · 바탕화면 · 카카오톡)으로 끌어내기: { name, rel? | base64? } — 임시 폴더에 그 이름으로 복사해 파일 끌기 (Electron startDrag)
fn drag_out(app: &AppHandle, label: &str, f: &Value) -> Option<String> {
    use base64::Engine;
    let source = match (f["rel"].as_str(), f["base64"].as_str()) {
        (Some(rel), _) if !rel.is_empty() => Ok(attachment_file(app, rel).ok()?),
        (_, Some(b)) => Err(base64::engine::general_purpose::STANDARD.decode(b).ok()?),
        _ => return None,
    };
    let root = std::env::temp_dir().join("memoking-drag");
    std::fs::create_dir_all(&root).ok()?;
    // 받는 앱이 복사를 마쳤을 만한 것(한 시간 지남)은 치운다
    for e in std::fs::read_dir(&root).ok()?.flatten() {
        if e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_secs() > 3600) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    let mut name = memoking_core::js::slice16(&safe_name(f["name"].as_str().unwrap_or_default()), 120);
    // 이름에 확장자가 없으면 원래 파일의 것을 (받는 쪽이 파일 종류를 알도록)
    if let (Ok(src), None) = (&source, Path::new(&name).extension()) {
        if let Some(ext) = src.extension() {
            name = format!("{name}.{}", ext.to_string_lossy());
        }
    }
    let dir = root.join(format!("d-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
    std::fs::create_dir(&dir).ok()?;
    let file = dir.join(name);
    match source {
        Ok(src) => std::fs::copy(src, &file).map(|_| ()),
        Err(bytes) => std::fs::write(&file, bytes),
    }
    .ok()?;
    let shown = file.file_name()?.to_string_lossy().into_owned(); // 끄는 파일 이름 — 화면이 메모킹에 도로 떨어졌는지 알아보는 데 (isOwnDragOut)
    if !crate::ipc::smoke() {
        start_file_drag(app, label, file);
    }
    Some(shown)
}

/// 셸 파일 끌기(SHDoDragDrop) — 창 스레드(메인)에서, 놓거나 Esc 를 누를 때까지 그 안에서 메시지를 돈다.
///   탐색기처럼 그 파일의 아이콘(그림이면 미리보기)이 마우스를 따라온다 (예전 OLE DoDragDrop 은 커서만). 복사만 허락한다
#[cfg(windows)]
fn start_file_drag(app: &AppHandle, label: &str, file: PathBuf) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{IDropSource, DROPEFFECT_COPY};
    use windows::Win32::UI::Shell::{BHID_DataObject, IShellItem, SHCreateItemFromParsingName, SHDoDragDrop};
    let hwnd = app.get_webview_window(label).and_then(|w| w.hwnd().ok()).map_or(0, |h| h.0 as isize);
    let _ = app.run_on_main_thread(move || unsafe {
        let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&windows::core::HSTRING::from(file.as_os_str()), None) else { return };
        let Ok(data) = item.BindToHandler::<_, IDataObject>(None, &BHID_DataObject) else { return };
        // 끄는 쪽(drop source)은 셸 기본 — 끄는 그림 · 커서를 셸이 맡는다
        let _ = SHDoDragDrop(Some(HWND(hwnd as _)), &data, None::<&IDropSource>, DROPEFFECT_COPY);
    });
}

#[cfg(not(windows))]
fn start_file_drag(_: &AppHandle, _: &str, _: PathBuf) {}

/// 글로 새 메모 (목록의 파일 가져오기 · 매직키): 문서 첨부는 메모 창이 열리며 편집기가 넣는다
fn import_memo(app: &AppHandle, args: &[Value]) -> Result<Value, String> {
    let body: String = args.first().and_then(Value::as_str).unwrap_or_default().chars().take(5_000_000).collect();
    let opts = args.get(1).cloned().unwrap_or(Value::Null);
    let id = with_vault(app, |v| v.import(&body, None).map_err(|e| e.to_string()))?.ok_or("이 파일로는 메모를 만들 수 없어요. 글 파일(.txt, .md 등)을 골라 주세요")?;
    // 메모 폴더의 첨부만
    let items: Vec<Value> = opts["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|it| {
            let src = it["src"].as_str().filter(|s| s.strip_prefix("attachments/").is_some_and(|n| !n.is_empty() && !n.contains(['/', '\\'])))?;
            Some(json!({ "kind": "file", "src": src, "name": it["name"].as_str()?.chars().take(255).collect::<String>() }))
        })
        .collect();
    let open = opts["open"] == true || !items.is_empty();
    if !items.is_empty() {
        state(app).inserts.lock().unwrap().insert(id.clone(), Value::Array(items));
    }
    push_list(app);
    if open {
        open_note(app, &id)?;
    }
    Ok(id.into())
}

// 동기화 충돌 사본: "제목 (PC 충돌 2026-11-15 1530).md" → 원본 "제목.md" (conflicts.js CONFLICT_TAG 그대로)
fn original_file_of(file: &str) -> Option<String> {
    static TAG: std::sync::LazyLock<fancy_regex::Regex> = std::sync::LazyLock::new(|| memoking_core::js::re(r" \((?:PC|휴대폰) 충돌 \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(?=\.md$)"));
    TAG.is_match(file).ok()?.then(|| TAG.replace(file, "").into_owned())
}

fn conflict_pair(v: &memoking_core::vault::Vault, copy_id: &str) -> Option<(Value, Option<Value>)> {
    let copy = v.get(copy_id)?;
    let orig = original_file_of(copy["file"].as_str()?)?;
    let original = v.list().into_iter().find(|m| m["file"] == orig.as_str()).and_then(|m| v.get(m["id"].as_str()?));
    Some((copy, original))
}

fn side(m: &Value) -> Value {
    let locked = m["locked"] == true;
    json!({ "id": m["id"], "title": m["title"], "file": m["file"], "updated": m["updated"], "locked": locked, "body": if locked { "" } else { m["body"].as_str().unwrap_or("") } })
}

/// keep: "copy" 사본 내용으로 원본을 바꾸고 사본은 휴지통 · "original" 원본 그대로, 사본만 휴지통
fn resolve_conflict(app: &AppHandle, copy_id: &str, keep: &str) -> Result<Value, String> {
    let fail = |m: &str| Ok(json!({ "ok": false, "message": m }));
    // 사본 창을 열어 둔 채 막 고쳤으면 그 글부터 저장 (아직 저장 전인 0.6초 안의 글이 빠지지 않게)
    // shortcut: Electron 처럼 저장이 끝나기를 기다리지 않고 0.5초 둔다 — 느린 PC 에서 마지막 글자가 빠지는 일이 보이면 응답을 받게
    let label = state(app).note_labels.lock().unwrap().get(copy_id).cloned();
    if let Some(w) = label.as_ref().and_then(|l| app.get_webview_window(l)) {
        let _ = w.eval("window.mkFlushSync?.()");
        std::thread::sleep(Duration::from_millis(500));
    }
    let Some((copy, original)) = with_vault(app, |v| Ok(conflict_pair(v, copy_id)))? else { return fail("사본을 찾지 못했어요. 이미 삭제했을 수 있어요") };
    if copy["locked"] == true || original.as_ref().is_some_and(|o| o["locked"] == true) {
        return fail("잠긴 메모는 직접 열어 고쳐 주세요");
    }
    if keep == "copy" {
        let Some(orig) = original else { return fail("원본 메모를 찾지 못했어요. 사본을 그대로 쓰면 돼요") };
        let oid = orig["id"].as_str().unwrap_or_default().to_string();
        let (card, _) = with_vault(app, |v| v.save(&oid, copy["body"].as_str().unwrap_or_default()).map_err(|e| e.to_string()))?;
        if card["refused"] == true {
            return fail("원본을 바꾸지 못했어요. 잠시 뒤 다시 해 주세요");
        }
        let fresh = with_vault(app, |v| Ok(v.get(&oid)))?;
        send_to_note(app, &oid, "memo:external", [fresh]); // 원본 창이 열려 있으면 바꾼 글로
    }
    state(app).note_labels.lock().unwrap().remove(copy_id);
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.destroy();
    }
    with_vault(app, |v| v.trash(copy_id).map_err(|e| e.to_string()))?;
    push_list(app);
    Ok(json!({ "ok": true, "message": if keep == "copy" { "사본 내용으로 바꾸고 사본은 휴지통으로 옮겼어요" } else { "사본을 휴지통으로 옮겼어요" } }))
}

/// 저장하지 못해 따로 남긴 글 (설정 폴더의 recovered/ — Electron 판이 남긴 것도)
fn recovered_files(app: &AppHandle) -> Vec<PathBuf> {
    if with_vault(app, |_| Ok(())).is_err() {
        return vec![];
    }
    let dir = state(app).settings_dir.join("recovered");
    std::fs::read_dir(dir).map_or(vec![], |rd| rd.flatten().map(|d| d.path()).filter(|p| p.extension().is_some_and(|e| e == "md")).collect())
}

/// 메모 창에 할 일을 보낸다 — 열려 있으면 바로, 아니면 열면서 (memo:get 의 command)
fn note_command(app: &AppHandle, id: &str, command: Value) -> Result<Value, String> {
    let open = state(app).note_labels.lock().unwrap().contains_key(id);
    if !open {
        state(app).commands.lock().unwrap().insert(id.to_string(), command.clone());
    }
    let shown = open_note(app, id)?;
    if !shown {
        state(app).commands.lock().unwrap().remove(id); // 없는 메모 — 남겨 두지 않는다
    } else if open {
        send_to_note(app, id, "memo:command", [command]);
    }
    Ok(shown.into())
}

/// 목록 카드에 마우스를 올려 두면: 예비 창에 그 메모를 숨긴 채 그려 둔다 — 누르면(memo:open) 이미 그린 창을 보이기만.
///   PRELOAD_KEEP 안에 열지 않으면 다시 예비 창으로. 예비 창이 준비돼 있을 때만 (새 창을 만들지는 않는다).
///   이미 열린 메모 · 스택 탭(show_tab 이 따로 연다) · 잠긴 메모 · 빈 메모(거둘 때 정리가 휴지통으로 보낸다)는 하지 않는다
const PRELOAD_KEEP: Duration = Duration::from_secs(4);
/// 미리 그려 두기만 한 창 — 열면(open_note) 빠진다. 남아 있으면 PRELOAD_KEEP 뒤에 거둔다
static PRELOADED: Mutex<Vec<String>> = Mutex::new(Vec::new());
fn preload_note(app: &AppHandle, id: &str) {
    if id.is_empty() || state(app).note_labels.lock().unwrap().contains_key(id) || crate::windows::in_stack(app, id) {
        return;
    }
    let ok = state(app).vault.lock().unwrap().as_ref().and_then(|v| v.entry(id).map(|e| !e.body.trim().is_empty() && !memoking_core::body::is_locked_body(&e.body))).unwrap_or(false);
    let ready = SPARE.lock().unwrap().iter().any(|s| s.assign.is_some());
    if !ok || !ready {
        return;
    }
    let Ok(win) = create_note_window(app, id, None, false, Some(Box::new(|_: &AppHandle| {}))) else { return };
    let (app, label) = (app.clone(), win.label().to_string());
    PRELOADED.lock().unwrap().push(label.clone());
    std::thread::spawn(move || {
        std::thread::sleep(PRELOAD_KEEP);
        // 열지 않은 것만 — 누른 창은 아직 그리는 중이라 숨어 있어도 거두지 않는다
        let unopened = {
            let mut p = PRELOADED.lock().unwrap();
            let had = p.contains(&label);
            p.retain(|l| *l != label);
            had
        };
        if unopened && !crate::windows::is_closing(&label) {
            crate::windows::retire_note(&app, &label);
        }
    });
}

/// 메모 채널 — 이 파일이 맡지 않는 채널이면 None
pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let st = state(app);
    Some(match channel {
        "app:info" => Ok(st.vault_info(app)),
        "vault:use" => {
            let dir = arg_str(args, 0);
            let dir = if dir.is_empty() { State::suggested_vault(app) } else { PathBuf::from(dir) };
            st.open_vault(app, dir);
            push_list(app);
            Ok(st.vault_info(app))
        }
        "memos:list" => Ok(list_memos(app)),
        "memos:folders" => with_vault(app, |v| Ok(json!(v.folders()))),
        "memo:get" => {
            // 층 · 탭 줄은 메모 폴더를 잡기 전에 (windows.rs 가 메모 폴더를 따로 잡는다)
            let (layer, stack) = (crate::windows::layer_state(app, &arg_str(args, 0)), crate::windows::stack_state(app, &arg_str(args, 0)));
            with_vault(app, |v| {
                let Some(mut m) = v.get(&arg_str(args, 0)) else { return Ok(Value::Null) };
                                let o = m.as_object_mut().unwrap();
                let insert = st.inserts.lock().unwrap().remove(o["id"].as_str().unwrap_or_default()).unwrap_or(Value::Null);
                o.insert("insert".into(), insert);
                let command = st.commands.lock().unwrap().remove(o["id"].as_str().unwrap_or_default()).unwrap_or(Value::Null);
                o.insert("command".into(), command);
                let alarm = st.alarms.lock().unwrap().remove(o["id"].as_str().unwrap_or_default()).unwrap_or(Value::Null);
                for (k, val) in [("alarm", alarm), ("capture", crate::services::take_capture(o["id"].as_str().unwrap_or_default()))] {
                    o.insert(k.into(), val);
                }
                for k in ["top", "bottom", "canTape"] {
                    o.insert(k.into(), layer[k].clone());
                }
                o.insert("onTop".into(), layer["top"].clone());
                o.insert("stack".into(), stack);
                m["workLife"] = (st.setting("workLife") == true).into();
                Ok(m)
            })
        }
        "memo:preload" => {
            preload_note(app, &arg_str(args, 0));
            Ok(Value::Null)
        }
        "memo:open" => {
            // 목록에서 찾던 말: 그 말로 찾아 첫 자리로 (note.js runCommand)
            let find: String = args.get(1).and_then(|o| o["find"].as_str()).unwrap_or_default().trim().chars().take(200).collect();
            // 목록에서 고른 테이프 메모: 테이프를 떼고 앞으로
            if label == "list" {
                crate::windows::untape_from_list(app, &arg_str(args, 0));
            }
            if find.is_empty() { open_note(app, &arg_str(args, 0)).map(Value::from) } else { note_command(app, &arg_str(args, 0), json!({ "find": find })) }
        }
        // 목록 카드 메뉴: 메모 창에서 하는 일
        "card:command" => match arg_str(args, 1).as_str() {
            c @ ("lock" | "unlock" | "versions") => note_command(app, &arg_str(args, 0), c.into()),
            _ => Ok(false.into()),
        },
        "memo:create" => create_memo(app, label, args.first().unwrap_or(&Value::Null)),
        "memo:save" => {
            let id = arg_str(args, 0);
            let Some(body) = args.get(1).and_then(Value::as_str) else { return Some(Err("본문이 문자열이 아닙니다.".into())) };
            let (card, changed) = match with_vault(app, |v| v.save(&id, body).map_err(|e| e.to_string())) {
                Ok(r) => r,
                Err(e) => return Some(Err(e)),
            };
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.set_title(card["title"].as_str().unwrap_or_default());
            }
            if changed {
                push_list(app);
            }
            Ok(card)
        }
        // 창을 닫는 순간의 저장 — 저장하지 못한 글은 사본 메모로라도 남긴다 (잃지 않게)
        "memo:save-sync" => {
            let id = arg_str(args, 0);
            let Some(body) = args.get(1).and_then(Value::as_str).map(str::to_string) else { return Some(Ok(true.into())) };
            let r = with_vault(app, |v| {
                let mut r = v.save(&id, &body).map_err(|e| e.to_string())?;
                if r.0["retry"] == true {
                    v.scan();
                    r = v.save(&id, &body).map_err(|e| e.to_string())?;
                }
                if r.0["refused"] == true && r.0["copied"] != true && r.0["invalid"] != true && !memoking_core::body::is_blank_body(&body) {
                    v.import_copy_of(&id, &body).map_err(|e| e.to_string())?;
                }
                Ok(())
            });
            push_list_soon(app);
            r.map(|()| true.into())
        }
        // 잠그기 · 열기: 열쇠 만들기(PBKDF2)는 일부러 느리다 — 메모 폴더를 붙잡지 않고 먼저 만든다
        "memo:lock" => {
            let (id, password) = (arg_str(args, 0), arg_str(args, 1));
            let hide = args.get(2).is_some_and(|o| o["hideTitle"] == true);
            let keep_open = st.note_labels.lock().unwrap().contains_key(&id);
            let r = memoking_core::lock::new_session(&password, memoking_core::lock::LOCK_ITERATIONS).and_then(|s| with_vault(app, |v| v.lock(&id, s, keep_open, hide).map_err(|e| e.to_string())));
            push_list(app);
            Ok(match r {
                Ok(Some(m)) => m,
                Ok(None) => json!({ "error": "잠그지 못했어요. 이미 잠겼거나 그사이 다른 기기에서 잠갔을 수 있어요" }),
                Err(e) => json!({ "error": e }),
            })
        }
        "memo:open-lock" => open_locked(app, &arg_str(args, 0), &arg_str(args, 1)),
        "memo:unlock" => {
            let id = arg_str(args, 0);
            let r = with_vault(app, |v| {
                let Some(m) = v.get(&id) else { return Ok(json!({ "error": "메모를 찾지 못했어요" })) };
                if m["locked"] != true {
                    return Ok(m);
                }
                if m["needsPassword"] == true {
                    return Ok(json!({ "error": "먼저 비밀번호로 열어 주세요" }));
                }
                Ok(v.unlock(&id).map_err(|e| e.to_string())?.unwrap_or_else(|| json!({ "error": "그사이 다른 기기에서 이 메모가 바뀌어 풀지 못했어요. 다시 해 주세요" })))
            });
            push_list(app);
            r
        }
        "attachment:save" => {
            let Some(bytes) = arg_bytes(args, 0) else { return Some(Err("넣으려는 파일을 읽지 못했어요. 파일을 다시 골라 주세요".into())) };
            // 비밀 메모 창이면 잠가서 그 비밀 폴더에 (풀린 채 attachments/ 에 두지 않는다)
            let secret = crate::secret::folder_of_window(app, label);
            with_vault(app, |v| match &secret {
                Some(fid) => v.secret_save_file(fid, &bytes, &arg_str(args, 1)),
                None => v.save_attachment(&bytes, &arg_str(args, 1)),
            }
            .map(Value::from)
            .map_err(|e| e.to_string()))
        }
        "attachment:read" => read_attachment(app, &arg_str(args, 0)),
        "attachment:rotate" => rotate_attachment(app, &arg_str(args, 0)),
        "attachment:info" => {
            let rel = arg_str(args, 0);
            let rel = memoking_core::js::decode_uri(&rel).unwrap_or(rel);
            let size = with_vault(app, |v| Ok(v.resolve(&rel).and_then(|f| std::fs::metadata(f).ok()).filter(|m| m.is_file()).map(|m| m.len())));
            Ok(size.ok().flatten().map_or(json!({ "exists": false, "size": 0 }), |n| json!({ "exists": true, "size": n })))
        }
        "attachment:open" => open_attachment(app, &arg_str(args, 0)),
        "attachment:save-as" => save_attachment_as(app, args.first().unwrap_or(&Value::Null)),
        "attachment:drag-out" => {
            let shown = drag_out(app, label, args.first().unwrap_or(&Value::Null));
            if shown.is_none() {
                elog!("[drag-out] 끌어낼 파일을 만들지 못했어요");
            }
            Ok(json!(shown))
        }
        "memo:handoff" => {
            let last = st.handoff.lock().unwrap().1.clone();
            let open = |id: &Value| st.note_labels.lock().unwrap().contains_key(id.as_str().unwrap_or_default());
            let fresh = last.filter(|m| chrono::Local::now().timestamp_millis() - m["at"].as_i64().unwrap_or(0) < memoking_core::handoff::HANDOFF_MS && !open(&m["id"]));
            Ok(fresh.unwrap_or(Value::Null))
        }
        "memo:import" => import_memo(app, args),
        "memo:keep-copy" => {
            let (source, copy) = (arg_str(args, 0), arg_str(args, 2));
            let Some(body) = args.get(1).and_then(Value::as_str) else { return Some(Ok(Value::Null)) };
            let unlocked = args.get(3).is_some_and(|o| o["unlocked"] == true);
            let r = with_vault(app, |v| {
                // 이미 만든 사본이 있으면 그 사본에 (저장되면 그대로)
                if !copy.is_empty() && v.entry(&copy).is_some() {
                    let (card, _) = v.save(&copy, body).map_err(|e| e.to_string())?;
                    if card["refused"] != true || card["copied"] == true {
                        return Ok(Some(copy.clone()));
                    }
                }
                let color = v.entry(&source).map(|e| e.meta.color.clone());
                let id = if unlocked && !v.is_open_lock(&source) { v.import(body, color.as_deref()) } else { v.import_copy_of(&source, body) };
                id.map_err(|e| e.to_string())
            });
            push_list(app);
            r.map(|id| id.map_or(Value::Null, Value::from))
        }
        "conflict:get" => with_vault(app, |v| {
            Ok(conflict_pair(v, &arg_str(args, 0)).map_or(Value::Null, |(copy, original)| json!({ "copy": side(&copy), "original": original.as_ref().map_or(Value::Null, side) })))
        }),
        "conflict:resolve" => resolve_conflict(app, &arg_str(args, 0), &arg_str(args, 1)),
        "recovered:count" => Ok(recovered_files(app).len().into()),
        "recovered:restore" => {
            let mut n = 0;
            for f in recovered_files(app) {
                let Ok(body) = std::fs::read_to_string(&f) else { continue };
                if matches!(with_vault(app, |v| v.import(&body, None).map_err(|e| e.to_string())), Ok(Some(_))) && std::fs::remove_file(&f).is_ok() {
                    n += 1;
                }
            }
            push_list(app);
            Ok(n.into())
        }
        "memos:search" => {
            let exclude = args.get(1).and_then(Value::as_str).map(str::to_string);
            let found = with_vault(app, |v| Ok(v.search(&arg_str(args, 0), exclude.as_deref())));
            found.map(|list| with_open_flag(app, list))
        }
        "tags:list" => with_vault(app, |v| Ok(json!(memoking_core::search::collect_tags(&v.list())))),
        "folders:pinned" => with_vault(app, |v| Ok(json!(v.pinned_folders()))),
        "folders:pin" => with_vault(app, |v| v.set_folder_pinned(&arg_str(args, 0), args.get(1) == Some(&Value::Bool(true))).map(|l| json!(l))),
        "folders:create" => with_vault(app, |v| v.create_folder(&arg_str(args, 0)).map(Value::from)),
        "folders:rename" => {
            let r = with_vault(app, |v| v.rename_folder(&arg_str(args, 0), &arg_str(args, 1)).map(Value::from));
            refresh_note_files(app);
            r
        }
        "folders:delete" => {
            let r = with_vault(app, |v| v.delete_folder(&arg_str(args, 0)));
            refresh_note_files(app);
            push_list(app);
            r
        }
        "memo:move-folder" => {
            let ids: Vec<String> = match args.first() {
                Some(Value::Array(a)) => a.iter().take(500).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string)).collect(),
                Some(v) => vec![v.as_str().map_or_else(|| v.to_string(), str::to_string)],
                None => vec![],
            };
            let folder = arg_str(args, 1);
            let mut moved = 0;
            for id in &ids {
                if with_vault(app, |v| v.move_to_folder(id, &folder)).unwrap_or(false) {
                    moved += 1;
                }
            }
            refresh_note_files(app);
            push_list(app);
            Ok(moved.into())
        }
        "memo:set" => {
            let id = arg_str(args, 0);
            let r = with_vault(app, |v| v.set_meta(&id, args.get(1).unwrap_or(&Value::Null)).map_err(|e| e.to_string()));
            if let Ok(Some(m)) = &r {
                send_to_note(app, &id, "memo:meta", [m.clone()]);
                push_list(app);
            }
            r.map(|m| m.unwrap_or(Value::Null))
        }
        "memo:remove" => remove_memo(app, &arg_str(args, 0)),
        "memo:links" => with_vault(app, |v| Ok(v.links(&arg_str(args, 0)))),
        "memo:link" => {
            let target = arg_str(args, 1);
            let on = args.get(2) != Some(&Value::Bool(false));
            let r = with_vault(app, |v| v.link(&arg_str(args, 0), &target, on).map_err(|e| e.to_string()));
            send_to_note(app, &target, "memo:links-changed", [Value::Null; 0]);
            r.map(|x| x.unwrap_or(Value::Null))
        }
        "memo:versions" => with_vault(app, |v| Ok(json!(v.versions(&arg_str(args, 0))))),
        "memo:version" => with_vault(app, |v| Ok(v.version(&arg_str(args, 0), &arg_str(args, 1)).map_or(Value::Null, Value::from))),
        "memo:restore-version" => {
            let id = arg_str(args, 0);
            let r = with_vault(app, |v| v.restore_version(&id, &arg_str(args, 1)).map_err(|e| e.to_string()));
            if let Ok(m) = &r {
                if let (Some(title), Some(l)) = (m["title"].as_str(), state(app).note_labels.lock().unwrap().get(&id)) {
                    if let Some(w) = app.get_webview_window(l) {
                        let _ = w.set_title(title);
                    }
                }
                push_list(app);
            }
            r
        }
        "trash:list" => with_vault(app, |v| Ok(json!(v.trash_list()))),
        "trash:preview" => with_vault(app, |v| Ok(v.trash_preview(&arg_str(args, 0)).map_or(Value::Null, Value::from))),
        "trash:restore" => {
            let r = with_vault(app, |v| v.restore_trash(&arg_str(args, 0)).map_err(|e| e.to_string()));
            push_list(app);
            r.map(|id| id.map_or(Value::Null, Value::from))
        }
        "trash:delete" => with_vault(app, |v| v.delete_trash(&arg_str(args, 0)).map(Value::from).map_err(|e| e.to_string())),
        "trash:empty" => with_vault(app, |v| Ok(v.empty_trash(None))),
        "vault:choose" => {
            use tauri_plugin_dialog::DialogExt;
            let start = with_vault(app, |v| Ok(v.root.clone())).unwrap_or_else(|_| State::suggested_vault(app));
            let picked = app.dialog().file().set_title("메모를 저장할 폴더 선택").set_directory(start).blocking_pick_folder();
            if let Some(dir) = picked.and_then(|p| p.into_path().ok()) {
                st.open_vault(app, dir);
                crate::shortcuts::refresh(app); // 다른 폴더의 메모 단축키
                push_list(app);
                if st.setting("tutorialDone") != true && !crate::ipc::smoke() {
                    crate::shortcuts::start_tutorial(app);
                }
            }
            Ok(st.vault_info(app))
        }
        "app:settings" => Ok(app_settings(app)),
        "win:close" => {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.close();
            }
            Ok(Value::Null)
        }
        "win:close-busy" => {
            crate::windows::mark_close_busy(label);
            Ok(Value::Null)
        }
        // 예비 창의 화면이 다 불러졌다 → 열 메모가 정해질 때까지 이 일꾼 스레드에서 기다린다 (Electron spareWaiting). 예비 창이 아니면 null
        "win:spare" => {
            let (tx, rx) = std::sync::mpsc::channel();
            match SPARE.lock().unwrap().iter_mut().find(|s| s.label == label) {
                Some(s) => s.assign = Some(tx),
                None => return Some(Ok(Value::Null)),
            }
            Ok(rx.recv().unwrap_or(Value::Null))
        }
        "win:painted" => {
            crate::windows::painted(app, label);
            Ok(Value::Null)
        }
        _ => return None,
    })
}

/// memoking://localhost/vault/<경로> — 메모 폴더 안 파일만 (그림 · 소리 · 영상). 앱 화면만 읽게 (main.rs)
pub fn serve_vault(app: &AppHandle, rel: &str) -> Option<(PathBuf, &'static str)> {
    let rel = crate::percent_decode(rel);
    let file = state(app).vault.lock().unwrap().as_ref()?.resolve(&rel)?;
    let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    Some((file, mime))
}

#[cfg(test)]
mod tests {
    use super::original_file_of;

    #[test]
    fn conflict_copy_names() {
        assert_eq!(original_file_of("회의 (PC 충돌 2026-11-15 1530).md").as_deref(), Some("회의.md"));
        assert_eq!(original_file_of("업무/회의 (휴대폰 충돌 2026-11-15 1530 2).md").as_deref(), Some("업무/회의.md"));
        assert_eq!(original_file_of("회의 (다른 기기 10월 5일 08:34).md"), None);
        assert_eq!(original_file_of("회의 (PC 충돌 2026-11-15 15:30).md"), None);
        assert_eq!(original_file_of("회의.md"), None);
    }
}
