// AI 비서 연결 (MCP 서버) — Claude 데스크톱 같은 AI 비서가 메모킹 메모를 찾고, 읽고, 새로 남기게 한다. Electron 의 desktop/mcp-server.js 자리.
//   AI 비서가 이 실행 파일을 띄우고 표준 입출력으로 JSON-RPC 를 한 줄씩 주고받는다 (도구 다섯 개라 SDK 없이).
//   메모 폴더는 메모킹 설정 파일(--settings)에서 매번 읽는다 (설정에서 폴더를 바꿔도 다시 연결할 필요 없게).
//   쓰기(새 메모 · 덧붙이기)는 설정의 "AI 가 메모를 쓰도록 허용" 이 켜져 있을 때만. 잠근 메모는 내용을 보여 주지 않는다.
//   이 프로세스는 읽고 쓰기만 — 색인 · 첨부 치우기 · 폴더 지켜보기는 켜져 있는 메모킹 앱이 맡는다.
use memoking_core::body::{extract_tags, has_lock_marker, is_locked_body};
use memoking_core::js;
use memoking_core::vault::Vault;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

const INSTRUCTIONS: &str = concat!(
    "메모킹(MemoKing) 사용자의 메모(마크다운)를 찾고 읽고 남기는 도구입니다. 먼저 search_memos로 찾고 read_memo로 읽으세요. ",
    "새로 남길 때는 첫 줄을 \"# 제목\" 으로 쓰면 그 제목이 파일 이름이 됩니다. #태그 는 본문 어디에나 쓸 수 있습니다. ",
    "잠긴 메모(locked)는 내용을 볼 수 없습니다. ",
    "메모를 새로 만들거나 덧붙일 때는 반드시 create_memo · append_to_memo를 쓰세요 — Google Drive의 메모킹 폴더에 파일을 직접 만들거나 올리면 ",
    "메모킹(PC·휴대폰)은 자기가 만든 파일만 볼 수 있어 그 메모가 보이지 않습니다."
);
const NO_WRITE: &str = "메모킹 설정에서 \"AI가 메모를 남기도록 허용\" 이 꺼져 있어요.";
const COLORS: [&str; 7] = ["yellow", "green", "pink", "purple", "blue", "gray", "charcoal"];

struct Server {
    settings: Option<PathBuf>,
    vault_arg: Option<String>,
    version: String,
    vault: Option<Vault>,
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn text(value: &Value) -> Value {
    let t = value.as_str().map_or_else(|| serde_json::to_string_pretty(value).unwrap(), str::to_string);
    json!({ "content": [{ "type": "text", "text": t }] })
}

fn fail(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }], "isError": true })
}

fn summary_of(m: &Value) -> Value {
    let locked = m["locked"] == true;
    let mut o = Map::new();
    o.insert("id".into(), m["id"].clone());
    o.insert("title".into(), m["title"].clone());
    o.insert("tags".into(), if locked { json!([]) } else { m["tags"].clone() });
    o.insert("updated".into(), m["updated"].clone());
    if m["pinned"] == true {
        o.insert("pinned".into(), true.into());
    }
    if locked {
        o.insert("locked".into(), true.into());
    }
    o.insert("preview".into(), if locked { "(잠긴 메모)".into() } else { m["preview"].clone() });
    if m["tasks"]["total"].as_u64().unwrap_or(0) > 0 {
        o.insert("tasks".into(), format!("{}/{} 끝냄", m["tasks"]["done"], m["tasks"]["total"]).into());
    }
    o.into()
}

enum Found {
    One(Value),
    Ambiguous(Vec<Value>),
    None,
}

/// id 또는 제목으로 메모 찾기. exact: 고치는 도구(덧붙이기)는 id · 제목이 딱 맞을 때만 — 비슷한 말이 든 엉뚱한 메모를 고치지 않게
fn find_memo(v: &Vault, reference: &str, exact: bool) -> Found {
    let key = js::trim(reference);
    if key.is_empty() {
        return Found::None;
    }
    if let Some(m) = v.get(key).filter(|m| !m["file"].is_null()) {
        return Found::One(m);
    }
    let all = v.list();
    let mut same: Vec<Value> = all.iter().filter(|m| m["title"] == key).cloned().collect();
    if same.is_empty() {
        same = all.iter().filter(|m| m["title"].as_str().is_some_and(|t| t.to_lowercase() == key.to_lowercase())).cloned().collect();
    }
    // 고치는 도구는 제목이 같은 메모가 여럿이면 고르지 않는다 (엉뚱한 쪽에 덧붙이지 않게 — id 로 다시)
    if exact && same.len() > 1 {
        return Found::Ambiguous(same);
    }
    let pick = match same.first() {
        Some(m) => Some(m.clone()),
        None if exact => None,
        None => v.search(key, None).into_iter().next(),
    };
    pick.and_then(|m| v.get(m["id"].as_str()?)).map_or(Found::None, Found::One)
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

impl Server {
    fn settings(&self) -> Option<Value> {
        let text = std::fs::read_to_string(self.settings.as_ref()?).ok()?;
        serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)
    }

    // 쓰기는 설정의 "AI 가 메모를 남기도록 허용"(기본 켜짐)을 따른다 — 설정 파일을 읽지 못하면 막는다
    fn can_write(&self) -> bool {
        self.settings().is_some_and(|s| s["mcp"]["write"] != false)
    }

    /// 지금 메모 폴더 (설정에서 바뀌었으면 새로 연다)
    fn vault(&mut self) -> Result<&mut Vault, String> {
        let root = self.vault_arg.clone().or_else(|| self.settings().and_then(|s| s["vaultPath"].as_str().map(str::to_string)));
        let Some(root) = root.map(PathBuf::from).filter(|r| r.exists()) else {
            // 폴더를 옮겼거나 외장 · 네트워크 드라이브가 빠졌다 — 연결은 그대로 두고, 폴더가 돌아오면 다시 연다
            self.vault = None;
            return Err("메모킹 메모 폴더를 찾지 못했어요. 메모 폴더를 옮겼거나 드라이브가 빠졌다면 메모킹에서 폴더를 다시 정해 주세요.".into());
        };
        if self.vault.as_ref().is_some_and(|v| v.root == root) {
            let v = self.vault.as_mut().unwrap();
            v.scan();
            return Ok(v);
        }
        let mut v = Vault::new(&root, "ai");
        v.open().map_err(|e| e.to_string())?;
        Ok(self.vault.insert(v))
    }

    fn search(&mut self, a: &Value) -> Result<Value, String> {
        let query = js::trim(s(&a["query"])).to_string();
        let limit = a["limit"].as_u64().unwrap_or(10) as usize;
        let v = self.vault()?;
        let mut list = if query.is_empty() { v.list() } else { v.search(&query, None) };
        if let Some(tag) = a["tag"].as_str() {
            let want = tag.strip_prefix('#').unwrap_or(tag).to_lowercase();
            list.retain(|m| m["tags"].as_array().is_some_and(|t| t.iter().any(|t| s(t).to_lowercase() == want)));
        }
        let shown: Vec<Value> = list.iter().take(limit).map(summary_of).collect();
        Ok(text(&json!({ "total": list.len(), "memos": shown })))
    }

    fn read(&mut self, a: &Value) -> Result<Value, String> {
        let memo = s(&a["memo"]).to_string();
        let v = self.vault()?;
        let Found::One(m) = find_memo(v, &memo, false) else { return Ok(fail(format!("\"{memo}\" 메모를 찾지 못했어요. search_memos로 먼저 찾아 주세요."))) };
        // 제목 · id 가 딱 맞지 않아 찾기로 고른 메모면 그렇다고 알린다 (다른 메모를 그 메모로 오해하지 않게)
        let key = js::trim(&memo);
        let exact_hit = m["id"] == key || s(&m["title"]).to_lowercase() == key.to_lowercase();
        if is_locked_body(s(&m["body"])) {
            return Ok(fail(format!("\"{}\" 은(는) 잠긴 메모라 내용을 볼 수 없어요.", s(&m["title"]))));
        }
        let now = chrono::Local::now();
        let reminders: Vec<Value> = m["reminders"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r["enabled"] == true && !memoking_core::reminders::is_past_event(r, now))
            .map(|r| {
                let next = memoking_core::reminders::next_time(r, now).map(|t| t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                // shortcut: 사람이 읽는 알림 설명(describeReminder)은 core 에 아직 없다 — 알림 옮기기에서 core 로 오면 채운다
                json!({ "when": null, "next": next })
            })
            .collect();
        let mut o = Map::new();
        if !exact_hit {
            o.insert("note".into(), format!("\"{memo}\" 와(과) 제목이 같은 메모가 없어 가장 비슷한 메모를 읽었어요: \"{}\"", s(&m["title"])).into());
        }
        for k in ["id", "title", "file", "updated"] {
            o.insert(k.into(), m[k].clone());
        }
        o.insert("tags".into(), json!(extract_tags(s(&m["body"]))));
        o.insert("reminders".into(), reminders.into());
        o.insert("content".into(), m["body"].clone());
        Ok(text(&o.into()))
    }

    fn tags(&mut self) -> Result<Value, String> {
        let v = self.vault()?;
        let mut counts: Vec<(String, u64)> = Vec::new();
        for m in v.list() {
            for t in m["tags"].as_array().into_iter().flatten().map(s) {
                match counts.iter_mut().find(|c| c.0 == t) {
                    Some(c) => c.1 += 1,
                    None => counts.push((t.to_string(), 1)),
                }
            }
        }
        counts.sort_by_key(|c| std::cmp::Reverse(c.1));
        Ok(text(&counts.into_iter().map(|(tag, memos)| json!({ "tag": tag, "memos": memos })).collect()))
    }

    fn create(&mut self, a: &Value) -> Result<Value, String> {
        if !self.can_write() {
            return Ok(fail(NO_WRITE));
        }
        let content = js::trim(s(&a["content"])).to_string();
        if content.is_empty() {
            return Ok(fail("메모 내용이 비어 있어요. content에 남길 글을 넣어 주세요."));
        }
        if is_locked_body(s(&a["content"])) || has_lock_marker(&content) {
            return Ok(fail("잠금 정보가 든 글은 남길 수 없어요 (아무도 열 수 없는 메모가 될 수 있어요)."));
        }
        let v = self.vault()?;
        let id = v.create(a["color"].as_str(), None, "");
        let (saved, _) = v.save(&id, &format!("{content}\n")).map_err(|e| e.to_string())?;
        if saved["refused"] == true {
            return Ok(fail("메모를 남기지 못했어요. 잠시 뒤 다시 해 주세요."));
        }
        v.finalize(&id).map_err(|e| e.to_string())?;
        let Some(m) = v.get(&id) else { return Ok(fail("메모를 남기지 못했어요.")) };
        Ok(text(&json!({ "ok": true, "id": id, "title": m["title"], "file": m["file"] })))
    }

    fn append(&mut self, a: &Value) -> Result<Value, String> {
        if !self.can_write() {
            return Ok(fail(NO_WRITE));
        }
        let (memo, content) = (s(&a["memo"]).to_string(), s(&a["content"]).to_string());
        let v = self.vault()?;
        let m = match find_memo(v, &memo, true) {
            Found::One(m) => m,
            Found::Ambiguous(all) => {
                let list: Vec<String> = all.iter().map(|x| format!("{} (id: {}, {})", s(&x["title"]), s(&x["id"]), s(&x["updated"]))).collect();
                return Ok(fail(format!("제목이 \"{memo}\" 인 메모가 {}개예요: {} — 덧붙일 메모의 id로 다시 불러 주세요.", all.len(), list.join(", "))));
            }
            Found::None => {
                let near: Vec<String> = v.search(js::trim(&memo), None).iter().take(5).map(|m| format!("{} (id: {})", s(&m["title"]), s(&m["id"]))).collect();
                let hint = if near.is_empty() { " search_memos로 먼저 찾아 주세요.".to_string() } else { format!(" 비슷한 메모: {} — 맞는 것의 id 로 다시 불러 주세요.", near.join(", ")) };
                return Ok(fail(format!("\"{memo}\" 와(과) 제목이 같은 메모가 없어요.{hint}")));
            }
        };
        let (id, title) = (s(&m["id"]).to_string(), s(&m["title"]).to_string());
        if is_locked_body(s(&m["body"])) {
            return Ok(fail(format!("\"{title}\" 은(는) 잠긴 메모라 덧붙일 수 없어요.")));
        }
        let add = js::trim(&content).to_string();
        if add.is_empty() {
            return Ok(fail("덧붙일 내용이 비어 있어요."));
        }
        if has_lock_marker(&content) {
            return Ok(fail("잠금 정보가 든 글은 덧붙일 수 없어요."));
        }
        // 목록 끝에 목록을 덧붙이면 한 목록으로 이어지게 (빈 줄 없이)
        let item = js::re(r"^\s*(?:[-*+]|\d+[.)])\s");
        let is_item = |line: &str| item.is_match(line).unwrap_or(false);
        let appended = |body: &str| {
            let before = js::trim_end(body);
            let gap = if is_item(before.rsplit('\n').next().unwrap_or("")) && is_item(add.split('\n').next().unwrap_or("")) { "\n" } else { "\n\n" };
            if before.is_empty() {
                format!("{add}\n") // 빈 메모면 앞에 빈 줄 없이
            } else {
                format!("{before}{gap}{add}\n")
            }
        };
        let (mut saved, _) = v.save(&id, &appended(s(&m["body"]))).map_err(|e| e.to_string())?;
        if saved["retry"] == true {
            v.scan(); // 파일이 잠깐 없었다 (동기화로 이름이 바뀌는 중 등) — 다시 읽고 한 번 더, 같은 id 로만
            saved = match v.get(&id) {
                None => json!({ "refused": true, "retry": true }),
                Some(again) if is_locked_body(s(&again["body"])) => json!({ "refused": true }),
                Some(again) => v.save(&id, &appended(s(&again["body"]))).map_err(|e| e.to_string())?.0,
            };
        }
        if saved["refused"] == true {
            return Ok(fail(if saved["retry"] == true {
                format!("\"{title}\" 메모 파일이 보이지 않아 덧붙이지 못했어요 (삭제됐거나 동기화 중일 수 있어요). 잠시 뒤 다시 해 주세요.")
            } else {
                format!("\"{title}\" 은(는) 방금 다른 기기에서 잠겨 덧붙이지 못했어요.")
            }));
        }
        Ok(text(&json!({ "ok": true, "id": id, "title": title })))
    }

    fn call(&mut self, name: &str, a: &Value) -> Option<Value> {
        if let Err(e) = check(name, a)? {
            return Some(fail(format!("입력이 올바르지 않아요: {e}")));
        }
        let r = match name {
            "search_memos" => self.search(a),
            "read_memo" => self.read(a),
            "list_tags" => self.tags(),
            "create_memo" => self.create(a),
            _ => self.append(a),
        };
        Some(r.unwrap_or_else(fail))
    }

    fn reply(&mut self, msg: &Value) -> Option<Value> {
        let id = msg.get("id")?.clone(); // 알림(notifications/*)은 답하지 않는다
        let p = &msg["params"];
        let result = match s(&msg["method"]) {
            "initialize" => {
                let asked = s(&p["protocolVersion"]);
                let version = if ["2025-06-18", "2025-03-26", "2024-11-05"].contains(&asked) { asked } else { "2025-06-18" };
                json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": "memoking", "version": self.version }, "instructions": INSTRUCTIONS })
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": tools() }),
            "tools/call" => match self.call(s(&p["name"]), p.get("arguments").unwrap_or(&json!({}))) {
                Some(r) => r,
                None => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": format!("Tool {} not found", s(&p["name"])) } })),
            },
            m => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {m}") } })),
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }
}

/// AI 비서가 보낸 입력 검사 (도구 설명의 inputSchema 대로) — 모르는 도구면 None
fn check(name: &str, a: &Value) -> Option<Result<(), String>> {
    let opt_str = |k: &str| if a[k].is_null() || a[k].is_string() { Ok(()) } else { Err(format!("{k} 는 글이어야 해요")) };
    let need_str = |k: &str| if a[k].as_str().is_some_and(|t| !t.is_empty()) { Ok(()) } else { Err(format!("{k} 가 필요해요")) };
    let r = match name {
        _ if !a.is_object() => Err("arguments 는 객체여야 해요".into()),
        "search_memos" => opt_str("query").and(opt_str("tag")).and(match &a["limit"] {
            Value::Null => Ok(()),
            l if l.as_u64().is_some_and(|n| (1..=50).contains(&n)) => Ok(()),
            _ => Err("limit 는 1~50 의 정수예요".into()),
        }),
        "read_memo" => a["memo"].as_str().map(|_| ()).ok_or_else(|| "memo 가 필요해요".into()),
        "list_tags" => Ok(()),
        "create_memo" => need_str("content").and(match a["color"].as_str() {
            _ if a["color"].is_null() => Ok(()),
            Some(c) if COLORS.contains(&c) => Ok(()),
            _ => Err(format!("color 는 {} 가운데 하나예요", COLORS.join(", "))),
        }),
        "append_to_memo" => a["memo"].as_str().map(|_| ()).ok_or_else(|| "memo 가 필요해요".to_string()).and(need_str("content")),
        _ => return None,
    };
    Some(r)
}

fn tools() -> Value {
    let read_only = json!({ "readOnlyHint": true });
    let writes = json!({ "readOnlyHint": false, "destructiveHint": false });
    let schema = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false });
    json!([
        {
            "name": "search_memos", "title": "메모 찾기",
            "description": "메모킹 메모를 찾습니다. query를 비우면 최근에 고친 메모부터. 제목·본문·#태그·초성(ㅈㅂㄱ)으로 찾을 수 있습니다.",
            "inputSchema": schema(json!({
                "query": { "type": "string", "description": "찾을 말 (비우면 최근 메모)" },
                "tag": { "type": "string", "description": "이 태그가 있는 메모만 (# 없이)" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
            }), &[]),
            "annotations": read_only,
        },
        {
            "name": "read_memo", "title": "메모 읽기",
            "description": "메모 한 개의 전체 내용(마크다운)을 읽습니다. memo 에는 id 또는 제목을 넣으세요.",
            "inputSchema": schema(json!({ "memo": { "type": "string", "description": "메모 id 또는 제목" } }), &["memo"]),
            "annotations": read_only,
        },
        {
            "name": "list_tags", "title": "태그 목록",
            "description": "메모에 쓰인 #태그 와 메모 수 (많이 쓴 순).",
            "inputSchema": schema(json!({}), &[]),
            "annotations": read_only,
        },
        {
            "name": "create_memo", "title": "새 메모 남기기",
            "description": "새 메모를 만듭니다 (PC·휴대폰 메모킹에 함께 보임). 메모킹 메모는 반드시 이 도구로 만드세요 — Google Drive 메모킹 폴더에 파일을 직접 만들면 메모킹에 보이지 않습니다. content는 마크다운 — 첫 줄을 \"# 제목\" 으로 쓰세요. 체크리스트는 \"- [ ] 할 일\".",
            "inputSchema": schema(json!({
                "content": { "type": "string", "minLength": 1, "description": "메모 내용 (마크다운)" },
                "color": { "type": "string", "enum": COLORS, "description": "메모 색 (기본 노랑)" },
            }), &["content"]),
            "annotations": writes,
        },
        {
            "name": "append_to_memo", "title": "메모에 덧붙이기",
            "description": "이미 있는 메모의 끝에 내용을 덧붙입니다 (삭제하거나 고치지 않음). memo 에는 id 또는 정확한 제목 (모르면 search_memos로 먼저 찾기).",
            "inputSchema": schema(json!({
                "memo": { "type": "string", "description": "메모 id 또는 제목" },
                "content": { "type": "string", "minLength": 1, "description": "덧붙일 마크다운" },
            }), &["memo", "content"]),
            "annotations": writes,
        },
    ])
}

fn main() {
    let mut server = Server { settings: arg("--settings").map(PathBuf::from), vault_arg: arg("--vault"), version: arg("--version").unwrap_or("1".into()), vault: None };
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if js::trim(&line).is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => server.reply(&msg),
            Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })),
        };
        if let Some(a) = answer {
            // 어떤 실패도 AI 비서와의 연결을 끊지 않게 — 쓰지 못하면 연결이 끊긴 것
            if writeln!(out, "{a}").and_then(|()| out.flush()).is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(server: &mut Server, name: &str, args: Value) -> Value {
        let r = server.reply(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } })).unwrap();
        r["result"].clone()
    }

    #[test]
    fn tools_round_trip() {
        let dir = std::env::temp_dir().join(format!("memoking-mcp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("vault")).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings, json!({ "vaultPath": dir.join("vault") }).to_string()).unwrap();
        let mut server = Server { settings: Some(settings.clone()), vault_arg: None, version: "1".into(), vault: None };
        let init = server.reply(&json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(server.reply(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        assert_eq!(server.reply(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap()["result"]["tools"].as_array().unwrap().len(), 5);

        let made = call(&mut server, "create_memo", json!({ "content": "# 장보기\n\n- 우유 #집" }));
        assert!(made["isError"].is_null(), "{made}");
        let added = call(&mut server, "append_to_memo", json!({ "memo": "장보기", "content": "- 빵" }));
        assert!(added["isError"].is_null(), "{added}");
        let read = call(&mut server, "read_memo", json!({ "memo": "장보기" }));
        let body: Value = serde_json::from_str(read["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["content"], "# 장보기\n\n- 우유 #집\n- 빵\n");
        assert_eq!(body["tags"], json!(["집"]));
        let found = call(&mut server, "search_memos", json!({ "tag": "#집" }));
        assert!(found["content"][0]["text"].as_str().unwrap().contains("\"total\": 1"));
        // 입력 검사 · 잠금 글 · 쓰기 막기
        assert_eq!(call(&mut server, "search_memos", json!({ "limit": 0 }))["isError"], true);
        assert_eq!(call(&mut server, "create_memo", json!({ "content": "x <!-- memoking-lock v1 -->" }))["isError"], true);
        assert_eq!(call(&mut server, "append_to_memo", json!({ "memo": "없는 메모", "content": "x" }))["isError"], true);
        std::fs::write(&settings, json!({ "vaultPath": dir.join("vault"), "mcp": { "write": false } }).to_string()).unwrap();
        assert_eq!(call(&mut server, "create_memo", json!({ "content": "새 글" }))["content"][0]["text"], NO_WRITE);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
