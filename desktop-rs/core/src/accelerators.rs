//! 전역 단축키 글자 (app/js/core/accelerators.js) · 메모 단축키 칸 (app/js/core/memo-hotkeys.js)
//!   저장: Electron accelerator ("Control+Alt+C") · 보이기: "Ctrl+Alt+C"
use serde_json::{json, Map, Value};

/// (이름, 기본 키, 보이는 이름) — DEFAULT_SHORTCUTS · SHORTCUT_NAMES 와 같은 차례
pub const SHORTCUTS: [(&str, &str, &str); 3] = [("quickMemo", "Control+Alt+C", "매직 카피"), ("magic", "Control+Alt+Space", "매직키"), ("list", "Control+Alt+`", "메모 목록")];

const PUNCT: [&str; 11] = ["-", "=", "[", "]", ";", "'", ",", ".", "/", "\\", "`"];
const NAMED: [&str; 11] = ["Space", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Insert", "Delete"];
// 프로그램마다 쓰는 기본 단축키 — 전역으로 가져가면 다른 앱의 복사 · 붙여넣기 등이 망가진다
const RESERVED: [&str; 22] = [
    "Control+C", "Control+V", "Control+X", "Control+Z", "Control+Y", "Control+A", "Control+S", "Control+F", "Control+P", "Control+N", "Control+O", "Control+W", "Control+T", "Control+Shift+Z", "Alt+F4",
    "Alt+Tab", "Control+Alt+Delete", "Super+L", "Super+D", "Super+E", "Super+R", "Super+Tab",
];

/// F1 ~ F24 (앞에 0 없이)
fn fkey(key: &str) -> bool {
    key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok().filter(|v| (1..=24).contains(v) && v.to_string() == n)).is_some()
}

/// isValidAccelerator: 저장된 단축키가 쓸 만한지 (Shift 말고 다른 꾸밈 키가 하나는 함께)
pub fn is_valid_accelerator(acc: &Value) -> bool {
    let Some(s) = acc.as_str() else { return false };
    let mut parts: Vec<&str> = s.split('+').collect();
    let key = parts.pop().unwrap_or_default();
    let mut mods = parts.clone();
    mods.sort_unstable();
    mods.dedup();
    if parts.is_empty() || mods.len() != parts.len() || !parts.iter().all(|m| ["Control", "Alt", "Shift", "Super"].contains(m)) || parts.iter().all(|m| *m == "Shift") {
        return false;
    }
    let one = key.len() == 1 && (key.as_bytes()[0].is_ascii_uppercase() || key.as_bytes()[0].is_ascii_digit());
    (one || fkey(key) || PUNCT.contains(&key) || NAMED.contains(&key)) && !RESERVED.contains(&s)
}

/// "Control+Alt+C" → "Ctrl+Alt+C", "Super+Shift+M" → "Win+Shift+M"
pub fn display_accelerator(acc: &str) -> String {
    acc.split('+').map(|p| match p {
        "Control" => "Ctrl",
        "Super" => "Win",
        _ => p,
    }).collect::<Vec<_>>().join("+")
}

/// normalizeShortcuts: 없거나 잘못된 것은 기본값으로, 겹치면 매직키 · 목록을 기본값으로 — SHORTCUTS 차례
pub fn normalize_shortcuts(value: &Value) -> [String; 3] {
    let mut out = SHORTCUTS.map(|(name, def, _)| if is_valid_accelerator(&value[name]) { value[name].as_str().unwrap().to_string() } else { def.to_string() });
    if out[0] == out[1] {
        out[1] = (if out[0] == SHORTCUTS[1].1 { SHORTCUTS[0].1 } else { SHORTCUTS[1].1 }).to_string();
    }
    if out[2] == out[0] || out[2] == out[1] {
        out[2] = SHORTCUTS[2].1.to_string();
    }
    out
}

/// withShortcuts: 안내 글의 기본 단축키 표기를 지금 쓰는 키로 (한 번에 — 바꾼 글이 다시 바뀌지 않게)
pub fn with_shortcuts(text: &str, shortcuts: &Value) -> String {
    let now = normalize_shortcuts(shortcuts);
    let map: Vec<(String, String)> = SHORTCUTS.iter().zip(&now).map(|((_, def, _), s)| (display_accelerator(def), display_accelerator(s))).collect();
    let mut out = String::new();
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        match map.iter().find(|(from, _)| rest.starts_with(from.as_str())) {
            Some((from, to)) => {
                out.push_str(to);
                rest = &rest[from.len()..];
            }
            None => {
                out.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    out
}

/// keymap.js comboFromAccelerator: "Control+Shift+P" → "ctrl+shift+KeyP" (Win 키가 든 것은 메모 창 키가 아니라 None)
pub fn combo_from_accelerator(acc: &str) -> Option<String> {
    let mut parts: Vec<&str> = acc.split('+').collect();
    let key = parts.pop().filter(|k| !k.is_empty())?;
    if parts.contains(&"Super") {
        return None;
    }
    let b = key.as_bytes();
    let code = match key {
        _ if b.len() == 1 && b[0].is_ascii_uppercase() => format!("Key{key}"),
        _ if b.len() == 1 && b[0].is_ascii_digit() => format!("Digit{key}"),
        "Up" | "Down" | "Left" | "Right" => format!("Arrow{key}"),
        _ => match PUNCT.iter().position(|p| *p == key) {
            Some(i) => ["Minus", "Equal", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backslash", "Backquote"][i].to_string(),
            None => key.to_string(),
        },
    };
    let has = |m| parts.contains(&m);
    Some(format!("{}{}{}{code}", if has("Control") { "ctrl+" } else { "" }, if has("Shift") { "shift+" } else { "" }, if has("Alt") { "alt+" } else { "" }))
}

// ---------- 메모 단축키 (Ctrl+Alt+1~9) ----------

pub const HOTKEY_SLOTS: [&str; 9] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

pub fn hotkey_accelerator(slot: &str) -> String {
    format!("Control+Alt+{slot}")
}

pub fn hotkey_label(slot: &str) -> String {
    format!("Ctrl+Alt+{slot}")
}

/// normalizeHotkeys: 설정 값 → 깨끗한 { 칸: { id, copy, show } } (둘 다 끈 칸 · 잘못된 칸은 버림, 칸 차례로)
pub fn normalize_hotkeys(raw: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for slot in HOTKEY_SLOTS {
        let v = &raw[slot];
        let Some(id) = v["id"].as_str().filter(|id| !id.is_empty()) else { continue };
        let (copy, show) = (v["copy"] != false, v["show"] == true);
        if copy || show {
            out.insert(slot.into(), json!({ "id": id, "copy": copy, "show": show }));
        }
    }
    out
}

/// 그 메모가 쓰는 칸
pub fn slot_of(hotkeys: &Map<String, Value>, id: &str) -> Option<String> {
    hotkeys.iter().find(|(_, b)| b["id"] == id).map(|(slot, _)| slot.clone())
}

/// assignHotkey: 메모에 칸을 정한다 (그 메모의 예전 칸은 비우고, 그 칸의 다른 메모는 빠진다). slot 이 None 이면 풀기
pub fn assign_hotkey(hotkeys: &Value, id: &str, slot: Option<&str>, copy: bool, show: bool) -> Result<Map<String, Value>, String> {
    let mut next = normalize_hotkeys(hotkeys);
    next.retain(|_, b| b["id"] != id);
    let Some(slot) = slot else { return Ok(next) };
    if !HOTKEY_SLOTS.contains(&slot) {
        return Err("1~9 중에서 골라 주세요".into());
    }
    if !copy && !show {
        return Err("복사하기와 띄우기 중 하나는 골라 주세요".into());
    }
    next.insert(slot.into(), json!({ "id": id, "copy": copy, "show": show }));
    Ok(normalize_hotkeys(&Value::Object(next)))
}
