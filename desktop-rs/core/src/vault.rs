//! 메모 폴더(볼트) — 폴더 속 .md 파일들을 DB 처럼. desktop/vault.js + app/js/core/vault-locks.js 의 저장 규칙을 옮긴 것.
//!   옮긴 것: 읽기(scan) · 목록 · 메모 하나 · 새 메모 · 저장(덮어쓰기 전 확인 · 충돌 사본 · 버전) · 닫을 때 정리 · 휴지통으로.
//!   아직(체크리스트): 잠금 열기 · 잠그기, 폴더 옮기기, 휴지통 되살리기 · 비우기, 첨부 정리(orphans), 같은 id 두 파일(twins), 색인(index.json).
//!   잠긴 메모는 열쇠가 없으니 늘 "저장 거절" — 풀린 글이 잠긴 메모를 덮어쓰는 일은 없다.
use crate::body::{self, Tasks};
use crate::memo_file::{self, Meta};
use crate::time;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const APP_DIR: &str = "_memoking";
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
}

/// 다시 읽은 결과 — 화면에 알릴 것 (vault.js 의 'changed' 이벤트)
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Changed {
    pub ids: Vec<String>,
    /// 다른 기기 · 탐색기에서 바뀐 메모
    pub external: Vec<String>,
    pub removed: Vec<String>,
}

impl Changed {
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
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
        Ok(())
    }

    // ---------- 폴더 읽기 ----------

    fn list_files(&self, dir: &Path, rel: &str, out: &mut Vec<String>) -> io::Result<()> {
        for item in fs::read_dir(dir)? {
            let item = item?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with("~$") || (rel.is_empty() && (name == APP_DIR || name == ATTACH_DIR)) {
                continue;
            }
            let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let ty = item.file_type()?;
            if ty.is_dir() {
                self.list_files(&item.path(), &rel_path, out)?;
            } else if ty.is_file() && name.to_lowercase().ends_with(".md") {
                out.push(rel_path);
            }
        }
        Ok(())
    }

    /// 바뀐 파일만 다시 읽는다. 다른 기기에서 들어온 변경은 external 로
    pub fn scan(&mut self) -> Changed {
        let mut files = vec![];
        if self.list_files(&self.root.clone(), "", &mut files).is_err() {
            return Changed::default();
        }
        let prev_by_file: HashMap<String, Entry> = self.entries.values().filter_map(|e| Some((e.file.clone()?, e.clone()))).collect();
        // 아직 파일이 없는 새 메모는 그대로
        let mut next: HashMap<String, Entry> = self.entries.iter().filter(|(_, e)| e.file.is_none()).map(|(k, e)| (k.clone(), e.clone())).collect();
        let mut changed: Vec<String> = vec![];
        let mut external = vec![];
        for file in files {
            let path = self.abs(&file);
            let Ok(stamp) = stamp_of(&path) else { continue };
            let prev = prev_by_file.get(&file);
            if let Some(p) = prev.filter(|p| p.stamp == Some(stamp) && !next.contains_key(&p.id)) {
                next.insert(p.id.clone(), p.clone());
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                // 백신 · OneDrive 가 잠깐 붙잡아 못 읽었다 — 아는 내용 그대로
                if let Some(p) = prev.filter(|p| !next.contains_key(&p.id)) {
                    next.insert(p.id.clone(), p.clone());
                }
                continue;
            };
            let (mut meta, body) = memo_file::parse_memo_file(&text);
            // id 가 없는 파일(직접 만든 것)이나 id 가 겹치는 사본은 임시 id
            // shortcut: 폴더를 옮긴 사이 옛 자리가 되살아난 같은 id 두 파일(resolveMovedTwin)은 아직 사본처럼 다룬다 — 폴더 옮기기를 옮길 때
            let mut id = meta.id.clone();
            let mut id_saved = id.is_some();
            if id.as_ref().is_none_or(|i| next.contains_key(i)) {
                id = Some(prev.filter(|p| !p.id_saved).map_or_else(|| uuid::Uuid::new_v4().to_string(), |p| p.id.clone()));
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
            let old_body = self.entries.get(&id).map(|e| e.body.clone());
            if old_body.as_deref() != Some(&body) && !self.own_files.contains(&file) {
                external.push(id.clone());
            }
            next.insert(id.clone(), Entry { id: id.clone(), file: Some(file), folder: String::new(), meta, body, stamp: Some(stamp), id_saved });
            changed.push(id);
        }
        let removed: Vec<String> = self.entries.keys().filter(|id| !next.contains_key(*id)).cloned().collect();
        let now = SystemTime::now();
        self.removed_meta.retain(|_, (_, at)| now.duration_since(*at).is_ok_and(|d| d.as_millis() < 10 * 60_000));
        for id in &removed {
            if let Some(e) = self.entries.get(id) {
                self.removed_meta.insert(id.clone(), (e.meta.clone(), now));
            }
            changed.push(id.clone());
        }
        self.entries = next;
        // 폴더만 생기거나 없어져도 목록이 폴더 목록을 다시 읽게
        let dirs = self.folders().join("\n");
        let dirs_changed = self.seen_dirs.as_ref().is_some_and(|d| *d != dirs);
        self.seen_dirs = Some(dirs);
        if dirs_changed && changed.is_empty() {
            return Changed { ids: vec![], external: vec![], removed: vec![] };
        }
        Changed { ids: changed, external, removed }
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

    pub fn summary(&self, e: &Entry) -> Value {
        let media = body::extract_media(&e.body);
        let has = |k: &str| media.iter().any(|m| m.kind == k);
        let images: Vec<&str> = media
            .iter()
            .filter(|m| m.kind == "image" && !matches!(m.title.as_str(), "album page" | "album page ink"))
            .take(24)
            .map(|m| m.src.as_str())
            .collect();
        let live_reminders = e.meta.reminders.iter().filter(|r| is_live_cached(r)).count();
        let tasks: Tasks = body::task_progress(&e.body);
        json!({
            "id": e.id,
            "file": e.file,
            "title": body::extract_title(&e.body),
            "preview": body::extract_preview(&e.body, 1200),
            "color": e.meta.color,
            "pinned": e.meta.pinned,
            "created": e.meta.created,
            "updated": e.meta.updated,
            "thumb": media.iter().find(|m| m.kind == "image").map(|m| &m.src),
            "video": media.iter().find(|m| m.kind == "video").map(|m| &m.src),
            "images": images,
            "day": e.meta.day,
            "mode": e.meta.mode,
            "folder": e.file.as_deref().map_or(e.folder.as_str(), memo_file::folder_of),
            "tags": body::extract_tags(&e.body),
            "hasImage": has("image"),
            "hasWebLink": has_web_link(&e.body),
            "hasAudio": has("audio"),
            "hasVideo": has("video"),
            "hasFile": has("file"),
            "reminderCount": live_reminders,
            "linkCount": e.meta.links.iter().filter(|id| self.entries.contains_key(*id)).count(),
            "tasks": tasks,
            "locked": body::is_locked_body(&e.body),
        })
    }

    /// 목록: 고정한 메모 먼저, 그다음 최근 고친 순
    pub fn list(&self) -> Vec<Value> {
        let mut list: Vec<&Entry> = self.entries.values().filter(|e| e.file.is_some()).collect();
        let t = |e: &Entry| e.meta.updated.as_deref().and_then(time::parse_js_date).map_or(0, |d| d.timestamp_millis());
        list.sort_by(|a, b| b.meta.pinned.cmp(&a.meta.pinned).then(t(b).cmp(&t(a))));
        list.into_iter().map(|e| self.summary(e)).collect()
    }

    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.entries.get(id)
    }

    /// 메모 창이 여는 메모 (잠긴 메모는 열쇠가 없어 늘 needsPassword)
    pub fn get(&self, id: &str) -> Option<Value> {
        let e = self.entries.get(id)?;
        let locked = body::is_locked_body(&e.body);
        let extra_list = |k: &str| e.meta.extra.get(k).filter(|v| v.is_array()).cloned().unwrap_or(Value::Null);
        Some(json!({
            "id": id,
            "file": e.file,
            "body": e.body,
            "locked": locked,
            "needsPassword": locked,
            "title": body::extract_title(&e.body),
            "color": e.meta.color,
            "pinned": e.meta.pinned,
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
        Entry { id: id.into(), file: None, folder: memo_file::clean_folder_name(folder), meta: memo_file::normalize_meta(&data), body: String::new(), stamp: None, id_saved: true }
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
        let wrote = self.write(&mut e, "");
        self.entries.insert(id.clone(), e);
        wrote?;
        Ok(Some(id))
    }

    /// 메모 저장 → 목록 카드 (저장하지 않았으면 refused · retry · invalid 를 더해)
    pub fn save(&mut self, id: &str, body: &str) -> io::Result<(Value, bool)> {
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
        // 잠금 형식 글을 통째로: 지금 파일과 같으면 할 일 없음, 다르면 아무도 열 수 없게 되므로 저장하지 않는다
        if body::is_locked_body(body) {
            return if e.file.is_some() && body == e.body { Ok((None, false)) } else { refuse(true, false) };
        }
        // 잠긴 메모: 열쇠가 있어야 저장 (아직 열쇠를 다루지 않으니 늘 거절 — 풀린 글로 덮어쓰지 않게)
        if body::is_locked_body(&e.body) {
            return refuse(false, false);
        }
        if e.body == body && e.file.is_some() {
            return Ok((None, false));
        }
        let before = e.meta.clone();
        let known = std::mem::replace(&mut e.body, body.into());
        e.meta.updated = Some(time::now_iso());
        e.meta.device = Some(self.device.clone());
        if e.file.is_none() && body::is_blank_body(body) {
            return Ok((None, false));
        }
        if e.file.is_some() {
            self.keep_version(&e.id, &known, false);
        }
        match self.write(e, &known) {
            Ok(Wrote::Yes) => Ok((None, true)),
            Ok(other) => {
                e.meta = before; // 쓰지 않았으니 글 · 머리말도 그대로 (다시 저장할 때 "같은 글" 로 건너뛰지 않게)
                e.body = known;
                refuse(false, other == Wrote::Skipped)
            }
            Err(err) => {
                e.meta = before;
                e.body = known;
                Err(err)
            }
        }
    }

    /// known: 파일에 있다고 알고 있는 본문 (save 가 바꾸기 전 것)
    fn write(&mut self, e: &mut Entry, known: &str) -> io::Result<Wrote> {
        if e.file.is_some() {
            if let Some(w) = self.keep_changed_on_disk(e, known)? {
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
        Ok(Wrote::Yes)
    }

    /// 마지막으로 읽은(쓴) 뒤 다른 기기가 이 파일을 바꿨는데 아직 알아채기 전에 덮어쓰려 할 때.
    ///   None: 그대로 쓴다 · Some: 쓰지 않는다
    fn keep_changed_on_disk(&mut self, e: &mut Entry, known: &str) -> io::Result<Option<Wrote>> {
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
        let (_, theirs) = memo_file::parse_memo_file(&text);
        if body::same_body(&theirs, known) || body::same_body(&theirs, &e.body) || body::is_blank_body(&theirs) {
            return Ok(None);
        }
        if body::same_body(&e.body, known) {
            // 이번 쓰기는 머리말만 — 들어온 글을 덮지 않는다
            // shortcut: JS 는 들어온 글에 이 기기의 머리말 변경을 더해 쓴다(adoptTheirs). 여기서는 쓰지 않고 다시 읽는다 — 머리말 쓰기를 옮길 때
            return Ok(Some(Wrote::Skipped));
        }
        if body::is_locked_body(&theirs) {
            // 그사이 다른 기기가 잠갔다: 덮어쓰지 않는다 (JS lockedOnDisk 의 "다른 비밀번호" 쪽 — 열쇠가 없으니 늘 이쪽)
            e.body = known.into();
            return Ok(Some(Wrote::Locked));
        }
        // 들어온 글을 사본 메모로 남기고 우리 글을 쓴다 — 아무것도 잃지 않게
        self.keep_version(&e.id, &theirs, true);
        self.import(&memo_file::conflict_copy_body(&theirs, &memo_file::conflict_label(chrono::Local::now())), Some(&e.meta.color.clone()))?;
        Ok(None)
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
        let Some(e) = self.entries.remove(id) else { return Ok(None) };
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

/// 종 단추 · 일정 탭이 세는 알림 (앞으로 울릴 것) — reminders.js isLiveCached
///   shortcut: 반복 일정은 늘 살아 있다고 보고, 한 번 울리는 것은 켜져 있고 시각이 지나지 않았으면 — 알림을 옮길 때(2단계) JS 규칙 그대로
fn is_live_cached(r: &Value) -> bool {
    if r["enabled"] == false {
        return false;
    }
    match r["kind"].as_str() {
        Some("at" | "timer") => {
            let end = r["end"].as_str().or(r["at"].as_str()).and_then(time::parse_js_date);
            end.is_some_and(|t| t.timestamp_millis() > chrono::Local::now().timestamp_millis()) || (r["task"] == true && r["done"] != true)
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("mk-vault-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
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
}
