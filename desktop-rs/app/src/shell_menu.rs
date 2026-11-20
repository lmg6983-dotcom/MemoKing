//! 탐색기 오른쪽 클릭 › "메모킹에 저장" — 메모킹이 다루는 파일(문서 · 그림 · 소리 · 동영상 · 글)을 새 메모로.
//!   메뉴는 켤 때마다 이 사용자 레지스트리(HKCU\Software\Classes\*\shell)에 적는다 — 설치 경로가 바뀌어도 맞고, 한글 메뉴 이름이
//!   설치 스크립트에서 깨지지 않게. 지우기는 설치 파일의 지우개가 (installer-hooks.nsh NSIS_HOOK_PREUNINSTALL)
//!   shortcut: Windows 11 은 이 메뉴를 "추가 옵션 표시"(Shift+오른쪽 클릭) 안에 둔다 — 첫 화면에 두려면 코드 서명한 sparse 패키지 + IExplorerCommand
//!   여러 파일을 고르면 Windows 가 파일마다 메모킹을 따로 부른다 → 잠깐(SAVE_GATHER) 모아 한 메모로 (save_file)
use crate::state::state;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

/// 메뉴를 보일 파일 (app/js/media.js mediaKind · core/file-kinds.js 문서 · 글) — 프로그램 · 압축 파일은 빼고
#[cfg_attr(not(windows), allow(dead_code))]
const EXTS: [&str; 41] = [
    "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "hwp", "hwpx", "txt", "md", "rtf", "odt", "odp", "ods", "csv", // 문서 · 글
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", // 그림
    "mp3", "m4a", "wav", "ogg", "oga", "opus", "aac", "flac", "weba", // 소리
    "mp4", "m4v", "mov", "ogv", "mkv", "webm", "3gp", // 동영상
];
#[cfg_attr(not(windows), allow(dead_code))]
const KEY: &str = r"Software\Classes\*\shell\MemoKing.Save";
const MAX_BYTES: u64 = 1024 * 1024 * 1024; // 1GB 넘는 파일은 메모에 넣지 않는다 (메모 폴더 · 동기화가 버겁다)
const SAVE_GATHER: Duration = Duration::from_millis(700);

/// 켤 때: 이 메모킹(exe)을 부르는 메뉴를 적는다
#[cfg(windows)]
pub fn register() {
    use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.display().to_string();
    let applies = EXTS.iter().map(|e| format!("System.FileExtension:=.{e}")).collect::<Vec<_>>().join(" OR ");
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let set = |sub: &str, name: Option<&str>, value: &str| {
        let (sub, value) = (wide(sub), wide(value));
        let name = name.map(wide);
        // SAFETY: 끝이 0 인 UTF-16 글자들 — 함수가 읽는 동안 살아 있다
        unsafe {
            RegSetKeyValueW(HKEY_CURRENT_USER, sub.as_ptr(), name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()), REG_SZ, value.as_ptr().cast(), (value.len() * 2) as u32);
        }
    };
    set(KEY, Some("MUIVerb"), "메모킹에 저장");
    set(KEY, Some("Icon"), &format!("\"{exe}\",0"));
    set(KEY, Some("AppliesTo"), &applies);
    set(KEY, Some("MultiSelectModel"), "Player"); // 여러 개를 골라도 메뉴가 보이게 (기본은 15개까지)
    set(&format!(r"{KEY}\command"), None, &format!("\"{exe}\" --save-file \"%1\""));
}

#[cfg(not(windows))]
pub fn register() {}

static GATHERED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
static GEN: AtomicU64 = AtomicU64::new(0);

/// 오른쪽 클릭으로 온 파일 하나 (--save-file "경로") — 잠깐 모았다가 한 메모로
pub fn save_file(app: &AppHandle, path: PathBuf) {
    GATHERED.lock().unwrap().push(path);
    let n = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_GATHER);
        if GEN.load(Ordering::SeqCst) == n {
            let files = std::mem::take(&mut *GATHERED.lock().unwrap());
            save_files(&app, files);
        }
    });
}

/// 파일들을 첨부로 넣은 새 메모를 만들고 연다 — 넣기는 메모 창에 끌어 놓을 때와 같게 (문서는 칩 + PDF 첫 쪽, 그림이 여럿이면 묶음을 묻는다)
fn save_files(app: &AppHandle, mut files: Vec<PathBuf>) {
    files.dedup();
    let mut items: Vec<Value> = vec![];
    let mut names: Vec<String> = vec![];
    for f in files.iter().filter(|f| std::fs::metadata(f).is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES)) {
        let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = f.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        let Ok(bytes) = std::fs::read(f) else { continue };
        let Some(Ok(rel)) = state(app).vault.lock().unwrap().as_ref().map(|v| v.save_attachment(&bytes, &ext)) else { continue };
        let base = name.rsplit_once('.').map_or(name.as_str(), |(b, _)| b).trim().to_string();
        items.push(match media_kind(&ext) {
            "file" => json!({ "kind": "file", "src": rel, "name": name }),
            kind => json!({ "kind": kind, "src": rel, "alt": if kind == "video" { format!("동영상 {base}") } else { base.clone() } }),
        });
        names.push(base);
    }
    let missed = files.len() - items.len();
    if items.is_empty() {
        crate::reminders::toast(app, "", "메모킹에 넣지 못했어요", "파일을 읽지 못했거나 너무 커요 (1GB 넘음)", "", None);
        return;
    }
    let title = if names.len() == 1 { names[0].clone() } else { format!("{} 외 {}개", names[0], names.len() - 1) };
    let body = format!("# {}\n", escape(if title.is_empty() { "가져온 파일" } else { &title }));
    let Some(Ok(Some(id))) = state(app).vault.lock().unwrap().as_mut().map(|v| v.import(&body, None)) else { return };
    if missed > 0 {
        elog!("[메모킹에 저장] {missed}개는 읽지 못했거나 너무 커서 빼고 넣었어요");
    }
    state(app).inserts.lock().unwrap().insert(id.clone(), Value::Array(items));
    crate::memos::push_list(app);
    let _ = crate::memos::open_note(app, &id);
}

/// app/js/media.js mediaKind 의 확장자 규칙
fn media_kind(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" => "image",
        "weba" | "ogg" | "oga" | "opus" | "mp3" | "m4a" | "aac" | "wav" | "flac" => "audio",
        "mp4" | "m4v" | "mov" | "ogv" | "mkv" | "webm" => "video",
        _ => "file",
    }
}

/// 제목에서 마크다운으로 읽힐 기호를 글자로 (core/file-memo.js esc)
fn escape(s: &str) -> String {
    s.chars().fold(String::new(), |mut out, c| {
        if "\\[]*_`#<>|".contains(c) {
            out.push('\\');
        }
        out.push(c);
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_titles() {
        assert_eq!(media_kind("png"), "image");
        assert_eq!(media_kind("m4a"), "audio");
        assert_eq!(media_kind("mov"), "video");
        assert_eq!(media_kind("docx"), "file");
        assert_eq!(media_kind("heic"), "file", "브라우저가 못 그리는 그림은 파일 칩으로 (media.js 와 같게)");
        assert_eq!(escape("보고서_최종 #1"), "보고서\\_최종 \\#1");
        assert!(EXTS.iter().all(|e| e.chars().all(|c| c.is_ascii_alphanumeric())));
    }
}
