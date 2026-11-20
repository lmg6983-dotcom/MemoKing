//! 일정 글 읽기 — app/js/core/schedule-parse.js 의 parseScheduleText · extractScheduleTitle 와 같은 답
//!   일정 탭 빠른 추가("1월 1일 영양제 먹는 날")와 같은 규칙: 날짜 · 기간 · 여러 날 · 하루 종일, 날짜 말을 뺀 제목.
//!   매직키(MagicKey)가 "일정 추가" 줄에 무엇이 저장될지 미리 보이려고 쓴다 (저장은 메모킹 일정 탭 코드가 같은 규칙으로)
use crate::date_detect::{at_time, find_dates_with, ymd, Found};
use crate::js::re;
use chrono::{DateTime, Local, Timelike};
use fancy_regex::Regex;
use std::sync::LazyLock;

type T = DateTime<Local>;

#[derive(Debug, Clone, PartialEq)]
pub struct Schedule {
    pub range: bool,
    pub start: T,
    pub end: Option<T>,
    pub all_day: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub hits: Vec<Found>,
    pub title: String,
    pub schedules: Vec<Schedule>,
    pub empty_title: bool,
    pub needs_date_choice: bool,
}

const MAX_TITLE: usize = 80; // UTF-16 글자 (JS slice(0, 80))

fn test(r: &Regex, s: &str) -> bool {
    r.is_match(s).unwrap_or(false)
}

/// 날짜 말과 그 뒤 조사 · 날짜 사이 연결어를 뺀 일정 제목 (extractScheduleTitle). 자리는 UTF-8 바이트
pub fn extract_schedule_title(raw: &str, hits: &[Found]) -> String {
    static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
    if hits.is_empty() {
        return crate::js::slice16(crate::js::trim(&SPACES.replace_all(raw, " ")), MAX_TITLE);
    }
    // 1) 날짜 바로 뒤의 '부터', '까지', '에는', '에', '쯤', '경'
    static AFTER: LazyLock<Regex> = LazyLock::new(|| re(r"^(\s*(?:부터|까지|에는|에|쯤|경))(?=\s|[,\.~]|$)"));
    let spans: Vec<(usize, usize)> = hits
        .iter()
        .map(|h| {
            let tail = AFTER.find(&raw[h.to..]).ok().flatten().map_or(0, |m| m.end());
            (h.from, h.to + tail)
        })
        .collect();
    // 2) 날짜 사이의 연결어(~, -, 그리고, 및, 와, 과, 랑, ',', +)로 이어지면 한 덩어리
    static JOIN: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(?:~|-|–|—|그리고|및|와|과|랑|,|\+)\s*$"));
    let mut merged: Vec<(usize, usize)> = vec![];
    for (from, to) in spans {
        match merged.last_mut() {
            Some(prev) if from >= prev.1 && test(&JOIN, &raw[prev.1..from]) => prev.1 = to,
            _ => merged.push((from, to)),
        }
    }
    // 3) 날짜 구간 빼기
    let mut result = String::new();
    let mut last = 0;
    for (from, to) in merged {
        if from >= last {
            result.push_str(&raw[last..from]);
        }
        result.push(' ');
        last = to;
    }
    result.push_str(&raw[last.min(raw.len())..]);
    // 4) 앞뒤 연결어 · 조사 · 기호 · 빈칸 정리
    static CONJ: LazyLock<Regex> = LazyLock::new(|| re(r"(?:^|\s)(?:그리고|및|와|과|랑|~|-)(?=\s|$)"));
    static LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(?:까지|에는|에|부터|은|는|이|가|의|쯤|경)(?=\s|$)"));
    static TAIL: LazyLock<Regex> = LazyLock::new(|| re(r"[\s,:·\-–~]+$"));
    static HEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^[\s,:·\-–~]+"));
    let s = CONJ.replace_all(&result, " ");
    let s = LEAD.replace(&s, "");
    let s = TAIL.replace(&s, "");
    let s = HEAD.replace(&s, "");
    let s = SPACES.replace_all(&s, " ");
    crate::js::slice16(crate::js::trim(&s), MAX_TITLE)
}

/// 일정 탭 빠른 추가의 글 → 만들 일정들 · 제목 (parseScheduleText). default_day: 날짜를 안 적었을 때의 날 (일정 탭에서 고른 날)
pub fn parse_schedule_text(raw: &str, default_day: Option<T>, now: T) -> Parsed {
    let text = crate::js::trim(raw);
    if text.is_empty() {
        return Parsed { hits: vec![], title: String::new(), schedules: vec![], empty_title: true, needs_date_choice: false };
    }
    let hits = find_dates_with(text, now, true);
    let title = extract_schedule_title(text, &hits);
    let empty_title = title.is_empty();
    if hits.is_empty() {
        let Some(start) = default_day else {
            return Parsed { hits, title, schedules: vec![], empty_title, needs_date_choice: true };
        };
        return Parsed { hits, title, schedules: vec![Schedule { range: false, start, end: None, all_day: true }], empty_title, needs_date_choice: false };
    }

    static RANGE_SYMBOL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^\s*(?:~|-|–|—|to|until)\s*$"));
    static FROM_ONLY: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(?:부터|에서)\s*$"));
    static FROM_LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(?:부터|에서)"));
    static UNTIL_LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*까지"));
    static MULTI: LazyLock<Regex> = LazyLock::new(|| re(r"(?:그리고|및|와|과|랑|,|\+)"));
    static DATE_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"(?:\d{1,2}월|\d{1,2}일|내일|낼|모레|글피|어제|그제|요일|주말|\d{4}[-./])"));
    let with_time = |d: T, h: &T| at_time(ymd(d), h.hour() as i64, h.minute() as i64);

    let mut schedules: Vec<Schedule> = vec![];
    let mut i = 0;
    while i < hits.len() {
        // 해석기가 이미 범위로 읽은 날짜 ("11월 20일~22일") — 끝 날은 시작과 같은 시각으로
        if let Some(end) = hits[i].end {
            let at = hits[i].at;
            schedules.push(Schedule { range: true, start: at, end: Some(with_time(end, &at)), all_day: true });
            i += 1;
            continue;
        }
        if i + 1 < hits.len() {
            let (h1, h2) = (&hits[i], &hits[i + 1]);
            let between = if h2.from >= h1.to { &text[h1.to..h2.from] } else { "" };
            let (h1_tail, h2_tail) = (&text[h1.to..], &text[h2.to..]);
            let range_symbol = test(&RANGE_SYMBOL, between);
            let from_to = test(&FROM_ONLY, between) || (test(&FROM_LEAD, h1_tail) && test(&UNTIL_LEAD, h2_tail)) || test(&UNTIL_LEAD, h2_tail);
            let multi = test(&MULTI, between);
            if !multi && (range_symbol || from_to) {
                let (mut start, mut end) = (h1.at, h2.at);
                if start > end {
                    std::mem::swap(&mut start, &mut end);
                }
                schedules.push(Schedule { range: true, start, end: Some(end), all_day: !h1.has_time && !h2.has_time });
                i += 2;
                continue;
            }
        }
        // 날짜 말(월, 일, 내일, 요일 …) 없이 시각만 적은 말("치과 2시")
        let has_date_word = test(&DATE_WORD, &hits[i].text);
        let mut start = hits[i].at;
        // "10월 31일 치과 오후 3시": 시각만 적은 말은 앞의 (시각 없는) 날짜에 붙인다
        if !has_date_word && hits[i].has_time {
            if let Some(prev) = schedules.last_mut().filter(|p| !p.range && p.all_day) {
                prev.start = with_time(prev.start, &hits[i].at);
                prev.all_day = false;
                i += 1;
                continue;
            }
            if let Some(day) = default_day {
                start = with_time(day, &hits[i].at);
            }
        }
        schedules.push(Schedule { range: false, start, end: None, all_day: !hits[i].has_time });
        i += 1;
    }

    // 같은 날 · 같은 시각의 같은 일정은 한 번만
    let mut normalized: Vec<Schedule> = vec![];
    for s in schedules {
        if !normalized.contains(&s) {
            normalized.push(s);
        }
    }
    Parsed { hits, title, schedules: normalized, empty_title, needs_date_choice: false }
}
