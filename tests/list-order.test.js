import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewOrder, dropAt } from '../app/js/core/list-order.js';

test('끌어 놓기: 가운데는 맞바꾸기, 위·아래 가장자리는 그 앞·뒤에 끼우기', () => {
  assert.deepEqual(dropAt(2, 0.5), { kind: 'swap', index: 2 });
  assert.deepEqual(dropAt(2, 0.1), { kind: 'insert', index: 2 });
  assert.deepEqual(dropAt(2, 0.9), { kind: 'insert', index: 3 });
});

test('미리 보기 순서: 맞바꾸기는 두 항목만 자리를 바꾼다', () => {
  assert.deepEqual(previewOrder(4, 0, { kind: 'swap', index: 2 }), [2, 1, 0, 3]);
  assert.deepEqual(previewOrder(4, 3, { kind: 'swap', index: 0 }), [3, 1, 2, 0]);
  assert.deepEqual(previewOrder(3, 1, { kind: 'swap', index: 1 }), [0, 1, 2]);
});

test('미리 보기 순서: 끼우기는 사이에 넣고 나머지는 밀린다', () => {
  assert.deepEqual(previewOrder(4, 0, { kind: 'insert', index: 3 }), [1, 2, 0, 3]); // 셋째와 넷째 사이
  assert.deepEqual(previewOrder(4, 0, { kind: 'insert', index: 4 }), [1, 2, 3, 0]); // 맨 끝
  assert.deepEqual(previewOrder(4, 3, { kind: 'insert', index: 0 }), [3, 0, 1, 2]); // 맨 앞
  assert.deepEqual(previewOrder(4, 2, { kind: 'insert', index: 2 }), [0, 1, 2, 3]); // 제자리
  assert.deepEqual(previewOrder(4, 1, null), [0, 1, 2, 3]);
});
