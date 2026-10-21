import test from 'node:test';
import assert from 'node:assert/strict';
import { findInText, stepMatch, findCountText, hasFormat, formatSummary, marksMatch, rangeMatches, formatRuns, snippet } from '../app/js/core/find.js';

test('찾기: 대소문자 구분 없이 기본, 겹치지 않게 앞에서부터', () => {
  assert.deepEqual(findInText('Apple apple APPLE', 'apple'), [[0, 5], [6, 11], [12, 17]]);
  assert.deepEqual(findInText('Apple apple APPLE', 'apple', { caseSensitive: true }), [[6, 11]]);
  assert.deepEqual(findInText('aaaa', 'aa'), [[0, 2], [2, 4]], '겹치지 않게');
  assert.deepEqual(findInText('메모', ''), []);
  assert.deepEqual(findInText('', '메모'), []);
});

test('찾기: 낱말 단위 (한글 · 영어) — "메모"를 찾을 때 "메모킹"은 빼고', () => {
  assert.deepEqual(findInText('메모킹 메모, 메모장 (메모)', '메모', { wholeWord: true }), [[4, 6], [13, 15]]);
  assert.deepEqual(findInText('pineapple apple apples', 'apple', { wholeWord: true }), [[10, 15]]);
  assert.deepEqual(findInText('a_b a b', 'a', { wholeWord: true }), [[4, 5]], '밑줄은 낱말 글자');
});

test('다음 · 이전 찾은 곳: 커서 다음 · 앞, 끝에서는 처음 · 마지막으로 돌아감', () => {
  const m = [{ from: 5 }, { from: 20 }, { from: 40 }];
  assert.equal(stepMatch(m, 0, 1), 0);
  assert.equal(stepMatch(m, 21, 1), 2);
  assert.equal(stepMatch(m, 41, 1), 0, '끝을 넘으면 처음');
  assert.equal(stepMatch(m, 20, -1), 0);
  assert.equal(stepMatch(m, 5, -1), 2, '처음 앞이면 마지막');
  assert.equal(stepMatch([], 0, 1), -1);
});

test('찾은 개수 글', () => {
  assert.equal(findCountText(2, 12, '메모'), '3/12');
  assert.equal(findCountText(-1, 0, '메모'), '없음');
  assert.equal(findCountText(-1, 0, ''), '');
});

test('서식 찾기: 고른 서식이 모두 있어야 · 색은 상관없음 · 아무 색 · 그 색', () => {
  const bold = [{ name: 'strong' }];
  const boldRed = [{ name: 'strong' }, { name: 'mk_color', color: '#E03131' }];
  assert.equal(hasFormat({}), false);
  assert.equal(hasFormat({ highlight: 'any' }), true);
  assert.equal(marksMatch([], {}), true, '서식을 안 고르면 모두 맞음');
  assert.equal(marksMatch(bold, { bold: true }), true);
  assert.equal(marksMatch(bold, { bold: true, italic: true }), false);
  assert.equal(marksMatch(boldRed, { color: 'any' }), true);
  assert.equal(marksMatch(boldRed, { color: '#e03131' }), true, '색 값은 대소문자 무시');
  assert.equal(marksMatch(boldRed, { color: '#1971c2' }), false);
  assert.equal(marksMatch(bold, { color: 'any' }), false);
});

test('서식 찾기: 찾은 자리의 글자가 모두 그 서식 · 찾을 말 없이 서식만이면 이어진 덩어리', () => {
  // "보통굵게굵게" — 0~2 보통, 2~4 굵게, 4~6 굵게+기울임, 6 그림
  const segs = [
    { start: 0, end: 2, text: true, marks: [] },
    { start: 2, end: 4, text: true, marks: [{ name: 'strong' }] },
    { start: 4, end: 6, text: true, marks: [{ name: 'strong' }, { name: 'emphasis' }] },
    { start: 6, end: 7, text: false, marks: [] },
  ];
  assert.equal(rangeMatches(segs, 2, 6, { bold: true }), true);
  assert.equal(rangeMatches(segs, 1, 3, { bold: true }), false, '한 글자라도 아니면 빼기');
  assert.equal(rangeMatches(segs, 5, 7, { bold: true }), false, '그림 칸이 끼면 빼기');
  assert.deepEqual(formatRuns(segs, { bold: true }), [[2, 6]], '이어진 굵은 글은 한 덩어리');
  assert.deepEqual(formatRuns(segs, { italic: true }), [[4, 6]]);
  assert.deepEqual(formatRuns(segs, {}), []);
});

test('서식 글 · 모두 찾기 목록 줄', () => {
  assert.equal(formatSummary({ bold: true, color: '#e03131', highlight: 'any' }), '굵게, 빨강 글자 색, 형광펜');
  assert.equal(formatSummary({ clear: true, highlight: '#ffec99' }), '서식 지우기, 노랑 형광펜');
  assert.equal(formatSummary({}), '');
  const s = snippet('가나다라마바사아자차카타파하 메모 끝', 15, 17, 4);
  assert.deepEqual([s.before, s.hit, s.after, s.cutStart], ['타파하 ', '메모', ' 끝', true]);
});
