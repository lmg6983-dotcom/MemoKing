// 받아쓰기 — Electron 의 desktop/stt (stt-service.js · stt-worker.js) 와 ipc-handlers.js 의 stt:* 자리.
//   데이터(모델)는 처음 한 번 받아 설정 폴더의 stt\ 에 둔다 (Electron 과 같은 곳 · 같은 파일). 메모 폴더(동기화)에는 넣지 않는다.
//     - 받아쓰기 (한국어, 약 80MB): 한국어 Zipformer(KsponSpeech) + 말소리 구간 나누기(Silero VAD)
//     - 말한 사람 나누기 (약 30MB, 켰을 때만): pyannote 구간 나누기 + CAM++ 목소리 특징
//   엔진은 sherpa-onnx (sherpa-rs, 인터넷 없이 이 PC 안에서만). 무거운 일은 받아쓰기 스레드 하나가 온 차례대로 한다 (Electron 작업 스레드처럼)
//     - 0.5초 쉬면 한 문장, 15초 넘게 이어지면 끊어서 구간마다 바로 받아쓴다 (녹음하는 동안 글이 나타남)
//     - 구간 앞뒤로 조금(0.3초 · 0.15초) 더 붙여 첫 글자가 잘리지 않게
//   받은 글 다듬기는 휴대폰과 같다: 이 메모 폴더의 낱말로 고치기 · 문장마다 줄 · 화자 이름표 (core transcript)
use crate::state::State;
use memoking_core::transcript::*;
use serde_json::{json, Value};
use sherpa_rs::diarize::{Diarize, DiarizeConfig};
use sherpa_rs::silero_vad::{SileroVad, SileroVadConfig};
use sherpa_rs::transducer::{TransducerConfig, TransducerRecognizer};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

macro_rules! gh {
    ($p:literal) => {
        concat!("https://github.com/k2-fsa/sherpa-onnx/releases/download/", $p)
    };
}
const HF: &str = "https://huggingface.co/k2-fsa/sherpa-onnx-zipformer-korean-2024-06-24/resolve/0fb4b2b5c8d3e5766121481ba911961e3649c664"; // 커밋 고정
const KO_FILES: &[(&str, &str)] =
    &[("encoder-epoch-99-avg-1.int8.onnx", "encoder.onnx"), ("decoder-epoch-99-avg-1.int8.onnx", "decoder.onnx"), ("joiner-epoch-99-avg-1.int8.onnx", "joiner.onnx"), ("tokens.txt", "tokens.txt")];

/// 받는 곳: base/이름 파일들, 또는 base/archive 압축에서 골라 (압축 안 이름의 끝 → 저장할 이름). bytes 는 진행률 무게
struct Source {
    base: &'static str,
    archive: Option<&'static str>,
    files: &'static [(&'static str, &'static str)],
    bytes: u64,
}

/// 묶음의 한 부분 — files: (이름, 크기, sha256). 크기는 있는지 볼 때(가볍게), sha256 은 다 받은 뒤 내용 확인. 받는 곳은 앞에서부터, 안 되면 다음
struct Part {
    dir: &'static str,
    files: &'static [(&'static str, u64, &'static str)],
    sources: &'static [Source],
}

const ASR: &[Part] = &[
    Part {
        dir: "ko",
        files: &[
            ("encoder.onnx", 70784728, "8b196d723421a0513c98ec25da2c43420c029e817f5e4a90b29ff80291c0af2b"),
            ("decoder.onnx", 2844692, "2cc8c04ea080a657c18ebc59702e6b049cef08163eba5d68ac5bf707925cb0fb"),
            ("joiner.onnx", 2581421, "eb654db1ea2cc9d63474855f65958b6059084692a9f2eb4f3812aceb1e416a20"),
            ("tokens.txt", 60246, "016bdf0965029263b7ad01b742366ee542ef0bef38261510e8176ff6f2e9e668"),
        ],
        sources: &[
            Source { base: HF, archive: None, files: KO_FILES, bytes: 76270000 },
            Source { base: gh!("asr-models"), archive: Some("sherpa-onnx-zipformer-korean-2024-06-24.tar.bz2"), files: KO_FILES, bytes: 329740690 },
        ],
    },
    Part {
        dir: "vad",
        files: &[("silero_vad.onnx", 643854, "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6")],
        sources: &[Source { base: gh!("asr-models"), archive: None, files: &[("silero_vad.onnx", "silero_vad.onnx")], bytes: 643854 }],
    },
];

const SPEAKER: &[Part] = &[
    Part {
        dir: "speaker",
        files: &[("segmentation.onnx", 1540506, "d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d")],
        sources: &[Source { base: gh!("speaker-segmentation-models"), archive: Some("sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"), files: &[("model.int8.onnx", "segmentation.onnx")], bytes: 6958444 }],
    },
    Part {
        dir: "speaker",
        files: &[("embedding.onnx", 28281138, "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11")],
        sources: &[Source { base: gh!("speaker-recongition-models"), archive: None, files: &[("3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx", "embedding.onnx")], bytes: 28281138 }],
    },
];

fn pack(name: &str) -> Option<(&'static [Part], &'static str)> {
    match name {
        "asr" => Some((ASR, "약 80MB")),
        "speaker" => Some((SPEAKER, "약 30MB")),
        _ => None,
    }
}

// 모델 받기 (받아쓰기 · AI): Electron net.fetch 처럼 시스템 프록시 · 인증서를 따른다
//   ureq 는 기본으로 시간 제한이 없어 연결이 멈추면 멈추기도 다음 받기도 안 되므로 연결 · 읽기마다 제한을 둔다
pub(crate) static WEB: LazyLock<ureq::Agent> =
    LazyLock::new(|| crate::files::web_config().http_status_as_error(false).timeout_connect(Some(Duration::from_secs(20))).timeout_per_read(Some(Duration::from_secs(60))).build().into());
static DOWNLOADS: LazyLock<Mutex<HashMap<String, (f64, String)>>> = LazyLock::new(Default::default); // 묶음 → (진행 0~1, 오류)

fn dir(app: &AppHandle) -> PathBuf {
    std::env::var_os("MEMOKING_STT_DIR").map_or_else(|| app.state::<State>().settings_dir.join("stt"), PathBuf::from)
}

fn part_ready(root: &Path, part: &Part) -> bool {
    part.files.iter().all(|(name, size, _)| std::fs::metadata(root.join(part.dir).join(name)).is_ok_and(|m| m.len() == *size))
}

fn ready(root: &Path, name: &str) -> bool {
    pack(name).is_some_and(|(parts, _)| parts.iter().all(|p| part_ready(root, p)))
}

/// 설정의 stt: 받아쓰기는 끄지 않았으면 켬, 말한 사람 나누기는 켰을 때만
fn options(app: &AppHandle) -> (bool, bool) {
    let o = app.state::<State>().setting("stt");
    (o["enabled"] != false, o["speaker"] == true)
}

fn status(app: &AppHandle) -> Value {
    let root = dir(app);
    let d = DOWNLOADS.lock().unwrap();
    let one = |name: &str| {
        let e = d.get(name);
        let state = if e.is_some_and(|e| e.1.is_empty()) {
            "downloading"
        } else if ready(&root, name) {
            "ready"
        } else {
            "missing"
        };
        json!({ "state": state, "progress": e.map_or(0.0, |e| e.0), "error": e.map_or("", |e| e.1.as_str()), "size": pack(name).unwrap().1 })
    };
    let (enabled, speaker) = options(app);
    json!({ "asr": one("asr"), "speaker": one("speaker"), "enabled": enabled, "speakerOn": speaker })
}

fn emit(app: &AppHandle) {
    let _ = app.emit("stt:status", [status(app)]);
}

// ---------- 받기 ----------

fn fetch_to(url: &str, file: &Path, on_bytes: &mut dyn FnMut(u64)) -> Result<(), String> {
    let offline = "받지 못했어요. 인터넷을 확인하고 다시 눌러 주세요";
    let res = WEB.get(url).call().map_err(|_| offline.to_string())?;
    if !res.status().is_success() {
        return Err(format!("받지 못했어요 ({}). 인터넷을 확인하고 다시 눌러 주세요", res.status().as_u16()));
    }
    let cut = |e: std::io::Error| if e.kind() == std::io::ErrorKind::StorageFull { "저장 공간이 모자라요".to_string() } else { "받다가 끊겼어요. 인터넷을 확인하고 다시 눌러 주세요".to_string() };
    let mut out = std::fs::File::create(file).map_err(cut)?;
    let mut body = res.into_body().into_reader();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = body.read(&mut buf).map_err(cut)?;
        if n == 0 {
            return out.sync_all().map_err(cut);
        }
        out.write_all(&buf[..n]).map_err(cut)?;
        on_bytes(n as u64);
    }
}

fn find(dir: &Path, tail: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        let hit = if p.is_dir() { find(&p, tail) } else { p.to_string_lossy().replace('\\', "/").ends_with(&format!("/{tail}")).then_some(p) };
        if hit.is_some() {
            return hit;
        }
    }
    None
}

/// .tar.bz2 에서 필요한 파일만 dest 로
///   shortcut: PC 의 tar 만 쓴다 (Windows 10 1803 부터 들어 있음, Electron 은 안 되면 JS 로 직접 풀었다) — tar 가 없는 PC 가 보이면 bzip2 · tar 크레이트로
fn extract(archive: &Path, tmp: &Path, dest: &Path, pick: &[(&str, &str)]) -> Result<(), String> {
    let out = tmp.join("x");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("tar");
    cmd.arg("-xjf").arg(archive).arg("-C").arg(&out);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    let _ = cmd.status();
    let found: Vec<_> = pick.iter().map(|(tail, to)| (*tail, *to, find(&out, tail))).collect();
    let missing: Vec<&str> = found.iter().filter(|f| f.2.is_none()).map(|f| f.0).collect();
    if !missing.is_empty() {
        return Err(format!("압축 안에 {} 이(가) 없어요", missing.join(", ")));
    }
    for (_, to, p) in found {
        std::fs::copy(p.unwrap(), dest.join(to)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sums_match(root: &Path, part: &Part) -> bool {
    use sha2::{Digest, Sha256};
    part.files.iter().all(|(name, _, sum)| {
        let mut hash = Sha256::new();
        std::fs::File::open(root.join(part.dir).join(name)).and_then(|mut f| std::io::copy(&mut f, &mut hash)).is_ok() && format!("{:x}", hash.finalize()) == *sum
    })
}

/// 한 부분 받기 — 받는 곳마다 임시 폴더에 받아 크기 · SHA-256 이 맞을 때만 넣는다
fn get_part(root: &Path, part: &Part, on_fraction: &mut dyn FnMut(f64)) -> Result<(), String> {
    let dest = root.join(part.dir);
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut last = None;
    for src in part.sources {
        // 이름을 고정해 두어 받다가 앱이 꺼져 남은 것도 다음에 지운다
        let tmp = root.join(format!(".part-{}", part.dir));
        let _ = std::fs::remove_dir_all(&tmp);
        let mut got = 0;
        let mut count = |n| {
            got += n;
            on_fraction((got as f64 / src.bytes as f64).min(1.0));
        };
        let r = std::fs::create_dir_all(&tmp).map_err(|e| e.to_string()).and_then(|_| {
            match src.archive {
                Some(name) => {
                    let archive = tmp.join("pack.tar.bz2");
                    fetch_to(&format!("{}/{name}", src.base), &archive, &mut count)?;
                    extract(&archive, &tmp, &dest, src.files)?;
                }
                None => {
                    for (from, to) in src.files {
                        fetch_to(&format!("{}/{from}", src.base), &tmp.join(to), &mut count)?;
                    }
                    for (_, to) in src.files {
                        let want = part.files.iter().find(|f| f.0 == *to).map(|f| f.1);
                        if want.is_some_and(|size| std::fs::metadata(tmp.join(to)).map_or(0, |m| m.len()) != size) {
                            return Err(format!("{to} 크기가 달라요"));
                        }
                    }
                    for (_, to) in src.files {
                        std::fs::rename(tmp.join(to), dest.join(to)).map_err(|e| e.to_string())?;
                    }
                }
            }
            if part_ready(root, part) && sums_match(root, part) {
                return Ok(());
            }
            for (name, _, _) in part.files {
                let _ = std::fs::remove_file(dest.join(name));
            }
            Err("받은 파일이 맞지 않아요. 다시 받아 주세요".into())
        });
        let _ = std::fs::remove_dir_all(&tmp);
        match r {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                on_fraction(0.0); // 다음 곳에서 처음부터
            }
        }
    }
    Err(last.unwrap_or_else(|| "받지 못했어요. 인터넷을 확인하고 다시 눌러 주세요".into()))
}

fn download(app: &AppHandle, name: &str) -> Result<Value, String> {
    let (parts, _) = pack(name).ok_or("모르는 데이터예요")?;
    {
        let mut d = DOWNLOADS.lock().unwrap();
        if d.get(name).is_some_and(|e| e.1.is_empty()) {
            drop(d);
            return Ok(status(app));
        }
        d.insert(name.into(), (0.0, String::new()));
    }
    emit(app);
    let root = dir(app);
    // 진행률: 부분마다 처음 받는 곳의 크기만큼 무게
    let todo: Vec<&Part> = parts.iter().filter(|p| !part_ready(&root, p)).collect();
    let total = todo.iter().map(|p| p.sources[0].bytes).sum::<u64>().max(1) as f64;
    let (mut before, mut shown) = (0.0, 0.0);
    let mut r = Ok(());
    for part in todo {
        let weight = part.sources[0].bytes as f64;
        r = get_part(&root, part, &mut |f| {
            let p = ((before + f * weight) / total).min(0.99);
            DOWNLOADS.lock().unwrap().insert(name.into(), (p, String::new()));
            if (p - shown).abs() >= 0.01 {
                shown = p;
                emit(app);
            }
        });
        if r.is_err() {
            break;
        }
        before += weight;
    }
    if let Err(e) = &r {
        DOWNLOADS.lock().unwrap().insert(name.into(), (0.0, e.clone()));
        emit(app);
    }
    DOWNLOADS.lock().unwrap().remove(name);
    r?;
    emit(app);
    Ok(status(app))
}

fn remove(app: &AppHandle, name: &str) -> Value {
    let root = dir(app);
    for part in pack(name).map_or(&[][..], |p| p.0) {
        for (file, _, _) in part.files {
            let _ = std::fs::remove_file(root.join(part.dir).join(file));
        }
    }
    emit(app);
    status(app)
}

// ---------- 받아쓰기 스레드 ----------

const RATE: usize = 16000;
const WINDOW: usize = 512; // VAD 가 한 번에 보는 소리 (32ms)
const PRE: usize = RATE * 3 / 10; // 구간 앞에 더 붙일 소리
const POST: usize = RATE * 15 / 100;
const KEEP: usize = RATE * 40; // 앞뒤를 붙이려고 기억해 두는 최근 소리
const IDLE: Duration = Duration::from_secs(3 * 60); // 쓰지 않으면 모델을 내려 메모리(약 300MB)를 돌려준다

enum Msg {
    Start { key: String, label: String, id: Value, asr: PathBuf, vad: PathBuf, speaker: Option<PathBuf> },
    Audio { key: String, samples: Vec<f32> },
    /// 끝내기 → { text, lines, speakers } (memo · src: 말한 사람 나누기가 끝나면 고칠 음성 카드)
    Stop { key: String, memo: String, src: String, reply: Sender<Value> },
    /// 창이 닫혔다 — 그 창의 받아쓰기를 모두 거둔다
    Close { label: String },
}

struct Session {
    vad: SileroVad,
    cond: SpeechConditioner,
    pending: Vec<f32>,
    hist: VecDeque<(usize, Vec<f32>)>, // (절대 위치, 다듬은 소리)
    fed: usize,
    last_end: usize,
    raw: Vec<i16>, // 말한 사람 나누기용 원래 소리 (켰을 때만)
    lines: Vec<Line>,
    speaking: bool,
    label: String,
    id: Value,
    asr: PathBuf,
    speaker: Option<PathBuf>,
}

#[derive(Default)]
struct Models {
    rec: Option<(PathBuf, TransducerRecognizer)>,
    sd: Option<(PathBuf, Diarize)>,
}

impl Models {
    fn recognizer(&mut self, dir: &Path) -> Result<&mut TransducerRecognizer, String> {
        if self.rec.as_ref().is_none_or(|r| r.0 != dir) {
            self.rec = None;
            let p = |f: &str| dir.join(f).to_string_lossy().into_owned();
            let config = TransducerConfig {
                encoder: p("encoder.onnx"),
                decoder: p("decoder.onnx"),
                joiner: p("joiner.onnx"),
                tokens: p("tokens.txt"),
                sample_rate: RATE as i32,
                feature_dim: 80,
                decoding_method: "greedy_search".into(),
                ..Default::default()
            };
            self.rec = Some((dir.to_path_buf(), TransducerRecognizer::new(config).map_err(|e| e.to_string())?));
        }
        Ok(&mut self.rec.as_mut().unwrap().1)
    }

    fn diarizer(&mut self, dir: &Path) -> Result<&mut Diarize, String> {
        if self.sd.as_ref().is_none_or(|d| d.0 != dir) {
            self.sd = None;
            let config = DiarizeConfig { num_clusters: Some(-1), threshold: Some(0.5), min_duration_on: Some(0.2), min_duration_off: Some(0.5), ..Default::default() };
            self.sd = Some((dir.to_path_buf(), Diarize::new(dir.join("segmentation.onnx"), dir.join("embedding.onnx"), config).map_err(|e| e.to_string())?));
        }
        Ok(&mut self.sd.as_mut().unwrap().1)
    }
}

static WORKER: Mutex<Option<Sender<Msg>>> = Mutex::new(None);

fn send(app: &AppHandle, msg: Msg) {
    let mut tx = WORKER.lock().unwrap();
    // 스레드가 없거나 멈췄으면 새로
    let msg = match tx.as_ref() {
        Some(t) => match t.send(msg) {
            Ok(()) => return,
            Err(e) => e.0,
        },
        None => msg,
    };
    let (t, rx) = mpsc::channel();
    let app = app.clone();
    std::thread::spawn(move || {
        let (mut models, mut sessions) = (Models::default(), HashMap::new());
        loop {
            match rx.recv_timeout(IDLE) {
                Ok(m) => run(&app, &mut models, &mut sessions, m),
                Err(RecvTimeoutError::Timeout) if sessions.is_empty() => models = Models::default(),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    let _ = t.send(msg);
    *tx = Some(t);
}

fn run(app: &AppHandle, models: &mut Models, sessions: &mut HashMap<String, Session>, msg: Msg) {
    match msg {
        Msg::Start { key, label, id, asr, vad, speaker } => {
            sessions.remove(&key);
            let config = SileroVadConfig {
                model: vad.join("silero_vad.onnx").to_string_lossy().into_owned(),
                threshold: 0.5,
                min_silence_duration: 0.5,
                min_speech_duration: 0.25,
                max_speech_duration: 15.0,
                sample_rate: RATE as u32,
                window_size: WINDOW as i32,
                ..Default::default()
            };
            // 첫 구간에서 기다리지 않게 받아쓰기 모델을 미리
            match models.recognizer(&asr).and_then(|_| SileroVad::new(config, 60.0).map_err(|e| e.to_string())) {
                Ok(vad) => {
                    let s = Session { vad, cond: SpeechConditioner::new(RATE as f64), pending: vec![], hist: VecDeque::new(), fed: 0, last_end: 0, raw: vec![], lines: vec![], speaking: false, label, id, asr, speaker };
                    sessions.insert(key, s);
                }
                Err(e) => eprintln!("받아쓰기를 시작하지 못했어요: {e}"),
            }
        }
        Msg::Audio { key, samples } => {
            if let Some(s) = sessions.get_mut(&key) {
                feed(app, models, s, samples);
            }
        }
        Msg::Stop { key, memo, src, reply } => {
            let Some(mut s) = sessions.remove(&key) else {
                let _ = reply.send(json!({ "text": "", "lines": 0, "speakers": false }));
                return;
            };
            // 남은 소리까지
            if !s.pending.is_empty() {
                let mut tail = vec![0.0; WINDOW];
                let n = s.pending.len().min(WINDOW);
                tail[..n].copy_from_slice(&s.pending[..n]);
                s.vad.accept_waveform(tail);
            }
            s.vad.flush();
            drain(app, models, &mut s);
            let speakers = s.speaker.is_some() && !s.lines.is_empty() && s.raw.len() > RATE * 2;
            let _ = reply.send(json!({ "text": polish(app, &join_transcript(&s.lines)), "lines": s.lines.len(), "speakers": speakers }));
            let Some(dir) = s.speaker.filter(|_| speakers) else { return };
            let samples = s.raw.iter().map(|v| f32::from(*v) / 32768.0).collect();
            match models.diarizer(&dir).and_then(|d| d.compute(samples, None).map_err(|e| e.to_string())) {
                Ok(segs) => {
                    let segs: Vec<(f64, f64, i64)> = segs.iter().map(|g| (f64::from(g.start), f64::from(g.end), i64::from(g.speaker))).collect();
                    let text = polish(app, &join_transcript(&label_speakers(&s.lines, &segs)));
                    if !memo.is_empty() && !src.is_empty() {
                        put_speakers(app, &memo, &src, &text);
                    }
                }
                Err(e) => eprintln!("받아쓰기: 말한 사람 나누기 {e}"),
            }
        }
        Msg::Close { label } => sessions.retain(|_, s| s.label != label),
    }
}

fn feed(app: &AppHandle, models: &mut Models, s: &mut Session, mut chunk: Vec<f32>) {
    if s.speaker.is_some() {
        s.raw.extend(chunk.iter().map(|v| (v * 32767.0).round().clamp(-32768.0, 32767.0) as i16));
    }
    s.cond.process(&mut chunk);
    s.hist.push_back((s.fed, chunk.clone()));
    s.fed += chunk.len();
    while s.hist.len() > 1 && s.hist[1].0 + KEEP < s.fed {
        s.hist.pop_front();
    }
    s.pending.extend(chunk);
    let n = s.pending.len() / WINDOW * WINDOW;
    for w in s.pending[..n].chunks(WINDOW) {
        s.vad.accept_waveform(w.to_vec());
    }
    s.pending.drain(..n);
    drain(app, models, s);
}

/// VAD 가 끊어 둔 구간들을 받아쓴다 → 줄
fn drain(app: &AppHandle, models: &mut Models, s: &mut Session) {
    while !s.vad.is_empty() {
        let seg = s.vad.front();
        s.vad.pop();
        let start = seg.start.max(0) as usize;
        let end = start + seg.samples.len();
        let from = start.saturating_sub(PRE).max(s.last_end).max(s.fed.saturating_sub(KEEP));
        let to = (end + POST).min(s.fed);
        s.last_end = end;
        let samples = if from < start || to > end { slice(s, from, to) } else { seg.samples };
        let text = match models.recognizer(&s.asr) {
            Ok(rec) => memoking_core::js::trim(&rec.transcribe(RATE as u32, &samples)).to_string(),
            Err(e) => {
                eprintln!("받아쓰기: {e}");
                continue;
            }
        };
        // 받아쓴 글이 문장부호 · 군말 하나뿐이면 버린다
        if !text.chars().any(char::is_alphanumeric) {
            continue;
        }
        s.lines.push(Line { text: text.clone(), start: start as f64 / RATE as f64, end: end as f64 / RATE as f64, speaker: 0 });
        let _ = app.emit_to(s.label.as_str(), "stt:line", [json!({ "id": s.id, "text": text })]);
    }
    let speaking = s.vad.is_speech();
    if speaking != s.speaking {
        s.speaking = speaking;
        let _ = app.emit_to(s.label.as_str(), "stt:speaking", [json!({ "id": s.id, "on": speaking })]);
    }
}

/// 기억해 둔 소리에서 [from, to) 를 꺼낸다 (절대 위치, 표본 단위)
fn slice(s: &Session, from: usize, to: usize) -> Vec<f32> {
    let mut out = vec![0.0; to.saturating_sub(from)];
    for (at, data) in &s.hist {
        let (a, b) = (from.max(*at), to.min(at + data.len()));
        if a < b {
            out[a - from..b - from].copy_from_slice(&data[a - at..b - at]);
        }
    }
    out
}

/// 이 메모 폴더의 낱말로 받아쓴 글 다듬기
fn polish(app: &AppHandle, text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let memos: Vec<(String, String)> = app.state::<State>().vault.lock().unwrap().as_ref().map(|v| v.files().map(|e| (String::new(), e.body.clone())).collect()).unwrap_or_default();
    fix_transcript(text, &vocabulary_from(&memos, 120))
}

/// 말한 사람을 나눈 글을 음성 카드에 — 메모 창이 열려 있으면 창이 고치고, 닫혔으면 여기서 메모 파일을
fn put_speakers(app: &AppHandle, memo: &str, src: &str, text: &str) {
    let st = app.state::<State>();
    let label = st.note_labels.lock().unwrap().get(memo).cloned();
    let mut guard = st.vault.lock().unwrap();
    let Some(v) = guard.as_mut() else { return };
    let Some(m) = v.get(memo) else { return };
    // shortcut: 창을 닫아 다시 잠긴 메모에는 넣지 못한다 (Electron 은 30분 열쇠를 들고 있었다) — 잠긴 메모 녹음이 잦으면 memos.rs 의 창 닫기에서 열쇠를 남겨 두게
    if m["needsPassword"] == true {
        return;
    }
    if let Some(label) = label {
        drop(guard);
        let _ = app.emit_to(label.as_str(), "stt:speakers", [json!({ "src": src, "text": text })]);
        return;
    }
    let body = m["body"].as_str().unwrap_or_default();
    let Some(next) = replace_transcript(body, src, text).filter(|n| n != body) else { return };
    let saved = v.save(memo, &next).is_ok();
    drop(guard);
    if saved {
        crate::memos::push_list(app);
    }
}

fn start(app: &AppHandle, label: &str, id: Value) -> Value {
    let (enabled, speaker_on) = options(app);
    let root = dir(app);
    if !enabled {
        return json!({ "stt": false, "reason": "off" });
    }
    if !ready(&root, "asr") {
        return json!({ "stt": false, "reason": "missing" });
    }
    let speaker = (speaker_on && ready(&root, "speaker")).then(|| root.join("speaker"));
    // 창이 닫히면 그 창의 받아쓰기를 거둔다 (창마다 한 번 단다)
    static WATCHED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    if WATCHED.lock().unwrap().get_or_insert_with(HashSet::new).insert(label.to_string()) {
        if let Some(w) = app.get_webview_window(label) {
            let (app2, label2) = (app.clone(), label.to_string());
            w.on_window_event(move |e| {
                if let WindowEvent::Destroyed = e {
                    WATCHED.lock().unwrap().get_or_insert_with(HashSet::new).remove(&label2);
                    send(&app2, Msg::Close { label: label2.clone() });
                }
            });
        }
    }
    let has_speaker = speaker.is_some();
    send(app, Msg::Start { key: key(label, &id), label: label.into(), id, asr: root.join("ko"), vad: root.join("vad"), speaker });
    json!({ "stt": true, "speaker": has_speaker })
}

fn key(label: &str, id: &Value) -> String {
    format!("{label}:{}", memoking_core::js::string(id))
}

pub fn handle(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
    let s = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default();
    Some(Ok(match channel {
        "stt:status" => status(app),
        "stt:download" => download(app, s(0)).unwrap_or_else(|e| {
            let mut st = status(app);
            st["error"] = e.into();
            st
        }),
        "stt:remove" => remove(app, s(0)),
        "stt:options" => {
            let (enabled, speaker) = options(app);
            let mut next = json!({ "enabled": enabled, "speaker": speaker });
            for (k, v) in arg(0).as_object().into_iter().flatten() {
                next[k] = v.clone();
            }
            app.state::<State>().set_setting("stt", next);
            emit(app);
            status(app)
        }
        "stt:start" => start(app, label, arg(0)),
        // 0.1초마다 오는 16kHz Float32 조각 ({ $bytes } 로 감싼 리틀 엔디언)
        "stt:audio" => {
            use base64::Engine;
            let bytes = arg(1)["$bytes"].as_str().and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
            if let Some(b) = bytes {
                let samples = b.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
                send(app, Msg::Audio { key: key(label, &arg(0)), samples });
            }
            Value::Null
        }
        "stt:stop" => {
            let target = arg(1);
            let (reply, rx) = mpsc::channel();
            send(app, Msg::Stop { key: key(label, &arg(0)), memo: target["memoId"].as_str().unwrap_or_default().into(), src: target["src"].as_str().unwrap_or_default().into(), reply });
            rx.recv().unwrap_or_else(|_| json!({ "text": "", "error": "받아쓰기가 멈췄어요" }))
        }
        _ => return None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 실제로 받아 본다 (인터넷 · tar 필요): cargo test -p memoking stt -- --ignored
    #[test]
    #[ignore]
    fn downloads_and_checks_parts() {
        let root = std::env::temp_dir().join(format!("memoking-stt-{}", std::process::id()));
        for part in [&ASR[1], &SPEAKER[0]] {
            get_part(&root, part, &mut |_| {}).unwrap();
            assert!(part_ready(&root, part) && sums_match(&root, part));
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
