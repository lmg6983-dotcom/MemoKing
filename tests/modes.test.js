import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoFile, serializeMemoFile, normalizeMode } from '../app/js/core/memo-file.js';
import { splitByMode, memoMode, otherMode, moveLabel, validMode } from '../app/js/core/modes.js';

test('Work / Life: 적지 않은 메모는 Life, work 만 Work', () => {
  assert.equal(normalizeMode(undefined), 'life');
  assert.equal(normalizeMode('Work'), 'work');
  assert.equal(normalizeMode('office'), 'life');
  assert.equal(validMode('x'), 'life');
  assert.equal(otherMode('work'), 'life');
  assert.equal(memoMode({}), 'life');
});

test('Work / Life: 머리말에 Work 만 적고 다시 읽으면 그대로', () => {
  const work = parseMemoFile('---\nid: a\nmode: work\n---\n# 회의\n');
  assert.equal(work.meta.mode, 'work');
  const out = serializeMemoFile(work.meta, work.body);
  assert.match(out, /^mode: work$/m);
  assert.equal(parseMemoFile(out).meta.mode, 'work');
  const life = parseMemoFile('---\nid: b\n---\n# 일기\n');
  assert.equal(life.meta.mode, 'life');
  assert.doesNotMatch(serializeMemoFile(life.meta, life.body), /mode:/);
  assert.equal(Object.keys(work.meta.extra).length, 0, 'mode 는 모르는 항목(extra)으로 두 번 쓰지 않는다');
});

test('Work / Life: 지금 모드의 메모와 다른 모드 수', () => {
  const memos = [{ id: 1, mode: 'work' }, { id: 2 }, { id: 3, mode: 'life' }, { id: 4, mode: 'work' }];
  assert.deepEqual(splitByMode(memos, 'work').mine.map((m) => m.id), [1, 4]);
  assert.equal(splitByMode(memos, 'work').other, 2);
  assert.equal(splitByMode(memos, 'life').mine.length, 2);
  assert.equal(moveLabel({ mode: 'work' }), 'Life로 옮기기');
  assert.equal(moveLabel({}), 'Work로 옮기기');
});
