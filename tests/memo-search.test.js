import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchMemos, snippetOf } from '../app/js/core/memo-search.js';

const memos = [
  { id: 'a', title: '장보기', text: '장보기\n우유 두 팩\n계란', updated: '2026-10-01T09:00:00' },
  { id: 'b', title: '회의록 9월', text: '회의록 9월\n예산 논의 — 우유 값 인상', updated: '2026-10-02T09:00:00' },
  { id: 'c', title: '우유 가격 비교', text: '우유 가격 비교\n마트별 정리', updated: '2026-09-01T09:00:00' },
];

test('메모 검색: 제목에 찾는 말이 있는 메모가 먼저, 그다음 최근 순', () => {
  assert.deepEqual(searchMemos(memos, '우유').map((m) => m.id), ['c', 'b', 'a']);
});

test('메모 검색: 띄어 쓴 낱말은 모두 들어간 메모만 · 본문에서 찾은 줄을 보여 준다', () => {
  const r = searchMemos(memos, '예산 우유');
  assert.deepEqual(r.map((m) => m.id), ['b']);
  assert.equal(r[0].snippet, '예산 논의 — 우유 값 인상');
  assert.deepEqual(searchMemos(memos, '   '), []);
  assert.deepEqual(searchMemos(memos, '없는말'), []);
});

test('메모 검색: 긴 줄은 찾은 말 둘레만', () => {
  const s = snippetOf(`${'가'.repeat(80)} 핵심어 ${'나'.repeat(80)}`, ['핵심어']);
  assert.ok(s.startsWith('…') && s.endsWith('…') && s.includes('핵심어') && s.length <= 62);
});

test('메모 검색: 관리번호는 기호(- / 등)를 빼고도 찾는다', () => {
  const memos = [
    { id: 'a', title: '의견서', text: '사건 P20261170KR01 마감' },
    { id: 'b', title: '보고', text: 'FPD2026080118E 보고서' },
    { id: 'c', title: '하이픈', text: 'P2026-1170-KR01 원본' },
    { id: 'd', title: '다른 것', text: 'P2026-1171-KR01' },
  ];
  assert.deepEqual(searchMemos(memos, 'P2026-1170-KR01').map((m) => m.id).sort(), ['a', 'c']);
  assert.deepEqual(searchMemos(memos, 'FPD/202608-0118/E').map((m) => m.id), ['b']);
  assert.deepEqual(searchMemos(memos, 'P20261170KR01').map((m) => m.id).sort(), ['a', 'c'], '붙여 써도 하이픈 있는 번호를');
  assert.equal(searchMemos(memos, 'a-b').length, 0, '짧은 말은 기호를 빼지 않음');
  assert.equal(snippetOf('첫 줄\n사건 P20261170KR01 마감', ['p2026-1170-kr01']), '사건 P20261170KR01 마감', '찾은 줄을 보여 준다');
});
