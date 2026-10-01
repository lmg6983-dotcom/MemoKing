import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepZoom, clampZoom, zoomLabel, visibleForZoom, ZOOM_STEPS } from '../app/js/core/zoom.js';

test('한 단계씩 크게·작게 (브라우저와 같은 단계)', () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1.1, 1), 1.25);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(0.9, -1), 0.8);
});

test('끝에서는 더 가지 않는다', () => {
  assert.equal(stepZoom(3, 1), 3);
  assert.equal(stepZoom(0.5, -1), 0.5);
});

test('단계 사이 값은 가까운 다음 단계로', () => {
  assert.equal(stepZoom(1.2, 1), 1.25);
  assert.equal(stepZoom(1.2, -1), 1.1);
});

test('저장해 둔 값 정리', () => {
  assert.equal(clampZoom('1.25'), 1.25);
  assert.equal(clampZoom(null), 1);
  assert.equal(clampZoom('abc'), 1);
  assert.equal(clampZoom(10), ZOOM_STEPS.at(-1));
  assert.equal(clampZoom(0.1), ZOOM_STEPS[0]);
});

test('배율 이름', () => {
  assert.equal(zoomLabel(1), '100%');
  assert.equal(zoomLabel(0.67), '67%');
  assert.equal(zoomLabel(1.25), '125%');
});

test('목록 배율 → 한 화면에 보일 메모 수: 확대하면 적게, 축소하면 많이', () => {
  assert.equal(visibleForZoom(1), 8);
  assert.ok(visibleForZoom(1.25) < 8 && visibleForZoom(1.5) < visibleForZoom(1.25) && visibleForZoom(3) >= 1);
  assert.ok(visibleForZoom(0.8) > 8 && visibleForZoom(0.5) > visibleForZoom(0.8) && visibleForZoom(0.5) <= 40);
});
