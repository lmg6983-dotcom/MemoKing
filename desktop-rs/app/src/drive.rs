// Google Drive 동기화 — 메모 폴더(이 PC)를 고른 Drive 폴더와 맞춘다. Electron 의 desktop/drive/ (google-auth.js · drive-api.js · drive-sync.js)
//   와 main.js · ipc-handlers.js 의 그 부분. 무엇을 올리고 받고 지울지는 core 의 drive_sync (sync-engine.js 와 같은 답).
// 로그인: 기본 브라우저 → 이 PC 안 작은 서버(127.0.0.1)로 결과를 받는다 ("데스크톱 앱" OAuth 클라이언트 + PKCE).
// 받은 토큰은 이 PC 에만 (%APPDATA%\MemoKing\google-auth.json) — Windows 에서는 Electron safeStorage 와 같은 암호로 (서로 읽는다).
// 기준 기록은 %APPDATA%\MemoKing\drive\<Drive 폴더 id>.<열쇠>.json (Electron 과 같은 파일).
use crate::memos::arg_str;
use crate::state::State;
use base64::Engine as _;
use memoking_core::drive_sync::{self, inside_drive_for_desktop, Changes, RemoteItem, SyncState, FOLDER};
use memoking_core::time::now_ms;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const FILE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
// Drive 전체 — 더는 요청하지 않는다. 예전 "외부 앱 메모 연동" 으로 받아 둔 연결만 끊지 않고 쓴다
const FULL_SCOPE: &str = "https://www.googleapis.com/auth/drive";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const FIELDS: &str = "id,name,mimeType,md5Checksum,modifiedTime,createdTime,size";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const OFFLINE: &str = "인터넷에 연결되지 않아 동기화하지 못했어요";
const DOUBLE_SYNC: &str = "메모 폴더를 Google Drive 데스크탑 앱도 동기화하고 있어서 메모킹 동기화를 멈췄어요 (휴대폰에서 메모가 사라지지 않게). 설정의 Google Drive 동기화에서 \"연결 끊기\" 뒤 \"연결하기\"를 누르면 메모를 문서\\메모킹 으로 옮겨 맞춰요";
// 주기: 쉬는 중 · 메모킹 창을 쓰는 중 10초 · 파일이 오간 뒤 2분은 5초 (휴대폰과 주고받는 중일 때 빨리)
const POLL_IDLE: Duration = Duration::from_secs(10); // 쉬는 중에도 10초 — 평소에는 "바뀐 것 있어?" 한 번만 묻는 가벼운 요청이라 (휴대폰 · Gemini 가 쓴 것이 빨리 오게)
const POLL_ACTIVE: Duration = Duration::from_secs(10);
const POLL_BURST: Duration = Duration::from_secs(5);
const BURST_FOR: Duration = Duration::from_secs(120);
const FOCUS_GAP: Duration = Duration::from_secs(5);
// 안전장치로 멈추면 자동 동기화는 이만큼 쉰다 — 같은 모습이면 다시 해도 또 멈추며 폴더만 계속 훑는다 ("지금 동기화" · 폴더를 바꾸면 바로)
const SAFETY_HOLD: Duration = Duration::from_secs(5 * 60);
// 이보다 작은 파일은 요청 한 번(multipart)으로 올린다 — 이어 올리기는 요청이 두 번이라 메모가 많으면 처음 동기화가 두 배 걸린다
const SIMPLE_UPLOAD_MAX: usize = 5 << 20;
// 진행 상황은 이만큼마다 한 번만 알린다 (파일마다 창에 보내면 목록이 바빠진다)
const PROGRESS_MS: u128 = 300;

struct Drive {
    dir: PathBuf,
    data: Mutex<Map<String, Value>>,
    /// (접근 토큰, 만료 ms) — 잠가 둔 채 새로 받아 여러 줄이 한꺼번에 새로 받지 않게
    access: Mutex<(String, i64)>,
    /// 범위 표시가 없는 아주 예전 연결을 지웠다 (다시 연결해 달라고)
    scope_upgraded: AtomicBool,
    login_cancel: Mutex<Option<Arc<AtomicBool>>>,
    status: Mutex<Value>,
    /// 한 번에 하나만 돈다
    running: Mutex<()>,
    sched: Mutex<Sched>,
    /// 폴더 고르기 · 자동 연결은 한 번에 하나만 (두 번 눌러도 메모 폴더를 두 번 옮기지 않게)
    folder_busy: Mutex<()>,
}

struct Sched {
    due: Option<Instant>,
    next_poll: Instant,
    burst_until: Instant,
    last_focus: Option<Instant>,
    focused: bool,
    config: String,
    hold_until: Instant,
}

static DRIVE: OnceLock<Drive> = OnceLock::new();

fn d() -> &'static Drive {
    DRIVE.get().expect("drive::start 먼저")
}

// AuthError (google-auth.js) — 구글이 4xx 로 거절함. 새 토큰을 받다 이러면 연결을 끊는다
fn auth_err(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, msg.into())
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random(n: usize) -> Vec<u8> {
    let mut b = vec![0; n];
    getrandom::fill(&mut b).expect("난수");
    b
}

// ---------- 토큰 저장 (Electron safeStorage 와 같게) ----------

#[cfg(windows)]
fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: 입력은 살아 있는 조각, 결과는 Windows 가 LocalAlloc 으로 준 것을 복사하고 놓는다
    unsafe {
        let ok = if protect {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out)
        } else {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out)
        };
        if ok == 0 {
            return None;
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData.cast());
        Some(v)
    }
}

/// Electron(Chromium) 의 열쇠: 설정 폴더 "Local State" 의 os_crypt.encrypted_key = "DPAPI" + DPAPI 로 감싼 32바이트.
///   없으면 만들어 둔다 (Electron 판으로 돌아가도 같은 열쇠로 읽게)
#[cfg(windows)]
fn os_key(dir: &Path) -> Option<Vec<u8>> {
    let file = dir.join("Local State");
    let mut ls: Map<String, Value> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let b64 = base64::engine::general_purpose::STANDARD;
    if let Some(k) = ls.get("os_crypt").and_then(|o| o["encrypted_key"].as_str()).and_then(|k| b64.decode(k).ok()) {
        return k.strip_prefix(b"DPAPI").and_then(|k| dpapi(k, false)).filter(|k| k.len() == 32);
    }
    let key = random(32);
    let sealed = [b"DPAPI".as_slice(), &dpapi(&key, true)?].concat();
    let os = ls.entry("os_crypt").or_insert_with(|| json!({}));
    os["encrypted_key"] = b64.encode(sealed).into();
    memoking_core::vault::write_atomic(&file, serde_json::to_string(&ls).ok()?.as_bytes()).ok()?;
    Some(key)
}

/// safeStorage.encryptString: "v10" + 12바이트 nonce + AES-256-GCM
#[cfg(windows)]
fn seal(dir: &Path, plain: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&os_key(dir)?).ok()?;
    let nonce = random(12);
    let ct = cipher.encrypt(aes_gcm::Nonce::from_slice(&nonce), plain).ok()?;
    Some([b"v10".as_slice(), &nonce, &ct].concat())
}

#[cfg(windows)]
fn unseal(dir: &Path, blob: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    let rest = blob.strip_prefix(b"v10")?;
    if rest.len() < 12 {
        return None;
    }
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&os_key(dir)?).ok()?;
    cipher.decrypt(aes_gcm::Nonce::from_slice(&rest[..12]), &rest[12..]).ok()
}

// shortcut: Windows 밖에서는 Electron 처럼(암호 저장소가 없을 때) 감싸지 않고 둔다 — 다른 OS 판을 낼 때 그 OS 열쇠고리로
#[cfg(not(windows))]
fn seal(_dir: &Path, _plain: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
fn unseal(_dir: &Path, _blob: &[u8]) -> Option<Vec<u8>> {
    None
}

fn load_auth(dir: &Path) -> Map<String, Value> {
    let Ok(raw) = std::fs::read_to_string(dir.join("google-auth.json")).map(|t| serde_json::from_str::<Value>(&t).unwrap_or_default()) else { return Map::new() };
    if let Some(enc) = raw["encrypted"].as_str() {
        let plain = base64::engine::general_purpose::STANDARD.decode(enc).ok().and_then(|b| unseal(dir, &b));
        return plain.and_then(|p| serde_json::from_slice(&p).ok()).unwrap_or_default();
    }
    raw["plain"].as_object().cloned().unwrap_or_default()
}

impl Drive {
    fn save(&self) -> io::Result<()> {
        let json = serde_json::to_string(&*self.data.lock().unwrap())?;
        let out = match seal(&self.dir, json.as_bytes()) {
            Some(blob) => json!({ "encrypted": base64::engine::general_purpose::STANDARD.encode(blob) }),
            None if cfg!(windows) => return Err(io::Error::other("Google 로그인 정보를 암호화하지 못했어요")), // Windows 에서는 글자 그대로 두지 않는다
            None => json!({ "plain": *self.data.lock().unwrap() }),
        };
        std::fs::create_dir_all(&self.dir)?;
        memoking_core::vault::write_atomic(&self.dir.join("google-auth.json"), out.to_string().as_bytes())
    }

    fn get(&self, key: &str) -> Value {
        self.data.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
    }

    fn connected(&self) -> bool {
        self.get("refreshToken").as_str().is_some_and(|s| !s.is_empty())
    }

    fn email(&self) -> String {
        self.get("email").as_str().unwrap_or_default().into()
    }

    fn set_email(&self, email: &str) {
        self.data.lock().unwrap().insert("email".into(), email.into());
        let _ = self.save();
    }

    // ---------- OAuth 클라이언트 ----------
    //   설정에 붙여 넣은 것 → 환경 변수 → 빌드 때 넣은 것(release-rs.yml 의 MEMOKING_GOOGLE_CLIENT_ID · SECRET) · %APPDATA%\MemoKing\google-client.json → 예전에 로그인했던 클라이언트

    fn bundled(&self) -> Option<(String, String)> {
        if let Some(id) = option_env!("MEMOKING_GOOGLE_CLIENT_ID").map(str::trim).filter(|s| !s.is_empty()) {
            return Some((id.into(), option_env!("MEMOKING_GOOGLE_CLIENT_SECRET").unwrap_or_default().trim().into()));
        }
        let b: Value = serde_json::from_str(&std::fs::read_to_string(self.dir.join("google-client.json")).ok()?).ok()?;
        Some((b["id"].as_str().filter(|s| !s.is_empty())?.into(), b["secret"].as_str().unwrap_or_default().into()))
    }

    fn client_and_source(&self) -> Option<((String, String), &'static str)> {
        let pair = |v: Value, id: &str, secret: &str| v[id].as_str().filter(|s| !s.is_empty()).map(|i| (i.to_string(), v[secret].as_str().unwrap_or_default().to_string()));
        let data = Value::Object(self.data.lock().unwrap().clone());
        if let Some(c) = pair(data.clone(), "clientId", "clientSecret") {
            return Some((c, "manual"));
        }
        if let Some(id) = std::env::var("MEMOKING_GOOGLE_CLIENT_ID").ok().filter(|s| !s.is_empty()) {
            return Some(((id, std::env::var("MEMOKING_GOOGLE_CLIENT_SECRET").unwrap_or_default()), "env"));
        }
        if let Some(c) = self.bundled() {
            return Some((c, "bundled"));
        }
        pair(data["tokenClient"].clone(), "id", "secret").map(|c| (c, "remembered"))
    }

    fn client(&self) -> Option<(String, String)> {
        self.client_and_source().map(|(c, _)| c)
    }

    /// 새 토큰을 받을 클라이언트 — 그 토큰을 준 클라이언트 (기억해 둔 게 없으면 지금 클라이언트)
    fn refresh_client(&self) -> Option<(String, String)> {
        let t = self.get("tokenClient");
        t["id"].as_str().filter(|s| !s.is_empty()).map(|id| (id.to_string(), t["secret"].as_str().unwrap_or_default().to_string())).or_else(|| self.client())
    }

    // ---------- 토큰 ----------

    fn token(&self) -> io::Result<String> {
        let mut access = self.access.lock().unwrap();
        if !access.0.is_empty() && now_ms() < access.1 - 60_000 {
            return Ok(access.0.clone());
        }
        let Some(refresh) = self.get("refreshToken").as_str().filter(|s| !s.is_empty()).map(str::to_string) else { return Err(auth_err("Google Drive에 로그인해 주세요")) };
        let (id, secret) = self.refresh_client().ok_or_else(|| auth_err("Google 로그인 설정(연결 ID, 비밀번호)이 없어요. 설정 Google Drive 동기화의 연결하기에서 다시 넣어 주세요"))?;
        let token = match post(TOKEN_URL, &[("refresh_token", &refresh), ("client_id", &id), ("client_secret", &secret), ("grant_type", "refresh_token")]) {
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
                // 권한을 거둬 갔거나 오래돼서 끊김 → 다시 로그인
                self.data.lock().unwrap().remove("refreshToken");
                let _ = self.save();
                return Err(auth_err("Google Drive 로그인이 끊겼어요. 다시 연결해 주세요"));
            }
            r => r?,
        };
        *access = (token["access_token"].as_str().unwrap_or_default().into(), now_ms() + token["expires_in"].as_i64().unwrap_or(3600) * 1000);
        Ok(access.0.clone())
    }

    fn invalidate(&self) {
        self.access.lock().unwrap().0.clear();
    }

    fn sign_out(&self) {
        let refresh = self.data.lock().unwrap().remove("refreshToken");
        self.data.lock().unwrap().remove("email");
        self.invalidate();
        let _ = self.save();
        if let Some(t) = refresh.and_then(|t| t.as_str().map(str::to_string)) {
            std::thread::spawn(move || post(REVOKE_URL, &[("token", &t)]));
        }
    }
}

// ---------- HTTP ----------

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let config = crate::files::web_config()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .build();
        ureq::Agent::new_with_config(config)
    })
}

type Response = ureq::http::Response<ureq::Body>;

fn call(method: &str, url: &str, headers: &[(&str, String)], body: Option<Vec<u8>>) -> io::Result<Response> {
    let mut req = ureq::http::Request::builder().method(method).uri(url);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let res = match body {
        Some(b) => agent().run(req.body(b).map_err(io::Error::other)?),
        None => agent().run(req.body(()).map_err(io::Error::other)?),
    };
    res.map_err(|e| {
        elog!("[Google Drive] {e}");
        io::Error::new(io::ErrorKind::ConnectionAborted, OFFLINE)
    })
}

fn read_text(res: &mut Response) -> String {
    res.body_mut().with_config().limit(64 << 20).read_to_string().unwrap_or_default()
}

/// 로그인 서버에 폼 보내기 (google-auth.js post) — 4xx 는 AuthError
fn post(url: &str, form: &[(&str, &str)]) -> io::Result<Value> {
    let body = form.iter().map(|(k, v)| format!("{}={}", crate::memos::query_escape(k), crate::memos::query_escape(v))).collect::<Vec<_>>().join("&");
    let mut res = call("POST", url, &[("Content-Type", "application/x-www-form-urlencoded".into())], Some(body.into_bytes()))?;
    let status = res.status().as_u16();
    let text = read_text(&mut res);
    let json: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    if (400..500).contains(&status) {
        let why = json["error_description"].as_str().filter(|s| !s.is_empty()).or(json["error"].as_str()).unwrap_or(&text);
        return Err(auth_err(format!("Google 로그인 오류: {why}")));
    }
    if !(200..300).contains(&status) {
        return Err(io::Error::other(format!("Google 서버에 문제가 있어요 ({status}). 잠시 뒤 다시 해 주세요")));
    }
    Ok(json)
}

fn describe(status: u16, text: &str) -> String {
    let msg = serde_json::from_str::<Value>(text).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_string)).unwrap_or_else(|| text.into());
    match status {
        401 => "Google Drive 로그인이 끊겼어요. 설정에서 다시 연결해 주세요".into(),
        403 if msg.contains("has not been used") || msg.contains("disabled") => "Google Cloud 프로젝트에서 Google Drive API를 켜 주세요".into(),
        403 => format!("Google Drive가 허락하지 않았어요: {msg}"),
        404 => "Google Drive에서 폴더나 파일을 찾지 못했어요".into(),
        _ => format!("Google Drive 오류 ({status}): {msg}"),
    }
}

fn q(s: &str) -> String {
    crate::memos::query_escape(s)
}

/// Drive REST API v3 — 동기화에 필요한 만큼만 (drive-api.js)
struct Api;

impl Api {
    // 요청 하나: 토큰 만료(401)면 한 번 새 토큰으로, 429·5xx 는 잠깐 쉬었다 다시 (최대 3번)
    fn request(&self, method: &str, url: &str, headers: &[(&str, String)], body: Option<Vec<u8>>) -> io::Result<Response> {
        for attempt in 0.. {
            let mut h = vec![("Authorization", format!("Bearer {}", d().token()?))];
            h.extend(headers.iter().cloned());
            let mut res = call(method, url, &h, body.clone())?;
            let status = res.status().as_u16();
            if res.status().is_success() {
                return Ok(res);
            }
            let text = read_text(&mut res);
            if status == 401 && attempt == 0 {
                d().invalidate();
                continue;
            }
            if (status == 429 || status >= 500 || (status == 403 && text.to_lowercase().contains("ratelimit"))) && attempt < 3 {
                std::thread::sleep(Duration::from_millis(1000 << attempt));
                continue;
            }
            return Err(io::Error::other(describe(status, &text)));
        }
        unreachable!()
    }

    fn json(&self, method: &str, url: &str, data: Option<Value>) -> io::Result<Value> {
        let headers = [("Content-Type", "application/json; charset=UTF-8".to_string())];
        let mut res = self.request(method, url, if data.is_some() { &headers } else { &[] }, data.map(|d| d.to_string().into_bytes()))?;
        Ok(serde_json::from_str(&read_text(&mut res)).unwrap_or(json!({})))
    }

    /// 구글 계정 이메일
    fn about(&self) -> io::Result<String> {
        Ok(self.json("GET", &format!("{API}/about?fields=user"), None)?["user"]["emailAddress"].as_str().unwrap_or_default().into())
    }

    fn query(&self, query: &str, order_by: Option<&str>) -> io::Result<Vec<RemoteItem>> {
        let mut out = vec![];
        let mut page: Option<String> = None;
        loop {
            let mut url = format!("{API}/files?q={}&fields={}&pageSize=1000&spaces=drive", q(query), q(&format!("nextPageToken,files({FIELDS})")));
            if let Some(o) = order_by {
                url += &format!("&orderBy={}", q(o));
            }
            if let Some(p) = &page {
                url += &format!("&pageToken={}", q(p));
            }
            let res = self.json("GET", &url, None)?;
            out.extend(res["files"].as_array().into_iter().flatten().map(RemoteItem::from_json));
            page = res["nextPageToken"].as_str().map(str::to_string);
            if page.is_none() {
                return Ok(out);
            }
        }
    }

    /// 폴더 고르기 화면용: parent("root" = 내 드라이브) 안의 폴더들 — 같은 이름이면 먼저 만든 것부터
    fn folders(&self, parent: &str) -> io::Result<Vec<RemoteItem>> {
        self.query(&format!("'{}' in parents and mimeType = '{FOLDER}' and trashed = false", quote(parent)), Some("name,createdTime"))
    }

    /// parent 안의 이 이름 폴더들, 먼저 만든 것부터 (Drive 는 같은 이름 폴더를 여럿 둘 수 있다)
    fn find_folders(&self, name: &str, parent: &str) -> io::Result<Vec<RemoteItem>> {
        let mut list = self.query(&format!("'{}' in parents and name = '{}' and mimeType = '{FOLDER}' and trashed = false", quote(parent), quote(name)), None)?;
        list.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
        Ok(list)
    }
}

// ---------- Google Drive 로 공유 (share-drive.js) ----------

const SHARE_FOLDER: &str = "메모킹 공유";

pub fn connected() -> bool {
    d().connected()
}

/// 내 드라이브의 "메모킹 공유" 폴더에 올리고, 링크가 있는 사람은 볼 수 있는 링크 (메모킹이 만든 파일만 다루는 drive.file 권한으로 충분).
///   폴더 id 는 설정에 기억 — 지워졌거나 휴지통이면 같은 이름 폴더를 찾아 쓰고, 없으면 새로 만든다
pub fn share_link(app: &AppHandle, file: &Path, name: &str) -> Result<String, String> {
    use drive_sync::Remote;
    if !d().connected() {
        return Err("설정에서 Google Drive를 먼저 연결해 주세요".into());
    }
    let (api, st) = (Api, app.state::<State>());
    let alive = |id: &str| api.json("GET", &format!("{API}/files/{}?fields=id,trashed", q(id)), None).is_ok_and(|v| v["trashed"] != true);
    let folder = match st.setting("driveShareFolderId").as_str().filter(|id| alive(id)) {
        Some(id) => id.to_string(),
        None => {
            let found = api.find_folders(SHARE_FOLDER, "root").map_err(|e| e.to_string())?.into_iter().next();
            let id = match found {
                Some(f) => f.id,
                None => api.create_folder("root", SHARE_FOLDER).map_err(|e| e.to_string())?.id,
            };
            st.set_setting("driveShareFolderId", id.clone().into());
            id
        }
    };
    let fail = |e: io::Error| format!("Google Drive에 올리지 못했어요 ({e})");
    let up = api.upload(&folder, name, None, file).map_err(fail)?;
    api.json("POST", &format!("{API}/files/{}/permissions?fields=id", q(&up.id)), Some(json!({ "type": "anyone", "role": "reader" }))).map_err(|e| {
        if e.to_string().contains("허락하지 않았어요") { "조직 설정 때문에 링크로 공유할 수 없어요. 메일이나 LocalSend를 써 주세요".to_string() } else { fail(e) }
    })?;
    let link = api.json("GET", &format!("{API}/files/{}?fields=webViewLink", q(&up.id)), None).ok().and_then(|v| v["webViewLink"].as_str().map(str::to_string));
    Ok(link.unwrap_or_else(|| format!("https://drive.google.com/file/d/{}/view", up.id)))
}

fn quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

impl drive_sync::Remote for Api {
    fn list_children(&self, folder_id: &str) -> io::Result<Vec<RemoteItem>> {
        self.query(&format!("'{}' in parents and trashed = false", quote(folder_id)), None)
    }

    fn download(&self, id: &str, file: &Path) -> io::Result<()> {
        let mut res = self.request("GET", &format!("{API}/files/{}?alt=media", q(id)), &[], None)?;
        let mut out = std::fs::File::create(file)?;
        io::copy(&mut res.body_mut().as_reader(), &mut out)?;
        Ok(())
    }

    // "이어 올리기(resumable)": 올릴 주소를 받고 → 내용을 보낸다
    fn upload(&self, parent: &str, name: &str, existing: Option<&str>, file: &Path) -> io::Result<RemoteItem> {
        let data = std::fs::read(file)?;
        let fields = q(FIELDS);
        let (method, start, meta) = match existing {
            Some(id) => ("PATCH", format!("{UPLOAD}/files/{}?uploadType=resumable&fields={fields}", q(id)), json!({})),
            None => ("POST", format!("{UPLOAD}/files?uploadType=resumable&fields={fields}"), json!({ "name": name, "parents": [parent] })),
        };
        if data.len() <= SIMPLE_UPLOAD_MAX {
            let boundary = format!("memoking{}", now_ms());
            let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
            body.extend(data);
            body.extend(format!("\r\n--{boundary}--").bytes());
            let headers = [("Content-Type", format!("multipart/related; boundary={boundary}"))];
            let mut res = self.request(method, &start.replace("uploadType=resumable", "uploadType=multipart"), &headers, Some(body))?;
            return Ok(RemoteItem::from_json(&serde_json::from_str(&read_text(&mut res)).unwrap_or_default()));
        }
        let headers = [("Content-Type", "application/json; charset=UTF-8".to_string()), ("X-Upload-Content-Length", data.len().to_string())];
        let res = self.request(method, &start, &headers, Some(meta.to_string().into_bytes()))?;
        let location = res.headers().get("location").and_then(|l| l.to_str().ok()).map(str::to_string);
        let location = location.ok_or_else(|| io::Error::other("Google Drive가 올릴 주소를 주지 않았어요. 잠시 뒤 다시 해 주세요"))?;
        for attempt in 0.. {
            let mut put = call("PUT", &location, &[("Content-Type", "application/octet-stream".into())], Some(data.clone()))?;
            let text = read_text(&mut put);
            if put.status().is_success() {
                return Ok(RemoteItem::from_json(&serde_json::from_str(&text).unwrap_or_default()));
            }
            if put.status().as_u16() >= 500 && attempt < 2 {
                std::thread::sleep(Duration::from_millis(1000 << attempt));
                continue;
            }
            return Err(io::Error::other(describe(put.status().as_u16(), &text)));
        }
        unreachable!()
    }

    fn create_folder(&self, parent: &str, name: &str) -> io::Result<RemoteItem> {
        Ok(RemoteItem::from_json(&self.json("POST", &format!("{API}/files?fields={}", q(FIELDS)), Some(json!({ "name": name, "mimeType": FOLDER, "parents": [parent] })))?))
    }

    fn trash(&self, id: &str) -> io::Result<()> {
        self.json("PATCH", &format!("{API}/files/{}?fields=id", q(id)), Some(json!({ "trashed": true }))).map(|_| ())
    }

    /// 지난 토큰 이후 이 메모 폴더 안에서 바뀐 것
    fn changes_since(&self, token: Option<&str>, known: &HashSet<String>) -> io::Result<Changes> {
        let Some(token) = token else {
            let start = self.json("GET", &format!("{API}/changes/startPageToken"), None)?;
            return Ok(Changes { changed: true, token: start["startPageToken"].as_str().unwrap_or_default().into(), items: None });
        };
        let mut raw = vec![];
        let mut page = token.to_string();
        loop {
            let fields = q(&format!("nextPageToken,newStartPageToken,changes(fileId,removed,file({FIELDS},parents,trashed))"));
            let url = format!("{API}/changes?pageToken={}&pageSize=1000&spaces=drive&includeRemoved=true&restrictToMyDrive=true&fields={fields}", q(&page));
            let mut res = self.json("GET", &url, None)?;
            raw.extend(res["changes"].as_array_mut().map(std::mem::take).unwrap_or_default());
            if let Some(next) = res["nextPageToken"].as_str() {
                page = next.into();
                continue;
            }
            let items = drive_sync::pick_changes(&raw, known);
            return Ok(Changes { changed: !items.is_empty(), token: res["newStartPageToken"].as_str().unwrap_or(&page).into(), items: Some(items) });
        }
    }
}

// ---------- 로그인 ----------

/// "client secret is invalid" 같은 클라이언트 오류 → 어디를 고쳐야 하는지 알려 주는 안내
fn invalid_client_help(err: io::Error, source: &str) -> io::Error {
    let msg = err.to_string();
    let lower = msg.to_lowercase();
    if err.kind() != io::ErrorKind::PermissionDenied || !["invalid_client", "client secret is invalid", "client_secret", "unauthorized", "the oauth client was not found"].iter().any(|k| lower.contains(k)) {
        return err;
    }
    let wher = match source {
        "manual" => "설정에 붙여 넣은 클라이언트 ID, 보안 비밀번호가 서로 맞지 않아요. 설정의 Google Drive의 클라이언트를 삭제하거나 같은 클라이언트의 값으로 다시 붙여 넣어 주세요 (삭제하면 앱에 들어 있는 연결 정보를 써요)",
        "bundled" => "이 앱에 들어 있는 Google 연결 정보(보안 비밀번호)가 맞지 않아요. 배포할 때 넣는 MEMOKING_GOOGLE_CLIENT_ID, MEMOKING_GOOGLE_CLIENT_SECRET이 같은 클라이언트의 값인지 확인하고 다시 배포해야 해요",
        "env" => "환경 변수 MEMOKING_GOOGLE_CLIENT_ID, MEMOKING_GOOGLE_CLIENT_SECRET이 서로 맞지 않아요",
        "remembered" => "예전에 로그인했던 클라이언트의 보안 비밀번호가 더 이상 맞지 않아요. 설정에서 클라이언트를 새로 붙여 넣어 주세요",
        _ => "Google 클라이언트(ID, 보안 비밀번호)를 확인해 주세요",
    };
    auth_err(format!("Google 로그인 오류: 클라이언트 보안 비밀번호가 올바르지 않아요. {wher}. (원문: {})", msg.trim_start_matches("Google 로그인 오류: ")))
}

fn page(ok: bool) -> String {
    let (title, sub) = if ok { ("메모킹에 Google Drive를 연결했어요", "이 창을 닫고 메모킹으로 돌아가세요.") } else { ("연결하지 못했어요", "메모킹으로 돌아가 다시 해 주세요.") };
    format!(
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>메모킹</title>\n<style>body{{font-family:system-ui,\"Malgun Gothic\",sans-serif;background:#f5f5f5;color:#111;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center}}\nh1{{font-size:22px}}p{{color:#686868}}</style></head><body><div><h1>{title}</h1><p>{sub}</p></div></body></html>"
    )
}

/// 브라우저가 돌아온 주소의 ?a=b&… (없으면 None)
fn query_of(request_line: &str) -> Option<Vec<(String, String)>> {
    let target = request_line.split_whitespace().nth(1)?;
    let query = target.split_once('?')?.1;
    Some(query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (crate::percent_decode(k), crate::percent_decode(&v.replace('+', " ")))).collect())
}

/// 기본 브라우저로 로그인 → 허용하면 토큰을 받아 둔다. 취소·실패하면 지금 연결(토큰·설정)은 그대로
// shortcut: 기다리는 5분 동안 IPC 일꾼 하나를 잡고 있다 — 다른 긴 일이 함께 막히는 일이 보이면 따로 스레드로 돌리고 이벤트로 알린다
fn login(app: &AppHandle) -> io::Result<()> {
    let dr = d();
    let ((id, secret), source) = dr.client_and_source().ok_or_else(|| auth_err("Google 로그인 설정(연결 ID, 비밀번호)이 아직 없어요. 설정 Google Drive 동기화의 연결하기에서 안내서(DRIVE-SETUP)대로 만든 값을 넣어 주세요"))?;
    cancel_login();
    let verifier = b64url(&random(48));
    let challenge = {
        use sha2::Digest;
        b64url(&sha2::Sha256::digest(verifier.as_bytes()))
    };
    let state = b64url(&random(16));
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let cancel = Arc::new(AtomicBool::new(false));
    *dr.login_cancel.lock().unwrap() = Some(cancel.clone());
    let params = [
        ("client_id", id.as_str()),
        ("redirect_uri", &redirect),
        ("response_type", "code"),
        ("scope", FILE_SCOPE),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", &state),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ];
    let url = format!("{AUTH_URL}?{}", params.iter().map(|(k, v)| format!("{k}={}", q(v))).collect::<Vec<_>>().join("&"));
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url, None::<&str>).map_err(io::Error::other)?;
    }
    let started = Instant::now();
    let code = loop {
        if cancel.load(Ordering::SeqCst) {
            break Err(auth_err("로그인을 취소했어요"));
        }
        if started.elapsed() > LOGIN_TIMEOUT {
            break Err(auth_err("로그인을 기다리다 시간이 지났어요. 다시 해 주세요"));
        }
        let (mut stream, _) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => break Err(e),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        let _ = io::BufReader::new(&stream).read_line(&mut line);
        let query = query_of(&line).unwrap_or_default();
        let get = |k: &str| query.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let Some(got_state) = get("state") else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        };
        let ok = got_state == state && get("code").is_some();
        let body = page(ok);
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        break if got_state != state {
            Err(auth_err("로그인 확인 값이 맞지 않아요. 다시 해 주세요"))
        } else if let (true, Some(code)) = (ok, get("code")) {
            Ok(code)
        } else {
            let error = get("error").unwrap_or_default();
            Err(auth_err(if error == "access_denied" { "로그인을 취소했어요".into() } else { format!("로그인하지 못했어요 ({error})") }))
        };
    };
    {
        let mut pending = dr.login_cancel.lock().unwrap();
        if pending.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
            *pending = None;
        }
    }
    let code = code?;
    let form = [("code", code.as_str()), ("client_id", &id), ("client_secret", &secret), ("redirect_uri", &redirect), ("grant_type", "authorization_code"), ("code_verifier", &verifier)];
    let token = post(TOKEN_URL, &form).map_err(|e| invalid_client_help(e, source))?;
    let Some(refresh) = token["refresh_token"].as_str() else { return Err(auth_err("구글이 오래 쓸 수 있는 권한을 주지 않았어요. 다시 해 주세요")) };
    {
        let mut data = dr.data.lock().unwrap();
        data.insert("refreshToken".into(), refresh.into());
        data.insert("scope".into(), FILE_SCOPE.into());
        data.remove("useFullDriveScope"); // 예전 외부 앱 메모 연동 설정
        data.insert("tokenClient".into(), json!({ "id": id, "secret": secret }));
    }
    dr.scope_upgraded.store(false, Ordering::SeqCst);
    *dr.access.lock().unwrap() = (token["access_token"].as_str().unwrap_or_default().into(), now_ms() + token["expires_in"].as_i64().unwrap_or(3600) * 1000);
    dr.save()
}

fn cancel_login() {
    if let Some(c) = d().login_cancel.lock().unwrap().take() {
        c.store(true, Ordering::SeqCst);
    }
}

// ---------- 동기화 ----------

/// 맞출 Drive 폴더(id, 이름)와 이 PC 의 메모 폴더 — 둘 다 있어야 켜짐
fn config(app: &AppHandle) -> Option<(String, String, PathBuf)> {
    let st = app.state::<State>();
    let drive = st.setting("drive");
    let folder = drive["folderId"].as_str().filter(|s| !s.is_empty())?.to_string();
    let root = st.vault.lock().unwrap().as_ref()?.root.clone();
    Some((folder, drive["folderName"].as_str().unwrap_or_default().into(), root))
}

/// 메모킹이 Google Drive 와 메모 폴더를 맞추고 있나 (로그인했고 Drive 폴더를 골랐다) — 이 동안은 메모 폴더를 바꾸지 않는다
pub fn syncing_vault(app: &AppHandle) -> bool {
    d().connected() && config(app).is_some()
}

fn info(app: &AppHandle) -> Value {
    let st = app.state::<State>();
    let drive = st.setting("drive");
    // 메모 폴더를 읽는 중이면 기다리지 않고 설정의 경로로 (동기화 칸 · 설정 창이 멈추지 않게)
    let root = match st.vault.try_lock() {
        Ok(g) => g.as_ref().map(|v| v.root.to_string_lossy().into_owned()).unwrap_or_default(),
        Err(_) => st.setting("vaultPath").as_str().unwrap_or_default().to_string(),
    };
    let dr = d();
    json!({
        "configured": dr.client().is_some(),
        "connected": dr.connected(),
        "email": dr.email(),
        "active": config(app).is_some(),
        "folderId": drive["folderId"].as_str().unwrap_or_default(),
        "folderName": drive["folderName"].as_str().unwrap_or_default(),
        "root": root,
        "insideDriveApp": inside_drive_for_desktop(&root),
        "reconnect": dr.scope_upgraded.load(Ordering::SeqCst),
        "status": *dr.status.lock().unwrap(),
    })
}

fn publish(app: &AppHandle, patch: Value) {
    if let (Value::Object(s), Value::Object(p)) = (&mut *d().status.lock().unwrap(), patch) {
        s.extend(p);
    }
    let _ = app.emit_to("list", "drive:status", [info(app)]);
}

/// 동기화를 부탁한다 (delay 안에 또 부탁하면 한 번으로) — 메모를 고친 뒤 · 창을 다시 볼 때 · 연결이 바뀔 때
pub fn request(delay_ms: u64) {
    if let Some(dr) = DRIVE.get() {
        dr.sched.lock().unwrap().due = Some(Instant::now() + Duration::from_millis(delay_ms));
    }
}

/// 연결 · 메모 폴더가 바뀌었을 때 (drive-sync.js configure)
fn configure(app: &AppHandle) {
    let cfg = config(app);
    {
        let mut s = d().sched.lock().unwrap();
        s.config = format!("{cfg:?}");
        s.hold_until = Instant::now();
    }
    match cfg {
        None => publish(app, json!({ "state": "off", "error": "" })),
        // 메모 폴더가 Google Drive 데스크탑 앱이 맞추는 폴더 안이면 멈춘다 — 두 동기화가 서로 올리고 받으며 사본이 끝없이 늘 수 있다
        Some((_, _, root)) if inside_drive_for_desktop(&root.to_string_lossy()) => publish(app, json!({ "state": "error", "error": DOUBLE_SYNC })),
        Some(_) => {}
    }
    request(2000);
}

fn state_file(dir: &Path, folder_id: &str, root: &Path) -> PathBuf {
    // 같은 Drive 폴더라도 이 PC 의 다른 폴더와 맞추면 기준이 달라진다
    let key = b64url(root.to_string_lossy().as_bytes());
    dir.join("drive").join(format!("{folder_id}.{}.json", &key[key.len().saturating_sub(40)..]))
}

/// 지금 바로 맞춘다 — 이미 도는 중이면 끝난 뒤에. full: Drive 폴더를 처음부터 훑는다 ("지금 동기화" 단추)
fn run(app: &AppHandle, full: bool) -> Value {
    let dr = d();
    let running = dr.running.lock().unwrap();
    let stopped = run_once(app, full);
    drop(running);
    let mut s = dr.sched.lock().unwrap();
    s.hold_until = Instant::now() + if stopped { SAFETY_HOLD } else { Duration::ZERO };
    let delay = if Instant::now() < s.burst_until { POLL_BURST } else if s.focused { POLL_ACTIVE } else { POLL_IDLE };
    s.next_poll = Instant::now() + delay;
    drop(s);
    dr.status.lock().unwrap().clone()
}

/// → 안전장치로 멈췄나
fn run_once(app: &AppHandle, full: bool) -> bool {
    let dr = d();
    let Some((folder_id, folder_name, root)) = config(app) else { return false };
    if inside_drive_for_desktop(&root.to_string_lossy()) {
        publish(app, json!({ "state": "error", "error": DOUBLE_SYNC }));
        return false;
    }
    if !dr.connected() {
        publish(app, json!({ "state": "error", "error": "Google Drive에 로그인해 주세요" }));
        return false;
    }
    let file = state_file(&dr.dir, &folder_id, &root);
    let mut state: SyncState = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    // 권한이 Drive 전체 → drive.file 로 줄었으면 다른 앱이 넣은 파일이 목록에서 사라져 보인다 —
    //   "Drive 에서 지움" 으로 이 PC 의 메모를 지우지 않고 메모킹 파일로 다시 올린다 (한 번 다 끝낼 때까지)
    let scope = if dr.connected() && dr.get("scope") == FULL_SCOPE { "full" } else { "file" };
    if state.scope.as_deref() == Some("full") && scope == "file" {
        state.keep_missing = Some(true);
    }
    state.scope = Some(scope.into());
    publish(app, json!({ "state": "syncing", "changed": false, "conflicts": [], "progress": { "phase": "scan", "done": 0, "total": 0, "since": now_ms() } }));
    let last_sent = Mutex::new(Instant::now());
    let on_progress = |phase: &str, done: usize, total: usize| {
        let mut st = dr.status.lock().unwrap();
        let prev = st["progress"].clone();
        let since = if prev["phase"] != phase { now_ms() } else { prev["since"].as_i64().unwrap_or_else(now_ms) }; // 남은 시간은 단계마다 따로
        st["progress"] = json!({ "phase": phase, "done": done, "total": total, "since": since });
        drop(st);
        // 처음 · 마지막 · 단계가 바뀔 때는 바로, 그 사이는 가끔
        let mut last = last_sent.lock().unwrap();
        if done == 0 || done == total || prev["phase"] != phase || last.elapsed().as_millis() >= PROGRESS_MS {
            *last = Instant::now();
            let _ = app.emit_to("list", "drive:status", [info(app)]);
        }
    };
    let now = now_ms;
    let st = app.state::<State>();
    let locked = |f: &mut dyn FnMut()| {
        let _vault = st.vault.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        f();
    };
    let opts = drive_sync::Options { full, local_clean: false, conflict_tag: "PC 충돌", now: &now, on_progress: &on_progress, concurrency: drive_sync::CONCURRENCY, locked: &locked };
    // shortcut: 메모 폴더 지켜보기(fs.watch)가 없어 차례마다 이 PC 폴더를 훑는다 (local_clean 늘 false) — 파일이 수천 개라 느리면 notify 로 지켜본다
    let result = std::fs::create_dir_all(&root).and_then(|()| drive_sync::run(&root, &Api, &folder_id, &mut state, &opts));
    // 끝내지 못했어도 끝낸 파일들의 기준은 남긴다 (다음 차례는 남은 것만)
    let saved = serde_json::to_string(&state).map_err(io::Error::other).and_then(|t| {
        std::fs::create_dir_all(file.parent().unwrap())?;
        memoking_core::vault::write_atomic(&file, t.as_bytes())
    });
    match result.and_then(|r| saved.map(|()| r)) {
        Ok(r) => {
            let moved = r.uploaded + r.downloaded + r.deleted_local + r.deleted_remote;
            if moved > 0 {
                dr.sched.lock().unwrap().burst_until = Instant::now() + BURST_FOR;
            }
            if dr.email().is_empty() {
                if let Ok(email) = Api.about() {
                    dr.set_email(&email);
                }
            }
            publish(app, json!({ "state": "idle", "lastSync": now_ms(), "error": "", "changed": r.local_changed, "conflicts": r.conflicts, "progress": null, "moved": moved }));
            if r.local_changed {
                crate::memos::rescan(app);
            }
            crate::devices::write(app, &root, &folder_name, true, ""); // 기기 상태 파일 (다른 기기 · AI 가 본다)
            // PC 다리: Drive 데스크탑 앱 폴더에 다른 앱(Gemini 등)이 새로 만든 메모를 가져온다 (drive_bridge.rs)
            let known: std::collections::HashSet<String> = state.files.keys().cloned().collect();
            crate::drive_bridge::run(app, &Api, &folder_id, &folder_name, &known);
            false
        }
        Err(err) => {
            elog!("[Google Drive 동기화] {err}");
            crate::devices::write(app, &root, &folder_name, false, &err.to_string());
            publish(app, json!({ "state": "error", "progress": null, "error": err.to_string() }));
            drive_sync::is_safety_stop(&err)
        }
    }
}

/// 켤 때: 로그인 정보를 읽고, 메모를 고친 뒤 · 창을 다시 볼 때 · 주기적으로 맞추는 일꾼을 띄운다
pub fn start(app: &AppHandle) {
    let st = app.state::<State>();
    let dir = st.settings_dir.clone();
    let mut data = load_auth(&dir);
    let dr = DRIVE.get_or_init(|| Drive {
        dir: dir.clone(),
        data: Mutex::new(Map::new()),
        access: Mutex::new((String::new(), 0)),
        scope_upgraded: AtomicBool::new(false),
        login_cancel: Mutex::new(None),
        status: Mutex::new(json!({ "state": "off", "lastSync": 0, "error": "", "changed": false, "conflicts": [], "progress": null })),
        running: Mutex::new(()),
        sched: Mutex::new(Sched { due: None, next_poll: Instant::now(), burst_until: Instant::now(), last_focus: None, focused: false, config: String::new(), hold_until: Instant::now() }),
        folder_busy: Mutex::new(()),
    });
    // 범위 표시가 없는 아주 예전 연결만: 다시 연결하게 하고, 구글 쪽 예전 권한은 돌려준다
    let has_refresh = data.get("refreshToken").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    let scope = data.get("scope").and_then(Value::as_str).unwrap_or_default().to_string();
    let old = (has_refresh && scope != FILE_SCOPE && scope != FULL_SCOPE).then(|| data.remove("refreshToken"));
    if old.is_some() {
        data.remove("email");
    }
    *dr.data.lock().unwrap() = data;
    if let Some(Some(Value::String(t))) = old {
        dr.scope_upgraded.store(true, Ordering::SeqCst);
        let _ = dr.save();
        std::thread::spawn(move || post(REVOKE_URL, &[("token", &t)]));
        if !st.setting("drive").is_null() {
            st.set_setting("drive", Value::Null);
        }
    }
    // 예전 연결(로그인한 클라이언트를 적어 두지 않은 것): 지금 쓸 수 있는 클라이언트가 그 클라이언트 — 기억해 둔다
    if dr.connected() && dr.get("tokenClient")["id"].as_str().is_none() {
        if let Some((id, secret)) = dr.client() {
            dr.data.lock().unwrap().insert("tokenClient".into(), json!({ "id": id, "secret": secret }));
            let _ = dr.save();
        }
    }
    // 예전(v0.41)의 Google 캘린더 상호 동기화 로그인은 지운다
    let _ = std::fs::remove_file(dir.join("google-calendar-auth.json"));
    configure(app);

    // shortcut: 1초마다 살핀다 (Electron 은 타이머 · 창 포커스 이벤트) — 부탁한 때보다 1초까지 늦을 수 있다
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if d().sched.lock().unwrap().config != format!("{:?}", config(&app)) {
            configure(&app); // 메모 폴더를 바꿨다
        }
        // 메모킹 창을 쓰는 중이면 10초마다, 창을 다시 볼 때 바로 (창을 떠나 있던 사이 탐색기에서 고쳤을 수 있다)
        let focused = app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
        let go = {
            let mut s = d().sched.lock().unwrap();
            let now = Instant::now();
            if focused && !s.focused && s.last_focus.is_none_or(|t| now - t >= FOCUS_GAP) {
                s.last_focus = Some(now);
                s.due = Some(now + Duration::from_millis(300));
            }
            s.focused = focused;
            if now >= s.next_poll {
                s.next_poll = now + if now < s.burst_until { POLL_BURST } else if focused { POLL_ACTIVE } else { POLL_IDLE };
                s.due.get_or_insert(now);
            }
            let go = s.due.is_some_and(|t| now >= t) && now >= s.hold_until;
            if go {
                s.due = None;
            }
            go
        };
        if go && d().connected() && config(&app).is_some() {
            run(&app, false);
        }
    });
}

/// 같은 이름 폴더가 이미 있으면 그것 (새로 만들지 않는다) — 한 번에 하나만
fn find_or_create_folder(parent: &str, name: &str) -> io::Result<(RemoteItem, bool)> {
    static MAKING: Mutex<()> = Mutex::new(());
    let _one = MAKING.lock().unwrap();
    if let Some(found) = Api.find_folders(name, parent)?.into_iter().next() {
        return Ok((found, true));
    }
    Ok((drive_sync::Remote::create_folder(&Api, parent, name)?, false))
}

/// Drive 폴더를 고른다. 메모킹이 Drive 와 맞추는 동안 메모 폴더는 늘 문서\메모킹 — 다른 곳(Google Drive 데스크탑 앱의 G: · OneDrive 폴더 등)이면
///   그 메모를 복사해 옮겨 맞춘다 (원래 폴더는 그대로). 두 동기화가 한 폴더를 함께 맞추면 휴대폰에서 메모가 사라졌다
fn switch_folder(app: &AppHandle, folder_id: &str, folder_name: &str) -> Value {
    let st = app.state::<State>();
    let current = st.vault.lock().unwrap().as_ref().map(|v| v.root.clone());
    let root = State::suggested_vault(app);
    let moving = current.as_ref() != Some(&root);
    if moving {
        // 옮기기 전에 쓰던 글부터 저장하고 메모 창을 닫는다 (마지막 글이 옛 폴더에만 남지 않게)
        // shortcut: Electron 처럼 저장이 끝나기를 기다리지 않고 0.5초 둔다 (memos.rs resolve_conflict 와 같게)
        let labels: Vec<String> = st.note_labels.lock().unwrap().values().cloned().collect();
        for w in labels.iter().filter_map(|l| app.get_webview_window(l)) {
            let _ = w.eval("window.mkFlushSync?.()");
        }
        std::thread::sleep(Duration::from_millis(500));
        for w in labels.iter().filter_map(|l| app.get_webview_window(l)) {
            let _ = w.close();
        }
        let until = Instant::now() + Duration::from_secs(3);
        while !st.note_labels.lock().unwrap().is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(from) = &current {
            drive_sync::copy_vault(from, &root);
        }
    }
    st.set_setting("drive", json!({ "folderId": folder_id, "folderName": folder_name }));
    crate::files::ensure_auto_start(app); // PC 가 켜져 있는 동안 늘 맞추게 (받은 메모 · PC 다리)
    if moving {
        st.open_vault(app, root);
        crate::memos::push_list(app);
    }
    configure(app);
    let status = run(app, false);
    json!({ "info": st.vault_info(app), "status": status, "drive": info(app) })
}

pub fn handle(app: &AppHandle, _label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let dr = d();
    let err = |e: io::Error| e.to_string();
    Some(match channel {
        "drive:status" => Ok(info(app)),
        "drive:set-client" => {
            {
                let mut data = dr.data.lock().unwrap();
                data.insert("clientId".into(), arg_str(args, 0).trim().into());
                data.insert("clientSecret".into(), arg_str(args, 1).trim().into());
            }
            dr.save().map(|()| info(app)).map_err(err)
        }
        "drive:login" => login(app).map_err(err).map(|()| {
            let email = Api.about().unwrap_or_default();
            if !email.is_empty() {
                dr.set_email(&email);
            }
            crate::os::show_list(app);
            json!({ "email": email })
        }),
        "drive:cancel-login" => {
            cancel_login();
            Ok(Value::Null)
        }
        "drive:folders" => {
            let parent = Some(arg_str(args, 0)).filter(|p| !p.is_empty()).unwrap_or("root".into());
            Api.folders(&parent).map(|list| list.into_iter().map(|f| json!({ "id": f.id, "name": f.name, "created": f.created })).collect()).map_err(err)
        }
        // 같은 이름 폴더가 이미 있으면 새로 만들지 않고 그것을 돌려준다 (existed: true)
        "drive:create-folder" => {
            let parent = Some(arg_str(args, 0)).filter(|p| !p.is_empty()).unwrap_or("root".into());
            find_or_create_folder(&parent, arg_str(args, 1).trim()).map(|(f, existed)| json!({ "id": f.id, "name": f.name, "created": f.created, "existed": existed })).map_err(err)
        }
        "drive:use" => {
            let _one = dr.folder_busy.lock().unwrap();
            Ok(switch_folder(app, &arg_str(args, 0), &arg_str(args, 1)))
        }
        // 내 드라이브의 "메모킹 동기화" 를 찾거나 만들어 맞춘다 — 같은 이름이 여럿이면 늘 가장 먼저 만든 것 (PC · 휴대폰이 같은 폴더를 고르게)
        "drive:auto" => {
            let _one = dr.folder_busy.lock().unwrap();
            find_or_create_folder("root", "메모킹 동기화").map(|(f, _)| switch_folder(app, &f.id, &f.name)).map_err(err)
        }
        // 단추: 다른 앱이 넣은 파일까지 보이게 폴더를 처음부터
        "drive:sync" => Ok(run(app, true)),
        // 설정의 Google Drive 칸: 이 Drive 폴더를 맞추는 기기들 (기기 상태 파일)
        "drive:devices" => Ok(config(app).map_or(json!([]), |(_, _, root)| crate::devices::list(app, &root))),
        "drive:disconnect" => {
            dr.sign_out();
            app.state::<State>().set_setting("drive", Value::Null);
            configure(app);
            Ok(info(app))
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_redirect_query() {
        let q = query_of("GET /?state=ab-c&code=4%2F0Ad&scope=a+b HTTP/1.1\r\n").unwrap();
        assert_eq!(q, vec![("state".into(), "ab-c".into()), ("code".into(), "4/0Ad".into()), ("scope".into(), "a b".into())]);
        assert!(query_of("GET /favicon.ico HTTP/1.1").is_none());
    }

    #[test]
    fn state_file_matches_electron() {
        // Buffer.from(path.resolve(root)).toString('base64url').slice(-40)
        let f = state_file(Path::new("/s"), "F1", Path::new(r"C:\Users\someone\Documents\메모킹"));
        assert_eq!(f, Path::new("/s/drive/F1.cnNcc29tZW9uZVxEb2N1bWVudHNc66mU66qo7YK5.json"));
    }
}
