// 시각 표현 — 파일에 쓰는 형식 (여러 모듈이 함께 쓰므로 따로 둔다)

const pad = (v) => String(Math.floor(Math.abs(v))).padStart(2, '0');

// 2026-09-29T17:30:12+09:00 (사람이 읽기 쉬운 현지 시각 + 시간대)
export function toLocalIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

// ---------- 화면 표시 조각 (format · reminders · voice-card · memo-file 이 함께 쓴다) ----------
export const pad2 = (v) => String(v).padStart(2, '0');
/** 09:05 */
export const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** 오후 3:12 */
export const koClock = (d) => `${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${pad2(d.getMinutes())}`;
/** 10월 4일 */
export const koMonthDay = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일`;

export const WEEKDAY = '일월화수목금토';
// 현지 날짜(연·월·일)를 UTC 날짜 수로 — 시간대·서머타임과 상관없이 하루 차이가 정확히 1
const dayNumber = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
/** 오늘부터 며칠 뒤인지 (어제 -1 · 오늘 0 · 내일 1) */
export const daysFrom = (d, now = new Date()) => dayNumber(new Date(d)) - dayNumber(new Date(now));
/** 10월 12일 (월) · 다른 해면 2027년 1월 2일 (토) */
export function koFullDate(date, now = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}년 `;
  return `${year}${koMonthDay(d)} (${WEEKDAY[d.getDay()]})`;
}
/** 어제 · 오늘 · 내일 · 모레 (그 밖은 null) */
export function relativeDay(date, now = new Date()) {
  return { [-1]: '어제', 0: '오늘', 1: '내일', 2: '모레' }[daysFrom(date, now)] ?? null;
}
/**
 * 날 이름 — 일정·알림·달력·날짜 밑줄이 모두 이 한 가지로: 오늘 · 내일 · 모레 · 10월 12일 (월) · 2027년 1월 2일 (토)
 * 시각을 붙일 때는 `${dayLabel(d)} ${koClock(d)}`
 */
export const dayLabel = (date, now = new Date()) => relativeDay(date, now) ?? koFullDate(date, now);

// 같은 날인지 비교용 키: 2026-09-29
export const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 휴지통 등 "언제" — 오늘 · 어제 · 3일 전 (PC·휴대폰 같은 말) */
export function daysAgoText(iso, now = new Date()) {
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  return days <= 0 ? '오늘' : days === 1 ? '어제' : `${days}일 전`;
}
