//! 업데이트 뒤 한 번 보여 줄 "개선된 점" — app/js/core/release-notes.js versionTitles
use crate::js::re;
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

static ROW: LazyLock<Regex> = LazyLock::new(|| re(r"^\| `v(\d+\.\d+\.\d+)` \|[^|]*\|[^|]*\| \*\*([^*]+)\*\*"));
static DEVICE_NOTE: LazyLock<Regex> = LazyLock::new(|| re(r"\s*\((?:휴대폰|PC)[^)]*\)\s*$"));

fn version(v: &str) -> Vec<u64> {
    v.split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

/// README 이력 표에서 from 다음부터 to 까지 버전마다 제목 한 줄 (새것부터 limit 개) → [{ version, title }]
pub fn version_titles(readme: &str, from: Option<&str>, to: &str, limit: usize) -> Vec<Value> {
    let mut out: Vec<(Vec<u64>, Value)> = vec![];
    for line in readme.split('\n') {
        let Some(m) = ROW.captures(line).ok().flatten() else { continue };
        let v = version(&m[1]);
        if v > version(to) || from.is_some_and(|f| v <= version(f)) {
            continue;
        }
        let title = DEVICE_NOTE.replace(&m[2], "");
        out.push((v, json!({ "version": &m[1], "title": crate::js::trim(&title) })));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().take(limit).map(|(_, t)| t).collect()
}
