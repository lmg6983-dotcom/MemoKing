//! 받아쓴 글 다듬기 — app/js/core/transcript-lines.js · transcript-fix.js 와 voice-card.js 의 replaceTranscript 를 옮긴 것
use crate::body::{extract_headings, extract_tags, extract_title};
use crate::js::{self, re};
use crate::tag_suggest::{is_hangul, jamo_distance, stem};
use fancy_regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

macro_rules! js_re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re($pat));
    };
}

// ---------- transcript-lines.js ----------

js_re!(QUESTION, "(까|까요|나요|가요|는지|는지요|냐|래요|대요|할래|했니|하니|있니|없니|어때|어때요)$");
js_re!(STATEMENT, "(다|요|죠|네|군|자|세요|니다|지|야|어|아|해|래)$");

/// 받아쓴 한 줄 (초 단위, speaker 0 = 모름)
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub speaker: i64,
}

/// 끝에 문장부호가 없으면 붙인다 (묻는 말은 ?, 맺는 말은 .)
pub fn punctuate(part: &str) -> String {
    let t = js::trim(part);
    if t.is_empty() || t.ends_with(['.', '?', '!', ',', '…', '~', '。', '？', '！']) {
        t.to_string()
    } else if QUESTION.is_match(t).unwrap_or(false) {
        format!("{t}?")
    } else if STATEMENT.is_match(t).unwrap_or(false) {
        format!("{t}.")
    } else {
        t.to_string()
    }
}

/// 줄마다 한 문장, 말한 사람이 둘 이상이면 사람이 바뀌는 줄 앞에 "화자 N: "
pub fn join_transcript(lines: &[Line]) -> String {
    let list: Vec<&Line> = lines.iter().filter(|l| !js::trim(&l.text).is_empty()).collect();
    let many = list.iter().map(|l| l.speaker).filter(|s| *s > 0).collect::<HashSet<_>>().len() >= 2;
    let mut who = -1;
    let mut out = vec![];
    for l in list {
        let spk = if l.speaker > 0 { l.speaker } else { who }; // 모르는(0) 조각은 앞사람으로
        let text = punctuate(&l.text);
        out.push(if many && spk > 0 && spk != who { format!("화자 {spk}: {text}") } else { text });
        if spk > 0 {
            who = spk;
        }
    }
    out.join("\n")
}

/// 화자 나누기 결과 (start, end, speaker) 를 줄에 붙인다 — 가장 많이 겹친 사람, 번호는 처음 말한 순서대로 1, 2, …
pub fn label_speakers(lines: &[Line], segments: &[(f64, f64, i64)]) -> Vec<Line> {
    let mut order: Vec<i64> = vec![];
    let mut prev = 0;
    lines
        .iter()
        .map(|l| {
            let mut overlap: Vec<(i64, f64)> = vec![]; // 처음 나온 차례 (Map 처럼)
            for &(start, end, spk) in segments {
                let o = l.end.min(end) - l.start.max(start);
                if o > 0.0 {
                    match overlap.iter_mut().find(|(s, _)| *s == spk) {
                        Some(x) => x.1 += o,
                        None => overlap.push((spk, o)),
                    }
                }
            }
            let mut best = None;
            let mut most = 0.0;
            for (spk, o) in overlap {
                if o > most {
                    most = o;
                    best = Some(spk);
                }
            }
            if let Some(b) = best {
                if !order.contains(&b) {
                    order.push(b);
                }
                prev = order.iter().position(|s| *s == b).unwrap() as i64 + 1;
            }
            Line { speaker: prev, ..l.clone() }
        })
        .collect()
}

/// 받아쓰기 전에 소리 다듬기 (낮은 웅웅 소리 빼기 · 작은 목소리 키우기 · 큰 소리 부드럽게 누르기)
///   상태는 JS 처럼 f64, 소리는 Float32Array 처럼 f32 로 담는다
pub struct SpeechConditioner {
    alpha: f64,
    prev_in: f64,
    prev_out: f64,
    level: f64,
    noise: f64,
    gain: f64,
    target: f64,
}

impl SpeechConditioner {
    pub fn new(rate: f64) -> Self {
        SpeechConditioner { alpha: 1.0 / (1.0 + (2.0 * std::f64::consts::PI * 100.0) / rate), prev_in: 0.0, prev_out: 0.0, level: 0.02, noise: 0.005, gain: 1.0, target: 0.12 }
    }

    pub fn process(&mut self, x: &mut [f32]) {
        if x.is_empty() {
            return;
        }
        let mut sum = 0.0;
        for s in x.iter_mut() {
            let v = f64::from(*s);
            let y = self.alpha * (self.prev_out + v - self.prev_in);
            self.prev_in = v;
            self.prev_out = y;
            *s = y as f32;
            sum += y * y;
        }
        let rms = (sum / x.len() as f64).sqrt();
        // 배경 소음은 조용한 쪽으로 빨리, 큰 쪽으로는 아주 느리게
        self.noise = if rms < self.noise { self.noise * 0.9 + rms * 0.1 } else { self.noise * 0.999 + rms * 0.001 };
        let speaking = rms > self.noise * 2.5 && rms > 0.004;
        if speaking {
            self.level = self.level * 0.9 + rms * 0.1;
        }
        let want = if speaking { (self.target / self.level.max(1e-4)).clamp(1.0, 8.0) } else { (self.gain * 0.98).max(1.0).min(self.gain) };
        self.gain += (want - self.gain) * 0.2;
        for s in x.iter_mut() {
            let mut y = f64::from(*s) * self.gain;
            if y > 0.8 {
                y = 0.8 + (y - 0.8) * 0.2;
            } else if y < -0.8 {
                y = -0.8 + (y + 0.8) * 0.2;
            }
            *s = y.clamp(-1.0, 1.0) as f32;
        }
    }
}

// ---------- transcript-fix.js ----------

const STOP: &[&str] = &["그리고", "그래서", "하지만", "그러나", "오늘", "내일", "어제", "이번", "다음", "지난", "정리", "메모", "내용", "관련", "진행", "확인", "사항", "부분", "경우", "정도", "사람", "생각", "이것", "그것", "저것", "우리", "그냥", "정말", "진짜"];

js_re!(NOT_WORD, r"[^\p{L}\p{N}]+");
js_re!(TITLE_SPLIT, r#"[\s,./()\[\]·:;!?'"“”]+"#);
js_re!(SPACES, r"[ \t]+");
js_re!(LABEL, r"^\s*화자\s*\d+\s*:\s*");
js_re!(BEFORE_MARK, r" +([.,?!])");
js_re!(AFTER_MARK, r"([.?!])(?=[^\s.?!\d])");
js_re!(BLANK_LINES, r"\n{3,}");

/// 말모음: 많이 쓴 순 (낱말, 무게) 과 이 폴더의 글에 한 번이라도 나온 낱말 (맞게 받아쓴 보통 말을 고치지 않게)
#[derive(Default)]
pub struct Vocab {
    pub terms: Vec<(String, u32)>,
    pub known: HashSet<String>,
}

/// vocabularyFrom — 태그는 무게 3, 제목 · 소제목 낱말은 나온 메모 수 (memos: (id, 본문))
pub fn vocabulary_from(memos: &[(String, String)], limit: usize) -> Vocab {
    let len = |s: &str| s.encode_utf16().count();
    let mut w: HashMap<String, u32> = HashMap::new();
    let mut known = HashSet::new();
    let mut add = |term: &str, by: u32| {
        let t = js::trim(term);
        if len(t) < 2 || STOP.contains(&t) || t.bytes().all(|b| b.is_ascii_digit()) {
            return;
        }
        *w.entry(t.to_string()).or_default() += by;
    };
    for (_, body) in memos {
        for raw in NOT_WORD.split(body).flatten() {
            if len(raw) >= 2 {
                known.insert(stem(raw));
            }
        }
        for tag in extract_tags(body) {
            add(&tag, 3);
        }
        let mut seen = HashSet::new();
        for line in std::iter::once(extract_title(body)).chain(extract_headings(body)) {
            for raw in TITLE_SPLIT.split(&line).flatten() {
                let s = stem(raw);
                let ascii_word = s.len() >= 3 && s.starts_with(|c: char| c.is_ascii_alphabetic()) && s.bytes().all(|b| b.is_ascii_alphanumeric());
                if len(&s) < 2 || seen.contains(&s) || !(is_hangul(&s) || ascii_word) {
                    continue;
                }
                add(&s, 1);
                seen.insert(s);
            }
        }
    }
    let mut terms: Vec<(String, u32)> = w.into_iter().filter(|(_, v)| *v >= 2).collect();
    terms.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| js::locale_cmp(&a.0, &b.0, true)));
    terms.truncate(limit);
    Vocab { terms, known }
}

/// 받아쓴 낱말 하나를 말모음의 낱말로 고칠 것이 있으면 그 말 — 자모 1~2개 차이, 첫소리는 같아야
pub fn correct_word(word: &str, vocab: &Vocab, known: &HashSet<String>) -> Option<String> {
    let core = stem(word);
    let n = core.chars().count();
    if !is_hangul(&core) || n < 2 || known.contains(&core) {
        return None;
    }
    let at = word.find(&core)?;
    let first = |s: &str| (s.chars().next().unwrap() as u32 - 0xac00) / 588;
    let max = if n >= 4 { 2 } else { 1 }; // 세 글자에 자모 둘은 다른 낱말이다 (메모장 ↔ 메모킹)
    let mut best: Option<(&str, usize)> = None;
    let mut tie = false;
    for (term, _) in &vocab.terms {
        if !is_hangul(term) || term.chars().count() != n || *term == core || first(term) != first(&core) {
            continue;
        }
        let d = jamo_distance(&core, term);
        if d > max {
            continue;
        }
        match best {
            Some((_, b)) if d >= b => tie |= d == b,
            _ => {
                best = Some((term, d));
                tie = false;
            }
        }
    }
    let (term, _) = best.filter(|_| !tie)?;
    Some(format!("{}{term}{}", &word[..at], &word[at + core.len()..]))
}

/// 받아쓴 글 전체 다듬기 (말모음으로 고치기 · 띄어쓰기 · 문장부호)
pub fn fix_transcript(text: &str, vocab: &Vocab) -> String {
    let mut known = vocab.known.clone();
    known.extend(vocab.terms.iter().map(|(t, _)| t.clone()));
    let text = SPACES.replace_all(text, " ");
    let out = text
        .split('\n')
        .map(|line| {
            let label = LABEL.find(line).ok().flatten().map_or("", |m| m.as_str()); // 말한 사람 이름표는 그대로
            let words: Vec<String> = line[label.len()..].split(' ').map(|w| if w.is_empty() { String::new() } else { correct_word(w, vocab, &known).unwrap_or_else(|| w.to_string()) }).collect();
            format!("{label}{}", words.join(" "))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let out = BEFORE_MARK.replace_all(&out, "$1");
    let out = AFTER_MARK.replace_all(&out, "$1 ");
    js::trim(&BLANK_LINES.replace_all(&out, "\n\n")).to_string()
}

// ---------- voice-card.js ----------

js_re!(SPEAKER_LINE, r"^화자\s*(\d+)\s*[:：]\s*");
js_re!(MD_CHAR, r"[\\`*_\[\]<>|~$]");
js_re!(BLOCK_MARK, r"^(\s*)([#>+-])(?=\s|$)");
js_re!(LIST_NUMBER, r"^(\s*\d+)([.)])(?=\s|$)");
js_re!(HASH, r"(^|\s)#(?=[^\s#])");

/// 마크다운으로 읽히는 글자 막기 (받아쓴 글은 그냥 글)
pub fn escape_line(text: &str) -> String {
    let s = MD_CHAR.replace_all(text, "\\$0");
    let s = BLOCK_MARK.replace(&s, "$1\\$2");
    let s = LIST_NUMBER.replace(&s, "$1\\$2");
    HASH.replace_all(&s, "$1\\#").into_owned() // 받아쓴 글 속 # 이 태그가 되지 않게
}

/// 받아쓴 글(줄마다 한 문장, "화자 N: ") → 카드 안의 마크다운 줄들
pub fn transcript_lines(transcript: &str) -> Vec<String> {
    transcript
        .split('\n')
        .map(|l| js::trim(&SPACES.replace_all(l, " ")).to_string())
        .filter(|l| !l.is_empty())
        .map(|l| match SPEAKER_LINE.captures(&l).ok().flatten() {
            Some(m) => format!("**화자 {}:** {}", m.get(1).unwrap().as_str(), escape_line(&l[m.get(0).unwrap().end()..])),
            None => escape_line(&l),
        })
        .collect()
}

fn quote(lines: &[String]) -> String {
    lines.iter().map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") }).collect::<Vec<_>>().join("\n")
}

fn between(lines: Vec<String>) -> Vec<String> {
    lines.into_iter().enumerate().flat_map(|(i, l)| if i > 0 { vec![String::new(), l] } else { vec![l] }).collect()
}

fn card_lines(add: &[String]) -> impl Iterator<Item = String> + '_ {
    add.iter().flat_map(|l| [">".to_string(), format!("> {l}")])
}

fn media_re(src: &str) -> Regex {
    Regex::new(&format!(r"!\[[^\]]*\]\(<?{}>?\)", fancy_regex::escape(src))).unwrap()
}

/// 이 소리 파일 줄에 받아쓴 글을 붙인다 — 음성 카드면 카드 끝에, 그냥 소리 줄이면 음성 카드로 (소리 줄이 없으면 None)
pub fn attach_transcript(body: &str, src: &str, transcript: &str) -> Option<String> {
    let mut lines: Vec<String> = body.split('\n').map(str::to_string).collect();
    let re = media_re(src);
    let at = lines.iter().position(|l| re.is_match(l).unwrap_or(false))?;
    let add = transcript_lines(transcript);
    if add.is_empty() {
        return Some(body.to_string());
    }
    if lines[at].starts_with('>') {
        let mut end = at;
        while end + 1 < lines.len() && lines[end + 1].starts_with('>') {
            end += 1;
        }
        lines.splice(end + 1..end + 1, card_lines(&add).collect::<Vec<_>>());
        return Some(lines.join("\n"));
    }
    let media = re.find(&lines[at]).ok().flatten()?.as_str().to_string();
    // 소리 줄에 다른 글이 같이 있으면 소리만 카드로 빼고 나머지는 남긴다
    let rest = js::trim(&re.replace(&lines[at], "")).to_string();
    let card: Vec<String> = quote(&between([vec![media], add].concat())).split('\n').map(str::to_string).collect();
    let new = if rest.is_empty() { card } else { [vec![rest, String::new()], card].concat() };
    lines.splice(at..=at, new);
    Some(lines.join("\n"))
}

/// 음성 카드의 받아쓴 글을 통째로 바꾼다 (말한 사람을 나눈 뒤). 카드가 아니면 attach_transcript 처럼
pub fn replace_transcript(body: &str, src: &str, transcript: &str) -> Option<String> {
    let mut lines: Vec<String> = body.split('\n').map(str::to_string).collect();
    let re = media_re(src);
    let at = lines.iter().position(|l| re.is_match(l).unwrap_or(false))?;
    if !lines[at].starts_with('>') {
        return attach_transcript(body, src, transcript);
    }
    let mut end = at;
    while end + 1 < lines.len() && lines[end + 1].starts_with('>') {
        end += 1;
    }
    let add = transcript_lines(transcript);
    lines.splice(at + 1..=end, card_lines(&add).collect::<Vec<_>>());
    Some(lines.join("\n"))
}
