// 태그 추천 · 로컬 AI — Electron 의 ipc-handlers.js (tags:* · ai:*) 와 desktop/ai/ (ai-service.js · ai-tagger.js) 자리.
//   AI 는 llama.cpp 의 llama-server 를 자식 프로세스로 띄워 이 PC 안에서만 돌린다 (인터넷 없이). 모델 파일은 설정 폴더 ai\chat.gguf.
//   메모리 8GB PC 를 생각해 쓸 때만 띄우고 5분 쓰지 않으면 끈다. 모델이 멈추거나 꺼져도 앱은 그대로.
use crate::state::State;
use memoking_core::ai::*;
use memoking_core::tag_suggest::{append_tags, auto_tags_for, remove_tags, suggest_tags_for};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const IDLE: Duration = Duration::from_secs(5 * 60);
const START: Duration = Duration::from_secs(3 * 60); // 느린 PC 에서 큰 모델을 올리는 시간
const MAX_TAGS: usize = 3; // 한 메모의 태그 (사용자 + AI) — AI 는 이만큼까지만 채운다

// 기본 모델 (core/model-catalog.js DEFAULT_MODEL) — 카카오 카나나2 3B instruct 를 imatrix 4비트로
const MODEL_REPO: &str = "mradermacher/kanana-2-3b-instruct-i1-GGUF";
const MODEL_FILE_END: &str = ".i1-q4_k_m.gguf";
const LICENSE_URL: &str = "https://huggingface.co/kakaocorp/kanana-2-3b-instruct/raw/main/LICENSE";

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
static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default); // "창:작업" → 멈추기
// 이 PC 의 엔진 — 프록시를 거치지 않는다
static LOCAL: LazyLock<ureq::Agent> = LazyLock::new(|| ureq::Agent::config_builder().proxy(None).http_status_as_error(false).build().into());
// 모델 받기 — Electron net.fetch 처럼 시스템 프록시 · 인증서를 따른다
static WEB: LazyLock<ureq::Agent> = LazyLock::new(|| {
    let tls = ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    ureq::Agent::config_builder().tls_config(tls).http_status_as_error(false).build().into()
});

fn dir(app: &AppHandle) -> PathBuf {
    app.state::<State>().settings_dir.join("ai")
}

fn model(app: &AppHandle) -> PathBuf {
    dir(app).join("chat.gguf")
}

/// llama-server: MEMOKING_LLAMA_SERVER, 설치본의 resources\llama, 개발 중이면 desktop/vendor/llama (npm run llama)
fn server_path(app: &AppHandle) -> PathBuf {
    let name = format!("llama-server{}", std::env::consts::EXE_SUFFIX);
    if let Some(p) = std::env::var_os("MEMOKING_LLAMA_SERVER") {
        return p.into();
    }
    let bundled = app.path().resource_dir().map(|d| d.join("llama").join(&name)).unwrap_or_default();
    if bundled.is_file() {
        return bundled;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../desktop/vendor/llama").join(name)
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
    json!({ "engine": server_path(app).is_file(), "chat": { "state": state, "name": name, "size": size, "error": e.error, "progress": e.progress } })
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

fn io_error(e: std::io::Error, other: &str) -> String {
    if e.kind() == std::io::ErrorKind::StorageFull {
        "저장 공간이 모자라요".into()
    } else {
        other.to_string()
    }
}

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
    let r = std::fs::create_dir_all(dir(app)).map_err(|e| e.to_string()).and_then(|_| fill(&part)).and_then(|name| {
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
        std::fs::copy(&source, part).map_err(|e| io_error(e, "모델 파일을 복사하지 못했어요"))?;
        Ok(source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
    })
}

/// encodeURIComponent
fn uri_component(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
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
    let url = format!("https://huggingface.co/{MODEL_REPO}/resolve/{}/{}", info["sha"].as_str().unwrap_or("main"), path.split('/').map(uri_component).collect::<Vec<_>>().join("/"));
    let size = f["lfs"]["size"].as_u64().or(f["size"].as_u64()).unwrap_or(0);
    Ok((path.rsplit('/').next().unwrap_or(path).to_string(), url, size, sha.to_string()))
}

/// 기본 모델 받기 — Hugging Face 가 알려 준 SHA-256 과 맞아야 넣는다
fn download_default(app: &AppHandle) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    STOP_DOWNLOAD.store(false, Ordering::Relaxed);
    let offline = "인터넷에 연결하지 못했어요. 인터넷이 될 때 다시 누르거나, 모델 파일을 직접 넣어 주세요";
    bring_in(app, |part| {
        let list = WEB.get(format!("https://huggingface.co/api/models/{MODEL_REPO}?blobs=true")).call().map_err(|_| offline.to_string())?;
        if !list.status().is_success() {
            return Err(format!("모델 목록을 받지 못했어요 ({}). 인터넷을 확인하고 다시 눌러 주세요", list.status().as_u16()));
        }
        let info: Value = list.into_body().read_to_string().ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or(offline)?;
        let (name, url, size, sha) = pick_model_file(&info)?;
        let res = WEB.get(url).call().map_err(|_| offline.to_string())?;
        if !res.status().is_success() {
            return Err(format!("받지 못했어요 ({}). 인터넷을 확인하고 다시 눌러 주세요", res.status().as_u16()));
        }
        let cut = "받다가 끊겼어요. 인터넷을 확인하고 다시 눌러 주세요";
        let mut out = std::fs::File::create(part).map_err(|e| io_error(e, cut))?;
        let mut body = res.into_body().into_reader();
        let mut hash = Sha256::new();
        let (mut got, mut shown) = (0u64, 0.0);
        let mut buf = vec![0u8; 1 << 16];
        loop {
            if STOP_DOWNLOAD.load(Ordering::Relaxed) {
                return Err("받기를 멈췄어요. 다시 누르면 처음부터 받아요".into());
            }
            let n = body.read(&mut buf).map_err(|_| cut.to_string())?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| io_error(e, cut))?;
            got += n as u64;
            if size > 0 && got as f64 / size as f64 - shown >= 0.01 {
                shown = got as f64 / size as f64;
                ENGINE.lock().unwrap().progress = Some(shown);
                emit(app);
            }
        }
        out.sync_all().map_err(|e| io_error(e, cut))?;
        let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if digest != sha {
            return Err("받은 파일이 맞지 않아요. 다시 받아 주세요".into());
        }
        // 라이선스 사본을 모델 옆에 (카나나 라이선스 3.1) — 못 받아도 설정의 링크로 볼 수 있어 모델은 넣는다
        if let Some(lic) = WEB.get(LICENSE_URL).call().ok().filter(|r| r.status().is_success()) {
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
fn start(app: &AppHandle) -> Result<(String, String), String> {
    let _one = STARTING.lock().unwrap();
    if let Some(s) = &ENGINE.lock().unwrap().server {
        return Ok((s.base.clone(), s.key.clone()));
    }
    let exe = server_path(app);
    if !exe.is_file() {
        return Err("이 PC에 AI 엔진이 없어요. 메모킹을 다시 설치해 주세요".into());
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

/// 메모 폴더의 메모들 (id, 본문) — 파일 이름 순 (HashMap 차례는 돌릴 때마다 달라 추천이 흔들리지 않게)
fn bodies(app: &AppHandle) -> Vec<(String, String)> {
    let st = app.state::<State>();
    let guard = st.vault.lock().unwrap();
    let mut list: Vec<(&str, String, String)> = guard.as_ref().map(|v| v.files().map(|e| (e.file.as_deref().unwrap_or_default(), e.id.clone(), e.body.clone())).collect()).unwrap_or_default();
    list.sort_by(|a, b| a.0.cmp(b.0));
    list.into_iter().map(|(_, id, body)| (id, body)).collect()
}

/// AI 로 태그 고르기 → 칩 목록
fn pick_tags(app: &AppHandle, body: &str, id: Option<&str>) -> Result<Vec<Value>, String> {
    let req = ai_tag_request(body, &bodies(app), id);
    let answer = chat(app, &req.messages, 80, 0.0, Some(&req.schema), &AtomicBool::new(false), None)?;
    Ok(ai_tag_result(&answer, &req.existing, body, &req.grounded))
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

/// AI 검색: 찾은 메모만 근거로 답 (물러서면 찾은 문장 그대로) → { text, sources, quoted }
// shortcut: 찾기 색인을 물을 때마다 새로 만든다 (메모 수천 개에 수백 ms), 느리다는 말이 나오면 ai-tasks.js 처럼 바뀐 메모만 다시
fn ask(app: &AppHandle, label: &str, id: &Value, question: &str, cancel: &AtomicBool) -> Result<Value, String> {
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
    let now = chrono::Local::now();
    let picked = retrieve(question, &build_index(chunks), &words, &|id| graph.get(id).cloned().unwrap_or_default(), 4, now);
    let sources: Vec<Value> = picked.iter().map(|m| json!({ "id": m.id, "title": m.title, "via": m.via })).collect();
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

// ---------- AI 태그 뒤처리 (ai-tagger.js) — 닫은 메모 · 설정의 "모든 메모" 를 하나씩 차례로 (모델이 하나라서) ----------
// shortcut: 글 속 일정 자동 등록(ai-events.js · aiEvents)은 아직 — 태그만. date-detect.js 를 옮길 때 tag_one 앞에

#[derive(Default)]
struct Tagger {
    queue: Vec<String>,
    running: bool,
    batch: Option<(Vec<String>, usize, usize)>, // (남은 것, done, total)
}

static TAGGER: LazyLock<Mutex<Tagger>> = LazyLock::new(Default::default);

fn batch_status() -> Value {
    TAGGER.lock().unwrap().batch.as_ref().map_or(Value::Null, |b| json!({ "done": b.1, "total": b.2 }))
}

fn tagging(app: &AppHandle, p: Value) {
    let _ = app.emit_to("list", "ai:tagging", [p]);
}

fn tagger_add(app: &AppHandle, ids: Vec<String>) {
    let mut t = TAGGER.lock().unwrap();
    for id in ids {
        if !t.queue.contains(&id) {
            t.queue.push(id);
        }
    }
    if t.running {
        return;
    }
    t.running = true;
    let app = app.clone();
    std::thread::spawn(move || {
        tagger_run(&app);
        TAGGER.lock().unwrap().running = false;
    });
}

fn tagger_run(app: &AppHandle) {
    let enabled = || app.state::<State>().setting("autoTags") != false;
    loop {
        let ready = model(app).is_file();
        let id = {
            let mut t = TAGGER.lock().unwrap();
            if t.queue.is_empty() || !enabled() || !ready {
                return;
            }
            t.queue.remove(0)
        };
        if let Err(err) = tag_one(app, &id) {
            // 모델이 멈춤 등 — 이 메모는 표시하지 않고(다음에 다시), 한꺼번에 하던 것은 멈춘다
            eprintln!("AI 태그 {err}");
            let mut t = TAGGER.lock().unwrap();
            let had = t.batch.take().is_some();
            t.queue.clear();
            drop(t);
            if had {
                tagging(app, json!({ "error": format!("AI 태그를 달지 못했어요: {err}") }));
            }
            return;
        }
        let mut t = TAGGER.lock().unwrap();
        let Some(b) = t.batch.as_mut() else { continue };
        let Some(i) = b.0.iter().position(|x| *x == id) else { continue };
        b.0.remove(i);
        b.1 += 1;
        if b.0.is_empty() {
            t.batch = None;
        }
        drop(t);
        tagging(app, batch_status());
    }
}

fn is_open(app: &AppHandle, id: &str) -> bool {
    app.state::<State>().note_labels.lock().unwrap().contains_key(id)
}

fn memo(app: &AppHandle, id: &str) -> Option<Value> {
    app.state::<State>().vault.lock().unwrap().as_ref().and_then(|v| v.get(id))
}

fn tag_one(app: &AppHandle, id: &str) -> Result<(), String> {
    let Some(m) = memo(app, id) else { return Ok(()) };
    let body = m["body"].as_str().unwrap_or_default().to_string();
    if m["locked"] == true || is_open(app, id) || memoking_core::body::is_blank_body(&body) || m["aiTags"].is_array() {
        return Ok(());
    }
    let room = MAX_TAGS.saturating_sub(memoking_core::body::extract_tags(&body).len());
    // 짧은 메모(인사 · 한 줄 대답)에는 저절로 달지 않는다 — 고를 주제가 없는데 억지로 채우던 것
    let plain: String = memoking_core::body::plain_lines(&body, usize::MAX).join("").chars().filter(|c| !memoking_core::js::is_space(*c)).collect();
    if room == 0 || plain.encode_utf16().count() < MIN_AI_TEXT {
        return Ok(());
    }
    let names: Vec<String> = pick_tags(app, &body, Some(id))?.into_iter().take(room).filter_map(|t| t["name"].as_str().map(str::to_string)).collect();
    // 그사이 고쳤거나 열었으면 건드리지 않는다 (다음에 닫을 때 다시)
    if memo(app, id).is_none_or(|now| now["body"] != body.as_str()) || is_open(app, id) {
        return Ok(());
    }
    let saved = app.state::<State>().vault.lock().unwrap().as_mut().map(|v| v.set_ai_tags(id, &append_tags(&body, &names), &names));
    if matches!(saved, Some(Ok(Some(_)))) {
        crate::memos::push_list(app);
    }
    Ok(())
}

/// 아직 보지 않은 모든 메모 → { done, total }
fn tag_all(app: &AppHandle) -> Value {
    let list = app.state::<State>().vault.lock().unwrap().as_ref().map(|v| v.list()).unwrap_or_default();
    let todo = |id: &str| {
        memo(app, id).is_some_and(|m| {
            let body = m["body"].as_str().unwrap_or_default();
            m["aiTags"].is_null() && m["locked"] != true && !memoking_core::body::is_blank_body(body) && memoking_core::body::extract_tags(body).len() < MAX_TAGS
        })
    };
    let ids: Vec<String> = list.iter().filter_map(|m| m["id"].as_str()).filter(|id| todo(id)).map(str::to_string).collect();
    let total = ids.len();
    TAGGER.lock().unwrap().batch = (total > 0).then(|| (ids.clone(), 0, total));
    tagging(app, batch_status());
    tagger_add(app, ids);
    json!({ "done": 0, "total": total })
}

fn tag_stop(app: &AppHandle) {
    let mut t = TAGGER.lock().unwrap();
    t.queue.clear();
    t.batch = None;
    drop(t);
    tagging(app, Value::Null);
}

/// AI 가 단 태그를 모든 메모에서 걷어 낸다 (다시 달지 않음) → 걷어 낸 메모 수. 열려 있는 메모는 건너뜀
fn tag_clear(app: &AppHandle) -> usize {
    tag_stop(app);
    let list = app.state::<State>().vault.lock().unwrap().as_ref().map(|v| v.list()).unwrap_or_default();
    let mut n = 0;
    for id in list.iter().filter_map(|m| m["id"].as_str()) {
        let Some(m) = memo(app, id) else { continue };
        let names: Vec<String> = m["aiTags"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(str::to_string)).collect();
        if names.is_empty() || m["locked"] == true || is_open(app, id) {
            continue;
        }
        let body = remove_tags(m["body"].as_str().unwrap_or_default(), &names);
        if matches!(app.state::<State>().vault.lock().unwrap().as_mut().map(|v| v.set_ai_tags(id, &body, &[])), Some(Ok(Some(_)))) {
            n += 1;
        }
    }
    if n > 0 {
        crate::memos::push_list(app);
    }
    n
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
        "tags:suggest" => Ok(json!(suggest_tags_for(s(0).unwrap_or_default(), &bodies(app), 3, s(1)))),
        "tags:auto" => Ok(json!(auto_tags_for(s(0).unwrap_or_default(), &bodies(app), s(1).unwrap_or_default(), s(2)))),
        "tags:ai" => Ok(pick_tags(app, s(0).unwrap_or_default(), s(1)).map_or_else(|e| json!({ "error": e }), |t| json!(t))),
        // 메모 창을 닫은 뒤: AI 가 고른 태그를 사용자 태그와 합쳐 3개까지 (설정 › 태그 자동 추가) — 창은 먼저 닫고 뒤에서
        "tags:ai-auto" => {
            tagger_add(app, vec![memoking_core::js::string(&arg)]);
            Ok(Value::Null)
        }
        "tags:ai-all" => Ok(tag_all(app)),
        "tags:ai-stop" => {
            tag_stop(app);
            Ok(Value::Null)
        }
        "tags:ai-clear" => Ok(tag_clear(app).into()),
        "tags:ai-status" => Ok(batch_status()),
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
