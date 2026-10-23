// 꾹 누르기 시간 맞추기 (app/js/core/hold-tuning.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_BASE, HOLD_MIN, HOLD_MAX, nextHold, isMisfireRelease, isSidewaysSelect, isMisfireUndo, isLateRetry, readHold } from '../app/js/core/hold-tuning.js';

test('실수면 늘리고 늦으면 줄이되, 범위 밖으로는 안 감', () => {
  assert.equal(nextHold(350, 'misfire'), 390);
  assert.equal(nextHold(350, 'late'), 330);
  assert.equal(nextHold(350, 'other'), 350);
  let ms = HOLD_BASE;
  for (let i = 0; i < 30; i++) ms = nextHold(ms, 'misfire');
  assert.equal(ms, HOLD_MAX);
  for (let i = 0; i < 60; i++) ms = nextHold(ms, 'late');
  assert.equal(ms, HOLD_MIN);
  assert.equal(nextHold(NaN, 'misfire'), HOLD_BASE + 40, '깨진 값은 처음 값에서');
});

test('실수 알아채기: 제자리에 곧 놓음 · 옆으로 끎 · 빨리 옮기고 곧 되돌림', () => {
  assert.ok(isMisfireRelease({ liftedMs: 200, movedPx: 3 }));
  assert.ok(!isMisfireRelease({ liftedMs: 1200, movedPx: 3 }), '오래 들고 있다 놓으면 망설인 것');
  assert.ok(!isMisfireRelease({ liftedMs: 200, movedPx: 40 }));
  assert.ok(isSidewaysSelect(30, 5));
  assert.ok(!isSidewaysSelect(10, 0), '조금은 흔들림');
  assert.ok(!isSidewaysSelect(20, 15), '비스듬하면 옮기기');
  assert.ok(!isSidewaysSelect(2, 40));
  assert.ok(isMisfireUndo({ dragMs: 400, sinceMs: 1500 }));
  assert.ok(!isMisfireUndo({ dragMs: 2500, sinceMs: 1500 }), '천천히 골라 옮긴 것은 자리만 틀린 것');
  assert.ok(!isMisfireUndo({ dragMs: 400, sinceMs: 9000 }));
});

test('늦음: 들리기 직전에 뗐다가 같은 줄을 곧 다시 눌러 옮김', () => {
  assert.ok(isLateRetry({ heldMs: 300, holdMs: 350, gapMs: 600, sameBlock: true }));
  assert.ok(!isLateRetry({ heldMs: 100, holdMs: 350, gapMs: 600, sameBlock: true }), '그냥 클릭');
  assert.ok(!isLateRetry({ heldMs: 300, holdMs: 350, gapMs: 3000, sameBlock: true }));
  assert.ok(!isLateRetry({ heldMs: 300, holdMs: 350, gapMs: 600, sameBlock: false }));
});

test('저장 값 읽기: 없거나 깨지면 처음 값 · 켜짐, 범위 밖은 잘라', () => {
  assert.deepEqual(readHold(null), { on: true, ms: HOLD_BASE });
  assert.deepEqual(readHold('{bad'), { on: true, ms: HOLD_BASE });
  assert.deepEqual(readHold('{"on":false,"ms":420}'), { on: false, ms: 420 });
  assert.deepEqual(readHold('{"ms":5000}'), { on: true, ms: HOLD_MAX });
});
