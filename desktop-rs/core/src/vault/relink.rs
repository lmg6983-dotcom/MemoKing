//! 같은 id 의 메모에 이어 쓰기 — PC 다리(app/src/drive_bridge.rs)가 다른 앱이 지우고 새로 만든 메모를 원래 메모로 돌려놓는다
use super::Vault;
use crate::js;

impl Vault {
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
    use crate::vault::Vault;
    use std::fs;

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
