import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDensity, MAX_LINES } from '../app/js/core/list-density.js';

test('카드가 적게 보일수록(확대) 요약 줄이 늘고, 사진 높이는 화면에서 같은 크기', () => {
  const area = { width: 360, height: 600 };
  const a = chooseDensity(area, 20, 2, { zoom: 1 });
  const b = chooseDensity(area, 20, 1, { zoom: 1 });
  assert.equal(a.mode, 'roomy');
  assert.ok(b.previewLines > a.previewLines, `${a.previewLines} → ${b.previewLines}`);
  assert.equal(a.thumbHeight, b.thumbHeight); // 칸이 넉넉해져도 사진은 그대로
  // 확대 배율만큼 사진 높이(확대된 단위)는 줄어 화면에서는 같은 크기
  const z = chooseDensity({ width: 360, height: 480 }, 20, 1, { zoom: 1.25 });
  assert.equal(z.mode, 'roomy');
  assert.equal(Math.round(z.thumbHeight * 1.25), a.thumbHeight);
});

test('사진이 없는 카드는 사진 자리까지 요약 줄로, 줄 수는 최대치까지', () => {
  const d = chooseDensity({ width: 360, height: 900 }, 20, 2);
  assert.ok(d.fullLines > d.previewLines);
  assert.ok(d.fullLines <= MAX_LINES && d.previewLines <= MAX_LINES);
});

test('보통 모양: 칸 높이만큼 요약 줄 (2줄 넘게도)', () => {
  const d = chooseDensity({ width: 360, height: 600 }, 20, 5);
  assert.equal(d.mode, 'preview');
  assert.ok(d.previewLines >= 2, String(d.previewLines));
});

test('칸이 좁으면 한 줄(촘촘)', () => {
  assert.equal(chooseDensity({ width: 360, height: 300 }, 20, 8).mode, 'compact');
});
