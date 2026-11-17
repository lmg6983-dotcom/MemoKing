// 태그 추천 · AI — Electron 의 ipc-handlers.js (tags:* · ai:*) 와 desktop/ai/ 자리.
use crate::state::State;
use memoking_core::tag_suggest::{auto_tags_for, suggest_tags_for};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// 메모 폴더의 메모들 (id, 본문) — 파일 이름 순 (HashMap 차례는 돌릴 때마다 달라 추천이 흔들리지 않게)
fn bodies(app: &AppHandle) -> Vec<(String, String)> {
    let st = app.state::<State>();
    let guard = st.vault.lock().unwrap();
    let mut list: Vec<(&str, String, String)> = guard.as_ref().map(|v| v.files().map(|e| (e.file.as_deref().unwrap_or_default(), e.id.clone(), e.body.clone())).collect()).unwrap_or_default();
    list.sort_by(|a, b| a.0.cmp(b.0));
    list.into_iter().map(|(_, id, body)| (id, body)).collect()
}

pub fn handle(app: &AppHandle, _label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let s = |i: usize| args.get(i).and_then(Value::as_str);
    Some(match channel {
        "tags:suggest" => Ok(json!(suggest_tags_for(s(0).unwrap_or_default(), &bodies(app), 3, s(1)))),
        "tags:auto" => Ok(json!(auto_tags_for(s(0).unwrap_or_default(), &bodies(app), s(1).unwrap_or_default(), s(2)))),
        _ => return None,
    })
}
