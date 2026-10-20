import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMemories, memoryDay, monthSummary, neighborDays, dayKey } from '../app/js/core/memories.js';

const local = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
const memos = [
  { id: 'a', title: '바다', created: local(2026, 10, 3, 9), images: ['attachments/a1.jpg', 'attachments/a2.jpg'], tags: ['여행'] },
  { id: 'b', title: '저녁', created: local(2026, 10, 3, 20), preview: '회 먹음', tags: ['여행', '데이트'] },
  { id: 'c', title: '나중에 쓴 일기', created: local(2026, 10, 9), day: '2026-10-04', images: ['attachments/c.jpg'] },
  { id: 'd', title: '회의', created: local(2026, 10, 5), tags: ['업무'] },
  { id: 'e', title: '잠긴 메모', created: local(2026, 10, 5), locked: true },
  { id: 'f', title: '', preview: '', created: local(2026, 10, 6) },
  { id: 'g', title: '다음 달', created: local(2026, 11, 1), images: ['attachments/g.jpg'] },
];

test('추억: 정한 날이 있으면 그날, 없으면 만든 날 (현지 날짜)', () => {
  assert.equal(memoryDay(memos[0]), '2026-10-03');
  assert.equal(memoryDay(memos[2]), '2026-10-04');
  assert.equal(memoryDay({ id: 'x' }), null);
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
});

test('추억: 날마다 메모(쓴 순서) · 사진 모음, 잠긴 · 빈 메모와 범위 밖은 빼고', () => {
  const days = collectMemories(memos, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual([...days.keys()], ['2026-10-03', '2026-10-04', '2026-10-05']);
  const d3 = days.get('2026-10-03');
  assert.deepEqual(d3.memos.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(d3.photos.map((p) => p.src), ['attachments/a1.jpg', 'attachments/a2.jpg']);
  assert.deepEqual(days.get('2026-10-05').memos.map((m) => m.id), ['d'], '잠긴 메모는 빼고');
});

test('추억: 태그를 고르면 그 태그가 붙은 메모만 (대소문자 무시)', () => {
  const days = collectMemories(memos, { tags: ['데이트'] });
  assert.deepEqual([...days.keys()], ['2026-10-03']);
  assert.deepEqual(days.get('2026-10-03').memos.map((m) => m.id), ['b']);
});

test('추억: 한 달 요약 · 앞뒤 날', () => {
  const days = collectMemories(memos, { from: '2026-10-01', to: '2026-10-31' });
  const s = monthSummary(days);
  assert.equal(s.days, 3);
  assert.equal(s.photos, 3);
  assert.deepEqual(s.cover.map((p) => p.src), ['attachments/a1.jpg', 'attachments/c.jpg']);
  assert.deepEqual(s.tags.map((t) => t.name), ['여행', '데이트', '업무']);
  assert.deepEqual(neighborDays(days, '2026-10-04'), { prev: '2026-10-03', next: '2026-10-05' });
  assert.deepEqual(neighborDays(days, '2026-10-03'), { prev: null, next: '2026-10-04' });
});

test('추억: 표지 사진은 많으면 고르게 max 장', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, title: `t${i}`, created: local(2026, 10, i + 1), images: [`attachments/${i}.jpg`] }));
  const s = monthSummary(collectMemories(many), 5);
  assert.deepEqual(s.cover.map((p) => p.src), ['attachments/0.jpg', 'attachments/4.jpg', 'attachments/8.jpg', 'attachments/12.jpg', 'attachments/16.jpg']);
});

test('추억: 머리말 day — 읽고 쓰기 · 잘못된 날짜는 버림', async () => {
  const { parseMemoFile, serializeMemoFile, normalizeDay } = await import('../app/js/core/memo-file.js');
  const { meta, body } = parseMemoFile('---\nid: a\ncolor: blue\nday: 2026-10-03\n---\n# 일기\n');
  assert.equal(meta.day, '2026-10-03');
  assert.match(serializeMemoFile(meta, body), /\nday: 2026-10-03\n/);
  assert.doesNotMatch(serializeMemoFile({ ...meta, day: '' }, body), /day:/);
  assert.equal(normalizeDay('2026-02-30'), '');
  assert.equal(normalizeDay('어제'), '');
  assert.equal(parseMemoFile('---\nid: a\n---\nx').meta.day, '');
});
