// Google 캘린더 상호 동기화 (순수 로직, 단위 테스트 대상) — PC 메인 프로세스 · 휴대폰이 같은 코드로 돈다
//
//   메모킹 일정(메모의 at · repeat 알림) ⇄ Google 계정의 "메모킹" 캘린더 (메모킹이 만든 캘린더만 보는 권한 calendar.app.created)
//   - 메모킹에서 만들고 고치고 지운 일정 → 그 캘린더로
//   - Google 캘린더 · 삼성 캘린더(휴대폰의 Google 계정으로 그 캘린더가 보인다)에서 고치고 지운 것 → 메모로
//   - 그 캘린더에 새로 만든 일정 → 새 메모 (일정 이름이 메모 제목)
//
//   충돌: 지난번에 서로 맞춘 모양(hash)을 기억해 두고 한쪽만 바뀌었으면 그쪽을, 양쪽 다 바뀌었으면 나중에 고친 쪽을 따른다.
//   PC · 휴대폰 둘 다 켜져 있어도 한 기기만 맡는다: 상태 파일(_memoking/google-calendar.json, Drive 로 함께 씀)의
//   임대(lease) — 맡은 기기가 20분 동안 소식이 없으면 다른 기기가 이어받는다. 일정 ID 는 메모 · 알림 id 로 정해져
//   (결정적 ID) 두 기기가 겹쳐 만들어도 하나만 생긴다.
//
//   메모킹이 알림을 울리므로 Google 쪽 알림은 끈다 (휴대폰에서 두 번 울리지 않게).
import { normalizeReminder, isEvent, isDone, occurrenceEnd, DEFAULT_ALERTS, EVERY } from './reminders.js';
import { toLocalIso, pad2 } from './time.js';
import { rruleOf, eventSpan, WEEKDAY_CODES, DEFAULT_MINUTES } from './calendar-events.js';

export const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const STATE_FILE = '_memoking/google-calendar.json';
export const CALENDAR_NAME = '메모킹';
const API = 'https://www.googleapis.com/calendar/v3';
export const LEASE_MS = 20 * 60_000;
const KEY_PROP = 'memoking'; // extendedProperties.private 의 "메모 id/알림 id"

export class CalendarSyncError extends Error {}

// ---------- 일정 ID ----------

/** 메모 · 알림 → 키 */
export const keyOf = (memoId, reminderId) => `${memoId}/${reminderId}`;

/** 키 → Google 일정 ID (소문자 a-v · 숫자만 되는 base32hex) — 같은 키면 어느 기기에서나 같은 ID */
export function eventIdFor(key) {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  let bits = 0;
  let value = 0;
  let out = 'mk';
  for (const byte of new TextEncoder().encode(key)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

// ---------- 비교용 모양 ----------
// 일정의 뜻만 (이름 · 하루 종일 · 언제 · 반복) — 알림 · 켜고 끔 · 울린 기록은 메모킹에만 있는 것이라 빼고 비교한다

const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const minuteKey = (d) => `${dayKey(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * 메모킹 알림 → 모양 (일정이 아니면 null)
 * @returns {{ title: string, allDay: boolean, at?: string, repeat?: object } | null}
 */
export function shapeOfReminder(r, memoTitle = '') {
  if (!r || !isEvent(r)) return null;
  const allDay = Boolean(r.allDay);
  const shape = { title: cleanTitle(r.title || memoTitle) || '일정', allDay };
  if (r.kind === 'at') {
    const at = new Date(r.at);
    if (Number.isNaN(at.getTime())) return null;
    shape.at = allDay ? dayKey(at) : minuteKey(at);
  } else {
    const rep = r.repeat;
    shape.repeat = { every: rep.every };
    if (rep.every === 'week') shape.repeat.weekdays = [...rep.weekdays].sort((a, b) => a - b);
    if (rep.every === 'month' || rep.every === 'year') shape.repeat.day = rep.day;
    if (rep.every === 'year') shape.repeat.month = rep.month;
    if (!allDay) shape.repeat.time = rep.time;
  }
  return shape;
}

export const shapeHash = (shape) => (shape ? JSON.stringify(shape) : '');

/** Google 일정 시작 → 이 기기 시각 (하루 종일은 그날 자정) */
function startOf(ev) {
  if (ev.start?.date) {
    const [y, m, d] = ev.start.date.split('-').map(Number);
    return { date: new Date(y, m - 1, d), allDay: true };
  }
  const t = new Date(ev.start?.dateTime ?? '');
  return Number.isNaN(t.getTime()) ? null : { date: t, allDay: false };
}

/** RRULE → 메모킹 반복 (메모킹이 나타낼 수 없는 규칙이면 null: 격주 · 횟수 · 끝나는 날 · 둘째 월요일 …) */
export function repeatOfRule(rule, start) {
  const parts = Object.fromEntries(String(rule).replace(/^RRULE:/i, '').split(';').filter(Boolean).map((p) => {
    const [k, v = ''] = p.split('=');
    return [k.toUpperCase(), v.toUpperCase()];
  }));
  const known = new Set(['FREQ', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST', 'INTERVAL']);
  if (Object.keys(parts).some((k) => !known.has(k))) return null;
  if (parts.INTERVAL && parts.INTERVAL !== '1') return null;
  const freq = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[parts.FREQ];
  if (!freq || !EVERY.includes(freq)) return null;
  const single = (v) => (v && /^\d{1,2}$/.test(v) ? Number(v) : null);
  if (freq === 'day') return parts.BYDAY || parts.BYMONTHDAY || parts.BYMONTH ? null : { every: 'day' };
  if (freq === 'week') {
    if (parts.BYMONTHDAY || parts.BYMONTH) return null;
    const days = parts.BYDAY ? parts.BYDAY.split(',') : [WEEKDAY_CODES[start.getDay()]];
    const idx = days.map((d) => WEEKDAY_CODES.indexOf(d));
    return idx.some((i) => i < 0) ? null : { every: 'week', weekdays: [...new Set(idx)].sort((a, b) => a - b) };
  }
  if (parts.BYDAY) return null;
  const day = parts.BYMONTHDAY ? single(parts.BYMONTHDAY) : start.getDate();
  if (!day || day > 31) return null;
  if (freq === 'month') return parts.BYMONTH ? null : { every: 'month', day };
  const month = parts.BYMONTH ? single(parts.BYMONTH) : start.getMonth() + 1;
  return month && month <= 12 ? { every: 'year', month, day } : null;
}

/**
 * Google 일정 → 모양. 취소(지움)는 'deleted', 메모킹이 나타낼 수 없는 반복은 { unsupported } (메모 쪽은 그대로 두고 Google 은 덮지 않는다)
 */
export function shapeOfEvent(ev) {
  if (!ev || ev.status === 'cancelled') return 'deleted';
  const s = startOf(ev);
  if (!s) return { unsupported: 'time' };
  const shape = { title: cleanTitle(ev.summary) || '일정', allDay: s.allDay };
  const rules = (ev.recurrence ?? []).filter((l) => /^RRULE:/i.test(l));
  if (rules.length > 1 || (ev.recurrence ?? []).some((l) => /^RDATE/i.test(l))) return { ...shape, unsupported: 'rule' };
  if (!rules.length) {
    shape.at = s.allDay ? dayKey(s.date) : minuteKey(s.date);
    return shape;
  }
  const repeat = repeatOfRule(rules[0], s.date);
  if (!repeat) return { ...shape, unsupported: 'rule' };
  if (!s.allDay) repeat.time = `${pad2(s.date.getHours())}:${pad2(s.date.getMinutes())}`;
  shape.repeat = repeat;
  return shape;
}

/** 모양을 메모킹 알림에 입힌다 (알림 · 켜고 끔은 지키고, 하루 종일이 바뀌면 미리 알림을 기본값으로) */
export function applyShape(r, shape, now = new Date()) {
  const allDay = Boolean(shape.allDay);
  const sameKind = r && Boolean(r.allDay) === allDay;
  const base = {
    id: r?.id,
    action: r?.action ?? 'notify',
    created: r?.created ?? toLocalIso(now),
    title: shape.title,
    alerts: sameKind && Array.isArray(r?.alerts) ? r.alerts : [...(allDay ? DEFAULT_ALERTS.allDay : DEFAULT_ALERTS.timed)],
    ...(allDay ? { allDay: true } : {}),
  };
  if (shape.at) {
    const [d, t = '00:00'] = shape.at.split('T');
    const [y, m, day] = d.split('-').map(Number);
    const [h, min] = t.split(':').map(Number);
    const start = new Date(y, m - 1, day, allDay ? 0 : h, allDay ? 0 : min);
    const future = occurrenceEnd(start, allDay) > now;
    const unchanged = r?.kind === 'at' && shapeOfReminder(r)?.at === shape.at && Boolean(r.allDay) === allDay;
    return normalizeReminder({
      ...base,
      kind: 'at',
      at: toLocalIso(start),
      // 때가 그대로면 울린 기록 · 켜고 끔도 그대로. 앞으로 옮겼으면 다시 울리게, 지난 때로 옮겼으면 울린 것으로
      last: unchanged ? r.last : future ? null : toLocalIso(now),
      enabled: r ? (unchanged ? r.enabled : r.enabled || (isDone(r) && future)) : future,
    }, now);
  }
  return normalizeReminder({
    ...base,
    kind: 'repeat',
    repeat: { ...shape.repeat, time: shape.repeat.time ?? r?.repeat?.time ?? '09:00' },
    last: r?.last ?? null,
    enabled: r?.enabled ?? true,
  }, now);
}

/** 메모킹 알림 → Google 일정 내용 */
export function eventBodyFor(r, { memoTitle = '', key, timeZone, extra = [], now = new Date() }) {
  const span = eventSpan(r, now);
  if (!span) return null;
  const title = cleanTitle(r.title || memoTitle) || '일정';
  const time = (d) => (span.allDay ? { date: dayKey(d) } : { dateTime: toLocalIso(d), timeZone });
  const rrule = rruleOf(r);
  return {
    summary: title,
    description: memoTitle && cleanTitle(memoTitle) !== title ? `메모킹 메모: ${memoTitle}` : '메모킹 일정',
    start: time(span.start),
    end: time(span.allDay ? span.end : new Date(span.start.getTime() + DEFAULT_MINUTES * 60_000)),
    ...(rrule ? { recurrence: [`RRULE:${rrule}`, ...extra] } : {}),
    status: 'confirmed',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { [KEY_PROP]: key } },
  };
}

// ---------- 동기화 ----------

/**
 * @typedef {{ memoId: string, title: string, updated?: string, reminder: any }} LocalItem
 * @typedef {{
 *   request: (method: string, url: string, body?: any) => Promise<{ status: number, json: any }>,
 *   store: { read: () => (any | Promise<any>), write: (state: any) => (void | Promise<void>) },
 *   memos: {
 *     all: () => (LocalItem[] | Promise<LocalItem[]>),
 *     state: (memoId: string) => ('present' | 'trashed' | 'missing'),
 *     setReminder: (memoId: string, reminderId: string, reminder: any | null) => any,
 *     create: (title: string, reminder: any) => (string | Promise<string>),
 *   },
 *   device: string, timeZone?: string, now?: () => number,
 * }} SyncOptions
 */
export class GoogleCalendarSync {
  /** @param {SyncOptions} o */
  constructor({ request, store, memos, device, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Date.now }) {
    this.request = request;
    this.store = store;
    this.memos = memos;
    this.device = device;
    this.timeZone = timeZone;
    this.now = now;
    this.running = null;
  }

  /** 겹쳐 돌지 않게 */
  run(opts = {}) {
    this.running ??= this.runOnce(opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async api(method, path, body) {
    const res = await this.request(method, `${API}${path}`, body);
    if (res.status === 401 || res.status === 403) {
      const reason = res.json?.error?.errors?.[0]?.reason ?? res.json?.error?.status ?? '';
      if (/accessNotConfigured|SERVICE_DISABLED/i.test(JSON.stringify(res.json ?? ''))) {
        throw new CalendarSyncError('Google Cloud 에서 Google Calendar API 를 켜야 해요 (android/DRIVE-SETUP.md 의 "캘린더 동기화")');
      }
      throw new CalendarSyncError(res.status === 401 ? 'Google 캘린더 연결이 끊겼어요. 다시 연결해 주세요' : `Google 캘린더 권한이 없어요 (${reason || res.status})`);
    }
    return res;
  }

  /** 상태 파일을 읽어 기본값을 채운다 */
  async readState() {
    let raw = null;
    try {
      raw = await this.store.read();
    } catch {
      raw = null;
    }
    return {
      calendarId: typeof raw?.calendarId === 'string' ? raw.calendarId : null,
      syncToken: typeof raw?.syncToken === 'string' ? raw.syncToken : null,
      items: raw?.items && typeof raw.items === 'object' ? raw.items : {},
      lease: raw?.lease ?? null,
      lastSync: raw?.lastSync ?? 0,
    };
  }

  async runOnce({ force = false } = {}) {
    const now = this.now();
    const st = await this.readState();
    if (!force && st.lease && st.lease.device !== this.device && st.lease.until > now) {
      return { skipped: 'lease', holder: st.lease.device, lastSync: st.lastSync };
    }
    st.lease = { device: this.device, until: now + LEASE_MS };
    const summary = { pushed: 0, pulled: 0, imported: 0, removed: 0, notes: [] };

    // 1) 메모킹 캘린더 (없거나 지웠으면 새로 — 그러면 처음부터 다시 맞춘다)
    if (st.calendarId) {
      const got = await this.api('GET', `/calendars/${encodeURIComponent(st.calendarId)}`);
      if (got.status === 404 || got.status === 410) Object.assign(st, { calendarId: null });
      else if (got.status >= 400) throw new CalendarSyncError(`Google 캘린더 오류 (${got.status})`);
    }
    if (!st.calendarId) {
      const made = await this.api('POST', '/calendars', { summary: CALENDAR_NAME, description: '메모킹 일정 — 여기서 고치거나 만든 일정은 메모킹으로 와요', timeZone: this.timeZone });
      if (made.status >= 400 || !made.json?.id) throw new CalendarSyncError(`메모킹 캘린더를 만들지 못했어요 (${made.status})`);
      Object.assign(st, { calendarId: made.json.id, syncToken: null, items: {} });
    }
    const cal = `/calendars/${encodeURIComponent(st.calendarId)}`;

    // 2) 바뀐 일정 받기 (처음 · 토큰이 만료되면 모두)
    let full = !st.syncToken;
    let remote = [];
    let nextToken = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      remote = [];
      let page = null;
      let expired = false;
      do {
        const q = new URLSearchParams({ showDeleted: 'true', maxResults: '250' });
        if (!full) q.set('syncToken', st.syncToken);
        if (page) q.set('pageToken', page);
        const res = await this.api('GET', `${cal}/events?${q}`);
        if (res.status === 410) {
          expired = true;
          break;
        }
        if (res.status >= 400) throw new CalendarSyncError(`Google 캘린더 일정을 받지 못했어요 (${res.status})`);
        remote.push(...(res.json?.items ?? []));
        page = res.json?.nextPageToken ?? null;
        nextToken = res.json?.nextSyncToken ?? nextToken;
      } while (page);
      if (!expired) break;
      full = true;
      st.syncToken = null;
    }

    // 3) 견주기
    const local = new Map();
    for (const item of await this.memos.all()) {
      const shape = shapeOfReminder(item.reminder, item.title);
      if (shape) local.set(keyOf(item.memoId, item.reminder.id), { ...item, shape });
    }
    const byKey = new Map();
    const foreign = [];
    for (const ev of remote) {
      if (ev.recurringEventId) continue; // 반복 일정의 한 회차만 고친 것 — Google 쪽에만 둔다
      const key = ev.extendedProperties?.private?.[KEY_PROP];
      if (key) byKey.set(key, ev);
      else if (ev.status !== 'cancelled') {
        // 키 없이 들어온 것: 상태에 그 일정 id 로 적어 둔 것(가져온 일정)인지 먼저
        const known = Object.entries(st.items).find(([, v]) => v.eventId === ev.id);
        if (known) byKey.set(known[0], ev);
        else foreign.push(ev);
      } else {
        const known = Object.entries(st.items).find(([, v]) => v.eventId === ev.id);
        if (known) byKey.set(known[0], ev);
      }
    }

    const keys = new Set([...local.keys(), ...Object.keys(st.items), ...byKey.keys()]);
    for (const key of keys) {
      const [memoId, reminderId] = key.split('/');
      const L = local.get(key) ?? null;
      const S = st.items[key] ?? null;
      const ev = byKey.get(key);
      const memoState = L ? 'present' : this.memos.state(memoId);
      if (!L && memoState === 'missing') continue; // 이 기기에 아직 오지 않은 메모 — 건드리지 않는다
      // 원격: 받은 목록에 있으면 그 모양, 모두 받았는데 없으면 지운 것, 바뀐 것만 받았는데 없으면 그대로
      const R = ev ? shapeOfEvent(ev) : full && S ? 'deleted' : undefined;
      const rHash = R && R !== 'deleted' && !R.unsupported ? shapeHash(R) : null;
      const lHash = L ? shapeHash(L.shape) : null;

      if (!S) {
        if (L && (R === undefined || R === 'deleted')) {
          await this.push(st, cal, key, L, null);
          summary.pushed++;
        } else if (L && R && R !== 'deleted') {
          if (R.unsupported) st.items[key] = { eventId: ev.id, hash: lHash, readOnly: true };
          else if (rHash === lHash) st.items[key] = { eventId: ev.id, hash: lHash, extra: extraOf(ev) };
          else if (newer(ev.updated, L.updated)) {
            await this.pull(st, key, L, R, ev);
            summary.pulled++;
          } else {
            st.items[key] = { eventId: ev.id, hash: '', extra: extraOf(ev) };
            await this.push(st, cal, key, L, ev.id);
            summary.pushed++;
          }
        } else if (!L && R && R !== 'deleted' && memoState !== 'missing') {
          // 메모에서 이미 지운 일정이 Google 에 남아 있다 (상태를 잃었을 때) — 지운다
          await this.remove(cal, ev.id);
          summary.removed++;
        }
        continue;
      }

      const lChanged = L ? lHash !== S.hash : 'deleted';
      const rChanged = R === undefined ? false : R === 'deleted' ? 'deleted' : R.unsupported ? false : rHash !== S.hash;
      if (ev && R !== 'deleted') S.extra = extraOf(ev);
      if (!lChanged && !rChanged) continue;
      if (lChanged && !rChanged) {
        if (L && !S.readOnly) {
          await this.push(st, cal, key, L, S.eventId);
          summary.pushed++;
        } else if (!L) {
          if (!S.readOnly || memoState === 'trashed') await this.remove(cal, S.eventId);
          delete st.items[key];
          summary.removed++;
        }
        continue;
      }
      if (!lChanged && rChanged) {
        if (rChanged === 'deleted') {
          await this.memos.setReminder(memoId, reminderId, null);
          delete st.items[key];
          summary.removed++;
        } else {
          await this.pull(st, key, L, R, ev);
          summary.pulled++;
        }
        continue;
      }
      // 양쪽 다 바뀜
      if (lChanged === 'deleted' && rChanged === 'deleted') delete st.items[key];
      else if (lChanged === 'deleted') {
        // 메모에서 지웠는데 Google 에서 고쳤다: 메모를 휴지통에 버렸으면 지우고, 일정만 지웠으면 고친 것을 살린다
        if (memoState === 'trashed') {
          await this.remove(cal, S.eventId);
          delete st.items[key];
          summary.removed++;
        } else {
          await this.pull(st, key, null, R, ev, memoId, reminderId);
          summary.pulled++;
        }
      } else if (rChanged === 'deleted') {
        await this.push(st, cal, key, L, S.eventId); // Google 에서 지웠지만 메모킹에서 고쳤다 — 고친 것을 살린다
        summary.pushed++;
      } else if (newer(ev?.updated, L.updated)) {
        await this.pull(st, key, L, R, ev);
        summary.pulled++;
      } else {
        await this.push(st, cal, key, L, S.eventId);
        summary.pushed++;
      }
    }

    // 4) 그 캘린더에 새로 만든 일정 → 새 메모
    for (const ev of foreign) {
      const R = shapeOfEvent(ev);
      if (R === 'deleted') continue;
      const reminder = applyShape(null, R.unsupported ? { ...R, unsupported: undefined, at: atOf(ev), repeat: undefined } : R, new Date(now));
      if (!reminder) continue;
      const memoId = await this.memos.create(R.title, reminder);
      if (!memoId) continue;
      const key = keyOf(memoId, reminder.id);
      st.items[key] = { eventId: ev.id, hash: R.unsupported ? '' : shapeHash(R), readOnly: Boolean(R.unsupported), extra: extraOf(ev) };
      // 다음부터 이 일정을 메모와 이어 보게 키를 붙인다 (이름 · 시각은 그대로)
      await this.api('PATCH', `${cal}/events/${encodeURIComponent(ev.id)}`, { extendedProperties: { private: { [KEY_PROP]: key } } });
      summary.imported++;
      if (R.unsupported) summary.notes.push(`"${R.title}" 의 반복 규칙은 메모킹이 나타낼 수 없어 첫 회차만 가져왔어요`);
    }

    if (nextToken) st.syncToken = nextToken;
    st.lastSync = now;
    st.lease = { device: this.device, until: this.now() + LEASE_MS };
    await this.store.write(st);
    return { ...summary, lastSync: now, calendarId: st.calendarId };
  }

  // 메모 → Google (있으면 고치고 없으면 만든다. 같은 ID 가 이미 있으면(다른 기기가 먼저 만듦) 고친다)
  async push(st, cal, key, L, eventId) {
    const S = st.items[key];
    const body = eventBodyFor(L.reminder, { memoTitle: L.title, key, timeZone: this.timeZone, extra: S?.extra ?? [], now: new Date(this.now()) });
    if (!body) return;
    const id = eventId ?? eventIdFor(key);
    let res;
    if (eventId) res = await this.api('PUT', `${cal}/events/${encodeURIComponent(id)}`, body);
    if (!eventId || res.status === 404 || res.status === 410) {
      res = await this.api('POST', `${cal}/events`, { ...body, id: eventIdFor(key) });
      if (res.status === 409) res = await this.api('PUT', `${cal}/events/${encodeURIComponent(eventIdFor(key))}`, body);
    }
    if (res.status >= 400) throw new CalendarSyncError(`Google 캘린더에 "${body.summary}" 를 넣지 못했어요 (${res.status})`);
    st.items[key] = { eventId: res.json?.id ?? id, hash: shapeHash(L.shape), extra: S?.extra ?? [] };
  }

  // Google → 메모
  async pull(st, key, L, R, ev, memoId = key.split('/')[0], reminderId = key.split('/')[1]) {
    const next = applyShape(L?.reminder ?? null, R, new Date(this.now()));
    if (!next) return;
    await this.memos.setReminder(memoId, reminderId, { ...next, id: reminderId });
    st.items[key] = { eventId: ev.id, hash: shapeHash(R), extra: extraOf(ev) };
  }

  async remove(cal, eventId) {
    if (!eventId) return;
    const res = await this.api('DELETE', `${cal}/events/${encodeURIComponent(eventId)}`);
    if (res.status >= 400 && res.status !== 404 && res.status !== 410) throw new CalendarSyncError(`Google 캘린더에서 지우지 못했어요 (${res.status})`);
  }
}

// 반복 일정에서 사용자가 지운 회차(EXDATE) 등 — 메모킹이 다시 넣을 때 지키게
const extraOf = (ev) => (ev?.recurrence ?? []).filter((l) => /^EXDATE/i.test(l));

// Google 이 더 나중에 고쳤는가 (메모 쪽 때를 모르면 메모킹 쪽을 따른다)
function newer(remoteIso, localIso) {
  const r = Date.parse(remoteIso ?? '');
  const l = Date.parse(localIso ?? '');
  return Number.isFinite(r) && (!Number.isFinite(l) || r > l);
}

function atOf(ev) {
  const s = startOf(ev);
  return s ? (s.allDay ? dayKey(s.date) : minuteKey(s.date)) : dayKey(new Date());
}
