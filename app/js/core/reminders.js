// 예약 알림 — 메모 머리말의 reminders 항목. 다음 알림 시각 계산과 설명 문구 (순수 함수, 단위 테스트 대상)
//
//   reminders:
//     - id: r7k2
//       kind: repeat            # timer | at | repeat | startup
//       repeat: { every: week, weekdays: [1, 3], time: "09:00" }
//       action: open            # open(메모 띄우기) | notify(알림만)
//       title: 치과               # (일정) 이름 — 없으면 메모 제목
//       alerts: [30, 1440]      # (일정) 미리 알림: 시작 몇 분 전 (구글 캘린더처럼 여러 개, 없으면 정시 한 번)
//       allDay: true            # (일정) 하루 종일 — at 은 그날 00:00, 미리 알림은 그 기준 ("당일 오전 9시" = -540)
//       created: 2026-09-30T10:00:00+09:00
//       last: 2026-10-01T09:00:02+09:00   # 마지막으로 울린 시각
import { toLocalIso, dateKey, hhmm, dayLabel, WEEKDAY } from './time.js';

export const KINDS = ['timer', 'at', 'repeat', 'startup'];
export const EVERY = ['day', 'week', 'month', 'year'];
export const STARTUP = ['every', 'daily', 'once'];
export const ACTIONS = ['open', 'notify'];
const MISSED_AFTER_MS = 2 * 60 * 1000; // 이보다 늦게 울리면 "놓친 알림"

const validDate = (value) => {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
};

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value ?? '').trim());
  const h = m ? Math.min(23, Number(m[1])) : 9;
  const min = m ? Math.min(59, Number(m[2])) : 0;
  return { h, min, text: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}

const randomId = () => `r${Math.random().toString(36).slice(2, 8)}`;

// ---------- 일정의 미리 알림 ----------
// 시각이 있는 일정: 시작 몇 분 전. 하루 종일 일정: 그날 00:00 기준 몇 분 전 (음수 = 그날 안: -540 = 당일 오전 9시)
export const ALERT_PRESETS = {
  timed: [0, 5, 10, 30, 60, 120, 1440, 10080],
  allDay: [-540, 900, 9540], // 당일 오전 9시 · 하루 전 오전 9시 · 일주일 전 오전 9시
};
export const DEFAULT_ALERTS = { timed: [10], allDay: [-540] };
export const MAX_ALERTS = 5;
export const MAX_ALERT_MIN = 60 * 24 * 28;
/** 미리 알림 값이 쓸 수 있는 것인지 (직접 정한 값 포함) — normalizeAlerts 와 같은 범위 */
export const validAlert = (v, allDay = false) => Number.isInteger(v) && v >= (allDay ? -1439 : 0) && v <= MAX_ALERT_MIN;
export const isEvent = (r) => r.kind === 'at' || r.kind === 'repeat';

/** 미리 알림 (분 전) — 먼저 울리는 것부터. 적지 않았으면 정시(하루 종일은 당일 오전 9시) 한 번, [] 는 "알림 없음" (달력에만) */
export function alertsOf(r) {
  if (!isEvent(r)) return [0];
  const list = Array.isArray(r.alerts) ? r.alerts : [r.allDay ? -540 : 0];
  return [...new Set(list)].sort((a, b) => b - a);
}

// 시각 있는 일정은 시작 전(0 이상)만, 하루 종일은 그날 안(자정 직전까지)과 그 전 — 이름("정시"·"당일 오후 12시")이 실제와 어긋나지 않게
function normalizeAlerts(raw, allDay = false) {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map((v) => Math.round(Number(v))).filter((v) => validAlert(v, allDay)))]
    .sort((a, b) => b - a).slice(0, MAX_ALERTS);
}

/** 하루 안의 분 → "오전 9시", "오후 5시 30분" */
function clockOfMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시${m ? ` ${m}분` : ''}`;
}

/** 미리 알림 한 개의 이름: "정시", "10분 전", "1시간 전", "하루 전", "당일 오전 9시", "하루 전 오전 9시" */
export function alertLabel(offset, allDay = false) {
  if (allDay) {
    if (offset <= 0) return `당일 ${clockOfMinutes(-offset)}`;
    const days = Math.ceil(offset / 1440);
    const name = days === 1 ? '하루' : days === 7 ? '일주일' : `${days}일`;
    return `${name} 전 ${clockOfMinutes(days * 1440 - offset)}`;
  }
  if (offset <= 0) return '정시';
  if (offset % 10080 === 0) return offset === 10080 ? '일주일 전' : `${offset / 10080}주 전`;
  if (offset % 1440 === 0) return offset === 1440 ? '하루 전' : `${offset / 1440}일 전`;
  if (offset % 60 === 0) return `${offset / 60}시간 전`;
  if (offset > 60) return `${Math.floor(offset / 60)}시간 ${offset % 60}분 전`;
  return `${offset}분 전`;
}

/**
 * 아직 울릴 수 있는 미리 알림만 (지금보다 뒤) — 일정 창·알림 패널·코어가 함께 쓰는 한 가지 규칙.
 * 반복 일정은 다음 회차에 울리므로 모두 남긴다.
 */
export function pendingAlerts(alerts, start, { repeat = false, now = new Date(), fallback = null, allDay = false } = {}) {
  const list = [...new Set(alerts ?? [])].sort((a, b) => b - a);
  if (repeat) return list;
  const future = (o) => alertTime(new Date(start), o, allDay).getTime() > new Date(now).getTime();
  const keep = list.filter(future);
  // 알림을 골랐는데 모두 지났다면(5분 뒤 일정에 "10분 전"): 아무 알림 없이 두지 않고 정시(하루 종일은 당일 오전 9시)에
  if (!keep.length && list.length && fallback !== null && future(fallback)) return [fallback];
  return keep;
}
/** 지난 알림 대신 울릴 때: 시각 있는 일정은 정시, 하루 종일은 당일 오전 9시 */
export const fallbackAlert = (allDay) => (allDay ? -540 : 0);

/**
 * 미리 알림이 울릴 때. 하루 종일 일정은 벽시계 기준("하루 전 오전 9시" 는 서머타임이 바뀌는 날에도 오전 9시),
 * 시각 있는 일정은 시작에서 그만큼 앞
 */
export function alertTime(start, offset, allDay = false) {
  if (allDay) return new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, -offset);
  return new Date(start.getTime() - offset * 60_000);
}

/** "10분 전, 하루 전" */
export const describeAlerts = (r) => {
  const list = alertsOf(r);
  return list.length ? list.slice().sort((a, b) => a - b).map((o) => alertLabel(o, Boolean(r.allDay))).join(', ') : '알림 없음';
};

// 파일에서 읽은 값(사람이 고쳤을 수도 있음)을 안전한 모양으로. 알 수 없는 종류는 버린다(null).
export function normalizeReminder(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return null;
  const r = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomId(),
    kind: raw.kind,
    action: ACTIONS.includes(raw.action) ? raw.action : 'notify',
    enabled: raw.enabled !== false,
    created: validDate(raw.created) ? String(raw.created) : toLocalIso(now),
    last: validDate(raw.last) ? String(raw.last) : null,
  };
  if (isEvent(r)) {
    const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (title) r.title = title;
    const alerts = normalizeAlerts(raw.alerts, raw.allDay === true);
    if (alerts) r.alerts = alerts;
    if (raw.allDay === true) r.allDay = true;
  }
  if (r.kind === 'timer' || r.kind === 'at') {
    if (!validDate(raw.at)) return null;
    r.at = String(raw.at);
    if (r.kind === 'timer') r.minutes = Math.max(1, Math.round(Number(raw.minutes) || 0)) || 1;
  } else if (r.kind === 'repeat') {
    const src = raw.repeat ?? {};
    const every = EVERY.includes(src.every) ? src.every : 'day';
    const repeat = { every, time: parseTime(src.time).text };
    if (every === 'week') {
      const days = Array.isArray(src.weekdays) ? src.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
      repeat.weekdays = [...new Set(days.length ? days : [validDate(r.created).getDay()])].sort((a, b) => a - b);
    }
    if (every === 'month' || every === 'year') repeat.day = Math.min(31, Math.max(1, Number(src.day) || 1));
    if (every === 'year') repeat.month = Math.min(12, Math.max(1, Number(src.month) || 1));
    r.repeat = repeat;
  } else {
    r.startup = STARTUP.includes(raw.startup) ? raw.startup : 'every';
  }
  return r;
}

// 파일에 쓸 모양 (기본값은 생략해 짧게)
export function serializeReminder(r) {
  const out = { id: r.id, kind: r.kind };
  if (r.at) out.at = r.at;
  if (r.kind === 'timer') out.minutes = r.minutes;
  if (r.repeat) out.repeat = r.repeat;
  if (r.startup) out.startup = r.startup;
  if (r.title) out.title = r.title;
  if (r.allDay) out.allDay = true;
  if (Array.isArray(r.alerts)) out.alerts = r.alerts;
  out.action = r.action;
  if (!r.enabled) out.enabled = false;
  out.created = r.created;
  if (r.last) out.last = r.last;
  return out;
}

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const at = (y, m, d, time) => new Date(y, m, Math.min(d, daysInMonth(y, m)), time.h, time.min, 0, 0);

/** after 보다 뒤의 첫 알림 시각 (없으면 null). 실행할 때 알림은 시각이 없다. */
export function nextOccurrence(r, after) {
  const base = new Date(after);
  if (r.kind === 'timer' || r.kind === 'at') {
    const t = validDate(r.at);
    return t && t > base ? t : null;
  }
  if (r.kind !== 'repeat') return null;
  const time = parseTime(r.repeat.time);
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  switch (r.repeat.every) {
    case 'day':
      for (let i = 0; i <= 1; i++) {
        const c = new Date(y, m, d + i, time.h, time.min, 0, 0); // 날짜 넘김은 Date 가 처리 (9/30 + 1 = 10/1)
        if (c > base) return c;
      }
      break;
    case 'week':
      for (let i = 0; i <= 7; i++) {
        const c = new Date(y, m, d + i, time.h, time.min, 0, 0);
        if (r.repeat.weekdays.includes(c.getDay()) && c > base) return c;
      }
      break;
    case 'month':
      for (let i = 0; i <= 12; i++) {
        const c = at(y, m + i, r.repeat.day, time);
        if (c > base) return c;
      }
      break;
    case 'year':
      for (let i = 0; i <= 4; i++) {
        const c = at(y + i, r.repeat.month - 1, r.repeat.day, time);
        if (c > base) return c;
      }
      break;
    default:
  }
  return null;
}

/**
 * after 보다 뒤의 첫 알림 (미리 알림 포함) — { at: 울릴 때, start: 일정 시작, offset: 몇 분 전 } 또는 null
 * 반복 일정은 앞뒤 회차의 미리 알림이 섞일 수 있어(매일 일정 + 하루 전 알림) 가장 이른 것을 고른다
 */
export function nextAlert(r, after) {
  const base = new Date(after);
  const offs = alertsOf(r);
  if (!offs.length) return null; // 알림 없음
  const maxOff = offs[0];
  let best = null;
  const consider = (start) => {
    for (const offset of offs) {
      const t = alertTime(start, offset, Boolean(r.allDay));
      if (!(t > base)) continue;
      if (!best || t < best.at) best = { at: t, start, offset, also: [] };
      else if (t.getTime() === best.at.getTime() && !(start.getTime() === best.start.getTime() && offset === best.offset)) {
        // 같은 때에 울릴 다른 알림 (매일 9시 일정의 "정시" 와 다음 날 일정의 "하루 전") — 하나로 울리되 둘 다 알린다
        const other = { start, offset };
        if (other.offset < best.offset) [best.start, best.offset, other.start, other.offset] = [other.start, other.offset, best.start, best.offset];
        best.also.push(other);
      }
    }
  };
  if (r.kind === 'timer' || r.kind === 'at') {
    const start = validDate(r.at);
    if (start) consider(start);
    return best;
  }
  if (r.kind !== 'repeat') return null;
  let from = new Date(base.getTime() + Math.min(0, offs.at(-1)) * 60_000 - Math.max(0, maxOff) * 60_000 - 1);
  for (let i = 0; i < 400; i++) {
    const start = nextOccurrence(r, from);
    if (!start) break;
    if (best && start.getTime() - maxOff * 60_000 > best.at.getTime()) break;
    consider(start);
    from = start;
  }
  return best;
}

/**
 * 지금 울려야 하는가. 놓친 알림이 여러 번이어도 한 번만 울린다(울린 뒤 last = 지금).
 * 만들기 전 시각의 미리 알림은 울리지 않는다 (내일 아침 일정에 오늘 저녁 "하루 전" 을 걸면 그건 이미 지남)
 * @returns {{ at: Date, start: Date, offset: number, missed: boolean } | null}
 */
export function dueOccurrence(r, now = new Date()) {
  if (!r.enabled || r.kind === 'startup') return null;
  const created = validDate(r.created) ?? new Date(0);
  const last = validDate(r.last);
  // 예전(미리 알림이 없던 때) 한 번짜리는 울렸으면 끝
  if ((r.kind === 'timer' || (r.kind === 'at' && !Array.isArray(r.alerts))) && last) return null;
  // 반복은 만든 때(또는 마지막으로 울린 때)부터, 한 번짜리는 처음부터 (지난 시각의 정시 알림은 예전처럼 "놓친 알림")
  const from = last ?? (r.kind === 'repeat' ? created : new Date(0));
  let next = nextAlert(r, from);
  // 만들기 전에 이미 지난 알림은 건너뛴다 (내일 아침 일정에 오늘 지난 "하루 전", 오전 10시에 만든 오늘 하루 종일 일정의
  // "당일 오전 9시" 는 울리지 않음). 예전 알림(미리 알림 없음)은 그대로 "놓친 알림" 으로.
  const skipBefore = (n) => n.at.getTime() < created.getTime() - (n.offset > 0 ? 0 : MISSED_AFTER_MS);
  // (하루 종일 일정은 미리 알림이 생긴 뒤의 것이라 alerts 가 없어도 같은 규칙)
  const fresh = Array.isArray(r.alerts) || r.allDay === true;
  for (let i = 0; next && (next.offset > 0 || fresh) && skipBefore(next) && i < 50; i++) next = nextAlert(r, next.at);
  if (!next || next.at > now) return null;
  return { ...next, missed: now - next.at > MISSED_AFTER_MS };
}

// 앱을 시작할 때 울려야 하는가 (실행할 때 알림)
export function dueAtStartup(r, now = new Date()) {
  if (!r.enabled || r.kind !== 'startup') return false;
  if (r.startup === 'daily') return !r.last || dateKey(validDate(r.last)) !== dateKey(now);
  return true;
}

// 울린 뒤 상태: 한 번짜리(타이머·일정·다음 실행 한 번)는 남은 미리 알림이 없으면 꺼져서 "완료" 로 남는다
export function markFired(r, now = new Date()) {
  // 한 번짜리 일정은 미리 알림을 다 보냈어도 일정이 지나기 전에는 끄지 않는다 ("알림을 모두 보냈어요" — 꺼진 것처럼 보이지 않게)
  const eventOver = !Array.isArray(r.alerts) || isPastEvent(r, now);
  const once = r.kind === 'timer' || (r.kind === 'at' && !nextAlert(r, now) && eventOver) || (r.kind === 'startup' && r.startup === 'once');
  return { ...r, last: toLocalIso(now), enabled: once ? false : r.enabled };
}

/** 끝난 알림: 한 번짜리가 울릴 것을 다 울리고 꺼진 것 (하루 전만 울리고 끈 일정은 "끝" 이 아니라 "꺼짐") */
export function isDone(r) {
  if (r.enabled || !r.last) return false;
  if (r.kind === 'timer' || r.startup === 'once') return true;
  return r.kind === 'at' && !nextAlert(r, validDate(r.last) ?? new Date(0));
}

/** 다시 켤 때: 끝난 것만 처음부터(울린 기록 지움), 중간에 끈 것은 울린 기록을 지켜 이미 울린 알림이 또 울리지 않게 */
// 일정은 울린 기록을 늘 지킨다 — 이미 울린 미리 알림이 "놓친 알림" 으로 다시 울리지 않게 (남은 알림만 울림)
// (예전 한 번짜리 알림 — 미리 알림이 없던 것 — 은 울린 기록이 있으면 다시 울리지 않으므로 처음부터)
export const reenable = (r) => ({ ...r, enabled: true, last: isDone(r) && (r.kind !== 'at' || !Array.isArray(r.alerts)) ? null : r.last });

/** 일정(한 회차)이 끝나는 때: 하루 종일이면 그날 끝, 아니면 시작 시각 */
export const occurrenceEnd = (start, allDay) => (allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) : new Date(start));

/** 한 번짜리 일정이 끝나는 때 */
function eventEnd(r) {
  const t = validDate(r.at);
  return t ? occurrenceEnd(t, r.allDay) : null;
}

/**
 * 살아 있는 알림 (종 버튼·일정 탭 숫자가 함께 세는 것): 켜져 있고 앞으로 울릴 것이 있거나, 켤 때 알림.
 * 알림 없는 일정은 울리지 않으니 세지 않는다.
 */
export function isLive(r, now = new Date()) {
  if (!r.enabled) return false;
  if (r.kind === 'startup') return true;
  return nextTime(r, now) < Infinity;
}

/** 알림 없이 달력에만 둔 한 번짜리 일정이 이미 지났는가 */
export const isPastEvent = (r, now = new Date()) => r.kind === 'at' && (eventEnd(r) ?? Infinity) <= now;

// ---------- 화면용 문구 ----------

// 오늘 14:00 / 모레 09:00 / 10월 3일 (금) 09:00 / 2027년 1월 2일 (토) 09:00 — 날 이름은 time.js 의 dayLabel 한 가지
export const formatWhen = (date, now = new Date()) => `${dayLabel(date, now)} ${hhmm(new Date(date))}`;



// 알림 설정 자체의 설명: "매주 월·수 09:00", "10분 타이머", "하루에 한 번, 처음 켤 때"
export function describeReminder(r, now = new Date()) {
  switch (r.kind) {
    case 'timer':
      return `${r.minutes >= 60 && r.minutes % 60 === 0 ? `${r.minutes / 60}시간` : `${r.minutes}분`} 타이머`;
    case 'at':
      return r.allDay ? `${dayLabel(r.at, now)} 하루 종일` : formatWhen(r.at, now);
    case 'repeat': {
      const { every, weekdays, day, month } = r.repeat;
      const time = r.allDay ? '하루 종일' : r.repeat.time;
      if (every === 'day') return `매일 ${time}`;
      if (every === 'week') {
        if (weekdays.length === 7) return `매일 ${time}`; // "매주 매일" 이 아니라
        return `매주 ${weekdays.map((w) => WEEKDAY[w]).join(', ')} ${time}`;
      }
      if (every === 'month') return `매월 ${day}일 ${time}`;
      return `매년 ${month}월 ${day}일 ${time}`;
    }
    default:
      return { every: '메모킹을 켤 때마다', daily: '하루에 한 번, 처음 켤 때', once: '다음에 켤 때 한 번만' }[r.startup];
  }
}

// 목록에 보여줄 "다음 알림" (없으면 null)
export function nextLabel(r, now = new Date()) {
  if (!r.enabled) return null;
  if (r.kind === 'startup') return describeReminder(r, now);
  const due = dueOccurrence(r, now);
  if (due) return '지금';
  const last = validDate(r.last);
  const next = nextAlert(r, last && last > now ? last : now);
  return next ? formatWhen(next.at, now) : null;
}

// 정렬용: 다음 알림 시각(ms). 실행할 때 알림·꺼진 알림은 뒤로.
export function nextTime(r, now = new Date()) {
  if (!r.enabled || r.kind === 'startup') return Infinity;
  const due = dueOccurrence(r, now);
  if (due) return due.at.getTime();
  return nextAlert(r, now)?.at.getTime() ?? Infinity;
}

/** 달력용: [from, to) 사이에 시작하는 일정 회차들 (시작 시각) */
export function occurrencesBetween(r, from, to, limit = 100) {
  if (!isEvent(r)) return [];
  const out = [];
  if (r.kind === 'at') {
    const t = validDate(r.at);
    if (t && t >= from && t < to) out.push(t);
    return out;
  }
  // 만든 날보다 앞의 회차는 없다 (1월 달력에 10월부터 시작한 매주 일정이 보이지 않게)
  const created = validDate(r.created);
  const begin = created ? Math.max(from.getTime(), new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime()) : from.getTime();
  let cursor = new Date(begin - 1);
  for (let i = 0; i < limit; i++) {
    const next = nextOccurrence(r, cursor);
    if (!next || next >= to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * 앞으로 울릴 알림들 — 회차(일정 시작) count 번까지. 휴대폰이 앱이 꺼져 있을 때 시스템에 맡겨 둘 목록.
 * 알림 개수가 아니라 회차로 센다 (매일 일정에 알림 3개여도 count=14 면 2주치)
 */
export function upcomingAlerts(r, from, count) {
  const out = [];
  const starts = new Set();
  let cursor = new Date(from);
  for (let i = 0; i < count * MAX_ALERTS + MAX_ALERTS; i++) {
    const next = nextAlert(r, cursor);
    if (!next) break;
    const key = next.start.getTime();
    if (!starts.has(key)) {
      if (starts.size >= count) break;
      starts.add(key);
    }
    for (const a of next.also ?? []) starts.add(a.start.getTime());
    out.push(next);
    cursor = next.at;
  }
  return out;
}

/** 울릴 때 알림 문구: 일정이면 "내일 15:00 (30분 뒤)", 그 밖은 "알림, 10분 타이머" */
export function alarmLabel(r, info = {}, now = new Date()) {
  if (info.startup) return `켤 때 알림, ${describeReminder(r, now)}`;
  if (!isEvent(r) || !info.start) return `${info.missed ? '놓친 알림' : '알림'}, ${describeReminder(r, now)}`;
  const start = new Date(info.start);
  const when = r.allDay ? `${dayLabel(start, now)} 하루 종일` : formatWhen(start, now);
  // 같은 때에 함께 울린 다른 회차의 미리 알림 ("…, 다음 일정 내일 09:00")
  const more = (info.also ?? []).map((a) => (r.allDay ? `${dayLabel(new Date(a.start), now)} 하루 종일` : formatWhen(new Date(a.start), now)));
  const tail = more.length ? `, 다음 일정 ${more.join(', ')}` : '';
  if (info.missed) return `놓친 알림, ${when}${tail}`;
  if (r.allDay) return `${when}${tail}`;
  const mins = Math.round((start.getTime() - now.getTime()) / 60_000);
  let soon = '';
  if (mins <= 0) soon = '지금 시작';
  else if (mins < 60) soon = `${mins}분 뒤`;
  else if (mins < 1440) soon = mins % 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분 뒤` : `${mins / 60}시간 뒤`;
  return `${soon ? `${when} (${soon})` : when}${tail}`;
}

/** 알림 제목: 일정 이름(없으면 메모 제목) */
export const alarmTitle = (r, memoTitle) => (isEvent(r) && r.title) || memoTitle;

/**
 * 알림 하나의 글 (PC·휴대폰 같음): title 알림 제목 · label 때 · full 메모 띠·보관함에 쓰는 한 줄 ("치과, 내일 15:00 (30분 뒤)")
 */
export function alarmText(r, memoTitle, info = {}, now = new Date()) {
  const title = alarmTitle(r, memoTitle);
  const label = alarmLabel(r, info, now);
  return { title, label, full: title === memoTitle ? label : `${title}, ${label}` };
}

// 살아 있는 알림 세기는 반복 일정 계산이 들어가 무겁다 — 목록을 다시 그릴 때마다 하지 않게 알림마다 1분 기억
const liveCache = new WeakMap();
export function isLiveCached(r, now = new Date()) {
  const hit = liveCache.get(r);
  if (hit && Math.abs(now - hit.t) < 60_000) return hit.v;
  const v = isLive(r, now);
  liveCache.set(r, { t: now.getTime(), v });
  return v;
}

/**
 * 글 속 날짜(date-detect findDates 의 하나)로 일정 하나 — 일정 창 없이 바로 저장할 때 (매직키 "알림 맞춰 저장")
 *   미리 알림은 기본값(시각이 있으면 10분 전, 날짜만이면 그날 오전 9시), 이미 지난 알림은 그때 바로 울리는 것으로
 * @param {{ at: Date|string, hasTime?: boolean, repeat?: object|null, title?: string }} d
 */
export function eventFromDate(d, now = new Date()) {
  const start = new Date(d.at);
  if (Number.isNaN(start.getTime())) return null;
  const allDay = !d.hasTime && !d.repeat;
  const alerts = pendingAlerts(allDay ? DEFAULT_ALERTS.allDay : DEFAULT_ALERTS.timed, start, { repeat: Boolean(d.repeat), now, fallback: fallbackAlert(allDay), allDay });
  const base = { action: 'notify', enabled: true, created: toLocalIso(now), alerts, ...(d.title ? { title: String(d.title).slice(0, 80) } : {}) };
  if (d.repeat) {
    const r = { every: d.repeat.every, time: d.repeat.time };
    if (d.repeat.every === 'week') r.weekdays = d.repeat.weekdays;
    if (d.repeat.every === 'month' || d.repeat.every === 'year') r.day = d.repeat.day;
    if (d.repeat.every === 'year') r.month = d.repeat.month;
    return normalizeReminder({ ...base, kind: 'repeat', repeat: r }, now);
  }
  const at = allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : start;
  return normalizeReminder({ ...base, kind: 'at', at: toLocalIso(at), ...(allDay ? { allDay: true } : {}) }, now);
}
