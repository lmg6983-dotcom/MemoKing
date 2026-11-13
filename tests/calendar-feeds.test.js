// 다른 캘린더 함께 보기 — .ics 구독 읽기 (반복 · 빠진 날 · 바뀐 회차 · 시간대), 휴대폰 캘린더
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFeedUrl, normalizeFeeds, feedLabel, icsName, looksLikeIcs, feedEvents, googleEventUrl, fromDeviceEvent, reminderFromExternal, importedEventBody,
  MAX_FEEDS,
} from '../app/js/core/calendar-feeds.js';
import { normalizeReminder } from '../app/js/core/reminders.js';

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

test('일정에 붙은 주소(URL) · 설명 속 주소: 인터넷 주소만 넘김', () => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//KO',
    'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261020T010000Z', 'DTEND:20261020T020000Z', 'SUMMARY:회의', 'URL:https://meet.example.com/abc', 'DESCRIPTION:자료: https://docs.example.com/x', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261021T010000Z', 'DTEND:20261021T020000Z', 'SUMMARY:이상한 주소', 'URL:javascript:alert(1)', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const [a, b] = feedEvents(ics, new Date(Date.UTC(2026, 9, 19)), new Date(Date.UTC(2026, 9, 23)));
  assert.equal(a.url, 'https://meet.example.com/abc');
  assert.equal(a.description, '자료: https://docs.example.com/x');
  assert.equal(b.url, '');
});

test('가져온 일정 메모 본문: 제목 · 달력 그림 · 장소 · 주소 · 설명 줄마다 문단, 줄 첫머리 마크다운은 글자로', () => {
  const body = importedEventBody({
    title: '가족  저녁', imageRel: 'attachments/2026 a.png', imageAlt: '2026년 10월 [달력]',
    location: '집', url: 'https://meet.example.com/x', description: '# 준비물\n\n\n- 케이크\n자세히: https://x.example.com',
  });
  assert.equal(body, '# 가족 저녁\n\n![2026년 10월 달력](attachments/2026%20a.png)\n\n장소: 집\n\n링크: https://meet.example.com/x\n\n\\# 준비물\n\n\\- 케이크\n\n자세히: https://x.example.com\n');
  // 그림 · 장소 · 설명이 없으면 제목만, 설명에 이미 있는 주소는 또 쓰지 않음
  assert.equal(importedEventBody({ title: '' }), '# 새 일정\n');
  assert.doesNotMatch(importedEventBody({ title: 'a', url: 'https://a.example.com', description: '여기 https://a.example.com' }), /링크:/);
});

test('Google 구독 일정 → 그 일정의 Google 캘린더 주소 (반복은 회차까지), Google 이 아니면 빈 글', () => {
  const feed = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics';
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:one123@google.com', 'DTSTART:20261120T010000Z', 'DTEND:20261120T020000Z', 'SUMMARY:한 번', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:rep456@google.com', 'DTSTART;VALUE=DATE:20261102', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:반복', 'END:VEVENT',
    'END:VCALENDAR', ''].join('\r\n');
  const events = feedEvents(ics, new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 11, 1)));
  const one = events.find((e) => e.title === '한 번');
  const rep1 = events.find((e) => e.title === '반복');
  const eid = (url) => atob(decodeURIComponent(new URL(url).searchParams.get('eid')));
  assert.equal(eid(googleEventUrl(feed, one)), 'one123 me@gmail.com');
  assert.equal(eid(googleEventUrl(feed, rep1)), 'rep456_20261102 me@gmail.com');
  assert.equal(googleEventUrl('https://example.com/a.ics', one), '');
  assert.equal(googleEventUrl(feed, { uid: 'x@naver.com' }), '');
});
