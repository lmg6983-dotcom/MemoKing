// 화면 표시용 시각 형식
import { pad2 as pad, hhmm, koClock, koMonthDay } from './time.js';

// 목록 카드: 오늘이면 시:분, 올해면 월.일, 아니면 연.월.일
export function formatTime(value, now = Date.now()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return hhmm(d);
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
  return `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${hhmm(d)}`;
}

// 목록 카드: 사람이 말하듯 — 방금 · 5분 전 · 오후 3:20 · 어제 오후 3:20 · 화요일 · 10월 2일 · 25.10.02
export function friendlyTime(value, now = Date.now()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const diff = now - d.getTime();
  if (diff >= -60_000 && diff < 60_000) return '방금';
  if (diff > 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  const n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86_400_000);
  const clock = koClock(d);
  if (days === 0) return clock;
  if (days === 1) return `어제 ${clock}`;
  if (days > 1 && days < 7) return `${'일월화수목금토'[d.getDay()]}요일`;
  if (d.getFullYear() === n.getFullYear()) return koMonthDay(d);
  return `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}
