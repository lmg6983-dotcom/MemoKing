import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widgetLines, plainInline, widgetMemo } from '../app/js/core/widget-lines.js';

test('꾸밈 걷어 내기', () => {
  assert.equal(plainInline('**굵게** 와 *기울임* ~~취소~~ `코드` [링크](https://a.b)'), '굵게 와 기울임 취소 코드 링크');
  assert.equal(plainInline('<span style="color:red">빨강</span> <mark>형광</mark>'), '빨강 형광');
  assert.equal(plainInline('![고양이](attachments/a.png)'), '🖼 고양이');
  assert.equal(plainInline('![녹음 10월 4일](attachments/a.m4a)'), '🎙 녹음 10월 4일');
  assert.equal(plainInline('#태그 그대로'), '#태그 그대로');
});

test('줄 종류와 할 일 번호', () => {
  const body = '# 장보기\n\n- [ ] 우유\n- [x] **빵**\n\n```\n- [ ] 코드 안은 할 일 아님\n```\n1. [ ] 달걀\n- 그냥 점\n> 인용\n---\n| a | b |\n|---|---|\n| 1 | 2 |';
  const lines = widgetLines(body);
  assert.deepEqual(lines.filter((l) => l.kind === 'task').map((l) => [l.t, l.done, l.i]), [['우유', false, 0], ['빵', true, 1], ['달걀', false, 2]]);
  assert.deepEqual(lines.map((l) => l.kind), ['h', 'task', 'task', 'text', 'task', 'bullet', 'text', 'text', 'text']);
  assert.equal(lines.at(-1).t, '1 · 2');
});

test('많으면 자르되 할 일 번호는 끝까지 맞게', () => {
  const body = Array.from({ length: 50 }, (_, n) => `- [ ] 할 일 ${n}`).join('\n');
  const lines = widgetLines(body, 10);
  assert.equal(lines.length, 10);
  assert.equal(lines.at(-1).i, 9);
});

test('위젯 메모: 제목과 같은 첫 제목 줄은 빼고', () => {
  const w = widgetMemo({ id: 'a', title: '장보기', body: '# 장보기\n- [ ] 우유', file: '장보기.md', color: 'green' });
  assert.deepEqual(w.lines.map((l) => l.t), ['우유']);
  assert.equal(w.color, 'green');
  assert.equal(w.file, '장보기.md');
});
