// 다른 캘린더(구글 · 네이버 · 휴대폰)의 색 → 가장 가까운 메모 색 — 달력 · 일정 목록이 메모 색 한 벌로 보이게
//   색상(hue) 위주로 견준다 (OKLab 의 a · b). 거의 무채색이면 회색
/** 메모 색 고르기의 점 색 (base.css --ok-paper-*-chip, 밝은 화면) — 다른 캘린더 색 고르기도 이 색들 */
export const MEMO_DOT = { yellow: '#ccb034', green: '#68ca80', pink: '#f589b6', purple: '#bf9bfc', blue: '#61b9ff', gray: '#b8b0a3' };

function oklab(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** "#rrggbb" → 가장 가까운 메모 색 이름 (못 읽으면 blue) */
export function nearestMemoColor(hex) {
  if (!/^#?[0-9a-f]{6}$/i.test(String(hex ?? ''))) return 'blue';
  const [, a, b] = oklab(hex);
  if (Math.hypot(a, b) < 0.04) return 'gray';
  const hue = Math.atan2(b, a);
  let best = 'blue';
  let bestD = Infinity;
  for (const [name, dot] of Object.entries(MEMO_DOT)) {
    if (name === 'gray') continue;
    const [, da, db] = oklab(dot);
    const d = Math.abs(Math.atan2(Math.sin(hue - Math.atan2(db, da)), Math.cos(hue - Math.atan2(db, da))));
    if (d < bestD) [best, bestD] = [name, d];
  }
  return best;
}
