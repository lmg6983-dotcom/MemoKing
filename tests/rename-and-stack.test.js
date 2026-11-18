import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName } from '../app/js/rename-content.js';

test('이름 변경: 쓸 수 없는 글자는 공백으로, 파일은 확장자를 지킨다', () => {
  assert.equal(cleanName('새:안내*자료', '안내 자료.pdf', true), '새 안내 자료.pdf');
  assert.equal(cleanName('회의록.docx', '안내 자료.pdf', true), '회의록.docx');
  assert.equal(cleanName('  ', '안내 자료.pdf', true), '');
  assert.equal(cleanName('사진 설명', '', false), '사진 설명');
  assert.equal(cleanName('..숨김', 'a.txt', true), '숨김.txt');
});

