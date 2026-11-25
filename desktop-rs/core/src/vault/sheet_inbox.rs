//! AI 받은함 시트의 요청을 메모 폴더에 — 휴대폰 android/web/js/vault.js applySheetJob 과 같은 규칙
use super::Vault;
use crate::body::is_locked_body;
use crate::sheet_inbox::{append_text, replace_once, Job};

impl Vault {
    /// 요청 하나를 처리한다 → 메모 id (거절하면 까닭). 고치기 전 글은 versions/ 에 남긴다
    ///   잠긴 메모 · 비밀 폴더 메모 · 없는 메모는 건드리지 않는다
    pub fn apply_sheet_job(&mut self, job: &Job) -> Result<String, String> {
        let io = |e: std::io::Error| format!("저장하지 못했어요 ({e})");
        let refused = |s: &serde_json::Value| s["refused"] == true;
        match job {
            Job::Create { folder, color, body } => {
                if is_locked_body(body) {
                    return Err("잠금 형식 글은 만들 수 없어요".into());
                }
                let id = self.create(Some(color.as_str()), None, folder);
                let (summary, _) = self.save(&id, body).map_err(io)?;
                if refused(&summary) {
                    self.entries.remove(&id);
                    return Err("저장하지 못했어요".into());
                }
                Ok(id)
            }
            Job::Append { memo_id, body } | Job::Replace { memo_id, body, .. } => {
                let old = self.editable(memo_id)?;
                let next = match job {
                    Job::Replace { find, .. } => replace_once(&old, find, body)?,
                    _ => append_text(&old, body),
                };
                self.keep_version(memo_id, &old, true);
                let (summary, _) = self.save(memo_id, &next).map_err(io)?;
                if refused(&summary) {
                    return Err("그사이 다른 기기가 고쳐 저장하지 못했어요. 다시 보내 주세요".into());
                }
                Ok(memo_id.clone())
            }
            Job::Trash { memo_id } => {
                self.editable(memo_id)?;
                self.trash(memo_id).map_err(io)?.ok_or("휴지통으로 옮기지 못했어요")?;
                Ok(memo_id.clone())
            }
        }
    }

    /// AI 가 고칠 수 있는 메모의 지금 글 (없거나 · 잠겼거나 · 비밀 폴더면 까닭)
    fn editable(&self, id: &str) -> Result<String, String> {
        let e = self.entries.get(id).ok_or("그런 memo_id 의 메모가 없어요")?;
        if e.secret.is_some() || is_locked_body(&e.body) {
            return Err("잠긴 메모는 고칠 수 없어요".into());
        }
        Ok(e.body.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::tmp;
    use super::*;
    use std::fs;

    #[test]
    fn four_actions_and_refusals() {
        let root = tmp();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let id = v.apply_sheet_job(&Job::Create { folder: "업무".into(), color: "blue".into(), body: "# 회의\n월요일".into() }).unwrap();
        assert!(root.join("업무/회의.md").exists(), "폴더 안에 첫 줄 제목으로");
        assert_eq!(v.entries[&id].meta.color, "blue", "지정한 색으로 생성");
        v.apply_sheet_job(&Job::Append { memo_id: id.clone(), body: "화요일".into() }).unwrap();
        assert_eq!(v.entries[&id].body, "# 회의\n월요일\n화요일");
        v.apply_sheet_job(&Job::Replace { memo_id: id.clone(), find: "화요일".into(), body: "수요일".into() }).unwrap();
        assert_eq!(v.entries[&id].body, "# 회의\n월요일\n수요일");
        assert!(fs::read_dir(root.join("_memoking/versions").join(&id)).unwrap().count() >= 2, "고치기 전 글은 버전으로");
        assert!(v.apply_sheet_job(&Job::Replace { memo_id: id.clone(), find: "없는 글".into(), body: "x".into() }).is_err());
        assert!(v.apply_sheet_job(&Job::Append { memo_id: "없는-id".into(), body: "x".into() }).is_err());
        v.apply_sheet_job(&Job::Trash { memo_id: id.clone() }).unwrap();
        assert!(!v.entries.contains_key(&id) && fs::read_dir(root.join("_memoking/trash")).unwrap().count() > 0);
        // 잠긴 메모는 고치지도 지우지도 않는다
        let locked = "---\nid: lk\ncolor: yellow\n---\n# 비밀\n\n<!-- memoking-lock v1 n=310000 s=AAAA i=BBBB c=CCCC== -->\n";
        fs::write(root.join("비밀.md"), locked).unwrap();
        v.open().unwrap();
        for job in [Job::Append { memo_id: "lk".into(), body: "x".into() }, Job::Trash { memo_id: "lk".into() }] {
            assert_eq!(v.apply_sheet_job(&job), Err("잠긴 메모는 고칠 수 없어요".into()));
        }
        assert_eq!(fs::read_to_string(root.join("비밀.md")).unwrap(), locked);
        fs::remove_dir_all(root).unwrap();
    }
}
