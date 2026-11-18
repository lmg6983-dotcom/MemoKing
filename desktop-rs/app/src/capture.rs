// 매직 카피 (Ctrl+Alt+C 한 번) — 어느 앱에서든 고른 것(글 · 파일 · 그림)을 복사해 새 메모로. 두 번 누르면 화면 캡처.
//   Electron 의 quick-capture.js · double-press.js · windowManager.quickMemo 자리.
//   1) 상주 PowerShell 도우미(scripts/clipboard-helper.ps1, Electron 과 같은 것)가 키에서 손을 뗄 때까지 기다렸다가
//      앞 창에 Ctrl+C 를 보내고, 클립보드를 임시 폴더에 풀어 둔다
//   2) 여기서 그 폴더를 읽어 파일 · 그림은 첨부로 넣고, 글 · 서식은 메모 창의 붙여넣기로 넘긴다 (memo:get 의 capture)
use crate::state::state;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

// ---------- 한 번 · 두 번 누르기 (double-press.js) ----------

const DOUBLE_MS: u64 = 350;
static PRESS: AtomicU64 = AtomicU64::new(0); // 기다리는 한 번 누르기의 차례 (0 = 없음)
static SEQ: AtomicU64 = AtomicU64::new(0);
static COOL: Mutex<Option<Instant>> = Mutex::new(None); // 두 번 누른 뒤 잠깐은 무시 (세 번째가 다시 한 번이 되지 않게)

/// 매직 카피 단축키: 350ms 안에 한 번 더 오면 화면 캡처, 아니면 매직 카피
pub fn pressed(app: &AppHandle) {
    if COOL.lock().unwrap().is_some_and(|t| t > Instant::now()) {
        return;
    }
    if PRESS.swap(0, Ordering::SeqCst) != 0 {
        *COOL.lock().unwrap() = Some(Instant::now() + Duration::from_millis(DOUBLE_MS));
        let app = app.clone();
        std::thread::spawn(move || {
            if !crate::services::start_area_capture(&app) && state(&app).vault.lock().unwrap().is_some() {
                crate::windows::show_hud(&app, "화면을 캡처하지 못했어요", "잠시 뒤 두 번 다시 눌러 주세요.", "warn");
            }
        });
        return;
    }
    let me = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    PRESS.store(me, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(DOUBLE_MS));
        if PRESS.compare_exchange(me, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            magic_copy(&app, true);
        }
    });
}

// ---------- 상주 도우미 ----------

struct Helper {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
}

static HELPER: Mutex<Option<Helper>> = Mutex::new(None);

fn spawn_helper(app: &AppHandle) -> Result<Helper, String> {
    let script = state(app).settings_dir.join("clipboard-helper.ps1");
    std::fs::write(&script, include_str!("../../../scripts/clipboard-helper.ps1")).map_err(|e| e.to_string())?;
    let mut child = crate::history::powershell(true)
        .arg("-File")
        .arg(&script)
        .args(["-Action", "serve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    crate::ai::kill_with_app(&child);
    let (stdin, out) = (child.stdin.take().ok_or("도우미 입력 없음")?, child.stdout.take().ok_or("도우미 출력 없음")?);
    let (tx, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut h = Helper { child, stdin, lines };
    // 첫 줄 {"ready":true} — PowerShell 이 뜨는 데 1~2초
    read_json(&mut h, Duration::from_secs(15)).filter(|v| v["ready"] == true).ok_or("도우미를 시작하지 못했어요")?;
    Ok(h)
}

/// 도우미가 찍는 다른 출력은 건너뛰고 JSON 한 줄
fn read_json(h: &mut Helper, wait: Duration) -> Option<Value> {
    let until = Instant::now() + wait;
    loop {
        let line = h.lines.recv_timeout(until.checked_duration_since(Instant::now())?).ok()?;
        if let Ok(v) = serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')) {
            return Some(v);
        }
    }
}

/// 매직 카피 키를 잡을 때 미리 띄워 둔다 (처음 누를 때 PowerShell 이 뜨는 지연 없이)
pub fn warm(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut slot = HELPER.lock().unwrap();
        if slot.is_none() {
            match spawn_helper(&app) {
                Ok(h) => *slot = Some(h),
                Err(e) => elog!("[매직 카피] {e}"),
            }
        }
    });
}

pub fn stop() {
    if let Some(mut h) = HELPER.lock().unwrap().take() {
        let _ = h.child.kill();
        let _ = h.child.wait();
    }
}

fn request(app: &AppHandle, line: &str) -> Result<Value, String> {
    let mut slot = HELPER.lock().unwrap();
    for attempt in 0..2 {
        if slot.is_none() {
            *slot = Some(spawn_helper(app)?);
        }
        let h = slot.as_mut().unwrap();
        while h.lines.try_recv().is_ok() {} // 지난번 늦게 온 답
        if writeln!(h.stdin, "{line}").and_then(|()| h.stdin.flush()).is_ok() {
            if let Some(v) = read_json(h, Duration::from_secs(10)) {
                return Ok(v);
            }
        }
        // 도우미가 꺼졌거나 멈췄다 — 한 번 새로 띄워 다시
        if let Some(mut h) = slot.take() {
            let _ = h.child.kill();
            let _ = h.child.wait();
        }
        if attempt == 1 {
            break;
        }
    }
    Err("도우미 응답 시간 초과".into())
}

/// 점검: 도우미가 지금 클립보드를 풀어 오는 내용 (메모는 만들지 않는다, ipc.rs smoke:clipboard-dump)
pub fn smoke_dump(app: &AppHandle) -> Result<Value, String> {
    use base64::Engine;
    let dir = std::env::temp_dir().join("memoking-capture").join("smoke");
    let path = base64::engine::general_purpose::STANDARD.encode(dir.to_string_lossy().as_bytes());
    let info = request(app, &format!("capture\t{path}\tnocopy"))?;
    let text = std::fs::read(dir.join("text.txt")).map(|b| String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').to_string()).ok();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(json!({ "info": info, "text": text }))
}

// ---------- 매직 카피 ----------

static CAPTURING: AtomicBool = AtomicBool::new(false);

/// copy: 앞 창에 Ctrl+C 를 보내 고른 것을 복사한 뒤 (false: 지금 클립보드 그대로 — 트레이 "복사해 둔 내용으로 새 메모")
pub fn magic_copy(app: &AppHandle, copy: bool) -> Option<String> {
    if state(app).vault.lock().unwrap().is_none() {
        crate::os::show_list(app); // 메모 폴더를 고르는 화면으로
        return None;
    }
    if CAPTURING.swap(true, Ordering::SeqCst) {
        return None;
    }
    let dir = std::env::temp_dir().join("memoking-capture").join(memoking_core::time::now_ms().to_string());
    let res = capture_into(app, &dir, copy);
    let _ = std::fs::remove_dir_all(&dir);
    CAPTURING.store(false, Ordering::SeqCst);
    let key = crate::shortcuts::status(app, "quickMemo")["label"].as_str().unwrap_or("Ctrl+Alt+C").to_string();
    match res {
        Ok(Some(id)) => Some(id),
        Ok(None) => {
            crate::windows::show_hud(app, "가져올 내용이 없어요", &format!("글, 파일, 그림을 고른 뒤 {key}를 눌러 주세요."), "warn");
            None
        }
        Err(e) => {
            elog!("[매직 카피] {e}");
            crate::windows::show_hud(app, "메모를 만들지 못했어요", &format!("{key}를 한 번 더 눌러 주세요."), "warn");
            None
        }
    }
}

fn capture_into(app: &AppHandle, dir: &Path, copy: bool) -> Result<Option<String>, String> {
    use base64::Engine;
    let path = base64::engine::general_purpose::STANDARD.encode(dir.to_string_lossy().as_bytes());
    let info = request(app, &format!("capture\t{path}{}", if copy { "" } else { "\tnocopy" }))?;
    if let Some(e) = info["error"].as_str() {
        return Err(e.to_string());
    }
    let Some(capture) = build_capture(app, dir, &info) else { return Ok(None) };
    let id = state(app).vault.lock().unwrap().as_mut().map(|v| v.create(None, None, "")).ok_or("메모 폴더 없음")?;
    crate::services::put_capture(&id, capture);
    crate::shortcuts::tutorial_event(app, "quick-memo"); // 튜토리얼 "어디서든 바로 메모" 를 직접 해 냄
    crate::memos::open_note(app, &id)?;
    Ok(Some(id))
}

/// 풀어 둔 클립보드 → 메모 창에 넘길 내용 (quick-capture.js buildCapture). 파일 · 그림은 여기서 첨부로 넣는다. 담을 것이 없으면 None
fn build_capture(app: &AppHandle, dir: &Path, info: &Value) -> Option<Value> {
    let read = |name: &str| std::fs::read(dir.join(name)).ok();
    let text = read("text.txt").map(|b| String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').to_string()).unwrap_or_default();
    let files: Vec<String> = read("files.txt").map(|b| String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').lines().filter(|l| !l.is_empty()).map(str::to_string).collect()).unwrap_or_default();
    let (html, url) = read("html.bin").map(|b| parse_cf_html(&b)).unwrap_or_default();
    let html = html.filter(|h| html_has_text(h));
    let image = dir.join("image.png");
    let (mut items, mut skipped, mut heading) = (Vec::new(), Vec::new(), Value::Null);
    let (mut html_out, mut text_out) = (Value::Null, Value::Null);
    let st = state(app);
    let guard = st.vault.lock().unwrap();
    let vault = guard.as_ref()?;
    let name_of = |f: &str| Path::new(f).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !files.is_empty() {
        // 탐색기 · 바탕화면에서 복사한 파일
        for f in &files {
            let (name, file) = (name_of(f), Path::new(f));
            let Some(src) = file.is_file().then(|| vault.copy_attachment(file).ok()).flatten() else {
                skipped.push(Value::from(name));
                continue;
            };
            let base = name.rsplit_once('.').map_or(name.as_str(), |(b, _)| b).to_string();
            let video = name.rsplit('.').next().is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "mp4" | "m4v" | "mov" | "ogv" | "mkv" | "webm"));
            let alt = if video { format!("동영상 {base}") } else { base };
            items.push(match memoking_core::body::media_kind_of(&src, &alt) {
                Some(kind) => json!({ "kind": kind, "src": src, "alt": alt }),
                None => json!({ "kind": "file", "src": src, "name": name }),
            });
        }
        if !items.is_empty() {
            let first = name_of(&files[0]);
            heading = if items.len() == 1 { first.into() } else { format!("{first} 외 {}개", items.len() - 1).into() };
        }
    } else if html.is_none() && image.is_file() {
        // 그림 (화면 캡처, 그림 편집기, 브라우저 "이미지 복사")
        let src = vault.save_attachment(&std::fs::read(&image).ok()?, "png").ok()?;
        items.push(json!({ "kind": "image", "src": src, "alt": "캡처한 그림" }));
        heading = "캡처한 그림".into();
    } else if let Some(h) = html {
        html_out = h.into(); // 웹 · 워드: 메모 창의 붙여넣기(서식 · 사진 저장)로
        text_out = text.into();
    } else if !text.trim().is_empty() {
        text_out = text.into();
    }
    if items.is_empty() && html_out.is_null() && text_out.is_null() {
        return None;
    }
    let source = json!({
        "window": info["window"].as_str().unwrap_or_default(),
        "process": info["process"].as_str().unwrap_or_default(),
        "url": url,
        "time": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "copied": info["changed"] == true,
    });
    let source_md = source_line(&source, chrono::Local::now());
    Some(json!({ "heading": heading, "html": html_out, "text": text_out, "items": items, "skipped": skipped, "source": source, "sourceMd": source_md }))
}

/// 클립보드의 "HTML Format"(CF_HTML, 위치 값은 UTF-8 바이트) → (선택한 조각, 원본 주소) — clipboard-html.js parseCfHtml
fn parse_cf_html(bytes: &[u8]) -> (Option<String>, Option<String>) {
    let text = String::from_utf8_lossy(bytes);
    let head: String = text.chars().take(2000).collect();
    let header = |name: &str| head.lines().find_map(|l| l.strip_prefix(name)?.strip_prefix(':').map(|v| v.trim().to_string()));
    let url = header("SourceURL").filter(|u| u.starts_with("http://") || u.starts_with("https://"));
    let num = |name: &str| header(name).and_then(|v| v.parse::<usize>().ok());
    let mut html = match (num("StartFragment"), num("EndFragment")) {
        (Some(a), Some(b)) if a < b && b <= bytes.len() => Some(String::from_utf8_lossy(&bytes[a..b]).into_owned()).filter(|h| !h.is_empty()),
        _ => None,
    };
    // 위치 값이 틀린 앱도 있어 주석 표시로 한 번 더
    if html.is_none() {
        html = match (text.find("<!--StartFragment-->"), text.find("<!--EndFragment-->")) {
            (Some(a), Some(b)) if a + 20 <= b => Some(text[a + 20..b].to_string()),
            _ => text.find('<').map(|i| text[i..].to_string()),
        };
    }
    let mut html = html.unwrap_or_default().trim().to_string();
    // 엑셀은 조각 표시가 <table> 안쪽이라 줄(<tr>)만 떼어진다 → 표로 다시 감싸고, 칸 모양(<style>)을 함께 붙인다
    let lower = html.to_ascii_lowercase();
    let has_cells = ["<tr", "<td", "<th"].iter().any(|t| lower.match_indices(t).any(|(i, _)| lower[i + 3..].starts_with([' ', '>', '\t', '\n', '\r'])));
    if has_cells && !lower.contains("<table") {
        let styles = style_blocks(&text);
        html = format!("{styles}<table>{html}</table>");
    }
    (Some(html), url)
}

fn style_blocks(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(a) = lower[at..].find("<style").map(|i| at + i) {
        let Some(b) = lower[a..].find("</style>").map(|i| a + i + 8) else { break };
        out.push_str(&text[a..b]);
        at = b;
    }
    out
}

/// HTML 안에 글자가 있는지 (그림만 있는 HTML 이면 그림 파일을 쓰는 게 낫다)
fn html_has_text(html: &str) -> bool {
    let mut s = html.to_string();
    for tag in ["script", "style"] {
        while let Some(a) = s.to_ascii_lowercase().find(&format!("<{tag}")) {
            let end = s.to_ascii_lowercase()[a..].find(&format!("</{tag}>")).map_or(s.len(), |i| a + i + tag.len() + 3);
            s.replace_range(a..end, "");
        }
    }
    let mut plain = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => plain.push(c),
            _ => {}
        }
    }
    !plain.replace("&nbsp;", " ").replace("&#160;", " ").trim().is_empty()
}

/// 메모 끝에 붙이는 출처 한 줄 (마크다운 인용) — quick-capture.js sourceLine
fn source_line(source: &Value, now: chrono::DateTime<chrono::Local>) -> String {
    let esc = |s: &str| s.chars().fold(String::new(), |mut o, c| {
        if "\\[]*_`<>".contains(c) {
            o.push('\\');
        }
        o.push(c);
        o
    });
    let title = source["window"].as_str().filter(|s| !s.trim().is_empty()).or_else(|| source["process"].as_str()).unwrap_or_default().trim().to_string();
    let where_ = match source["url"].as_str() {
        Some(url) => format!("[{}]({url})", esc(if title.is_empty() { url } else { &title })),
        None => esc(if title.is_empty() { "클립보드" } else { &title }),
    };
    format!("> 출처: {where_}, {}", now.format("%Y.%-m.%-d %H:%M"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cf(fragment: &str, url: &str) -> Vec<u8> {
        let pre = "<html><body><!--StartFragment-->";
        let head_len = format!("Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\nSourceURL:{url}\r\n", 0, 0, 0, 0).len();
        let a = head_len + pre.len();
        let b = a + fragment.len();
        format!("Version:0.9\r\nStartHTML:{head_len:010}\r\nEndHTML:{:010}\r\nStartFragment:{a:010}\r\nEndFragment:{b:010}\r\nSourceURL:{url}\r\n{pre}{fragment}<!--EndFragment--></body></html>", b + 30).into_bytes()
    }

    #[test]
    fn reads_fragment_and_source() {
        let (html, url) = parse_cf_html(&cf("<b>안녕</b> 하세요", "https://news.example.com/a"));
        assert_eq!(html.as_deref(), Some("<b>안녕</b> 하세요"));
        assert_eq!(url.as_deref(), Some("https://news.example.com/a"));
        let (_, url) = parse_cf_html(&cf("x", "file:///C:/a.html"));
        assert_eq!(url, None);
    }

    #[test]
    fn wraps_excel_rows() {
        let (html, _) = parse_cf_html(&cf("<tr><td>품목</td><td>가격</td></tr>", ""));
        assert_eq!(html.as_deref(), Some("<table><tr><td>품목</td><td>가격</td></tr></table>"));
    }

    #[test]
    fn text_in_html() {
        assert!(html_has_text("<p>글</p>"));
        assert!(!html_has_text("<img src=a.png><style>p{}</style>&nbsp;"));
        assert!(!html_has_text("<script>var a = 1</script>"));
    }

    #[test]
    fn source_markdown() {
        let at = chrono::Local::now();
        let when = at.format("%Y.%-m.%-d %H:%M");
        assert_eq!(source_line(&json!({ "window": "보고서 [최종]", "process": "", "url": null }), at), format!("> 출처: 보고서 \\[최종\\], {when}"));
        assert_eq!(source_line(&json!({ "window": "", "process": "", "url": "https://a.com" }), at), format!("> 출처: [https://a.com](https://a.com), {when}"));
        assert_eq!(source_line(&json!({ "window": "", "process": "", "url": null }), at), format!("> 출처: 클립보드, {when}"));
    }
}
