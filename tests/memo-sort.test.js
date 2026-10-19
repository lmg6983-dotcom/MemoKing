import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortMemos, validSort, sortLabel } from '../app/js/core/memo-sort.js';

const memos = [
  { id: 'a', title: '나 메모', updated: '2026-10-03T00:00:00Z', created: '2026-10-01T00:00:00Z', views: 2 },
  { id: 'b', title: '가 메모', updated: '2026-10-01T00:00:00Z', created: '2026-10-03T00:00:00Z', views: 9 },
  { id: 'c', title: '다 메모', updated: '2026-10-02T00:00:00Z', created: '2026-10-02T00:00:00Z', views: 0, pinned: true },
  { id: 'd', title: '메모 10', updated: '2026-10-04T00:00:00Z', created: '2026-09-01T00:00:00Z' },
  { id: 'e', title: '메모 9', updated: '2026-09-30T00:00:00Z', created: '2026-09-02T00:00:00Z' },
];
const ids = (sort) => sortMemos(memos, sort).map((m) => m.id).join('');

test('정렬: 고정한 메모는 늘 맨 앞', () => {
  for (const s of ['updated', 'oldest', 'created', 'views', 'title']) assert.equal(ids(s)[0], 'c', s);
});

test('정렬: 기준마다', () => {
  assert.equal(ids('updated'), 'cdabe');
  assert.equal(ids('oldest'), 'cebad');
  assert.equal(ids('created'), 'cbaed');
  assert.equal(ids('views'), 'cbade', '본 횟수가 같으면(0) 최근 수정순');
  assert.equal(ids('title'), 'cbaed', '가나다 · 숫자는 크기대로(메모 9 < 메모 10)');
});

test('정렬: 모르는 값은 최근 수정순 · 원래 배열은 그대로', () => {
  assert.equal(ids('nope'), ids('updated'));
  assert.equal(validSort('nope'), 'updated');
  assert.equal(validSort('views'), 'views');
  assert.equal(sortLabel('title'), '이름순 (가나다)');
  assert.equal(memos[0].id, 'a');
});
