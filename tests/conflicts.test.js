// 충돌 사본 이름 → 원본 이름 (PC · 휴대폰 "원본과 견주기")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalFileOf } from '../app/js/core/conflicts.js';

test('충돌 사본 이름에서 원본 이름을 찾는다', () => {
  assert.equal(originalFileOf('회의 (PC 충돌 2026-11-15 1530).md'), '회의.md');
  assert.equal(originalFileOf('업무/회의 (휴대폰 충돌 2026-11-15 1530 2).md'), '업무/회의.md');
  assert.equal(originalFileOf('회의 (2).md'), null);
  assert.equal(originalFileOf('회의 (PC 충돌 메모).md'), null);
  assert.equal(originalFileOf(''), null);
});
