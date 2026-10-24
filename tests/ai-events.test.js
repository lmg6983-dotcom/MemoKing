import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventCandidates, aiEventRequest, aiEventResult, nextSeen } from '../app/js/core/ai-events.js';

const now = new Date(2026, 9, 24, 10, 0); // 2026-10-24 (토) 오전 10시

test('일정 후보: 앞으로의 날짜가 있는 줄만, 본 줄은 빼고', () => {
  const body = '# 메모\n\n내일 오후 3시 김 부장 견적 미팅\n어제 3시 회의는 잘 끝남\n내일 비 온대\n그냥 글';
  const c = eventCandidates(body, [], now);
  assert.deepEqual(c.map((x) => x.line), ['내일 오후 3시 김 부장 견적 미팅', '내일 비 온대']);
  assert.equal(c[0].date.at.getDate(), 25);
  assert.deepEqual(eventCandidates(body, nextSeen([], c), now), []);
});

test('일정 고르기: AI 가 고른 번호만, 이름이 비면 줄에서 짐작, 이미 있는 때 · 겹친 번호는 빼고', () => {
  const c = eventCandidates('내일 오후 3시 견적 미팅\n내일 비 온대\n매주 월요일 10시 주간 회의', [], now);
  const { schema } = aiEventRequest(c);
  assert.equal(schema.properties.events.items.properties.n.maximum, 3);
  const json = JSON.stringify({ events: [{ n: 1, title: '견적 미팅' }, { n: 1, title: '또' }, { n: 3, title: '' }, { n: 9, title: '없는 줄' }] });
  const out = aiEventResult(json, c, [], now);
  assert.deepEqual(out.map((r) => [r.kind, r.title]), [['at', '견적 미팅'], ['repeat', '주간 회의']]);
  assert.deepEqual(out[0].alerts, [10]); // 매직키 알림 맞춰 저장과 같은 기본값
  assert.equal(aiEventResult(json, c, [out[0]], now).length, 1); // 같은 때 일정이 이미 있으면 빼고
  assert.deepEqual(aiEventResult('엉뚱한 답', c, [], now), []);
});

test('일정 자동 등록: "내일" 은 쓴 때 기준, 이미 지난 때는 넣지 않는다', async () => {
  const { createAiTasks } = await import('../app/js/core/ai-tasks.js');
  const tasks = createAiTasks({ ai: { chat: async () => '{"events":[{"n":1,"title":"치과"}]}' }, memos: () => [], graph: () => [] });
  const body = '내일 오후 3시 치과';
  // 휴대폰에서 어젯밤 11시 반에 쓴 메모를 오늘 0시 반에 봄 → 오늘 오후 3시 (하루 밀리지 않음)
  const late = await tasks.autoEvents(body, { now: new Date(2026, 9, 25, 0, 30), written: new Date(2026, 9, 24, 23, 30) });
  assert.equal(new Date(late.events[0].at).getDate(), 25);
  // 그저께 쓴 "내일" 은 이미 지났다
  const old = await tasks.autoEvents(body, { now, written: new Date(2026, 9, 22, 9, 0) });
  assert.deepEqual(old.events, []);
  assert.deepEqual(old.seen, [body]);
});
