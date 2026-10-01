import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findShift, stitchFrames } from '../app/js/core/stitch.js';

// 무늬가 있는 긴 "페이지" (줄마다 다른 무늬 — 글 줄처럼)
function page(width, height, seed = 7) {
  const data = new Uint8Array(width * height * 4);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < height; y++) {
    const blank = y % 23 > 17; // 글 줄 사이 빈 줄
    for (let x = 0; x < width; x++) {
      const v = blank ? 250 : Math.floor(rnd() * 255);
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
// 페이지의 top 부터 h 줄 (화면에 보이는 부분)
function view(p, top, h, extra = {}) {
  return { width: p.width, height: h, data: p.data.slice(top * p.width * 4, (top + h) * p.width * 4), ...extra };
}
const crop = (p, y0, y1) => p.data.slice(y0 * p.width * 4, y1 * p.width * 4);

test('밀린 거리를 찾는다 (짐작이 조금 틀려도, 몰라도)', () => {
  const p = page(120, 600);
  const a = view(p, 0, 300);
  const b = view(p, 230, 300);
  assert.equal(findShift(a, b, 230).shift, 230);
  assert.equal(findShift(a, b, 240).shift, 230);
  assert.equal(findShift(a, b, 0).shift, 230);
});

test('네 장을 이어 붙이면 원래 페이지와 같다', () => {
  const p = page(120, 1000);
  const tops = [0, 230, 470, 700];
  const frames = tops.map((t, i) => view(p, t, 300, { moved: i ? t - tops[i - 1] + (i === 2 ? 6 : 0) : 0 }));
  const out = stitchFrames(frames, { pad: 0 });
  assert.deepEqual(out.offsets, tops);
  assert.equal(out.height, 1000);
  assert.deepEqual(out.data, p.data);
});

test('선택한 내용(장마다의 사각형)이 모두 들어가게 여백을 두고 잘라 낸다', () => {
  const p = page(120, 1000);
  const tops = [0, 230, 470, 700];
  const frames = tops.map((t, i) => view(p, t, 300, { moved: i ? t - tops[i - 1] : 0 }));
  frames[0].sel = { x: 20, y: 100, width: 80, height: 200 }; // 페이지 100~300
  frames[1].sel = { x: 10, y: 0, width: 90, height: 300 };
  frames[3].sel = { x: 20, y: 0, width: 60, height: 150 }; // 페이지 700~850
  const out = stitchFrames(frames, { pad: 8 });
  assert.equal(out.width, 106); // x 10~100 → 여백 넣어 2~108
  assert.equal(out.height, 858 - 92);
  const row = (img, y) => img.data.slice(y * img.width * 4, (y + 1) * img.width * 4);
  // 첫 줄 = 페이지 92 줄의 x 2~120
  assert.deepEqual(row(out, 0), p.data.slice((92 * 120 + 2) * 4, (92 * 120 + 108) * 4));
});

test('위에 늘 붙어 있는 머리말(스크롤해도 그 자리)은 한 번만', () => {
  const p = page(120, 1000);
  const header = page(120, 20, 99);
  const withHeader = (t) => {
    const v = view(p, t, 300);
    v.data.set(header.data, 0); // 화면 위 20줄은 늘 머리말
    return v;
  };
  const tops = [0, 200, 400];
  const frames = tops.map((t, i) => ({ ...withHeader(t), moved: i ? 200 : 0 }));
  const out = stitchFrames(frames, { pad: 0 });
  assert.deepEqual(out.offsets, tops);
  assert.deepEqual(out.data.slice(0, 20 * 120 * 4), header.data);
  assert.deepEqual(out.data.slice(20 * 120 * 4), crop(p, 20, 700));
});

test('그림이 없거나 너비가 다르면 알려 준다', () => {
  assert.throws(() => stitchFrames([]));
  const p = page(120, 400);
  assert.throws(() => stitchFrames([view(p, 0, 200), { ...view(page(100, 400), 100, 200), moved: 100 }]));
});
