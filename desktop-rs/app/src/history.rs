// 알림 보관함 (갤럭시 NotiStar 처럼) — Windows 알림 센터에서 지워져도 기록을 남긴다. Electron 의 notification-history.js · popup-watch.js · main.js 의 그 부분.
//   Windows 는 알림 센터의 알림을 wpndatabase.db(SQLite)에 두다가 지우면 없앤다 — 15초마다 그 파일의 "복사본"을 읽어 새 토스트를 기록한다.
//   알림 센터를 쓰지 않는 앱(카카오톡 PC)은 PowerShell 도우미(scripts/popup-watch.ps1)가 알림 창을 읽어 한 줄(JSON)씩 보낸다.
//   기록은 이 PC 에만 (설정 폴더\notification-history) — 메모 폴더(Google Drive)로 동기화하지 않는다.
use crate::state::State;
use memoking_core::notify;
use memoking_core::vault::write_atomic;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

const MAX_ENTRIES: usize = 10_000;
const MAX_IMAGE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Default)]
pub struct History {
    dir: PathBuf,
    last_arrival: i64,
    entries: Vec<Value>,
    /// 앱 id(소문자) → 시작 메뉴의 앱 이름
    app_names: HashMap<String, String>,
    /// 알림 DB 의 (파일 시각:크기) — 그대로면 다시 복사하지 않는다
    last_sig: String,
    /// 방금 넣은 팝업 알림 (같은 알림을 두 번 넣지 않게, 5분)
    recent: Vec<Value>,
}

static ON: AtomicBool = AtomicBool::new(false);
static WATCHER: Mutex<Option<Child>> = Mutex::new(None);

fn st(app: &AppHandle) -> tauri::State<'_, State> {
    app.state::<State>()
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn time_ms(e: &Value) -> f64 {
    e["time"].as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map_or(f64::NAN, |t| t.timestamp_millis() as f64)
}

/// PowerShell 도우미를 띄우는 규칙 (desktop/powershell.js) — 프로필을 읽지 않고 · 묻지 않고 · 스크립트 허용,
///   작업 폴더는 임시 폴더(설치 폴더를 물려받으면 업데이트 때 지우지 못한다) · 창은 숨김
pub fn powershell(sta: bool) -> Command {
    let mut c = Command::new("powershell.exe");
    if sta {
        c.arg("-STA");
    }
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]).current_dir(std::env::temp_dir());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

impl History {
    fn file(&self) -> PathBuf {
        self.dir.join("history.json")
    }

    fn image_dir(&self) -> PathBuf {
        self.dir.join("images")
    }

    fn save(&self) {
        let text = json!({ "lastArrival": self.last_arrival.to_string(), "entries": self.entries }).to_string();
        let _ = std::fs::create_dir_all(&self.dir);
        // 디스크가 가득 참 등 — 다음 알림 때 다시 쓴다
        if let Err(err) = write_atomic(&self.file(), text.as_bytes()) {
            eprintln!("[알림 보관함] {err}");
        }
    }

    fn remove_image(&self, e: &Value) {
        if let Some(name) = e["image"].as_str() {
            let _ = std::fs::remove_file(self.image_dir().join(name));
        }
    }

    /// 기록 하나 넣기 (막은 앱 · 이미 있는 id 는 None). 저장 · 알리기는 부른 쪽이
    fn add(&mut self, blocked: &Map<String, Value>, entry: Value) -> Option<Value> {
        let s = |k: &str| entry[k].as_str().map(str::to_string);
        let app_id = s("appId").unwrap_or_default();
        let id = s("id").unwrap_or_else(|| format!("{}{:06x}", radix36(now_ms() as u64), rand24()));
        let mut item = json!({
            "id": id,
            "source": s("source").unwrap_or("windows".into()),
            "appId": app_id,
            "app": s("app").unwrap_or_else(|| notify::fallback_app_name(&app_id)),
            "title": s("title").unwrap_or_default(),
            "body": s("body").unwrap_or_default(),
            "time": s("time").unwrap_or_else(|| iso(now_ms() as i64)),
            "image": entry["image"],
            "memoId": entry["memoId"],
        });
        if let Some(via) = s("via").filter(|v| !v.is_empty()) {
            item["via"] = via.into(); // 팝업 알림을 읽은 방법: uia · msaa · win32(글자 그대로) / ocr(그림 글자 인식)
        }
        if (blocked.contains_key(&app_id) && item["source"] != "memoking") || self.entries.iter().any(|e| e["id"] == item["id"]) {
            return None;
        }
        self.entries.insert(0, item.clone());
        self.entries.sort_by(|a, b| time_ms(b).total_cmp(&time_ms(a)));
        for old in self.entries.split_off(self.entries.len().min(MAX_ENTRIES)) {
            self.remove_image(&old);
        }
        Some(item)
    }

    fn list(&self, query: &str, app: &str) -> Vec<&Value> {
        self.entries.iter().filter(|e| (app.is_empty() || e["app"] == app) && notify::matches_query(e, query)).collect()
    }

    // 앱별 개수 (거르기 단추용, 많은 순)
    fn apps(&self) -> Value {
        let mut counts: Vec<(Value, u64)> = Vec::new();
        for e in &self.entries {
            match counts.iter_mut().find(|c| c.0 == e["app"]) {
                Some(c) => c.1 += 1,
                None => counts.push((e["app"].clone(), 1)),
            }
        }
        counts.sort_by_key(|c| std::cmp::Reverse(c.1));
        counts.into_iter().map(|(name, count)| json!({ "name": name, "count": count })).collect()
    }

    fn remove(&mut self, id: &str) -> bool {
        let Some(i) = self.entries.iter().position(|e| e["id"] == id) else { return false };
        let e = self.entries.remove(i);
        self.remove_image(&e);
        true
    }

    /// 알림의 그림(보낸 사람 사진 등)은 임시 폴더에 있다가 사라지므로 복사해 둔다 → images/ 안의 이름
    fn keep_image(&self, src: &str) -> Option<String> {
        let low = src.to_ascii_lowercase();
        let rest = if low.starts_with("file:///") { &src[8..] } else if low.starts_with("file://") { &src[7..] } else { src };
        let file = PathBuf::from(rest.replace('/', std::path::MAIN_SEPARATOR_STR));
        let meta = std::fs::metadata(&file).ok().filter(|m| file.is_absolute() && m.is_file() && m.len() <= MAX_IMAGE_BYTES)?;
        let data = std::fs::read(&file).ok().filter(|d| d.len() as u64 == meta.len())?;
        let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).filter(|e| ["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico"].contains(&e.as_str())).unwrap_or("png".into());
        use sha2::Digest;
        let hash: String = sha2::Sha256::digest(&data).iter().take(8).map(|b| format!("{b:02x}")).collect();
        let name = format!("{hash}.{ext}");
        let dest = self.image_dir().join(&name);
        let _ = std::fs::create_dir_all(self.image_dir());
        if !dest.exists() {
            std::fs::write(&dest, data).ok()?;
        }
        Some(name)
    }

    fn app_name(&self, app_id: &str) -> String {
        self.app_names.get(&app_id.to_lowercase()).cloned().unwrap_or_else(|| notify::fallback_app_name(app_id))
    }

    /// 알림 DB 복사본에서 지난번 이후 새 토스트 → 넣은 개수
    fn read_copy(&mut self, file: &Path, self_id: &str, blocked: &Map<String, Value>) -> rusqlite::Result<usize> {
        let db = rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut stmt = db.prepare(
            "select n.Id, n.Payload, n.ArrivalTime, h.PrimaryId from Notification n join NotificationHandler h on h.RecordId = n.HandlerId
             where n.ArrivalTime > ? and n.Type in ('toast', 'toastCondensed') order by n.ArrivalTime asc",
        )?;
        let rows: Vec<(i64, Vec<u8>, i64, String)> = stmt
            .query_map([self.last_arrival], |r| Ok((r.get(0)?, r.get::<_, Option<Vec<u8>>>(1)?.unwrap_or_default(), r.get(2)?, r.get::<_, Option<String>>(3)?.unwrap_or_default())))?
            .collect::<Result<_, _>>()?;
        let mut added = 0;
        for (id, payload, arrival, app_id) in rows {
            self.last_arrival = self.last_arrival.max(arrival);
            if app_id.eq_ignore_ascii_case(self_id) {
                continue; // 메모킹 자신은 따로 기록
            }
            let Some(toast) = notify::parse_toast_xml(&String::from_utf8_lossy(&payload)) else { continue };
            let image = toast["image"].as_str().and_then(|s| self.keep_image(s));
            let entry = json!({
                "id": format!("w{id}-{arrival}"),
                "source": "windows",
                "appId": app_id,
                "app": self.app_name(&app_id),
                "title": toast["title"],
                "body": toast["body"],
                "time": iso(notify::file_time_to_ms(arrival)),
                "image": image,
            });
            added += usize::from(self.add(blocked, entry).is_some());
        }
        Ok(added)
    }
}

fn radix36(mut n: u64) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

// 기록 id 의 뒤 3바이트 (같은 밀리초에 둘이 와도 다르게) — 표준 라이브러리의 무작위 해시 열쇠를 빌린다
fn rand24() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new().build_hasher().finish() & 0xff_ffff
}

fn blocked(app: &AppHandle) -> Map<String, Value> {
    st(app).setting("historyBlocked").as_object().cloned().unwrap_or_default()
}

fn changed(app: &AppHandle) {
    let _ = app.emit_to("list", "history:changed", ());
}

/// 보관함을 바꾸는 일 — 바꿨으면(true) 저장하고 목록에 알린다
fn update<T>(app: &AppHandle, f: impl FnOnce(&mut History, &Map<String, Value>) -> (T, bool)) -> T {
    let blocked = blocked(app);
    let h = app.state::<Mutex<History>>();
    let mut h = h.lock().unwrap();
    let (r, dirty) = f(&mut h, &blocked);
    if dirty {
        h.save();
        drop(h);
        changed(app);
    }
    r
}

/// 켤 때: 기록을 읽고, 켜 둔 사람이면 모으기 시작
pub fn start(app: &AppHandle) {
    let dir = st(app).settings_dir.join("notification-history");
    let mut h = History { dir, ..Default::default() };
    if let Ok(Value::Object(data)) = std::fs::read_to_string(h.file()).map(|t| serde_json::from_str(&t).unwrap_or_default()) {
        if let Some(entries) = data.get("entries").and_then(Value::as_array) {
            h.entries = entries.clone();
            h.last_arrival = memoking_core::js::string(&data["lastArrival"]).parse().unwrap_or(0);
        }
    }
    app.manage(Mutex::new(h));
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut names = false;
        loop {
            if ON.load(Ordering::SeqCst) {
                if !names {
                    names = true;
                    load_app_names(&app2);
                }
                poll(&app2);
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
    set_on(app, st(app).setting("historyEnabled") == true);
}

fn set_on(app: &AppHandle, on: bool) {
    // 점검(--smoke) 때는 진짜 알림을 모으지 않는다
    let on = on && !crate::ipc::smoke();
    if ON.swap(on, Ordering::SeqCst) == on {
        return;
    }
    if on {
        let app = app.clone();
        std::thread::spawn(move || {
            poll(&app);
            watch_popups(&app);
        });
    } else if let Some(mut c) = WATCHER.lock().unwrap().take() {
        let _ = c.kill();
    }
}

// 시작 메뉴의 앱 이름 (앱 id → "카카오톡" 등). 한 번만 불러 두고, 이름을 몰랐던 기록도 고친다
fn load_app_names(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | ForEach-Object { \"$($_.AppID)`t$($_.Name)\" }";
    let Ok(out) = powershell(false).args(["-Command", script]).stderr(Stdio::null()).output() else { return };
    update(app, |h, _| {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some((id, name)) = line.split_once('\t').filter(|(i, n)| !i.trim().is_empty() && !n.trim().is_empty()) {
                h.app_names.insert(id.trim().to_lowercase(), name.trim().to_string());
            }
        }
        let mut fixed = false;
        for i in 0..h.entries.len() {
            if let Some(name) = h.entries[i]["appId"].as_str().and_then(|id| h.app_names.get(&id.to_lowercase())).cloned() {
                fixed |= h.entries[i]["app"] != name.as_str();
                h.entries[i]["app"] = name.into();
            }
        }
        ((), fixed)
    });
}

// 알림 DB 복사본에서 지난번 이후 새 토스트를 읽는다 (원본은 건드리지 않음)
fn poll(app: &AppHandle) {
    let Some(src) = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Microsoft").join("Windows").join("Notifications")) else { return };
    if !src.join("wpndatabase.db").exists() {
        return;
    }
    let self_id = app.config().identifier.clone();
    // 알림 DB(와 쓰기 기록 -wal)가 지난번 그대로면 복사하지 않는다 — 알림이 많은 PC 는 수십 MB
    let sig = ["wpndatabase.db", "wpndatabase.db-wal"]
        .map(|n| std::fs::metadata(src.join(n)).map_or("-".into(), |m| format!("{:?}:{}", m.modified().ok(), m.len())))
        .join("|");
    update(app, |h, blocked| {
        if sig == h.last_sig {
            return ((), false);
        }
        let tmp = std::env::temp_dir().join(format!("memoking-wpn-{}-{}", std::process::id(), rand24()));
        let r = std::fs::create_dir_all(&tmp).map_err(|e| e.to_string()).and_then(|()| {
            for name in ["wpndatabase.db", "wpndatabase.db-wal", "wpndatabase.db-shm"] {
                if src.join(name).exists() {
                    std::fs::copy(src.join(name), tmp.join(name)).map_err(|e| e.to_string())?;
                }
            }
            h.read_copy(&tmp.join("wpndatabase.db"), &self_id, blocked).map_err(|e| e.to_string())
        });
        let _ = std::fs::remove_dir_all(&tmp);
        match r {
            Ok(added) => {
                h.last_sig = sig; // 다 읽은 뒤에만 (읽다 실패하면 다음에 다시)
                h.save(); // 읽은 자리(lastArrival)는 새 알림이 없어도
                ((), added > 0)
            }
            Err(err) => {
                eprintln!("[알림 보관함] {err}");
                ((), false)
            }
        }
    });
}

// ---------- 팝업 알림 지켜보기 ----------

fn popup_dir() -> PathBuf {
    std::env::temp_dir().join("memoking-popups")
}

// 도우미를 띄워 두고 한 줄씩 읽는다. 멈추면 잠시 뒤 다시 (끄는 중이 아니면)
fn watch_popups(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let script = st(app).settings_dir.join("popup-watch.ps1");
    let _ = std::fs::create_dir_all(popup_dir());
    let _ = std::fs::write(&script, include_str!("../../../scripts/popup-watch.ps1"));
    let log = st(app).settings_dir.join("popup-debug.log");
    let processes = notify::POPUP_APPS.map(|a| a.0).join(",");
    while ON.load(Ordering::SeqCst) {
        let child = powershell(true)
            .arg("-File")
            .arg(&script)
            .arg("-Dir")
            .arg(popup_dir())
            .args(["-Processes", &processes, "-Log"])
            .arg(&log)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn();
        // PowerShell 을 띄우지 못하면(보안 프로그램이 막음 등) 적고 잠시 뒤 다시
        match child {
            Err(err) => eprintln!("[팝업 알림] {err}"),
            Ok(mut c) => {
                let out = c.stdout.take().unwrap();
                *WATCHER.lock().unwrap() = Some(c);
                for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                    match serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')) {
                        Ok(msg) if msg["error"].is_string() => eprintln!("[팝업 알림] {}", msg["error"]),
                        Ok(msg) if msg.is_object() => add_popup(app, msg),
                        _ => {}
                    }
                }
                if let Some(mut c) = WATCHER.lock().unwrap().take() {
                    let _ = c.wait();
                }
            }
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

// 도우미가 알려 준 파일 — 팝업 폴더 안의 파일만 믿는다
fn popup_file(v: &Value) -> Option<PathBuf> {
    let p = PathBuf::from(v.as_str()?);
    (p.parent() == Some(popup_dir().as_path()) && p.is_file()).then_some(p)
}

// 읽은 알림 창 하나를 보관함에 (main.js addPopupToHistory)
fn add_popup(app: &AppHandle, mut p: Value) {
    let files: Vec<PathBuf> = ["image", "ocrImage", "verifyImage"].iter().filter_map(|k| popup_file(&p[*k])).collect();
    let process = p["process"].as_str().map(str::to_string);
    let app_name = notify::popup_app_name(process.as_deref());
    if let Some(l) = p["lines"].as_str().map(str::to_string) {
        p["lines"] = json!([l]);
    }
    let via = p["via"].as_str().unwrap_or_default().to_string();
    // shortcut: Electron 은 그림 글자 인식(ocr)한 알림 창을 숨은 창의 한글 OCR 로 다시 읽었다 — 여기서는 도우미가 Windows OCR 로 읽은 글 그대로. 오타가 많다는 말이 나오면 OCR 창을 옮긴다
    let by_layout = match (&p["boxes"], process.as_deref(), via.as_str()) {
        (Value::Array(boxes), Some("KakaoTalk"), "ocr") => {
            notify::kakao_entry(boxes, p["size"]["w"].as_f64().unwrap_or(0.0), p["size"]["h"].as_f64().unwrap_or(0.0), &app_name, memoking_core::js::number(&p["profileTop"]).max(0.0))
        }
        _ => None,
    };
    let lines = p["lines"].as_array().cloned().unwrap_or_default();
    let image = popup_file(&p["image"]);
    if let Some(mut entry) = by_layout.or_else(|| notify::popup_to_entry(&lines, &app_name)) {
        update(app, |h, blocked| {
            let title = entry["title"].as_str().unwrap_or_default().to_string();
            // 글자 인식으로 읽었는데 보낸 사람에 글자가 하나도 없으면(검은 그림을 '222' 처럼 읽음) 알림이 아니다
            if via == "ocr" && !title.chars().any(char::is_alphabetic) {
                return ((), false);
            }
            // 글자 인식으로 읽은 이름은 이미 받은 이름과 한 글자만 다르면 그 이름으로
            if via == "ocr" {
                let known = notify::known_names(h.entries.iter().filter(|e| e["app"] == app_name.as_str() && e["source"] == "popup").take(500).filter_map(|e| e["title"].as_str()));
                entry["title"] = notify::correct_title(&title, &known).into();
            }
            let now = now_ms();
            h.recent.retain(|r| now - r["at"].as_f64().unwrap_or(0.0) <= 5.0 * 60.0 * 1000.0);
            let probe = json!({ "app": app_name, "hwnd": p["hwnd"], "title": entry["title"], "body": entry["body"] });
            // 같은 앱이 Windows 알림 센터에도 같은 알림을 남겼으면(그쪽 글이 정확하다) 알림 창 것은 넣지 않는다
            let toasts: Vec<Value> = h
                .entries
                .iter()
                .filter(|e| {
                    let mine = e["app"] == app_name.as_str() || process.as_ref().is_some_and(|pr| e["appId"].as_str().unwrap_or_default().to_lowercase().contains(&pr.to_lowercase()));
                    e["source"] == "windows" && now - time_ms(e) < 2.0 * 60.0 * 1000.0 && mine
                })
                .map(|e| json!({ "app": app_name, "title": e["title"], "body": e["body"], "at": time_ms(e) }))
                .collect();
            if notify::find_repeat(&toasts, &probe, now, 120_000.0).is_some() {
                return ((), false);
            }
            // 같은 알림을 또 읽었으면 넣지 않는다 — 다만 앞의 것은 그림 글자 인식, 이번 것은 글 그대로 읽었으면 이번 것으로
            let prev = notify::find_repeat(&h.recent, &probe, now, 120_000.0);
            if prev.is_some_and(|i| !notify::better_reading(&h.recent[i], &json!({ "via": via }))) {
                return ((), false);
            }
            if let Some(i) = prev {
                let r = h.recent.remove(i);
                if let Some(id) = r["id"].as_str() {
                    h.remove(id);
                }
            }
            let image = image.as_ref().and_then(|f| h.keep_image(&f.to_string_lossy()));
            let item = h.add(blocked, json!({ "source": "popup", "appId": process, "app": app_name, "title": entry["title"], "body": entry["body"], "image": image, "via": via }));
            h.recent.push(json!({ "app": app_name, "hwnd": p["hwnd"], "title": entry["title"], "body": entry["body"], "via": via, "id": item.as_ref().map(|i| i["id"].clone()), "at": now }));
            ((), true)
        });
    }
    for f in files {
        let _ = std::fs::remove_file(f);
    }
}

/// memoking://localhost/history/<이름> — 보관함의 그림
pub fn serve_image(app: &AppHandle, name: &str) -> Option<(Vec<u8>, &'static str)> {
    let name = crate::percent_decode(name);
    let name = Path::new(&name).file_name()?.to_string_lossy().into_owned();
    let file = app.state::<Mutex<History>>().lock().unwrap().image_dir().join(&name);
    let mime = match name.rsplit('.').next().unwrap_or_default() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        _ => "image/png",
    };
    Some((std::fs::read(file).ok()?, mime))
}

// 알림 → 메모. 팝업 알림은 알림 창 사진, Windows 알림은 들어 있는 그림 (작은 앱 아이콘 100px 아래는 넣지 않는다)
fn to_memo(app: &AppHandle, id: &str) -> Result<Value, String> {
    let (e, file) = {
        let h = app.state::<Mutex<History>>();
        let h = h.lock().unwrap();
        let Some(e) = h.entries.iter().find(|e| e["id"] == id).cloned() else { return Ok(Value::Null) };
        let file = e["image"].as_str().map(|n| h.image_dir().join(n)).filter(|f| f.is_file());
        (e, file)
    };
    let state = st(app);
    let id = {
        let mut guard = state.vault.lock().unwrap();
        let Some(v) = guard.as_mut() else { return Ok(Value::Null) };
        let pic = file.filter(|f| e["source"] == "popup" || image::image_dimensions(f).is_ok_and(|d| d.0 >= 100)).and_then(|f| {
            let ext = f.extension().map(|x| x.to_string_lossy().into_owned()).unwrap_or("png".into());
            std::fs::read(&f).ok().and_then(|b| v.save_attachment(&b, &ext).ok())
        });
        let s = |k: &str| e[k].as_str().unwrap_or_default().to_string();
        let when = chrono::DateTime::parse_from_rfc3339(&s("time")).map(|t| ko_locale(t.with_timezone(&chrono::Local))).unwrap_or_default();
        let title = if s("title").is_empty() { s("app") } else { s("title") };
        let body = if s("body").is_empty() { String::new() } else { format!("{}\n\n", s("body")) };
        let pic = pic.map(|p| format!("![]({p})\n\n")).unwrap_or_default();
        v.import(&format!("# {title}\n\n{body}{pic}> {} 알림, {when}", s("app")), None).map_err(|e| e.to_string())?
    };
    let Some(id) = id else { return Ok(Value::Null) };
    crate::memos::open_note(app, &id)?;
    Ok(id.into())
}

/// new Date().toLocaleString('ko-KR') — "2026. 11. 17. 오후 3:05:09"
fn ko_locale(t: chrono::DateTime<chrono::Local>) -> String {
    use chrono::Timelike;
    let (pm, h) = t.hour12();
    format!("{} {}{h}:{}", t.format("%Y. %-m. %-d."), if pm { "오후 " } else { "오전 " }, t.format("%M:%S"))
}

pub fn handle(app: &AppHandle, _label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let arg = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default().to_string();
    Some(Ok(match channel {
        "history:list" => {
            let f = args.first().cloned().unwrap_or_default();
            let h = app.state::<Mutex<History>>();
            let h = h.lock().unwrap();
            let entries: Vec<&Value> = h.list(f["query"].as_str().unwrap_or_default(), f["app"].as_str().unwrap_or_default()).into_iter().take(500).collect();
            json!({ "enabled": st(app).setting("historyEnabled") == true, "total": h.entries.len(), "apps": h.apps(), "entries": entries })
        }
        "history:set-enabled" => {
            let on = crate::settings::truthy(args.first());
            st(app).set_setting("historyEnabled", on.into());
            set_on(app, on);
            on.into()
        }
        "history:remove" => update(app, |h, _| {
            let r = h.remove(&arg(0));
            (r, r)
        })
        .into(),
        "history:clear" => update(app, |h, _| {
            h.entries.clear();
            let _ = std::fs::remove_dir_all(h.image_dir());
            (Value::Null, true)
        }),
        "history:to-memo" => return Some(to_memo(app, &arg(0))),
        "history:apps" => {
            // 앱 id 별 이름 · 개수 (많은 순, 메모킹 자신 빼고) + 막아 둔 앱
            let blocked = blocked(app);
            let h = app.state::<Mutex<History>>();
            let mut apps: Vec<Value> = Vec::new();
            for e in h.lock().unwrap().entries.iter().filter(|e| e["source"] != "memoking") {
                match apps.iter_mut().find(|a| a["appId"] == e["appId"]) {
                    Some(a) => a["count"] = (a["count"].as_u64().unwrap_or(0) + 1).into(),
                    None => apps.push(json!({ "appId": e["appId"], "app": e["app"], "count": 1, "blocked": blocked.contains_key(e["appId"].as_str().unwrap_or_default()) })),
                }
            }
            apps.sort_by_key(|a| std::cmp::Reverse(a["count"].as_u64()));
            for (id, name) in &blocked {
                if !apps.iter().any(|a| a["appId"] == id.as_str()) {
                    apps.push(json!({ "appId": id, "app": name, "count": 0, "blocked": true }));
                }
            }
            apps.into()
        }
        "history:block" => {
            let (id, name) = (args.first().filter(|v| !v.is_null()).map(memoking_core::js::string).unwrap_or_default(), arg(1));
            if id.is_empty() {
                return Some(Ok(0.into()));
            }
            let mut b = blocked(app);
            b.insert(id.clone(), if name.is_empty() { id.clone() } else { name }.into());
            st(app).set_setting("historyBlocked", b.into());
            if !crate::settings::truthy(args.get(2)) {
                return Some(Ok(0.into()));
            }
            // 이 앱의 알림을 모두 지운다 (메모킹 자신의 알림은 남김)
            update(app, |h, _| {
                let before = h.entries.len();
                let (gone, keep): (Vec<Value>, Vec<Value>) = std::mem::take(&mut h.entries).into_iter().partition(|e| e["appId"] == id.as_str() && e["source"] != "memoking");
                gone.iter().for_each(|e| h.remove_image(e));
                h.entries = keep;
                (before - h.entries.len(), !gone.is_empty())
            })
            .into()
        }
        "history:unblock" => {
            let mut b = blocked(app);
            b.remove(&arg(0));
            st(app).set_setting("historyBlocked", b.into());
            changed(app);
            Value::Null
        }
        _ => return None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_new_toasts_from_the_notification_db() {
        let dir = std::env::temp_dir().join(format!("memoking-history-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("wpn.db");
        let db = rusqlite::Connection::open(&file).unwrap();
        db.execute_batch(
            "create table NotificationHandler (RecordId integer, PrimaryId text);
             create table Notification (Id integer, HandlerId integer, Type text, Payload blob, ArrivalTime integer);
             insert into NotificationHandler values (1, 'Microsoft.Teams_8wekyb3d8bbwe!MSTeams'), (2, 'com.memoking.desktop');
             insert into Notification values (10, 1, 'toast', cast('<toast><text>김대리</text><text>회의 &amp; 점심</text></toast>' as blob), 133000000000000000),
               (11, 2, 'toast', cast('<toast><text>메모킹</text></toast>' as blob), 133000000000000001),
               (12, 1, 'tile', cast('<tile><text>x</text></tile>' as blob), 133000000000000002);",
        )
        .unwrap();
        drop(db);
        let mut h = History { dir: dir.clone(), ..Default::default() };
        assert_eq!(h.read_copy(&file, "com.memoking.desktop", &Map::new()).unwrap(), 1);
        assert_eq!(h.last_arrival, 133000000000000001);
        let e = &h.entries[0];
        assert_eq!((e["id"].as_str(), e["app"].as_str(), e["title"].as_str(), e["body"].as_str()), (Some("w10-133000000000000000"), Some("MSTeams"), Some("김대리"), Some("회의 & 점심")));
        assert_eq!(e["time"], "2022-06-18T04:26:40.000Z");
        // 다시 읽어도 지난번 뒤의 것만 — 막아 둔 앱은 넣지 않는다
        assert_eq!(h.read_copy(&file, "com.memoking.desktop", &Map::new()).unwrap(), 0);
        let blocked: Map<String, Value> = [("x".to_string(), json!("X"))].into_iter().collect();
        assert!(h.add(&blocked, json!({ "appId": "x", "title": "막힘" })).is_none());
        assert!(h.add(&blocked, json!({ "appId": "x", "source": "memoking" })).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn korean_locale_time() {
        use chrono::TimeZone;
        assert_eq!(ko_locale(chrono::Local.with_ymd_and_hms(2026, 11, 7, 0, 5, 9).unwrap()), "2026. 11. 7. 오전 12:05:09");
        assert_eq!(ko_locale(chrono::Local.with_ymd_and_hms(2026, 1, 17, 15, 30, 0).unwrap()), "2026. 1. 17. 오후 3:30:00");
    }
}
