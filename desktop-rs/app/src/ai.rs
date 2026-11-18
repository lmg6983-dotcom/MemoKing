// 태그 추천 · 로컬 AI — Electron 의 ipc-handlers.js (tags:* · ai:*) 와 desktop/ai/ (ai-service.js · ai-tagger.js) 자리.
//   AI 는 llama.cpp 의 llama-server 를 자식 프로세스로 띄워 이 PC 안에서만 돌린다 (인터넷 없이). 모델 파일은 설정 폴더 ai\chat.gguf.
//   메모리 8GB PC 를 생각해 쓸 때만 띄우고 5분 쓰지 않으면 끈다. 모델이 멈추거나 꺼져도 앱은 그대로.
use crate::state::State;
use memoking_core::ai::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const IDLE: Duration = Duration::from_secs(5 * 60);
const START: Duration = Duration::from_secs(3 * 60); // 느린 PC 에서 큰 모델을 올리는 시간

// 기본 모델 (core/model-catalog.js DEFAULT_MODEL) — 카카오 카나나2 3B instruct 를 imatrix 4비트로
const MODEL_REPO: &str = "mradermacher/kanana-2-3b-instruct-i1-GGUF";
const MODEL_FILE_END: &str = ".i1-q4_k_m.gguf";
const LICENSE_URL: &str = "https://huggingface.co/kakaocorp/kanana-2-3b-instruct/raw/main/LICENSE";

// AI 엔진 (llama.cpp llama-server, Vulkan) — 설치 파일에 넣지 않고 처음 쓸 때 받는다 (설치 파일 48MB 중 32MB 였다 — 업데이트마다 받던 것).
//   scripts/get-llama.mjs 와 같은 판. GitHub 가 알려 준 SHA-256 과 맞을 때만 넣는다
const LLAMA_TAG: &str = "b11400";
const LLAMA_ASSET: &str = "llama-b11400-bin-win-vulkan-x64.zip";

struct Server {
    child: Child,
    base: String,
    key: String,
    log: Arc<Mutex<Vec<String>>>,
}

#[derive(Default)]
struct Engine {
    server: Option<Server>,
    copying: bool,
    progress: Option<f64>,
    error: String,
    busy: usize,
    last_used: Option<Instant>,
}

static ENGINE: LazyLock<Mutex<Engine>> = LazyLock::new(Default::default);
static STARTING: Mutex<()> = Mutex::new(()); // 둘이 함께 불러도 엔진은 하나만 띄운다
static STOP_DOWNLOAD: AtomicBool = AtomicBool::new(false);
static ENGINE_DL: Mutex<()> = Mutex::new(()); // 엔진 받기는 한 번에 하나
static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default); // "창:작업" → 멈추기
// 이 PC 의 엔진 — 프록시를 거치지 않는다
static LOCAL: LazyLock<ureq::Agent> = LazyLock::new(|| ureq::Agent::config_builder().proxy(None).http_status_as_error(false).build().into());

fn dir(app: &AppHandle) -> PathBuf {
    app.state::<State>().settings_dir.join("ai")
}

fn model(app: &AppHandle) -> PathBuf {
    dir(app).join("chat.gguf")
}

fn engine_dir(app: &AppHandle) -> PathBuf {
    dir(app).join("engine")
}

/// llama-server: MEMOKING_LLAMA_SERVER, 받아 둔 설정 폴더 ai\engine, 설치본의 resources\llama(예전 설치 파일), 개발 중이면 desktop/vendor/llama (npm run llama)
fn server_path(app: &AppHandle) -> PathBuf {
    let name = format!("llama-server{}", std::env::consts::EXE_SUFFIX);
    if let Some(p) = std::env::var_os("MEMOKING_LLAMA_SERVER") {
        return p.into();
    }
    let got = engine_dir(app).join(&name);
    if got.is_file() {
        return got;
    }
    let bundled = app.path().resource_dir().map(|d| d.join("llama").join(&name)).unwrap_or_default();
    if bundled.is_file() {
        return bundled;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../desktop/vendor/llama").join(name)
}

/// 엔진이 없으면 받는다 (llama.cpp 릴리스의 Windows Vulkan 묶음에서 llama-server.exe 와 DLL 만) — 받는 동안 진행률은 모델 받기와 같은 칸에
fn ensure_engine(app: &AppHandle) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if server_path(app).is_file() {
        return Ok(());
    }
    if !cfg!(windows) {
        return Err("이 PC에 AI 엔진이 없어요 (npm run llama)".into());
    }
    let _one = ENGINE_DL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if server_path(app).is_file() {
        return Ok(()); // 기다리는 사이 다른 쪽이 받았다
    }
    let offline = "AI 엔진을 받지 못했어요. 인터넷에 연결한 뒤 다시 해 주세요";
    let rel = crate::stt::WEB.get(format!("https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{LLAMA_TAG}")).header("Accept", "application/vnd.github+json").call().map_err(|_| offline.to_string())?;
    let info: Value = rel.into_body().read_to_string().ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or(offline)?;
    let asset = info["assets"].as_array().into_iter().flatten().find(|a| a["name"] == LLAMA_ASSET).ok_or(offline)?;
    let sha = asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).filter(|d| d.len() == 64).ok_or(offline)?.to_string();
    let url = asset["browser_download_url"].as_str().ok_or(offline)?.to_string();
    let size = asset["size"].as_u64().unwrap_or(0);
    std::fs::create_dir_all(dir(app)).map_err(|e| e.to_string())?;
    let zip = dir(app).join("engine.zip.part");
    let res = crate::stt::WEB.get(url).call().map_err(|_| offline.to_string())?;
    if !res.status().is_success() {
        return Err(offline.into());
    }
    let mut hash = Sha256::new();
    let (mut got, mut shown) = (0u64, 0.0);
    let saved = crate::stt::save_to(res, &zip, &mut |b| {
        if STOP_DOWNLOAD.load(Ordering::Relaxed) {
            return Err("받기를 멈췄어요. 다시 누르면 처음부터 받아요".into());
        }
        hash.update(b);
        got += b.len() as u64;
        if size > 0 && got as f64 / size as f64 - shown >= 0.02 {
            shown = got as f64 / size as f64;
            ENGINE.lock().unwrap().progress = Some(shown);
            emit(app);
        }
        Ok(())
    });
    let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let r = saved.and_then(|()| if digest == sha { Ok(()) } else { Err("받은 AI 엔진이 맞지 않아요. 다시 해 주세요".into()) }).and_then(|()| unpack_engine(app, &zip));
    let _ = std::fs::remove_file(&zip);
    ENGINE.lock().unwrap().progress = None;
    r
}

/// 받은 zip 에서 llama-server.exe 와 DLL 만 ai\engine 으로 (다 꺼낸 뒤에 바꿔 넣는다 — 도중에 끊겨도 반쯤 든 엔진이 남지 않게)
fn unpack_engine(app: &AppHandle, zip: &std::path::Path) -> Result<(), String> {
    let tmp = dir(app).join("engine.unpack");
    let new = dir(app).join("engine.new");
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_dir_all(&new);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&new).map_err(|e| e.to_string())?;
    // Windows 10 이상의 tar(bsdtar)는 zip 도 푼다 (받아쓰기 모델과 같게)
    let mut cmd = Command::new("tar");
    cmd.arg("-xf").arg(zip).arg("-C").arg(&tmp);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    let _ = cmd.status();
    fn walk(d: &std::path::Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    walk(&tmp, &mut files);
    let pick: Vec<&PathBuf> = files.iter().filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("llama-server.exe") || n.to_ascii_lowercase().ends_with(".dll"))).collect();
    if !pick.iter().any(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("llama-server.exe"))) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("AI 엔진 묶음을 풀지 못했어요. 다시 해 주세요".into());
    }
    for p in pick {
        std::fs::copy(p, new.join(p.file_name().unwrap())).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_dir_all(engine_dir(app));
    std::fs::rename(&new, engine_dir(app)).map_err(|e| e.to_string())
}

/// 모델은 있는데 엔진이 없으면(엔진을 빼고 만든 설치 파일로 업데이트한 PC) 뒤에서 받아 둔다 — 한 번만
fn fetch_engine_soon(app: &AppHandle) {
    static ASKED: AtomicBool = AtomicBool::new(false);
    if !cfg!(windows) || server_path(app).is_file() || !model(app).is_file() || ASKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // 못 받았어도 다시 돌리지 않는다 — 실패 → 상태 알림(emit → status) → 다시 받기로 끝없이 돌았다. 다음은 AI 를 쓸 때(start) 받는다
        if let Err(e) = ensure_engine(&app) {
            ENGINE.lock().unwrap().error = e;
        }
        emit(&app);
    });
}

/// 화면이 묻는 상태 { engine, chat: { state, name, size, error, progress } }
fn status(app: &AppHandle) -> Value {
    let size = std::fs::metadata(model(app)).map_or(0, |m| m.len());
    let e = ENGINE.lock().unwrap();
    let state = if e.copying {
        "copying"
    } else if size == 0 {
        "missing"
    } else if e.server.is_some() {
        "running"
    } else {
        "ready"
    };
    let name = if size > 0 { app.state::<State>().setting("ai")["chat"].as_str().unwrap_or_default().to_string() } else { String::new() };
    // engine: 쓸 수 있다 — 엔진이 있거나, 없어도 받을 수 있다 (Windows: 모델을 받거나 처음 켤 때 받는다)
    let engine = cfg!(windows) || server_path(app).is_file();
    drop(e);
    fetch_engine_soon(app);
    let e = ENGINE.lock().unwrap();
    json!({ "engine": engine, "chat": { "state": state, "name": name, "size": size, "error": e.error, "progress": e.progress } })
}

fn emit(app: &AppHandle) {
    let _ = app.emit_to("list", "ai:status", [status(app)]);
}

fn set_name(app: &AppHandle, name: &str) {
    let st = app.state::<State>();
    let mut ai = st.setting("ai");
    if !ai.is_object() {
        ai = json!({});
    }
    ai["chat"] = name.into();
    st.set_setting("ai", ai);
}

// ---------- 모델 파일 ----------

/// 모델을 .part 로 채운 뒤(fill → 이름) 다 됐을 때만 바꿔 넣는다 — 몇 GB 라 도중에 끊겨도 쓰던 모델이 깨지지 않게
fn bring_in(app: &AppHandle, fill: impl FnOnce(&PathBuf) -> Result<String, String>) -> Result<Value, String> {
    {
        let mut e = ENGINE.lock().unwrap();
        if e.copying {
            drop(e);
            return Ok(status(app));
        }
        e.copying = true;
        e.error.clear();
    }
    emit(app);
    let part = dir(app).join("chat.gguf.part");
    // 엔진부터 (없으면 받는다 — 모델만 있고 엔진이 없으면 쓸 수 없으니 함께)
    let r = ensure_engine(app).and_then(|()| std::fs::create_dir_all(dir(app)).map_err(|e| e.to_string())).and_then(|_| fill(&part)).and_then(|name| {
        stop();
        std::fs::rename(&part, model(app)).map_err(|e| e.to_string())?;
        set_name(app, &name);
        Ok(())
    });
    {
        let mut e = ENGINE.lock().unwrap();
        if let Err(msg) = &r {
            let _ = std::fs::remove_file(&part);
            e.error = msg.clone();
        }
        e.copying = false;
        e.progress = None;
    }
    emit(app);
    r.map(|_| status(app))
}

fn import_model(app: &AppHandle, role: &str) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    if role != "chat" {
        return Err("모르는 모델이에요".into());
    }
    let picked = app.dialog().file().set_title("모델 파일(.gguf) 고르기").add_filter("AI 모델", &["gguf"]).blocking_pick_file();
    let Some(source) = picked.and_then(|p| p.into_path().ok()) else { return Ok(status(app)) };
    // .gguf 파일인지 (앞 4바이트) — 엉뚱한 파일을 모델로 넣지 않게
    let mut magic = [0u8; 4];
    let gguf = std::fs::File::open(&source).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"GGUF";
    if !gguf {
        return Err("모델 파일(.gguf)이 아니에요".into());
    }
    bring_in(app, |part| {
        std::fs::copy(&source, part).map_err(|e| crate::stt::io_error(e, "모델 파일을 복사하지 못했어요"))?;
        Ok(source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
    })
}

/// 저장소 파일 목록 → 받을 것 (이름, 주소, 크기, SHA-256) — 보조 파일(mtp 초안 · mmproj 그림)은 빼고, 목록을 받은 그 커밋으로 고정
fn pick_model_file(info: &Value) -> Result<(String, String, u64, String), String> {
    let f = info["siblings"].as_array().into_iter().flatten().find(|s| {
        let n = s["rfilename"].as_str().unwrap_or_default().to_lowercase();
        n.ends_with(MODEL_FILE_END) && !n.contains("mtp") && !n.contains("mmproj")
    });
    let sha = f.and_then(|f| f["lfs"]["sha256"].as_str()).unwrap_or_default();
    let (Some(f), true) = (f, sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) else {
        return Err("받을 모델 파일을 찾지 못했어요. 잠시 뒤 다시 해 주세요".into());
    };
    let path = f["rfilename"].as_str().unwrap_or_default();
    let url = format!("https://huggingface.co/{MODEL_REPO}/resolve/{}/{}", info["sha"].as_str().unwrap_or("main"), path.split('/').map(memoking_core::js::encode_uri_component).collect::<Vec<_>>().join("/"));
    let size = f["lfs"]["size"].as_u64().or(f["size"].as_u64()).unwrap_or(0);
    Ok((path.rsplit('/').next().unwrap_or(path).to_string(), url, size, sha.to_string()))
}

/// 기본 모델 받기 — Hugging Face 가 알려 준 SHA-256 과 맞아야 넣는다
fn download_default(app: &AppHandle) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    STOP_DOWNLOAD.store(false, Ordering::Relaxed);
    let offline = "인터넷에 연결하지 못했어요. 인터넷이 될 때 다시 누르거나, 모델 파일을 직접 넣어 주세요";
    bring_in(app, |part| {
        let list = crate::stt::WEB.get(format!("https://huggingface.co/api/models/{MODEL_REPO}?blobs=true")).call().map_err(|_| offline.to_string())?;
        if !list.status().is_success() {
            return Err(format!("모델 목록을 받지 못했어요 ({}). 인터넷을 확인하고 다시 눌러 주세요", list.status().as_u16()));
        }
        let info: Value = list.into_body().read_to_string().ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or(offline)?;
        let (name, url, size, sha) = pick_model_file(&info)?;
        let res = crate::stt::WEB.get(url).call().map_err(|_| offline.to_string())?;
        if !res.status().is_success() {
            return Err(format!("받지 못했어요 ({}). 인터넷을 확인하고 다시 눌러 주세요", res.status().as_u16()));
        }
        let mut hash = Sha256::new();
        let (mut got, mut shown) = (0u64, 0.0);
        crate::stt::save_to(res, part, &mut |b| {
            if STOP_DOWNLOAD.load(Ordering::Relaxed) {
                return Err("받기를 멈췄어요. 다시 누르면 처음부터 받아요".into());
            }
            hash.update(b);
            got += b.len() as u64;
            if size > 0 && got as f64 / size as f64 - shown >= 0.01 {
                shown = got as f64 / size as f64;
                ENGINE.lock().unwrap().progress = Some(shown);
                emit(app);
            }
            Ok(())
        })?;
        let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if digest != sha {
            return Err("받은 파일이 맞지 않아요. 다시 받아 주세요".into());
        }
        // 라이선스 사본을 모델 옆에 (카나나 라이선스 3.1) — 못 받아도 설정의 링크로 볼 수 있어 모델은 넣는다
        if let Some(lic) = crate::stt::WEB.get(LICENSE_URL).call().ok().filter(|r| r.status().is_success()) {
            if let Ok(text) = lic.into_body().read_to_string() {
                let _ = std::fs::write(dir(app).join("KANANA-LICENSE.txt"), text);
            }
        }
        Ok(name)
    })
}

fn remove_model(app: &AppHandle, role: &str) -> Result<Value, String> {
    if role != "chat" {
        return Err("모르는 모델이에요".into());
    }
    stop();
    let _ = std::fs::remove_file(model(app));
    ENGINE.lock().unwrap().error.clear();
    set_name(app, "");
    emit(app);
    Ok(status(app))
}

// ---------- llama-server ----------

/// 엔진 끄기 (앱을 끌 때도 — 따로 도는 프로세스라 남지 않게)
pub fn stop() {
    let s = ENGINE.lock().unwrap().server.take();
    if let Some(mut s) = s {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

/// 엔진을 띄워(이미 떠 있으면 그대로) 주소와 열쇠
/// 메모킹이 충돌하거나 작업 관리자로 꺼져도 엔진(몇 GB 메모리)이 남지 않게: 엔진을 작업 개체에 넣으면 앱이 끝나 그 핸들이 닫힐 때 Windows 가 함께 끈다
#[cfg(windows)]
pub(crate) fn kill_with_app(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::*;
    // 핸들은 일부러 닫지 않는다 (닫히는 때가 엔진을 끄는 때)
    static JOB: LazyLock<usize> = LazyLock::new(|| {
        // SAFETY: 이름 없는 작업 개체를 만들고, 살아 있는 지역 구조체를 그 크기와 함께 넘긴다
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, size_of_val(&info) as u32);
            job as usize
        }
    });
    // SAFETY: 두 핸들 모두 살아 있다 (작업 개체를 못 만들었으면 null 이라 실패만 한다)
    unsafe { AssignProcessToJobObject(*JOB as _, child.as_raw_handle()) };
}

fn start(app: &AppHandle) -> Result<(String, String), String> {
    let _one = STARTING.lock().unwrap();
    if let Some(s) = &ENGINE.lock().unwrap().server {
        return Ok((s.base.clone(), s.key.clone()));
    }
    // 엔진이 없으면 지금 받는다 (처음 켤 때 한 번)
    ensure_engine(app)?;
    let exe = server_path(app);
    if !exe.is_file() {
        return Err("이 PC에 AI 엔진이 없어요. 인터넷에 연결한 뒤 다시 해 주세요".into());
    }
    if !model(app).is_file() {
        return Err("AI 모델 파일을 먼저 넣어 주세요 (설정의 AI 도우미)".into());
    }
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    let key: String = raw.iter().map(|b| format!("{b:02x}")).collect(); // 이 PC 의 다른 프로그램 · 웹 페이지가 모델을 부르지 못하게
    let mut cmd = Command::new(&exe);
    cmd.arg("-m").arg(model(app)).args(["--host", "127.0.0.1", "--port", &port.to_string(), "--api-key", &key, "--no-webui", "-c", "4096", "-np", "1"]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    // 엔진 파일을 띄우지 못하면(보안 프로그램이 격리함 등) 그 까닭을 엔진 오류로
    let mut child = cmd.spawn().map_err(|e| {
        let msg = engine_error(&e.to_string(), "-1");
        ENGINE.lock().unwrap().error = msg.clone();
        msg
    })?;
    #[cfg(windows)]
    kill_with_app(&child);
    let log = Arc::new(Mutex::new(Vec::new()));
    if let Some(err) = child.stderr.take() {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok).filter(|l| !l.is_empty()) {
                let mut l = log.lock().unwrap();
                l.push(line);
                let over = l.len().saturating_sub(20);
                l.drain(..over);
            }
        });
    }
    let base = format!("http://127.0.0.1:{port}");
    {
        let mut e = ENGINE.lock().unwrap();
        e.server = Some(Server { child, base: base.clone(), key: key.clone(), log });
        e.last_used = Some(Instant::now());
    }
    emit(app);
    watch(app.clone(), base.clone());
    let until = Instant::now() + START;
    while Instant::now() < until {
        if ENGINE.lock().unwrap().server.as_ref().is_none_or(|s| s.base != base) {
            let e = ENGINE.lock().unwrap().error.clone();
            return Err(if e.is_empty() { "모델을 올리지 못했어요. 파일이 깨졌거나 이 엔진이 모르는 모델이에요".into() } else { e });
        }
        if LOCAL.get(format!("{base}/health")).call().is_ok_and(|r| r.status().is_success()) {
            ENGINE.lock().unwrap().error.clear();
            return Ok((base, key));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    stop();
    Err("모델을 올리는 데 너무 오래 걸려요".into())
}

/// 엔진이 저절로 꺼지면 까닭을 남기고, 5분 쓰지 않으면 끈다
fn watch(app: AppHandle, base: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let mut e = ENGINE.lock().unwrap();
        let Some(s) = e.server.as_mut().filter(|s| s.base == base) else { return };
        if let Ok(Some(code)) = s.child.try_wait() {
            let log = s.log.lock().unwrap().join("\n");
            e.server = None;
            if let Some(c) = code.code().filter(|c| *c != 0) {
                eprintln!("AI chat 꺼짐 {c} {log}");
                e.error = engine_error(&log, &c.to_string());
            }
            drop(e);
            emit(&app);
            return;
        }
        if e.busy == 0 && e.last_used.is_some_and(|t| t.elapsed() >= IDLE) {
            drop(e);
            stop();
            emit(&app);
            return;
        }
    });
}

/// 엔진에 묻는다. on_line 을 주면 답을 줄(SSE "data: {…}")마다 넘기고 None, 아니면 답 JSON
type OnLine<'a> = &'a mut dyn FnMut(&str) -> Result<(), String>;

fn request(app: &AppHandle, body: &Value, cancel: &AtomicBool, on_line: Option<OnLine>) -> Result<Option<Value>, String> {
    let (base, key) = start(app)?;
    ENGINE.lock().unwrap().busy += 1;
    let r = (|| {
        let res = LOCAL
            .post(format!("{base}/v1/chat/completions"))
            .header("authorization", format!("Bearer {key}"))
            .header("content-type", "application/json")
            .send(body.to_string())
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("AI가 답하지 못했어요 ({})", res.status().as_u16()));
        }
        let Some(on_line) = on_line else {
            let text = res.into_body().read_to_string().map_err(|e| e.to_string())?;
            return serde_json::from_str(&text).map(Some).map_err(|e| e.to_string());
        };
        for line in BufReader::new(res.into_body().into_reader()).lines() {
            if cancel.load(Ordering::Relaxed) {
                return Err("멈췄어요".into());
            }
            on_line(&line.map_err(|e| e.to_string())?)?;
        }
        Ok(None)
    })();
    let mut e = ENGINE.lock().unwrap();
    e.busy -= 1;
    e.last_used = Some(Instant::now());
    drop(e);
    // shortcut: 한 번에 받는 답(태그 · 맞춤법 조각)은 중간에 끊지 못하고 다 온 뒤에 멈춘다, 길게 걸리면 연결을 닫는 멈추기로
    if cancel.load(Ordering::Relaxed) {
        return Err("멈췄어요".into());
    }
    r
}

/// 글 모델에 묻기 → 답 글 (llama-client.js chat). on_token: 지금까지 온 글을 조각마다
fn chat(app: &AppHandle, messages: &Value, max_tokens: usize, temperature: f64, schema: Option<&Value>, cancel: &AtomicBool, on_token: Option<&dyn Fn(&str)>) -> Result<String, String> {
    let Some(on_token) = on_token else {
        let data = request(app, &chat_body(messages, max_tokens, temperature, schema, false), cancel, None)?;
        return Ok(reply_text(&data.unwrap_or_default()));
    };
    let mut text = String::new();
    let mut each = |line: &str| {
        let piece = sse_text(line)?;
        if !piece.is_empty() {
            text.push_str(&piece);
            on_token(&no_think(&text));
        }
        Ok(())
    };
    request(app, &chat_body(messages, max_tokens, temperature, schema, true), cancel, Some(&mut each))?;
    Ok(no_think(&text))
}

/// 글 도우미: spell → { fixed: [] } (믿을 만한 답만, 아니면 원래 글) · style · draft → { text }
fn write(app: &AppHandle, label: &str, job: &Value, cancel: &AtomicBool) -> Result<Value, String> {
    let id = job["id"].clone();
    let s = |k: &str| job[k].as_str().unwrap_or_default();
    if s("task") == "spell" {
        let blocks: Vec<&str> = job["blocks"].as_array().into_iter().flatten().map(|b| b.as_str().unwrap_or_default()).collect();
        let mut fixed = vec![];
        for (i, block) in blocks.iter().enumerate() {
            let _ = app.emit_to(label, "ai:progress", [json!({ "id": id, "done": i, "total": blocks.len() })]);
            let out = chat(app, &spell_messages(block), block.encode_utf16().count() * 2 + 32, 0.0, None, cancel, None)?;
            fixed.push(if plausible_fix(block, &out) { out } else { block.to_string() });
        }
        return Ok(json!({ "fixed": fixed }));
    }
    let messages = if s("task") == "style" { style_messages(s("text"), s("style")) } else { draft_messages(s("title"), s("text"), s("request"), s("selection")) };
    let token = |text: &str| {
        let _ = app.emit_to(label, "ai:token", [json!({ "id": id, "text": text })]);
    };
    let raw = chat(app, &messages, 1024, 0.2, None, cancel, Some(&token))?;
    Ok(json!({ "text": clean_write_output(&raw) }))
}

/// 찾기: 잠긴 메모 빼고 모든 메모의 조각에서, 질문을 넓혀(모델) 낱말 · 두 글자 조각 · 그래프로 → (고른 메모, 넓힌 낱말)
// shortcut: 찾기 색인을 물을 때마다 새로 만든다 (메모 수천 개에 수백 ms), 느리다는 말이 나오면 ai-tasks.js 처럼 바뀐 메모만 다시
fn find(app: &AppHandle, question: &str, limit: usize, now: chrono::DateTime<chrono::Local>, cancel: &AtomicBool) -> Result<(Vec<memoking_core::rag::Picked>, Vec<String>), String> {
    use memoking_core::rag::*;
    let (messages, schema) = expand_messages(question);
    // 넓히지 못해도(모델 오류 · 엉뚱한 답) 질문 낱말만으로 찾는다
    let words = chat(app, &messages, 120, 0.0, Some(&schema), cancel, None).map(|a| expand_result(&a)).unwrap_or_default();
    if cancel.load(Ordering::Relaxed) {
        return Err("멈췄어요".into());
    }
    let (chunks, graph) = {
        let st = app.state::<State>();
        let guard = st.vault.lock().unwrap();
        let Some(v) = guard.as_ref() else { return Err("메모 폴더가 아직 없어요. 먼저 메모 폴더를 골라 주세요".into()) };
        let mut files: Vec<_> = v.files().filter(|e| !memoking_core::body::is_locked_body(&e.body)).collect();
        files.sort_by(|a, b| a.file.cmp(&b.file));
        let chunks: Vec<Chunk> = files
            .iter()
            .flat_map(|e| {
                let title = memoking_core::body::extract_title(&e.body);
                chunk_memo(&e.body).into_iter().map(move |text| Chunk { id: e.id.clone(), title: title.clone(), text, updated: e.meta.updated.clone() })
            })
            .collect();
        // 그래프: 색인(index.json)의 연결 · 관련도
        let index: Value = std::fs::read_to_string(v.root.join("_memoking").join("index.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let graph: HashMap<String, Vec<(String, f64)>> = index["memos"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|m| {
                let rel = m["related"].as_array().into_iter().flatten().map(|r| (r["id"].as_str().unwrap_or_default().to_string(), r["score"].as_f64().unwrap_or(0.0))).collect();
                (m["id"].as_str().unwrap_or_default().to_string(), rel)
            })
            .collect();
        (chunks, graph)
    };
    Ok((retrieve(question, &build_index(chunks), &words, &|id| graph.get(id).cloned().unwrap_or_default(), limit, now), words))
}

fn sources_of(picked: &[memoking_core::rag::Picked]) -> Vec<Value> {
    picked.iter().map(|m| json!({ "id": m.id, "title": m.title, "via": m.via })).collect()
}

/// AI 검색: 찾은 메모만 근거로 답 (물러서면 찾은 문장 그대로) → { text, sources, quoted }
fn ask(app: &AppHandle, label: &str, id: &Value, question: &str, cancel: &AtomicBool) -> Result<Value, String> {
    use memoking_core::rag::*;
    let now = chrono::Local::now();
    let (picked, words) = find(app, question, 4, now, cancel)?;
    let sources = sources_of(&picked);
    if picked.is_empty() {
        return Ok(json!({ "text": NOT_FOUND, "sources": sources, "quoted": false }));
    }
    let token = |text: &str| {
        let _ = app.emit_to(label, "ai:token", [json!({ "id": id, "text": text })]);
    };
    let raw = chat(app, &rag_messages(question, &picked, now), 400, 0.2, None, cancel, Some(&token))?;
    let (text, quoted) = finish_answer(&raw, question, &picked, &words);
    Ok(json!({ "text": text, "sources": sources, "quoted": quoted }))
}

/// 매직 에이전트 (ai-tasks.js agent): 질문이면 답, 할 일이면 확인 카드 (바꾸는 일은 사용자 확인 뒤 ai:agent-run 이 한다)
///   → { kind: 'answer', text, sources } | { kind: 'summary', topic, text, sources } | { kind: 'confirm', action, … }
fn agent(app: &AppHandle, label: &str, id: &Value, text: &str, cancel: &AtomicBool) -> Result<Value, String> {
    use memoking_core::agent::*;
    let now = chrono::Local::now();
    let mut intent = detect_intent(text, now);
    // "내일 일정 알려줘" 처럼 시각 없이 일정을 물으면 넣기가 아니라 일정 답 ("내일 3시 치과 알려줘" 는 넣기)
    let sq = schedule_query(text, now);
    let asks_schedule = || memoking_core::js::re(r"일정|약속|스케줄|계획|뭐\s*있|할\s*일").is_match(text).unwrap_or(false);
    if sq.is_some() && intent["action"] == "event" && intent["when"]["hasTime"] != true && intent["when"]["repeat"].is_null() && asks_schedule() {
        intent = json!({ "action": "answer" });
    }
    if intent["unsure"] == true {
        let (messages, schema) = plan_messages(text);
        let keep = intent;
        intent = chat(app, &messages, 200, 0.0, Some(&schema), cancel, None).map_or_else(|_| keep.clone(), |a| plan_result(&a, text, now));
        if intent["action"] == "answer" && keep["action"] == "event" {
            intent = keep; // 날짜가 든 짧은 명령은 일정으로 (확인 카드에서 고칠 수 있다)
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("멈췄어요".into());
    }
    let token = |text: &str| {
        let _ = app.emit_to(label, "ai:token", [json!({ "id": id, "text": text })]);
    };
    match intent["action"].as_str() {
        Some("event") => return Ok(json!({ "kind": "confirm", "action": { "type": "event", "title": intent["title"], "when": intent["when"] } })),
        Some("memo") => {
            // 내용 없이 "출시 준비 체크리스트 만들어줘" 면 모델이 초안 항목을 (확인 카드에서 고친다)
            let empty = if intent["list"] == true { intent["items"].as_array().is_none_or(Vec::is_empty) } else { intent["text"].as_str().is_none_or(str::is_empty) };
            if empty {
                let (messages, schema) = memo_draft_messages(text, &intent);
                if let Ok(a) = chat(app, &messages, 400, 0.3, Some(&schema), cancel, None) {
                    intent = memo_draft_result(&a, &intent);
                }
            }
            return Ok(json!({ "kind": "confirm", "action": { "type": "memo", "body": memo_body(&intent) }, "drafted": intent["drafted"] == true }));
        }
        Some("append") => {
            let memos: Vec<(String, String, Option<String>)> = {
                let st = app.state::<State>();
                let guard = st.vault.lock().unwrap();
                let mut list: Vec<_> = guard.as_ref().map(|v| v.files().map(|e| (e.file.clone(), e.id.clone(), e.body.clone(), e.meta.updated.clone())).collect()).unwrap_or_default();
                list.sort_by(|a, b| a.0.cmp(&b.0));
                list.into_iter().map(|(_, id, body, updated)| (id, body, updated)).collect()
            };
            let target = intent["target"].as_str().unwrap_or_default();
            let targets = append_targets(target, &memos);
            let Some(first) = targets.first() else {
                return Ok(json!({ "kind": "answer", "text": format!("\"{target}\" 메모를 찾지 못했어요. 덧붙일 메모의 제목으로 다시 말해 주세요."), "sources": [] }));
            };
            return Ok(json!({ "kind": "confirm", "action": { "type": "append", "id": first["id"], "text": append_text(intent["content"].as_str().unwrap_or_default()) }, "targets": targets }));
        }
        Some("summary") => {
            let topic = intent["topic"].as_str().unwrap_or_default();
            let picked: Vec<_> = find(app, topic, 6, now, cancel)?.0.into_iter().filter(|m| m.via != "graph").collect();
            if picked.is_empty() {
                return Ok(json!({ "kind": "answer", "text": memoking_core::rag::NOT_FOUND, "sources": [] }));
            }
            let raw = chat(app, &summary_messages(topic, &picked), 500, 0.2, None, cancel, Some(&token))?;
            // 없는 번호([9])는 지운다
            let body = memoking_core::js::re(r"\[(\d+)\]")
                .replace_all(memoking_core::js::trim(&raw), |c: &fancy_regex::Captures<str>| if c[1].parse::<usize>().is_ok_and(|n| (1..=picked.len()).contains(&n)) { c[0].to_string() } else { String::new() })
                .into_owned();
            let text = if body.is_empty() { memoking_core::rag::NOT_FOUND.to_string() } else { body };
            return Ok(json!({ "kind": "summary", "topic": topic, "text": text, "sources": sources_of(&picked) }));
        }
        _ => {}
    }
    // 일정을 물으면 ("내일 뭐 있어?") 일정 탭에서 바로 — 모델 없이, 틀릴 일 없이
    if let Some(sq) = sq {
        let all = app.state::<State>().vault.lock().unwrap().as_ref().map(|v| v.all_reminders()).unwrap_or_default();
        let events = events_in(&all, &sq);
        if !events.is_empty() || sq.words.is_empty() {
            let (text, ids) = schedule_text(&sq, &events);
            let sources: Vec<Value> = ids.iter().map(|id| json!({ "id": id, "title": events.iter().find(|e| e.memo_id == *id).map(|e| e.title.clone()), "via": "event" })).collect();
            return Ok(json!({ "kind": "answer", "text": text, "sources": sources }));
        }
    }
    let mut answer = ask(app, label, id, text, cancel)?;
    answer["kind"] = "answer".into();
    Ok(answer)
}

/// 매직 에이전트가 사용자 확인을 받은 일 — 화면이 보낸 값이므로 여기서 다시 거른다 (종류 · 길이 · 날짜 · 잠금) → { ok, id?, message }
fn run_agent_action(app: &AppHandle, a: &Value) -> Value {
    use crate::reminders::{MEMO_PICK_AGAIN, SAVED_ELSEWHERE};
    use memoking_core::js::{is_space, slice16, string};
    let st = app.state::<State>();
    let fail = |m: &str| json!({ "ok": false, "message": m });
    if st.vault.lock().unwrap().is_none() || !a.is_object() {
        return fail(MEMO_PICK_AGAIN);
    }
    let s = |v: &Value, max: usize| slice16(&if v.is_null() { String::new() } else { string(v) }, max);
    let clean = |v: &Value, max: usize| s(v, max).split(is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let now = chrono::Local::now();
    match a["type"].as_str() {
        Some("event") => {
            let title = Some(clean(&a["title"], 80)).filter(|t| !t.is_empty()).unwrap_or_else(|| "일정".into());
            let when = &a["when"];
            let end = s(&when["end"], 40);
            let d = json!({ "at": s(&when["at"], 40), "hasTime": when["hasTime"], "repeat": if when["repeat"].is_object() { when["repeat"].clone() } else { Value::Null }, "end": (!end.is_empty()).then_some(end), "title": title });
            let Some(r) = memoking_core::reminders::event_from_date(&d, now) else { return fail("날짜를 알아보지 못했어요") };
            let done = st.vault.lock().unwrap().as_mut().map(|v| -> Result<(String, Vec<Value>), String> {
                let id = v.import(&format!("# {title}\n"), None).map_err(|e| e.to_string())?.ok_or(SAVED_ELSEWHERE)?;
                let saved = v.set_reminders(&id, vec![r]).map_err(|e| e.to_string())?.ok_or(SAVED_ELSEWHERE)?;
                Ok((id, saved))
            });
            let (id, saved) = match done {
                Some(Ok(done)) => done,
                Some(Err(e)) => return fail(&e),
                None => return fail(MEMO_PICK_AGAIN),
            };
            let message = format!("일정을 넣었어요 · {}", memoking_core::reminders::describe_reminder(&saved[0], now));
            crate::reminders::changed(app, &id, saved);
            json!({ "ok": true, "id": id, "message": message })
        }
        Some(kind @ ("memo" | "summary")) => {
            let body = if kind == "summary" {
                let titles: Vec<String> = a["sources"].as_array().into_iter().flatten().take(10).map(|x| clean(&x["title"], 80)).collect();
                memoking_core::agent::summary_body(&clean(&a["topic"], 60), &s(&a["text"], 8000), &titles)
            } else {
                s(&a["body"], 20000)
            };
            if memoking_core::js::trim(&body).is_empty() || memoking_core::body::is_locked_body(&body) {
                return fail("쓸 내용이 없어요");
            }
            let body = if body.ends_with('\n') { body } else { format!("{body}\n") };
            let id = match st.vault.lock().unwrap().as_mut().map(|v| v.import(&body, None)) {
                Some(Ok(Some(id))) => id,
                Some(Err(e)) => return fail(&e.to_string()),
                _ => return fail(SAVED_ELSEWHERE),
            };
            crate::memos::push_list(app);
            json!({ "ok": true, "id": id, "message": if kind == "summary" { "요약을 새 메모로 저장했어요" } else { "메모를 만들었어요" } })
        }
        Some("append") => {
            let id = s(&a["id"], usize::MAX);
            let Some(m) = memo(app, &id) else { return fail("덧붙일 메모를 찾지 못했어요") };
            let old = m["body"].as_str().unwrap_or_default();
            if m["locked"] == true || memoking_core::body::is_locked_body(old) {
                return fail("잠긴 메모에는 덧붙일 수 없어요");
            }
            let text = s(&a["text"], 8000);
            if memoking_core::body::has_lock_marker(&text) {
                return fail("잠금 정보가 든 글은 덧붙일 수 없어요");
            }
            let Some(body) = memoking_core::agent::append_to_body(old, &text) else { return fail("덧붙일 내용이 없어요") };
            let saved = st.vault.lock().unwrap().as_mut().map(|v| v.save(&id, &body));
            match saved {
                Some(Ok((card, changed))) if card["refused"] != true => {
                    if changed {
                        crate::memos::push_list(app);
                    }
                }
                Some(Err(e)) => return fail(&e.to_string()),
                _ => return fail(SAVED_ELSEWHERE),
            }
            // 열린 메모 창도 덧붙인 글로
            crate::reminders::send_to_note(app, &id, "memo:external", memo(app, &id).unwrap_or_default());
            let title = m["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("제목 없음");
            json!({ "ok": true, "id": id, "message": format!("'{}'에 덧붙였어요", slice16(title, 20)) })
        }
        _ => fail("할 수 없는 일이에요"),
    }
}

fn memo(app: &AppHandle, id: &str) -> Option<Value> {
    app.state::<State>().vault.lock().unwrap().as_ref().and_then(|v| v.get(id))
}

// ---------- 채널 ----------

/// 창에서 부른 AI 작업 — ai:cancel 로 멈출 수 있게 등록해 두고, 오류는 { error }
fn job(label: &str, id: &Value, run: impl FnOnce(&AtomicBool) -> Result<Value, String>) -> Result<Value, String> {
    let key = format!("{label}:{}", memoking_core::js::string(id));
    let cancel = Arc::new(AtomicBool::new(false));
    JOBS.lock().unwrap().insert(key.clone(), cancel.clone());
    let r = run(&cancel);
    JOBS.lock().unwrap().remove(&key);
    Ok(r.unwrap_or_else(|e| json!({ "error": e })))
}

fn with_status(app: &AppHandle, r: Result<Value, String>) -> Result<Value, String> {
    Ok(r.unwrap_or_else(|e| {
        let mut s = status(app);
        s["error"] = e.into();
        s
    }))
}

pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let s = |i: usize| args.get(i).and_then(Value::as_str);
    let arg = args.first().cloned().unwrap_or_default();
    Some(match channel {
        "ai:status" => Ok(status(app)),
        "ai:import" => with_status(app, import_model(app, s(0).unwrap_or_default())),
        "ai:remove" => remove_model(app, s(0).unwrap_or_default()),
        "ai:download-default" => with_status(app, download_default(app)),
        "ai:cancel-download" => {
            STOP_DOWNLOAD.store(true, Ordering::Relaxed);
            Ok(true.into())
        }
        "ai:try" => {
            let started = Instant::now();
            let ask = json!([{ "role": "user", "content": "메모 앱을 한 문장으로 소개해 주세요." }]);
            Ok(match chat(app, &ask, 80, 0.3, None, &AtomicBool::new(false), None) {
                Ok(text) => json!({ "text": text, "seconds": started.elapsed().as_secs_f64() }),
                Err(e) => json!({ "error": e }),
            })
        }
        "ai:write" => job(label, &arg["id"], |cancel| write(app, label, &arg, cancel)),
        "ai:ask" => job(label, &arg["id"], |cancel| ask(app, label, &arg["id"], &memoking_core::js::string(&arg["question"]), cancel)),
        // 매직 에이전트 (목록 검색창 ✦ · 매직키 AI 줄): 답이나 확인 카드 → 확인하면 agent-run 으로 실행
        "ai:agent" => {
            let text = if arg["text"].is_null() { String::new() } else { memoking_core::js::slice16(&memoking_core::js::string(&arg["text"]), 2000) };
            job(label, &arg["id"], |cancel| agent(app, label, &arg["id"], &text, cancel))
        }
        "ai:agent-run" => Ok(run_agent_action(app, &arg)),
        // AI 가 뒤에서 한 일 막대 (Electron 판의 MagicKey 다듬기) — 자동 태그 · 일정 자동 등록을 없애 이 판에는 알릴 것이 없다
        "ai:notice" | "ai:notice-dismiss" => Ok(Value::Null),
        "ai:notice-undo" => Ok(json!({ "ok": false, "message": "되돌릴 것이 없어요", "next": null })),
        "ai:cancel" => {
            if let Some(c) = JOBS.lock().unwrap().get(&format!("{label}:{}", memoking_core::js::string(&arg))) {
                c.store(true, Ordering::Relaxed);
            }
            Ok(Value::Null)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_main_model_file() {
        let info = json!({ "sha": "abc", "siblings": [
            { "rfilename": "x.i1-Q4_K_M.mmproj.gguf", "lfs": { "sha256": "a".repeat(64), "size": 1 } },
            { "rfilename": "kanana.mtp.i1-Q4_K_M.gguf", "lfs": { "sha256": "b".repeat(64), "size": 2 } },
            { "rfilename": "sub dir/kanana.i1-Q4_K_M.gguf", "lfs": { "sha256": "c".repeat(64), "size": 3 } },
        ] });
        let (name, url, size, sha) = pick_model_file(&info).unwrap();
        assert_eq!((name.as_str(), size, sha), ("kanana.i1-Q4_K_M.gguf", 3, "c".repeat(64)));
        assert_eq!(url, format!("https://huggingface.co/{MODEL_REPO}/resolve/abc/sub%20dir/kanana.i1-Q4_K_M.gguf"));
        // 해시가 없거나 이상하면 받지 않는다
        assert!(pick_model_file(&json!({ "siblings": [{ "rfilename": "k.i1-Q4_K_M.gguf", "lfs": { "sha256": "XYZ" } }] })).is_err());
    }
}
