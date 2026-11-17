//! 알림 보관함 규칙 — Windows 알림 DB 의 값 (notifications.js) · 팝업 알림 창의 글 (popup-notify.js) 을 보관함 항목으로.
use crate::js::{self, re, slice16};
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

macro_rules! js_re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re($pat));
    };
}

js_re!(TOAST, r"(?i)<toast[\s>]");
js_re!(TEXT, r"(?is)<text\b[^>]*>(.*?)</text>");
js_re!(TAG, r"<[^>]+>");
js_re!(IMAGE, r"(?i)<image\b([^>]*)>");
js_re!(SRC, r#"(?i)\bsrc\s*=\s*"([^"]*)""#);
js_re!(PLACEMENT, r#"(?i)\bplacement\s*=\s*"([^"]*)""#);
js_re!(SPACES, r"\s+");
js_re!(NOT_LETTER, r"[^\p{L}\p{N}]");
js_re!(LETTER, r"[\p{L}\p{N}]");
js_re!(LONE, r"(?i)^[0-9ox]$");
js_re!(CONTROL, r"(?i)^(닫기|x|close|답장|reply|전송|보기|확인)$");
js_re!(LINE_TAIL, r"(\s+(?:[^\p{L}\p{N}\s]{1,2}|[xXoO0×✕]))+$");
js_re!(TITLE, r"^(.*\S)\s+\(([^()]*)\)$");

// 알림 창 글에서 뺄 것: 앱 이름만 있는 줄, 시각만 있는 줄("오후 3:12", "15:12"), 버튼 글자
static NOISE: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    [re(r"(?i)^(카카오톡|kakaotalk)$"), re(r"^(오전|오후)\s*\d{1,2}:\d{2}$"), re(r"(?i)^\d{1,2}:\d{2}(\s*(AM|PM))?$"), re(r"(?i)^(닫기|답장|보기|확인|close|reply)$")]
});

pub const UNKNOWN_APP: &str = "알 수 없는 앱";
pub const KAKAO_BODY_Y: f64 = 58.0;
pub const SAME_WINDOW_MS: f64 = 15_000.0;

fn test(r: &Regex, s: &str) -> bool {
    r.is_match(s).unwrap_or(false)
}

fn noise(line: &str) -> bool {
    NOISE.iter().any(|r| test(r, line))
}

/// Windows FILETIME(1601년부터 100나노초) → 밀리초 시각
pub fn file_time_to_ms(ticks: i64) -> i64 {
    ticks / 10000 - 11_644_473_600_000
}

/// 토스트 알림 XML → { title, body, image }
pub fn parse_toast_xml(xml: &str) -> Option<Value> {
    if !test(&TOAST, xml) {
        return None;
    }
    let decode = |s: &str| crate::body::decode_entities(s, false);
    let texts: Vec<String> = TEXT.captures_iter(xml).flatten().map(|c| js::trim(&decode(&TAG.replace_all(&c[1], ""))).to_string()).filter(|t| !t.is_empty()).collect();
    let images: Vec<(String, String)> = IMAGE
        .captures_iter(xml)
        .flatten()
        .filter_map(|c| {
            let src = SRC.captures(&c[1]).ok().flatten()?[1].to_string();
            let placement = PLACEMENT.captures(&c[1]).ok().flatten().map(|p| p[1].to_string()).unwrap_or_default();
            Some((decode(&src), placement))
        })
        .collect();
    let image = images.iter().find(|i| i.1 == "appLogoOverride").or(images.first()).map(|i| i.0.clone());
    let (title, rest) = texts.split_first()?;
    Some(json!({ "title": title, "body": rest.join("\n"), "image": image }))
}

/// 앱 이름을 모를 때: "Microsoft.Teams_8wekyb3d8bbwe!MSTeams" → "MSTeams", "com.daou.msn" → "msn"
pub fn fallback_app_name(app_id: &str) -> String {
    let after_bang = app_id.rsplit_once('!').map_or(app_id, |(_, t)| t);
    let tail = after_bang.rsplit(['\\', '/']).next().unwrap_or("");
    let is_exe = tail.to_lowercase().ends_with(".exe");
    let name = if tail.contains('.') && !is_exe { tail.rsplit('.').next().unwrap_or("") } else if is_exe { &tail[..tail.len() - 4] } else { tail };
    [name, app_id].iter().find(|s| !s.is_empty()).map_or(UNKNOWN_APP.into(), |s| s.to_string())
}

/// 검색: 앱 이름 · 제목 · 내용, 빈칸으로 나눈 모든 낱말을 담는가
pub fn matches_query(entry: &Value, query: &str) -> bool {
    let s = |k: &str| js::string(&entry[k]);
    let hay = format!("{} {} {}", s("app"), s("title"), s("body")).to_lowercase();
    query.to_lowercase().split(js::is_space).filter(|w| !w.is_empty()).all(|w| hay.contains(w))
}

/// 지켜볼 앱: 프로세스 이름 → 보관함에 보일 이름
pub const POPUP_APPS: [(&str, &str); 1] = [("KakaoTalk", "카카오톡")];

pub fn popup_app_name(process: Option<&str>) -> String {
    match process {
        Some(p) => POPUP_APPS.iter().find(|a| a.0 == p).map_or(p, |a| a.1).to_string(),
        None => UNKNOWN_APP.into(),
    }
}

fn squash(raw: &Value) -> String {
    let s = if raw.is_null() { String::new() } else { js::string(raw) };
    js::trim(&SPACES.replace_all(&s, " ")).to_string()
}

/// 읽은 줄 → { title, body }. 첫 줄은 보낸 사람(제목), 나머지는 내용
pub fn popup_to_entry(lines: &[Value], app_name: &str) -> Option<Value> {
    let mut clean: Vec<String> = Vec::new();
    for raw in lines {
        let line = squash(raw);
        if line.is_empty() || noise(&line) || line == app_name || clean.last() == Some(&line) {
            continue;
        }
        clean.push(line);
    }
    let (title, rest) = clean.split_first()?;
    Some(json!({ "title": slice16(title, 200), "body": slice16(&rest.join("\n"), 2000) }))
}

// 글자만 (띄어쓰기 · 기호 · 읽는 방법마다 다른 줄 나눔은 빼고) — JS 처럼 UTF-16 단위로 센다
fn letters(text: &str) -> Vec<u16> {
    NOT_LETTER.replace_all(text, "").encode_utf16().collect()
}

fn contains(a: &[u16], b: &[u16]) -> bool {
    b.is_empty() || a.windows(b.len()).any(|w| w == b)
}

/// 두 글이 얼마나 같은가 (0~1): 글자 두 개씩 묶음의 겹침(다이스 계수). contain: 한쪽이 다른 쪽을 담으면 1
pub fn similarity(a: &str, b: &str, contain: bool) -> f64 {
    let (x, y) = (letters(a), letters(b));
    if x == y {
        return 1.0;
    }
    if contain && !x.is_empty() && !y.is_empty() && (contains(&x, &y) || contains(&y, &x)) {
        return 1.0;
    }
    if x.len() < 2 || y.len() < 2 {
        return 0.0;
    }
    let mut gy: Vec<&[u16]> = y.windows(2).collect();
    let mut hit = 0;
    for g in x.windows(2) {
        if let Some(i) = gy.iter().position(|h| *h == g) {
            gy.swap_remove(i);
            hit += 1;
        }
    }
    (2 * hit) as f64 / (x.len() - 1 + y.len() - 1) as f64
}

fn text_of(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_string()
}

/// 같은 알림을 짧은 시간 안에 두 번 넣지 않는다 → 같은 알림으로 본 앞의 기록 자리
///   같은 알림 창(hwnd)을 15초 안에 다시 읽었으면 글이 절반쯤만 같아도, 다른 창이어도 2분 안에 제목 · 내용이 80% 같으면
pub fn find_repeat(recent: &[Value], entry: &Value, now: f64, window_ms: f64) -> Option<usize> {
    let (title, body) = (text_of(entry, "title"), text_of(entry, "body"));
    (0..recent.len()).rev().find(|&i| {
        let r = &recent[i];
        let at = js::number(&r["at"]);
        if r["app"] != entry["app"] || now - at >= window_ms {
            return false;
        }
        let (rt, rb) = (text_of(r, "title"), text_of(r, "body"));
        if similarity(&rt, &title, false) >= 0.8 && similarity(&rb, &body, false) >= 0.8 {
            return true;
        }
        let hwnd = &entry["hwnd"];
        !hwnd.is_null() && hwnd != &json!(0) && r["hwnd"] == *hwnd && now - at < SAME_WINDOW_MS && !letters(&format!("{rt}{rb}")).is_empty() && similarity(&format!("{rt}{rb}"), &format!("{title}{body}"), true) >= 0.5
    })
}

/// 같은 알림을 두 번 읽었을 때 나중 것으로 바꿀까: 앞의 것은 그림 글자 인식, 나중 것은 글 그대로
pub fn better_reading(prev: &Value, next: &Value) -> bool {
    prev["via"] == "ocr" && next["via"].as_str().is_some_and(|v| !v.is_empty() && v != "ocr")
}

// 글자로 쓸 수 있는 조각인가 (기호만 · 단추 글자 · 잘못 읽은 한 글자는 빼고, 'ㅋㅋ' 같은 자모만의 메시지는 남긴다)
fn usable(text: &str) -> bool {
    if !test(&LETTER, text) || test(&LONE, text) {
        return false;
    }
    let t = SPACES.replace_all(text, "").to_lowercase();
    !test(&CONTROL, &t) && !t.contains("메시지입력") && !t.contains("아이콘표시")
}

// 채팅방 이름과 보낸 사람이 같은 이름인가 (1:1 대화) — 한 글자만 달라도 같은 이름으로
fn same_name(a: &str, b: &str) -> bool {
    let (x, y) = (letters(a), letters(b));
    if x.is_empty() || y.is_empty() || x == y || contains(&x, &y) || contains(&y, &x) {
        return true;
    }
    if x.len().abs_diff(y.len()) > 1 {
        return false;
    }
    let (mut i, mut j, mut diff) = (0isize, 0isize, 0);
    let at = |v: &[u16], k: isize| usize::try_from(k).ok().and_then(|k| v.get(k).copied());
    while (i as usize) < x.len() || (j as usize) < y.len() {
        if at(&x, i) != at(&y, j) {
            diff += 1;
            if x.len() > y.len() {
                j -= 1;
            } else if y.len() > x.len() {
                i -= 1;
            }
            if diff > 1 {
                return false;
            }
        }
        i += 1;
        j += 1;
    }
    true
}

fn num_or(v: &Value, d: f64) -> f64 {
    let n = js::number(v);
    if n.is_nan() || n == 0.0 {
        d
    } else {
        n
    }
}

fn clean_line(s: &str) -> String {
    js::trim(&LINE_TAIL.replace_all(s, "")).to_string()
}

fn or_raw(clean: String, raw: &str) -> String {
    if clean.is_empty() {
        raw.to_string()
    } else {
        clean
    }
}

/// 카카오톡 알림 창: 글자 인식 결과(줄마다 글과 자리, 100% 배율 px) → { title, body }
///   profile_top: 프로필 사진 윗변 — 그 위는 채팅방 이름, 아래 첫 줄이 보낸 사람
pub fn kakao_entry(boxes: &[Value], width: f64, height: f64, app_name: &str, profile_top: f64) -> Option<Value> {
    struct Item {
        text: String,
        x: f64,
        y: f64,
        h: f64,
    }
    let mut items = Vec::new();
    for b in boxes {
        let text = squash(&b["text"]);
        let (x, y) = (num_or(&b["x"], 0.0), num_or(&b["y"], 0.0));
        let h = num_or(&b["h"], 14.0).max(1.0);
        if text.is_empty() || !usable(&text) || noise(&text) || text == app_name {
            continue;
        }
        // 오른쪽 위 종 · 닫기 단추 자리 (폭의 70% 오른쪽 · 높이의 35% 위)
        if width != 0.0 && height != 0.0 && x > width * 0.7 && y < height * 0.35 {
            continue;
        }
        items.push(Item { text, x, y, h });
    }
    if items.is_empty() {
        return None;
    }
    // 같은 높이(세로 가운데가 글자 높이의 65% 안)의 조각은 한 줄로, 왼쪽부터
    items.sort_by(|a, b| a.y.total_cmp(&b.y));
    let mut rows: Vec<(f64, f64, Vec<Item>)> = Vec::new();
    for it in items {
        match rows.iter_mut().find(|r| ((r.0 + r.1 / 2.0) - (it.y + it.h / 2.0)).abs() < r.1.max(it.h) * 0.65) {
            Some(r) => r.2.push(it),
            None => rows.push((it.y, it.h, vec![it])),
        }
    }
    let lines: Vec<(f64, String)> = rows
        .into_iter()
        .map(|(y, _, mut parts)| {
            parts.sort_by(|a, b| a.x.total_cmp(&b.x));
            (y, parts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join(" "))
        })
        .collect();
    let texts = |ls: &[(f64, String)]| ls.iter().map(|l| l.1.clone()).collect::<Vec<_>>();
    let below: Vec<(f64, String)> = if profile_top > 0.0 { lines.iter().filter(|l| l.0 >= profile_top - 4.0).cloned().collect() } else { vec![] };
    let (room, sender, body) = if !below.is_empty() {
        let above: Vec<String> = lines.iter().filter(|l| l.0 < profile_top - 4.0).map(|l| l.1.clone()).collect();
        let room_line = clean_line(&above.join(" "));
        let sender = or_raw(clean_line(&below[0].1), &below[0].1);
        let room = if !room_line.is_empty() && !same_name(&room_line, &sender) { room_line } else { sender.clone() };
        (room, sender, texts(&below[1..]))
    } else if lines.len() == 1 {
        let first = or_raw(clean_line(&lines[0].1), &lines[0].1);
        (first.clone(), first, vec![])
    } else if lines[1].0 >= KAKAO_BODY_Y || same_name(&clean_line(&lines[0].1), &clean_line(&lines[1].1)) {
        let first = or_raw(clean_line(&lines[0].1), &lines[0].1);
        let mut rest = texts(&lines[1..]);
        if same_name(&clean_line(rest.first().map_or("", String::as_str)), &first) {
            rest.remove(0);
        }
        (first.clone(), first, rest)
    } else {
        let r0 = or_raw(clean_line(&lines[0].1), &lines[0].1);
        let s0 = or_raw(clean_line(&lines[1].1), &lines[1].1);
        (if same_name(&r0, &s0) { s0.clone() } else { r0 }, s0, texts(&lines[2..]))
    };
    let title = if !room.is_empty() && room != sender { format!("{sender} ({room})") } else { sender };
    Some(json!({ "title": slice16(&title, 200), "body": slice16(&body.join("\n"), 2000) }))
}

// ---------- 이미 받은 이름으로 맞추기 ----------

/// "보낸 사람 (채팅방)" → (sender, room)
pub fn split_title(title: &str) -> (String, String) {
    let t = js::trim(title);
    match TITLE.captures(t).ok().flatten() {
        Some(m) => (m[1].to_string(), m[2].to_string()),
        None => (t.to_string(), String::new()),
    }
}

/// 이미 받은 알림 제목들에서 이름별 횟수 (처음 나온 차례대로)
pub fn known_names<'a>(titles: impl IntoIterator<Item = &'a str>) -> Vec<(String, u32)> {
    let mut count: Vec<(String, u32)> = Vec::new();
    for t in titles {
        let (sender, room) = split_title(t);
        for n in [sender, room].into_iter().filter(|n| !n.is_empty()) {
            match count.iter_mut().find(|c| c.0 == n) {
                Some(c) => c.1 += 1,
                None => count.push((n, 1)),
            }
        }
    }
    count
}

// 한 글자 차이(바뀜 · 빠짐 · 더해짐)인가 — 두 글자 넘는 이름만
fn one_off(a: &[u16], b: &[u16]) -> bool {
    if a == b || a.len() < 3 || b.len() < 3 || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let i = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let tail = |v: &[u16], k: usize| v.get(k..).unwrap_or(&[]).to_vec();
    match a.len().cmp(&b.len()) {
        std::cmp::Ordering::Equal => tail(a, i + 1) == tail(b, i + 1),
        std::cmp::Ordering::Greater => tail(a, i + 1) == tail(b, i),
        std::cmp::Ordering::Less => tail(a, i) == tail(b, i + 1),
    }
}

// 처음 보는 이름 → 한 글자 차이인 받은 이름 가운데 가장 자주 온 것. 받은 이름이라도 한 글자 차이 이름이 3배 넘게(3번 넘게) 왔으면 그쪽
fn fix_name(name: &str, known: &[(String, u32)]) -> String {
    if name.is_empty() {
        return String::new();
    }
    let mine = known.iter().find(|k| k.0 == name).map_or(0, |k| k.1);
    let key: Vec<u16> = SPACES.replace_all(name, "").encode_utf16().collect();
    let mut best: Option<&(String, u32)> = None;
    for k in known {
        if k.0 == name || !one_off(&key, &SPACES.replace_all(&k.0, "").encode_utf16().collect::<Vec<_>>()) {
            continue;
        }
        if best.is_none_or(|b| k.1 > b.1) {
            best = Some(k);
        }
    }
    match best {
        Some(b) if mine == 0 || (b.1 >= 3 && b.1 > mine * 3) => b.0.clone(),
        _ => name.to_string(),
    }
}

/// 알림 제목의 보낸 사람 · 채팅방 이름을 이미 받은 이름으로 맞춘다
pub fn correct_title(title: &str, known: &[(String, u32)]) -> String {
    let (sender, room) = split_title(title);
    let (s, r) = (fix_name(&sender, known), fix_name(&room, known));
    if r.is_empty() {
        s
    } else {
        format!("{s} ({r})")
    }
}
