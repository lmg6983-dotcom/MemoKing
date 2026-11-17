//! 메모 스택 — 여러 메모를 한 창의 탭으로 묶는다. desktop/stacks.js (StackStore) 를 옮긴 것.
//!   메모 폴더 _memoking/stacks.json: { "version": 1, "stacks": [{ "id", "memos": [메모 id…], "active": 보이는 탭 }] }
//!   창은 다루지 않는다 (app 의 windows.rs 가 이 순서대로 창을 만든다). 같은 답인지는 tests/parity.rs stacks
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Stack {
    pub id: String,
    pub memos: Vec<String>,
    /// 빈 스택에서만 없다 (JS undefined — 쓸 때 빠진다)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
}

pub struct Stacks {
    pub stacks: Vec<Stack>,
    new_id: Box<dyn FnMut() -> String + Send>,
}

/// stacks.remove 의 답 — 남은 스택(하나만 남으면 풀려서 없음) · 보이게 될 탭 · 남은 탭들
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub stack: Option<Stack>,
    pub dissolved: bool,
    pub next_active: Option<String>,
    /// 스택에 없던 메모면 없음 (JS 도 빠진다)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rest: Option<Vec<String>>,
}

/// 새 스택 id (JS randomUUID().slice(0, 8))
pub fn random_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

impl Stacks {
    /// 파일 글에서 읽고, 없어진 메모 · 겹친 메모를 정리한다 (깨진 파일은 빈 스택)
    pub fn load(text: Option<&str>, exists: impl Fn(&str) -> bool, mut new_id: Box<dyn FnMut() -> String + Send>) -> Stacks {
        let data: Value = text.and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null);
        let mut seen = std::collections::HashSet::new();
        let stacks = data["stacks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| {
                let memos: Vec<String> = s["memos"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|id| exists(id) && seen.insert(id.to_string())).map(str::to_string).collect();
                // String(s.id || newId()) — 새 id 는 걸러질 스택에도 매긴다 (JS 와 같은 차례)
                let falsy = match &s["id"] {
                    Value::Null | Value::Bool(false) => true,
                    Value::String(x) => x.is_empty(),
                    Value::Number(n) => n.as_f64() == Some(0.0),
                    _ => false,
                };
                let id = if falsy { new_id() } else { crate::js::string(&s["id"]) };
                let active = s["active"].as_str().filter(|a| memos.iter().any(|m| m == a)).map(str::to_string).or_else(|| memos.first().cloned());
                Stack { id, memos, active }
            })
            .filter(|s| s.memos.len() >= 2)
            .collect();
        Stacks { stacks, new_id }
    }

    /// stacks.json 에 쓸 글 (JSON.stringify(…, null, 1))
    pub fn text(&self) -> String {
        let v = json!({ "version": 1, "stacks": self.stacks });
        let mut out = Vec::new();
        let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b" "));
        serde::Serialize::serialize(&v, &mut ser).unwrap();
        String::from_utf8(out).unwrap()
    }

    pub fn stack_of(&self, id: &str) -> Option<&Stack> {
        self.stacks.iter().find(|s| s.memos.iter().any(|m| m == id))
    }

    fn stack_of_mut(&mut self, id: &str) -> Option<&mut Stack> {
        self.stacks.iter_mut().find(|s| s.memos.iter().any(|m| m == id))
    }

    /// moving 메모들(과 그 스택 전체)을 target 의 스택으로. target 이 혼자면 새 스택.
    ///   옮겨 온 탭은 target 탭 바로 뒤에, activate(없으면 moving 첫째)가 보이는 탭
    pub fn merge(&mut self, target_id: &str, moving_ids: &[String], activate: Option<&str>) -> Option<Stack> {
        let activate = activate.map(str::to_string).or_else(|| moving_ids.first().cloned());
        let target_stack = self.stack_of(target_id).map(|s| s.id.clone());
        let mut moving: Vec<String> = Vec::new();
        for id in moving_ids {
            // 다른 스택이면 탭을 모두, 같은 스택 안이면 그 탭만
            let group = match self.stack_of(id) {
                Some(from) if Some(&from.id) != target_stack.as_ref() => from.memos.clone(),
                _ => vec![id.clone()],
            };
            for m in group {
                if m != target_id && !moving.contains(&m) {
                    moving.push(m);
                }
            }
        }
        for m in &moving {
            self.detach(m);
        }
        if self.stack_of(target_id).is_none() {
            self.detach(target_id);
            let id = (self.new_id)();
            self.stacks.push(Stack { id, memos: vec![target_id.into()], active: Some(target_id.into()) });
        }
        let target = self.stack_of_mut(target_id).unwrap();
        let at = target.memos.iter().position(|m| m == target_id).unwrap() + 1;
        target.memos.splice(at..at, moving);
        if let Some(a) = activate.filter(|a| target.memos.contains(a)) {
            target.active = Some(a);
        }
        self.cleanup();
        self.stack_of(target_id).cloned()
    }

    /// 보이는 탭 바로 뒤에 새 메모 (+ 단추)
    pub fn add_after(&mut self, existing: &str, new: &str) -> Stack {
        if self.stack_of(existing).is_none() {
            let id = (self.new_id)();
            self.stacks.push(Stack { id, memos: vec![existing.into()], active: Some(existing.into()) });
        }
        self.detach(new);
        let s = self.stack_of_mut(existing).unwrap();
        let at = s.memos.iter().position(|m| m == existing).unwrap() + 1;
        s.memos.insert(at, new.into());
        s.active = Some(new.into());
        s.clone()
    }

    /// 탭을 끌어 순서 바꾸기: id 를 index 번째로 (Number(index) 를 잘라서). 바뀌었으면 그 스택
    pub fn reorder(&mut self, id: &str, index: &Value) -> Option<Stack> {
        let s = self.stack_of_mut(id)?;
        let from = s.memos.iter().position(|m| m == id)?;
        // f64::min 은 NaN 을 버린다 — JS 의 Math.min 처럼 NaN 이면 그대로 실패
        let to = crate::js::number(index).trunc();
        let to = if to.is_nan() { to } else { to.min((s.memos.len() - 1) as f64).max(0.0) };
        if to.is_nan() || from == to as usize {
            return None;
        }
        let m = s.memos.remove(from);
        s.memos.insert(to as usize, m);
        Some(s.clone())
    }

    pub fn set_active(&mut self, id: &str) -> Option<Stack> {
        let s = self.stack_of_mut(id)?;
        s.active = Some(id.into());
        Some(s.clone())
    }

    /// 옆 탭 (dir 1 다음, -1 이전 — 끝에서 처음으로 돈다)
    pub fn neighbor(&self, id: &str, dir: i32) -> Option<String> {
        let s = self.stack_of(id)?;
        let n = s.memos.len() as i32;
        let i = s.memos.iter().position(|m| m == id)? as i32;
        Some(s.memos[((i + dir + n) % n) as usize].clone())
    }

    /// 스택에서 뺀다 — 보이던 탭이면 옆 탭이 보인다 (하나만 남으면 풀림)
    pub fn remove(&mut self, id: &str) -> Removed {
        let Some(s) = self.stack_of_mut(id) else { return Removed { stack: None, dissolved: false, next_active: None, rest: None } };
        let i = s.memos.iter().position(|m| m == id).unwrap();
        s.memos.remove(i);
        if s.active.as_deref() == Some(id) {
            s.active = s.memos.get(i.min(s.memos.len().saturating_sub(1))).cloned();
        }
        let (stack, dissolved) = (s.clone(), s.memos.len() < 2);
        self.cleanup();
        Removed { next_active: stack.active.clone(), rest: Some(stack.memos.clone()), dissolved, stack: (!dissolved).then_some(stack) }
    }

    fn detach(&mut self, id: &str) {
        for s in &mut self.stacks {
            let Some(i) = s.memos.iter().position(|m| m == id) else { continue };
            s.memos.remove(i);
            if s.active.as_deref() == Some(id) {
                s.active = s.memos.get(i.min(s.memos.len().saturating_sub(1))).cloned();
            }
        }
    }

    fn cleanup(&mut self) {
        self.stacks.retain(|s| s.memos.len() >= 2);
    }
}
