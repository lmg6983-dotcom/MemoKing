import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutsChip, snapOutOfChip } from '../app/js/file-chip-guard.js';

const chips = [{ from: 10, to: 20 }];

test('파일 칩: 이름 일부를 바꾸는 편집은 막는다', () => {
  assert.equal(cutsChip(chips, 15, 15), true, '가운데 끼워 넣기');
  assert.equal(cutsChip(chips, 12, 14), true, '가운데 삭제');
  assert.equal(cutsChip(chips, 19, 20), true, '끝 글자 삭제');
  assert.equal(cutsChip(chips, 5, 12), true, '앞에서 걸쳐 삭제');
});

test('파일 칩: 통째로 삭제 · 경계에 쓰기 · 칩 밖은 된다', () => {
  assert.equal(cutsChip(chips, 10, 20), false);
  assert.equal(cutsChip(chips, 5, 25), false);
  assert.equal(cutsChip(chips, 10, 10), false, '칩 바로 앞에 쓰기');
  assert.equal(cutsChip(chips, 20, 20), false, '칩 바로 뒤에 쓰기');
  assert.equal(cutsChip(chips, 0, 5), false);
  assert.equal(cutsChip([], 3, 4), false);
});

test('파일 칩: 커서는 칩 앞뒤에만 — 끝에서 한 칸 들어오면 건너편, 누른 자리는 가까운 끝', () => {
  assert.equal(snapOutOfChip(chips, 11, 10), 20, '앞에서 → 는 칩 뒤로');
  assert.equal(snapOutOfChip(chips, 19, 20), 10, '뒤에서 ← 는 칩 앞으로');
  assert.equal(snapOutOfChip(chips, 13, 3), 10, '멀리서 누른 것: 가까운 앞');
  assert.equal(snapOutOfChip(chips, 17, 3), 20, '멀리서 누른 것: 가까운 뒤');
  assert.equal(snapOutOfChip(chips, 15, -Infinity), 20, '오른쪽으로 고르는 중');
  assert.equal(snapOutOfChip(chips, 15, Infinity), 10, '왼쪽으로 고르는 중');
  assert.equal(snapOutOfChip(chips, 10, 3), 10, '칩 앞뒤는 그대로');
  assert.equal(snapOutOfChip(chips, 12, null), 10, '화살표가 아니면(누르기) 가까운 끝');
  assert.equal(snapOutOfChip(chips, 5, 3), 5);
});
