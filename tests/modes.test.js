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

test('정리 도우미: 일 이야기 같은 Life 메모를 점수 순으로', async () => {
  const { suggestWork } = await import('../app/js/core/mode-helper.js');
  const memos = [
    { id: 'a', title: '팀 회의록', preview: '다음 분기 예산', tags: ['업무'] },
    { id: 'b', title: '장보기', preview: '우유, 계란', tags: [] },
    { id: 'c', title: '여행 계획', preview: '출장 겸 부산', tags: [] },
    { id: 'd', title: '회의', preview: '', tags: [], mode: 'work' },
    { id: 'e', title: '일기', preview: '오늘 회의가 길었다', tags: [] },
  ];
  const s = suggestWork(memos);
  assert.deepEqual(s.map((x) => x.memo.id), ['a'], '본문 낱말 하나(1점)만으로는 권하지 않는다');
  assert.ok(s[0].reasons.includes('#업무'));
  const more = suggestWork([...memos, { id: 'f', title: '견적서', preview: '거래처 납품', tags: [] }]);
  assert.deepEqual(more.map((x) => x.memo.id), ['a', 'f']);
});
