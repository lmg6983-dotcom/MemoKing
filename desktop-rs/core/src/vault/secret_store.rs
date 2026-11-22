//! 비밀 폴더를 메모 폴더(Vault)에 — 휴대폰 android/web/js/vault-secret.js 와 같은 생각
//!   연 비밀 폴더의 메모는 "파일이 없는 항목" (file: None, secret: 폴더 id) 으로만 든다
//!     → 목록 · 찾기 · 색인 · 알림 · 내보내기는 파일이 있는 항목만 보므로 저절로 빠진다
//!     → 저장(write)은 늘 잠가서 _memoking/secret 으로, 버전 · 휴지통 · 충돌 사본은 남기지 않는다 (모두 잠기지 않는 곳)
//!   열쇠는 연 동안만 (secrets) — 잠그면 항목과 함께 잊는다
use super::{write_atomic, Entry, Vault, ATTACH_DIR};
use crate::secret::{self, Folder};
use crate::{body, memo_file, time};
use serde_json::{json, Value};
use std::fs;
use std::io;

fn locked() -> io::Error {
    io::Error::other(secret::LOCKED)
}

impl Vault {
    fn secret_key(&self, fid: &str) -> io::Result<[u8; 32]> {
        self.secrets.get(fid).map(|f| f.key).ok_or_else(locked)
    }

    /// 메모 폴더 안 비밀 폴더 id 들 (잠겼든 열렸든)
    fn secret_ids(&self) -> Vec<String> {
        let Ok(rd) = fs::read_dir(self.abs(secret::SECRET_DIR)) else { return vec![] };
        let mut ids: Vec<String> = rd
            .flatten()
            .filter(|d| d.file_type().is_ok_and(|t| t.is_dir()))
            .map(|d| d.file_name().to_string_lossy().into_owned())
            .filter(|n| secret::safe_id(n))
            .collect();
        ids.sort();
        ids
    }

    /// 비밀 폴더 하나의 기록 (folder.json)
    pub fn secret_record(&self, fid: &str) -> Option<Value> {
        serde_json::from_str(&fs::read_to_string(self.abs(&secret::record_path(fid))).ok()?).ok()
    }

    /// 비밀번호를 맞춘 폴더를 연다 — 그 안 메모를 항목으로. 이름이 보이기 전에 만든 폴더면 보이는 이름(title)을 적어 둔다
    pub fn secret_add(&mut self, fid: &str, folder: Folder) {
        if let Some(mut record) = self.secret_record(fid).filter(|r| r["title"].as_str() != Some(folder.name.as_str())) {
            record["title"] = folder.name.clone().into();
            let _ = write_atomic(&self.abs(&secret::record_path(fid)), record.to_string().as_bytes());
        }
        self.secrets.insert(fid.into(), folder);
        self.secret_load(fid);
    }

    /// 모든 비밀 폴더 [{ fid, name, open, count }] (이름순) — 잠긴 것도 이름은 보인다 (count 는 연 폴더만)
    pub fn secret_folders(&self) -> Vec<Value> {
        let mut list: Vec<Value> = self
            .secret_ids()
            .into_iter()
            .filter_map(|fid| {
                if let Some(f) = self.secrets.get(&fid) {
                    let count = self.entries.values().filter(|e| e.secret.as_ref() == Some(&fid) && !body::is_blank_body(&e.body)).count();
                    return Some(json!({ "fid": fid, "name": f.name, "open": true, "count": count }));
                }
                let record = self.secret_record(&fid)?;
                let name = memo_file::clean_folder_name(record["title"].as_str().unwrap_or_default());
                Some(json!({ "fid": fid, "name": if name.is_empty() { "비밀 폴더".to_string() } else { name }, "open": false }))
            })
            .collect();
        list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        list
    }

    /// 새 비밀 폴더를 만들어 연 채로 → 폴더 id
    pub fn secret_insert_new(&mut self, record: &Value, folder: Folder) -> Result<String, String> {
        if self.secret_folders().iter().any(|f| f["name"] == folder.name.as_str()) {
            return Err("같은 이름의 비밀 폴더가 이미 있어요".into());
        }
        let fid = secret::random_id(9);
        let path = self.abs(&secret::record_path(&fid));
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        write_atomic(&path, record.to_string().as_bytes()).map_err(|e| e.to_string())?;
        self.secrets.insert(fid.clone(), folder);
        Ok(fid)
    }

    /// 열린 폴더의 메모를 (다시) 읽는다 — 다른 기기에서 고친 것도 열 때마다 새로
    fn secret_load(&mut self, fid: &str) {
        let Ok(key) = self.secret_key(fid) else { return };
        self.entries.retain(|_, e| e.secret.as_deref() != Some(fid));
        let Ok(rd) = fs::read_dir(self.abs(&secret::folder_dir(fid))) else { return };
        for item in rd.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let Some(mid) = name.strip_suffix(".mks").filter(|m| secret::safe_id(m)) else { continue };
            let Some(plain) = fs::read_to_string(item.path()).ok().and_then(|t| secret::open_text(&t, &key)) else { continue }; // 다른 열쇠 · 망가진 것은 건너뛴다
            let (mut meta, body) = memo_file::parse_memo_file(&plain);
            let id = secret::memo_id(fid, mid);
            meta.id = Some(id.clone());
            // 잠긴 동안 울린 알림의 울림 표시(last · 꺼짐)는 알림 파일에만 — 메모로 옮겨 온다 (다음 저장에서 다시 울리지 않게)
            let fired = self.secret_alarm_list(fid, mid);
            for r in meta.reminders.iter_mut() {
                if let Some(a) = fired.iter().find(|a| a["id"] == r["id"]) {
                    for k in ["last", "enabled"] {
                        if let Some(v) = a.get(k) {
                            r[k] = v.clone();
                        }
                    }
                }
            }
            self.entries.insert(id.clone(), Entry { id, file: None, folder: String::new(), meta, body, stamp: None, id_saved: true, disk_meta: None, secret: Some(fid.into()) });
        }
    }

    /// 비밀 폴더를 잠근다 (None 이면 모두) → 치운 메모 id 들 (열린 메모 창을 닫게)
    pub fn secret_lock(&mut self, fid: Option<&str>) -> Vec<String> {
        match fid {
            Some(f) => drop(self.secrets.remove(f)),
            None => self.secrets.clear(),
        }
        let gone: Vec<String> = self.entries.values().filter(|e| e.secret.as_ref().is_some_and(|f| !self.secrets.contains_key(f))).map(|e| e.id.clone()).collect();
        for id in &gone {
            self.entries.remove(id);
        }
        self.secret_alias.retain(|_, (f, _)| self.secrets.contains_key(f));
        gone
    }

    pub fn secret_is_open(&self) -> bool {
        !self.secrets.is_empty()
    }

    /// 비밀 폴더의 메모 카드들 (고정한 것 먼저, 최근 고친 순)
    pub fn secret_list(&self, fid: &str) -> Vec<Value> {
        let mut list: Vec<&Entry> = self.entries.values().filter(|e| e.secret.as_deref() == Some(fid) && !body::is_blank_body(&e.body)).collect();
        let t = |e: &Entry| e.meta.updated.as_deref().and_then(time::parse_js_date).map_or(0, |d| d.timestamp_millis());
        list.sort_by_cached_key(|e| (std::cmp::Reverse(e.meta.pinned), std::cmp::Reverse(t(e))));
        list.into_iter().map(|e| self.summary(e)).collect()
    }

    /// 비밀 폴더에 새 메모 (빈 채 — 쓰면 잠가 저장)
    pub fn secret_create_memo(&mut self, fid: &str, color: Option<&str>, mode: Option<&str>) -> io::Result<String> {
        self.secret_key(fid)?;
        let id = secret::memo_id(fid, &secret::random_id(9));
        let mut e = self.new_entry(&id, color, mode, "");
        e.secret = Some(fid.into());
        self.entries.insert(id.clone(), e);
        Ok(id)
    }

    /// 비밀 메모 저장 (save_entry 가 부른다) → 바뀌었는가
    pub(super) fn save_secret(&mut self, e: &mut Entry, body: &str) -> io::Result<bool> {
        if e.body == body {
            return Ok(false);
        }
        let fid = e.secret.clone().unwrap_or_default();
        self.secret_key(&fid)?;
        let on_disk = self.abs(&secret::memo_path(&fid, secret::parse_id(&e.id).map_or("", |p| p.1))).exists();
        if !on_disk && body::is_blank_body(body) {
            e.body = body.into(); // 아직 아무것도 쓰지 않은 새 메모 — 파일을 만들지 않는다
            return Ok(false);
        }
        let before = (std::mem::replace(&mut e.body, body.into()), e.meta.clone());
        e.meta.updated = Some(time::now_iso());
        e.meta.device = Some(self.device.clone());
        if let Err(err) = self.write_secret(e) {
            (e.body, e.meta) = before;
            return Err(err);
        }
        Ok(true)
    }

    /// 비밀 메모를 잠가 쓴다 — 본문에 남은 보통 첨부(attachments/…)도 잠가 옮긴다 (어느 길로 들어왔든 풀린 채 남지 않게)
    pub(super) fn write_secret(&mut self, e: &mut Entry) -> io::Result<()> {
        let fid = e.secret.clone().unwrap_or_default();
        let key = self.secret_key(&fid)?;
        let mid = secret::parse_id(&e.id).map(|p| p.1.to_string()).ok_or_else(|| io::Error::other("비밀 메모 id 가 아니에요"))?;
        // 이미 잠가 옮긴 첨부를 아직 옛 주소로 들고 있는 메모 창의 글 → 잠근 주소로
        for (from, (f, to)) in &self.secret_alias {
            if *f == fid && e.body.contains(from.as_str()) {
                e.body = e.body.replace(from.as_str(), to);
            }
        }
        let (body, moved) = self.seal_attachments(&fid, &e.body)?;
        if !moved.is_empty() {
            e.body = body;
            self.adopted.push(e.id.clone()); // 열린 메모 창이 잠근 주소로 다시 읽게 (다음 scan → external)
            self.drop_plain_attachments(&e.id, &moved);
        }
        e.meta.id = Some(e.id.clone());
        let dir = self.abs(&secret::folder_dir(&fid));
        fs::create_dir_all(&dir)?;
        write_atomic(&self.abs(&secret::memo_path(&fid, &mid)), secret::seal_text(&memo_file::serialize_memo_file(&e.meta, &e.body), &key).as_bytes())?;
        let alarms = secret::alarm_reminders(&e.meta);
        let alarms_path = self.abs(&secret::alarms_path(&fid, &mid));
        if alarms.is_empty() {
            let _ = fs::remove_file(alarms_path);
        } else {
            write_atomic(&alarms_path, json!({ "reminders": alarms }).to_string().as_bytes())?;
        }
        e.id_saved = true;
        Ok(())
    }

    /// 본문의 attachments/… 를 잠근 첨부로 → (바꾼 본문, 잠가 옮긴 원래 주소들)
    fn seal_attachments(&mut self, fid: &str, text: &str) -> io::Result<(String, Vec<(String, String)>)> {
        let mut out = text.to_string();
        let mut moved = vec![];
        for m in body::extract_media(text) {
            if !m.src.starts_with(&format!("{ATTACH_DIR}/")) {
                continue;
            }
            let Some(bytes) = self.resolve(&m.src).and_then(|p| fs::read(p).ok()) else { continue };
            let ext = m.src.rsplit_once('.').map_or("", |(_, e)| e);
            let to = self.secret_save_file(fid, &bytes, ext)?;
            out = out.replace(&m.src, &to);
            self.secret_alias.insert(m.src.clone(), (fid.into(), to.clone()));
            moved.push((m.src, to));
        }
        Ok((out, moved))
    }

    /// 잠가 옮긴 보통 첨부를 지운다 — 다른 (보통) 메모가 아직 쓰면 남긴다
    fn drop_plain_attachments(&self, except: &str, moved: &[(String, String)]) {
        let used: std::collections::HashSet<String> =
            self.entries.values().filter(|e| e.id != except && e.file.is_some()).flat_map(|e| body::extract_media(&e.body).into_iter().map(|m| m.src)).collect();
        for (src, _) in moved {
            if !used.contains(src) {
                if let Some(p) = self.resolve(src) {
                    let _ = fs::remove_file(p);
                }
            }
        }
    }

    /// 첨부를 잠가 둔다 → 본문에 쓸 "secret-file/<무작위>.<확장자>"
    pub fn secret_save_file(&self, fid: &str, bytes: &[u8], ext: &str) -> io::Result<String> {
        let key = self.secret_key(fid)?;
        let ext: String = ext.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
        let src = format!("{}{}{}", secret::FILE_PREFIX, secret::random_id(12), if ext.is_empty() { String::new() } else { format!(".{ext}") });
        let path = self.abs(&secret::file_path(fid, &src).unwrap());
        fs::create_dir_all(path.parent().unwrap())?;
        write_atomic(&path, &secret::seal_bytes(bytes, &key))?;
        Ok(src)
    }

    /// 잠근 첨부를 푼 바이트 (연 비밀 폴더에서 찾는다 — 잠겼으면 None)
    pub fn secret_file_bytes(&self, src: &str) -> Option<Vec<u8>> {
        self.secrets.iter().find_map(|(fid, f)| {
            let bytes = fs::read(self.abs(&secret::file_path(fid, src)?)).ok()?;
            secret::open_bytes(&bytes, &f.key)
        })
    }

    /// 비밀 메모 지우기 — 그 메모만 쓰던 잠근 첨부도 (휴지통에 두지 않는다)
    pub(super) fn remove_secret(&mut self, id: &str) -> io::Result<()> {
        let Some(e) = self.entries.remove(id) else { return Ok(()) };
        let (Some(fid), Some((_, mid))) = (e.secret.as_deref(), secret::parse_id(id)) else { return Ok(()) };
        for p in [secret::memo_path(fid, mid), secret::alarms_path(fid, mid)] {
            match fs::remove_file(self.abs(&p)) {
                Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
                _ => {}
            }
        }
        let used: std::collections::HashSet<String> = self.entries.values().filter(|x| x.secret.as_deref() == Some(fid)).flat_map(|x| secret::secret_files(&x.body)).collect();
        for src in secret::secret_files(&e.body) {
            if !used.contains(&src) {
                if let Some(p) = secret::file_path(fid, &src) {
                    let _ = fs::remove_file(self.abs(&p));
                }
            }
        }
        Ok(())
    }

    /// 보통 메모 → 비밀 폴더 (첨부까지 잠그고, 원래 메모 · 그 버전 기록 · 첨부는 휴지통에 두지 않고 지운다) → 비밀 메모 id
    pub fn move_to_secret(&mut self, id: &str, fid: &str) -> io::Result<String> {
        self.secret_key(fid)?;
        let e = self.entries.get(id).filter(|e| e.secret.is_none()).cloned().ok_or_else(|| io::Error::other("옮길 메모를 찾지 못했어요"))?;
        let plain = self.plain_of(&e).ok_or_else(|| io::Error::other("잠긴 메모는 먼저 열어서 잠금을 푼 뒤 옮겨 주세요"))?;
        let new_id = secret::memo_id(fid, &secret::random_id(9));
        let mut meta = e.meta.clone();
        for k in ["lockRefs", "lockHideTitle", "trashedFrom"] {
            meta.extra.shift_remove(k);
        }
        let mut c = Entry { id: new_id.clone(), file: None, folder: String::new(), meta, body: plain, stamp: None, id_saved: true, disk_meta: None, secret: Some(fid.into()) };
        self.entries.remove(id); // 먼저 빼 둔다 — 첨부 정리가 "이 메모가 아직 쓴다" 로 보지 않게
        let written = self.write_secret(&mut c); // 첨부도 여기서 잠가 옮긴다 (다른 메모가 쓰는 것은 남김)
        self.adopted.retain(|x| x != &new_id);
        let removed = written.and_then(|()| match &e.file {
            Some(file) => match fs::remove_file(self.abs(file)) {
                Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
                _ => Ok(()),
            },
            None => Ok(()),
        });
        if let Err(err) = removed {
            let _ = self.remove_secret_files_of(&c);
            self.entries.insert(id.into(), e);
            return Err(err);
        }
        self.locks.remove(id);
        self.purge_versions(id);
        self.entries.insert(new_id.clone(), c);
        Ok(new_id)
    }

    // 옮기다 실패: 방금 만든 비밀 메모를 거둔다
    fn remove_secret_files_of(&mut self, c: &Entry) -> io::Result<()> {
        self.entries.insert(c.id.clone(), c.clone());
        self.remove_secret(&c.id)
    }

    /// 비밀 메모 → 보통 메모 (folder: 넣을 보통 폴더). 잠근 첨부는 풀어 attachments/ 로 → 새 메모 id
    pub fn move_out_of_secret(&mut self, id: &str, folder: &str) -> io::Result<String> {
        let e = self.entries.get(id).filter(|e| e.secret.is_some()).cloned().ok_or_else(|| io::Error::other("비밀 메모를 찾지 못했어요"))?;
        let mut text = e.body.clone();
        for src in secret::secret_files(&e.body) {
            let bytes = self.secret_file_bytes(&src).ok_or_else(|| io::Error::other("비밀 첨부를 열지 못했어요"))?;
            let to = self.save_attachment(&bytes, src.rsplit_once('.').map_or("", |(_, x)| x))?;
            text = text.replace(&src, &to);
        }
        let new_id = self.create(Some(&e.meta.color.clone()), Some(&e.meta.mode.clone()), folder);
        let mut c = self.entries.remove(&new_id).unwrap();
        c.meta = e.meta.clone();
        c.meta.id = Some(new_id.clone());
        c.body = text;
        let r = self.write(&mut c, "", true);
        self.entries.insert(new_id.clone(), c);
        r?;
        self.remove_secret(id)?;
        Ok(new_id)
    }

    /// 보통 폴더 → 비밀 폴더: 같은 이름의 비밀 폴더를 만들어 안의 메모(첨부까지)를 모두 잠가 옮기고, 빈 폴더는 치운다 → 폴더 id
    ///   잠긴 메모는 열지 못하니 남긴다 (그 폴더도 남는다) → (폴더 id, 남긴 메모 수)
    pub fn secret_from_folder(&mut self, folder: &str, record: &Value, f: Folder) -> Result<(String, usize), String> {
        if folder.is_empty() || memo_file::clean_folder_name(folder) != folder {
            return Err("폴더 이름으로 쓸 수 없어요".into());
        }
        let fid = self.secret_insert_new(record, f)?;
        let ids: Vec<String> = self.entries.values().filter(|e| e.file.as_deref().is_some_and(|p| memo_file::folder_of(p) == folder)).map(|e| e.id.clone()).collect();
        let mut left = 0;
        for id in ids {
            if self.move_to_secret(&id, &fid).is_err() {
                left += 1;
            }
        }
        let _ = fs::remove_dir(self.root.join(folder)); // 다른 파일이 남았으면 그대로
        Ok((fid, left))
    }

    /// 비밀 폴더 → 보통 폴더 (같은 이름): 메모를 모두 풀어 꺼내고 비밀 폴더를 치운다 → 폴더 이름
    pub fn secret_to_folder(&mut self, fid: &str) -> Result<String, String> {
        let name = self.secrets.get(fid).map(|f| f.name.clone()).ok_or(secret::LOCKED)?;
        let dir = self.create_folder(&name)?;
        let ids: Vec<String> = self.entries.values().filter(|e| e.secret.as_deref() == Some(fid)).map(|e| e.id.clone()).collect();
        for id in ids {
            if self.entries.get(&id).is_some_and(|e| body::is_blank_body(&e.body)) {
                self.remove_secret(&id).map_err(|e| e.to_string())?;
                continue;
            }
            self.move_out_of_secret(&id, &dir).map_err(|e| e.to_string())?;
        }
        self.secret_remove_folder(fid).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    pub fn secret_rename(&mut self, fid: &str, name: &str) -> Result<String, String> {
        let key = self.secret_key(fid).map_err(|e| e.to_string())?;
        let path = self.abs(&secret::record_path(fid));
        let record: Value = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or("비밀 폴더 정보를 읽지 못했어요")?;
        let (next, clean) = secret::renamed_record(&record, &key, name)?;
        write_atomic(&path, next.to_string().as_bytes()).map_err(|e| e.to_string())?;
        self.secrets.get_mut(fid).unwrap().name = clean.clone();
        Ok(clean)
    }

    /// 비밀 폴더 통째로 지우기 (열린 폴더만) → 치운 메모 id 들
    pub fn secret_remove_folder(&mut self, fid: &str) -> io::Result<Vec<String>> {
        self.secret_key(fid)?;
        fs::remove_dir_all(self.abs(&secret::folder_dir(fid)))?;
        Ok(self.secret_lock(Some(fid)))
    }

    /// 비밀 메모 하나의 알림 파일 (때만)
    fn secret_alarm_list(&self, fid: &str, mid: &str) -> Vec<Value> {
        fs::read_to_string(self.abs(&secret::alarms_path(fid, mid)))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["reminders"].as_array().cloned())
            .unwrap_or_default()
    }

    /// 알림 실행기가 울릴 비밀 메모의 알림 [{ memoId, reminder }] — 잠겨 있어도 (이름 없이)
    pub fn secret_alarm_items(&self) -> Vec<Value> {
        self.secret_alarms().into_iter().flat_map(|a| a["reminders"].as_array().cloned().unwrap_or_default().into_iter().map(move |r| json!({ "memoId": a["memoId"], "reminder": r }))).collect()
    }

    /// 비밀 메모 알림 하나의 지금 모습 (울리기 직전에 다시 확인하려고)
    pub fn secret_alarm(&self, id: &str, reminder_id: &Value) -> Option<Value> {
        let (fid, mid) = secret::parse_id(id)?;
        self.secret_alarm_list(fid, mid).into_iter().find(|r| r["id"] == *reminder_id)
    }

    /// 울림 표시를 적는다 — 알림 파일에, 연 폴더면 메모에도 (잠가서) → 적었나
    pub fn secret_set_alarm(&mut self, id: &str, reminder: &Value) -> io::Result<bool> {
        let Some((fid, mid)) = secret::parse_id(id).map(|(f, m)| (f.to_string(), m.to_string())) else { return Ok(false) };
        if let Some(mut e) = self.entries.remove(id) {
            for r in e.meta.reminders.iter_mut() {
                if r["id"] == reminder["id"] {
                    let title = r.get("title").cloned(); // 알림 파일의 알림에는 이름이 없다 — 메모의 이름은 그대로
                    *r = reminder.clone();
                    if let (Some(t), Some(o)) = (title, r.as_object_mut()) {
                        o.insert("title".into(), t);
                    }
                }
            }
            let r = self.write_secret(&mut e);
            self.entries.insert(id.into(), e);
            r?;
        }
        let mut list = self.secret_alarm_list(&fid, &mid);
        let Some(slot) = list.iter_mut().find(|r| r["id"] == reminder["id"]) else { return Ok(self.entries.contains_key(id)) };
        let mut next = reminder.clone();
        if let Some(o) = next.as_object_mut() {
            o.shift_remove("title"); // 이름은 알림 파일에 남기지 않는다
        }
        *slot = next;
        write_atomic(&self.abs(&secret::alarms_path(&fid, &mid)), json!({ "reminders": list }).to_string().as_bytes())?;
        Ok(true)
    }

    /// 모든 비밀 폴더의 일정 · 알림 (잠겨 있어도) → [{ memoId, reminders }] — 이름 없이 "비밀 메모의 일정" 으로만 알린다
    pub fn secret_alarms(&self) -> Vec<Value> {
        let mut out = vec![];
        for fid in self.secret_ids() {
            let Ok(rd) = fs::read_dir(self.abs(&secret::folder_dir(&fid))) else { continue };
            for item in rd.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                let Some(mid) = name.strip_suffix(".alarms.json").filter(|m| secret::safe_id(m)) else { continue };
                let Some(v) = fs::read_to_string(item.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
                if v["reminders"].as_array().is_some_and(|r| !r.is_empty()) {
                    out.push(json!({ "memoId": secret::memo_id(&fid, mid), "reminders": v["reminders"] }));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("mk-secret-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn all_text(root: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(d: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for e in fs::read_dir(d).unwrap().flatten() {
                if e.path().is_dir() {
                    walk(&e.path(), out);
                } else {
                    out.push((e.path().to_string_lossy().into_owned(), fs::read(e.path()).unwrap()));
                }
            }
        }
        let mut out = vec![];
        walk(root, &mut out);
        out
    }

    fn open_with(v: &mut Vault, pw: &str) -> Vec<String> {
        let mut opened = vec![];
        let locked: Vec<String> = v.secret_folders().into_iter().filter(|f| f["open"] == false).filter_map(|f| f["fid"].as_str().map(str::to_string)).collect();
        let records: Vec<(String, Value)> = locked.into_iter().filter_map(|fid| Some((fid.clone(), v.secret_record(&fid)?))).collect();
        for (fid, record) in records {
            if let Ok(f) = secret::unlock_record(&record, pw) {
                v.secret_add(&fid, f);
                opened.push(fid);
            }
        }
        opened
    }

    #[test]
    fn secret_memo_never_touches_plain_files() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let (record, folder) = secret::new_record("일기장", "pass1234", 1000).unwrap();
        let fid = v.secret_insert_new(&record, folder).unwrap();
        let id = v.secret_create_memo(&fid, Some("pink"), None).unwrap();
        assert!(!v.save(&id, "").unwrap().1, "빈 새 메모는 쓰지 않는다");
        let reminders = vec![json!({ "id": "r1", "kind": "at", "at": "2026-12-01T09:00:00", "title": "병원 예약", "enabled": true })];
        v.save(&id, "# 첫사랑 이야기\n\n아무도 모르는 비밀").unwrap();
        v.set_reminders(&id, reminders).unwrap();
        assert!(v.list().is_empty() && v.search("첫사랑", None).is_empty(), "목록 · 찾기에 들지 않는다");
        assert_eq!(v.secret_list(&fid)[0]["title"], "첫사랑 이야기");
        v.scan();
        assert_eq!(v.secret_list(&fid).len(), 1, "다시 읽어도 남는다");
        for (p, b) in all_text(&root) {
            let t = String::from_utf8_lossy(&b);
            assert!(!t.contains("첫사랑") && !t.contains("병원") && !p.ends_with(".md"), "{p} 에 드러남");
            assert!(!t.contains("일기장") || p.ends_with("folder.json"), "{p} 에 이름 (folder.json 의 보이는 이름만)");
        }
        // 잠그면 항목이 사라지고, 잠긴 메모로는 저장하지 않는다 (보통 메모로 되살아나지 않게)
        assert_eq!(v.secret_lock(None), vec![id.clone()]);
        assert!(v.save(&id, "# 새어 나가면 안 됨").is_err());
        assert!(all_text(&root).iter().all(|(p, _)| !p.ends_with(".md")));
        // 알림은 잠겨 있어도 (이름 없이)
        let alarms = v.secret_alarms();
        assert_eq!(alarms[0]["memoId"], json!(id));
        assert!(!json!(alarms).to_string().contains("병원"));
        // 잠긴 동안 울림 표시는 알림 파일에 — 다시 열면 메모로 옮겨 온다
        let item = v.secret_alarm_items().pop().unwrap();
        let mut fired = item["reminder"].clone();
        fired["last"] = "2026-12-01T09:00:00".into();
        fired["enabled"] = false.into();
        assert!(v.secret_set_alarm(&id, &fired).unwrap());
        assert_eq!(v.secret_alarm(&id, &json!("r1")).unwrap()["enabled"], false);
        assert_eq!(v.secret_folders()[0], json!({ "fid": fid, "name": "일기장", "open": false }), "잠겨도 이름은 보인다");
        // 다른 비밀번호로는 열리지 않고, 맞으면 다시
        assert!(open_with(&mut v, "wrong999").is_empty());
        assert_eq!(open_with(&mut v, "pass1234"), vec![fid.clone()]);
        assert!(v.get(&id).unwrap()["body"].as_str().unwrap().contains("아무도 모르는"));
        let r = &v.get(&id).unwrap()["reminders"][0];
        assert_eq!((r["enabled"].clone(), r["last"].clone(), r["title"].clone()), (json!(false), json!("2026-12-01T09:00:00"), json!("병원 예약")));
        assert_eq!(v.secret_folders()[0], json!({ "fid": fid, "name": "일기장", "open": true, "count": 1 }));
        // 지우면 휴지통이 아니라 바로
        v.trash(&id).unwrap();
        assert!(v.secret_list(&fid).is_empty() && !root.join("_memoking/trash").read_dir().unwrap().any(|_| true));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_in_and_out_with_attachments() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let photo = [137u8, 80, 78, 71, 1, 2, 3];
        let src = v.save_attachment(&photo, "png").unwrap();
        let id = v.create(Some("green"), None, "");
        v.save(&id, &format!("# 여권\n\n![]({src})\n")).unwrap();
        let (record, folder) = secret::new_record("서류", "pass1234", 1000).unwrap();
        let fid = v.secret_insert_new(&record, folder).unwrap();
        let sid = v.move_to_secret(&id, &fid).unwrap();
        assert!(v.list().is_empty() && !root.join("여권.md").exists() && v.resolve(&src).is_some_and(|p| !p.exists()), "원래 메모 · 첨부는 지운다");
        let body = v.get(&sid).unwrap()["body"].as_str().unwrap().to_string();
        let files = secret::secret_files(&body);
        assert_eq!(files.len(), 1);
        assert_eq!(v.secret_file_bytes(&files[0]).unwrap(), photo);
        assert!(all_text(&root).iter().all(|(_, b)| !b.windows(photo.len()).any(|w| w == photo)), "디스크에 원래 바이트가 없다");
        // 비밀 메모에 보통 첨부가 들어와도 저장할 때 잠가 옮긴다
        let plain = v.save_attachment(&[1, 2, 3, 4, 5], "pdf").unwrap();
        v.save(&sid, &format!("{body}\n[문서.pdf]({plain})\n")).unwrap();
        assert!(!v.get(&sid).unwrap()["body"].as_str().unwrap().contains("attachments/"));
        assert!(v.resolve(&plain).is_some_and(|p| !p.exists()));
        // 꺼내기
        let back = v.move_out_of_secret(&sid, "").unwrap();
        let out = v.get(&back).unwrap()["body"].as_str().unwrap().to_string();
        assert!(out.contains("attachments/") && !out.contains("secret-file/"));
        assert_eq!(v.list().len(), 1);
        assert!(v.secret_list(&fid).is_empty());
        assert!(!root.join("_memoking/secret").join(&fid).join("files").read_dir().unwrap().any(|_| true), "잠근 첨부도 치운다");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_to_secret_and_back() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        v.create_folder("일기").unwrap();
        let src = v.save_attachment(&[9, 8, 7], "png").unwrap();
        let a = v.create(None, None, "일기");
        v.save(&a, &format!("# 첫날\n\n![]({src})\n")).unwrap();
        let b = v.create(None, None, "");
        v.save(&b, "# 밖의 메모").unwrap();
        let (record, f) = secret::new_record("일기", "pass1234", 1000).unwrap();
        let (fid, left) = v.secret_from_folder("일기", &record, f).unwrap();
        assert_eq!(left, 0);
        assert!(!root.join("일기").exists(), "빈 보통 폴더는 치운다");
        assert_eq!(v.list().len(), 1, "밖의 메모는 그대로");
        assert_eq!(v.secret_list(&fid)[0]["title"], "첫날");
        assert!(v.resolve(&src).is_some_and(|p| !p.exists()), "첨부도 잠가 옮긴다");
        // 되돌리기: 같은 이름의 보통 폴더로
        assert_eq!(v.secret_to_folder(&fid).unwrap(), "일기");
        let back: Vec<Value> = v.list().into_iter().filter(|m| m["folder"] == "일기").collect();
        assert_eq!(back.len(), 1);
        assert!(v.get(back[0]["id"].as_str().unwrap()).unwrap()["body"].as_str().unwrap().contains("attachments/"));
        assert!(v.secret_folders().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
