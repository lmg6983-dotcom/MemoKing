// Electron 메인 프로세스 — 앱 초기화, 시스템 트레이, 전역 단축키, 백그라운드 서비스 오케스트레이션.
import {
  app, BrowserWindow, globalShortcut, nativeImage, nativeTheme, net,
  powerMonitor, protocol, safeStorage, session, shell, Tray, Menu,
} from 'electron';
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
import { FileIndex } from './file-index.js';
import { jumpListCategories, launchAction, pushRecent } from './jump-list.js';
import { flushOpmsFiles } from './opms.js';
import { createDoublePress } from './double-press.js';
import { MemoHotkeys } from './memo-hotkeys.js';
import { hotkeyCopyText, hotkeyLabel, hotkeyAccelerator } from '../app/js/core/memo-hotkeys.js';
import { TUTORIAL_STEPS, advanceTutorial } from '../app/js/core/tutorial.js';
import { toLocalIso, extractPreview } from '../app/js/core/memo-file.js';
import { alarmText } from '../app/js/core/reminders.js';

import {
  APP_DIR, APP_ICON, APP_ICON_PNG, ASSETS_DIR,
  noteBg, titleBarOverlay, bringToFront,
} from './window-utils.js';

import {
  SMOKE, APP_ID, LOGIN_ARGS, STT_WORKER, STT_VENDOR, POPUP_HELPER,
  settings, loadSettings, saveSettings, installMark, suggestedVaultPath,
  purgeTrash, autoStartAvailable, getAutoStart, setAutoStart, appSettings,
  TRASH_DAYS, openWebPage, openVaultFile, toast, smokeToasts, smokeOpened,
  smokeConfirmAnswers, writeClipboard, fetchRemoteImage, registerVaultProtocol,
  mcpStatus, mcpConnect, mcpSnippet, shorten,
} from './utils.js';

import { WindowManager } from './window-manager.js';
import { registerIpc } from './ipc-handlers.js';

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
let linkPreviews = null;

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
      windowManager.refreshWidgets([...new Set([...ids, ...removed])]);
      if (removed.length || ids.some((id) => memoHotkeys.slotOf(id))) memoHotkeys.refresh();
      showHandoff(external.filter((id) => !removed.includes(id)).map((id) => next.get(id)));
    });
    next.on('trashed', (id) => {
      windowManager.removeWidget(id);
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
      windowManager.restoreWidgets(); // 바탕화면 위젯 — 숨겨 시작해도(로그인 때 자동 실행) 그 자리에
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
    bundledClient: path.join(import.meta.dirname, 'google-client.json'),
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
  };
}

async function useDriveFolder(folderId, folderName) {
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
async function autoDriveFolder() {
  const found = (await driveApi.folders('root')).find((f) => f.name === SYNC_FOLDER);
  const folder = found ?? await driveApi.createFolder('root', SYNC_FOLDER);
  return useDriveFolder(folder.id, folder.name);
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
  return { ...step, title: keys(step.title), text: keys(step.text), index: tutorial.index, total: TUTORIAL_STEPS.length, praise: tutorial.praise };
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
    fileIndex ??= new FileIndex({ cacheFile: path.join(app.getPath('userData'), 'file-index.json') });
    fileIndex.start();
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
    { label: '최근 메모', enabled: false },
    ...(recent.length
      ? recent.map((m) => ({ label: `   ${shorten(m.title)}`, click: () => windowManager.openNote(m.id) }))
      : [{ label: '   없음', enabled: false }]),
    { type: 'separator' },
    { label: '알림 예약', click: () => windowManager.createListWindow('reminders') },
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

  registerIpc({
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
  });
  powerMonitor.on('unlock-screen', () => alarms.tick());

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
    if (!windowManager.openNote(id)) settings.openNotes = settings.openNotes.filter((x) => x !== id);
  }
  if (launched && launched.kind !== 'list') handleLaunch(process.argv);
  alarms.startup();
  alarms.start();
  registerQuickMemoKey();
  registerMagicKey();
  memoHotkeys.register();
  syncFileIndex();
  updateTrayMenu();
  if (vault && !settings.tutorialDone && !HIDDEN_START) startTutorial();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (quitting) return;
  showTrayNoticeOnce();
});

app.on('will-quit', () => {
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
