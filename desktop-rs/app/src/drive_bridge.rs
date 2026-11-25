// PC 다리 — Google Drive 데스크탑 앱이 받아 둔 메모킹 동기화 폴더(G:\내 드라이브\메모킹 동기화)에서,
//   메모킹이 Drive 에서 볼 수 없는 메모(Gemini 등 다른 앱이 새로 만든 .md)를 찾아 메모킹 메모로 가져오고 원래 파일은 지운다(Drive 휴지통).
//   메모킹은 drive.file 권한이라 다른 앱이 만든 파일이 보이지 않는다 — 받은 메모 빈 칸(core/inbox.rs)을 쓰지 않고 AI 가 새 파일을 만든 때의 안전망.
//   잘못 지우지 않게: ① 동기화 기록에 없고 ② 방금 Drive 에 물어 메모킹 눈에 없는 것만, 다 받은 지 30초 지난 것만.
//   머리말 id 가 메모킹 메모와 같으면 새 메모가 아니라 그 메모를 고친 것 — 그 메모에 이어 쓴다 (휴지통에 갔으면 되살려)
use crate::memos::{push_list, with_vault};
use memoking_core::drive_sync::{skip_path, Remote};
use memoking_core::memo_file::{folder_of, parse_memo_file};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

const SETTLE: Duration = Duration::from_secs(30);

/// 이 PC 에서 Google Drive 데스크탑 앱이 보여 주는 그 Drive 폴더 (내 드라이브 바로 아래만 — "메모킹 동기화" 가 거기 있다)
///   스트리밍 방식은 드라이브 문자(G:\내 드라이브), 미러링 방식은 사용자 폴더(C:\Users\…\내 드라이브)
///   찾은 답은 5분 기억한다 — 동기화(10초마다)마다 A: ~ Z: 를 훑으면 끊긴 네트워크 드라이브에서 몇 초씩 멈춘다
pub fn mirror_of(folder_name: &str) -> Option<PathBuf> {
    static FOUND: std::sync::Mutex<Option<(std::time::Instant, String, Option<PathBuf>)>> = std::sync::Mutex::new(None);
    if !cfg!(windows) || folder_name.is_empty() {
        return None;
    }
    if let Some((at, name, found)) = FOUND.lock().unwrap().as_ref() {
        if name == folder_name && at.elapsed() < Duration::from_secs(5 * 60) {
            return found.clone();
        }
    }
    let mut roots: Vec<PathBuf> = ('A'..='Z').map(|l| PathBuf::from(format!("{l}:\\"))).collect();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        roots.push(PathBuf::from(home));
    }
    let found = roots.iter().flat_map(|r| ["내 드라이브", "My Drive"].map(|d| r.join(d).join(folder_name))).find(|p| p.is_dir());
    *FOUND.lock().unwrap() = Some((std::time::Instant::now(), folder_name.into(), found.clone()));
    found
}

/// 폴더 안의 .md (메모킹 폴더 기준 경로 · 고친 때) — _memoking · 첨부 · 임시 파일은 빼고
fn mirror_memos(dir: &Path, rel: &str, out: &mut Vec<(String, SystemTime)>) {
    let Ok(items) = std::fs::read_dir(dir) else { return };
    for it in items.flatten() {
        let name = it.file_name().to_string_lossy().into_owned();
        let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if skip_path(&r) || (rel.is_empty() && matches!(name.to_lowercase().as_str(), "_memoking" | "attachments")) {
            continue;
        }
        let Ok(t) = it.file_type() else { continue };
        if t.is_dir() {
            mirror_memos(&it.path(), &r, out);
        } else if t.is_file() && name.to_lowercase().ends_with(".md") {
            if let Ok(m) = it.metadata().and_then(|m| m.modified()) {
                out.push((r, m));
            }
        }
    }
}

/// 가져올 후보: 동기화 기록(known)에 없고 다 받은 지 SETTLE 지난 것
pub fn candidates(found: &[(String, SystemTime)], known: &HashSet<String>, now: SystemTime) -> Vec<String> {
    found.iter().filter(|(rel, at)| !known.contains(rel) && now.duration_since(*at).is_ok_and(|d| d >= SETTLE)).map(|(rel, _)| rel.clone()).collect()
}

/// 메모킹이 Drive 에서 볼 수 있는 파일들 (폴더 기준 경로) — 지금 물어 본다
fn visible(remote: &dyn Remote, folder_id: &str, rel: &str, out: &mut HashSet<String>) -> std::io::Result<()> {
    for it in remote.list_children(folder_id)? {
        let r = if rel.is_empty() { it.name.clone() } else { format!("{rel}/{}", it.name) };
        if it.folder {
            visible(remote, &it.id, &r, out)?;
        } else {
            out.insert(r);
        }
    }
    Ok(())
}

/// 동기화를 한 번 마친 뒤 (drive.rs) — known: 동기화 기록의 경로들
pub fn run(app: &AppHandle, remote: &dyn Remote, folder_id: &str, folder_name: &str, known: &HashSet<String>) {
    let Some(mirror) = mirror_of(folder_name) else { return };
    let mut found = vec![];
    mirror_memos(&mirror, "", &mut found);
    // 받은 메모 폴더에 빈 칸을 덮어쓰지 않고 새로 만든 파일("빈 메모 007 (1).md" 등)도 — 빈 칸 이름 그대로인 것은 메모킹 칸
    let inbox = format!("{}/", memoking_core::inbox::INBOX_DIR);
    let mut extra = vec![];
    mirror_memos(&mirror.join(memoking_core::inbox::INBOX_DIR.replace('/', "\\")), memoking_core::inbox::INBOX_DIR, &mut extra);
    let slot = |rel: &str| rel.strip_prefix(inbox.as_str()).is_some_and(|n| (1..=memoking_core::inbox::INBOX_SLOTS).any(|i| memoking_core::inbox::slot_name(i) == n));
    found.extend(extra.into_iter().filter(|(rel, _)| !slot(rel)));
    let picks = candidates(&found, known, SystemTime::now());
    if picks.is_empty() {
        return;
    }
    let mut seen = HashSet::new();
    if visible(remote, folder_id, "", &mut seen).is_err() {
        return; // 못 물어보면 아무것도 하지 않는다
    }
    let mut made = 0;
    for rel in picks.into_iter().filter(|r| !seen.contains(r)) {
        let file = mirror.join(rel.replace('/', "\\"));
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let (meta, body) = parse_memo_file(&text);
        if body.trim().is_empty() {
            continue;
        }
        let folder = if rel.starts_with("_memoking/") { String::new() } else { folder_of(&rel).to_string() }; // 받은 메모 폴더의 것은 맨 위로
        let done = with_vault(app, |v| {
            // 같은 id 의 메모가 있으면(다른 앱이 지우고 새로 만들어 고쳤다) 그 메모에 이어 쓴다 — 휴지통에 갔으면 되살려서 (vault/inbox.rs relink)
            if let Some(id) = meta.id.as_deref() {
                if v.relink(id, &body).map_err(|e| e.to_string())?.is_some() {
                    return Ok(true);
                }
            }
            // 같은 글이 이미 있으면 가져온 것으로
            if v.files().any(|e| e.body.trim() == body.trim()) {
                return Ok(true);
            }
            let id = v.create(Some(&meta.color), None, &folder);
            v.save(&id, body.trim()).map(|(s, _)| s["refused"] != true).map_err(|e| e.to_string())
        });
        if done == Ok(true) && std::fs::remove_file(&file).is_ok() {
            made += 1; // Drive 데스크탑 앱이 원래 파일을 Drive 휴지통으로
        }
    }
    if made > 0 {
        push_list(app);
        let _ = app.emit_to("list", "inbox:taken", [made]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_unknown_settled_files() {
        let now = SystemTime::now();
        let old = now - Duration::from_secs(60);
        let found = vec![("a.md".into(), old), ("업무/b.md".into(), old), ("c.md".into(), now)];
        let known: HashSet<String> = ["a.md".to_string()].into();
        assert_eq!(candidates(&found, &known, now), vec!["업무/b.md".to_string()]);
    }
}
