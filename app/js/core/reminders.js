// 예약 알림 — 메모 머리말의 reminders 항목. 다음 알림 시각 계산과 설명 문구 (순수 함수, 단위 테스트 대상)
//
//   reminders:
//     - id: r7k2
//       kind: repeat            # timer | at | repeat | startup
//       repeat: { every: week, weekdays: [1, 3], time: "09:00" }
//       action: open            # open(메모 띄우기) | notify(알림만)
//       created: 2026-09-30T10:00:00+09:00
//       last: 2026-10-01T09:00:02+09:00   # 마지막으로 울린 시각
import { toLocalIso, dateKey } from './time.js';

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
  if (r.kind === 'timer' || r.kind === 'at') {
    if (!validDate(raw.at)) return null;
    r.at = String(raw.at);
    if (r.kind === 'timer') r.minutes = Math.max(1, Math.round(Number(raw.minutes) || 0)) || 1;
  } else if (r.kind === 'repeat') {
    const src = raw.repeat ?? {};
    const every = EVERY.includes(src.every) ? src.every : 'day';
    const repeat = { every, time: parseTime(src.time).text };
    if (every === 'week') {
      const days = Array.isArray(src.weekdays) ? src.weekdays.map(Number).filter((d) => d >= 0 && d <= 6) : [];
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
 * 지금 울려야 하는가. 놓친 반복 알림이 여러 번이어도 한 번만 울린다(울린 뒤 last = 지금).
 * @returns {{ at: Date, missed: boolean } | null}
 */
export function dueOccurrence(r, now = new Date()) {
  if (!r.enabled || r.kind === 'startup') return null;
  if ((r.kind === 'timer' || r.kind === 'at') && r.last) return null;
  const from = r.kind === 'repeat' ? validDate(r.last) ?? validDate(r.created) : new Date(0);
  const next = nextOccurrence(r, from);
  if (!next || next > now) return null;
  return { at: next, missed: now - next > MISSED_AFTER_MS };
}

// 앱을 시작할 때 울려야 하는가 (실행할 때 알림)
export function dueAtStartup(r, now = new Date()) {
  if (!r.enabled || r.kind !== 'startup') return false;
  if (r.startup === 'daily') return !r.last || dateKey(validDate(r.last)) !== dateKey(now);
  return true;
}

// 울린 뒤 상태: 한 번짜리(타이머·날짜·다음 실행 한 번)는 꺼져서 "완료" 로 남는다
export function markFired(r, now = new Date()) {
  const once = r.kind === 'timer' || r.kind === 'at' || (r.kind === 'startup' && r.startup === 'once');
  return { ...r, last: toLocalIso(now), enabled: once ? false : r.enabled };
}

export const isDone = (r) => !r.enabled && Boolean(r.last) && (r.kind === 'timer' || r.kind === 'at' || r.startup === 'once');

// ---------- 화면용 문구 ----------

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

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

// 알림 설정 자체의 설명: "매주 월·수 09:00", "10분 타이머", "하루에 한 번, 처음 켤 때"
export function describeReminder(r, now = new Date()) {
  switch (r.kind) {
    case 'timer':
      return `${r.minutes >= 60 && r.minutes % 60 === 0 ? `${r.minutes / 60}시간` : `${r.minutes}분`} 타이머`;
    case 'at':
      return formatWhen(r.at, now);
    case 'repeat': {
      const { every, time, weekdays, day, month } = r.repeat;
      if (every === 'day') return `매일 ${time}`;
      if (every === 'week') {
        const names = weekdays.length === 7 ? '매일' : weekdays.map((w) => WEEKDAY[w]).join('·');
        return `매주 ${names} ${time}`;
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
  const from = r.kind === 'repeat' ? new Date(Math.max(now, validDate(r.last) ?? 0)) : now;
  const next = nextOccurrence(r, from);
  return next ? formatWhen(next, now) : null;
}

// 정렬용: 다음 알림 시각(ms). 실행할 때 알림·꺼진 알림은 뒤로.
export function nextTime(r, now = new Date()) {
  if (!r.enabled || r.kind === 'startup') return Infinity;
  const due = dueOccurrence(r, now);
  if (due) return due.at.getTime();
  return nextOccurrence(r, now)?.getTime() ?? Infinity;
}
