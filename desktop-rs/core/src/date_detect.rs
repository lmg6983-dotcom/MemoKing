//! 글 속의 날짜·시각 찾기 — app/js/core/date-detect.js 의 findDates · guessTitle ("내일 오후 3시", "다음 주 화요일", "이틀 뒤" …)
//!   앞으로의 시각만 — 지난 날("어제 오후 3시")은 그 자리를 통째로 비워 둔다. 자리(from · to)는 UTF-8 바이트 (JS 는 UTF-16)
//!   find_dates_with(allow_past) 는 지난 날도 (일정 탭 빠른 추가 · 매직키 일정 — schedule_parse.rs)
//!   shortcut: 영어 날짜(chrono)는 옮기지 않았다 — 쓰는 곳(에이전트 · 일정 자동 등록 · 일정 추가)이 한국어만 본다, 편집기 밑줄을 옮길 때
use crate::js::re;
use crate::time::js_local;
use chrono::{DateTime, Datelike, Duration, Local, Timelike};
use fancy_regex::{Captures, Regex};
use serde_json::{json, Value};
use std::sync::LazyLock;

type T = DateTime<Local>;
type Day = (i64, i64, i64); // (해, 달 0~11, 날) — JS { y, mo, d }
type Caps<'a> = Captures<'a, str>;

pub const DEFAULT_HOUR: i64 = 9; // 날짜만 적었으면 그날 아침 9시

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub from: usize,
    pub to: usize,
    pub text: String,
    pub at: T,
    pub has_time: bool,
    pub end: Option<T>,
    pub repeat: Option<Value>,
}

const NOT_AFTER: &str = "(?<![0-9A-Za-z])";
const NOT_AFTER_HANGUL: &str = "(?<![가-힣])";
const NATIVE_HOUR_RE: &str = "열한|열두|다섯|여섯|일곱|여덟|아홉|한|두|세|네|열";
const COUNT_RE: &str = r"\d{1,3}|열|다섯|여섯|일곱|여덟|아홉|한|두|세|네";
const PERIOD_RE: &str = "오전|오후|아침|점심|저녁|밤|낮|새벽";
const WEEKDAYS: &str = "일월화수목금토";

fn native_hour(t: &str) -> i64 {
    match t {
        "열한" => 11,
        "열두" => 12,
        _ => native_count(t).unwrap_or(0),
    }
}

fn native_count(t: &str) -> Option<i64> {
    ["한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉", "열"].iter().position(|w| *w == t).map(|i| i as i64 + 1)
}

/// 숫자 · 고유어 개수 (한 달 · 두 시간) — 모르면 None (JS NaN)
fn count(t: &str) -> Option<i64> {
    if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        return t.parse().ok();
    }
    native_count(t)
}

/// 한자어 수 (십오 분 · 삼십 분)
fn sino_number(t: &str) -> Option<i64> {
    if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        return t.parse().ok();
    }
    let (mut total, mut digit) = (0, 0);
    for ch in t.chars() {
        if ch == '십' {
            total += if digit == 0 { 1 } else { digit } * 10;
            digit = 0;
        } else {
            digit = "일이삼사오육칠팔구".chars().position(|c| c == ch)? as i64 + 1;
        }
    }
    Some(total + digit)
}

fn period_hour(p: &str) -> i64 {
    match p {
        "새벽" => 6,
        "아침" => 8,
        "오전" => 9,
        "점심" => 12,
        "낮" => 13,
        "오후" => 14,
        "저녁" => 19,
        _ => 21, // 밤
    }
}

pub(crate) fn ymd(t: T) -> Day {
    (t.year().into(), t.month0().into(), t.day().into())
}
pub(crate) fn at_time(d: Day, h: i64, min: i64) -> T {
    js_local(d.0, d.1, d.2, h, min)
}
fn start_of_day(t: T) -> T {
    at_time(ymd(t), 0, 0)
}
fn add_days(t: T, n: i64) -> T {
    let (y, m, d) = ymd(t);
    js_local(y, m, d + n, 0, 0)
}
// 하루·한 주 뒤는 달력으로 더한다 (서머타임이 바뀌는 날에도 같은 시각이 되게)
fn plus_days(t: T, n: i64) -> T {
    let (y, m, d) = ymd(t);
    js_local(y, m, d + n, t.hour().into(), t.minute().into())
}
fn valid_day(d: Day) -> bool {
    ymd(at_time(d, 0, 0)) == d
}
fn days_in(y: i64, mo: i64) -> i64 {
    js_local(y, mo + 1, 0, 0, 0).day().into()
}
fn weekday(t: T) -> i64 {
    t.weekday().num_days_from_sunday().into()
}
fn weekday_index(ch: &str) -> i64 {
    WEEKDAYS.chars().position(|c| ch.starts_with(c)).map_or(-1, |i| i as i64)
}
fn num(m: &Caps, i: usize) -> i64 {
    m.get(i).and_then(|g| g.as_str().parse().ok()).unwrap_or(0)
}
fn group<'a>(m: &Caps<'a>, i: usize) -> Option<&'a str> {
    m.get(i).map(|g| g.as_str())
}

// 이번 주 = 월요일에 시작하는 주 (한국 달력 관례)
fn weekday_in(now: T, week_offset: i64, wd: i64) -> T {
    let today = start_of_day(now);
    let monday = add_days(today, -((weekday(today) + 6) % 7));
    add_days(monday, week_offset * 7 + (wd + 6) % 7)
}

fn with_year(year: Option<i64>, mo: i64, d: i64, now: T) -> Day {
    if let Some(y) = year {
        return (y, mo, d);
    }
    // 연도가 없으면 올해 — 이미 지났으면 내년 (12월에 적은 "1월 3일")
    let y = now.year() as i64;
    (if js_local(y, mo, d, 23, 59) < now { y + 1 } else { y }, mo, d)
}

fn week_offset(w: &str) -> i64 {
    match w {
        "다음" | "담" => 1,
        "다다음" => 2,
        "지난" | "저번" => -1,
        _ => 0,
    }
}

fn month_offset(w: &str) -> i64 {
    match w {
        "다음" => 1,
        "다다음" => 2,
        _ => 0,
    }
}

// 그 달의 n번째 X요일 (n = 0 이면 마지막) — 없는 날(다섯째 주가 없는 달)은 None
fn nth_weekday(y: i64, mo: i64, n: i64, wd: i64) -> Option<Day> {
    if n == 0 {
        let last = js_local(y, mo + 1, 0, 0, 0);
        return Some((y, mo, i64::from(last.day()) - (weekday(last) - wd + 7) % 7));
    }
    let d = 1 + (wd - weekday(js_local(y, mo, 1, 0, 0)) + 7) % 7 + (n - 1) * 7;
    (d <= days_in(y, mo)).then_some((y, mo, d))
}

fn nth(w: &str) -> i64 {
    match w {
        "첫" | "첫째" | "첫번째" => 1,
        "둘째" | "두번째" => 2,
        "셋째" | "세번째" => 3,
        "넷째" | "네번째" => 4,
        "다섯째" | "다섯번째" => 5,
        _ => 0, // 마지막
    }
}

// (이번|다음) 달 · M월 → 그 달 (해, 달) (M월이 이미 지난 달이면 내년)
fn month_of(word: Option<&str>, num: i64, now: T) -> (i64, i64) {
    if let Some(w) = word {
        let first = js_local(now.year().into(), i64::from(now.month0()) + month_offset(w), 1, 0, 0);
        return (first.year().into(), first.month0().into());
    }
    let mo = num - 1;
    (i64::from(now.year()) + i64::from(mo < now.month0().into()), mo)
}

// 음력 설날(1월 1일) · 추석(8월 15일)의 양력 날 — JS 는 브라우저의 한국 음력 달력(Intl dangi)으로 찾는다
// shortcut: 2024~2060년 표만 (JS Intl 로 뽑은 것), 2060년이 다가오면 표를 늘린다
const LUNAR_FROM: i64 = 2024;
const SEOLLAL: [(i64, i64); 37] = [
    (2, 10), (1, 29), (2, 17), (2, 7), (1, 27), (2, 13), (2, 3), (1, 23), (2, 11), (1, 31), (2, 19), (2, 8), (1, 28), (2, 15), (2, 4), (1, 24), (2, 12), (2, 1), (1, 22),
    (2, 10), (1, 30), (2, 17), (2, 6), (1, 26), (2, 14), (2, 2), (1, 23), (2, 11), (2, 1), (2, 19), (2, 8), (1, 28), (2, 15), (2, 4), (1, 24), (2, 12), (2, 2),
];
const CHUSEOK: [(i64, i64); 37] = [
    (9, 17), (10, 6), (9, 25), (9, 15), (10, 3), (9, 22), (9, 12), (10, 1), (9, 19), (9, 8), (9, 27), (9, 16), (10, 4), (9, 24), (9, 13), (10, 2), (9, 21), (9, 10), (9, 28),
    (9, 17), (10, 5), (9, 25), (9, 15), (10, 4), (9, 22), (9, 11), (9, 30), (9, 19), (9, 7), (9, 26), (9, 16), (10, 5), (9, 24), (9, 13), (10, 2), (9, 21), (9, 9),
];

/// 앞으로 가장 가까운 그 명절 (오늘 포함, 400일 안)
fn next_lunar(table: &[(i64, i64)], now: T) -> Option<Day> {
    let from = start_of_day(now);
    let until = add_days(from, 400);
    table.iter().enumerate().map(|(i, &(m, d))| (LUNAR_FROM + i as i64, m - 1, d)).find(|&day| at_time(day, 0, 0) >= from).filter(|&day| at_time(day, 0, 0) < until)
}

// ---------- 날짜 말 ----------
// date(m, now) → R | None (None = 날짜 말이 아님, 자리도 차지하지 않음)
#[derive(Default)]
struct R {
    at: Option<T>,     // 시각까지 정해지는 상대 표현 ("30분 뒤")
    date: Option<Day>, // None 이면 없는 날 — 자리만 차지
    repeat: Option<Value>,
    past: bool,
    today: bool,
    roll_week: bool, // 요일만 적은 말 — 그 시각이 지났으면 다음 주
}

fn on(date: Day) -> Option<R> {
    Some(R { date: Some(date), ..R::default() })
}

struct Rule {
    re: Regex,
    date: fn(&Caps, T) -> Option<R>,
    needs_more: bool, // 뒤에 요일 괄호나 시각이 있을 때만 날짜로 (분수·소수와 헷갈리지 않게)
    numeric: bool,    // 숫자로 적은 날짜 — 범위의 끝 날도 숫자로 읽는다
}

fn rule(pattern: &str, date: fn(&Caps, T) -> Option<R>) -> Rule {
    Rule { re: re(pattern), date, needs_more: false, numeric: false }
}

static DATE_RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let wd = format!("[{WEEKDAYS}]");
    vec![
        // 매년 M월 D일 (되풀이 — "M월 D일" 보다 먼저). 2월 29일은 평년엔 28일에 — 어느 해에도 없는 날만 버린다
        rule(r"(?<![가-힣])매년\s?(\d{1,2})월\s?(\d{1,2})일", |m, now| {
            let (mo, day, y) = (num(m, 1) - 1, num(m, 2), now.year().into());
            if !(0..=11).contains(&mo) || day < 1 || day > days_in(2000, mo) {
                return on((y, mo, day));
            }
            Some(R { date: Some((y, mo, day.min(days_in(y, mo)))), repeat: Some(json!({ "every": "year", "month": mo + 1, "day": day })), ..R::default() })
        }),
        // 2026-10-12, 2026.10.12, 2026/10/12
        Rule { numeric: true, ..rule(&format!(r"{NOT_AFTER}(\d{{4}})[-./]\s?(\d{{1,2}})[-./]\s?(\d{{1,2}})(?![0-9])\.?"), |m, _| on((num(m, 1), num(m, 2) - 1, num(m, 3)))) },
        // (2026년) 10월 12일 · 26년 10월 12일
        rule(&format!(r"{NOT_AFTER}(?:(\d{{4}}|\d{{2}})년\s?)?(\d{{1,2}})월\s?(\d{{1,2}})일"), |m, now| {
            let year = group(m, 1).map(|y| if y.len() == 2 { 2000 + num(m, 1) } else { num(m, 1) });
            on(with_year(year, num(m, 2) - 1, num(m, 3), now))
        }),
        // '26.10.20 · 26.10.20 (두 자리 연도)
        Rule { numeric: true, ..rule(r"(?<![0-9A-Za-z.])'?(\d{2})\.(\d{1,2})\.(\d{1,2})(?![0-9.])", |m, _| on((2000 + num(m, 1), num(m, 2) - 1, num(m, 3)))) },
        // 10/12 · 10.12 — 뒤에 요일 괄호나 시각이 있을 때만 ("1/2 컵", "3.5" 는 날짜가 아님)
        Rule { needs_more: true, numeric: true, ..rule(r"(?<![0-9A-Za-z/.])(\d{1,2})[/.](\d{1,2})(?![0-9/.])", |m, now| on(with_year(None, num(m, 1) - 1, num(m, 2), now))) },
        // 이번 달 20일 · 다음 달 3일 · 다다음 달 1일
        rule(r"(?<![가-힣])(이번|다음|다다음)\s?달\s?(\d{1,2})일", |m, now| {
            let first = js_local(now.year().into(), i64::from(now.month0()) + month_offset(&m[1]), 1, 0, 0);
            on((first.year().into(), first.month0().into(), num(m, 2)))
        }),
        // 12월 첫째 주 월요일 · 다음 달 셋째 주 금요일 · 이번 달 마지막 주 수요일 (뒤의 "X요일" 규칙보다 먼저)
        rule(
            &format!(r"(?<![0-9가-힣])(?:(이번|다음|다다음)\s?달|(\d{{1,2}})월)\s?(첫|첫째|첫\s?번째|둘째|두\s?번째|셋째|세\s?번째|넷째|네\s?번째|다섯째|다섯\s?번째|마지막)\s?주\s?({wd})(?:요일|욜)"),
            |m, now| {
                if m.get(2).is_some() && !(1..=12).contains(&num(m, 2)) {
                    return None;
                }
                let (y, mo) = month_of(group(m, 1), num(m, 2), now);
                let n: String = m[3].chars().filter(|c| !crate::js::is_space(*c)).collect();
                // 없는 날(다섯째 주가 없는 달)이면 자리만 차지 — 뒤의 "월요일" 을 가까운 월요일로 읽지 않게
                Some(R { date: nth_weekday(y, mo, nth(&n), weekday_index(&m[4])), ..R::default() })
            },
        ),
        // 월말 · 이번 달 말 · 다음 달 말일 · 11월 말 → 그 달 마지막 날 ("10월 말고" 는 아님)
        rule(r"(?<![0-9가-힣])(?:(이번|다음|다다음)\s?달\s?말일?|(\d{1,2})월\s?말일?|월말)(?=$|[^가-힣]|까지|에|엔|쯤|경|일)", |m, now| {
            if m.get(2).is_some() && !(1..=12).contains(&num(m, 2)) {
                return None;
            }
            let (y, mo) = if m.get(1).is_some() || m.get(2).is_some() { month_of(group(m, 1), num(m, 2), now) } else { (now.year().into(), now.month0().into()) };
            on((y, mo, days_in(y, mo)))
        }),
        // 설날 · 추석 (음력 — 앞으로 가장 가까운 날)
        rule(r"(?<![가-힣])(설날|구정|추석|한가위)", |m, now| on(next_lunar(if matches!(&m[1], "설날" | "구정") { &SEOLLAL } else { &CHUSEOK }, now)?)),
        // 크리스마스(이브)
        rule(r"(?<![가-힣])크리스마스(\s?이브)?", |m, now| on(with_year(None, 11, if m.get(1).is_some() { 24 } else { 25 }, now))),
        // 지난 날: 어제 · 그제 · 그저께 · 엊그제 · 어젯밤 — 자리만 차지 (뒤 시각을 오늘로 읽지 않게)
        rule(r"(?<![가-힣])(어제|어젯밤|그제|그저께|엊그제|지난밤)", |_, now| Some(R { date: Some(ymd(add_days(now, -1))), past: true, ..R::default() })),
        // 오늘 · 내일 · 낼 · 모레 · 내일모레 · 글피 — "낼" 은 "내다" (돈을 낼게요) 와 같아 시각·때가 바로 이어질 때만
        rule(&format!(r"(?<![가-힣])(오늘|내일\s?모레|내일|낼(?=\s?(?:\d|{PERIOD_RE}|{NATIVE_HOUR_RE}\s?시))|모레|글피)(?!의)"), |m, now| {
            let n = match &m[1] {
                "오늘" => 0,
                "내일" | "낼" => 1,
                "모레" => 2,
                "글피" => 3,
                _ => 2, // 내일모레
            };
            Some(R { date: Some(ymd(add_days(now, n))), today: &m[1] == "오늘", ..R::default() })
        }),
        // N시간 M분 뒤 · 30분 뒤 · 한 시간 후 · 30분 있다가
        rule(&format!(r"(?<![0-9가-힣])(?:({COUNT_RE})\s?시간\s?(반)?\s?)?(?:(\d{{1,3}}|[일이삼사오육칠팔구십]{{1,3}})\s?분\s?)?(뒤|후|있다가|이따가?)(?=$|[^가-힣]|에|엔|쯤)"), |m, now| {
            if m.get(1).is_none() && m.get(3).is_none() {
                return None;
            }
            let hours = group(m, 1).map_or(Some(0), count)?;
            let mins = if m.get(2).is_some() { 30 } else { 0 } + group(m, 3).map_or(Some(0), sino_number)?;
            if hours + mins == 0 {
                return None;
            }
            Some(R { at: Some(now + Duration::minutes(hours * 60 + mins)), ..R::default() })
        }),
        // 하루·이틀·사흘 … 열흘 뒤
        rule(r"(?<![가-힣])(하루|이틀|사흘|나흘|닷새|엿새|이레|여드레|아흐레|열흘|보름)\s?(?:뒤|후|있다가|지나서)", |m, now| {
            let n = ["하루", "이틀", "사흘", "나흘", "닷새", "엿새", "이레", "여드레", "아흐레", "열흘"].iter().position(|w| *w == &m[1]).map_or(15, |i| i as i64 + 1);
            on(ymd(add_days(now, n)))
        }),
        // 3일 뒤 · 일주일 후 · 2주 뒤 · 한 달 뒤 · 3개월 후 · 1년 뒤
        rule(&format!(r"(?<![0-9가-힣])(?:(일)주일|({COUNT_RE})\s?(일|주일?|달|개월|년))\s?(?:뒤|후|있다가|지나서)(?=$|[^가-힣]|에|엔|쯤)"), |m, now| {
            if m.get(1).is_some() {
                return on(ymd(add_days(now, 7)));
            }
            let n = count(&m[2]).filter(|n| *n > 0)?;
            let unit = &m[3];
            if unit == "일" {
                return on(ymd(add_days(now, n)));
            }
            if unit.starts_with('주') {
                return on(ymd(add_days(now, n * 7)));
            }
            let months = if unit == "년" { n * 12 } else { n };
            let t = js_local(now.year().into(), i64::from(now.month0()) + months, 1, 0, 0);
            on((t.year().into(), t.month0().into(), i64::from(now.day()).min(days_in(t.year().into(), t.month0().into()))))
        }),
        // ---- 되풀이: 매일 · 매주 X요일 · X요일마다 · 매달 N일 → 반복 알림 (한 번짜리로 잘못 맞추지 않게) ----
        rule(r"(?<![가-힣])매일|(?<![가-힣])날마다", |_, now| Some(R { date: Some(ymd(now)), repeat: Some(json!({ "every": "day" })), ..R::default() })),
        rule(&format!(r"(?<![가-힣])매주\s?({wd})(?:요일|욜)|(?<![가-힣])({wd})(?:요일|욜)\s?마다"), |m, now| {
            let wd = weekday_index(group(m, 1).or(group(m, 2))?);
            Some(R { date: Some(ymd(add_days(start_of_day(now), (wd - weekday(now) + 7) % 7))), repeat: Some(json!({ "every": "week", "weekdays": [wd] })), ..R::default() })
        }),
        // 격주 금요일 · 2주마다 금요일 · 3주에 한 번 금요일 · 금요일 격주 → N주마다 (첫 회차는 가장 가까운 그 요일, 12주까지)
        rule(
            &format!(r"(?<![0-9가-힣])(?:격주|(\d{{1,2}}|이|삼|사|두|세|네)\s?주\s?(?:마다|에\s?한\s?번))\s?({wd})(?:요일|욜)(?:\s?마다)?|(?<![가-힣])({wd})(?:요일|욜)\s?격주(?:\s?(?:로|마다))?"),
            |m, now| {
                // JS: count(m[1]) || sinoNumber(m[1]) — 0 · NaN 이면 한자어로
                let n = group(m, 1).map_or(Some(2), |t| count(t).filter(|n| *n != 0).or_else(|| sino_number(t)))?;
                if !(1..=12).contains(&n) {
                    return None;
                }
                let wd = weekday_index(group(m, 2).or(group(m, 3))?);
                let mut repeat = json!({ "every": "week", "weekdays": [wd] });
                if n > 1 {
                    repeat["interval"] = n.into();
                }
                Some(R { date: Some(ymd(add_days(start_of_day(now), (wd - weekday(now) + 7) % 7))), repeat: Some(repeat), ..R::default() })
            },
        ),
        rule(r"(?<![가-힣])(?:매달|매월)\s?(\d{1,2})일(?:\s?마다)?", |m, now| {
            let d = num(m, 1);
            if !(1..=31).contains(&d) {
                return None;
            }
            let (y, mo) = (now.year().into(), now.month0().into());
            Some(R { date: Some((y, mo, d.min(days_in(y, mo)))), repeat: Some(json!({ "every": "month", "day": d })), ..R::default() })
        }),
        // (이번|다음|담|다다음|지난|저번) 주 X요일 · 다음주 월욜
        rule(&format!(r"(?<![가-힣])(이번|다음|담|다다음|지난|저번)\s?주\s?({wd})(?:요일|욜)"), |m, now| {
            let off = week_offset(&m[1]);
            Some(R { date: Some(ymd(weekday_in(now, off, weekday_index(&m[2])))), past: off < 0, ..R::default() })
        }),
        // (이번|다음) 주말 → 그 주 토요일
        rule(r"(?<![가-힣])(?:(이번|다음|담|다다음|지난|저번)\s?)?주말", |m, now| {
            let off = week_offset(group(m, 1).unwrap_or("이번"));
            let mut sat = weekday_in(now, off, 6);
            // 이번 주말인데 토요일 아침이 지났으면 일요일, 주말이 다 지났으면 ("주말" 만 적은 것은) 다음 주말
            if off == 0 && sat + Duration::hours(DEFAULT_HOUR) <= now {
                let sun = add_days(sat, 1);
                if sun + Duration::hours(DEFAULT_HOUR) > now {
                    sat = sun;
                } else if m.get(1).is_none() {
                    sat = add_days(sat, 7);
                }
            }
            Some(R { date: Some(ymd(sat)), past: off < 0, ..R::default() })
        }),
        // X요일 · X욜 → 오늘부터 가장 가까운 그 요일 (오늘이 그 요일이면 오늘)
        rule(&format!(r"(?<![가-힣])({wd})(?:요일|욜)"), |m, now| {
            Some(R { date: Some(ymd(add_days(start_of_day(now), (weekday_index(&m[1]) - weekday(now) + 7) % 7))), roll_week: true, ..R::default() })
        }),
        // 15일까지 · 25일에 — 이번 달(지났으면 다음 달). "3일 동안" · "3일에 걸쳐" · 줄 끝의 "3일"(기간) 은 날짜가 아님
        rule(r"(?<![0-9가-힣./-])(\d{1,2})일(?=\s?(?:까지|에(?!\s?걸쳐)|부터|날|\(|오전|오후|아침|점심|저녁|밤|낮|새벽|\d{1,2}\s?시|\d{1,2}:|\d{1,2}\s?(?:am|pm|AM|PM)(?![A-Za-z0-9_])))", |m, now| {
            let d = num(m, 1);
            if !(1..=31).contains(&d) {
                return None;
            }
            let mut date = (now.year().into(), now.month0().into(), d);
            // 이번 달이 지났으면 다음 달 — 다음 달에도 그날이 없으면(1월 31일의 "30일까지") 찾지 않는다(findDates 의 validDay)
            if at_time(date, 23, 59) < now || !valid_day(date) {
                let next = js_local(now.year().into(), i64::from(now.month0()) + 1, 1, 0, 0);
                date = (next.year().into(), next.month0().into(), d);
            }
            on(date)
        }),
    ]
});

// ---------- 시각 ----------
// 오후 3시 · 3시 반 · 3시 20분 · 세 시 · 열한 시 반 · 15:30 · 정오 · 자정 — "시" 뒤에 시간·시작 같은 다른 말이 오면 시각이 아니다
static TIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    let after_si = r"(?!\s?방향)(?=$|[^가-힣]|반|에|엔|까지|부터|쯤|경|정각|전|에서|으로|이나|이고|이요|이에요|입니다)";
    let min_re = r"(\d{1,2}|[일이삼사오육칠팔구십]{1,3})\s?분";
    re(&format!(
        r"(?:({PERIOD_RE})\s?)?(?:{NOT_AFTER}(\d{{1,2}}):(\d{{2}})(?![0-9:])|{NOT_AFTER}(\d{{1,2}})\s?시(?:\s?(반)|\s?{min_re})?{after_si}|(?:(?<={PERIOD_RE}\s?)|{NOT_AFTER_HANGUL})({NATIVE_HOUR_RE})\s?시(?:\s?(반)|\s?{min_re})?{after_si})|{NOT_AFTER_HANGUL}(정오|자정)"
    ))
});
// 때만 (시각 없이): 날짜 바로 뒤에서만 ("내일 저녁"). 붙어도 되는 토씨만 — "낮잠" · "밤샘" 은 때가 아님
static PERIOD_ONLY_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(r"({PERIOD_RE})(?=(?:에는|에도|에|엔|쯤에?|께|부터|까지|즈음|경|중|이나|은|는|이|의)?(?![가-힣]))(?!\s?(?:\d|{NATIVE_HOUR_RE})\s?시)"))
});
static GAP_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:\s|에\s?|의\s?|,\s?|\([월화수목금토일](?:요일)?\)\s?)*"));
static PAREN_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s?\((?:[월화수목금토일](?:요일)?)\)"));
static PAST_WORD_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(지난|저번)\s?(주\s?)?$"));

#[derive(Clone, Copy)]
struct Tm {
    h: i64,
    min: i64,
    period: Option<&'static str>,
    digital: bool,
    explicit: bool,
    midnight: bool,
}

fn period_name(p: &str) -> &'static str {
    PERIOD_RE.split('|').find(|x| *x == p).unwrap_or("")
}

fn time_of(m: &Caps, input: &str) -> Option<Tm> {
    let tm = |h, min, period, digital| Some(Tm { h, min, period, digital, explicit: true, midnight: false });
    if let Some(w) = group(m, 10) {
        return if w == "정오" { tm(12, 0, None, false) } else { Some(Tm { midnight: true, ..tm(24, 0, None, false)? }) };
    }
    let period = group(m, 1).map(period_name);
    let minutes = |half: usize, mins: usize| if m.get(half).is_some() { Some(30) } else { group(m, mins).map_or(Some(0), sino_number) };
    let (mut h, min, digital) = if m.get(2).is_some() {
        (num(m, 2), num(m, 3), true)
    } else if m.get(4).is_some() {
        (num(m, 4), minutes(5, 6)?, false)
    } else {
        // "세시 풍속" · "한시 바삐" 같은 낱말은 시각이 아님
        let rest = &input[m.get(0)?.end()..];
        if period.is_none() && re(r"^\s?(?:풍속|바삐|바쁘)").is_match(rest).unwrap_or(false) {
            return None;
        }
        (native_hour(&m[7]), minutes(8, 9)?, false)
    };
    if h > 24 || min > 59 {
        return None;
    }
    match period {
        Some("오전" | "아침" | "새벽") => {
            if h == 12 {
                h = 0;
            }
            if h > 12 {
                return None;
            }
        }
        Some(p) => {
            if h > 12 {
                return None;
            }
            if p == "밤" && h == 12 {
                h = 24; // 밤 12시 = 그날 자정
            } else if p == "낮" || p == "점심" {
                h = if h <= 6 { h + 12 } else { h }; // 낮 1시 = 13시, 낮 11시 = 11시
            } else if p == "밤" && h <= 4 {
                h += 24; // 밤 1시 = 다음 날 새벽 1시
            } else if h < 12 {
                h += 12;
            }
        }
        // "3시 회의" 처럼 오전·오후 없이 1~6시는 보통 오후
        None if !digital && (1..=6).contains(&h) => h += 12,
        None => {}
    }
    tm(h, min, period, digital)
}

/// TIME_RE 가 바로 pos 에서 맞으면 그 맞춤
fn time_match_at(text: &str, pos: usize) -> Option<Caps<'_>> {
    TIME_RE.captures_from_pos(text, pos).ok().flatten().filter(|m| m.get(0).is_some_and(|g| g.start() == pos))
}

/// pos 부터 시각(또는 때만)이 바로 이어지면 (시각, 끝)
fn time_at(text: &str, pos: usize) -> Option<(Tm, usize)> {
    let from = pos + GAP_RE.find(&text[pos..]).ok().flatten().map_or(0, |g| g.end());
    if let Some(m) = time_match_at(text, from) {
        if let Some(t) = time_of(&m, text) {
            return Some((t, range_end(text, m.get(0)?.end())));
        }
    }
    let p = PERIOD_ONLY_RE.captures_from_pos(text, from).ok().flatten().filter(|p| p.get(0).is_some_and(|g| g.start() == from))?;
    Some((Tm { h: period_hour(&p[1]), min: 0, period: Some(period_name(&p[1])), digital: false, explicit: false, midnight: false }, p.get(0)?.end()))
}

/// "3시~5시" · "3시부터 5시까지": 끝 시각까지 한 자리로 (알림은 시작 시각)
fn range_end(text: &str, end: usize) -> usize {
    let Some(r) = re(r"^\s?(?:~|-|–|부터)\s?").find(&text[end..]).ok().flatten() else { return end };
    let Some(m) = time_match_at(text, end + r.end()) else { return end };
    let to = m.get(0).map_or(end, |g| g.end());
    to + re(r"^\s?까지").find(&text[to..]).ok().flatten().map_or(0, |g| g.end())
}

/// 오전·오후 없는 7~11시가 이미 지났으면 저녁으로 ("오늘 8시" 를 오전 10시에 적으면 저녁 8시)
fn evening_if_past(at: T, t: &Tm, now: T) -> T {
    if at <= now && t.period.is_none() && !t.digital && (7..=11).contains(&t.h) {
        at + Duration::hours(12)
    } else {
        at
    }
}

static RANGE_DAY: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    let day = r"(?:(\d{1,2})월\s?)?(\d{1,2})일";
    let num = r"|(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?![0-9])|(\d{1,2})([-/.])(\d{1,2})(?![0-9/.-])|(\d{1,2})(?![0-9:/.]|\s?[시분월년개명번])";
    let make = |alt: &str| re(&format!(r"^\s?(?:~|-|–|부터)\s?(?:{day}{alt})(?:\s?\([월화수목금토일](?:요일)?\))?(?:\s?까지)?"));
    [make(""), make(num)]
});

/// 날짜 바로 뒤의 끝 날 → (끝 날 0시, 끝 자리, 빗금인가) — 시작보다 뒤의 있는 날일 때만
///   "~22일" · "부터 12월 2일까지" · 숫자 날짜 뒤에서는 "~ 2026-11-22" · "~11/22" · "~11.22" · "~22" 도
fn range_day(text: &str, pos: usize, start: T, numeric: bool) -> Option<(T, usize, bool)> {
    let m = RANGE_DAY[usize::from(numeric)].captures(&text[pos..]).ok().flatten()?;
    let month = group(&m, 1).or(group(&m, 4)).or(group(&m, 6));
    let mo = month.map_or(start.month0().into(), |x| x.parse::<i64>().unwrap_or(0) - 1);
    // 끝 달이 시작 달보다 앞이면 해를 넘긴 것 ("12월 30일~1월 2일")
    let y = if m.get(3).is_some() { num(&m, 3) } else { i64::from(start.year()) + i64::from(mo < start.month0().into()) };
    let d = [2, 5, 8, 9].into_iter().find_map(|i| group(&m, i)).map_or(0, |x| x.parse().unwrap_or(0));
    if !(0..=11).contains(&mo) || !valid_day((y, mo, d)) {
        return None;
    }
    let end = at_time((y, mo, d), 0, 0);
    (end > start).then(|| (end, pos + m.get(0).map_or(0, |g| g.end()), group(&m, 7) == Some("/")))
}

/// 되풀이 규칙에 시각을 채운다 — 격주는 첫 회차 날을 기준(from)으로
fn repeat_at(repeat: &Value, at: T) -> Value {
    let mut r = repeat.clone();
    r["time"] = at.format("%H:%M").to_string().into();
    if r.get("interval").is_some() {
        r["from"] = at.format("%Y-%m-%d").to_string().into();
    }
    r
}

/// 되풀이 알림의 다음 차례 (이미 지났으면 하루·한 주·한 달·한 해 뒤로)
fn next_repeat(at: T, repeat: &Value, now: T) -> T {
    let mut next = at;
    for _ in 0..400 {
        if next > now {
            break;
        }
        next = match repeat["every"].as_str() {
            Some("day") => plus_days(next, 1),
            Some("week") => plus_days(next, 7),
            every => {
                let months = if every == Some("year") { 12 } else { 1 };
                let (h, min) = (next.hour().into(), next.minute().into());
                let base = js_local(next.year().into(), i64::from(next.month0()) + months, 1, h, min);
                let (y, mo) = (base.year().into(), base.month0().into());
                let day = repeat["day"].as_i64().unwrap_or(next.day().into());
                js_local(y, mo, day.min(days_in(y, mo)), h, min)
            }
        };
    }
    next
}

/// s 의 byte 자리 앞 UTF-16 n 단위 (JS s.slice(from - n, from))
fn before(s: &str, from: usize, n: usize) -> &str {
    let mut units = 0;
    let start = s[..from].char_indices().rev().take_while(|(_, c)| {
        units += c.len_utf16();
        units <= n
    });
    start.last().map_or(&s[from..from], |(i, _)| &s[i..from])
}

/// 글 속 날짜·시각들 (앞에서부터, 겹치지 않게) — 앞으로의 것만
pub fn find_dates(s: &str, now: T) -> Vec<Found> {
    find_dates_with(s, now, false)
}

/// allow_past: 지난 날 · 지난 시각도 그대로 (JS findDates 의 { allowPast })
pub fn find_dates_with(s: &str, now: T, allow_past: bool) -> Vec<Found> {
    let mut found: Vec<Found> = vec![];
    let mut taken: Vec<(usize, usize)> = vec![]; // 날짜 말이 차지한 자리 (지난 날 포함)
    let overlaps = |taken: &[(usize, usize)], from: usize, to: usize| taken.iter().any(|r| from < r.1 && to > r.0);
    let mut add = |taken: &mut Vec<(usize, usize)>, from: usize, to: usize, at: T, has_time: bool, past: bool, repeat: Option<&Value>, end: Option<T>| {
        if overlaps(taken, from, to) {
            return;
        }
        taken.push((from, to));
        if past && !allow_past {
            return;
        }
        // 되풀이는 이미 지났으면 다음 차례로
        let at = repeat.map_or(at, |r| next_repeat(at, r, now));
        // 날짜만 적은 말(종일)은 그날이 다 가기 전까지는 앞으로의 날 (date-detect.js dayLeft)
        if !allow_past && if has_time { at <= now + Duration::seconds(30) } else { add_days(at, 1) <= now } {
            return;
        }
        found.push(Found { from, to, text: crate::js::trim(&s[from..to]).to_string(), at, has_time, end, repeat: repeat.map(|r| repeat_at(r, at)) });
    };

    for rule in DATE_RULES.iter() {
        for m in rule.re.captures_iter(s).flatten() {
            let all = m.get(0).unwrap();
            let from = all.start();
            let mut to = all.end();
            if overlaps(&taken, from, to) {
                continue;
            }
            let paren = PAREN_RE.find(&s[to..]).ok().flatten().map(|p| p.end());
            to += paren.unwrap_or(0);
            let Some(r) = (rule.date)(&m, now) else { continue };
            if let Some(at) = r.at {
                add(&mut taken, from, to, at, true, false, None, None);
                continue;
            }
            let Some(date) = r.date.filter(|d| (0..=11).contains(&d.1) && valid_day(*d)) else {
                taken.push((from, to)); // "13월 1일" 의 "1일" 을 따로 날짜로 읽지 않게
                continue;
            };
            // "지난 금요일" · "저번 주 화요일" 처럼 앞에 지난 말이 붙은 요일도 지난 날
            let past = r.past || PAST_WORD_RE.is_match(before(s, from, 5)).unwrap_or(false);
            let t = time_at(s, to);
            // "11/20~11/22" 처럼 빗금 날짜 둘이 이어지면 날짜 범위 (점은 "3.5~4.5" 같은 수일 때가 많아 읽지 않는다)
            let slash_range = rule.needs_more && all.as_str().contains('/') && t.is_none() && range_day(s, to, at_time(date, DEFAULT_HOUR, 0), true).is_some_and(|r| r.2);
            if rule.needs_more && paren.is_none() && !t.is_some_and(|t| t.0.explicit) && !slash_range {
                continue;
            }
            if let Some((t, end)) = t {
                let mut at = at_time(date, t.h, t.min);
                if r.today && !allow_past {
                    at = evening_if_past(at, &t, now);
                }
                if r.roll_week && at <= now {
                    at = plus_days(at, 7);
                }
                add(&mut taken, from, end, at, true, past, r.repeat.as_ref(), None);
            } else if r.today {
                taken.push((from, to)); // "오늘" 만은 알림 시각이 없다
            } else {
                let mut at = at_time(date, DEFAULT_HOUR, 0);
                // 오늘이 그 요일이고 9시가 지났으면: 날짜만 적은 "금요일" 은 다음 주
                if r.roll_week && at <= now {
                    at = plus_days(at, 7);
                }
                // "11월 20일~22일" · "20일부터 12월 2일까지": 끝 날까지 한 자리로, 여러 날 일정
                let range = if r.repeat.is_some() { None } else { range_day(s, to, at, rule.numeric) };
                add(&mut taken, from, range.map_or(to, |r| r.1), at, false, past, r.repeat.as_ref(), range.map(|r| r.0));
            }
        }
    }

    // 날짜 없이 시각만: 오늘 그 시각 (지났으면 찾지 않음 — 다만 새벽·자정은 다음 날)
    for m in TIME_RE.captures_iter(s).flatten() {
        let all = m.get(0).unwrap();
        if overlaps(&taken, all.start(), all.end()) {
            continue;
        }
        let Some(t) = time_of(&m, s) else { continue };
        // 오전·오후 없는 숫자 시각(12:30)은 시간표·기록일 때가 많고, "24시 편의점" 은 시각이 아니다
        if (t.digital && t.period.is_none()) || (t.period.is_none() && t.h == 24 && !t.midnight) {
            continue;
        }
        let end = range_end(s, all.end());
        let mut at = at_time(ymd(now), t.h, t.min);
        if !allow_past && at <= now && (t.period == Some("새벽") || t.midnight) {
            at = plus_days(at, 1);
        } else if !allow_past {
            at = evening_if_past(at, &t, now);
        }
        add(&mut taken, all.start(), end, at, true, false, None, None);
    }
    found.sort_by_key(|f| f.from);
    found
}

/// 일정 이름 짐작: 그 줄에서 날짜 말을 빼고 남은 말 ("내일 오후 3시 치과" → "치과", "15일까지 보고서 제출" → "보고서 제출")
pub fn guess_title(line: &str, from: usize, to: usize) -> String {
    static LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(?:까지|에는|에|부터|은|는|이|가|의|쯤|경)(?=\s|$)"));
    static MID: LazyLock<Regex> = LazyLock::new(|| re(r"(?:^|\s)(?:까지|에는|에|부터)(?=\s)"));
    static TAIL: LazyLock<Regex> = LazyLock::new(|| re(r"[\s,:·\-–~]+$"));
    static HEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^[\s,:·\-–~]+"));
    static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
    let rest = format!("{} {}", &line[..from], &line[to..]).replace('\u{FFFC}', " ");
    let rest = LEAD.replace(&rest, "");
    let rest = MID.replace_all(&rest, " ");
    let rest = TAIL.replace(&rest, "");
    let rest = HEAD.replace(&rest, "");
    let rest = SPACES.replace_all(&rest, " ");
    crate::js::slice16(crate::js::trim(&rest), 40)
}
