//! 메모 본문에서 뽑는 것 — 제목 · 미리 보기 · 첨부 · 태그 · 체크리스트 · 잠김.
//!   app/js/core/memo-file.js (plainLines · extractTitle · extractPreview · extractMedia · isBlankBody),
//!   tags.js extractTags · tasks.js taskProgress · memo-lock.js isLockedBody
use crate::js::{self, re};
use crate::memo_file::FRONTMATTER;
use fancy_regex::{Captures, Regex};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::LazyLock;

pub const UNTITLED: &str = "제목 없음";
const LOCK_NOTICE: &str = "🔒 잠긴 메모예요. 메모킹에서 비밀번호를 넣으면 열려요.";

macro_rules! js_re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re($pat));
    };
}

js_re!(FENCE_LINE, r"^\s*(```|~~~)");
js_re!(RULE_LINE, r"^\s*([-*_])(\s*\1){2,}\s*$");
js_re!(COMMENT_LINE, r"^\s*<!--.*-->\s*$");
js_re!(TABLE_LINE, r"^\s*\|.*\|\s*$");
js_re!(TABLE_RULE, r"^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$");
js_re!(TABLE_SPLIT, r"(?<!\\)\|");
js_re!(LINE_BREAK, r"(^|[^\\])((?:\\\\)*)\\\s*$");
js_re!(IMAGE, r"!\[[^\]]*\]\([^)]*\)");
js_re!(LINK, r"\[([^\]]*)\]\([^)]*\)");
js_re!(BR, r"(?i)<br\s*/?>");
js_re!(AUTOLINK, r"(?i)<((?:https?|ftp|mailto):[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>");
js_re!(HTML_TAG, r"(?i)</?[a-z][^>]*>");
js_re!(BOLD_STRIKE, r"(\*\*|~~)(.+?)\1");
js_re!(ITALIC_STAR, r"(^|[^\\*])\*(?=\S)(.+?)(?<=\S)\*");
js_re!(UNDERSCORE, r"(^|[^\p{L}\p{N}\\_])(__?)(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}_])");
js_re!(CODE, r"`([^`]*)`");
js_re!(ESCAPED, r"\\([\\`*_{}\[\]()#+\-.!~|>])");
js_re!(ENTITY, r"(?i)&(#x[0-9a-f]+|#\d+|[a-z]+);");
js_re!(SPACES, r"\s+");
js_re!(HEADING_MARK, r"^\s{0,3}#{1,6}\s+");
js_re!(QUOTE_MARK, r"^\s*>\s?");
js_re!(LIST_MARK, r"^\s*(?:[-*+]|\d+[.)])(?:\s+|$)(?:\\?\[[ xX]\](?:\s+|$))?");
js_re!(HEADER_LIKE, r"^([A-Za-z_][\w-]*\s*:|\s+\S|-\s)");
js_re!(SOURCE_LINE, r"^출처\s*[:：]");
js_re!(MATH, r"\${1,2}([^$]+?)\${1,2}");
js_re!(MEDIA, r#"(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)"#);

fn replace_all(r: &Regex, s: &str, rep: &str) -> String {
    r.replace_all(s, rep).into_owned()
}

/// JS 의 lines: body.split(/\r?\n/)
fn lines(body: &str) -> impl Iterator<Item = &str> {
    body.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l))
}

/// HTML · XML 글자 참조(&amp; · &#39; · &#x1F600;) 풀기 — entities.js decodeEntities (HTML 표)
pub fn decode_entities(s: &str) -> String {
    ENTITY
        .replace_all(s, |c: &Captures<str>| {
            let code = &c[1];
            if let Some(num) = code.strip_prefix('#') {
                let n = match num.strip_prefix(['x', 'X']) {
                    Some(h) => u32::from_str_radix(h, 16).ok(),
                    None => num.parse().ok(),
                };
                return n.filter(|&n| n > 0 && n < 0x110000).and_then(char::from_u32).map_or_else(|| c[0].to_string(), String::from);
            }
            match code.to_ascii_lowercase().as_str() {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "apos" => "'",
                "nbsp" => "\u{a0}",
                "middot" => "·",
                "hellip" => "…",
                "ndash" => "–",
                "mdash" => "—",
                "laquo" => "«",
                "raquo" => "»",
                _ => return c[0].to_string(),
            }
            .to_string()
        })
        .into_owned()
}

// 한 줄의 마크다운 기호를 걷어내 사람이 읽는 글자만 남긴다
fn strip_inline(line: &str) -> String {
    let s = LINE_BREAK.replace(line, "${1}${2}").into_owned();
    let s = replace_all(&IMAGE, &s, " ");
    let s = replace_all(&LINK, &s, "${1}");
    let s = replace_all(&BR, &s, " ");
    let s = replace_all(&AUTOLINK, &s, "${1}");
    let s = replace_all(&HTML_TAG, &s, "");
    let s = replace_all(&BOLD_STRIKE, &s, "${2}");
    let s = replace_all(&ITALIC_STAR, &s, "${1}${2}");
    let s = replace_all(&UNDERSCORE, &s, "${1}${3}");
    let s = replace_all(&CODE, &s, "${1}");
    let s = replace_all(&ESCAPED, &s, "${1}");
    let s = decode_entities(&s);
    js::trim(&replace_all(&SPACES, &s, " ")).to_string()
}

fn strip_block(line: &str) -> String {
    let s = HEADING_MARK.replace(line, "").into_owned();
    let s = QUOTE_MARK.replace(&s, "").into_owned();
    LIST_MARK.replace(&s, "").into_owned()
}

/// 표 한 줄 → "품목, 가격" (표 줄이 아니면 None, 구분선이면 "") — tables.js tableLineText
fn table_line_text(line: &str) -> Option<String> {
    if !TABLE_LINE.is_match(line).unwrap_or(false) {
        return None;
    }
    if TABLE_RULE.is_match(line).unwrap_or(false) {
        return Some(String::new());
    }
    let t = js::trim(line);
    let inner = &t[1..t.len() - 1]; // 앞뒤 | (맞는 줄이라 늘 있다)
    let mut cells = vec![];
    let mut last = 0;
    for m in TABLE_SPLIT.find_iter(inner).flatten() {
        cells.push(&inner[last..m.start()]);
        last = m.end();
    }
    cells.push(&inner[last..]);
    Some(cells.into_iter().map(|c| js::trim(&c.replace("\\|", "|")).to_string()).filter(|c| !c.is_empty()).collect::<Vec<_>>().join(", "))
}

/// 코드 블록 울타리는 빼고, 줄마다 읽는 글자로. max: 앞의 몇 줄만
pub fn plain_lines(body: &str, max: usize) -> Vec<String> {
    let mut out = vec![];
    let mut fence = false;
    for raw in lines(body) {
        if FENCE_LINE.is_match(raw).unwrap_or(false) {
            fence = !fence;
            continue;
        }
        if !fence && (RULE_LINE.is_match(raw).unwrap_or(false) || COMMENT_LINE.is_match(raw).unwrap_or(false)) {
            continue;
        }
        let text = if fence {
            js::trim(raw).to_string()
        } else {
            match table_line_text(raw) {
                Some(cells) => strip_inline(&cells),
                None => strip_inline(&strip_block(raw)),
            }
        };
        if !text.is_empty() {
            out.push(text);
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

// 읽지 못한(깨진) 머리말이 본문 맨 앞에 남아 있으면 제목 · 미리보기에서는 건너뛴다
fn without_broken_header(body: &str) -> &str {
    let Ok(Some(m)) = FRONTMATTER.captures(body) else { return body };
    let header: Vec<&str> = lines(&m[1]).filter(|l| !js::trim(l).is_empty()).collect();
    if !header.is_empty() && header.iter().all(|l| HEADER_LIKE.is_match(l).unwrap_or(false)) {
        &body[m[0].len()..]
    } else {
        body
    }
}

pub fn extract_title(body: &str) -> String {
    plain_lines(without_broken_header(body), 1).first().map_or_else(|| UNTITLED.to_string(), |t| js::slice16(t, 80))
}

/// 제목(첫 줄)을 뺀 나머지 — "출처: …" 줄은 빼고, 수식 표시($)는 걷어낸다
pub fn extract_preview(body: &str, max: usize) -> String {
    let rest: Vec<String> = plain_lines(without_broken_header(body), usize::MAX).into_iter().skip(1).filter(|l| !SOURCE_LINE.is_match(l).unwrap_or(false)).collect();
    js::slice16(&replace_all(&MATH, &rest.join(" "), "${1}"), max)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Media {
    pub src: String,
    pub alt: String,
    pub kind: &'static str,
    pub title: String,
}

fn is_local_path(src: &str) -> bool {
    static SCHEME: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^[a-z][a-z0-9+.-]*:"));
    !SCHEME.is_match(src).unwrap_or(false) && !src.starts_with('/') && !src.starts_with('#')
}

pub fn media_kind_of(src: &str, alt: &str) -> Option<&'static str> {
    let path = src.split(['?', '#']).next().unwrap_or("").to_lowercase();
    let ext = path.rsplit_once('.').map_or("", |(_, e)| e);
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" => Some("image"),
        "webm" => {
            let a = alt.to_lowercase();
            Some(if a.contains("동영상") || a.contains("영상") || a.contains("video") { "video" } else { "audio" })
        }
        "mp4" | "m4v" | "mov" | "ogv" | "mkv" => Some("video"),
        "weba" | "ogg" | "oga" | "opus" | "mp3" | "m4a" | "aac" | "wav" | "flac" => Some("audio"),
        _ => None,
    }
}

fn pdf_of_title(t: &str) -> Option<&str> {
    t.strip_prefix("pdf ").filter(|p| !p.is_empty() && !p.chars().any(js::is_space))
}

/// 본문에 들어간 폴더 안 파일들 (인터넷 주소 · data: 는 빼고)
pub fn extract_media(body: &str) -> Vec<Media> {
    let mut found = vec![];
    let mut seen = HashSet::new();
    let decode = |s: &str| js::decode_uri(s).unwrap_or_else(|| s.to_string());
    for m in MEDIA.captures_iter(body).flatten() {
        let embed = &m[1] == "!";
        let src = decode(&m[3]);
        if !is_local_path(&src) || seen.contains(&src) || (!embed && !src.starts_with("attachments/")) {
            continue;
        }
        seen.insert(src.clone());
        let alt = m[2].to_string();
        let title = m.get(4).map_or("", |t| t.as_str());
        let kind = if embed { media_kind_of(&src, &alt).unwrap_or("file") } else { "file" };
        found.push(Media { src, alt: alt.clone(), kind, title: title.to_string() });
        // PDF 썸네일이 가리키는 PDF 도 이 메모의 첨부
        let pdf = if embed { decode(pdf_of_title(title).unwrap_or("")) } else { String::new() };
        if !pdf.is_empty() && is_local_path(&pdf) && !seen.contains(&pdf) {
            seen.insert(pdf.clone());
            found.push(Media { src: pdf, alt, kind: "file", title: String::new() });
        }
    }
    found
}

pub fn is_blank_body(body: &str) -> bool {
    plain_lines(body, usize::MAX).is_empty() && extract_media(body).is_empty()
}

/// 같은 본문인가 — 파일에 쓸 때 맞추는 줄바꿈(\r\n) · 끝 빈칸은 같은 것으로
pub fn same_body(a: &str, b: &str) -> bool {
    js::trim_end(&a.replace("\r\n", "\n")) == js::trim_end(&b.replace("\r\n", "\n"))
}

// ---------- 태그 (tags.js) ----------

static TAG: LazyLock<Regex> = LazyLock::new(|| re(r#"(^|[\s(\[{,;:!?'"“‘>*_~])#([\p{L}\p{N}\p{M}_\-]+)"#));
js_re!(INDENTED_CODE, r"^( {4}|\t)");
js_re!(LINK_TARGET, r"\]\([^)]*\)");
js_re!(ANGLE, r"<[^>]*>");

pub fn is_valid_tag(name: &str) -> bool {
    js_re!(TAG_NAME, r"^[\p{L}\p{N}\p{M}_\-]+$");
    js_re!(NOT_TAG, r"^[\d_-]+$");
    TAG_NAME.is_match(name).unwrap_or(false) && !NOT_TAG.is_match(name).unwrap_or(false)
}

/// 본문의 #태그 (처음 나온 순, 대소문자만 다른 같은 태그는 하나로)
pub fn extract_tags(body: &str) -> Vec<String> {
    let mut keys = HashSet::new();
    let mut tags = vec![];
    let mut fence = false;
    for raw in lines(body) {
        if FENCE_LINE.is_match(raw).unwrap_or(false) {
            fence = !fence;
            continue;
        }
        if fence || INDENTED_CODE.is_match(raw).unwrap_or(false) {
            continue;
        }
        let line = replace_all(&CODE, raw, " ");
        let line = replace_all(&LINK_TARGET, &line, "] ");
        let line = replace_all(&ANGLE, &line, " ").replace("\\#", "#");
        for m in TAG.captures_iter(line.as_str()).flatten() {
            let name = m[2].trim_end_matches(['-', '_']);
            if is_valid_tag(name) && keys.insert(name.to_lowercase()) {
                tags.push(name.to_string());
            }
        }
    }
    tags
}

// ---------- 체크리스트 (tasks.js) ----------

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Tasks {
    pub total: u32,
    pub done: u32,
}

pub fn task_progress(body: &str) -> Tasks {
    js_re!(TASK, r"^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?=\s|$)");
    let mut t = Tasks { total: 0, done: 0 };
    let mut fence: Option<String> = None;
    for line in lines(body) {
        if let Ok(Some(f)) = FENCE_LINE.captures(line) {
            match &fence {
                None => fence = Some(f[1].to_string()),
                Some(open) if *open == f[1] => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Ok(Some(m)) = TASK.captures(line) {
            t.total += 1;
            t.done += u32::from(&m[1] != " ");
        }
    }
    t
}

// ---------- 잠금 (memo-lock.js) ----------

pub static LOCK: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"^\x{{feff}}?\s*(?:#[^\n]*\n\s*)?(?:{}\s*)?<!--\s*memoking-lock\s+(v\d+)\s+n=(\d+)\s+s=([A-Za-z0-9+/=]+)\s+i=([A-Za-z0-9+/=]+)\s+c=([A-Za-z0-9+/=]+)\s*-->\s*$",
        fancy_regex::escape(LOCK_NOTICE)
    ))
});

pub fn is_locked_body(body: &str) -> bool {
    LOCK.is_match(body).unwrap_or(false)
}
