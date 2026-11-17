//! 일정 · 알림 머리말 — app/js/core/reminders.js 의 normalizeReminder · serializeReminder
//!   와 울릴 때 계산 (nextOccurrence · nextAlert · dueOccurrence · markFired · isLive …) — 데스크톱 알림 실행기 · 목록 숫자가 쓰는 것
use crate::{js, time};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};

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

/// "7:5" → (7, 5), 못 읽으면 09:00
fn parse_time(v: &Value) -> (u32, u32) {
    let s = if v.is_null() { String::new() } else { js::string(v) };
    let t = s.trim_matches(js::is_space);
    t.split_once(':')
        .filter(|(h, m)| (1..=2).contains(&h.len()) && (1..=2).contains(&m.len()) && h.chars().chain(m.chars()).all(|c| c.is_ascii_digit()))
        .map_or((9, 0), |(h, m)| (h.parse::<u32>().unwrap().min(23), m.parse::<u32>().unwrap().min(59)))
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
            let (h, m) = parse_time(sget("time"));
            repeat.insert("time".into(), format!("{h:02}:{m:02}").into());
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
    format!("r{}", &uuid::Uuid::new_v4().simple().to_string()[..6])
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

// ---------- 울릴 때 계산 (reminders.js 와 같은 규칙) ----------

const MISSED_AFTER_MS: i64 = 2 * 60 * 1000; // 이보다 늦게 울리면 "놓친 알림"

type Time = DateTime<Local>;

fn date_of(v: &Value) -> Option<Time> {
    valid_date(v).map(|t| t.with_timezone(&Local))
}

fn epoch() -> Time {
    Local.timestamp_millis_opt(0).unwrap()
}

/// 미리 알림 한 번 — 울릴 때(at), 일정 시작(start), 몇 분 전(offset), 같은 때에 함께 울릴 다른 회차의 (시작, 몇 분 전)
#[derive(Debug, Clone, PartialEq)]
pub struct Alert {
    pub at: Time,
    pub start: Time,
    pub offset: i64,
    pub also: Vec<(Time, i64)>,
}

/// 일정 (시각 · 하루 종일) — 할 일 알림 · 타이머 · 켤 때 알림이 아닌 것
pub fn is_event(r: &Value) -> bool {
    matches!(r["kind"].as_str(), Some("at" | "repeat")) && r["task"] != true
}

/// 지난 알림 대신 울릴 때: 시각 있는 일정은 정시, 하루 종일은 당일 오전 9시
pub fn fallback_alert(all_day: bool) -> i64 {
    if all_day {
        -540
    } else {
        0
    }
}

/// 미리 알림 (분 전) — 먼저 울리는 것부터. 없으면 정시(하루 종일은 당일 오전 9시) 한 번, [] 는 "알림 없음"
pub fn alerts_of(r: &Value) -> Vec<i64> {
    if !is_event(r) {
        return vec![0];
    }
    let mut list = r["alerts"].as_array().map_or_else(|| vec![fallback_alert(r["allDay"] == true)], |a| a.iter().filter_map(Value::as_i64).collect());
    list.sort_unstable_by(|a, b| b.cmp(a));
    list.dedup();
    list
}

/// 미리 알림이 울릴 때 — 하루 종일은 벽시계 기준(서머타임이 바뀌는 날에도 오전 9시), 시각 있는 일정은 시작에서 그만큼 앞
pub fn alert_time(start: Time, offset: i64, all_day: bool) -> Time {
    if all_day {
        time::js_local(start.year().into(), start.month0().into(), start.day().into(), 0, -offset)
    } else {
        start - Duration::minutes(offset)
    }
}

/// 격주 · N주마다 일정에서 그날이 울리는 주인가 (기준 날이 든 주에서 interval 주째마다)
fn on_week(repeat: &Value, day: Time) -> bool {
    let Some(interval) = repeat["interval"].as_i64().filter(|i| *i != 0) else { return true };
    let Some(from) = repeat["from"].as_str().and_then(|f| time::parse_js_date(&format!("{f}T00:00"))) else { return false };
    let sunday = |d: NaiveDate| d - Duration::days(d.weekday().num_days_from_sunday().into());
    let weeks = (sunday(day.date_naive()) - sunday(from.with_timezone(&Local).date_naive())).num_days() / 7;
    weeks % interval == 0
}

/// after 보다 뒤의 첫 회차 (없으면 None). 켤 때 알림은 시각이 없다.
pub fn next_occurrence(r: &Value, after: Time) -> Option<Time> {
    match r["kind"].as_str() {
        Some("timer" | "at") => return date_of(&r["at"]).filter(|t| *t > after),
        Some("repeat") => {}
        _ => return None,
    }
    let rep = &r["repeat"];
    let (h, min) = parse_time(&rep["time"]);
    let (h, min) = (i64::from(h), i64::from(min));
    let (y, m, d) = (i64::from(after.year()), i64::from(after.month0()), i64::from(after.day()));
    // 날짜 넘김은 js_local 이 한다 (9/30 + 1 = 10/1)
    let on_day = |i: i64| time::js_local(y, m, d + i, h, min);
    // 없는 날(2월 31일)은 그달 마지막 날
    let day = js::number(&rep["day"]) as i64;
    let clamped = |y: i64, m: i64| time::js_local(y, m, day.min(time::js_local(y, m + 1, 0, 0, 0).day().into()), h, min);
    let after_it = |c: &Time| *c > after;
    match rep["every"].as_str() {
        Some("day") => (0..=1).map(on_day).find(after_it),
        Some("week") => {
            let weekdays: Vec<u64> = rep["weekdays"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
            (0..=7 * rep["interval"].as_i64().unwrap_or(1))
                .map(on_day)
                .find(|c| weekdays.contains(&u64::from(c.weekday().num_days_from_sunday())) && after_it(c) && on_week(rep, *c))
        }
        Some("month") => (0..=12).map(|i| clamped(y, m + i)).find(after_it),
        Some("year") => (0..=4).map(|i| clamped(y + i, js::number(&rep["month"]) as i64 - 1)).find(after_it),
        _ => None,
    }
}

fn consider(best: &mut Option<Alert>, start: Time, offs: &[i64], all_day: bool, after: Time) {
    for &offset in offs {
        let at = alert_time(start, offset, all_day);
        if at <= after {
            continue;
        }
        match best {
            Some(b) if at > b.at => {}
            Some(b) if at == b.at => {
                if start == b.start && offset == b.offset {
                    continue;
                }
                // 같은 때에 울릴 다른 회차 (매일 9시 일정의 "정시" 와 다음 날 일정의 "하루 전") — 하나로 울리되 둘 다 알린다
                let (mut s, mut o) = (start, offset);
                if o < b.offset {
                    std::mem::swap(&mut s, &mut b.start);
                    std::mem::swap(&mut o, &mut b.offset);
                }
                b.also.push((s, o));
            }
            _ => *best = Some(Alert { at, start, offset, also: Vec::new() }),
        }
    }
}

/// after 보다 뒤의 첫 알림 (미리 알림 포함). 반복 일정은 앞뒤 회차의 미리 알림이 섞일 수 있어 가장 이른 것을 고른다
pub fn next_alert(r: &Value, after: Time) -> Option<Alert> {
    let offs = alerts_of(r);
    let (&max_off, &min_off) = (offs.first()?, offs.last()?); // 비었으면 알림 없음
    let all_day = r["allDay"] == true;
    let mut best = None;
    match r["kind"].as_str() {
        Some("timer" | "at") => {
            if let Some(start) = date_of(&r["at"]) {
                consider(&mut best, start, &offs, all_day, after);
            }
            return best;
        }
        Some("repeat") => {}
        _ => return None,
    }
    let mut from = after + Duration::minutes(min_off.min(0)) - Duration::minutes(max_off.max(0)) - Duration::milliseconds(1);
    for _ in 0..400 {
        let Some(start) = next_occurrence(r, from) else { break };
        if best.as_ref().is_some_and(|b: &Alert| start - Duration::minutes(max_off) > b.at) {
            break;
        }
        consider(&mut best, start, &offs, all_day, after);
        from = start;
    }
    best
}

/// 지금 울려야 하는가 → (알림, 놓쳤나). 놓친 알림이 여러 번이어도 한 번만 (울린 뒤 last = 지금)
///   만들기 전 시각의 미리 알림은 울리지 않는다 (내일 아침 일정에 오늘 저녁 "하루 전" 을 걸면 이미 지남)
pub fn due_occurrence(r: &Value, now: Time) -> Option<(Alert, bool)> {
    let kind = r["kind"].as_str().unwrap_or_default();
    if r["enabled"] != true || kind == "startup" {
        return None;
    }
    let created = date_of(&r["created"]).unwrap_or_else(epoch);
    let last = date_of(&r["last"]);
    let has_alerts = r["alerts"].is_array();
    // 예전(미리 알림이 없던 때) 한 번짜리는 울렸으면 끝
    if (kind == "timer" || (kind == "at" && !has_alerts)) && last.is_some() {
        return None;
    }
    // 반복은 만든 때(또는 마지막으로 울린 때)부터, 한 번짜리는 처음부터 (지난 정시 알림은 "놓친 알림")
    let mut next = next_alert(r, last.unwrap_or_else(|| if kind == "repeat" { created } else { epoch() }));
    let skip_before = |n: &Alert| n.at < created - Duration::milliseconds(if n.offset > 0 { 0 } else { MISSED_AFTER_MS });
    // 하루 종일 일정은 미리 알림이 생긴 뒤의 것이라 alerts 가 없어도 같은 규칙. 예전 알림은 그대로 "놓친 알림" 으로
    let fresh = has_alerts || r["allDay"] == true;
    for _ in 0..50 {
        let Some(at) = next.as_ref().filter(|n| (n.offset > 0 || fresh) && skip_before(n)).map(|n| n.at) else { break };
        next = next_alert(r, at);
    }
    let next = next.filter(|n| n.at <= now)?;
    let missed = (now - next.at).num_milliseconds() > MISSED_AFTER_MS;
    Some((next, missed))
}

/// 앱을 시작할 때 울려야 하는가 (켤 때 알림)
pub fn due_at_startup(r: &Value, now: Time) -> bool {
    if r["enabled"] != true || r["kind"] != "startup" {
        return false;
    }
    let day = |t: Time| time::local_day(t.fixed_offset()).0;
    r["startup"] != "daily" || date_of(&r["last"]).is_none_or(|l| day(l) != day(now))
}

/// 울린 뒤 상태: 한 번짜리는 남은 미리 알림이 없으면 꺼져서 "완료" 로 남는다
///   (한 번짜리 일정은 미리 알림을 다 보냈어도 일정이 지나기 전에는 끄지 않는다 — 꺼진 것처럼 보이지 않게)
pub fn mark_fired(r: &Value, now: Time) -> Value {
    let kind = r["kind"].as_str().unwrap_or_default();
    let event_over = !r["alerts"].is_array() || is_past_event(r, now);
    let once = kind == "timer" || (kind == "at" && next_alert(r, now).is_none() && event_over) || (kind == "startup" && r["startup"] == "once");
    let mut out = r.clone();
    out["last"] = time::to_local_iso(now).into();
    if once {
        out["enabled"] = false.into();
    }
    out
}

/// 일정 한 회차가 끝나는 때: 하루 종일이면 마지막 날의 끝(다음 날 0시), 아니면 끝 시각(없으면 시작)
fn occurrence_end(start: Time, all_day: bool, end: Option<Time>) -> Time {
    let last = end.filter(|e| *e > start).unwrap_or(start);
    if all_day {
        time::js_local(last.year().into(), last.month0().into(), i64::from(last.day()) + 1, 0, 0)
    } else {
        last
    }
}

/// 한 번짜리 일정이 이미 지났는가
pub fn is_past_event(r: &Value, now: Time) -> bool {
    r["kind"] == "at" && date_of(&r["at"]).is_some_and(|t| occurrence_end(t, r["allDay"] == true, date_of(&r["end"])) <= now)
}

/// 다음에 울릴 때 (울릴 때가 됐으면 그 시각). 켤 때 알림 · 꺼진 알림은 None
pub fn next_time(r: &Value, now: Time) -> Option<Time> {
    if r["enabled"] != true || r["kind"] == "startup" {
        return None;
    }
    due_occurrence(r, now).map(|(a, _)| a.at).or_else(|| next_alert(r, now).map(|a| a.at))
}

/// 살아 있는 알림 (종 버튼 · 일정 탭 숫자): 켜져 있고 앞으로 울릴 것이 있거나, 켤 때 알림. 알림 없는 일정은 세지 않는다
pub fn is_live(r: &Value, now: Time) -> bool {
    r["enabled"] == true && (r["kind"] == "startup" || next_time(r, now).is_some())
}

/// is_live 를 1분 기억 — 반복 일정 계산이 무거워 목록을 다시 그릴 때마다 하지 않게.
///   JS 는 객체마다 기억하지만 여기는 내용마다 (같은 내용이면 같은 답)
pub fn is_live_cached(r: &Value, now: Time) -> bool {
    static CACHE: LazyLock<Mutex<HashMap<String, (Time, bool)>>> = LazyLock::new(Mutex::default);
    let fresh = |t: &Time| (now - *t).num_milliseconds().abs() < 60_000;
    let key = r.to_string();
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((_, v)) = cache.get(&key).filter(|(t, _)| fresh(t)) {
        return *v;
    }
    let v = is_live(r, now);
    cache.retain(|_, (t, _)| fresh(t)); // 지난 것은 버려 쌓이지 않게
    cache.insert(key, (now, v));
    v
}

// ---------- 알림 문구 (describeReminder · alarmText — PC · 휴대폰 같은 말) ----------

const WEEKDAY: [&str; 7] = ["일", "월", "화", "수", "목", "금", "토"];

fn hhmm(t: Time) -> String {
    t.format("%H:%M").to_string()
}

/// 날 이름 (time.js dayLabel): 어제 · 오늘 · 내일 · 모레 · 10월 12일 (월) · 2027년 1월 2일 (토)
fn day_label(t: Time, now: Time) -> String {
    match (t.date_naive() - now.date_naive()).num_days() {
        -1 => "어제".into(),
        0 => "오늘".into(),
        1 => "내일".into(),
        2 => "모레".into(),
        _ => {
            let year = if t.year() == now.year() { String::new() } else { format!("{}년 ", t.year()) };
            format!("{year}{}월 {}일 ({})", t.month(), t.day(), WEEKDAY[t.weekday().num_days_from_sunday() as usize])
        }
    }
}

/// 오늘 14:00 · 10월 3일 (금) 09:00
fn format_when(t: Time, now: Time) -> String {
    format!("{} {}", day_label(t, now), hhmm(t))
}

/// 알림 한 줄 설명: "10분 타이머" · "내일 15:00~16:00" · "격주 월, 수 09:00" · "메모킹을 켤 때마다"
pub fn describe_reminder(r: &Value, now: Time) -> String {
    let n = |v: &Value| js::string(&js::num(js::number(v)));
    match r["kind"].as_str() {
        Some("timer") => {
            let m = js::number(&r["minutes"]);
            if m >= 60.0 && m % 60.0 == 0.0 {
                format!("{}시간 타이머", js::string(&js::num(m / 60.0)))
            } else {
                format!("{}분 타이머", n(&r["minutes"]))
            }
        }
        Some("at") => {
            let Some(at) = date_of(&r["at"]) else { return String::new() };
            let end = date_of(&r["end"]).filter(|e| *e > at);
            match (r["allDay"] == true, end) {
                (true, Some(e)) => format!("{} ~ {} 하루 종일", day_label(at, now), day_label(e, now)),
                (true, None) => format!("{} 하루 종일", day_label(at, now)),
                (false, Some(e)) if at.date_naive() == e.date_naive() => format!("{}~{}", format_when(at, now), hhmm(e)),
                (false, Some(e)) => format!("{} ~ {}", format_when(at, now), format_when(e, now)),
                (false, None) => format_when(at, now),
            }
        }
        Some("repeat") => {
            let rep = &r["repeat"];
            let time = if r["allDay"] == true { "하루 종일".to_string() } else { js::string(&rep["time"]) };
            let days: Vec<&str> = rep["weekdays"].as_array().into_iter().flatten().filter_map(|d| WEEKDAY.get(d.as_u64()? as usize).copied()).collect();
            match rep["every"].as_str() {
                Some("day") => format!("매일 {time}"),
                Some("week") if days.len() == 7 => format!("매일 {time}"), // "매주 매일" 이 아니라
                Some("week") => {
                    let i = js::number(&rep["interval"]);
                    let every = if i == 2.0 { "격주".to_string() } else if i > 2.0 { format!("{}주마다", n(&rep["interval"])) } else { "매주".into() };
                    format!("{every} {} {time}", days.join(", "))
                }
                Some("month") => format!("매월 {}일 {time}", n(&rep["day"])),
                _ => format!("매년 {}월 {}일 {time}", n(&rep["month"]), n(&rep["day"])),
            }
        }
        _ => match r["startup"].as_str() {
            Some("every") => "메모킹을 켤 때마다",
            Some("daily") => "하루에 한 번, 처음 켤 때",
            Some("once") => "다음에 켤 때 한 번만",
            _ => "",
        }
        .into(),
    }
}

/// 울릴 때 알림 글 → (제목, 때, 메모 띠 · 보관함에 쓰는 한 줄). due: 울린 회차와 놓쳤나 — None 이면 켤 때 알림
///   일정이면 "내일 15:00 (30분 뒤)", 그 밖은 "알림, 10분 타이머"
pub fn alarm_text(r: &Value, memo_title: &str, due: Option<&(Alert, bool)>, now: Time) -> (String, String, String) {
    let title = r["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(memo_title).to_string();
    let all_day = r["allDay"] == true;
    let when = |t: Time| if all_day { format!("{} 하루 종일", day_label(t, now)) } else { format_when(t, now) };
    let label = match due {
        None => format!("켤 때 알림, {}", describe_reminder(r, now)),
        Some((_, missed)) if !is_event(r) => format!("{}, {}", if *missed { "놓친 알림" } else { "알림" }, describe_reminder(r, now)),
        Some((a, missed)) => {
            // 같은 때에 함께 울린 다른 회차의 미리 알림 ("…, 다음 일정 내일 09:00")
            let more: Vec<String> = a.also.iter().map(|(s, _)| when(*s)).collect();
            let tail = if more.is_empty() { String::new() } else { format!(", 다음 일정 {}", more.join(", ")) };
            let mins = js::round((a.start - now).num_milliseconds() as f64 / 60_000.0) as i64;
            let soon = match mins {
                ..=0 => "지금 시작".to_string(),
                1..60 => format!("{mins}분 뒤"),
                60..1440 if mins % 60 != 0 => format!("{}시간 {}분 뒤", mins / 60, mins % 60),
                60..1440 => format!("{}시간 뒤", mins / 60),
                _ => String::new(),
            };
            if *missed {
                format!("놓친 알림, {}{tail}", when(a.start))
            } else if all_day || soon.is_empty() {
                format!("{}{tail}", when(a.start))
            } else {
                format!("{} ({soon}){tail}", when(a.start))
            }
        }
    };
    let full = if title == memo_title { label.clone() } else { format!("{title}, {label}") };
    (title, label, full)
}
