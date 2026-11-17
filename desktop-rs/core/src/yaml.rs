//! 메모 머리말 YAML — app/vendor/yaml.js(yaml npm, YAML 1.2 core)와 같은 읽기 · 같은 글자로 쓰기.
//!   쓰기 규칙은 yaml npm 의 stringifyString(plain · 따옴표 · 블록)을 옮긴 것. lineWidth: 0 (접지 않음) 만.
//!   맞는지는 tests/parity.rs 가 JS 의 답(fixtures/yaml_stringify.json)과 견준다.
use fancy_regex::Regex;
use serde_json::{Map, Number, Value};
use std::sync::LazyLock;
use yaml_rust2::{Yaml, YamlLoader};

/// YAML 글 → JSON 값. 깨졌으면 Err (yaml npm 처럼 같은 키 두 번도 깨진 것으로)
pub fn parse(text: &str) -> Result<Value, String> {
    let docs = YamlLoader::load_from_str(text).map_err(|e| e.to_string())?;
    match docs.into_iter().next() {
        None => Ok(Value::Null),
        Some(doc) => to_json(doc),
    }
}

fn to_json(y: Yaml) -> Result<Value, String> {
    Ok(match y {
        Yaml::Null | Yaml::BadValue => Value::Null,
        Yaml::Boolean(b) => Value::Bool(b),
        Yaml::Integer(i) => Value::from(i),
        Yaml::Real(s) => real(&s),
        Yaml::String(s) => Value::String(s),
        Yaml::Array(a) => Value::Array(a.into_iter().map(to_json).collect::<Result<_, _>>()?),
        Yaml::Hash(h) => {
            let mut m = Map::new();
            for (k, v) in h {
                let key = match k {
                    Yaml::String(s) => s,
                    Yaml::Integer(i) => i.to_string(),
                    Yaml::Real(s) => number_text(&real(&s)),
                    Yaml::Boolean(b) => b.to_string(),
                    Yaml::Null => String::new(),
                    _ => return Err("머리말 키가 글자가 아니에요".into()),
                };
                if m.insert(key, to_json(v)?).is_some() {
                    return Err("Map keys must be unique".into());
                }
            }
            Value::Object(m)
        }
        Yaml::Alias(_) => return Err("별칭(alias)은 읽지 않아요".into()),
    })
}

fn real(s: &str) -> Value {
    let lower = s.to_ascii_lowercase();
    let f = match lower.trim_start_matches(['+', '-']) {
        ".inf" => f64::INFINITY * if lower.starts_with('-') { -1.0 } else { 1.0 },
        ".nan" => f64::NAN,
        _ => s.parse().unwrap_or(f64::NAN),
    };
    // JSON 에는 무한 · NaN 이 없다 — JS 의 JSON.stringify 처럼 null
    Number::from_f64(f).map_or(Value::Null, Value::Number)
}

fn number_text(v: &Value) -> String {
    match v {
        Value::Number(n) => js_number(n),
        _ => "null".into(),
    }
}

/// JS 의 String(number) 처럼: 1.0 → "1", 1.5 → "1.5"
pub fn js_number(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        format!("{f}")
    }
}

// ---------- 쓰기 ----------

/// 맨 위 객체 → 블록 YAML (끝에 줄바꿈 하나 — yaml npm stringify 와 같다)
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    match value {
        Value::Object(m) if !m.is_empty() => map(&mut out, m, ""),
        Value::Array(a) if !a.is_empty() => seq(&mut out, a, ""),
        other => {
            out.push_str(&scalar(other, "", false));
            out.push('\n');
        }
    }
    out
}

fn map(out: &mut String, m: &Map<String, Value>, indent: &str) {
    for (i, (k, v)) in m.iter().enumerate() {
        if i > 0 {
            out.push_str(indent);
        }
        out.push_str(&string(k, indent, true));
        out.push(':');
        value_after(out, v, indent, true);
    }
}

fn seq(out: &mut String, a: &[Value], indent: &str) {
    for (i, v) in a.iter().enumerate() {
        if i > 0 {
            out.push_str(indent);
        }
        out.push('-');
        value_after(out, v, indent, false);
    }
}

// "키:" 또는 "-" 다음에 오는 값. 줄은 줄바꿈으로 끝낸다
fn value_after(out: &mut String, v: &Value, indent: &str, in_map: bool) {
    let inner = format!("{indent}  ");
    match v {
        Value::Object(m) if !m.is_empty() => {
            if in_map {
                out.push('\n');
                out.push_str(&inner);
            } else {
                out.push(' ');
            }
            map(out, m, &inner);
        }
        Value::Array(a) if !a.is_empty() => {
            if in_map {
                out.push('\n');
                out.push_str(&inner);
            } else {
                out.push(' ');
            }
            seq(out, a, &inner);
        }
        _ => {
            out.push(' ');
            out.push_str(&scalar(v, &inner, false));
            out.push('\n');
        }
    }
}

fn scalar(v: &Value, indent: &str, implicit_key: bool) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n),
        Value::String(s) => string(s, indent, implicit_key),
        Value::Array(_) => "[]".into(),
        Value::Object(_) => "{}".into(),
    }
}

static CONTROL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]").unwrap());
// yaml npm plainString: plain 로 쓸 수 없는 모양
static NOT_PLAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^[\n\t ,\[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"#).unwrap()
});
static DOC_MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^(%|---|\.\.\.)").unwrap());
// YAML 1.2 core 가 글자가 아닌 것으로 읽는 모양 (null · bool · int · float)
static CORE_TYPED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE",
        r"|[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+",
        r"|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?",
        r"|[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$"
    ))
    .unwrap()
});

fn is(re: &Regex, s: &str) -> bool {
    re.is_match(s).unwrap_or(false)
}

fn string(s: &str, indent: &str, implicit_key: bool) -> String {
    if is(&CONTROL, s) || s.chars().any(|c| (0xD800..=0xDFFF).contains(&(c as u32))) {
        return double_quoted(s, indent, implicit_key);
    }
    if s.is_empty() {
        return quoted(s, indent, implicit_key);
    }
    if implicit_key && s.contains('\n') {
        return quoted(s, indent, implicit_key);
    }
    if is(&NOT_PLAIN, s) {
        return if implicit_key || !s.contains('\n') { quoted(s, indent, implicit_key) } else { block(s, indent) };
    }
    if !implicit_key && s.contains('\n') {
        return block(s, indent);
    }
    if is(&DOC_MARKER, s) && implicit_key && indent == "  " {
        return quoted(s, indent, implicit_key);
    }
    if is(&CORE_TYPED, s) {
        return quoted(s, indent, implicit_key);
    }
    s.to_string()
}

fn quoted(s: &str, indent: &str, implicit_key: bool) -> String {
    let (dq, sq) = (s.contains('"'), s.contains('\''));
    if dq && !sq {
        single_quoted(s, indent, implicit_key)
    } else {
        double_quoted(s, indent, implicit_key)
    }
}

fn single_quoted(s: &str, indent: &str, implicit_key: bool) -> String {
    static WS_NL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]\n|\n[ \t]").unwrap());
    if (implicit_key && s.contains('\n')) || (!implicit_key && is(&WS_NL, s)) {
        return double_quoted(s, indent, implicit_key);
    }
    let body = s.replace('\'', "''");
    format!("'{}'", newline_runs(&body, indent))
}

// 줄바꿈 묶음마다 줄바꿈 하나를 더하고 들여 쓴다 (yaml npm: value.replace(/\n+/g, `$&\n${indent}`))
fn newline_runs(s: &str, indent: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c == '\n' && chars.peek() != Some(&'\n') {
            out.push('\n');
            out.push_str(indent);
        }
    }
    out
}

fn double_quoted(s: &str, indent: &str, implicit_key: bool) -> String {
    // JSON.stringify 의 이스케이프 + YAML 의 짧은 이스케이프 (\0 \a \v \e \N \_ \L \P \xXX)
    let json: Vec<char> = serde_json::to_string(s).unwrap().chars().collect();
    let json_len = json.len();
    let mut out = String::new();
    let mut i = 0;
    while i < json_len {
        let c = json[i];
        if c == '\\' && i + 1 < json_len {
            match json[i + 1] {
                'u' => {
                    let code: String = json[i + 2..i + 6].iter().collect::<String>().to_ascii_lowercase();
                    out.push_str(match code.as_str() {
                        "0000" => "\\0",
                        "0007" => "\\a",
                        "000b" => "\\v",
                        "001b" => "\\e",
                        "0085" => "\\N",
                        "00a0" => "\\_",
                        "2028" => "\\L",
                        "2029" => "\\P",
                        _ => "",
                    });
                    if !matches!(code.as_str(), "0000" | "0007" | "000b" | "001b" | "0085" | "00a0" | "2028" | "2029") {
                        if let Some(rest) = code.strip_prefix("00") {
                            out.push_str("\\x");
                            out.push_str(&rest.to_ascii_uppercase());
                        } else {
                            out.extend(&json[i..i + 6]);
                        }
                    }
                    i += 6;
                    continue;
                }
                'n' if !(implicit_key || json.get(i + 2) == Some(&'"') || json_len < 40) => {
                    // 접힘이 첫 줄바꿈을 먹는다 — 빈 줄을 넣어 그대로 읽히게 (yaml npm doubleQuotedString)
                    out.push_str("\n\n");
                    i += 2;
                    while json.get(i) == Some(&'\\') && json.get(i + 1) == Some(&'n') && json.get(i + 2) != Some(&'"') {
                        out.push('\n');
                        i += 2;
                    }
                    out.push_str(indent);
                    if json.get(i) == Some(&' ') {
                        out.push('\\');
                    }
                    continue;
                }
                _ => {
                    out.push(c);
                    out.push(json[i + 1]);
                    i += 2;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn block(s: &str, indent: &str) -> String {
    static NL_WS_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[\t ]+$").unwrap());
    if is(&NL_WS_END, s) {
        return quoted(s, indent, false);
    }
    // 끝의 빈칸 · 줄바꿈 → 자르기(-) · 그대로(+) · 하나(없음)
    let end_start = s.trim_end_matches(['\n', '\t', ' ']).len();
    let mut end = s[end_start..].to_string();
    let chomp = match end.find('\n') {
        None => "-",
        Some(p) if end.len() == s.len() || p != end.len() - 1 => "+",
        Some(_) => "",
    };
    let mut value = &s[..end_start];
    if !end.is_empty() {
        if end.ends_with('\n') {
            end.pop();
        }
        // /\n+(?!\n|$)/g → 들여쓰기 붙이기 (끝의 줄바꿈 묶음은 그대로)
        let t = newline_indent(&end, indent);
        end = if end.ends_with('\n') { t[..t.len() - indent.len()].to_string() } else { t };
    }
    // 앞의 빈칸 · 빈 줄 → 들여쓰기 표시
    let mut start_with_space = false;
    let mut start_nl: Option<usize> = None;
    let mut start_end = 0;
    for (i, ch) in value.char_indices() {
        match ch {
            ' ' => start_with_space = true,
            '\n' => start_nl = Some(i),
            _ => break,
        }
        start_end = i + ch.len_utf8();
    }
    let start_len = match start_nl {
        Some(p) if p < start_end => p + 1,
        _ => start_end,
    };
    let start = newline_indent(&value[..start_len], indent);
    value = &value[start_len..];
    let header = format!("{}{chomp}", if start_with_space { if indent.is_empty() { "1" } else { "2" } } else { "" });
    format!("|{header}\n{indent}{start}{}{end}", newline_indent(value, indent))
}

// /\n+/g → `$&${indent}` (빈 줄은 들여 쓰지 않는다)
fn newline_indent(s: &str, indent: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c == '\n' && chars.peek() != Some(&'\n') {
            out.push_str(indent);
        }
    }
    out
}
