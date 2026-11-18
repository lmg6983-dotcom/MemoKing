// 목록 창 늘 위 · 메모 폴더 보기 · 링크(열기 · 미리보기) · 그림 복사 · 저장 · 첨부 복사 · 받기 · 공유 · 새 버전 안내 · 문제 보내기.
//   Electron 의 ipc-handlers.js · main.js(whatsNew · reportProblem) · utils.js(fetchRemoteImage · copyFileToClipboard) ·
//   link-previews.js · share-file.js · window-manager.js(setListOnTop) 의 그 부분.
use crate::memos::arg_str;
use crate::state::state;
use memoking_core::js::encode_uri_component;
use memoking_core::link_preview::{detect_charset, host_of, image_ext_from_type, image_ext_from_url, parse_link_preview, parse_youtube_oembed, stale_youtube_entry, youtube_oembed_url};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

fn vault_root(app: &AppHandle) -> Option<PathBuf> {
    state(app).vault.lock().unwrap().as_ref().map(|v| v.root.clone())
}

// ---------- 인터넷에서 받기 (Electron net.fetch 자리) ----------

// 사이트가 브라우저에게 주는 것과 같은 미리보기 정보를 받게 (Electron 은 크롬 UA 에서 Electron 만 뺐다)
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const IMAGE_ACCEPT: &str = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

// shortcut: 프록시는 환경 변수 · Windows 인터넷 옵션의 고정 프록시만 (PAC 자동 설정은 못 읽는다), 회사망에서 미리보기가 안 된다는 말이 나오면 WebView2 로 받기
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| web_config().user_agent(USER_AGENT).build().into())
}

/// 인터넷으로 받는 모든 곳(미리보기 · 모델 · 드라이브 · 캘린더)이 같은 운영체제 TLS · 인증서 · 시스템 프록시를 쓰게
pub(crate) fn web_config() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    ureq::Agent::config_builder().tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
}

type Response = ureq::http::Response<ureq::Body>;

fn call(url: &str, accept: &str, timeout_secs: u64) -> Result<Response, String> {
    let req = agent().get(url).config().timeout_global(Some(Duration::from_secs(timeout_secs))).build();
    req.header("Accept", accept).header("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.8").call().map_err(|e| match e {
        ureq::Error::StatusCode(code) => format!("HTTP {code}"),
        e => e.to_string(),
    })
}

fn content_type(res: &Response) -> String {
    res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string()
}

/// 받은 내용 — limit 을 넘으면 too_big (head: 넘으면 · </head> 를 보면 거기까지만 — 미리보기 정보는 <head> 안에 있다)
fn read(res: &mut Response, limit: u64, head: bool, too_big: &str) -> Result<Vec<u8>, String> {
    if !head && res.body().content_length().is_some_and(|n| n > limit) {
        return Err(too_big.into());
    }
    let mut reader = res.body_mut().as_reader();
    let (mut out, mut buf) = (vec![], vec![0u8; 64 * 1024]);
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        if out.len() as u64 > limit {
            if !head {
                return Err(too_big.into());
            }
            break;
        }
        if head && out.len() > 2048 && buf[..n].windows(7).any(|w| w.eq_ignore_ascii_case(b"</head>")) {
            break;
        }
    }
    Ok(out)
}

const MAX_REMOTE_IMAGE: u64 = 50 * 1024 * 1024;

/// 붙여넣은 인터넷 그림을 메모 폴더에 받아 둔다 → "attachments/…" (utils.js fetchRemoteImage)
fn fetch_remote_image(app: &AppHandle, url: &str) -> Result<Value, String> {
    if vault_root(app).is_none() {
        return Err("메모 폴더가 아직 없어요. 처음 화면에서 메모 폴더를 정해 주세요".into());
    }
    let target = Url::parse(url).map_err(|_| "Invalid URL")?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("인터넷 주소(http, https)만 받을 수 있어요.".into());
    }
    let mut res = call(target.as_str(), IMAGE_ACCEPT, 20)?;
    let ty = content_type(&res);
    let ext = image_ext_from_type(&ty)
        .or_else(|| (ty.starts_with("image/") || ty.is_empty()).then(|| image_ext_from_url(target.as_str())).flatten())
        .ok_or_else(|| format!("그림이 아니에요 ({}). 그림 주소(PNG, JPG, GIF, WebP)를 넣어 주세요", if ty.is_empty() { "형식 모름" } else { &ty }))?;
    let bytes = read(&mut res, MAX_REMOTE_IMAGE, false, "50MB보다 커서 넣을 수 없어요. 더 작은 그림으로 해 주세요")?;
    // 받는 동안은 메모 폴더를 잠그지 않는다 (다른 창이 멈추지 않게)
    let st = state(app);
    let guard = st.vault.lock().unwrap();
    let v = guard.as_ref().ok_or("메모 폴더가 아직 없어요. 처음 화면에서 메모 폴더를 정해 주세요")?;
    v.save_attachment(&bytes, ext).map(Value::from).map_err(|e| e.to_string())
}

// ---------- 링크 미리보기 (link-previews.js) ----------
//   <메모 폴더>/_memoking/link-previews.json 주소별 정보 · link-previews/ 사진 · 아이콘 — 메모 폴더와 함께 동기화된다

const MAX_HTML: u64 = 2 * 1024 * 1024;
const MAX_IMAGE: u64 = 5 * 1024 * 1024;
const MAX_ICON: u64 = 300 * 1024;
const RETRY_FAILED: Duration = Duration::from_secs(6 * 60 * 60); // 받지 못한 주소는 6시간 뒤 다시

struct Previews {
    dir: PathBuf,
    cache: Map<String, Value>,
    /// 이번 실행에서 받지 못한 주소 → 시각 (파일에는 남기지 않음)
    failed: HashMap<String, Instant>,
}

static PREVIEWS: Mutex<Option<Previews>> = Mutex::new(None);

fn read_cache(dir: &Path) -> Option<Map<String, Value>> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("link-previews.json")).ok()?).ok()
}

fn save_cache(dir: &Path, cache: &Map<String, Value>) {
    // JSON.stringify(cache, null, 1) 과 같은 모양
    let mut text = vec![];
    let mut ser = serde_json::Serializer::with_formatter(&mut text, serde_json::ser::PrettyFormatter::with_indent(b" "));
    if serde::Serialize::serialize(cache, &mut ser).is_ok() {
        if let Err(err) = memoking_core::vault::write_atomic(&dir.join("link-previews.json"), &text) {
            elog!("[링크 미리보기] 저장 실패: {err}");
        }
    }
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// 사진을 _memoking/link-previews/<주소 해시>.<확장자> 로 → 메모 폴더 기준 경로
fn save_image(dir: &Path, url: &str, limit: u64) -> Result<String, String> {
    use sha1::Digest;
    let mut res = call(url, IMAGE_ACCEPT, 10)?;
    let ty = content_type(&res).to_lowercase();
    let bytes = read(&mut res, limit, false, "너무 큰 파일")?;
    if bytes.is_empty() {
        return Err("빈 파일".into());
    }
    let lower = url.to_lowercase();
    let ico = ty.contains("icon") || lower.ends_with(".ico") || lower.contains(".ico?");
    let ext = image_ext_from_type(&ty).or(ico.then_some("ico")).or_else(|| image_ext_from_url(url)).ok_or("그림이 아니에요")?;
    let hash: String = sha1::Sha1::digest(url.as_bytes())[..8].iter().map(|b| format!("{b:02x}")).collect();
    let name = format!("{hash}.{ext}");
    let folder = dir.join("link-previews");
    std::fs::create_dir_all(&folder).and_then(|()| std::fs::write(folder.join(&name), bytes)).map_err(|e| e.to_string())?;
    Ok(format!("_memoking/link-previews/{name}"))
}

// 유튜브 동영상: oEmbed(제목 · 채널) + 정해진 썸네일 — 언제 받아도 같은 카드 (동영상이 아니거나 못 받으면 None)
fn fetch_youtube(dir: &Path, url: &str) -> Option<Value> {
    let mut res = call(&youtube_oembed_url(url)?, "application/json", 10).ok()?;
    let body = read(&mut res, MAX_ICON, false, "너무 큰 파일").ok()?;
    let p = parse_youtube_oembed(&String::from_utf8_lossy(&body), url);
    if p["title"] == "" {
        return None; // 비공개 · 삭제된 동영상 → 페이지를 읽어 본다
    }
    let s = |k: &str| p[k].as_str().unwrap_or_default().to_string();
    let (image, icon) = (save_image(dir, &s("image"), MAX_IMAGE).unwrap_or_default(), save_image(dir, &s("icon"), MAX_ICON).unwrap_or_default());
    Some(json!({ "kind": "youtube", "title": p["title"], "description": p["description"], "site": p["site"], "image": image, "imageUrl": p["image"], "icon": icon, "fetchedAt": now_iso() }))
}

fn fetch_preview(dir: &Path, url: &str) -> Result<Value, String> {
    let target = Url::parse(url).ok().filter(|u| matches!(u.scheme(), "http" | "https")).ok_or("인터넷 주소가 아니에요")?;
    if let Some(entry) = fetch_youtube(dir, url) {
        return Ok(entry);
    }
    let mut res = call(target.as_str(), "text/html,application/xhtml+xml,*/*;q=0.8", 10)?;
    let ty = content_type(&res).to_lowercase();
    let final_url = ureq::ResponseExt::get_uri(&res).to_string();
    let body = read(&mut res, MAX_HTML, true, "너무 큰 파일")?;
    let mut entry = json!({ "kind": "page", "title": "", "description": "", "site": "", "image": "", "imageUrl": "", "icon": "", "fetchedAt": now_iso() });
    let last = Url::parse(&final_url).ok().and_then(|u| u.path().rsplit('/').next().map(str::to_string)).unwrap_or_default();
    let file_name = memoking_core::js::decode_uri_component(&last).ok_or("URI malformed")?;
    let name_or_host = if file_name.is_empty() { host_of(url) } else { file_name };
    if ty.starts_with("image/") {
        // 사진 주소를 붙여넣은 경우: 그 사진이 곧 미리보기
        entry["title"] = name_or_host.into();
        entry["image"] = save_image(dir, &final_url, MAX_IMAGE).unwrap_or_default().into();
        entry["imageUrl"] = final_url.into();
        return Ok(entry);
    }
    if !ty.contains("html") && !ty.contains("xml") && !ty.is_empty() {
        entry["title"] = name_or_host.into(); // PDF 등 파일 주소
        return Ok(entry);
    }
    let head: String = body.iter().take(4096).map(|&b| char::from(b)).collect();
    let charset = detect_charset(&ty, &head);
    let encoding = encoding_rs::Encoding::for_label_no_replacement(charset.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let p = parse_link_preview(&encoding.decode_with_bom_removal(&body).0, &final_url);
    let s = |k: &str| p[k].as_str().unwrap_or_default().to_string();
    for k in ["title", "description", "site"] {
        entry[k] = p[k].clone();
    }
    entry["imageUrl"] = p["image"].clone();
    entry["image"] = if s("image").is_empty() { String::new() } else { save_image(dir, &s("image"), MAX_IMAGE).unwrap_or_default() }.into();
    entry["icon"] = if s("icon").is_empty() { String::new() } else { save_image(dir, &s("icon"), MAX_ICON).unwrap_or_default() }.into();
    Ok(entry)
}

/// 화면에 보여줄 미리보기 — 사진은 메모 폴더 기준 경로(image), 아직 동기화되지 않았으면 인터넷 주소(imageUrl)
fn preview_view(root: &Path, url: &str, entry: Option<&Value>) -> Value {
    let s = |k: &str| entry.and_then(|e| e[k].as_str()).unwrap_or_default().to_string();
    let exists = |rel: String| if !rel.is_empty() && root.join(&rel).exists() { rel } else { String::new() };
    let site = s("site");
    json!({
        "url": url,
        "ok": entry.is_some(),
        "title": s("title"),
        "description": s("description"),
        "site": if site.is_empty() { host_of(url) } else { site },
        "host": host_of(url),
        "image": exists(s("image")),
        "imageUrl": s("imageUrl"),
        "icon": exists(s("icon")),
    })
}

// shortcut: 같은 주소를 동시에 물으면 두 번 받는다 (Electron 은 하나로 묶음) — 같은 카드가 여러 창에 잦으면 받는 중 표시를 두기
fn link_preview(app: &AppHandle, url: &str, refresh: bool) -> Value {
    // 미리보기를 끄면 사이트에 가지 않는다 (화면 쪽이 깜빡 묻더라도)
    let Some(root) = vault_root(app).filter(|_| state(app).setting("linkPreviews") != false) else { return Value::Null };
    let dir = root.join("_memoking");
    let cached = {
        let mut guard = PREVIEWS.lock().unwrap();
        if guard.as_ref().is_none_or(|p| p.dir != dir) {
            let failed = guard.take().map(|p| p.failed).unwrap_or_default();
            *guard = Some(Previews { dir: dir.clone(), cache: read_cache(&dir).unwrap_or_default(), failed });
        }
        let p = guard.as_mut().unwrap();
        // 다른 PC 가 먼저 받아 둔 정보가 동기화돼 들어왔을 수 있다 — 없을 때만 파일을 다시 읽는다
        if !p.cache.contains_key(url) {
            if let Some(mut disk) = read_cache(&dir).filter(|d| d.contains_key(url)) {
                disk.extend(std::mem::take(&mut p.cache));
                p.cache = disk;
            }
        }
        let cached = p.cache.get(url).filter(|c| !c.is_null()).cloned();
        let failed_lately = p.failed.get(url).is_some_and(|t| t.elapsed() < RETRY_FAILED);
        if !refresh && (cached.as_ref().is_some_and(|c| !stale_youtube_entry(url, c)) || failed_lately) {
            return preview_view(&root, url, cached.as_ref());
        }
        cached
    };
    // 받는 동안은 잠그지 않는다 (다른 카드 · 창이 기다리지 않게)
    let fetched = fetch_preview(&dir, url);
    let mut guard = PREVIEWS.lock().unwrap();
    let p = guard.as_mut().filter(|p| p.dir == dir);
    let entry = match fetched {
        Ok(entry) => {
            if let Some(p) = p {
                p.cache.insert(url.to_string(), entry.clone());
                p.failed.remove(url);
                save_cache(&dir, &p.cache);
            }
            Some(entry)
        }
        Err(err) => {
            elog!("[링크 미리보기] {url} {err}");
            if let Some(p) = p {
                p.failed.insert(url.to_string(), Instant::now());
            }
            cached
        }
    };
    preview_view(&root, url, entry.as_ref())
}

/// 웹 주소를 브라우저로 (http · https 만) → 열었나
fn open_web_page(app: &AppHandle, url: &str) -> bool {
    let Some(target) = Url::parse(url).ok().filter(|u| matches!(u.scheme(), "http" | "https")) else { return false };
    let _ = app.opener().open_url(target.as_str(), None::<&str>);
    true
}

// ---------- 그림 · 첨부 복사 · 저장 ----------

/// 파일(들)을 파일 그대로 클립보드에 — 탐색기 · 메신저에 붙는다
fn copy_files(files: &[PathBuf]) -> bool {
    // 리눅스는 클립보드 내용을 이 값이 살아 있는 동안 내어 준다 — 한 번 만들어 둔다
    static CLIP: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);
    let mut clip = CLIP.lock().unwrap();
    if clip.is_none() {
        *clip = arboard::Clipboard::new().ok();
    }
    clip.as_mut().is_some_and(|c| c.set().file_list(files).is_ok())
}

/// 메모 폴더 안의 파일 (화면이 encodeURI 한 경로일 수도)
fn vault_file(app: &AppHandle, rel: &Value) -> Option<PathBuf> {
    let rel = rel.as_str().unwrap_or_default();
    let rel = memoking_core::js::decode_uri(rel).unwrap_or_else(|| rel.to_string());
    state(app).vault.lock().unwrap().as_ref()?.resolve(&rel).filter(|f| f.is_file())
}

/// 그림으로 저장할 파일 이름: 화면이 준 이름(.png)이 쓸 만하면 그것, 아니면 메모 제목 (pdf-page.js pdfFileName 규칙)
pub fn png_name(file_name: Option<&str>, title: &str) -> String {
    if let Some(n) = file_name {
        let stem = n.len().checked_sub(4).filter(|&i| n.is_char_boundary(i) && n[i..].eq_ignore_ascii_case(".png")).map(|i| &n[..i]);
        if stem.is_some_and(|s| (1..=120).contains(&s.encode_utf16().count()) && !s.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])) {
            return n.to_string();
        }
    }
    let title = if title.is_empty() { "메모" } else { title };
    let cleaned: Vec<&str> = title.split(|c: char| "\\/:*?\"<>|\r\n".contains(c) || memoking_core::js::is_space(c)).filter(|p| !p.is_empty()).collect();
    let name = memoking_core::js::slice16(&cleaned.join(" "), 80);
    format!("{}.png", if name.is_empty() { "메모" } else { &name })
}

fn save_png(app: &AppHandle, id: &Value, base64: &str, file_name: Option<&str>) -> Result<Value, String> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).map_err(|e| e.to_string())?;
    let title = id
        .as_str()
        .filter(|id| !id.is_empty())
        .and_then(|id| state(app).vault.lock().unwrap().as_ref()?.get(id))
        .map_or_else(|| "메모".to_string(), |m| m["title"].as_str().unwrap_or_default().to_string());
    let name = png_name(file_name, &title);
    let file = if crate::ipc::smoke() {
        Some(std::env::temp_dir().join(format!("memoking-smoke-{}.png", chrono::Utc::now().timestamp_millis())))
    } else {
        let dir = app.path().picture_dir().unwrap_or_else(|_| std::env::temp_dir());
        let picked = app.dialog().file().set_title("그림으로 저장").set_directory(dir).set_file_name(&name).add_filter("PNG 그림", &["png"]).blocking_save_file();
        picked.and_then(|p| p.into_path().ok())
    };
    let Some(file) = file else { return Ok(json!({ "cancelled": true })) };
    if let Err(err) = std::fs::write(&file, bytes) {
        crate::windows::show_hud(app, "그림을 저장하지 못했어요", "다른 위치에 저장해 보세요", "warn");
        return Err(err.to_string());
    }
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(json!({ "file": file.to_string_lossy(), "name": name }))
}

// ---------- 공유 (내용 단추 › 공유 › 방법 고르기 — share-file.js) ----------

const LOCALSEND_DOWNLOAD: &str = "https://localsend.org/download";

/// 설치된 LocalSend 실행 파일 — 설치판 · 사용자 설치 · 휴대용(Scoop · winget 링크) 자리
fn find_local_send() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let places = [
        ("ProgramFiles", r"LocalSend\localsend_app.exe"),
        ("ProgramFiles(x86)", r"LocalSend\localsend_app.exe"),
        ("LOCALAPPDATA", r"Programs\LocalSend\localsend_app.exe"),
        ("LOCALAPPDATA", r"LocalSend\localsend_app.exe"),
        ("USERPROFILE", r"scoop\apps\localsend\current\localsend_app.exe"),
        ("LOCALAPPDATA", r"Microsoft\WinGet\Links\localsend_app.exe"),
    ];
    places.iter().filter_map(|(var, rel)| Some(PathBuf::from(std::env::var_os(var)?).join(rel))).find(|p| p.exists())
}

/// 공유할 파일: 메모 폴더의 첨부는 그대로, 만든 내용(표 CSV · 글 · 그림 PNG)은 임시 파일로
fn share_source(app: &AppHandle, f: &Value) -> Result<PathBuf, String> {
    use base64::Engine;
    if let Some(rel) = f["rel"].as_str().filter(|r| !r.is_empty()) {
        return crate::memos::attachment_file(app, rel);
    }
    let b64 = f["base64"].as_str().ok_or("공유할 내용이 없어요")?;
    let root = std::env::temp_dir().join("memoking-share");
    let make = || -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(&root)?;
        // 지난 공유 때 만든 임시 파일은 하루가 지나면 치운다 (공유 창이 넘겨받을 동안은 남겨 두고)
        for old in std::fs::read_dir(&root)?.flatten() {
            if old.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().unwrap_or_default() > Duration::from_secs(86_400)) {
                let _ = std::fs::remove_dir_all(old.path());
            }
        }
        // 공유마다 제 폴더에 (같은 이름으로 잇따라 공유해도 앞의 파일을 덮어쓰지 않게 — 이름은 그대로 보이도록)
        let dir = root.join(format!("s-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        std::fs::create_dir(&dir)?;
        let file = dir.join(crate::memos::safe_name(f["name"].as_str().unwrap_or("메모 내용")));
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(std::io::Error::other)?;
        std::fs::write(&file, bytes)?;
        Ok(file)
    };
    make().map_err(|err| {
        elog!("[share] {err}");
        "공유할 파일을 만들지 못했어요. 다시 눌러 주세요".to_string()
    })
}

// 기본 메일 앱(Outlook 등)의 새 메일에 첨부 (MAPI) — share-file.js MAIL_SCRIPT 그대로
#[cfg(windows)]
const MAIL_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MkMail {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class MapiFileDescW { public int reserved; public int flags; public int position = -1; public string pathName; public string fileName; public IntPtr fileType; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class MapiMessageW {
    public int reserved; public string subject; public string noteText; public string messageType; public string dateReceived; public string conversationID;
    public int flags; public IntPtr originator; public int recipCount; public IntPtr recips; public int fileCount; public IntPtr files;
  }
  [DllImport("mapi32.dll", CharSet = CharSet.Unicode)]
  static extern int MAPISendMailW(IntPtr session, IntPtr hwnd, MapiMessageW message, int flags, int reserved);
  public static int Send(string file, string subject) {
    MapiFileDescW f = new MapiFileDescW();
    f.pathName = file;
    f.fileName = System.IO.Path.GetFileName(file);
    IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(f));
    try {
      Marshal.StructureToPtr(f, p, false);
      MapiMessageW m = new MapiMessageW();
      m.subject = subject;
      m.noteText = "";
      m.fileCount = 1;
      m.files = p;
      return MAPISendMailW(IntPtr.Zero, IntPtr.Zero, m, 0x8 | 0x4 | 0x1, 0);
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
  $code = [MkMail]::Send($env:MK_SHARE_FILE, $env:MK_SHARE_TITLE)
  if ($code -eq 0 -or $code -eq 1) { [Console]::Out.WriteLine('ok') } else { [Console]::Out.WriteLine('err mapi ' + $code) }
} catch {
  [Console]::Out.WriteLine('err ' + $_.Exception.Message)
}
"#;

/// → "ok" | "err …" — 새 메일은 도우미가 떠 있는 동안만 유지되므로 대답 뒤에도 도우미는 그대로 둔다
#[cfg(windows)]
fn mail_attach(file: &Path, title: &str) -> String {
    use std::io::BufRead;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let child = Command::new("powershell.exe")
        .args(["-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", MAIL_SCRIPT])
        .env("MK_SHARE_FILE", file)
        .env("MK_SHARE_TITLE", title)
        .current_dir(std::env::temp_dir()) // 설치 폴더를 물려받으면 업데이트 때 그 폴더를 지우지 못한다
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return format!("err {e}"),
    };
    let out = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let lines = std::io::BufReader::new(out).split(b'\n').map_while(Result::ok);
        let line = lines.map(|l| String::from_utf8_lossy(&l).trim().to_string()).find(|l| !l.is_empty());
        let _ = tx.send(line);
    });
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(Some(line)) if line == "ok" || line.starts_with("ok ") => "ok".into(),
        Ok(Some(line)) => line,
        Ok(None) => "err exit".into(),
        Err(_) => {
            let _ = child.kill();
            "err timeout".into()
        }
    }
}

#[cfg(not(windows))]
fn mail_attach(_file: &Path, _title: &str) -> String {
    "err unavailable".into()
}

fn share_once(app: &AppHandle, f: &Value) -> Value {
    let via = f["via"].as_str().unwrap_or_default();
    if !["drive", "localsend", "mail"].contains(&via) {
        return json!({ "error": "공유 방법을 다시 골라 주세요" });
    }
    let file = match share_source(app, f) {
        Ok(file) => file,
        Err(error) => return json!({ "error": error }),
    };
    let title = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match via {
        "drive" if crate::ipc::smoke() => json!({ "ok": true, "link": "https://drive.google.com/smoke" }),
        "drive" => match crate::drive::share_link(app, &file, &title) {
            Ok(link) => {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let _ = app.clipboard().write_text(link.clone());
                json!({ "ok": true, "link": link })
            }
            Err(error) => json!({ "error": error }),
        },
        "localsend" => {
            let Some(exe) = find_local_send() else {
                let _ = app.opener().open_url(LOCALSEND_DOWNLOAD, None::<&str>);
                return json!({ "missing": true });
            };
            let spawned = std::process::Command::new(exe).arg(&file).current_dir(std::env::temp_dir()).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
            match spawned {
                Ok(_) => json!({ "ok": true }),
                Err(e) => json!({ "error": format!("LocalSend를 열지 못했어요 ({e})") }),
            }
        }
        // 남은 것은 메일 (위에서 방법을 걸렀다)
        _ => match mail_attach(&file, &title).as_str() {
            "ok" => json!({ "ok": true }),
            r if r.contains("mapi") => json!({ "error": "기본 메일 앱을 찾지 못했어요. Google Drive 링크나 LocalSend를 써 보세요" }),
            r => json!({ "error": format!("새 메일을 만들지 못했어요 ({})", r.strip_prefix("err ").unwrap_or(r)) }),
        },
    }
}

// ---------- 새 버전 안내 · 문제 보내기 ----------

/// encodeURIComponent
/// 문제 보내기 메일 (mailto 주소) — 버전 · 운영체제 · 들어가는 만큼의 최근 기록 (error-log.js problemMail: 긴 것은 오래된 줄부터 뺀다)
fn problem_mail(to: &str, version: &str, os: &str, lines: &[String]) -> String {
    // mailto 주소는 메일 앱마다 2000자 안팎에서 잘린다 (한글은 한 글자가 9자) — 다 안 들어가면 클립보드로
    const MAIL_CHARS: usize = 2000;
    let head = format!("메모킹 v{version} · {os}\n\n무슨 일이 있었나요?\n\n\n--- 최근 오류 기록 (전체는 클립보드에 있어요, Ctrl+V) ---\n");
    let subject = encode_uri_component(&format!("메모킹 v{version} 문제 알림"));
    let url = |body: &str| format!("mailto:{to}?subject={subject}&body={}", encode_uri_component(body));
    let mut picked = lines;
    while !picked.is_empty() && url(&(head.clone() + &picked.join("\n"))).len() > MAIL_CHARS {
        picked = &picked[1..];
    }
    url(&(head + &if picked.is_empty() { "(기록된 오류 없음)".to_string() } else { picked.join("\n") }))
}

// ---------- 기록 (설정 폴더 logs\memoking.log — Electron 의 desktop/error-log.js 와 같은 파일 · 같은 모양) ----------
//   이 PC 에만 남기고 어디로도 보내지 않는다. 설정 › 문제 보내기가 최근 줄을 붙인 메일을 띄운다 (보낼지는 사용자가)

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
const LOG_MAX: u64 = 512 * 1024; // 넘으면 .1 로 옮기고 새로 (둘까지만)

/// 켤 때 한 번 — 기록 파일 자리
pub fn init_log(app: &AppHandle) {
    let _ = LOG_FILE.set(state(app).settings_dir.join("logs").join("memoking.log"));
}

/// 기록 한 줄: "때 [kind] 글" — 줄바꿈은 ⏎ 로, 1000자까지 (오류 · 멈춤 · 화면 · 속도)
pub fn log(kind: &str, text: &str) {
    use std::io::Write;
    static WRITING: Mutex<()> = Mutex::new(()); // 여러 스레드가 함께 써도 줄이 섞이지 않게
    let Some(file) = LOG_FILE.get() else { return };
    let _one = WRITING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(file).is_ok_and(|m| m.len() > LOG_MAX) {
        let _ = std::fs::rename(file, file.with_extension("log.1"));
    }
    let at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let text: String = text.split('\n').map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ⏎ ").chars().take(1000).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{at} [{kind}] {text}");
    }
}

/// 속도 기록 한 줄 (메모 열기 · 닫기의 단계별 시간)
pub fn perf_log(text: &str) {
    log("속도", text);
}

/// 설정 › 문제 보내기: 최근 기록은 클립보드에, 들어가는 만큼은 새 메일 본문에 (보낼지는 사용자가)
fn report_problem(app: &AppHandle) -> Value {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    // 받는 주소는 support-mail.js 한 곳에만 (개인 메일이라 따로 둔 파일)
    let to = include_str!("../support-mail.js").split('\'').nth(1).unwrap_or_default();
    // 오류 기록 (설정 폴더 logs\memoking.log — 위 log())
    let log = std::fs::read_to_string(state(app).settings_dir.join("logs").join("memoking.log")).unwrap_or_default();
    let all: Vec<String> = log.split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect();
    let lines = &all[all.len().saturating_sub(300)..];
    let version = app.package_info().version.to_string();
    // shortcut: 운영체제 버전 번호(Windows_NT 10.0.x)는 없이 이름 · 종류만, 버전별 문제가 나오면 os_info 로
    let os = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    let _ = app.clipboard().write_text(std::iter::once(format!("메모킹 v{version} · {os}")).chain(lines.iter().cloned()).collect::<Vec<_>>().join("\n"));
    let _ = app.opener().open_url(problem_mail(to, &version, &os, lines), None::<&str>);
    json!({ "ok": true, "lines": lines.len() })
}

/// 업데이트 뒤 한 번: 지난번 켠 버전 다음부터 이번 버전까지 바뀐 점의 제목 (README 이력 표). 처음 설치는 튜토리얼이 먼저라 없음
fn whats_new(app: &AppHandle) -> Value {
    let st = state(app);
    let now = app.package_info().version.to_string();
    let seen = st.setting("seenVersion");
    if seen == now.as_str() || crate::ipc::smoke() {
        return Value::Null; // 자동 점검은 창 없이 (모달이라 뒤 화면을 막는다)
    }
    st.set_setting("seenVersion", now.clone().into());
    if st.setting("tutorialDone") != true {
        return Value::Null;
    }
    let items = memoking_core::release_notes::version_titles(include_str!("../../../README.md"), seen.as_str(), &now, 5);
    json!({ "version": now, "items": items })
}

// ---------- 목록 창 늘 위 ----------

pub fn set_list_on_top(app: &AppHandle, on: bool) -> bool {
    let Some(w) = app.get_webview_window("list") else { return false };
    let _ = w.set_always_on_top(on);
    state(app).set_setting("listOnTop", on.into());
    crate::windows::set_list_crown(app, on, true);
    let _ = app.emit_to("list", "list:on-top", [on]);
    on
}

fn list_on_top(app: &AppHandle) -> bool {
    app.get_webview_window("list").is_some_and(|w| w.is_always_on_top().unwrap_or(false))
}

/// 로그인 때 자동 실행 (Electron autoStartAvailable · getAutoStart), 설치한 Windows 메모킹에서만
pub fn auto_start(app: &AppHandle) -> Value {
    let available = cfg!(windows) && !cfg!(debug_assertions) && !crate::ipc::smoke();
    json!({ "available": available, "enabled": available && app.autolaunch().is_enabled().unwrap_or(false) })
}

pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
    Some(match channel {
        "list:show" => {
            crate::os::show_list(app);
            Ok(Value::Null)
        }
        "list:on-top" => Ok(list_on_top(app).into()),
        "list:crown-docked" => Ok(crate::windows::list_crown_docked().into()),
        "list:toggle-top" => Ok(set_list_on_top(app, !list_on_top(app)).into()),
        // 찾지 못한 메모 폴더를 다시 찾아본다 (외장 드라이브를 다시 꽂음 등) — 있으면 열고, 없으면 그대로
        "vault:retry" => {
            let st = state(app);
            let missing = st.vault_missing.lock().unwrap().clone();
            if let Some(dir) = missing.as_ref().filter(|d| Path::new(d).exists()) {
                st.open_vault(app, PathBuf::from(dir));
                crate::memos::push_list(app);
                return Some(Ok(st.vault_info(app)));
            }
            let mut info = st.vault_info(app);
            info["stillMissing"] = missing.is_some().into();
            Ok(info)
        }
        "vault:reveal" => Ok(match vault_root(app) {
            Some(root) => match app.opener().open_path(root.to_string_lossy(), None::<&str>) {
                Ok(()) => "".into(),
                Err(e) => e.to_string().into(),
            },
            None => Value::Null,
        }),
        "link:open" => Ok(open_web_page(app, &memoking_core::js::string(&arg(0))).into()),
        "link:preview" => Ok(link_preview(app, &arg_str(args, 0), arg(1)["refresh"].as_bool().unwrap_or(false))),
        "image:copy" => {
            use base64::Engine;
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let png = base64::engine::general_purpose::STANDARD.decode(memoking_core::js::string(&arg(0))).ok();
            let image = png.and_then(|b| tauri::image::Image::from_bytes(&b).ok()).ok_or_else(|| "그림을 읽지 못했어요. 다른 그림으로 다시 해 주세요".to_string());
            image.and_then(|img| app.clipboard().write_image(&img).map_err(|e| e.to_string())).map(|()| json!({ "ok": true }))
        }
        "image:save" => save_png(app, &arg(0), &memoking_core::js::string(&arg(1)), args.get(2).and_then(Value::as_str)),
        "attachment:copy" => Ok(vault_file(app, &arg(0)).is_some_and(|f| copy_files(&[f])).into()),
        // 묶음 사진 복사: 장마다의 파일을 한 번에
        "attachment:copy-many" => {
            let files: Vec<PathBuf> = arg(0).as_array().into_iter().flatten().filter_map(|r| vault_file(app, r)).collect();
            Ok((!files.is_empty() && copy_files(&files)).into())
        }
        "attachment:fetch" => fetch_remote_image(app, &memoking_core::js::string(&arg(0))),
        "share:targets" => {
            let local_send = find_local_send().is_some();
            let drive = crate::drive::connected();
            Ok(json!([
                { "id": "drive", "label": "Google Drive 링크", "sub": if drive { "올리고 링크를 복사해요 (링크가 있는 사람은 보기)" } else { "아직 연결 전이에요. 눌러서 설정에서 연결하기" }, "ready": drive, "connect": !drive },
                { "id": "localsend", "label": "LocalSend", "sub": if local_send { "같은 와이파이의 휴대폰, PC로 바로 (오픈소스)" } else { "무료 오픈소스 앱, 누르면 내려받기 페이지를 열어요" }, "ready": true },
                { "id": "mail", "label": "메일에 첨부", "sub": "기본 메일 앱(Outlook 등)의 새 메일에", "ready": cfg!(windows) || crate::ipc::smoke() },
            ]))
        }
        "attachment:share" => {
            let f = arg(0);
            let r = share_once(app, &f);
            // 공유가 안 될 때 까닭을 남긴다 (설정 폴더의 share.log — 사용자가 보내 주면 고칠 수 있게)
            if let Some(err) = r["error"].as_str() {
                use std::io::Write;
                let line = format!("{} [{}] {}\n", now_iso(), f["via"].as_str().unwrap_or_default(), memoking_core::js::slice16(err, 2000));
                let log = std::fs::OpenOptions::new().create(true).append(true).open(state(app).settings_dir.join("share.log"));
                let _ = log.and_then(|mut file| file.write_all(line.as_bytes()));
            }
            Ok(r)
        }
        "app:set-auto-start" => {
            if auto_start(app)["available"] == true {
                let al = app.autolaunch();
                if let Err(err) = if crate::settings::truthy(args.first()) { al.enable() } else { al.disable() } {
                    elog!("자동 실행을 바꾸지 못했어요: {err}");
                }
                state(app).set_setting("autoStartSet", true.into());
                crate::os::refresh_tray(app); // 바꾸지 못했어도 알림 영역의 체크를 실제대로
            }
            Ok(auto_start(app)["enabled"].clone())
        }
        "app:whats-new" => Ok(whats_new(app)),
        "app:report-problem" => Ok(report_problem(app)),
        "perf:log" => {
            perf_log(&arg(0).as_str().unwrap_or_default().chars().take(300).collect::<String>());
            Ok(Value::Null)
        }
        // 화면(창)에서 난 잡히지 않은 오류 — 어느 창인지와 함께 (shim.js)
        "app:log-error" => {
            log("화면", &format!("{label} {}", arg(0).as_str().unwrap_or_default().chars().take(800).collect::<String>()));
            Ok(Value::Null)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_names() {
        assert_eq!(png_name(Some("회상 2026.PNG"), "x"), "회상 2026.PNG");
        assert_eq!(png_name(Some("a/b.png"), "제목"), "제목.png");
        assert_eq!(png_name(Some(".png"), ""), "메모.png");
        assert_eq!(png_name(None, " 회의:  메모\n둘 "), "회의 메모 둘.png");
        assert_eq!(png_name(None, "???"), "메모.png");
        assert_eq!(png_name(None, &"가".repeat(90)).chars().count(), 84);
    }

    #[test]
    fn problem_mail_drops_oldest_lines() {
        assert_eq!(encode_uri_component("a b/가!"), "a%20b%2F%EA%B0%80!");
        let none = problem_mail("x@y.z", "1.0.0", "windows x86_64", &[]);
        assert!(none.starts_with("mailto:x@y.z?subject=%EB%A9%94") && none.contains(&encode_uri_component("(기록된 오류 없음)")));
        let lines: Vec<String> = (0..300).map(|i| format!("{i:03} 오류")).collect();
        let url = problem_mail("x@y.z", "1.0.0", "windows", &lines);
        assert!(url.len() <= 2000 && url.ends_with(&encode_uri_component("299 오류")) && !url.contains(&encode_uri_component("000 오류")));
    }
}
