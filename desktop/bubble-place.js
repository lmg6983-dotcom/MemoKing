// 상태 말풍선 창의 자리 (status-bubble-window.js) — electron 없이 계산만 (단위 테스트)
export const BUBBLE_SIZE = { width: 360, height: 180 }; // 투명한 곳은 보이지도 눌리지도 않는다
export const BAR_H = 36; // 메모 창 윗막대
const GAP = 2;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/**
 * 말풍선 창을 어디에 둘지 (순수 계산 — 단위 테스트)
 * @param {{ x: number, y: number, width: number, height: number }} b 메모 창 (화면 좌표)
 * @param {{ x: number, y: number, width: number, height: number }} area 그 화면의 작업 영역
 * @param {number} anchor 상태 줄 글이 시작하는 화면 x · @param {number} barH 윗막대 높이(확대 반영)
 * @param {{ x: number, y: number, width: number, height: number } | null} sticker 위 가장자리 스티커 창
 */
export function placeBubble(b, area, anchor, barH = BAR_H, sticker = null) {
  const { width: W, height: H } = BUBBLE_SIZE;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const barMid = b.y + barH / 2;
  if (b.y - GAP - H >= area.y) {
    const x = Math.round(clamp(anchor - 24, area.x, right - W));
    const y = b.y - GAP - H;
    // 스티커(창 위 가장자리에 반쯤 걸친)의 자리 — 말풍선은 그 왼쪽에 들어가거나, 안 되면 그 위로 올라간다
    const avoid = sticker ? { left: sticker.x - x, right: sticker.x + sticker.width - x, rise: Math.ceil(b.y - sticker.y) + GAP } : null;
    return { bounds: { x, y, width: W, height: H }, place: 'above', ax: anchor - x + 10, avoid };
  }
  const y = Math.round(clamp(barMid - 30, area.y, bottom - H));
  const ay = barMid - y;
  if (b.x + b.width + GAP + W <= right) return { bounds: { x: b.x + b.width + GAP, y, width: W, height: H }, place: 'right', ay };
  if (b.x - GAP - W >= area.x) return { bounds: { x: b.x - GAP - W, y, width: W, height: H }, place: 'left', ay };
  const x = Math.round(clamp(anchor - 24, area.x, right - W));
  return { bounds: { x, y: b.y, width: W, height: H }, place: 'over', ax: anchor - x + 10 };
}
