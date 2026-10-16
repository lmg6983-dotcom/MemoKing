// 메모킹 일정 → 다른 캘린더의 일정 모양 (ical.js 없이 — .ics 내보내기 · Google 캘린더 상호 동기화가 함께 쓴다)
import { pad2 } from './time.js';
import { isEvent, nextOccurrence } from './reminders.js';

export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const ymd = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
export const DEFAULT_MINUTES = 60; // 메모킹 일정은 끝나는 때가 없다 — 다른 캘린더에는 1시간으로 (Google 캘린더 기본과 같음)

/** 반복 일정 → RRULE (한 번짜리는 '') */
export function rruleOf(r) {
  if (r.kind !== 'repeat') return '';
  const rep = r.repeat;
  if (rep.every === 'day') return 'FREQ=DAILY';
  if (rep.every === 'week') return `FREQ=WEEKLY;BYDAY=${rep.weekdays.map((d) => WEEKDAY_CODES[d]).join(',')}`;
  // 메모킹은 31일이 없는 달에 그 달 마지막 날 — 다른 캘린더에는 29~31일이면 "그 달 마지막 날 무렵"을 맞추기 어려워 그날만
  if (rep.every === 'month') return `FREQ=MONTHLY;BYMONTHDAY=${rep.day}`;
  if (rep.every === 'year') return `FREQ=YEARLY;BYMONTH=${rep.month};BYMONTHDAY=${rep.day}`;
  return '';
}

/**
 * 한 일정의 첫 회차 시작 · 끝 (반복은 만든 때 뒤의 첫 회차, 한 번짜리는 그 시각)
 * @returns {{ start: Date, end: Date, allDay: boolean } | null}
 */
export function eventSpan(r, now = new Date()) {
  if (!isEvent(r)) return null;
  let start;
  if (r.kind === 'at') start = new Date(r.at);
  else {
    const created = new Date(r.created);
    const base = Number.isNaN(created.getTime()) ? now : created;
    start = nextOccurrence(r, new Date(new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime() - 1));
  }
  if (!start || Number.isNaN(start.getTime())) return null;
  const allDay = Boolean(r.allDay);
  if (allDay) start = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const end = allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) : new Date(start.getTime() + DEFAULT_MINUTES * 60_000);
  return { start, end, allDay };
}

