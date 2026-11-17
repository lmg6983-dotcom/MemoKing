//! 태그 추천 (인터넷 · AI 없이, 메모 폴더 안의 메모들만 보고) — app/js/core/tag-suggest.js · auto-tags.js · korean.js
//!   차례 · 소수 끝자리까지 JS 와 같게: Map 은 넣은 차례를 지키는 Ordered 로, 더하는 차례도 JS 와 같다
use crate::body::{extract_tags, extract_title, is_valid_tag, plain_lines};
use crate::indexer::{len16, tfidf_vectors, tokenize};
use crate::js::{self, re};
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub const MIN_TEXT: usize = 12; // 이보다 짧은 메모에는 추천하지 않는다 (글자 수)
const K: usize = 7; // 닮은 메모 몇 개의 태그를 볼지
const MIN_SIM: f64 = 0.1; // 이보다 덜 닮은 메모의 태그는 세지 않는다
const STRONG_SIM: f64 = 0.15; // 닮은 메모가 하나뿐이면 이만큼은 닮아야
const CENTROID_SIM: f64 = 0.2; // 그 태그를 단 메모들 전체와 이만큼 닮으면

// 같은 뜻의 말 묶음 — tag-suggest.js SYNONYMS 그대로
const SYNONYMS: &[&[&str]] = &[
    &["회의", "미팅", "meeting", "회의록", "미팅록"],
    &["할일", "투두", "todo", "해야할일", "할것"],
    &["아이디어", "idea", "아이디어노트", "발상"],
    &["장보기", "쇼핑", "shopping", "살것", "구매목록"],
    &["업무", "work", "회사", "직장", "회사일"],
    &["공부", "학습", "study", "스터디"],
    &["여행", "travel", "trip", "여행계획"],
    &["건강", "운동", "health", "헬스", "다이어트"],
    &["가계부", "지출", "예산", "budget", "돈관리"],
    &["일기", "diary", "다이어리"],
    &["독서", "책", "book", "reading", "읽을거리"],
    &["요리", "레시피", "recipe", "cooking"],
    &["개발", "코딩", "프로그래밍", "dev", "code"],
    &["디자인", "design", "시안"],
    &["중요", "important", "긴급", "urgent"],
    &["일정", "약속", "schedule", "스케줄"],
    &["가족", "family"],
    &["영화", "movie", "film"],
    &["음악", "music", "노래"],
    &["고객", "클라이언트", "client", "customer"],
    &["계약", "계약서", "contract"],
    &["보고서", "report"],
    &["캡처", "캡쳐", "스크린샷", "화면캡처", "screenshot", "capture"],
    &["링크", "웹", "북마크", "link", "url", "web"],
    &["음성", "녹음", "voice", "음성메모", "보이스"],
    &["공유", "받은글", "스크랩", "share", "clip"],
];
static SYN: LazyLock<HashMap<String, usize>> = LazyLock::new(|| SYNONYMS.iter().enumerate().flat_map(|(i, g)| g.iter().map(move |w| (normalize_tag(w), i))).collect());

// 핵심어로 쓰지 않을 말 (흔한 말 · 때 · 움직임)
const STOP: &[&str] = &[
    "오늘", "내일", "어제", "이번", "다음", "지난", "정리", "메모", "내용", "관련", "진행", "확인", "사항", "부분", "경우", "정도", "사람", "생각", "이것", "그것", "저것", "우리", "그냥", "정말", "진짜", "시간", "때문",
    "하나", "여기", "거기", "무엇", "어디", "언제", "모두", "전체", "주간", "월간", "오전", "오후", "이번주", "다음주", "지난주", "the", "and", "for", "with", "this", "that",
];
static NOT_NOUN: LazyLock<Regex> = LazyLock::new(|| {
    re("([았었였졌겠됐왔갔웠렸켰쳤셨텼][다고]|에서|에게|있고|없고|^[가와봐써줘둬놔]서|은|른|하다|했다|한다|하기|하고|해서|하면|하는|했던|되다|된다|됐다|있다|없다|같다|싶다|겠다|이다|이고|이며|어요|아요|해요|세요|니다|는데|지만|으면|려고|도록|면서|어서|아서|할|될|던|았|었|게|히|이|기|음|임)$")
});
// JS 의 \b 는 ASCII 낱말 경계 (fancy_regex 는 유니코드라 직접 적는다)
static URL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?<![A-Za-z0-9_])(?:https?://|www\.)\S+"));
static EXT: LazyLock<Regex> = LazyLock::new(|| re(r"(?<=[^\s.])\.[A-Za-z][A-Za-z0-9]{0,4}(?![A-Za-z0-9_])"));

// ---------- korean.js ----------

const CHO: &str = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG: &str = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG: &str = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"; // 맨 앞은 받침 없음 (쓰지 않는다)
const ENDINGS: &[&str] = &[
    "에서부터", "으로부터", "이라는", "이라고", "에게서", "한테서", "까지는", "부터는", "에서는", "으로는", "이에요", "입니다", "했어요", "했습니다", "합니다", "해요", "하고", "하는", "했다", "하기", "에서", "에게",
    "한테", "으로", "까지", "부터", "처럼", "보다", "라는", "이나", "이랑", "이다", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만", "랑", "나", "요",
];

pub fn is_hangul(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| ('가'..='힣').contains(&c))
}

fn jamo(word: &str) -> Vec<String> {
    let nth = |s: &str, i: u32| s.chars().nth(i as usize).unwrap().to_string();
    let mut out = vec![];
    for ch in word.chars() {
        let Some(c) = (ch as u32).checked_sub(0xac00).filter(|c| *c <= 11171) else {
            out.push(ch.to_lowercase().collect());
            continue;
        };
        out.push(nth(CHO, c / 588));
        out.push(nth(JUNG, c % 588 / 28));
        if c % 28 != 0 {
            out.push(nth(JONG, c % 28));
        }
    }
    out
}

/// 자모 편집 거리 (Levenshtein)
pub fn jamo_distance(a: &str, b: &str) -> usize {
    let (x, y) = (jamo(a), jamo(b));
    let mut prev: Vec<usize> = (0..=y.len()).collect();
    for i in 1..=x.len() {
        let mut cur = vec![i];
        for j in 1..=y.len() {
            cur.push((prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(x[i - 1] != y[j - 1])));
        }
        prev = cur;
    }
    prev[y.len()]
}

/// 낱말 끝의 조사 · 어미를 뗀 줄기 (한글이 아니면 그대로, 소문자)
pub fn stem(word: &str) -> String {
    let w = js::trim(word).trim_end_matches(['.', ',', '!', '?', '~', '…', '\'', '"', '“', '”', '‘', '’', '(', ')', '[', ']', '{', '}', ':', ';']);
    if !is_hangul(w) {
        return w.to_lowercase();
    }
    let n = w.chars().count();
    match ENDINGS.iter().find(|e| n >= e.chars().count() + 2 && w.ends_with(**e)) {
        Some(e) => w[..w.len() - e.len()].to_string(),
        None => w.to_string(),
    }
}

/// 대소문자 · 띄어쓰기 · _-·. 를 뺀 태그 열쇠
pub fn normalize_tag(name: &str) -> String {
    name.to_lowercase().chars().filter(|c| !(js::is_space(*c) || "_-·.".contains(*c))).collect()
}

// ---------- tag-suggest.js ----------

/// 넣은 차례를 지키는 Map (JS Map 처럼 — 있는 열쇠에 다시 넣어도 자리는 그대로)
pub(crate) struct Ordered<V> {
    pub(crate) at: HashMap<String, usize>,
    pub(crate) items: Vec<(String, V)>,
}

impl<V> Ordered<V> {
    pub(crate) fn new() -> Self {
        Ordered { at: HashMap::new(), items: vec![] }
    }
    pub(crate) fn get(&self, k: &str) -> Option<&V> {
        self.at.get(k).map(|i| &self.items[*i].1)
    }
    pub(crate) fn set(&mut self, k: &str, v: V) {
        match self.at.get(k) {
            Some(i) => self.items[*i].1 = v,
            None => {
                self.at.insert(k.to_string(), self.items.len());
                self.items.push((k.to_string(), v));
            }
        }
    }
    pub(crate) fn entry(&mut self, k: &str, def: impl FnOnce() -> V) -> &mut V {
        if !self.at.contains_key(k) {
            self.set(k, def());
        }
        &mut self.items[self.at[k]].1
    }
}

pub(crate) fn cosine(a: &Ordered<f64>, b: &Ordered<f64>) -> f64 {
    let (small, large) = if a.items.len() <= b.items.len() { (a, b) } else { (b, a) };
    small.items.iter().fold(0.0, |sum, (t, w)| match large.get(t) {
        Some(o) if *o != 0.0 => sum + w * o,
        _ => sum,
    })
}

fn no_urls(text: &str) -> String {
    let t = URL.replace_all(text, " ");
    EXT.replace_all(&t, " ").into_owned()
}

fn text_of(body: &str) -> String {
    let title = extract_title(body);
    no_urls(&format!("{title} {title} {}", plain_lines(body, usize::MAX).join(" ")))
}

// 본문에 이 말이 낱말로 나오는가: 줄기가 같거나 줄기가 이 말로 시작 (세 글자 이상이면 글 속 어디든)
fn mentions(word: &str, stems: &HashSet<String>, lower: &str) -> bool {
    let w = normalize_tag(word);
    let n = len16(&w);
    if n < 2 {
        return false;
    }
    stems.contains(&w) || stems.iter().any(|t| t.starts_with(&w) && len16(t) <= n + 2) || (n >= 3 && lower.contains(&w))
}

/// 이 태그(또는 같은 뜻 말)가 본문에 낱말로 나오는가 — AI 가 고른 기존 태그의 근거 (ai-tags.js)
pub fn mentions_tag(name: &str, body: &str) -> bool {
    let plain = no_urls(&plain_lines(body, usize::MAX).join(" "));
    let lower = plain.to_lowercase();
    let stems: HashSet<String> = tokenize(&plain).iter().map(|t| stem(t)).collect();
    let key = normalize_tag(name);
    mentions(&key, &stems, &lower) || SYN.get(&key).is_some_and(|g| SYNONYMS[*g].iter().any(|w| mentions(w, &stems, &lower)))
}

pub struct Existing {
    pub name: String,
    pub count: usize,
}

/// 기존 태그 중 이 말과 사실상 같은 것 → (그 태그, 얼마나 같은지 1~4)
pub fn match_existing<'a>(word: &str, existing: &'a [Existing]) -> Option<(&'a Existing, u8)> {
    let k = normalize_tag(word);
    if k.is_empty() {
        return None;
    }
    let mut best: Option<(&Existing, u8)> = None;
    for t in existing {
        let tk = normalize_tag(&t.name);
        let (kl, tl) = (k.chars().count(), tk.chars().count());
        let both = is_hangul(&k) && is_hangul(&tk);
        let rank = if tk == k {
            4 // 대소문자 · 띄어쓰기만 다름
        } else if SYN.get(&k).is_some_and(|g| SYN.get(&tk) == Some(g)) {
            3 // 같은 뜻 묶음
        } else if both && kl.min(tl) >= 2 && (k.starts_with(&tk) || tk.starts_with(&k)) && kl.abs_diff(tl) <= 2 {
            2 // 회의 ↔ 회의록
        } else if both && kl >= 3 && kl == tl && jamo_distance(&k, &tk) <= 1 {
            1 // 한 글자 오타
        } else {
            0
        };
        if rank > 0 && best.is_none_or(|(b, r)| rank > r || (rank == r && t.count > b.count)) {
            best = Some((t, rank));
        }
    }
    best
}

struct Sug {
    name: String,
    score: f64,
    rank: Option<f64>,
    reason: &'static str,
    existing: bool,
    sure: Option<bool>, // JS 에서 undefined 일 때가 있다 (그대로 빠진다)
    why: String,
}

fn round2(v: f64) -> f64 {
    js::round(v * 100.0) / 100.0
}

/// 태그 추천 → [{ name, score, reason, existing, sure, why }]
pub fn suggest_tags_for(body: &str, memos: &[(String, String)], limit: usize, exclude_id: Option<&str>) -> Vec<Value> {
    let plain = no_urls(&plain_lines(body, usize::MAX).join(" "));
    if len16(&plain.chars().filter(|c| !js::is_space(*c)).collect::<String>()) < MIN_TEXT {
        return vec![];
    }
    let key_of = normalize_tag;
    let own: HashSet<String> = extract_tags(body).iter().map(|t| key_of(t)).collect();
    let others: Vec<&(String, String)> = memos.iter().filter(|(id, b)| Some(id.as_str()) != exclude_id && b != body).collect();
    let docs: Vec<Vec<String>> = std::iter::once(body).chain(others.iter().map(|(_, b)| b.as_str())).map(|b| tokenize(&text_of(b))).collect();
    let stems: HashSet<String> = docs[0].iter().map(|t| stem(t)).collect();
    let vectors: Vec<Ordered<f64>> = tfidf_vectors(docs)
        .into_iter()
        .map(|v| {
            let mut o = Ordered::new();
            for (t, w) in v {
                o.set(&t, w);
            }
            o
        })
        .collect();
    let target = &vectors[0];
    let lower = plain.to_lowercase();
    let tags_of: Vec<Vec<String>> = others.iter().map(|(_, b)| extract_tags(b)).collect();

    // 기존 태그: 이름 · 쓴 횟수 · 묶음 중심
    let mut groups: Ordered<(String, usize, Ordered<f64>)> = Ordered::new();
    for (i, tags) in tags_of.iter().enumerate() {
        for name in tags {
            let g = groups.entry(&key_of(name), || (name.clone(), 0, Ordered::new()));
            g.1 += 1;
            for (t, w) in &vectors[i + 1].items {
                let c = g.2.entry(t, || 0.0);
                *c += w;
            }
        }
    }
    let existing: Vec<Existing> = groups.items.iter().map(|(_, g)| Existing { name: g.0.clone(), count: g.1 }).collect();

    // 닮은 메모 k개의 태그 투표
    let mut sims: Vec<(usize, f64)> = (0..others.len()).map(|i| (i, cosine(target, &vectors[i + 1]))).filter(|x| x.1 >= MIN_SIM).collect();
    sims.sort_by(|a, b| b.1.total_cmp(&a.1));
    sims.truncate(K);
    let total = sims.iter().fold(0.0, |a, x| a + x.1);
    let sim_total = if total == 0.0 { 1.0 } else { total };
    let mut votes: HashMap<String, (f64, usize, f64)> = HashMap::new(); // (share, n, max)
    for (i, s) in &sims {
        for name in &tags_of[*i] {
            let v = votes.entry(key_of(name)).or_insert((0.0, 0, 0.0));
            v.0 += s / sim_total;
            v.1 += 1;
            v.2 = v.2.max(*s);
        }
    }

    let mut scored: Ordered<Sug> = Ordered::new();
    let put = |scored: &mut Ordered<Sug>, mut r: Sug| {
        let k = key_of(&r.name);
        if own.contains(&k) {
            return;
        }
        let rank = *r.rank.get_or_insert(r.score);
        if scored.get(&k).is_none_or(|p| rank > p.rank.unwrap()) {
            scored.set(&k, r);
        }
    };

    for (key, (name, _, centroid)) in &groups.items {
        let norm = centroid.items.iter().fold(0.0, |a, (_, w)| a + w * w).sqrt();
        let norm = if norm == 0.0 { 1.0 } else { norm };
        let mut c = Ordered::new();
        for (t, w) in &centroid.items {
            c.set(t, w / norm);
        }
        let sim = cosine(target, &c);
        let vote = votes.get(key);
        // 태그 이름(또는 같은 뜻 말)이 본문에 낱말로 나오는가
        let parts: Vec<String> = tokenize(&name.replace(['_', '-'], " ")).iter().map(|t| stem(t)).collect();
        let mut mention = len16(key) >= 2 && ((!parts.is_empty() && parts.iter().all(|p| mentions(p, &stems, &lower))) || mentions(key, &stems, &lower));
        let mut via = None;
        if !mention {
            if let Some(g) = SYN.get(key) {
                via = SYNONYMS[*g].iter().find(|w| key_of(w) != *key && mentions(w, &stems, &lower));
                mention = via.is_some();
            }
        }
        // 근거: 본문에 나옴 · 닮은 메모 여럿(또는 아주 닮은 하나)이 달았음 · 그 태그 메모들과 꽤 닮음 — 없으면 추천하지 않는다
        let strong_vote = vote.is_some_and(|v| if v.1 >= 2 { v.0 >= 0.3 } else { v.2 >= STRONG_SIM });
        if !mention && !strong_vote && sim < CENTROID_SIM {
            continue;
        }
        let vote_score = vote.map_or(0.0, |v| v.0 * 0.6 + (0.15f64).min(v.1 as f64 * 0.04));
        let raw = (if mention { if via.is_some() { 0.6 } else { 0.7 } } else { 0.0 }) + vote_score + sim * 0.35;
        let (reason, why) = match (mention, via, vote) {
            (true, Some(v), _) => ("consistent", format!("본문의 \"{v}\", 같은 뜻으로 이미 쓰는 태그")),
            (true, None, _) => ("mention", "본문에 나오는 기존 태그".to_string()),
            (false, _, Some(v)) => ("similar", format!("내용이 닮은 메모 {}개에 달린 태그", v.1)),
            _ => ("centroid", "이 태그를 단 메모들과 내용이 닮음".to_string()),
        };
        let sure = if mention { Some(true) } else { vote.map(|v| v.0 >= 0.45 && v.1 >= 2) };
        put(&mut scored, Sug { name: name.clone(), score: round2(raw.min(1.0)), rank: Some(raw), reason, existing: true, sure, why });
    }

    // 함께 다는 태그: 본문에 나온 태그 A 와 거의 늘 같이 단 태그 B (닮은 메모로만 고른 A 에서는 넓히지 않는다)
    let mut first: Vec<(String, f64, f64)> = scored.items.iter().filter(|(_, r)| matches!(r.reason, "mention" | "consistent")).map(|(_, r)| (r.name.clone(), r.score, r.rank.unwrap())).collect();
    first.sort_by(|a, b| b.2.total_cmp(&a.2));
    for (a_name, a_score, _) in first.into_iter().take(3) {
        let ka = key_of(&a_name);
        let with_a: Vec<&Vec<String>> = tags_of.iter().filter(|tags| tags.iter().any(|t| key_of(t) == ka)).collect();
        if with_a.len() < 2 {
            continue;
        }
        let mut co: Ordered<(String, usize)> = Ordered::new();
        for tags in &with_a {
            for t in tags.iter().filter(|t| key_of(t) != ka) {
                let n = co.get(&key_of(t)).map_or(0, |c| c.1);
                co.set(&key_of(t), (t.clone(), n + 1));
            }
        }
        for (kb, (name, n)) in &co.items {
            let p = *n as f64 / with_a.len() as f64;
            if p < 0.8 || *n < 2 || scored.get(kb).is_some() {
                continue;
            }
            let r = Sug { name: name.clone(), score: round2(a_score * p * 0.6), rank: None, reason: "related", existing: true, sure: Some(false), why: format!("#{a_name}와 자주 같이 다는 태그") };
            put(&mut scored, r);
        }
    }

    let mut out: Vec<Sug> = scored.items.into_iter().map(|(_, r)| r).collect();
    out.sort_by(|a, b| b.rank.unwrap().total_cmp(&a.rank.unwrap()).then_with(|| js::locale_cmp(&a.name, &b.name, true)));

    // 새 태그는 기존 태그로 못 채웠을 때만: 핵심어(명사 위주, 제목 우대) — 기존 태그와 같은 말이면 그 태그로
    if out.len() < limit {
        let title: HashSet<String> = tokenize(&extract_title(body)).iter().map(|t| stem(t)).collect();
        static DIGIT: LazyLock<Regex> = LazyLock::new(|| re(r"\d"));
        static EN_JOSA: LazyLock<Regex> = LazyLock::new(|| re("[a-z].*(에서|에게)"));
        let mut words: Vec<(String, f64)> = target
            .items
            .iter()
            .map(|(t, w)| (stem(&stem(t)), w * if title.contains(&stem(t)) { 2.0 } else { 1.0 })) // 폰에서도 → 폰에서 → 폰 (조사가 겹쳐도)
            .filter(|(t, _)| {
                let n = len16(t);
                (2..=10).contains(&n)
                    && is_valid_tag(t)
                    && !STOP.contains(&t.as_str())
                    && !DIGIT.is_match(t).unwrap_or(false)
                    && !(is_hangul(t) && NOT_NOUN.is_match(t).unwrap_or(false))
                    && !EN_JOSA.is_match(t).unwrap_or(false)
            })
            .collect();
        words.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| js::locale_cmp(&a.0, &b.0, false)));
        let mut seen = HashSet::new();
        for (t, w) in words {
            if out.len() >= limit {
                break;
            }
            if !seen.insert(t.clone()) {
                continue;
            }
            let taken = |out: &[Sug], k: &str| own.contains(k) || out.iter().any(|o| key_of(&o.name) == k);
            if let Some((m, rank)) = match_existing(&t, &existing) {
                if taken(&out, &key_of(&m.name)) {
                    continue;
                }
                let why = format!("\"{t}\" 대신 이미 쓰는 #{}", m.name);
                out.push(Sug { name: m.name.clone(), score: round2((0.5f64).min(0.2 + w * 0.3)), rank: None, reason: "consistent", existing: true, sure: Some(rank >= 3), why });
            } else if !taken(&out, &key_of(&t)) {
                out.push(Sug { name: t, score: round2((0.15f64).min(w * 0.3)), rank: None, reason: "keyword", existing: false, sure: Some(false), why: "이 메모의 핵심어 (새 태그)".into() });
            }
        }
    }
    out.sort_by(|a, b| b.existing.cmp(&a.existing).then_with(|| b.rank.unwrap_or(b.score).total_cmp(&a.rank.unwrap_or(a.score))));
    out.into_iter()
        .take(limit)
        .map(|r| {
            let mut v = json!({ "name": r.name, "score": js::num(r.score), "reason": r.reason, "existing": r.existing, "sure": r.sure, "why": r.why });
            if r.sure.is_none() {
                v.as_object_mut().unwrap().remove("sure");
            }
            v
        })
        .collect()
}

static TAG_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^(\s*#[^\s#]+)+\s*$"));

/// 본문 끝에 태그 줄을 붙인 새 본문 (끝 줄이 이미 태그만 있는 줄이면 그 줄에 이어서)
pub fn append_tags(body: &str, names: &[String]) -> String {
    let tags: Vec<String> = names.iter().filter(|n| is_valid_tag(n)).map(|n| format!("#{n}")).collect();
    if tags.is_empty() {
        return body.to_string();
    }
    let text = js::trim_end(body);
    let (head, last) = text.rsplit_once('\n').map_or(("", text), |(h, l)| (h, l));
    if TAG_LINE.is_match(last).unwrap_or(false) && !extract_tags(last).is_empty() {
        let sep = if text.contains('\n') { "\n" } else { "" };
        return format!("{head}{sep}{} {}\n", js::trim_end(last), tags.join(" "));
    }
    format!("{text}\n\n{}\n", tags.join(" "))
}

/// 태그만 있는 줄(append_tags 가 붙인 줄)에서 그 태그들을 뺀 새 본문 — 빈 줄이 되면 그 줄도 (AI 태그 모두 지우기)
pub fn remove_tags(body: &str, names: &[String]) -> String {
    let drop: HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
    let lines: Vec<String> = body
        .split('\n')
        .map(|line| {
            if !TAG_LINE.is_match(line).unwrap_or(false) {
                return line.to_string();
            }
            js::trim(line).split(js::is_space).filter(|t| !t.is_empty() && !drop.contains(&t.chars().skip(1).collect::<String>().to_lowercase())).collect::<Vec<_>>().join(" ")
        })
        .collect();
    format!("{}\n", js::trim_end(&lines.join("\n")))
}

// ---------- auto-tags.js ----------

/// 밖에서 들어온 메모(화면 캡처 · 링크 · 음성 · 공유)에 저절로 달 태그 (본문에 이미 있는 것은 빼고)
pub fn auto_tags_for(body: &str, memos: &[(String, String)], source: &str, exclude_id: Option<&str>) -> Vec<String> {
    let own: HashSet<String> = extract_tags(body).iter().map(|t| t.to_lowercase()).collect();
    let mut out: Vec<String> = vec![];
    let add = |out: &mut Vec<String>, name: &str| {
        let key = name.to_lowercase();
        if is_valid_tag(name) && !own.contains(&key) && !out.iter().any(|t| t.to_lowercase() == key) {
            out.push(name.to_string());
        }
    };
    let suggestions: Vec<Value> = suggest_tags_for(body, memos, 4, exclude_id).into_iter().filter(|t| t["existing"] == true).collect();
    let sure: Vec<&Value> = suggestions.iter().filter(|t| t["sure"] == true).take(2).collect();
    if !sure.is_empty() {
        for t in sure {
            add(&mut out, t["name"].as_str().unwrap_or_default());
        }
    } else if let Some(t) = suggestions.first().filter(|t| t["score"].as_f64().unwrap_or(0.0) >= 0.3) {
        add(&mut out, t["name"].as_str().unwrap_or_default());
    }

    let tag = match source {
        "capture" => "캡처",
        "link" => "링크",
        "audio" => "음성",
        "share" => "공유",
        _ => return out,
    };
    if source == "capture" || out.is_empty() {
        // 이미 쓰는 같은 뜻의 태그가 있으면 그것으로
        let mut counts: Ordered<usize> = Ordered::new();
        for (_, b) in memos {
            for t in extract_tags(b) {
                *counts.entry(&t, || 0) += 1;
            }
        }
        let existing: Vec<Existing> = counts.items.into_iter().map(|(name, count)| Existing { name, count }).collect();
        let name = match_existing(tag, &existing).map_or(tag.to_string(), |(m, _)| m.name.clone());
        add(&mut out, &name);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn korean() {
        assert_eq!(stem("회의록을"), "회의록");
        assert_eq!(stem("Hello!"), "hello");
        assert_eq!(jamo_distance("엄무", "업무"), 1);
        assert_eq!(normalize_tag("Memo King_x·y"), "memokingxy");
    }
}
