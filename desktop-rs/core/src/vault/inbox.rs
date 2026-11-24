//! 받은 메모 빈 칸을 메모 폴더에 — 휴대폰 android/web/js/vault.js inbox 와 같은 차례
use super::{write_atomic, Vault};
use crate::inbox::{slot_memo, slot_name, INBOX_DIR, INBOX_SLOTS, SLOT_TEXT};
use crate::js;
use std::fs;

impl Vault {
    /// 빈 칸을 채워 두고(없는 것만), 채워진 칸을 메모로 옮긴 뒤 다시 비운다 → 새로 만든 메모 id 들.
    ///   ensure: 빈 칸을 만들까 (Drive 와 맞추는 동안만 — 맞추지 않으면 쓸 데가 없다)
    ///   같은 글의 메모가 이미 있으면(다른 기기가 먼저 옮겼다) 만들지 않고 칸만 비운다
    pub fn take_inbox(&mut self, ensure: bool) -> Vec<String> {
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
        assert!(v.take_inbox(true).is_empty());
        let dir = root.join(INBOX_DIR);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), INBOX_SLOTS, "빈 칸 100개");
        assert!(v.list().is_empty(), "빈 칸은 메모 목록에 없다");
        // AI 가 칸 하나를 덮어씀 → 메모로 옮기고 칸은 다시 비운다
        fs::write(dir.join(slot_name(7)), "---\ncolor: blue\n---\n# 오늘 날씨\n맑음 #날씨").unwrap();
        let made = v.take_inbox(true);
        assert_eq!(made.len(), 1);
        let m = v.get(&made[0]).unwrap();
        assert_eq!((m["title"].as_str(), m["color"].as_str()), (Some("오늘 날씨"), Some("blue")));
        assert_eq!(fs::read_to_string(dir.join(slot_name(7))).unwrap(), SLOT_TEXT);
        // 같은 글이 또 오면(다른 기기가 먼저 옮김) 새로 만들지 않고 칸만 비운다
        fs::write(dir.join(slot_name(8)), "# 오늘 날씨\n맑음 #날씨").unwrap();
        assert!(v.take_inbox(true).is_empty());
        assert_eq!(fs::read_to_string(dir.join(slot_name(8))).unwrap(), SLOT_TEXT);
        assert_eq!(v.list().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
