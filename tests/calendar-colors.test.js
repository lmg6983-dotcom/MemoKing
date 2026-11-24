// 다른 캘린더 색 — 캘린더 이름으로: 같은 이름은 어느 기기에서나 같은 색, 이 기기의 캘린더끼리는 겹치지 않게
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarColors, calendarColorOf, MEMO_DOT, nearestMemoColor } from '../app/js/core/memo-colors.js';

const names = ['결혼기념일', '대한민국의 휴일', '제일특허', '가족', '행복이', '업무', '개인'];

test('7개까지는 캘린더마다 다른 메모 색', () => {
  const colors = calendarColors(names);
  assert.equal(new Set(colors.values()).size, names.length);
  for (const c of colors.values()) assert.ok(Object.values(MEMO_DOT).includes(c) && MEMO_DOT[nearestMemoColor(c)] === c);
});

test('목록 차례가 달라도(PC · 휴대폰) 같은 이름은 같은 색', () => {
  const a = calendarColors(names);
  const b = calendarColors([...names].reverse().concat(names[0], ''));
  for (const n of names) assert.equal(a.get(n), b.get(n));
});

test('8개부터는 다시 돈다 · 목록에 없는 이름도 색이 있다', () => {
  const colors = calendarColors([...names, '하나 더']);
  assert.equal(colors.size, 8);
  assert.ok(Object.values(MEMO_DOT).includes(calendarColorOf('없는 캘린더', colors)));
  assert.equal(calendarColorOf('업무', colors), colors.get('업무'));
});
