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

/// 목록 창을 메모 창 옆으로 → 목록 창 자리 (x, y). 왼쪽에 들어가면 왼쪽, 아니면 오른쪽, 둘 다 모자라면 넓은 쪽에 화면 안으로
pub fn list_beside([nx, ny, nw, _]: Rect, (w, h): (f64, f64), [ax, ay, aw, ah]: Rect) -> (f64, f64) {
    const SIDE_GAP: f64 = 8.0;
    let (left, right) = (nx - ax, ax + aw - (nx + nw));
    let x = if left >= w + SIDE_GAP || (right < w + SIDE_GAP && left >= right) { nx - w - SIDE_GAP } else { nx + nw + SIDE_GAP };
    (round(clamp_min(x, ax, ax + aw - w)), round(clamp_min(ny, ay, ay + ah - h)))
}

/// 새 메모 창 자리 (Windows 스티커 메모처럼) — 연 창(anchor) 왼쪽 → 오른쪽 → 아래 → 위, 화면 안에 다 들어오고 다른 창(others)과 겹치지 않는 첫 자리.
///   그런 자리가 없으면 anchor 와만 안 겹치는 자리, 그것도 없으면 anchor 에서 비스듬히 비켜(다른 창과 왼쪽 위가 겹치지 않게).
///   anchor 가 없으면(알림 영역 · 단축키) 화면 가운데에서 비스듬히. size 는 화면보다 크면 줄인다
pub fn new_note_spot(anchor: Option<Rect>, (w, h): (f64, f64), [ax, ay, aw, ah]: Rect, others: &[Rect]) -> Rect {
    const SIDE_GAP: f64 = 12.0;
    const STEP: f64 = 32.0;
    let (w, h) = (w.min(aw), h.min(ah));
    let fits = |[x, y, ..]: Rect| x >= ax && y >= ay && x + w <= ax + aw && y + h <= ay + ah;
    let hits = |[x, y, ..]: Rect, o: &Rect| x < o[0] + o[2] && x + w > o[0] && y < o[1] + o[3] && y + h > o[1];
    let clamp_x = |x: f64| clamp_min(x, ax, ax + aw - w);
    let clamp_y = |y: f64| clamp_min(y, ay, ay + ah - h);
    let cascade = |sx: f64, sy: f64, first: f64| {
        (0..12)
            .map(|k| [clamp_x(sx + first + STEP * k as f64), clamp_y(sy + first + STEP * k as f64), w, h])
            .find(|r| !others.iter().any(|o| (o[0] - r[0]).abs() < 8.0 && (o[1] - r[1]).abs() < 8.0))
            .unwrap_or([clamp_x(sx + first), clamp_y(sy + first), w, h])
    };
    let Some(a @ [nx, ny, nw, nh]) = anchor else {
        return cascade(ax + (aw - w) / 2.0, ay + (ah - h) / 2.0, 0.0).map(round);
    };
    // 옆은 위 끝을 맞추고(화면 밖이면 위아래로 밀고), 아래 · 위는 왼쪽 끝을 맞춘다
    let spots = [[nx - w - SIDE_GAP, clamp_y(ny), w, h], [nx + nw + SIDE_GAP, clamp_y(ny), w, h], [clamp_x(nx), ny + nh + SIDE_GAP, w, h], [clamp_x(nx), ny - h - SIDE_GAP, w, h]];
    spots
        .into_iter()
        .find(|&r| fits(r) && !hits(r, &a) && !others.iter().any(|o| hits(r, o)))
        .or_else(|| spots.into_iter().find(|&r| fits(r) && !hits(r, &a)))
        .unwrap_or_else(|| cascade(nx, ny, STEP))
        .map(round)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_note_left_right_below() {
        let area = [0.0, 0.0, 1920.0, 1040.0];
        let size = (340.0, 380.0);
        let note = [800.0, 200.0, 340.0, 380.0];
        // 왼쪽에 자리가 있으면 왼쪽, 위 끝을 맞춰
        assert_eq!(new_note_spot(Some(note), size, area, &[]), [448.0, 200.0, 340.0, 380.0]);
        // 왼쪽에 다른 메모가 있으면 오른쪽
        assert_eq!(new_note_spot(Some(note), size, area, &[[400.0, 150.0, 340.0, 380.0]]), [1152.0, 200.0, 340.0, 380.0]);
        // 화면 왼쪽 끝 메모: 오른쪽
        assert_eq!(new_note_spot(Some([0.0, 200.0, 340.0, 380.0]), size, area, &[]), [352.0, 200.0, 340.0, 380.0]);
        // 양옆이 막히면 아래
        let wide = [100.0, 100.0, 1700.0, 380.0];
        assert_eq!(new_note_spot(Some(wide), size, area, &[]), [100.0, 492.0, 340.0, 380.0]);
        // 양옆 · 아래가 막히면 위
        let low = [100.0, 600.0, 1700.0, 380.0];
        assert_eq!(new_note_spot(Some(low), size, area, &[]), [100.0, 208.0, 340.0, 380.0]);
        // 화면 아래쪽 메모의 옆자리는 화면 안으로 올린다
        assert_eq!(new_note_spot(Some([800.0, 900.0, 340.0, 380.0]), size, area, &[]), [448.0, 660.0, 340.0, 380.0]);
        // 다른 메모로 사방이 막혀도 연 메모와는 안 겹치게 (왼쪽)
        let crowd = [[400.0, 150.0, 340.0, 380.0], [1150.0, 150.0, 340.0, 380.0], [800.0, 600.0, 340.0, 380.0]];
        assert_eq!(new_note_spot(Some(note), size, area, &crowd), [448.0, 200.0, 340.0, 380.0]);
        // 화면을 꽉 채운 메모: 비스듬히 비켜, 이미 그 자리에 있으면 한 칸 더
        let full = [0.0, 0.0, 1920.0, 1040.0];
        assert_eq!(new_note_spot(Some(full), size, area, &[]), [32.0, 32.0, 340.0, 380.0]);
        assert_eq!(new_note_spot(Some(full), size, area, &[[32.0, 32.0, 340.0, 380.0]]), [64.0, 64.0, 340.0, 380.0]);
        // 연 창이 없으면 가운데, 이미 있으면 비스듬히
        assert_eq!(new_note_spot(None, size, area, &[]), [790.0, 330.0, 340.0, 380.0]);
        assert_eq!(new_note_spot(None, size, area, &[[790.0, 330.0, 340.0, 380.0]]), [822.0, 362.0, 340.0, 380.0]);
        // 화면보다 큰 크기는 줄인다
        assert_eq!(new_note_spot(None, (3000.0, 380.0), area, &[]), [0.0, 330.0, 1920.0, 380.0]);
    }

    #[test]
    fn list_goes_left_then_right() {
        let area = [0.0, 0.0, 1920.0, 1040.0];
        // 왼쪽에 자리가 있으면 왼쪽
        assert_eq!(list_beside([1000.0, 100.0, 340.0, 380.0], (420.0, 640.0), area), (572.0, 100.0));
        // 왼쪽이 모자라면 오른쪽
        assert_eq!(list_beside([100.0, 100.0, 340.0, 380.0], (420.0, 640.0), area), (448.0, 100.0));
        // 둘 다 모자라면 넓은 쪽, 화면 안으로 (아래로도 넘치지 않게)
        assert_eq!(list_beside([300.0, 900.0, 1400.0, 380.0], (420.0, 640.0), [0.0, 0.0, 1920.0, 1040.0]), (0.0, 400.0));
    }
}
