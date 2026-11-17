// 전역 단축키(매직 카피 · 메모 목록) · 메모 단축키(Ctrl+Alt+1~9) · 처음 실행 튜토리얼 · 화면이 그린 메뉴와 편집 명령.
//   Electron 의 main.js(전역 단축키 · 튜토리얼) · memo-hotkeys.js · ipc-handlers.js 의 그 부분.
use crate::state::state;
use memoking_core::accelerators::{self as acc, SHORTCUTS};
use memoking_core::{js, tutorial};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

// 잡은 키 — 단축키 잡기 · 놓기는 메인 스레드에서 돌아 기다리므로 이 자물쇠를 쥔 채 부르지 않는다
#[derive(Default)]
struct Keys {
    paused: bool,
    /// "quickMemo" · "list" · 칸 "1"~"9" → 잡은 단축키
    held: HashMap<String, String>,
    /// 다른 앱이 쓰고 있어 잡지 못한 칸
    failed: HashSet<String>,
    /// 새 키를 받는 동안 단축키를 놓게 한 창 · 닫히는지 지켜보는 창
    paused_by: Option<String>,
    watched: HashSet<String>,
}
static KEYS: LazyLock<Mutex<Keys>> = LazyLock::new(Default::default);

fn is_slot(name: &str) -> bool {
    acc::HOTKEY_SLOTS.contains(&name)
}

/// 설정의 전역 단축키 하나 (SHORTCUTS 이름)
fn shortcut_key(app: &AppHandle, name: &str) -> String {
    let i = SHORTCUTS.iter().position(|s| s.0 == name).unwrap_or(0);
    acc::normalize_shortcuts(&state(app).setting("shortcuts"))[i].clone()
}

fn enabled(app: &AppHandle, name: &str) -> bool {
    match name {
        // 매직 카피는 Windows 에서만 (Electron 과 같게)
        "quickMemo" => state(app).setting("quickMemo") != false && cfg!(windows),
        // 매직키는 따로 설치하는 MagicKey 앱이 맡는다 — 키 칸만 남겨 MagicKey 가 이어받게
        "magic" => false,
        _ => true,
    }
}

/// shortcutStatus: 설정 화면이 보이는 키 하나의 상태
pub fn status(app: &AppHandle, name: &str) -> Value {
    let key = shortcut_key(app, name);
    let held = KEYS.lock().unwrap().held.get(name) == Some(&key);
    let def = SHORTCUTS.iter().find(|s| s.0 == name).map(|s| s.1);
    json!({
        "key": key,
        "label": acc::display_accelerator(&key),
        "isDefault": def == Some(key.as_str()),
        "enabled": enabled(app, name),
        "registered": held && app.global_shortcut().is_registered(key.as_str()),
    })
}

/// 메모 단축키 칸 (설정의 memoHotkeys 를 정리한 것)
pub fn hotkeys(app: &AppHandle) -> Map<String, Value> {
    acc::normalize_hotkeys(&state(app).setting("memoHotkeys"))
}

fn memo_exists(app: &AppHandle, id: &str) -> bool {
    state(app).vault.lock().unwrap().as_ref().is_none_or(|v| v.entry(id).is_some())
}

/// 다른 메모킹 단축키가 쓰는 칸이면 그 이름
fn reserved_by(app: &AppHandle, slot: &str) -> Option<&'static str> {
    let keys = acc::normalize_shortcuts(&state(app).setting("shortcuts"));
    SHORTCUTS.iter().zip(keys).find(|(_, k)| *k == acc::hotkey_accelerator(slot)).map(|(s, _)| s.2)
}

/// 키를 잡는다 (누르면 pressed(이름)). 다른 앱이 쓰거나 잘못된 키면 false
fn grab(app: &AppHandle, name: &str, key: &str) -> bool {
    let name = name.to_string();
    let ok = app
        .global_shortcut()
        .on_shortcut(key, move |app, _, e| {
            // 메인 스레드다 — 창 만들기 · 기다리기는 다른 스레드에서
            if e.state() == ShortcutState::Pressed {
                let (app, name) = (app.clone(), name.clone());
                std::thread::spawn(move || pressed(&app, &name));
            }
        })
        .is_ok();
    if !ok {
        eprintln!("{}를 다른 프로그램이 쓰고 있어 등록하지 못했어요", acc::display_accelerator(key));
    }
    ok
}

fn release(app: &AppHandle, name: &str) {
    let old = KEYS.lock().unwrap().held.remove(name);
    if let Some(old) = old {
        let _ = app.global_shortcut().unregister(old.as_str());
    }
}

/// registerQuickMemoKey · registerListKey: 지금 설정대로 다시 잡는다
fn register_global(app: &AppHandle, name: &str) -> bool {
    release(app, name);
    if !enabled(app, name) || KEYS.lock().unwrap().paused {
        return false;
    }
    let key = shortcut_key(app, name);
    let ok = grab(app, name, &key);
    if ok {
        KEYS.lock().unwrap().held.insert(name.into(), key);
    }
    ok
}

/// MemoHotkeys.register: 정해 둔 칸만 잡는다 (없는 메모의 칸 · 다른 메모킹 단축키 칸은 비워 다른 앱이 쓰게)
fn register_memo(app: &AppHandle) {
    let slots: Vec<String> = KEYS.lock().unwrap().held.keys().filter(|k| is_slot(k)).cloned().collect();
    for slot in slots {
        release(app, &slot);
    }
    KEYS.lock().unwrap().failed.clear();
    if KEYS.lock().unwrap().paused {
        return;
    }
    for (slot, b) in hotkeys(app) {
        if !memo_exists(app, b["id"].as_str().unwrap_or_default()) {
            continue;
        }
        let key = acc::hotkey_accelerator(&slot);
        let ok = reserved_by(app, &slot).is_none() && grab(app, &slot, &key);
        let mut k = KEYS.lock().unwrap();
        if ok {
            k.held.insert(slot, key);
        } else {
            k.failed.insert(slot);
        }
    }
}

/// MemoHotkeys.refresh: 메모가 생기거나 없어졌으면 잡은 칸을 다시 맞춘다 (다른 기기에서 지웠을 때 · 메모 폴더가 바뀔 때)
pub fn refresh(app: &AppHandle) {
    let want: Vec<String> = hotkeys(app).into_iter().filter(|(slot, b)| reserved_by(app, slot).is_none() && memo_exists(app, b["id"].as_str().unwrap_or_default())).map(|(s, _)| s).collect();
    let stale = {
        let k = KEYS.lock().unwrap();
        want.iter().any(|s| !k.held.contains_key(s) && !k.failed.contains(s)) || k.held.keys().any(|s| is_slot(s) && !want.contains(s))
    };
    if stale {
        register_memo(app);
    }
}

fn pause(app: &AppHandle, on: bool) {
    KEYS.lock().unwrap().paused = on;
    register_global(app, "quickMemo");
    register_global(app, "list");
    register_memo(app);
}

/// 켤 때: 전역 단축키 · 메모 단축키를 잡고, 1분마다 못 잡은 키를 다시 (다른 앱이 놓았으면 이제 잡는다) · 화면이 그린 메뉴의 고름을 받는다
pub fn start(app: &AppHandle) {
    register_global(app, "quickMemo");
    register_global(app, "list");
    register_memo(app);
    app.on_menu_event(|_, e| menu_chosen(e.id.as_ref()));
    // 처음 켰을 때 (메모 폴더가 있고 숨겨 켜지 않았으면) 사용법부터
    if state(app).setting("tutorialDone") != true && !crate::ipc::smoke() && !std::env::args().any(|a| a == "--hidden") {
        start_tutorial(app);
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        if KEYS.lock().unwrap().paused {
            continue;
        }
        let names = ["quickMemo", "list"];
        let before: Vec<Value> = names.iter().map(|n| status(&app, n)["registered"].clone()).collect();
        for n in names {
            if enabled(&app, n) && status(&app, n)["registered"] != true {
                register_global(&app, n);
            }
        }
        let failed: Vec<String> = KEYS.lock().unwrap().failed.iter().cloned().collect();
        if failed.iter().any(|s| reserved_by(&app, s).is_none()) {
            register_memo(&app);
        }
        if names.iter().map(|n| status(&app, n)["registered"].clone()).collect::<Vec<_>>() != before {
            let _ = app.emit_to("list", "shortcuts:changed", [Value::Null; 0]);
        }
    });
}

// ---------- 키를 눌렀을 때 ----------

fn pressed(app: &AppHandle, name: &str) {
    match name {
        "list" => crate::os::toggle_list(app),
        // shortcut: 매직 카피(고른 글 · 파일 담기)와 두 번 눌러 화면 캡처는 아직 — 새 메모만 연다. 매직 카피를 옮길 때 windowManager.quickMemo 로
        "quickMemo" => {
            if !matches!(crate::memos::handle(app, "list", "memo:create", &[json!({})]), Some(Ok(_))) {
                crate::os::show_list(app); // 메모 폴더가 없으면 고르는 화면으로
            }
        }
        slot => memo_hotkey_pressed(app, slot),
    }
}

/// 메모 단축키: 정해 둔 메모를 클립보드로 복사 · 메모 창 띄우기 (다른 앱 위에 잠깐 "복사했어요")
fn memo_hotkey_pressed(app: &AppHandle, slot: &str) {
    let b = hotkeys(app).get(slot).cloned().unwrap_or_default();
    let id = b["id"].as_str().unwrap_or_default().to_string();
    let get = || state(app).vault.lock().unwrap().as_ref().and_then(|v| v.get(&id));
    let Some(memo) = get() else {
        crate::windows::show_hud(app, &format!("{}: 메모를 찾지 못했어요", acc::hotkey_label(slot)), "삭제했거나 다른 메모 폴더의 메모예요", "warn");
        return;
    };
    let label = state(app).note_labels.lock().unwrap().get(&id).cloned();
    let mut copied = false;
    if b["copy"] == true && memo["needsPassword"] != true {
        // 그 메모 창에서 막 고친 글까지 (저장 기다림 600ms 안에 눌러도)
        // shortcut: 저장이 끝나기를 기다리지 않고 0.3초 둔다 (Tauri 의 eval 은 답을 못 받는다) — 마지막 글자가 빠지는 일이 보이면 저장 끝을 알려 받게
        if let Some(w) = label.as_deref().and_then(|l| app.get_webview_window(l)) {
            if w.eval("window.__memokingFlush?.()").is_ok() {
                std::thread::sleep(Duration::from_millis(300));
            }
        }
        let body = get().unwrap_or_else(|| memo.clone())["body"].as_str().unwrap_or_default().to_string();
        copied = app.clipboard().write_text(memoking_core::share_text::hotkey_copy_text(&body)).is_ok();
    }
    // 잠긴 메모는 비밀번호를 넣어야 하니 복사 대신 창을 띄운다
    // shortcut: 복사도 했을 때 포커스를 쓰던 앱에 남기기(inactive)는 아직 — 창을 띄우면 포커스를 가져간다
    if b["show"] == true || (b["copy"] == true && !copied) {
        let _ = crate::memos::open_note(app, &id);
        if let Some(l) = state(app).note_labels.lock().unwrap().get(&id) {
            let _ = app.emit_to(l.as_str(), "memo:highlight", [Value::Null; 0]);
        }
    }
    // 붙여 넣는 법은 처음 몇 번만 (매일 수십 번 쓰는 사람에게는 군더더기)
    let tips = state(app).setting("hotkeyTips").as_u64().unwrap_or(0);
    let tip = copied && tips < 3;
    if tip {
        state(app).set_setting("hotkeyTips", (tips + 1).into());
    }
    let title = memo["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("제목 없음");
    if copied {
        crate::windows::show_hud(app, &format!("“{title}” 내용을 복사했어요"), if tip { "Ctrl+V로 붙여 넣으세요" } else { "" }, "ok");
    } else if b["copy"] == true && memo["needsPassword"] == true {
        crate::windows::show_hud(app, "잠긴 메모라 복사하지 않았어요", "비밀번호를 넣고 열어 주세요", "warn");
    } else if b["copy"] == true {
        crate::windows::show_hud(app, "복사하지 못했어요", "다시 눌러 주세요", "warn");
    }
}

// ---------- 전역 단축키 바꾸기 (설정 › 단축키) ----------

fn set_shortcut(app: &AppHandle, name: &str, wanted: Option<String>) -> Value {
    let Some(&(_, def, _)) = SHORTCUTS.iter().find(|s| s.0 == name) else { return json!({ "ok": false, "reason": "invalid" }) };
    let fail = |extra: Value| {
        let mut r = json!({ "ok": false, "status": status(app, name) });
        r.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
        r
    };
    let next = wanted.unwrap_or_else(|| def.into());
    if !acc::is_valid_accelerator(&json!(next)) {
        return fail(json!({ "reason": "invalid" }));
    }
    if let Some(other) = SHORTCUTS.iter().find(|s| s.0 != name && shortcut_key(app, s.0) == next) {
        return fail(json!({ "reason": "same", "other": other.2 }));
    }
    // 메모 단축키(Ctrl+Alt+숫자)가 쓰는 키 — 바꾸는 동안은 잠시 놓여 있으므로 잡은 키가 아니라 정해 둔 칸으로 본다
    if hotkeys(app).iter().any(|(slot, b)| acc::hotkey_accelerator(slot) == next && memo_exists(app, b["id"].as_str().unwrap_or_default())) {
        return fail(json!({ "reason": "same", "other": "메모 단축키" }));
    }
    // 메모 창 단축키가 쓰는 키를 전역으로 가져가면 그 기능이 모든 메모 창에서 멈춘다
    if let Some(label) = acc::combo_from_accelerator(&next).and_then(|c| crate::settings::action_using(&state(app).setting("keymap"), &c)) {
        return fail(json!({ "reason": "same", "other": format!("메모 창의 '{label}'") }));
    }
    if enabled(app, name) && next != shortcut_key(app, name) {
        if app.global_shortcut().register(next.as_str()).is_err() {
            return fail(json!({ "reason": "taken", "label": acc::display_accelerator(&next) }));
        }
        let _ = app.global_shortcut().unregister(next.as_str());
    }
    let mut all: Map<String, Value> = SHORTCUTS.iter().map(|s| s.0.to_string()).zip(acc::normalize_shortcuts(&state(app).setting("shortcuts")).map(Value::from)).collect();
    all.insert(name.into(), next.into());
    state(app).set_setting("shortcuts", Value::Object(all));
    if name != "magic" {
        register_global(app, name);
    }
    register_memo(app); // 놓아 준 Ctrl+Alt+숫자를 메모 단축키가 다시 쓰게
    // 설정 창 · 단축키 설정 창 어디서 바꿨든 둘 다 바로
    let _ = app.emit("shortcuts:changed", [Value::Null; 0]);
    json!({ "ok": true, "status": status(app, name) })
}

// ---------- 메모 단축키 정하기 (메모 창 › 단축키로 불러오기) ----------

/// MemoHotkeys.state: 그 메모의 칸과 칸마다 쓰는 메모
fn hotkey_state(app: &AppHandle, id: &str) -> Value {
    let map = hotkeys(app);
    let mine = acc::slot_of(&map, id);
    let failed = KEYS.lock().unwrap().failed.clone();
    let slots: Vec<Value> = acc::HOTKEY_SLOTS
        .iter()
        .map(|&slot| {
            let b = map.get(slot);
            let other_id = b.and_then(|b| b["id"].as_str()).filter(|o| *o != id);
            // 다른 메모가 쓰는 칸: 그 메모 제목 (지워진 메모면 빈 칸처럼)
            let other = other_id.and_then(|o| state(app).vault.lock().unwrap().as_ref().and_then(|v| v.get(o)));
            let title = other.map(|m| m["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("제목 없음").to_string());
            let reserved = reserved_by(app, slot);
            json!({ "slot": slot, "label": acc::hotkey_label(slot), "mine": b.is_some_and(|b| b["id"] == id), "title": title, "reserved": reserved, "failed": failed.contains(slot) && reserved.is_none() })
        })
        .collect();
    let mb = mine.as_ref().and_then(|s| map.get(s));
    json!({ "slot": mine, "copy": mb.is_none_or(|b| b["copy"] == true), "show": mb.is_some_and(|b| b["show"] == true), "slots": slots })
}

/// MemoHotkeys.set: 칸 정하기 (None 이면 풀기) → { ok, error?, state }
fn set_hotkey(app: &AppHandle, id: &str, slot: Option<String>, copy: bool, show: bool) -> Value {
    let fail = |error: String| json!({ "ok": false, "error": error, "state": hotkey_state(app, id) });
    if let Some(name) = slot.as_deref().and_then(|s| reserved_by(app, s)) {
        return fail(format!("{}: {name} 단축키라 쓸 수 없어요", acc::hotkey_label(slot.as_deref().unwrap())));
    }
    let next = match acc::assign_hotkey(&state(app).setting("memoHotkeys"), id, slot.as_deref(), copy, show) {
        Ok(n) => n,
        Err(e) => return fail(e),
    };
    let taken = |s: &str| format!("{}: 다른 앱이 이미 쓰고 있어요. 다른 숫자를 골라 주세요", acc::hotkey_label(s));
    let paused = KEYS.lock().unwrap().paused;
    // 단축키를 바꾸는 중(잠시 놓음)이면 잡아 보고 바로 놓아 다른 앱이 쓰는지만 본다
    if let Some(s) = slot.as_deref().filter(|_| paused) {
        let key = acc::hotkey_accelerator(s);
        if app.global_shortcut().register(key.as_str()).is_err() {
            return fail(taken(s));
        }
        let _ = app.global_shortcut().unregister(key.as_str());
    }
    let before = state(app).setting("memoHotkeys");
    state(app).settings.lock().unwrap().insert("memoHotkeys".into(), Value::Object(next));
    register_memo(app);
    if let Some(s) = slot.as_deref().filter(|s| !paused && !KEYS.lock().unwrap().held.contains_key(*s)) {
        // 다른 앱이 이미 쓰는 키 — 예전대로 되돌린다
        state(app).settings.lock().unwrap().insert("memoHotkeys".into(), before);
        register_memo(app);
        return fail(taken(s));
    }
    state(app).save_settings();
    json!({ "ok": true, "state": hotkey_state(app, id) })
}

// ---------- 처음 실행 튜토리얼 ----------

struct Tutorial {
    active: bool,
    index: i64,
    praise: bool,
    /// 다시 보는 사람 (설정 › 사용법 둘러보기) — 첫 말풍선에서 어디부터 볼지 고르게
    again: bool,
    /// 시작할 때의 Work / Life 나누기 — 연습하며 켠 것을 끝나면 처음대로
    work_life: Value,
}
static TUTORIAL: Mutex<Tutorial> = Mutex::new(Tutorial { active: false, index: -1, praise: false, again: false, work_life: Value::Null });

fn payload(app: &AppHandle) -> Value {
    let (index, praise, again) = {
        let t = TUTORIAL.lock().unwrap();
        if !t.active {
            return Value::Null;
        }
        (t.index, t.praise, t.again)
    };
    let Some(raw) = usize::try_from(index).ok().and_then(|i| tutorial::steps().get(i)) else { return Value::Null };
    // 직접 해 볼 기능이 꺼져 있으면 안내만 (Work / Life 나누기 · 매직 카피 키 · 알림 보관함)
    let has = |need: &str| match need {
        "workLife" => state(app).setting("workLife") == true,
        "history" => state(app).setting("historyEnabled") == true,
        "quickMemo" => status(app, "quickMemo")["registered"] == true,
        _ => true,
    };
    let mut step = tutorial::step_for(raw, has);
    let shortcuts = state(app).setting("shortcuts");
    // 테이프는 아직 옮기지 않아 테이프를 못 쓰는 PC 처럼 왕관만 (noTape)
    let text = if step["noTape"].is_null() { step["text"].clone() } else { step["noTape"].clone() };
    let s = step.as_object_mut().unwrap();
    for (k, v) in [("title", s.get("title").cloned().unwrap_or_default()), ("text", text), ("try", s.get("try").cloned().unwrap_or_default())] {
        match v.as_str() {
            Some(t) => s.insert(k.into(), acc::with_shortcuts(t, &shortcuts).into()),
            None if v.is_null() => None,
            None => s.insert(k.into(), v),
        };
    }
    s.insert("index".into(), index.into());
    s.insert("total".into(), tutorial::steps().len().into());
    s.insert("praise".into(), praise.into());
    s.insert("chapter".into(), tutorial::chapter(index));
    if index == 0 && again {
        s.insert("jumps".into(), tutorial::jumps());
    }
    // shortcut: 연습 공간(예시 메모가 든 임시 폴더, seedTutorialSandbox)은 아직 — 실제 메모 폴더에서 한다 (PC 단계는 메모를 만들거나 고치지 않는다). 메모를 다루는 단계가 생기면 연습 공간도
    s.insert("sandbox".into(), false.into());
    step
}

/// 말풍선을 띄울 창 — PC 단계는 모두 목록 창 (튜토리얼 중 만든 메모 창 단계는 없다)
fn target(step: &Value) -> Option<&'static str> {
    (step["win"] == "list").then_some("list")
}

fn send(app: &AppHandle) {
    let p = payload(app);
    let to = target(&p);
    let notes: Vec<String> = state(app).note_labels.lock().unwrap().values().cloned().collect();
    for l in std::iter::once("list".to_string()).chain(notes) {
        let _ = app.emit_to(l.as_str(), "tutorial:step", [if Some(l.as_str()) == to { p.clone() } else { Value::Null }]);
    }
}

fn list_to_front(app: &AppHandle) {
    crate::os::show_list(app);
    let _ = app.emit_to("list", "list:tab", ["memos"]);
}

pub fn start_tutorial(app: &AppHandle) -> bool {
    if state(app).vault.lock().unwrap().is_none() {
        return false;
    }
    {
        let mut t = TUTORIAL.lock().unwrap();
        if !t.active {
            t.work_life = state(app).setting("workLife");
        }
        (t.active, t.index, t.praise, t.again) = (true, 0, false, state(app).setting("tutorialDone") == true);
    }
    list_to_front(app);
    send(app);
    true
}

fn finish_tutorial(app: &AppHandle) {
    let work_life = {
        let mut t = TUTORIAL.lock().unwrap();
        (t.active, t.index, t.praise) = (false, -1, false);
        std::mem::take(&mut t.work_life)
    };
    state(app).set_setting("tutorialDone", true.into());
    send(app);
    // 목록 창: 연습하며 바꾼 보기 · 확대 · 태그 고르기 · 늘 위에를 처음대로
    let _ = app.emit_to("list", "tutorial:finished", [Value::Null; 0]);
    // 연습하며 켠 Work / Life 나누기도 처음대로
    if state(app).setting("workLife") != work_life {
        let _ = crate::settings::handle(app, "list", "mode:work-life", &[work_life]);
    }
}

/// 말풍선 단추: 'jump:<번호>' 다시 볼 때 그 묶음부터 · 'enable:workLife' 꺼진 기능을 켜고 그 자리에서 직접 해 보기
fn tutorial_action(app: &AppHandle, action: &str) {
    let index = {
        let t = TUTORIAL.lock().unwrap();
        if !t.active {
            return;
        }
        t.index
    };
    if let Some(to) = action.strip_prefix("jump:").filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).and_then(|n| n.parse::<i64>().ok()) {
        if !tutorial::jumps().as_array().unwrap().iter().any(|j| j["index"] == to) {
            return;
        }
        {
            let mut t = TUTORIAL.lock().unwrap();
            (t.index, t.praise) = (to, false);
        }
        list_to_front(app);
        return send(app);
    }
    let needs = usize::try_from(index).ok().and_then(|i| tutorial::steps().get(i)).map(|s| s["needs"].clone()).unwrap_or_default();
    if action == "enable:workLife" && needs == "workLife" {
        let _ = crate::settings::handle(app, "list", "mode:work-life", &[true.into()]); // 목록 창은 mode:changed 로 스위치를 보인다
        send(app);
    }
    // shortcut: 'enable:history'(알림 보관함 켜기)는 보관함을 옮길 때 — 지금은 안내만 보인다
}

pub fn tutorial_event(app: &AppHandle, event: &str) {
    let (index, next) = {
        let t = TUTORIAL.lock().unwrap();
        if !t.active {
            return;
        }
        (t.index, tutorial::advance(t.index, event))
    };
    if next == index {
        return;
    }
    if next < 0 {
        return finish_tutorial(app);
    }
    let steps = tutorial::steps();
    {
        let mut t = TUTORIAL.lock().unwrap();
        t.praise = event != "next" && steps[index as usize]["advance"] == event;
        t.index = next;
    }
    // 튜토리얼 중 만든 메모 창이 없다 — 메모 단계면 목록 단계로
    if steps[next as usize]["win"] == "note" {
        return tutorial_event(app, "note-closed");
    }
    list_to_front(app);
    send(app);
}

// ---------- 화면이 그린 메뉴 (오른쪽 클릭) ----------

/// 띄운 메뉴 (번호, 고른 항목을 받을 곳) — 메뉴 항목 id 는 "mk-menu:<번호>:<항목>"
static MENU: Mutex<Option<(u64, mpsc::Sender<usize>)>> = Mutex::new(None);

fn menu_chosen(id: &str) {
    let mut it = id.strip_prefix("mk-menu:").unwrap_or_default().split(':').map(|n| n.parse::<u64>().ok());
    if let (Some(Some(n)), Some(Some(i))) = (it.next(), it.next()) {
        if let Some((_, tx)) = MENU.lock().unwrap().as_ref().filter(|(m, _)| *m == n) {
            let _ = tx.send(i as usize);
        }
    }
}

/// menu:choose: [{ id, label, accelerator?, enabled? } | { type: 'separator' }], 자리 { x, y }? → 고른 id | null
fn choose(app: &AppHandle, label: &str, raw: &Value, at: &Value) -> Result<Value, String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let items: Vec<&Value> = raw.as_array().into_iter().flatten().take(24).filter(|it| it["type"] == "separator" || (it["id"].is_string() && it["label"].is_string())).collect();
    let Some(win) = app.get_webview_window(label).filter(|_| items.iter().any(|it| it["type"] != "separator")) else { return Ok(Value::Null) };
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    for (i, it) in items.iter().enumerate() {
        let r = if it["type"] == "separator" {
            menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        } else {
            let text: String = it["label"].as_str().unwrap_or_default().chars().take(80).collect();
            menu.append(&MenuItem::with_id(app, format!("mk-menu:{n}:{i}"), text, it["enabled"] != false, it["accelerator"].as_str()).map_err(|e| e.to_string())?)
        };
        r.map_err(|e| e.to_string())?;
    }
    let (tx, rx) = mpsc::channel();
    *MENU.lock().unwrap() = Some((n, tx));
    let r = match (at["x"].as_f64(), at["y"].as_f64()) {
        (Some(x), Some(y)) => win.popup_menu_at(&menu, tauri::LogicalPosition::new(x.round(), y.round())),
        _ => win.popup_menu(&menu),
    };
    r.map_err(|e| e.to_string())?;
    // Windows 는 메뉴가 닫힐 때까지 기다렸다 돌아오고, 고른 일은 그 뒤에 온다 — 한 박자 기다린다
    // shortcut: 그 밖(Linux)은 메뉴가 닫히는 때를 몰라 고를 때까지(최대 1분) 기다린다 — 개발용이라 그대로
    let wait = Duration::from_millis(if cfg!(windows) { 300 } else { 60_000 });
    let chosen = rx.recv_timeout(wait).ok().and_then(|i| items.get(i)).map(|it| it["id"].clone());
    let mut m = MENU.lock().unwrap();
    if m.as_ref().is_some_and(|(k, _)| *k == n) {
        *m = None;
    }
    Ok(chosen.unwrap_or(Value::Null))
}

/// edit:run: 화면이 그린 메뉴(표 오른쪽 클릭)의 편집 명령 — 그 창의 포커스가 있는 글 칸에
fn edit_run(app: &AppHandle, label: &str, name: &str) -> Value {
    let text = || app.clipboard().read_text().unwrap_or_default();
    let eval = |js: String| {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.eval(js);
        }
    };
    match name {
        "cut" | "copy" => eval(format!("document.execCommand('{name}')")),
        // shortcut: 붙여넣기는 글만 (Electron 의 webContents.paste 처럼 서식 · 그림까지는 아님) — 서식 붙여넣기가 아쉬우면 클립보드 HTML 을 편집기에 넘기게
        "paste" => eval(format!("document.execCommand('insertText', false, {})", json!(text()))),
        "pastePlain" => {
            let _ = app.emit_to(label, "edit:paste-plain", [text()]);
        }
        // 메모 편집기 오른쪽 클릭 메뉴(shim.js)의 서식 지우기 — 편집기가 맡는다 (Ctrl+\ 와 같은 일)
        "clearFormat" => {
            let _ = app.emit_to(label, "edit:clear-format", [Value::Null; 0]);
        }
        _ => {}
    }
    true.into()
}

// ---------- 채널 ----------

pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
    let opt = |i: usize| Some(arg(i)).filter(|v| !v.is_null()).map(|v| js::string(&v));
    Some(Ok(match channel {
        "shortcuts:set" => set_shortcut(app, &js::string(&arg(0)), opt(1)),
        // 새 키를 받는 동안 전역 단축키를 잠시 놓기 — 놓은 창이 닫히면(되살리기를 못 보냄) 여기서 되살린다
        // shortcut: 놓은 창을 새로 고쳤을 때(did-start-loading)는 못 본다 — 그 창이 닫히거나 다시 놓기를 부를 때까지 놓인 채
        "shortcuts:pause" => {
            let on = crate::settings::truthy(args.first());
            let watch = {
                let mut k = KEYS.lock().unwrap();
                k.paused_by = on.then(|| label.to_string());
                on && k.watched.insert(label.to_string())
            };
            if let Some(w) = app.get_webview_window(label).filter(|_| watch) {
                let (app2, l) = (app.clone(), label.to_string());
                w.on_window_event(move |e| {
                    if let WindowEvent::Destroyed = e {
                        let mut k = KEYS.lock().unwrap();
                        k.watched.remove(&l);
                        if k.paused_by.as_ref() == Some(&l) {
                            k.paused_by = None;
                            drop(k);
                            // 창 이벤트는 메인 스레드 — 단축키 잡기는 다른 스레드에서
                            let app = app2.clone();
                            std::thread::spawn(move || pause(&app, false));
                        }
                    }
                });
            }
            pause(app, on);
            Value::Null
        }
        "app:set-quick-memo" => {
            state(app).set_setting("quickMemo", crate::settings::truthy(args.first()).into());
            register_global(app, "quickMemo");
            return Some(crate::memos::handle(app, label, "app:settings", &[]).unwrap_or(Ok(Value::Null)).map(|s| s["quickMemo"].clone()));
        }
        "hotkey:state" => hotkey_state(app, &js::string(&arg(0))),
        "hotkey:set" => {
            let o = arg(2);
            let r = set_hotkey(app, &js::string(&arg(0)), opt(1), o["copy"] != false, o["show"] == true);
            if r["ok"] == true {
                crate::memos::push_list(app);
            }
            r
        }
        "keymap:open-window" => {
            let Some(w) = app.get_webview_window("keymap") else {
                let win = crate::window(app, "keymap", "shortcuts.html").title("단축키 설정").inner_size(640.0, 720.0).min_inner_size(460.0, 420.0).center().build();
                return Some(win.map(|_| true.into()).map_err(|e| e.to_string()));
            };
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            true.into()
        }
        "tutorial:start" => start_tutorial(app).into(),
        "tutorial:current" => {
            let p = payload(app);
            if target(&p) == Some(label) {
                p
            } else {
                Value::Null
            }
        }
        "tutorial:action" => {
            match arg(0).as_str() {
                Some(a @ ("next" | "skip")) => tutorial_event(app, a),
                Some(a) => tutorial_action(app, a),
                None => {}
            }
            Value::Null
        }
        "tutorial:event" => {
            let name = arg(0);
            // 메모를 만들거나 닫은 일은 화면이 아니라 앱이 안다
            if tutorial::events().contains(&name) && name != "memo-created" && name != "note-closed" {
                tutorial_event(app, name.as_str().unwrap_or_default());
            }
            Value::Null
        }
        "edit:run" => edit_run(app, label, arg(0).as_str().unwrap_or_default()),
        "menu:choose" => return Some(choose(app, label, &arg(0), &arg(1))),
        _ => return None,
    }))
}
