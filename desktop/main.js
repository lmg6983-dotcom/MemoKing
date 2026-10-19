// Electron 메인 프로세스 — 앱 초기화, 시스템 트레이, 전역 단축키, 백그라운드 서비스 오케스트레이션.
import {
  app, BrowserWindow, clipboard, dialog, globalShortcut, nativeImage, nativeTheme, net,
  powerMonitor, protocol, safeStorage, session, shell, Tray, Menu,
} from 'electron';
import { contextMenuTemplate } from './context-menu.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './vault.js';
import { createAlarmRunner } from './alarms.js';
import { NotificationHistory } from './notification-history.js';
import { GoogleAuth } from './drive/google-auth.js';
import { DriveApi } from './drive/drive-api.js';
import { DriveSync, insideDriveForDesktop, copyVault } from './drive/drive-sync.js';
import { LinkPreviews } from './link-previews.js';
import { pickHandoff, recentlyUpdated } from '../app/js/core/handoff.js';
import { PopupWatcher } from './popup-watch.js';
import { createSttService } from './stt/stt-service.js';
import { replaceTranscript } from '../app/js/core/voice-card.js';
import { popupToEntry, kakaoEntry, popupAppName, isRepeat, POPUP_APPS } from '../app/js/core/popup-notify.js';
import { normalizeMagicSettings, activeModules, magicChips } from '../app/js/core/magic-modules.js';
import { normalizeShortcuts, isValidAccelerator, displayAccelerator, withShortcuts, DEFAULT_SHORTCUTS, SHORTCUT_NAMES } from '../app/js/core/accelerators.js';
import { FileIndex, defaultRoots } from './file-index.js';
import { Updater, isSnoozed } from './updater.js';
import { recoverOpmsSettings, normalizeOpmsHost } from './opms.js';
import { comboFromAccelerator, actionUsing } from '../app/js/core/keymap.js';
import { jumpListCategories, launchAction, pushRecent } from './jump-list.js';
import { flushOpmsFiles } from './opms.js';
import { createDoublePress } from './double-press.js';
import { MemoHotkeys } from './memo-hotkeys.js';
import { hotkeyCopyText, hotkeyLabel, hotkeyAccelerator } from '../app/js/core/memo-hotkeys.js';
import { TUTORIAL_STEPS, advanceTutorial } from '../app/js/core/tutorial.js';
import { toLocalIso, extractPreview } from '../app/js/core/memo-file.js';
import { alarmText } from '../app/js/core/reminders.js';

import {
  APP_ICON, APP_ICON_PNG, ASSETS_DIR,
  noteBg, titleBarOverlay, bringToFront, broadcast,
} from './window-utils.js';

import {
  SMOKE, APP_ID, STT_WORKER, STT_VENDOR, POPUP_HELPER,
  settings, loadSettings, saveSettings, installMark, suggestedVaultPath,
  purgeTrash, autoStartAvailable, getAutoStart, setAutoStart, appSettings,
  TRASH_DAYS, openWebPage, openVaultFile, toast, smokeToasts, smokeOpened,
  smokeConfirmAnswers, writeClipboard, fetchRemoteImage, registerVaultProtocol,
  mcpStatus, mcpConnect, mcpSnippet, shorten,
} from './utils.js';

import { WindowManager } from './window-manager.js';
import { registerIpc } from './ipc-handlers.js';
import { CalendarFeeds } from './calendar-feeds.js';

// 점검 때는 가짜 마이크(삐 소리)로 녹음한다 — 실제 마이크·권한 창 없이
if (SMOKE) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (process.env.MEMOKING_FAKE_AUDIO) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.MEMOKING_FAKE_AUDIO);
  }
}

// Windows 로그인 때 자동 실행된 경우: 창 없이 알림 영역에서 조용히 시작
const HIDDEN_START = process.argv.includes('--hidden');

if (SMOKE) {
  const smokeDir = path.join(os.tmpdir(), 'memoking-smoke');
  fs.rmSync(smokeDir, { recursive: true, force: true });
  fs.mkdirSync(smokeDir, { recursive: true });
  app.setPath('userData', path.join(smokeDir, 'userData'));
}

const gotLock = SMOKE || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

protocol.registerSchemesAsPrivileged([
  { scheme: 'memoking', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------- 전역 애플리케이션 상태 ----------

let vault = null;
let vaultError = null;
let quitting = false;

let tray = null;
let trayMenuTemplate = [];
let jumpTimer = null;
let lastJumpList = '';

const handoffSeen = new Set();
let lastHandoff = null;

let history = null;
let popupWatcher = null;
const recentPopups = [];

let driveAuth = null;
let driveApi = null;
let driveSync = null;

let stt = null;
const heldLocks = new Map();

let fileIndex = null;
let updater = null; // 자동 업데이트 (updater.js) — 앱이 준비된 뒤
let linkPreviews = null;
let calendarFeeds = null; // 일정 탭이 구독하는 다른 캘린더 (.ics 주소)

let tutorial = { active: false, index: -1, memoId: null, praise: false };

// 단축키 관리 상태
const heldKeys = { quickMemo: null, magic: null };
let shortcutsPaused = false;

const shortcutKey = (name) => normalizeShortcuts(settings.shortcuts)[name];
const shortcutLabel = (name) => displayAccelerator(shortcutKey(name));

// ---------- 윈도우 관리자 (WindowManager) 인스턴스 ----------

const windowManager = new WindowManager({
  getVault: () => vault,
  onUpdateTray: () => updateTrayMenu(),
  onNoteOpened: (id) => noteOpened(id),
  getTutorial: () => tutorial,
  onTutorialEvent: (evt) => tutorialEvent(evt),
  onHoldLock: (id, session) => holdLock(id, session),
  getStt: () => stt,
  getDriveSync: () => driveSync,
  getFileIndex: () => fileIndex,
  isQuitting: () => quitting,
  getShortcutLabel: (name) => shortcutLabel(name),
});

// ---------- 메모 단축키 (Ctrl+Alt+1~9) ----------
// 정해 둔 메모를 어디서든: 내용을 클립보드로 복사 · 메모 창 띄우기 (메모 창 메뉴 › 단축키로 불러오기)

const memoHotkeys = new MemoHotkeys({
  settings,
  saveSettings,
  getVault: () => vault,
  onPress: (slot) => memoHotkeyPressed(slot),
  reserved: () => [{ key: shortcutKey('quickMemo'), name: SHORTCUT_NAMES.quickMemo }, { key: shortcutKey('magic'), name: SHORTCUT_NAMES.magic }],
});
windowManager.hotkeySlotOf = (id) => memoHotkeys.slotOf(id); // 목록 카드에 단축키 표시

async function memoHotkeyPressed(slot) {
  const bound = memoHotkeys.map[slot];
  const memo = bound && vault?.get(bound.id);
  if (!memo) {
    windowManager.showHud({ title: `${hotkeyLabel(slot)}: 메모를 찾지 못했어요`, body: '지웠거나 다른 메모 폴더의 메모예요', kind: 'warn' });
    return;
  }
  const title = memo.title || '제목 없음';
  let copied = false;
  if (bound.copy && !memo.needsPassword) {
    // 그 메모 창에서 막 고친 글까지 (저장 기다림 600ms 안에 눌러도)
    const win = windowManager.noteWins.get(bound.id);
    if (win && !win.isDestroyed()) {
      const flushed = win.webContents.executeJavaScript('window.__memokingFlush?.()', true).catch(() => {});
      await Promise.race([flushed, new Promise((r) => setTimeout(r, 800))]); // 저장이 막혀도 단축키는 바로
    }
    const text = hotkeyCopyText(vault.get(bound.id)?.body ?? memo.body);
    try {
      await writeClipboard({ text });
      copied = true;
    } catch (err) {
      console.error('메모 단축키 복사', err);
    }
  }
  // 잠긴 메모는 비밀번호를 넣어야 하니 복사 대신 창을 띄운다
  const show = bound.show || (bound.copy && !copied);
  // 복사도 했으면 창은 띄우되 포커스는 쓰던 앱에 — 바로 Ctrl+V 가 거기에 들어가게
  if (show) windowManager.revealNote(bound.id, { inactive: copied });
  // 붙여 넣는 법은 처음 몇 번만 (매일 수십 번 쓰는 사람에게는 군더더기)
  const tip = copied && (settings.hotkeyTips ?? 0) < 3;
  if (tip) {
    settings.hotkeyTips = (settings.hotkeyTips ?? 0) + 1;
    saveSettings();
  }
  if (copied) windowManager.showHud({ title: `“${title}” 내용을 복사했어요`, body: tip ? 'Ctrl+V 로 붙여 넣으세요' : '' });
  else if (bound.copy && memo.needsPassword) windowManager.showHud({ title: '잠긴 메모라 복사하지 않았어요', body: '비밀번호를 넣고 열어 주세요', kind: 'warn' });
  else if (bound.copy) windowManager.showHud({ title: '복사하지 못했어요', body: '다시 눌러 주세요', kind: 'warn' });
}

// ---------- 볼트(Vault) 연결 및 동기화 ----------

function openVault(dir) {
  vault?.close();
  vault = null;
  try {
    const next = new Vault(dir);
    next.on('changed', ({ ids, external, removed }) => {
      windowManager.pushList();
      driveSync?.request(3000);
      for (const id of external) windowManager.sendToNote(id, 'memo:external', next.get(id));
      for (const id of removed) windowManager.sendToNote(id, 'memo:removed');
      if (removed.length || ids.some((id) => memoHotkeys.slotOf(id))) memoHotkeys.refresh();
      showHandoff(external.filter((id) => !removed.includes(id)).map((id) => next.get(id)));
    });
    next.on('trashed', (id) => {
      windowManager.forgetLayer(id); // 테이프로 바탕화면에 붙여 둔 기억
      if (memoHotkeys.slotOf(id)) memoHotkeys.set(id, null); // 단축키는 놓아 다른 앱이 쓰게
    });
    next.on('indexed', (index) => windowManager.listWin?.webContents.send('vault:indexed', index.generatedAt));
    next.on('error', (err) => console.error('[vault]', err));
    next.open();
    vault = next;
    vaultError = null;
    showHandoff(recentlyUpdated(next.list()).map((m) => next.get(m.id)));
    settings.vaultPath = next.root;
    saveSettings();
    migrateV1();
    windowManager.loadStacks();
    if (app.isReady()) {
      windowManager.migrateWidgets(); // 예전 바탕화면 위젯 → 테이프 붙인 메모 창 (숨겨 시작해도 그 자리에)
      memoHotkeys.refresh(); // 다른 폴더의 메모 단축키
    }
    purgeTrash(vault);
    configureDrive();
  } catch (err) {
    console.error('메모 폴더 열기 실패', err);
    vaultError = '메모 폴더를 열지 못했어요. 폴더가 있는지, Google Drive가 연결돼 있는지 확인해 주세요.';
  }
  windowManager.listWin?.webContents.send('vault:opened', vaultInfo());
  windowManager.pushList();
  return vaultInfo();
}

function vaultInfo() {
  return { vaultPath: vault?.root ?? null, vaultError, suggestedPath: suggestedVaultPath(), version: app.getVersion() };
}

function showHandoff(memos) {
  const hit = pickHandoff(memos, { mine: 'pc', seen: handoffSeen, isOpen: (id) => windowManager.noteWins.has(id) });
  if (!hit) return;
  lastHandoff = { id: hit.memo.id, title: hit.memo.title, from: hit.from, at: Date.now() };
  windowManager.listWin?.webContents.send('memo:handoff', lastHandoff);
}

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

// ---------- 링크 미리보기 ----------

function getLinkPreviews() {
  linkPreviews ??= new LinkPreviews({
    fetch: (url, options) => net.fetch(url, options),
    userAgent: app.userAgentFallback.replace(/\s*(Electron|MemoKing)\/\S+/g, ''),
  });
  return linkPreviews;
}

// ---------- 예약 알림 (Alarms) ----------

function pushReminders() {
  windowManager.listWin?.webContents.send('reminders:changed');
  updateTrayMenu();
}

function fireReminder(memoId, reminder, info) {
  const memo = vault?.get(memoId);
  if (!memo) return;
  const { title, label, full } = alarmText(reminder, memo.title, info);
  const alarm = { reminderId: reminder.id, label: full, missed: Boolean(info.missed) };
  history?.add({ source: 'memoking', appId: APP_ID, app: '메모킹', title, body: label, memoId });

  if (reminder.action === 'open') {
    const existing = windowManager.noteWins.get(memoId);
    if (existing) existing.webContents.send('memo:alarm', alarm);
    else windowManager.pendingAlarms.set(memoId, alarm);
    const win = windowManager.openNote(memoId);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.moveTop();
      win.flashFrame(true);
      win.once('focus', () => win.flashFrame(false));
    }
  } else {
    showToast(memoId, memo, { ...alarm, title, label });
  }
  pushReminders();
}

function showToast(memoId, memo, alarm) {
  const preview = memo.locked ? '' : extractPreview(memo.body, 120);
  toast({
    memoId,
    title: alarm.title ?? memo.title,
    body: preview ? `${alarm.label}\n${preview}` : alarm.label,
    onClick: () => windowManager.revealNote(memoId),
  });
}

const alarms = createAlarmRunner({ getVault: () => vault, fire: fireReminder });

// ---------- 알림 보관함 & 팝업 지켜보기 ----------

function initHistory() {
  history = new NotificationHistory({
    dir: path.join(app.getPath('userData'), 'notification-history'),
    sourceDir: SMOKE ? path.join(os.tmpdir(), 'memoking-smoke', 'wpn') : undefined,
    selfAppId: APP_ID,
  });
  history.on('changed', () => windowManager.listWin?.webContents.send('history:changed'));
  history.on('error', (err) => console.warn('[알림 보관함]', err.message));
  history.setBlocked(Object.keys(settings.historyBlocked ?? {}));
  if (settings.historyEnabled) history.start();
  syncPopupWatch();
}

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

async function addPopupToHistory(p) {
  try {
    const appName = popupAppName(p.process);
    if (p.via === 'ocr' && p.ocrImage && fs.existsSync(p.ocrImage)) {
      try {
        const r = await windowManager.runOcr(p.ocrImage, p.ocrUnit);
        if (r.boxes?.length) { p.boxes = r.boxes; p.lines = r.lines; }
      } catch (err) {
        console.warn('[한글 OCR]', err.message);
      }
    }
    const byLayout = p.process === 'KakaoTalk' && p.via === 'ocr' && Array.isArray(p.boxes)
      ? kakaoEntry(p.boxes, { width: p.size?.w, height: p.size?.h, appName })
      : null;
    const entry = byLayout ?? popupToEntry(p.lines, { appName });
    if (!entry || !history) return;
    const now = Date.now();
    while (recentPopups.length && now - recentPopups[0].at > 5 * 60 * 1000) recentPopups.shift();
    if (isRepeat(recentPopups, { app: appName, ...entry }, now)) return;
    recentPopups.push({ app: appName, ...entry, at: now });
    const image = p.image ? history.keepImage(p.image) : null;
    history.add({ source: 'popup', appId: p.process, app: appName, ...entry, image, via: p.via ?? '' });
  } finally {
    if (p.image) fs.rm(p.image, { force: true }, () => {});
    if (p.ocrImage) fs.rm(p.ocrImage, { force: true }, () => {});
  }
}

function syncPopupWatch() {
  const on = settings.historyEnabled && !SMOKE;
  if (on) {
    popupWatcher ??= createPopupWatcher();
    popupWatcher.start();
  } else {
    popupWatcher?.stop();
    if (windowManager.ocrWin && !windowManager.ocrWin.isDestroyed()) windowManager.ocrWin.close();
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

function historyApps() {
  const blocked = settings.historyBlocked ?? {};
  const apps = new Map((history?.appList() ?? []).map((a) => [a.appId, { ...a, blocked: Boolean(blocked[a.appId]) }]));
  for (const [appId, a] of Object.entries(blocked)) {
    if (!apps.has(appId)) apps.set(appId, { appId, app: a, count: 0, blocked: true });
  }
  return [...apps.values()];
}

function historyToMemo(entryId) {
  const e = history?.get(entryId);
  if (!e || !vault) return null;
  const when = new Date(e.time).toLocaleString('ko-KR');
  const body = `# ${e.title || e.app}\n\n${e.body ? `${e.body}\n\n` : ''}> ${e.app} 알림, ${when}`;
  const id = vault.import({ body });
  windowManager.openNote(id);
  return id;
}

// ---------- Google Drive 직접 동기화 ----------

function initDrive() {
  driveAuth = new GoogleAuth({
    file: path.join(app.getPath('userData'), 'google-auth.json'),
    // 설치 파일에 넣은 것 → 이 PC 의 %APPDATA%\MemoKing 에 둔 것 (연결 정보 없이 빌드된 버전에서도 붙여 넣지 않게)
    bundledClient: [path.join(import.meta.dirname, 'google-client.json'), path.join(app.getPath('userData'), 'google-client.json')],
    fetch: (...args) => net.fetch(...args),
    openExternal: (url) => shell.openExternal(url),
    safeStorage,
  });
  driveApi = new DriveApi({ auth: driveAuth, fetch: (...args) => net.fetch(...args) });
  driveSync = new DriveSync({ api: driveApi, auth: driveAuth, stateDir: path.join(app.getPath('userData'), 'drive') });
  driveSync.on('status', (st) => {
    if (st.changed) vault?.scan();
    windowManager.listWin?.webContents.send('drive:status', driveInfo());
  });
  if (driveAuth.scopeUpgraded && settings.drive) {
    settings.drive = null;
    saveSettings();
  }
  configureDrive();
  // 예전(v0.41)의 Google 캘린더 상호 동기화는 없앴다 — 이 PC 에 남은 캘린더 로그인만 지운다
  //   (Google 쪽 허용은 Drive 와 같은 클라이언트라 거두지 않는다 — 거두면 Drive 연결도 끊긴다)
  fs.rm(path.join(app.getPath('userData'), 'google-calendar-auth.json'), { force: true }, () => {});
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
    reconnect: driveAuth?.scopeUpgraded ?? false,
    status: driveSync?.status ?? { state: 'off' },
    fullScope: driveAuth?.fullScope ?? false, // 외부 앱 메모 연동 (전체 드라이브 권한)
  };
}

// 폴더 고르기 · 자동 연결은 한 번에 하나만 — 두 번 눌러도 메모 폴더를 두 번 옮기거나 동기화가 겹치지 않게
let driveFolderBusy = null;
function oneAtATime(fn) {
  if (driveFolderBusy) return driveFolderBusy;
  driveFolderBusy = fn().finally(() => {
    driveFolderBusy = null;
  });
  return driveFolderBusy;
}

function useDriveFolder(folderId, folderName) {
  return oneAtATime(() => switchDriveFolder(folderId, folderName));
}

async function switchDriveFolder(folderId, folderName) {
  let root = vault?.root;
  if (!root || insideDriveForDesktop(root)) root = path.join(app.getPath('documents'), '메모킹');
  const moving = root !== vault?.root;
  if (moving) {
    const wins = [...windowManager.noteWins.values()].filter((w) => !w.isDestroyed());
    await Promise.all(wins.map((w) => new Promise((resolve) => {
      w.once('closed', resolve);
      setTimeout(resolve, 3000);
      w.close();
    })));
    if (vault?.root) copyVault(vault.root, root);
  }
  settings.drive = { folderId, folderName };
  saveSettings();
  if (moving) openVault(root);
  else configureDrive();
  const status = await driveSync.run();
  return { info: vaultInfo(), status, drive: driveInfo() };
}

const SYNC_FOLDER = '메모킹 동기화';
// 내 드라이브의 "메모킹 동기화" 를 찾거나 만들어 맞춘다 — 같은 이름이 여럿이면 늘 가장 먼저 만든 것 (PC · 휴대폰이 같은 폴더를 고르게)
function autoDriveFolder() {
  return oneAtATime(async () => {
    const folder = await findOrCreateDriveFolder('root', SYNC_FOLDER);
    return switchDriveFolder(folder.id, folder.name);
  });
}

// 같은 이름 폴더가 이미 있으면 그것 (새로 만들지 않는다) — 만드는 중에 또 부탁해도 하나만
const folderMaking = new Map();
function findOrCreateDriveFolder(parent, name) {
  if (!driveApi) return Promise.reject(new Error('Google Drive 를 쓸 수 없어요'));
  const key = `${parent}\u0000${name}`;
  if (!folderMaking.has(key)) {
    folderMaking.set(key, (async () => {
      const found = (await driveApi.findFolders(name, parent))[0];
      return found ? { ...found, existed: true } : { ...(await driveApi.createFolder(parent, name)), existed: false };
    })().finally(() => folderMaking.delete(key)));
  }
  return folderMaking.get(key);
}

// ---------- 받아쓰기 (STT) ----------

function holdLock(memoId, session) {
  clearTimeout(heldLocks.get(memoId)?.timer);
  const timer = setTimeout(() => heldLocks.delete(memoId), 30 * 60_000);
  timer.unref?.();
  heldLocks.set(memoId, { session, timer });
}

const sttOptions = () => ({ enabled: settings.stt?.enabled !== false, speaker: settings.stt?.speaker === true });

function initStt() {
  stt = createSttService({
    dir: process.env.MEMOKING_STT_DIR || path.join(app.getPath('userData'), 'stt'),
    workerPath: STT_WORKER,
    vendor: STT_VENDOR,
    fetch: (url) => net.fetch(url),
    getVault: () => vault,
    getOptions: sttOptions,
    onStatus: (status) => {
      for (const w of [windowManager.listWin, ...windowManager.noteWins.values()]) {
        if (w && !w.isDestroyed()) w.webContents.send('stt:status', status);
      }
    },
    onSpeakers: ({ memoId, src, text }) => {
      const win = windowManager.noteWins.get(memoId);
      if (win && !win.isDestroyed() && !vault?.get(memoId)?.needsPassword) {
        return win.webContents.send('stt:speakers', { src, text });
      }
      const held = heldLocks.get(memoId);
      heldLocks.delete(memoId);
      const opened = Boolean(held && vault?.get(memoId)?.needsPassword && vault.openLock(memoId, held.session));
      clearTimeout(held?.timer);
      const memo = vault?.get(memoId);
      const next = memo && !memo.needsPassword && replaceTranscript(memo.body, src, text);
      const r = next && next !== memo.body ? vault.save(memoId, next) : null;
      if (opened) vault.closeLock(memoId);
      if ((memo?.needsPassword || r?.refused) && held) {
        toast({ title: '말한 사람 나누기를 넣지 못했어요', body: '그사이 메모가 다른 기기에서 잠겨 바뀌었어요' });
      }
    },
  });
}

// ---------- 처음 실행 튜토리얼 ----------

function tutorialPayload() {
  const step = tutorial.active ? TUTORIAL_STEPS[tutorial.index] : null;
  if (!step) return null;
  const keys = (t) => (typeof t === 'string' ? withShortcuts(t, settings.shortcuts) : t);
  const text = step.noTape && !windowManager.canTape ? step.noTape : step.text; // 테이프를 못 쓰는 PC 에서는 왕관만
  return { ...step, title: keys(step.title), text: keys(text), index: tutorial.index, total: TUTORIAL_STEPS.length, praise: tutorial.praise };
}

function tutorialWin(step) {
  if (!step) return null;
  return step.win === 'note' ? windowManager.noteWins.get(tutorial.memoId) ?? null : windowManager.listWin;
}

function sendTutorial() {
  const payload = tutorialPayload();
  const target = tutorialWin(payload);
  for (const w of [windowManager.listWin, ...windowManager.noteWins.values()]) {
    if (w && !w.isDestroyed()) w.webContents.send('tutorial:step', w === target ? payload : null);
  }
}

function startTutorial() {
  if (!vault) return false;
  tutorial = { active: true, index: 0, memoId: null, praise: false };
  windowManager.createListWindow('memos');
  sendTutorial();
  return true;
}

function finishTutorial() {
  tutorial = { active: false, index: -1, memoId: null, praise: false };
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
  tutorial.praise = event !== 'next' && event === TUTORIAL_STEPS[tutorial.index]?.advance;
  tutorial.index = next;
  const step = TUTORIAL_STEPS[next];
  if (step.win === 'note' && !windowManager.noteWins.get(tutorial.memoId)) return tutorialEvent('note-closed');
  const w = step.win === 'list' ? windowManager.createListWindow('memos') : windowManager.noteWins.get(tutorial.memoId);
  if (w && !w.isDestroyed()) bringToFront(w);
  sendTutorial();
}

// ---------- 전역 단축키 ----------

function shortcutStatus(name) {
  const enabled = name === 'quickMemo' ? settings.quickMemo && process.platform === 'win32' : normalizeMagicSettings(settings.magic).enabled;
  const key = shortcutKey(name);
  return {
    key,
    label: displayAccelerator(key),
    isDefault: key === DEFAULT_SHORTCUTS[name],
    enabled,
    registered: Boolean(heldKeys[name]) && globalShortcut.isRegistered(key),
  };
}

function setShortcut(name, acc) {
  if (!(name in DEFAULT_SHORTCUTS)) return { ok: false, reason: 'invalid' };
  const next = acc ?? DEFAULT_SHORTCUTS[name];
  if (!isValidAccelerator(next)) return { ok: false, reason: 'invalid', status: shortcutStatus(name) };
  const other = name === 'quickMemo' ? 'magic' : 'quickMemo';
  if (next === shortcutKey(other)) return { ok: false, reason: 'same', other: SHORTCUT_NAMES[other], status: shortcutStatus(name) };
  // 메모 단축키(Ctrl+Alt+숫자)가 쓰는 키 — 단축키를 바꾸는 동안은 잠시 놓여 있으므로 잡은 키가 아니라 정해 둔 칸으로 본다
  if (Object.entries(memoHotkeys.map).some(([slot, b]) => hotkeyAccelerator(slot) === next && (!vault || vault.get(b.id)))) return { ok: false, reason: 'same', other: '메모 단축키', status: shortcutStatus(name) };
  // 메모 창 단축키가 쓰는 키를 전역으로 가져가면 그 기능이 모든 메모 창에서 멈춘다
  const inMemo = actionUsing(settings.keymap, comboFromAccelerator(next));
  if (inMemo) return { ok: false, reason: 'same', other: `메모 창의 '${inMemo.label}'`, status: shortcutStatus(name) };
  const prev = shortcutKey(name);
  const enabled = shortcutStatus(name).enabled;
  if (enabled && next !== prev) {
    if (!globalShortcut.register(next, () => {})) return { ok: false, reason: 'taken', label: displayAccelerator(next), status: shortcutStatus(name) };
    globalShortcut.unregister(next);
  }
  settings.shortcuts = { ...normalizeShortcuts(settings.shortcuts), [name]: next };
  saveSettings();
  if (name === 'quickMemo') registerQuickMemoKey();
  else registerMagicKey();
  memoHotkeys.register(); // 놓아 준 Ctrl+Alt+숫자를 메모 단축키가 다시 쓰게
  updateTrayMenu();
  // 설정 창 · 단축키 설정 창 어디서 바꿨든 둘 다 바로
  broadcast('shortcuts:changed');
  return { ok: true, status: shortcutStatus(name) };
}

function pauseShortcuts(on) {
  shortcutsPaused = Boolean(on);
  registerQuickMemoKey();
  registerMagicKey();
  memoHotkeys.pause(on);
}

function registerQuickMemoKey() {
  if (heldKeys.quickMemo) globalShortcut.unregister(heldKeys.quickMemo);
  heldKeys.quickMemo = null;
  if (!settings.quickMemo || process.platform !== 'win32' || shortcutsPaused) return false;
  const key = shortcutKey('quickMemo');
  const ok = globalShortcut.register(key, () => onQuickMemoKey());
  if (!ok) console.warn(`${displayAccelerator(key)} 를 다른 프로그램이 쓰고 있어 등록하지 못했습니다`);
  else {
    heldKeys.quickMemo = key;
    windowManager.captureHelper.start();
  }
  return ok;
}

function registerMagicKey() {
  if (heldKeys.magic) globalShortcut.unregister(heldKeys.magic);
  heldKeys.magic = null;
  if (!normalizeMagicSettings(settings.magic).enabled || shortcutsPaused) return false;
  const key = shortcutKey('magic');
  const ok = globalShortcut.register(key, () => windowManager.showMagic());
  if (!ok) console.warn(`${displayAccelerator(key)} 를 다른 프로그램이 쓰고 있어 등록하지 못했습니다`);
  else heldKeys.magic = key;
  return ok;
}

function setMagicSettings(next) {
  settings.magic = normalizeMagicSettings(next);
  saveSettings();
  registerMagicKey();
  syncFileIndex();
  if (!settings.magic.enabled && windowManager.magicWin && !windowManager.magicWin.isDestroyed()) windowManager.magicWin.hide();
  if (windowManager.magicWin && !windowManager.magicWin.isDestroyed()) {
    windowManager.magicWin.webContents.send('magic:modules-changed', magicChips(settings.magic).map(({ id, name, description, on }) => ({ id, name, description, on })));
  }
  return settings.magic;
}

function setQuickMemo(on) {
  settings.quickMemo = Boolean(on);
  saveSettings();
  if (!registerQuickMemoKey()) windowManager.captureHelper.stop();
  updateTrayMenu();
  return appSettings(vault, fileIndex, shortcutStatus, shortcutLabel).quickMemo;
}

const onQuickMemoKey = createDoublePress({
  ms: 350,
  onSingle: () => windowManager.quickMemo(),
  onDouble: () => windowManager.startAreaCapture(),
});

function syncFileIndex() {
  const on = !SMOKE && activeModules(settings.magic).some((m) => m.id === 'files');
  if (on) {
    // 전자포대 폴더는 맨 먼저 훑는다 (G: 같은 뒤쪽 드라이브는 목록이 차면 덜 들어가므로) · 생기는 파일은 곧바로 목록에
    const wrapperDir = () => windowManager.opmsSettings().wrapperDir;
    fileIndex ??= new FileIndex({
      cacheFile: path.join(app.getPath('userData'), 'file-index.json'),
      roots: () => [...(fs.existsSync(wrapperDir()) ? [{ dir: wrapperDir() }] : []), ...defaultRoots()],
    });
    fileIndex.start();
    fileIndex.watch([wrapperDir()]);
  } else fileIndex?.stop();
}

setInterval(() => {
  if (shortcutsPaused) return;
  const before = [shortcutStatus('quickMemo').registered, shortcutStatus('magic').registered].join();
  if (shortcutStatus('quickMemo').enabled && !shortcutStatus('quickMemo').registered) registerQuickMemoKey();
  if (shortcutStatus('magic').enabled && !shortcutStatus('magic').registered) registerMagicKey();
  if ([...memoHotkeys.failed].some((slot) => !memoHotkeys.reservedBy(slot))) memoHotkeys.register(); // 다른 앱이 쓰던 숫자를 놓았으면 이제 잡는다
  if ([shortcutStatus('quickMemo').registered, shortcutStatus('magic').registered].join() !== before) {
    updateTrayMenu();
    windowManager.listWin?.webContents.send('shortcuts:changed');
  }
}, 60_000).unref?.();

// ---------- 알림 영역 (트레이) 및 점프 목록 ----------

function createTray() {
  tray = new Tray(process.platform === 'win32' ? APP_ICON : APP_ICON_PNG);
  tray.setToolTip('메모킹: 누르면 메모 목록이 열려요');
  tray.on('click', () => windowManager.createListWindow());
  tray.on('double-click', () => windowManager.createListWindow());
  updateTrayMenu();
}

function noteOpened(id) {
  settings.recentOpened = pushRecent(settings.recentOpened, id);
  saveSettings();
  updateJumpList();
}

function updateJumpList() {
  if (process.platform !== 'win32' || SMOKE) return;
  clearTimeout(jumpTimer);
  jumpTimer = setTimeout(() => {
    const recent = (settings.recentOpened ?? []).map((id) => vault?.get(id)).filter(Boolean);
    const prefix = app.isPackaged ? [] : [app.getAppPath()];
    const categories = jumpListCategories(recent, { program: process.execPath, prefix });
    const sig = JSON.stringify(categories);
    if (sig === lastJumpList) return;
    try {
      const res = app.setJumpList(categories);
      lastJumpList = sig;
      if (res && res !== 'ok') console.warn('점프 목록:', res);
    } catch (err) {
      console.error('점프 목록을 만들지 못했어요', err);
    }
  }, 800);
}

function handleLaunch(argv) {
  const act = launchAction(argv);
  if (!act) return false;
  if (act.kind === 'list') windowManager.createListWindow();
  else if (act.kind === 'new') {
    if (!vault) windowManager.createListWindow();
    else windowManager.createNote({});
  } else if (act.kind === 'memo') {
    if (vault?.get(act.id)) windowManager.revealNote(act.id);
    else windowManager.createListWindow();
  }
  return true;
}

function updateTrayMenu() {
  updateJumpList();
  if (!tray || tray.isDestroyed()) return;
  const recent = vault?.list().slice(0, 5) ?? [];
  trayMenuTemplate = [
    { label: '메모 목록 열기', click: () => windowManager.createListWindow() },
    { label: '새 메모', enabled: Boolean(vault), click: () => windowManager.createNote({}) },
    { label: '화면 캡처로 새 메모', enabled: Boolean(vault), click: () => windowManager.startAreaCapture() },
    { label: '복사해 둔 내용으로 새 메모', enabled: Boolean(vault), click: () => windowManager.quickMemo({ copy: false }) },
    { type: 'separator' },
    // 들여 쓴 흐린 머리말 대신 하위 메뉴 (Windows 메뉴의 "최근 항목" 처럼)
    {
      label: '최근 메모',
      submenu: recent.length
        ? recent.map((m) => ({ label: shorten(m.title), click: () => windowManager.openNote(m.id) }))
        : [{ label: '없음', enabled: false }],
    },
    { type: 'separator' },
    { label: '일정', click: () => windowManager.createListWindow('reminders') }, // 목록 창의 탭 이름과 같게
    { label: '알림 보관함', click: () => windowManager.createListWindow('history') },
    { label: '열린 메모 모두 앞으로', enabled: windowManager.noteWins.size > 0, click: () => windowManager.showAllNotes() },
    { label: '메모 폴더 열기', enabled: Boolean(vault), click: () => shell.openPath(vault.root) },
    { type: 'separator' },
    {
      label: `빠른 메모 ${shortcutLabel('quickMemo')} (두 번: 화면 캡처)${settings.quickMemo && !shortcutStatus('quickMemo').registered ? ' — 다른 앱이 쓰는 중' : ''}`,
      type: 'checkbox',
      checked: settings.quickMemo && shortcutStatus('quickMemo').registered,
      click: (item) => setQuickMemo(item.checked),
    },
    {
      label: autoStartAvailable() ? 'PC를 켜면 메모킹도 함께 켜기' : 'PC를 켜면 메모킹도 함께 켜기 (설치한 메모킹에서)',
      type: 'checkbox',
      checked: getAutoStart(),
      enabled: autoStartAvailable(),
      click: (item) => setAutoStart(item.checked, updateTrayMenu),
    },
    { type: 'separator' },
    { label: '사용법 보기', enabled: Boolean(vault), click: startTutorial },
    { label: '메모킹 종료', click: quitApp },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate));
}

function quitApp() {
  quitting = true;
  app.quit();
}

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

// 6시간마다 휴지통 자동 비우기
setInterval(() => purgeTrash(vault), 6 * 60 * 60 * 1000).unref?.();

// ---------- 시작 및 초기화 ----------

app.on('second-instance', (_e, argv) => {
  if (!handleLaunch(argv)) windowManager.createListWindow();
});

// 오른쪽 클릭 메뉴 (모든 창 — 메모 글 · 글 칸 · 링크 · 그림 · 맞춤법). 무엇을 넣는지는 context-menu.js
app.on('web-contents-created', (_e, wc) => {
  wc.on('context-menu', (_event, params) => {
    const win = BrowserWindow.fromWebContents(wc);
    // 메모 폴더 안 그림(memoking://vault/…)만 파일로 저장할 수 있다 (웹 그림은 복사만)
    const src = /^memoking:\/\/vault\//.test(params.srcURL ?? '') ? vault?.resolve(decodeURIComponent(new URL(params.srcURL).pathname.replace(/^\/+/, ''))) : null;
    const isNote = [...windowManager.noteWins.values()].some((w) => !w.isDestroyed() && w.webContents === wc);
    const template = contextMenuTemplate(params, {
      openLink: (url) => openWebPage(url),
      copyText: (text) => clipboard.writeText(text),
      copyImage: () => wc.copyImageAt(params.x, params.y),
      saveImage: src && fs.existsSync(src) ? async () => {
        const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.basename(src)) });
        if (!r.canceled && r.filePath) fs.copyFileSync(src, r.filePath);
      } : null,
      // 메모 창의 편집기는 서식 없이 붙여넣기 · 서식 지우기를 직접 한다 (note.js 가 'edit:*' 를 받는다). 그 밖의 칸은 창의 기본 동작
      pastePlain: isNote ? async () => wc.send('edit:paste-plain', await clipboard.readText()) : null, // readText 는 약속(Promise)을 돌려준다
      clearFormat: isNote && !/^(input-|text-area)/.test(params.formControlType ?? '') ? () => wc.send('edit:clear-format') : null,
      replaceMisspelling: (word) => wc.replaceMisspelling(word),
      addToDictionary: (word) => wc.session.addWordToSpellCheckerDictionary(word),
    });
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win ?? undefined });
  });
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  app.setAppUserModelId(APP_ID);

  if (app.isPackaged) {
    try {
      const mcp = mcpStatus();
      if (mcp.stale && !mcp.broken) mcpConnect(true);
    } catch (err) {
      console.warn('AI 비서 연결 확인 실패', err);
    }
  }

  const isNoteWindow = (wc) => {
    try {
      const url = new URL(wc?.getURL() ?? '');
      return url.protocol === 'file:' && url.pathname.endsWith('/note.html');
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const types = details?.mediaTypes ?? [];
    callback(permission === 'media' && types.length > 0 && types.every((t) => t === 'audio') && isNoteWindow(wc));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => (
    permission === 'media' && (details?.mediaType ?? 'audio') === 'audio' && isNoteWindow(wc)
  ));

  registerVaultProtocol(() => vault, () => history);
  initStt();

  calendarFeeds = new CalendarFeeds({
    dir: path.join(app.getPath('userData'), 'calendars'),
    fetch: (...args) => net.fetch(...args),
    getList: () => settings.calendars ?? [],
    setList: (list) => {
      settings.calendars = list;
      saveSettings();
    },
  });
  registerIpc({
    calendarFeeds,
    windowManager,
    memoHotkeys,
    getVault: () => vault,
    openVault,
    vaultInfo,
    suggestedVaultPath,
    appSettings: () => appSettings(vault, fileIndex, shortcutStatus, shortcutLabel),
    settings,
    saveSettings,
    alarms,
    pushReminders,
    getHistory: () => history,
    historyApps,
    setHistoryEnabled,
    blockHistoryApp,
    unblockHistoryApp,
    historyToMemo,
    getDriveAuth: () => driveAuth,
    getDriveApi: () => driveApi,
    getDriveSync: () => driveSync,
    driveInfo,
    useDriveFolder,
    autoDriveFolder,
    findOrCreateDriveFolder,
    configureDrive,
    setAutoStart: (on) => setAutoStart(on, updateTrayMenu),
    setQuickMemo,
    setShortcut,
    pauseShortcuts,
    setMagicSettings,
    mcpConnect,
    mcpStatus,
    mcpSnippet,
    getFileIndex: () => fileIndex,
    startTutorial,
    tutorialPayload,
    getUpdater: () => updater,
    updateState: () => updateState(),
    tutorialWin,
    tutorialEvent,
    purgeTrash,
    TRASH_DAYS,
    getStt: () => stt,
    sttOptions,
    getLinkPreviews,
    openWebPage,
    openVaultFile,
    writeClipboard,
    fetchRemoteImage,
    getLastHandoff: () => lastHandoff,
  });

  try {
    createTray();
  } catch (err) {
    console.error('알림 영역 아이콘을 만들지 못했어요', err);
  }

  nativeTheme.on('updated', () => {
    windowManager.listWin?.setTitleBarOverlay(titleBarOverlay());
    for (const [id, win] of windowManager.noteWins) {
      win.setBackgroundColor(noteBg(vault?.get(id)?.color));
    }
  });

  for (const w of BrowserWindow.getAllWindows()) w.on('session-end', flushOpmsFiles);
  app.on('browser-window-created', (_e, w) => w.on('session-end', flushOpmsFiles));
  powerMonitor.on('shutdown', flushOpmsFiles);

  powerMonitor.on('resume', () => {
    alarms.tick();
    driveSync?.request(3000);
    setTimeout(() => updater?.checkIfStale(), 10_000).unref?.(); // 인터넷이 다시 붙을 즈음
  });
  powerMonitor.on('unlock-screen', () => {
    alarms.tick();
    updater?.checkIfStale();
  });

  if (SMOKE) {
    const { prepareSmoke, runSmoke } = await import(
      process.argv.includes('--tutorial')
        ? './smoke-tutorial.js'
        : process.argv.includes('--new')
          ? './smoke-new.js'
          : './smoke.js'
    ).catch((err) => {
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
      getList: () => windowManager.listWin,
      noteWins: windowManager.noteWins,
      getVault: () => vault,
      createListWindow: (tab) => windowManager.createListWindow(tab),
      getGhost: () => windowManager.ghostWin,
      getTray: () => tray,
      getTrayMenu: () => trayMenuTemplate,
      alarms,
      smokeToasts,
      getHistory: () => history,
      appSettings: () => appSettings(vault, fileIndex, shortcutStatus, shortcutLabel),
      quickMemo: (opts) => windowManager.quickMemo(opts),
      registerQuickMemoKey,
      getCapturePoint: () => windowManager.lastCapturePoint,
      smokeOpened,
      smokeConfirmAnswers,
      getStacks: () => windowManager.stacks,
      isInking: (id) => windowManager.inkingWins.has(windowManager.noteWins.get(id)),
      trackWindowDrag: (id, pt) => windowManager.trackWindowDrag(id, pt),
      endWindowDrag: (id) => windowManager.endWindowDrag(id),
      stackInto: (targetId, movingId) => windowManager.stackInto(targetId, movingId),
      getTabTear: () => windowManager.tabTear,
      getSettings: () => settings,
      stickers: windowManager.stickers,
      reloadSettings: loadSettings,
      installMark,
      startAreaCapture: (opts) => windowManager.startAreaCapture(opts),
      getAreaCapture: () => windowManager.areaCapture,
      smokeClipboard: windowManager.smokeClipboard,
      onQuickMemoKey,
      createPopupWatcher,
      smokePdf: windowManager.smokePdf,
      getPdfWin: () => windowManager.pdfWin,
      openPdfWindow: (id, parent) => windowManager.openPdfWindow(id, parent),
      startTutorial,
      getTutorial: () => tutorial,
      captureToMemo: (dir, info, pt) => windowManager.captureToMemo(dir, info, pt),
      smokeToastsList: smokeToasts,
      getTitleBarOverlay: () => titleBarOverlay(),
      showMagic: () => windowManager.showMagic(),
      getMagic: () => windowManager.magicWin,
      getFinder: () => windowManager.finderWin,
      useFileIndex: (idx) => { fileIndex = idx; },
      getOpms: () => windowManager.opmsWin,
      memoHotkeys,
      smokeHud: windowManager.smokeHud,
      windowManager,
    });
    return;
  }

  loadSettings();
  initHistory();
  initDrive();

  if (autoStartAvailable() && !settings.autoStartSet) setAutoStart(true, updateTrayMenu);
  if (settings.vaultPath) openVault(settings.vaultPath);

  const launched = launchAction(process.argv);
  if (!HIDDEN_START || !vault) {
    if (launched?.kind !== 'memo' || !vault?.get(launched.id)) windowManager.createListWindow();
  }
  for (const id of [...settings.openNotes]) {
    // 테이프 메모는 바탕화면 층에 조용히 (로그인 때 쓰던 앱의 포커스를 빼앗지 않게)
    const inactive = windowManager.layerOf(id) === 'bottom';
    if (!windowManager.openNote(id, { inactive })) settings.openNotes = settings.openNotes.filter((x) => x !== id);
  }
  if (launched && launched.kind !== 'list') handleLaunch(process.argv);
  alarms.startup();
  alarms.start();
  registerQuickMemoKey();
  registerMagicKey();
  memoHotkeys.register();
  migrateOpmsSettings();
  syncFileIndex();
  updateTrayMenu();
  if (vault && !settings.tutorialDone && !HIDDEN_START) startTutorial();
  updater.start();
});

// ---------- OPMS 설정 옮기기 (0.39.0) ----------
// 서버 주소 · 전자포대 폴더를 코드에서 뺐다 (설치 파일이 공개 저장소에 올라가므로). 예전부터 쓰던 PC 는
//   이 PC 의 받은 전자포대 기록에서 그 값을 찾아 설정으로 옮기고, 찾지 못하면 한 번 알려 설정에서 넣게 한다
function migrateOpmsSettings() {
  if (settings.opmsMigrated) return;
  settings.opmsMigrated = true;
  if (!settings.opms?.host || !settings.opms?.wrapperDir) {
    const found = recoverOpmsSettings(path.join(app.getPath('userData'), 'opms-files.json'));
    if (found) {
      settings.opms = {
        ...settings.opms,
        host: settings.opms?.host || found.host,
        ...(settings.opms?.wrapperDir || !fs.existsSync(found.wrapperDir) ? {} : { wrapperDir: found.wrapperDir }),
      };
    }
  }
  saveSettings();
  const opmsOn = activeModules(settings.magic).some((m) => m.id === 'opms');
  if (!normalizeOpmsHost(settings.opms?.host) && settings.opmsIntroduced && opmsOn && !SMOKE) {
    toast({
      title: 'OPMS 서버 주소를 한 번 넣어 주세요',
      body: '보안을 위해 서버 주소를 설치 파일에서 뺐어요. 설정 › 매직키 › OPMS 연결에서 넣으면 돼요',
      onClick: () => windowManager.createListWindow('memos'),
    });
  }
}

// ---------- 자동 업데이트 ----------
// 화면은 목록 창(설정 › 업데이트 · 새 버전 대화 상자). 목록 창이 없으면 Windows 알림 → 누르면 목록 창을 열어 보여 준다
function updateWin() {
  const w = windowManager.listWin;
  return w && !w.isDestroyed() ? w : null;
}
/** 목록 창이 물어볼 때: 지금 상태 + 대화 상자를 띄울지 (숨겨 둔 버전이면 띄우지 않음) */
function updateState() {
  const st = updater?.state ?? { status: 'idle' };
  // "나중에" 를 고른 버전은 24시간 다시 띄우지 않는다 (받아 둔 뒤 "나중에 (끝낼 때 설치)" 도)
  const ask = (st.status === 'ready' || st.status === 'available') && !isSnoozed(settings.updateSnooze, st.version);
  return { ...st, ask, current: app.getVersion(), enabled: Boolean(updater?.enabled) };
}
updater = new Updater({
  packaged: app.isPackaged && !SMOKE,
  settings,
  saveSettings: () => saveSettings(),
  send: (channel, payload) => {
    let w = updateWin();
    // 새 버전 · 받기 끝: 목록 창이 없거나 숨어(최소화) 있으면 띄워서 알린다 — 쓰던 창의 입력은 뺏지 않게
    if ((channel === 'update:available' || channel === 'update:ready') && (!w || !w.isVisible() || w.isMinimized())) {
      const fresh = !w;
      w = windowManager.createListWindow(null, { inactive: true });
      if (fresh) return Boolean(w); // 새 창은 열리며 상태를 물어 대화 상자를 띄운다 (updateState 의 ask)
    }
    if (!w) return false;
    w.webContents.send(channel, { ...payload, current: app.getVersion() });
    return true;
  },
  notify: (t) => toast({ title: t.title, body: t.body, onClick: () => windowManager.createListWindow('memos') }),
  // 재시작 전에: 열린 메모 창의 쓰던 글을 바로 저장하고 설정도 지금 쓴다
  beforeInstall: async () => {
    quitting = true;
    // 설치를 시작하지 못해 앱이 그대로 남으면(설치 파일이 막힘 등) 다시 평소대로 (창을 닫으면 알림 영역으로, 알림 도우미도 다시)
    setTimeout(() => {
      quitting = false;
      syncPopupWatch();
    }, 20_000).unref?.();
    await Promise.all([...windowManager.noteWins.values()].filter((w) => !w.isDestroyed())
      .map((w) => w.webContents.executeJavaScript('window.mkFlushSync?.()', true).catch(() => {})));
    saveSettings(true);
    // 설치 파일이 이전 설치 폴더를 지우려면 메모킹이 띄운 PowerShell 도우미(알림 · 창 층 · 클립보드)가 다 꺼져 있어야 한다 —
    //   남아 있으면 "이전 설치 파일을 지우지 못했어요(Failed to uninstall old application files)" 로 업데이트가 멈춘다
    await stopHelpers();
  },
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (quitting) return;
  showTrayNoticeOnce();
});

// 메모킹이 띄운 PowerShell 도우미를 모두 끈다 (끝날 때 · 업데이트 설치 직전). 꺼질 시간을 조금 준다
async function stopHelpers() {
  popupWatcher?.stop();
  windowManager.topWatch.stop();
  windowManager.captureHelper.stop();
  windowManager.desktopPin.stop();
  await new Promise((resolve) => setTimeout(resolve, 700));
}

app.on('will-quit', () => {
  popupWatcher?.stop(); // 예전에는 이것만 빠져 알림 도우미가 앱이 끝난 뒤에도 남아 설치 폴더를 붙잡았다
  updater?.stop();
  flushOpmsFiles();
  stt?.close();
  windowManager.topWatch.stop();
  globalShortcut.unregisterAll();
  windowManager.captureHelper.stop();
  windowManager.desktopPin.stop();
  alarms.stop();
  history?.stop();
  history?.save(true);
  tray?.destroy();
  vault?.close();
  saveSettings(true);
});
