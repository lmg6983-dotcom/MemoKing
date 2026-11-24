//! 메모 폴더(볼트) — 폴더 속 .md 파일들을 DB 처럼. desktop/vault.js + app/js/core/vault-locks.js 의 저장 규칙을 옮긴 것.
//!   옮긴 것: 읽기(scan) · 목록 · 메모 하나 · 새 메모 · 저장(덮어쓰기 전 확인 · 충돌 사본 · 버전) · 닫을 때 정리 · 휴지통으로.
//!   아직(체크리스트): 잠금 열기 · 잠그기, 폴더 옮기기, 휴지통 되살리기 · 비우기, 첨부 정리(orphans), 같은 id 두 파일(twins), 색인(index.json).
//!   잠긴 메모는 열쇠가 없으니 늘 "저장 거절" — 풀린 글이 잠긴 메모를 덮어쓰는 일은 없다.
use crate::body::{self, Tasks};
use crate::memo_file::{self, Meta};
use crate::{lock, time};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const APP_DIR: &str = "_memoking";
const PINNED_FOLDERS: &str = "pinned-folders.json";
pub const ATTACH_DIR: &str = "attachments";
const VERSION_GAP_MS: u128 = 10 * 60 * 1000;
const MAX_VERSIONS: usize = 30;
const MAX_VERSION_AGE_MS: u128 = 30 * 86_400_000;
const KEEP_RECENT: usize = 3;

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: String,
    /// 메모 폴더 기준 경로 ("업무/회의.md"), 아직 파일이 없는 새 메모는 None
    pub file: Option<String>,
    /// 새 메모를 처음 저장할 폴더
    pub folder: String,
    pub meta: Meta,
    pub body: String,
    stamp: Option<(SystemTime, u64)>,
    pub id_saved: bool,
    /// 지금 파일에 있는 머리말 (머리말만 쓰는 사이 다른 기기가 고쳤을 때, 이 기기가 바꾼 항목만 골라 더하려고)
    disk_meta: Option<Meta>,
    /// 비밀 폴더 id (비밀 메모면 — file 은 늘 None, 저장은 잠가서 _memoking/secret 으로: vault/secret_store.rs)
    pub secret: Option<String>,
}

/// 다시 읽은 결과 — 화면에 알릴 것 (vault.js 의 'changed' 이벤트)
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Changed {
    pub ids: Vec<String>,
    /// 다른 기기 · 탐색기에서 바뀐 메모
    pub external: Vec<String>,
    pub removed: Vec<String>,
    /// 메모는 그대로여도 폴더가 생기거나 없어졌다 (목록이 폴더 목록을 다시 읽게)
    pub folders: bool,
}

impl Changed {
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty() && !self.folders
    }
}

/// 저장하지 않은 까닭
#[derive(Debug, PartialEq)]
enum Wrote {
    Yes,
    /// 그사이 다른 기기가 잠갔다 — 덮어쓰지 않음
    Locked,
    /// 파일이 잠깐 없다 — 다시 읽은 뒤 화면이 곧 다시 저장
    Skipped,
    /// 그사이 다른 기기가 다른 비밀번호로 잠갔다 — 우리 글은 사본 메모로 남겼다
    Copied,
}

pub struct Vault {
    pub root: PathBuf,
    /// 내용을 고친 곳 (pc · ai) — 머리말 device
    pub device: String,
    /// 새 메모의 Work / Life
    pub default_mode: String,
    entries: HashMap<String, Entry>,
    /// 다시 읽다 잠깐 사라진 메모의 머리말 (곧 같은 id 로 저장하면 그 머리말로)
    removed_meta: HashMap<String, (Meta, SystemTime)>,
    /// 이 기기가 되살린 파일 — "다른 기기에서 고침" 으로 알리지 않게
    own_files: HashSet<String>,
    seen_dirs: Option<String>,
    /// 연 잠긴 메모의 열쇠 (메모를 닫으면 잊는다)
    locks: HashMap<String, lock::Session>,
    /// 본문에서 뽑은 것 — 본문이 같으면 다시 뽑지 않는다 (JS bodyParts: 메모 2,000개를 저장마다 다 읽으면 1초 넘게 걸렸다)
    parts: std::sync::Mutex<HashMap<String, (u64, std::sync::Arc<Parts>)>>,
    /// 다른 기기 글을 받아들인 메모 (adopt_theirs) — 다음 scan 이 external 로 알린다
    adopted: Vec<String>,
    /// 연 비밀 폴더의 열쇠 (폴더 id → 열쇠 · 이름) — 잠그면 잊는다
    secrets: HashMap<String, crate::secret::Folder>,
    /// 비밀 메모로 잠가 옮긴 첨부: 옛 주소 → (폴더 id, 잠근 주소) — 메모 창이 아직 옛 주소로 저장해도 잠근 쪽으로
    secret_alias: HashMap<String, (String, String)>,
}

mod secret_store;

/// 목록 카드 · 찾기가 본문에서 쓰는 것
pub struct Parts {
    title: String,
    preview: String,
    media: Vec<body::Media>,
    tags: Vec<String>,
    tasks: Tasks,
    locked: bool,
    web_link: bool,
    /// 찾기용 글 (서식 뺀 줄)
    text: String,
}

fn stamp_of(path: &Path) -> io::Result<(SystemTime, u64)> {
    let m = fs::metadata(path)?;
    Ok((m.modified()?, m.len()))
}

fn ms(t: SystemTime) -> u128 {
    t.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

fn local(t: SystemTime) -> String {
    time::to_local_iso(chrono::DateTime::<chrono::Local>::from(t))
}

/// 20261008-153000 (현지 시각)
fn file_stamp(now: chrono::DateTime<chrono::Local>) -> String {
    now.format("%Y%m%d-%H%M%S").to_string()
}

/// 임시 파일에 쓰고 바꿔치기 — 쓰는 도중 꺼져도 원본이 깨지지 않는다
pub fn write_atomic(file: &Path, data: &[u8]) -> io::Result<()> {
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("memo");
    let tmp = file.with_file_name(format!(".{name}.{}.tmp", &uuid::Uuid::new_v4().simple().to_string()[..6]));
    fs::write(&tmp, data)?;
    if let Err(err) = fs::rename(&tmp, file) {
        let _ = fs::remove_file(&tmp);
        // 동기화 프로그램이 파일을 잡고 있으면 바꿔치기가 실패할 수 있어 직접 쓴다
        if err.kind() != io::ErrorKind::PermissionDenied {
            return Err(err);
        }
        fs::write(file, data)?;
    }
    Ok(())
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

impl Vault {
    pub fn new(root: impl Into<PathBuf>, device: &str) -> Self {
        Vault {
            root: root.into(),
            device: device.into(),
            default_mode: "life".into(),
            entries: HashMap::new(),
            removed_meta: HashMap::new(),
            own_files: HashSet::new(),
            seen_dirs: None,
            locks: HashMap::new(),
            parts: Default::default(),
            adopted: vec![],
            secrets: HashMap::new(),
            secret_alias: HashMap::new(),
        }
    }

    fn app_dir(&self) -> PathBuf {
        self.root.join(APP_DIR)
    }
    fn trash_dir(&self) -> PathBuf {
        self.app_dir().join("trash")
    }
    pub fn abs(&self, file: &str) -> PathBuf {
        file.split('/').fold(self.root.clone(), |p, part| p.join(part))
    }

    pub fn open(&mut self) -> io::Result<()> {
        for dir in [self.root.clone(), self.app_dir(), self.trash_dir(), self.root.join(ATTACH_DIR)] {
            fs::create_dir_all(dir)?;
        }
        self.scan();
        // 꺼 둔 사이 다른 기기에서 잠근 메모의 풀린 버전이 이 기기에 남지 않게
        let locked: Vec<String> = self.entries.values().filter(|e| body::is_locked_body(&e.body)).map(|e| e.id.clone()).collect();
        for id in locked {
            self.drop_unsafe_versions(&id);
        }
        // 목록 카드에 쓸 본문 분석을 코어마다 나눠 미리 (메모 2,000개면 첫 목록이 메모 폴더를 0.2초 넘게 붙잡았다)
        let all: Vec<&Entry> = self.entries.values().collect();
        let lanes = std::thread::available_parallelism().map_or(1, |n| n.get());
        let me = &*self;
        std::thread::scope(|s| {
            for chunk in all.chunks(all.len().div_ceil(lanes).max(1)) {
                s.spawn(move || chunk.iter().for_each(|e| drop(me.parts(e))));
            }
        });
        Ok(())
    }

    // ---------- 폴더 읽기 ----------

    /// 메모 폴더의 .md 파일들. 읽을 수 없는 항목(받는 중 사라진 파일 · Drive 바로가기 · 권한이 다른 하위 폴더)은 건너뛴다
    ///   — 예전에는 하나만 실패해도 이번 읽기를 통째로 버려, Google Drive 데스크탑 앱 폴더에서 새로 들어온 메모가 계속 안 보였다.
    ///   메모 폴더 자체를 못 읽을 때만 실패
    fn list_files(&self, dir: &Path, rel: &str, out: &mut Vec<String>, unread: &mut Vec<String>) -> io::Result<()> {
        for item in fs::read_dir(dir)?.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with("~$") || (rel.is_empty() && (name == APP_DIR || name == ATTACH_DIR)) {
                continue;
            }
            let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(ty) = item.file_type() else {
                unread.push(rel_path); // 잠깐 못 읽은 항목 — 그 메모는 아는 그대로 (scan)
                continue;
            };
            if ty.is_dir() {
                if self.list_files(&item.path(), &rel_path, out, unread).is_err() {
                    unread.push(format!("{rel_path}/")); // 하위 폴더 하나를 못 읽어도 나머지는 — 그 안의 메모는 아는 그대로 (scan)
                }
            } else if ty.is_file() && name.to_lowercase().ends_with(".md") {
                out.push(rel_path);
            }
        }
        Ok(())
    }

    /// 바뀐 파일만 다시 읽는다. 다른 기기에서 들어온 변경은 external 로
    pub fn scan(&mut self) -> Changed {
        let (mut files, mut unread) = (vec![], vec![]);
        if self.list_files(&self.root.clone(), "", &mut files, &mut unread).is_err() {
            return Changed::default();
        }
        // 지금 것을 꺼내 바뀌지 않은 메모는 그대로 옮긴다 (2초마다 모든 본문을 복사하지 않게)
        let mut old = std::mem::take(&mut self.entries);
        let prev_by_file: HashMap<String, String> = old.values().filter_map(|e| Some((e.file.clone()?, e.id.clone()))).collect();
        // 아직 파일이 없는 새 메모는 그대로
        let new_ids: Vec<String> = old.values().filter(|e| e.file.is_none()).map(|e| e.id.clone()).collect();
        let mut next: HashMap<String, Entry> = new_ids.into_iter().filter_map(|id| Some((id.clone(), old.remove(&id)?))).collect();
        let mut changed: Vec<String> = vec![];
        let mut external = vec![];
        let mut locked_now: Vec<String> = vec![];
        for file in files {
            let path = self.abs(&file);
            let Ok(stamp) = stamp_of(&path) else {
                unread.push(file.clone()); // 목록을 읽은 뒤 잠깐 못 본 파일 — 지운 것이 아니다
                continue;
            };
            let prev = prev_by_file.get(&file).and_then(|id| old.get(id)).filter(|p| p.file.as_deref() == Some(file.as_str()));
            let keep = prev.is_some_and(|p| p.stamp == Some(stamp) && !next.contains_key(&p.id));
            let text = if keep { None } else { fs::read_to_string(&path).ok() };
            let Some(text) = text else {
                // 그대로이거나, 백신 · OneDrive 가 잠깐 붙잡아 못 읽었다 — 아는 내용 그대로
                if let Some(p) = prev.filter(|p| !next.contains_key(&p.id)).map(|p| p.id.clone()).and_then(|id| old.remove(&id)) {
                    next.insert(p.id.clone(), p);
                }
                continue;
            };
            let prev_unsaved = prev.filter(|p| !p.id_saved).map(|p| p.id.clone());
            let (mut meta, body) = memo_file::parse_memo_file(&text);
            // id 가 없는 파일(직접 만든 것)이나 id 가 겹치는 사본은 임시 id
            // shortcut: 폴더를 옮긴 사이 옛 자리가 되살아난 같은 id 두 파일(resolveMovedTwin)은 아직 사본처럼 다룬다 — 폴더 옮기기를 옮길 때
            let mut id = meta.id.clone();
            let mut id_saved = id.is_some();
            if id.as_ref().is_none_or(|i| next.contains_key(i)) {
                id = Some(prev_unsaved.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
                id_saved = false;
            }
            let id = id.unwrap();
            meta.id = Some(id.clone());
            // 머리말 없이 만든 파일은 파일 시각
            if meta.updated.is_none() {
                meta.updated = Some(local(stamp.0));
            }
            if meta.created.is_none() {
                let born = fs::metadata(&path).and_then(|m| m.created()).unwrap_or(stamp.0);
                meta.created = Some(local(born));
            }
            let old_body = old.get(&id).map(|e| e.body.as_str());
            // 다른 기기에서 잠갔거나 비밀번호를 바꾼 메모: 이 기기에 남은 풀린 버전 · 예전 비밀번호 버전을 지운다 (아래에서)
            let salt = |b: &str| lock::parse_locked(b).map(|p| p.salt);
            if body::is_locked_body(&body) && old_body.is_some_and(|o| salt(o) != salt(&body)) {
                locked_now.push(id.clone());
            }
            if old_body != Some(body.as_str()) && !self.own_files.contains(&file) {
                external.push(id.clone());
            }
            next.insert(id.clone(), Entry { id: id.clone(), file: Some(file), folder: String::new(), disk_meta: Some(meta.clone()), meta, body, stamp: Some(stamp), id_saved, secret: None });
            changed.push(id);
        }
        // 이번에 못 읽은 하위 폴더의 메모는 지운 것이 아니다 — 아는 그대로 둔다
        let keep: Vec<String> = old.values().filter(|e| !next.contains_key(&e.id) && e.file.as_ref().is_some_and(|f| unread.iter().any(|d| f.starts_with(d.as_str())))).map(|e| e.id.clone()).collect();
        for id in keep {
            if let Some(e) = old.remove(&id) {
                next.insert(id, e);
            }
        }
        let removed: Vec<String> = old.keys().filter(|id| !next.contains_key(*id)).cloned().collect();
        let now = SystemTime::now();
        self.removed_meta.retain(|_, (_, at)| now.duration_since(*at).is_ok_and(|d| d.as_millis() < 10 * 60_000));
        for id in &removed {
            if let Some(e) = old.remove(id) {
                self.removed_meta.insert(id.clone(), (e.meta, now));
            }
            changed.push(id.clone());
        }
        self.entries = next;
        // 분석해 둔 것 중 없어진 메모 것은 버린다 (쌓이지 않게)
        self.parts.lock().unwrap().retain(|id, _| self.entries.contains_key(id));
        for id in &locked_now {
            self.drop_unsafe_versions(id);
        }
        // 폴더만 생기거나 없어져도 목록이 폴더 목록을 다시 읽게
        let dirs = self.folders().join("\n");
        let dirs_changed = self.seen_dirs.as_ref().is_some_and(|d| *d != dirs);
        self.seen_dirs = Some(dirs);
        for id in std::mem::take(&mut self.adopted) {
            if self.entries.contains_key(&id) && !external.contains(&id) {
                if body::is_locked_body(&self.entries[&id].body) {
                    self.drop_unsafe_versions(&id);
                }
                external.push(id.clone());
                changed.push(id);
            }
        }
        Changed { ids: changed, external, removed, folders: dirs_changed }
    }

    /// 메모 폴더 맨 위의 메모킹 폴더 (빈 폴더도)
    pub fn folders(&self) -> Vec<String> {
        let Ok(rd) = fs::read_dir(&self.root) else { return vec![] };
        let mut out: Vec<String> = rd
            .flatten()
            .filter(|d| d.file_type().is_ok_and(|t| t.is_dir()))
            .map(|d| d.file_name().to_string_lossy().into_owned())
            .filter(|n| memo_file::clean_folder_name(n) == *n)
            .collect();
        out.sort();
        out
    }

    // ---------- 조회 ----------

    fn parts(&self, e: &Entry) -> std::sync::Arc<Parts> {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        e.body.hash(&mut h);
        let key = h.finish();
        if let Some((k, p)) = self.parts.lock().unwrap().get(&e.id) {
            if *k == key {
                return p.clone();
            }
        }
        let (title, preview, lines) = body::title_preview_lines(&e.body, 1200);
        let p = std::sync::Arc::new(Parts {
            title,
            preview,
            media: body::extract_media(&e.body),
            tags: body::extract_tags(&e.body),
            tasks: body::task_progress(&e.body),
            locked: body::is_locked_body(&e.body),
            web_link: has_web_link(&e.body),
            text: lines.join("\n"),
        });
        self.parts.lock().unwrap().insert(e.id.clone(), (key, p.clone()));
        p
    }

    pub fn summary(&self, e: &Entry) -> Value {
        let p = self.parts(e);
        let media = &p.media;
        let has = |k: &str| media.iter().any(|m| m.kind == k);
        let images: Vec<&str> = media
            .iter()
            .filter(|m| m.kind == "image" && !matches!(m.title.as_str(), "album page" | "album page ink"))
            .take(24)
            .map(|m| m.src.as_str())
            .collect();
        let live_reminders = e.meta.reminders.iter().filter(|r| crate::reminders::is_live_cached(r, chrono::Local::now())).count();
        json!({
            "id": e.id,
            "file": e.file,
            "title": p.title,
            "preview": p.preview,
            "color": e.meta.color,
            "pinned": e.meta.pinned,
            "pinnedAt": e.meta.extra.get("pinnedAt").and_then(Value::as_str),
            "created": e.meta.created,
            "updated": e.meta.updated,
            "thumb": media.iter().find(|m| m.kind == "image").map(|m| &m.src),
            "video": media.iter().find(|m| m.kind == "video").map(|m| &m.src),
            "images": images,
            "day": e.meta.day,
            "mode": e.meta.mode,
            "folder": e.file.as_deref().map_or(e.folder.as_str(), memo_file::folder_of),
            "tags": p.tags,
            "hasImage": has("image"),
            "hasWebLink": p.web_link,
            "hasAudio": has("audio"),
            "hasVideo": has("video"),
            "hasFile": has("file"),
            "reminderCount": live_reminders,
            "linkCount": e.meta.links.iter().filter(|id| self.entries.contains_key(*id)).count(),
            "tasks": p.tasks,
            "locked": p.locked,
            "secret": e.secret,
        })
    }

    /// 목록: 고정한 메모 먼저, 그다음 최근 고친 순
    pub fn list(&self) -> Vec<Value> {
        self.sorted().into_iter().map(|e| self.summary(e)).collect()
    }

    fn sorted(&self) -> Vec<&Entry> {
        let mut list: Vec<&Entry> = self.entries.values().filter(|e| e.file.is_some()).collect();
        let t = |e: &Entry| e.meta.updated.as_deref().and_then(time::parse_js_date).map_or(0, |d| d.timestamp_millis());
        // 날짜 읽기는 메모마다 한 번 (비교마다 읽으면 2,000개에 4만 번)
        // 상단 고정은 나중에 고정한 것이 위 (memo-sort.js 와 같음)
        let pinned_at = |e: &Entry| e.meta.extra.get("pinnedAt").and_then(Value::as_str).and_then(time::parse_js_date).map_or(0, |d| d.timestamp_millis());
        list.sort_by_cached_key(|e| (std::cmp::Reverse(e.meta.pinned), std::cmp::Reverse(if e.meta.pinned { pinned_at(e) } else { 0 }), std::cmp::Reverse(t(e))));
        list
    }

    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.entries.get(id)
    }

    /// 파일이 있는 메모들 (색인 · 내보내기)
    pub fn files(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values().filter(|e| e.file.is_some())
    }

    /// 이 메모의 본문 (잠겼으면 열쇠로 푼 글, 못 풀면 None)
    fn plain_of(&self, e: &Entry) -> Option<String> {
        if !body::is_locked_body(&e.body) {
            return Some(e.body.clone());
        }
        lock::unseal(&e.body, self.locks.get(&e.id)?)
    }

    /// 메모 창이 여는 메모 (잠긴 메모는 연 동안만 풀린 글)
    pub fn get(&self, id: &str) -> Option<Value> {
        let e = self.entries.get(id)?;
        let locked = body::is_locked_body(&e.body);
        let plain = self.plain_of(e);
        let extra_list = |k: &str| e.meta.extra.get(k).filter(|v| v.is_array()).cloned().unwrap_or(Value::Null);
        Some(json!({
            "id": id,
            "file": e.file,
            "body": plain.as_deref().unwrap_or(&e.body),
            "locked": locked,
            "needsPassword": locked && plain.is_none(),
            "title": body::extract_title(&e.body),
            "color": e.meta.color,
            "pinned": e.meta.pinned,
            "pinnedAt": e.meta.extra.get("pinnedAt").and_then(Value::as_str),
            "links": e.meta.links,
            "reminders": e.meta.reminders,
            "tables": e.meta.tables,
            "ink": e.meta.ink,
            "created": e.meta.created,
            "updated": e.meta.updated,
            "device": e.meta.device,
            "day": e.meta.day,
            "mode": e.meta.mode,
            "aiTags": extra_list("aiTags"),
            "aiEvents": extra_list("aiEvents"),
            "secret": e.secret,
        }))
    }

    // ---------- 쓰기 ----------

    fn new_entry(&self, id: &str, color: Option<&str>, mode: Option<&str>, folder: &str) -> Entry {
        let now = time::now_iso();
        let mut data = Map::new();
        data.insert("id".into(), id.into());
        data.insert("created".into(), now.clone().into());
        data.insert("updated".into(), now.into());
        if let Some(c) = color {
            data.insert("color".into(), c.into());
        }
        data.insert("mode".into(), mode.unwrap_or(&self.default_mode).into());
        Entry { id: id.into(), file: None, folder: memo_file::clean_folder_name(folder), meta: memo_file::normalize_meta(&data), body: String::new(), stamp: None, id_saved: true, disk_meta: None, secret: None }
    }

    /// 새 메모 — 내용이 생길 때 파일로 만든다 (빈 파일이 쌓이지 않게)
    pub fn create(&mut self, color: Option<&str>, mode: Option<&str>, folder: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let e = self.new_entry(&id, color, mode, folder);
        self.entries.insert(id.clone(), e);
        id
    }

    /// 글로 새 메모를 만들어 바로 쓴다 (충돌 사본 · 가져오기)
    pub fn import(&mut self, body: &str, color: Option<&str>) -> io::Result<Option<String>> {
        if body::is_locked_body(body) {
            return Ok(None); // 아무도 열 수 없는 메모가 되므로
        }
        let id = self.create(color, None, "");
        let mut e = self.entries.remove(&id).unwrap();
        e.body = body.into();
        let wrote = self.write(&mut e, "", true);
        self.entries.insert(id.clone(), e);
        wrote?;
        Ok(Some(id))
    }

    /// 메모 저장 → 목록 카드 (저장하지 않았으면 refused · retry · invalid 를 더해)
    pub fn save(&mut self, id: &str, body: &str) -> io::Result<(Value, bool)> {
        if !self.entries.contains_key(id) && crate::secret::is_secret_id(id) {
            // 잠긴 비밀 폴더의 메모: 풀린 글로 되살려 쓰지 않는다 (보통 메모 파일로 새지 않게)
            return Err(io::Error::other(crate::secret::LOCKED));
        }
        if !self.entries.contains_key(id) {
            // 쓰는 사이 파일이 지워졌다면, 화면에 남은 내용으로 되살린다 (잠깐 사라졌던 메모면 그 머리말로)
            let mut e = self.new_entry(id, None, None, "");
            if let Some((meta, _)) = self.removed_meta.remove(id) {
                e.meta = meta;
            }
            self.entries.insert(id.into(), e);
        }
        let mut e = self.entries.remove(id).unwrap();
        let result = self.save_entry(&mut e, body);
        self.entries.insert(id.into(), e);
        let (refused, changed) = result?;
        let summary = self.summary(&self.entries[id]);
        Ok(match refused {
            None => (summary, changed),
            Some(extra) => {
                let mut s = summary;
                s.as_object_mut().unwrap().extend(extra);
                (s, false)
            }
        })
    }

    // (거절했으면 Some(화면에 알릴 것), 바뀌었는가)
    fn save_entry(&mut self, e: &mut Entry, body: &str) -> io::Result<(Option<Map<String, Value>>, bool)> {
        let refuse = |invalid: bool, retry: bool| {
            let mut m = Map::new();
            m.insert("refused".into(), true.into());
            if invalid {
                m.insert("invalid".into(), true.into());
            }
            if retry {
                m.insert("retry".into(), true.into());
            }
            m.insert("copied".into(), false.into());
            Ok((Some(m), false))
        };
        if e.secret.is_some() {
            if body::is_locked_body(body) {
                return refuse(true, false);
            }
            return self.save_secret(e, body).map(|changed| (None, changed));
        }
        // 잠금 형식 글을 통째로: 지금 파일과 같으면 할 일 없음, 다르면 아무도 열 수 없게 되므로 저장하지 않는다
        if body::is_locked_body(body) {
            return if e.file.is_some() && body == e.body { Ok((None, false)) } else { refuse(true, false) };
        }
        let before = e.meta.clone();
        // 잠긴 메모: 연 동안만 저장하고, 저장은 늘 다시 잠근 글로 (풀린 글이 파일에 닿지 않게)
        let session = self.locks.get(&e.id).cloned();
        let body: String = if body::is_locked_body(&e.body) {
            let Some(s) = session else { return refuse(false, false) }; // 열지 않았다 — 덮어쓰지 않음
            let Some(plain) = lock::unseal(&e.body, &s) else { return refuse(false, false) }; // 다른 비밀번호로 다시 잠금
            if e.file.is_some() && plain == body {
                return Ok((None, false));
            }
            self.seal_into(e, body, &s)
        } else if let (Some(s), None) = (&session, &e.file) {
            // 열쇠를 든 메모인데 파일이 사라져 다시 만드는 중: 풀린 글이 새 파일로 나가지 않게 잠근 채로
            self.seal_into(e, body, s)
        } else {
            body.to_string()
        };
        if e.body == body && e.file.is_some() {
            e.meta = before;
            return Ok((None, false));
        }
        let known = std::mem::replace(&mut e.body, body.clone());
        e.meta.updated = Some(time::now_iso());
        e.meta.device = Some(self.device.clone());
        if e.file.is_none() && body::is_blank_body(&body) {
            return Ok((None, false));
        }
        if e.file.is_some() {
            self.keep_version(&e.id, &known, false);
        }
        match self.write(e, &known, true) {
            Ok(Wrote::Yes) => Ok((None, true)),
            Ok(other) => {
                e.meta = before; // 쓰지 않았으니 글 · 머리말도 그대로 (다시 저장할 때 "같은 글" 로 건너뛰지 않게)
                e.body = known;
                let r = refuse(false, other == Wrote::Skipped);
                if other == Wrote::Copied {
                    if let Ok((Some(mut m), c)) = r {
                        m.insert("copied".into(), true.into());
                        return Ok((Some(m), c));
                    }
                }
                r
            }
            Err(err) => {
                e.meta = before;
                e.body = known;
                Err(err)
            }
        }
    }

    /// 열쇠로 잠근 글 — 머리말에 첨부 표를 (첨부 정리가 이 메모의 사진을 치우지 않게)
    fn seal_into(&self, e: &mut Entry, plain: &str, s: &lock::Session) -> String {
        let sealed = lock::seal(plain, s, e.meta.extra.get("lockHideTitle") == Some(&Value::Bool(true)));
        e.meta.extra.insert("lockRefs".into(), json!(lock::lock_refs(plain, &sealed)));
        sealed
    }

    /// known: 파일에 있다고 알고 있는 본문 (save 가 바꾸기 전 것).
    ///   copy: 그사이 다른 기기가 고친 글을 사본으로 남기고 쓴다 — 잠그기 · 풀기 · 되돌리기는 false (멈추고 "다시 해 주세요")
    fn write(&mut self, e: &mut Entry, known: &str, copy: bool) -> io::Result<Wrote> {
        if e.secret.is_some() {
            return self.write_secret(e).map(|()| Wrote::Yes); // 비밀 메모는 늘 잠가서 (파일 이름 · 충돌 사본 없음)
        }
        if e.file.is_some() {
            if let Some(w) = self.keep_changed_on_disk(e, known, copy)? {
                return Ok(w);
            }
        }
        if e.file.is_none() {
            let base = memo_file::title_to_file_name(&body::extract_title(&e.body));
            e.file = Some(self.unique_file(&base, &e.folder.clone(), None));
        }
        let path = self.abs(e.file.as_ref().unwrap());
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        e.meta.id = Some(e.id.clone());
        write_atomic(&path, memo_file::serialize_memo_file(&e.meta, &e.body).as_bytes())?;
        e.stamp = stamp_of(&path).ok();
        e.id_saved = true;
        e.disk_meta = Some(e.meta.clone());
        Ok(Wrote::Yes)
    }

    /// 마지막으로 읽은(쓴) 뒤 다른 기기가 이 파일을 바꿨는데 아직 알아채기 전에 덮어쓰려 할 때.
    ///   None: 그대로 쓴다 · Some: 쓰지 않는다
    fn keep_changed_on_disk(&mut self, e: &mut Entry, known: &str, copy: bool) -> io::Result<Option<Wrote>> {
        let path = self.abs(e.file.as_ref().unwrap());
        let stamp = match stamp_of(&path) {
            Ok(s) => s,
            // 정말 없을 때만 — 다른 기기가 지웠거나 이름을 바꿈: 바로 되살려 쓰지 않고 먼저 다시 읽는다
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                e.body = known.into();
                return Ok(Some(Wrote::Skipped));
            }
            Err(_) => return Ok(None), // 백신 등이 잠깐 붙잡음 — 그대로 써 본다
        };
        if Some(stamp) == e.stamp {
            return Ok(None);
        }
        let Ok(text) = fs::read_to_string(&path) else { return Ok(None) };
        let (their_meta, theirs) = memo_file::parse_memo_file(&text);
        if body::same_body(&theirs, known) || body::same_body(&theirs, &e.body) || body::is_blank_body(&theirs) {
            return Ok(None);
        }
        if body::same_body(&e.body, known) {
            // 이번 쓰기는 머리말만 — 들어온 글을 그대로 두고 이 기기가 바꾼 머리말만 더해 쓴다
            self.adopt_theirs(e, theirs, their_meta);
            return Ok(None);
        }
        if body::is_locked_body(&theirs) {
            return self.locked_on_disk(e, known, &theirs, copy);
        }
        if !copy {
            // 잠그기 · 풀기 · 되돌리기 중: 그쪽 글을 덮어쓰지 않고 멈춘다
            e.body = known.into();
            return Ok(Some(Wrote::Locked));
        }
        // 들어온 글을 사본 메모로 남기고 우리 글을 쓴다 — 아무것도 잃지 않게
        self.keep_version(&e.id, &theirs, true);
        self.import(&memo_file::conflict_copy_body(&theirs, &memo_file::conflict_label(chrono::Local::now())), Some(&e.meta.color.clone()))?;
        Ok(None)
    }

    /// 머리말만 쓰는 사이 다른 기기가 글을 바꿨다 (JS adoptTheirs): 그쪽 글 · 머리말을 바탕으로, 이 기기가 (마지막으로 읽은 뒤)
    ///   바꾼 항목만 더한다 — 그쪽에서 지운 알림이 되살아나지 않게. 잠금 정보(lockRefs · lockHideTitle)는 늘 그쪽 것
    fn adopt_theirs(&mut self, e: &mut Entry, theirs: String, their_meta: Meta) {
        let to = |m: &Meta| serde_json::to_value(m).unwrap();
        let (mine, theirs_v) = (to(&e.meta), to(&their_meta));
        let disk = e.disk_meta.as_ref().map(to);
        let changed = |k: &str, v: &Value| disk.as_ref().is_none_or(|d| d.get(k) != Some(v));
        let mut merged = theirs_v.as_object().unwrap().clone();
        for (k, v) in mine.as_object().unwrap() {
            match k.as_str() {
                "extra" | "id" => {}
                "reminders" => {
                    let list = |v: Option<&Value>| v.and_then(Value::as_array).cloned().unwrap_or_default();
                    merged.insert(k.clone(), Value::Array(merge_reminders(&list(Some(v)), &list(disk.as_ref().and_then(|d| d.get(k))), &list(theirs_v.get(k)))));
                }
                _ if changed(k, v) => {
                    merged.insert(k.clone(), v.clone());
                }
                _ => {}
            }
        }
        let lock_key = |k: &str| k == "lockRefs" || k == "lockHideTitle";
        let disk_extra = disk.as_ref().and_then(|d| d["extra"].as_object().cloned()).unwrap_or_default();
        let mut extra = theirs_v["extra"].as_object().cloned().unwrap_or_default();
        for (k, v) in mine["extra"].as_object().unwrap() {
            if !lock_key(k) && (disk.is_none() || disk_extra.get(k) != Some(v)) {
                extra.insert(k.clone(), v.clone());
            }
        }
        // 이 기기가 지운 항목도 (그쪽이 그사이 바꾸지 않았으면) 지운 채로
        for (k, v) in &disk_extra {
            if !lock_key(k) && !mine["extra"].as_object().unwrap().contains_key(k) && theirs_v["extra"].get(k) == Some(v) {
                extra.shift_remove(k);
            }
        }
        merged.insert("extra".into(), Value::Object(extra));
        merged.insert("id".into(), mine["id"].clone());
        e.meta = serde_json::from_value(Value::Object(merged)).unwrap_or(their_meta);
        if body::is_locked_body(&theirs) {
            for r in &mut e.meta.reminders {
                if let Some(o) = r.as_object_mut() {
                    o.shift_remove("title"); // 잠긴 글의 일정 이름은 풀린 머리말에 남기지 않는다
                }
            }
        }
        e.body = theirs;
        self.adopted.push(e.id.clone()); // 다음 다시 읽기에서 열린 화면에 알린다 (scan → external)
    }

    /// 덮어쓰려는 사이 다른 기기가 잠근 글로 바꿨다 (JS lockedOnDisk)
    ///   같은 비밀번호로 고친 것(들고 있는 열쇠로 풀림): 그쪽 글을 잠근 사본으로 남기고 저장은 계속 → None
    ///   잠갔거나 다른 비밀번호: 파일은 그대로, 우리 글은 사본으로(copy 일 때) → Copied · Locked
    fn locked_on_disk(&mut self, e: &mut Entry, known: &str, theirs: &str, copy: bool) -> io::Result<Option<Wrote>> {
        let session = self.locks.get(&e.id).cloned();
        if let Some(theirs_plain) = session.as_ref().and_then(|s| lock::unseal(theirs, s)) {
            if !copy {
                e.body = known.into();
                return Ok(Some(Wrote::Locked));
            }
            self.keep_version(&e.id, theirs, true);
            if !body::is_blank_body(&theirs_plain) {
                let copy_body = memo_file::conflict_copy_body(&theirs_plain, &memo_file::conflict_label(chrono::Local::now()));
                self.new_locked_copy(e, &copy_body, session.as_ref().unwrap())?;
            }
            return Ok(None);
        }
        let mine = e.body.clone();
        let mut copied = false;
        if copy && !body::is_blank_body(&mine) && !body::same_body(&mine, known) {
            // 우리 글: 잠근 글이면 그대로(열쇠로 표를 만들어), 풀린 글이면 풀린 사본으로 — 잃지 않게
            let plain = session.as_ref().and_then(|s| lock::unseal(&mine, s));
            match (plain, &session) {
                (Some(p), Some(s)) => {
                    self.new_locked_copy(e, &p, s)?;
                }
                _ => {
                    self.import(&mine, Some(&e.meta.color.clone()))?;
                }
            }
            copied = true;
        }
        e.body = known.into(); // 곧 다시 읽을 때 "바뀌었다" 로 알아채고 열린 화면에 알리게
        Ok(Some(if copied { Wrote::Copied } else { Wrote::Locked }))
    }

    /// 잠긴 메모의 사본: 같은 열쇠로 잠근다 (풀린 글이 사본으로 새지 않게). 사본은 따로 열 때 비밀번호를 묻는다
    ///   shortcut: JS 는 원래 메모가 열려 있는 동안 사본 열쇠도 들고 있다(lockCopies) — 여기서는 사본은 늘 비밀번호로
    fn new_locked_copy(&mut self, source: &Entry, plain: &str, s: &lock::Session) -> io::Result<String> {
        let id = self.create(Some(&source.meta.color.clone()), Some(&source.meta.mode.clone()), "");
        let mut c = self.entries.remove(&id).unwrap();
        if source.meta.extra.get("lockHideTitle") == Some(&Value::Bool(true)) {
            c.meta.extra.insert("lockHideTitle".into(), true.into());
        }
        c.body = self.seal_into(&mut c, plain, s);
        let r = self.write(&mut c, "", true);
        self.entries.insert(id.clone(), c);
        r?;
        Ok(id)
    }

    // ---------- 잠금 ----------

    /// 비밀번호로 연다 (열쇠가 이 메모를 풀 수 있어야) → 메모
    pub fn open_lock(&mut self, id: &str, s: lock::Session) -> Option<Value> {
        let e = self.entries.get(id)?;
        if !body::is_locked_body(&e.body) || lock::unseal(&e.body, &s).is_none() {
            return None;
        }
        self.locks.insert(id.into(), s.clone());
        // 첨부 표가 없는 예전 잠금: 연 김에 적어 둔다 — 없으면 첨부 정리가 모두 멈추므로
        if !self.entries[id].meta.extra.get("lockRefs").is_some_and(Value::is_array) {
            let mut e = self.entries.remove(id).unwrap();
            let before = e.meta.clone();
            let plain = lock::unseal(&e.body, &s).unwrap_or_default();
            e.meta.extra.insert("lockRefs".into(), json!(lock::lock_refs(&plain, &e.body)));
            let known = e.body.clone();
            if !matches!(self.write(&mut e, &known, false), Ok(Wrote::Yes)) {
                e.meta = before; // 쓰지 못한 표는 남기지 않는다 (다음에 다시)
            }
            self.entries.insert(id.into(), e);
        }
        self.get(id)
    }

    /// 열쇠를 들고 있는 메모인가
    pub fn is_open_lock(&self, id: &str) -> bool {
        self.locks.contains_key(id)
    }

    /// 저장하지 못한 글을 사본 메모로 — 원래 메모가 잠겼으면 같은 열쇠로 잠근 사본 (풀린 글이 새지 않게)
    pub fn import_copy_of(&mut self, source_id: &str, body: &str) -> io::Result<Option<String>> {
        if crate::secret::is_secret_id(source_id) {
            return Ok(None); // 비밀 메모의 글은 보통 메모 사본으로 남기지 않는다
        }
        let Some(src) = self.entries.get(source_id).cloned() else { return self.import(body, None) };
        match self.locks.get(source_id).cloned() {
            Some(s) if !body::is_locked_body(body) => self.new_locked_copy(&src, body, &s).map(Some),
            _ if body::is_locked_body(&src.body) || body::is_locked_body(body) => Ok(None), // 열쇠 없이는 사본도 만들지 않는다
            _ => self.import(body, Some(&src.meta.color)),
        }
    }

    /// 메모를 닫을 때 열쇠를 잊는다
    pub fn close_lock(&mut self, id: &str) {
        self.locks.remove(id);
    }

    /// 잠그기: 지금 본문을 잠근 글로, 잠그기 전 버전(풀린 글)은 지운다. keep_open: 열린 메모면 열쇠를 들고 있는다
    pub fn lock(&mut self, id: &str, s: lock::Session, keep_open: bool, hide_title: bool) -> io::Result<Option<Value>> {
        let Some(mut e) = self.entries.remove(id) else { return Ok(None) };
        if body::is_locked_body(&e.body) || e.secret.is_some() {
            self.entries.insert(id.into(), e);
            return Ok(None);
        }
        let known = e.body.clone();
        let before = e.meta.clone();
        e.meta.extra.shift_remove("lockHideTitle");
        if hide_title {
            e.meta.extra.insert("lockHideTitle".into(), true.into());
        }
        e.body = self.seal_into(&mut e, &known, &s);
        // 글에서 짐작한 일정 이름은 비밀일 수 있어 풀린 머리말에 남기지 않는다 (알림엔 메모 제목)
        for r in &mut e.meta.reminders {
            if let Some(o) = r.as_object_mut() {
                o.shift_remove("title");
            }
        }
        e.meta.updated = Some(time::now_iso());
        e.meta.device = Some(self.device.clone());
        let r = self.write(&mut e, &known, false);
        let ok = matches!(r, Ok(Wrote::Yes));
        if !ok {
            e.body = known;
            e.meta = before;
        }
        self.entries.insert(id.into(), e);
        r?;
        if !ok {
            return Ok(None); // 그사이 다른 기기가 바꿈 — 아무것도 바꾸지 않음
        }
        self.purge_versions(id);
        if keep_open {
            self.locks.insert(id.into(), s);
        } else {
            self.locks.remove(id);
        }
        if hide_title {
            self.finalize(id)?; // 파일 이름도 바로 "잠긴 메모" 로
        }
        Ok(self.get(id))
    }

    /// 잠금 풀기 (연 동안만): 본문을 풀린 글로
    pub fn unlock(&mut self, id: &str) -> io::Result<Option<Value>> {
        let Some(plain) = self.entries.get(id).filter(|e| body::is_locked_body(&e.body)).and_then(|e| self.plain_of(e)) else { return Ok(None) };
        let mut e = self.entries.remove(id).unwrap();
        let known = std::mem::replace(&mut e.body, plain);
        let before = e.meta.clone();
        e.meta.extra.shift_remove("lockRefs");
        e.meta.extra.shift_remove("lockHideTitle");
        e.meta.updated = Some(time::now_iso());
        e.meta.device = Some(self.device.clone());
        let r = self.write(&mut e, &known, false);
        let ok = matches!(r, Ok(Wrote::Yes));
        if !ok {
            e.body = known;
            e.meta = before;
        }
        self.entries.insert(id.into(), e);
        r?;
        if !ok {
            return Ok(None);
        }
        self.purge_versions(id); // 잠긴 동안의 버전은 이제 열 수 없는 글이므로
        self.locks.remove(id);
        Ok(self.get(id))
    }

    fn purge_versions(&self, id: &str) {
        if let Some(dir) = self.version_dir(id) {
            let _ = fs::remove_dir_all(dir);
        }
    }

    /// 잠긴 메모의 버전 중 지금 비밀번호로 잠긴 것이 아닌 것(잠기기 전 풀린 글 · 예전 비밀번호)이 있으면 모두 지운다
    fn drop_unsafe_versions(&self, id: &str) {
        let Some(salt) = self.entries.get(id).and_then(|e| lock::parse_locked(&e.body)).map(|p| p.salt) else { return };
        let Some(dir) = self.version_dir(id) else { return };
        let mut timed: Vec<(u128, String)> = version_names(&dir).into_iter().map(|n| (version_time(&n).unwrap_or(0), n)).collect();
        timed.sort();
        let newest = timed.last().map(|v| v.0);
        let check = timed.first().into_iter().chain(timed.iter().filter(|v| Some(v.0) == newest));
        if check.into_iter().any(|(_, n)| self.version(id, n).and_then(|b| lock::parse_locked(&b)).map(|p| p.salt) != Some(salt.clone())) {
            self.purge_versions(id);
        }
    }

    /// 같은 폴더에서 겹치지 않는 이름: "제목.md", "제목 (2).md", …
    fn unique_file(&self, base: &str, dir: &str, current: Option<&str>) -> String {
        for n in 1.. {
            let name = if n == 1 { format!("{base}.md") } else { format!("{base} ({n}).md") };
            let file = if dir.is_empty() { name } else { format!("{dir}/{name}") };
            if current.is_some_and(|c| same_name(&file, c)) {
                return current.unwrap().into();
            }
            let taken = self.entries.values().any(|e| e.file.as_deref().is_some_and(|f| same_name(f, &file)));
            if !taken && !self.abs(&file).exists() {
                return file;
            }
        }
        unreachable!()
    }

    /// 창을 닫을 때: 빈 메모는 치우고, 제목이 바뀌었으면 파일 이름을 맞춘다 → 바뀌었는가
    pub fn finalize(&mut self, id: &str) -> io::Result<bool> {
        let Some(e) = self.entries.get(id) else { return Ok(false) };
        if e.secret.is_some() {
            if body::is_blank_body(&e.body) {
                self.remove_secret(id)?; // 빈 비밀 메모는 남기지 않는다
                return Ok(true);
            }
            return Ok(false);
        }
        if body::is_blank_body(&e.body) {
            if e.file.is_some() {
                self.trash(id)?;
            } else {
                self.entries.remove(id);
            }
            return Ok(true);
        }
        let Some(file) = e.file.clone() else { return Ok(false) };
        let base = memo_file::title_to_file_name(&body::extract_title(&e.body));
        let dir = file.rsplit_once('/').map_or("", |(d, _)| d).to_string();
        let current = file.rsplit('/').next().unwrap_or(&file).trim_end_matches(".md").to_string();
        if current == base || current.starts_with(&format!("{base} (")) {
            return Ok(false);
        }
        let target = self.unique_file(&base, &dir, Some(&file));
        if target == file {
            return Ok(false);
        }
        fs::rename(self.abs(&file), self.abs(&target))?;
        self.entries.get_mut(id).unwrap().file = Some(target);
        Ok(true)
    }

    /// 휴지통 자리 "제목 (지운 시각).md" — 겹치면 "제목 (2) (지운 시각).md"
    fn trash_path(&self, base: &str) -> PathBuf {
        let stamp = file_stamp(chrono::Local::now());
        (1..)
            .map(|n| self.trash_dir().join(format!("{base}{} ({stamp}).md", if n > 1 { format!(" ({n})") } else { String::new() })))
            .find(|p| !p.exists())
            .unwrap()
    }

    /// 휴지통으로 → 휴지통 파일 이름 (되돌리기에 씀)
    ///   shortcut: 이 메모만 쓰던 첨부를 휴지통으로 옮기는 정리(trashAttachments)는 아직 — 첨부는 그대로 남는다 (잃는 것 없음)
    pub fn trash(&mut self, id: &str) -> io::Result<Option<String>> {
        if self.entries.get(id).is_some_and(|e| e.secret.is_some()) {
            self.remove_secret(id)?; // 휴지통은 잠기지 않는 곳 — 비밀 메모는 바로 지운다
            return Ok(None);
        }
        let Some(e) = self.entries.remove(id) else { return Ok(None) };
        self.locks.remove(id); // 지운 잠긴 메모의 열쇠를 남기지 않는다 (되살리면 다시 비밀번호로)
        let Some(file) = &e.file else { return Ok(None) };
        let base = file.rsplit('/').next().unwrap_or(file).trim_end_matches(".md");
        let dest = self.trash_path(base);
        match fs::rename(self.abs(file), &dest) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                self.entries.insert(id.into(), e);
                return Err(err);
            }
        }
        // 폴더에 있던 메모는 되살릴 때 그 폴더로 — 머리말에 남긴다
        let folder = memo_file::folder_of(file);
        if !folder.is_empty() {
            if let Ok(text) = fs::read_to_string(&dest) {
                let (mut meta, body) = memo_file::parse_memo_file(&text);
                meta.extra.insert("trashedFrom".into(), folder.into());
                let _ = write_atomic(&dest, memo_file::serialize_memo_file(&meta, &body).as_bytes());
            }
        }
        Ok(dest.file_name().map(|n| n.to_string_lossy().into_owned()))
    }

    /// 메모 폴더 안의 파일만 (../ 로 밖을 가리키면 None)
    pub fn resolve(&self, rel: &str) -> Option<PathBuf> {
        let mut out = self.root.clone();
        for part in rel.split(['/', '\\']) {
            match part {
                "" | "." => {}
                ".." => return None,
                p if p.contains(':') => return None,
                p => out.push(p),
            }
        }
        (out != self.root).then_some(out)
    }

    // ---------- 버전 기록 (_memoking/versions/<id>/<시각>.md) ----------

    fn version_dir(&self, id: &str) -> Option<PathBuf> {
        let ok = !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        ok.then(|| self.app_dir().join("versions").join(id))
    }

    /// 덮어쓰기 전 내용(before)을 남긴다. 계속 쓰는 동안은 10분에 하나, force 면 바로
    pub fn keep_version(&self, id: &str, before: &str, force: bool) -> Option<String> {
        let dir = self.version_dir(id)?;
        if body::is_blank_body(before) {
            return None;
        }
        let names = version_names(&dir);
        let newest = names.iter().filter_map(|n| Some((version_time(n)?, n))).max_by_key(|(t, _)| *t);
        if let Some((at, name)) = newest {
            if fs::read_to_string(dir.join(name)).is_ok_and(|b| body::same_body(&b, before)) {
                return None;
            }
            if !force && ms(SystemTime::now()).saturating_sub(at) < VERSION_GAP_MS {
                return None;
            }
        }
        fs::create_dir_all(&dir).ok()?;
        let base = file_stamp(chrono::Local::now());
        let name = (1..).map(|n| if n == 1 { format!("{base}.md") } else { format!("{base}-{n}.md") }).find(|n| !names.contains(n)).unwrap();
        write_atomic(&dir.join(&name), before.as_bytes()).ok()?;
        let mut all = names;
        all.push(name.clone());
        for old in versions_to_prune(&all, ms(SystemTime::now())) {
            let _ = fs::remove_file(dir.join(old));
        }
        Some(name)
    }
}

// ---------- 휴지통 · 버전 · 폴더 · 머리말 · 연결 · 찾기 ----------
impl Vault {
    /// 찾기 — 제목 · 본문 글(서식 뺀 줄)에서
    pub fn search(&self, query: &str, exclude: Option<&str>) -> Vec<Value> {
        let matches = crate::search::matcher(query);
        // 맞는 메모만 카드로 만든다 (글자를 칠 때마다 2,000개 카드를 다 만들지 않게)
        self.sorted()
            .into_iter()
            .filter(|e| {
                let p = self.parts(e);
                Some(e.id.as_str()) != exclude && matches(&[p.title.as_str(), p.text.as_str()])
            })
            .map(|e| self.summary(e))
            .collect()
    }

    /// 색 · 고정 · 표 크기 · 그림 · 회상 날 · Work/Life — 머리말만 쓴다. 쓰지 못했으면 되돌리고 None
    pub fn set_meta(&mut self, id: &str, patch: &Value) -> io::Result<Option<Value>> {
        let Some(mut e) = self.entries.remove(id) else { return Ok(None) };
        let prev = e.meta.clone();
        if let Some(c) = patch["color"].as_str().filter(|c| memo_file::COLORS.contains(c)) {
            e.meta.color = c.into();
        }
        if let Some(p) = patch["pinned"].as_bool().filter(|p| *p != e.meta.pinned) {
            // 상단 고정한 때 — 목록의 상단 고정 묶음은 나중에 고정한 것이 위 (vault-locks.js setMeta 와 같음)
            e.meta.pinned = p;
            e.meta.extra.remove("pinnedAt");
            if p {
                e.meta.extra.insert("pinnedAt".into(), time::now_iso().into());
            }
        }
        if patch["tables"].is_array() {
            e.meta.tables = crate::tables::normalize_tables(&patch["tables"]);
        }
        if let Some(ink) = patch["ink"].as_str() {
            e.meta.ink = memo_file::normalize_ink_path(&Value::String(ink.into()));
        }
        if let Some(day) = patch.get("day") {
            e.meta.day = memo_file::normalize_day(if day.is_null() { &Value::Null } else { day });
        }
        if let Some(m) = patch["mode"].as_str().filter(|m| *m == "work" || *m == "life") {
            e.meta.mode = m.into();
        }
        let known = e.body.clone();
        let wrote = if e.file.is_some() || e.secret.is_some() { self.write(&mut e, &known, true) } else { Ok(Wrote::Yes) };
        let ok = matches!(wrote, Ok(Wrote::Yes));
        if !ok {
            e.meta = prev; // 쓰지 못했다 — 바뀐 것처럼 보이지 않게
        }
        self.entries.insert(id.into(), e);
        wrote?;
        Ok(if ok { self.get(id) } else { None })
    }

    /// 모든 메모의 알림 (reminders:all · 알림 실행기)
    pub fn all_reminders(&self) -> Vec<Value> {
        let mut out = vec![];
        for e in self.files() {
            for r in &e.meta.reminders {
                out.push(json!({ "memoId": e.id, "title": body::extract_title(&e.body), "color": e.meta.color, "updated": e.meta.updated, "locked": body::is_locked_body(&e.body), "stable": e.id_saved, "reminder": r }));
            }
        }
        out
    }

    /// 알림 목록 통째로 바꾸기 — 내용 수정이 아니라 updated 는 그대로. 쓰지 못했으면 되돌리고 None
    pub fn set_reminders(&mut self, id: &str, reminders: Vec<Value>) -> io::Result<Option<Vec<Value>>> {
        let Some(mut e) = self.entries.remove(id) else { return Ok(None) };
        let prev = std::mem::replace(&mut e.meta.reminders, reminders);
        // 잠긴 메모의 일정 이름은 머리말(풀린 글)에 남기지 않는다 — 글에서 짐작한 이름이 비밀일 수 있음 (알림엔 메모 제목)
        if body::is_locked_body(&e.body) {
            for r in &mut e.meta.reminders {
                if let Some(o) = r.as_object_mut() {
                    o.shift_remove("title");
                }
            }
        }
        let known = e.body.clone();
        let wrote = if e.file.is_some() || !body::is_blank_body(&e.body) { self.write(&mut e, &known, true) } else { Ok(Wrote::Yes) };
        let ok = matches!(wrote, Ok(Wrote::Yes));
        if !ok {
            e.meta.reminders = prev; // 저장된 것처럼 보이지 않게
        }
        let saved = e.meta.reminders.clone();
        self.entries.insert(id.into(), e);
        wrote?;
        Ok(ok.then_some(saved))
    }

    /// AI 가 단 태그: 본문과 머리말 aiTags (vault-locks.js setAiTags) — 고친 시각 · 기기는 그대로
    ///   (모든 메모를 한 번에 태그해도 목록 순서가 바뀌거나 휴대폰에 "방금 고친 메모" 가 뜨지 않게). 쓰지 못했으면 되돌리고 None
    pub fn set_ai_tags(&mut self, id: &str, body: &str, names: &[String]) -> io::Result<Option<Value>> {
        let Some(mut e) = self.entries.remove(id) else { return Ok(None) };
        if e.file.is_none() || body::is_locked_body(&e.body) {
            self.entries.insert(id.into(), e);
            return Ok(None);
        }
        let (prev, known) = (e.meta.clone(), e.body.clone());
        e.body = body.into();
        e.meta.extra.insert("aiTags".into(), json!(names));
        if body != known {
            self.keep_version(id, &known, false);
        }
        // 다른 기기가 고친 글이 디스크에 있으면 쓰지 않는다 — 사본을 만들면 옛 글이 진짜 메모로 남는다. 다시 읽은 뒤 다음에 태그
        let wrote = self.write(&mut e, &known, false);
        let ok = matches!(wrote, Ok(Wrote::Yes));
        if !ok {
            e.meta = prev;
            e.body = known;
        }
        self.entries.insert(id.into(), e);
        wrote?;
        Ok(if ok { self.get(id) } else { None })
    }

    /// AI 가 글에서 찾아 넣은 일정과 본 줄 aiEvents (vault-locks.js addAiEvents) — 고친 시각은 그대로. 쓰지 못했으면 되돌리고 None
    pub fn add_ai_events(&mut self, id: &str, events: &[Value], seen: &[String]) -> io::Result<Option<Value>> {
        let Some(mut e) = self.entries.remove(id) else { return Ok(None) };
        if e.file.is_none() || body::is_locked_body(&e.body) {
            self.entries.insert(id.into(), e);
            return Ok(None);
        }
        let (prev, known) = (e.meta.clone(), e.body.clone());
        e.meta.reminders.extend_from_slice(events);
        e.meta.extra.insert("aiEvents".into(), json!(seen));
        let wrote = self.write(&mut e, &known, true);
        let ok = matches!(wrote, Ok(Wrote::Yes));
        if !ok {
            e.meta = prev;
        }
        self.entries.insert(id.into(), e);
        wrote?;
        Ok(if ok { self.get(id) } else { None })
    }

    /// 연결한 메모 · 나를 연결한 메모
    pub fn links(&self, id: &str) -> Value {
        let Some(e) = self.entries.get(id) else { return json!({ "links": [], "backlinks": [], "suggestions": [] }) };
        let brief = |e: &Entry| json!({ "id": e.id, "title": body::extract_title(&e.body), "color": e.meta.color });
        let links: Vec<Value> = e.meta.links.iter().filter_map(|to| self.entries.get(to)).map(brief).collect();
        let backlinks: Vec<Value> = self.entries.values().filter(|o| o.id != id && o.meta.links.iter().any(|l| l == id)).map(brief).collect();
        // shortcut: 비슷한 메모 추천(색인의 related)은 색인(index.json)을 옮길 때
        json!({ "links": links, "backlinks": backlinks, "suggestions": [] })
    }

    /// 메모 연결 켜고 끄기 — 쓰지 못했으면 되돌리고 None
    pub fn link(&mut self, id: &str, target: &str, on: bool) -> io::Result<Option<Value>> {
        if id == target || !self.entries.contains_key(id) || !self.entries.contains_key(target) {
            return Ok(None);
        }
        // 상대 메모에 id 가 저장돼 있어야 파일 이름이 바뀌어도 연결이 남는다
        if on {
            let mut t = self.entries.remove(target).unwrap();
            let known = t.body.clone();
            let r = if (t.file.is_some() || t.secret.is_some()) && !t.id_saved { self.write(&mut t, &known, true) } else { Ok(Wrote::Yes) };
            self.entries.insert(target.into(), t);
            if !matches!(r?, Wrote::Yes) {
                return Ok(None);
            }
        }
        let mut e = self.entries.remove(id).unwrap();
        let prev = e.meta.links.clone();
        e.meta.links.retain(|l| l != target);
        if on {
            e.meta.links.push(target.into());
        }
        let known = e.body.clone();
        let r = if e.file.is_some() || e.secret.is_some() { self.write(&mut e, &known, true) } else { Ok(Wrote::Yes) };
        let ok = matches!(r, Ok(Wrote::Yes));
        if !ok {
            e.meta.links = prev;
        }
        self.entries.insert(id.into(), e);
        r?;
        Ok(ok.then(|| self.links(id)))
    }

    // ---------- 버전 ----------

    /// 버전 목록 (새것 먼저)
    pub fn versions(&self, id: &str) -> Vec<Value> {
        let Some(dir) = self.version_dir(id) else { return vec![] };
        let mut list: Vec<(u128, String, String)> = version_names(&dir).into_iter().filter_map(|n| Some((version_time(&n)?, fs::read_to_string(dir.join(&n)).ok()?, n))).collect();
        list.sort_by_key(|v| std::cmp::Reverse(v.0));
        list.into_iter()
            .map(|(at, text, name)| {
                let iso = chrono::DateTime::from_timestamp_millis(at as i64).map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
                json!({ "name": name, "at": iso, "title": body::extract_title(&text), "preview": body::extract_preview(&text, 120), "chars": text.encode_utf16().count() })
            })
            .collect()
    }

    pub fn version(&self, id: &str, name: &str) -> Option<String> {
        let dir = self.version_dir(id)?;
        (version_time(name).is_some() && !name.contains(['/', '\\'])).then(|| fs::read_to_string(dir.join(name)).ok()).flatten()
    }

    /// 지금 내용도 버전으로 남겨 두고(되돌리기를 되돌릴 수 있게) 고른 버전으로 바꾼다
    pub fn restore_version(&mut self, id: &str, name: &str) -> io::Result<Value> {
        let (Some(text), Some(e)) = (self.version(id, name), self.entries.get(id)) else { return Ok(Value::Null) };
        // 풀린 메모에는 잠긴 버전을, 잠긴 메모에는 풀린 버전 · 다른 비밀번호 버전을 되돌리지 않는다 (잠긴 메모는 연 동안만)
        let salt = |b: &str| lock::parse_locked(b).map(|p| p.salt);
        let can = if body::is_locked_body(&e.body) { self.locks.contains_key(id) && body::is_locked_body(&text) && salt(&text) == salt(&e.body) } else { !body::is_locked_body(&text) };
        if !can {
            return Ok(json!({ "error": "잠긴 메모에는 잠기기 전 버전을 되돌릴 수 없어요" }));
        }
        let current = e.body.clone();
        self.keep_version(id, &current, true);
        let mut e = self.entries.remove(id).unwrap();
        let before = e.meta.clone();
        e.body = text;
        e.meta.updated = Some(time::now_iso());
        e.meta.device = Some(self.device.clone());
        if body::is_locked_body(&e.body) {
            // 되돌린 잠긴 글의 첨부 표도 그 글에 맞게 (첨부 정리가 치우지 않게)
            match self.locks.get(id).and_then(|s| lock::unseal(&e.body, s)) {
                Some(plain) => {
                    e.meta.extra.insert("lockRefs".into(), json!(lock::lock_refs(&plain, &e.body)));
                }
                None => {
                    e.meta.extra.shift_remove("lockRefs");
                }
            }
        }
        let r = self.write(&mut e, &current, false);
        let ok = matches!(r, Ok(Wrote::Yes));
        if !ok {
            e.body = current;
            e.meta = before;
        }
        self.entries.insert(id.into(), e);
        r?;
        Ok(if ok { self.get(id).unwrap_or(Value::Null) } else { json!({ "error": "그사이 다른 기기에서 이 메모가 바뀌어 되돌리지 못했어요. 다시 해 주세요" }) })
    }

    // ---------- 폴더 ----------

    pub fn create_folder(&self, name: &str) -> Result<String, String> {
        let dir = memo_file::clean_folder_name(name);
        if dir.is_empty() {
            return Err("폴더 이름으로 쓸 수 없어요".into());
        }
        fs::create_dir_all(self.root.join(&dir)).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    /// 옮긴 메모의 머리말에 옮긴 때(moved) — 디스크의 글 그대로에 더한다 (잠긴 메모가 풀린 채 쓰이지 않게)
    fn stamp_moved(&mut self, id: &str) {
        let Some(file) = self.entries.get(id).and_then(|e| e.file.clone()) else { return };
        let path = self.abs(&file);
        let Ok(text) = fs::read_to_string(&path) else { return };
        let (mut meta, b) = memo_file::parse_memo_file(&text);
        let moved = time::now_iso();
        meta.extra.insert("moved".into(), moved.clone().into());
        if write_atomic(&path, memo_file::serialize_memo_file(&meta, &b).as_bytes()).is_ok() {
            let e = self.entries.get_mut(id).unwrap();
            e.meta.extra.insert("moved".into(), moved.into());
            e.stamp = stamp_of(&path).ok();
        }
    }

    /// 메모를 다른 폴더로 ("" = 맨 위) → 옮겼는가
    pub fn move_to_folder(&mut self, id: &str, folder: &str) -> Result<bool, String> {
        let dir = memo_file::clean_folder_name(folder);
        if !folder.is_empty() && dir.is_empty() {
            return Err("폴더 이름으로 쓸 수 없어요".into());
        }
        let Some(e) = self.entries.get_mut(id) else { return Ok(false) };
        let Some(file) = e.file.clone() else {
            e.folder = dir; // 아직 파일이 없는 새 메모 — 처음 저장할 때 이 폴더에
            return Ok(true);
        };
        if memo_file::folder_of(&file) == dir {
            return Ok(true);
        }
        let base = file.rsplit('/').next().unwrap_or(&file).trim_end_matches(".md").to_string();
        let target = self.unique_file(&base, &dir, None);
        if let Some(p) = self.abs(&target).parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        fs::rename(self.abs(&file), self.abs(&target)).map_err(|e| e.to_string())?;
        self.entries.get_mut(id).unwrap().file = Some(target);
        self.stamp_moved(id);
        Ok(true)
    }

    /// 폴더 이름 바꾸기 → 새 이름
    pub fn rename_folder(&mut self, from: &str, to: &str) -> Result<String, String> {
        let dst = memo_file::clean_folder_name(to);
        if memo_file::clean_folder_name(from) != from || dst.is_empty() {
            return Err("폴더 이름으로 쓸 수 없어요".into());
        }
        if dst == from {
            return Ok(dst);
        }
        let a = self.root.join(from);
        if !a.is_dir() {
            return Err("폴더를 찾지 못했어요. 다른 곳에서 삭제했을 수 있어요".into());
        }
        let case_only = dst.to_lowercase() == from.to_lowercase(); // Windows 는 대소문자만 다른 이름을 같은 폴더로 본다
        if !case_only && self.root.join(&dst).exists() {
            return Err(format!("\"{dst}\" 폴더가 이미 있어요. 다른 이름을 써 주세요"));
        }
        if case_only {
            let tmp = self.root.join(format!(".rename-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]));
            fs::rename(&a, &tmp).and_then(|()| fs::rename(&tmp, self.root.join(&dst))).map_err(|e| e.to_string())?;
        } else {
            fs::rename(&a, self.root.join(&dst)).map_err(|e| e.to_string())?;
        }
        let ids: Vec<String> = self.entries.values().filter(|e| e.file.as_deref().is_some_and(|f| memo_file::folder_of(f) == from)).map(|e| e.id.clone()).collect();
        for id in &ids {
            let e = self.entries.get_mut(id).unwrap();
            let f = e.file.clone().unwrap();
            e.file = Some(format!("{dst}{}", &f[from.len()..]));
            self.stamp_moved(id);
        }
        if self.pinned_folders().iter().any(|n| n == from) {
            let _ = self.set_folder_pinned(from, false).and_then(|_| self.set_folder_pinned(&dst, true)); // 고정도 새 이름으로 (못 써도 이름 바꾸기는 됐다)
        }
        Ok(dst)
    }

    /// 상단 고정한 폴더 (_memoking/pinned-folders.json — 기기끼리 함께. app/js/core/folders.js parsePinned 와 같음)
    pub fn pinned_folders(&self) -> Vec<String> {
        let text = fs::read_to_string(self.app_dir().join(PINNED_FOLDERS)).unwrap_or_default();
        let list: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
        let mut out: Vec<String> = vec![];
        for n in list.iter().filter_map(Value::as_str) {
            if memo_file::clean_folder_name(n) == n && !n.is_empty() && !out.iter().any(|o| o == n) && out.len() < 200 {
                out.push(n.to_string());
            }
        }
        out
    }

    /// 폴더 상단 고정 · 풀기 → 새 목록 (지운 폴더 이름은 남긴다: 지우기를 되돌리면 그대로 고정)
    pub fn set_folder_pinned(&self, name: &str, on: bool) -> Result<Vec<String>, String> {
        if memo_file::clean_folder_name(name) != name || name.is_empty() {
            return Err("폴더 이름으로 쓸 수 없어요".into());
        }
        let mut list: Vec<String> = self.pinned_folders().into_iter().filter(|n| n != name).collect();
        if on {
            list.push(name.to_string());
        }
        fs::create_dir_all(self.app_dir()).map_err(|e| e.to_string())?;
        write_atomic(&self.app_dir().join(PINNED_FOLDERS), json!(list).to_string().as_bytes()).map_err(|e| e.to_string())?;
        Ok(list)
    }

    /// 폴더 지우기: 안의 메모는 모두 맨 위로 꺼내고, 그러고 나서 비었으면 폴더를 지운다 (메모가 아닌 파일이 남으면 그대로)
    pub fn delete_folder(&mut self, name: &str) -> Result<Value, String> {
        if memo_file::clean_folder_name(name) != name {
            return Err("폴더 이름으로 쓸 수 없어요".into());
        }
        let ids: Vec<String> = self.entries.values().filter(|e| e.file.as_deref().is_some_and(|f| memo_file::folder_of(f) == name)).map(|e| e.id.clone()).collect();
        let mut moved = vec![];
        for id in ids {
            if self.move_to_folder(&id, "")? {
                moved.push(id);
            }
        }
        let dir = self.root.join(name);
        let junk = ["desktop.ini", "thumbs.db", ".ds_store"];
        fn files(d: &Path, junk: &[&str]) -> usize {
            fs::read_dir(d).map_or(0, |rd| {
                rd.flatten()
                    .map(|x| if x.path().is_dir() { files(&x.path(), junk) } else { usize::from(!junk.contains(&x.file_name().to_string_lossy().to_lowercase().as_str())) })
                    .sum()
            })
        }
        let removed = !dir.exists() || (files(&dir, &junk) == 0 && fs::remove_dir_all(&dir).is_ok());
        Ok(json!({ "moved": moved.len(), "removed": removed, "ids": moved }))
    }

    // ---------- 휴지통 ----------

    /// 휴지통의 메모 파일 (이름만 받는다 — 휴지통 밖 경로는 거부)
    fn trash_file(&self, name: &str) -> Option<PathBuf> {
        let ok = !name.is_empty() && !name.contains(['/', '\\']) && name != ".." && name.to_lowercase().ends_with(".md");
        let file = self.trash_dir().join(name);
        (ok && file.is_file()).then_some(file)
    }

    // 휴지통 메모들 (이름, 파일, 지운 때 ms, 머리말, 본문)
    fn trash_entries(&self) -> Vec<(String, PathBuf, i64, Meta, String)> {
        let Ok(rd) = fs::read_dir(self.trash_dir()) else { return vec![] };
        rd.flatten()
            .filter_map(|d| {
                let name = d.file_name().to_string_lossy().into_owned();
                let path = d.path();
                if !name.to_lowercase().ends_with(".md") || !path.is_file() {
                    return None;
                }
                let at = trashed_at(&name).unwrap_or_else(|| fs::metadata(&path).and_then(|m| m.modified()).map_or(0, |t| ms(t) as i64));
                let (meta, b) = memo_file::parse_memo_file(&fs::read_to_string(&path).ok()?);
                Some((name, path, at, meta, b))
            })
            .collect()
    }

    pub fn trash_list(&self) -> Vec<Value> {
        let mut list = self.trash_entries();
        list.sort_by_key(|t| std::cmp::Reverse(t.2));
        list.into_iter()
            .map(|(name, _, at, meta, b)| {
                let deleted = chrono::DateTime::from_timestamp_millis(at).map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
                // shortcut: 잠긴 메모의 첨부 수(머리말 표)는 잠금을 옮길 때 — 잠긴 메모는 0 으로 보인다
                let attachments = if body::is_locked_body(&b) { 0 } else { body::extract_media(&b).len() };
                json!({ "name": name, "title": body::extract_title(&b), "preview": body::extract_preview(&b, 100), "color": meta.color, "deletedAt": deleted, "attachments": attachments })
            })
            .collect()
    }

    /// 휴지통 메모의 글 미리보기 (잠긴 메모는 내용을 보이지 않는다)
    pub fn trash_preview(&self, name: &str) -> Option<String> {
        let (_, b) = memo_file::parse_memo_file(&fs::read_to_string(self.trash_file(name)?).ok()?);
        if body::is_locked_body(&b) {
            return Some("(잠긴 메모라 내용을 볼 수 없어요)".into());
        }
        Some(crate::js::slice16(&body::plain_lines(&b, usize::MAX).into_iter().skip(1).collect::<Vec<_>>().join("\n"), 1500))
    }

    /// 메모 폴더로 되돌린다 (이름이 겹치면 "(2)") — 함께 휴지통에 간 첨부도. 되살린 메모 id
    pub fn restore_trash(&mut self, name: &str) -> io::Result<Option<String>> {
        let Some(file) = self.trash_file(name) else { return Ok(None) };
        let (meta, b) = memo_file::parse_memo_file(&fs::read_to_string(&file)?);
        if !body::is_locked_body(&b) {
            for m in body::extract_media(&b) {
                let (Some(live), held) = (self.resolve(&m.src), self.trash_dir().join(&m.src)) else { continue };
                if m.src.starts_with("attachments/") && !live.exists() && held.exists() {
                    let _ = fs::rename(held, live);
                }
            }
        }
        // 폴더에 있던 메모는 그 폴더로 (폴더가 없어졌으면 다시 만든다)
        let dir = memo_file::clean_folder_name(meta.extra.get("trashedFrom").and_then(Value::as_str).unwrap_or(""));
        let target = self.unique_file(&memo_file::title_to_file_name(&body::extract_title(&b)), &dir, None);
        if let Some(p) = self.abs(&target).parent() {
            fs::create_dir_all(p)?;
        }
        fs::rename(&file, self.abs(&target))?;
        if meta.extra.contains_key("trashedFrom") {
            let mut m = meta;
            m.extra.shift_remove("trashedFrom");
            write_atomic(&self.abs(&target), memo_file::serialize_memo_file(&m, &b).as_bytes())?;
        }
        // 이 기기에서 되살린 메모는 "다른 기기에서 방금 고친 메모" 로 알리지 않는다
        self.own_files.insert(target.clone());
        self.scan();
        self.own_files.clear();
        Ok(self.entries.values().find(|e| e.file.as_deref() == Some(target.as_str())).map(|e| e.id.clone()))
    }

    /// 휴지통의 메모 하나를 영구 삭제
    pub fn delete_trash(&self, name: &str) -> io::Result<bool> {
        let Some(file) = self.trash_file(name) else { return Ok(false) };
        fs::remove_file(file)?;
        self.purge_trash_attachments(i64::MAX);
        Ok(true)
    }

    /// 휴지통 비우기 — older_than_days 를 주면 그보다 오래 있던 것만
    pub fn empty_trash(&self, older_than_days: Option<u32>) -> Value {
        let cutoff = older_than_days.map_or(i64::MAX, |d| ms(SystemTime::now()) as i64 - i64::from(d) * 86_400_000);
        let mut memos = 0;
        for (_, path, at, _, _) in self.trash_entries() {
            if at <= cutoff && fs::remove_file(path).is_ok() {
                memos += 1;
            }
        }
        json!({ "memos": memos, "files": self.purge_trash_attachments(cutoff) })
    }

    /// 휴지통의 첨부 중 살아 있는 메모 · 휴지통의 메모가 쓰지 않는 것을 지운다
    ///   열지 않은 잠긴 메모는 머리말의 첨부 표(lockRefs)로 본다
    fn purge_trash_attachments(&self, older_than: i64) -> usize {
        let trash = self.trash_entries();
        let mut used = HashSet::new();
        let mut sealed: Vec<(String, HashSet<String>)> = vec![]; // 열지 않은 잠긴 메모: (소금, 첨부 표)
        let live = self.entries.values().map(|e| (e.body.clone(), e.meta.extra.get("lockRefs").cloned(), self.plain_of(e), true));
        let held = trash.iter().map(|t| (t.4.clone(), t.3.extra.get("lockRefs").cloned(), None, false));
        for (b, refs, plain, is_live) in live.chain(held) {
            if !body::is_locked_body(&b) {
                used.extend(body::extract_media(&b).into_iter().map(|m| m.src));
                continue;
            }
            if let Some(p) = plain {
                used.extend(body::extract_media(&p).into_iter().map(|m| m.src));
                continue;
            }
            match refs.as_ref().and_then(Value::as_array) {
                Some(list) => sealed.push((lock::parse_locked(&b).map(|p| p.salt).unwrap_or_default(), list.iter().filter_map(Value::as_str).map(str::to_string).collect())),
                // 표가 없는 예전 잠금: 살아 있는 메모면 무엇을 쓰는지 몰라 아무것도 지우지 않는다 (열면 표가 생김)
                None if is_live => return 0,
                None => {}
            }
        }
        let in_use = |src: &str| used.contains(src) || sealed.iter().any(|(salt, refs)| refs.contains(&lock::lock_ref_key(src, salt)));
        let dir = self.trash_dir().join(ATTACH_DIR);
        let Ok(rd) = fs::read_dir(&dir) else { return 0 };
        rd.flatten()
            .filter(|d| {
                let src = format!("{ATTACH_DIR}/{}", d.file_name().to_string_lossy());
                let old = d.metadata().and_then(|m| m.modified()).is_ok_and(|t| (ms(t) as i64) <= older_than);
                d.path().is_file() && old && !in_use(&src) && fs::remove_file(d.path()).is_ok()
            })
            .count()
    }
}

// ---------- 첨부 ----------
impl Vault {
    /// 첨부 저장 → "attachments/20261117-153000-ab12.png"
    pub fn save_attachment(&self, bytes: &[u8], ext: &str) -> io::Result<String> {
        let ext: String = ext.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
        let ext = if ext.is_empty() { "bin".into() } else { ext };
        let name = format!("{}-{}.{ext}", file_stamp(chrono::Local::now()), &uuid::Uuid::new_v4().simple().to_string()[..4]);
        write_atomic(&self.root.join(ATTACH_DIR).join(&name), bytes)?;
        Ok(format!("{ATTACH_DIR}/{name}"))
    }

    /// 다른 곳의 파일을 첨부로 복사 (매직 카피로 담은 파일 — 큰 영상도 메모리에 올리지 않게 파일째) → 첨부 경로
    pub fn copy_attachment(&self, file: &Path) -> io::Result<String> {
        let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
        let ext = if ext.is_empty() { "bin".into() } else { ext };
        let name = format!("{}-{}.{ext}", file_stamp(chrono::Local::now()), &uuid::Uuid::new_v4().simple().to_string()[..4]);
        let dir = self.root.join(ATTACH_DIR);
        fs::create_dir_all(&dir)?;
        fs::copy(file, dir.join(&name))?;
        Ok(format!("{ATTACH_DIR}/{name}"))
    }
}

/// 실행하면 프로그램이 도는 파일 (열기 전에 묻는다) — file-kinds.js isProgramFile
pub fn is_program_file(name: &str) -> bool {
    const PROGRAM_EXT: [&str; 33] = [
        "exe", "msi", "msix", "appx", "appxbundle", "bat", "cmd", "com", "scr", "pif", "cpl", "msc", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "reg", "jar",
        "application", "appref-ms", "inf", "sct", "chm", "gadget", "ws", "settingcontent-ms",
    ];
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").split(['?', '#']).next().unwrap_or("");
    let ext = match base.rfind('.') {
        Some(i) if i > 0 => base[i + 1..].to_lowercase(),
        _ => return false,
    };
    PROGRAM_EXT.contains(&ext.as_str())
}

/// 알림 목록 합치기 (알림마다): 그쪽 목록을 바탕으로, 이 기기에서 새로 만든 것은 더하고, 바꾼 것은 바꾼 대로, 지운 것은 빼고
///   — 그쪽에서 지운 것은 되살리지 않는다 (vault-locks.js mergeReminders)
pub fn merge_reminders(mine: &[Value], disk: &[Value], theirs: &[Value]) -> Vec<Value> {
    let by_id = |list: &[Value], id: &Value| list.iter().find(|r| r["id"] == *id).cloned();
    let mut out: Vec<Value> = vec![];
    for t in theirs {
        let (d, m) = (by_id(disk, &t["id"]), by_id(mine, &t["id"]));
        match (d, m) {
            (Some(_), None) => {} // 이 기기에서 지움
            (Some(d), Some(m)) if m != d => out.push(m),
            _ => out.push(t.clone()),
        }
    }
    for m in mine {
        if by_id(disk, &m["id"]).is_none() && by_id(&out, &m["id"]).is_none() {
            out.push(m.clone());
        }
    }
    out
}

/// 지운 때: 휴지통 파일 이름 "제목 (20260930-153000).md" 의 시각 (현지)
fn trashed_at(name: &str) -> Option<i64> {
    use chrono::TimeZone;
    let stem = name.get(..name.len().checked_sub(3)?)?;
    let inner = stem.strip_suffix(')')?.rsplit_once('(')?.1;
    let n = chrono::NaiveDateTime::parse_from_str(inner, "%Y%m%d-%H%M%S").ok()?;
    chrono::Local.from_local_datetime(&n).earliest().map(|t| t.timestamp_millis())
}

fn version_names(dir: &Path) -> Vec<String> {
    fs::read_dir(dir).map_or(vec![], |rd| rd.flatten().map(|d| d.file_name().to_string_lossy().into_owned()).filter(|n| version_time(n).is_some()).collect())
}

/// "20261008-153000.md" → 그 시각(ms, 현지), 형식이 아니면 None
fn version_time(name: &str) -> Option<u128> {
    use chrono::TimeZone;
    let stem = name.strip_suffix(".md").or_else(|| name.strip_suffix(".MD"))?;
    let stem = stem.split_once('-').map(|(d, rest)| (d, rest.split('-').next().unwrap_or(""), rest)).filter(|(d, t, rest)| d.len() == 8 && t.len() == 6 && (rest.len() == 6 || rest[6..].strip_prefix('-').is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))))?;
    let n = chrono::NaiveDateTime::parse_from_str(&format!("{}{}", stem.0, stem.1), "%Y%m%d%H%M%S").ok()?;
    chrono::Local.from_local_datetime(&n).earliest().map(|t| t.timestamp_millis() as u128)
}

/// 지울 버전: 최근 30개만, 그중에서도 30일 지난 것은 빼되 최근 3개는 남김
fn versions_to_prune(names: &[String], now: u128) -> Vec<String> {
    let mut dated: Vec<(u128, &String)> = names.iter().filter_map(|n| Some((version_time(n)?, n))).collect();
    dated.sort_by_key(|d| std::cmp::Reverse(d.0));
    let cutoff = now.saturating_sub(MAX_VERSION_AGE_MS);
    dated.into_iter().enumerate().filter(|(i, (at, _))| *i >= MAX_VERSIONS || (*i >= KEEP_RECENT && *at < cutoff)).map(|(_, (_, n))| n.clone()).collect()
}

fn has_web_link(body: &str) -> bool {
    let b = body.to_lowercase();
    ["](http://", "](https://", "<http://", "<https://"].iter().any(|p| b.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("mk-vault-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    // 못 읽은 하위 폴더의 메모는 지운 것이 아니다 — 목록에 그대로 (Drive 데스크탑 앱 폴더 · 백신)
    #[cfg(unix)]
    #[test]
    fn unreadable_folder_keeps_memos() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let a = v.create(None, None, "업무");
        v.save(&a, "# 회의\n본문").unwrap();
        let b = v.create(None, None, "");
        v.save(&b, "# 장보기").unwrap();
        v.scan();
        let dir = root.join("업무");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = fs::read_dir(&dir).is_err(); // root 로 돌면 권한이 막히지 않는다
        let changed = v.scan();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        if unreadable {
            assert!(v.entry(&a).is_some() && !changed.removed.contains(&a), "못 읽은 폴더의 메모는 그대로");
        }
        assert!(v.entry(&b).is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_save_list_get_finalize_trash() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.create(Some("green"), None, "");
        // 빈 메모는 파일을 만들지 않는다
        assert!(!v.save(&id, "").unwrap().1);
        assert!(v.list().is_empty());
        let (card, changed) = v.save(&id, "# 회의\n\n#업무 할 일\n- [x] 하나").unwrap();
        assert!(changed);
        assert_eq!(card["title"], "회의");
        assert_eq!(card["tags"], json!(["업무"]));
        assert_eq!(card["color"], "green");
        let text = fs::read_to_string(root.join("회의.md")).unwrap();
        assert!(text.starts_with("---\nid: ") && text.contains("color: green\ndevice: pc\n---\n# 회의\n"), "{text}");
        assert_eq!(v.get(&id).unwrap()["body"], "# 회의\n\n#업무 할 일\n- [x] 하나");
        // 제목을 바꾸고 닫으면 파일 이름도
        v.save(&id, "# 주간 회의\n본문").unwrap();
        assert!(v.finalize(&id).unwrap());
        assert!(root.join("주간 회의.md").exists() && !root.join("회의.md").exists());
        // 다시 열어 읽어도 같은 메모
        let mut v2 = Vault::new(&root, "pc");
        v2.open().unwrap();
        assert_eq!(v2.list()[0]["id"], json!(id));
        // 휴지통으로
        let name = v2.trash(&id).unwrap().unwrap();
        assert!(name.starts_with("주간 회의 (") && root.join("_memoking/trash").join(&name).exists());
        assert!(v2.list().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_events_add_reminders_and_seen_lines() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.create(None, None, "");
        assert!(v.add_ai_events(&id, &[], &[]).unwrap().is_none(), "파일이 없는 메모는 아니다");
        v.save(&id, "# 메모\n내일 3시 치과").unwrap();
        let updated = v.get(&id).unwrap()["updated"].clone();
        let r = json!({ "id": "r1", "kind": "at", "action": "notify", "enabled": true, "created": "2026-10-24T10:00:00+09:00", "at": "2026-10-25T15:00:00+09:00", "alerts": [10] });
        let m = v.add_ai_events(&id, std::slice::from_ref(&r), &["내일 3시 치과".into()]).unwrap().unwrap();
        assert_eq!((m["reminders"][0]["id"].clone(), m["aiEvents"].clone(), m["updated"].clone()), (json!("r1"), json!(["내일 3시 치과"]), updated));
        let text = fs::read_to_string(root.join("메모.md")).unwrap();
        assert!(text.contains("aiEvents:") && text.contains("id: r1"), "{text}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_tags_write_body_and_meta_but_never_over_another_device() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.create(None, None, "");
        v.save(&id, "# 메모\n치과 예약").unwrap();
        let updated = v.get(&id).unwrap()["updated"].clone();
        let m = v.set_ai_tags(&id, "# 메모\n치과 예약\n\n#병원", &["병원".into()]).unwrap().unwrap();
        assert_eq!((m["aiTags"].clone(), m["updated"].clone()), (json!(["병원"]), updated));
        let path = root.join("메모.md");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("aiTags:") && text.contains("#병원"), "{text}");
        assert!(!v.versions(&id).is_empty(), "태그 달기 전 글을 버전으로");
        // 휴대폰에서 고친 글이 내려왔는데 아직 다시 읽기 전 — 사본을 만들지 않고 쓰지 않는다
        let theirs = text.replace("치과 예약", "휴대폰에서 고침");
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&path, &theirs).unwrap();
        assert!(v.set_ai_tags(&id, "# 메모\n치과 예약\n\n#병원 #예약", &["병원".into(), "예약".into()]).unwrap().is_none());
        assert_eq!(fs::read_to_string(&path).unwrap(), theirs);
        assert_eq!(v.list().len(), 1, "사본 메모 없음");
        assert_eq!(v.get(&id).unwrap()["aiTags"], json!(["병원"]), "되돌림");
        // 잠긴 메모는 손대지 않는다
        let locked = "---\nid: lk\ncolor: yellow\n---\n# 비밀\n\n<!-- memoking-lock v1 n=310000 s=AAAA i=BBBB c=CCCC== -->\n";
        fs::write(root.join("비밀.md"), locked).unwrap();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        assert!(v.set_ai_tags("lk", "# 비밀\n\n#태그", &["태그".into()]).unwrap().is_none());
        assert_eq!(fs::read_to_string(root.join("비밀.md")).unwrap(), locked);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conflict_from_other_device_keeps_both() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.create(None, None, "");
        v.save(&id, "# 메모\n처음").unwrap();
        // 다른 기기가 파일을 고쳤는데 아직 다시 읽기 전에 이 기기가 저장
        let path = root.join("메모.md");
        let theirs = fs::read_to_string(&path).unwrap().replace("처음", "휴대폰에서 고침");
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&path, theirs).unwrap();
        v.save(&id, "# 메모\nPC 에서 고침").unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("PC 에서 고침"));
        let copies: Vec<Value> = v.list().into_iter().filter(|m| m["id"] != json!(id)).collect();
        assert_eq!(copies.len(), 1, "들어온 글은 사본 메모로");
        assert!(copies[0]["title"].as_str().unwrap().starts_with("메모 (다른 기기 "));
        assert!(v.get(copies[0]["id"].as_str().unwrap()).unwrap()["body"].as_str().unwrap().contains("휴대폰에서 고침"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn locked_memo_is_never_overwritten() {
        let root = tmp();
        let locked = "---\nid: lk\ncolor: yellow\n---\n# 비밀\n\n<!-- memoking-lock v1 n=310000 s=AAAA i=BBBB c=CCCC== -->\n";
        fs::write(root.join("비밀.md"), locked).unwrap();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        assert_eq!(v.get("lk").unwrap()["needsPassword"], true);
        let (card, changed) = v.save("lk", "풀린 글").unwrap();
        assert!(!changed && card["refused"] == true);
        assert_eq!(fs::read_to_string(root.join("비밀.md")).unwrap(), locked);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn version_names_and_pruning() {
        assert!(version_time("20261008-153000.md").is_some());
        assert!(version_time("20261008-153000-2.md").is_some());
        assert!(version_time("20261008-1530.md").is_none());
        let now = version_time("20261008-153000.md").unwrap();
        let names: Vec<String> = (0..35).map(|i| format!("202610{:02}-120000.md", 1 + i % 28) + if i >= 28 { "-2" } else { "" }).map(|n| n.replace(".md-2", "-2.md")).collect();
        assert_eq!(versions_to_prune(&names, now).len(), 5);
    }

    #[test]
    fn trash_restore_folders_meta_links_versions() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let a = v.create(None, None, "");
        v.save(&a, "# 가\n본문 하나").unwrap();
        let b = v.create(None, None, "");
        v.save(&b, "# 나\n장보기 목록").unwrap();
        // 찾기 (초성)
        assert_eq!(v.search("ㅈㅂㄱ", None).len(), 1);
        assert_eq!(v.search("", Some(&a)).len(), 1);
        // 머리말: 색 · 고정
        let m = v.set_meta(&a, &json!({ "color": "blue", "pinned": true })).unwrap().unwrap();
        assert!(m["color"] == "blue" && m["pinned"] == true);
        assert!(m["pinnedAt"].is_string(), "상단 고정한 때");
        assert!(v.set_meta(&a, &json!({ "pinned": false })).unwrap().unwrap()["pinnedAt"].is_null(), "풀면 삭제한다");
        v.set_meta(&a, &json!({ "pinned": true })).unwrap();
        assert_eq!(v.list()[0]["id"], json!(a), "상단 고정한 메모가 먼저");
        // 연결 · 나를 연결한 메모
        v.link(&a, &b, true).unwrap().unwrap();
        assert_eq!(v.links(&b)["backlinks"][0]["id"], json!(a));
        // 폴더: 만들기 · 옮기기 · 이름 바꾸기 · 지우기 (메모는 맨 위로)
        assert_eq!(v.create_folder("업무").unwrap(), "업무");
        assert!(v.move_to_folder(&a, "업무").unwrap());
        assert_eq!(v.entry(&a).unwrap().file.as_deref(), Some("업무/가.md"));
        assert_eq!(v.rename_folder("업무", "회사").unwrap(), "회사");
        assert!(root.join("회사/가.md").exists());
        assert_eq!(v.folders(), vec!["회사"]);
        let r = v.delete_folder("회사").unwrap();
        assert!(r["moved"] == 1 && r["removed"] == true && root.join("가.md").exists());
        // 휴지통 → 목록 · 미리보기 · 되살리기 (같은 id 로)
        v.move_to_folder(&b, "보관").unwrap();
        let name = v.trash(&b).unwrap().unwrap();
        assert_eq!(v.trash_list()[0]["title"], "나");
        assert_eq!(v.trash_preview(&name).as_deref(), Some("장보기 목록"));
        let back = v.restore_trash(&name).unwrap().unwrap();
        assert_eq!(back, b);
        assert_eq!(v.entry(&b).unwrap().file.as_deref(), Some("보관/나.md"), "삭제한 폴더로 되살린다");
        assert!(!fs::read_to_string(root.join("보관/나.md")).unwrap().contains("trashedFrom"));
        // 영구 삭제 · 비우기
        let n = v.trash(&b).unwrap().unwrap();
        assert!(v.delete_trash(&n).unwrap() && v.trash_list().is_empty());
        // 버전 되돌리기 (지금 글도 버전으로 남긴다)
        v.save(&a, "# 가\n두 번째").unwrap();
        let vs = v.versions(&a);
        assert_eq!(vs.len(), 1);
        let name = vs[0]["name"].as_str().unwrap().to_string();
        assert_eq!(v.version(&a, &name).as_deref(), Some("# 가\n본문 하나"));
        let restored = v.restore_version(&a, &name).unwrap();
        assert_eq!(restored["body"], "# 가\n본문 하나");
        assert!(!v.versions(&a).is_empty());
        assert!(v.version(&a, "../x.md").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lock_open_save_unlock() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.create(None, None, "");
        v.save(&id, "# 비밀\n![](attachments/p.png) 첫 글").unwrap();
        v.save(&id, "# 비밀\n![](attachments/p.png) 둘째 글").unwrap();
        assert!(!v.versions(&id).is_empty());
        let s = lock::new_session("비밀번호", 1000).unwrap();
        let m = v.lock(&id, s.clone(), true, false).unwrap().unwrap();
        assert!(m["locked"] == true && m["needsPassword"] == false && m["body"].as_str().unwrap().contains("둘째 글"));
        assert!(v.versions(&id).is_empty(), "잠그기 전 풀린 버전은 삭제한다");
        let file = root.join("비밀.md");
        let text = fs::read_to_string(&file).unwrap();
        assert!(!text.contains("둘째 글") && text.contains("lockRefs") && text.contains("memoking-lock v1"));
        // 연 동안 저장 → 늘 다시 잠근 글로
        v.save(&id, "# 비밀\n셋째 글").unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(!text.contains("셋째 글") && lock::unseal(&memo_file::parse_memo_file(&text).1, &s).as_deref() == Some("# 비밀\n셋째 글"));
        // 닫으면 열쇠를 잊는다 → 비밀번호 필요, 저장 거절
        v.close_lock(&id);
        assert_eq!(v.get(&id).unwrap()["needsPassword"], true);
        assert_eq!(v.save(&id, "풀린 글").unwrap().0["refused"], true);
        // 다시 열기 · 풀기
        let (_, s2) = lock::open_lock(&memo_file::parse_memo_file(&fs::read_to_string(&file).unwrap()).1, "비밀번호").unwrap();
        assert_eq!(v.open_lock(&id, s2).unwrap()["body"], "# 비밀\n셋째 글");
        let m = v.unlock(&id).unwrap().unwrap();
        assert_eq!(m["locked"], false);
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("셋째 글") && !text.contains("lockRefs"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn other_device_relocked_keeps_ours_as_copy() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.create(None, None, "");
        v.save(&id, "# 메모\n처음").unwrap();
        // 다른 기기가 다른 비밀번호로 잠갔는데 아직 다시 읽기 전에 이 기기가 저장
        let file = root.join("메모.md");
        let other = lock::new_session("다른비번", 1000).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        let (meta, _) = memo_file::parse_memo_file(&text);
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&file, memo_file::serialize_memo_file(&meta, &lock::seal("# 메모\n처음", &other, false))).unwrap();
        let (card, _) = v.save(&id, "# 메모\n이 기기 글").unwrap();
        assert!(card["refused"] == true && card["copied"] == true);
        assert!(body::is_locked_body(&memo_file::parse_memo_file(&fs::read_to_string(&file).unwrap()).1), "잠근 파일은 그대로");
        v.scan();
        assert!(v.list().iter().any(|m| v.get(m["id"].as_str().unwrap()).unwrap()["body"] == "# 메모\n이 기기 글"), "우리 글은 사본으로");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn set_reminders_writes_and_lists() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let blank = v.create(None, None, "");
        assert_eq!(v.set_reminders(&blank, vec![json!({ "id": "r1", "kind": "startup" })]).unwrap().unwrap().len(), 1);
        assert!(v.all_reminders().is_empty(), "빈 새 메모는 파일을 만들지 않는다");
        let id = v.create(None, None, "");
        v.save(&id, "# 치과").unwrap();
        let before = v.get(&id).unwrap()["updated"].clone();
        v.set_reminders(&id, vec![json!({ "id": "r1", "kind": "startup", "title": "비밀" })]).unwrap().unwrap();
        let all = v.all_reminders();
        assert!(all.len() == 1 && all[0]["memoId"] == id.as_str() && all[0]["title"] == "치과" && all[0]["reminder"]["id"] == "r1", "{all:?}");
        assert!(fs::read_to_string(root.join("치과.md")).unwrap().contains("reminders:"));
        assert_eq!(v.get(&id).unwrap()["updated"], before, "알림은 내용 수정이 아니다");
        assert!(v.set_reminders("없음", vec![]).unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_folders_follow_rename() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        assert!(v.pinned_folders().is_empty());
        v.create_folder("업무").unwrap();
        assert_eq!(v.set_folder_pinned("업무", true).unwrap(), ["업무"]);
        assert_eq!(v.set_folder_pinned("집", true).unwrap(), ["업무", "집"]);
        assert!(v.set_folder_pinned("a:b", true).is_err());
        v.rename_folder("업무", "회사").unwrap();
        assert_eq!(v.pinned_folders(), ["집", "회사"]);
        assert_eq!(v.set_folder_pinned("집", false).unwrap(), ["회사"]);
        fs::write(root.join("_memoking/pinned-folders.json"), "{망가짐").unwrap();
        assert!(v.pinned_folders().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_only_change_is_reported() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        assert!(v.scan().is_empty());
        fs::create_dir(root.join("휴대폰에서 만든 폴더")).unwrap();
        let c = v.scan();
        assert!(c.folders && !c.is_empty() && c.ids.is_empty());
        assert!(v.scan().is_empty(), "한 번 알린 뒤로는 조용히");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn meta_change_keeps_other_device_text() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.create(None, None, "");
        v.save(&id, "# 메모\n처음").unwrap();
        // 휴대폰이 글을 고쳤는데 아직 다시 읽기 전에 PC 에서 색을 바꿈
        let file = root.join("메모.md");
        let text = fs::read_to_string(&file).unwrap().replace("처음", "휴대폰 글").replace("color: yellow", "color: yellow\npinned: true");
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&file, text).unwrap();
        let m = v.set_meta(&id, &json!({ "color": "blue" })).unwrap().unwrap();
        assert!(m["body"].as_str().unwrap().trim_end() == "# 메모\n휴대폰 글" && m["color"] == "blue" && m["pinned"] == true, "{m}");
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("휴대폰 글") && text.contains("color: blue") && text.contains("pinned: true"));
        assert_eq!(v.list().len(), 1, "사본을 만들지 않는다");
        assert_eq!(v.scan().external, vec![id], "열린 화면에 알린다");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_reminders_keeps_each_side() {
        let r = |id: &str, at: &str| json!({ "id": id, "at": at });
        let disk = [r("a", "1"), r("b", "1"), r("c", "1")];
        let mine = [r("a", "2"), r("c", "1"), r("n", "1")]; // a 바꿈 · b 지움 · n 새로
        let theirs = [r("a", "1"), r("b", "1"), r("t", "1")]; // c 지움 · t 새로
        let out = merge_reminders(&mine, &disk, &theirs);
        assert_eq!(out, vec![r("a", "2"), r("t", "1"), r("n", "1")]);
    }
}
