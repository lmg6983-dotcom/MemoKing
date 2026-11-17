//! 창 자리 계산 — desktop/placement.js (끌어 놓은 메모 창) · bubble-place.js (상태 말풍선) 를 옮긴 것.
//!   자리는 화면 논리 좌표 [x, y, width, height]. 같은 답인지는 tests/parity.rs placement
use serde_json::{json, Value};

pub type Rect = [f64; 4];

/// 커서가 메모 윗막대의 이 지점을 잡고 있는 것처럼 (placement.js GRAB)
const GRAB: (f64, f64) = (48.0, 18.0);
pub const DEFAULT_NOTE_SIZE: (f64, f64) = (340.0, 380.0);
pub const BUBBLE_SIZE: (f64, f64) = (360.0, 180.0);
pub const BAR_H: f64 = 36.0;
const GAP: f64 = 2.0;

pub fn is_inside((x, y): (f64, f64), [rx, ry, rw, rh]: Rect) -> bool {
    x >= rx && x < rx + rw && y >= ry && y < ry + rh
}

// placement.js clamp: 최대가 최소보다 작으면 최소
fn clamp_min(v: f64, min: f64, max: f64) -> f64 {
    v.max(min).min(max.max(min))
}

/// JS Math.round (반은 위로)
fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// 커서 자리 → 놓을 메모 창 자리 (작업 영역 밖으로 나가지 않게)
pub fn drop_bounds((px, py): (f64, f64), (w, h): (f64, f64), [ax, ay, aw, ah]: Rect) -> Rect {
    [round(clamp_min(px - GRAB.0, ax, ax + aw - w)), round(clamp_min(py - GRAB.1, ay, ay + ah - h)), w, h]
}

/// 상태 말풍선 창을 어디에 둘지 → { bounds, place, ax | ay, avoid? } (bubble-place.js placeBubble)
///   b: 메모 창, area: 그 화면의 작업 영역, anchor: 상태 줄 글이 시작하는 화면 x, sticker: 위 가장자리 스티커 창
pub fn place_bubble(b: Rect, area: Rect, anchor: f64, bar_h: f64, sticker: Option<Rect>) -> Value {
    let (w, h) = BUBBLE_SIZE;
    let [bx, by, bw, _] = b;
    let right = area[0] + area[2];
    let bottom = area[1] + area[3];
    let bar_mid = by + bar_h / 2.0;
    // bubble-place.js clamp 는 위 끝이 먼저 (아래 끝을 넘어도 위 끝 안)
    let clamp = |v: f64, lo: f64, hi: f64| lo.max(v.min(hi));
    let rect = |r: Rect| json!({ "x": r[0], "y": r[1], "width": r[2], "height": r[3] });
    if by - GAP - h >= area[1] {
        let x = round(clamp(anchor - 24.0, area[0], right - w));
        let avoid = sticker.map_or(Value::Null, |[sx, sy, sw, _]| json!({ "left": sx - x, "right": sx + sw - x, "rise": (by - sy).ceil() + GAP }));
        return json!({ "bounds": rect([x, by - GAP - h, w, h]), "place": "above", "ax": anchor - x + 10.0, "avoid": avoid });
    }
    let y = round(clamp(bar_mid - 30.0, area[1], bottom - h));
    let ay = bar_mid - y;
    if bx + bw + GAP + w <= right {
        return json!({ "bounds": rect([bx + bw + GAP, y, w, h]), "place": "right", "ay": ay });
    }
    if bx - GAP - w >= area[0] {
        return json!({ "bounds": rect([bx - GAP - w, y, w, h]), "place": "left", "ay": ay });
    }
    let x = round(clamp(anchor - 24.0, area[0], right - w));
    json!({ "bounds": rect([x, by, w, h]), "place": "over", "ax": anchor - x + 10.0 })
}
