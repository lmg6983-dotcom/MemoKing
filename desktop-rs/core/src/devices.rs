//! 기기 상태 (_memoking/기기/<이름> (<id>).md) — app/js/core/devices.js 와 같은 규칙 (tests/parity.rs devices)
//!   기기마다 마지막 동기화 · 메모 폴더 · PC 다리 · 최근 오류를 적어 다른 기기 · AI 가 보게 하고,
//!   AI 받은함 시트를 처리할 한 기기를 정한다 (켜져 있는 PC 먼저, 이름 차례로 첫째)
use crate::memo_file::title_to_file_name;
use chrono::TimeZone;

pub const DEVICES_DIR: &str = "_memoking/기기";
pub const ALIVE_MS: i64 = 15 * 60_000;
pub const HEARTBEAT_MS: i64 = 5 * 60_000;

/// 기기 파일 경로: "_memoking/기기/DESKTOP-AB12 (3f9c).md"
pub fn device_file(name: &str, id: &str) -> String {
    format!("{DEVICES_DIR}/{}.md", title_to_file_name(&format!("{name} ({id})")))
}

/// 이 기기 시각으로 "2026-11-24 17:20"
pub fn local_stamp(ms: i64) -> String {
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

/// 기기 파일에 적을 것
#[derive(Clone, Debug, Default)]
pub struct Device {
    pub name: String,
    pub kind: String,
    pub alive: i64,
    pub last_sync: i64,
    pub folder: String,
    /// PC 다리가 읽는 폴더 (없으면 꺼짐)
    pub bridge: String,
    pub error: String,
}

pub fn device_text(d: &Device) -> String {
    let pc = d.kind == "pc";
    let mut lines = vec![
        format!("- 종류: {}", if pc { "PC" } else { "휴대폰" }),
        format!("- 마지막 동기화: {}", if d.last_sync != 0 { local_stamp(d.last_sync) } else { "아직 없음".into() }),
    ];
    if !d.folder.is_empty() {
        lines.push(format!("- 메모 폴더: {}", d.folder));
    }
    if pc {
        lines.push(format!("- PC 다리: {}", if d.bridge.is_empty() { "꺼짐 (Google Drive 데스크탑 앱 폴더를 찾지 못함)".to_string() } else { format!("켜짐 ({})", d.bridge) }));
    }
    lines.push(format!("- 최근 오류: {}", if d.error.is_empty() { "없음" } else { &d.error }));
    format!("---\nkind: {}\nalive: {}\nlastSync: {}\n---\n# {}\n\n{}\n", if pc { "pc" } else { "phone" }, d.alive, d.last_sync, d.name, lines.join("\n"))
}

/// 읽은 기기 파일
#[derive(Clone, Debug, PartialEq)]
pub struct Seen {
    pub name: String,
    pub kind: String,
    pub alive: i64,
    pub last_sync: i64,
    pub lines: Vec<String>,
}

pub fn parse_device(text: &str) -> Option<Seen> {
    let t = text.replace("\r\n", "\n");
    let rest = t.strip_prefix("---\n")?;
    let end = rest.find("\n---\n")?;
    let (head, body) = (&rest[..end], &rest[end + 5..]);
    let get = |k: &str| head.split('\n').find_map(|l| l.split_once(": ").filter(|(a, _)| a.trim() == k).map(|(_, v)| v.trim().to_string()));
    let alive: i64 = get("alive")?.parse().ok()?;
    let name = body.split('\n').find_map(|l| l.strip_prefix("# ")).map(|n| n.trim().to_string()).filter(|n| !n.is_empty())?;
    Some(Seen {
        name,
        kind: if get("kind").as_deref() == Some("pc") { "pc".into() } else { "phone".into() },
        alive,
        last_sync: get("lastSync").and_then(|v| v.parse().ok()).unwrap_or(0),
        lines: body.split('\n').filter_map(|l| l.strip_prefix("- ")).map(str::to_string).collect(),
    })
}

/// 동기화 충돌 사본("(PC 충돌 …).md", "(휴대폰 충돌 …).md")인지 확인
fn is_conflict_device(file: &str) -> bool {
    file.ends_with(").md") && (file.contains(" (PC 충돌 ") || file.contains(" (휴대폰 충돌 "))
}

/// AI 받은함 시트를 이 기기가 처리할 차례인가 — others: (기기 파일 이름, kind, alive)
pub fn inbox_leader(others: &[(String, String, i64)], me_file: &str, me_kind: &str, now: i64) -> bool {
    let mut live: Vec<(&str, &str)> = others
        .iter()
        .filter(|(f, _, a)| f != me_file && !is_conflict_device(f) && now - a <= ALIVE_MS)
        .map(|(f, k, _)| (f.as_str(), k.as_str()))
        .collect();
    live.push((me_file, me_kind));
    let pcs: Vec<(&str, &str)> = live.iter().copied().filter(|(_, k)| *k == "pc").collect();
    let pool = if pcs.is_empty() { live } else { pcs };
    pool.iter().map(|(f, _)| *f).min() == Some(me_file)
}

/// 다시 적을 때인가: HEARTBEAT_MS 지났거나 사람이 읽는 내용이 바뀌었다 — 마지막 동기화 시각은 빼고
///   (동기화마다 적으면 그 파일을 올리느라 또 동기화하고, 기기마다 1분에 한 번씩 파일이 오간다)
pub fn needs_write(prev_text: Option<&str>, next: &Device, now: i64) -> bool {
    let Some(prev) = prev_text.and_then(parse_device) else { return true };
    let Some(draft) = parse_device(&device_text(&Device { alive: now, ..next.clone() })) else { return true };
    let keep = |l: &Vec<String>| l.iter().filter(|x| !x.starts_with("마지막 동기화")).cloned().collect::<Vec<_>>();
    now - prev.alive >= HEARTBEAT_MS || prev.name != draft.name || keep(&prev.lines) != keep(&draft.lines)
}
