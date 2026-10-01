import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionCaptureRect } from '../app/js/core/selection-rect.js';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

test('선택한 내용 둘레에 여백 8px 을 두고 모니터 기준 좌표로', () => {
  assert.deepEqual(selectionCaptureRect({ x: 100, y: 200, width: 300, height: 40 }, screen), { x: 92, y: 192, width: 316, height: 56 });
});

test('소수 좌표는 바깥쪽으로 올림·내림 (선택한 내용이 잘리지 않게)', () => {
  assert.deepEqual(selectionCaptureRect({ x: 100.6, y: 200.4, width: 10.2, height: 10.2 }, screen, { pad: 0 }), { x: 100, y: 200, width: 11, height: 11 });
});

test('모니터 가장자리를 넘는 부분은 잘라 낸다', () => {
  assert.deepEqual(selectionCaptureRect({ x: -50, y: 1000, width: 200, height: 200 }, screen), { x: 0, y: 992, width: 158, height: 88 });
});

test('두 번째 모니터: 그 모니터 기준 좌표', () => {
  const right = { x: 1920, y: -200, width: 2560, height: 1440 };
  assert.deepEqual(selectionCaptureRect({ x: 2000, y: -100, width: 100, height: 50 }, right), { x: 72, y: 92, width: 116, height: 66 });
});

test('선택이 없거나, 너무 작거나, 모니터 밖이면 null (직접 고르기로)', () => {
  assert.equal(selectionCaptureRect(null, screen), null);
  assert.equal(selectionCaptureRect({ x: 10, y: 10, width: 0, height: 20 }, screen), null);
  assert.equal(selectionCaptureRect({ x: NaN, y: 10, width: 10, height: 20 }, screen), null);
  assert.equal(selectionCaptureRect({ x: 3000, y: 10, width: 100, height: 20 }, screen), null);
  assert.equal(selectionCaptureRect({ x: 10, y: 10, width: 2, height: 2 }, screen, { pad: 0 }), null);
});
