// 휴대폰 앱 안 업데이트의 판단 규칙 (android/web/js/updates.js 가 쓴다 — Kotlin 쪽은 AppUpdate.kt, 규칙은 AppUpdateTest.kt)
//   · 앱을 켤 때 조용히 확인하되 6시간 안에 또 확인하지 않는다 · 설정 › 업데이트 확인 은 언제나
//   · 새 버전이 있어도 "나중에" 를 고르면 그 버전은 24시간 다시 묻지 않는다 (PC 의 desktop/updater.js 와 같은 약속)
import { formatBytes } from './file-kinds.js';

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

/** 조용히 확인할 때가 됐는가 */
export function dueForCheck(lastAt, now = Date.now()) {
  return !Number.isFinite(lastAt) || lastAt <= 0 || now - lastAt >= CHECK_EVERY_MS || lastAt > now;
}

/** 이 버전 알림을 지금 숨길까 ("나중에" 를 고른 지 24시간 안) */
export function isSnoozed(snooze, version, now = Date.now()) {
  return Boolean(snooze && snooze.version === version && now < snooze.until);
}

/** 받는 중 글: "42% · 24.3MB / 58.0MB" (전체 크기를 모르면 퍼센트 없이 받은 만큼) */
export function progressLabel(done, total) {
  const d = Number(done) || 0;
  const t = Number(total) || 0;
  if (t > 0) return `${Math.min(100, Math.floor((d / t) * 100))}% · ${formatBytes(d)} / ${formatBytes(t)}`;
  return d > 0 ? formatBytes(d) : '';
}

/** 앱이 보낸 확인 결과를 화면이 쓸 모양으로 (모르는 값은 안전하게 "새 버전 없음") */
export function normalizeInfo(raw) {
  const info = raw && typeof raw === 'object' ? raw : {};
  return {
    available: info.available === true,
    current: String(info.current ?? ''),
    version: String(info.version ?? ''),
    notes: String(info.notes ?? ''),
    size: Number(info.size) || 0,
    sha256: String(info.sha256 ?? ''),
    apk: String(info.apk ?? ''),
  };
}
