// PC Google 캘린더 상호 동기화 — 진짜 메모 폴더(Vault) + 가짜 Google: 메모 → 캘린더, 캘린더에서 고친 것 · 새 일정 → 메모, 휴지통
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../desktop/vault.js';
import { createCalendarSync } from '../desktop/calendar-sync.js';
import { FakeGoogle } from './fake-google.js';

const opened = [];
after(() => {
  for (const v of opened) v.close();
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-gcal-vault-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-gcal-user-'));
  // 이미 연결된 것처럼 (캘린더 로그인 토큰)
  fs.writeFileSync(path.join(userData, 'google-calendar-auth.json'), JSON.stringify({ plain: { refreshToken: 'RT', scope: 'https://www.googleapis.com/auth/calendar.app.created', tokenClient: { id: 'c', secret: 's' } } }));
  const vault = new Vault(root, { orphanDelay: 0 });
  vault.open();
  opened.push(vault);
  const g = new FakeGoogle({ realTime: true });
  const changed = [];
  const statuses = [];
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }));
    const res = await g.request(init.method ?? 'GET', String(url), init.body ? JSON.parse(init.body) : undefined);
    return new Response(res.status === 204 ? null : JSON.stringify(res.json ?? {}), { status: res.status });
  };
  const sync = createCalendarSync({
    userData, bundledClient: [], driveAuth: () => null, fetch, openExternal: () => {}, getVault: () => vault,
    onChanged: (ids) => changed.push(...ids), onStatus: (s) => statuses.push(s),
  });
  return { vault, g, sync, changed, statuses, root };
}
const live = (g) => [...g.events.values()].filter((e) => e.status !== 'cancelled');

test('PC: 메모 일정이 "메모킹" 캘린더에 들어가고, 캘린더에서 고친 것 · 새로 만든 일정이 메모로 온다', async () => {
  const { vault, g, sync, changed, root } = setup();
  const id = vault.import({ body: '# 치과 메모\n\n스케일링\n' });
  vault.setReminders(id, [{ id: 'r1', kind: 'at', at: '2026-12-20T15:00:00+09:00', title: '치과', alerts: [30], action: 'notify', enabled: true, created: '2026-10-16T09:00:00+09:00' }]);
  const first = await sync.run();
  assert.equal(first.error, '');
  assert.equal(live(g).length, 1);
  assert.ok(fs.existsSync(path.join(root, '_memoking', 'google-calendar.json')), '상태 파일은 메모 폴더(Drive 로 함께)');
  // 삼성 캘린더에서 시각을 옮김
  const ev = live(g)[0];
  g.edit(ev.id, { start: { dateTime: '2026-12-21T11:00:00+09:00' }, end: { dateTime: '2026-12-21T12:00:00+09:00' } });
  // Google 캘린더에서 새 일정
  g.create({ summary: '팀 점심', start: { dateTime: '2026-12-22T12:00:00+09:00' }, end: { dateTime: '2026-12-22T13:00:00+09:00' } });
  await sync.run();
  const r = vault.get(id).reminders[0];
  assert.equal(new Date(r.at).toISOString(), '2026-12-21T02:00:00.000Z');
  assert.ok(changed.includes(id));
  const lunch = vault.list().find((m) => m.title === '팀 점심');
  assert.ok(lunch, '새 일정 → 새 메모');
  assert.equal(vault.get(lunch.id).reminders[0].kind, 'at');
  // 메모를 휴지통에 버리면 캘린더에서도 지운다
  vault.trash(id);
  await sync.run();
  assert.deepEqual(live(g).map((e) => e.summary), ['팀 점심']);
});

test('PC: 연결 전에는 아무것도 하지 않음 · 메모 글만 바꾸면 다시 맞추지 않음', async () => {
  const { vault, sync, g } = setup();
  sync.disconnect();
  const id = vault.import({ body: '# 메모\n' });
  vault.setReminders(id, [{ id: 'r1', kind: 'at', at: '2026-12-20T15:00:00+09:00', action: 'notify' }]);
  const res = await sync.run();
  assert.equal(res.connected, false);
  assert.equal(g.calls.length, 0);
});
