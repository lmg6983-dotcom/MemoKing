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
export const LOCKED_TITLE = '🔒 메모킹 일정'; // 잠긴 메모의 일정 이름 — Google 에 메모 제목을 보내지 않는다
const ORPHAN_KEEP_MS = 24 * 3600_000; // 이 기기가 만든 캘린더를 하루 동안 기억 (두 기기가 동시에 만들었으면 진 쪽을 지운다)
const GONE_GRACE_MS = 30 * 60_000; // 다른 기기가 맞춘 일정이 이 기기 메모에 없을 때: Drive 가 늦은 것일 수 있어 이만큼 기다린 뒤 지운다
const MISSING_DROP_MS = 3 * 24 * 3600_000; // 메모가 아예 없어진 지(휴지통도 비움) 이만큼 지나면 Google 에서도 지운다

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
    shape.repeat = canonRepeat(r.repeat, allDay);
  }
  return shape;
}

/** 반복을 늘 같은 순서의 모양으로 (메모킹 쪽 · Google 쪽에서 만든 것이 같은 글이 되게) */
function canonRepeat(rep, allDay) {
  const out = { every: rep.every };
  if (rep.every === 'week') out.weekdays = [...rep.weekdays].sort((a, b) => a - b);
  if (rep.every === 'year') out.month = rep.month;
  if (rep.every === 'month' || rep.every === 'year') out.day = rep.day;
  if (!allDay && rep.time) out.time = rep.time;
  return out;
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
  if (!s) return { title: cleanTitle(ev.summary) || '일정', allDay: false, unsupported: 'time' };
  const shape = { title: cleanTitle(ev.summary) || '일정', allDay: s.allDay };
  const rules = (ev.recurrence ?? []).filter((l) => /^RRULE:/i.test(l));
  if (rules.length > 1 || (ev.recurrence ?? []).some((l) => /^RDATE/i.test(l))) return { ...shape, unsupported: 'rule' };
  if (!rules.length) {
    shape.at = s.allDay ? dayKey(s.date) : minuteKey(s.date);
    return shape;
  }
  const repeat = repeatOfRule(rules[0], s.date);
  if (!repeat) return { ...shape, unsupported: 'rule' };
  shape.repeat = canonRepeat({ ...repeat, time: `${pad2(s.date.getHours())}:${pad2(s.date.getMinutes())}` }, s.allDay);
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
/**
 * 메모킹 알림 → Google 일정 내용. 새로 만들 때(full)만 설명 · 알림을 넣고, 고칠 때는 메모킹이 정하는 것(이름 · 때 · 반복)만 —
 * 사용자가 Google 에서 넣은 장소 · 참석자 · 색 · 설명을 지우지 않게. 시각 있는 일정은 Google 에서 늘린 길이(durationMs)를 지킨다
 */
export function eventBodyFor(r, { memoTitle = '', key, timeZone, extra = [], durationMs = null, durationDays = null, full = true, now = new Date() }) {
  const span = eventSpan(r, now);
  if (!span) return null;
  const title = cleanTitle(r.title || memoTitle) || '일정';
  const time = (d) => (span.allDay ? { date: dayKey(d) } : { dateTime: toLocalIso(d), timeZone });
  // 길이: Google 에서 늘린 것을 지킨다 (여러 날 하루 종일 · 시각 있는 일정의 끝)
  const end = span.allDay
    ? new Date(span.start.getFullYear(), span.start.getMonth(), span.start.getDate() + (durationDays > 1 ? durationDays : 1))
    : new Date(span.start.getTime() + (durationMs > 0 ? durationMs : DEFAULT_MINUTES * 60_000));
  const rrule = rruleOf(r);
  return {
    summary: title,
    start: time(span.start),
    end: time(end),
    recurrence: rrule ? [`RRULE:${rrule}`, ...extra] : [],
    status: 'confirmed',
    extendedProperties: { private: { [KEY_PROP]: key } },
    ...(full ? {
      description: memoTitle && cleanTitle(memoTitle) !== title ? `메모킹 메모: ${memoTitle}` : '메모킹 일정',
      reminders: { useDefault: false, overrides: [] },
    } : {}),
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
  constructor({ request, store, local = null, memos, device, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Date.now }) {
    this.request = request;
    this.store = store;
    this.local = local; // 이 기기에만 두는 것 { get(), set(v) } — 이 기기가 만든 캘린더
    this.memos = memos;
    this.device = device;
    this.timeZone = timeZone;
    this.now = now;
    this.running = null;
  }

  /** 겹쳐 돌지 않게. 도는 중에 "지금 맞추기"(force)가 오면 끝난 뒤 한 번 더 (임대로 건너뛴 결과를 돌려주지 않게) */
  run(opts = {}) {
    if (this.running) return opts.force ? this.running.catch(() => {}).then(() => this.run(opts)) : this.running;
    this.running = this.runOnce(opts).finally(() => {
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

  /**
   * 상태 파일 — 없으면 처음, 있는데 읽지 못하면(Drive 가 쓰는 중 · 깨짐) 이번엔 건너뛴다.
   * (빈 상태로 이어 가면 "메모킹" 캘린더를 하나 더 만들고 모든 일정을 두 번 넣게 된다)
   */
  async readState() {
    let raw;
    try {
      raw = await this.store.read();
    } catch {
      throw new CalendarSyncError('동기화 상태 파일을 읽지 못했어요 (Drive 가 맞추는 중일 수 있어요). 잠시 뒤 다시 맞춰요');
    }
    if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new CalendarSyncError('동기화 상태 파일이 깨졌어요. 잠시 뒤 다시 맞춰요');
    return {
      calendarId: typeof raw?.calendarId === 'string' ? raw.calendarId : null,
      syncToken: typeof raw?.syncToken === 'string' ? raw.syncToken : null,
      items: raw?.items && typeof raw.items === 'object' ? raw.items : {},
      lease: raw?.lease ?? null,
      lastSync: raw?.lastSync ?? 0,
    };
  }

  // 다른 기기가 맡고 있는가 (20분 안에 소식이 있었으면)
  leasedElsewhere(st, now) {
    return Boolean(st.lease && st.lease.device !== this.device && st.lease.until > now);
  }

  async runOnce({ force = false } = {}) {
    const now = this.now();
    const st = await this.readState();
    if (!force && this.leasedElsewhere(st, now)) return { skipped: 'lease', holder: st.lease.device, lastSync: st.lastSync };
    // 맡았다는 것을 먼저 적어 둔다 (끝에서만 적으면 다른 기기가 그사이 같이 돌 수 있다).
    // 이미 맡고 있고 임대가 반 넘게 남았으면 쓰지 않는다 (Drive 로 함께 쓰는 파일을 5분마다 바꾸지 않게)
    const before = JSON.stringify({ ...st, lease: null, lastSync: 0 });
    const renew = () => !st.lease || st.lease.device !== this.device || st.lease.until - this.now() < LEASE_MS / 2;
    if (renew()) {
      st.lease = { device: this.device, until: now + LEASE_MS };
      await this.store.write(st);
    }
    const summary = { pushed: 0, pulled: 0, imported: 0, removed: 0, notes: [] };

    // 1) 메모킹 캘린더 (없거나 지웠으면 새로 — 그러면 처음부터 다시 맞춘다)
    const exists = async (id) => {
      const got = await this.api('GET', `/calendars/${encodeURIComponent(id)}`);
      if (got.status === 404 || got.status === 410) return false;
      if (got.status >= 400) throw new CalendarSyncError(`Google 캘린더 오류 (${got.status})`);
      return true;
    };
    const mine = await this.local?.get?.(); // 이 기기가 만든 캘린더 { id, at }
    if (st.calendarId && !(await exists(st.calendarId))) Object.assign(st, { calendarId: null });
    if (st.calendarId) {
      // 두 기기가 처음에 동시에 캘린더를 만들었으면(상태 파일이 아직 오지 않아서): 함께 쓰는 파일의 캘린더가 살아 있는 것을
      // 확인한 뒤에만 이 기기가 만든 것을 지운다 (오래된 상태 파일 때문에 살아 있는 캘린더를 지우지 않게)
      if (mine?.id && mine.id !== st.calendarId) {
        const gone = await this.api('DELETE', `/calendars/${encodeURIComponent(mine.id)}`);
        if (gone.status < 400 || gone.status === 404 || gone.status === 410) await this.local.set(null);
      } else if (mine?.id && now - (mine.at ?? 0) > ORPHAN_KEEP_MS) await this.local.set(null);
    } else if (mine?.id && await exists(mine.id)) {
      // 함께 쓰는 캘린더가 없어졌는데 이 기기가 만든 것이 있으면 그것을 다시 쓴다 (또 만들지 않게)
      Object.assign(st, { calendarId: mine.id, syncToken: null, items: {} });
    }
    if (!st.calendarId) {
      const made = await this.api('POST', '/calendars', { summary: CALENDAR_NAME, description: '메모킹 일정 — 여기서 고치거나 만든 일정은 메모킹으로 와요', timeZone: this.timeZone });
      if (made.status >= 400 || !made.json?.id) throw new CalendarSyncError(`메모킹 캘린더를 만들지 못했어요 (${made.status})`);
      Object.assign(st, { calendarId: made.json.id, syncToken: null, items: {} });
      await this.local?.set?.({ id: made.json.id, at: now });
      await this.store.write(st); // 만든 캘린더를 바로 적어 둔다 (중간에 멈춰도 또 만들지 않게)
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
      // 모두 다시 받아도 410 이면 그만 (빈 목록으로 이어 가면 모든 일정을 "지운 것" 으로 보게 된다)
      if (full) throw new CalendarSyncError('Google 캘린더 일정을 받지 못했어요 (410). 잠시 뒤 다시 맞춰요');
      full = true;
      st.syncToken = null;
    }

    // 3) 견주기
    const local = new Map();
    for (const raw of await this.memos.all()) {
      // 임시 id 의 메모(아직 id 를 파일에 쓰지 않은 사본 등)는 켤 때마다 id 가 바뀌어 일정이 쌓이므로 맞추지 않는다
      if (raw.stable === false) continue;
      // 잠긴 메모: 메모 제목 · 일정 이름을 Google 에 보내지 않는다 (이름은 늘 같은 글)
      const item = raw.locked ? { ...raw, title: LOCKED_TITLE, reminder: { ...raw.reminder, title: undefined } } : raw;
      const shape = shapeOfReminder(item.reminder, item.title);
      if (shape) local.set(keyOf(item.memoId, item.reminder.id), { ...item, shape });
    }
    const keyByEvent = new Map(Object.entries(st.items).map(([k, v]) => [v.eventId, k]));
    const byKey = new Map();
    const foreign = [];
    for (const ev of remote) {
      if (ev.recurringEventId) continue; // 반복 일정의 한 회차만 고친 것 — Google 쪽에만 둔다
      // 키: 일정에 붙은 것 → 상태에 그 일정 id 로 적어 둔 것(가져온 일정) → 없으면 그 캘린더에서 새로 만든 일정
      const key = ev.extendedProperties?.private?.[KEY_PROP] ?? keyByEvent.get(ev.id);
      if (key) byKey.set(key, ev);
      else if (ev.status !== 'cancelled') foreign.push(ev);
    }

    const keys = new Set([...local.keys(), ...Object.keys(st.items), ...byKey.keys()]);
    for (const key of keys) {
      const [memoId, reminderId] = key.split('/');
      const L = local.get(key) ?? null;
      const S = st.items[key] ?? null;
      const ev = byKey.get(key);
      if (S?.detached) continue; // 메모킹에서 지웠지만 Google 에 남겨 둔 일정 (메모킹이 나타낼 수 없는 반복) — 더는 건드리지 않는다
      const memoState = L ? 'present' : this.memos.state(memoId);
      if (L && S) delete S.goneSince;
      if (!L && memoState === 'missing') {
        // 이 기기에 아직 오지 않은 메모일 수 있다 — 건드리지 않는다. 다만 며칠째 없으면(휴지통까지 비움) Google 에서도 지운다
        if (S && ev?.status !== 'cancelled') {
          if (!S.goneSince || S.goneDevice !== this.device) Object.assign(S, { goneSince: now, goneDevice: this.device });
          else if (now - S.goneSince > MISSING_DROP_MS) {
            await this.remove(cal, S.eventId);
            delete st.items[key];
            summary.removed++;
          }
        }
        continue;
      }
      // 메모는 있는데 일정이 없다: 다른 기기에서 넣은 일정이 Drive 로 아직 오지 않았을 수 있다.
      //   지난번 이 기기가 맞춘 뒤 메모 파일을 고쳤으면(같은 기기 시계로 견줌) 지운 것, 아니면 잠깐(30분) 기다려 본다
      if (!L && S && memoState === 'present') {
        const touchedAfter = S.atDevice === this.device && (this.memos.touched?.(memoId) ?? Infinity) > (S.at ?? 0);
        if (!touchedAfter) {
          if (!S.goneSince || S.goneDevice !== this.device) {
            Object.assign(S, { goneSince: now, goneDevice: this.device });
            continue;
          }
          if (now - S.goneSince < GONE_GRACE_MS) continue;
        }
      }
      // 원격: 받은 목록에 있으면 그 모양, 모두 받았는데 없으면 지운 것, 바뀐 것만 받았는데 없으면 그대로
      let R = ev ? shapeOfEvent(ev) : full && S ? 'deleted' : undefined;
      if ((L?.locked ?? S?.locked) && R && R !== 'deleted') R = { ...R, title: LOCKED_TITLE };
      const rHash = R && R !== 'deleted' && !R.unsupported ? shapeHash(R) : null;
      const lHash = L ? shapeHash(L.shape) : null;
      if (S && ev && R !== 'deleted') {
        Object.assign(S, seenOf(ev));
        // Google 에서 메모킹이 나타낼 수 없는 반복으로 바꿨으면 그 뒤로는 Google 을 덮지 않는다 (나타낼 수 있게 되돌리면 다시)
        S.readOnly = Boolean(R.unsupported);
      }
      if (S && L) S.locked = Boolean(L.locked);

      if (!S) {
        if (L && (R === undefined || R === 'deleted')) {
          await this.push(st, cal, key, L, null);
          summary.pushed++;
        } else if (L && R && R !== 'deleted') {
          if (R.unsupported) st.items[key] = { eventId: ev.id, hash: lHash, readOnly: true, at: now, atDevice: this.device, locked: Boolean(L.locked), ...seenOf(ev) };
          else if (rHash === lHash) st.items[key] = { eventId: ev.id, hash: lHash, at: now, atDevice: this.device, locked: Boolean(L.locked), ...seenOf(ev) };
          else if (newer(ev.updated, editedOf(L))) {
            await this.pull(st, key, L, R, ev);
            summary.pulled++;
          } else {
            st.items[key] = { eventId: ev.id, hash: '', locked: Boolean(L.locked), ...seenOf(ev) };
            await this.push(st, cal, key, L, ev.id);
            summary.pushed++;
          }
        } else if (!L && R && R !== 'deleted' && !R.unsupported) {
          // 메모에서 이미 지운 일정이 Google 에 남아 있다 (상태를 잃었을 때) — 지운다 (나타낼 수 없는 반복은 남겨 둔다)
          await this.remove(cal, ev.id);
          summary.removed++;
        }
        continue;
      }

      const lChanged = L ? lHash !== S.hash : 'deleted';
      const rChanged = R === undefined ? false : R === 'deleted' ? 'deleted' : R.unsupported ? false : rHash !== S.hash;
      if (!lChanged && !rChanged) continue;
      if (lChanged && !rChanged) {
        if (L && !S.readOnly) {
          await this.push(st, cal, key, L, S.eventId);
          summary.pushed++;
        } else if (!L) {
          if (S.readOnly && memoState !== 'trashed') {
            S.detached = true; // 메모킹이 나타낼 수 없는 반복은 Google 에 남기고 더는 잇지 않는다
            continue;
          }
          await this.remove(cal, S.eventId);
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
      } else if (newer(ev?.updated, editedOf(L))) {
        await this.pull(st, key, L, R, ev);
        summary.pulled++;
      } else {
        await this.push(st, cal, key, L, S.eventId);
        summary.pushed++;
      }
    }

    // 4) 그 캘린더에 새로 만든 일정 → 새 메모 (하나씩: 메모를 만들면 바로 상태에 적어 두어 다음에 또 만들지 않게)
    if (foreign.length) {
      // 그사이 다른 기기가 맡았으면 여기서 그만 — 가져오지도, 상태(동기화 토큰 · 임대)를 덮어쓰지도 않는다
      //   (토큰을 넘기면 그 기기가 새 일정을 다시 보지 못한다)
      const latest = await this.readState().catch(() => null);
      if (latest && this.leasedElsewhere(latest, this.now())) return { ...summary, skipped: 'lease', holder: latest.lease.device, lastSync: latest.lastSync };
    }
    for (const ev of foreign) {
      const R = shapeOfEvent(ev);
      if (R === 'deleted' || R.unsupported === 'time') continue; // 때를 알 수 없는 일정은 가져오지 않는다
      const reminder = applyShape(null, R.unsupported ? { title: R.title, allDay: R.allDay, at: atOf(ev) } : R, new Date(now));
      if (!reminder) continue;
      const memoId = await this.memos.create(R.title, reminder);
      if (!memoId) continue;
      const key = keyOf(memoId, reminder.id);
      st.items[key] = { eventId: ev.id, hash: R.unsupported ? '' : shapeHash(R), readOnly: Boolean(R.unsupported), at: this.now(), atDevice: this.device, ...seenOf(ev) };
      await this.store.write(st);
      // 다음부터 이 일정을 메모와 이어 보게 키를 붙인다 (이름 · 시각은 그대로). 못 붙여도 상태의 일정 id 로 이어진다
      const tagged = await this.api('PATCH', `${cal}/events/${encodeURIComponent(ev.id)}`, { extendedProperties: { private: { [KEY_PROP]: key } } });
      if (tagged.status >= 400) summary.notes.push(`"${R.title}" 에 메모 표시를 붙이지 못했어요 (${tagged.status}) — 다음에 다시`);
      summary.imported++;
      if (R.unsupported) summary.notes.push(`"${R.title}" 의 반복 규칙은 메모킹이 나타낼 수 없어 첫 회차만 가져왔어요`);
    }

    if (nextToken) st.syncToken = nextToken;
    st.lastSync = now;
    // 바뀐 것이 있거나 임대가 반 넘게 지났을 때만 쓴다
    if (JSON.stringify({ ...st, lease: null, lastSync: 0 }) !== before || renew()) {
      st.lease = { device: this.device, until: this.now() + LEASE_MS };
      await this.store.write(st);
    }
    return { ...summary, lastSync: now, calendarId: st.calendarId };
  }

  // 메모 → Google: 있으면 메모킹이 정하는 것만 고치고(PATCH), 없으면 만든다. 같은 ID 가 이미 있으면(다른 기기가 먼저 만듦) 고친다
  async push(st, cal, key, L, eventId) {
    const S = st.items[key];
    const opts = { memoTitle: L.title, key, timeZone: this.timeZone, extra: S?.extra ?? [], durationMs: S?.durationMs ?? null, durationDays: S?.durationDays ?? null, now: new Date(this.now()) };
    const id = eventIdFor(key);
    let res;
    if (eventId) res = await this.api('PATCH', `${cal}/events/${encodeURIComponent(eventId)}`, eventBodyFor(L.reminder, { ...opts, full: false }));
    if (!eventId || res.status === 404 || res.status === 410) {
      const body = eventBodyFor(L.reminder, opts);
      if (!body) return;
      res = await this.api('POST', `${cal}/events`, { ...body, id });
      if (res.status === 409) res = await this.api('PATCH', `${cal}/events/${encodeURIComponent(id)}`, eventBodyFor(L.reminder, { ...opts, full: false }));
    }
    if (!res || res.status >= 400) throw new CalendarSyncError(`Google 캘린더에 "${L.shape.title}" 를 넣지 못했어요 (${res?.status})`);
    st.items[key] = { ...(S ?? {}), eventId: res.json?.id ?? eventId ?? id, hash: shapeHash(L.shape), at: this.now(), atDevice: this.device, locked: Boolean(L.locked) };
  }

  // Google → 메모
  async pull(st, key, L, R, ev, memoId = key.split('/')[0], reminderId = key.split('/')[1]) {
    const next = applyShape(L?.reminder ?? null, R, new Date(this.now()));
    if (!next) return;
    // 바꾼 때는 Google 에서 고친 때로 (다음 충돌 때 견주게)
    const changed = Number.isFinite(Date.parse(ev.updated ?? '')) ? toLocalIso(new Date(ev.updated)) : undefined;
    await this.memos.setReminder(memoId, reminderId, { ...next, id: reminderId, ...(changed ? { changed } : {}) });
    st.items[key] = { ...(st.items[key] ?? {}), eventId: ev.id, hash: shapeHash(R), at: this.now(), atDevice: this.device, ...seenOf(ev) };
  }

  async remove(cal, eventId) {
    if (!eventId) return;
    const res = await this.api('DELETE', `${cal}/events/${encodeURIComponent(eventId)}`);
    if (res.status >= 400 && res.status !== 404 && res.status !== 410) throw new CalendarSyncError(`Google 캘린더에서 지우지 못했어요 (${res.status})`);
  }
}

// Google 쪽에서 본 것 중 메모킹이 다시 넣을 때 지킬 것: 지운 회차(EXDATE) · 일정 길이
function seenOf(ev) {
  const out = { extra: (ev?.recurrence ?? []).filter((l) => /^EXDATE/i.test(l)) };
  const a = Date.parse(ev?.start?.dateTime ?? '');
  const b = Date.parse(ev?.end?.dateTime ?? '');
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.durationMs = b - a;
  const da = ev?.start?.date ? Date.parse(`${ev.start.date}T00:00:00Z`) : NaN;
  const db = ev?.end?.date ? Date.parse(`${ev.end.date}T00:00:00Z`) : NaN;
  if (Number.isFinite(da) && Number.isFinite(db) && db > da) out.durationDays = Math.round((db - da) / 86_400_000);
  return out;
}

// 메모 쪽 일정을 마지막으로 바꾼 때: 알림에 찍힌 때(이름 · 때 · 반복을 바꾼 때, reminders.js stampChanged), 없으면 메모 내용을 고친 때
//   이름이 없는 일정은 메모 제목이 일정 이름이라, 메모를 고친 때(제목을 바꿨을 수 있음)도 견줘 나중 것으로
function editedOf(L) {
  const changed = Date.parse(L?.reminder?.changed ?? '');
  const updated = Date.parse(L?.updated ?? '');
  const t = L?.reminder?.title ? (Number.isFinite(changed) ? changed : updated) : Math.max(Number.isFinite(changed) ? changed : -Infinity, Number.isFinite(updated) ? updated : -Infinity);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Google 이 더 나중에 고쳤는가 (어느 한쪽 때를 모르면 메모킹 쪽을 따른다)
function newer(remoteIso, localIso) {
  const r = Date.parse(remoteIso ?? '');
  const l = Date.parse(localIso ?? '');
  return Number.isFinite(r) && Number.isFinite(l) && r > l;
}

function atOf(ev) {
  const s = startOf(ev);
  return s ? (s.allDay ? dayKey(s.date) : minuteKey(s.date)) : dayKey(new Date());
}
