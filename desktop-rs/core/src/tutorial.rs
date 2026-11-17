//! 처음 실행 튜토리얼의 단계와 규칙 (app/js/core/tutorial.js — PC 단계 TUTORIAL_STEPS)
use serde_json::{json, Value};
use std::sync::OnceLock;

/// TUTORIAL_STEPS · TUTORIAL_EVENTS — 말풍선 글을 손으로 옮기지 않고 parity/gen.mjs 가 JS 에서 뽑아 둔 것을 쓴다 (JS 가 바뀌면 CI 가 알린다)
pub fn steps() -> &'static [Value] {
    static S: OnceLock<Vec<Value>> = OnceLock::new();
    S.get_or_init(|| serde_json::from_str(include_str!("../tests/fixtures/tutorial_steps.json")).unwrap())
}

pub fn events() -> &'static [Value] {
    static S: OnceLock<Vec<Value>> = OnceLock::new();
    S.get_or_init(|| serde_json::from_str(include_str!("../tests/fixtures/tutorial_events.json")).unwrap())
}

fn step(index: i64) -> Option<&'static Value> {
    usize::try_from(index).ok().and_then(|i| steps().get(i))
}

/// tutorialStepFor: 필요한 기능(needs)이 꺼져 있으면 직접 해 보기 없이 안내(offText)만 하고 "다음"으로
pub fn step_for(step: &Value, has: impl Fn(&str) -> bool) -> Value {
    let mut s = step.as_object().cloned().unwrap_or_default();
    let needs = step["needs"].as_str().filter(|n| !n.is_empty());
    if needs.is_none_or(&has) {
        s.shift_remove("enable"); // 켜져 있으면 켜기 단추는 없다
        return Value::Object(s);
    }
    for k in ["advance", "try", "offText", "enable"] {
        s.shift_remove(k);
    }
    s.insert("text".into(), if step["offText"].is_null() { step["text"].clone() } else { step["offText"].clone() });
    s.insert("next".into(), "다음".into());
    if step["enable"].as_str().is_some_and(|e| !e.is_empty()) {
        s.insert("enable".into(), json!({ "need": needs, "label": step["enable"] }));
    }
    Value::Object(s)
}

/// tutorialChapter: 지금 단계의 묶음 이름 · 묶음 안에서 몇 번째(at) · 묶음의 단계 수(of)
pub fn chapter(index: i64) -> Value {
    let Some(name) = step(index).and_then(|s| s["chapter"].as_str().filter(|n| !n.is_empty())) else { return Value::Null };
    let same: Vec<usize> = steps().iter().enumerate().filter(|(_, s)| s["chapter"] == name).map(|(i, _)| i).collect();
    let at = same.iter().position(|&i| i as i64 == index).map_or(0, |p| p + 1);
    json!({ "name": name, "at": at, "of": same.len() })
}

/// tutorialJumps: 다시 볼 때 어디부터 볼지 — 목록 화면에서 시작하는 묶음의 첫 단계만
pub fn jumps() -> Value {
    let s = steps();
    let mut out: Vec<Value> = vec![];
    for (i, st) in s.iter().enumerate() {
        let Some(name) = st["chapter"].as_str().filter(|n| !n.is_empty()) else { continue };
        if name == "시작" || name == "마무리" || out.iter().any(|j| j["name"] == name) || (i > 0 && s[i - 1]["chapter"] == name) {
            continue;
        }
        // 바로 다음 묶음은 "시작할게요"와 같다
        if st["win"] == "list" && i > 1 {
            out.push(json!({ "name": name, "index": i }));
        }
    }
    Value::Array(out)
}

/// advanceTutorial: 사용자가 한 일로 몇 번째 단계가 되는지 (끝나면 -1)
///   'next': 다음 · 'skip': 끝 · 'note-closed': 메모 단계 중에 메모 창이 닫히면 목록 단계로 · 그 밖: 지금 단계의 advance 와 같을 때만 다음
pub fn advance(index: i64, event: &str) -> i64 {
    let Some(st) = step(index) else { return -1 };
    if event == "skip" {
        return -1;
    }
    let next = if event == "next" || st["advance"] == event {
        index + 1
    } else if event == "note-closed" && st["win"] == "note" {
        steps().iter().enumerate().position(|(i, s)| i as i64 > index && s["win"] != "note").map_or(-1, |i| i as i64)
    } else {
        index
    };
    if next < 0 || next as usize >= steps().len() {
        -1
    } else {
        next
    }
}
