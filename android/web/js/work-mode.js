// 휴대폰의 업무 시간 설정 (이 휴대폰에만 — PC 는 PC 설정에) · core/work-hours.js
import { HOURS_KEY, normalizeHours } from '../../app/js/core/work-hours.js';

const listeners = new Set();

export function workHours() {
  try {
    return normalizeHours(JSON.parse(localStorage.getItem(HOURS_KEY) ?? 'null'));
  } catch {
    return normalizeHours(null);
  }
}

export function saveWorkHours(hours) {
  const h = normalizeHours(hours);
  try {
    localStorage.setItem(HOURS_KEY, JSON.stringify(h));
  } catch {
    // 이번 실행 동안만은 못 쓴다 — 다음에 기본값
  }
  for (const fn of listeners) fn(h);
  return h;
}

/** 업무 시간 설정이 바뀌면 (모드 시계 · 알림 예약을 새로) */
export const onWorkHours = (fn) => listeners.add(fn);
