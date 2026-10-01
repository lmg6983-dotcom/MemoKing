// 화면 표시용 시각 형식

const pad = (v) => String(v).padStart(2, '0');

// 목록 카드: 오늘이면 시:분, 올해면 월.일, 아니면 연.월.일
export function formatTime(value, now = Date.now()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}.${d.getDate()}`;
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

// 녹음 시간: 1:05
export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// 목록 카드의 마지막 고친 시각: 26.10.01 09:05
export function formatStamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
