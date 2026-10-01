// 화면 그림에서 "선택 강조색" 영역 찾기 (순수 함수, 단위 테스트 대상)
// UI 자동화로 선택 위치를 읽을 수 없는 앱(카카오톡 등)에서 쓴다: 사용자가 마지막으로 끈(드래그) 시작·끝 점 근처의
// 강조색(파랑 바탕 등)을 알아내고, 그 색이 칠해진 줄들을 위아래로 이어 찾아 감싸는 사각형을 돌려준다.
// 픽셀은 4바이트(BGRA·RGBA 상관없음 — 색끼리 견주기만 한다).

const Q = 4; // 색을 이만큼 뭉뚱그려 센다 (비트)
const key = (d, o) => ((d[o] >> Q) << 8) | ((d[o + 1] >> Q) << 4) | (d[o + 2] >> Q);
const near = (d, o, c, tol) => Math.abs(d[o] - c[0]) <= tol && Math.abs(d[o + 1] - c[1]) <= tol && Math.abs(d[o + 2] - c[2]) <= tol;

// 사각형 안에서 가장 많은 색들 (뭉뚱그린 색 → { n, 평균 색 })
function colorsIn(img, x0, y0, x1, y1) {
  const map = new Map();
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const o = (y * img.width + x) * 4;
      const k = key(img.data, o);
      const e = map.get(k) ?? { n: 0, s: [0, 0, 0] };
      e.n++;
      e.s[0] += img.data[o];
      e.s[1] += img.data[o + 1];
      e.s[2] += img.data[o + 2];
      map.set(k, e);
    }
  }
  return map;
}

/**
 * @param {{ width: number, height: number, data: Uint8Array }} img 화면(또는 창) 그림
 * @param {{ x: number, y: number }} a 끈 시작점 (그림 좌표)
 * @param {{ x: number, y: number }} b 끈 끝점
 * @param {{ within?: { x: number, y: number, width: number, height: number } }} options within = 찾을 범위(앞 창), 없으면 그림 전체
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function findHighlightBox(img, a, b, { tol = 22, reach = 80, patch = 14, within = null } = {}) {
  const W0 = Math.max(0, Math.floor(within?.x ?? 0));
  const W1 = Math.min(img.width, Math.ceil(within ? within.x + within.width : img.width));
  const H0 = Math.max(0, Math.floor(within?.y ?? 0));
  const H1 = Math.min(img.height, Math.ceil(within ? within.y + within.height : img.height));
  // 읽는 순서로 앞·뒤 (위쪽이 앞, 같은 줄이면 왼쪽이 앞)
  const [s, e] = a.y < b.y - 6 || (Math.abs(a.y - b.y) <= 6 && a.x <= b.x) ? [a, b] : [b, a];
  const sx = Math.round(s.x);
  const sy = Math.round(s.y);
  const ex = Math.round(e.x);
  const ey = Math.round(e.y);
  // 선택은 시작점의 오른쪽, 끝점의 왼쪽에 칠해진다
  const ps = colorsIn(img, sx + 2, sy - patch / 2, sx + 2 + patch, sy + patch / 2);
  const pe = colorsIn(img, ex - 2 - patch, ey - patch / 2, ex - 2, ey + patch / 2);
  // 두 곳에 함께 많은 색 = 강조색 후보
  let best = null;
  for (const [k, v] of ps) {
    const w = pe.get(k);
    if (!w) continue;
    const score = Math.min(v.n, w.n);
    if (!best || score > best.score) best = { score, color: [0, 1, 2].map((i) => (v.s[i] + w.s[i]) / (v.n + w.n)) };
  }
  if (!best || best.score < patch * 2) return null;
  const color = best.color;
  // 선택 바깥(위·아래로 떨어진 곳)도 이 색이면 강조가 아니라 그냥 바탕색 → 찾지 못함
  const outside = (y) => {
    const m = colorsIn(img, Math.min(sx, ex) - patch, y - 3, Math.max(sx, ex) + patch, y + 3);
    let n = 0;
    let all = 0;
    for (const v of m.values()) {
      all += v.n;
      const avg = v.s.map((x) => x / v.n);
      if (avg.every((x, i) => Math.abs(x - color[i]) <= tol)) n += v.n;
    }
    return all ? n / all : 0;
  };
  const top = Math.min(sy, ey);
  const bottom = Math.max(sy, ey);
  const probes = [top - reach, bottom + reach].filter((y) => y >= H0 + 3 && y < H1 - 3);
  if (probes.length && probes.every((y) => outside(y) > 0.6)) return null;

  // 끈 범위 위아래로 강조색 줄을 찾는다 (글 줄 사이 틈은 몇 줄까지 넘어간다)
  const rowHit = (y) => {
    let n = 0;
    let l = Infinity;
    let r = -Infinity;
    const o0 = y * img.width * 4;
    for (let x = W0; x < W1; x++) {
      if (near(img.data, o0 + x * 4, color, tol)) {
        n++;
        if (x < l) l = x;
        r = x;
      }
    }
    return n >= 4 ? { l, r } : null;
  };
  let y0 = null;
  let y1 = null;
  let x0 = Infinity;
  let x1 = -Infinity;
  const take = (y, h) => {
    y0 = y0 == null ? y : Math.min(y0, y);
    y1 = y1 == null ? y : Math.max(y1, y);
    x0 = Math.min(x0, h.l);
    x1 = Math.max(x1, h.r);
  };
  for (let y = Math.max(H0, top - 4); y <= Math.min(H1 - 1, bottom + 4); y++) {
    const h = rowHit(y);
    if (h) take(y, h);
  }
  if (y0 == null) return null;
  const GAP = 8;
  for (const dir of [-1, 1]) {
    let miss = 0;
    for (let y = dir < 0 ? y0 - 1 : y1 + 1; y >= H0 && y < H1 && miss <= GAP && Math.abs(y - (dir < 0 ? top : bottom)) <= reach; y += dir) {
      const h = rowHit(y);
      if (h) {
        take(y, h);
        miss = 0;
      } else miss++;
    }
  }
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
