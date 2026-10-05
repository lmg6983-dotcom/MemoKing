import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remarkEmptyTasks } from '../app/js/core/empty-tasks.js';

const item = (text, checked = null) => ({ type: 'listItem', checked, children: [{ type: 'paragraph', children: text == null ? [] : [{ type: 'text', value: text }] }] });

test('빈 체크리스트 항목: "[ ]" 글자로 읽힌 항목을 빈 체크리스트로', () => {
  const tree = { type: 'root', children: [{ type: 'list', children: [item('a', false), item('[ ]'), item('[x]'), item('[ ] 글'), item('그냥')] }] };
  remarkEmptyTasks()(tree);
  const [a, b, c, d, e] = tree.children[0].children;
  assert.equal(a.checked, false);
  assert.equal(b.checked, false);
  assert.deepEqual(b.children[0].children, []);
  assert.equal(c.checked, true);
  assert.equal(d.checked, null); // 글이 있는 것은 그대로
  assert.equal(e.checked, null);
});
