// 화면 표시용 시각 형식
import { pad2 as pad, hhmm, koClock, koMonthDay } from './time.js';

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

// "‘장보기 목록’ 메모를 휴지통으로 옮겼어요" — 어떤 메모인지 (길면 앞 18자)
export function trashedText(title) {
  const t = String(title ?? '').trim();
  if (!t) return '메모를 휴지통으로 옮겼어요';
  return `‘${t.length > 18 ? `${t.slice(0, 18)}…` : t}’ 메모를 휴지통으로 옮겼어요`;
}

// 카드 미리 보기 글의 웹 주소는 짧게: "https://www.example.com/restaurant." → "example.com/restaurant."
//   (긴 주소가 카드 폭에서 "…/rest" · "aurant" 처럼 낱말 중간에 끊겨 보였다) — 너무 길면 앞부분 + …
export function shortUrls(text, max = 28) {
  return String(text ?? '').replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
    const tail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? ''; // 문장 끝 마침표 · 괄호는 주소가 아니다
    let s = url.slice(0, url.length - tail.length).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
    if (s.length > max) s = `${s.slice(0, max - 1)}…`;
    return s + tail;
  });
}
