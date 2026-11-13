// CalDAV 읽기 (네이버 캘린더) — 계정 → 캘린더 찾기, 일정 합치기, 비밀번호는 같은 서버에만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caldavIcs } from '../app/js/core/caldav.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareFeed, feedEvents, normalizeFeeds } from '../app/js/core/calendar-feeds.js';
import { CalendarFeeds } from '../desktop/calendar-feeds.js';

const TZ = 'BEGIN:VTIMEZONE\nTZID:Asia/Seoul\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0900\nTZOFFSETTO:+0900\nEND:STANDARD\nEND:VTIMEZONE';
const event = (uid, start, title) => `BEGIN:VCALENDAR\nVERSION:2.0\n${TZ}\nBEGIN:VEVENT\nUID:${uid}\nDTSTART;TZID=Asia/Seoul:${start}\nDURATION:PT1H\nSUMMARY:${title}\nEND:VEVENT\nEND:VCALENDAR\n`;
const ms = (body) => `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;
const resp = (href, prop) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${prop}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const xmlText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// 네이버처럼: 처음 주소는 넘겨 가고, 계정(principal)을 거쳐 캘린더 모음을 알려 준다
function server() {
  const calls = [];
  const request = async (url, { method, headers, body }) => {
    calls.push({ url, method, depth: headers.Depth, auth: headers.Authorization });
    const path = new URL(url).pathname;
    if (headers.Authorization !== `Basic ${Buffer.from('mk:앱비번').toString('base64')}`) return { status: 401, text: '' };
    if (path === '/') return { status: 301, location: '/dav/', text: '' };
    if (method === 'PROPFIND' && path === '/dav/') return { status: 207, text: ms(resp('/dav/', '<D:resourcetype><D:collection/></D:resourcetype><D:current-user-principal><D:href>/principals/mk/</D:href></D:current-user-principal>')) };
    if (method === 'PROPFIND' && path === '/principals/mk/') return { status: 207, text: ms(resp(path, '<C:calendar-home-set><D:href>/calendars/mk/</D:href></C:calendar-home-set>')) };
    if (method === 'PROPFIND' && path === '/calendars/mk/') {
      assert.equal(headers.Depth, '1');
      return { status: 207, text: ms(resp(path, '<D:resourcetype><D:collection/></D:resourcetype>')
        + resp('/calendars/mk/work/', '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>회사</D:displayname>')
        + resp('/calendars/mk/home/', '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>')
        + resp('/calendars/mk/inbox/', '<D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype>')) };
    }
    if (method === 'REPORT') {
      assert.match(body, /calendar-query/);
      const one = path.includes('work') ? event('a', '20261120T100000', '회의 & 점심') : event('b', '20261121T150000', '치과');
      return { status: 207, text: ms(resp(`${path}1.ics`, `<C:calendar-data>${xmlText(one)}</C:calendar-data>`)) };
    }
    return { status: 404, text: '' };
  };
  return { request, calls };
}

test('계정 → 캘린더 모음 → 캘린더마다 일정, 한 .ics 로 합쳐 달력에 보인다', async () => {
  const { request, calls } = server();
  const ics = await caldavIcs({ url: 'https://caldav.calendar.naver.com', user: 'mk', pass: '앱비번' }, request);
  assert.equal(calls.filter((c) => c.method === 'REPORT').length, 2); // 일정 받은함(inbox)은 빼고
  assert.equal(ics.match(/BEGIN:VTIMEZONE/g).length, 1); // 같은 시간대는 한 번
  const events = feedEvents(prepareFeed(ics), new Date(2026, 10, 1), new Date(2026, 11, 1));
  assert.deepEqual(events.map((e) => e.title).sort(), ['치과', '회의 & 점심']);
});

test('비밀번호가 틀리면 알기 쉬운 오류, http 주소 · 다른 서버로는 비밀번호를 보내지 않는다', async () => {
  const { request } = server();
  await assert.rejects(caldavIcs({ url: 'https://caldav.calendar.naver.com', user: 'mk', pass: 'x' }, request), /애플리케이션 비밀번호/);
  await assert.rejects(caldavIcs({ url: 'http://caldav.calendar.naver.com', user: 'mk', pass: '앱비번' }, request), /https/);
  const calls = [];
  const evil = async (url) => {
    calls.push(url);
    return { status: 207, text: ms(resp('/', '<D:current-user-principal><D:href>https://evil.example/p/</D:href></D:current-user-principal>')) };
  };
  await assert.rejects(caldavIcs({ url: 'https://caldav.calendar.naver.com', user: 'mk', pass: '앱비번' }, evil), /다른 곳/);
  assert.equal(calls.length, 1);
});

test('구독 목록: CalDAV 계정은 아이디 · 비밀번호를 지키고, 같은 서버의 다른 아이디는 따로', () => {
  const list = normalizeFeeds([
    { url: 'https://caldav.calendar.naver.com', user: ' mk ', pass: 'p1' },
    { url: 'https://caldav.calendar.naver.com', user: 'other', pass: 'p2' },
    { url: 'https://caldav.calendar.naver.com', user: 'mk', pass: 'p3' },
  ]);
  assert.deepEqual(list.map((f) => [f.user, f.pass, f.name]), [['mk', 'p1', '네이버 캘린더'], ['other', 'p2', '네이버 캘린더']]);
});

test('PC: 아이디가 있는 구독은 CalDAV 로 받아 둔다', async () => {
  const { request } = server();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-dav-'));
  const store = new CalendarFeeds({
    dir,
    fetch: async (url, init) => {
      assert.equal(init.redirect, 'manual');
      const r = await request(url, init);
      return new Response(r.text || null, { status: r.status, headers: r.location ? { Location: r.location } : {} });
    },
    getList: () => [{ id: 'n1', url: 'https://caldav.calendar.naver.com', user: 'mk', pass: '앱비번' }],
    setList: () => {},
  });
  const got = await store.get('n1');
  assert.equal(got.error, undefined);
  assert.match(got.text, /SUMMARY:치과/);
});
