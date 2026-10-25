import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, planResult, appendTargets, memoBody, appendText, splitItems, scheduleQuery, eventsIn, scheduleText, memoDraftResult, summaryBody } from '../app/js/core/agent.js';
import { occurrencesBetween, eventFromDate } from '../app/js/core/reminders.js';
import { createAiTasks } from '../app/js/core/ai-tasks.js';
import { lockBody } from '../app/js/core/memo-lock.js';

const now = new Date(2026, 9, 25, 10, 0); // 2026-10-25 (일) 오전 10시

test('매직 에이전트: 말 모양으로 가르기 — 일정 · 새 메모 · 덧붙이기 · 요약 · 질문', () => {
  const ev = detectIntent('금요일 2시 치과 예약 알려줘', { now });
  assert.equal(ev.action, 'event');
  assert.equal(ev.title, '치과 예약');
  assert.equal(new Date(ev.when.at).getDate(), 30);
  assert.equal(new Date(ev.when.at).getHours(), 14);
  assert.equal(detectIntent('내일 오후 3시 거래처 미팅 일정 등록해줘', { now }).title, '거래처 미팅');
  assert.equal(detectIntent('매주 월요일 9시 주간회의 알림', { now }).when.repeat.every, 'week');
  assert.equal(detectIntent('3시에 깨워줘', { now }).title, '알람');

  const memo = detectIntent('장보기 목록 만들어줘: 우유, 계란, 빵', { now });
  assert.deepEqual([memo.action, memo.title, memo.list, memo.items], ['memo', '장보기', true, ['우유', '계란', '빵']]);
  assert.deepEqual(detectIntent('출시 준비 체크리스트 만들어줘', { now }), { action: 'memo', title: '출시 준비', list: true, items: [], text: '' });

  assert.deepEqual(detectIntent('회의록에 다음 주 발표 추가해줘', { now }), { action: 'append', target: '회의록', content: '다음 주 발표' });
  assert.deepEqual(detectIntent('장보기 메모에 대파랑 두부 추가', { now }), { action: 'append', target: '장보기', content: '대파랑 두부' });
  assert.deepEqual(detectIntent('이번 주 회의 메모 요약해줘', { now }), { action: 'summary', topic: '이번 주 회의' });

  // 질문은 답하기 — 날짜가 들어도 일정을 넣지 않는다
  for (const q of ['출시일 언제야?', '지난주 회의에서 정한 거 뭐였지', '김 부장 전화번호 알려줘', '내일 회의 몇 시야']) {
    assert.equal(detectIntent(q, { now }).action, 'answer', q);
    assert.ok(!detectIntent(q, { now }).unsure, q);
  }
  // 때가 덧붙일 메모로 · 일정 묻기가 일정 넣기로 읽히지 않게 (검수 1)
  assert.deepEqual(['event', '치과 예약'], [detectIntent('금요일 2시에 치과 예약 추가해줘', { now }).action, detectIntent('금요일 2시에 치과 예약 추가해줘', { now }).title]);
  assert.equal(detectIntent('내일 오후 3시에 회의 넣어줘', { now }).action, 'event');
  assert.equal(detectIntent('금요일 치과 예약 몇 시였지?', { now }).action, 'answer');
  assert.equal(detectIntent('정리해 둔 회의 메모 어디 있어?', { now }).action, 'answer');
  // 애매한 명령은 모델에 묻는다
  assert.ok(detectIntent('견적서 보내기 기억해줘', { now }).unsure);
  assert.ok(detectIntent('금요일 3시 치과', { now }).unsure);
});

test('매직 에이전트: 모델이 고른 것 — 일정 날짜는 해석기가 찾은 것만, 엉뚱하면 답하기', () => {
  assert.equal(planResult('{"action":"event","title":"치과"}', '치과 가야 해', { now }).action, 'answer', '날짜가 없으면 일정이 아니다');
  const ev = planResult('{"action":"event","title":"치과 검진"}', '금요일 3시 치과', { now });
  assert.deepEqual([ev.action, ev.title, new Date(ev.when.at).getHours()], ['event', '치과 검진', 15]);
  assert.deepEqual(planResult('{"action":"memo","title":"할 일","content":"견적서 보내기"}', 'x', { now }), { action: 'memo', title: '할 일', list: false, items: [], text: '견적서 보내기' });
  assert.equal(planResult('{"action":"append","target":"","content":"x"}', 'x').action, 'answer');
  assert.equal(planResult('엉뚱한 답', 'x').action, 'answer');
});

test('매직 에이전트: 덧붙일 메모는 제목이 같은 것부터, 잠긴 메모는 빼고 · 본문 만들기', async () => {
  const memos = [
    { id: '1', body: '# 회의록 모음\n\n…' },
    { id: '2', body: '# 회의록\n\n- 10월' },
    { id: '3', body: await lockBody('# 회의록\n\n비밀', '사과1234', { iterations: 1000 }) },
  ];
  assert.deepEqual(appendTargets('회의록', memos).map((m) => m.id), ['2', '1']);
  assert.deepEqual(splitItems('우유, 계란이랑 빵'), ['우유', '계란', '빵']);
  assert.equal(appendText('대파랑 두부'), '- 대파\n- 두부');
  assert.equal(appendText('다음 주 발표'), '다음 주 발표');
  assert.equal(memoBody({ title: '장보기', list: true, items: ['우유', '계란'] }), '# 장보기\n\n- [ ] 우유\n- [ ] 계란\n');
  assert.equal(memoBody({ title: '', list: false, text: '견적서 보내기' }), '견적서 보내기\n');
  assert.match(summaryBody('회의', '- 출시일 확정 [1]', [{ title: '주간 회의' }]), /^# 회의 요약\n\n- 출시일 확정\n\n출처\n- \[\[주간 회의\]\]\n$/);
  // 초안: 엉뚱하면 그대로, 사용자가 준 제목은 지킨다
  const it = { action: 'memo', title: '출시 준비', list: true, items: [] };
  assert.deepEqual(memoDraftResult('{"title":"다른 이름","items":["QA","공지"]}', it).items, ['QA', '공지']);
  assert.equal(memoDraftResult('{"title":"다른 이름","items":["QA"]}', it).title, '출시 준비');
  assert.equal(memoDraftResult('엉뚱', it), it);
});

test('매직 에이전트: 일정을 물으면 일정 탭에서 — 기간 · 찾을 말 · 없으면 없다고', () => {
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  const all = [
    { memoId: 'm1', title: '거래처', reminder: eventFromDate({ at: at(26, 15), hasTime: true, title: '거래처 미팅' }, now) },
    { memoId: 'm2', title: '주간 회의', reminder: eventFromDate({ at: at(26, 9), hasTime: true, repeat: { every: 'week', weekdays: [1], time: '09:00' }, title: '주간 회의' }, now) },
    { memoId: 'm3', title: '비밀', locked: true, reminder: eventFromDate({ at: at(26, 11), hasTime: true, title: '비밀 일정' }, now) },
  ];
  const q = scheduleQuery('내일 뭐 있어?', now);
  assert.equal(q.label, '내일');
  const events = eventsIn(all, q, occurrencesBetween);
  assert.deepEqual(events.map((e) => e.title), ['주간 회의', '거래처 미팅'], '시각 순 · 잠긴 메모 빼고');
  assert.equal(scheduleText(q, events, now), '내일 일정이에요.\n- 오전 9:00 주간 회의 [1]\n- 오후 3:00 거래처 미팅 [2]');
  // 찾을 말 (회의) 에 맞는 것만
  assert.deepEqual(eventsIn(all, scheduleQuery('내일 회의 몇 시야', now), occurrencesBetween).map((e) => e.title), ['주간 회의']);
  assert.deepEqual(eventsIn(all, scheduleQuery('내일 마감 몇 시야', now), occurrencesBetween), [], '물은 말에 맞는 일정이 없으면 엉뚱한 일정 대신 [] (메모에서 찾게)');
  assert.equal(scheduleText(scheduleQuery('모레 일정 있어?', now), [], now), '모레 일정은 없어요.');
  assert.equal(scheduleQuery('출시일 언제야?', now), null, '일정 말이 없으면 메모에서 찾는다');
  assert.equal(scheduleQuery('내일 회의 등록해줘', now), null, '시키는 말은 일정 묻기가 아니다');
});

test('매직 에이전트 흐름: 할 일은 확인 카드, 일정 묻기는 일정 탭, 나머지는 메모에서 답', async () => {
  const memos = [
    { id: 'a', body: '# 주간 회의\n\n출시일은 11월 3일로 확정했어요' },
    { id: 'b', body: '# 장보기\n\n- [ ] 우유' },
  ];
  const asked = [];
  const tasks = createAiTasks({
    ai: {
      status: () => ({ chat: { state: 'ready' } }),
      chat: async (m, o) => {
        asked.push(m[0].content.slice(0, 20));
        if (o?.schema?.properties?.words) return '{"words":[]}';
        if (o?.schema?.properties?.items) return '{"title":"x","items":["QA 끝내기","공지 쓰기"]}';
        if (o?.schema?.properties?.action) return '{"action":"memo","title":"할 일","content":"견적서 보내기"}';
        return '메모에서 찾지 못했어요.'; // 작은 모델이 물러서는 경우
      },
    },
    memos: () => memos,
    graph: () => [],
    reminders: () => [{ memoId: 'r', title: '치과', reminder: eventFromDate({ at: new Date(2026, 9, 26, 14).toISOString(), hasTime: true, title: '치과' }, now) }],
  });
  const ev = await tasks.agent('내일 오후 3시 거래처 미팅 등록해줘', { now });
  assert.equal(ev.kind, 'confirm');
  assert.equal(ev.action.type, 'event');
  assert.equal(asked.length, 0, '확실한 일정은 모델에 묻지 않는다');

  const draft = await tasks.agent('출시 준비 체크리스트 만들어줘', { now });
  assert.equal(draft.action.body, '# 출시 준비\n\n- [ ] QA 끝내기\n- [ ] 공지 쓰기\n');
  assert.ok(draft.drafted);

  const ap = await tasks.agent('장보기에 계란 추가해줘', { now });
  assert.deepEqual([ap.action.type, ap.action.id, ap.action.text], ['append', 'b', '계란']);
  assert.match((await tasks.agent('없는메모에 계란 추가해줘', { now })).text, /찾지 못했어요/);

  const plan = await tasks.agent('견적서 보내기 기억해줘', { now });
  assert.equal(plan.action.body, '# 할 일\n\n견적서 보내기\n');

  const sch = await tasks.agent('내일 뭐 있어?', { now });
  assert.equal(sch.text, '내일 일정이에요.\n- 오후 2:00 치과 [1]');
  assert.equal(sch.sources[0].id, 'r');
  assert.equal((await tasks.agent('내일 일정 알려줘', { now })).text, sch.text, '시각 없이 일정을 물으면 넣기가 아니라 일정 답');
  assert.equal((await tasks.agent('내일 2시 치과 알려줘', { now })).kind, 'confirm', '시각이 있으면 알림 넣기');

  // 분명히 찾았는데 모델이 물러서면 메모의 문장을 그대로
  const ans = await tasks.agent('출시일 언제야?', { now });
  assert.equal(ans.kind, 'answer');
  assert.equal(ans.text, '메모에 이렇게 적혀 있어요.\n“출시일은 11월 3일로 확정했어요” [1]');
  assert.equal(ans.sources[0].id, 'a');
});
