// OPMS 사건 찾기: 무엇으로 찾는지 · 이름 나누기 · 초성 이름 고르기 · 정확한 것부터 (app/js/core/opms-search.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opmsQueryKind, looksLikeOpmsQuery, splitNames, matchChoseongNames, rankCases, matchedInventor } from '../app/js/core/opms-search.js';

test('무엇으로 찾나: 번호(일부도) · 이름 · 초성, 문장 · 긴 글 · 한 글자는 묻지 않음', () => {
  for (const q of ['FPD/2026-0271/E', '0271', '1020260012345', '2026-0012', 'P-1234', '10-2026']) assert.equal(opmsQueryKind(q), 'ref', q);
  for (const q of ['홍길동', '홍길', '메모킹', '메모킹 홍길동', 'Samsung', 'FPD', '(주)메모킹']) assert.equal(opmsQueryKind(q), 'name', q);
  for (const q of ['ㅎㄱㄷ', 'ㅁㅁㅋ', 'ㅎㄱ ㄷ']) assert.equal(opmsQueryKind(q), 'choseong', q);
  for (const q of ['', '홍', 'ㅎ', '12', 'ab', '내일 오후 3시까지 보고서 정리해서 보내기', '첫 줄\n홍길동', '이것 저것 그것 요것', '회의 준비?']) assert.equal(opmsQueryKind(q), null, q);
  assert.ok(looksLikeOpmsQuery('홍길동') && !looksLikeOpmsQuery('a'));
});

test('이름 칸 나누기: 쉼표 · 세미콜론 · 줄바꿈 · 및', () => {
  assert.deepEqual(splitNames('홍길동, 김철수;이영희\n박민수 및 최지우'), ['홍길동', '김철수', '이영희', '박민수', '최지우']);
  assert.deepEqual(splitNames('메모킹 주식회사'), ['메모킹 주식회사']);
  assert.deepEqual(splitNames(''), []);
});

test('초성 이름 고르기: 첫머리부터 · 이름 전부 맞는 것 · 짧은 것이 앞, (주) · 주식회사는 빼고 비교', () => {
  const names = ['김홍길동', '홍길동', '홍길순', '메모킹 주식회사', '(주)메모킹전자', '홍길동', '박해길동'];
  assert.deepEqual(matchChoseongNames(names, 'ㅎㄱㄷ'), ['홍길동', '김홍길동', '박해길동'], '가운데 맞은 것(해길동)도 뒤에');
  assert.deepEqual(matchChoseongNames(names, 'ㅎㄱ').slice(0, 2), ['홍길동', '홍길순']);
  assert.deepEqual(matchChoseongNames(names, 'ㅁㅁㅋ'), ['메모킹 주식회사', '(주)메모킹전자']);
  assert.deepEqual(matchChoseongNames(names, '홍길'), [], '초성 검색어가 아니면');
});

test('정확한 것부터: 번호는 같음 > 첫머리 > 끝자리 > 일부, 같으면 최근 접수', () => {
  const rows = [
    { idx: '1', ourref: 'FPD/2026-0271/D', n_app: '10-2026-0099999', d_accept: '2026-01-09' },
    { idx: '2', ourref: 'FPD/2026-1027/E', n_app: '10-2026-0012345', d_accept: '2026-03-01' },
    { idx: '3', ourref: '0271', n_app: '', d_accept: '2025-01-01' },
    { idx: '4', ourref: 'P-9', n_app: '10-2025-0000271', d_accept: '2025-05-05' },
  ];
  assert.deepEqual(rankCases(rows.map((r) => ({ ...r })), '0271').map((r) => r.idx), ['3', '4', '1', '2'], '같음 · 출원번호 끝자리 · 관리번호 일부 · (2 는 "1027" 이라 안 맞음)');
  assert.equal(rankCases(rows.map((r) => ({ ...r })), '0271').at(-1)._score, 0);
  assert.deepEqual(rankCases(rows.map((r) => ({ ...r })), 'FPD2026').map((r) => r.idx).slice(0, 2), ['2', '1'], '첫머리가 같으면 최근 접수가 앞');
});

test('정확한 것부터: 이름은 같음 > 첫머리 > 일부, 출원인이 발명자보다 조금 앞, 낱말 모두 맞아야', () => {
  const rows = [
    { idx: 'a', applicant: '김홍길동', inventor: '', d_accept: '2026-05-01' },
    { idx: 'b', applicant: '메모킹 주식회사', inventor: '홍길동, 김철수', d_accept: '2026-01-01' },
    { idx: 'c', applicant: '홍길동', inventor: '', d_accept: '2025-01-01' },
    { idx: 'd', applicant: '홍길동산업', inventor: '', d_accept: '2026-02-01' },
  ];
  assert.deepEqual(rankCases(rows.map((r) => ({ ...r })), '홍길동').map((r) => r.idx), ['c', 'b', 'd', 'a']);
  assert.deepEqual(rankCases(rows.map((r) => ({ ...r })), '메모킹 홍길동').filter((r) => r._score).map((r) => r.idx), ['b']);
  assert.deepEqual(rankCases(rows.map((r) => ({ ...r })), 'ㅎㄱㄷ').map((r) => r.idx).slice(0, 2), ['c', 'b'], '초성: 이름 전부 맞는 것부터');
  assert.equal(rankCases([{ idx: 'x', applicant: '메모킹 주식회사' }], '메모킹')[0]._score, 90, '주식회사는 빼고 같은 이름');
});

test('사건 줄의 발명자: 이름 · 초성으로 찾았고 발명자 칸에서 맞았을 때만', () => {
  const r = { applicant: '메모킹 주식회사', inventor: '김철수, 홍길동' };
  assert.equal(matchedInventor(r, '홍길동'), '홍길동');
  assert.equal(matchedInventor(r, 'ㅎㄱㄷ'), '홍길동');
  assert.equal(matchedInventor(r, '메모킹'), '');
  assert.equal(matchedInventor(r, '0271'), '');
});

test('저절로 묻는 것은 온전한 사건번호뿐: 출원번호 전체 · 관리번호 꼴, 전화번호 · 날짜 · 일부 번호 · 글은 아님', async () => {
  const { isExactCaseRef } = await import('../app/js/core/opms-search.js');
  for (const q of ['10-2026-0012345', '1020260012345', '2026-0012345', 'FPD/2026-0271/E', 'P2026-1170-KR01', 'P20261170KR01', 'P-12345']) assert.ok(isExactCaseRef(q), q);
  for (const q of ['010-1234-5678', '2026-10-22', '0271', '0012345', '2026년 회의록', 'FPD', 'P-12', '홍길동', 'abc', 'FPD 2026-0271', '12345678']) assert.ok(!isExactCaseRef(q), q);
});
