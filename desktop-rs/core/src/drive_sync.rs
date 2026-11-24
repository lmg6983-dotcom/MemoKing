// 메모 폴더(이 PC) ↔ Google Drive 폴더 양방향 동기화 — desktop/drive/sync-engine.js (안드로이드 SyncEngine.kt 와 같은 규칙).
//
// 지난번 동기화 때의 모습(기준)을 기억해 두고, 파일마다 양쪽이 기준에서 바뀌었는지 보고 정한다:
//   한쪽만 바뀜 → 그쪽 것을 다른 쪽에 반영 (올리기·내려받기·지우기)
//   양쪽 다 바뀜 → 내용이 같으면 그대로, 다르면 Drive 것을 남기고 이 PC 것은 "(PC 충돌 …)" 사본으로
// Drive 에서 지울 때는 휴지통으로 보낸다. 한쪽에서 한꺼번에 많이 사라지면 아무것도 지우지 않고 멈춘다.
// 같은 답인지는 tests/parity.rs (drive_sync · drive_pick fixtures).
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub const FOLDER: &str = "application/vnd.google-apps.folder";
// 기기마다 따로 만드는 파일 — 서로 덮어쓰며 충돌하지 않게 동기화하지 않는다
const LOCAL_ONLY: &str = "_memoking/index.json";
const MERGE_JSON: &str = "_memoking/link-previews.json";
const MASS_DELETE_MIN: usize = 20;
// 한 번에 이만큼 넘게 양쪽에서 엇갈리면 무언가 같은 폴더를 함께 맞추는 것 — 사본을 더 만들지 않고 멈춘다
const MASS_CONFLICT_MAX: usize = 20;
// Drive 의 "바뀐 것" 목록만 믿으면 거기서 빠진 파일은 영영 내려오지 않으므로, 이만큼마다 폴더를 처음부터 훑는다
pub const FULL_SCAN_MS: i64 = 15 * 60_000;
// 한꺼번에 주고받는 파일 수 — 하나씩이면 메모가 많을 때 너무 느리다
pub const CONCURRENCY: usize = 4;
const JUNK: [&str; 3] = ["desktop.ini", "thumbs.db", ".ds_store"];

pub fn skip_name(name: &str) -> bool {
    name.starts_with('.') || name.starts_with("~$") || name.ends_with(".tmp") || name == "desktop.ini" || name == "Thumbs.db"
}

pub fn skip_path(rel: &str) -> bool {
    rel == LOCAL_ONLY || rel.split('/').any(skip_name)
}

/// 메모 폴더 맨 위의 사용자 폴더 (메모킹의 폴더 목록) — 앱이 쓰는 폴더는 빼고
pub fn user_dir(name: &str) -> bool {
    !skip_name(name) && !matches!(name.to_lowercase().as_str(), "_memoking" | "attachments")
}

/// Google Drive 데스크탑 앱이 맞추는 폴더(G:\내 드라이브 …) 안이면, 메모킹으로 또 맞추면 두 번 동기화가 된다
pub fn inside_drive_for_desktop(dir: &str) -> bool {
    dir.split(['\\', '/']).any(|p| ["내 드라이브", "my drive", "google drive", "공유 드라이브", "shared drives"].contains(&p.to_lowercase().as_str()))
}

pub fn md5_file(file: &Path) -> io::Result<String> {
    use md5::{Digest, Md5};
    let mut f = fs::File::open(file)?;
    let mut hash = Md5::new();
    let mut buf = vec![0; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RemoteItem {
    pub id: String,
    pub name: String,
    pub folder: bool,
    pub md5: Option<String>,
    pub modified: i64,
    pub created: i64,
    pub size: u64,
}

fn parse_ms(v: &Value) -> i64 {
    v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map_or(0, |d| d.timestamp_millis())
}

impl RemoteItem {
    /// Drive API 의 파일 정보 (drive-api.js item)
    pub fn from_json(o: &Value) -> RemoteItem {
        RemoteItem {
            id: o["id"].as_str().unwrap_or_default().into(),
            name: o["name"].as_str().unwrap_or_default().into(),
            folder: o["mimeType"] == FOLDER,
            md5: o["md5Checksum"].as_str().map(str::to_string),
            modified: parse_ms(&o["modifiedTime"]),
            created: parse_ms(&o["createdTime"]),
            size: o["size"].as_str().and_then(|s| s.parse().ok()).or(o["size"].as_u64()).unwrap_or(0),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub id: String,
    pub removed: bool,
    pub parents: Vec<String>,
    pub item: Option<RemoteItem>,
}

pub struct Changes {
    pub changed: bool,
    pub token: String,
    /// None: 무엇이 바뀌었는지 모른다 (처음) — 다 훑는다
    pub items: Option<Vec<Change>>,
}

/// Drive 의 "바뀐 것"(changes API 의 changes) 가운데 이 메모 폴더 안의 것만 (drive-api.js pickChanges).
///   새로 생긴 폴더는 아는 것으로 쳐서 그 안의 새 파일도 담는다 — 목록의 순서와 상관없이
///   (Drive 는 폴더에 파일이 들 때마다 그 폴더를 목록 뒤로 보내, 새 폴더가 그 안의 파일보다 뒤에 올 수 있다)
pub fn pick_changes(changes: &[Value], known_ids: &HashSet<String>) -> Vec<Change> {
    let mut known = known_ids.clone();
    let parents = |c: &Value| -> Vec<String> { c["file"]["parents"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(str::to_string)).collect() };
    let id = |c: &Value| c["fileId"].as_str().unwrap_or_default().to_string();
    let folders: Vec<&Value> = changes.iter().filter(|c| c["file"]["mimeType"] == FOLDER).collect();
    let mut grew = true;
    while grew {
        grew = false;
        for c in &folders {
            if known.contains(&id(c)) || !parents(c).iter().any(|p| known.contains(p)) {
                continue;
            }
            known.insert(id(c));
            grew = true;
        }
    }
    changes
        .iter()
        .filter(|c| known.contains(&id(c)) || parents(c).iter().any(|p| known.contains(p)))
        .map(|c| {
            let file = c["file"].is_object().then(|| {
                let mut f = c["file"].clone();
                f["id"] = id(c).into();
                RemoteItem::from_json(&f)
            });
            Change { id: id(c), removed: c["removed"] == true || c["file"]["trashed"] == true, parents: parents(c), item: file }
        })
        .collect()
}

/// Drive 쪽 (drive-api.js DriveApi). 여러 줄에서 한꺼번에 부른다
pub trait Remote: Sync {
    fn list_children(&self, folder_id: &str) -> io::Result<Vec<RemoteItem>>;
    fn download(&self, id: &str, file: &Path) -> io::Result<()>;
    fn upload(&self, parent: &str, name: &str, existing: Option<&str>, file: &Path) -> io::Result<RemoteItem>;
    fn create_folder(&self, parent: &str, name: &str) -> io::Result<RemoteItem>;
    fn trash(&self, id: &str) -> io::Result<()>;
    fn changes_since(&self, token: Option<&str>, known: &HashSet<String>) -> io::Result<Changes>;
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Base {
    pub id: String,
    pub md5: String,
    pub lmtime: i64,
    pub lsize: u64,
}

/// 기준 기록 — Electron 과 같은 파일 (%APPDATA%\MemoKing\drive\<폴더 id>.<열쇠>.json)
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_token: Option<String>,
    #[serde(default)]
    pub files: BTreeMap<String, Base>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_full_scan: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// 권한이 줄어 안 보이게 된 파일: 지우지 않고 다시 올린다 (drive-sync.js)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_missing: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub skipped: bool,
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_local: usize,
    pub deleted_remote: usize,
    pub conflicts: Vec<String>,
    pub local_changed: bool,
    #[serde(skip)]
    dirs_changed: bool,
}

#[derive(Clone, Copy)]
struct Stat {
    mtime: i64,
    size: u64,
}

fn stat_of(path: &Path) -> Option<Stat> {
    let m = fs::metadata(path).ok().filter(|m| m.is_file())?;
    let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    Some(Stat { mtime, size: m.len() })
}

fn parent_dir(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

fn base_name(rel: &str) -> &str {
    rel.rfind('/').map_or(rel, |i| &rel[i + 1..])
}

fn hex6() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..6].to_string()
}

fn safety(msg: String) -> io::Error {
    io::Error::other(msg)
}

/// lanes 개의 줄이 0..count 를 나눠 한다. 한 줄이 실패하면 다른 줄은 지금 하는 것만 끝내고 멈춘다 (끝낸 파일의 기준은 남게)
fn lanes(lanes: usize, count: usize, f: impl Fn(usize) -> io::Result<()> + Sync) -> io::Result<()> {
    let next = AtomicUsize::new(0);
    let failed: Mutex<Option<io::Error>> = Mutex::new(None);
    std::thread::scope(|s| {
        for _ in 0..lanes.clamp(1, count.max(1)) {
            s.spawn(|| loop {
                if failed.lock().unwrap().is_some() {
                    return;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= count {
                    return;
                }
                if let Err(e) = f(i) {
                    failed.lock().unwrap().get_or_insert(e);
                    return;
                }
            });
        }
    });
    failed.into_inner().unwrap().map_or(Ok(()), Err)
}

pub struct Options<'a> {
    pub full: bool,
    pub local_clean: bool,
    pub conflict_tag: &'a str,
    pub now: &'a (dyn Fn() -> i64 + Sync),
    /// 어디까지 했는지 (scan: Drive 폴더 살펴보는 중, transfer: 맞출 파일 total 개 중 done 개)
    pub on_progress: &'a (dyn Fn(&str, usize, usize) + Sync),
    pub concurrency: usize,
    /// 메모 파일을 바꿔치기 · 옮기기 · 지우는 순간을 앱의 메모 잠금 안에서 돌린다 —
    ///   다른 스레드의 저장이 확인과 바꿔치기 사이에 끼어들어 사라지지 않게 (잠금이 없으면 그냥 부른다)
    pub locked: &'a (dyn Fn(&mut dyn FnMut()) + Sync),
}

struct Engine<'a> {
    root: PathBuf,
    remote: &'a dyn Remote,
    root_id: String,
    files: Mutex<BTreeMap<String, Base>>,
    folder_ids: Mutex<BTreeMap<String, String>>,
    // 만드는 중인 Drive 폴더 — 여러 줄이 한꺼번에 같은 폴더를 두 번 만들지 않게
    making: Mutex<()>,
    result: Mutex<SyncResult>,
    opts: &'a Options<'a>,
}

/// 한 번 맞춘다. state 는 끝내지 못했어도 끝낸 파일만큼 바뀐 채로 — 저장해 둔다 (다음 차례는 남은 것만)
pub fn run(root: &Path, remote: &dyn Remote, root_id: &str, state: &mut SyncState, opts: &Options) -> io::Result<SyncResult> {
    let e = Engine {
        root: root.to_path_buf(),
        remote,
        root_id: root_id.into(),
        files: Mutex::new(std::mem::take(&mut state.files)),
        folder_ids: Mutex::new(BTreeMap::new()),
        making: Mutex::new(()),
        result: Mutex::new(SyncResult::default()),
        opts,
    };
    let r = e.run(state);
    state.files = e.files.into_inner().unwrap();
    r.map(|()| e.result.into_inner().unwrap())
}

impl Engine<'_> {
    fn abs(&self, rel: &str) -> PathBuf {
        rel.split('/').fold(self.root.clone(), |p, s| p.join(s))
    }

    fn stat(&self, rel: &str) -> Option<Stat> {
        stat_of(&self.abs(rel))
    }

    fn record(&self, rel: &str, id: &str, md5: &str, l: Stat) {
        self.files.lock().unwrap().insert(rel.into(), Base { id: id.into(), md5: md5.into(), lmtime: l.mtime, lsize: l.size });
    }

    // ---------- 양쪽 둘러보기 ----------

    /// 이 PC 메모 폴더의 파일들. 못 읽은 하위 폴더(백신이 잠깐 붙잡음 · 권한) · 항목은 "지운 것" 이 아니다 —
    ///   아는 기준 그대로(바뀌지 않음) 넣어, Drive 에서도 지우지 않게 (예전: 빠진 파일을 이 PC 에서 지운 것으로 보고 Drive 휴지통으로)
    fn walk_local(&self) -> BTreeMap<String, Stat> {
        fn walk(dir: &Path, rel: &str, out: &mut BTreeMap<String, Stat>, unread: &mut Vec<String>) {
            let Ok(items) = fs::read_dir(dir) else {
                unread.push(format!("{rel}/"));
                return;
            };
            for d in items.flatten() {
                let name = d.file_name().to_string_lossy().into_owned();
                if skip_name(&name) {
                    continue;
                }
                let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                let Ok(t) = d.file_type() else {
                    unread.push(r);
                    continue;
                };
                if t.is_dir() {
                    walk(&d.path(), &r, out, unread);
                } else if t.is_file() && !skip_path(&r) {
                    // 목록을 읽은 뒤 사라진 파일 — 없는 것으로 치고 다음 차례에
                    if let Some(st) = stat_of(&d.path()) {
                        out.insert(r, st);
                    }
                }
            }
        }
        let (mut out, mut unread) = (BTreeMap::new(), vec![]);
        walk(&self.root, "", &mut out, &mut unread);
        if unread.iter().any(|u| u == "/") {
            return out; // 메모 폴더 자체를 못 읽음 — 아래 run 의 "메모 폴더가 비었다" 안전장치가 멈춘다
        }
        for (rel, b) in self.files.lock().unwrap().iter() {
            if !out.contains_key(rel) && unread.iter().any(|u| rel.starts_with(u.as_str())) {
                out.insert(rel.clone(), Stat { mtime: b.lmtime, size: b.lsize });
            }
        }
        out
    }

    /// 메모 폴더 맨 위의 사용자 폴더 이름들 (이 PC)
    fn local_dirs(&self) -> Vec<String> {
        let Ok(items) = fs::read_dir(&self.root) else { return vec![] };
        items.flatten().filter(|d| d.file_type().is_ok_and(|t| t.is_dir())).map(|d| d.file_name().to_string_lossy().into_owned()).filter(|n| user_dir(n)).collect()
    }

    fn walk_remote(&self) -> io::Result<BTreeMap<String, RemoteItem>> {
        let mut out = BTreeMap::new();
        let mut folder_ids = BTreeMap::from([(String::new(), self.root_id.clone())]);
        // 한 층씩, 그 층의 폴더들은 한꺼번에 훑는다
        let mut level = vec![(self.root_id.clone(), String::new())];
        while !level.is_empty() {
            let lists: Vec<Mutex<Vec<RemoteItem>>> = level.iter().map(|_| Mutex::default()).collect();
            lanes(self.opts.concurrency, level.len(), |i| {
                *lists[i].lock().unwrap() = self.remote.list_children(&level[i].0)?;
                Ok(())
            })?;
            let mut next = vec![];
            for ((_, dir), list) in level.iter().zip(lists) {
                // Drive 는 한 폴더에 같은 이름을 여러 개 둘 수 있다 — 가장 최근 것만 쓴다
                let mut by_name: Vec<RemoteItem> = vec![];
                for item in list.into_inner().unwrap() {
                    match by_name.iter_mut().find(|p| p.name == item.name) {
                        Some(prev) if item.modified > prev.modified => *prev = item,
                        Some(_) => {}
                        None => by_name.push(item),
                    }
                }
                for item in by_name {
                    if skip_name(&item.name) {
                        continue;
                    }
                    let rel = if dir.is_empty() { item.name.clone() } else { format!("{dir}/{}", item.name) };
                    if item.folder {
                        folder_ids.insert(rel.clone(), item.id.clone());
                        next.push((item.id, rel));
                    } else if item.md5.is_some() && !skip_path(&rel) {
                        out.insert(rel, item); // md5 가 없는 것은 구글 문서 같은 Drive 전용 파일
                    }
                }
            }
            level = next;
        }
        *self.folder_ids.lock().unwrap() = folder_ids;
        Ok(out)
    }

    /// Drive 폴더를 다 훑지 않고: 기준 + 그 뒤 바뀐 것(changes)으로 지금 Drive 모습을 만든다.
    ///   이름 바꾸기 · 옮기기 · 폴더 지우기처럼 기준만으로 어디인지 알 수 없는 것이 섞이면 None (다 훑는다)
    fn remote_from_changes(&self, state: &SyncState, items: &[Change]) -> Option<BTreeMap<String, RemoteItem>> {
        let mut folders = state.folders.clone().unwrap_or_default();
        folders.insert(String::new(), self.root_id.clone());
        let mut rel_of_folder: HashMap<String, String> = folders.iter().map(|(rel, id)| (id.clone(), rel.clone())).collect();
        let files = self.files.lock().unwrap();
        let mut remote: BTreeMap<String, RemoteItem> = files.iter().map(|(rel, b)| (rel.clone(), RemoteItem { id: b.id.clone(), md5: Some(b.md5.clone()), ..Default::default() })).collect();
        let mut rel_of_file: HashMap<String, String> = remote.iter().map(|(rel, r)| (r.id.clone(), rel.clone())).collect();
        let placed = |c: &Change, rel_of_folder: &HashMap<String, String>| -> Option<String> {
            let dir = c.parents.iter().find_map(|p| rel_of_folder.get(p))?;
            let name = &c.item.as_ref()?.name;
            Some(if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") })
        };
        let is_folder = |c: &Change, rel_of_folder: &HashMap<String, String>| c.item.as_ref().is_some_and(|i| i.folder) || rel_of_folder.contains_key(&c.id);
        // 폴더 먼저 — 새 폴더 안에 새 폴더가 들 수 있어, 놓을 수 있는 것이 없어질 때까지 되풀이
        let mut pending: Vec<&Change> = items.iter().filter(|c| is_folder(c, &rel_of_folder)).collect();
        while !pending.is_empty() {
            let mut left = vec![];
            for c in &pending {
                let was = rel_of_folder.get(&c.id).cloned();
                if c.removed {
                    if was.is_some() {
                        return None; // 알던 폴더를 지움 — 그 안의 파일을 다 따지려면 훑는다
                    }
                    continue;
                }
                match placed(c, &rel_of_folder) {
                    None => left.push(*c),
                    Some(rel) if was.as_ref().is_some_and(|w| *w != rel) => return None, // 폴더 이름 바꾸기 · 옮기기
                    Some(rel) => {
                        folders.insert(rel.clone(), c.id.clone());
                        rel_of_folder.insert(c.id.clone(), rel);
                    }
                }
            }
            if left.len() == pending.len() {
                return None; // 어디에 놓을지 모르는 폴더
            }
            pending = left;
        }
        for c in items {
            if is_folder(c, &rel_of_folder) {
                continue;
            }
            let was = rel_of_file.get(&c.id).cloned();
            if c.removed {
                if let Some(w) = was {
                    if remote.get(&w).is_some_and(|r| r.id == c.id) {
                        remote.remove(&w);
                    }
                }
                continue;
            }
            let rel = placed(c, &rel_of_folder)?; // 기준에 없는 곳
            if was.is_some_and(|w| w != rel) {
                return None; // 이름 바꾸기 · 옮기기
            }
            let item = c.item.clone().unwrap();
            if skip_path(&rel) || item.md5.is_none() {
                continue; // md5 가 없는 것은 구글 문서 같은 Drive 전용 파일
            }
            remote.insert(rel.clone(), item);
            rel_of_file.insert(c.id.clone(), rel);
        }
        *self.folder_ids.lock().unwrap() = folders;
        Some(remote)
    }

    fn ensure_remote_folder(&self, dir: &str) -> io::Result<String> {
        if dir.is_empty() {
            return Ok(self.root_id.clone());
        }
        if let Some(id) = self.folder_ids.lock().unwrap().get(dir) {
            return Ok(id.clone());
        }
        // 한 번에 하나만 만든다 (같은 이름 폴더가 둘 생기지 않게)
        let _making = self.making.lock().unwrap();
        let mut parent = self.root_id.clone();
        let mut path = String::new();
        for part in dir.split('/') {
            path = if path.is_empty() { part.into() } else { format!("{path}/{part}") };
            let known = self.folder_ids.lock().unwrap().get(&path).cloned();
            parent = match known {
                Some(id) => id,
                None => {
                    let id = self.remote.create_folder(&parent, part)?.id;
                    self.folder_ids.lock().unwrap().insert(path.clone(), id.clone());
                    id
                }
            };
        }
        Ok(parent)
    }

    // ---------- 맨 위 폴더 맞추기 (파일을 다 맞춘 뒤) ----------
    //   지난번 양쪽에 다 있던 폴더(state.dirs)를 기준으로:
    //     한쪽에만 있고 기준에 없음 → 새로 만든 것: 다른 쪽에도 만든다
    //     한쪽에만 있고 기준에 있음 → 다른 쪽에서 지운 것: 이쪽도 비었으면 지운다
    //   기준이 없으면(처음) 지우지 않고 합치기만 한다
    fn sync_dirs(&self, state: &mut SyncState) -> io::Result<()> {
        let had: Option<HashSet<String>> = state.dirs.as_ref().map(|d| d.iter().cloned().collect());
        let had_has = |d: &str| had.as_ref().is_some_and(|h| h.contains(d));
        let mut local: BTreeSet<String> = self.local_dirs().into_iter().collect();
        let mut remote: BTreeSet<String> = self.folder_ids.lock().unwrap().keys().filter(|d| !d.is_empty() && !d.contains('/') && user_dir(d)).cloned().collect();
        let all: Vec<String> = local.union(&remote).cloned().collect();
        for d in all {
            if local.contains(&d) && remote.contains(&d) {
                continue;
            }
            if local.contains(&d) {
                if !had_has(&d) {
                    self.ensure_remote_folder(&d)?;
                    remote.insert(d);
                } else if self.local_dir_empty(&d) {
                    fs::remove_dir_all(self.abs(&d))?;
                    local.remove(&d);
                    self.result.lock().unwrap().dirs_changed = true;
                }
            } else if !had_has(&d) {
                fs::create_dir_all(self.abs(&d))?;
                local.insert(d);
                self.result.lock().unwrap().dirs_changed = true;
            } else {
                let id = self.folder_ids.lock().unwrap()[&d].clone();
                if !self.remote.list_children(&id)?.is_empty() {
                    continue; // Drive 쪽에 무엇이 남았다 — 지우지 않는다
                }
                self.remote.trash(&id)?;
                self.folder_ids.lock().unwrap().remove(&d);
                remote.remove(&d);
            }
        }
        state.dirs = Some(local.intersection(&remote).cloned().collect());
        Ok(())
    }

    fn local_dir_empty(&self, d: &str) -> bool {
        fn has_file(dir: &Path) -> bool {
            let Ok(items) = fs::read_dir(dir) else { return false };
            items.flatten().any(|e| if e.file_type().is_ok_and(|t| t.is_dir()) { has_file(&e.path()) } else { !JUNK.contains(&e.file_name().to_string_lossy().to_lowercase().as_str()) })
        }
        !has_file(&self.abs(d))
    }

    // ---------- 파일 하나 ----------

    fn upload(&self, rel: &str, existing: Option<&str>) -> io::Result<()> {
        let Some(before) = self.stat(rel) else { return Ok(()) };
        let parent = self.ensure_remote_folder(parent_dir(rel))?;
        let item = self.remote.upload(&parent, base_name(rel), existing, &self.abs(rel))?;
        self.record(rel, &item.id, item.md5.as_deref().unwrap_or_default(), before);
        self.result.lock().unwrap().uploaded += 1;
        Ok(())
    }

    // 내려받기는 임시 파일에 받아 바꿔치기. 둘러본 뒤 이 PC 에서 또 고쳤으면 이번에는 건드리지 않는다
    fn download(&self, rel: &str, item: &RemoteItem, expect: Option<Stat>) -> io::Result<()> {
        let untouched = || match (self.stat(rel), expect) {
            (Some(now), Some(e)) => now.mtime == e.mtime && now.size == e.size,
            (now, None) => now.is_none(),
            (None, Some(_)) => false,
        };
        if !untouched() {
            return Ok(());
        }
        let dest = self.abs(rel);
        fs::create_dir_all(dest.parent().unwrap())?;
        let tmp = dest.with_file_name(format!(".{}.{}.tmp", base_name(rel), hex6()));
        let swapped = (|| {
            self.remote.download(&item.id, &tmp)?;
            let mut swapped = Ok(false); // 받는 사이 이 PC 에서 고쳤다 — 덮어쓰지 않고 다음 차례에
            (self.opts.locked)(&mut || {
                if untouched() {
                    swapped = fs::rename(&tmp, &dest).map(|()| true);
                }
            });
            swapped
        })();
        let _ = fs::remove_file(&tmp);
        if !swapped? {
            return Ok(());
        }
        let now = self.stat(rel).ok_or(io::ErrorKind::NotFound)?;
        self.record(rel, &item.id, item.md5.as_deref().unwrap_or_default(), now);
        self.result.lock().unwrap().downloaded += 1;
        Ok(())
    }

    fn conflict_name(&self, rel: &str) -> String {
        use chrono::TimeZone;
        let stamp = chrono::Local.timestamp_millis_opt((self.opts.now)()).single().map_or_else(String::new, |d| d.format("%Y-%m-%d %H%M").to_string());
        let (dir, name) = (parent_dir(rel), base_name(rel));
        let dot = name.rfind('.').filter(|&i| i > 0).unwrap_or(name.len());
        let tag = self.opts.conflict_tag;
        (1..)
            .map(|n| {
                let tag = if n == 1 { format!("{tag} {stamp}") } else { format!("{tag} {stamp} {n}") };
                let candidate = format!("{} ({tag}){}", &name[..dot], &name[dot..]);
                if dir.is_empty() { candidate } else { format!("{dir}/{candidate}") }
            })
            .find(|p| self.stat(p).is_none())
            .unwrap()
    }

    // 양쪽에서 다르게 바뀐 파일: 링크 미리보기 모음은 합치고, 나머지는 Drive 것을 남기고 이 PC 것은 사본으로
    fn conflict(&self, rel: &str, item: &RemoteItem) -> io::Result<()> {
        if rel == MERGE_JSON {
            let read = |p: &Path| fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Map<String, Value>>(&t).ok()).unwrap_or_default();
            let mut merged = read(&self.abs(rel));
            let tmp = PathBuf::from(format!("{}.{}.tmp", self.abs(rel).display(), hex6()));
            let theirs = self.remote.download(&item.id, &tmp).map(|()| read(&tmp)).unwrap_or_default();
            let _ = fs::remove_file(&tmp);
            merged.extend(theirs);
            let mut out = vec![];
            let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b" "));
            merged.serialize(&mut ser).map_err(io::Error::other)?;
            fs::write(self.abs(rel), out)?;
            return self.upload(rel, Some(&item.id));
        }
        let copy = self.conflict_name(rel);
        let mut moved = Ok(());
        (self.opts.locked)(&mut || moved = fs::rename(self.abs(rel), self.abs(&copy)));
        moved?;
        self.result.lock().unwrap().conflicts.push(copy.clone());
        self.download(rel, item, None)?;
        self.upload(&copy, None)
    }

    fn one(&self, rel: &str, l: Option<Stat>, r: Option<&RemoteItem>, keep_missing: bool) -> io::Result<()> {
        let b = self.files.lock().unwrap().get(rel).cloned();
        let local_changed = l.is_some_and(|l| b.as_ref().is_none_or(|b| b.lmtime != l.mtime || b.lsize != l.size));
        let remote_changed = r.is_some_and(|r| b.as_ref().is_none_or(|b| Some(&b.md5) != r.md5.as_ref()));
        match (l, r) {
            (Some(l), Some(r)) => {
                if local_changed && !remote_changed {
                    self.upload(rel, Some(&r.id))
                } else if !local_changed && remote_changed {
                    self.download(rel, r, Some(l))
                } else if Some(md5_file(&self.abs(rel))?) == r.md5 {
                    // 양쪽 같은 내용
                    let now = self.stat(rel).ok_or(io::ErrorKind::NotFound)?;
                    self.record(rel, &r.id, r.md5.as_deref().unwrap_or_default(), now);
                    Ok(())
                } else {
                    self.conflict(rel, r)
                }
            }
            (Some(l), None) => {
                if b.is_none() || local_changed || keep_missing {
                    self.upload(rel, None) // 새 파일, 또는 Drive 에서 지웠지만 이 PC 에서 고침 → 되살림
                } else {
                    // 다른 기기에서 지움 → 이 PC 에서도. 둘러본 뒤 이 PC 에서 고쳤으면 지우지 않는다 (다음 차례에 되살림)
                    let mut removed = Ok(false);
                    (self.opts.locked)(&mut || {
                        removed = match self.stat(rel) {
                            Some(now) if now.mtime != l.mtime || now.size != l.size => Ok(false),
                            _ => fs::remove_file(self.abs(rel)).or_else(|e| if e.kind() == io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map(|()| true),
                        }
                    });
                    if !removed? {
                        return Ok(());
                    }
                    self.result.lock().unwrap().deleted_local += 1;
                    self.files.lock().unwrap().remove(rel);
                    Ok(())
                }
            }
            (None, Some(r)) => {
                if b.is_none() || remote_changed {
                    self.download(rel, r, None) // 새 파일, 또는 이 PC 에서 지웠지만 다른 기기에서 고침 → 되살림
                } else {
                    self.remote.trash(&r.id)?;
                    self.result.lock().unwrap().deleted_remote += 1;
                    self.files.lock().unwrap().remove(rel);
                    Ok(())
                }
            }
            (None, None) => Ok(()),
        }
    }

    // ---------- 동기화 ----------

    fn run(&self, state: &mut SyncState) -> io::Result<()> {
        let now = self.opts.now;
        let folder_values = |state: &SyncState| state.folders.iter().flat_map(|f| f.values().cloned()).collect::<Vec<_>>();
        let skipped = |state: &mut SyncState, token: String| -> io::Result<()> {
            state.page_token = Some(token);
            self.result.lock().unwrap().skipped = true;
            Ok(())
        };
        let mut peeked = None;
        // 이 PC 의 메모 폴더가 그대로인 것을 알면 폴더를 훑지 않고 Drive 에 바뀐 것만 묻는다
        if self.opts.local_clean && !self.opts.full && state.page_token.is_some() && now() - state.last_full_scan.unwrap_or(0) < FULL_SCAN_MS {
            let mut ids: HashSet<String> = self.files.lock().unwrap().values().map(|f| f.id.clone()).collect();
            ids.extend(folder_values(state));
            ids.insert(self.root_id.clone());
            let peek = self.remote.changes_since(state.page_token.as_deref(), &ids)?;
            if !peek.changed {
                return skipped(state, peek.token);
            }
            peeked = Some(peek); // Drive 에 바뀐 것이 있다: 아래에서 보통대로 (물은 것은 그대로 쓴다)
        }
        let local = self.walk_local();
        let files = self.files.lock().unwrap().clone();
        let local_dirty = local.len() != files.len() || local.iter().any(|(rel, l)| files.get(rel).is_none_or(|b| b.lmtime != l.mtime || b.lsize != l.size));
        let changes = match peeked {
            Some(p) => p,
            None => {
                let mut ids: HashSet<String> = files.values().map(|f| f.id.clone()).collect();
                ids.extend(folder_values(state));
                ids.insert(self.root_id.clone());
                self.remote.changes_since(state.page_token.as_deref().filter(|t| !t.is_empty()), &ids)?
            }
        };
        let scan_due = self.opts.full || now() - state.last_full_scan.unwrap_or(0) >= FULL_SCAN_MS;
        // 빈 폴더를 만들거나 지운 것도 바뀐 것 (파일만 보면 놓친다)
        let mut dirs = self.local_dirs();
        dirs.sort();
        let dirs_dirty = dirs != state.dirs.clone().unwrap_or_default();
        if !local_dirty && !dirs_dirty && !changes.changed && !scan_due {
            return skipped(state, changes.token);
        }

        (self.opts.on_progress)("scan", 0, 0);
        // Drive 폴더를 다 훑는 것은 15분에 한 번 · "지금 동기화" 때만 — 평소에는 기준 + 바뀐 것
        let quick = match (scan_due, changes.changed, &changes.items) {
            (true, _, _) | (false, true, None) => None,
            (false, true, Some(items)) => self.remote_from_changes(state, items),
            (false, false, _) => self.remote_from_changes(state, &[]),
        };
        let was_quick = quick.is_some();
        let remote = match quick {
            Some(r) => r,
            None => self.walk_remote()?,
        };
        let paths: BTreeSet<&String> = local.keys().chain(remote.keys()).chain(files.keys()).collect();

        let gone_remote = paths.iter().filter(|p| files.contains_key(**p) && !remote.contains_key(**p) && local.contains_key(**p)).count();
        let gone_local = paths.iter().filter(|p| files.contains_key(**p) && !local.contains_key(**p) && remote.contains_key(**p)).count();
        let keep_missing = state.keep_missing == Some(true);
        if !keep_missing && gone_remote >= MASS_DELETE_MIN && gone_remote * 2 > files.len() {
            return Err(safety(format!("Google Drive 폴더에서 파일 {gone_remote}개가 한꺼번에 사라져서 동기화를 멈췄어요. 고른 폴더가 맞는지 확인해 주세요.")));
        }
        // 메모 폴더가 통째로 비었으면 지운 게 아니라 못 읽은 것 (폴더를 옮김 · 드라이브가 빠짐) — 적은 수라도 Drive 에서 지우지 않는다
        if gone_local > 0 && local.is_empty() {
            return Err(safety("이 PC 메모 폴더가 비어 있거나 읽을 수 없어 동기화를 멈췄어요. 메모 폴더가 맞는지 확인해 주세요.".into()));
        }
        if gone_local >= MASS_DELETE_MIN && gone_local * 2 > files.len() {
            return Err(safety(format!("이 PC 메모 폴더에서 파일 {gone_local}개가 한꺼번에 사라져서 동기화를 멈췄어요.")));
        }

        let changed = |rel: &str| {
            let (l, r, b) = (local.get(rel), remote.get(rel), files.get(rel));
            let lc = l.is_some_and(|l| b.is_none_or(|b| b.lmtime != l.mtime || b.lsize != l.size));
            let rc = r.is_some_and(|r| b.is_none_or(|b| Some(&b.md5) != r.md5.as_ref()));
            (l.copied(), r, lc, rc)
        };
        // 양쪽에서 엇갈린 파일이 너무 많으면 아무것도 건드리기 전에 멈춘다 (도중에 멈추면 다음 차례마다 사본이 또 생긴다)
        let clashes: Vec<&&String> = paths.iter().filter(|p| p.as_str() != MERGE_JSON && matches!(changed(p), (Some(_), Some(_), true, true))).collect();
        if clashes.len() > MASS_CONFLICT_MAX && clashes.iter().filter(|p| md5_file(&self.abs(p)).ok() != remote[***p].md5).count() > MASS_CONFLICT_MAX {
            return Err(safety(format!(
                "양쪽에서 엇갈린 메모가 {MASS_CONFLICT_MAX}개를 넘어 동기화를 멈췄어요 (사본이 계속 늘어나지 않게). 메모 폴더를 Google Drive 데스크탑 앱 등 다른 동기화도 맞추고 있는지 확인해 주세요."
            )));
        }

        // 할 일이 있는 파일만 골라 (그대로인 것 · 양쪽 다 지운 것은 바로) 몇 개씩 한꺼번에
        let mut work = vec![];
        for rel in paths {
            match changed(rel) {
                (None, None, _, _) => {
                    self.files.lock().unwrap().remove(rel); // 양쪽 다 지움
                }
                (Some(_), Some(_), false, false) => {}
                (l, r, _, _) => work.push((rel, l, r)),
            }
        }
        let done = AtomicUsize::new(0);
        (self.opts.on_progress)("transfer", 0, work.len());
        lanes(self.opts.concurrency, work.len(), |i| {
            let (rel, l, r) = work[i];
            match self.one(rel, l, r, keep_missing) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e), // 둘러보는 사이 없어진 파일은 다음 차례에
                _ => {}
            }
            (self.opts.on_progress)("transfer", done.fetch_add(1, Ordering::SeqCst) + 1, work.len());
            Ok(())
        })?;
        self.sync_dirs(state)?;

        state.page_token = Some(changes.token);
        state.keep_missing = None; // 다 올렸으면 다음부터는 보통대로
        if !was_quick {
            state.last_full_scan = Some(now());
        }
        state.folders = Some(self.folder_ids.lock().unwrap().clone());
        let mut res = self.result.lock().unwrap();
        res.local_changed = res.downloaded > 0 || res.deleted_local > 0 || !res.conflicts.is_empty() || res.dirs_changed;
        Ok(())
    }
}

/// 메모 폴더를 다른 곳으로 옮겨 맞출 때 (Google Drive 데스크탑 앱 폴더 → 문서\메모킹): 원래 폴더의 메모·첨부를 복사한다.
/// 원래 폴더는 그대로 두고, 새 폴더에 같은 이름이 이미 있으면 건드리지 않는다 (동기화 기록·임시 파일은 빼고). 복사한 파일 수
pub fn copy_vault(from: &Path, to: &Path) -> usize {
    fn walk(from: &Path, to: &Path, rel: &str, copied: &mut usize) {
        let Ok(items) = fs::read_dir(if rel.is_empty() { from.to_path_buf() } else { from.join(rel) }) else { return };
        for e in items.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if skip_name(&name) {
                continue;
            }
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                walk(from, to, &r, copied);
            } else if t.is_file() && !skip_path(&r) {
                let dest = to.join(&r);
                if dest.exists() {
                    continue;
                }
                let _ = fs::create_dir_all(dest.parent().unwrap());
                if fs::copy(e.path(), &dest).is_ok() {
                    // 고친 시각을 그대로 (목록 순서·충돌 판정이 바뀌지 않게)
                    if let (Ok(m), Ok(f)) = (e.metadata().and_then(|m| m.modified()), fs::File::options().write(true).open(&dest)) {
                        let _ = f.set_modified(m);
                    }
                    *copied += 1;
                }
            }
        }
    }
    let mut copied = 0;
    if from != to {
        walk(from, to, "", &mut copied);
    }
    copied
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_for_desktop_folders() {
        assert!(inside_drive_for_desktop(r"G:\내 드라이브\메모") && inside_drive_for_desktop("/Users/a/Google Drive") && inside_drive_for_desktop(r"G:\My Drive"));
        assert!(!inside_drive_for_desktop(r"C:\Users\a\Documents\메모킹") && !inside_drive_for_desktop(r"C:\My Drives"));
    }
}
