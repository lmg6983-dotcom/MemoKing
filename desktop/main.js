// Electron 메인 프로세스 — 목록 창·스티커 창 관리, 설정, 메모 폴더(볼트) 연결.
import {
  app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, Notification,
  powerMonitor, protocol, safeStorage, screen, session, shell, Tray,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Vault } from './vault.js';
import { isInside, dropBounds, tweenBounds, DEFAULT_NOTE_SIZE } from './placement.js';
import { createAlarmRunner } from './alarms.js';
import { NotificationHistory } from './notification-history.js';
import { GoogleAuth } from './drive/google-auth.js';
import { DriveApi } from './drive/drive-api.js';
import { DriveSync, insideDriveForDesktop, copyVault } from './drive/drive-sync.js';
import { CaptureHelper, readCaptureDir, buildCapture, sourceLine, captureTitle, captureWhere } from './quick-capture.js';
import { LinkPreviews } from './link-previews.js';
import { isProgramFile } from '../app/js/core/file-kinds.js';
import { collectTags } from '../app/js/core/tags.js';
import { autoTagsFor } from '../app/js/core/auto-tags.js';
import { suggestTagsFor } from '../app/js/core/tag-suggest.js';
import { StackStore } from './stacks.js';
import { PopupWatcher } from './popup-watch.js';
import { popupToEntry, kakaoEntry, popupAppName, isRepeat, POPUP_APPS } from '../app/js/core/popup-notify.js';
import { pdfFileName, mmToPx } from '../app/js/core/pdf-page.js';
import { normalizeMagicSettings, activeModules, memoBodyFromText, MAGIC_KEY, MAGIC_MODULES } from '../app/js/core/magic-modules.js';
import { searchMemos } from '../app/js/core/memo-search.js';
import { FileIndex } from './file-index.js';
import { createDoublePress } from './double-press.js';
import { execFile } from 'node:child_process';
import { TUTORIAL_STEPS, advanceTutorial } from '../app/js/core/tutorial.js';
import { toLocalIso, extractPreview } from '../app/js/core/memo-file.js';
import { imageExtFromType, imageExtFromUrl, MAX_REMOTE_IMAGE_BYTES } from '../app/js/core/remote-images.js';
import { normalizeReminder, describeReminder } from '../app/js/core/reminders.js';

const SMOKE = process.argv.includes('--smoke');
// Windows 로그인 때 자동 실행된 경우: 창 없이 알림 영역에서 조용히 시작
const HIDDEN_START = process.argv.includes('--hidden');
const LOGIN_ARGS = ['--hidden'];
// Windows 알림(토스트)의 앱 신원 — 설치판(electron-builder appId)과 같아야 한다
const APP_ID = 'com.memoking.desktop';
const APP_DIR = path.join(import.meta.dirname, '..', 'app');
const PRELOAD = path.join(import.meta.dirname, 'preload.cjs');
const OCR_PRELOAD = path.join(import.meta.dirname, 'ocr-preload.cjs');
const MAGIC_PRELOAD = path.join(import.meta.dirname, 'magic-preload.cjs');
const ASSETS_DIR = path.join(import.meta.dirname, '..', 'assets');
// 창·작업표시줄·알림 영역 아이콘 (npm run icons 로 생성, 16~256px 9개 크기)
const APP_ICON = path.join(ASSETS_DIR, 'icons', 'memoking.ico');
const APP_ICON_PNG = path.join(ASSETS_DIR, 'icons', 'icon-256.png');
// PowerShell 이 읽어야 하므로 설치판에서는 asar 밖(app.asar.unpacked)에 둔다
const POPUP_HELPER = path.join(import.meta.dirname, '..', 'scripts', 'popup-watch.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const CLIPBOARD_HELPER = path.join(import.meta.dirname, '..', 'scripts', 'clipboard-helper.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const QUICK_MEMO_KEY = 'Control+Alt+C';

// 스티커 창이 뜨는 순간의 배경색 (화면 CSS 와 같은 값)
const NOTE_BG = {
  light: { yellow: '#fff4b8', green: '#ddf5df', pink: '#ffe0ec', purple: '#ede3ff', blue: '#ddeeff', gray: '#f1f0ec', charcoal: '#1c1c1b' },
  dark: { yellow: '#3a3317', green: '#1e3322', pink: '#3d2230', purple: '#2c2440', blue: '#1c2d42', gray: '#262624', charcoal: '#141413' },
};
const noteBg = (color) => NOTE_BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'][color] ?? NOTE_BG.light.yellow;

if (SMOKE) {
  // 자동 점검은 실제 설정·메모를 건드리지 않도록 임시 폴더를 쓴다.
  const smokeDir = path.join(os.tmpdir(), 'memoking-smoke');
  fs.rmSync(smokeDir, { recursive: true, force: true });
  fs.mkdirSync(smokeDir, { recursive: true });
  app.setPath('userData', path.join(smokeDir, 'userData'));
}
const gotLock = SMOKE || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

protocol.registerSchemesAsPrivileged([
  { scheme: 'memoking', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ---------- 설정 ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {
  vaultPath: null, openNotes: [], noteBounds: {}, onTop: {}, listBounds: null, migratedV1: false,
  historyEnabled: false, // 알림 보관함 (다른 앱 알림을 읽으므로 사용자가 켤 때만)
  autoStartSet: false, // 설치판 첫 실행 때 자동 실행을 한 번 켜 두었는지
  quickMemo: true, // Ctrl+Alt+C 빠른 메모
  tutorialDone: false, // 처음 실행 튜토리얼을 마쳤거나 건너뛰었는지
  trashDays: 30, // 휴지통에 이 날짜보다 오래 있던 메모를 저절로 영구 삭제 (0 = 하지 않음)
  listOnTop: false, // 목록 창도 다른 창보다 늘 위에
  historyBlocked: {}, // 알림 보관함에 모으지 않을 앱 { 앱 id: 앱 이름 }
  drive: null, // Google Drive 직접 동기화: { folderId, folderName } (메모 폴더를 이 Drive 폴더와 맞춘다)
  fitTables: true, // 표가 메모 본문보다 넓으면 메모를 줄여 맞추고, 더 못 줄이면 창을 넓힌다
  autoTags: true, // 태그 없는 메모를 닫을 때 확실한 추천 태그를 저절로 (휴대폰과 같음)
  magic: undefined, // 매직키 (Ctrl+Alt+Space): { enabled, modules } — normalizeMagicSettings 로 정리
  magicPos: null, // 매직키 창을 끌어 옮긴 자리 { x, y }
};
let settingsTimer = null;

// 지금 설치를 알아보는 표시: 버전 + 앱 파일을 설치한 때 (다시 설치하면 파일이 새로 만들어진다). 개발 실행은 버전만
function installMark() {
  let at = 0;
  if (app.isPackaged) {
    try {
      at = Math.round(fs.statSync(path.join(process.resourcesPath, 'app.asar')).birthtimeMs);
    } catch {
      // 알 수 없으면 버전만
    }
  }
  return `${app.getVersion()}@${at}`;
}

function loadSettings() {
  try {
    const loaded = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...settings, ...loaded };
    // 튜토리얼 이전 버전부터 쓰던 사람에게는 업데이트 뒤 저절로 띄우지 않는다
    if (!('tutorialDone' in loaded)) settings.tutorialDone = true;
    // 새로 설치·업데이트·다시 설치했으면 튜토리얼을 다시 (같은 설치에서는 한 번만)
    if (settings.tutorialInstall !== installMark()) settings.tutorialDone = false;
  } catch {
    // 첫 실행
  }
}

function saveSettings(now = false) {
  clearTimeout(settingsTimer);
  const write = () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  };
  if (now) write();
  else settingsTimer = setTimeout(write, 500);
}

// Google Drive 가 있으면 그 안의 "메모킹" 폴더를 추천한다.
function suggestedVaultPath() {
  const drives = ['G:\\내 드라이브', 'G:\\My Drive', path.join(os.homedir(), 'Google Drive'), path.join(os.homedir(), 'My Drive')];
  const base = drives.find((d) => fs.existsSync(d)) ?? app.getPath('documents');
  return path.join(base, '메모킹');
}

// ---------- 볼트 ----------

let vault = null;
let vaultError = null;
let listWin = null;
const noteWins = new Map();
let quitting = false;
let listTimer = null;

function openVault(dir) {
  vault?.close();
  vault = null;
  try {
    const next = new Vault(dir);
    next.on('changed', ({ external, removed }) => {
      pushList();
      driveSync?.request(3000); // 고친 것을 잠시 뒤 Google Drive 로
      for (const id of external) sendToNote(id, 'memo:external', next.get(id));
      for (const id of removed) sendToNote(id, 'memo:removed');
    });
    next.on('indexed', (index) => listWin?.webContents.send('vault:indexed', index.generatedAt));
    next.on('error', (err) => console.error('[vault]', err));
    next.open();
    vault = next;
    vaultError = null;
    settings.vaultPath = next.root;
    saveSettings();
    migrateV1();
    loadStacks();
    purgeTrash();
    configureDrive();
  } catch (err) {
    console.error('메모 폴더 열기 실패', err);
    vaultError = '메모 폴더를 열지 못했어요. 폴더가 있는지, Google Drive가 연결돼 있는지 확인해 주세요.';
    console.error(err);
  }
  listWin?.webContents.send('vault:opened', vaultInfo());
  pushList();
  return vaultInfo();
}

function vaultInfo() {
  return { vaultPath: vault?.root ?? null, vaultError, suggestedPath: suggestedVaultPath(), version: app.getVersion() };
}

// 목록 카드에 "지금 열려 있는 메모" 표시를 붙인다.
// 스택의 숨은 탭은 열린 것으로 치지 않는다. stack: 같은 스택의 탭 수
const withOpenFlag = (memos) => memos.map((m) => ({
  ...m,
  open: Boolean(noteWins.get(m.id)?.isVisible()),
  stack: stacks?.stackOf(m.id)?.memos.length ?? 0,
}));
const listMemos = () => withOpenFlag(vault?.list() ?? []);

function pushList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    listWin?.webContents.send('memos:changed', listMemos());
    pushAllStacks(); // 탭 제목·색
    updateTrayMenu(); // 트레이의 "최근 메모"도 함께 갱신
  }, 80);
}

function sendToNote(id, channel, ...args) {
  noteWins.get(id)?.webContents.send(channel, ...args);
}

// v0.1.0 의 memos.json 을 메모 파일로 옮겨 온다 (한 번만).
function migrateV1() {
  if (settings.migratedV1 || !vault) return;
  const legacy = path.join(app.getPath('userData'), 'memos.json');
  if (fs.existsSync(legacy)) {
    try {
      const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      for (const m of data.memos ?? []) {
        const title = String(m.title ?? '').trim();
        const body = title ? `# ${title}\n\n${m.body ?? ''}` : String(m.body ?? '');
        if (!body.trim()) continue;
        vault.import({
          body,
          created: m.createdAt ? toLocalIso(new Date(m.createdAt)) : undefined,
          updated: m.updatedAt ? toLocalIso(new Date(m.updatedAt)) : undefined,
          pinned: m.pinned === true,
        });
      }
      fs.renameSync(legacy, path.join(app.getPath('userData'), 'memos.v0.1.0-migrated.json'));
    } catch (err) {
      console.error('v0.1.0 메모 옮기기 실패', err);
      return;
    }
  }
  settings.migratedV1 = true;
  saveSettings();
}

// ---------- 창 ----------

const webPreferences = { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true };
const windowIcon = { icon: APP_ICON };

function guardWindow(win) {
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) openWebPage(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

function onScreen(bounds) {
  if (!bounds) return false;
  const area = screen.getDisplayMatching(bounds).workArea;
  return bounds.x < area.x + area.width - 40 && bounds.x + bounds.width > area.x + 40 &&
    bounds.y >= area.y - 10 && bounds.y < area.y + area.height - 40;
}

// 창 버튼(최소화·최대화·닫기) 줄은 Windows 가 화면 위에 그려 대화 상자로 덮을 수 없다.
// 대화 상자·튜토리얼 동안에는 이 줄의 바탕을 뒤 막(검정 40%·45%)을 얹은 색으로 맞춘다.
let titleBarDim = false; // false | 'dialog' | 'coach'
const TITLEBAR_DIM = { light: { dialog: '#949391', coach: '#878785' }, dark: { dialog: '#080808', coach: '#080808' } };
function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  const base = dark ? '#0e0e0d' : '#f6f5f1';
  return { color: titleBarDim ? TITLEBAR_DIM[dark ? 'dark' : 'light'][titleBarDim] : base, symbolColor: dark ? '#f5f4ef' : '#111111', height: 44 };
}

// tab: 'memos' | 'reminders' | 'history' — 트레이 메뉴 등에서 바로 그 탭으로 연다
function createListWindow(tab) {
  if (listWin) {
    if (listWin.isMinimized()) listWin.restore();
    listWin.show();
    listWin.focus();
    if (tab) listWin.webContents.send('list:tab', tab);
    return listWin;
  }
  const bounds = onScreen(settings.listBounds) ? settings.listBounds : { width: 400, height: 680 };
  listWin = new BrowserWindow({
    ...bounds,
    minWidth: 300,
    minHeight: 380,
    title: '메모킹',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e0d' : '#f6f5f1',
    ...windowIcon,
    webPreferences,
  });
  guardWindow(listWin);
  if (settings.listOnTop) {
    listWin.setAlwaysOnTop(true, 'floating');
    setSticker(listWin, true, { animate: false });
  }
  const remember = () => {
    settings.listBounds = listWin.getNormalBounds();
    saveSettings();
  };
  listWin.on('moved', remember);
  listWin.on('resized', remember);
  listWin.once('ready-to-show', () => listWin.show());
  listWin.on('closed', () => {
    listWin = null;
    titleBarDim = false; // 대화 상자를 연 채로 닫았어도 다음 목록 창은 원래 색으로
    // 미리보기 창은 목록 창과 함께 사라져야 "모든 창을 닫으면 종료"가 동작한다.
    drag = null;
    ghostWin?.destroy();
    ghostWin = null;
  });
  listWin.loadFile(path.join(APP_DIR, 'index.html'), tab ? { query: { tab } } : undefined);
  return listWin;
}

function defaultNoteBounds() {
  const { width, height } = DEFAULT_NOTE_SIZE;
  const n = noteWins.size;
  const anchor = listWin?.getBounds() ?? screen.getPrimaryDisplay().workArea;
  const area = screen.getDisplayMatching(anchor).workArea;
  let x = anchor.x + anchor.width + 16 + n * 28;
  let y = anchor.y + n * 28;
  if (x + width > area.x + area.width) x = Math.max(area.x, anchor.x - width - 16 - n * 28);
  if (y + height > area.y + area.height) y = area.y + 40;
  return { x: Math.round(x), y: Math.round(y), width, height };
}

// inactive: 하던 작업의 키보드 포커스를 뺏지 않고 연다 (빠른 메모)
// 스택에 든 메모면 그 스택 창에서 이 메모의 탭을 보여 준다.
function openNote(id, { inactive = false } = {}) {
  if (stacks?.stackOf(id)) return showTab(id, { inactive });
  const existing = noteWins.get(id);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    if (inactive) existing.showInactive();
    else {
      existing.show();
      existing.focus();
    }
    return existing;
  }
  return createNoteWindow(id, { inactive });
}

// show: false 면 숨긴 채로 만들어 둔다 (스택의 다른 탭 — 누르면 바로 보이도록)
function createNoteWindow(id, { inactive = false, show = true, bounds = null } = {}) {
  const memo = vault?.get(id);
  if (!memo) return null;

  const saved = settings.noteBounds[id];
  const win = new BrowserWindow({
    ...(bounds ?? (onScreen(saved) ? saved : defaultNoteBounds())),
    minWidth: 240,
    minHeight: 200,
    frame: false,
    show: false,
    title: memo.title,
    alwaysOnTop: settings.onTop[id] === true,
    backgroundColor: noteBg(memo.color),
    ...windowIcon,
    webPreferences,
  });
  guardWindow(win);
  if (settings.onTop[id] === true) {
    win.setAlwaysOnTop(true, 'floating'); // 토글과 같은 수준으로
    setSticker(win, true, { animate: false });
  }
  noteWins.set(id, win);

  // 앱을 끌 때 보이던 메모는 다음 실행 때 다시 연다 (스택의 숨은 탭은 보이는 탭을 따라 열림)
  const setOpen = (open) => {
    if (quitting) return;
    settings.openNotes = settings.openNotes.filter((x) => x !== id);
    if (open) settings.openNotes.push(id);
    saveSettings();
  };
  win.on('show', () => {
    setOpen(true);
    pushList();
  });
  win.on('hide', () => {
    setOpen(false);
    pushList();
  });

  const remember = () => syncStackBounds(id, win.getNormalBounds());
  // 창을 손으로 끌어 다른 메모 위에 잠깐 머물렀다 놓으면 탭으로 합친다
  win.on('will-move', () => trackWindowDrag(id));
  win.on('moved', () => {
    remember();
    endWindowDrag(id);
  });
  win.on('resized', remember);
  if (show) win.once('ready-to-show', () => (inactive ? win.showInactive() : win.show()));
  pushList();
  // 스택 창을 닫으면(Alt+F4 등) 숨은 탭들도 함께 닫는다
  win.on('close', () => {
    if (quitting) return;
    const stack = stacks?.stackOf(id);
    if (!stack || closingStacks.has(stack.id)) return;
    closingStacks.add(stack.id);
    for (const m of stack.memos) if (m !== id) noteWins.get(m)?.close();
    setTimeout(() => closingStacks.delete(stack.id), 1000);
  });
  win.on('closed', () => {
    noteWins.delete(id);
    if (id === tutorial.memoId) tutorialEvent('note-closed');
    vault?.finalize(id);
    // 비워 두어 지워진 메모(+ 로 만들고 안 쓴 탭 등)는 스택에서도 뺀다
    if (!vault?.get(id) && stacks?.stackOf(id)) {
      const r = stacks.remove(id);
      pushStackTo(r.rest ?? []);
    }
    pushList();
    if (!quitting) {
      settings.openNotes = settings.openNotes.filter((x) => x !== id);
      if (!vault?.get(id)) delete settings.noteBounds[id];
      saveSettings();
    }
  });
  win.loadFile(path.join(APP_DIR, 'note.html'), { query: { id } });
  return win;
}

// ---------- 메모 스택 (탭) ----------
// 스택의 메모마다 창을 하나씩 두고, 같은 자리·크기로 겹쳐 보이는 탭 하나만 보여 준다.
// 탭을 바꾸면 창만 바꿔 보여 주므로 즉시 바뀌고, 메모마다 실행 취소 기록도 그대로 남는다.

let stacks = null; // StackStore (메모 폴더마다, _memoking/stacks.json)
const closingStacks = new Set();
const STACK_DWELL_MS = 100; // 다른 메모 위에 이만큼 머물러야 합쳐진다 (스쳐 지나가며 실수로 합쳐지지 않게)

function loadStacks() {
  const file = path.join(vault.appDir, 'stacks.json');
  stacks = new StackStore({
    read: () => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    write: (text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    },
  }).load((id) => Boolean(vault?.get(id)));
}

// 탭 줄에 보여 줄 모양 (스택이 아니면 members 가 비어 탭 줄이 숨는다)
function stackState(id) {
  const stack = stacks?.stackOf(id);
  if (!stack) return { members: [], active: id };
  return {
    active: stack.active,
    members: stack.memos.map((m) => {
      const memo = vault?.get(m);
      return { id: m, title: memo?.title ?? '제목 없음', color: memo?.color ?? 'yellow' };
    }),
  };
}

function pushStackTo(ids) {
  for (const m of ids) noteWins.get(m)?.webContents.send('stack:state', stackState(m));
}

function pushAllStacks() {
  for (const s of stacks?.all() ?? []) pushStackTo(s.memos);
}

// 스택에서 지금 보이는 창 (없으면 null)
function visibleStackWin(stack, exceptId = null) {
  for (const m of stack?.memos ?? []) {
    const w = noteWins.get(m);
    if (m !== exceptId && w && !w.isDestroyed() && w.isVisible()) return w;
  }
  return null;
}

const stackOnTop = (stack) => stack.memos.some((m) => settings.onTop[m] === true);

// 창 자리·크기를 스택의 모든 탭에 맞춘다
function syncStackBounds(id, bounds) {
  const stack = stacks?.stackOf(id);
  for (const m of stack ? stack.memos : [id]) {
    settings.noteBounds[m] = bounds;
    const w = noteWins.get(m);
    if (m !== id && w && !w.isDestroyed() && !w.isVisible()) w.setBounds(bounds);
  }
  saveSettings();
}

// 스택에서 id 의 탭을 보여 준다
// bounds: 보여 줄 자리를 정해 줄 때 (보이던 탭이 스택에서 빠져 나가면 그 창의 자리를 이어받는다)
function showTab(id, { inactive = false, bounds: at = null } = {}) {
  const stack = stacks.setActive(id);
  const current = visibleStackWin(stack, id);
  const bounds = at ?? current?.getNormalBounds() ?? (onScreen(settings.noteBounds[id]) ? settings.noteBounds[id] : defaultNoteBounds());
  const top = stackOnTop(stack);
  let win = noteWins.get(id);
  const reveal = () => {
    if (win.isDestroyed()) return;
    // 창이 준비되는 사이 다른 탭으로 바뀌었으면(+ 를 빠르게 여러 번 등) 보이지 않는다
    const now = stacks.stackOf(id);
    if (now && now.active !== id) return;
    if (win.isMinimized()) win.restore();
    // 지금 보이는 탭의 자리 (준비되는 사이 창을 옮겼을 수 있음)
    const shown = now ? visibleStackWin(now, id) : null;
    win.setBounds(shown?.getNormalBounds() ?? bounds);
    setTopmost(win, top);
    setSticker(win, top, { animate: false });
    if (inactive) win.showInactive();
    else {
      win.show();
      win.focus();
    }
    // 새 탭이 나타난 다음에 다른 탭은 모두 숨겨 깜빡이지 않게 (보이는 탭은 언제나 하나)
    setTimeout(() => {
      const st = stacks.stackOf(id);
      if (!st || st.active !== id) return;
      for (const m of st.memos) {
        const w = noteWins.get(m);
        if (m !== id && w && !w.isDestroyed() && w.isVisible()) w.hide();
      }
    }, 30);
  };
  if (!win) {
    win = createNoteWindow(id, { show: false, bounds });
    if (!win) return null;
    win.once('ready-to-show', reveal);
  } else reveal();
  pushStackTo(stack.memos);
  pushList();
  return win;
}

/**
 * movingId 의 메모(와 그 스택)를 targetId 가 보이는 창의 탭으로 합친다. 놓은 메모가 보이는 탭.
 */
function stackInto(targetId, movingId) {
  const targetWin = noteWins.get(targetId);
  if (!targetWin || targetId === movingId || !vault?.get(movingId)) return false;
  const bounds = targetWin.getNormalBounds();
  const top = stackOnTop(stacks.stackOf(targetId) ?? { memos: [targetId] }) || settings.onTop[targetId] === true;
  const stack = stacks.merge(targetId, [movingId], { activate: movingId });
  for (const m of stack.memos) {
    settings.noteBounds[m] = bounds;
    if (top) settings.onTop[m] = true;
    const w = noteWins.get(m);
    if (w && m !== movingId && m !== targetId && w.isVisible()) w.hide(); // 옮겨 온 스택의 다른 탭
  }
  saveSettings();
  let win = noteWins.get(movingId);
  const hideTarget = () => setTimeout(() => !targetWin.isDestroyed() && targetWin.hide(), 30);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.setAlwaysOnTop(top, 'floating');
    setSticker(win, top, { animate: false });
    if (win.isVisible()) animateBounds(win, bounds);
    else win.setBounds(bounds);
    win.show();
    win.focus();
    setTimeout(hideTarget, 200);
  } else {
    win = createNoteWindow(movingId, { show: false, bounds });
    win?.once('ready-to-show', () => {
      win.setAlwaysOnTop(top, 'floating');
      setSticker(win, top, { animate: false });
      win.show();
      win.focus();
      hideTarget();
    });
  }
  pushStackTo(stack.memos);
  pushList();
  return true;
}

/**
 * 스택에서 뺀다. mode: 'close' 그 탭을 닫음 · 'detach' 옆에 자기 창으로 · 'none' 창은 건드리지 않음(지울 때)
 */
function removeFromStack(id, mode = 'close') {
  const stack = stacks?.stackOf(id);
  if (!stack) return false;
  const win = noteWins.get(id);
  const wasVisible = Boolean(win?.isVisible());
  const bounds = (wasVisible ? win.getNormalBounds() : visibleStackWin(stack)?.getNormalBounds()) ?? settings.noteBounds[id];
  const r = stacks.remove(id);
  const quiet = mode === 'tear';
  if (wasVisible && r.nextActive) {
    // 남은 탭 중 하나를 같은 자리에 보여 준다 (끌어내기 중에는 포커스를 뺏지 않게)
    if (r.stack) showTab(r.nextActive, { inactive: quiet, bounds });
    else {
      const rest = noteWins.get(r.nextActive) ?? createNoteWindow(r.nextActive, { show: false, bounds });
      rest?.setBounds(bounds);
      const reveal = () => (quiet ? rest.showInactive() : rest.show());
      if (rest?.webContents.isLoading()) rest.once('ready-to-show', reveal);
      else if (rest) reveal();
    }
  }
  pushStackTo([...(r.rest ?? []), id]);
  if (mode === 'close') win?.close();
  else if (mode === 'detach') {
    const b = { ...bounds, x: bounds.x + 28, y: bounds.y + 28 };
    settings.noteBounds[id] = b;
    saveSettings();
    if (win) {
      win.setBounds(b);
      win.show();
      win.focus();
    } else createNoteWindow(id, { bounds: b });
  }
  pushList();
  return true;
}

// 커서 아래에 있는, 합칠 수 있는 다른 메모 창 (자기 스택 제외)
function stackTargetAt(point, excludeId) {
  const own = stacks?.stackOf(excludeId)?.memos ?? [excludeId];
  for (const [mid, w] of noteWins) {
    if (own.includes(mid) || w.isDestroyed() || !w.isVisible() || w.isMinimized()) continue;
    if (isInside(point, w.getBounds())) return mid;
  }
  return null;
}

function setStackHover(id, on) {
  if (id) noteWins.get(id)?.webContents.send('stack:hover', on);
}

// 끄는 동안 합칠 곳 찾기 — 같은 곳에 STACK_DWELL_MS 머물면 "놓으면 탭으로 합쳐요" (armed)
function trackStackTarget(state, point, excludeId, onChange) {
  const target = stackTargetAt(point, excludeId);
  if (target === state.target) return;
  clearTimeout(state.timer);
  setStackHover(state.target, false);
  const wasArmed = state.armed;
  state.target = target;
  state.armed = false;
  if (wasArmed) onChange?.(false);
  if (!target) return;
  state.timer = setTimeout(() => {
    if (state.target !== target) return;
    state.armed = true;
    setStackHover(target, true);
    onChange?.(true);
  }, STACK_DWELL_MS);
}

function clearStackTarget(state) {
  clearTimeout(state?.timer);
  setStackHover(state?.target, false);
}

let windowDrag = null; // { id, target, armed, timer }

function trackWindowDrag(id, point = screen.getCursorScreenPoint()) {
  if (windowDrag?.id !== id) {
    clearStackTarget(windowDrag);
    windowDrag = { id, target: null, armed: false, timer: null };
  }
  trackStackTarget(windowDrag, point, id);
}

function endWindowDrag(id) {
  const d = windowDrag;
  if (!d || d.id !== id) return;
  windowDrag = null;
  clearStackTarget(d);
  if (d.armed && d.target) stackInto(d.target, id);
}

// ---------- 탭 끌어내기 ----------
// 탭을 탭 줄 밖으로 끌면 그 탭을 스택에서 빼 제 창으로 만들고, 놓을 때까지 커서를 따라가게 한다 (반투명).
// 다른 메모 창 위에 잠깐 머물면 창 끌어 합치기와 같이 탭으로 합친다. 포인터는 끌기를 시작한 창이 계속 잡고 좌표를 보내 준다.
const TEAR_OPACITY = 0.9;
const TEAR_ARMED_OPACITY = 0.55;
let tabTear = null; // { id, offset, win, target, armed, timer }

function tearStart(id, offset, point) {
  const stack = stacks?.stackOf(id);
  if (!stack || tabTear) return false;
  const size = (visibleStackWin(stack) ?? noteWins.get(id))?.getNormalBounds() ?? settings.noteBounds[id] ?? DEFAULT_NOTE_SIZE;
  const off = { x: Math.max(12, Math.min(size.width - 40, Math.round(offset?.x ?? 60))), y: Math.round(offset?.y ?? 17) };
  const bounds = { x: Math.round(point.x - off.x), y: Math.round(point.y - off.y), width: size.width, height: size.height };
  removeFromStack(id, 'tear');
  let win = noteWins.get(id);
  if (win) win.setBounds(bounds);
  else win = createNoteWindow(id, { show: false, bounds });
  if (!win) return false;
  win.setOpacity(TEAR_OPACITY);
  const reveal = () => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    win.moveTop();
  };
  if (win.webContents.isLoading()) win.once('ready-to-show', reveal);
  else reveal();
  tabTear = { id, offset: off, win, target: null, armed: false, timer: null };
  return true;
}

function tearMove(point) {
  const t = tabTear;
  if (!t || t.win.isDestroyed()) return;
  t.win.setPosition(Math.round(point.x - t.offset.x), Math.round(point.y - t.offset.y));
  trackStackTarget(t, point, t.id, (armed) => {
    if (!t.win.isDestroyed()) t.win.setOpacity(armed ? TEAR_ARMED_OPACITY : TEAR_OPACITY);
  });
}

function tearEnd(point) {
  const t = tabTear;
  if (!t) return false;
  if (point) tearMove(point);
  tabTear = null;
  clearStackTarget(t);
  if (t.win.isDestroyed()) return false;
  t.win.setOpacity(1);
  if (t.armed && t.target) return stackInto(t.target, t.id);
  settings.noteBounds[t.id] = t.win.getNormalBounds();
  saveSettings();
  t.win.focus();
  pushList();
  return true;
}

// ---------- 늘 위에 두기 = 왕관 스티커 (v0.16.3) ----------
// 창 안의 화면은 창 밖에 그릴 수 없으므로, 늘 위에 둔 창마다 그 창에 딸린 작은 투명 창을 띄워
// 위 가장자리 가운데에 반쯤 걸쳐 둔다. 마우스는 통과, 포커스는 가져가지 않음, 창을 따라 움직이고 숨는다.
// 늘 위에 두기 켜고 끄기. Windows 에서 딸린 창(스티커)이 닫힌 직후 켜기가 적용되지 않는 일이 있어 확인하고 한 번 더.
function setTopmost(win, on) {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(on, 'floating');
  if (on && !win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, 'floating');
  }
}

const STICKER = { width: 64, height: 52 };
const stickers = new Map(); // 주인 창 id → { owner, win|null, off }
// Windows 에서 투명 창을 숨겼다 다시 보이면 바탕이 불투명하게 그려지는 일이 있어(스티커 뒤 네모 바탕),
// 스티커 창은 숨기지 않는다: 주인 창이 숨거나 내려가면 닫고, 다시 보이면 새로 만들어 첫 그림이 그려진 뒤에 보인다.

function stickerBounds(owner) {
  const b = owner.getBounds();
  return { x: Math.round(b.x + b.width / 2 - STICKER.width / 2), y: Math.round(b.y - STICKER.height / 2), ...STICKER };
}

function closeStickerWin(entry, { peel = false } = {}) {
  const win = entry.win;
  entry.win = null;
  if (!win || win.isDestroyed()) return;
  const owner = entry.owner;
  const destroy = () => {
    if (win.isDestroyed()) return;
    win.destroy();
    // 아직 붙여 둔 상태면 늘 위를 다시 확인
    if (!owner.isDestroyed() && stickers.get(owner.id)) setTopmost(owner, true);
  };
  if (peel && win.isVisible()) {
    win.webContents.send('sticker:peel');
    setTimeout(destroy, 220);
  } else destroy();
}

function openStickerWin(entry, animate) {
  const { owner } = entry;
  if (entry.win || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()) return;
  const win = new BrowserWindow({
    ...stickerBounds(owner),
    parent: owner, // 주인 창보다 늘 위
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences,
  });
  entry.win = win;
  win.setIgnoreMouseEvents(true, { forward: true }); // 왕관 위에 올라오면 sticker:hover 로 마우스를 받는다
  guardWindow(win);
  // 첫 그림이 그려진 뒤에 보인다 (빈 창이 잠깐 보이지 않게)
  win.once('ready-to-show', () => {
    if (win.isDestroyed() || entry.win !== win || owner.isDestroyed()) return;
    win.setBounds(stickerBounds(owner));
    win.showInactive();
    win.webContents.send('sticker:show', { animate });
  });
  win.loadFile(path.join(APP_DIR, 'sticker.html'));
}

function setSticker(owner, on, { animate = true } = {}) {
  if (!owner || owner.isDestroyed()) return;
  const cur = stickers.get(owner.id);
  if (!on) {
    if (!cur) return;
    stickers.delete(owner.id);
    cur.off();
    closeStickerWin(cur, { peel: animate });
    return;
  }
  if (cur) {
    openStickerWin(cur, false); // 이미 붙어 있음 (창이 지금 보이면 스티커도)
    return;
  }
  const entry = { owner, win: null, off: () => {} };
  const sync = () => {
    if (entry.win && !entry.win.isDestroyed() && !owner.isDestroyed()) entry.win.setBounds(stickerBounds(owner));
  };
  const visible = () => {
    if (owner.isDestroyed()) return;
    if (owner.isVisible() && !owner.isMinimized()) openStickerWin(entry, false);
    else closeStickerWin(entry);
  };
  const events = { move: sync, resize: sync, show: visible, hide: visible, minimize: visible, restore: visible };
  for (const [name, fn] of Object.entries(events)) owner.on(name, fn);
  entry.off = () => {
    if (!owner.isDestroyed()) for (const [name, fn] of Object.entries(events)) owner.off(name, fn);
  };
  stickers.set(owner.id, entry);
  owner.once('closed', () => {
    entry.off();
    closeStickerWin(entry);
    if (stickers.get(owner.id) === entry) stickers.delete(owner.id);
  });
  openStickerWin(entry, animate);
}

// 목록 창 늘 위에 두기 (버튼 = 왕관 스티커를 붙임, 스티커 누르기 = 뗌)
function setListOnTop(on) {
  if (!listWin) return false;
  settings.listOnTop = Boolean(on);
  setTopmost(listWin, settings.listOnTop);
  setSticker(listWin, settings.listOnTop);
  saveSettings();
  listWin.webContents.send('list:on-top', settings.listOnTop);
  return settings.listOnTop;
}

// 메모 창 늘 위에 두기 ('floating': 일반 창들 위. 스택이면 탭 모두, 숨은 탭도 버튼 상태를 맞춘다)
function setNoteOnTop(id, next, { fromId = id } = {}) {
  const members = stacks?.stackOf(id)?.memos ?? [id];
  for (const m of members) {
    setTopmost(noteWins.get(m), next);
    setSticker(noteWins.get(m), next, { animate: m === fromId });
    noteWins.get(m)?.webContents.send('memo:on-top', next);
    if (next) settings.onTop[m] = true;
    else delete settings.onTop[m];
  }
  saveSettings();
  return next;
}

// 스티커를 누르면: 그 스티커가 붙은 창의 늘 위에 두기를 끈다 (스티커는 떼어지며 사라짐)
function peelSticker(sender) {
  for (const [, s] of stickers) {
    if (!s.win || s.win.isDestroyed() || s.win.webContents !== sender || s.owner.isDestroyed()) continue;
    if (s.owner === listWin) return setListOnTop(false) === false;
    const id = [...noteWins].find(([, w]) => w === s.owner)?.[0];
    if (id) return setNoteOnTop(id, false) === false;
  }
  return false;
}

// ---------- 메모를 PDF 로 ----------
// 만들기 창(pdf.html)에서 크기·여백을 고르면, 보이지 않는 창에 print.html 로 그린 뒤 Chromium 의 printToPDF 로 만든다.
let pdfWin = null;
const smokePdf = []; // 자동 점검: 저장 창 대신 여기 경로로 저장

function openPdfWindow(id, parent = BrowserWindow.getFocusedWindow()) {
  if (!vault?.get(id)) return false;
  pdfWin?.destroy();
  const area = screen.getDisplayMatching(parent?.getBounds() ?? screen.getPrimaryDisplay().workArea).workArea;
  const width = Math.min(820, area.width - 40);
  const height = Math.min(600, area.height - 40);
  pdfWin = new BrowserWindow({
    width, height, minWidth: 640, minHeight: 480,
    x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    title: 'PDF로 저장',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e0d' : '#f6f5f1',
    ...windowIcon,
    webPreferences: { ...webPreferences, nodeIntegrationInSubFrames: true }, // 미리보기 iframe(print.html)도 window.memoking 을 쓴다
  });
  guardWindow(pdfWin);
  pdfWin.setMenu(null);
  const w = pdfWin;
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => {
    if (pdfWin === w) pdfWin = null;
  });
  w.loadFile(path.join(APP_DIR, 'pdf.html'), { query: { id } });
  return true;
}

async function savePdf(id, o, parent) {
  const memo = vault?.get(id);
  if (!memo) return null;
  let file = SMOKE ? smokePdf.shift() : null;
  if (!file) {
    const r = await dialog.showSaveDialog(parent ?? undefined, {
      title: 'PDF로 저장',
      defaultPath: path.join(app.getPath('documents'), pdfFileName(memo.title)),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { cancelled: true };
    file = r.filePath;
  }
  const width = Number(o.width) || 210;
  const height = Number(o.height) || 297;
  const margin = Math.max(0, Number(o.margin) || 0);
  const win = new BrowserWindow({ show: false, width: Math.round(mmToPx(width)), height: Math.round(mmToPx(height)), webPreferences });
  try {
    await win.loadFile(path.join(APP_DIR, 'print.html'), { query: { id, w: String(width), h: String(height), m: String(margin), bg: o.bg ? '1' : '0', date: o.date ? '1' : '0' } });
    const end = Date.now() + 15000;
    while (Date.now() < end && !(await win.webContents.executeJavaScript('document.documentElement.dataset.ready === "true"').catch(() => false))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // 쪽 크기·여백은 print.html 의 @page 를 따른다 (메모 색 바탕은 여백까지)
    const pdf = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { marginType: 'none' } });
    fs.writeFileSync(file, pdf);
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
    if (o.open && !SMOKE) shell.openPath(file);
    return { file, pages };
  } catch (err) {
    console.error('PDF 만들기 실패', err);
    return null;
  } finally {
    win.destroy();
  }
}

// ---------- 목록에서 끌어다 놓기 ----------
// 카드를 목록 창 밖으로 끌면 실제 크기의 반투명 미리보기 창이 커서를 따라다니고,
// 놓으면 그 자리에 메모 창이 열린다 (이미 열려 있으면 그 자리로 이동).

const GHOST_MARGIN = 24; // 미리보기 그림자가 들어갈 투명 여백
let ghostWin = null;
let ghostLoaded = null;
let drag = null; // { id, outside, bounds }

function ensureGhost() {
  if (ghostWin && !ghostWin.isDestroyed()) return;
  ghostWin = new BrowserWindow({
    width: DEFAULT_NOTE_SIZE.width + GHOST_MARGIN * 2,
    height: DEFAULT_NOTE_SIZE.height + GHOST_MARGIN * 2,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences,
  });
  ghostWin.setIgnoreMouseEvents(true);
  ghostWin.setAlwaysOnTop(true, 'screen-saver');
  ghostLoaded = new Promise((resolve) => ghostWin.webContents.once('did-finish-load', resolve));
  ghostWin.loadFile(path.join(APP_DIR, 'ghost.html'));
}

function hideGhost() {
  if (ghostWin && !ghostWin.isDestroyed()) ghostWin.hide();
}

const noteSize = (id) => {
  const saved = settings.noteBounds[id];
  return saved ? { width: saved.width, height: saved.height } : DEFAULT_NOTE_SIZE;
};

function boundsAt(id, point) {
  return dropBounds(point, noteSize(id), screen.getDisplayNearestPoint(point).workArea);
}

async function dragStart(id) {
  const memo = vault?.get(id);
  if (!memo || !listWin) return false;
  ensureGhost();
  clearStackTarget(drag?.stack);
  drag = { id, outside: false, bounds: null, ready: false, stack: { target: null, armed: false, timer: null } };
  await ghostLoaded;
  if (drag?.id !== id) return false;
  ghostWin.webContents.send('ghost:data', {
    color: memo.color,
    title: memo.title,
    preview: extractPreview(memo.body, 400),
    open: noteWins.has(id),
  });
  // 첫 끌기에서는 미리보기 창이 준비되기 전에 이미 목록 밖으로 나갔을 수 있다.
  if (drag.outside) ghostWin.webContents.send('ghost:visible', true);
  drag.ready = true;
  return true;
}

function dragMove(point) {
  if (!drag || !listWin || !ghostWin || ghostWin.isDestroyed()) return;
  const outside = !isInside(point, listWin.getBounds());
  if (outside) {
    drag.bounds = boundsAt(drag.id, point);
    const { x, y, width, height } = drag.bounds;
    ghostWin.setBounds({ x: x - GHOST_MARGIN, y: y - GHOST_MARGIN, width: width + GHOST_MARGIN * 2, height: height + GHOST_MARGIN * 2 });
    if (!drag.outside) {
      ghostWin.showInactive();
      if (drag.ready) ghostWin.webContents.send('ghost:visible', true);
    }
  } else if (drag.outside) {
    ghostWin.webContents.send('ghost:visible', false);
    hideGhost();
  }
  if (outside !== drag.outside) listWin.webContents.send('drag:state', { outside });
  drag.outside = outside;
  // 떠 있는 다른 메모 위에 머물면 "놓으면 탭으로 합쳐요"
  const current = drag;
  if (outside) {
    trackStackTarget(current.stack, point, current.id, (armed) => {
      if (drag === current) ghostWin?.webContents.send('ghost:mode', { stack: armed });
    });
  } else if (current.stack.target) {
    clearStackTarget(current.stack);
    current.stack = { target: null, armed: false, timer: null };
    ghostWin?.webContents.send('ghost:mode', { stack: false });
  }
}

// point 가 없으면 취소
function dragEnd(point) {
  const current = drag;
  drag = null;
  if (!current) return { opened: false };
  clearStackTarget(current.stack);
  ghostWin?.webContents.send('ghost:mode', { stack: false });
  if (!point || !listWin || isInside(point, listWin.getBounds())) {
    hideGhost();
    return { opened: false };
  }
  if (current.stack.armed && current.stack.target) {
    hideGhost();
    stackInto(current.stack.target, current.id);
    return { opened: true, stacked: true };
  }
  const bounds = boundsAt(current.id, point);
  ghostWin?.webContents.send('ghost:drop');
  placeNote(current.id, bounds);
  return { opened: true, bounds };
}

function placeNote(id, bounds) {
  // 스택의 메모면 그 탭을 보여 주며 스택 창을 통째로 옮긴다
  if (stacks?.stackOf(id)) {
    hideGhost();
    const win = openNote(id);
    const move = () => {
      animateBounds(win, bounds);
      syncStackBounds(id, bounds);
    };
    if (win?.isVisible()) move();
    else win?.once('show', move);
    return;
  }
  settings.noteBounds[id] = bounds;
  saveSettings();
  const existing = noteWins.get(id);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    hideGhost();
    animateBounds(existing, bounds);
    existing.show();
    existing.focus();
    return;
  }
  const win = openNote(id);
  if (!win) return hideGhost();
  // 진짜 창이 나타나는 순간 미리보기를 치운다 (깜빡임 없이 바뀌도록)
  const fallback = setTimeout(hideGhost, 1500);
  win.once('show', () => {
    clearTimeout(fallback);
    setTimeout(hideGhost, 60);
  });
}

// 이미 열린 창은 180ms 동안 부드럽게 이동
function animateBounds(win, to, duration = 180) {
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

function createNote(options) {
  if (!vault) return null;
  const id = vault.create(options);
  openNote(id);
  // 튜토리얼 "첫 메모 만들기" 단계
  if (tutorial.active && TUTORIAL_STEPS[tutorial.index]?.advance === 'memo-created') {
    tutorial.memoId = id;
    tutorialEvent('memo-created');
  }
  return id;
}

// ---------- 처음 실행 튜토리얼 ----------
// 단계는 core/tutorial.js. 말풍선은 단계의 창(목록 창 또는 튜토리얼 중 만든 메모 창)에만 띄운다.

let tutorial = { active: false, index: -1, memoId: null };

function tutorialPayload() {
  const step = tutorial.active ? TUTORIAL_STEPS[tutorial.index] : null;
  return step ? { ...step, index: tutorial.index, total: TUTORIAL_STEPS.length } : null;
}

function tutorialWin(step) {
  if (!step) return null;
  return step.win === 'note' ? noteWins.get(tutorial.memoId) ?? null : listWin;
}

function sendTutorial() {
  const payload = tutorialPayload();
  const target = tutorialWin(payload);
  for (const w of [listWin, ...noteWins.values()]) {
    if (w && !w.isDestroyed()) w.webContents.send('tutorial:step', w === target ? payload : null);
  }
}

function startTutorial() {
  if (!vault) return false;
  tutorial = { active: true, index: 0, memoId: null };
  const w = createListWindow('memos');
  w.show();
  w.focus();
  sendTutorial(); // 목록 창이 아직 불러오는 중이면 창이 tutorial:current 로 받아 간다
  return true;
}

function finishTutorial() {
  tutorial = { active: false, index: -1, memoId: null };
  settings.tutorialDone = true;
  settings.tutorialInstall = installMark();
  saveSettings();
  sendTutorial();
}

function tutorialEvent(event) {
  if (!tutorial.active) return;
  const next = advanceTutorial(tutorial.index, event);
  if (next === tutorial.index) return;
  if (next < 0) return finishTutorial();
  tutorial.index = next;
  const step = TUTORIAL_STEPS[next];
  // 메모 단계인데 메모 창이 없으면(먼저 닫음) 목록 단계로
  if (step.win === 'note' && !noteWins.get(tutorial.memoId)) return tutorialEvent('note-closed');
  const w = step.win === 'list' ? createListWindow('memos') : noteWins.get(tutorial.memoId);
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
  sendTutorial();
}

// ---------- 예약 알림 ----------

const pendingAlarms = new Map(); // 알림으로 새로 여는 메모 창에 보여줄 알림 띠
// 알림 객체를 놓으면 알림 센터에서 나중에 눌렀을 때 반응이 없으므로, 누르기 전까지 잡아 둔다 (최근 50개)
// ---------- 링크·파일 열기 ----------
// 자동 점검 때는 실제로 브라우저·프로그램을 띄우지 않고 기록만 한다 (사용자 PC 에 창이 뜨지 않게).
const smokeOpened = [];
const smokeConfirmAnswers = []; // 점검이 미리 정해 둔 확인 창 답 (true = 실행하기)

function openWebPage(url) {
  let target;
  try {
    target = new URL(String(url));
  } catch {
    return false;
  }
  if (!/^https?:$/.test(target.protocol)) return false;
  if (SMOKE) smokeOpened.push({ kind: 'web', target: target.href });
  else shell.openExternal(target.href);
  return true;
}

// 메모 폴더의 파일을 기본 앱으로 연다. 프로그램 파일은 한 번 묻는다 (메모 폴더는 다른 PC 와 동기화되므로).
async function openVaultFile(file, win) {
  const name = path.basename(file);
  if (isProgramFile(name)) {
    const ok = SMOKE
      ? (smokeOpened.push({ kind: 'confirm', target: file }), smokeConfirmAnswers.shift() ?? false)
      : (await dialog.showMessageBox(win ?? undefined, {
        type: 'warning',
        title: '메모킹',
        message: `"${name}"은(는) 프로그램 파일이에요. 실행할까요?`,
        detail: '다른 기기와 함께 쓰는 폴더예요. 직접 넣은 파일이 맞는지 확인해 주세요.',
        buttons: ['실행', '취소'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })).response === 0;
    if (!ok) return 'cancelled';
  }
  if (SMOKE) {
    smokeOpened.push({ kind: 'file', target: file });
    return '';
  }
  return shell.openPath(file); // 실패하면 이유 문자열
}

let linkPreviews = null;
function getLinkPreviews() {
  linkPreviews ??= new LinkPreviews({
    fetch: (url, options) => net.fetch(url, options),
    userAgent: app.userAgentFallback.replace(/\s*(Electron|MemoKing)\/\S+/g, ''),
  });
  return linkPreviews;
}

const liveToasts = new Set();
const MAX_LIVE_TOASTS = 50;
const smokeToasts = []; // 자동 점검 때는 실제 Windows 알림 대신 여기에 기록

/**
 * Windows 알림(토스트)
 * @param {{ title: string, body: string, memoId?: string, onClick?: () => void }} t
 */
function toast(t) {
  if (SMOKE) {
    smokeToasts.push(t);
    return;
  }
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: t.title, body: t.body, icon: APP_ICON_PNG });
  n.on('click', () => {
    liveToasts.delete(n);
    t.onClick?.();
  });
  liveToasts.add(n);
  while (liveToasts.size > MAX_LIVE_TOASTS) liveToasts.delete(liveToasts.values().next().value);
  n.show();
}

// 메모를 화면 맨 앞으로 가져와 포커스하고, 창 테두리를 한 번 반짝여 "이 메모" 임을 보여 준다
function revealNote(id) {
  const win = (stacks?.stackOf(id) ? openNote(id) : noteWins.get(id)) ?? openNote(id);
  if (!win) return null;
  const bring = () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.moveTop();
    win.focus();
    win.webContents.send('memo:highlight');
  };
  if (win.webContents.isLoading()) win.once('ready-to-show', bring);
  else bring();
  return win;
}

// 포커스는 뺏지 않고 잠깐 맨 위에 띄워 "여기 생겼다" 를 보여 준 뒤 원래대로 (사용자가 켠 항상 위는 유지)
function peekOnTop(win, id, ms = 2500) {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'floating');
  win.webContents.send('memo:highlight');
  setTimeout(() => {
    if (!win.isDestroyed() && settings.onTop[id] !== true) win.setAlwaysOnTop(false);
  }, ms);
}

function pushReminders() {
  listWin?.webContents.send('reminders:changed');
  updateTrayMenu();
}

function fireReminder(memoId, reminder, info) {
  const memo = vault?.get(memoId);
  if (!memo) return;
  const kind = info.missed ? '놓친 알림' : info.startup ? '켤 때 알림' : '알림';
  const alarm = { reminderId: reminder.id, label: `${kind} · ${describeReminder(reminder)}`, missed: Boolean(info.missed) };
  history?.add({ source: 'memoking', appId: APP_ID, app: '메모킹', title: memo.title, body: alarm.label, memoId });

  if (reminder.action === 'open') {
    // 메모 띄우기: 창을 화면 앞에 열고 창 안에 알림 띠
    const existing = noteWins.get(memoId);
    if (existing) existing.webContents.send('memo:alarm', alarm);
    else pendingAlarms.set(memoId, alarm);
    const win = openNote(memoId);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.moveTop();
      win.flashFrame(true);
      win.once('focus', () => win.flashFrame(false));
    }
  } else {
    showToast(memoId, memo, alarm);
  }
  pushReminders();
}

// 알림만: Windows 알림(토스트). 누르면 메모가 앞으로 온다.
function showToast(memoId, memo, alarm) {
  const preview = extractPreview(memo.body, 120);
  toast({
    memoId,
    title: memo.title,
    body: preview ? `${alarm.label}\n${preview}` : alarm.label,
    onClick: () => revealNote(memoId),
  });
}

const alarms = createAlarmRunner({ getVault: () => vault, fire: fireReminder });

// ---------- 알림 보관함 (Windows 알림 기록) ----------

let history = null;

function initHistory() {
  history = new NotificationHistory({
    dir: path.join(app.getPath('userData'), 'notification-history'),
    sourceDir: SMOKE ? path.join(os.tmpdir(), 'memoking-smoke', 'wpn') : undefined,
    selfAppId: APP_ID,
  });
  history.on('changed', () => listWin?.webContents.send('history:changed'));
  history.on('error', (err) => console.warn('[알림 보관함]', err.message));
  history.setBlocked(Object.keys(settings.historyBlocked ?? {}));
  if (settings.historyEnabled) history.start();
  syncPopupWatch();
}

// ---------- 팝업 알림 (Windows 알림 센터를 쓰지 않는 앱) ----------
// 지켜볼 앱이 작은 맨 위 창(알림 창)을 띄우면 도우미가 글자를 그대로 읽거나(UI 자동화 등) Windows 글자 인식으로 읽어 보내 준다.
let popupWatcher = null;
const recentPopups = [];

function createPopupWatcher(options = {}) {
  const watcher = new PopupWatcher({
    script: POPUP_HELPER,
    dir: path.join(os.tmpdir(), 'memoking-popups'),
    log: path.join(app.getPath('userData'), 'popup-debug.log'),
    processes: Object.keys(POPUP_APPS),
    ...options,
  });
  watcher.on('popup', (p) => addPopupToHistory(p).catch((err) => console.warn('[팝업 알림]', err.message)));
  watcher.on('error', (err) => console.warn('[팝업 알림]', err.message));
  return watcher;
}

// ---------- 숨은 OCR 창 (tesseract.js 한글) — 알림 창 그림을 Windows 기본 OCR 대신 한글에 강한 모델로 읽는다 ----------
// memoking://ocr 오리진에서 로드되어 워커·wasm·언어파일을 같은 오리진에서 불러온다. 처음 쓸 때 한 번만 띄운다.
let ocrWin = null;
let ocrReady = null;
const ocrPending = new Map(); // id -> {resolve, timer}
let ocrSeq = 0;

function ensureOcrWindow() {
  if (ocrReady) return ocrReady;
  ocrReady = new Promise((resolve, reject) => {
    try {
      ocrWin = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        webPreferences: { preload: OCR_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      ipcMain.once('ocr:ready', () => resolve(ocrWin));
      ocrWin.webContents.on('render-process-gone', () => { ocrWin = null; ocrReady = null; });
      ocrWin.on('closed', () => { ocrWin = null; ocrReady = null; });
      ocrWin.loadURL('memoking://ocr/ocr.html').catch(reject);
      setTimeout(() => reject(new Error('OCR 창 준비 시간 초과')), 20000);
    } catch (err) {
      ocrReady = null;
      reject(err);
    }
  }).catch((err) => { ocrReady = null; throw err; });
  return ocrReady;
}

ipcMain.on('ocr:result', (_e, data) => {
  const job = ocrPending.get(data?.id);
  if (!job) return;
  ocrPending.delete(data.id);
  clearTimeout(job.timer);
  job.resolve(data);
});

// 그림 파일을 한글 OCR → 줄마다 { text, x, y, w, h } (좌표는 100% 배율 px). 안 되면 throw.
async function runOcr(imagePath, unit) {
  await ensureOcrWindow();
  const dataUrl = `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`;
  const id = ++ocrSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ocrPending.delete(id); reject(new Error('OCR 시간 초과')); }, 30000);
    ocrPending.set(id, { resolve, timer });
    ocrWin.webContents.send('ocr:request', { id, dataUrl, unit: unit || 1 });
  }).then((data) => {
    if (data.error) throw new Error(data.error);
    return data;
  });
}

async function addPopupToHistory(p) {
  try {
    const app = popupAppName(p.process);
    // Windows 기본 OCR 대신 한글에 강한 tesseract.js 로 다시 읽는다 (그대로 읽은 글이 없을 때 = via 'ocr', 3배 확대 그림이 있을 때)
    if (p.via === 'ocr' && p.ocrImage && fs.existsSync(p.ocrImage)) {
      try {
        const r = await runOcr(p.ocrImage, p.ocrUnit);
        if (r.boxes?.length) { p.boxes = r.boxes; p.lines = r.lines; }
      } catch (err) {
        console.warn('[한글 OCR]', err.message); // 실패하면 아래에서 PowerShell 이 보낸 Windows OCR 결과를 그대로 쓴다
      }
    }
    // 카카오톡 알림 창을 글자 인식으로 읽었으면 줄의 자리로 방 이름·보낸 사람·메시지를 나눈다
    const byLayout = p.process === 'KakaoTalk' && p.via === 'ocr' && Array.isArray(p.boxes)
      ? kakaoEntry(p.boxes, { width: p.size?.w, height: p.size?.h, appName: app })
      : null;
    const entry = byLayout ?? popupToEntry(p.lines, { appName: app });
    if (!entry || !history) return;
    const now = Date.now();
    while (recentPopups.length && now - recentPopups[0].at > 5 * 60 * 1000) recentPopups.shift();
    if (isRepeat(recentPopups, { app, ...entry }, now)) return;
    recentPopups.push({ app, ...entry, at: now });
    // 알림 창 그림도 함께 (보관함에서 그대로 보이게)
    const image = p.image ? history.keepImage(p.image) : null;
    history.add({ source: 'popup', appId: p.process, app, ...entry, image, via: p.via ?? '' });
  } finally {
    if (p.image) fs.rm(p.image, { force: true }, () => {});
    if (p.ocrImage) fs.rm(p.ocrImage, { force: true }, () => {});
  }
}

function syncPopupWatch() {
  // 따로 켜는 설정 없이, 알림 모아두기가 켜져 있으면 늘 (카카오톡 등의 알림 창도 함께 모은다)
  const on = settings.historyEnabled && !SMOKE;
  if (on) {
    popupWatcher ??= createPopupWatcher();
    popupWatcher.start();
  } else {
    popupWatcher?.stop();
    if (ocrWin && !ocrWin.isDestroyed()) ocrWin.close(); // 알림 모으기를 끄면 OCR 창도 닫는다
  }
}

function setHistoryEnabled(on) {
  settings.historyEnabled = Boolean(on);
  saveSettings();
  if (on) history.start();
  else history.stop();
  syncPopupWatch();
  updateTrayMenu();
  return settings.historyEnabled;
}

// 앱마다 모으지 않기: { 앱 id: 앱 이름 }
function blockHistoryApp(appId, appName, removeExisting) {
  if (!appId || !history) return 0;
  settings.historyBlocked = { ...(settings.historyBlocked ?? {}), [appId]: appName || appId };
  saveSettings();
  history.setBlocked(Object.keys(settings.historyBlocked));
  return removeExisting ? history.removeApp(appId) : 0;
}

function unblockHistoryApp(appId) {
  const next = { ...(settings.historyBlocked ?? {}) };
  delete next[appId];
  settings.historyBlocked = next;
  saveSettings();
  history?.setBlocked(Object.keys(next));
  history?.emit('changed');
}

// 모을 앱 고르기: 알림이 온 앱 + 끈 앱
function historyApps() {
  const blocked = settings.historyBlocked ?? {};
  const apps = new Map((history?.appList() ?? []).map((a) => [a.appId, { ...a, blocked: Boolean(blocked[a.appId]) }]));
  for (const [appId, app] of Object.entries(blocked)) if (!apps.has(appId)) apps.set(appId, { appId, app, count: 0, blocked: true });
  return [...apps.values()];
}

// 보관한 알림을 메모로 만든다
function historyToMemo(entryId) {
  const e = history?.get(entryId);
  if (!e || !vault) return null;
  const when = new Date(e.time).toLocaleString('ko-KR');
  const body = `# ${e.title || e.app}\n\n${e.body ? `${e.body}\n\n` : ''}> ${e.app} 알림 · ${when}`;
  const id = vault.import({ body });
  openNote(id);
  return id;
}

// ---------- Google Drive 직접 동기화 (Google Drive 데스크탑 앱 없이) ----------
// 메모 폴더(이 PC)를 고른 Drive 폴더와 맞춘다. 휴대폰 메모킹과 같은 규칙(desktop/drive/sync-engine.js).

let driveAuth = null;
let driveApi = null;
let driveSync = null;

function initDrive() {
  driveAuth = new GoogleAuth({
    file: path.join(app.getPath('userData'), 'google-auth.json'),
    bundledClient: path.join(import.meta.dirname, 'google-client.json'),
    fetch: (...args) => net.fetch(...args),
    openExternal: (url) => shell.openExternal(url),
    safeStorage,
  });
  driveApi = new DriveApi({ auth: driveAuth, fetch: (...args) => net.fetch(...args) });
  driveSync = new DriveSync({ api: driveApi, auth: driveAuth, stateDir: path.join(app.getPath('userData'), 'drive') });
  driveSync.on('status', (st) => {
    if (st.changed) vault?.scan(); // 내려받은 메모를 바로 목록·열린 창에
    listWin?.webContents.send('drive:status', driveInfo());
  });
  // 예전(Drive 전체 권한) 연결이었으면: 고른 Drive 폴더도 잊고 다시 연결하게 (메모는 이 PC 에 그대로)
  if (driveAuth.scopeUpgraded && settings.drive) {
    settings.drive = null;
    saveSettings();
  }
  configureDrive();
}

function configureDrive() {
  if (!driveSync) return;
  const d = settings.drive;
  driveSync.configure(d?.folderId && vault ? { folderId: d.folderId, folderName: d.folderName, root: vault.root } : null);
  driveSync.request(2000);
}

function driveInfo() {
  return {
    configured: driveAuth?.configured ?? false,
    connected: driveAuth?.connected ?? false,
    email: driveAuth?.email ?? '',
    active: Boolean(settings.drive?.folderId) && (driveSync?.active ?? false),
    folderId: settings.drive?.folderId ?? '',
    folderName: settings.drive?.folderName ?? '',
    root: vault?.root ?? '',
    insideDriveApp: insideDriveForDesktop(vault?.root),
    reconnect: driveAuth?.scopeUpgraded ?? false, // 연결 방식이 바뀌어 다시 연결해야 함
    status: driveSync?.status ?? { state: 'off' },
  };
}

// 이 Drive 폴더와 맞추기 시작. 지금 메모 폴더가 Google Drive 데스크탑 앱 폴더(G:\내 드라이브…) 안이면
// 두 번 동기화가 되지 않게 이 PC 의 문서\메모킹 으로 옮겨 맞춘다 — 메모킹은 자기가 만든 Drive 파일만 보므로
// (drive.file) Drive 앱이 올린 메모를 내려받을 수 없다: 원래 폴더의 메모를 먼저 복사해 두고, 첫 동기화 때 새 Drive 폴더로 올린다.
async function useDriveFolder(folderId, folderName) {
  let root = vault?.root;
  if (!root || insideDriveForDesktop(root)) root = path.join(app.getPath('documents'), '메모킹');
  const moving = root !== vault?.root;
  if (moving) {
    // 열린 메모 창이 닫히며 남은 글을 원래 폴더에 저장한 뒤 복사한다
    const wins = [...noteWins.values()].filter((w) => !w.isDestroyed());
    await Promise.all(wins.map((w) => new Promise((resolve) => {
      w.once('closed', resolve);
      setTimeout(resolve, 3000); // 닫히지 않는 창이 있어도 멈추지 않게
      w.close();
    })));
    if (vault?.root) copyVault(vault.root, root);
  }
  settings.drive = { folderId, folderName };
  saveSettings();
  if (moving) openVault(root); // → configureDrive
  else configureDrive();
  const status = await driveSync.run();
  return { info: vaultInfo(), status, drive: driveInfo() };
}

// ---------- Windows 시작 시 자동 실행 ----------
// 개발 실행(npx electron)은 실행 파일 경로가 npm 캐시라 불안정하므로 설치판에서만 쓴다.

const autoStartAvailable = () => app.isPackaged && process.platform === 'win32';
const getAutoStart = () => autoStartAvailable() && app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;

function setAutoStart(on) {
  if (!autoStartAvailable()) return false;
  app.setLoginItemSettings({ openAtLogin: Boolean(on), args: LOGIN_ARGS });
  settings.autoStartSet = true;
  saveSettings();
  updateTrayMenu();
  return getAutoStart();
}

// ---------- 휴지통 자동 비우기 ----------
const TRASH_DAYS = [0, 7, 30, 90, 365];
function purgeTrash() {
  if (!vault || !(settings.trashDays > 0)) return null;
  try {
    const r = vault.emptyTrash({ olderThanDays: settings.trashDays });
    if (r.memos || r.files) console.log(`[휴지통] 오래된 메모 ${r.memos}개·첨부 ${r.files}개를 영구 삭제`);
    return r;
  } catch (err) {
    console.error('휴지통 비우기 실패', err);
    return null;
  }
}
setInterval(purgeTrash, 6 * 60 * 60 * 1000).unref?.();

function appSettings() {
  return {
    trashDays: settings.trashDays,
    trashCount: vault?.trashList().length ?? 0,
    autoStart: { available: autoStartAvailable(), enabled: getAutoStart() },
    historyEnabled: settings.historyEnabled,
    quickMemo: { enabled: settings.quickMemo, registered: globalShortcut.isRegistered(QUICK_MEMO_KEY), key: 'Ctrl+Alt+C' },
    fitTables: settings.fitTables !== false,
    autoTags: settings.autoTags !== false,
    magic: normalizeMagicSettings(settings.magic),
    magicIndex: fileIndex?.status() ?? null, // 파일 검색 목록: 개수·만든 때
    version: app.getVersion(),
  };
}

// ---------- 빠른 메모 (Ctrl+Alt+C) ----------
// 어느 앱에서든 선택한 글·파일·그림을 복사해 마우스 위치에 새 메모로 띄운다.

const captureHelper = new CaptureHelper(CLIPBOARD_HELPER);
const pendingCaptures = new Map(); // 새 메모 창이 열리면 채울 내용
let capturing = false;

function registerQuickMemoKey() {
  globalShortcut.unregister(QUICK_MEMO_KEY);
  if (!settings.quickMemo || process.platform !== 'win32') return false;
  const ok = globalShortcut.register(QUICK_MEMO_KEY, () => onQuickMemoKey());
  if (!ok) console.warn('Ctrl+Alt+C 를 다른 프로그램이 쓰고 있어 등록하지 못했습니다');
  else captureHelper.start(); // 미리 띄워 두어 누르자마자 동작하게
  return ok;
}

// ---------- 매직키 (Ctrl+Alt+Space) — 어디서든 빠르게 입력하는 작은 창 (기본: 메모 만들기) ----------
let magicWin = null;

function createMagicWindow() {
  const win = new BrowserWindow({
    width: 600,
    height: 190,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...windowIcon,
    webPreferences: { preload: MAGIC_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(APP_DIR, 'magic.html'));
  win.on('blur', () => win.hide()); // 밖을 누르면 닫힌다
  // 끌어 옮긴 자리는 기억해 다음에도 그 자리에
  win.on('moved', () => {
    if (!win.isVisible()) return;
    const [x, y] = win.getPosition();
    settings.magicPos = { x, y };
    saveSettings();
  });
  win.on('closed', () => { if (magicWin === win) magicWin = null; });
  return win;
}

function showMagic() {
  if (!vault) { createListWindow(); return; } // 메모 폴더가 아직 없으면 목록부터
  magicWin ??= createMagicWindow();
  const [w] = magicWin.getSize();
  const saved = settings.magicPos;
  // 끌어 옮긴 자리가 지금 화면 안이면 그 자리, 아니면 마우스가 있는 화면 위쪽 가운데
  const onScreen = saved && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x >= a.x - 40 && saved.x + 80 <= a.x + a.width && saved.y >= a.y - 10 && saved.y + 40 <= a.y + a.height;
  });
  if (onScreen) magicWin.setPosition(Math.round(saved.x), Math.round(saved.y));
  else {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    magicWin.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + area.height * 0.22));
  }
  magicWin.show();
  magicWin.focus();
  magicWin.webContents.send('magic:show');
  fileIndex?.touch(); // 오래됐으면 파일 목록을 뒤에서 새로
}

// 파일 검색 모듈이 켜져 있으면 파일 이름 목록을 만들어 두고 주기적으로 새로 고친다
let fileIndex = null;
function syncFileIndex() {
  const on = !SMOKE && activeModules(settings.magic).some((m) => m.id === 'files');
  if (on) {
    fileIndex ??= new FileIndex({ cacheFile: path.join(app.getPath('userData'), 'file-index.json') });
    fileIndex.start();
  } else fileIndex?.stop();
}

// 파일 아이콘 (확장자마다 한 번, 프로그램·바로 가기·폴더는 그 파일 것)
const iconCache = new Map();
async function fileIcon(p, isDir) {
  const ext = path.extname(p).toLowerCase();
  const key = isDir ? 'dir' : /^\.(exe|lnk|url|ico|appref-ms)$/.test(ext) ? p : ext || 'none';
  if (!iconCache.has(key)) {
    iconCache.set(key, app.getFileIcon(p, { size: 'normal' }).then((img) => img.toDataURL()).catch(() => ''));
    if (iconCache.size > 800) iconCache.delete(iconCache.keys().next().value);
  }
  return iconCache.get(key);
}
let lastFileResults = new Set(); // 매직키 창이 열 수 있는 파일 = 방금 찾아 보여 준 것만

function registerMagicKey() {
  globalShortcut.unregister(MAGIC_KEY);
  if (!normalizeMagicSettings(settings.magic).enabled) return false;
  const ok = globalShortcut.register(MAGIC_KEY, () => showMagic());
  if (!ok) console.warn('Ctrl+Alt+Space 를 다른 프로그램이 쓰고 있어 등록하지 못했습니다');
  return ok;
}

function setMagicSettings(next) {
  settings.magic = normalizeMagicSettings(next);
  saveSettings();
  registerMagicKey();
  syncFileIndex();
  if (!settings.magic.enabled && magicWin && !magicWin.isDestroyed()) magicWin.hide();
  return settings.magic;
}

function setQuickMemo(on) {
  settings.quickMemo = Boolean(on);
  saveSettings();
  if (!registerQuickMemoKey()) captureHelper.stop();
  updateTrayMenu();
  return appSettings().quickMemo;
}

const notice = (title, body) => toast({ title, body });

/** @param {{ copy?: boolean }} options  copy=false: 선택을 복사하지 않고 지금 클립보드 내용으로 (트레이 메뉴·점검) */
let lastCapturePoint = null; // 자동 점검용: 메모를 만든 순간의 마우스 위치
async function quickMemo({ copy = true, onlyPid = 0 } = {}) {
  if (capturing) return null;
  if (!vault) {
    createListWindow();
    return null;
  }
  capturing = true;
  const point = screen.getCursorScreenPoint();
  lastCapturePoint = point;
  const dir = path.join(os.tmpdir(), 'memoking-capture', `${Date.now()}`);
  try {
    const info = await captureHelper.capture(dir, { copy, onlyPid });
    if (info.error) throw new Error(info.error);
    if (info.copySkipped) return null;
    return captureToMemo(dir, info, point);
  } catch (err) {
    console.error('빠른 메모 실패', err);
    notice('메모를 만들지 못했어요', 'Ctrl+Alt+C를 한 번 더 눌러 주세요.');
    return null;
  } finally {
    capturing = false;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 풀어 둔 클립보드(dir) → 새 메모 창 + 알림. 자동 점검은 받아 둔 클립보드 내용으로 이것만 부른다.
function captureToMemo(dir, info, point) {
  const capture = buildCapture(readCaptureDir(dir), info, vault);
  if (!capture) {
    notice('가져올 내용이 없어요', '글·파일·그림을 고른 뒤 Ctrl+Alt+C를 눌러 주세요.');
    return null;
  }
  const where = captureWhere(capture.source);
  return openCaptureMemo(capture, point, {
    title: '메모를 만들었어요',
    body: `${captureTitle(capture)}${where ? `\n${where}에서 가져왔어요` : ''} · 눌러서 열기`,
  });
}

// 가져온 내용(capture)으로 새 메모 창 + Windows 알림 (빠른 메모·영역 캡처가 함께 씀)
function openCaptureMemo(capture, point, message) {
  const id = vault.create();
  pendingCaptures.set(id, { ...capture, sourceMd: sourceLine(capture.source) });
  settings.noteBounds[id] = boundsAt(id, point); // 마우스가 있는 자리에
  // Windows 는 다른 앱에서 작업 중일 때 새 창을 맨 앞으로 가져오지 못하게 막으므로,
  // 포커스는 뺏지 않고 잠깐 맨 위에 보여 주고 + Windows 알림 (누르면 그 메모로 이동)
  const win = openNote(id, { inactive: true });
  win?.once('ready-to-show', () => peekOnTop(win, id));
  toast({ memoId: id, kind: 'quick-memo', ...message, onClick: () => revealNote(id) });
  return id;
}

// ---------- 영역 캡처 (Ctrl+Alt+C 두 번) ----------
// Electron 의 desktopCapturer(Chromium) 로 모니터마다 원래 해상도 화면을 찍고, 그 위에 전체 화면 오버레이를 띄워
// 끌어서 고른 사각형만 잘라 → 클립보드에 그림으로 복사 + 새 메모. 자동 점검은 오버레이를 숨긴 채 쓴다.
let areaCapture = null; // { wins, shots: Map(webContents id → { image, display }), point }
const smokeClipboard = [];

async function startAreaCapture({ show = !SMOKE } = {}) {
  if (areaCapture || !vault) return false;
  areaCapture = { wins: [], shots: new Map(), point: screen.getCursorScreenPoint() };
  const displays = screen.getAllDisplays();
  let sources = [];
  try {
    const size = {
      width: Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor))),
      height: Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor))),
    };
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  } catch (err) {
    console.error('화면 캡처 실패', err);
  }
  if (!sources.length) {
    areaCapture = null;
    notice('화면을 캡처하지 못했어요', '잠시 뒤 Ctrl+Alt+C 를 두 번 다시 눌러 주세요.');
    return false;
  }
  for (const d of displays) {
    const src = sources.find((x) => String(x.display_id) === String(d.id)) ?? (displays.length === 1 ? sources[0] : null);
    if (!src || src.thumbnail.isEmpty()) continue;
    const win = new BrowserWindow({
      ...d.bounds,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      backgroundColor: '#000000',
      webPreferences,
    });
    guardWindow(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setBounds(d.bounds);
    areaCapture.shots.set(win.webContents.id, { image: src.thumbnail, display: d });
    areaCapture.wins.push(win);
    win.webContents.once('did-finish-load', () => {
      if (!areaCapture || win.isDestroyed()) return;
      // 보여 주기만 하는 그림은 JPEG 로 가볍게 (자르기는 원본 그대로)
      win.webContents.send('capture:image', { src: `data:image/jpeg;base64,${src.thumbnail.toJPEG(92).toString('base64')}` });
      if (show) {
        win.show();
        win.moveTop();
        win.focus();
      }
    });
    win.loadFile(path.join(APP_DIR, 'capture.html'));
  }
  if (!areaCapture.wins.length) {
    areaCapture = null;
    return false;
  }
  return true;
}

function endAreaCapture() {
  const c = areaCapture;
  areaCapture = null;
  for (const w of c?.wins ?? []) if (!w.isDestroyed()) w.destroy();
  return c;
}

// 그림을 클립보드에 (Electron 44 는 그림 쓰기가 없어 PowerShell 도우미의 image 동작)
function copyImageToClipboard(file) {
  if (SMOKE) {
    smokeClipboard.push(file);
    return;
  }
  execFile('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLIPBOARD_HELPER, '-Action', 'image', '-ImageFile', file],
    { windowsHide: true }, (err) => {
      if (err) console.error('캡처한 그림을 클립보드에 넣지 못했어요', err.message);
      setTimeout(() => fs.rmSync(file, { force: true }), 5000);
    });
}

// 오버레이에서 고른 사각형(그 모니터 기준, 화면 좌표 단위) → 잘라서 메모
function finishAreaCapture(senderId, rect) {
  const shot = areaCapture?.shots.get(senderId);
  const c = endAreaCapture();
  if (!shot || !c || !rect) return null;
  const { width: iw, height: ih } = shot.image.getSize();
  const rx = iw / shot.display.bounds.width;
  const ry = ih / shot.display.bounds.height;
  const crop = {
    x: Math.max(0, Math.round(rect.x * rx)),
    y: Math.max(0, Math.round(rect.y * ry)),
    width: Math.round(rect.width * rx),
    height: Math.round(rect.height * ry),
  };
  crop.width = Math.min(crop.width, iw - crop.x);
  crop.height = Math.min(crop.height, ih - crop.y);
  if (crop.width < 2 || crop.height < 2) return null;
  const png = shot.image.crop(crop).toPNG();
  const tmp = path.join(os.tmpdir(), `memoking-area-${Date.now()}.png`);
  fs.writeFileSync(tmp, png);
  copyImageToClipboard(tmp);
  const src = vault.saveAttachment(png, 'png');
  const capture = {
    heading: '화면 캡처',
    html: null,
    text: null,
    items: [{ kind: 'image', src, alt: '화면 캡처' }],
    skipped: [],
    source: { window: '화면 캡처', process: '', url: null, time: new Date().toISOString(), copied: false },
  };
  return openCaptureMemo(capture, c.point, {
    title: '화면 캡처로 메모를 만들었어요',
    body: `${crop.width} × ${crop.height} 이미지를 클립보드에도 복사했어요 · 눌러서 열기`,
  });
}

// Ctrl+Alt+C: 한 번 = 빠른 메모, 0.35초 안에 두 번 = 영역 캡처
const onQuickMemoKey = createDoublePress({
  ms: 350,
  onSingle: () => quickMemo(),
  onDouble: () => startAreaCapture(),
});

// ---------- IPC ----------

const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);

function registerIpc() {
  ipcMain.handle('app:info', () => vaultInfo());
  ipcMain.handle('vault:use', (_e, dir) => {
    const info = openVault(dir);
    if (vault && !settings.tutorialDone && !SMOKE) startTutorial(); // 처음 설치: 폴더를 정한 직후
    return info;
  });
  // 튜토리얼
  ipcMain.handle('tutorial:start', () => startTutorial());
  ipcMain.handle('tutorial:current', (event) => {
    const payload = tutorialPayload();
    return payload && tutorialWin(payload) === senderWindow(event) ? payload : null;
  });
  ipcMain.handle('tutorial:action', (_e, action) => {
    if (action === 'next' || action === 'skip') tutorialEvent(action);
  });
  ipcMain.handle('tutorial:event', (_e, name) => {
    if (name === 'typed' || name === 'tagged') tutorialEvent(name);
  });
  ipcMain.handle('vault:choose', async (event) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      title: '메모를 저장할 폴더 선택',
      defaultPath: vault?.root ?? suggestedVaultPath(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return vaultInfo();
    for (const win of noteWins.values()) win.close();
    const info = openVault(result.filePaths[0]);
    if (vault && !settings.tutorialDone && !SMOKE) startTutorial();
    return info;
  });
  ipcMain.handle('vault:reveal', () => vault && shell.openPath(vault.root));
  ipcMain.handle('vault:reveal-index', () => vault && shell.showItemInFolder(vault.indexFile));

  ipcMain.handle('memos:list', () => listMemos());
  // 지금까지 쓴 태그 (많이 쓴 순) — 메모 창의 # 자동완성
  ipcMain.handle('tags:list', () => collectTags(vault?.list() ?? []));
  // 밖에서 들어온 메모(화면 캡처·빠른 메모)에 저절로 달 태그 — 내용에 맞는 기존 태그 + 들어온 곳 태그
  // 태그 없는 메모의 추천 태그 (휴대폰과 같은 알고리즘 — 이미 쓰는 태그와 정합성 있게)
  ipcMain.handle('tags:suggest', (_e, body, id) => suggestTagsFor(String(body ?? ''), vault?.bodies() ?? [], { excludeId: id }));
  ipcMain.handle('tags:auto', (_e, body, source, id) => autoTagsFor(String(body ?? ''), vault?.bodies() ?? [], { source, excludeId: id }));
  ipcMain.handle('memos:search', (_e, query, excludeId) => withOpenFlag(vault?.search(String(query ?? ''), excludeId) ?? []));

  // 예약 알림: 메모 하나의 알림 목록을 통째로 저장 (추가·삭제·켜기/끄기)
  ipcMain.handle('reminders:set', (_e, id, list) => {
    if (!vault || !Array.isArray(list)) return null;
    const reminders = list.map((r) => normalizeReminder(r)).filter(Boolean);
    const saved = vault.setReminders(id, reminders);
    sendToNote(id, 'memo:reminders', saved);
    pushReminders();
    alarms.tick(); // 방금 만든 알림이 이미 울릴 때면 바로
    return saved;
  });
  ipcMain.handle('reminders:all', () => vault?.allReminders() ?? []);

  // 알림 보관함
  ipcMain.handle('history:list', (_e, filter) => {
    const entries = history?.list(filter ?? {}) ?? [];
    return { enabled: settings.historyEnabled, total: history?.state.entries.length ?? 0, apps: history?.apps() ?? [], entries: entries.slice(0, 500) };
  });
  ipcMain.handle('history:set-enabled', (_e, on) => setHistoryEnabled(on));
  ipcMain.handle('history:remove', (_e, id) => history?.remove(id) ?? false);
  ipcMain.handle('history:clear', () => history?.clear());
  ipcMain.handle('history:to-memo', (_e, id) => historyToMemo(id));
  ipcMain.handle('history:apps', () => historyApps());
  // Google Drive 직접 동기화
  ipcMain.handle('drive:status', () => driveInfo());
  ipcMain.handle('drive:set-client', (_e, id, secret) => {
    driveAuth.setClient(id, secret);
    return driveInfo();
  });
  ipcMain.handle('drive:login', async () => {
    await driveAuth.login();
    const email = await driveApi.about().catch(() => '');
    if (email) driveAuth.setEmail(email);
    if (listWin) {
      if (listWin.isMinimized()) listWin.restore();
      listWin.show();
      listWin.focus();
    }
    return { email };
  });
  ipcMain.handle('drive:cancel-login', () => driveAuth.cancelLogin());
  ipcMain.handle('drive:folders', async (_e, parent) => (await driveApi.folders(String(parent || 'root'))).map((f) => ({ id: f.id, name: f.name })));
  ipcMain.handle('drive:create-folder', async (_e, parent, name) => {
    const f = await driveApi.createFolder(String(parent || 'root'), String(name));
    return { id: f.id, name: f.name };
  });
  ipcMain.handle('drive:use', (_e, folderId, name) => useDriveFolder(String(folderId), String(name)));
  ipcMain.handle('drive:sync', () => driveSync.run());
  ipcMain.handle('drive:disconnect', () => {
    driveAuth.signOut();
    settings.drive = null;
    saveSettings();
    configureDrive();
    return driveInfo();
  });
  ipcMain.handle('history:block', (_e, appId, app, removeExisting) => blockHistoryApp(String(appId ?? ''), String(app ?? ''), Boolean(removeExisting)));
  ipcMain.handle('history:unblock', (_e, appId) => unblockHistoryApp(String(appId ?? '')));
  ipcMain.handle('clipboard:write-text', (_e, text) => clipboard.writeText(String(text ?? '')));

  // 설정 (자동 실행)
  ipcMain.handle('app:settings', () => appSettings());
  ipcMain.handle('app:set-auto-start', (_e, on) => setAutoStart(on));
  ipcMain.handle('app:set-quick-memo', (_e, on) => setQuickMemo(on));
  ipcMain.handle('app:set-fit-tables', (_e, on) => {
    settings.fitTables = Boolean(on);
    saveSettings();
    return settings.fitTables;
  });
  ipcMain.handle('app:set-auto-tags', (_e, on) => {
    settings.autoTags = Boolean(on);
    saveSettings();
    return settings.autoTags;
  });
  ipcMain.handle('app:set-magic', (_e, next) => setMagicSettings(next));
  // 매직키 창 아래 캡슐: 쓸 수 있는 모듈 모두와 켜짐 여부 (누르면 켜고 끔)
  const magicModuleList = () => {
    const m = normalizeMagicSettings(settings.magic);
    return MAGIC_MODULES.filter((x) => x.ready).map(({ id, name, description }) => ({ id, name, description, on: m.enabled && m.modules[id] }));
  };
  ipcMain.handle('magic:modules', () => magicModuleList());
  ipcMain.handle('magic:toggle-module', (_e, id) => {
    const m = normalizeMagicSettings(settings.magic);
    if (!(id in m.modules)) return magicModuleList();
    setMagicSettings({ ...m, modules: { ...m.modules, [id]: !m.modules[id] } });
    return magicModuleList();
  });
  ipcMain.on('magic:close', () => { if (magicWin && !magicWin.isDestroyed()) magicWin.hide(); });
  // 입력하는 대로: 메모(제목·내용)와 파일(이름)을 찾는다
  ipcMain.handle('magic:search', async (_e, query) => {
    const mods = new Set(activeModules(settings.magic).map((m) => m.id));
    const q = String(query ?? '').slice(0, 200);
    // 아무것도 안 썼으면 최근 메모 몇 개 (바로 열 수 있게)
    if (!q.trim()) {
      const recent = mods.has('notes') && vault ? vault.list().slice(0, 4).map((m) => ({ id: m.id, title: m.title, snippet: (m.preview ?? '').split('\n')[0], color: m.color, updated: m.updated })) : [];
      return { notes: recent, recent: true, folders: [], files: [], index: fileIndex?.status() ?? null };
    }
    const updatedOf = new Map((vault?.list() ?? []).map((m) => [m.id, m.updated]));
    const notes = mods.has('notes') && vault ? searchMemos(vault.searchable(), q, 5).map((n) => ({ ...n, updated: updatedOf.get(n.id) })) : [];
    let folders = [];
    let files = [];
    if (mods.has('files') && fileIndex) {
      ({ folders, files } = fileIndex.searchSplit(q, { folders: 3, files: 6 }));
      lastFileResults = new Set([...folders, ...files].map((f) => f.path));
      const home = os.homedir();
      const shown = (p) => (p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p);
      const withIcon = (list) => Promise.all(list.map(async (f) => ({ ...f, where: shown(path.dirname(f.path)), icon: await fileIcon(f.path, f.isDir) })));
      [folders, files] = await Promise.all([withIcon(folders), withIcon(files)]);
    }
    return { notes, folders, files, index: fileIndex?.status() ?? null };
  });
  ipcMain.handle('magic:open-memo', (_e, id) => {
    if (!vault?.get(String(id))) return false;
    magicWin?.hide();
    revealNote(String(id));
    return true;
  });
  ipcMain.handle('magic:open-file', async (_e, { path: p, reveal } = {}) => {
    if (!lastFileResults.has(p) || !fs.existsSync(p)) return false; // 방금 보여 준 결과만
    magicWin?.hide();
    if (reveal) shell.showItemInFolder(p);
    else {
      const err = await shell.openPath(p);
      if (err) notice('열지 못했어요', err);
    }
    return true;
  });
  // 결과 목록 높이에 맞춰 창 높이를 바꾼다 (위치는 그대로)
  ipcMain.on('magic:resize', (_e, h) => {
    if (!magicWin || magicWin.isDestroyed()) return;
    const height = Math.max(120, Math.min(640, Math.round(Number(h) || 0)));
    const [w, cur] = magicWin.getSize();
    if (cur !== height) magicWin.setSize(w, height);
  });
  ipcMain.handle('magic:run', (_e, payload) => {
    const mods = activeModules(settings.magic);
    if (!vault || payload?.module !== 'memo' || !mods.some((m) => m.id === 'memo')) return { ok: false };
    const body = memoBodyFromText(payload.text);
    if (!body) return { ok: false };
    const id = vault.import({ body });
    if (payload.open) openNote(id);
    else notice('메모를 만들었어요', body.split('\n')[0].slice(0, 40));
    return { ok: true, id };
  });
  // 표가 넘칠 때: 메모 창을 더 넓게 (요청한 본문 폭이 들어가도록, 화면 안에서). 반환: 실제로 넓힌 본문 폭(px)
  ipcMain.handle('win:grow-width', (event, extra) => {
    const win = senderWindow(event);
    const add = Math.ceil(Number(extra) || 0);
    if (!win || add <= 0) return 0;
    const [w, h] = win.getSize();
    const [x, y] = win.getPosition();
    const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
    const maxW = area.width - 24;
    const want = Math.min(maxW, w + add);
    if (want <= w) return 0;
    let nx = x;
    if (x + want > area.x + area.width) nx = Math.max(area.x, area.x + area.width - want); // 화면 밖으로 나가면 왼쪽으로
    win.setBounds({ x: nx, y, width: want, height: h });
    return want - w;
  });
  // 휴지통: 되살리기·영구 삭제·비우기, 자동 영구 삭제 기간
  ipcMain.handle('trash:list', () => vault?.trashList() ?? []);
  ipcMain.handle('trash:restore', (_e, name) => {
    const id = vault?.restoreTrash(String(name ?? '')) ?? null;
    pushList();
    return id;
  });
  ipcMain.handle('trash:delete', (_e, name) => vault?.deleteTrash(String(name ?? '')) ?? false);
  ipcMain.handle('trash:empty', () => vault?.emptyTrash() ?? { memos: 0, files: 0 });
  ipcMain.handle('app:set-trash-days', (_e, days) => {
    const d = Number(days);
    if (TRASH_DAYS.includes(d)) {
      settings.trashDays = d;
      saveSettings();
      purgeTrash(); // 줄인 기간이 바로 적용되게
    }
    return appSettings();
  });

  ipcMain.handle('memo:open', (_e, id) => Boolean(openNote(id)));
  ipcMain.handle('memo:create', (_e, options) => createNote(options ?? {}));
  ipcMain.handle('memo:get', (_e, id) => {
    const memo = vault?.get(id);
    // 창 상태(항상 위)는 기기별 설정이라 파일이 아닌 설정에서 붙인다.
    if (!memo) return null;
    const alarm = pendingAlarms.get(id) ?? null; // 알림으로 열린 창이면 알림 띠를 함께
    const capture = pendingCaptures.get(id) ?? null; // 빠른 메모로 만든 창이면 채울 내용
    pendingAlarms.delete(id);
    pendingCaptures.delete(id);
    return { ...memo, onTop: settings.onTop[id] === true, alarm, capture, stack: stackState(id) };
  });
  ipcMain.handle('memo:save', (_e, id, body) => {
    if (typeof body !== 'string') throw new TypeError('본문이 문자열이 아닙니다.');
    const summary = vault.save(id, body);
    noteWins.get(id)?.setTitle(summary.title);
    return summary;
  });
  // 쓰는 중에 다른 기기에서도 고친 메모: 들어온 내용을 사본 메모로 따로 남긴다 (열어 둔 동안은 한 사본만 고쳐 쓴다)
  ipcMain.handle('memo:keep-copy', (_e, sourceId, body, copyId) => {
    if (!vault || typeof body !== 'string') return null;
    if (copyId && vault.get(copyId)) {
      vault.save(copyId, body);
      return copyId;
    }
    return vault.import({ body, color: vault.get(sourceId)?.color });
  });
  ipcMain.on('memo:save-sync', (event, id, body) => {
    try {
      if (typeof body === 'string' && vault) vault.save(id, body);
      event.returnValue = true;
    } catch (err) {
      console.error('저장 실패', err);
      event.returnValue = false;
    }
  });
  ipcMain.handle('memo:set', (_e, id, patch) => {
    const memo = vault?.setMeta(id, patch ?? {});
    const win = noteWins.get(id);
    if (memo && win) {
      win.setBackgroundColor(noteBg(memo.color));
      win.webContents.send('memo:meta', memo);
    }
    return memo;
  });
  ipcMain.handle('memo:remove', (_e, id) => {
    removeFromStack(id, 'none'); // 스택이면 옆 탭이 보이게
    const win = noteWins.get(id);
    const title = vault?.get?.(id)?.title ?? '';
    const ok = vault?.trash(id) ?? false;
    win?.destroy();
    // 묻지 않고 지우므로 목록 창에 "되돌리기" (메모 창에서 지워도)
    if (typeof ok === 'string') listWin?.webContents.send('memo:trashed', { name: ok, title });
    return Boolean(ok);
  });
  // 메모를 PDF 로
  ipcMain.handle('pdf:open', (_e, id) => openPdfWindow(String(id)));
  ipcMain.handle('pdf:memo', (_e, id) => {
    const m = vault?.get(String(id));
    return m ? { title: m.title, body: m.body, color: m.color, tables: m.tables, created: m.created, updated: m.updated } : null;
  });
  ipcMain.handle('pdf:save', (event, id, options) => savePdf(String(id), options ?? {}, BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('memo:links', (_e, id) => vault?.links(id) ?? { links: [], backlinks: [], suggestions: [] });
  ipcMain.handle('memo:link', (_e, id, targetId, on) => {
    const result = vault?.link(id, targetId, on !== false);
    sendToNote(targetId, 'memo:links-changed');
    return result;
  });

  ipcMain.handle('attachment:save', (_e, bytes, ext) => {
    if (!vault) throw new Error('메모 폴더가 아직 없어요.');
    if (!(bytes instanceof Uint8Array)) throw new TypeError('넣으려는 파일을 읽지 못했어요.');
    return vault.saveAttachment(bytes, ext);
  });
  // 붙여넣은 인터넷 사진을 받아 메모 폴더에 저장 → "attachments/..." 반환
  ipcMain.handle('attachment:fetch', (_e, url) => fetchRemoteImage(String(url ?? '')));
  // 파일 칩·사진 누르기 → 기본 앱으로 열기 (메모 폴더 안의 파일만)
  ipcMain.handle('attachment:open', async (e, rel) => {
    let decoded = String(rel ?? '');
    try {
      decoded = decodeURI(decoded);
    } catch {
      // 이미 풀린 경로
    }
    const file = vault?.resolve(decoded);
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return '파일을 찾지 못했어요. 메모 폴더에서 옮겨졌거나 지워졌을 수 있어요.';
    const result = await openVaultFile(file, BrowserWindow.fromWebContents(e.sender));
    return result && result !== 'cancelled' ? '파일을 열지 못했어요. 이 파일을 열 수 있는 프로그램이 있는지 확인해 주세요.' : result;
  });
  // 파일 칩에 마우스를 올리면 보여줄 크기
  ipcMain.handle('attachment:info', (_e, rel) => {
    let decoded = String(rel ?? '');
    try {
      decoded = decodeURI(decoded);
    } catch {
      // 이미 풀린 경로
    }
    const file = vault?.resolve(decoded);
    const stat = file ? fs.statSync(file, { throwIfNoEntry: false }) : null;
    return stat?.isFile() ? { exists: true, size: stat.size } : { exists: false, size: 0 };
  });
  // 링크 미리보기 카드: 제목·설명·사진 (메모 폴더에 모아 둔 것, 없으면 페이지를 읽어 옴)
  ipcMain.handle('link:preview', (_e, url, options) => {
    if (!vault) return null;
    return getLinkPreviews().get(vault, String(url ?? ''), { refresh: Boolean(options?.refresh) });
  });
  ipcMain.handle('link:open', (_e, url) => openWebPage(url));

  const asPoint = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y) } : null);
  ipcMain.handle('drag:start', (_e, id) => dragStart(id));
  ipcMain.on('drag:move', (_e, point) => {
    const p = asPoint(point);
    if (p) dragMove(p);
  });
  ipcMain.handle('drag:end', (_e, point) => dragEnd(asPoint(point)));

  ipcMain.handle('win:close', (event) => senderWindow(event)?.close()); // 스택이면 'close' 이벤트에서 탭 모두 닫힘
  // 메모 스택 (탭)
  ipcMain.handle('stack:activate', (_e, id) => Boolean(openNote(String(id))));
  ipcMain.handle('stack:new-tab', (_e, fromId) => {
    if (!vault?.get(fromId)) return null;
    const id = vault.create({ color: vault.get(fromId).color });
    stacks.addAfter(fromId, id);
    showTab(id);
    return id;
  });
  ipcMain.handle('stack:remove', (_e, id) => removeFromStack(String(id), 'close'));
  ipcMain.handle('stack:detach', (_e, id) => removeFromStack(String(id), 'detach'));
  // 탭 끌어내기 (좌표는 화면 기준)
  ipcMain.handle('stack:tear-start', (_e, id, offset, point) => {
    const p = asPoint(point);
    return p ? tearStart(String(id), offset, p) : false;
  });
  ipcMain.on('stack:tear-move', (_e, point) => {
    const p = asPoint(point);
    if (p) tearMove(p);
  });
  ipcMain.handle('stack:tear-end', (_e, point) => tearEnd(asPoint(point)));
  ipcMain.handle('stack:cycle', (_e, id, dir) => {
    const next = stacks?.neighbor(String(id), dir < 0 ? -1 : 1);
    return next ? Boolean(showTab(next)) : false;
  });
  ipcMain.handle('stack:menu', (event, id) => {
    Menu.buildFromTemplate([
      { label: '따로 떼어 보기', click: () => removeFromStack(String(id), 'detach') },
      { label: '탭 닫기', click: () => removeFromStack(String(id), 'close') },
    ]).popup({ window: senderWindow(event) });
  });
  ipcMain.handle('win:minimize', (event) => senderWindow(event)?.minimize());
  // 목록 창 늘 위에 두기 (최소화 버튼 옆)
  // 영역 캡처 오버레이
  ipcMain.handle('capture:done', (event, rect) => {
    const r = rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])) ? rect : null;
    return finishAreaCapture(event.sender.id, r);
  });
  ipcMain.handle('capture:cancel', () => {
    endAreaCapture();
  });
  ipcMain.handle('list:toggle-top', () => setListOnTop(!listWin?.isAlwaysOnTop()));
  // 왕관 스티커: 왕관 위에 마우스가 오면 받기, 누르면 떼어져 늘 위에 두기 끄기
  ipcMain.on('sticker:hover', (event, over) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!over, { forward: true });
  });
  ipcMain.handle('sticker:peel', (event) => peelSticker(event.sender));
  ipcMain.handle('list:on-top', () => Boolean(listWin?.isAlwaysOnTop()));
  ipcMain.handle('win:dim-titlebar', (event, level) => {
    if (!listWin || senderWindow(event) !== listWin) return;
    titleBarDim = level === 'dialog' || level === 'coach' ? level : false;
    listWin.setTitleBarOverlay(titleBarOverlay());
  });
  ipcMain.handle('win:toggle-top', (event, id) => {
    const win = senderWindow(event);
    return win ? setNoteOnTop(String(id), !win.isAlwaysOnTop()) : false;
  });
  ipcMain.handle('list:show', () => {
    createListWindow();
  });
}

// 크롬과 같은 네트워크(net.fetch)로 받는다. 그림 형식만, 50MB·20초 제한.
// 일부 사이트는 "Electron" 이 들어간 브라우저 이름을 막으므로 일반 크롬 이름으로 요청한다.
async function fetchRemoteImage(url) {
  if (!vault) throw new Error('메모 폴더가 아직 없어요.');
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error('인터넷 주소(http·https)만 받을 수 있어요.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await net.fetch(target.href, {
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': app.userAgentFallback.replace(/\s*(Electron|MemoKing)\/\S+/g, ''),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const ext = imageExtFromType(type) ?? (type.startsWith('image/') || !type ? imageExtFromUrl(target.href) : null);
    if (!ext) throw new Error(`그림이 아니에요 (${type || '형식 모름'})`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_REMOTE_IMAGE_BYTES) throw new Error('50MB보다 커요.');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > MAX_REMOTE_IMAGE_BYTES) {
        controller.abort();
        throw new Error('50MB보다 커요.');
      }
      chunks.push(chunk);
    }
    return vault.saveAttachment(Buffer.concat(chunks.map((c) => Buffer.from(c))), ext);
  } finally {
    clearTimeout(timer);
  }
}

// 본문의 attachments/... 를 memoking://vault/attachments/... 로 보여준다.
// 알림 보관함의 그림(보낸 사람 사진 등)은 memoking://history/<파일>
function registerVaultProtocol() {
  protocol.handle('memoking', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    // memoking://ocr/<경로> = 숨은 OCR 창이 쓰는 앱 파일 (ocr.html·tesseract vendor). 같은 오리진이라 워커·wasm 을 그대로 불러온다.
    if (url.host === 'ocr') {
      const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
      const file = path.join(APP_DIR, safe);
      if (file.startsWith(APP_DIR) && fs.existsSync(file)) return net.fetch(pathToFileURL(file).href, { headers: request.headers });
      return new Response('not found', { status: 404 });
    }
    const file = url.host === 'vault' ? vault?.resolve(rel) : url.host === 'history' ? history?.resolveImage(rel) : null;
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href, { headers: request.headers });
  });
}

// ---------- 알림 영역(트레이) 아이콘 ----------
// 창을 모두 닫아도 앱은 알림 영역에 남아, 아이콘 클릭 한 번으로 다시 열 수 있다.

let tray = null;
let trayMenuTemplate = [];

const shorten = (text, max = 28) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function createTray() {
  // .ico 는 Windows 에서만 읽힌다 (다른 곳에서는 PNG)
  tray = new Tray(process.platform === 'win32' ? APP_ICON : APP_ICON_PNG);
  tray.setToolTip('메모킹 · 누르면 메모 목록이 열려요');
  tray.on('click', () => createListWindow());
  tray.on('double-click', () => createListWindow());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const recent = vault?.list().slice(0, 5) ?? [];
  trayMenuTemplate = [
    { label: '메모 목록 열기', click: () => createListWindow() },
    { label: '새 메모', enabled: Boolean(vault), click: () => createNote({}) },
    { label: '화면 캡처로 새 메모', enabled: Boolean(vault), click: () => startAreaCapture() },
    { label: '복사해 둔 내용으로 새 메모', enabled: Boolean(vault), click: () => quickMemo({ copy: false }) },
    { type: 'separator' },
    { label: '최근 메모', enabled: false },
    ...(recent.length
      ? recent.map((m) => ({ label: `   ${shorten(m.title)}`, click: () => openNote(m.id) }))
      : [{ label: '   없음', enabled: false }]),
    { type: 'separator' },
    { label: '알림 예약', click: () => createListWindow('reminders') },
    { label: '알림 보관함', click: () => createListWindow('history') },
    { label: '열린 메모 모두 앞으로', enabled: noteWins.size > 0, click: showAllNotes },
    { label: '메모 폴더 열기', enabled: Boolean(vault), click: () => shell.openPath(vault.root) },
    { type: 'separator' },
    {
      label: '빠른 메모 Ctrl+Alt+C (두 번: 화면 캡처)',
      type: 'checkbox',
      checked: settings.quickMemo && globalShortcut.isRegistered(QUICK_MEMO_KEY),
      click: (item) => setQuickMemo(item.checked),
    },
    {
      label: autoStartAvailable() ? 'PC를 켜면 메모킹도 함께 켜기' : 'PC를 켜면 메모킹도 함께 켜기 (설치한 메모킹에서)',
      type: 'checkbox',
      checked: getAutoStart(),
      enabled: autoStartAvailable(),
      click: (item) => setAutoStart(item.checked),
    },
    { type: 'separator' },
    { label: '사용법 보기', enabled: Boolean(vault), click: startTutorial },
    { label: '메모킹 종료', click: quitApp },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate));
}

function showAllNotes() {
  for (const [id, win] of noteWins) {
    const stack = stacks?.stackOf(id);
    if (stack && stack.active !== id) continue; // 스택의 숨은 탭
    if (win.isMinimized()) win.restore();
    win.showInactive();
    win.moveTop();
  }
}

// 열린 메모는 저장되고(창의 beforeunload), 다음 실행 때 다시 열린다.
function quitApp() {
  quitting = true;
  app.quit();
}

// 처음으로 모든 창을 닫았을 때 한 번만: "꺼진 게 아니라 여기 있어요"
function showTrayNoticeOnce() {
  if (settings.trayNoticeShown || !tray || SMOKE) return;
  settings.trayNoticeShown = true;
  saveSettings();
  tray.displayBalloon({
    icon: nativeImage.createFromPath(path.join(ASSETS_DIR, 'icons', 'icon-256.png')),
    title: '메모킹은 계속 켜져 있어요',
    content: '작업 표시줄 오른쪽 아래 알림 영역(^)에서 메모킹 아이콘을 누르면 다시 열려요.',
  });
}

// ---------- 시작 / 종료 ----------

app.on('second-instance', () => createListWindow());

app.whenReady().then(async () => {
  if (!gotLock) return;
  app.setAppUserModelId(APP_ID);
  // 카메라·마이크·위치 등 어떤 권한도 쓰지 않는다 (v0.6.0 에서 녹음 기능 삭제)
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  registerVaultProtocol();
  registerIpc();
  try {
    createTray();
  } catch (err) {
    console.error('알림 영역 아이콘을 만들지 못했어요', err); // 아이콘이 없어도 메모 창·알림은 그대로 뜨게
  }
  nativeTheme.on('updated', () => {
    listWin?.setTitleBarOverlay(titleBarOverlay());
    for (const [id, win] of noteWins) win.setBackgroundColor(noteBg(vault?.get(id)?.color));
  });

  // 절전에서 깨어나면 그 사이 알림을 바로 확인
  powerMonitor.on('resume', () => {
    alarms.tick();
    driveSync?.request(3000);
  });
  powerMonitor.on('unlock-screen', () => alarms.tick());

  if (SMOKE) {
    // 점검 모듈을 불러오지 못하면 멈춰 기다리지 말고 바로 실패로 끝낸다
    // --new: 이번에 바뀐 기능만 확인하는 짧은 점검 (smoke-new.js)
    const { prepareSmoke, runSmoke } = await import(process.argv.includes('--new') ? './smoke-new.js' : './smoke.js').catch((err) => {
      console.error('✖ 점검 모듈 오류', err);
      app.exit(1);
      return {};
    });
    if (!runSmoke) return;
    prepareSmoke(app.getPath('userData'));
    loadSettings();
    initHistory();
    openVault(settings.vaultPath);
    runSmoke({
      getList: () => listWin, noteWins, getVault: () => vault, createListWindow, getGhost: () => ghostWin,
      getTray: () => tray, getTrayMenu: () => trayMenuTemplate,
      alarms, smokeToasts, getHistory: () => history, appSettings, quickMemo, registerQuickMemoKey,
      getCapturePoint: () => lastCapturePoint, smokeOpened, smokeConfirmAnswers,
      getStacks: () => stacks, trackWindowDrag, endWindowDrag, stackInto, getTabTear: () => tabTear, getSettings: () => settings, stickers, reloadSettings: loadSettings, installMark,
      startAreaCapture, getAreaCapture: () => areaCapture, smokeClipboard, onQuickMemoKey,
      createPopupWatcher, getHistory: () => history, smokePdf, getPdfWin: () => pdfWin, openPdfWindow,
      startTutorial, getTutorial: () => tutorial,
      captureToMemo, smokeToastsList: smokeToasts, getTitleBarOverlay: () => titleBarOverlay(),
    });
    return;
  }

  loadSettings();
  initHistory();
  initDrive();
  // 설치판 첫 실행: 자동 실행을 기본으로 켜 둔다 (설정·트레이 메뉴에서 끌 수 있음)
  if (autoStartAvailable() && !settings.autoStartSet) setAutoStart(true);
  if (settings.vaultPath) openVault(settings.vaultPath);
  // 로그인 때 자동 실행이면 목록 창 없이 알림 영역에서 조용히 시작
  if (!HIDDEN_START || !vault) createListWindow();
  for (const id of [...settings.openNotes]) {
    if (!openNote(id)) settings.openNotes = settings.openNotes.filter((x) => x !== id);
  }
  alarms.startup(); // "실행할 때" 알림
  alarms.start(); // 날짜·시간·반복·타이머 알림 (놓친 것 포함)
  registerQuickMemoKey(); // Ctrl+Alt+C 빠른 메모
  registerMagicKey(); // Ctrl+Alt+Space 매직키
  syncFileIndex(); // 매직키 파일 검색 목록
  updateTrayMenu();
  // 튜토리얼을 마치기 전에 껐다 켰으면 다시 (자동 실행으로 조용히 켜질 때는 제외)
  if (vault && !settings.tutorialDone && !HIDDEN_START) startTutorial();
});

app.on('before-quit', () => {
  quitting = true;
});

// 창을 모두 닫아도 종료하지 않고 알림 영역에 남는다 (종료는 트레이 메뉴에서).
app.on('window-all-closed', () => {
  if (quitting) return;
  showTrayNoticeOnce();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  captureHelper.stop();
  alarms.stop();
  history?.stop();
  history?.save(true);
  tray?.destroy();
  vault?.close();
  saveSettings(true);
});
