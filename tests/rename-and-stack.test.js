import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName } from '../app/js/rename-content.js';
import { StackStore } from '../desktop/stacks.js';

test('이름 변경: 쓸 수 없는 글자는 공백으로, 파일은 확장자를 지킨다', () => {
  assert.equal(cleanName('새:안내*자료', '안내 자료.pdf', true), '새 안내 자료.pdf');
  assert.equal(cleanName('회의록.docx', '안내 자료.pdf', true), '회의록.docx');
  assert.equal(cleanName('  ', '안내 자료.pdf', true), '');
  assert.equal(cleanName('사진 설명', '', false), '사진 설명');
  assert.equal(cleanName('..숨김', 'a.txt', true), '숨김.txt');
});

test('스택: 탭을 끌어 순서 바꾸기', () => {
  const store = new StackStore({ read: () => null, write: () => {} });
  store.merge('a', ['b', 'c']);
  const order = () => store.stackOf('a').memos.join('');
  assert.equal(order(), 'abc');
  assert.ok(store.reorder('c', 0));
  assert.equal(order(), 'cab');
  assert.ok(store.reorder('c', 99), '범위를 넘으면 맨 끝');
  assert.equal(order(), 'abc');
  assert.equal(store.reorder('b', 1), null, '같은 자리면 바뀐 것 없음');
  assert.equal(store.reorder('zzz', 0), null, '스택에 없는 탭');
});
