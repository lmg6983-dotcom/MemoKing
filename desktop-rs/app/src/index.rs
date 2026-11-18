// 색인 _memoking/index.json — AI 비서 · 다른 앱이 읽는다 (desktop/vault.js writeIndex · putIndex).
//   메모가 바뀌면 표시만 해 두고(mark), 8초 동안 더 바뀌지 않으면 2초마다의 다시 읽기가 한 번에 쓴다 (JS: 바뀐 뒤 1.5초).
//   메모 폴더 잠금은 글을 복사하는 동안만 — 색인 만들기(메모 2,000개면 몇백 ms)는 잠금 밖에서 (JS 는 작업 스레드)
use crate::state::State;
use memoking_core::indexer::{index_key, index_output, IndexMemo, AGENT_GUIDE};
use memoking_core::vault::write_atomic;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static PENDING: AtomicBool = AtomicBool::new(true);
/// 마지막으로 바뀐 때 (앱을 켠 뒤 ms) — 쓰는 동안은 기다렸다가 멈추면 한 번에
static MARKED_AT: AtomicU64 = AtomicU64::new(0);
/// 바뀐 뒤 이만큼 조용하면 만든다 — 예전에는 쓰는 동안 2초마다 모든 메모 본문을 복사해 색인을 다시 만들었다 (메모리 · CPU)
const QUIET_MS: u64 = 8_000;
static START: std::sync::LazyLock<std::time::Instant> = std::sync::LazyLock::new(std::time::Instant::now);
fn now_ms() -> u64 {
    START.elapsed().as_millis() as u64
}
// 마지막으로 쓴 색인의 열쇠 (generatedAt 만 다르면 같은 색인 — Drive 가 매번 올리지 않게)
static KEY: Mutex<Option<String>> = Mutex::new(None);

pub fn mark() {
    MARKED_AT.store(now_ms(), Ordering::Relaxed);
    PENDING.store(true, Ordering::Relaxed);
}

/// 메모 폴더를 열 때: 안내 파일(README) 맞추기, 지난 색인의 열쇠 읽기
pub fn opened(root: &Path) {
    let guide = root.join("_memoking").join("README.md");
    if std::fs::read_to_string(&guide).ok().as_deref() != Some(AGENT_GUIDE) {
        let _ = write_atomic(&guide, AGENT_GUIDE.as_bytes());
    }
    let old = std::fs::read_to_string(root.join("_memoking").join("index.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    *KEY.lock().unwrap() = old.as_ref().map(index_key);
    mark();
}

/// 바뀐 것이 있으면 색인을 다시 만들어, 내용이 다를 때만 쓴다
pub fn tick(app: &AppHandle) {
    // 자동 점검(smoke)은 색인이 몇 초 안에 생기는지 본다 — 점검 때는 짧게
    let quiet = if crate::ipc::smoke() { 1_500 } else { QUIET_MS };
    if !PENDING.load(Ordering::Relaxed) || now_ms().saturating_sub(MARKED_AT.load(Ordering::Relaxed)) < quiet {
        return;
    }
    PENDING.store(false, Ordering::Relaxed);
    let copied = app.state::<State>().vault.lock().unwrap().as_ref().map(|v| {
        (v.root.clone(), v.files().map(|e| (e.id.clone(), e.file.clone().unwrap_or_default(), e.meta.clone(), e.body.clone())).collect::<Vec<_>>())
    });
    let Some((root, memos)) = copied else { return };
    let refs: Vec<IndexMemo> = memos.iter().map(|(id, file, meta, body)| IndexMemo { id, file, meta, body }).collect();
    let out = index_output(&refs, &chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
    let mut key = KEY.lock().unwrap();
    if key.as_deref() == Some(out.key.as_str()) {
        return;
    }
    match write_atomic(&root.join("_memoking").join("index.json"), out.text.as_bytes()) {
        Ok(()) => {
            *key = Some(out.key);
        }
        Err(err) => {
            elog!("색인을 쓰지 못했어요: {err}");
            mark(); // 다음에 다시
        }
    }
}
