//! JS 의 값 바꾸기 규칙 (Number(), String(), \s) — 옮긴 규칙이 JS 와 같은 답을 내게.
use serde_json::Value;

/// JS 정규식의 \s
pub fn is_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// Number(v)
pub fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => number_of_str(s),
        Value::Array(a) => match a.as_slice() {
            [] => 0.0,
            [one] if !one.is_array() && !one.is_object() => number_of_str(&string(one)),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

fn number_of_str(s: &str) -> f64 {
    let t = s.trim_matches(is_space);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r| u64::from_str_radix(p, r).map_or(f64::NAN, |v| v as f64);
    match t.get(..2).map(str::to_ascii_lowercase).as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    match t.trim_start_matches(['+', '-']) {
        "Infinity" => return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY },
        "inf" | "infinity" | "nan" | "NaN" => return f64::NAN, // Rust 는 읽지만 JS 는 못 읽는 것
        _ => {}
    }
    t.parse().unwrap_or(f64::NAN)
}

/// String(v)
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => crate::yaml::js_number(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS 숫자 → JSON 값 (정수면 정수로 — 3 과 3.0 이 다르게 견줘지지 않게)
pub fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
    }
}

/// Math.round (반은 +∞ 쪽으로)
pub fn round(f: f64) -> f64 {
    (f + 0.5).floor()
}

/// s.slice(0, n) — UTF-16 단위로 자른다 (JS 와 같은 길이)
pub fn slice16(s: &str, n: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= n
        })
        .collect()
}
