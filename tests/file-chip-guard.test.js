import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutsChip } from '../app/js/file-chip-guard.js';

const chips = [{ from: 10, to: 20 }];

test('파일 칩: 이름 일부를 바꾸는 편집은 막는다', () => {
  assert.equal(cutsChip(chips, 15, 15), true, '가운데 끼워 넣기');
  assert.equal(cutsChip(chips, 12, 14), true, '가운데 지우기');
  assert.equal(cutsChip(chips, 19, 20), true, '끝 글자 지우기');
  assert.equal(cutsChip(chips, 5, 12), true, '앞에서 걸쳐 지우기');
});

test('파일 칩: 통째로 지우기 · 경계에 쓰기 · 칩 밖은 된다', () => {
  assert.equal(cutsChip(chips, 10, 20), false);
  assert.equal(cutsChip(chips, 5, 25), false);
  assert.equal(cutsChip(chips, 10, 10), false, '칩 바로 앞에 쓰기');
  assert.equal(cutsChip(chips, 20, 20), false, '칩 바로 뒤에 쓰기');
  assert.equal(cutsChip(chips, 0, 5), false);
  assert.equal(cutsChip([], 3, 4), false);
});
