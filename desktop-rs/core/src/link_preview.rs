//! 링크 미리보기 · 인터넷 그림 — app/js/core/link-preview.js (웹페이지에서 제목 · 설명 · 사진 읽기, 유튜브) · remote-images.js (그림 확장자)
use crate::body::decode_entities;
use crate::js::{self, re};
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
use url::Url;

macro_rules! js_re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re($pat));
    };
}

js_re!(ATTR, r#"([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))"#);
js_re!(META, r"(?i)<meta\b[^>]*>");
js_re!(BASE, r"(?i)<base\b[^>]*>");
js_re!(TITLE, r"(?is)<title[^>]*>(.*?)</title>");
js_re!(LINK, r"(?i)<link\b[^>]*>");
js_re!(SPACES, r"\s+");
js_re!(CHARSET_HEADER, r#"(?i)charset\s*=\s*["']?([\w-]+)"#);
js_re!(CHARSET_META, r#"(?i)<meta[^>]+charset\s*=\s*["']?([\w-]+)"#);
js_re!(URL_EXT, r"(?i)\.([a-z0-9]{2,5})$");

/// new URL(url) — 못 읽으면 None
fn parse(url: &str) -> Option<Url> {
    Url::parse(url).ok()
}

/// 카드에 보여줄 사이트 이름 (없으면 주소의 호스트, www. 뺌)
pub fn host_of(url: &str) -> String {
    let host = parse(url).and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    host.strip_prefix("www.").map_or(host.clone(), str::to_string)
}

/// 유튜브 동영상 주소면 동영상 ID (watch · youtu.be · shorts · live · embed · m. · music.)
pub fn youtube_video_id(url: &str) -> Option<String> {
    let u = parse(url)?;
    let lower = u.host_str().unwrap_or_default().to_lowercase();
    let host = ["www.", "m.", "music."].iter().find_map(|p| lower.strip_prefix(p)).unwrap_or(&lower);
    let id = if host == "youtu.be" {
        u.path().split('/').nth(1).map(str::to_string)
    } else if host == "youtube.com" || host == "youtube-nocookie.com" {
        let mut parts = u.path().split('/').filter(|p| !p.is_empty());
        match (parts.next(), parts.next()) {
            (Some("watch"), _) => u.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned()),
            (Some("shorts" | "live" | "embed" | "v"), second) => second.map(str::to_string),
            _ => None,
        }
    } else {
        None
    };
    id.filter(|id| id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

/// 유튜브 oEmbed 요청 주소 (동영상이 아니면 None)
pub fn youtube_oembed_url(url: &str) -> Option<String> {
    // ID 는 [\w-] 뿐이라 encodeURIComponent 해도 그대로
    youtube_video_id(url).map(|id| format!("https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}"))
}

/// 빈칸을 하나로 · 앞뒤 빈칸 빼기 · max 를 넘으면 … (UTF-16 길이로, JS 와 같게)
fn squash(s: &str, max: usize) -> String {
    let t = js::trim(&SPACES.replace_all(s, " ")).to_string();
    if t.encode_utf16().count() > max {
        format!("{}…", js::slice16(&t, max - 1))
    } else {
        t
    }
}

/// oEmbed 응답(JSON 글자) → { title, description, image, icon, site }. 썸네일은 정해진 주소(hqdefault)
pub fn parse_youtube_oembed(text: &str, url: &str) -> Value {
    let data: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let field = |k: &str| match &data[k] {
        Value::Null => String::new(),
        v => js::string(v),
    };
    let image = youtube_video_id(url).map(|id| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")).unwrap_or_default();
    json!({
        "title": squash(&field("title"), 200),
        "description": squash(&field("author_name"), 300),
        "image": image,
        "icon": "https://www.youtube.com/favicon.ico",
        "site": "YouTube",
    })
}

/// 받아 둔 미리보기가 예전 방식(kind 없음)으로 만든 유튜브 카드라 다시 받아야 하는가
pub fn stale_youtube_entry(url: &str, entry: &Value) -> bool {
    let truthy = |v: &Value| !matches!(v, Value::Null | Value::Bool(false)) && v != "" && v != 0;
    truthy(entry) && youtube_video_id(url).is_some() && !truthy(&entry["kind"])
}

fn clean(s: &str, max: usize) -> String {
    squash(&decode_entities(s, true), max)
}

/// 태그의 속성들 (이름은 소문자, 같은 이름이면 뒤의 것)
fn attrs_of(tag: &str) -> serde_json::Map<String, Value> {
    let mut attrs = serde_json::Map::new();
    for c in ATTR.captures_iter(tag).flatten() {
        let v = c.get(3).or(c.get(4)).or(c.get(5)).map_or("", |m| m.as_str());
        attrs.insert(c[1].to_lowercase(), v.into());
    }
    attrs
}

/// 상대 주소 → 절대 주소 (http · https 만, 아니면 "")
fn absolute(href: Option<&str>, base: &str) -> String {
    let Some(href) = href.filter(|h| !h.is_empty()) else { return String::new() };
    let joined = parse(base).and_then(|b| b.join(&decode_entities(js::trim(href), true)).ok());
    joined.filter(|u| matches!(u.scheme(), "http" | "https")).map(|u| u.to_string()).unwrap_or_default()
}

/// HTML(앞부분만 있어도 됨)에서 미리보기 정보 → { title, description, image, icon, site }
pub fn parse_link_preview(html: &str, page_url: &str) -> Value {
    let head = js::slice16(html, 600_000);
    let mut meta = serde_json::Map::new();
    for m in META.find_iter(head.as_str()).flatten() {
        let a = attrs_of(m.as_str());
        let key = a.get("property").or(a.get("name")).or(a.get("itemprop")).and_then(Value::as_str).unwrap_or_default().to_lowercase();
        if !key.is_empty() && !meta.contains_key(&key) {
            if let Some(content) = a.get("content") {
                meta.insert(key, content.clone());
            }
        }
    }
    // JS 의 a || b || c — 없거나 빈 글은 건너뛴다
    let first = |keys: &[&str]| keys.iter().find_map(|k| meta.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty())).map(str::to_string);
    let mut base = page_url.to_string();
    if let Some(tag) = BASE.find(head.as_str()).ok().flatten() {
        let b = absolute(attrs_of(tag.as_str()).get("href").and_then(Value::as_str), page_url);
        if !b.is_empty() {
            base = b;
        }
    }
    let title_tag = TITLE.captures(head.as_str()).ok().flatten().map(|c| c[1].to_string()).unwrap_or_default();
    let title = clean(&first(&["og:title", "twitter:title"]).unwrap_or(title_tag), 200);
    let description = clean(&first(&["og:description", "twitter:description", "description"]).unwrap_or_default(), 300);
    let image = absolute(first(&["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]).as_deref(), &base);
    let site = clean(&first(&["og:site_name", "application-name"]).unwrap_or_default(), 80);

    let mut icon = String::new();
    let mut best = -1.0;
    for m in LINK.find_iter(head.as_str()).flatten() {
        let a = attrs_of(m.as_str());
        let rel = a.get("rel").and_then(Value::as_str).unwrap_or_default().to_lowercase();
        let rel: Vec<&str> = rel.split(js::is_space).collect();
        let apple = rel.contains(&"apple-touch-icon");
        if !rel.contains(&"icon") && !apple {
            continue;
        }
        let sizes = a.get("sizes").and_then(Value::as_str).unwrap_or_default();
        let n = js::number(&Value::from(sizes.split('x').next().unwrap_or_default()));
        let size = if n != 0.0 && !n.is_nan() { n } else if apple { 180.0 } else { 16.0 };
        // 너무 큰 아이콘보다 32~64px 근처를 고른다
        let score = if (32.0..=96.0).contains(&size) { 1000.0 - (size - 48.0).abs() } else if size < 32.0 { size } else { 200.0 - size / 10.0 };
        let href = absolute(a.get("href").and_then(Value::as_str), &base);
        if !href.is_empty() && score > best {
            best = score;
            icon = href;
        }
    }
    if icon.is_empty() {
        icon = absolute(Some("/favicon.ico"), &base);
    }
    json!({ "title": title, "description": description, "image": image, "icon": icon, "site": site })
}

/// 응답 헤더 · HTML 앞부분(바이트를 latin1 글자로)에서 글자 인코딩 (없으면 utf-8)
pub fn detect_charset(content_type: &str, head_latin1: &str) -> String {
    if let Some(c) = CHARSET_HEADER.captures(content_type).ok().flatten() {
        return c[1].to_lowercase();
    }
    let head: String = head_latin1.chars().take(4096).collect();
    CHARSET_META.captures(head.as_str()).ok().flatten().map_or_else(|| "utf-8".into(), |c| c[1].to_lowercase())
}

/// Content-Type → 그림 확장자
pub fn image_ext_from_type(content_type: &str) -> Option<&'static str> {
    Some(match js::trim(content_type.split(';').next().unwrap_or_default()).to_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/bmp" | "image/x-ms-bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        _ => return None,
    })
}

/// 서버가 형식을 안 알려 줄 때 주소 끝의 확장자로 짐작
pub fn image_ext_from_url(url: &str) -> Option<&'static str> {
    let u = parse(url)?;
    let ext = URL_EXT.captures(u.path()).ok().flatten()?[1].to_lowercase();
    ["png", "jpg", "gif", "webp", "avif", "bmp", "svg", "ico"].into_iter().find(|e| *e == ext || (ext == "jpeg" && *e == "jpg"))
}
