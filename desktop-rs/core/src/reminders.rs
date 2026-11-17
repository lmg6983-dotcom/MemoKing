//! 일정 · 알림 머리말 — app/js/core/reminders.js 의 normalizeReminder · serializeReminder
//!   (울릴 때 계산 nextOccurrence 등은 알림을 옮길 때 — 2단계)
use crate::{js, time};
use serde_json::{json, Map, Value};

const KINDS: [&str; 4] = ["timer", "at", "repeat", "startup"];
const EVERY: [&str; 4] = ["day", "week", "month", "year"];
const STARTUP: [&str; 3] = ["every", "daily", "once"];
const ACTIONS: [&str; 2] = ["open", "notify"];
const MAX_ALERTS: usize = 5;
const MAX_ALERT_MIN: f64 = 60.0 * 24.0 * 28.0;
const MAX_WEEKS: f64 = 12.0;

fn valid_date(v: &Value) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    match v {
        Value::Null => None,
        // shortcut: 숫자 · 객체를 날짜로 읽는 JS 의 옛 규칙은 따르지 않는다 (메모킹은 늘 ISO 글자를 쓴다)
        Value::String(s) => time::parse_js_date(s),
        _ => None,
    }
}

/// "7:5" → "07:05", 못 읽으면 09:00
fn parse_time(v: &Value) -> String {
    let s = if v.is_null() { String::new() } else { js::string(v) };
    let t = s.trim_matches(js::is_space);
    let (h, m) = t
        .split_once(':')
        .filter(|(h, m)| (1..=2).contains(&h.len()) && (1..=2).contains(&m.len()) && h.chars().chain(m.chars()).all(|c| c.is_ascii_digit()))
        .map_or((9, 0), |(h, m)| (h.parse::<u32>().unwrap().min(23), m.parse::<u32>().unwrap().min(59)));
    format!("{h:02}:{m:02}")
}

fn valid_alert(v: f64, all_day: bool) -> bool {
    v.fract() == 0.0 && v >= if all_day { -1439.0 } else { 0.0 } && v <= MAX_ALERT_MIN
}

fn normalize_alerts(raw: &Value, all_day: bool) -> Option<Value> {
    let mut list: Vec<f64> = Vec::new();
    for v in raw.as_array()? {
        let n = js::round(js::number(v));
        if valid_alert(n, all_day) && !list.contains(&n) {
            list.push(n);
        }
    }
    list.sort_by(|a, b| b.total_cmp(a));
    list.truncate(MAX_ALERTS);
    Some(Value::Array(list.into_iter().map(js::num).collect()))
}

fn pick<'a>(v: &Value, allowed: &[&'a str], default: &'a str) -> &'a str {
    v.as_str().and_then(|s| allowed.iter().find(|a| **a == s).copied()).unwrap_or(default)
}

/// 머리말의 일정 · 알림 하나 → 쓸 수 있는 모양 (못 쓰면 None)
pub fn normalize_reminder(raw: &Value, now_iso: &str) -> Option<Value> {
    let raw = raw.as_object()?;
    let get = |k: &str| raw.get(k).unwrap_or(&Value::Null);
    let kind = get("kind").as_str().filter(|k| KINDS.contains(k))?;
    let mut r = Map::new();
    let id = get("id").as_str().filter(|s| !s.is_empty()).map_or_else(random_id, str::to_string);
    r.insert("id".into(), id.into());
    r.insert("kind".into(), kind.into());
    r.insert("action".into(), pick(get("action"), &ACTIONS, "notify").into());
    r.insert("enabled".into(), (get("enabled") != &Value::Bool(false)).into());
    let created = valid_date(get("created")).map_or_else(|| now_iso.to_string(), |_| js::string(get("created")));
    r.insert("created".into(), created.clone().into());
    r.insert("last".into(), valid_date(get("last")).map_or(Value::Null, |_| js::string(get("last")).into()));
    let task = get("task") == &Value::Bool(true) && (kind == "at" || kind == "repeat");
    if task {
        r.insert("task".into(), true.into());
        if get("done") == &Value::Bool(true) {
            r.insert("done".into(), true.into());
        }
    }
    if let Some(title) = get("title").as_str() {
        let one: String = title.split(js::is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
        // JS 는 /\s+/g → ' ' 뒤 trim 이라 앞뒤만 다르다 — 낱말 사이 빈칸 묶음은 하나로 같다
        let title = js::slice16(&one, 80);
        if !title.is_empty() {
            r.insert("title".into(), title.into());
        }
    }
    let all_day = get("allDay") == &Value::Bool(true);
    let event = (kind == "at" || kind == "repeat") && !task;
    // 일정만 미리 알림 · 하루 종일 (할 일 알림은 없음)
    if event {
        if let Some(a) = normalize_alerts(get("alerts"), all_day) {
            r.insert("alerts".into(), a);
        }
        if all_day {
            r.insert("allDay".into(), true.into());
        }
    }
    match kind {
        "timer" | "at" => {
            let start = valid_date(get("at"))?;
            r.insert("at".into(), js::string(get("at")).into());
            if kind == "timer" {
                let m = js::round(js::number(get("minutes")));
                let m = if m.is_nan() { 0.0 } else { m };
                r.insert("minutes".into(), js::num(m.max(1.0)));
            } else if valid_date(get("end")).is_some_and(|e| e > start) {
                r.insert("end".into(), js::string(get("end")).into());
            }
        }
        "repeat" => {
            let src = get("repeat");
            let sget = |k: &str| src.get(k).unwrap_or(&Value::Null);
            let every = pick(sget("every"), &EVERY, "day");
            let mut repeat = Map::new();
            repeat.insert("every".into(), every.into());
            repeat.insert("time".into(), parse_time(sget("time")).into());
            let created_at = valid_date(&Value::String(created.clone()));
            if every == "week" {
                let mut days: Vec<i64> = sget("weekdays")
                    .as_array()
                    .map(|a| a.iter().map(js::number).filter(|d| d.fract() == 0.0 && (0.0..=6.0).contains(d)).map(|d| d as i64).collect())
                    .unwrap_or_default();
                if days.is_empty() {
                    days.push(created_at.map_or(0, |t| i64::from(time::local_day(t).1)));
                }
                days.sort_unstable();
                days.dedup();
                repeat.insert("weekdays".into(), json!(days));
                let interval = js::number(sget("interval"));
                if interval.fract() == 0.0 && (2.0..=MAX_WEEKS).contains(&interval) {
                    repeat.insert("interval".into(), js::num(interval));
                    let from = sget("from");
                    let from_s = if from.is_null() { String::new() } else { js::string(from) };
                    let ok = from_s.len() == 10
                        && from_s.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
                        && time::parse_js_date(&format!("{from_s}T00:00")).is_some();
                    let from = if ok { from_s } else { created_at.map(|t| time::local_day(t).0).unwrap_or_default() };
                    repeat.insert("from".into(), from.into());
                }
            }
            let clamp = |k: &str, max: f64| {
                let n = js::number(sget(k));
                js::num(if n.is_nan() || n == 0.0 { 1.0 } else { n }.clamp(1.0, max))
            };
            if every == "month" || every == "year" {
                repeat.insert("day".into(), clamp("day", 31.0));
            }
            if every == "year" {
                repeat.insert("month".into(), clamp("month", 12.0));
            }
            r.insert("repeat".into(), Value::Object(repeat));
        }
        _ => {
            r.insert("startup".into(), pick(get("startup"), &STARTUP, "every").into());
        }
    }
    Some(Value::Object(r))
}

fn random_id() -> String {
    format!("r{}", &uuid_hex()[..6])
}

fn uuid_hex() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    format!("{:016x}", h.finish())
}

/// 파일에 쓸 모양 (기본값은 생략해 짧게)
pub fn serialize_reminder(r: &Value) -> Value {
    let get = |k: &str| r.get(k).unwrap_or(&Value::Null);
    let truthy = |k: &str| match get(k) {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        _ => true,
    };
    let mut out = Map::new();
    out.insert("id".into(), get("id").clone());
    out.insert("kind".into(), get("kind").clone());
    for k in ["at", "end"] {
        if truthy(k) {
            out.insert(k.into(), get(k).clone());
        }
    }
    if get("kind") == "timer" {
        out.insert("minutes".into(), get("minutes").clone());
    }
    for k in ["repeat", "startup", "title"] {
        if truthy(k) {
            out.insert(k.into(), get(k).clone());
        }
    }
    for k in ["task", "done", "allDay"] {
        if truthy(k) {
            out.insert(k.into(), true.into());
        }
    }
    if get("alerts").is_array() {
        out.insert("alerts".into(), get("alerts").clone());
    }
    out.insert("action".into(), get("action").clone());
    if !truthy("enabled") {
        out.insert("enabled".into(), false.into());
    }
    out.insert("created".into(), get("created").clone());
    if truthy("last") {
        out.insert("last".into(), get("last").clone());
    }
    Value::Object(out)
}
