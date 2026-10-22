// 글자 인식 다듬기 — 카카오톡처럼 늘 같은 글꼴을 쓰는 알림 창에서, 헷갈리는 한글("볼" · "몰")을
// 같은 글꼴 · 같은 크기 · 같은 하위 픽셀 시작점으로 직접 그려 원래 크기 그림과 견주고 더 닮은 글자로 고친다.
//   글꼴이 꼭 맞을 때만 쓴다: 줄마다 가장 긴 낱말을 크기 · 굵기 · 그리는 방식별로 그려 보고, 거의 그대로 겹치는 것이 없으면
//   (다른 글꼴 · 다른 그리기) 그 줄은 손대지 않는다. 바꾸는 것도 원래 글보다 뚜렷이(30%) 더 닮았을 때만.
import { similarSyllables } from './core/hangul-similar.js';

const FAMILY = 'Malgun Gothic';
const MATCH_LIMIT = 0.03; // 글꼴이 맞다고 볼 차이 (0 = 똑같음). 시험장에서 맞는 글꼴은 0.00x, 다른 크기는 훨씬 크다
const MARGIN = 0.3;

// 흑백 1배 그림: { w, h, px(Float32 밝기) } — 어두운 바탕(다크 모드)은 뒤집어 흰 바탕에 검은 글로
export function grayImage(imageData) {
  const { width: w, height: h, data: d } = imageData;
  const px = new Float32Array(w * h);
  const hist = new Uint32Array(64);
  for (let i = 0; i < px.length; i++) {
    const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    px[i] = v;
    hist[v >> 2]++;
  }
  let bg = 0;
  for (let v = 1; v < 64; v++) if (hist[v] > hist[bg]) bg = v;
  if (bg * 4 < 128) for (let i = 0; i < px.length; i++) px[i] = 255 - px[i];
  return { w, h, px };
}

// 글을 그려 흑백 1배 그림으로. mode 'lcd' 는 ClearType 처럼(가로 3배로 그려 하위 픽셀을 R · G · B 로), 'gray' 는 보통 흐림.
// phase: 시작점의 하위 픽셀 (0 · 1 · 2 = 0 · 1/3 · 2/3 px)
const renders = new Map();
function render(text, font, mode, phase) {
  const key = `${mode}|${phase}|${font}|${text}`;
  const hit = renders.get(key);
  if (hit) return hit;
  const size = parseFloat(/(\d+(\.\d+)?)px/.exec(font)?.[1] ?? '12');
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  const w = Math.ceil(m.measureText(text).width) + 6;
  const h = Math.ceil(size * 1.5) + 4;
  const k = mode === 'lcd' ? 3 : 1;
  const c = document.createElement('canvas');
  c.width = w * k;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, h);
  g.setTransform(k, 0, 0, 1, 0, 0);
  g.fillStyle = '#000';
  g.font = font;
  g.textBaseline = 'top';
  g.fillText(text, 2 + phase / 3, 2);
  const d = g.getImageData(0, 0, c.width, h).data;
  const px = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (k === 1) {
      const o = (y * w + x) * 4;
      px[y * w + x] = (d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114) / 1000;
      continue;
    }
    // 하위 픽셀 3개(R · G · B)에 이웃까지 1:2:1 로 — ClearType 의 거름과 비슷하게
    let rgb = 0;
    const at = (sx) => d[(y * c.width + Math.max(0, Math.min(c.width - 1, sx))) * 4];
    for (let ch = 0; ch < 3; ch++) {
      const sx = x * 3 + ch;
      const v = (at(sx - 1) + 2 * at(sx) + at(sx + 1)) / 4;
      rgb += v * [299, 587, 114][ch];
    }
    px[y * w + x] = rgb / 1000;
  }
  const out = { w, h, px };
  if (renders.size > 3000) renders.clear();
  renders.set(key, out);
  return out;
}

// 창 안에서 그림 I 와 r(자리 ox, oy)의 차이: 1 - 정규화 상관 (밝기 · 진하기가 달라도 모양만 본다)
function score(I, win, r, ox, oy) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = win.y0; y < win.y1; y++) for (let x = win.x0; x < win.x1; x++) {
    const a = y >= 0 && y < I.h && x >= 0 && x < I.w ? I.px[y * I.w + x] : 255;
    const rx = x - ox;
    const ry = y - oy;
    const b = rx >= 0 && ry >= 0 && rx < r.w && ry < r.h ? r.px[ry * r.w + rx] : 255;
    n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
  }
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va <= 0 || vb <= 0 ? 1 : 1 - (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

// 가장 잘 겹치는 자리(정수 px) · 하위 픽셀 찾기
function place(I, win, text, style, x0, y0, rad, phases = [0, 1, 2]) {
  let best = { s: Infinity };
  for (const ph of phases) {
    const r = render(text, style.font, style.mode, ph);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const s = score(I, win, r, x0 + dx, y0 + dy);
      if (s < best.s) best = { s, x: x0 + dx, y: y0 + dy, ph };
    }
  }
  return best;
}

const boxOf = (bbox, unit) => ({
  x0: Math.floor(bbox.x0 / unit), y0: Math.floor(bbox.y0 / unit),
  x1: Math.ceil(bbox.x1 / unit), y1: Math.ceil(bbox.y1 / unit),
});
const windowOf = (bb) => ({ x0: bb.x0 - 3, y0: bb.y0 - 3, x1: bb.x1 + 4, y1: bb.y1 + 4 });

// 한 번 맞은 글꼴(크기 · 굵기 · 그리기)은 기억해 둔다 — 카카오톡 글꼴은 잘 안 바뀌므로 다음 알림부터는 바로 확인만
const known = [];

function styleFor(I, line, unit, scale, family) {
  const word = line.words.filter((w) => /[가-힣]/.test(w.text)).sort((a, b) => b.text.length - a.text.length)[0];
  if (!word) return null;
  const bb = boxOf(word.bbox, unit);
  const win = windowOf(bb);
  const tryStyle = (style, rad) => place(I, win, word.text, style, bb.x0 - 2, bb.y0 - 4, rad);
  for (const style of known) if (tryStyle(style, 3).s < MATCH_LIMIT) return style;
  let pick = { s: Infinity, style: null };
  for (let size = 9; size <= 14; size += 0.5) {
    for (const weight of ['normal', 'bold']) for (const mode of ['lcd', 'gray']) {
      const style = { font: `${weight} ${Math.round(size * scale * 2) / 2}px "${family}"`, mode };
      const b = tryStyle(style, 3);
      if (b.s < pick.s) pick = { s: b.s, style };
    }
  }
  if (pick.s >= MATCH_LIMIT) return null;
  known.unshift(pick.style);
  known.length = Math.min(known.length, 6);
  return pick.style;
}

/**
 * tesseract 결과(blocks)를 다듬는다.
 * @param {{ w: number, h: number, px: Float32Array }} I 원래 크기 알림 그림 (grayImage)
 * @param {object} data tesseract recognize(..., { blocks: true }) 의 data
 * @param {{ unit: number, scale?: number, family?: string }} o unit = 글자 인식 그림 px / 원래 그림 px, scale = 화면 배율, family = 알림 창 글꼴
 * @returns {{ lines: Map<object, string>, fixes: string[][], matched: number, lineCount: number, skipped: boolean }}
 */
// 글꼴이 안 맞는 PC(다른 글꼴 · 다른 그리기)에서 알림마다 헛되이 맞춰 보지 않게: 3번 내리 안 맞으면 30번은 쉬었다가 다시
const BACKOFF = { after: 3, skip: 30 };
let misses = 0;
let resting = 0;

export function refineHangul(I, data, { unit, scale = 1, family = FAMILY }) {
  const lines = new Map();
  const fixes = [];
  let matched = 0;
  let lineCount = 0;
  let tried = 0;
  if (resting > 0) {
    resting--;
    return { lines, fixes, matched, lineCount, skipped: true };
  }
  for (const block of data.blocks ?? []) for (const par of block.paragraphs ?? []) for (const line of par.lines ?? []) {
    lineCount++;
    if (!line.words?.some((w) => /[가-힣]/.test(w.text))) continue;
    // 첫 한글 줄부터 안 맞으면 이 알림은 그만 (같은 알림 창의 줄들은 대개 같은 글꼴)
    if (tried && !matched) continue;
    tried++;
    const style = styleFor(I, line, unit, scale, family);
    if (!style) continue;
    matched++;
    const words = line.words.map((w) => {
      if (!/[가-힣]/.test(w.text)) return w.text;
      const chars = [...w.text];
      const bb = boxOf(w.bbox, unit);
      const win = windowOf(bb);
      const at = place(I, win, w.text, style, bb.x0 - 2, bb.y0 - 4, 4);
      let cur = at.s;
      for (let i = 0; i < chars.length; i++) {
        for (const alt of similarSyllables(chars[i])) {
          const cand = [...chars];
          cand[i] = alt;
          const b = place(I, win, cand.join(''), style, at.x, at.y, 1, [at.ph]);
          if (b.s < cur * (1 - MARGIN)) {
            fixes.push([chars[i], alt]);
            cur = b.s;
            chars[i] = alt;
          }
        }
      }
      return chars.join('');
    });
    lines.set(line, words.join(' '));
  }
  if (tried) {
    misses = matched ? 0 : misses + 1;
    if (misses >= BACKOFF.after) {
      misses = 0;
      resting = BACKOFF.skip;
    }
  }
  return { lines, fixes, matched, lineCount, skipped: false };
}
