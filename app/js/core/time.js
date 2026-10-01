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

// 같은 날인지 비교용 키: 2026-09-29
export const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
