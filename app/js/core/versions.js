// 메모 버전 기록 — 자동 저장이 덮어쓰기 전의 내용을 _memoking/versions/<메모 id>/<시각>.md 로 남겨 둔다.
// "1시간 전 내용으로 되돌리기" 와, 다른 기기에서 고친 내용이 들어왔을 때 어느 쪽이든 되찾을 수 있게.
// 규칙(이름·간격·보관 개수)만 여기에 두고, 파일 읽기·쓰기는 데스크탑·휴대폰 vault 가 맡는다.
import { extractTitle, extractPreview, isBlankBody, sameBody } from './memo-file.js';

export const VERSIONS_DIR = '_memoking/versions';
// 계속 쓰는 동안에는 이 간격마다 하나씩만 (몇 초마다 저장돼도 버전이 쏟아지지 않게)
export const VERSION_GAP_MS = 10 * 60 * 1000;
export const MAX_VERSIONS = 30;
export const MAX_VERSION_AGE_DAYS = 30;
// 오래돼도 최근 몇 개는 늘 남긴다 (오래 안 고친 메모도 되돌릴 곳이 있게)
const KEEP_RECENT = 3;

const pad = (v) => String(v).padStart(2, '0');

export function versionName(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.md`;
}

/** "20261008-153000.md" → 그 시각(ms), 형식이 아니면 null */
export function versionTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.md$/i.exec(String(name ?? ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

// 메모 id 는 폴더 이름이 되므로 경로를 벗어나는 글자를 막는다
export const safeVersionId = (id) => (/^[A-Za-z0-9_-]{1,80}$/.test(String(id ?? '')) ? String(id) : null);
export const isVersionName = (name) => versionTime(name) !== null && !/[\\/]/.test(name);

/**
 * 지금 바뀌기 전 내용(before)을 버전으로 남길지.
 * @param {string} before 덮어쓰일 내용
 * @param {{ at: number, body?: string }|null} latest 가장 최근 버전
 * @param {{ now?: number, force?: boolean }} [o] force: 간격과 상관없이 (되돌리기 직전 등)
 */
export function shouldKeepVersion(before, latest, { now = Date.now(), force = false } = {}) {
  if (typeof before !== 'string' || isBlankBody(before)) return false;
  if (latest?.body !== undefined && sameBody(latest.body, before)) return false;
  if (force || !latest) return true;
  return now - latest.at >= VERSION_GAP_MS;
}

/** 지울 버전 이름들: 최근 MAX_VERSIONS 개만, 그중에서도 MAX_VERSION_AGE_DAYS 가 지난 것은 빼되 최근 KEEP_RECENT 개는 남김 */
export function versionsToPrune(names, now = Date.now()) {
  const dated = names.map((name) => ({ name, at: versionTime(name) })).filter((v) => v.at !== null).sort((a, b) => b.at - a.at);
  const cutoff = now - MAX_VERSION_AGE_DAYS * 86_400_000;
  return dated.filter((v, i) => i >= MAX_VERSIONS || (i >= KEEP_RECENT && v.at < cutoff)).map((v) => v.name);
}

/** 목록에 보일 모양 (새것 먼저) */
export function describeVersions(items) {
  return items
    .filter((v) => v.at !== null && typeof v.body === 'string')
    .sort((a, b) => b.at - a.at)
    .map((v) => ({
      name: v.name,
      at: new Date(v.at).toISOString(),
      title: extractTitle(v.body),
      preview: extractPreview(v.body, 120),
      chars: v.body.length,
    }));
}
