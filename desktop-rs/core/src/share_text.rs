//! 메모를 다른 앱(카톡 · 메일)으로 보낼 때의 글 — 마크다운 기호 대신 보이는 모양 그대로.
//!   app/js/core/share-text.js shareText · inlineToText, memo-hotkeys.js hotkeyCopyText
use crate::js::{self, re};
use fancy_regex::{Captures, Regex};
use std::sync::LazyLock;

macro_rules! js_re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re($pat));
    };
}

// link-preview.js CARD_TITLE — 링크 카드는 주소만
const CARD_TITLE: &str = "미리보기";

js_re!(IMAGE_EXT, r"(?i)\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$");
js_re!(AUDIO_EXT, r"(?i)\.(m4a|mp3|wav|ogg|oga|aac|flac|opus|weba|3gp|amr)$");
js_re!(VIDEO_EXT, r"(?i)\.(mp4|webm|mov|mkv|m4v|avi)$");
js_re!(HAS_EXT, r"(?i)\.[a-z0-9]{1,5}$");
js_re!(MEDIA, r#"!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#);
js_re!(LINK, r#"\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)"#);
js_re!(BR, r"(?i)<br\s*/?>");
js_re!(AUTOLINK, r"(?i)<((?:https?|ftp|mailto):[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>");
js_re!(MAILTO, r"(?i)^mailto:");
js_re!(FORMAT_TAG, r"(?i)</?(u|mark|span|b|i|strong|em|s|del|sub|sup|small|kbd)\b[^>]*>");
js_re!(MATH, r"\$\$([^$]+)\$\$");
js_re!(BOLD, r"(?s)(\*\*|__)(?=\S)(.*?\S)\1");
js_re!(ITALIC_STAR, r"(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)");
js_re!(ITALIC_UNDER, r"(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])");
js_re!(STRIKE, r"(?s)~~(?=\S)(.*?\S)~~");
js_re!(CODE, r"`([^`]+)`");
js_re!(ESCAPED, r"\\([\\`*_{}\[\]()#+\-.!|>~$<])");

fn media_label(alt: &str, src: &str) -> String {
    let last = src.rsplit('/').next().unwrap_or("");
    let name = if alt.is_empty() { js::decode_uri_component(last).unwrap_or_else(|| last.to_string()) } else { alt.to_string() };
    let is = |r: &Regex| r.is_match(src).unwrap_or(false);
    // /\s+\]$/ → ']' (이름이 비면 "[녹음]")
    let tidy = |s: String| js::trim_end(s.strip_suffix(']').unwrap_or(&s)).to_string() + "]";
    if is(&AUDIO_EXT) {
        return tidy(format!("[녹음 {name}]"));
    }
    if is(&VIDEO_EXT) {
        return tidy(format!("[동영상 {name}]"));
    }
    if is(&IMAGE_EXT) || !is(&HAS_EXT) {
        return if alt.is_empty() { "[사진]".into() } else { format!("[사진 {alt}]") };
    }
    format!("[파일 {name}]")
}

/// 한 줄 안의 서식 기호를 빼고 읽는 글로
pub fn inline_to_text(line: &str) -> String {
    let s = MEDIA.replace_all(line, |c: &Captures<str>| media_label(&c[1], &c[2])).into_owned();
    let s = LINK
        .replace_all(&s, |c: &Captures<str>| {
            let (text, href) = (&c[1], &c[2]);
            if c.get(3).is_some_and(|t| t.as_str() == CARD_TITLE) {
                href.to_string()
            } else if href.starts_with("attachments/") {
                format!("[파일 {text}]")
            } else if !text.is_empty() && text != href {
                format!("{text} ({href})")
            } else {
                href.to_string()
            }
        })
        .into_owned();
    let s = BR.replace_all(&s, "\n").into_owned();
    let s = AUTOLINK.replace_all(&s, |c: &Captures<str>| MAILTO.replace(&c[1], "").into_owned()).into_owned();
    let s = FORMAT_TAG.replace_all(&s, "").into_owned();
    let s = MATH.replace_all(&s, |c: &Captures<str>| format!("${}$", &c[1])).into_owned();
    let s = BOLD.replace_all(&s, "${2}").into_owned();
    let s = ITALIC_STAR.replace_all(&s, "${1}${2}").into_owned();
    let s = ITALIC_UNDER.replace_all(&s, "${1}${2}").into_owned();
    let s = STRIKE.replace_all(&s, "${1}").into_owned();
    let s = CODE.replace_all(&s, "${1}").into_owned();
    ESCAPED.replace_all(&s, "${1}").into_owned()
}

js_re!(FENCE, r"^\s*(```|~~~)");
js_re!(MATH_FENCE, r"^\s*\$\$\s*$");
js_re!(LINE_END_BREAK, r"(?<!\\)\\$");
js_re!(TABLE_ROW, r"^\s*\|.*\|\s*$");
js_re!(TABLE_RULE, r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$");
js_re!(TABLE_EDGES, r"^\||\|$");
js_re!(TABLE_SPLIT, r"(?<!\\)\|");
js_re!(LIST, r"^(\s*)([-*+]|(\d{1,9})[.)])\s+(\[([ xX])\]\s+)?(.*)$");
js_re!(LEADING_SPACE, r"^\s");
js_re!(HEADING, r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$");
js_re!(RULE, r"^\s*([-*_])(\s*\1){2,}\s*$");
js_re!(QUOTE, r"^\s*>\s?(.*)$");
js_re!(LEAD, r"^(\s*)");
js_re!(BLANKS, r"\n{3,}");
js_re!(KIND, r"^((?: {2})*)([•]|[☐☑]|\d+\.) ");
js_re!(LEADING_BLANK_LINES, r"^(?:[ \t]*\n)+");

/// 마크다운 본문 → 보내기용 글
pub fn share_text(markdown: &str) -> String {
    let text = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut out: Vec<String> = vec![];
    let mut counters: Vec<Option<u64>> = vec![]; // 들여쓰기 단계마다 번호
    let (mut fence, mut math) = (false, false);
    let is = |r: &Regex, s: &str| r.is_match(s).unwrap_or(false);
    for line in text.split('\n') {
        if is(&FENCE, line) {
            fence = !fence;
            continue;
        }
        if fence {
            out.push(line.to_string());
            continue;
        }
        if is(&MATH_FENCE, line) {
            math = !math;
            continue;
        }
        if math {
            out.push(js::trim(line).to_string());
            continue;
        }
        // 줄 끝의 \ 는 마크다운의 줄바꿈 표시 — 글에는 넣지 않는다
        let raw = LINE_END_BREAK.replace(line, "").into_owned();
        // 표: 구분 줄은 빼고 칸 사이 " | "
        if is(&TABLE_ROW, &raw) {
            if is(&TABLE_RULE, &raw) {
                continue;
            }
            let inner = TABLE_EDGES.replace_all(js::trim(&raw), "").into_owned();
            let mut cells = vec![];
            let mut last = 0;
            for m in TABLE_SPLIT.find_iter(&inner).flatten() {
                cells.push(&inner[last..m.start()]);
                last = m.end();
            }
            cells.push(&inner[last..]);
            out.push(cells.iter().map(|c| inline_to_text(js::trim(c)).replace('\n', " ")).collect::<Vec<_>>().join(" | "));
            counters.clear();
            continue;
        }
        // 줄 앞 들여쓰기(편집기가 U+00A0 로 지킨 것)는 그 칸 수 그대로
        let nbsp = raw.chars().take_while(|c| *c == '\u{a0}').count();
        if nbsp > 0 {
            counters.clear();
            let rest: String = raw.chars().skip(nbsp).collect();
            out.push(" ".repeat(nbsp) + &inline_to_text(js::trim(&rest)));
            continue;
        }
        if let Ok(Some(m)) = LIST.captures(raw.as_str()) {
            let depth = m[1].replace('\t', "    ").encode_utf16().count() / 2;
            counters.resize(depth + 1, None);
            let num = m.get(3).map(|n| n.as_str().parse::<u64>().unwrap_or(0));
            let bullet = if m.get(4).is_some() {
                if js::trim(m.get(5).map_or("", |x| x.as_str())).is_empty() { "☐".to_string() } else { "☑".to_string() }
            } else if let Some(n) = num {
                let v = counters[depth].map_or(n, |c| c + 1);
                counters[depth] = Some(v);
                format!("{v}.")
            } else {
                "•".to_string()
            };
            if num.is_none() {
                counters[depth] = None;
            }
            out.push(format!("{}{bullet} {}", "  ".repeat(depth), inline_to_text(&m[6])));
            continue;
        }
        if !js::trim(&raw).is_empty() && !is(&LEADING_SPACE, &raw) {
            counters.clear();
        }
        if let Ok(Some(h)) = HEADING.captures(raw.as_str()) {
            out.push(inline_to_text(&h[1]));
            continue;
        }
        if is(&RULE, &raw) {
            out.push("———".into());
            continue;
        }
        if let Ok(Some(q)) = QUOTE.captures(raw.as_str()) {
            out.push(format!("│ {}", inline_to_text(&q[1])));
            continue;
        }
        // 목록 항목 아래로 이어지는 줄(들여쓴 문단)은 들여쓰기 그대로
        let lead = LEAD.captures(raw.as_str()).ok().flatten().map_or(0, |c| c[1].encode_utf16().count());
        let body = inline_to_text(js::trim(&raw));
        out.push(if lead >= 2 { format!("{}{body}", "  ".repeat(lead / 2)) } else { body });
    }
    // 빈 줄은 두 개 이상 겹치지 않게, 같은 목록 항목 사이 빈 줄(느슨한 목록)은 붙인다
    let joined = BLANKS.replace_all(&out.join("\n"), "\n\n").into_owned();
    let rows: Vec<&str> = joined.split('\n').collect();
    let kind = |line: Option<&&str>| -> Option<String> {
        let c = KIND.captures(*line?).ok()??;
        let k = match &c[2] {
            "•" => "b",
            x if x.chars().any(|ch| ch.is_ascii_digit()) => "n",
            _ => "t",
        };
        Some(format!("{}:{k}", c[1].len()))
    };
    let kept: Vec<&str> = rows
        .iter()
        .enumerate()
        .filter(|(i, line)| {
            let prev = if *i == 0 { None } else { kind(rows.get(i - 1)) };
            !line.is_empty() || prev.is_none() || prev != kind(rows.get(i + 1))
        })
        .map(|(_, l)| *l)
        .collect();
    // 앞뒤 빈 줄만 걷고 첫 줄의 들여쓰기는 남긴다
    js::trim_end(&LEADING_BLANK_LINES.replace(&kept.join("\n"), "")).to_string()
}

/// 메모 단축키 · 목록의 "글 복사": 제목 줄 아래 글만 (제목 줄이 없거나 아래가 비면 전체)
pub fn hotkey_copy_text(markdown: &str) -> String {
    js_re!(HEAD, r"^\s{0,3}#{1,6}\s");
    let body = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = body.split('\n').collect();
    if let Some(first) = lines.iter().position(|l| !js::trim(l).is_empty()) {
        if HEAD.is_match(lines[first]).unwrap_or(false) {
            let rest = share_text(&lines[first + 1..].join("\n"));
            if !js::trim(&rest).is_empty() {
                return rest;
            }
        }
    }
    share_text(&body)
}
