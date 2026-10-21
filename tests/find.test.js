import test from 'node:test';
import assert from 'node:assert/strict';
import { findInText, stepMatch, findCountText } from '../app/js/core/find.js';

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
