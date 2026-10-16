// Google 캘린더 상호 동기화 — 가짜 Google 캘린더 서버로: 메모킹 → Google, Google(삼성 캘린더) → 메모킹, 충돌, 두 기기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleCalendarSync, eventIdFor, keyOf, shapeOfEvent, shapeOfReminder, repeatOfRule, LEASE_MS } from '../app/js/core/gcal-sync.js';
import { normalizeReminder } from '../app/js/core/reminders.js';
import { FakeGoogle } from './fake-google.js';
import { toLocalIso } from '../app/js/core/time.js';

/** 가짜 메모 폴더 (Drive 로 함께 쓰는 상태 파일 포함) */
class FakeVault {
  constructor() {
    this.memos = new Map(); // id → { title, updated, reminders, trashed }
    this.stateFile = null;
    this.n = 0;
  }
  add(title, reminders, updated = '2026-10-16T00:00:00Z') {
    const id = `m${++this.n}`;
    this.memos.set(id, { title, updated, reminders: reminders.map((r) => normalizeReminder(r)), trashed: false });
    return id;
  }
  adapter() {
    return {
      all: () => [...this.memos.entries()].filter(([, m]) => !m.trashed).flatMap(([memoId, m]) => m.reminders.map((reminder) => ({ memoId, title: m.title, updated: m.updated, edited: m.edited, reminder }))),
      state: (id) => (!this.memos.has(id) ? 'missing' : this.memos.get(id).trashed ? 'trashed' : 'present'),
      setReminder: (id, rid, r) => {
        const m = this.memos.get(id);
        const list = m.reminders.filter((x) => x.id !== rid);
        m.reminders = r ? [...m.reminders.filter((x) => x.id !== rid), r] : list;
        if (r && m.reminders.length === list.length) m.reminders = [...list, r];
      },
      create: (title, r) => this.add(title, [r]),
    };
  }
}

const NOW = Date.UTC(2026, 9, 16, 0, 0, 0);
function setup() {
  const g = new FakeGoogle();
  const v = new FakeVault();
  let t = NOW;
  const make = (device) => new GoogleCalendarSync({
    request: (...a) => g.request(...a),
    store: { read: () => structuredClone(v.stateFile), write: (s) => { v.stateFile = structuredClone(s); } },
    memos: v.adapter(),
    device,
    timeZone: 'Asia/Seoul',
    now: () => t,
  });
  return { g, v, pc: make('pc'), phone: make('phone'), advance: (ms) => { t += ms; } };
}
const at = (iso) => ({ kind: 'at', at: iso, title: '치과', alerts: [30] });
const ours = (g) => [...g.events.values()].filter((e) => e.status !== 'cancelled');

test('일정 ID: 같은 메모 · 알림이면 어디서나 같은 ID (Google 규칙: a-v, 0-9)', () => {
  const id = eventIdFor(keyOf('00000000-0000-4000-8000-000000000001', 'r7k2'));
  assert.match(id, /^[a-v0-9]{5,1024}$/);
  assert.equal(id, eventIdFor('00000000-0000-4000-8000-000000000001/r7k2'));
});

test('처음: 메모킹 캘린더를 만들고 메모킹 일정을 넣는다 (Google 알림은 끔, 메모 키를 붙임)', async () => {
  const { g, v, pc } = setup();
  const id = v.add('치과 메모', [at('2026-10-20T15:00:00+09:00'), { kind: 'timer', at: '2026-10-16T10:00:00+09:00', minutes: 5 }]);
  const res = await pc.run();
  assert.equal(res.pushed, 1);
  const [ev] = ours(g);
  assert.equal(ev.summary, '치과');
  assert.equal(ev.description, '메모킹 메모: 치과 메모');
  assert.equal(new Date(ev.start.dateTime).toISOString(), '2026-10-20T06:00:00.000Z');
  assert.deepEqual(ev.reminders, { useDefault: false, overrides: [] });
  assert.equal(ev.extendedProperties.private.memoking, keyOf(id, v.memos.get(id).reminders[0].id));
  assert.equal(g.calendars.size, 1);
  // 다시 돌려도 아무것도 하지 않는다
  const again = await pc.run();
  assert.deepEqual([again.pushed, again.pulled, again.imported], [0, 0, 0]);
});

test('Google(삼성 캘린더)에서 시각 · 이름을 고치면 메모 일정이 바뀐다 · 알림은 그대로', async () => {
  const { g, v, pc } = setup();
  const id = v.add('치과 메모', [at('2026-10-20T15:00:00+09:00')]);
  await pc.run();
  const [ev] = ours(g);
  g.edit(ev.id, { summary: '치과 스케일링', start: { dateTime: '2026-10-21T10:30:00+09:00' }, end: { dateTime: '2026-10-21T11:30:00+09:00' } });
  const res = await pc.run();
  assert.equal(res.pulled, 1);
  const r = v.memos.get(id).reminders[0];
  assert.equal(r.title, '치과 스케일링');
  assert.equal(new Date(r.at).toISOString(), '2026-10-21T01:30:00.000Z');
  assert.deepEqual(r.alerts, [30]);
  assert.equal((await pc.run()).pushed, 0, '받은 것을 다시 보내지 않음');
});

test('Google 에서 지우면 메모의 일정도 지운다 · 메모킹에서 지우면 Google 에서도', async () => {
  const { g, v, pc } = setup();
  const a = v.add('하나', [at('2026-10-20T15:00:00+09:00')]);
  const b = v.add('둘', [{ ...at('2026-10-22T09:00:00+09:00'), title: '둘' }]);
  await pc.run();
  const evA = ours(g).find((e) => e.summary === '치과');
  g.edit(evA.id, { status: 'cancelled' });
  v.adapter().setReminder(b, v.memos.get(b).reminders[0].id, null);
  const res = await pc.run();
  assert.equal(v.memos.get(a).reminders.length, 0);
  assert.equal(ours(g).length, 0);
  assert.equal(res.removed, 2);
});

test('그 캘린더에 새로 만든 일정 → 새 메모 (반복 · 하루 종일까지), 그다음부터는 이어짐', async () => {
  const { g, v, pc } = setup();
  await pc.run();
  g.create({ summary: '주간 회의', start: { dateTime: '2026-10-19T10:00:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-19T11:00:00+09:00' }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'] });
  g.create({ summary: '엄마 생일', start: { date: '2026-10-28' }, end: { date: '2026-10-29' } });
  const res = await pc.run();
  assert.equal(res.imported, 2);
  const titles = [...v.memos.values()].map((m) => m.title).sort();
  assert.deepEqual(titles, ['엄마 생일', '주간 회의']);
  const weekly = [...v.memos.values()].find((m) => m.title === '주간 회의').reminders[0];
  const tenSeoul = new Date('2026-10-19T10:00:00+09:00'); // 이 컴퓨터 시각으로
  const hm = `${String(tenSeoul.getHours()).padStart(2, '0')}:${String(tenSeoul.getMinutes()).padStart(2, '0')}`;
  assert.deepEqual([weekly.kind, weekly.repeat.every, weekly.repeat.time], ['repeat', 'week', hm]);
  assert.equal(weekly.repeat.weekdays.length, 2);
  const bday = [...v.memos.values()].find((m) => m.title === '엄마 생일').reminders[0];
  assert.equal(bday.allDay, true);
  // 이어짐: 메모킹에서 고치면 그 일정이 바뀐다 (새로 만들지 않음)
  const [bdayId] = [...v.memos.entries()].find(([, m]) => m.title === '엄마 생일');
  v.adapter().setReminder(bdayId, bday.id, normalizeReminder({ ...bday, at: toLocalIso(new Date(2026, 9, 29)) }));
  v.memos.get(bdayId).updated = '2026-10-17T00:00:00Z';
  await pc.run();
  assert.equal(ours(g).length, 2);
  assert.equal(ours(g).find((e) => e.summary === '엄마 생일').start.date, '2026-10-29');
});

test('양쪽 다 고치면 나중에 고친 쪽 · Google 에서 지웠지만 메모킹에서 고쳤으면 살린다', async () => {
  const { g, v, pc } = setup();
  const id = v.add('치과 메모', [at('2026-10-20T15:00:00+09:00')]);
  await pc.run();
  const [ev] = ours(g);
  const rid = v.memos.get(id).reminders[0].id;
  // 메모킹이 나중에 고침
  g.edit(ev.id, { summary: 'Google 이름' });
  v.adapter().setReminder(id, rid, normalizeReminder({ ...v.memos.get(id).reminders[0], title: '메모킹 이름' }));
  v.memos.get(id).updated = '2027-01-01T00:00:00Z';
  await pc.run();
  assert.equal(g.events.get(ev.id).summary, '메모킹 이름');
  // Google 에서 지웠는데 메모킹에서 고침 → 살림
  g.edit(ev.id, { status: 'cancelled' });
  v.adapter().setReminder(id, rid, normalizeReminder({ ...v.memos.get(id).reminders[0], at: '2026-10-25T15:00:00+09:00' }));
  await pc.run();
  assert.equal(g.events.get(ev.id).status, 'confirmed');
});

test('PC · 휴대폰 둘 다 켜져 있으면 한 기기만 맡고, 20분 소식이 없으면 이어받는다 · 같은 일정을 두 번 만들지 않음', async () => {
  const { g, v, pc, phone, advance } = setup();
  v.add('치과 메모', [at('2026-10-20T15:00:00+09:00')]);
  await pc.run();
  const skipped = await phone.run();
  assert.equal(skipped.skipped, 'lease');
  advance(LEASE_MS + 1000);
  const took = await phone.run();
  assert.equal(took.skipped, undefined);
  assert.equal(ours(g).length, 1);
  // 상태를 잃은 기기가 처음부터 맞춰도 하나만
  v.stateFile = { ...v.stateFile, items: {}, syncToken: null, lease: null };
  await pc.run();
  assert.equal(ours(g).length, 1);
});

test('메모킹이 나타낼 수 없는 반복(격주)은 메모 쪽을 그대로 두고 Google 을 덮지 않음', async () => {
  const { g, v, pc } = setup();
  const id = v.add('운동', [{ kind: 'repeat', title: '운동', repeat: { every: 'week', weekdays: [2], time: '07:00' } }]);
  await pc.run();
  const [ev] = ours(g);
  g.edit(ev.id, { recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU'] });
  await pc.run();
  assert.equal(v.memos.get(id).reminders[0].repeat.every, 'week');
  assert.deepEqual(g.events.get(ev.id).recurrence, ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU']);
});

test('반복 규칙 · 모양 변환', () => {
  const mon = new Date(2026, 9, 19);
  assert.deepEqual(repeatOfRule('RRULE:FREQ=MONTHLY', mon), { every: 'month', day: 19 });
  assert.deepEqual(repeatOfRule('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=9', mon), { every: 'year', month: 3, day: 9 });
  assert.equal(repeatOfRule('FREQ=MONTHLY;BYDAY=2MO', mon), null);
  assert.equal(repeatOfRule('FREQ=DAILY;COUNT=5', mon), null);
  assert.equal(shapeOfEvent({ status: 'cancelled' }), 'deleted');
  const r = normalizeReminder({ kind: 'repeat', title: '회의', repeat: { every: 'week', weekdays: [3, 1], time: '10:00' } });
  assert.deepEqual(shapeOfReminder(r).repeat, { every: 'week', weekdays: [1, 3], time: '10:00' });
});

test('매년 일정은 몇 번을 맞춰도 오가지 않음 (메모킹 · Google 모양이 같은 글)', async () => {
  const { g, v, pc } = setup();
  v.add('기념일', [{ kind: 'repeat', title: '결혼기념일', allDay: true, repeat: { every: 'year', month: 3, day: 5 } }]);
  await pc.run();
  const callsAfterFirst = g.calls.filter((c) => !c.startsWith('GET')).length;
  for (let i = 0; i < 3; i++) {
    const res = await pc.run();
    assert.deepEqual([res.pushed, res.pulled], [0, 0], `회차 ${i}`);
  }
  assert.equal(g.calls.filter((c) => !c.startsWith('GET')).length, callsAfterFirst);
});

test('상태 파일을 읽지 못하면 이번엔 건너뜀 (캘린더를 하나 더 만들지 않음)', async () => {
  const { g, v } = setup();
  v.add('치과 메모', [at('2026-10-20T15:00:00+09:00')]);
  const broken = new GoogleCalendarSync({
    request: (...a) => g.request(...a), device: 'pc', timeZone: 'Asia/Seoul', now: () => NOW,
    store: { read: () => { throw new SyntaxError('Unexpected end of JSON'); }, write: () => {} },
    memos: v.adapter(),
  });
  await assert.rejects(broken.run(), /상태 파일/);
  assert.equal(g.calendars.size, 0);
});

test('메모킹에서 고쳐 보낼 때 Google 에서 넣은 장소 · 설명 · 길이는 지킨다', async () => {
  const { g, v, pc } = setup();
  const id = v.add('치과 메모', [at('2026-10-20T15:00:00+09:00')]);
  await pc.run();
  const [ev] = ours(g);
  g.edit(ev.id, { location: '강남역 치과', description: '보험증 챙기기', end: { dateTime: '2026-10-20T17:00:00+09:00' } });
  await pc.run();
  const r = v.memos.get(id).reminders[0];
  v.adapter().setReminder(id, r.id, normalizeReminder({ ...r, title: '치과 (스케일링)' }));
  v.memos.get(id).edited = '2027-01-01T00:00:00Z';
  await pc.run();
  const after = g.events.get(ev.id);
  assert.equal(after.summary, '치과 (스케일링)');
  assert.equal(after.location, '강남역 치과');
  assert.equal(after.description, '보험증 챙기기');
  assert.equal(Date.parse(after.end.dateTime) - Date.parse(after.start.dateTime), 2 * 3600_000);
});

test('양쪽 다 고쳤을 때 메모 쪽 때는 파일을 고친 때(edited) — 알림만 바꿔도 메모킹이 나중이면 메모킹', async () => {
  const { g, v, pc } = setup();
  const id = v.add('오래된 메모', [at('2026-10-20T15:00:00+09:00')], '2026-01-01T00:00:00Z');
  await pc.run();
  const [ev] = ours(g);
  g.edit(ev.id, { summary: 'Google 이름' });
  const r = v.memos.get(id).reminders[0];
  v.adapter().setReminder(id, r.id, normalizeReminder({ ...r, at: '2026-10-21T15:00:00+09:00' }));
  v.memos.get(id).edited = '2099-01-01T00:00:00Z';
  await pc.run();
  assert.equal(new Date(g.events.get(ev.id).start.dateTime).toISOString(), '2026-10-21T06:00:00.000Z');
});

test('다른 기기가 맡은 중에도 "지금 맞추기"(force)는 맞춘다', async () => {
  const { v, pc, phone } = setup();
  v.add('치과 메모', [at('2026-10-20T15:00:00+09:00')]);
  await pc.run();
  const background = phone.run();
  const forced = phone.run({ force: true });
  assert.equal((await background).skipped, 'lease');
  assert.equal((await forced).skipped, undefined);
});
