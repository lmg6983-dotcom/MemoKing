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
