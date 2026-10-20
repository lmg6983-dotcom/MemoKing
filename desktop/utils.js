// 데스크탑 유틸리티 — 설정 관리, 클립보드, 외부 링크/파일 실행, 알림(토스트), MCP 연동, 커스텀 프로토콜 등.
import {
  app, clipboard, dialog, nativeImage, net, Notification, protocol, shell,
} from 'electron';
import * as electronApi from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isProgramFile } from '../app/js/core/file-kinds.js';
import { imageExtFromType, imageExtFromUrl, MAX_REMOTE_IMAGE_BYTES } from '../app/js/core/remote-images.js';
import { normalizeMagicSettings } from '../app/js/core/magic-modules.js';
import { APP_DIR, APP_ICON_PNG } from './window-utils.js';
import { cleanOverrides } from '../app/js/core/keymap.js';
import { normalizeHours } from '../app/js/core/work-hours.js';

export const SMOKE = process.argv.includes('--smoke');
export const APP_ID = 'com.memoking.desktop';
export const LOGIN_ARGS = ['--hidden'];

const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
export const STT_WORKER = unpacked(path.join(import.meta.dirname, 'stt', 'stt-worker.js'));
export const STT_VENDOR = unpacked(path.join(import.meta.dirname, 'vendor'));
export const POPUP_HELPER = path.join(import.meta.dirname, '..', 'scripts', 'popup-watch.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
export const CLIPBOARD_HELPER = path.join(import.meta.dirname, '..', 'scripts', 'clipboard-helper.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// ---------- 설정 ----------

export const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

export const settings = {
  vaultPath: null, openNotes: [], noteBounds: {}, onTop: {}, listBounds: null, migratedV1: false,
  viewCounts: {}, // 메모 id → 이 PC 에서 메모 창이 보인 횟수 (목록 "많이 본 순")
  historyEnabled: false,
  autoStartSet: false,
  quickMemo: true,
  tutorialDone: false,
  trashDays: 30,
  listOnTop: false,
  historyBlocked: {},
  drive: null,
  fitTables: true,
  linkPreviews: true,
  autoTags: true,
  magic: undefined,
  magicPos: null,
  shortcuts: undefined,
  keymap: {}, // 메모 창 단축키 중 바꾼 것 (app/js/core/keymap.js)
  mode: 'life', // 메모킹 Work / Life — 지금 보는 모드 (새 메모도 이 모드로)
  workHours: undefined, // 업무 시간 · 저절로 바꾸기 · 퇴근 뒤 조용히 (core/work-hours.js)
  workLife: undefined, // Work / Life 나누기 — 정한 적 없으면 Work 메모가 있을 때만 켬 (main.js openVault)
  mcp: undefined,
};

let settingsTimer = null;

// 지금 설치를 알아보는 표시: 버전 + 앱 파일을 설치한 때
export function installMark() {
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

export function loadSettings() {
  try {
    const loaded = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    Object.assign(settings, loaded);
    if (!('tutorialDone' in loaded)) settings.tutorialDone = true;
    if (settings.tutorialInstall !== installMark()) settings.tutorialDone = false;
    if (!settings.opmsIntroduced && settings.magic?.modules) {
      settings.magic = { ...settings.magic, modules: { ...settings.magic.modules, opms: true } };
      settings.opmsIntroduced = true;
    }
  } catch {
    // 첫 실행
  }
}

export function saveSettings(now = false) {
  clearTimeout(settingsTimer);
  const write = () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  };
  if (now) write();
  else settingsTimer = setTimeout(write, 500);
}

// Google Drive 가 있으면 그 안의 "메모킹" 폴더를 추천한다.
export function suggestedVaultPath() {
  const drives = ['G:\\내 드라이브', 'G:\\My Drive', path.join(os.homedir(), 'Google Drive'), path.join(os.homedir(), 'My Drive')];
  const base = drives.find((d) => fs.existsSync(d)) ?? app.getPath('documents');
  return path.join(base, '메모킹');
}

// 휴지통 자동 비우기
export const TRASH_DAYS = [0, 7, 30, 90, 365];

export function purgeTrash(vault) {
  if (!vault || !(settings.trashDays > 0)) return null;
  try {
    const r = vault.emptyTrash({ olderThanDays: settings.trashDays });
    if (r.memos || r.files) console.log(`[휴지통] 오래된 메모 ${r.memos}개와 첨부 ${r.files}개를 영구 삭제`);
    return r;
  } catch (err) {
    console.error('휴지통 비우기 실패', err);
    return null;
  }
}

// Windows 시작 시 자동 실행
export const autoStartAvailable = () => app.isPackaged && process.platform === 'win32';
export const getAutoStart = () => autoStartAvailable() && app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;

export function setAutoStart(on, onUpdateTray) {
  if (!autoStartAvailable()) return false;
  app.setLoginItemSettings({ openAtLogin: Boolean(on), args: LOGIN_ARGS });
  settings.autoStartSet = true;
  saveSettings();
  onUpdateTray?.();
  return getAutoStart();
}

export function appSettings(vault, fileIndex, shortcutStatus, shortcutLabel) {
  return {
    trashDays: settings.trashDays,
    trashCount: vault?.trashList().length ?? 0,
    autoStart: { available: autoStartAvailable(), enabled: getAutoStart() },
    historyEnabled: settings.historyEnabled,
    quickMemo: {
      enabled: settings.quickMemo,
      registered: shortcutStatus('quickMemo').registered,
      key: shortcutLabel('quickMemo'),
    },
    shortcuts: {
      quickMemo: shortcutStatus('quickMemo'),
      magic: shortcutStatus('magic'),
    },
    fitTables: settings.fitTables !== false,
    linkPreviews: settings.linkPreviews !== false,
    autoTags: settings.autoTags !== false,
    mode: settings.mode === 'work' ? 'work' : 'life',
    workLife: settings.workLife === true, // Work / Life 나누기 (꺼져 있으면 모든 메모가 한 목록)
    workHours: normalizeHours(settings.workHours),
    keymap: cleanOverrides(settings.keymap),
    magic: normalizeMagicSettings(settings.magic),
    magicIndex: fileIndex?.status() ?? null,
    mcp: mcpStatus(),
    version: app.getVersion(),
  };
}

// ---------- 링크·파일 열기 및 자동 점검용 상태 ----------
export const smokeOpened = [];
export const smokeConfirmAnswers = [];

export function openWebPage(url) {
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

export async function openVaultFile(file, win) {
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
  return shell.openPath(file);
}

// ---------- Windows 알림(토스트) ----------
export const liveToasts = new Set();
export const MAX_LIVE_TOASTS = 50;
export const smokeToasts = [];

export function toast(t) {
  if (SMOKE) {
    smokeToasts.push(t);
    return true;
  }
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: t.title, body: t.body, icon: APP_ICON_PNG });
  n.on('failed', () => {
    liveToasts.delete(n);
    t.onFail?.();
  });
  n.on('click', () => {
    liveToasts.delete(n);
    t.onClick?.();
  });
  liveToasts.add(n);
  while (liveToasts.size > MAX_LIVE_TOASTS) liveToasts.delete(liveToasts.values().next().value);
  n.show();
  return true;
}

// ---------- 클립보드 도우미 ----------
export async function writeClipboard({ png = null, text = null, html = null }) {
  if (png) {
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) throw new Error('그림을 읽지 못했어요. 다른 그림으로 다시 해 주세요');
    png = image.toPNG();
  }
  const Item = electronApi.ClipboardItem;
  if (Item) {
    const parts = {};
    if (png) parts['image/png'] = new Blob([png], { type: 'image/png' });
    if (html) parts['text/html'] = new Blob([html], { type: 'text/html' });
    if (text != null) parts['text/plain'] = new Blob([text], { type: 'text/plain' });
    await clipboard.write([new Item(parts)]);
    return;
  }
  if (png && typeof clipboard.writeImage === 'function') clipboard.writeImage(nativeImage.createFromBuffer(png));
  else clipboard.write({ ...(text != null ? { text } : {}), ...(html ? { html } : {}), ...(png ? { image: nativeImage.createFromBuffer(png) } : {}) });
}

export function copyFileToClipboard(p) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const list = path.join(os.tmpdir(), `memoking-copy-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(list, `${p}\r\n`, 'utf8');
      execFile('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLIPBOARD_HELPER, '-Action', 'files', '-ListFile', list],
        { cwd: os.tmpdir(), windowsHide: true, timeout: 15000 }, (err) => {
          if (err) console.error('파일을 클립보드에 넣지 못했어요', err.message);
          fs.rmSync(list, { force: true });
          resolve(!err);
        });
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'on run argv', '-e', 'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', p], { timeout: 8000 }, (err) => resolve(!err));
    } else {
      // 리눅스: 파일 관리자용 형식이 없으면(일부 Electron) 경로라도 글로
      if (typeof clipboard.writeBuffer === 'function') clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(`copy\n${pathToFileURL(p).href}`));
      else clipboard.writeText(p);
      resolve(true);
    }
  });
}

export const smokeClipboard = [];

export function copyImageToClipboard(file) {
  if (SMOKE) {
    smokeClipboard.push(file);
    return;
  }
  execFile('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLIPBOARD_HELPER, '-Action', 'image', '-ImageFile', file],
    { cwd: os.tmpdir(), windowsHide: true }, (err) => {
      if (err) console.error('캡처한 그림을 클립보드에 넣지 못했어요', err.message);
      setTimeout(() => fs.rmSync(file, { force: true }), 5000);
    });
}

// ---------- 원격 그림 다운로드 ----------
export async function fetchRemoteImage(vault, url) {
  if (!vault) throw new Error('메모 폴더가 아직 없어요. 처음 화면에서 메모 폴더를 정해 주세요');
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error('인터넷 주소(http, https)만 받을 수 있어요.');
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
    if (!ext) throw new Error(`그림이 아니에요 (${type || '형식 모름'}). 그림 주소(PNG · JPG · GIF · WebP)를 넣어 주세요`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_REMOTE_IMAGE_BYTES) throw new Error('50MB보다 커서 넣을 수 없어요. 더 작은 그림으로 해 주세요');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > MAX_REMOTE_IMAGE_BYTES) {
        controller.abort();
        throw new Error('50MB보다 커서 넣을 수 없어요. 더 작은 그림으로 해 주세요');
      }
      chunks.push(chunk);
    }
    return vault.saveAttachment(Buffer.concat(chunks.map((c) => Buffer.from(c))), ext);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- memoking:// 프로토콜 ----------
export function registerVaultProtocol(getVault, getHistory) {
  protocol.handle('memoking', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (url.host === 'ocr') {
      const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
      const file = path.join(APP_DIR, safe);
      if (file.startsWith(APP_DIR) && fs.existsSync(file)) return net.fetch(pathToFileURL(file).href, { headers: request.headers });
      return new Response('not found', { status: 404 });
    }
    const vault = getVault?.();
    const history = getHistory?.();
    const file = url.host === 'vault' ? vault?.resolve(rel) : url.host === 'history' ? history?.resolveImage(rel) : null;
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    const origin = request.headers.get('origin');
    if (!origin || !(origin === 'null' || origin.startsWith('memoking://'))) return net.fetch(pathToFileURL(file).href, { headers: request.headers });
    return net.fetch(pathToFileURL(file).href, { headers: request.headers }).then((res) => {
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', origin);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    });
  });
}

// ---------- AI 비서 연결 (MCP) ----------
export const MCP_NAME = 'memoking';
export const claudeConfigFile = () => process.env.MEMOKING_CLAUDE_CONFIG || path.join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json');

export function mcpServerEntry() {
  return {
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'mcp-server.js'), '--settings', settingsFile(), '--version', app.getVersion()],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export function readClaudeConfig() {
  const file = claudeConfigFile();
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const json = JSON.parse(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('알 수 없는 모양');
  return json;
}

export function mcpStatus() {
  const file = claudeConfigFile();
  let entry = null;
  let broken = false;
  try {
    entry = readClaudeConfig().mcpServers?.[MCP_NAME] ?? null;
  } catch {
    broken = true;
  }
  return {
    claudeFound: fs.existsSync(path.dirname(file)),
    connected: Boolean(entry),
    stale: Boolean(entry) && entry.command !== process.execPath,
    broken,
    write: settings.mcp?.write !== false,
  };
}

export function mcpConnect(on) {
  const file = claudeConfigFile();
  let config;
  try {
    config = readClaudeConfig();
  } catch {
    return { ...mcpStatus(), error: 'Claude 데스크톱 설정 파일을 읽지 못해서 건드리지 않았어요. "설정 복사" 로 직접 넣어 주세요' };
  }
  const servers = { ...(config.mcpServers ?? {}) };
  if (on) servers[MCP_NAME] = mcpServerEntry();
  else delete servers[MCP_NAME];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && !fs.existsSync(`${file}.memoking-backup`)) fs.copyFileSync(file, `${file}.memoking-backup`);
    fs.writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`);
  } catch (err) {
    return { ...mcpStatus(), error: `설정 파일에 쓰지 못했어요 (${err.message})` };
  }
  return mcpStatus();
}

export const mcpSnippet = () => JSON.stringify({ mcpServers: { [MCP_NAME]: mcpServerEntry() } }, null, 2);

export const shorten = (text, max = 28) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
