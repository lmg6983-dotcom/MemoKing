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
import { toLocalIso, dateKey, hhmm } from './time.js';

export const KINDS = ['timer', 'at', 'repeat', 'startup'];
export const EVERY = ['day', 'week', 'month', 'year'];
export const STARTUP = ['every', 'daily', 'once'];
export const ACTIONS = ['open', 'notify'];
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
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
  timed: [0, 10, 30, 60, 1440, 10080],
  allDay: [-540, 900, 9540], // 당일 오전 9시 · 하루 전 오전 9시 · 일주일 전 오전 9시
};
export const DEFAULT_ALERTS = { timed: [10], allDay: [-540] };
const MAX_ALERTS = 5;
const MAX_ALERT_MIN = 60 * 24 * 28;
export const isEvent = (r) => r.kind === 'at' || r.kind === 'repeat';

/** 미리 알림 (분 전) — 먼저 울리는 것부터. 적지 않았으면 정시(하루 종일은 당일 오전 9시) 한 번, [] 는 "알림 없음" (달력에만) */
export function alertsOf(r) {
  if (!isEvent(r)) return [0];
  const list = Array.isArray(r.alerts) ? r.alerts : [r.allDay ? -540 : 0];
  return [...new Set(list)].sort((a, b) => b - a);
}

function normalizeAlerts(raw) {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map((v) => Math.round(Number(v))).filter((v) => Number.isFinite(v) && v >= -1440 && v <= MAX_ALERT_MIN))]
    .sort((a, b) => b - a).slice(0, MAX_ALERTS);
}

const pad2 = (v) => String(v).padStart(2, '0');
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
    const alerts = normalizeAlerts(raw.alerts);
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
      const t = new Date(start.getTime() - offset * 60_000);
      if (t > base && (!best || t < best.at)) best = { at: t, start, offset };
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
  // 만들기 전에 이미 지난 "미리" 알림은 건너뛴다 (내일 아침 일정에 오늘 지난 "하루 전" 은 울리지 않음)
  for (let i = 0; next && next.offset > 0 && next.at < created && i < 50; i++) next = nextAlert(r, next.at);
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
  const once = r.kind === 'timer' || (r.kind === 'at' && !nextAlert(r, now)) || (r.kind === 'startup' && r.startup === 'once');
  return { ...r, last: toLocalIso(now), enabled: once ? false : r.enabled };
}

export const isDone = (r) => !r.enabled && Boolean(r.last) && (r.kind === 'timer' || r.kind === 'at' || r.startup === 'once');

// ---------- 화면용 문구 ----------

// 오늘 14:00 / 내일 09:00 / 10월 3일(금) 09:00 / 2027년 1월 2일(토) 09:00
export function formatWhen(date, now = new Date()) {
  const d = new Date(date);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return `오늘 ${hhmm(d)}`;
  if (diff === 1) return `내일 ${hhmm(d)}`;
  if (diff === -1) return `어제 ${hhmm(d)}`;
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}년 `;
  return `${year}${d.getMonth() + 1}월 ${d.getDate()}일(${WEEKDAY[d.getDay()]}) ${hhmm(d)}`;
}

/** 날짜만: 오늘 · 내일 · 10월 3일(금) · 2027년 1월 2일(토) */
export function formatDay(date, now = new Date()) {
  const d = new Date(date);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === -1) return '어제';
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}년 `;
  return `${year}${d.getMonth() + 1}월 ${d.getDate()}일(${WEEKDAY[d.getDay()]})`;
}

// 알림 설정 자체의 설명: "매주 월·수 09:00", "10분 타이머", "하루에 한 번, 처음 켤 때"
export function describeReminder(r, now = new Date()) {
  switch (r.kind) {
    case 'timer':
      return `${r.minutes >= 60 && r.minutes % 60 === 0 ? `${r.minutes / 60}시간` : `${r.minutes}분`} 타이머`;
    case 'at':
      return r.allDay ? `${formatDay(r.at, now)} 하루 종일` : formatWhen(r.at, now);
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
  let cursor = new Date(from.getTime() - 1);
  for (let i = 0; i < limit; i++) {
    const next = nextOccurrence(r, cursor);
    if (!next || next >= to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** 울릴 때 알림 문구: 일정이면 "내일 15:00 (30분 뒤)", 그 밖은 "알림, 10분 타이머" */
export function alarmLabel(r, info = {}, now = new Date()) {
  if (info.startup) return `켤 때 알림, ${describeReminder(r, now)}`;
  if (!isEvent(r) || !info.start) return `${info.missed ? '놓친 알림' : '알림'}, ${describeReminder(r, now)}`;
  const start = new Date(info.start);
  const when = r.allDay ? `${formatDay(start, now)} 하루 종일` : formatWhen(start, now);
  if (info.missed) return `놓친 알림, ${when}`;
  if (r.allDay) return when;
  const mins = Math.round((start.getTime() - now.getTime()) / 60_000);
  let soon = '';
  if (mins <= 0) soon = '지금 시작';
  else if (mins < 60) soon = `${mins}분 뒤`;
  else if (mins < 1440) soon = mins % 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분 뒤` : `${mins / 60}시간 뒤`;
  return soon ? `${when} (${soon})` : when;
}

/** 알림 제목: 일정 이름(없으면 메모 제목) */
export const alarmTitle = (r, memoTitle) => (isEvent(r) && r.title) || memoTitle;
