//! 찾기 · 태그 목록 — app/js/core/text-match.js textMatcher · tags.js collectTags
use serde_json::{json, Value};

const CHO: [char; 19] = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

fn is_choseong_query(t: &str) -> bool {
    !t.is_empty() && t.chars().all(|c| ('ㄱ'..='ㅎ').contains(&c))
}

/// 기호(띄어쓰기 포함)를 뺀 글 — 소문자
pub fn compact_text(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// 기호를 빼고 비교할 낱말인가: 숫자가 있고 뺀 뒤에도 4글자 이상
fn compact_term(term: &str) -> Option<String> {
    let c = compact_text(term);
    (c.chars().any(|ch| ch.is_ascii_digit()) && c.encode_utf16().count() >= 4).then_some(c)
}

// 글자 하나의 초성 (한글이 아니면 그 글자)
fn cho_of(c: char) -> char {
    match c as u32 {
        0xac00..=0xd7a3 => CHO[((c as u32 - 0xac00) / 588) as usize],
        _ => c.to_ascii_lowercase(),
    }
}

fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{3000}')
}

/// 초성 검색어(ㄱㅈㅅ)가 글에 들어 있나 — 띄어쓰기는 건너뛴다
fn choseong_found(text: &str, term: &str) -> bool {
    let t: Vec<char> = text.chars().filter(|c| !is_space(*c)).map(cho_of).collect();
    let q: Vec<char> = term.chars().collect();
    t.windows(q.len()).any(|w| w == q.as_slice())
}

/// 초성 검색어(ㄱㅈㅅ)가 글의 어디에 맞나 (띄어쓰기는 건너뜀) → 맞은 첫 글자의 바이트 자리 (choseongRange 의 시작)
pub fn choseong_start(text: &str, term: &str) -> Option<usize> {
    if !is_choseong_query(term) {
        return None;
    }
    let t: Vec<(usize, char)> = text.char_indices().filter(|(_, c)| !crate::js::is_space(*c)).map(|(i, c)| (i, cho_of(c))).collect();
    let q: Vec<char> = term.chars().collect();
    t.windows(q.len()).find(|w| w.iter().map(|x| x.1).eq(q.iter().copied())).map(|w| w[0].0)
}

/// 낱말마다 texts 중 하나에 들어 있으면 true (빈 검색어는 늘 true)
pub fn matcher(query: &str) -> impl Fn(&[&str]) -> bool {
    let terms: Vec<String> = query.trim_matches(crate::js::is_space).to_lowercase().split(crate::js::is_space).filter(|t| !t.is_empty()).map(str::to_string).collect();
    let compact: Vec<Option<String>> = terms.iter().map(|t| compact_term(t)).collect();
    move |texts: &[&str]| {
        let lower: Vec<String> = texts.iter().map(|t| t.to_lowercase()).collect();
        terms.iter().enumerate().all(|(i, term)| {
            lower.iter().any(|t| t.contains(term.as_str()))
                || compact[i].as_ref().is_some_and(|c| lower.iter().any(|t| compact_text(t).contains(c.as_str())))
                || (is_choseong_query(term) && lower.iter().any(|t| choseong_found(t, term)))
        })
    }
}

/// 모든 메모의 태그와 쓰인 수 (많이 쓴 것부터)
pub fn collect_tags(memos: &[Value]) -> Vec<Value> {
    let mut all: Vec<(String, String, u32)> = vec![]; // (키, 이름, 수)
    for m in memos {
        for name in m["tags"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let key = name.to_lowercase();
            match all.iter_mut().find(|t| t.0 == key) {
                Some(t) => t.2 += 1,
                None => all.push((key, name.to_string(), 1)),
            }
        }
    }
    // shortcut: 같은 수일 때 이름 순은 JS localeCompare('ko') 대신 글자 순 — 한글끼리는 같고 영문 대소문자 섞인 순서만 다를 수 있다
    all.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    all.into_iter().map(|(_, name, count)| json!({ "name": name, "count": count })).collect()
}
