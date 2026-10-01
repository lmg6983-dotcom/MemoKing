// 스크롤하며 찍은 여러 장을 한 장으로 이어 붙이기 (순수 함수, 단위 테스트 대상)
// 각 장은 같은 영역(화면의 보이는 부분)을 위에서 아래로 스크롤하며 찍은 것. 픽셀은 4바이트(BGRA·RGBA 상관없음).
//   1) 이웃한 두 장이 얼마나 밀렸는지: 스크롤한 거리(UI 자동화가 잰 값) 근처에서 겹치는 줄이 가장 잘 맞는 곳을 찾는다
//   2) 겹치는 부분은 가운데에서 잘라 이어 붙인다 (위·아래에 붙어 있는 머리말·바닥글이 반복되지 않게)
//   3) 장마다 선택한 내용의 사각형을 모아, 선택한 내용이 모두 들어가게(둘레 여백) 잘라 낸다

const SAMPLES = 64; // 줄마다 견줄 점 수
const MAX_ROWS = 320; // 겹침을 견줄 때 쓰는 최대 줄 수

/** @typedef {{ width: number, height: number, data: Uint8Array, moved?: number, sel?: { x: number, y: number, width: number, height: number } | null }} Frame */

// 줄마다 고르게 뽑은 점의 밝기
function rowSignatures(frame) {
  const { width, height, data } = frame;
  const sig = new Float32Array(height * SAMPLES);
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < SAMPLES; i++) {
      const x = Math.min(width - 1, Math.floor(((i + 0.5) * width) / SAMPLES));
      const o = (y * width + x) * 4;
      sig[y * SAMPLES + i] = data[o] * 0.11 + data[o + 1] * 0.59 + data[o + 2] * 0.3;
    }
  }
  return sig;
}

/**
 * cur 의 0번 줄이 prev 의 몇 번 줄과 같은지 (= 밀린 거리)
 * @returns {{ shift: number, score: number }} score 는 한 점당 평균 밝기 차 (작을수록 잘 맞음)
 */
export function findShift(prev, cur, guess = 0, { range = 24 } = {}) {
  const h = Math.min(prev.height, cur.height);
  const a = rowSignatures(prev);
  const b = rowSignatures(cur);
  const minOverlap = Math.min(8, h - 1);
  let lo = 1;
  let hi = h - minOverlap;
  if (guess > 0) {
    lo = Math.max(1, Math.round(guess) - range);
    hi = Math.min(h - minOverlap, Math.round(guess) + range);
    if (lo > hi) [lo, hi] = [1, h - minOverlap];
  }
  let best = { shift: guess > 0 ? Math.min(Math.max(1, Math.round(guess)), h) : h, score: Infinity };
  for (let s = lo; s <= hi; s++) {
    const overlap = Math.min(prev.height - s, cur.height);
    if (overlap < minOverlap) continue;
    const rows = Math.min(overlap, MAX_ROWS);
    const stride = Math.max(1, Math.floor(overlap / rows));
    let sum = 0;
    let n = 0;
    for (let y = 0; y < overlap; y += stride) {
      const pa = (s + y) * SAMPLES;
      const pb = y * SAMPLES;
      for (let i = 0; i < SAMPLES; i++) sum += Math.abs(a[pa + i] - b[pb + i]);
      n += SAMPLES;
    }
    const score = sum / n;
    // 거의 같으면 짐작한 거리에 가까운 쪽
    const better = score < best.score - 0.01 || (Math.abs(score - best.score) <= 0.01 && guess > 0 && Math.abs(s - guess) < Math.abs(best.shift - guess));
    if (better) best = { shift: s, score };
  }
  return best;
}

/**
 * @param {Frame[]} frames 위에서 아래 순서. 두 번째부터 moved = 앞 장에서 스크롤한 거리(px, 모르면 0)
 * @param {{ pad?: number }} options
 * @returns {{ width: number, height: number, data: Uint8Array, offsets: number[] }}
 */
export function stitchFrames(frames, { pad = 8 } = {}) {
  if (!frames.length) throw new Error('이어 붙일 그림이 없어요');
  const width = frames[0].width;
  const offsets = [0];
  for (let k = 1; k < frames.length; k++) {
    if (frames[k].width !== width) throw new Error('그림 너비가 서로 달라요');
    offsets.push(offsets[k - 1] + findShift(frames[k - 1], frames[k], frames[k].moved ?? 0).shift);
  }
  const last = frames.length - 1;
  const total = offsets[last] + frames[last].height;
  // 겹친 부분의 가운데에서 다음 장으로 넘어간다
  const seams = [0];
  for (let k = 1; k < frames.length; k++) {
    const start = offsets[k];
    const end = offsets[k - 1] + frames[k - 1].height;
    seams.push(end > start ? Math.floor((start + end) / 2) : start);
  }
  seams.push(total);

  // 선택한 내용(장마다의 사각형)을 모두 감싸는 사각형 + 여백
  let box = null;
  frames.forEach((f, k) => {
    if (!f.sel || f.sel.width <= 0 || f.sel.height <= 0) return;
    const r = { x0: f.sel.x, y0: f.sel.y + offsets[k], x1: f.sel.x + f.sel.width, y1: f.sel.y + f.sel.height + offsets[k] };
    box = box ? { x0: Math.min(box.x0, r.x0), y0: Math.min(box.y0, r.y0), x1: Math.max(box.x1, r.x1), y1: Math.max(box.y1, r.y1) } : r;
  });
  const x0 = box ? Math.max(0, Math.floor(box.x0 - pad)) : 0;
  const y0 = box ? Math.max(0, Math.floor(box.y0 - pad)) : 0;
  const x1 = box ? Math.min(width, Math.ceil(box.x1 + pad)) : width;
  const y1 = box ? Math.min(total, Math.ceil(box.y1 + pad)) : total;
  const outW = Math.max(1, x1 - x0);
  const outH = Math.max(1, y1 - y0);
  const out = new Uint8Array(outW * outH * 4);
  let k = 0;
  for (let y = y0; y < y1; y++) {
    while (k < frames.length - 1 && y >= seams[k + 1]) k++;
    const f = frames[k];
    const fy = Math.min(f.height - 1, Math.max(0, y - offsets[k]));
    const src = (fy * f.width + x0) * 4;
    out.set(f.data.subarray(src, src + outW * 4), (y - y0) * outW * 4);
  }
  return { width: outW, height: outH, data: out, offsets };
}
