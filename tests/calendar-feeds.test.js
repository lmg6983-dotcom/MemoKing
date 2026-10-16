// 다른 캘린더와 잇기 — .ics 구독 읽기 (반복 · 빠진 날 · 바뀐 회차 · 시간대), 휴대폰 캘린더, 내보내기(.ics · Google 주소)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFeedUrl, normalizeFeeds, feedLabel, icsName, looksLikeIcs, feedEvents, fromDeviceEvent, reminderFromExternal,
  rruleOf, eventSpan, buildIcs, googleCalendarUrl, deviceInsertArgs, MAX_FEEDS,
} from '../app/js/core/calendar-feeds.js';
import { normalizeReminder } from '../app/js/core/reminders.js';
import { ICAL } from '../app/vendor/ical.js';

const SEOUL_TZ = `BEGIN:VTIMEZONE
TZID:Asia/Seoul
BEGIN:STANDARD
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:KST
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE`;

const GOOGLE = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
X-WR-CALNAME:내 캘린더\\, 회사
${SEOUL_TZ}
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20261019T100000
DTEND;TZID=Asia/Seoul:20261019T110000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Asia/Seoul:20261026T100000
UID:weekly@google.com
SUMMARY:팀 회의
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20261102T140000
DTEND;TZID=Asia/Seoul:20261102T150000
RECURRENCE-ID;TZID=Asia/Seoul:20261102T100000
UID:weekly@google.com
SUMMARY:팀 회의 (오후로)
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261022
DTEND;VALUE=DATE:20261024
UID:trip@google.com
SUMMARY:부산 출장
LOCATION:부산역
END:VEVENT
BEGIN:VEVENT
DTSTART:20261020T010000Z
DTEND:20261020T020000Z
UID:cancelled@google.com
STATUS:CANCELLED
SUMMARY:취소된 일정
END:VEVENT
END:VCALENDAR`;

const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

test('붙여 넣은 주소: webcal → https, 인터넷 주소만', () => {
  assert.equal(normalizeFeedUrl(' webcal://calendar.google.com/a/basic.ics '), 'https://calendar.google.com/a/basic.ics');
  assert.equal(normalizeFeedUrl('file:///etc/passwd'), null);
  assert.equal(normalizeFeedUrl('그냥 글'), null);
  assert.equal(feedLabel('https://calendar.google.com/calendar/ical/x/private-y/basic.ics'), 'Google 캘린더');
});

test('구독 목록 정리: 같은 주소 하나만, 이름 · 색 기본값, 개수 제한', () => {
  const list = normalizeFeeds([
    { url: 'https://calendar.google.com/a.ics', name: '  회사  ' },
    { url: 'webcal://calendar.google.com/a.ics' },
    { url: 'nope' },
    { url: 'https://example.com/b.ics', on: false, color: '#123456', id: 'mine' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, '회사');
  assert.match(list[0].color, /^#[0-9a-f]{6}$/i);
  assert.deepEqual({ id: list[1].id, on: list[1].on, color: list[1].color, name: list[1].name }, { id: 'mine', on: false, color: '#123456', name: 'example.com' });
  const many = normalizeFeeds(Array.from({ length: 30 }, (_, i) => ({ url: `https://e.com/${i}.ics` })));
  assert.equal(many.length, MAX_FEEDS);
});

test('.ics 이름 · 진짜 iCal 인지', () => {
  assert.equal(icsName(GOOGLE), '내 캘린더, 회사');
  assert.equal(looksLikeIcs(GOOGLE), true);
  assert.equal(looksLikeIcs('<!doctype html><html>로그인</html>'), false);
});

test('Google .ics 읽기: 매주 반복 · 빠진 날 · 오후로 옮긴 회차 · 여러 날 하루 종일 · 취소는 빼기', () => {
  const events = feedEvents(GOOGLE, local(2026, 10, 18), local(2026, 11, 10));
  // 시간대가 있는 일정은 서울 시각으로 (시험하는 컴퓨터의 시간대와 상관없이), 하루 종일은 그 날짜 그대로
  const seoul = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, Number(p.value)]));
  const rows = events.map((e) => {
    if (e.allDay) return `${e.start.getMonth() + 1}/${e.start.getDate()} 종일 ${e.title}`;
    const s = seoul(e.start);
    return `${s.month}/${s.day} ${s.hour}시 ${e.title}`;
  });
  assert.deepEqual(rows, [
    '10/19 10시 팀 회의',
    '10/22 종일 부산 출장',
    '11/2 14시 팀 회의 (오후로)',
    '11/9 10시 팀 회의',
  ]);
  const trip = events.find((e) => e.allDay);
  assert.equal(trip.end.getDate(), 24);
  assert.equal(trip.location, '부산역');
});

test('범위에 걸친 여러 날 일정은 시작이 범위 앞이어도 보임 · 아주 많은 반복도 멈추지 않음', () => {
  const inside = feedEvents(GOOGLE, local(2026, 10, 23), local(2026, 10, 24));
  assert.deepEqual(inside.map((e) => e.title), ['부산 출장']);
  const daily = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:d\nDTSTART:19900101T000000Z\nRRULE:FREQ=MINUTELY\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR`;
  const t = Date.now();
  feedEvents(daily, local(2026, 10, 1), local(2026, 11, 1));
  assert.ok(Date.now() - t < 5000);
});

test('휴대폰 캘린더 일정: 하루 종일은 UTC 자정 → 그 날짜', () => {
  const e = fromDeviceEvent({ id: 7, title: ' 결혼식 ', start: Date.UTC(2026, 9, 24), end: Date.UTC(2026, 9, 25), allDay: true, color: '#33B679', calendar: '삼성 캘린더' });
  assert.equal(e.start.getDate(), 24);
  assert.equal(e.start.getHours(), 0);
  assert.equal(e.end.getDate(), 25);
  assert.equal(e.title, '결혼식');
  assert.equal(e.color, '#33B679');
  const timed = fromDeviceEvent({ id: 8, title: '', start: local(2026, 10, 24, 13).getTime(), end: 0, allDay: false });
  assert.equal(timed.title, '(제목 없음)');
  assert.equal(timed.end.getTime(), timed.start.getTime());
});

test('다른 캘린더 일정 → 메모킹 일정 (알림 기본값, 지난 것은 꺼 둠)', () => {
  const now = local(2026, 10, 16, 9);
  const r = normalizeReminder(reminderFromExternal({ title: '부산 출장', start: local(2026, 10, 22, 15), allDay: true }, now));
  assert.equal(r.kind, 'at');
  assert.equal(r.allDay, true);
  assert.equal(new Date(r.at).getHours(), 0);
  assert.deepEqual(r.alerts, [-540]);
  assert.equal(r.enabled, true);
  const past = normalizeReminder(reminderFromExternal({ title: '지난 일', start: local(2026, 10, 1, 9), allDay: false }, now));
  assert.equal(past.enabled, false);
  assert.deepEqual(past.alerts, [10]);
});

const item = (reminder, title = '메모 제목') => ({ memoId: 'm1', title, reminder: normalizeReminder(reminder) });

test('반복 → RRULE', () => {
  assert.equal(rruleOf(item({ kind: 'repeat', repeat: { every: 'week', weekdays: [1, 3], time: '10:00' } }).reminder), 'FREQ=WEEKLY;BYDAY=MO,WE');
  assert.equal(rruleOf(item({ kind: 'repeat', repeat: { every: 'year', month: 3, day: 9 } }).reminder), 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=9');
  assert.equal(rruleOf(item({ kind: 'at', at: '2026-10-20T09:00:00+09:00' }).reminder), '');
});

test('일정 시작 · 끝: 한 번짜리는 1시간, 하루 종일은 다음 날까지, 반복은 만든 날 뒤 첫 회차', () => {
  const at = eventSpan(item({ kind: 'at', at: local(2026, 10, 20, 9).toISOString() }).reminder);
  assert.equal(at.end - at.start, 3600_000);
  const day = eventSpan(item({ kind: 'at', at: local(2026, 10, 22).toISOString(), allDay: true }).reminder);
  assert.equal(day.end.getDate(), 23);
  const rep = eventSpan(item({ kind: 'repeat', created: local(2026, 10, 14, 12).toISOString(), repeat: { every: 'week', weekdays: [1], time: '10:00' } }).reminder);
  assert.equal(rep.start.getDate(), 19);
  assert.equal(rep.start.getHours(), 10);
  assert.equal(eventSpan(item({ kind: 'timer', at: local(2026, 10, 22).toISOString(), minutes: 5 }).reminder), null);
});

test('.ics 내보내기: 다시 읽으면 같은 일정 · 알림 · 반복, 긴 한글 줄은 75바이트로 접기', () => {
  const now = local(2026, 10, 16, 9);
  const items = [
    item({ kind: 'at', at: local(2026, 10, 17, 15).toISOString(), title: '치과, 스케일링; 예약', alerts: [30] }, '치과'),
    item({ kind: 'at', at: local(2026, 10, 22).toISOString(), allDay: true, title: '분기 보고 마감' }),
    item({ kind: 'repeat', created: local(2026, 10, 14).toISOString(), title: '주간 회의', repeat: { every: 'week', weekdays: [1, 3], time: '10:00' } }),
    item({ kind: 'timer', at: local(2026, 10, 16, 18).toISOString(), minutes: 10 }),
    item({ kind: 'at', at: local(2026, 10, 25, 9).toISOString(), title: '가'.repeat(60) }),
  ];
  const text = buildIcs(items, { now });
  assert.ok(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75), '접기');
  assert.match(text, /SUMMARY:치과\\, 스케일링\\; 예약/);
  assert.match(text, /TRIGGER:-PT30M/);
  assert.match(text, /TRIGGER:PT540M/); // 하루 종일: 당일 오전 9시
  assert.doesNotMatch(text, /timer/);
  const back = feedEvents(text, local(2026, 10, 16), local(2026, 10, 30));
  const rows = back.map((e) => `${e.start.getMonth() + 1}/${e.start.getDate()} ${e.allDay ? '종일' : `${e.start.getHours()}시`} ${e.title}`);
  assert.deepEqual(rows, [
    '10/17 15시 치과, 스케일링; 예약',
    '10/19 10시 주간 회의',
    '10/21 10시 주간 회의',
    '10/22 종일 분기 보고 마감',
    '10/25 9시 ' + '가'.repeat(60),
    '10/26 10시 주간 회의',
    '10/28 10시 주간 회의',
  ]);
  const comp = new ICAL.Component(ICAL.parse(text));
  assert.equal(comp.getFirstPropertyValue('x-wr-calname'), '메모킹 일정');
});

test('Google 캘린더 새 일정 주소 · 휴대폰 캘린더 앱 값', () => {
  const allDay = item({ kind: 'at', at: local(2026, 10, 22).toISOString(), allDay: true, title: '마감' }, '보고서');
  const url = new URL(googleCalendarUrl(allDay));
  assert.equal(url.hostname, 'calendar.google.com');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('dates'), '20261022/20261023');
  assert.equal(url.searchParams.get('details'), '메모킹 메모: 보고서');
  const rep = item({ kind: 'repeat', created: local(2026, 10, 14).toISOString(), title: '회의', repeat: { every: 'day', time: '08:30' } });
  assert.equal(new URL(googleCalendarUrl(rep)).searchParams.get('recur'), 'RRULE:FREQ=DAILY');
  const args = deviceInsertArgs(allDay);
  assert.equal(args.start, local(2026, 10, 22).getTime());
  assert.equal(args.allDay, true);
  assert.equal(deviceInsertArgs(rep).rrule, 'FREQ=DAILY');
});

test('오래된 매일 반복이 여럿 앞에 있어도 뒤의 한 번짜리 일정이 빠지지 않음 · 범위 밖에서 범위 안으로 옮긴 회차도 보임', () => {
  const daily = Array.from({ length: 6 }, (_, i) => `BEGIN:VEVENT\nUID:d${i}\nDTSTART:2012010${i + 1}T000000Z\nRRULE:FREQ=DAILY\nSUMMARY:매일 ${i}\nEND:VEVENT`).join('\n');
  const text = `BEGIN:VCALENDAR\nVERSION:2.0\n${daily}
BEGIN:VEVENT\nUID:once\nDTSTART:20261020T010000Z\nDTEND:20261020T020000Z\nSUMMARY:한 번\nEND:VEVENT
BEGIN:VEVENT\nUID:wk\nDTSTART:20261005T010000Z\nRRULE:FREQ=WEEKLY\nSUMMARY:주간\nEND:VEVENT
BEGIN:VEVENT\nUID:wk\nRECURRENCE-ID:20261102T010000Z\nDTSTART:20261030T010000Z\nDTEND:20261030T020000Z\nSUMMARY:주간 (앞당김)\nEND:VEVENT
END:VCALENDAR`;
  const events = feedEvents(text, new Date(Date.UTC(2026, 9, 15)), new Date(Date.UTC(2026, 10, 1)));
  assert.ok(events.some((e) => e.title === '한 번'), '뒤의 한 번짜리');
  assert.ok(events.some((e) => e.title === '주간 (앞당김)'), '옮긴 회차');
  assert.equal(events.filter((e) => e.title === '매일 0').length, 17);
});

test('오늘 하루 종일 일정을 가져오면 켜 둠 · 아주 오래된 매시간 반복도 오늘 회차가 보임', () => {
  const now = local(2026, 10, 16, 8);
  const today = normalizeReminder(reminderFromExternal({ title: '생일', start: local(2026, 10, 16), allDay: true }, now));
  assert.equal(today.enabled, true);
  const hourly = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:h\nDTSTART:20200101T000000Z\nRRULE:FREQ=HOURLY\nSUMMARY:매시간\nEND:VEVENT\nEND:VCALENDAR';
  const t = Date.now();
  const got = feedEvents(hourly, new Date(Date.UTC(2026, 9, 16)), new Date(Date.UTC(2026, 9, 17)));
  assert.equal(got.length, 24);
  assert.ok(Date.now() - t < 8000);
});
