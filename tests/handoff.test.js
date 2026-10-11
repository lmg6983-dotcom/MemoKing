import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffFrom, handoffText } from '../app/js/core/handoff.js';
import { parseMemoFile, serializeMemoFile } from '../app/js/core/memo-file.js';

const now = Date.parse('2026-10-10T12:00:00+09:00');
const memo = (device, updated = '2026-10-10T11:58:00+09:00') => ({ id: 'a', device, updated });

test('다른 기기에서 방금 고친 메모만', () => {
  assert.equal(handoffFrom(memo('phone'), { mine: 'pc', now }), '휴대폰');
  assert.equal(handoffFrom(memo('pc'), { mine: 'phone', now }), 'PC');
  assert.equal(handoffFrom(memo('ai'), { mine: 'pc', now }), 'AI 비서');
  assert.equal(handoffFrom(memo('pc'), { mine: 'pc', now }), null, '내가 고친 것');
  assert.equal(handoffFrom(memo(null), { mine: 'pc', now }), null, '예전 파일 (device 없음)');
  assert.equal(handoffFrom(memo('phone', '2026-10-10T11:30:00+09:00'), { mine: 'pc', now }), null, '오래전');
});

test('같은 고침은 한 번만', () => {
  const seen = new Set();
  assert.equal(handoffFrom(memo('phone'), { mine: 'pc', now, seen }), '휴대폰');
  assert.equal(handoffFrom(memo('phone'), { mine: 'pc', now, seen }), null);
  assert.equal(handoffFrom(memo('phone', '2026-10-10T11:59:00+09:00'), { mine: 'pc', now, seen }), '휴대폰', '새로 또 고침');
  assert.equal(handoffText('휴대폰', '장보기'), '휴대폰에서 방금 고친 메모: 장보기');
});

test('머리말 device 가 파일에 남고 다시 읽힌다', () => {
  const text = serializeMemoFile({ id: 'a', created: 'x', updated: 'y', color: 'yellow', device: 'phone', extra: {} }, '# 제목');
  assert.match(text, /\ndevice: phone\n/);
  assert.equal(parseMemoFile(text).meta.device, 'phone');
  assert.equal(parseMemoFile('---\nid: a\ndevice: toaster\n---\n# t').meta.device, null);
});

test('pickHandoff: 열어 둔 메모는 본 것으로만 치고, 다른 메모 하나를 고름', async () => {
  const { pickHandoff } = await import('../app/js/core/handoff.js');
  const now = Date.parse('2026-10-11T10:00:00+09:00');
  const m = (id) => ({ id, file: `${id}.md`, device: 'phone', updated: '2026-10-11T09:58:00+09:00', title: id });
  const seen = new Set();
  const hit = pickHandoff([m('a'), m('b'), m('c')], { mine: 'pc', seen, now, isOpen: (id) => id === 'a' });
  assert.equal(hit.memo.id, 'b');
  assert.equal(pickHandoff([m('a')], { mine: 'pc', seen, now }), null, '열어 둔 동안 본 메모는 닫은 뒤에도 다시 뜨지 않음');
});
