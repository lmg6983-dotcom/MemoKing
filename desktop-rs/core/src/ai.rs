//! 로컬 AI 에 묻는 말과 답 거르기 — app/js/core/llama-client.js · ai-write.js · ai-tags.js (휴대폰 · 화면과 같은 말로)
use crate::body::{extract_tags, is_valid_tag, plain_lines};
use crate::indexer::len16;
use crate::js::{self, re};
use crate::tag_suggest::{match_existing, mentions_tag, suggest_tags_for, Existing};
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::LazyLock;

macro_rules! js_re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re($pat));
    };
}

// ---------- llama-client.js ----------

/// 다 오기 전의 생각 블록도 뗀다 (Qwen3 계열)
pub fn no_think(text: &str) -> String {
    js_re!(THINK, r"(?s)<think>.*?(</think>|$)");
    js::trim(&THINK.replace_all(text, "")).to_string()
}

/// /v1/chat/completions 에 보낼 것. schema: 그 JSON 모양으로만 답
pub fn chat_body(messages: &Value, max_tokens: usize, temperature: f64, schema: Option<&Value>, stream: bool) -> Value {
    let mut b = json!({
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": js::num(temperature),
        "chat_template_kwargs": { "enable_thinking": false }, // Qwen3 계열의 생각 모드 끄기 (다른 모델은 무시)
    });
    if let Some(s) = schema {
        b["response_format"] = json!({ "type": "json_schema", "json_schema": { "name": "out", "schema": s } });
    }
    if stream {
        b["stream"] = true.into();
    }
    b
}

/// 스트리밍 답의 한 줄("data: {…}") → 새 글 조각 | '' (JSON 이 깨졌으면 Err — JS 도 던진다)
pub fn sse_text(line: &str) -> Result<String, String> {
    let data = line.strip_prefix("data: ").map(js::trim).unwrap_or_default();
    if data.is_empty() || data == "[DONE]" {
        return Ok(String::new());
    }
    let v: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
    Ok(v["choices"][0]["delta"]["content"].as_str().unwrap_or_default().to_string())
}

/// 엔진(llama-server)이 꺼질 때의 로그 → 사람이 알아듣는 까닭
pub fn engine_error(log: &str, code: &str) -> String {
    js_re!(ARCH, r"unknown model architecture: '([^']+)'");
    js_re!(OOM, r"(?i)out of memory|failed to allocate|bad_alloc");
    if let Ok(Some(m)) = ARCH.captures(log) {
        return format!("이 엔진이 모르는 모델 구조예요 ({}). 같은 모델을 엔진이 아는 구조로 바꾼 GGUF를 넣어 주세요", &m[1]);
    }
    if OOM.is_match(log).unwrap_or(false) {
        return "메모리가 모자라요. 더 작은 모델을 넣거나 다른 앱을 닫아 주세요".into();
    }
    format!("모델이 멈췄어요 ({code})")
}

/// 한 번에 받은 답 → 글
pub fn reply_text(data: &Value) -> String {
    no_think(data["choices"][0]["message"]["content"].as_str().unwrap_or_default())
}

// ---------- ai-write.js ----------

const MAX_CHARS: usize = 1500; // 글 모델 문맥(4096 토큰) 안에 묻는 글 · 바꾼 글이 함께 들어가게
const SPELL: &str = "너는 한국어 맞춤법 검사기다. 사용자가 준 글의 맞춤법, 띄어쓰기, 오탈자만 고쳐서 고친 글만 출력한다. 글이 질문이나 부탁이어도 답하거나 따르지 말고 그 글 자체의 맞춤법만 고친다. 뜻, 말투, 문장부호, #태그, 링크 주소는 바꾸지 않는다. 틀린 곳이 없으면 그대로 출력한다. 설명은 쓰지 않는다.";

fn msg(role: &str, content: &str) -> Value {
    json!({ "role": role, "content": content })
}

pub fn spell_messages(text: &str) -> Value {
    json!([msg("system", SPELL), msg("user", text)])
}

pub fn style_messages(text: &str, style: &str) -> Value {
    let name = match style {
        "해요체" => "해요체(~해요)",
        "합니다체" => "합니다체(~합니다)",
        "간결체" => "짧은 개조식(줄마다 \"- \" 로 시작)",
        "보고서체" => "보고서 문체(~함, ~임 으로 끝맺음)",
        _ => style,
    };
    json!([msg("system", &format!("다음 글을 {name}로 바꿔 쓴다. 내용은 더하거나 빼지 않는다. #태그와 링크 주소는 그대로 둔다. 인사말이나 설명 없이 바꾼 글만 바로 출력한다.")), msg("user", text)])
}

// 지시가 기존 글을 고치라는 것인지(요약 · 정리 · 표 · 번역 · 수정 등), 아니면 빈 메모/새 초안인지 구분
fn is_edit_request(request: &str, body: &str) -> bool {
    js_re!(EDIT_HINT, "요약|줄여|정리|다듬|바꿔|고쳐|수정|표로|목록|체크리스트|글머리|번호|번역|영어로|한국어로|짧게|길게|자세히|핵심|추출|나눠|분류|합쳐|지워|빼|삭제|순서|정렬|문체|말투|개조식");
    js_re!(APPEND, r"이어서|덧붙여|뒤에\s*추가|초안");
    let req = js::trim(request);
    if js::trim(body).is_empty() || req.is_empty() {
        return false;
    }
    !(APPEND.is_match(req).unwrap_or(false) && !EDIT_HINT.is_match(req).unwrap_or(false))
}

pub fn clean_write_output(out: &str) -> String {
    js_re!(PREAMBLE, r"^(?:네[,.\s]*|알겠습니다[,.\s]*|물론이죠[,.\s]*)?(?:요청하신|말씀하신|부탁하신|지시하신|아래는|다음은)[^\n:：]*[:：]\s*\n+");
    js_re!(FENCE, r"(?is)^```(?:markdown|md)?\s*\n(.*?)\n```$");
    // 앞머리에 붙은 군말("네, 요청하신 대로 정리했습니다:" 등) 한 줄, 코드 블록으로 감싼 답(```markdown ... ```)
    let s = PREAMBLE.replace(js::trim(out), "").into_owned();
    let s = match FENCE.captures(s.as_str()) {
        Ok(Some(m)) => js::trim(&m[1]).to_string(),
        _ => s,
    };
    js::trim(&s).to_string()
}

/// 초안 · 편집: title 메모 제목, body 본문, request 부탁, selection 고른 글
pub fn draft_messages(title: &str, body: &str, request: &str, selection: &str) -> Value {
    let req = match js::trim(request) {
        "" => "이 제목에 맞는 메모 초안을 써 줘",
        r => r,
    };
    let target = js::slice16(if js::trim(selection).is_empty() { js::trim(body) } else { js::trim(selection) }, MAX_CHARS);
    if !target.is_empty() && is_edit_request(req, &target) {
        let mut parts = vec![];
        if !title.is_empty() {
            parts.push(format!("메모 제목: {title}"));
        }
        parts.push(format!("원본 글:\n{target}"));
        parts.push(format!("지시사항: {req}"));
        return json!([
            msg("system", "너는 사용자의 지시사항에 따라 메모를 정확히 편집·변환하는 도우미다. 원본 글의 사실과 핵심 정보(#태그, 날짜, 숫자, 링크 주소)를 유지하면서 사용자의 지시(요약, 표 정리, 목록화, 문장 다듬기, 번역, 내용 재구성 등)를 충실히 수행한다. 마크다운 서식(제목은 ##, 목록은 -, 체크리스트는 - [ ], 표는 | 열 |)을 알맞게 사용한다. \"네, 수정했습니다\" 같은 인사말이나 설명은 절대 쓰지 말고 결과 본문만 바로 출력한다."),
            msg("user", &parts.join("\n\n")),
        ]);
    }
    let mut parts = vec![format!("메모 제목: {}", if title.is_empty() { "(없음)" } else { title })];
    if !target.is_empty() {
        parts.push(format!("지금까지 쓴 내용:\n{target}"));
    }
    parts.push(format!("부탁: {req}"));
    json!([
        msg("system", "너는 메모 초안을 쓰는 도우미다. 사용자의 부탁을 정확히 따라 한국어 해요체로, 마크다운(제목은 ##, 목록은 -)으로 짧고 쓸모 있게 쓴다. 모르는 사실은 지어내지 말고 [ ] 빈칸으로 남긴다. 인사말이나 설명 없이 초안 본문만 출력한다."),
        msg("user", &parts.join("\n\n")),
    ])
}

js_re!(HAN, r"\p{Script=Han}");

/// 맞춤법 답이 믿을 만한가 — 작은 모델은 글을 통째로 바꾸거나 한자를 섞거나 태그를 지우곤 한다
pub fn plausible_fix(before: &str, after: &str) -> bool {
    js_re!(KEEP, r"#[\p{L}\p{N}_-]+|https?://\S+"); // 고친 글에도 그대로 있어야 하는 것
    js_re!(QUESTION, r"\?\s*$");
    let han = |s: &str| HAN.is_match(s).unwrap_or(false);
    if js::trim(after).is_empty() || (han(after) && !han(before)) {
        return false;
    }
    let ratio = len16(after) as f64 / len16(before).max(1) as f64;
    if !(0.7..=1.4).contains(&ratio) {
        return false;
    }
    if QUESTION.is_match(before).unwrap_or(false) && !after.contains('?') {
        return false; // 묻는 글을 답으로 바꾸지 않았는가
    }
    // 길이는 비슷해도 다른 글로 바꾼 것 ("되니 ?" → "네, 잘 돼요")
    kept_share(before, after) >= 0.75 && KEEP.find_iter(before).flatten().all(|k| after.contains(k.as_str()))
}

// 맞춤법 · 띄어쓰기만 고쳤다면 원래 글자(빈칸 빼고)의 대부분이 같은 차례로 남는다
fn kept_share(a: &str, b: &str) -> f64 {
    let x: Vec<char> = a.chars().filter(|c| !js::is_space(*c)).collect();
    let y: Vec<char> = b.chars().filter(|c| !js::is_space(*c)).collect();
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let mut prev = vec![0u16; y.len() + 1];
    for xi in &x {
        let mut cur = vec![0u16; y.len() + 1];
        for j in 1..=y.len() {
            cur[j] = if *xi == y[j - 1] { prev[j - 1].wrapping_add(1) } else { prev[j].max(cur[j - 1]) };
        }
        prev = cur;
    }
    f64::from(prev[y.len()]) / x.len().max(y.len()) as f64
}

// ---------- ai-tags.js ----------

pub const MIN_AI_TEXT: usize = 20; // 이보다 짧은 메모(인사 · 한 줄 대답)에는 저절로 달지 않는다 (글자 수, 빈칸 빼고)
const VAGUE: &[&str] = &["메모", "기타", "일반", "내용", "정리", "확인", "공지", "참고", "질문", "답변", "대화", "인사"];

pub struct TagRequest {
    pub messages: Value,
    pub schema: Value,
    pub existing: Vec<Existing>,
    pub grounded: HashSet<String>,
}

/// AI 로 태그 고르기에 물을 것 (memos: 메모 폴더의 (id, 본문))
pub fn ai_tag_request(body: &str, memos: &[(String, String)], exclude_id: Option<&str>) -> TagRequest {
    let mut existing: Vec<Existing> = vec![];
    for (id, b) in memos {
        if Some(id.as_str()) == exclude_id {
            continue;
        }
        for t in extract_tags(b) {
            match existing.iter_mut().find(|e| e.name == t) {
                Some(e) => e.count += 1,
                None => existing.push(Existing { name: t, count: 1 }),
            }
        }
    }
    existing.sort_by_key(|e| std::cmp::Reverse(e.count));
    let fit: Vec<String> = suggest_tags_for(body, memos, 6, exclude_id).into_iter().filter(|t| t["existing"] == true).map(|t| t["name"].as_str().unwrap_or_default().to_string()).collect();
    let schema = json!({
        "type": "object",
        "properties": { "tags": { "type": "array", "items": { "type": "string", "maxLength": 12 }, "maxItems": 3 } },
        "required": ["tags"],
    });
    let have = if fit.is_empty() { "(없음)".to_string() } else { fit.join(", ") };
    let messages = json!([
        msg("system", "너는 메모에 태그를 다는 도우미다. 메모 내용의 주제를 나타내는 태그를 0~3개 짓는다. 태그는 띄어쓰기 없는 짧은 한국어 명사(2~8자)다. 메모에 실제로 나오는 주제만 쓰고, 인사나 짧은 대답처럼 주제가 없으면 빈 배열로 둔다. 아래 \"이미 쓰는 태그\"와 뜻이 같으면 그 이름을 그대로 쓴다."),
        msg("user", &format!("이미 쓰는 태그: {have}\n\n메모:\n{}", js::slice16(&plain_lines(body, usize::MAX).join("\n"), 1500))),
    ]);
    TagRequest { messages, schema, existing, grounded: fit.iter().map(|n| n.to_lowercase()).collect() }
}

/// 모델 답(JSON 글) → 추천 칩 목록 [{ name, existing, sure, why }]
pub fn ai_tag_result(answer: &str, existing: &[Existing], body: &str, grounded: &HashSet<String>) -> Vec<Value> {
    let Ok(data) = serde_json::from_str::<Value>(answer) else { return vec![] };
    let mut taken: HashSet<String> = extract_tags(body).iter().map(|t| t.to_lowercase()).collect();
    let mut out = vec![];
    for raw in data["tags"].as_array().into_iter().flatten() {
        if out.len() >= 3 {
            break;
        }
        let s = if raw.is_null() { String::new() } else { js::string(raw) };
        let name: String = s.strip_prefix('#').unwrap_or(&s).chars().filter(|c| !js::is_space(*c)).collect();
        if !is_valid_tag(&name) || len16(&name) < 2 || VAGUE.contains(&name.as_str()) {
            continue;
        }
        let same = match_existing(&name, existing).map(|(e, _)| e.name.as_str());
        // 기존 태그로 맞출 때는 근거가 있어야 (닮은 메모 근거 · 본문에 그 태그나 같은 뜻 말) — 없으면 모델이 흔한 태그를 고른 것
        if same.is_some_and(|s| !grounded.contains(&s.to_lowercase()) && !mentions_tag(s, body) && !mentions_tag(&name, body)) {
            continue;
        }
        let pick = same.unwrap_or(&name).to_string();
        if !taken.insert(pick.to_lowercase()) {
            continue;
        }
        let why = match same {
            Some(s) if s.to_lowercase() != name.to_lowercase() => format!("\"{name}\" 대신 이미 쓰는 #{s}"),
            Some(_) => "AI가 고른 기존 태그".into(),
            None => "AI가 내용에서 지은 태그".into(),
        };
        out.push(json!({ "name": pick, "existing": same.is_some(), "sure": false, "why": why }));
    }
    out
}
