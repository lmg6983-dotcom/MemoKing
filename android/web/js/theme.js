// 휴대폰 화면 밝기: 메모킹 Work 는 어두운 화면 · Life 는 밝은 화면 (시스템 설정과 상관없이)
//   목록은 지금 고른 모드, 메모를 열면 그 메모의 모드 — 닫으면 다시 목록의 모드 (CSS 는 :root[data-theme])
import { matchChrome } from './ui.js';

let listMode = 'life';

export function setTheme(mode) {
  const theme = mode === 'work' ? 'dark' : 'light';
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  requestAnimationFrame(() => matchChrome?.(document.querySelector('.screen:not([hidden]) .bar, .screen:not([hidden]) .searchbar') ?? document.body));
}

/** 목록의 모드 (list-view) — 메모가 열려 있지 않으면 바로 그 밝기로 */
export function setListTheme(mode, { noteOpen = false } = {}) {
  listMode = mode;
  if (!noteOpen) setTheme(mode);
}

/** 메모를 닫을 때 (note-view) */
export const restoreListTheme = () => setTheme(listMode);
