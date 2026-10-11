import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReminder, serializeReminder, nextAlert, dueOccurrence, markFired, isDone, alertLabel, describeAlerts, describeReminder, nextLabel, occurrencesBetween } from '../app/js/core/reminders.js';
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
  assert.equal(final.enabled, false);
  assert.equal(isDone(final), true);
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
  assert.equal(describeReminder(r, at(2026, 10, 1)), '10월 7일(수) 하루 종일');
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
