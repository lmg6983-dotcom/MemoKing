//! 받은 메모 빈 칸을 메모 폴더에 — 휴대폰 android/web/js/vault.js inbox 와 같은 차례
use super::{write_atomic, Vault};
use crate::inbox::{slot_memo, slot_name, INBOX_DIR, INBOX_SLOTS, SLOT_TEXT};
use crate::js;
use std::fs;

impl Vault {
    /// 빈 칸을 채워 두고(없는 것만), 채워진 칸을 메모로 옮긴 뒤 다시 비운다 → 새로 만든 메모 id 들.
    ///   ensure: 빈 칸을 만들까 (Drive 와 맞추는 동안만 — 맞추지 않으면 쓸 데가 없다)
    ///   take: 채워진 칸을 옮길까 (켜져 있는 기기 가운데 한 기기만 — core/devices.rs inbox_leader)
    ///   같은 글의 메모가 이미 있으면(다른 기기가 먼저 옮겼다) 만들지 않고 칸만 비운다
    pub fn take_inbox(&mut self, ensure: bool, take: bool) -> Vec<String> {
        let dir = self.root.join(INBOX_DIR);
        if ensure && fs::create_dir_all(&dir).is_ok() {
            for n in 1..=INBOX_SLOTS {
                let f = dir.join(slot_name(n));
                if !f.exists() {
                    let _ = write_atomic(&f, SLOT_TEXT.as_bytes());
                }
            }
        }
        let mut made = vec![];
        if !take {
            return made;
        }
        for n in 1..=INBOX_SLOTS {
            let f = dir.join(slot_name(n));
            let Ok(meta) = fs::metadata(&f) else { continue };
            let stamp = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len());
            if self.inbox_seen.get(&n) == Some(&stamp) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&f) else { continue };
            if let Some((body, color)) = slot_memo(&text) {
                let have = self.entries.values().any(|e| js::trim(&e.body) == js::trim(&body));
                if !have {
                    match self.import(&body, Some(&color)) {
                        Ok(Some(id)) => made.push(id),
                        _ => continue, // 못 옮겼으면 칸을 비우지 않는다 (다음에 다시)
                    }
                }
                if write_atomic(&f, SLOT_TEXT.as_bytes()).is_err() {
                    continue;
                }
            }
            if let Ok(m) = fs::metadata(&f) {
                self.inbox_seen.insert(n, (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len()));
            }
        }
        made
    }

    /// 다른 앱(Gemini 등)이 지우고 새로 만든 메모 — 머리말 id 가 같은 메모에 글을 이어 쓴다 (PC 다리 app/src/drive_bridge.rs).
    ///   그 메모가 휴지통에 있으면(원래 파일이 지워져 다른 기기에서 휴지통으로 왔다) 되살려 쓴다. 잠긴 메모는 건드리지 않는다
    ///   → 이어 쓴 메모 id (같은 id 의 메모가 어디에도 없으면 None)
    pub fn relink(&mut self, id: &str, body: &str) -> std::io::Result<Option<String>> {
        let live = match self.entries.get(id) {
            Some(e) if crate::body::is_locked_body(&e.body) => return Ok(None),
            Some(_) => id.to_string(),
            None => {
                let Some((name, ..)) = self.trash_entries().into_iter().find(|t| t.3.id.as_deref() == Some(id) && !crate::body::is_locked_body(&t.4)) else { return Ok(None) };
                let Some(back) = self.restore_trash(&name)? else { return Ok(None) };
                back
            }
        };
        if js::trim(&self.entries[&live].body) != js::trim(body) {
            self.save(&live, js::trim(body))?;
        }
        Ok(Some(live))
    }
}

#[cfg(test)]
mod tests {
    use crate::inbox::{slot_name, INBOX_DIR, INBOX_SLOTS, SLOT_TEXT};
    use crate::vault::Vault;
    use std::fs;

    #[test]
    fn slots_become_memos() {
        let root = std::env::temp_dir().join(format!("mk-inbox-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&root).unwrap();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        assert!(v.take_inbox(true, true).is_empty());
        let dir = root.join(INBOX_DIR);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), INBOX_SLOTS, "빈 칸 100개");
        assert!(v.list().is_empty(), "빈 칸은 메모 목록에 없다");
        // AI 가 칸 하나를 덮어씀 → 메모로 옮기고 칸은 다시 비운다
        fs::write(dir.join(slot_name(7)), "---\ncolor: blue\n---\n# 오늘 날씨\n맑음 #날씨").unwrap();
        let made = v.take_inbox(true, true);
        assert_eq!(made.len(), 1);
        let m = v.get(&made[0]).unwrap();
        assert_eq!((m["title"].as_str(), m["color"].as_str()), (Some("오늘 날씨"), Some("blue")));
        assert_eq!(fs::read_to_string(dir.join(slot_name(7))).unwrap(), SLOT_TEXT);
        // 같은 글이 또 오면(다른 기기가 먼저 옮김) 새로 만들지 않고 칸만 비운다
        fs::write(dir.join(slot_name(8)), "# 오늘 날씨\n맑음 #날씨").unwrap();
        assert!(v.take_inbox(true, true).is_empty());
        assert_eq!(fs::read_to_string(dir.join(slot_name(8))).unwrap(), SLOT_TEXT);
        assert_eq!(v.list().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relink_by_id() {
        let root = std::env::temp_dir().join(format!("mk-relink-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&root).unwrap();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.create(None, None, "");
        v.save(&id, "# 장보기\n우유").unwrap();
        // 같은 id 의 새 글 → 그 메모에 이어 쓴다 (새 메모를 만들지 않는다)
        assert_eq!(v.relink(&id, "# 장보기\n우유\n빵").unwrap().as_deref(), Some(id.as_str()));
        assert_eq!(v.list().len(), 1);
        assert!(v.entries[&id].body.contains("빵"));
        // 휴지통에 간 메모 → 되살려 쓴다
        v.trash(&id).unwrap();
        assert!(v.list().is_empty());
        let back = v.relink(&id, "# 장보기\n달걀").unwrap().expect("되살림");
        assert_eq!(v.list().len(), 1);
        assert!(v.entries[&back].body.contains("달걀"));
        assert_eq!(v.relink("없는-id", "# x").unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }
}
