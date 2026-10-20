import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHours, inWorkHours, scheduledMode, quietAlarm, hoursLabel, modeClock } from '../app/js/core/work-hours.js';

const at = (s) => new Date(s); // 2026-10-19 은 월요일
const hours = { auto: true, quiet: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

test('업무 시간: 평일 9~18시', () => {
  assert.equal(inWorkHours(at('2026-10-19T09:00:00'), hours), true);
  assert.equal(inWorkHours(at('2026-10-19T17:59:00'), hours), true);
  assert.equal(inWorkHours(at('2026-10-19T18:00:00'), hours), false);
  assert.equal(inWorkHours(at('2026-10-19T08:59:00'), hours), false);
  assert.equal(inWorkHours(at('2026-10-18T10:00:00'), hours), false, '일요일');
  assert.equal(scheduledMode(at('2026-10-20T11:00:00'), hours), 'work');
});

test('업무 시간: 밤을 넘기는 근무', () => {
  const night = { days: [1], start: '22:00', end: '06:00' };
  assert.equal(inWorkHours(at('2026-10-19T23:00:00'), night), true);
  assert.equal(inWorkHours(at('2026-10-20T05:00:00'), night), true, '월요일 밤에 시작한 근무');
  assert.equal(inWorkHours(at('2026-10-21T05:00:00'), night), false);
});

test('업무 시간: 이상한 값은 기본값으로', () => {
  const h = normalizeHours({ days: [9, 'x', 3, 3], start: '25:00', end: 'x' });
  assert.deepEqual(h, { auto: false, quiet: false, days: [3], start: '09:00', end: '18:00' });
  assert.equal(hoursLabel(hours), '평일 09:00–18:00');
  assert.equal(hoursLabel({ days: [0, 6] }), '일·토 09:00–18:00');
});

test('퇴근 뒤 Work 알림은 조용히 — 고정한 메모 · Life 메모는 울린다', () => {
  const night = at('2026-10-19T21:00:00');
  assert.equal(quietAlarm({ mode: 'work' }, night, hours), true);
  assert.equal(quietAlarm({ mode: 'work', pinned: true }, night, hours), false);
  assert.equal(quietAlarm({ mode: 'life' }, night, hours), false);
  assert.equal(quietAlarm({ mode: 'work' }, at('2026-10-19T10:00:00'), hours), false);
  assert.equal(quietAlarm({ mode: 'work' }, night, { ...hours, quiet: false }), false);
});

test('모드 시계: 켤 때 한 번, 그 뒤엔 경계를 넘을 때만', () => {
  const seen = [];
  let h = hours;
  const tick = modeClock({ getHours: () => h, onChange: (m, o) => seen.push([m, o.first]) });
  tick(at('2026-10-19T08:00:00'));
  tick(at('2026-10-19T08:30:00'));
  tick(at('2026-10-19T09:00:00'));
  tick(at('2026-10-19T12:00:00'));
  tick(at('2026-10-19T18:00:00'));
  assert.deepEqual(seen, [['life', true], ['work', false], ['life', false]]);
  h = { ...hours, auto: false };
  tick(at('2026-10-20T10:00:00'));
  assert.equal(seen.length, 3);
});
