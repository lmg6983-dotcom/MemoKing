//! 표 크기 · 모양 머리말 — app/js/core/table-sizes.js 의 normalizeTables
use crate::js;
use serde_json::{Map, Value};

const COL: (f64, f64) = (24.0, 2000.0);
const ROW: (f64, f64) = (20.0, 2000.0);

fn size_list(list: &Value, (min, max): (f64, f64), limit: usize) -> Option<Value> {
    let out: Vec<f64> = list
        .as_array()?
        .iter()
        .take(limit)
        .map(|v| {
            let n = js::round(js::number(v));
            if n.is_finite() && n > 0.0 { n.clamp(min, max) } else { 0.0 }
        })
        .collect();
    out.iter().any(|&v| v > 0.0).then(|| out.into_iter().map(js::num).collect())
}

fn normalize_table(raw: &Value) -> Map<String, Value> {
    let mut t = Map::new();
    let Some(raw) = raw.as_object() else { return t };
    let get = |k| raw.get(k).unwrap_or(&Value::Null);
    if let Some(c) = size_list(get("cols"), COL, 100) {
        t.insert("cols".into(), c);
    }
    if let Some(r) = size_list(get("rows"), ROW, 1000) {
        t.insert("rows".into(), r);
    }
    if get("accent") == &Value::Bool(true) {
        t.insert("accent".into(), Value::Bool(true));
    }
    if let Some(list) = get("merges").as_array() {
        let merges: Vec<Value> = list
            .iter()
            .take(500)
            .filter_map(|m| {
                let m: Vec<f64> = m.as_array()?.iter().take(4).map(|v| js::number(v).floor()).collect();
                let ok = m.len() == 4
                    && m.iter().all(|v| v.is_finite())
                    && m[0] >= 0.0
                    && m[1] >= 0.0
                    && m[2] >= 1.0
                    && m[3] >= 1.0
                    && (m[2] > 1.0 || m[3] > 1.0)
                    && m[2] <= 1000.0
                    && m[3] <= 100.0;
                ok.then(|| Value::Array(m.into_iter().map(js::num).collect()))
            })
            .collect();
        if !merges.is_empty() {
            t.insert("merges".into(), Value::Array(merges));
        }
    }
    t
}

/// 머리말 값 → 표 목록. 끝의 기본 모양 표는 뺀다 (모두 기본이면 [])
pub fn normalize_tables(raw: &Value) -> Vec<Value> {
    let Some(list) = raw.as_array() else { return vec![] };
    let mut out: Vec<Map<String, Value>> = list.iter().take(200).map(normalize_table).collect();
    while out.last().is_some_and(Map::is_empty) {
        out.pop();
    }
    out.into_iter().map(Value::Object).collect()
}
