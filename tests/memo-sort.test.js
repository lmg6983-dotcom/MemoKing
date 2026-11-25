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
  for (const s of ['updated', 'oldest', 'views', 'title']) assert.equal(ids(s)[0], 'c', s);
});

test('정렬: 기준마다', () => {
  assert.equal(ids('updated'), 'cdabe');
  assert.equal(ids('oldest'), 'cebad');
  assert.equal(ids('views'), 'cbade', '본 횟수가 같으면(0) 최신순');
  assert.equal(ids('title'), 'cbaed', '가나다 · 숫자는 크기대로(메모 9 < 메모 10)');
});

test('정렬: 모르는 값은 최신순 · 원래 배열은 그대로', () => {
  assert.equal(ids('nope'), ids('updated'));
  assert.equal(validSort('nope'), 'updated');
  assert.equal(validSort('views'), 'views');
  assert.equal(validSort('created'), 'updated', '없앤 "최근 만든 순" 을 골라 두었으면 최신순으로');
  assert.equal(sortLabel('title'), '이름순 (가나다)');
  assert.equal(memos[0].id, 'a');
});

test('상단 고정 묶음: 나중에 고정한 것이 위, 고정한 때를 모르는 예전 고정은 그 아래 고른 정렬로', () => {
  const list = [
    { id: 'old1', title: '나', updated: '2026-10-05T00:00:00Z', pinned: true },
    { id: 'p1', title: '다', updated: '2026-10-01T00:00:00Z', pinned: true, pinnedAt: '2026-11-01T09:00:00' },
    { id: 'n', title: '가', updated: '2026-10-09T00:00:00Z' },
    { id: 'p2', title: '라', updated: '2026-09-01T00:00:00Z', pinned: true, pinnedAt: '2026-11-10T09:00:00' },
    { id: 'old2', title: '가', updated: '2026-10-04T00:00:00Z', pinned: true },
  ];
  assert.deepEqual(sortMemos(list, 'updated').map((m) => m.id), ['p2', 'p1', 'old1', 'old2', 'n']);
  assert.deepEqual(sortMemos(list, 'title').map((m) => m.id), ['p2', 'p1', 'old2', 'old1', 'n'], '고정 묶음 순서는 정렬과 상관없이 고정한 때');
});

test('정렬: 시각이 완전히 같아도 입력 순서에 따라 흔들리지 않는다 (id 순)', () => {
  const same = [
    { id: 'c', title: '가', updated: '2026-11-23T16:56:00+09:00' },
    { id: 'a', title: '가', updated: '2026-11-23T16:56:00+09:00' },
    { id: 'b', title: '가', updated: '2026-11-23T16:56:00+09:00' },
  ];
  assert.deepEqual(sortMemos(same, 'updated').map((m) => m.id), ['a', 'b', 'c']);
  assert.deepEqual(sortMemos([...same].reverse(), 'updated').map((m) => m.id), ['a', 'b', 'c']);
});
