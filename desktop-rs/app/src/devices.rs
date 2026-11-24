// 기기 상태 파일 (_memoking/기기/<이 PC> (<id>).md — core/src/devices.rs): 동기화를 마칠 때마다 적고(바뀐 것이 있거나 5분마다),
//   다른 기기 파일을 읽어 설정의 Google Drive 칸에 보여 주고, 받은 메모 빈 칸을 이 PC 가 옮길 차례인지 정한다
use crate::state::state;
use memoking_core::devices::{device_file, device_text, inbox_leader, needs_write, parse_device, Device, DEVICES_DIR};
use memoking_core::time::now_ms;
use memoking_core::vault::write_atomic;
use serde_json::{json, Value};
use std::path::Path;
use tauri::AppHandle;

/// 이 PC 의 이름 · 짧은 id (설정에 한 번 정해 둔다 — 같은 이름의 PC 가 둘이어도 따로)
fn me(app: &AppHandle) -> (String, String) {
    let st = state(app);
    let id = match st.setting("deviceId").as_str() {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos() ^ d.as_secs() as u32);
            let id = format!("{:04x}", nanos & 0xffff);
            st.set_setting("deviceId", id.clone().into());
            id
        }
    };
    let name = std::env::var("COMPUTERNAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "PC".into());
    (name, id)
}

/// 이 PC 의 기기 파일 (메모 폴더 기준)
pub fn my_file(app: &AppHandle) -> String {
    let (name, id) = me(app);
    device_file(&name, &id)
}

/// 동기화를 한 번 마친 뒤 — error: 이번 오류 (없으면 "")
pub fn write(app: &AppHandle, root: &Path, folder_name: &str, ok: bool, error: &str) {
    let (name, _) = me(app);
    let file = root.join(my_file(app));
    let prev = std::fs::read_to_string(&file).ok();
    let now = now_ms();
    let last_sync = if ok { now } else { prev.as_deref().and_then(parse_device).map_or(0, |d| d.last_sync) };
    let bridge = crate::drive_bridge::mirror_of(folder_name).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let d = Device { name, kind: "pc".into(), alive: now, last_sync, folder: root.to_string_lossy().into_owned(), bridge, error: error.into() };
    if needs_write(prev.as_deref(), &d, now) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = write_atomic(&file, device_text(&Device { alive: now, ..d }).as_bytes());
    }
}

/// 다른 기기들 (기기 파일 이름, 읽은 것)
fn others(root: &Path) -> Vec<(String, memoking_core::devices::Seen)> {
    let Ok(items) = std::fs::read_dir(root.join(DEVICES_DIR)) else { return vec![] };
    items
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let seen = parse_device(&std::fs::read_to_string(e.path()).ok()?)?;
            Some((format!("{DEVICES_DIR}/{name}"), seen))
        })
        .collect()
}

/// 받은 메모 빈 칸을 이 PC 가 옮길 차례인가 (켜져 있는 PC 가 먼저, 이름 차례로 첫째)
pub fn inbox_turn(app: &AppHandle, root: &Path) -> bool {
    let list: Vec<(String, String, i64)> = others(root).into_iter().map(|(f, s)| (f, s.kind, s.alive)).collect();
    inbox_leader(&list, &my_file(app), "pc", now_ms())
}

/// 설정에 보일 기기 목록
pub fn list(app: &AppHandle, root: &Path) -> Value {
    let me = my_file(app);
    let mut out: Vec<Value> = others(root)
        .into_iter()
        .map(|(f, s)| json!({ "name": s.name, "kind": s.kind, "alive": s.alive, "lastSync": s.last_sync, "lines": s.lines, "me": f == me }))
        .collect();
    out.sort_by(|a, b| b["me"].as_bool().cmp(&a["me"].as_bool()).then_with(|| a["name"].as_str().cmp(&b["name"].as_str())));
    Value::Array(out)
}
