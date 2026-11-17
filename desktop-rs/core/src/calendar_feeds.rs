//! 다른 캘린더 구독 — app/js/core/calendar-feed-list.js (구독 목록 정리 · 받은 글 확인) 와 caldav.js (CalDAV 계정 → .ics 한 글)
//!   주소 · 계정은 비밀이라 메모 폴더가 아니라 이 PC 설정에만 둔다 (받기 · 저장은 앱이)
use crate::js;
use serde_json::{json, Map, Value};
use url::Url;

pub const MAX_FEED_BYTES: usize = 5 * 1024 * 1024;
pub const FEED_FRESH_MS: i64 = 15 * 60 * 1000; // 받은 지 이보다 오래되면 다시 받는다
pub const TOO_BIG: &str = "캘린더가 너무 커요 (5MB 넘음)";
const MAX_FEEDS: usize = 10;
// 구독 캘린더 색 (메모 색과 겹치지 않는 진한 색 — 달력에서 "다른 캘린더" 로 보이게)
const FEED_COLORS: [&str; 6] = ["#4285f4", "#0b8043", "#8e24aa", "#f4511e", "#039be5", "#616161"];

/// 붙여 넣은 캘린더 주소 → 받을 수 있는 주소 (webcal:// 은 https:// 로). 아니면 None
fn normalize_feed_url(raw: &Value) -> Option<String> {
    let s = if raw.is_null() { String::new() } else { js::string(raw) };
    let text = js::trim(&s);
    let lower = text.to_ascii_lowercase();
    let text = ["webcal://", "webcals://"].iter().find(|p| lower.starts_with(*p)).map_or_else(|| text.to_string(), |p| format!("https://{}", &text[p.len()..]));
    let url = Url::parse(&text).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// 주소로 짐작한 캘린더 이름 — 이름을 비워 두면
fn feed_label(url: &str) -> String {
    let Some(host) = Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)) else { return "캘린더".into() };
    let under = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    if under("google.com") {
        "Google 캘린더".into()
    } else if under("icloud.com") || under("me.com") {
        "iCloud 캘린더".into()
    } else if host.contains("outlook") || host.contains("office") || host.contains("live.com") {
        "Outlook 캘린더".into()
    } else if under("naver.com") {
        "네이버 캘린더".into()
    } else {
        host.strip_prefix("www.").unwrap_or(&host).to_string()
    }
}

fn is_color(v: &Value) -> bool {
    v.as_str().is_some_and(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|h| h.is_ascii_hexdigit()))
}

/// 캘린더별 설정 { 이름 또는 ID: { on, color? } } 을 안전한 모양으로 (네이버 캘린더 · 휴대폰 캘린더). 비었으면 None
fn normalize_cals(o: &Value) -> Option<Value> {
    let mut out = Map::new();
    for (k, v) in o.as_object()?.iter().take(100) {
        if k.is_empty() || k.encode_utf16().count() > 80 {
            continue;
        }
        let mut c = json!({ "on": v["on"] != false });
        if is_color(&v["color"]) {
            c["color"] = v["color"].clone();
        }
        out.insert(k.clone(), c);
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// 저장해 둔 구독 목록을 안전한 모양으로 [{ id, name, url, color, on, user?, pass?, cals? }] (user · pass 는 CalDAV 계정)
pub fn normalize_feeds(list: &Value) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Value> = vec![];
    for f in list.as_array().into_iter().flatten() {
        let Some(url) = normalize_feed_url(&f["url"]) else { continue };
        let user = f["user"].as_str().map(|u| js::slice16(js::trim(u), 200)).unwrap_or_default();
        // 같은 CalDAV 서버의 다른 계정은 따로
        if !seen.insert(format!("{user}@{url}")) {
            continue;
        }
        let id = f["id"].as_str().filter(|id| (1..=40).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        let id = id.map_or_else(|| format!("c{}", &uuid::Uuid::new_v4().simple().to_string()[..6]), str::to_string);
        let raw_name = if f["name"].is_null() { String::new() } else { js::string(&f["name"]) };
        let name = js::slice16(&raw_name.split(js::is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" "), 40);
        let mut feed = json!({
            "id": id,
            "name": if name.is_empty() { feed_label(&url) } else { name },
            "url": url,
            "color": if is_color(&f["color"]) { f["color"].clone() } else { FEED_COLORS[out.len() % FEED_COLORS.len()].into() },
            "on": f["on"] != false,
        });
        if !user.is_empty() {
            let pass = if f["pass"].is_null() { String::new() } else { js::string(&f["pass"]) };
            feed["user"] = user.into();
            feed["pass"] = js::slice16(&pass, 200).into();
        }
        if let Some(cals) = normalize_cals(&f["cals"]) {
            feed["cals"] = cals;
        }
        out.push(feed);
        if out.len() >= MAX_FEEDS {
            break;
        }
    }
    out
}

/// 응답 상태가 실패면 알기 쉬운 오류 (본문을 받기 전에 먼저 볼 때)
pub fn check_feed_status(status: u16) -> Result<(), String> {
    match status {
        401 | 403 | 404 => Err("캘린더를 볼 수 없어요. 주소가 바뀌었거나 비공개 주소를 다시 만들었는지 확인해 주세요".into()),
        200..=299 => Ok(()),
        _ => Err(format!("캘린더 서버 오류 ({status})")),
    }
}

/// 받은 글이 iCal 인가 (로그인 화면 HTML 같은 것을 거르게) → 그 글, 아니면 알기 쉬운 오류
pub fn feed_response_text(status: u16, text: String) -> Result<String, String> {
    check_feed_status(status)?;
    if !js::slice16(&text, 2000).to_ascii_uppercase().contains("BEGIN:VCALENDAR") {
        return Err("캘린더(iCal) 주소가 아니에요. Google 캘린더는 \"iCal 형식의 비공개 주소\" 를 넣어 주세요".into());
    }
    Ok(text)
}

// ---------- CalDAV (네이버 캘린더처럼 .ics 주소 없이 아이디 · 비밀번호로만 여는 캘린더) ----------
//   계정의 캘린더를 모두 찾아(PROPFIND) 일정 주소를 모으고(PROPFIND) 내용을 받아(REPORT calendar-multiget) 한 .ics 글로 합친다.
//   calendar-query 는 쓰지 않는다: 네이버는 그 답에 일정 내용을 빼고 준다

const FIND: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><d:current-user-principal/><c:calendar-home-set/></d:prop></d:propfind>"#;
const LIST: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>"#;
const ITEMS: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>"#;
const MULTIGET_BATCH: usize = 100;

fn multiget(paths: &[String]) -> String {
    let hrefs: String = paths.iter().map(|p| format!("<d:href>{}</d:href>", p.replace('&', "&amp;").replace('<', "&lt;"))).collect();
    format!(r#"<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>{hrefs}</c:calendar-multiget>"#)
}

fn unxml(s: &str) -> String {
    let s = js::re(r"<!\[CDATA\[((?s:.)*?)\]\]>").replace_all(s, "$1").into_owned();
    let code = |c: &fancy_regex::Captures<str>, radix| u32::from_str_radix(&c[1], radix).ok().and_then(char::from_u32).map_or_else(|| c[0].to_string(), String::from);
    let s = js::re(r"(?i)&#x([0-9a-f]+);").replace_all(&s, |c: &fancy_regex::Captures<str>| code(c, 16)).into_owned();
    let s = js::re(r"&#(\d+);").replace_all(&s, |c: &fancy_regex::Captures<str>| code(c, 10)).into_owned();
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// 접두어(d: · D: · 없음)와 상관없이 요소 하나의 속 글
fn inner(xml: &str, name: &str) -> String {
    let re = js::re(&format!(r"<(?:[\w-]+:)?{name}\b[^>]*?(?:/>|>((?s:.)*?)</(?:[\w-]+:)?{name}>)"));
    re.captures(xml).ok().flatten().and_then(|c| c.get(1).map(|m| m.as_str().to_string())).unwrap_or_default()
}

fn href_in(xml: &str) -> String {
    js::trim(&unxml(&inner(xml, "href"))).to_string()
}

fn has_type(resp: &str, kind: &str) -> bool {
    js::re(&format!(r"<(?:[\w-]+:)?{kind}[\s/>]")).is_match(&inner(resp, "resourcetype")).unwrap_or(false)
}

fn responses(xml: &str) -> Vec<String> {
    js::re(r"<(?:[\w-]+:)?response\b[^>]*>((?s:.)*?)</(?:[\w-]+:)?response>").captures_iter(xml).filter_map(|c| Some(c.ok()?[1].to_string())).collect()
}

/// 받은 답 하나: (상태, Location, 본문)
pub type Reply = (u16, String, String);

/// CalDAV 계정의 일정을 모두 받아 .ics 글 하나로.
///   request(method, url, headers, body) 는 넘겨 가지 않는(redirect: manual) HTTP 한 번 — 앱이 넘긴다
pub fn caldav_ics(feed_url: &str, user: &str, pass: &str, mut request: impl FnMut(&str, &str, &[(&str, &str)], &str) -> Result<Reply, String>) -> Result<String, String> {
    use base64::Engine;
    let base = Url::parse(feed_url).map_err(|e| e.to_string())?;
    if base.scheme() != "https" {
        return Err("CalDAV 는 https:// 주소만 돼요 (비밀번호가 그대로 보내지지 않게)".into());
    }
    let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}")));
    let mut send = |method: &str, mut url: Url, depth: &str, body: &str| -> Result<(Url, String), String> {
        for hops in 0.. {
            // 비밀번호는 처음 넣은 서버에만 보낸다 (서버가 알려 준 다른 곳으로는 보내지 않음)
            if url.origin() != base.origin() {
                return Err("캘린더 서버가 다른 곳으로 보냈어요".into());
            }
            let headers = [("Authorization", auth.as_str()), ("Depth", depth), ("Content-Type", "application/xml; charset=utf-8")];
            let (status, location, text) = request(method, url.as_str(), &headers, body)?;
            if (300..400).contains(&status) && !location.is_empty() && hops < 3 {
                url = url.join(&location).map_err(|e| e.to_string())?;
                continue;
            }
            match status {
                401 => return Err("아이디나 비밀번호가 맞지 않아요. 네이버는 \"애플리케이션 비밀번호\" 를 넣어 주세요".into()),
                403 => return Err("캘린더를 볼 수 없어요 (권한 없음)".into()),
                200..=299 => return Ok((url, text)),
                _ => return Err(format!("캘린더 서버 오류 ({status})")),
            }
        }
        unreachable!()
    };
    let join = |url: &Url, href: &str| url.join(href).map_err(|e| e.to_string());

    // 1. 넣은 주소가 캘린더면 그것만, 아니면 계정 → 캘린더 모음 → 캘린더들
    let (first_url, first) = send("PROPFIND", base.clone(), "0", FIND)?;
    // 캘린더 이름: 서버의 displayname, 없으면 주소 끝 (줄바꿈은 빼서 .ics 한 줄에 들어가게)
    let cal_of = |r: &str, url: Url| {
        let shown = js::re(r"[\x00-\x1f]+").replace_all(&unxml(&inner(r, "displayname")), " ").trim_matches(js::is_space).to_string();
        let last = url.path().split('/').rfind(|p| !p.is_empty()).unwrap_or("");
        let shown = if shown.is_empty() { js::decode_uri_component(last).unwrap_or_else(|| last.to_string()) } else { shown };
        let name = js::slice16(&shown, 60);
        (url, if name.is_empty() { "캘린더".to_string() } else { name })
    };
    let cals = if has_type(&first, "calendar") {
        vec![cal_of(&first, first_url)]
    } else {
        let mut home = href_in(&inner(&first, "calendar-home-set"));
        if home.is_empty() {
            let principal = href_in(&inner(&first, "current-user-principal"));
            if !principal.is_empty() {
                home = href_in(&inner(&send("PROPFIND", join(&first_url, &principal)?, "0", FIND)?.1, "calendar-home-set"));
            }
        }
        let (list_url, list) = send("PROPFIND", if home.is_empty() { first_url.clone() } else { join(&first_url, &home)? }, "1", LIST)?;
        let mut cals = vec![];
        for r in responses(&list).iter().filter(|r| has_type(r, "calendar")) {
            cals.push(cal_of(r, join(&list_url, &href_in(r))?));
        }
        cals
    };
    if cals.is_empty() {
        return Err("이 계정에서 캘린더를 찾지 못했어요".into());
    }

    // 2. 캘린더마다 일정 주소 → 내용(100개씩) → 한 .ics 로 (시간대는 겹치지 않게 한 번씩)
    let mut parts: Vec<String> = vec![];
    let mut zones = std::collections::HashSet::new();
    let mut size = 0;
    let block = js::re(r"(?m)^BEGIN:(VEVENT|VTIMEZONE)\r$(?s:.)*?^END:\1(?=\r?$)");
    for (url, name) in cals {
        let (items_url, items) = send("PROPFIND", url, "1", ITEMS)?;
        let mut paths = vec![];
        for r in responses(&items).iter().filter(|r| !has_type(r, "collection")) {
            let u = join(&items_url, &href_in(r))?;
            if u.origin() == base.origin() {
                paths.push(u.path().to_string());
            }
        }
        for chunk in paths.chunks(MULTIGET_BATCH) {
            let (_, xml) = send("REPORT", items_url.clone(), "1", &multiget(chunk))?;
            for r in responses(&xml) {
                let ics = js::re(r"\r\n?|\n").replace_all(&unxml(&inner(&r, "calendar-data")), "\r\n").into_owned();
                for c in block.captures_iter(ics.as_str()).filter_map(Result::ok) {
                    let (text, kind) = (&c[0], &c[1]);
                    if kind == "VTIMEZONE" {
                        let tz = js::re(r"(?m)^TZID:(.*)\r$").captures(text).ok().flatten().map(|t| t[1].to_string());
                        if !zones.insert(tz) {
                            continue;
                        }
                    }
                    let tagged = if kind == "VEVENT" { text.replacen("BEGIN:VEVENT\r\n", &format!("BEGIN:VEVENT\r\nX-MK-CAL:{name}\r\n"), 1) } else { text.to_string() };
                    size += tagged.encode_utf16().count();
                    if size > MAX_FEED_BYTES {
                        return Err(TOO_BIG.into());
                    }
                    parts.push(tagged);
                }
            }
        }
    }
    let mut out = vec!["BEGIN:VCALENDAR".to_string(), "VERSION:2.0".into(), "PRODID:-//MemoKing//CalDAV//KO".into()];
    out.extend(parts);
    out.extend(["END:VCALENDAR".into(), String::new()]);
    Ok(out.join("\r\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caldav_follows_home_and_merges_calendars() {
        let mut calls = vec![];
        let ev = |uid: &str| format!("BEGIN:VCALENDAR\nBEGIN:VTIMEZONE\nTZID:Asia/Seoul\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:{uid}\nEND:VEVENT\nEND:VCALENDAR");
        let mut server = |method: &str, url: &str, headers: &[(&str, &str)], body: &str| -> Result<Reply, String> {
            calls.push(format!("{method} {url}"));
            assert_eq!(headers[0], ("Authorization", "Basic 7JWE7J2065SUOnB3"));
            let ok = |xml: String| Ok((207, String::new(), xml));
            match (method, url) {
                ("PROPFIND", "https://cal.example/") => Ok((301, "/dav/".into(), String::new())),
                ("PROPFIND", "https://cal.example/dav/") => ok("<D:multistatus xmlns:D=\"DAV:\"><D:response><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><C:calendar-home-set><D:href>/dav/home/</D:href></C:calendar-home-set></D:prop></D:propstat></D:response></D:multistatus>".into()),
                ("PROPFIND", "https://cal.example/dav/home/") => ok("<d:response><d:href>/dav/home/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/home/work/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>업무 &amp; 회의</d:displayname></d:prop></d:propstat></d:response>".into()),
                ("PROPFIND", "https://cal.example/dav/home/work/") => ok("<d:response><d:href>/dav/home/work/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/home/work/a.ics</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response><d:response><d:href>https://evil.example/b.ics</d:href></d:response>".into()),
                ("REPORT", "https://cal.example/dav/home/work/") => {
                    assert!(body.contains("<d:href>/dav/home/work/a.ics</d:href>") && !body.contains("evil"), "{body}");
                    ok(format!("<d:response><c:calendar-data><![CDATA[{}]]></c:calendar-data></d:response><d:response><c:calendar-data>{}</c:calendar-data></d:response>", ev("a"), ev("b")))
                }
                _ => panic!("{method} {url}"),
            }
        };
        let ics = caldav_ics("https://cal.example/", "아이디", "pw", &mut server).unwrap();
        assert_eq!(ics, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//MemoKing//CalDAV//KO\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Seoul\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nX-MK-CAL:업무 & 회의\r\nUID:a\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nX-MK-CAL:업무 & 회의\r\nUID:b\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
        assert_eq!(calls.len(), 5);
        // 다른 서버로 넘기면 비밀번호를 보내지 않는다 · http 는 받지 않는다
        let mut away = |_: &str, _: &str, _: &[(&str, &str)], _: &str| -> Result<Reply, String> { Ok((302, "https://evil.example/".into(), String::new())) };
        assert_eq!(caldav_ics("https://cal.example/", "a", "b", &mut away).unwrap_err(), "캘린더 서버가 다른 곳으로 보냈어요");
        assert!(caldav_ics("http://cal.example/", "a", "b", &mut away).unwrap_err().contains("https://"));
    }
}
