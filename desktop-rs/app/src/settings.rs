// 설정 채널 — 값 하나를 settings.json 에 쓰고 열린 창에 알리는 것들. Electron 의 ipc-handlers.js · main.js(Work / Life) 그 부분.
use crate::state::State;
use memoking_core::js;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

/// JS 의 Boolean(v)
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// 모든 창에 (Electron broadcast)
fn broadcast(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, [payload]);
}

/// 화면이 읽는 설정 전체 (app:settings 는 memos.rs 에 있다)
fn app_settings(app: &AppHandle, label: &str) -> Result<Value, String> {
    crate::memos::handle(app, label, "app:settings", &[]).unwrap_or(Ok(Value::Null))
}

/// 켜고 끄기만 하는 설정: 쓰고 그 값을 돌려준다
fn set_flag(st: &State, key: &str, on: bool) -> Value {
    st.set_setting(key, on.into());
    on.into()
}

/// 모드 · 나누기가 바뀌었을 때: 새 메모의 모드 · 열린 창들 (Electron applyAppMode)
// shortcut: 작업 표시줄 표시 · 트레이 글은 트레이를 옮길 때 같이
fn apply_mode(app: &AppHandle, st: &State) {
    let enabled = st.setting("workLife") == true;
    let mode = if enabled && st.setting("mode") == "work" { "work" } else { "life" };
    if let Some(v) = st.vault.lock().unwrap().as_mut() {
        v.default_mode = mode.into();
    }
    broadcast(app, "mode:changed", json!({ "mode": mode, "enabled": enabled }));
}

const TRASH_DAYS: [f64; 5] = [0.0, 7.0, 30.0, 90.0, 365.0];

pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let st = app.state::<State>();
    let on = truthy(args.first());
    Some(match channel {
        "app:set-fit-tables" => Ok(set_flag(&st, "fitTables", on)),
        "app:set-auto-tags" => Ok(set_flag(&st, "autoTags", on)),
        "app:set-auto-events" => Ok(set_flag(&st, "autoEvents", on)),
        "app:set-ai-phone" => Ok(set_flag(&st, "aiPhone", on)),
        "app:set-magic-polish" => Ok(set_flag(&st, "magicPolish", on)),
        "app:set-link-previews" => {
            // 열린 메모 · 위젯에도 바로
            let v = set_flag(&st, "linkPreviews", on);
            broadcast(app, "settings:link-previews", v.clone());
            Ok(v)
        }
        "app:set-trash-days" => {
            let d = js::number(args.first().unwrap_or(&Value::Null));
            if TRASH_DAYS.contains(&d) {
                st.set_setting("trashDays", (d as u64).into());
                // 바꾼 날수보다 오래된 휴지통 메모는 바로 비운다 (Electron purgeTrash)
                if let Some(v) = st.vault.lock().unwrap().as_ref().filter(|_| d > 0.0) {
                    v.empty_trash(Some(d as u32));
                }
            }
            app_settings(app, label)
        }
        // 메모킹 Work / Life — 목록이 그 모드의 메모만 보이고, 새 메모도 그 모드로
        "mode:set" => {
            let mode = if args.first().is_some_and(|m| m == "work") { "work" } else { "life" };
            st.set_setting("mode", mode.into());
            apply_mode(app, &st);
            Ok(mode.into())
        }
        "mode:work-life" => {
            // 끄면 Life 로 돌아간다
            if !on {
                st.settings.lock().unwrap().insert("mode".into(), "life".into());
            }
            st.set_setting("workLife", on.into());
            apply_mode(app, &st);
            Ok(on.into())
        }
        // shortcut: 업무 시간 시계(auto: 경계에서 Work ↔ Life) · 퇴근 뒤 조용히는 아직 — 값만 둔다. 알림을 옮길 때 modeClock 도
        "mode:hours" => {
            let hours = normalize_hours(args.first().unwrap_or(&Value::Null));
            st.set_setting("workHours", hours.clone());
            Ok(hours)
        }
        // 메모 창 단축키 (바꾼 것만 settings.keymap 에) — 바꾸면 열린 창 모두 바로
        "keymap:get" => keymap_state(app, label, &st),
        "keymap:set" => {
            let id = args.first().map(js::string).unwrap_or_else(|| "undefined".into());
            let combo = args.get(1).filter(|c| !c.is_null()).map(js::string);
            let (overrides, moved) = set_action_key(&st.setting("keymap"), &id, combo.as_deref());
            keymap_changed(app, &st, overrides);
            keymap_state(app, label, &st).map(|mut s| {
                s["moved"] = json!(moved);
                s
            })
        }
        "keymap:reset" => {
            keymap_changed(app, &st, Map::new());
            keymap_state(app, label, &st)
        }
        _ => return None,
    })
}

/// actionUsing: 이 키를 쓰는 메모 창 기능의 이름 (같은 키가 둘이면 앞의 기능)
pub fn action_using(overrides: &Value, combo: &str) -> Option<&'static str> {
    let o = overrides.as_object().cloned().unwrap_or_default();
    ACTIONS.iter().zip(raw_keys(&o)).find(|(_, keys)| keys.iter().any(|k| k == combo)).map(|(a, _)| a.1)
}

fn keymap_state(app: &AppHandle, label: &str, st: &State) -> Result<Value, String> {
    let shortcuts = app_settings(app, label)?["shortcuts"].clone();
    Ok(json!({ "overrides": clean_overrides(&st.setting("keymap")), "shortcuts": shortcuts }))
}

fn keymap_changed(app: &AppHandle, st: &State, overrides: Map<String, Value>) {
    st.set_setting("keymap", Value::Object(overrides.clone()));
    broadcast(app, "keymap:changed", Value::Object(overrides));
}

// ---------- 업무 시간 (app/js/core/work-hours.js normalizeHours) ----------

fn is_hhmm(v: &Value) -> bool {
    let Some(s) = v.as_str() else { return false };
    let b = s.as_bytes();
    b.len() == 5 && b[2] == b':' && s[..2].parse::<u8>().is_ok_and(|h| h < 24) && s[3..].parse::<u8>().is_ok_and(|m| m < 60) && b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit())
}

pub fn normalize_hours(v: &Value) -> Value {
    let days: Vec<u8> = match v["days"].as_array() {
        Some(a) => {
            let mut d: Vec<u8> = a.iter().map(js::number).filter(|n| n.fract() == 0.0 && (0.0..=6.0).contains(n)).map(|n| n as u8).collect();
            d.sort_unstable();
            d.dedup();
            d
        }
        None => vec![1, 2, 3, 4, 5],
    };
    let time = |k: &str, def: &str| if is_hhmm(&v[k]) { v[k].clone() } else { def.into() };
    json!({ "auto": v["auto"] == true, "quiet": v["quiet"] == true, "days": days, "start": time("start", "09:00"), "end": time("end", "18:00") })
}

// ---------- 메모 창 단축키 (app/js/core/keymap.js 의 규칙) ----------

/// (id, 이름, 기본 키) — keymap.js KEYMAP_ACTIONS 와 같은 차례 (같은 키가 둘이면 앞의 기능이 갖는다)
const ACTIONS: &[(&str, &str, &[&str])] = &[
    ("new", "새 메모 창", &["ctrl+KeyN"]),
    ("close", "닫기", &["ctrl+KeyW"]),
    ("top", "늘 위에 두기 (왕관)", &["ctrl+shift+KeyT"]),
    ("tape", "바탕화면에 붙이기 (테이프)", &["ctrl+shift+KeyG"]),
    ("reminders", "알림", &["ctrl+shift+KeyA"]),
    ("links", "메모 연결", &["ctrl+KeyK"]),
    ("pdf", "PDF로 저장", &["ctrl+shift+KeyP"]),
    ("versions", "이전 버전", &["ctrl+shift+KeyY"]),
    ("list", "메모 목록 열기", &["ctrl+shift+KeyM"]),
    ("imageCopy", "그림으로 복사", &[]),
    ("imageSave", "그림으로 저장", &[]),
    ("pin", "목록 맨 위에 고정", &[]),
    ("lock", "잠그기", &[]),
    ("find", "찾기", &["ctrl+KeyF"]),
    ("replace", "바꾸기", &["ctrl+KeyH"]),
    ("shortcuts", "단축키 보기", &["ctrl+Slash"]),
    ("bold", "굵게", &["ctrl+KeyB"]),
    ("italic", "기울임", &["ctrl+KeyI"]),
    ("underline", "밑줄", &["ctrl+KeyU"]),
    ("strike", "취소선", &["ctrl+KeyT"]),
    ("code", "코드", &["ctrl+KeyE"]),
    ("color", "글자 색 (마지막 색)", &["ctrl+shift+KeyC"]),
    ("highlight", "형광펜 (마지막 색)", &["ctrl+shift+KeyH"]),
    ("clearFormat", "서식 지우기", &["ctrl+Backslash"]),
    ("h1", "제목 1", &["ctrl+Digit1"]),
    ("h2", "제목 2", &["ctrl+Digit2"]),
    ("h3", "제목 3", &["ctrl+Digit3"]),
    ("paragraph", "본문", &["ctrl+Digit0"]),
    ("quote", "인용", &["ctrl+shift+KeyB"]),
    ("bullet", "글머리 목록", &["ctrl+shift+Digit8", "ctrl+shift+KeyL"]),
    ("ordered", "번호 목록", &["ctrl+shift+Digit7"]),
    ("task", "체크리스트", &["ctrl+shift+Digit9"]),
    ("file", "파일 넣기", &["ctrl+shift+KeyI"]),
    ("record", "음성 녹음 시작, 끝내기", &["ctrl+shift+KeyR"]),
    ("ink", "손 메모", &["ctrl+shift+KeyD"]),
    ("annotate", "글 위에 그리기", &["ctrl+shift+KeyE"]),
];

// 편집 · 창이 늘 쓰는 키 — 다른 기능에 줄 수 없다
const RESERVED: &[&str] = &[
    "ctrl+KeyC", "ctrl+KeyV", "ctrl+KeyX", "ctrl+KeyZ", "ctrl+KeyY", "ctrl+KeyA", "ctrl+shift+KeyZ", "ctrl+shift+KeyV", "ctrl+Tab", "ctrl+shift+Tab", "ctrl+Equal", "ctrl+shift+Equal", "ctrl+Minus",
    "ctrl+NumpadAdd", "ctrl+NumpadSubtract", "alt+ArrowUp", "alt+ArrowDown", "alt+F4",
];
const NAV: &[&str] = &["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Delete", "Insert", "Space"];
const PUNCT: &[&str] = &["Minus", "Equal", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backslash", "Backquote"];

/// accelerators.js keyName 이 이름을 아는 키인가
fn known_key(code: &str) -> bool {
    let tail = |p: &str| code.strip_prefix(p).unwrap_or_default().to_string();
    let f = tail("F").parse::<u8>().ok().filter(|n| (1..=24).contains(n) && tail("F") == n.to_string());
    (tail("Key").len() == 1 && tail("Key").as_bytes()[0].is_ascii_uppercase())
        || (tail("Digit").len() == 1 && tail("Digit").as_bytes()[0].is_ascii_digit())
        || f.is_some()
        || PUNCT.contains(&code)
        || NAV.contains(&code)
}

/// isValidCombo: Ctrl 이나 Alt 와 함께(F1~F12 는 혼자도), 아는 키, 늘 쓰는 키가 아님
fn is_valid_combo(combo: &str) -> bool {
    let mut rest = combo;
    let mut take = |p: &str| rest.strip_prefix(p).map(|r| rest = r).is_some();
    let (ctrl, shift, alt) = (take("ctrl+"), take("shift+"), take("alt+"));
    let code = rest;
    if code.is_empty() || !code.bytes().all(|b| b.is_ascii_alphanumeric()) || !known_key(code) {
        return false;
    }
    let fkey = code.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=12).contains(&n));
    if !ctrl && !alt && !fkey {
        return false;
    }
    // 글을 옮겨 다니는 키 · Ctrl+Alt+1~9(메모 불러오기 키)도 못 준다
    let nav = NAV.contains(&code) && (ctrl || shift || alt);
    let memo_hotkey = ctrl && alt && !shift && code.len() == 6 && code.starts_with("Digit") && code.as_bytes()[5].is_ascii_digit() && code != "Digit0";
    !RESERVED.contains(&combo) && !nav && !memo_hotkey
}

/// 설정의 키 목록 → 쓸 만한 첫 키 하나 (rawKeys · cleanOverrides 의 filter(isValidCombo).slice(0, 1))
fn first_valid(keys: &[Value]) -> Vec<String> {
    keys.iter().filter_map(Value::as_str).filter(|k| is_valid_combo(k)).take(1).map(str::to_string).collect()
}

/// 기능마다 지금 키 (바꾼 것이 없으면 기본 키)
fn raw_keys(overrides: &Map<String, Value>) -> Vec<Vec<String>> {
    ACTIONS.iter().map(|(id, _, def)| overrides.get(*id).and_then(Value::as_array).map_or_else(|| def.iter().map(|k| k.to_string()).collect(), |a| first_valid(a))).collect()
}

/// cleanOverrides: 설정에 둘 것만 — 아는 기능 중 기본값과 다른 것
pub fn clean_overrides(overrides: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for (id, keys) in overrides.as_object().into_iter().flatten() {
        let (Some((_, _, def)), Some(keys)) = (ACTIONS.iter().find(|a| a.0 == id), keys.as_array()) else { continue };
        let k = first_valid(keys);
        if k == *def {
            continue;
        }
        out.insert(id.clone(), json!(k));
    }
    out
}

/// setActionKey: 기능 하나의 키를 바꾼다 (None = 기본값으로). 같은 키를 쓰던 다른 기능에서는 그 키를 뺀다 → (바꾼 것, 키를 빼앗긴 기능 이름)
pub fn set_action_key(overrides: &Value, id: &str, combo: Option<&str>) -> (Map<String, Value>, Vec<String>) {
    let mut next = clean_overrides(overrides);
    let Some(me) = ACTIONS.iter().position(|a| a.0 == id) else { return (next, vec![]) };
    match combo {
        None => {
            next.remove(id);
        }
        Some(c) => {
            next.insert(id.into(), if c.is_empty() { json!([]) } else { json!([c]) });
        }
    }
    let now = raw_keys(&next);
    let mut moved = vec![];
    for (i, (other, name, _)) in ACTIONS.iter().enumerate() {
        if i != me && now[i].iter().any(|k| now[me].contains(k)) {
            let left: Vec<&String> = now[i].iter().filter(|k| !now[me].contains(k)).take(1).collect();
            next.insert(other.to_string(), json!(left));
            moved.push(name.to_string());
        }
    }
    (clean_overrides(&Value::Object(next)), moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_match_keymap_js() {
        // 기능 표를 손으로 옮겼으니 keymap.js 와 어긋나면 알린다
        let src = include_str!("../../../app/js/core/keymap.js");
        let lines: Vec<&str> = src.lines().filter(|l| l.trim_start().starts_with("{ id: '")).collect();
        assert_eq!(lines.len(), ACTIONS.len());
        for (line, (id, _, keys)) in lines.iter().zip(ACTIONS) {
            let want = format!("keys: [{}]", keys.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", "));
            assert!(line.contains(&format!("{{ id: '{id}'")) && line.contains(&want), "{id}: {line}");
        }
    }

    #[test]
    fn combos() {
        for ok in ["ctrl+KeyQ", "F2", "shift+F5", "alt+KeyP", "ctrl+alt+Digit0", "ctrl+Backquote", "ctrl+F24"] {
            assert!(is_valid_combo(ok), "{ok}");
        }
        for bad in ["KeyQ", "shift+KeyQ", "F13", "ctrl+KeyC", "ctrl+ArrowLeft", "ctrl+alt+Digit3", "shift+ctrl+KeyQ", "ctrl+Numpad1", "ctrl+F0", "ctrl+F05", "ctrl+Keyq", ""] {
            assert!(!is_valid_combo(bad), "{bad}");
        }
    }

    #[test]
    fn overrides_keep_only_changes_and_steal_keys() {
        let o = json!({ "bold": ["ctrl+KeyB"], "italic": [], "nope": ["ctrl+KeyQ"], "pin": [], "code": ["ctrl+KeyC", "ctrl+KeyQ"] });
        assert_eq!(Value::Object(clean_overrides(&o)), json!({ "italic": [], "code": ["ctrl+KeyQ"] }));
        // 굵게의 키를 찾기에 주면 굵게는 키를 잃는다
        let (next, moved) = set_action_key(&json!({}), "find", Some("ctrl+KeyB"));
        assert_eq!((Value::Object(next), moved), (json!({ "find": ["ctrl+KeyB"], "bold": [] }), vec!["굵게".to_string()]));
        // 기본값으로 되돌리면 빼앗았던 키도 돌아오지 않는다 (Electron 과 같게)
        let (next, _) = set_action_key(&json!({ "find": ["ctrl+KeyB"], "bold": [] }), "find", None);
        assert_eq!(Value::Object(next), json!({ "bold": [] }));
        assert_eq!(set_action_key(&json!({ "x": 1 }), "nope", Some("ctrl+KeyQ")).0, Map::new());
        // 전역 단축키로 가져가면 멈출 메모 창 기능
        assert_eq!(action_using(&Value::Null, "ctrl+shift+KeyP"), Some("PDF로 저장"));
        assert_eq!(action_using(&json!({ "pdf": [], "find": ["ctrl+shift+KeyP"] }), "ctrl+shift+KeyP"), Some("찾기"));
        assert_eq!(action_using(&json!({ "find": ["ctrl+KeyB"] }), "ctrl+KeyB"), Some("찾기"), "같은 키면 앞의 기능");
    }

    #[test]
    fn hours() {
        assert_eq!(normalize_hours(&Value::Null), json!({ "auto": false, "quiet": false, "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00" }));
        let h = json!({ "auto": true, "quiet": 1, "days": [6, "0", 6, 7, 1.5, null], "start": "22:30", "end": "24:00" });
        assert_eq!(normalize_hours(&h), json!({ "auto": true, "quiet": false, "days": [0, 6], "start": "22:30", "end": "18:00" }));
    }
}
