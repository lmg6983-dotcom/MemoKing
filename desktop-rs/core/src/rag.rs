//! AI 검색 — 내 메모에서 찾아 출처를 단 답 (app/js/core/rag.js). 찾기가 일을 대부분 하고 모델은 고른 메모만 보고 짧게 답한다.
//!   찾기: 낱말(TF-IDF) + 한글 두 글자 조각 + 제목에 든 말 · 물은 때에 고친 메모를 앞으로 + 그래프(index.json 의 related)
use crate::body::{extract_title, plain_lines};
use crate::indexer::{len16, tokenize};
use crate::js::{self, re};
use crate::tag_suggest::{cosine, Ordered};
use chrono::{DateTime, Datelike, Local};
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

const CHUNK: usize = 400; // 글자 — 한 조각이 문맥에 여럿 들어가게
const MAX_CHUNKS: usize = 20; // 메모 하나에서
const CONTEXT: usize = 2400; // 답할 때 모델에 주는 메모 글자
const MAX_WORDS: usize = 6; // 질문을 넓힐 낱말 수
const KEEP: f64 = 0.25; // 맨 위 메모 점수의 이만큼은 돼야 함께 보여 준다
const STRONG: f64 = 0.12; // 이만큼 맞으면 모델이 물러서도 문장을 그대로 보여 준다
pub const NOT_FOUND: &str = "메모에서 찾지 못했어요.";

// 물음 말 — 메모에 쓰였을 리 없어 찾기에서 뺀다
const ASK_WORDS: &[&str] = &[
    "뭐야", "뭐였지", "뭐지", "뭐", "무엇", "무엇이", "무엇인지", "언제", "언제야", "언제지", "언제였지", "어디", "어디야", "어디였지", "누구", "누구야", "누가", "몇", "몇시", "몇일", "며칠", "얼마", "얼마야", "어떻게",
    "어떤", "왜", "알려줘", "알려", "알려주세요", "있어", "있나", "있었지", "했어", "했지", "했나", "했었지", "였지", "이었지", "인가", "일까", "거야", "건가", "건지", "그거", "그게", "내가", "우리", "메모", "메모에서",
    "찾아줘", "찾아", "말해줘", "기억나", "해줘", "좀", "혹시", "있는지", "했는지", "인지",
];

// 비슷한 말 묶음 — 모델이 질문을 넓혀 주지 못할 때에도 찾게 (rag.js SYNONYMS 그대로)
const SYNONYMS: &[&[&str]] = &[
    &["비밀번호", "암호", "비번", "패스워드", "password"],
    &["와이파이", "wifi", "인터넷", "무선랜", "공유기"],
    &["아이디", "계정", "로그인"],
    &["가격", "단가", "금액", "비용", "요금", "값"],
    &["월세", "집세", "임대료", "방세"],
    &["이체", "송금", "입금", "보내"],
    &["계좌", "통장"],
    &["출시", "발매", "런칭", "릴리스", "내놓"],
    &["마감", "기한", "데드라인"],
    &["회의", "미팅"],
    &["일정", "스케줄", "약속"],
    &["담당자", "책임자"],
    &["비행기", "항공편", "항공권", "비행편"],
    &["여행", "휴가"],
    &["숙소", "호텔", "펜션", "숙박"],
    &["자동차", "차량", "차"],
    &["정비", "수리", "점검"],
    &["전화번호", "연락처"],
    &["주소", "위치"],
    &["생일", "생신"],
    &["식당", "맛집", "음식점"],
    &["요리", "레시피", "조리법"],
    &["운동", "헬스", "피트니스"],
    &["책", "도서"],
    &["병원", "의원", "진료"],
    &["오류", "에러", "버그", "장애"],
    &["영수증", "계산서"],
    &["사진", "이미지", "그림"],
];

static WORD_SPLIT: LazyLock<Regex> = LazyLock::new(|| re(r"[^\p{L}\p{N}]+"));
static HANGUL_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"^\p{Script=Hangul}{2,}$"));
static CITE: LazyLock<Regex> = LazyLock::new(|| re(r"\[(\d+)\]"));

/// 질문 낱말과 같은 묶음의 다른 말들 — 두 글자 이상은 앞머리로 맞추고, 한 글자("차")는 그 낱말일 때만
fn synonyms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let lower = query.to_lowercase();
    for w in WORD_SPLIT.split(&lower).flatten() {
        for group in SYNONYMS {
            let Some(hit) = group.iter().find(|k| w == **k || (len16(k) >= 2 && w.starts_with(**k))) else { continue };
            for k in group.iter().filter(|k| *k != hit) {
                if !out.iter().any(|o| o == k) {
                    out.push(k.to_string());
                }
            }
        }
    }
    out
}

/// 찾기 특징: 낱말 + 한글 낱말의 두 글자 조각 (조사 · 어미가 달라도 맞게)
fn features(text: &str, ask: bool) -> Vec<String> {
    let words: Vec<String> = tokenize(text).into_iter().filter(|w| !(ask && ASK_WORDS.contains(&w.as_str()))).collect();
    let mut out = words.clone();
    for w in words.iter().filter(|w| HANGUL_WORD.is_match(w).unwrap_or(false)) {
        let c: Vec<char> = w.chars().collect();
        out.extend(c.windows(2).map(|p| format!("·{}{}", p[0], p[1])));
    }
    out
}

/// 메모 → 조각 글들 (줄을 모아 CHUNK 자 안팎, 조각마다 앞에 제목)
pub fn chunk_memo(body: &str) -> Vec<String> {
    let title = extract_title(body);
    let mut out = vec![];
    let mut cur = String::new();
    for line in plain_lines(body, usize::MAX).into_iter().skip(1) {
        if !cur.is_empty() && len16(&cur) + len16(&line) > CHUNK {
            out.push(std::mem::take(&mut cur));
        }
        cur = if cur.is_empty() { line } else { format!("{cur}\n{line}") };
    }
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out.into_iter().take(MAX_CHUNKS).map(|t| js::trim(&format!("{title}\n{t}")).to_string()).collect()
}

/// 물은 때: "오늘 · 어제 · 이번 주 · 지난주 · 이번 달 · 지난달 · 올해" → (from, to)
pub fn asked_period(question: &str, now: DateTime<Local>) -> Option<(DateTime<Local>, DateTime<Local>)> {
    let (y, m, d) = (i64::from(now.year()), i64::from(now.month0()), i64::from(now.day()));
    let day = |n: i64| crate::time::js_local(y, m, d + n, 0, 0);
    let mon = -i64::from(now.weekday().num_days_from_monday());
    let month = |k: i64| crate::time::js_local(y, m + k, 1, 0, 0);
    let has = |p: &str| re(p).is_match(question).unwrap_or(false);
    Some(if has("오늘") {
        (day(0), day(1))
    } else if has("어제") {
        (day(-1), day(0))
    } else if has("그저께|그제") {
        (day(-2), day(-1))
    } else if has(r"지난\s*주|저번\s*주") {
        (day(mon - 7), day(mon))
    } else if has(r"이번\s*주|금주") {
        (day(mon), day(mon + 7))
    } else if has(r"지난\s*달|저번\s*달") {
        (month(-1), month(0))
    } else if has(r"이번\s*달") {
        (month(0), month(1))
    } else if has("올해|금년") {
        (crate::time::js_local(y, 0, 1, 0, 0), crate::time::js_local(y + 1, 0, 1, 0, 0))
    } else {
        return None;
    })
}

fn term_counts(list: &[String]) -> Ordered<f64> {
    let mut tf = Ordered::new();
    for t in list {
        *tf.entry(t, || 0.0) += 1.0;
    }
    tf
}

/// tf-idf (indexer.js 와 같은 셈), 길이 1로
fn weigh(tf: &Ordered<f64>, df: &HashMap<String, f64>, n: f64) -> Ordered<f64> {
    let mut v = Ordered::new();
    let mut norm = 0.0;
    for (t, count) in &tf.items {
        let w = (1.0 + count.ln()) * (1.0 + n / df.get(t).copied().unwrap_or(1.0)).ln();
        v.set(t, w);
        norm += w * w;
    }
    let norm = if norm == 0.0 { 1.0 } else { norm.sqrt() };
    for (_, w) in &mut v.items {
        *w /= norm;
    }
    v
}

/// 찾기에 쓰는 조각 하나
pub struct Chunk {
    pub id: String,
    pub title: String,
    pub text: String,
    pub updated: Option<String>,
}

pub struct Index {
    chunks: Vec<Chunk>,
    df: HashMap<String, f64>,
    vecs: Vec<Ordered<f64>>,
}

/// 찾기 색인: 조각마다 tf-idf 벡터
pub fn build_index(chunks: Vec<Chunk>) -> Index {
    let mut df: HashMap<String, f64> = HashMap::new();
    let tfs: Vec<Ordered<f64>> = chunks
        .iter()
        .map(|c| {
            let tf = term_counts(&features(&c.text, false));
            for (t, _) in &tf.items {
                *df.entry(t.clone()).or_default() += 1.0;
            }
            tf
        })
        .collect();
    let n = chunks.len() as f64;
    let vecs = tfs.iter().map(|tf| weigh(tf, &df, n)).collect();
    Index { chunks, df, vecs }
}

/// 찾은 메모 하나
#[derive(Clone)]
pub struct Picked {
    pub id: String,
    pub title: String,
    pub score: f64,
    pub via: &'static str, // "match" | "graph"
    pub texts: Vec<String>,
}

impl Picked {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "title": self.title, "score": js::num(self.score), "via": self.via, "texts": self.texts })
    }
}

/// 관련 메모 찾기. words: 질문을 넓힌 낱말 · related: 메모 id → 그래프의 관련 메모 (id, 관련도)
pub fn retrieve(query: &str, index: &Index, words: &[String], related: &dyn Fn(&str) -> Vec<(String, f64)>, limit: usize, now: DateTime<Local>) -> Vec<Picked> {
    if index.chunks.is_empty() {
        return vec![];
    }
    let mut qf = features(query, true);
    for w in words.iter().cloned().chain(synonyms(query)) {
        qf.extend(features(&w, false));
    }
    if qf.is_empty() {
        return vec![];
    }
    let q = weigh(&term_counts(&qf), &index.df, index.chunks.len() as f64 + 1.0);
    let asked: HashSet<String> = tokenize(query).into_iter().filter(|w| !ASK_WORDS.contains(&w.as_str())).collect();
    let period = asked_period(query, now);
    let in_period = |c: &Chunk| {
        let (Some((from, to)), Some(t)) = (period, c.updated.as_deref().and_then(crate::time::parse_js_date)) else { return false };
        t >= from.fixed_offset() && t < to.fixed_offset()
    };
    let mut ranked: Vec<(usize, f64)> = index
        .vecs
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let c = &index.chunks[i];
            let mut s = cosine(&q, v);
            if s <= 0.0 {
                return (i, 0.0);
            }
            if tokenize(&c.title).iter().any(|w| asked.contains(w)) {
                s *= 1.3; // 제목에 물은 말
            }
            if in_period(c) {
                s *= 1.5;
            }
            (i, s)
        })
        .filter(|(_, s)| *s > 0.0)
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut memos: Ordered<Picked> = Ordered::new();
    for (i, score) in &ranked {
        let c = &index.chunks[*i];
        let m = memos.entry(&c.id, || Picked { id: c.id.clone(), title: c.title.clone(), score: *score, via: "match", texts: vec![] });
        if m.texts.len() < 3 {
            m.texts.push(c.text.clone());
        }
    }
    let best = ranked.first().map_or(0.0, |r| r.1);
    let mut top: Vec<Picked> = memos.items.iter().map(|(_, m)| m).filter(|m| m.score >= best * KEEP).take(limit).cloned().collect();
    // 그래프: 찾은 메모와 연결 · 비슷한 메모 (찾기에서 놓친 것) — 앞 메모 점수의 절반 × 관련도
    let by_id: HashMap<&str, &Chunk> = index.chunks.iter().map(|c| (c.id.as_str(), c)).collect(); // 같은 메모면 마지막 조각 (JS Map 처럼)
    for m in top.clone().iter().take(2) {
        for (rid, rscore) in related(&m.id).into_iter().take(2) {
            let Some(c) = by_id.get(rid.as_str()).filter(|_| memos.get(&rid).is_none()) else { continue };
            let g = Picked { id: rid.clone(), title: c.title.clone(), score: m.score * 0.5 * rscore, via: "graph", texts: vec![c.text.clone()] };
            memos.set(&rid, g.clone());
            top.push(g);
        }
    }
    top.sort_by(|a, b| b.score.total_cmp(&a.score));
    top.truncate(limit + 1);
    top
}

/// 질문 넓히기: 메모에 쓰였을 만한 비슷한 말 · 바꿔 쓴 말 → (messages, schema)
pub fn expand_messages(question: &str) -> (Value, Value) {
    (
        json!([
            { "role": "system", "content": format!("너는 메모 검색을 돕는다. 질문의 답이 적힌 메모에 쓰였을 만한 한국어 낱말을 {MAX_WORDS}개까지 고른다. 질문의 낱말과 비슷한 말, 바꿔 쓴 말, 줄임말을 넣는다. 낱말만 쓴다.") },
            { "role": "user", "content": question },
        ]),
        json!({ "type": "object", "properties": { "words": { "type": "array", "items": { "type": "string", "maxLength": 20 }, "maxItems": MAX_WORDS } }, "required": ["words"] }),
    )
}

/// 넓힌 낱말 답(JSON 글) → 낱말들 (엉뚱한 답이면 [])
pub fn expand_result(answer: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(answer) else { return vec![] };
    let Some(words) = v["words"].as_array() else { return vec![] };
    words.iter().map(|w| js::trim(&js::string(w)).to_string()).filter(|w| !w.is_empty()).take(MAX_WORDS).collect()
}

/// 답하기: 고른 메모만 근거로, 번호로 출처를 달게 (오늘 날짜도)
pub fn rag_messages(question: &str, picked: &[Picked], now: DateTime<Local>) -> Value {
    const DAYS: [&str; 7] = ["일", "월", "화", "수", "목", "금", "토"];
    let mut budget = CONTEXT as i64;
    let mut parts = vec![];
    for (i, m) in picked.iter().enumerate() {
        let text = js::slice16(&m.texts.join("\n"), budget.max(0) as usize);
        budget -= len16(&text) as i64;
        if !text.is_empty() {
            parts.push(format!("[{}] {}\n{text}", i + 1, m.title));
        }
    }
    let today = format!("{}년 {}월 {}일 {}요일", now.year(), now.month(), now.day(), DAYS[now.weekday().num_days_from_sunday() as usize]);
    json!([
        { "role": "system", "content": format!("너는 사용자의 메모를 읽고 질문에 답하는 비서다. 오늘은 {today}이다. 아래 [번호] 메모는 질문과 관련되어 이미 찾아 놓은 참고 메모다. 이 메모들의 내용(비슷한 표현이나 간접적인 단서 포함)을 적극적으로 활용해 한국어 해요체로 1~3문장 답하고, 문장마다 끝에 반드시 근거 메모 번호를 [1]처럼 붙인다. 여러 메모를 참고했으면 [1][2]처럼 모두 붙인다. 질문과 조금이라도 관련된 내용이 있으면 절대 포기하지 말고 찾은 내용을 바탕으로 답한다. 모든 메모가 질문과 완전히 무관할 때만 \"{NOT_FOUND}\"라고 답한다. 메모에 없는 사실은 지어내지 않는다.") },
        { "role": "user", "content": format!("메모:\n{}\n\n질문: {question}", parts.join("\n\n")) },
    ])
}

/// 찾은 메모에서 질문(또는 넓힌 낱말)과 가장 맞는 문장 → (글, 몇 번 메모)
fn best_sentence(question: &str, picked: &[Picked], words: &[String]) -> Option<(String, usize)> {
    static SENTENCE_END: LazyLock<Regex> = LazyLock::new(|| re(r"(?<=[.!?。])\s+"));
    let mut qf: Vec<String> = vec![];
    for f in features(question, true).into_iter().chain(words.iter().flat_map(|w| features(w, false))) {
        if !qf.contains(&f) {
            qf.push(f);
        }
    }
    let mut best: Option<(String, usize, f64)> = None;
    for (i, m) in picked.iter().enumerate().filter(|(_, m)| m.via != "graph") {
        for text in &m.texts {
            for line in text.split('\n').skip(1) {
                for s in SENTENCE_END.split(line).flatten().map(js::trim).filter(|s| !s.is_empty()) {
                    let f: HashSet<String> = features(s, false).into_iter().collect();
                    let hit = qf.iter().filter(|x| f.contains(*x)).count();
                    if hit == 0 {
                        continue;
                    }
                    let score = hit as f64 / qf.len().max(1) as f64 + if i == 0 { 0.05 } else { 0.0 };
                    if best.as_ref().is_none_or(|b| score > b.2) {
                        best = Some((js::slice16(s, 200), i + 1, score));
                    }
                }
            }
        }
    }
    if let Some((t, n, _)) = best {
        return Some((t, n));
    }
    // 넓힌 낱말이나 제목으로 찾았는데 본문 문장에 겹치는 낱말이 없으면 첫 번째 매칭 메모의 핵심 줄
    let idx = picked.iter().position(|m| m.via != "graph")?;
    let first = &picked[idx];
    for text in &first.texts {
        if let Some(line) = text.split('\n').skip(1).map(js::trim).find(|l| !l.is_empty()) {
            return Some((js::slice16(line, 200), idx + 1));
        }
    }
    (!first.title.is_empty()).then(|| (js::slice16(&first.title, 200), idx + 1))
}

/// 모델 답 다듬기: 없는 번호는 지우고, 분명히 찾았는데 물러섰으면 메모의 문장을 그대로 → (글, 그대로 옮겼나)
pub fn finish_answer(answer: &str, question: &str, picked: &[Picked], words: &[String]) -> (String, bool) {
    let text = CITE
        .replace_all(js::trim(answer), |c: &fancy_regex::Captures<str>| {
            let n: f64 = c[1].parse().unwrap_or(f64::NAN);
            if n >= 1.0 && n <= picked.len() as f64 {
                c[0].to_string()
            } else {
                String::new()
            }
        })
        .into_owned();
    let cited = CITE.is_match(&text).unwrap_or(false);
    let gave_up = text.is_empty() || text.contains("찾지 못했") || (text.contains("없어요") && len16(&text) < 25 && !cited);
    let strong = picked.first().is_some_and(|p| p.via != "graph" && p.score >= STRONG);
    let s = if strong && (gave_up || !cited) { best_sentence(question, picked, words) } else { None };
    // 물러섰으면 문장을 그대로, 답은 했는데 번호가 없으면 근거 문장을 아래에 (지어낸 답인지 바로 보이게)
    match s {
        Some((t, n)) if gave_up => (format!("메모에 이렇게 적혀 있어요.\n“{t}” [{n}]"), true),
        Some((t, n)) => (format!("{text}\n근거: “{t}” [{n}]"), true),
        None if !gave_up && strong && !cited => (format!("{text} [1]"), false),
        None => (if text.is_empty() { NOT_FOUND.to_string() } else { text }, false),
    }
}
