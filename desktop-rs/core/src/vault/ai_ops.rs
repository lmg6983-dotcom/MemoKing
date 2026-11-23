//! AI 요청 메모의 요청을 메모 폴더에 반영 — 휴대폰 app/js/core/ai-requests.js applyOps 와 같은 차례 · 같은 말
//!   본문을 고치기 전 글은 지난 버전으로 남긴다 (되돌릴 수 있게). 잠긴 메모 · 비밀 메모는 고치지 않는다
use super::{Entry, Vault};
use crate::ai_requests::{edit_body, merge_bodies, result_line};
use crate::{body, memo_file};
use serde_json::{json, Value};

impl Vault {
    /// 메모 주소(id 또는 "업무/회의.md") → 메모 id
    fn find_memo(&self, reference: &str) -> Option<String> {
        let r = crate::js::trim(reference).replace('\\', "/");
        let r = r.trim_start_matches('/');
        if r.is_empty() {
            return None;
        }
        if self.entries.contains_key(r) {
            return Some(r.to_string());
        }
        let same = |f: &str, want: &str| f == want || f.strip_suffix(".md") == Some(want);
        // 같은 경로는 하나뿐 (HashMap 차례에 기대지 않는다)
        if let Some(e) = self.entries.values().find(|e| e.file.as_deref().is_some_and(|f| same(f, r))) {
            return Some(e.id.clone());
        }
        // 다른 기기가 먼저 다른 폴더로 옮겼다: 파일 이름이 하나뿐이면 그것
        let base = r.rsplit('/').next().unwrap_or(r);
        let named: Vec<&Entry> = self.entries.values().filter(|e| e.file.as_deref().is_some_and(|f| same(f.rsplit('/').next().unwrap_or(f), base))).collect();
        (named.len() == 1).then(|| named[0].id.clone())
    }

    fn not_editable(e: Option<&Entry>) -> &'static str {
        match e {
            None => "메모를 찾지 못했어요",
            Some(e) if e.secret.is_some() || e.file.is_none() || body::is_locked_body(&e.body) => "잠긴 메모는 고치지 않아요",
            _ => "",
        }
    }

    fn title_of(&self, id: Option<&str>) -> String {
        let Some(e) = id.and_then(|id| self.entries.get(id)) else { return String::new() };
        let t = body::extract_title(&e.body);
        if !t.is_empty() {
            return t;
        }
        e.file.clone().unwrap_or_else(|| e.id.clone())
    }

    /// 요청들을 반영 → 결과 줄들
    pub fn apply_ai_ops(&mut self, ops: &[Value]) -> Vec<String> {
        ops.iter().map(|op| self.apply_ai_op(op)).collect()
    }

    fn apply_ai_op(&mut self, op: &Value) -> String {
        let id = op["memo"].as_str().filter(|m| !m.is_empty()).and_then(|m| self.find_memo(m));
        let title = self.title_of(id.as_deref());
        let done = |status: &str, note: &str| result_line(op, &title, status, note);
        if let Some(e) = op["error"].as_str() {
            return done("fail", e);
        }
        let s = |k: &str| op[k].as_str().unwrap_or("").to_string();
        if op["do"] == "create" {
            let text = s("text");
            if self.entries.values().any(|x| crate::js::trim(&x.body) == text) {
                return done("same", "같은 메모가 이미 있어요");
            }
            let (color, folder) = (s("color"), s("folder"));
            let new = self.create((!color.is_empty()).then_some(color.as_str()), None, &folder);
            return match self.save(&new, &format!("{text}\n")) {
                Ok(_) => result_line(op, &self.title_of(Some(&new)), "ok", &if folder.is_empty() { "만듦".to_string() } else { format!("{folder} 폴더에 만듦") }),
                Err(e) => done("fail", &e.to_string()),
            };
        }
        let why = Self::not_editable(id.as_deref().and_then(|i| self.entries.get(i)));
        if !why.is_empty() {
            return done("fail", why);
        }
        let id = id.unwrap();
        let (body, color, file) = {
            let e = &self.entries[&id];
            (e.body.clone(), e.meta.color.clone(), e.file.clone().unwrap_or_default())
        };
        let r: Result<String, String> = match op["do"].as_str().unwrap_or("") {
            "tag" | "replace" | "append" => {
                let (next, status, note) = edit_body(&body, op);
                if status == "ok" {
                    self.keep_version(&id, &body, true);
                    if let Err(e) = self.save(&id, &next) {
                        return done("fail", &e.to_string());
                    }
                }
                return done(status, &note);
            }
            "color" => {
                if color == s("color") {
                    return done("same", "이미 그 색이에요");
                }
                self.set_meta(&id, &json!({ "color": s("color") })).map(|_| format!("{} 로 바꿈", s("color"))).map_err(|e| e.to_string())
            }
            "move" => {
                let want = s("folder");
                let dir = memo_file::clean_folder_name(&want);
                if !want.is_empty() && dir.is_empty() {
                    return done("fail", "폴더 이름으로 쓸 수 없어요");
                }
                if memo_file::folder_of(&file) == dir {
                    return done("same", "이미 그 폴더예요");
                }
                self.move_to_folder(&id, &dir).map(|_| if dir.is_empty() { "맨 위로".to_string() } else { format!("{dir} 폴더로") })
            }
            "trash" => self.trash(&id).map(|_| "휴지통으로".to_string()).map_err(|e| e.to_string()),
            "merge" => {
                let mut froms: Vec<String> = vec![];
                for r in op["from"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    if let Some(x) = self.find_memo(r).filter(|x| *x != id && !froms.contains(x) && Self::not_editable(self.entries.get(x)).is_empty()) {
                        froms.push(x);
                    }
                }
                if froms.is_empty() {
                    return done("same", "합칠 메모가 없어요 (이미 합쳤거나 없는 메모)");
                }
                let bodies: Vec<String> = froms.iter().map(|x| self.entries[x].body.clone()).collect();
                let (next, added) = merge_bodies(&body, &bodies);
                if added > 0 {
                    self.keep_version(&id, &body, true);
                    if let Err(e) = self.save(&id, &next) {
                        return done("fail", &e.to_string());
                    }
                }
                let mut err = None;
                for x in &froms {
                    if let Err(e) = self.trash(x) {
                        err = Some(e.to_string());
                    }
                }
                match err {
                    Some(e) => Err(e),
                    None => Ok(format!("{}개를 합치고 휴지통으로", froms.len())),
                }
            }
            _ => Err("모르는 요청이에요".into()),
        };
        match r {
            Ok(note) => done("ok", &note),
            Err(e) => done("fail", &e),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::ai_requests::parse_requests;
    use crate::vault::Vault;
    use serde_json::json;

    #[test]
    fn apply_requests_to_folder() {
        let root = std::env::temp_dir().join(format!("mk-ai-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        let mut v = Vault::new(&root, "pc");
        v.open().unwrap();
        let a = v.create(None, None, "");
        v.save(&a, "# OA 프롬프트\n\n본문 길게\n\n#ETRI #공유").unwrap();
        let b = v.create(None, None, "");
        v.save(&b, "# 덧붙일 메모\n둘째 글").unwrap();
        let ops = json!([
            { "do": "tag", "memo": "OA 프롬프트.md", "add": ["프롬프트"], "remove": ["ETRI", "공유"] },
            { "do": "color", "memo": a, "color": "blue" },
            { "do": "move", "memo": a, "folder": "프롬프트" },
            { "do": "merge", "into": a, "from": [b] },
            { "do": "create", "text": "# 새 메모\n본문", "folder": "할일" },
            { "do": "replace", "memo": a, "find": "없는 글", "with": "x" },
            { "do": "tag", "memo": "없는.md", "add": ["x"] },
        ]);
        let (ops, _) = parse_requests(&format!("```json\n{ops}\n```"));
        let lines = v.apply_ai_ops(&ops);
        assert!(lines[..5].iter().all(|l| l.starts_with("- ✅")), "{lines:#?}");
        assert!(lines[5].starts_with("- ⚠️ 글 바꾸기 · OA 프롬프트 — 바꿀 글을 찾지"), "{}", lines[5]);
        assert!(lines[6].starts_with("- ⚠️ 태그 · 없는.md — 메모를 찾지"), "{}", lines[6]);
        let m = v.get(&a).unwrap();
        assert_eq!(m["color"], "blue");
        assert!(m["body"].as_str().unwrap().contains("#프롬프트") && !m["body"].as_str().unwrap().contains("#ETRI"));
        assert!(m["body"].as_str().unwrap().contains("둘째 글"));
        assert_eq!(v.entry(&a).unwrap().file.as_deref(), Some("프롬프트/OA 프롬프트.md"));
        assert!(v.entry(&b).is_none(), "합친 메모는 휴지통으로");
        assert!(!v.versions(&a).is_empty(), "고치기 전 글은 지난 버전으로");
        assert!(root.join("할일/새 메모.md").exists());
        // 다른 기기가 같은 요청을 또 반영해도: 이미 됨
        let again = v.apply_ai_ops(&ops[..5]);
        assert!(again.iter().all(|l| l.starts_with("- ➖")), "{again:#?}");
        std::fs::remove_dir_all(root).unwrap();
    }
}
