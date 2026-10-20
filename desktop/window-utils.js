// Electron 창 관련 기본 유틸리티 — 창 모양, 크기 계산, 애니메이션, 안전 가드.
import { app, BrowserWindow, nativeTheme, screen } from 'electron';
import path from 'node:path';
import { tweenBounds, DEFAULT_NOTE_SIZE } from './placement.js';

export const APP_DIR = path.join(import.meta.dirname, '..', 'app');
export const PRELOAD = path.join(import.meta.dirname, 'preload.cjs');
export const OCR_PRELOAD = path.join(import.meta.dirname, 'ocr-preload.cjs');
export const MAGIC_PRELOAD = path.join(import.meta.dirname, 'magic-preload.cjs');
export const FINDER_PRELOAD = path.join(import.meta.dirname, 'finder-preload.cjs');
export const OPMS_PRELOAD = path.join(import.meta.dirname, 'opms-preload.cjs');
export const ASSETS_DIR = path.join(import.meta.dirname, '..', 'assets');

export const APP_ICON = path.join(ASSETS_DIR, 'icons', 'memoking.ico');
export const APP_ICON_PNG = path.join(ASSETS_DIR, 'icons', 'icon-256.png');

export const webPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

export const windowIcon = { icon: APP_ICON };

// 스티커 창이 뜨는 순간의 배경색 (화면 CSS 와 같은 값)
export const NOTE_BG = {
  light: { yellow: '#fff4b8', green: '#ddf5df', pink: '#ffe0ec', purple: '#ede3ff', blue: '#ddeeff', gray: '#f1f0ec', charcoal: '#1c1c1b' },
  dark: { yellow: '#3a3317', green: '#1e3322', pink: '#3d2230', purple: '#2c2440', blue: '#1c2d42', gray: '#262624', charcoal: '#141413' },
};

export const noteBg = (color) => NOTE_BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'][color] ?? NOTE_BG.light.yellow;

export function guardWindow(win, { openWebPage } = {}) {
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && openWebPage) openWebPage(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_event, input) => {
    // 개발자 도구는 개발할 때만 (설치한 메모킹에서 실수로 F12 를 눌러 알 수 없는 창이 뜨지 않게)
    if (!app.isPackaged && input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

export function onScreen(bounds) {
  if (!bounds) return false;
  const area = screen.getDisplayMatching(bounds).workArea;
  return bounds.x < area.x + area.width - 40 && bounds.x + bounds.width > area.x + 40 &&
    bounds.y >= area.y - 10 && bounds.y < area.y + area.height - 40;
}

// 창 버튼(최소화·최대화·닫기) 줄은 Windows 가 화면 위에 그려 대화 상자로 덮을 수 없다.
// 대화 상자·튜토리얼 동안에는 이 줄의 바탕을 뒤 막(검정 40%·45%)을 얹은 색으로 맞춘다.
let currentTitleBarDim = false; // false | 'dialog' | 'coach'
const TITLEBAR_DIM = { light: { dialog: '#949391', coach: '#878785' }, dark: { dialog: '#080808', coach: '#080808' } };

export function setTitleBarDim(level) {
  currentTitleBarDim = level === 'dialog' || level === 'coach' ? level : false;
  return currentTitleBarDim;
}

export function getTitleBarDim() {
  return currentTitleBarDim;
}

export function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  const base = dark ? '#0e0e0d' : '#f6f5f1';
  return {
    color: currentTitleBarDim ? TITLEBAR_DIM[dark ? 'dark' : 'light'][currentTitleBarDim] : base,
    symbolColor: dark ? '#f5f4ef' : '#111111',
    height: 44,
  };
}

/** 열린 창 모두에 알림 (설정이 바뀌었을 때 등) */
export function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

// 창을 앞으로: 내려 둔 창은 되살리고, 보이게 한 뒤 (inactive 가 아니면) 포커스까지
export function bringToFront(win, { inactive = false, raise = false } = {}) {
  if (win.isMinimized()) win.restore();
  if (inactive) win.showInactive();
  else win.show();
  if (raise) win.moveTop();
  if (!inactive) win.focus();
}

// size: 손 메모로 만드는 새 메모는 그리기 좋게 넓게
export function defaultNoteBounds(size = DEFAULT_NOTE_SIZE, { listWin = null, noteWinsCount = 0 } = {}) {
  const { width, height } = size;
  const n = noteWinsCount;
  const anchor = listWin?.getBounds() ?? screen.getPrimaryDisplay().workArea;
  const area = screen.getDisplayMatching(anchor).workArea;
  let x = anchor.x + anchor.width + 16 + n * 28;
  let y = anchor.y + n * 28;
  if (x + width > area.x + area.width) x = Math.max(area.x, anchor.x - width - 16 - n * 28);
  if (y + height > area.y + area.height) y = area.y + 40;
  return { x: Math.round(x), y: Math.round(y), width, height };
}

// 창마다 "첫 화면을 그렸다" 약속
const paintedOf = new WeakMap();

//   manual: 미리 불러 둔 예비 창처럼 이미 그린 창 — 돌려주는 함수를 부르면 그린 것으로 친다
export function trackPaint(win, { manual = false } = {}) {
  let mark;
  paintedOf.set(win, new Promise((resolve) => { mark = resolve; }));
  const wc = win.webContents;
  if (manual) {
    wc.once('render-process-gone', mark);
    return mark;
  }
  const onShow = () => {
    if (!wc.isLoading()) mark();
    else wc.once('did-finish-load', mark);
  };
  win.once('ready-to-show', mark);
  wc.once('did-fail-load', mark);
  wc.once('render-process-gone', mark);
  win.on('show', onShow);
  paintedOf.get(win).then(() => {
    if (!win.isDestroyed()) win.off('show', onShow);
  });
  return mark;
}

export function whenPainted(win, fn) {
  const paintedPromise = paintedOf.get(win);
  if (!paintedPromise) return fn();
  paintedPromise.then(() => {
    if (!win.isDestroyed()) fn();
  });
}

/** 창이 지금 모습을 한 번 새로 그릴 때까지 (requestAnimationFrame 두 번) — 늦어도 150ms */
export function painted(win) {
  const frame = win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true).catch(() => false);
  return Promise.race([frame, new Promise((r) => setTimeout(r, 150))]);
}

/** 창을 투명 → 불투명으로 부드럽게 (스택 탭: 색이 다른 메모로 바뀔 때 색이 툭 바뀌지 않게) — 끝나면 resolve */
export function fadeIn(win, duration = 120) {
  return new Promise((resolve) => {
    const start = Date.now();
    const step = () => {
      if (win.isDestroyed()) return resolve();
      const t = Math.min(1, (Date.now() - start) / duration);
      win.setOpacity(1 - (1 - t) ** 2); // 처음엔 빨리, 끝은 천천히
      if (t < 1) setTimeout(step, 16);
      else resolve();
    };
    step();
  });
}

// 이미 열린 창은 180ms 동안 부드럽게 이동
export function animateBounds(win, to, duration = 180) {
  const from = win.getBounds();
  const start = Date.now();
  const step = () => {
    if (win.isDestroyed()) return;
    const t = (Date.now() - start) / duration;
    win.setBounds(tweenBounds(from, to, t));
    if (t < 1) setTimeout(step, 12);
  };
  step();
}
