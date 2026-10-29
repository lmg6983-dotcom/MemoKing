// 옮기기(끌어 놓기) 계산 — 화면 없이 쓰는 순수 함수 (block-move.js · list-drag.js · drag-frames.js 함께)

// ---------- 손가락 입력 보정 (터치) ----------
// 줄의 높이와 상관없이 손가락을 약 STEP_PX 만큼 움직이면 한 칸 — 큰 사진 앞뒤로도 조금만 움직이면 되게.
// 지나가는 칸마다 그 칸의 배율로: 큰 칸(사진·음성 카드)은 빨리, 짧은 글 줄은 손가락 그대로.
// 그래서 끄는 내용이 손가락보다 앞서 움직여 손가락에 가리지도 않는다. 마우스는 그대로(1배)
export const STEP_PX = 40;
export const MAX_GAIN = 2.6;
export const EASE_PX = 10; // 처음 이만큼은 1배 — 들어 올리는 순간의 작은 떨림이 배율만큼 커져 출렁이지 않게

/** 칸 하나의 배율: STEP_PX 이하의 낮은 칸은 1배, 높은 칸은 손가락 STEP_PX 로 지나가게 (최대 MAX_GAIN) */
export const slotGain = (h) => Math.min(MAX_GAIN, Math.max(1, h / STEP_PX));

/**
 * 손가락이 움직인 만큼(D) → 끄는 내용이 갈 위치 (문서 좌표). 줄들 밖으로는 1배.
 * @param {number} c0 시작 위치 @param {number} D 손가락 이동 (아래 +)
 * @param {number[]} tops 칸마다 시작 @param {number[]} slots 칸마다 높이 (이어져 있다: tops[i] + slots[i] = tops[i + 1])
 */
export function warpDrag(c0, D, tops, slots) {
  const dir = Math.sign(D);
  if (!dir) return c0;
  const ease = Math.min(Math.abs(D), EASE_PX);
  let c = c0 + dir * ease;
  let left = Math.abs(D) - ease;
  for (let guard = 0; left > 1e-6 && guard < tops.length + 2; guard++) {
    const i = tops.findIndex((t, k) => (dir > 0 ? c >= t && c < t + slots[k] : c > t && c <= t + slots[k]));
    if (i < 0) break;
    const g = slotGain(slots[i]);
    const edge = dir > 0 ? tops[i] + slots[i] : tops[i];
    const need = Math.abs(edge - c) / g; // 이 칸 끝까지 가는 데 드는 손가락
    if (left <= need) {
      c += dir * left * g;
      left = 0;
    } else {
      c = edge;
      left -= need;
    }
  }
  return c + dir * left;
}

// 놓을 자리가 바뀐 뒤 이만큼은 더 움직여야 다시 바뀐다 (경계에서 깜빡이지 않게)
export const HYSTERESIS_PX = 10;

// ---------- 틀 ----------
// 틀(들어 올린 것 · 맞바꿀 상대 · 넣을 자리)은 내용에서 FRAME_GAP 떨어진 FRAME_LINE 굵기의 선 — note.css 의 .mk-drag-frame 과 같게
export const FRAME_GAP = 4;
export const FRAME_LINE = 2;

/** rect 를 사방으로 by 만큼 넓힌 상자 */
export function inflate(r, by) {
  return { left: r.left - by, top: r.top - by, width: r.width + 2 * by, height: r.height + 2 * by, right: r.left + r.width + by, bottom: r.top + r.height + by };
}

const hits = (a, b) => a.x < b.right && a.x + a.w > b.left && a.y < b.bottom && a.y + a.h > b.top;

/**
 * 안내 캡슐 자리: 틀의 오른쪽 바깥(세로 가운데 → 위 끝 → 아래 끝)이 먼저, 자리가 없으면 틀 오른쪽 위 모서리에 걸쳐서.
 * 손가락(커서)이 가리는 자리는 몰래 건너뛴다 (터치는 손가락 아래쪽 손바닥까지 넉넉히). avoid(들고 있는 내용 등)도
 * 되도록 피하지만, 손가락을 피하는 것이 먼저다.
 * @param {{ frame: {left:number, top:number, right:number, bottom:number}, bw: number, bh: number,
 *   bounds: {left:number, top:number, right:number, bottom:number}, finger?: {x:number, y:number, r:number} | null,
 *   avoid?: {left:number, top:number, right:number, bottom:number}[] }} o
 * @returns {{ x: number, y: number, side: 'right'|'corner'|'above'|'below' }}
 */
export function placeBadge({ frame, bw, bh, bounds, finger = null, avoid = [] }) {
  const pad = 6;
  const midY = (frame.top + frame.bottom) / 2 - bh / 2;
  const all = [];
  if (frame.right + 8 + bw <= bounds.right - pad) {
    // 틀 오른쪽: 가운데 → 위 끝 → 아래 끝 (모두 틀을 가리키는 꼭지)
    for (const y of [midY, frame.top, frame.bottom - bh]) all.push({ x: frame.right + 8, y, side: 'right' });
  }
  all.push({ x: frame.right - bw - 12, y: frame.top - bh / 2, side: 'corner' });
  all.push({ x: frame.right - bw, y: frame.top - bh - 6, side: 'above' });
  all.push({ x: frame.right - bw, y: frame.bottom + 6, side: 'below' });
  const clamp = (c) => ({
    ...c,
    x: Math.round(Math.max(bounds.left + pad, Math.min(bounds.right - bw - pad, c.x))),
    y: Math.round(Math.max(bounds.top + pad, Math.min(bounds.bottom - bh - pad, c.y))),
  });
  const cands = all.map(clamp);
  const box = (c) => ({ x: c.x, y: c.y, w: bw, h: bh });
  const zone = finger && { left: finger.x - finger.r, right: finger.x + finger.r, top: finger.y - finger.r, bottom: finger.y + finger.r * 1.8 };
  const free = (c) => !zone || !hits(box(c), zone);
  return cands.find((c) => free(c) && !avoid.some((a) => hits(box(c), a))) ?? cands.find(free) ?? cands[0];
}

/**
 * 블록 이동 후(접힘 해제 뒤) 뷰포트 안에 들어오도록 최소 스크롤 보정량(dy)을 구한다.
 * 위로 이동(movedUp=true)할 때는 블록의 머리(top)가 보이도록 우선 보정하고,
 * 아래로 이동(movedUp=false)할 때는 블록의 꼬리(bottom)가 보이도록 우선 보정한다.
 * @param {{ top: number, bottom: number }} rect 이동된 블록의 화면 좌표
 * @param {{ top: number, bottom: number }} viewBox 스크롤 컨테이너의 화면 좌표
 * @param {boolean} movedUp 위로 이동 여부
 * @param {number} [pad=16] 위·아래 여백(px)
 */
export function dropScrollDelta(rect, viewBox, movedUp, pad = 16) {
  const hi = viewBox.top + pad;
  const lo = viewBox.bottom - pad;
  if (lo <= hi) return 0;
  if (movedUp) {
    if (rect.top < hi) return rect.top - hi;
    if (rect.bottom > lo) return Math.min(rect.bottom - lo, rect.top - hi);
    return 0;
  }
  if (rect.bottom > lo) return rect.bottom - lo;
  if (rect.top < hi) return Math.max(rect.top - hi, rect.bottom - lo);
  return 0;
}
