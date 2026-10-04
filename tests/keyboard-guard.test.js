import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeScroll } from '../app/js/keyboard-guard.js';

test('끄는 동안 자동 스크롤: 가장자리 안쪽에서만, 가까울수록 빠르게', () => {
  assert.equal(edgeScroll(500, 100, 900), 0); // 가운데
  assert.ok(edgeScroll(880, 100, 900) > 0); // 아래 끝 가까이
  assert.ok(edgeScroll(110, 100, 900) < 0); // 위 끝 가까이
  assert.ok(edgeScroll(895, 100, 900) > edgeScroll(870, 100, 900));
});

test('끄는 동안 자동 스크롤: 손가락이 끝 밖으로 멀리 나가도 속도 상한 (맨 아래로 휙 가지 않게)', () => {
  assert.equal(edgeScroll(1400, 100, 900), 14);
  assert.equal(edgeScroll(-500, 100, 900), -14);
  assert.ok(edgeScroll(1400, 100, 900) <= 14);
});
