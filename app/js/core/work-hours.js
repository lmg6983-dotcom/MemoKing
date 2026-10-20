// 메모킹 Work / Life 2단계 — 업무 시간 (PC · 휴대폰 같은 규칙)
//   auto: 업무 시간이 시작되면 Work, 끝나면 Life로 저절로 (경계를 넘을 때만 — 그 사이 손으로 바꾼 건 그대로 둔다)
//   quiet: 업무 시간 밖(퇴근 뒤 · 쉬는 날)에는 Work 메모의 알림을 띄우지 않고 조용히 (고정한 메모 = 중요한 메모는 늘 울린다)
import { memoMode } from './modes.js';

export const HOURS_KEY = 'memoking.workHours';
export const DEFAULT_HOURS = Object.freeze({ auto: false, quiet: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' });
export const WEEKDAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (hhmm) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function normalizeHours(value) {
  const v = value && typeof value === 'object' ? value : {};
  const days = Array.isArray(v.days) ? [...new Set(v.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [...DEFAULT_HOURS.days];
  return {
    auto: v.auto === true,
    quiet: v.quiet === true,
    days,
    start: HHMM.test(v.start) ? v.start : DEFAULT_HOURS.start,
    end: HHMM.test(v.end) ? v.end : DEFAULT_HOURS.end,
  };
}

/** 이 때가 업무 시간인가 — 끝이 시작보다 이르면 밤을 넘기는 근무 (예: 22:00~06:00, 시작한 요일 기준) */
export function inWorkHours(date, hours) {
  const h = normalizeHours(hours);
  const s = minutes(h.start);
  const e = minutes(h.end);
  if (s === e) return false;
  const t = date.getHours() * 60 + date.getMinutes();
  const day = date.getDay();
  if (s < e) return h.days.includes(day) && t >= s && t < e;
  if (t >= s) return h.days.includes(day);
  return t < e && h.days.includes((day + 6) % 7); // 자정 넘어 — 어제 시작한 근무
}

/** 지금 저절로 고를 모드 */
export const scheduledMode = (date, hours) => (inWorkHours(date, hours) ? 'work' : 'life');

/** 이 알림을 조용히 둘까 (업무 시간 밖의 Work 메모 · 고정하지 않은 것) */
export function quietAlarm(memo, date, hours) {
  const h = normalizeHours(hours);
  return h.quiet && memoMode(memo) === 'work' && memo?.pinned !== true && !inWorkHours(date, h);
}

/** "월~금 09:00–18:00" */
export function hoursLabel(hours) {
  const h = normalizeHours(hours);
  const d = h.days;
  let days;
  if (d.join() === '1,2,3,4,5') days = '평일';
  else if (d.length === 7) days = '매일';
  else if (!d.length) days = '쉬는 날만';
  else days = d.map((x) => WEEKDAY_LABEL[x]).join(', ');
  return `${days} ${h.start}–${h.end}`;
}

/**
 * 모드 시계: 업무 시간의 경계를 넘을 때 onChange(mode) — 처음 부를 때도 한 번 (켤 때 업무 시간이면 Work로 시작)
 * @returns {(now?: Date) => void} 1분쯤마다 부른다
 */
export function modeClock({ getHours, onChange }) {
  let last = null;
  return (now = new Date()) => {
    const h = normalizeHours(getHours());
    if (!h.auto) {
      last = null; // 다시 켜면 그때의 모드로 시작
      return;
    }
    const m = scheduledMode(now, h);
    if (m === last) return;
    const first = last === null;
    last = m;
    onChange(m, { first });
  };
}
