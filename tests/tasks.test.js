import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProgress, isAllClear } from '../app/js/core/tasks.js';

test('체크리스트: 할 일·한 일을 센다 (점·번호 목록, 들여쓴 항목 포함)', () => {
  const md = '# 장보기\n\n- [ ] 우유\n- [x] 계란\n  - [X] 대파\n1. [ ] 두부\n* [x] 김\n- 그냥 항목\n';
  assert.deepEqual(taskProgress(md), { total: 5, done: 3 });
});

test('체크리스트: 코드 블록 안·대괄호만 있는 글은 세지 않는다', () => {
  const md = '```\n- [ ] 코드 안\n```\n- [ ] 진짜\n[ ] 목록 아님\n- [ ]붙어 있음\n~~~\n- [x] 물결 코드\n~~~\n';
  assert.deepEqual(taskProgress(md), { total: 1, done: 0 });
});

test('CLEAR: 체크리스트가 있고 모두 했을 때만', () => {
  assert.equal(isAllClear(taskProgress('- [x] a\n- [x] b')), true);
  assert.equal(isAllClear(taskProgress('- [x] a\n- [ ] b')), false);
  assert.equal(isAllClear(taskProgress('그냥 메모')), false);
  assert.equal(isAllClear(null), false);
});
