//! AI 요청 메모 (_memoking/AI 요청.md) — app/js/core/ai-requests.js 와 같은 규칙 (tests/parity.rs ai_requests)
//!   AI 비서는 큰 메모를 다시 쓰지 않고 메모킹이 만들어 둔 이 파일에 요청(json)만 적는다. 메모킹이 메모를 고치고 결과를 적는다
use crate::body::{extract_tags, is_valid_tag};
use crate::js::{self, re};
use crate::tag_suggest::append_tags;
use serde_json::{json, Map, Value};

pub const REQUESTS_FILE: &str = "_memoking/AI 요청.md";
pub const MAX_OPS: usize = 50;
pub const DOS: [&str; 8] = ["tag", "color", "move", "replace", "append", "merge", "trash", "create"];
const COLORS: [&str; 7] = ["yellow", "green", "pink", "purple", "blue", "gray", "charcoal"];

const GUIDE: &str = "# 메모킹 AI 요청

AI 비서(Gemini 등)는 메모를 직접 다시 쓰지 말고 이 파일만 고쳐 주세요. 아래 json 칸에 요청을 넣고 이 파일 전체를 다시 저장하면, 메모킹(PC · 휴대폰)이 메모를 고치고 이 파일에 결과를 적은 뒤 칸을 비워요.
메모 주소(memo)는 메모의 id 또는 메모 폴더 기준 파일 경로(\"업무/회의.md\")예요. 자세한 방법은 _memoking/README.md 에 있어요.

```json
[]
```
";

/// 요청 메모 → (요청들, 알릴 말) — 요청이 없으면 비어 있다
pub fn parse_requests(text: &str) -> (Vec<Value>, String) {
    let fence = re(r"(?s)```(?:json)?[ \t]*\r?\n(.*?)\r?\n?```");
    let Ok(Some(m)) = fence.captures(text) else { return (vec![], String::new()) };
    if js::trim(&m[1]).is_empty() {
        return (vec![], String::new());
    }
    let data: Value = match serde_json::from_str(&m[1]) {
        Ok(v) => v,
        Err(e) => return (vec![], format!("요청(json)을 읽지 못했어요: {e}")),
    };
    let list = match &data {
        Value::Array(a) => a.clone(),
        Value::Object(o) if o.get("ops").is_some_and(Value::is_array) => o["ops"].as_array().unwrap().clone(),
        _ => return (vec![], "요청은 [ ... ] 목록이어야 해요".into()),
    };
    let note = if list.len() > MAX_OPS { format!("한 번에 {MAX_OPS}개까지만 했어요") } else { String::new() };
    (list.iter().take(MAX_OPS).map(normalize_op).collect(), note)
}

fn s(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => js::string(other),
    }
}
fn first<'a>(o: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter().map(|k| &o[*k]).find(|v| !v.is_null()).unwrap_or(&Value::Null)
}
fn names(v: &Value) -> Vec<String> {
    let list = match v {
        Value::Array(a) => a.clone(),
        Value::Null => vec![],
        other => vec![other.clone()],
    };
    list.iter().map(|n| js::trim(&s(n)).trim_start_matches('#').to_string()).filter(|n| !n.is_empty()).collect()
}
fn lf(v: &Value) -> String {
    s(v).replace("\r\n", "\n")
}
fn folder(v: &Value) -> String {
    js::trim(&s(v)).trim_matches('/').to_string()
}

/// 요청 하나를 정리 — 모르는 요청은 { do, memo, error }
pub fn normalize_op(raw: &Value) -> Value {
    let empty = Value::Object(Map::new());
    let o = if raw.is_object() { raw } else { &empty };
    let what = js::trim(&s(first(o, &["do", "op"]))).to_lowercase();
    let memo = js::trim(&s(first(o, &["memo", "id", "file"]))).to_string();
    let err = |e: String| json!({ "do": what, "memo": memo, "error": e });
    match what.as_str() {
        "tag" => {
            let (add, remove) = (names(&o["add"]), names(&o["remove"]));
            if let Some(bad) = add.iter().chain(&remove).find(|n| !is_valid_tag(n)) {
                return err(format!("#{bad} 는 태그로 쓸 수 없어요"));
            }
            if add.is_empty() && remove.is_empty() {
                return err("더하거나 뺄 태그가 없어요".into());
            }
            json!({ "do": what, "memo": memo, "add": add, "remove": remove })
        }
        "color" => {
            let color = js::trim(&s(&o["color"])).to_lowercase();
            if COLORS.contains(&color.as_str()) { json!({ "do": what, "memo": memo, "color": color }) } else { err(format!("색은 {} 가운데 하나예요", COLORS.join(" · "))) }
        }
        "move" => json!({ "do": what, "memo": memo, "folder": folder(first(o, &["folder", "to"])) }),
        "replace" => {
            let find = lf(&o["find"]);
            if find.is_empty() {
                return err("바꿀 글(find)이 없어요".into());
            }
            json!({ "do": what, "memo": memo, "find": find, "with": lf(first(o, &["with", "replace"])) })
        }
        "append" => {
            let text = js::trim(&lf(&o["text"])).to_string();
            if text.is_empty() { err("덧붙일 글(text)이 없어요".into()) } else { json!({ "do": what, "memo": memo, "text": text }) }
        }
        "merge" => {
            let into = js::trim(&s(first(o, &["into", "memo"]))).to_string();
            let list = match &o["from"] {
                Value::Array(a) => a.clone(),
                other => vec![other.clone()],
            };
            let from: Vec<String> = list.iter().map(|x| js::trim(&s(x)).to_string()).filter(|x| !x.is_empty() && *x != into).collect();
            if into.is_empty() || from.is_empty() {
                return json!({ "do": what, "memo": into, "error": "합칠 메모(into · from)가 없어요" });
            }
            json!({ "do": what, "memo": into, "from": from })
        }
        "trash" => json!({ "do": what, "memo": memo }),
        "create" => {
            let text = js::trim(&lf(first(o, &["text", "body"]))).to_string();
            if text.is_empty() {
                return json!({ "do": what, "memo": "", "error": "새 메모의 글(text)이 없어요" });
            }
            let color = js::trim(&s(&o["color"])).to_lowercase();
            json!({ "do": what, "memo": "", "text": text, "folder": folder(&o["folder"]), "color": if COLORS.contains(&color.as_str()) { color } else { String::new() } })
        }
        _ => err(format!("모르는 요청이에요 ({}) — {}", if what.is_empty() { "빈 do" } else { &what }, DOS.join(" · "))),
    }
}

fn escape(s: &str) -> String {
    s.chars().map(|c| if ".*+?^${}()|[]\\".contains(c) { format!("\\{c}") } else { c.to_string() }).collect()
}

// 본문에서 #태그 를 뺀다 (코드 칸 밖, 뒤 띄어쓰기 하나와 함께). put 이 있으면 뺀 자리 하나에 — 태그만 있는 줄이 먼저
fn drop_tags(body: &str, drop: &[String], put: &str) -> (String, bool) {
    let res: Vec<_> = drop.iter().map(|n| re(&format!(r#"(?i)(^|[\s(\[{{,;:!?'"“‘>*_~])#{}(?![\p{{L}}\p{{N}}\p{{M}}_\-])([ \t]?)"#, escape(n)))).collect();
    let tag_only = re(r"^(\s*#[^\s#]+)+\s*$");
    let edge = re(r"^\s*(```|~~~)");
    let indented = re(r"^( {4}|\t)");
    let lines: Vec<&str> = body.split('\n').collect();
    let mut fence = false;
    let code: Vec<bool> = lines
        .iter()
        .map(|l| {
            let e = edge.is_match(l).unwrap_or(false);
            if e {
                fence = !fence;
            }
            e || fence || indented.is_match(l).unwrap_or(false)
        })
        .collect();
    let hits: Vec<usize> = (0..lines.len()).filter(|&i| !code[i] && res.iter().any(|r| r.is_match(lines[i]).unwrap_or(false))).collect();
    let target = if put.is_empty() { None } else { hits.iter().copied().find(|&i| tag_only.is_match(lines[i]).unwrap_or(false)).or(hits.first().copied()) };
    let mut out = vec![];
    for (i, line) in lines.iter().enumerate() {
        if !hits.contains(&i) {
            out.push(line.to_string());
            continue;
        }
        let mut placed = Some(i) != target;
        let mut next = line.to_string();
        for r in &res {
            next = r
                .replace_all(&next, |c: &fancy_regex::Captures<str>| {
                    if placed {
                        c[1].to_string()
                    } else {
                        placed = true;
                        format!("{}{put}{}", &c[1], &c[2])
                    }
                })
                .into_owned();
        }
        if !js::trim(&next).is_empty() {
            out.push(js::trim_end(&next).to_string()); // 태그만 있던 줄이 비면 줄째로 뺀다
        }
    }
    (out.join("\n"), target.is_some())
}

fn tidy_end(s: &str) -> String {
    format!("{}\n", js::trim_end(s))
}

/// 본문만 고치는 요청 (tag · replace · append) → (본문, "ok" | "same" | "fail", 알릴 말)
pub fn edit_body(body: &str, op: &Value) -> (String, &'static str, String) {
    let text = body.replace("\r\n", "\n");
    let key = |n: &str| n.to_lowercase();
    let list = |k: &str| op[k].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
    let tags = |l: &[String]| l.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(" ");
    match op["do"].as_str() {
        Some("tag") => {
            let have: std::collections::HashSet<String> = extract_tags(&text).iter().map(|n| key(n)).collect();
            let remove: Vec<String> = list("remove").into_iter().filter(|n| have.contains(&key(n))).collect();
            let all = list("add");
            let add: Vec<String> = all.iter().enumerate().filter(|(i, n)| !have.contains(&key(n)) && all.iter().position(|x| key(x) == key(n)) == Some(*i)).map(|(_, n)| n.clone()).collect();
            if remove.is_empty() && add.is_empty() {
                return (text, "same", "이미 그 태그예요".into());
            }
            let (mut next, mut placed) = (text.clone(), false);
            if !remove.is_empty() {
                (next, placed) = drop_tags(&text, &remove, &tags(&add));
            }
            if !add.is_empty() && !placed {
                next = append_tags(&next, &add);
            }
            let note = [(!add.is_empty()).then(|| format!("{} 더함", tags(&add))), (!remove.is_empty()).then(|| format!("{} 뺌", tags(&remove)))].into_iter().flatten().collect::<Vec<_>>().join(", ");
            (tidy_end(&next), "ok", note)
        }
        Some("replace") => {
            let (find, with) = (op["find"].as_str().unwrap_or(""), op["with"].as_str().unwrap_or(""));
            let count = text.matches(find).count();
            if count == 1 {
                return (text.replacen(find, with, 1), "ok", "글을 바꿈".into());
            }
            if count == 0 && !with.is_empty() && text.contains(with) {
                return (text, "same", "이미 바뀌어 있어요".into());
            }
            let note = if count > 0 { format!("바꿀 글이 {count}곳에 있어요 — 한 곳만 있게 더 길게 적어 주세요") } else { "바꿀 글을 찾지 못했어요".into() };
            (text, "fail", note)
        }
        Some("append") => {
            let add = op["text"].as_str().unwrap_or("");
            if text.contains(add) {
                return (text, "same", "이미 들어 있어요".into());
            }
            (format!("{}\n\n{add}\n", js::trim_end(&text)), "ok", "끝에 덧붙임".into())
        }
        _ => (text, "fail", "본문 요청이 아니에요".into()),
    }
}

/// 합치기: 받는 메모 끝에 다른 메모 글을 잇는다 — 이미 들어 있는 글은 다시 넣지 않는다 → (본문, 넣은 수)
pub fn merge_bodies(into: &str, froms: &[String]) -> (String, usize) {
    let mut text = js::trim_end(&into.replace("\r\n", "\n")).to_string();
    let mut added = 0;
    for b in froms {
        let b = b.replace("\r\n", "\n");
        let part = js::trim(&b);
        if part.is_empty() || text.contains(part) {
            continue;
        }
        text = format!("{text}\n\n---\n\n{part}");
        added += 1;
    }
    (format!("{text}\n"), added)
}

/// 결과 한 줄: "- ✅ 태그 · OA 프롬프트 — #프롬프트 더함"
pub fn result_line(op: &Value, title: &str, status: &str, note: &str) -> String {
    let icon = match status {
        "ok" => "✅",
        "same" => "➖",
        _ => "⚠️",
    };
    let what = match op["do"].as_str().unwrap_or("") {
        "tag" => "태그",
        "color" => "색",
        "move" => "옮기기",
        "replace" => "글 바꾸기",
        "append" => "덧붙이기",
        "merge" => "합치기",
        "trash" => "지우기",
        "create" => "새 메모",
        "" => "요청",
        other => other,
    };
    let who = if title.is_empty() { op["memo"].as_str().unwrap_or("") } else { title };
    format!("- {icon} {what}{}{}", if who.is_empty() { String::new() } else { format!(" · {who}") }, if note.is_empty() { String::new() } else { format!(" — {note}") })
}

/// 요청을 반영한 뒤 쓸 글 — 칸은 비우고 결과를 아래에
pub fn requests_text(lines: &[String], stamp: &str) -> String {
    if lines.is_empty() {
        return GUIDE.to_string();
    }
    format!("{GUIDE}\n## 지난 결과{}\n\n{}\n", if stamp.is_empty() { String::new() } else { format!(" ({stamp})") }, lines.join("\n"))
}
