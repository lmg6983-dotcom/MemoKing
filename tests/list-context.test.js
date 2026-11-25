import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listContext } from '../app/js/core/list-context.js';
import { UNFILED } from '../app/js/core/folders.js';

test('목록 머리 한 줄: 개수 대신 지금 보는 곳', () => {
  assert.equal(listContext({ shown: 13 }), '모든 메모');
  assert.equal(listContext({ folder: '업무', shown: 3 }), '업무 폴더');
  assert.equal(listContext({ folder: UNFILED, shown: 3 }), '미분류');
  assert.equal(listContext({ folder: '업무', mode: 'work', workLife: true, shown: 3 }), 'Work · 업무 폴더');
  assert.equal(listContext({ mode: 'work', workLife: false, shown: 3 }), '모든 메모');
});

test('목록 머리 한 줄: 검색 · 필터로 좁혔을 때는 찾은 수', () => {
  assert.equal(listContext({ query: '견적', shown: 2 }), "'견적' 찾은 메모 2개");
  assert.equal(listContext({ query: '견적', filters: 1, shown: 2 }), "'견적' 찾은 메모 2개 · 필터 1개");
  assert.equal(listContext({ folder: '업무', filters: 2, shown: 1 }), '업무 폴더 · 필터 2개로 1개');
  assert.equal(listContext({ query: 'ㄱ'.repeat(30), shown: 0 }), `'${'ㄱ'.repeat(20)}…' 찾은 메모 0개`);
});
