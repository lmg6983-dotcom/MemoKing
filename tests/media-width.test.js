// 사진 · 동영상 크기 표시 (설명 끝의 "|50%") — 메모 파일에 저장되는 형식이라 읽기 · 쓰기가 서로 맞아야 한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaWidthOf, plainAlt, withMediaWidth } from '../app/js/core/memo-file.js';

test('크기 읽기: 15~99% 만, 그 밖이나 없으면 null', () => {
  assert.equal(mediaWidthOf('사진|50%'), 50);
  assert.equal(mediaWidthOf('사진|15%'), 15);
  assert.equal(mediaWidthOf('사진|99%'), 99);
  assert.equal(mediaWidthOf('사진|100%'), null); // 꽉 참 = 크기 없음
  assert.equal(mediaWidthOf('사진|5%'), null); // 너무 작은 값은 무시
  assert.equal(mediaWidthOf('사진'), null);
  assert.equal(mediaWidthOf(''), null);
  assert.equal(mediaWidthOf(undefined), null);
  assert.equal(mediaWidthOf('a|b 50%'), null); // 끝이 "|숫자%" 가 아니면 크기가 아니다
});

test('설명만: 끝의 크기 표시만 뺀다 (설명 속 | 는 그대로)', () => {
  assert.equal(plainAlt('사진|50%'), '사진');
  assert.equal(plainAlt('A|B'), 'A|B');
  assert.equal(plainAlt('A|B|30%'), 'A|B');
  assert.equal(plainAlt(null), '');
});

test('크기 쓰기: 읽기와 왕복 · 100% 이상이나 없음이면 표시를 지운다 · 이미 있던 표시는 바꾼다', () => {
  assert.equal(withMediaWidth('사진', 50), '사진|50%');
  assert.equal(mediaWidthOf(withMediaWidth('사진', 33.4)), 33);
  assert.equal(withMediaWidth('사진|50%', 75), '사진|75%');
  assert.equal(withMediaWidth('사진|50%', 100), '사진');
  assert.equal(withMediaWidth('사진|50%', null), '사진');
  assert.equal(withMediaWidth('사진', 10), '사진'); // 너무 작으면 크기 없음
  assert.equal(withMediaWidth('', 40), '|40%');
  assert.equal(mediaWidthOf(withMediaWidth('', 40)), 40);
});
