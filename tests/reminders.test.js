import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReminder, nextOccurrence, dueOccurrence, dueAtStartup, markFired, isDone, describeReminder, nextLabel } from '../app/js/core/reminders.js';
import { toLocalIso } from '../app/js/core/time.js';
import { parseToastXml } from '../app/js/core/notifications.js';

// 시각은 모두 이 컴퓨터의 현지 시각으로 (시간대와 상관없이 같은 결과)
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const iso = (...a) => toLocalIso(at(...a));
const repeat = (rule, created = iso(2026, 10, 1, 8, 0), extra = {}) => normalizeReminder({ id: 'r1', kind: 'repeat', repeat: rule, created, ...extra });

test('매일: 오늘 시각이 지났으면 내일', () => {
  const r = repeat({ every: 'day', time: '09:00' });
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 1, 8, 59)), at(2026, 10, 1, 9, 0));
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 1, 9, 0)), at(2026, 10, 2, 9, 0));
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 31, 10, 0)), at(2026, 11, 1, 9, 0)); // 달 넘김
});

test('매주: 고른 요일 중 다음', () => {
  const r = repeat({ every: 'week', weekdays: [1, 3], time: '09:00' }); // 월·수
  // 2026-10-01 은 목요일 → 다음은 10-05(월)
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 1, 10, 0)), at(2026, 10, 5, 9, 0));
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 5, 9, 0)), at(2026, 10, 7, 9, 0));
});

test('격주: 기준 날이 든 주부터 두 주마다', () => {
  const r = repeat({ every: 'week', weekdays: [5], time: '09:00', interval: 2, from: '2026-10-16' }); // 금
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 10, 10, 0)), at(2026, 10, 16, 9, 0));
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 16, 9, 0)), at(2026, 10, 30, 9, 0)); // 23일은 건너뜀
  assert.deepEqual(nextOccurrence(r, at(2026, 12, 25, 9, 0)), at(2027, 1, 8, 9, 0)); // 해 넘김
  assert.equal(describeReminder(r), '격주 금 09:00');
  // 3주마다
  const r3 = repeat({ every: 'week', weekdays: [5], time: '09:00', interval: 3, from: '2026-10-16' });
  assert.deepEqual(nextOccurrence(r3, at(2026, 10, 16, 9, 0)), at(2026, 11, 6, 9, 0));
  assert.equal(describeReminder(r3), '3주마다 금 09:00');
  assert.equal(repeat({ every: 'week', weekdays: [5], time: '09:00', interval: 99 }).repeat.interval, undefined, '너무 긴 간격은 매주로');
  // 기준 날이 없으면 만든 날(2026-10-01 목)이 든 주부터
  assert.equal(repeat({ every: 'week', weekdays: [5], time: '09:00', interval: 2 }).repeat.from, '2026-10-01');
});

test('매월 31일: 짧은 달은 그 달 마지막 날', () => {
  const r = repeat({ every: 'month', day: 31, time: '09:00' });
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 31, 10, 0)), at(2026, 11, 30, 9, 0));
  assert.deepEqual(nextOccurrence(r, at(2027, 2, 1, 0, 0)), at(2027, 2, 28, 9, 0));
});

test('매년 2월 29일: 평년은 28일', () => {
  const r = repeat({ every: 'year', month: 2, day: 29, time: '07:30' });
  assert.deepEqual(nextOccurrence(r, at(2026, 10, 1)), at(2027, 2, 28, 7, 30));
  assert.deepEqual(nextOccurrence(r, at(2027, 3, 1)), at(2028, 2, 29, 7, 30));
});

test('놓친 반복 알림은 한 번만 울리고, 울린 뒤엔 다음 차례까지 조용', () => {
  const r = repeat({ every: 'day', time: '09:00' }, iso(2026, 10, 1, 8, 0));
  const now = at(2026, 10, 4, 12, 0); // 사흘 동안 앱이 꺼져 있었음
  const due = dueOccurrence(r, now);
  assert.ok(due);
  assert.equal(due.missed, true);
  const fired = markFired(r, now);
  assert.equal(fired.enabled, true);
  assert.equal(dueOccurrence(fired, at(2026, 10, 4, 13, 0)), null);
  assert.ok(dueOccurrence(fired, at(2026, 10, 5, 9, 0)));
  assert.equal(dueOccurrence(fired, at(2026, 10, 5, 9, 0)).missed, false);
});

test('한 번짜리(날짜) 알림: 울리면 꺼져서 완료로', () => {
  const r = normalizeReminder({ id: 'a', kind: 'at', at: iso(2026, 10, 2, 9, 0), created: iso(2026, 10, 1) });
  assert.equal(dueOccurrence(r, at(2026, 10, 2, 8, 59)), null);
  assert.ok(dueOccurrence(r, at(2026, 10, 2, 9, 0)));
  const fired = markFired(r, at(2026, 10, 2, 9, 0));
  assert.equal(fired.enabled, false);
  assert.equal(isDone(fired), true);
  assert.equal(dueOccurrence(fired, at(2026, 10, 3)), null);
  assert.equal(nextLabel(fired, at(2026, 10, 3)), null);
});

test('켤 때 알림: 하루에 한 번은 날이 바뀌어야 다시', () => {
  const r = normalizeReminder({ id: 's', kind: 'startup', startup: 'daily', created: iso(2026, 10, 1) });
  assert.equal(dueAtStartup(r, at(2026, 10, 1, 9)), true);
  const fired = markFired(r, at(2026, 10, 1, 9));
  assert.equal(dueAtStartup(fired, at(2026, 10, 1, 23, 59)), false);
  assert.equal(dueAtStartup(fired, at(2026, 10, 2, 0, 1)), true);
  const once = markFired(normalizeReminder({ id: 'o', kind: 'startup', startup: 'once' }), at(2026, 10, 1));
  assert.equal(dueAtStartup(once, at(2026, 10, 2)), false);
});

test('파일을 손으로 고친 값도 안전하게', () => {
  assert.equal(normalizeReminder({ kind: 'nope' }), null);
  assert.equal(normalizeReminder({ kind: 'at', at: '언젠가' }), null);
  const r = repeat({ every: 'week', weekdays: [1.5, '3', 9, 'x'], time: '25:99' });
  assert.deepEqual(r.repeat.weekdays, [3]); // 1.5·9·x 는 버림
  assert.equal(r.repeat.time, '23:59');
  const t = normalizeReminder({ kind: 'timer', at: iso(2026, 10, 1, 9), minutes: -5 });
  assert.equal(t.minutes, 1);
});

test('설명 문구', () => {
  assert.equal(describeReminder(repeat({ every: 'week', weekdays: [0, 1, 2, 3, 4, 5, 6], time: '09:00' })), '매일 09:00');
  assert.equal(describeReminder(repeat({ every: 'week', weekdays: [1, 3], time: '09:00' })), '매주 월, 수 09:00');
  assert.equal(describeReminder(repeat({ every: 'month', day: 15, time: '18:30' })), '매월 15일 18:30');
  assert.equal(describeReminder(normalizeReminder({ kind: 'timer', at: iso(2026, 10, 1, 9), minutes: 120 })), '2시간 타이머');
});

test('Windows 알림: 틀린 글자 번호가 있어도 멈추지 않는다', () => {
  const r = parseToastXml('<toast><visual><binding><text>보낸 사람</text><text>안녕 &#99999999; &#x1F600; &amp;</text></binding></visual></toast>');
  assert.equal(r.title, '보낸 사람');
  assert.equal(r.body, '안녕 &#99999999; 😀 &');
});

// ---------- 알림 (구글 리마인더처럼) ----------
import { buildTask, taskPresets, taskRepeatChoices, isEvent as isEv, isTask, isDone as done, normalizeReminder as norm, serializeReminder as ser, occurrencesBetween as occ, alarmTitle as aTitle } from '../app/js/core/reminders.js';

test('알림: 한 번 · 반복은 일정이 아니다 (달력에는 때로 보임), 완료 표시는 파일에 남는다', () => {
  const now = new Date(2026, 9, 31, 10, 0); // 토 10:00
  const once = buildTask({ title: ' 약  먹기 ', at: new Date(2026, 9, 31, 18, 0) }, now);
  assert.equal(once.kind, 'at');
  assert.equal(once.task, true);
  assert.equal(once.title, '약 먹기');
  assert.equal(isEv(once), false);
  assert.equal(isTask(once), true);
  const weekly = buildTask({ at: new Date(2026, 9, 31, 18, 0), every: 'week' }, now);
  assert.deepEqual(weekly.repeat, { every: 'week', time: '18:00', weekdays: [6] });
  const back = norm(ser({ ...norm(weekly), done: true }));
  assert.equal(back.task, true);
  assert.equal(back.done, true);
  assert.equal(done(back), true);
  assert.equal(occ(norm(once), new Date(2026, 9, 31), new Date(2026, 10, 1)).length, 1);
  assert.equal(aTitle(norm(once), '메모'), '약 먹기');
  assert.throws(() => buildTask({ at: new Date(2026, 9, 31, 9, 0) }, now), /지난/);
});

test('알림: 빨리 고르기 · 반복 고르기 문구', () => {
  const sat = new Date(2026, 9, 31, 10, 0);
  assert.deepEqual(taskPresets(sat).map((p) => p.label), ['1시간 뒤', '오늘 저녁', '내일 아침', '월요일 아침']);
  assert.equal(taskPresets(sat).at(-1).at.getDate(), 2); // 11월 2일 월요일
  assert.equal(taskPresets(new Date(2026, 9, 31, 20, 0)).some((p) => p.id === 'evening'), false);
  assert.deepEqual(taskRepeatChoices(sat).map((c) => c.label), ['반복 안 함', '매일', '매주 토요일', '매월 31일', '매년 10월 31일']);
});

test('알림 한 줄 설명: 오전 · 오후 시각, 반복은 다음 날, 완료', async () => {
  const { describeTask } = await import('../app/js/core/reminders.js');
  const now = new Date(2026, 9, 31, 10, 0); // 토
  const once = norm(buildTask({ at: new Date(2026, 9, 31, 18, 0) }, now));
  assert.equal(describeTask(once, now), '오늘 오후 6:00');
  const weekly = norm({ ...buildTask({ at: new Date(2026, 9, 31, 18, 0), every: 'week' }, now), created: '2026-10-31T09:00:00' });
  assert.equal(describeTask(weekly, now), '매주 토요일 오후 6:00 · 다음 오늘');
  assert.equal(describeTask({ ...once, done: true }, now), '완료');
  assert.equal(describeTask({ ...once, enabled: false }, now), '오늘 오후 6:00 · 꺼짐');
});
