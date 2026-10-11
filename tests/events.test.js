import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReminder, serializeReminder, nextAlert, dueOccurrence, markFired, isDone, reenable, isLive, isPastEvent, pendingAlerts, upcomingAlerts, alertLabel, describeAlerts, describeReminder, nextLabel, occurrencesBetween } from '../app/js/core/reminders.js';
import { toLocalIso } from '../app/js/core/time.js';

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const iso = (...a) => toLocalIso(at(...a));
const event = (extra) => normalizeReminder({ id: 'e1', kind: 'at', created: iso(2026, 10, 1, 8, 0), ...extra });

/** 시간을 흘려 보내며 울리는 순서를 모은다 (15초마다 살피는 실행기와 같게) */
function ring(r, from, to, step = 60_000) {
  const out = [];
  let cur = r;
  for (let t = from.getTime(); t <= to.getTime(); t += step) {
    const due = dueOccurrence(cur, new Date(t));
    if (!due) continue;
    out.push(`${alertLabel(due.offset, Boolean(cur.allDay))} @ ${new Date(t).getDate()}일 ${new Date(t).getHours()}:${String(new Date(t).getMinutes()).padStart(2, '0')}`);
    cur = markFired(cur, new Date(t));
  }
  return { rang: out, final: cur };
}

test('일정 + 미리 알림 여러 개: 하루 전·30분 전 차례로, 마지막 뒤에 완료', () => {
  const r = event({ at: iso(2026, 10, 5, 15, 0), title: '치과', alerts: [30, 1440] });
  const { rang, final } = ring(r, at(2026, 10, 4, 0, 0), at(2026, 10, 5, 16, 0));
  assert.deepEqual(rang, ['하루 전 @ 4일 15:00', '30분 전 @ 5일 14:30']);
  // 미리 알림을 다 보냈어도 일정 전에는 켜진 채로 ("알림을 모두 보냈어요"), 더 울리지 않고, 일정이 지나면 끝
  assert.equal(final.enabled, true);
  assert.equal(dueOccurrence(final, at(2026, 10, 5, 16, 0)), null);
  assert.equal(isPastEvent(final, at(2026, 10, 5, 16, 0)), true);
  assert.equal(isLive(final, at(2026, 10, 5, 14, 40)), false);
});

test('하루 전 알림이 남아 있으면 첫 알림 뒤에도 켜져 있음', () => {
  const r = event({ at: iso(2026, 10, 5, 15, 0), alerts: [10, 1440] });
  const fired = markFired(r, at(2026, 10, 4, 15, 0));
  assert.equal(fired.enabled, true);
  assert.equal(nextLabel(fired, at(2026, 10, 4, 16, 0)), '내일 14:50');
});

test('만들기 전에 지난 미리 알림은 울리지 않음', () => {
  // 10/1 08:00 에 만든 10/1 15:00 일정 — 하루 전(9/30 15:00)은 이미 지남, 1시간 전만
  const r = event({ at: iso(2026, 10, 1, 15, 0), alerts: [60, 1440] });
  const { rang } = ring(r, at(2026, 10, 1, 8, 0), at(2026, 10, 1, 16, 0));
  assert.deepEqual(rang, ['1시간 전 @ 1일 14:00']);
});

test('하루 종일 일정: 당일 오전 9시 · 하루 전 오전 9시', () => {
  const r = event({ at: iso(2026, 10, 7, 0, 0), allDay: true, alerts: [-540, 900] });
  const { rang } = ring(r, at(2026, 10, 5, 0, 0), at(2026, 10, 8, 0, 0));
  assert.deepEqual(rang, ['하루 전 오전 9시 @ 6일 9:00', '당일 오전 9시 @ 7일 9:00']);
  assert.equal(describeReminder(r, at(2026, 10, 1)), '10월 7일 (수) 하루 종일');
  assert.equal(describeAlerts(r), '당일 오전 9시, 하루 전 오전 9시');
});

test('반복 일정 + 하루 전: 회차마다 전날 울림', () => {
  const r = normalizeReminder({ id: 'w', kind: 'repeat', repeat: { every: 'week', weekdays: [1], time: '10:00' }, alerts: [1440], created: iso(2026, 10, 1, 8, 0) });
  const { rang, final } = ring(r, at(2026, 10, 1, 8, 0), at(2026, 10, 19, 12, 0), 5 * 60_000);
  assert.deepEqual(rang, ['하루 전 @ 4일 10:00', '하루 전 @ 11일 10:00', '하루 전 @ 18일 10:00']);
  assert.equal(final.enabled, true);
});

test('매일 일정 + 10분 전·정시 섞여도 순서대로', () => {
  const r = normalizeReminder({ id: 'd', kind: 'repeat', repeat: { every: 'day', time: '09:00' }, alerts: [0, 10], created: iso(2026, 10, 1, 8, 0) });
  const { rang } = ring(r, at(2026, 10, 1, 8, 0), at(2026, 10, 2, 9, 30));
  assert.deepEqual(rang, ['10분 전 @ 1일 8:50', '정시 @ 1일 9:00', '10분 전 @ 2일 8:50', '정시 @ 2일 9:00']);
});

test('예전 알림(미리 알림 없음)은 그대로 정시 한 번', () => {
  const r = event({ at: iso(2026, 10, 2, 9, 0) });
  const { rang, final } = ring(r, at(2026, 10, 2, 8, 0), at(2026, 10, 2, 10, 0));
  assert.deepEqual(rang, ['정시 @ 2일 9:00']);
  assert.equal(isDone(final), true);
});

test('놓친 미리 알림이 여럿이면 한 번만 (놓친 알림)', () => {
  const r = event({ at: iso(2026, 10, 5, 15, 0), alerts: [30, 1440] });
  const due = dueOccurrence(r, at(2026, 10, 5, 16, 0)); // 꺼져 있다가 일정 뒤에 켬
  assert.equal(due.missed, true);
  const fired = markFired(r, at(2026, 10, 5, 16, 0));
  assert.equal(dueOccurrence(fired, at(2026, 10, 5, 16, 1)), null);
  assert.equal(fired.enabled, false);
});

test('미리 알림 이름', () => {
  assert.deepEqual([0, 5, 10, 30, 60, 90, 120, 1440, 2880, 10080].map((o) => alertLabel(o)),
    ['정시', '5분 전', '10분 전', '30분 전', '1시간 전', '1시간 30분 전', '2시간 전', '하루 전', '2일 전', '일주일 전']);
  assert.deepEqual([-540, -1020, 900, 9540].map((o) => alertLabel(o, true)), ['당일 오전 9시', '당일 오후 5시', '하루 전 오전 9시', '일주일 전 오전 9시']);
});

test('파일에 쓰고 읽기: 제목·미리 알림·하루 종일', () => {
  const r = event({ at: iso(2026, 10, 7), allDay: true, title: '  엄마   생신 ', alerts: [900, -540, 900, 'x', 999999] });
  assert.equal(r.title, '엄마 생신');
  assert.deepEqual(r.alerts, [900, -540]);
  const back = normalizeReminder(serializeReminder(r));
  assert.deepEqual(back, r);
});

test('달력: 기간 안의 회차', () => {
  const r = normalizeReminder({ id: 'w', kind: 'repeat', repeat: { every: 'week', weekdays: [1, 3], time: '10:00' }, created: iso(2026, 10, 1) });
  assert.deepEqual(occurrencesBetween(r, at(2026, 10, 1), at(2026, 10, 15)).map((d) => d.getDate()), [5, 7, 12, 14]);
  const once = event({ at: iso(2026, 10, 9, 15) });
  assert.equal(occurrencesBetween(once, at(2026, 10, 1), at(2026, 11, 1)).length, 1);
  assert.equal(occurrencesBetween(once, at(2026, 11, 1), at(2026, 12, 1)).length, 0);
});

test('nextAlert: 다음 울릴 때와 그 일정', () => {
  const r = event({ at: iso(2026, 10, 5, 15, 0), alerts: [30, 1440] });
  const n = nextAlert(r, at(2026, 10, 4, 16, 0));
  assert.deepEqual([n.at, n.start, n.offset], [at(2026, 10, 5, 14, 30), at(2026, 10, 5, 15, 0), 30]);
});

test('알림 없음: 달력에만 있고 울리지 않음', () => {
  const r = event({ at: iso(2026, 10, 5, 15, 0), alerts: [] });
  assert.deepEqual(r.alerts, []);
  assert.equal(describeAlerts(r), '알림 없음');
  assert.equal(dueOccurrence(r, at(2026, 10, 5, 15, 0)), null);
  assert.equal(occurrencesBetween(r, at(2026, 10, 1), at(2026, 11, 1)).length, 1);
  assert.deepEqual(normalizeReminder(serializeReminder(r)).alerts, []);
});

// ---------- 버그 고침 재현 ----------

test('하루 전 알림이 울린 뒤 껐다 켜도: "끝났어요" 아님, 하루 전이 다시 울리지 않음', () => {
  const r = event({ at: iso(2026, 10, 5, 15, 0), alerts: [30, 1440] });
  const fired = markFired(r, at(2026, 10, 4, 15, 0)); // 하루 전 울림
  const off = { ...fired, enabled: false };
  assert.equal(isDone(off), false); // 꺼짐이지 끝이 아님
  const on = reenable(off);
  assert.equal(on.last, fired.last); // 울린 기록을 지킴
  assert.equal(dueOccurrence(on, at(2026, 10, 4, 16, 0)), null); // 하루 전이 "놓친 알림" 으로 또 울리지 않음
  assert.equal(dueOccurrence(on, at(2026, 10, 5, 14, 30)).offset, 30);
});

test('일정이 지난 뒤 끝난 일정을 다시 켜도 울린 알림은 다시 울리지 않음', () => {
  const r = event({ at: iso(2026, 10, 5, 15, 0), alerts: [30] });
  const done = markFired(r, at(2026, 10, 5, 16, 0)); // 꺼져 있다가 일정 뒤에 울림(놓친 알림) → 끝
  assert.equal(isDone(done), true);
  const again = reenable(done);
  assert.equal(again.last, done.last);
  assert.equal(dueOccurrence(again, at(2026, 10, 5, 16, 1)), null);
});

test('오전 10시에 만든 오늘 하루 종일 일정: 당일 오전 9시는 "놓친 알림" 으로 울리지 않음', () => {
  const r = event({ at: iso(2026, 10, 5), allDay: true, alerts: [-540], created: iso(2026, 10, 5, 10, 0) });
  assert.equal(dueOccurrence(r, at(2026, 10, 5, 10, 0)), null);
  assert.equal(dueOccurrence(r, at(2026, 10, 5, 23, 0)), null);
});

test('만들기 전에 지난 정시 알림도 새 일정이면 울리지 않음 (알림 패널에서 지난 시각을 골라도)', () => {
  const r = event({ at: iso(2026, 10, 5, 9, 0), alerts: [0], created: iso(2026, 10, 5, 10, 0) });
  assert.equal(dueOccurrence(r, at(2026, 10, 5, 10, 0)), null);
  // 예전 알림(미리 알림 없음)은 그대로 놓친 알림
  const legacy = event({ at: iso(2026, 10, 5, 9, 0), created: iso(2026, 10, 5, 10, 0) });
  assert.equal(dueOccurrence(legacy, at(2026, 10, 5, 10, 0)).missed, true);
});

test('이미 지난 미리 알림 거르기: 5분 뒤 일정에 10분 전은 빠짐, 반복 일정은 그대로', () => {
  const now = at(2026, 10, 5, 9, 0);
  assert.deepEqual(pendingAlerts([10, 0], at(2026, 10, 5, 9, 5), { now }), [0]);
  assert.deepEqual(pendingAlerts([10], at(2026, 10, 5, 9, 5), { now }), []);
  assert.deepEqual(pendingAlerts([10, 1440], at(2026, 10, 5, 9, 5), { repeat: true, now }), [1440, 10]);
  // 오늘 하루 종일 · 오전 10시: 당일 오전 9시는 지남
  assert.deepEqual(pendingAlerts([-540, 900], at(2026, 10, 5), { now: at(2026, 10, 5, 10, 0) }), []);
});

test('휴대폰 예약: 알림 개수가 아니라 회차로 센다 (매일 + 알림 3개 → 14회차)', () => {
  const r = normalizeReminder({ id: 'd', kind: 'repeat', repeat: { every: 'day', time: '09:00' }, alerts: [0, 10, 60], created: iso(2026, 10, 1, 8, 0) });
  const list = upcomingAlerts(r, at(2026, 10, 1, 7, 0), 14);
  assert.equal(new Set(list.map((x) => x.start.getTime())).size, 14);
  assert.equal(list.length, 42);
  assert.deepEqual(list.at(-1).start, at(2026, 10, 14, 9, 0));
  // 한 번짜리는 그 일정의 알림 모두
  assert.equal(upcomingAlerts(event({ at: iso(2026, 10, 5, 15, 0), alerts: [30, 1440] }), at(2026, 10, 1), 1).length, 2);
});

test('알림 없는 일정은 켜짐으로 세지 않음 (종 버튼과 탭 숫자가 같게)', () => {
  const now = at(2026, 10, 3);
  const noAlert = event({ at: iso(2026, 10, 5, 15, 0), alerts: [] });
  assert.equal(isLive(noAlert, now), false);
  assert.equal(isLive(event({ at: iso(2026, 10, 5, 15, 0), alerts: [10] }), now), true);
  assert.equal(isLive(normalizeReminder({ id: 's', kind: 'startup' }), now), true);
  assert.equal(isPastEvent(noAlert, at(2026, 10, 5, 15, 0)), true);
  assert.equal(isPastEvent(event({ at: iso(2026, 10, 5), allDay: true, alerts: [] }), at(2026, 10, 5, 23, 0)), false);
});

test('반복 일정은 만든 날 전에는 달력에 없음', () => {
  const r = normalizeReminder({ id: 'w', kind: 'repeat', repeat: { every: 'week', weekdays: [1], time: '10:00' }, created: iso(2026, 10, 7, 8, 0) });
  assert.deepEqual(occurrencesBetween(r, at(2026, 1, 1), at(2026, 2, 1)), []);
  assert.deepEqual(occurrencesBetween(r, at(2026, 10, 1), at(2026, 10, 20)).map((d) => d.getDate()), [12, 19]);
  // 만든 날의 회차는 보임
  const daily = normalizeReminder({ id: 'd', kind: 'repeat', repeat: { every: 'day', time: '09:00' }, created: iso(2026, 10, 7, 10, 0) });
  assert.deepEqual(occurrencesBetween(daily, at(2026, 10, 6), at(2026, 10, 9)).map((d) => d.getDate()), [7, 8]);
});

test('날 이름은 한 가지로: 모레 · "(월)" 띄어 쓰기 · 다른 해', async () => {
  const { dayLabel } = await import('../app/js/core/time.js');
  const { formatWhen } = await import('../app/js/core/reminders.js');
  const now = at(2026, 10, 10, 10, 0);
  assert.deepEqual([-1, 0, 1, 2, 3].map((n) => dayLabel(at(2026, 10, 10 + n), now)), ['어제', '오늘', '내일', '모레', '10월 13일 (화)']);
  assert.equal(dayLabel(at(2027, 1, 2), now), '2027년 1월 2일 (토)');
  assert.equal(formatWhen(at(2026, 10, 12, 9, 0), now), '모레 09:00');
});

test('alerts 가 없는 하루 종일 일정도 만들기 전 "당일 오전 9시" 는 울리지 않음', () => {
  const r = normalizeReminder({ id: 'x', kind: 'at', allDay: true, at: iso(2026, 10, 5), created: iso(2026, 10, 5, 10, 0) });
  assert.equal(dueOccurrence(r, at(2026, 10, 5, 10, 0)), null);
});

test('파일의 이상한 미리 알림 값은 버림 (시각 있는 일정의 음수, 하루 종일의 -1440)', () => {
  assert.deepEqual(event({ at: iso(2026, 10, 5, 15, 0), alerts: [-30, 10] }).alerts, [10]);
  assert.deepEqual(event({ at: iso(2026, 10, 5), allDay: true, alerts: [-1440, -540] }).alerts, [-540]);
});

test('고른 알림이 모두 지났으면 정시로 (하루 종일은 당일 오전 9시), 정시도 지났으면 없음', async () => {
  const { fallbackAlert } = await import('../app/js/core/reminders.js');
  const now = at(2026, 10, 5, 14, 55);
  assert.deepEqual(pendingAlerts([10], at(2026, 10, 5, 15, 0), { now, fallback: fallbackAlert(false) }), [0]);
  assert.deepEqual(pendingAlerts([10, 0], at(2026, 10, 5, 15, 0), { now, fallback: 0 }), [0]);
  assert.deepEqual(pendingAlerts([], at(2026, 10, 5, 15, 0), { now, fallback: 0 }), [], '알림 없음을 고른 것은 그대로');
  assert.deepEqual(pendingAlerts([900], at(2026, 10, 6), { now: at(2026, 10, 5, 10, 0), fallback: fallbackAlert(true) }), [-540]);
  assert.deepEqual(pendingAlerts([-540], at(2026, 10, 5), { now: at(2026, 10, 5, 10, 0), fallback: fallbackAlert(true) }), []);
});

test('날짜 차이는 서머타임이 있는 시간대에서도 정확 (오클랜드)', { skip: process.platform === 'win32' && 'TZ 를 바꿀 수 없음' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const code = "import('./app/js/core/time.js').then(({ daysFrom, dayLabel }) => { const now = new Date(2026, 8, 26, 10); console.log([daysFrom(new Date(2026, 8, 27, 9), now), daysFrom(new Date(2026, 8, 28, 9), now), dayLabel(new Date(2026, 8, 27, 9), now)].join(',')); })";
  const out = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'Pacific/Auckland' }, cwd: fileURLToPath(new URL('..', import.meta.url)) }).toString().trim();
  assert.equal(out, '1,2,내일'); // 2026-09-27 에 서머타임 시작
});

test('서머타임이 바뀌는 날: 하루 종일 "당일 오전 9시" 는 오전 9시, "매일 오후 3시" 는 다음 날도 오후 3시 (뉴욕)', { skip: process.platform === 'win32' && 'TZ 를 바꿀 수 없음' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const code = `Promise.all([import('./app/js/core/reminders.js'), import('./app/js/core/date-detect.js')]).then(([rm, dd]) => {
    const r = rm.normalizeReminder({ id: 'a', kind: 'at', allDay: true, at: new Date(2026, 2, 8).toISOString(), alerts: [-540, 900], created: new Date(2026, 2, 1).toISOString() });
    const a = rm.nextAlert(r, new Date(2026, 2, 7, 12)); // 3/8 이 서머타임 시작
    const d = dd.findDates('매일 오후 3시 약', new Date(2026, 2, 7, 16))[0];
    console.log([a.at.getHours(), a.at.getDate(), d.at.getHours(), d.repeat.time].join(','));
  })`;
  const out = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'America/New_York' }, cwd: fileURLToPath(new URL('..', import.meta.url)) }).toString().trim();
  assert.equal(out, '9,8,15,15:00');
});

test('같은 때에 겹친 두 알림(매일 9시 일정의 정시 + 다음 날 일정의 하루 전): 한 번 울리며 둘 다 알림', async () => {
  const { alarmLabel } = await import('../app/js/core/reminders.js');
  const r = normalizeReminder({ id: 'd', kind: 'repeat', repeat: { every: 'day', time: '09:00' }, alerts: [1440, 0], created: iso(2026, 10, 1, 8, 0) });
  const n = nextAlert(r, at(2026, 10, 3, 8, 0));
  assert.equal(n.offset, 0);
  assert.equal(n.also.length, 1);
  assert.deepEqual(n.also[0].start, at(2026, 10, 4, 9, 0));
  assert.match(alarmLabel(r, n, at(2026, 10, 3, 9, 0)), /다음 일정 내일 09:00/);
});
