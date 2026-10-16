// PC 다른 캘린더 받기 — 15분 안이면 받아 둔 것, 실패하면 받아 둔 것 + 오류, iCal 이 아니면 오류, 지운 캘린더는 파일도 지움
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CalendarFeeds, FRESH_MS } from '../desktop/calendar-feeds.js';

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

function setup(respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-cal-'));
  let list = [{ id: 'g1', url: 'https://calendar.google.com/a.ics', name: '회사' }];
  let t = 1_000_000;
  const calls = [];
  const store = new CalendarFeeds({
    dir,
    fetch: async (url) => {
      calls.push(url);
      return respond(url, calls.length);
    },
    getList: () => list,
    setList: (next) => {
      list = next;
    },
    now: () => t,
  });
  return { store, dir, calls, tick: (ms) => { t += ms; }, list: () => list };
}

test('받아 두고 15분 안에는 다시 받지 않음, 지나면 새로, 받지 못하면 받아 둔 것 + 오류', async () => {
  let fail = false;
  const { store, calls, tick } = setup(() => (fail ? Promise.reject(new Error('offline')) : new Response(ICS)));
  const a = await store.get('g1');
  assert.equal(a.text, ICS);
  await store.get('g1');
  assert.equal(calls.length, 1);
  tick(FRESH_MS + 1);
  fail = true;
  const c = await store.get('g1');
  assert.equal(calls.length, 2);
  assert.equal(c.text, ICS);
  assert.match(c.error, /연결하지 못했어요/);
});

test('다시 켜도 파일에서 그대로 · 주소가 바뀌면 받아 둔 것은 쓰지 않음', async () => {
  const { store, dir } = setup(() => new Response(ICS));
  await store.get('g1');
  const again = new CalendarFeeds({ dir, fetch: async () => { throw new Error('x'); }, getList: () => [{ id: 'g1', url: 'https://calendar.google.com/a.ics' }], setList: () => {}, now: () => 1_000_000 });
  assert.equal((await again.get('g1')).text, ICS);
  const moved = new CalendarFeeds({ dir, fetch: async () => { throw new Error('x'); }, getList: () => [{ id: 'g1', url: 'https://calendar.google.com/b.ics' }], setList: () => {}, now: () => 1_000_000 });
  const r = await moved.get('g1');
  assert.equal(r.text, '');
  assert.ok(r.error);
});

test('iCal 이 아니거나(로그인 화면) 404 · 너무 크면 알기 쉬운 오류', async () => {
  for (const [res, re] of [
    [new Response('<html>로그인</html>'), /iCal/],
    [new Response('no', { status: 404 }), /볼 수 없어요/],
    [new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024) } }), /너무 커요/],
  ]) {
    const { store } = setup(() => res);
    assert.match((await store.get('g1', { force: true })).error, re);
  }
});

test('목록 저장: 지운 캘린더의 받아 둔 파일도 지움 · 없는 캘린더는 오류', async () => {
  const { store, dir, list } = setup(() => new Response(ICS));
  await store.get('g1');
  assert.ok(fs.existsSync(path.join(dir, 'g1.ics')));
  store.save([]);
  assert.deepEqual(list(), []);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(dir, 'g1.ics')), false);
  assert.ok((await store.get('g1')).error);
});

test('받는 사이 연결을 끊으면 받은 글을 파일로 남기지 않음', async () => {
  let release;
  const { store, dir } = setup(() => new Promise((r) => { release = () => r(new Response(ICS)); }));
  const pending = store.get('g1');
  await new Promise((r) => setTimeout(r, 10));
  store.save([]);
  release();
  await pending;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(dir, 'g1.ics')), false);
});
