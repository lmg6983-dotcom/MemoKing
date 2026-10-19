// 왕관 · 테이프 스티커는 창 위 가장자리 가운데에 걸친 따로 뜬 창이라 그 아래 HTML(오른쪽 클릭 메뉴 · 공유 메뉴)을 가리고 클릭도 막는다
//   → 메뉴가 그 자리에 걸치면 스티커 바로 아래로 내려 띄운다 (window-manager.js 의 STICKERS 크기: 왕관 64×52 · 테이프 96×30, 창 가장자리에 반쯤 걸침)
const ZONES = { 'on-top': { half: 32, depth: 26 }, 'on-desktop': { half: 48, depth: 15 } };
const GAP = 4;

/** 메뉴 상자 { left, top, width, height } 가 스티커에 걸치면 겹치지 않는 top (아니면 그대로) */
export function clearOfSticker({ left, top, width }) {
  for (const [cls, z] of Object.entries(ZONES)) {
    if (!document.body.classList.contains(cls)) continue;
    const mid = window.innerWidth / 2;
    if (left < mid + z.half + GAP && left + width > mid - z.half - GAP && top < z.depth + GAP) return z.depth + GAP;
  }
  return top;
}
