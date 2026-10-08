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

// 같은 날인지 비교용 키: 2026-09-29
export const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 휴지통 등 "언제" — 오늘 · 어제 · 3일 전 (PC·휴대폰 같은 말) */
export function daysAgoText(iso, now = new Date()) {
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  return days <= 0 ? '오늘' : days === 1 ? '어제' : `${days}일 전`;
}
