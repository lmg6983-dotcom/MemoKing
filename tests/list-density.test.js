import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDensity, levelDensity, MORE, LESS, THUMB, MAX_DETAIL_LINES } from '../app/js/core/list-density.js';
import { ZOOM_STEPS } from '../app/js/core/zoom.js';

// 여러 창 크기·메모 수의 100% 모양
const bases = [];
for (const width of [300, 400, 700, 1000]) {
  for (const height of [300, 450, 600, 800, 1100]) {
    for (const count of [2, 5, 14, 60]) bases.push({ area: { width, height, count }, base: chooseDensity({ width, height }, count) });
  }
}
const steps = ZOOM_STEPS.filter((z) => z <= 1.75);
// 보이는 내용의 양: 요약 줄(사진 카드·사진 없는 카드) + 사진이 보이는지
const amount = (d) => ({ photo: d.mode === 'compact' ? 0 : d.previewLines, plain: d.mode === 'compact' ? 0 : d.fullLines, thumb: d.mode === 'roomy' ? 1 : 0 });

test('확대·축소 단계를 하나 올릴 때마다 보이는 내용이 줄지 않는다 (요약 줄·사진) — 모든 창 크기에서', () => {
  for (const { area, base } of bases) {
    let prev = null;
    for (const z of steps) {
      const d = levelDensity(base, z, { width: area.width / Math.min(1, z), count: area.count });
      const a = amount(d);
      if (prev) {
        const msg = `${JSON.stringify(area)} ${z}: ${JSON.stringify(prev)} → ${JSON.stringify(a)}`;
        assert.ok(a.photo >= prev.photo, msg);
        assert.ok(a.plain >= prev.plain, msg);
        assert.ok(a.thumb >= prev.thumb, msg);
      }
      prev = a;
    }
  }
});

test('확대 단계마다 요약 줄이 실제로 늘어난다 (최대치 전까지)', () => {
  for (const { base } of bases) {
    let prev = levelDensity(base, 1);
    for (const { zoom } of MORE) {
      const d = levelDensity(base, zoom);
      const before = prev.mode === 'compact' ? 0 : prev.previewLines;
      if (before < MAX_DETAIL_LINES) assert.ok(d.previewLines > before, `${zoom}: ${before} → ${d.previewLines}`);
      prev = d;
    }
  }
});

test('확대: 150% 부터 사진·태그 줄을 요약 아래에 덧붙이고(요약 줄을 빼앗지 않음), 사진은 늘 같은 크기, 열은 줄여 카드를 넓게', () => {
  const base = chooseDensity({ width: 700, height: 260 }, 14); // 2열 · 촘촘
  assert.equal(base.mode, 'compact');
  const d125 = levelDensity(base, 1.25);
  const d150 = levelDensity(base, 1.5);
  const d175 = levelDensity(base, 1.75);
  assert.equal(d125.mode, 'preview');
  assert.equal(d150.mode, 'roomy');
  assert.ok(d150.previewLines > d125.previewLines);
  assert.equal(d150.thumbHeight, THUMB);
  assert.equal(d175.thumbHeight, THUMB);
  assert.equal(d125.cols, 1);
  assert.equal(base.cols, 2);
});

test('축소: 요약 줄을 줄이고 사진은 감추며, 작아진 만큼 열을 늘린다', () => {
  const base = chooseDensity({ width: 600, height: 900 }, 14);
  for (const { zoom } of LESS) {
    const d = levelDensity(base, zoom, { width: 600 / zoom, count: 14 });
    assert.equal(d.thumbHeight, 0);
    assert.ok(d.previewLines <= base.previewLines);
  }
  assert.equal(levelDensity(base, 0.5, { width: 1200, count: 14 }).mode, 'compact');
  assert.ok(levelDensity(base, 0.5, { width: 1200, count: 14 }).cols >= 2);
});

test('100% 모양: 칸이 좁으면 한 줄(촘촘), 넉넉하면 사진과 요약 (사진 없는 카드는 사진 자리까지 글로)', () => {
  assert.equal(chooseDensity({ width: 360, height: 300 }, 20).mode, 'compact');
  const d = chooseDensity({ width: 360, height: 900 }, 3);
  assert.equal(d.mode, 'roomy');
  assert.ok(d.fullLines > d.previewLines);
  assert.equal(d.thumbHeight, THUMB);
});
