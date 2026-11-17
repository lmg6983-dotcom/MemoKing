//! 시각 — app/js/core/time.js 와 JS Date 에서 쓰는 만큼만.
use chrono::{DateTime, Duration, FixedOffset, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone};

/// 2026-09-29T17:30:12+09:00 (사람이 읽기 쉬운 현지 시각 + 시간대) — toLocalIso
pub fn to_local_iso(t: DateTime<Local>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

pub fn now_iso() -> String {
    to_local_iso(Local::now())
}

/// JS Date.now()
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// JS Date.parse 가 읽는 ISO 모양 → 시각 (못 읽으면 None)
///   날짜만(YYYY-MM-DD)은 UTC 자정, 시간대 없는 날짜+시각은 현지 시각 — JS 와 같다.
///   shortcut: ISO 가 아닌 모양(RFC 2822 등)은 None — 메모킹이 쓰는 값은 모두 ISO 라서. 다른 앱이 쓴 값이 보이면 넓힌다
pub fn parse_js_date(s: &str) -> Option<DateTime<FixedOffset>> {
    let s = s.trim();
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Some(t);
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc().fixed_offset());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M%:z", "%Y-%m-%dT%H:%M:%S%.fZ", "%Y-%m-%dT%H:%MZ"] {
        if let Ok(t) = DateTime::parse_from_str(&s.replace('Z', "+00:00"), &f.replace('Z', "%:z")) {
            return Some(t);
        }
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, f) {
            return Local.from_local_datetime(&n).earliest().map(|t| t.fixed_offset());
        }
    }
    None
}

/// 그 시각의 현지 날짜 (dateKey) 와 요일 (0 = 일요일)
pub fn local_day(t: DateTime<FixedOffset>) -> (String, u32) {
    use chrono::Datelike;
    let l = t.with_timezone(&Local);
    (l.format("%Y-%m-%d").to_string(), l.weekday().num_days_from_sunday())
}

/// new Date(y, m, d, h, min) — m 은 0부터, 넘친 달 · 날 · 분은 JS 처럼 앞뒤로 넘겨 센다
///   겹친 현지 시각(서머타임 끝)은 앞의 것, 없는 현지 시각(서머타임 시작)은 바뀌기 전 시간대로 읽어 뒤로 밀린다 — JS 와 같다
pub fn js_local(y: i64, m: i64, d: i64, h: i64, min: i64) -> DateTime<Local> {
    let first = NaiveDate::from_ymd_opt((y + m.div_euclid(12)) as i32, (m.rem_euclid(12) + 1) as u32, 1).expect("연도 범위");
    let naive = first.and_hms_opt(0, 0, 0).unwrap() + Duration::days(d - 1) + Duration::hours(h) + Duration::minutes(min);
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t,
        LocalResult::None => {
            let before = Local.offset_from_utc_datetime(&(naive - Duration::days(1)));
            Local.from_utc_datetime(&(naive - Duration::seconds(before.local_minus_utc().into())))
        }
    }
}
