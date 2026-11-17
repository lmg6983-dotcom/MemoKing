//! 메모 파일(.md) 형식 — 머리말(YAML) + 마크다운 본문. app/js/core/memo-file.js 의 읽기 · 쓰기
use crate::{js, reminders, tables, time, yaml};
use fancy_regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::sync::LazyLock;

pub const COLORS: [&str; 7] = ["yellow", "green", "pink", "purple", "blue", "gray", "charcoal"];
pub const DEFAULT_COLOR: &str = "yellow";
pub const DEVICES: [&str; 3] = ["pc", "phone", "ai"];
const KNOWN_KEYS: [&str; 12] = ["id", "created", "updated", "color", "pinned", "links", "reminders", "tables", "ink", "device", "day", "mode"];
pub static FRONTMATTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)").unwrap());

/// 머리말 (JS 의 normalizeMeta 결과와 같은 모양 · 같은 순서)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Meta {
    pub id: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub color: String,
    pub pinned: bool,
    pub links: Vec<String>,
    pub reminders: Vec<Value>,
    pub tables: Vec<Value>,
    pub ink: String,
    pub device: Option<String>,
    pub day: String,
    pub mode: String,
    /// 앱이 모르는 머리말 항목 — 그대로 다시 쓴다
    pub extra: Map<String, Value>,
}

/// 머리말이 깨져 있으면 파일 전체를 본문으로 (사용자 내용을 잃지 않게)
pub fn parse_memo_file(text: &str) -> (Meta, String) {
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut data = Map::new();
    let mut body = source;
    if let Ok(Some(m)) = FRONTMATTER.captures(source) {
        match yaml::parse(&m[1]) {
            // 머리말(키: 값)일 때만 떼어 낸다 — "---" 구분선으로 시작하는 글이 사라지지 않게
            Ok(Value::Null) => body = &source[m[0].len()..],
            Ok(Value::Object(o)) => {
                data = o;
                body = &source[m[0].len()..];
            }
            _ => {}
        }
    }
    (normalize_meta(&data), body.to_string())
}

pub fn normalize_meta(data: &Map<String, Value>) -> Meta {
    let get = |k: &str| data.get(k).unwrap_or(&Value::Null);
    let iso = |k: &str| get(k).as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let mut links: Vec<String> = vec![];
    for l in get("links").as_array().into_iter().flatten().filter_map(Value::as_str) {
        if !l.is_empty() && !links.iter().any(|x| x == l) {
            links.push(l.to_string());
        }
    }
    let now = time::now_iso();
    Meta {
        id: get("id").as_str().map(|s| s.trim_matches(js::is_space)).filter(|s| !s.is_empty()).map(str::to_string),
        created: iso("created"),
        updated: iso("updated"),
        color: get("color").as_str().filter(|c| COLORS.contains(c)).unwrap_or(DEFAULT_COLOR).to_string(),
        pinned: get("pinned") == &Value::Bool(true),
        links,
        reminders: get("reminders").as_array().into_iter().flatten().filter_map(|r| reminders::normalize_reminder(r, &now)).collect(),
        tables: tables::normalize_tables(get("tables")),
        ink: normalize_ink_path(get("ink")),
        device: get("device").as_str().filter(|d| DEVICES.contains(d)).map(str::to_string),
        day: normalize_day(get("day")),
        mode: normalize_mode(get("mode")).to_string(),
        extra: data.iter().filter(|(k, _)| !KNOWN_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect(),
    }
}

/// Work / Life — 'work' 가 아니면 모두 Life
pub fn normalize_mode(v: &Value) -> &'static str {
    let s = if v.is_null() { String::new() } else { js::string(v) };
    if s.trim_matches(js::is_space).to_lowercase() == "work" { "work" } else { "life" }
}

/// 회상 달력의 날 (YYYY-MM-DD) — 있는 날짜일 때만, 아니면 ""
pub fn normalize_day(v: &Value) -> String {
    let s = v.as_str().map(|s| s.trim_matches(js::is_space)).unwrap_or("");
    let ok = s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-';
    if ok { s.to_string() } else { String::new() }
}

/// 주석 파일은 메모 폴더의 attachments/ 안의 것만 (../ 로 밖을 가리키지 않게)
pub fn normalize_ink_path(v: &Value) -> String {
    let s = v.as_str().map(|s| s.trim_matches(js::is_space)).unwrap_or("");
    let ok = s.strip_prefix("attachments/").is_some_and(|name| !name.is_empty() && !name.contains(['/', '\\'])) && !s.contains("..");
    if ok { s.to_string() } else { String::new() }
}

/// 앱이 모르는 머리말 항목(extra)도 그대로 다시 쓴다
pub fn serialize_memo_file(meta: &Meta, body: &str) -> String {
    let mut data = Map::new();
    let opt = |v: &Option<String>| v.clone().map_or(Value::Null, Value::String);
    data.insert("id".into(), opt(&meta.id));
    data.insert("created".into(), opt(&meta.created));
    data.insert("updated".into(), opt(&meta.updated));
    data.insert("color".into(), meta.color.clone().into());
    if meta.pinned {
        data.insert("pinned".into(), true.into());
    }
    if !meta.links.is_empty() {
        data.insert("links".into(), meta.links.clone().into());
    }
    if !meta.reminders.is_empty() {
        data.insert("reminders".into(), meta.reminders.iter().map(reminders::serialize_reminder).collect());
    }
    let t = tables::normalize_tables(&Value::Array(meta.tables.clone()));
    if !t.is_empty() {
        data.insert("tables".into(), t.into());
    }
    let ink = normalize_ink_path(&Value::String(meta.ink.clone()));
    if !ink.is_empty() {
        data.insert("ink".into(), ink.into());
    }
    if let Some(d) = meta.device.as_deref().filter(|d| DEVICES.contains(d)) {
        data.insert("device".into(), d.into());
    }
    let day = normalize_day(&Value::String(meta.day.clone()));
    if !day.is_empty() {
        data.insert("day".into(), day.into());
    }
    if normalize_mode(&Value::String(meta.mode.clone())) == "work" {
        data.insert("mode".into(), "work".into()); // Life 는 적지 않는다 (예전 파일과 같게)
    }
    for (k, v) in &meta.extra {
        data.insert(k.clone(), v.clone());
    }
    let yaml = yaml::stringify(&Value::Object(data));
    let text = body.replace("\r\n", "\n");
    format!("---\n{}\n---\n{}\n", js::trim_end(&yaml), js::trim_end(&text))
}

// ---------- 파일 이름 · 충돌 사본 ----------

/// 윈도우 · 안드로이드 · Google Drive 모두에서 안전한 파일 이름 (확장자 빼고) — titleToFileName
pub fn title_to_file_name(title: &str) -> String {
    use crate::js::re;
    static BAD: LazyLock<Regex> = LazyLock::new(|| re(r#"[<>:"/\\|?*#^\[\]\x00-\x1f]"#));
    static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
    static EDGE: LazyLock<Regex> = LazyLock::new(|| re(r"^[.\s]+|[.\s]+$"));
    static OFFICE: LazyLock<Regex> = LazyLock::new(|| re(r"^(~\$\s*)+"));
    static RESERVED: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(con|prn|aux|nul|com\d|lpt\d)$"));
    static DEVICE: LazyLock<Regex> = LazyLock::new(|| re(r"^([^.]*?)(\s*)(?=\.|$)"));
    let s = BAD.replace_all(title, " ");
    let s = SPACES.replace_all(&s, " ");
    let s = EDGE.replace_all(js::trim(&s), "");
    let s = OFFICE.replace(&s, "");
    let mut name = js::trim(&js::slice16(&s, 60)).to_string();
    if name.is_empty() {
        name = crate::body::UNTITLED.into();
    }
    // 윈도우는 점 뒤가 있어도(con.txt) 장치 이름으로 본다
    if RESERVED.is_match(js::trim(name.split('.').next().unwrap_or(""))).unwrap_or(false) {
        name = DEVICE.replace(&name, "${1}_${2}").into_owned();
    }
    name
}

/// "다른 기기 10월 5일 08:34"
pub fn conflict_label(now: chrono::DateTime<chrono::Local>) -> String {
    use chrono::{Datelike, Timelike};
    format!("다른 기기 {}월 {}일 {:02}:{:02}", now.month(), now.day(), now.hour(), now.minute())
}

/// 다른 기기에서 들어온 글의 사본 본문 — 제목 줄에 "(label)"
pub fn conflict_copy_body(body: &str, label: &str) -> String {
    use crate::js::re;
    static HEADING: LazyLock<Regex> = LazyLock::new(|| re(r"^\s{0,3}#{1,6}\s+\S"));
    let text = body.replace("\r\n", "\n");
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    let i = lines.iter().position(|l| !js::trim(l).is_empty());
    match i {
        Some(i) if HEADING.is_match(&lines[i]).unwrap_or(false) => lines[i] = format!("{} ({label})", js::trim_end(&lines[i])),
        _ => {
            let at = i.unwrap_or(0);
            lines.splice(at..at, [format!("# {} ({label})", crate::body::extract_title(&text)), String::new()]);
        }
    }
    lines.join("\n")
}

/// 폴더 이름 → 파일 이름으로 쓸 수 있는 이름, 못 쓰면 "" (folders.js cleanFolderName)
pub fn clean_folder_name(raw: &str) -> String {
    use crate::js::re;
    static BAD: LazyLock<Regex> = LazyLock::new(|| re(r#"[\\/:*?"<>|\x00-\x1f]"#));
    static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
    static TAIL: LazyLock<Regex> = LazyLock::new(|| re(r"[.\s]+$"));
    static DEVICE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(con|prn|aux|nul|com\d|lpt\d)$"));
    let s = SPACES.replace_all(&BAD.replace_all(raw, " "), " ").into_owned();
    let name = TAIL.replace(&js::slice16(js::trim(&s), 40), "").into_owned();
    let lower = name.to_lowercase();
    if name.is_empty() || name.starts_with('.') || name.starts_with("~$") || lower == "_memoking" || lower == "attachments" || DEVICE.is_match(&name).unwrap_or(false) {
        return String::new();
    }
    name
}

/// 메모 파일 경로 → 그 메모의 폴더 ("" = 폴더 없음)
pub fn folder_of(file: &str) -> &str {
    match file.find('/') {
        Some(i) if i > 0 => &file[..i],
        _ => "",
    }
}
