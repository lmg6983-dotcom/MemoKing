//! 매직 에이전트 (app/js/core/agent.js) — 목록 검색창 ✦ · 매직키 AI 줄. 쓴 말이 질문인지 할 일인지 가려서:
//!   answer 메모에서 찾은 답 · summary 찾은 메모 요약 · event 일정 넣기 · memo 새 메모 · 할 일 · append 찾은 메모 끝에 덧붙이기
//!   바꾸는 일(event · memo · append)은 확인 카드로 — 작은 모델(3B)은 고르기를 자주 틀려 말 모양으로 먼저 가르고 애매한 명령만 모델에 묻는다.
//!   가른 것(intent)은 JS 와 같은 JSON 모양 ({ action, … })
use crate::body::{extract_title, is_locked_body};
use crate::date_detect::{find_dates, guess_title, Found};
use crate::js::{self, re, slice16};
use crate::rag::Picked;
use crate::search::{choseong_start, matcher};
use chrono::{DateTime, Datelike, Duration, Local, Timelike, Utc};
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

type T = DateTime<Local>;

pub const ACTIONS: [&str; 5] = ["answer", "summary", "event", "memo", "append"];

macro_rules! regex {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re($pattern));
    };
}

// 부탁 끝말 — 할 일 이름 · 내용에서 뺀다
regex!(ASK_TAIL, r"\s*(?:좀\s*)?(?:해\s*줘|해\s*주세요|해\s*줄래\??|해\s*줄\s*수\s*있어\??|부탁해(?:요)?|해\s*봐|하자|해요|할래|해|줘|주세요)\s*[.!?~]*\s*$");
regex!(EVENT_VERB, r"(알려\s*(?:줘|주세요|줄래)|알림|리마인드|일정|예약|약속\s*잡|잡아\s*(?:줘|주세요)|등록|챙겨\s*(?:줘|주세요)|깨워|기억해\s*(?:줘|주세요)|넣어\s*(?:줘|주세요)|추가해\s*(?:줘|주세요))");
// 일정을 넣으라고 시키는 말 — 이게 없으면 질문("치과 예약 몇 시였지?")은 일정 넣기가 아니다
regex!(EVENT_DO, r"(알려\s*(?:줘|주세요|줄래)|등록|잡아\s*(?:줘|주세요)|넣어\s*(?:줘|주세요)|추가해\s*(?:줘|주세요)|챙겨\s*(?:줘|주세요)|깨워|기억해\s*(?:줘|주세요)|리마인드|알림\s*(?:줘|주세요|설정|맞춰))");
regex!(SUMMARY_VERB, r"(요약|정리|간추려|한눈에)\s*(?:해|좀|해서|해줘|해 줘|해주세요|해 주세요|부탁|$)|요약$|정리$");
regex!(MEMO_VERB, r"(?:(메모|노트|할\s*일|할일|체크\s*리스트|체크리스트|목록|리스트|투두)(?:를|을|로|으로)?\s*(?:하나\s*)?(?:만들어|써|작성|남겨|적어|새로)|^(?:메모|기록)\s*(?:해|해줘|해 줘|해주세요|남겨))");
regex!(APPEND, r"^(.+?)\s*(?:메모|노트|목록|리스트)?\s*(?:에|에다|에다가)\s+(.+?)\s*(?:을|를)?\s*(?:추가|덧붙|붙여|적어|넣어|기록|더해)");
regex!(MEMO_WORDS, r"\s*(?:(?:메모|노트|할\s*일|할일|체크\s*리스트|체크리스트|목록|리스트|투두)(?:를|을|로|으로)?\s*)?(?:하나\s*)?(?:만들어|써|작성해|작성|남겨|적어)\s*(?:줘|주세요|줄래)?\s*$");
regex!(QUESTION, r"[?？]\s*$|(?:알려\s*(?:줘|주세요|줄래)|찾아\s*(?:줘|주세요)|말해\s*(?:줘|주세요)|뭐|무엇|언제|어디|누구|누가|몇|얼마|어떻게|어떤|왜|있나|있어\s*\??$|했나|했지|였지|이었지|인가|일까|나요|까요|니\s*\??$|냐\s*\??$|야\s*\??$)");
// 일정 이름에서 뺄 부탁 말 ("치과 예약 알려줘" → "치과 예약")
regex!(EVENT_ASK, r"\s*(?:(?:일정|알림|알람|리마인드)(?:으로|로|을|를)?\s*)?(?:알려|알림|등록|리마인드|잡아|챙겨|깨워|기억해|넣어|추가해|추가|설정|맞춰)?\s*(?:해\s*)?(?:줘|주세요|줄래|해|하기|할래|부탁해)?\s*[.!?~]*\s*$");

fn test(r: &Regex, s: &str) -> bool {
    r.is_match(s).unwrap_or(false)
}

/// String(s ?? '') 의 빈칸을 하나로, 앞뒤 빈칸 없이
fn clean(s: &str) -> String {
    s.split(js::is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// JSON 값 → clean (null · 없음은 '')
fn clean_v(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        clean(&js::string(v))
    }
}

fn strip_ask(s: &str) -> String {
    clean(&ASK_TAIL.replace(s, ""))
}

/// toISOString
fn iso(t: T) -> String {
    t.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// 쉼표 · "랑" · "하고" · 줄로 나눈 항목들 ("우유, 계란이랑 빵" → [우유, 계란, 빵])
pub fn split_items(text: &str) -> Vec<String> {
    regex!(SPLIT, r"\s*(?:\n|,|，|、|·|;|(?<=\S)(?:이랑|랑|하고|와|과)\s+)\s*");
    regex!(BULLET, r"^[-*•]\s*");
    regex!(PARTICLE, r"\s*(?:을|를|도)$");
    SPLIT
        .split(text)
        .flatten()
        .map(|s| js::trim(&PARTICLE.replace(&BULLET.replace(s, ""), "")).to_string())
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 80)
        .collect()
}

/// 앞으로의 날짜 (되풀이는 지났어도)
fn next_when(t: &str, now: T) -> Option<Found> {
    find_dates(t, now).into_iter().find(|d| d.at > now || d.repeat.is_some())
}

/// 말 모양으로 가르기 → { action, … } — 확실하지 않으면 { action: 'answer', unsure } (unsure: 명령처럼 보이는데 못 가름 → 모델에 묻는다)
pub fn detect_intent(text: &str, now: T) -> Value {
    let t = clean(text);
    if t.is_empty() {
        return json!({ "action": "answer" });
    }
    let question = test(&QUESTION, &t) && (!test(&ASK_TAIL, &t) || test(&re("알려|찾아|말해"), &t));
    // 덧붙이기: "회의록에 다음 주 발표 추가해줘" — "금요일 2시에 치과 예약 추가해줘" 의 "금요일 2시" 는 메모가 아니라 때
    if let Some(ap) = APPEND.captures(t.as_str()).ok().flatten() {
        if !question && !is_when(&ap[1], now) {
            return json!({ "action": "append", "target": clean(&ap[1]), "content": strip_ask(&ap[2]) });
        }
    }
    // 일정: 앞으로의 날짜 + 알려줘 · 등록 · 예약 … (질문이면 시키는 말이 있을 때만)
    let when = next_when(&t, now);
    if let Some(w) = when.as_ref().filter(|_| test(&EVENT_VERB, &t) && (!question || test(&EVENT_DO, &t))) {
        return with_action("event", event_fields(&t, w));
    }
    if test(&SUMMARY_VERB, &t) && !question {
        return json!({ "action": "summary", "topic": summary_topic(&t) });
    }
    if let Some(mm) = MEMO_VERB.captures(t.as_str()).ok().flatten() {
        return with_action("memo", memo_fields(&t, &mm));
    }
    // 날짜만 있고 명령 꼴이면 ("금요일 3시 치과" 처럼 질문이 아닌 짧은 줄) 일정으로 묻는다
    if let Some(w) = when.as_ref().filter(|_| !question) {
        let mut v = with_action("event", event_fields(&t, w));
        v["unsure"] = true.into();
        return v;
    }
    json!({ "action": "answer", "unsure": !question && test(&ASK_TAIL, &t) })
}

fn with_action(action: &str, fields: Value) -> Value {
    let mut v = json!({ "action": action });
    v.as_object_mut().unwrap().extend(fields.as_object().cloned().unwrap_or_default());
    v
}

/// 글이 날짜 · 시각 말뿐인가 ("금요일 2시", "내일 오후 3시에")
fn is_when(s: &str, now: T) -> bool {
    let ds = find_dates(s, now);
    if ds.is_empty() {
        return false;
    }
    let mut rest = s.to_string();
    for d in ds.iter().rev() {
        rest = format!("{}{}", &rest[..d.from], &rest[d.to..]);
    }
    js::trim(&re("(?:에|에는|쯤|경|까지|부터)").replace_all(&rest, "")).is_empty()
}

fn event_fields(t: &str, when: &Found) -> Value {
    regex!(TAIL, r"\s*(?:에|을|를|좀|으로|로|라고|이라고|일정|알림)$");
    let mut title = clean(&guess_title(t, when.from, when.to));
    for _ in 0..3 {
        title = clean(&TAIL.replace(&EVENT_ASK.replace(&ASK_TAIL.replace(&title, ""), ""), ""));
    }
    let title = slice16(&title, 60);
    let mut w = json!({ "at": iso(when.at), "hasTime": when.has_time, "repeat": when.repeat });
    if let Some(end) = when.end {
        w["end"] = iso(end).into();
    }
    w["text"] = when.text.clone().into();
    let fallback = if test(&re("깨워|알람"), t) { "알람" } else { "일정" };
    json!({ "title": if title.is_empty() { fallback.to_string() } else { title }, "when": w })
}

fn memo_fields(t: &str, m: &fancy_regex::Captures<str>) -> Value {
    regex!(LIST_WORD, r"할\s*일|할일|체크\s*리스트|체크리스트|목록|리스트|투두");
    regex!(OBJECT, r"(?:을|를|로|으로)$");
    regex!(KIND_TAIL, r"\s*(?:메모|노트|할\s*일|목록|리스트|체크\s*리스트|투두)$");
    regex!(ASK_HEAD, r"^\s*(?:줘|주세요|해\s*줘|해줘|해주세요)\s*");
    regex!(COMMA, "[,，、]");
    let list = test(&LIST_WORD, m.get(1).map_or("", |g| g.as_str()));
    // "장보기 목록 만들어줘: 우유, 계란" · "우유 계란 사야 하는 거 메모해줘"
    let all = m.get(0).unwrap();
    let (head, tail) = match t.find(':') {
        Some(i) => (&t[..i], &t[i + 1..]),
        None => (&t[..all.start()], &t[all.end()..]),
    };
    let title = slice16(&KIND_TAIL.replace(&strip_ask(&OBJECT.replace(&MEMO_WORDS.replace(head, ""), "")), ""), 60);
    let rest = strip_ask(&ASK_HEAD.replace(tail, ""));
    let mut items = if list { split_items(&rest) } else { vec![] };
    if list && items.is_empty() && test(&COMMA, &title) {
        items = split_items(&title); // "우유, 계란 할 일로 만들어줘"
    }
    let title = if !items.is_empty() && test(&COMMA, &title) { String::new() } else { title };
    json!({ "title": title, "list": list, "items": items, "text": if list { String::new() } else { rest } })
}

fn summary_topic(t: &str) -> String {
    regex!(FILLER, r"(?:을|를|좀|에\s*대해|관련|내용|메모들?|것들?)(?=\s|$)");
    let topic = clean(&FILLER.replace_all(&ASK_TAIL.replace(&SUMMARY_VERB.replace(t, " "), ""), " "));
    if topic.is_empty() {
        t.to_string()
    } else {
        topic
    }
}

/// 애매한 명령만: 모델이 할 일을 고른다 (JSON) → (messages, schema)
pub fn plan_messages(text: &str) -> (Value, Value) {
    (
        json!([
            { "role": "system", "content": "너는 메모 앱의 비서다. 사용자의 말이 무엇을 바라는지 하나를 고른다. answer: 메모에서 무엇을 찾아 답하기, summary: 메모들을 요약 · 정리, event: 일정 · 알림 등록, memo: 새 메모나 할 일 목록 만들기, append: 이미 있는 메모에 내용 덧붙이기. target 은 덧붙일 메모 이름, content 는 덧붙이거나 새로 쓸 내용, title 은 일정이나 새 메모의 짧은 이름이다. 모르면 answer." },
            { "role": "user", "content": text },
        ]),
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ACTIONS },
                "title": { "type": "string", "maxLength": 60 },
                "target": { "type": "string", "maxLength": 60 },
                "content": { "type": "string", "maxLength": 600 },
            },
            "required": ["action"],
        }),
    )
}

/// 모델이 고른 것(JSON 글) → detect_intent 와 같은 꼴. 엉뚱하거나 필요한 것이 없으면 answer
pub fn plan_result(answer: &str, text: &str, now: T) -> Value {
    let Ok(p) = serde_json::from_str::<Value>(answer) else { return json!({ "action": "answer" }) };
    let t = clean(text);
    match p["action"].as_str() {
        Some("event") => {
            // 날짜는 해석기가 찾은 것만 — 모델이 지은 날짜는 믿지 않는다
            let Some(when) = next_when(&t, now) else { return json!({ "action": "answer" }) };
            let mut v = with_action("event", event_fields(&t, &when));
            let title = slice16(&clean_v(&p["title"]), 60);
            if !title.is_empty() {
                v["title"] = title.into();
            }
            v
        }
        Some("append") if !clean_v(&p["target"]).is_empty() && !clean_v(&p["content"]).is_empty() => {
            json!({ "action": "append", "target": clean_v(&p["target"]), "content": clean_v(&p["content"]) })
        }
        Some("memo") => {
            let items = split_items(&if p["content"].is_null() { String::new() } else { js::string(&p["content"]) });
            let list = items.len() > 1;
            json!({ "action": "memo", "title": slice16(&clean_v(&p["title"]), 60), "list": list, "items": if list { items } else { vec![] }, "text": if list { String::new() } else { clean_v(&p["content"]) } })
        }
        Some("summary") => json!({ "action": "summary", "topic": summary_topic(&t) }),
        _ => json!({ "action": "answer" }),
    }
}

/// 덧붙일 메모 후보 (제목이 맞는 것부터, 잠긴 메모 빼고) → [{ id, title }] 최대 5. memos: (id, 본문, 고친 때)
pub fn append_targets(target: &str, memos: &[(String, String, Option<String>)]) -> Vec<Value> {
    let open: Vec<_> = memos.iter().filter(|m| !is_locked_body(&m.1)).collect();
    let key = re(r"\s*(?:메모|노트)$").replace(&clean(target), "").to_lowercase();
    let titled: Vec<(&str, String)> = open.iter().map(|m| (m.0.as_str(), Some(extract_title(&m.1)).filter(|t| !t.is_empty()).unwrap_or_else(|| "제목 없음".into()))).collect();
    let exact = titled.iter().filter(|m| m.1.to_lowercase() == key);
    let starts = titled.iter().filter(|m| m.1.to_lowercase() != key && m.1.to_lowercase().contains(&key));
    let found = search_titles(&open, &key).into_iter().filter_map(|id| titled.iter().find(|m| m.0 == id));
    let mut out: Vec<&(&str, String)> = vec![];
    for m in exact.chain(starts).chain(found) {
        if !out.iter().any(|o| o.0 == m.0) {
            out.push(m);
        }
    }
    out.into_iter().take(5).map(|m| json!({ "id": m.0, "title": m.1 })).collect()
}

/// memo-search.js searchMemos 를 제목으로만 (에이전트는 본문 글을 넘기지 않는다) → 맞는 id 최대 5개, 점수 · 최근 것부터
fn search_titles<'a>(memos: &[&'a (String, String, Option<String>)], query: &str) -> Vec<&'a str> {
    let q = js::trim(query).to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let terms: Vec<&str> = q.split(js::is_space).filter(|t| !t.is_empty()).collect();
    let matches = matcher(&q);
    let mut found = vec![];
    for m in memos {
        let title = extract_title(&m.1);
        let lt = title.to_lowercase();
        if !matches(&[&title, ""]) {
            continue;
        }
        let mut score = 0;
        if lt.contains(&q) {
            score += 4; // 제목에 찾는 말 그대로
        }
        if lt.starts_with(&q) {
            score += 2;
        }
        score += terms.iter().filter(|t| lt.contains(*t)).count();
        // 초성(ㄱㅈㅅ)도 글자로 찾은 것처럼 — 제목 첫머리면 더
        for t in &terms {
            if lt.contains(t) {
                continue;
            }
            if let Some(at) = choseong_start(&title, t) {
                score += if terms.len() == 1 { 4 + if at == 0 { 2 } else { 0 } } else { 1 };
            }
        }
        let at = m.2.as_deref().and_then(crate::time::parse_js_date).map_or(0, |d| d.timestamp_millis());
        found.push((m.0.as_str(), score, at));
    }
    found.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    found.into_iter().take(5).map(|f| f.0).collect()
}

/// 새 메모 본문: 제목 + (할 일이면 체크리스트, 아니면 글)
pub fn memo_body(intent: &Value) -> String {
    let title = clean_v(&intent["title"]);
    let head = if title.is_empty() { String::new() } else { format!("# {title}\n\n") };
    let items = intent["items"].as_array().filter(|i| !i.is_empty() && intent["list"] == true);
    if let Some(items) = items {
        return format!("{head}{}\n", items.iter().map(|i| format!("- [ ] {}", clean_v(i))).collect::<Vec<_>>().join("\n"));
    }
    format!("{head}{}\n", js::trim(&if intent["text"].is_null() { String::new() } else { js::string(&intent["text"]) }))
}

/// 덧붙일 글: 여러 항목이면 줄마다 "- "
pub fn append_text(content: &str) -> String {
    let items = split_items(content);
    if items.len() > 1 {
        items.iter().map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n")
    } else {
        clean(content)
    }
}

/// 요약 저장 본문: 제목 · 요약 · 출처 메모 ([[제목]] 연결)
pub fn summary_body(topic: &str, text: &str, source_titles: &[String]) -> String {
    let links: Vec<String> = source_titles.iter().map(|t| format!("- [[{}]]", if t.is_empty() { "제목 없음" } else { t })).collect();
    let topic = slice16(&clean(topic), 50);
    let text = re(r"\s*\[\d+\]").replace_all(text, "");
    format!("# {} 요약\n\n{}\n\n출처\n{}\n", if topic.is_empty() { "요약" } else { &topic }, js::trim(&text), links.join("\n"))
}

/// 요약하기: 찾은 메모들만 근거로, 번호로 출처를 달게
pub fn summary_messages(topic: &str, picked: &[Picked]) -> Value {
    let mut budget: i64 = 2400;
    let mut parts = vec![];
    for (i, m) in picked.iter().enumerate() {
        let text = slice16(&m.texts.join("\n"), budget.max(0) as usize);
        budget -= text.encode_utf16().count() as i64;
        if !text.is_empty() {
            parts.push(format!("[{}] {}\n{text}", i + 1, m.title));
        }
    }
    json!([
        { "role": "system", "content": "너는 사용자의 메모를 요약하는 비서다. 아래 [번호] 메모에 적힌 것만으로 한국어 해요체 요약을 쓴다. 중요한 것부터 \"- \" 로 시작하는 줄 3~6개로 쓰고, 줄 끝에 근거 메모 번호를 [1]처럼 붙인다. 메모에 없는 것은 쓰지 않는다." },
        { "role": "user", "content": format!("메모:\n{}\n\n요약할 것: {topic}", parts.join("\n\n")) },
    ])
}

// ---------- 일정 묻기 ("내일 뭐 있어?" · "이번 주 회의 언제야") — 메모 글이 아니라 일정 탭에서 바로 ----------

pub struct ScheduleQuery {
    pub from: T,
    pub to: T,
    pub label: String,
    pub words: Vec<String>,
}

/// 일정을 묻는 말이면 그 기간과 찾을 말
pub fn schedule_query(text: &str, now: T) -> Option<ScheduleQuery> {
    regex!(SCHEDULE_ASK, r"(일정|약속|스케줄|계획|뭐\s*있|무슨\s*일|할\s*일|회의|미팅|마감|예약)");
    regex!(STOP, r"^(오늘|내일|모레|이번|다음|주|달|금주|일정|약속|스케줄|계획|뭐|무슨|있어|있나|있지|언제|몇|시|몇시|할|일|알려줘|알려|좀|나|내|다가오는|앞으로|곧)$");
    regex!(ENDING, r"(?:은|는|이|가|을|를|에|에는|도|이야|야|이지|지)$");
    let t = clean(text);
    if !test(&SCHEDULE_ASK, &t) || !test(&QUESTION, &t) {
        return None;
    }
    let (y, m, d) = (i64::from(now.year()), i64::from(now.month0()), i64::from(now.day()));
    let day = |n: i64| crate::time::js_local(y, m, d + n, 0, 0);
    let monday = |n: i64| day(-((i64::from(now.weekday().num_days_from_sunday()) + 6) % 7) + n * 7);
    let month = |n: i64| crate::time::js_local(y, m + n, 1, 0, 0);
    let has = |p: &str| test(&re(p), &t);
    let range = if has("오늘") {
        Some((day(0), day(1), "오늘".to_string()))
    } else if has("모레") {
        Some((day(2), day(3), "모레".into()))
    } else if has("내일") {
        Some((day(1), day(2), "내일".into()))
    } else if has(r"다음\s*주") {
        Some((monday(1), monday(2), "다음 주".into()))
    } else if has(r"이번\s*주|금주") {
        Some((day(0), monday(1), "이번 주".into()))
    } else if has(r"다음\s*달") {
        Some((month(1), month(2), "다음 달".into()))
    } else if has(r"이번\s*달") {
        Some((day(0), month(1), "이번 달".into()))
    } else if let Some(f) = find_dates(&t, now - Duration::days(1)).into_iter().find(|x| x.repeat.is_none()) {
        let a = f.at;
        let start = crate::time::js_local(a.year().into(), a.month0().into(), a.day().into(), 0, 0);
        Some((start, crate::time::js_local(a.year().into(), a.month0().into(), i64::from(a.day()) + 1, 0, 0), f.text))
    } else if has(r"다가오는|앞으로|곧|다음\s*일정") {
        Some((now, day(14), "앞으로 2주".into()))
    } else {
        None
    };
    let (from, to, label) = range?;
    // 찾을 말: 일정 이름에 들어갈 만한 말만 ("내일 회의 몇 시야" → 회의)
    let words = re("[?？.!]")
        .replace_all(&t, " ")
        .split(js::is_space)
        .map(|w| ENDING.replace(w, "").into_owned())
        .filter(|w| w.encode_utf16().count() >= 2 && !test(&STOP, w) && !test(&re("일정|약속|스케줄"), w))
        .collect();
    Some(ScheduleQuery { from, to, label, words })
}

pub struct Event {
    pub at: T,
    pub title: String,
    pub memo_id: String,
    pub all_day: bool,
}

/// 그 기간의 일정 회차 (시각 순, 잠긴 메모 · 꺼진 일정 빼고). all: vault.all_reminders()
///   찾을 말이 있으면 그 말이 든 일정만 — 없으면 [] (부른 쪽이 메모에서 찾는다)
pub fn events_in(all: &[Value], q: &ScheduleQuery) -> Vec<Event> {
    let mut out = vec![];
    for e in all {
        let r = &e["reminder"];
        if e["locked"] == true || r["enabled"] != true {
            continue;
        }
        let name = [&r["title"], &e["title"]].iter().filter_map(|v| v.as_str()).find(|s| !s.is_empty()).unwrap_or("일정").to_string();
        for at in crate::reminders::occurrences_between(r, q.from, q.to) {
            out.push(Event { at, title: name.clone(), memo_id: e["memoId"].as_str().unwrap_or_default().into(), all_day: r["allDay"] == true });
        }
    }
    out.sort_by_key(|e| e.at);
    if q.words.is_empty() {
        out
    } else {
        out.into_iter().filter(|e| q.words.iter().any(|w| e.title.contains(w.as_str()))).collect()
    }
}

/// 일정 답 글: "내일 일정이에요.\n- 오후 3:00 거래처 미팅 [1]" (번호는 출처 메모) → (글, 출처 메모 id 차례)
pub fn schedule_text(q: &ScheduleQuery, events: &[Event]) -> (String, Vec<String>) {
    let mut ids: Vec<String> = vec![];
    for e in events {
        if !ids.contains(&e.memo_id) {
            ids.push(e.memo_id.clone());
        }
    }
    if events.is_empty() {
        return (format!("{} 일정은 없어요.", q.label), ids);
    }
    let same_day = q.to - q.from <= Duration::days(1);
    let lines: Vec<String> = events
        .iter()
        .take(12)
        .map(|e| {
            let d = e.at;
            let day = if same_day { String::new() } else { format!("{}/{}({}) ", d.month(), d.day(), "일월화수목금토".chars().nth(d.weekday().num_days_from_sunday() as usize).unwrap()) };
            let time = if e.all_day { "하루 종일".to_string() } else { format!("{} {}:{:02}", if d.hour() < 12 { "오전" } else { "오후" }, (d.hour() + 11) % 12 + 1, d.minute()) };
            format!("- {day}{time} {} [{}]", e.title, ids.iter().position(|i| *i == e.memo_id).unwrap() + 1)
        })
        .collect();
    let more = if events.len() > 12 { format!("\n외 {}개", events.len() - 12) } else { String::new() };
    (format!("{} 일정이에요.\n{}{more}", q.label, lines.join("\n")), ids)
}

/// 새 메모 · 할 일인데 내용이 없을 때 ("출시 준비 체크리스트 만들어줘"): 모델이 초안 항목을 짓는다 → (messages, schema)
pub fn memo_draft_messages(text: &str, intent: &Value) -> (Value, Value) {
    let list = intent["list"] == true;
    let system = if list {
        "너는 메모 앱의 비서다. 사용자의 부탁에 맞는 할 일 목록을 짓는다. title 은 목록의 짧은 이름, items 는 할 일 3~8개다. 각 항목은 짧은 명사구나 동사구로 쓴다."
    } else {
        "너는 메모 앱의 비서다. 사용자의 부탁에 맞는 메모를 짓는다. title 은 짧은 이름, body 는 메모 내용(몇 줄)이다. 모르는 사실은 [ ] 칸으로 비워 둔다."
    };
    let schema = if list {
        json!({ "type": "object", "properties": { "title": { "type": "string", "maxLength": 40 }, "items": { "type": "array", "items": { "type": "string", "maxLength": 60 }, "maxItems": 10 } }, "required": ["title", "items"] })
    } else {
        json!({ "type": "object", "properties": { "title": { "type": "string", "maxLength": 40 }, "body": { "type": "string", "maxLength": 800 } }, "required": ["title", "body"] })
    };
    (json!([{ "role": "system", "content": system }, { "role": "user", "content": text }]), schema)
}

/// 초안 답(JSON 글) → intent 에 채운 것 (엉뚱하면 그대로)
pub fn memo_draft_result(answer: &str, intent: &Value) -> Value {
    let Some(d) = serde_json::from_str::<Value>(answer).ok().filter(Value::is_object) else { return intent.clone() };
    let own = clean_v(&intent["title"]);
    let title = if own.is_empty() { slice16(&clean_v(&d["title"]), 60) } else { own };
    let mut out = intent.clone();
    if intent["list"] == true {
        let items: Vec<String> = d["items"].as_array().into_iter().flatten().map(clean_v).filter(|s| !s.is_empty()).take(10).collect();
        if items.is_empty() {
            return out;
        }
        out["items"] = json!(items);
    } else {
        let text = slice16(js::trim(&if d["body"].is_null() { String::new() } else { js::string(&d["body"]) }), 2000);
        if text.is_empty() {
            return out;
        }
        out["text"] = text.into();
    }
    out["title"] = title.into();
    out["drafted"] = true.into();
    out
}

/// 넘긴 글 → 메모 본문 (memo-text.js memoBodyFromText): 앞 빈 줄 · 뒤 빈칸은 빼고 줄바꿈은 그대로
fn memo_body_from_text(text: &str) -> String {
    let t = text.replace("\r\n", "\n");
    js::trim_end(&re(r"^\s*\n+").replace(&t, "")).to_string()
}

/// 있는 메모 끝에 글을 덧붙인 본문 (memo-text.js appendToBody) — 빈 줄 하나를 두고 (빈 글이면 None)
pub fn append_to_body(body: &str, text: &str) -> Option<String> {
    let add = memo_body_from_text(text);
    if add.is_empty() {
        return None;
    }
    let base = js::trim_end(body);
    Some(if base.is_empty() { format!("{add}\n") } else { format!("{base}\n\n{add}\n") })
}
