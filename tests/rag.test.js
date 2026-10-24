import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMemo, retrieve, ragMessages, expandResult } from '../app/js/core/rag.js';

const memo = (id, title, text) => ({ id, title, text: `${title}\n${text}` });

test('AI 검색: 메모를 조각으로 (첫 조각에 제목)', () => {
  const body = `# 출시 계획\n\n${'가나다라마 '.repeat(100)}\n\n두 번째 줄`;
  const chunks = chunkMemo(body);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].startsWith('출시 계획\n'));
  assert.deepEqual(chunkMemo('# 제목만'), ['제목만']);
});

test('AI 검색: 넓힌 낱말로 찾고, 연결된 메모를 더한다', () => {
  const chunks = [
    memo('a', '주간 회의', '출시일은 11월 3일로 정했어요'),
    memo('b', '장보기', '우유 계란 대파'),
    memo('c', '디자인 시안', '두 번째 시안을 고르기로'),
    memo('d', '배포 일정', '런칭 날짜 공지 초안'),
  ];
  const related = (id) => (id === 'a' ? [{ id: 'c', score: 0.8 }] : []);
  // "언제 내놓아" 만으로는 못 찾고, 넓힌 낱말(출시일 · 런칭)로 a · d, 연결로 c
  assert.deepEqual(retrieve('언제 내놓아', chunks, { related }), []);
  const got = retrieve('언제 내놓아', chunks, { words: ['출시일', '런칭'], related, limit: 2 });
  assert.deepEqual(got.map((m) => m.id).sort(), ['a', 'c', 'd']);
  assert.equal(got.find((m) => m.id === 'c').via, 'graph');
  assert.equal(retrieve('우유', chunks)[0].id, 'b');
});

test('AI 검색: 넓힌 낱말 답 — 엉뚱하면 빈 목록, 6개까지', () => {
  assert.deepEqual(expandResult('{"words":[" 출시일 ","",3]}'), ['출시일', '3']);
  assert.deepEqual(expandResult('엉뚱한 답'), []);
  assert.equal(expandResult(JSON.stringify({ words: Array(9).fill('가') })).length, 6);
});

test('AI 검색: 답은 번호 붙인 메모만 근거로', () => {
  const m = ragMessages('출시일?', [{ title: '주간 회의', texts: ['출시일은 11월 3일'] }]);
  assert.match(m[0].content, /찾지 못했어요/);
  assert.match(m[1].content, /\[1\] 주간 회의\n출시일은 11월 3일/);
  assert.match(m[1].content, /질문: 출시일\?/);
});
