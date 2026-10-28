// 손 메모 (순수 함수 — PC·휴대폰 함께, 단위 테스트 대상)
//   획 모양은 오픈소스 perfect-freehand (tldraw·Excalidraw 와 같은 엔진: 펜 압력·속도로 굵기, 손떨림 보정)
//
//   1) 콘텐츠로서 손 메모: 메모 폴더의 SVG 파일 한 개 = 그림 한 칸. 마크다운에는 그냥 그림으로
//        ![손 메모](attachments/20261006-101500-ab12.svg)        (바탕: "손 메모" 투명 · "손 메모 · 흰 바탕" · "손 메모 · 검은 바탕")
//      SVG 안에 획 자료(JSON)를 함께 넣어 두어 다시 열어 고칠 수 있다. 크기는 그린 만큼 (그린 곳 둘레 + 여백)
//   2) 주석으로서 손 메모: 글 위에 겹쳐 그린 획 — 칸을 차지하지 않는다. 메모 머리말 ink: 의 JSON 파일에.
//      획마다 그 아래 문단(블록)에 붙여 두어, 글이 늘거나 창 폭이 바뀌어도 그 문단을 따라간다.
//      좌표 단위: 본문 폭의 1/1000 (폭이 다른 휴대폰·PC 에서도 같은 자리 · 같은 비율)

export const INK_ALT = '손 메모';
export const INK_BG = { none: '', white: '#ffffff', black: '#111111' };
const BG_ALT = { none: INK_ALT, white: `${INK_ALT} · 흰 바탕`, black: `${INK_ALT} · 검은 바탕` };

export const PEN_COLORS = ['#1f1f1c', '#2f6fdf', '#e5484d', '#2f9e44', '#f08c00', '#7a4dff', '#ffffff'];
export const HIGHLIGHT_COLORS = ['#ffd43b', '#8ce99a', '#ffa8a8', '#a5d8ff'];
export const SIZES = { pen: [2.5, 4, 7], highlighter: [14, 20, 28], eraser: [10, 18, 30] };

/** 어두운 화면(다크 모드 · 검은 메모)에서 검은 펜이 그려 보이는 색 */
export const INK_LIGHT = '#f5f4ef';
/** 획의 밝기 성질: 검은 펜 'ink-k' · 흰 펜 'ink-w' · 그 밖(색 펜·형광펜) '' — 어두운 화면에서는 이 둘만 서로 바꿔 보인다 */
export function inkTone(stroke) {
  if (stroke?.tool === 'highlighter') return '';
  const c = String(stroke?.color ?? '').toLowerCase();
  return c === PEN_COLORS[0] ? 'ink-k' : c === '#ffffff' ? 'ink-w' : '';
}
/** 어두운 화면용 손 메모: 검은 펜 ↔ 흰 펜만 바꾼다 (색 펜·형광펜은 그대로 — 원노트처럼). 바꿀 획이 없으면 null */
export function inkForDark(doc) {
  const ink = normalizeInk(doc);
  let changed = false;
  const strokes = ink.strokes.map((s) => {
    const tone = inkTone(s);
    if (!tone) return s;
    changed = true;
    return { ...s, color: tone === 'ink-k' ? INK_LIGHT : PEN_COLORS[0] };
  });
  return changed ? { ...ink, strokes } : null;
}

/** 이 그림이 손 메모인가 (SVG + 이름이 "손 메모"로 시작) */
export function isInk(src, alt = '') {
  return /\.svg$/i.test(String(src ?? '').split(/[?#]/)[0]) && String(alt ?? '').startsWith(INK_ALT);
}
export function inkAlt(bg) {
  return BG_ALT[bg] ?? INK_ALT;
}
export function bgOfAlt(alt) {
  const a = String(alt ?? '');
  return a.includes('흰 바탕') ? 'white' : a.includes('검은 바탕') ? 'black' : 'none';
}

const round = (v) => Math.round(v * 10) / 10;

/** 그리는 중의 점 하나 (x, y, 압력) — 파일을 작게 하려고 0.1 단위로 */
export const point = (x, y, p = 0.5) => [round(x), round(y), Math.round(Math.max(0, Math.min(1, p)) * 100) / 100];

/** perfect-freehand 설정: 펜은 압력(없으면 속도)으로 굵기, 형광펜은 같은 굵기 · 끝이 네모 */
export function strokeOptions(stroke) {
  if (stroke.tool === 'highlighter') {
    return { size: stroke.size, thinning: 0, smoothing: 0.6, streamline: 0.5, simulatePressure: false, start: { cap: false }, end: { cap: false }, last: true };
  }
  return { size: stroke.size, thinning: stroke.pen ? 0.65 : 0.55, smoothing: 0.55, streamline: 0.45, simulatePressure: !stroke.pen, last: true };
}

/** 획의 바깥 테두리 점들 → SVG path (perfect-freehand 안내서의 getSvgPathFromStroke) */
export function outlinePath(points) {
  const n = points.length;
  if (n < 2) return '';
  const avg = (a, b) => (a + b) / 2;
  let d = `M${round(points[0][0])},${round(points[0][1])} Q`;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % n];
    d += `${round(x0)},${round(y0)} ${round(avg(x0, x1))},${round(avg(y0, y1))} `;
  }
  return `${d.trim()}Z`;
}

export function strokePath(stroke, getStroke) {
  if (!stroke?.pts?.length) return '';
  // 점 하나(콕 찍기)도 보이게
  const pts = stroke.pts.length === 1 ? [stroke.pts[0], [stroke.pts[0][0] + 0.1, stroke.pts[0][1] + 0.1, stroke.pts[0][2]]] : stroke.pts;
  return outlinePath(getStroke(pts, strokeOptions(stroke)));
}

/** 획들의 둘레 (굵기 포함) — 없으면 null */
export function inkBounds(strokes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of strokes ?? []) {
    const r = (s.size ?? 4) / 2 + 1;
    for (const [x, y] of s.pts ?? []) {
      x0 = Math.min(x0, x - r);
      y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r);
      y1 = Math.max(y1, y + r);
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/** 주석 획이 붙은 곳: b 문단 번호 · f 문단 글(앞 40자) — 글자에 붙인 획(t: 'c')은 c 글자 자리 · w 그 자리부터의 글 몇 자 */
function normalizeAnchor(a) {
  const out = { b: Math.max(0, Math.floor(Number(a.b) || 0)), f: String(a.f ?? '').slice(0, 40) };
  if (a.t === 'c') Object.assign(out, { t: 'c', c: Math.max(0, Math.floor(Number(a.c) || 0)), w: String(a.w ?? '').slice(0, CHAR_SNIP) });
  return out;
}

/** 받은 자료를 안전한 모양으로 (파일을 손으로 고쳤거나 다른 버전이 만든 것도) */
export function normalizeInk(doc) {
  const bg = Object.hasOwn(INK_BG, doc?.bg) ? doc.bg : 'none';
  const strokes = (Array.isArray(doc?.strokes) ? doc.strokes : []).map((s) => ({
    tool: s?.tool === 'highlighter' ? 'highlighter' : 'pen',
    color: /^#[0-9a-f]{6}$/i.test(s?.color) ? s.color.toLowerCase() : '#1f1f1c',
    size: Math.max(0.5, Math.min(80, Number(s?.size) || 4)),
    pen: Boolean(s?.pen),
    pts: (Array.isArray(s?.pts) ? s.pts : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => point(p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0.5)),
    ...(s?.anchor ? { anchor: normalizeAnchor(s.anchor) } : {}),
  })).filter((s) => s.pts.length);
  return { v: 1, bg, strokes };
}

/**
 * 손 메모 → SVG 글 (그린 곳 둘레 + 여백 크기). 획이 없으면 null
 *   그림은 그린 자리 그대로(viewBox), 자료(JSON)는 <metadata> 에 — 다시 열면 같은 자리에서 이어 그린다
 */
export function inkToSvg(doc, getStroke, { pad = 14 } = {}) {
  const ink = normalizeInk(doc);
  const b = inkBounds(ink.strokes);
  if (!b) return null;
  const x = Math.floor(b.x - pad);
  const y = Math.floor(b.y - pad);
  const w = Math.ceil(b.w + pad * 2);
  const h = Math.ceil(b.h + pad * 2);
  const parts = [];
  if (ink.bg !== 'none') parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${INK_BG[ink.bg]}"/>`);
  for (const s of ink.strokes) {
    const d = strokePath(s, getStroke);
    if (d) parts.push(`<path d="${d}" fill="${esc(s.color)}"${s.tool === 'highlighter' ? ' fill-opacity="0.4"' : ''}/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`
    + `<metadata id="memoking-ink"><![CDATA[${JSON.stringify(ink)}]]></metadata>${parts.join('')}</svg>`;
}

/** SVG 글 → 손 메모 자료 (메모킹이 만든 것이 아니면 null) */
export function parseInkSvg(text) {
  const m = String(text ?? '').match(/<metadata id="memoking-ink"><!\[CDATA\[([\s\S]*?)\]\]><\/metadata>/);
  if (!m) return null;
  try {
    return normalizeInk(JSON.parse(m[1]));
  } catch {
    return null;
  }
}

/** 지우개: 이 점에서 r 안에 닿는 획들의 번호 */
export function strokesHit(strokes, x, y, r) {
  const hit = [];
  strokes.forEach((s, i) => {
    const rr = r + s.size / 2;
    const pts = s.pts;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const bpt = pts[k + 1] ?? a;
      if (distToSegment(x, y, a[0], a[1], bpt[0], bpt[1]) <= rr) {
        hit.push(i);
        break;
      }
    }
  });
  return hit;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------- 주석: 획을 문단에 붙이기 ----------

/** 문단 알아보기용 글 (첫 40자, 띄어쓰기 정리) — 문단이 앞뒤로 생겨 번호가 바뀌어도 같은 문단을 찾게 */
export const fingerprint = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * 그린 획 → 주석 획: 획의 맨 위가 걸친 문단에 붙이고 좌표를 "본문 폭의 1/1000" 단위로
 * @param stroke 화면 좌표(본문 왼쪽 위 기준, px)
 * @param blocks [{ top, height, text }] 본문의 문단들 (같은 기준, px)
 * @param width 본문 폭 (px)
 */
export function anchorStroke(stroke, blocks, width) {
  const u = 1000 / Math.max(1, width);
  const top = Math.min(...stroke.pts.map((p) => p[1]));
  let b = 0;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].top <= top) b = i;
  const base = blocks[b]?.top ?? 0;
  return {
    ...stroke,
    size: round(stroke.size * u),
    pts: stroke.pts.map(([x, y, p]) => point(x * u, (y - base) * u, p)),
    anchor: { b, f: fingerprint(blocks[b]?.text) },
  };
}

/** 주석 획이 붙은 문단 찾기: 같은 글의 문단(원래 번호에서 가장 가까운) → 없으면 원래 번호 (끝을 넘으면 마지막) */
export function findAnchor(blocks, anchor) {
  if (!blocks.length) return -1;
  const want = anchor?.f ?? '';
  if (want) {
    let best = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (fingerprint(blocks[i].text) === want && (best < 0 || Math.abs(i - anchor.b) < Math.abs(best - anchor.b))) best = i;
    }
    if (best >= 0) return best;
  }
  return Math.min(Math.max(0, anchor?.b ?? 0), blocks.length - 1);
}

// ---------- 주석: 획을 글자에 붙이기 (v0.55) ----------
//   문단 폭 비율로 두면 화면 비율이 다른 기기(태블릿 ↔ 휴대폰 ↔ PC)에서 줄바꿈이 달라져 다른 낱말 위에 그려졌다.
//   그래서 획 가운데 아래의 글자에 붙이고, 모양은 그 글자 왼쪽 위에서 "글자 크기(16px 기준)" 단위로 둔다 —
//   줄바꿈 · 화면 폭 · 글자 크기가 바뀌어도 그 낱말을 따라간다. 글이 조금 고쳐져도 그 자리 글(w)로 다시 찾는다.
export const CHAR_SNIP = 12;

/**
 * 그린 획 → 글자에 붙인 주석 획
 * @param stroke 화면 좌표 (본문 왼쪽 위 기준, px)
 * @param at { b 문단 번호, text 문단 글, c 글자 자리, left/top 그 글자 왼쪽 위(같은 기준, px), font 그 글자 크기(px) }
 */
export function anchorStrokeToChar(stroke, at) {
  const u = 16 / Math.max(1, at.font);
  return {
    ...stroke,
    size: round(stroke.size * u),
    pts: stroke.pts.map(([x, y, p]) => point((x - at.left) * u, (y - at.top) * u, p)),
    anchor: { b: at.b, f: fingerprint(at.text), t: 'c', c: at.c, w: String(at.text ?? '').slice(at.c, at.c + CHAR_SNIP) },
  };
}

/**
 * 한 번에 그린 그림 묶기: 테두리가 gap(px) 안으로 닿는 획끼리 한 묶음 (손글씨 · 동그라미 + 화살표 등)
 *   묶음은 같은 글자에 함께 붙여, 줄바꿈이 달라져도 그림이 흩어지지 않고 낱말을 따라간다 (v0.72 에서 획마다 붙여 흩어지던 것)
 * @returns {number[][]} 획 번호 묶음들 (그린 순서)
 */
export function groupStrokes(strokes, gap = 24) {
  const boxes = strokes.map((s) => inkBounds([s]));
  const root = strokes.map((_, i) => i);
  const find = (i) => (root[i] === i ? i : (root[i] = find(root[i])));
  const near = (a, b) => a && b && a.x - gap <= b.x + b.w && b.x - gap <= a.x + a.w && a.y - gap <= b.y + b.h && b.y - gap <= a.y + a.h;
  for (let i = 0; i < strokes.length; i++) {
    for (let j = 0; j < i; j++) if (near(boxes[i], boxes[j])) root[find(i)] = find(j);
  }
  const groups = new Map();
  strokes.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return [...groups.values()];
}

/** 글자에 붙인 획의 글자 자리 다시 찾기: 그 자리 글이 그대로면 그대로, 고쳐졌으면 같은 글(w)의 가장 가까운 곳, 없으면 끝에 맞춤 */
export function findChar(text, anchor) {
  const s = String(text ?? '');
  if (!s.length) return -1;
  const c = Math.max(0, anchor?.c ?? 0);
  const w = anchor?.w ?? '';
  if (w && s.slice(c, c + w.length) === w) return c;
  // 앞쪽 글이 고쳐져 밀렸으면: 같은 글을 찾되 원래 자리에서 가장 가까운 곳 (짧게 잘라 가며 — 뒤쪽이 고쳐졌어도)
  for (let n = w.length; n >= Math.min(3, w.length) && n > 0; n--) {
    const piece = w.slice(0, n);
    let best = -1;
    for (let i = s.indexOf(piece); i >= 0; i = s.indexOf(piece, i + 1)) if (best < 0 || Math.abs(i - c) < Math.abs(best - c)) best = i;
    if (best >= 0) return best;
  }
  return Math.min(c, s.length - 1);
}

/** 글자에 붙인 주석 획 → 지금 화면 좌표 (origin: 그 글자의 지금 왼쪽 위 · 글자 크기) */
export function placeStrokeAtChar(stroke, origin) {
  const k = Math.max(1, origin.font) / 16;
  return { ...stroke, size: stroke.size * k, pts: stroke.pts.map(([x, y, p]) => [x * k + origin.left, y * k + origin.top, p]) };
}

/** 주석 획 → 지금 화면 좌표 (본문 왼쪽 위 기준, px) — 문단 폭 비율로 둔 예전 획 (글자를 못 찾은 그림 위 획도) */
export function placeStroke(stroke, blocks, width) {
  const i = findAnchor(blocks, stroke.anchor);
  const k = Math.max(1, width) / 1000;
  const base = i >= 0 ? blocks[i].top : 0;
  return { ...stroke, size: stroke.size * k, pts: stroke.pts.map(([x, y, p]) => [x * k, y * k + base, p]) };
}
