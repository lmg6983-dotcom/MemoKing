import test from 'node:test';
import assert from 'node:assert/strict';
import { textMatcher, isChoseongQuery } from '../app/js/core/text-match.js';

test('초성만 쓰면 초성 검색', () => {
  assert.ok(textMatcher('ㅈㅂㄱ')('장보기', ''));
  assert.ok(textMatcher('ㅈㅂㄱ')('', '오늘 장 보기 목록')); // 띄어 쓴 글도
  assert.ok(!textMatcher('ㅈㅂㄱ')('회의 메모', '안건'));
  assert.ok(isChoseongQuery('ㄱㄴ') && !isChoseongQuery('가ㄴ') && !isChoseongQuery('abc'));
});

test('보통 검색: 대소문자 무시 · 낱말 모두 · 섞어 쓰기', () => {
  const m = textMatcher('  Example 우유 ');
  assert.ok(m('링크', 'https://example.com 우유 사기'));
  assert.ok(!m('링크', 'https://example.com'));
  assert.ok(textMatcher('ㅇㅇ 계란')('장보기', '우유, 계란'));
  assert.ok(textMatcher('')('아무거나'));
});

test('초성 글자 자체가 든 글도 그대로 찾음', () => {
  assert.ok(textMatcher('ㅋㅋ')('', '재밌다 ㅋㅋ'));
});

test('초성 자리: 한글만 초성으로 바꿔 같은 길이, 띄어쓰기는 건너뛰며 원래 글의 자리로', async () => {
  const { choseongAligned, choseongRange } = await import('../app/js/core/text-match.js');
  assert.equal(choseongAligned('견적서 01.txt'), 'ㄱㅈㅅ 01.txt');
  assert.deepEqual(choseongRange('새 견적 서류', 'ㄱㅈㅅ'), [2, 6]);
  assert.deepEqual(choseongRange('장보기', 'ㅈㅂㄱ'), [0, 3]);
  assert.equal(choseongRange('장보기', '장'), null, '초성 검색어가 아니면');
  assert.equal(choseongRange('abc', 'ㄱ'), null);
});

test('초성 위치 (choseongIndex): 띄어쓰기를 뺀 글에서 몇 번째부터, 글을 만들지 않고', async () => {
  const { choseongIndex } = await import('../app/js/core/text-match.js');
  assert.equal(choseongIndex('견적서 01.txt', 'ㄱㅈㅅ'), 0);
  assert.equal(choseongIndex('새 견적 서류', 'ㄱㅈㅅ'), 1);
  assert.equal(choseongIndex('회의 록 모음', 'ㅎㅇㄹㅁㅇ'), 0, '띄어쓰기 건너뜀');
  assert.equal(choseongIndex('report.txt', 'ㄱ'), -1);
  assert.equal(choseongIndex('가나', 'ㄱㄴㄷ'), -1, '끝까지 못 맞으면');
  assert.equal(choseongIndex('ㄱ자', 'ㄱㅈ'), 0, '자음 글자는 그대로');
});
