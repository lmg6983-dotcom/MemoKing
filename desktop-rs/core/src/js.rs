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

// JS 의 \s 글자들 (정규식 글자 묶음 안에 넣는 모양)
const SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// JS 정규식 → fancy_regex. \s \S \d \w 를 JS 뜻(\s 는 JS 빈칸 목록, \d \w 는 ASCII)으로 바꾼다
pub fn re(pattern: &str) -> fancy_regex::Regex {
    let mut out = String::new();
    let mut chars = pattern.chars();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let n = chars.next().expect("정규식이 \\ 로 끝남");
                let (inside, outside) = match n {
                    's' => (SPACE_CLASS.to_string(), format!("[{SPACE_CLASS}]")),
                    'S' => {
                        assert!(!in_class, "글자 묶음 안의 \\S 는 바꾸지 않는다");
                        (String::new(), format!("[^{SPACE_CLASS}]"))
                    }
                    'd' => ("0-9".into(), "[0-9]".into()),
                    'w' => ("A-Za-z0-9_".into(), "[A-Za-z0-9_]".into()),
                    _ => {
                        out.push('\\');
                        out.push(n);
                        continue;
                    }
                };
                out.push_str(if in_class { &inside } else { &outside });
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
                // "[]" 나 "[^]" 처음의 ] 는 글자 — JS 에서는 빈 묶음이지만 메모킹 규칙에는 없다
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    fancy_regex::Regex::new(&out).unwrap_or_else(|e| panic!("정규식 {pattern}: {e}"))
}

/// JS trim()
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// decodeURI — 틀린 %XX 가 있으면 None (JS 는 던진다). 예약 글자(;/?:@&=+$,#)는 풀지 않는다
pub fn decode_uri(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |i: usize| -> Option<u8> { u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok() };
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let first = hex(i)?;
        let len = match first {
            0x00..=0x7f => 1,
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return None,
        };
        if len == 1 {
            if b";/?:@&=+$,#".contains(&first) {
                out.extend_from_slice(&b[i..i + 3]);
            } else {
                out.push(first);
            }
            i += 3;
            continue;
        }
        let mut bytes = vec![first];
        for k in 1..len {
            let j = i + 3 * k;
            if b.get(j) != Some(&b'%') {
                return None;
            }
            bytes.push(hex(j)?);
        }
        std::str::from_utf8(&bytes).ok()?;
        out.extend_from_slice(&bytes);
        i += 3 * len;
    }
    String::from_utf8(out).ok()
}
