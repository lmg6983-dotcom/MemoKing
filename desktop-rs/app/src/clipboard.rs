// 클립보드 · 글 공유 채널 — desktop/ipc-handlers.js 의 clipboard:* · memo:copy-text · card:copy · card:share-file
use crate::state::State;
use memoking_core::share_text::hotkey_copy_text;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

// 메모 하나의 보내기용 글 (잠긴 메모 · 없는 메모는 None — 잠긴 글이 클립보드로 새지 않게)
fn memo_text(app: &AppHandle, id: &str) -> Option<(String, String)> {
    let st = app.state::<State>();
    let guard = st.vault.lock().unwrap();
    let m = guard.as_ref()?.get(id)?;
    (m["locked"] != true).then(|| (hotkey_copy_text(m["body"].as_str().unwrap_or_default()), m["title"].as_str().unwrap_or_default().to_string()))
}

pub fn handle(app: &AppHandle, _label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let arg = |i: usize| args.get(i).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string)).unwrap_or_default();
    let clip = app.clipboard();
    Some(match channel {
        "clipboard:write-text" => clip.write_text(arg(0)).map(|()| Value::Null).map_err(|e| e.to_string()),
        "clipboard:write-rich" => {
            let o = args.first().cloned().unwrap_or(Value::Null);
            let (text, html) = (o["text"].as_str().unwrap_or_default().to_string(), o["html"].as_str().unwrap_or_default().to_string());
            let r = if html.is_empty() { clip.write_text(text) } else { clip.write_html(html, Some(text)) };
            r.map(|()| true.into()).map_err(|e| e.to_string())
        }
        "memo:copy-text" | "card:copy" => Ok(memo_text(app, &arg(0)).is_some_and(|(text, _)| clip.write_text(text).is_ok()).into()),
        // 메모 공유: 글을 "제목.txt" 파일로 (공유 방법은 attachment:share 가 이어서)
        "card:share-file" => {
            use base64::Engine;
            let id = arg(0);
            let locked = app.state::<State>().vault.lock().unwrap().as_ref().and_then(|v| v.get(&id)).map(|m| m["locked"] == true);
            Ok(match (locked, memo_text(app, &id)) {
                (None, _) => json!({ "error": "메모를 다시 골라 주세요" }),
                (Some(true), _) => json!({ "error": "잠긴 메모는 잠금을 풀어야 공유할 수 있어요" }),
                (_, Some((text, _))) if text.trim().is_empty() => json!({ "error": "공유할 글이 없어요" }),
                (_, Some((text, title))) => {
                    let name: String = crate::memos::safe_name(if title.is_empty() { "메모" } else { &title }).chars().take(60).collect();
                    json!({ "base64": base64::engine::general_purpose::STANDARD.encode(text), "name": format!("{name}.txt"), "mime": "text/plain" })
                }
                _ => json!({ "error": "메모를 다시 골라 주세요" }),
            })
        }
        _ => return None,
    })
}
