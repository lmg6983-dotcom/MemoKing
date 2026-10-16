// IPC 라우팅 및 핸들러 등록 — 렌더러와 메인 프로세스 간 통신 채널 바인딩.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isProgramFile } from '../app/js/core/file-kinds.js';
import { collectTags } from '../app/js/core/tags.js';
import { autoTagsFor } from '../app/js/core/auto-tags.js';
import { suggestTagsFor } from '../app/js/core/tag-suggest.js';
import { newLockSession, openLock, isLockedBody } from '../app/js/core/memo-lock.js';
import { normalizeReminder } from '../app/js/core/reminders.js';
import { normalizeMagicSettings, activeModules, memoBodyFromText, magicChips, toggleMagicChip } from '../app/js/core/magic-modules.js';
import { searchMemos } from '../app/js/core/memo-search.js';
import { looksLikeRef, isOpenableFile, foreignSummary, caseMemoMarkdown } from './opms.js';
import { isBlankBody, extractPreview } from '../app/js/core/memo-file.js';
import { pdfFileName } from '../app/js/core/pdf-page.js';
import { TUTORIAL_EVENTS } from '../app/js/core/tutorial.js';
import { cleanOverrides, setActionKey } from '../app/js/core/keymap.js';
import { HANDOFF_MS } from '../app/js/core/handoff.js';
import { noteBg, setTitleBarDim, titleBarOverlay, bringToFront, broadcast } from './window-utils.js';
import { SMOKE, toast, copyFileToClipboard, smokeOpened, writeClipboard } from './utils.js';
import { insideDriveForDesktop } from './drive/drive-sync.js';
import { hotkeyCopyText } from '../app/js/core/memo-hotkeys.js';
import { shareSheet, mailAttach, openLocalSend, findLocalSend, LOCALSEND_DOWNLOAD } from './share-file.js';
import { driveShareLink } from './share-drive.js';

const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);
const asPoint = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y) } : null);

export function registerIpc(ctx) {
  const {
    windowManager: wm,
    memoHotkeys,
    getVault,
    openVault,
    vaultInfo,
    suggestedVaultPath,
    appSettings,
    settings,
    saveSettings,
    alarms,
    pushReminders,
    getHistory,
    historyApps,
    setHistoryEnabled,
    blockHistoryApp,
    unblockHistoryApp,
    historyToMemo,
    getDriveAuth,
    getDriveApi,
    getDriveSync,
    driveInfo,
    useDriveFolder,
    autoDriveFolder,
    configureDrive,
    setAutoStart,
    setQuickMemo,
    setShortcut,
    pauseShortcuts,
    setMagicSettings,
    mcpConnect,
    mcpStatus,
    mcpSnippet,
    getFileIndex,
    startTutorial,
    tutorialPayload,
    tutorialWin,
    tutorialEvent,
    purgeTrash,
    TRASH_DAYS,
    getStt,
    sttOptions,
    getLinkPreviews,
    openWebPage,
    openVaultFile,
    writeClipboard,
    fetchRemoteImage,
    getLastHandoff,
  } = ctx;

  // ---------- STT (받아쓰기) ----------
  const sttKey = (e, id) => `${e.sender.id}:${id}`;
  const sttSenders = new Map();

  ipcMain.handle('stt:status', () => getStt()?.status());
  ipcMain.handle('stt:download', async (_e, pack) => {
    const stt = getStt();
    try {
      return await stt.download(pack);
    } catch (err) {
      return { ...stt?.status(), error: err.message };
    }
  });
  ipcMain.handle('stt:remove', (_e, pack) => getStt()?.remove(pack));
  ipcMain.handle('stt:options', (_e, next) => {
    settings.stt = { ...sttOptions(), ...(next ?? {}) };
    saveSettings();
    const stt = getStt();
    stt?.emit();
    return stt?.status();
  });
  ipcMain.handle('stt:start', (e, id) => {
    const key = sttKey(e, id);
    const wc = e.sender;
    const stt = getStt();
    const res = stt.start(key, {
      onLine: (text) => !wc.isDestroyed() && wc.send('stt:line', { id, text }),
      onSpeaking: (on) => !wc.isDestroyed() && wc.send('stt:speaking', { id, on }),
    });
    if (res.stt && !sttSenders.has(wc.id)) {
      sttSenders.set(wc.id, new Set());
      wc.once('destroyed', () => {
        for (const k of sttSenders.get(wc.id) ?? []) getStt()?.cancel(k);
        sttSenders.delete(wc.id);
      });
    }
    if (res.stt) sttSenders.get(wc.id).add(key);
    return res;
  });
  ipcMain.on('stt:audio', (e, id, samples) => {
    if (samples instanceof Float32Array) getStt()?.audio(sttKey(e, id), samples);
  });
  ipcMain.handle('stt:stop', async (e, id, target) => {
    const key = sttKey(e, id);
    sttSenders.get(e.sender.id)?.delete(key);
    try {
      return await getStt()?.stop(key, target);
    } catch (err) {
      return { text: '', error: err.message };
    }
  });
  ipcMain.handle('stt:transcribe', async (_e, job) => {
    try {
      return await getStt()?.transcribe({ memoId: job?.memoId, src: job?.src, samples: job?.samples });
    } catch (err) {
      return { text: '', error: err.message };
    }
  });

  // ---------- Vault / 폴더 ----------
  ipcMain.handle('app:info', () => vaultInfo());
  ipcMain.handle('vault:use', (_e, dir) => {
    const info = openVault(dir);
    if (getVault() && !settings.tutorialDone && !SMOKE) startTutorial();
    return info;
  });
  ipcMain.handle('vault:choose', async (event) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      title: '메모를 저장할 폴더 선택',
      defaultPath: getVault()?.root ?? suggestedVaultPath(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return vaultInfo();
    // Google Drive 데스크탑 앱 폴더(G:\내 드라이브 …)를 고르면서 메모킹의 Google Drive 동기화도 켜져 있으면:
    //   두 동기화가 같은 파일을 주고받아 메모가 끝없이 늘어날 수 있다 — 하나만 쓰게 묻는다
    if (settings.drive?.folderId && insideDriveForDesktop(result.filePaths[0])) {
      const { response } = await dialog.showMessageBox(senderWindow(event), {
        type: 'warning',
        title: '메모킹',
        message: '이 폴더는 Google Drive 데스크탑 앱이 동기화하는 곳이에요',
        detail: '메모킹의 Google Drive 동기화와 함께 쓰면 두 동기화가 같은 메모를 서로 올리고 받아, 메모가 계속 늘어날 수 있어요.\n\n'
          + '이 폴더를 쓰려면 메모킹의 Google Drive 동기화를 끕니다 (Google Drive 데스크탑 앱만 동기화). 휴대폰과 맞추려면 Google Drive 밖의 폴더를 골라 주세요.',
        buttons: ['다른 폴더 고르기', '이 폴더 쓰고 메모킹 동기화 끄기'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return vaultInfo();
      settings.drive = null;
      saveSettings();
    }
    for (const win of wm.noteWins.values()) win.close();
    const info = openVault(result.filePaths[0]);
    if (getVault() && !settings.tutorialDone && !SMOKE) startTutorial();
    return info;
  });
  ipcMain.handle('vault:reveal', () => getVault() && shell.openPath(getVault().root));
  ipcMain.handle('vault:reveal-index', () => getVault() && shell.showItemInFolder(getVault().indexFile));

  // ---------- 튜토리얼 ----------
  ipcMain.handle('tutorial:start', () => startTutorial());
  ipcMain.handle('tutorial:current', (event) => {
    const payload = tutorialPayload();
    return payload && tutorialWin(payload) === senderWindow(event) ? payload : null;
  });
  ipcMain.handle('tutorial:action', (_e, action) => {
    if (action === 'next' || action === 'skip') tutorialEvent(action);
  });
  ipcMain.handle('tutorial:event', (_e, name) => {
    if (TUTORIAL_EVENTS.includes(name) && name !== 'memo-created' && name !== 'note-closed') tutorialEvent(name);
  });

  // ---------- 메모 목록·검색·태그 ----------
  ipcMain.handle('memos:list', () => wm.listMemos());
  ipcMain.handle('tags:list', () => collectTags(getVault()?.list() ?? []));
  ipcMain.handle('tags:suggest', (_e, body, id) => suggestTagsFor(String(body ?? ''), getVault()?.bodies() ?? [], { excludeId: id }));
  ipcMain.handle('tags:auto', (_e, body, source, id) => autoTagsFor(String(body ?? ''), getVault()?.bodies() ?? [], { source, excludeId: id }));
  ipcMain.handle('memos:search', (_e, query, excludeId) => wm.withOpenFlag(getVault()?.search(String(query ?? ''), excludeId) ?? []));

  // ---------- 예약 알림 ----------
  ipcMain.handle('reminders:set', (_e, id, list) => {
    const vault = getVault();
    if (!vault || !Array.isArray(list)) return null;
    const reminders = list.map((r) => normalizeReminder(r)).filter(Boolean);
    const saved = vault.setReminders(id, reminders);
    if (!saved) throw new Error('그사이 이 메모가 다른 기기에서 바뀌어 저장하지 못했어요. 다시 해 주세요');
    wm.sendToNote(id, 'memo:reminders', saved);
    pushReminders();
    alarms.tick();
    return saved;
  });
  ipcMain.handle('reminders:all', () => getVault()?.allReminders() ?? []);
  ipcMain.handle('reminders:add', (_e, id, reminder, newTitle) => {
    const vault = getVault();
    if (!vault) return null;
    const r = normalizeReminder(reminder);
    if (!r) return null;
    let memoId = id ? String(id) : null;
    if (!memoId) {
      const title = String(newTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '새 일정';
      memoId = vault.import({ body: `# ${title}\n` });
    }
    const memo = memoId ? vault.get(memoId) : null;
    if (!memo) throw new Error('메모를 찾지 못했어요');
    const saved = vault.setReminders(memoId, [...(memo.reminders ?? []), r]);
    if (!saved) throw new Error('그사이 이 메모가 다른 기기에서 바뀌어 저장하지 못했어요. 다시 해 주세요');
    wm.sendToNote(memoId, 'memo:reminders', saved);
    pushReminders();
    alarms.tick();
    return memoId;
  });

  // ---------- 알림 보관함 ----------
  ipcMain.handle('history:list', (_e, filter) => {
    const h = getHistory();
    const entries = h?.list(filter ?? {}) ?? [];
    return { enabled: settings.historyEnabled, total: h?.state.entries.length ?? 0, apps: h?.apps() ?? [], entries: entries.slice(0, 500) };
  });
  ipcMain.handle('history:set-enabled', (_e, on) => setHistoryEnabled(on));
  ipcMain.handle('history:remove', (_e, id) => getHistory()?.remove(id) ?? false);
  ipcMain.handle('history:clear', () => getHistory()?.clear());
  ipcMain.handle('history:to-memo', (_e, id) => historyToMemo(id));
  ipcMain.handle('history:apps', () => historyApps());
  ipcMain.handle('history:block', (_e, appId, app, removeExisting) => blockHistoryApp(String(appId ?? ''), String(app ?? ''), Boolean(removeExisting)));
  ipcMain.handle('history:unblock', (_e, appId) => unblockHistoryApp(String(appId ?? '')));

  // ---------- Google Drive 동기화 ----------
  ipcMain.handle('drive:status', () => driveInfo());
  ipcMain.handle('drive:set-client', (_e, id, secret) => {
    getDriveAuth()?.setClient(id, secret);
    return driveInfo();
  });
  ipcMain.handle('drive:login', async () => {
    const auth = getDriveAuth();
    await auth.login();
    const email = await getDriveApi()?.about().catch(() => '');
    if (email) auth.setEmail(email);
    if (wm.listWin) bringToFront(wm.listWin);
    return { email };
  });
  ipcMain.handle('drive:cancel-login', () => getDriveAuth()?.cancelLogin());
  // 외부 앱 메모 연동 (전체 드라이브 권한): 그 범위로 다시 로그인 → 받았으면 폴더를 처음부터 훑어 다른 앱이 넣은 메모를 바로 받는다
  ipcMain.handle('drive:full-scope', async (_e, on) => {
    const auth = getDriveAuth();
    if (!auth) return { full: false, error: 'Google Drive 를 쓸 수 없어요' };
    const res = await auth.setFullScope(Boolean(on));
    if (wm.listWin) bringToFront(wm.listWin);
    if (res.relogged) getDriveSync()?.run({ full: true }).catch(() => {});
    return { ...res, drive: driveInfo() };
  });
  ipcMain.handle('drive:folders', async (_e, parent) => (await getDriveApi()?.folders(String(parent || 'root'))).map((f) => ({ id: f.id, name: f.name })));
  ipcMain.handle('drive:create-folder', async (_e, parent, name) => {
    const f = await getDriveApi()?.createFolder(String(parent || 'root'), String(name));
    return { id: f.id, name: f.name };
  });
  ipcMain.handle('drive:use', (_e, folderId, name) => useDriveFolder(String(folderId), String(name)));
  ipcMain.handle('drive:auto', () => autoDriveFolder());
  ipcMain.handle('drive:sync', () => getDriveSync()?.run({ full: true })); // 단추: 다른 앱이 넣은 파일까지 보이게 폴더를 처음부터
  ipcMain.handle('drive:disconnect', () => {
    getDriveAuth()?.signOut();
    settings.drive = null;
    saveSettings();
    configureDrive();
    return driveInfo();
  });

  // ---------- 클립보드 ----------
  ipcMain.handle('clipboard:write-text', (_e, text) => clipboard.writeText(String(text ?? '')));
  ipcMain.handle('clipboard:write-rich', async (_e, { text, html } = {}) => {
    await writeClipboard({ text: String(text ?? ''), html: String(html ?? '') });
    return true;
  });

  // ---------- 설정 & 단축키 & MCP ----------
  ipcMain.handle('app:settings', () => appSettings());
  ipcMain.handle('app:set-auto-start', (_e, on) => setAutoStart(on));
  ipcMain.handle('app:set-quick-memo', (_e, on) => setQuickMemo(on));
  ipcMain.handle('shortcuts:set', (_e, name, acc) => setShortcut(String(name), acc == null ? null : String(acc)));
  // 새 키를 받는 동안 전역 단축키를 잠시 놓기 — 놓은 창이 닫히거나 새로 고쳐지면(되살리기를 못 보냄) 여기서 되살린다
  let pausedBy = null;
  ipcMain.handle('shortcuts:pause', (event, on) => {
    const wc = event.sender;
    pausedBy = on ? wc : null;
    if (on && !wc.mkPauseWatch) {
      wc.mkPauseWatch = true;
      const undo = () => {
        if (pausedBy !== wc) return;
        pausedBy = null;
        pauseShortcuts(false);
      };
      wc.on('destroyed', undo);
      wc.on('did-start-loading', undo);
    }
    return pauseShortcuts(on);
  });
  // 메모 창 단축키 (바꾼 것만 settings.keymap 에) — 바꾸면 열린 창 모두 바로
  const keymapState = () => ({ overrides: cleanOverrides(settings.keymap), shortcuts: appSettings().shortcuts });
  const keymapChanged = () => {
    saveSettings();
    broadcast('keymap:changed', cleanOverrides(settings.keymap));
  };
  ipcMain.handle('keymap:get', () => keymapState());
  ipcMain.handle('keymap:set', (_e, id, combo) => {
    const r = setActionKey(settings.keymap, String(id), combo == null ? null : String(combo));
    settings.keymap = r.overrides;
    keymapChanged();
    return { ...keymapState(), moved: r.moved };
  });
  ipcMain.handle('keymap:reset', () => {
    settings.keymap = {};
    keymapChanged();
    return keymapState();
  });
  ipcMain.handle('keymap:open-window', () => wm.openKeymapWindow());
  ipcMain.handle('app:set-fit-tables', (_e, on) => {
    settings.fitTables = Boolean(on);
    saveSettings();
    return settings.fitTables;
  });
  // 링크 미리보기 카드 켜고 끄기 — 열린 메모 · 위젯에도 바로
  ipcMain.handle('app:set-link-previews', (_e, on) => {
    settings.linkPreviews = Boolean(on);
    saveSettings();
    broadcast('settings:link-previews', settings.linkPreviews);
    return settings.linkPreviews;
  });
  ipcMain.handle('app:set-auto-tags', (_e, on) => {
    settings.autoTags = Boolean(on);
    saveSettings();
    return settings.autoTags;
  });
  ipcMain.handle('app:set-magic', (_e, next) => setMagicSettings(next));
  ipcMain.handle('mcp:connect', (_e, on) => mcpConnect(on !== false));
  ipcMain.handle('mcp:copy', () => {
    clipboard.writeText(mcpSnippet());
    return true;
  });
  ipcMain.handle('mcp:set-write', (_e, on) => {
    settings.mcp = { ...(settings.mcp ?? {}), write: Boolean(on) };
    saveSettings();
    return mcpStatus();
  });

  // ---------- 매직키 ----------
  const magicModuleList = () => magicChips(settings.magic).map(({ id, name, description, on }) => ({ id, name, description, on }));
  ipcMain.handle('magic:modules', () => magicModuleList());
  ipcMain.handle('magic:toggle-module', (_e, id) => {
    setMagicSettings(toggleMagicChip(settings.magic, String(id)));
    return magicModuleList();
  });
  ipcMain.on('magic:close', () => {
    if (wm.magicWin && !wm.magicWin.isDestroyed()) wm.magicWin.hide();
  });
  ipcMain.handle('magic:search', async (_e, query) => {
    const vault = getVault();
    const mods = new Set(activeModules(settings.magic).map((m) => m.id));
    const q = String(query ?? '').slice(0, 200);
    if (!q.trim()) {
      const recent = mods.has('notes') && vault ? vault.list().slice(0, 4).map((m) => ({ id: m.id, title: m.title, snippet: (m.preview ?? '').split('\n')[0], color: m.color, updated: m.updated })) : [];
      return { notes: recent, recent: true, folders: [], files: [], index: getFileIndex()?.status() ?? null };
    }
    const updatedOf = new Map((vault?.list() ?? []).map((m) => [m.id, m.updated]));
    const memos = mods.has('notes') && vault ? vault.searchable() : [];
    const notes = searchMemos(memos, q, 5).map((n) => ({ ...n, updated: updatedOf.get(n.id) }));
    const notesTotal = notes.length < 5 ? notes.length : searchMemos(memos, q, Infinity).length;
    let folders = [];
    let files = [];
    let totalFolders = 0;
    let totalFiles = 0;
    const fileIndex = getFileIndex();
    if (mods.has('files') && fileIndex) {
      ({ folders, files, totalFolders, totalFiles } = fileIndex.searchSplit(q, { folders: 3, files: 6 }));
      wm.lastFileResults = new Set([...folders, ...files].map((f) => f.path));
      const home = os.homedir();
      const shown = (p) => (p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p);
      const withIcon = (list) => Promise.all(list.map(async (f) => ({ ...f, where: shown(path.dirname(f.path)), icon: await wm.fileIcon(f.path, f.isDir) })));
      [folders, files] = await Promise.all([withIcon(folders), withIcon(files)]);
    }
    const more = Math.max(0, notesTotal - notes.length) + Math.max(0, totalFolders - folders.length) + Math.max(0, totalFiles - files.length);
    return { notes, folders, files, more, index: fileIndex?.status() ?? null };
  });
  ipcMain.handle('magic:act', (_e, req) => wm.magicAct(req));
  ipcMain.handle('magic:opms-search', async (_e, query) => {
    const q = String(query ?? '').slice(0, 40);
    if (!activeModules(settings.magic).some((m) => m.id === 'opms') || !looksLikeRef(q)) return { cases: [], total: 0 };
    try {
      const rows = await wm.opmsClient().find(q, { timeoutMs: 5000, retries: 0 });
      wm.rememberCases(rows);
      return { cases: rows.slice(0, 6).map((r) => wm.opmsBrief(r)), total: rows.length };
    } catch (err) {
      return { cases: [], total: 0, error: err.offline ? '사내망에 연결돼 있지 않아 OPMS 를 찾지 못했어요' : err.message };
    }
  });

  // ---------- OPMS 창 ----------
  ipcMain.handle('opms:search', async (_e, query) => {
    const rows = await wm.opmsClient().find(String(query ?? '').slice(0, 60), { retries: 1 });
    wm.rememberCases(rows);
    return rows.map((r) => wm.opmsBrief(r));
  });
  ipcMain.handle('opms:case', async (_e, idx) => {
    const known = wm.caseOf(idx);
    const client = wm.opmsClient();
    const c = (await client.caseByIdx(known.idx).catch(() => null)) ?? known;
    wm.rememberCases([c]);
    const foreign = await client.foreign(c).catch(() => []);
    return { case: c, foreign, summary: foreignSummary(c, foreign), ...wm.opmsSettings() };
  });
  ipcMain.handle('opms:mywork', (_e, idx) => wm.opmsClient().mywork(wm.caseOf(idx).idx));
  ipcMain.handle('opms:details', (_e, idx) => wm.opmsClient().details(wm.caseOf(idx)));
  ipcMain.handle('opms:schema-copy', async () => {
    const text = await wm.opmsClient().schemaText();
    clipboard.writeText(text.slice(0, 200_000));
    return text.split('\n').length;
  });
  ipcMain.handle('opms:bills', (_e, idx) => wm.opmsClient().bills(wm.caseOf(idx).idx));

  const ATTACH_TTL = 5 * 60_000;
  const attachmentsOf = async (c, { fresh = false } = {}) => {
    const key = `${wm.opmsSettings().host}\n${c.idx}`;
    const hit = wm.attachCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ATTACH_TTL) return hit.list;
    const list = await wm.opmsClient().attachments(c.idx);
    wm.attachCache.set(key, { at: Date.now(), list });
    if (wm.attachCache.size > 20) wm.attachCache.delete(wm.attachCache.keys().next().value);
    return list;
  };
  ipcMain.handle('opms:attachments', (_e, idx) => attachmentsOf(wm.caseOf(idx), { fresh: true }));
  ipcMain.handle('opms:download', async (event, { idx, uploads, all } = {}) => {
    const c = wm.caseOf(idx);
    const client = wm.opmsClient();
    const picked = (Array.isArray(uploads) ? uploads : []).map(String);
    let list = await attachmentsOf(c);
    const has = (l) => new Set(l.map((it) => it.upload));
    const first = has(list);
    if (!all && picked.some((u) => !first.has(u))) list = await attachmentsOf(c, { fresh: true });
    const known = has(list);
    const items = all ? list : picked.filter((u) => known.has(u)).map((u) => list.find((it) => it.upload === u));
    const gone = all ? [] : [...new Set(picked.filter((u) => !known.has(u)))];
    const res = await client.download(c, items, {
      baseDir: wm.opmsSettings().wrapperDir,
      all: Boolean(all),
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('opms:progress', p); },
    });
    for (const u of gone) res.failed.push({ upload: u, name: path.basename(u), error: 'OPMS 목록에서 사라졌어요. 새로 고침 해 주세요' });
    wm.opmsLastDir = res.dir;
    indexWrapper(res.dir);
    if (!SMOKE) shell.openPath(res.dir);
    return res;
  });
  // 받은 전자포대는 곧바로 매직키 파일 찾기에 (색인 새로 고침을 기다리지 않게)
  const indexWrapper = (dir, files = null) => {
    try {
      const index = getFileIndex();
      if (!index) return;
      files ??= fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(dir, d.name));
      index.add([dir, ...files], { base: wm.opmsSettings().wrapperDir });
    } catch {
      // 찾기 목록에 못 넣어도 받기는 끝났다
    }
  };
  ipcMain.handle('opms:open-file', async (_e, { idx, upload } = {}) => {
    const c = wm.caseOf(idx);
    const find = (list) => list.find((x) => x.upload === String(upload ?? ''));
    const it = find(await attachmentsOf(c)) ?? find(await attachmentsOf(c, { fresh: true }));
    if (!it) throw new Error('그 파일을 찾지 못했어요. 새로 고침 뒤 다시 해 주세요');
    const file = await wm.opmsClient().fileFor(c, it, wm.opmsSettings().wrapperDir);
    if (!file) throw new Error('파일 이름이 이상해 열 수 없어요');
    wm.opmsLastDir = path.dirname(file);
    indexWrapper(path.dirname(file), [file]);
    if (!isOpenableFile(file)) {
      if (!SMOKE) shell.showItemInFolder(file);
      return { file, shown: true, message: '서류가 아닌 파일이라 열지 않고 폴더에서 보여 줘요' };
    }
    if (SMOKE) return { file };
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return { file };
  });
  ipcMain.handle('opms:open-folder', () => (wm.opmsLastDir ? shell.openPath(wm.opmsLastDir) : ''));
  ipcMain.handle('opms:choose-dir', async (event) => {
    const r = await dialog.showOpenDialog(senderWindow(event), { title: '전자포대를 저장할 폴더', defaultPath: wm.opmsSettings().wrapperDir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return wm.opmsSettings().wrapperDir;
    settings.opms = { ...settings.opms, wrapperDir: r.filePaths[0] };
    getFileIndex()?.watch([r.filePaths[0]]);
    saveSettings();
    return r.filePaths[0];
  });
  ipcMain.handle('opms:copy', (_e, text) => clipboard.writeText(String(text ?? '').slice(0, 2000)));
  ipcMain.handle('opms:to-memo', async (_e, idx) => {
    const vault = getVault();
    if (!vault) throw new Error('메모 폴더가 아직 없어요');
    const known = wm.caseOf(idx);
    const client = wm.opmsClient();
    const c = (await client.caseByIdx(known.idx).catch(() => null)) ?? known;
    const [foreign, mywork, details] = await Promise.all([client.foreign(c).catch(() => []), client.mywork(c.idx).catch(() => []), client.details(c).catch(() => null)]);
    const id = vault.import({ body: caseMemoMarkdown(c, { mywork, foreign, summary: foreignSummary(c, foreign), details }) });
    if (!id) throw new Error('메모를 만들지 못했어요');
    wm.openNote(id);
    return id;
  });

  // ---------- 전체 결과 창 (Finder) ----------
  ipcMain.handle('magic:open-all', (_e, query) => {
    wm.magicWin?.hide();
    wm.showFinder(String(query ?? '').slice(0, 200));
    return true;
  });
  ipcMain.handle('finder:search', async (_e, query) => {
    const q = String(query ?? '').slice(0, 200);
    const fileIndex = getFileIndex();
    if (!q.trim()) {
      wm.lastFinderResults = new Set();
      return { items: [], total: 0, index: fileIndex?.status() ?? null };
    }
    const vault = getVault();
    const mods = new Set(activeModules(settings.magic).map((m) => m.id));
    const updatedOf = new Map((vault?.list() ?? []).map((m) => [m.id, m.updated]));
    const notes = mods.has('notes') && vault ? searchMemos(vault.searchable(), q, 300).map((n) => ({ kind: 'note', ...n, updated: updatedOf.get(n.id) })) : [];
    const found = mods.has('files') && fileIndex ? fileIndex.searchAll(q, 2000) : { items: [], total: 0 };
    wm.lastFinderResults = new Set(found.items.map((f) => f.path));
    const home = os.homedir();
    const shown = (p) => (p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p);
    const files = await Promise.all(found.items.map(async (f) => ({ kind: f.isDir ? 'folder' : 'file', ...f, where: shown(path.dirname(f.path)), icon: await wm.fileIcon(f.path, f.isDir) })));
    return { items: [...notes, ...files], total: notes.length + found.total, index: fileIndex?.status() ?? null };
  });
  ipcMain.handle('finder:stat', async (_e, paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => wm.shownPath(p)).slice(0, 200);
    return Object.fromEntries(await Promise.all(list.map(async (p) => {
      try {
        const st = await fs.promises.stat(p);
        return [p, { size: st.isDirectory() ? null : st.size, mtime: st.mtimeMs }];
      } catch {
        return [p, null];
      }
    })));
  });
  ipcMain.handle('finder:act', async (_e, req) => {
    const res = await wm.magicAct(req);
    return { ...res, close: false };
  });
  ipcMain.on('magic:resize', (_e, h) => {
    if (!wm.magicWin || wm.magicWin.isDestroyed()) return;
    const height = Math.max(120, Math.min(640, Math.round(Number(h) || 0)));
    const [w, cur] = wm.magicWin.getSize();
    if (cur !== height) wm.magicWin.setSize(w, height);
  });
  ipcMain.handle('magic:run', (_e, payload) => {
    const vault = getVault();
    const mods = activeModules(settings.magic);
    if (!vault || payload?.module !== 'memo' || !mods.some((m) => m.id === 'memo')) return { ok: false };
    const body = memoBodyFromText(payload.text);
    if (!body) return { ok: false };
    const id = vault.import({ body });
    if (!id) return { ok: false };
    if (payload.open) wm.openNote(id);
    else {
      const showNow = () => wm.openNote(id, { inactive: true });
      if (!toast({ memoId: id, kind: 'magic-memo', title: '메모를 만들었어요', body: `${body.split('\n')[0].slice(0, 40)}\n눌러서 열기`, onClick: () => wm.revealNote(id), onFail: showNow })) showNow();
    }
    return { ok: true, id };
  });

  // ---------- 창 크기 조정 ----------
  // 본문 복사 (메모 단축키와 같은 글: 제목 줄 빼고, 서식 기호 없이, 줄 앞 띄어쓰기 그대로)
  ipcMain.handle('memo:copy-text', async (_e, id) => {
    const m = getVault()?.get(String(id));
    if (!m || m.locked) return false;
    await writeClipboard({ text: hotkeyCopyText(m.body) });
    return true;
  });

  // 메모 단축키 (Ctrl+Alt+1~9)
  ipcMain.handle('hotkey:state', (_e, id) => memoHotkeys.state(String(id)));
  ipcMain.handle('hotkey:set', (_e, id, slot, opts) => {
    const r = memoHotkeys.set(String(id), slot == null ? null : String(slot), { copy: opts?.copy !== false, show: opts?.show === true });
    if (r.ok) wm.pushList();
    return r;
  });
  ipcMain.handle('win:spare', (e) => wm.spareWaiting(e.sender));
  ipcMain.on('win:painted', (e) => wm.notePainted(e.sender));
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
    if (x + want > area.x + area.width) nx = Math.max(area.x, area.x + area.width - want);
    win.setBounds({ x: nx, y, width: want, height: h });
    return want - w;
  });

  // ---------- 휴지통 ----------
  ipcMain.handle('trash:list', () => getVault()?.trashList() ?? []);
  ipcMain.handle('trash:restore', (_e, name) => {
    const id = getVault()?.restoreTrash(String(name ?? '')) ?? null;
    wm.pushList();
    return id;
  });
  ipcMain.handle('trash:delete', (_e, name) => getVault()?.deleteTrash(String(name ?? '')) ?? false);
  ipcMain.handle('trash:empty', () => getVault()?.emptyTrash() ?? { memos: 0, files: 0 });
  ipcMain.handle('app:set-trash-days', (_e, days) => {
    const d = Number(days);
    if (TRASH_DAYS.includes(d)) {
      settings.trashDays = d;
      saveSettings();
      purgeTrash(getVault());
    }
    return appSettings();
  });

  // ---------- 개별 메모 조작 ----------
  ipcMain.handle('memo:open', (_e, id) => Boolean(wm.openNote(id)));
  ipcMain.handle('memo:handoff', () => {
    const last = getLastHandoff();
    return (last && Date.now() - last.at < HANDOFF_MS && !wm.noteWins.has(last.id) ? last : null);
  });
  ipcMain.handle('memo:create', (_e, options) => wm.createNote(options ?? {}));
  ipcMain.handle('memo:import', (_e, body, opts) => {
    const vault = getVault();
    if (!vault) throw new Error('메모 폴더가 아직 없어요');
    const id = vault.import({ body: String(body ?? '').slice(0, 5_000_000) });
    if (!id) throw new Error('이 파일로는 메모를 만들 수 없어요');
    if (opts?.open) wm.openNote(id);
    return id;
  });
  ipcMain.handle('memo:get', (_e, id) => {
    const memo = getVault()?.get(id);
    if (!memo) return null;
    const alarm = wm.pendingAlarms.get(id) ?? null;
    const capture = wm.pendingCaptures.get(id) ?? null;
    wm.pendingAlarms.delete(id);
    wm.pendingCaptures.delete(id);
    return { ...memo, ...wm.layerState(id), onTop: settings.onTop[id] === true, alarm, capture, stack: wm.stackState(id), linkPreviews: settings.linkPreviews !== false };
  });

  // ---------- 잠금 메모 ----------
  ipcMain.handle('memo:lock', async (_e, id, password, opts) => {
    const vault = getVault();
    try {
      const session = await newLockSession(String(password ?? ''));
      return vault?.lock(String(id), session, { keepOpen: wm.noteWins.has(String(id)), hideTitle: opts?.hideTitle === true }) ?? { error: '잠그지 못했어요. 이미 잠겼거나 그사이 다른 기기에서 잠갔을 수 있어요' };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('memo:open-lock', async (_e, id, password) => {
    const vault = getVault();
    const sealed = vault?.entries.get(String(id))?.body;
    if (vault && sealed != null && !isLockedBody(sealed)) return vault.get(String(id));
    try {
      const { session } = await openLock(sealed, String(password ?? ''));
      if (!wm.noteWins.has(String(id))) return { error: '메모 창이 닫혔어요' };
      return vault?.openLock(String(id), session) ?? { error: '메모를 열지 못했어요' };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('memo:unlock', (_e, id) => {
    const vault = getVault();
    if (!vault) return { error: '메모 폴더가 열려 있지 않아요' };
    const m = vault.get(String(id));
    if (!m) return { error: '메모를 찾을 수 없어요. 이동했거나 삭제됐을 수 있어요' };
    if (!m.locked) return m;
    if (m.needsPassword) return { error: '먼저 비밀번호로 열어 주세요' };
    return vault.unlock(String(id)) ?? { error: '그사이 다른 기기에서 이 메모가 바뀌어 풀지 못했어요. 다시 해 주세요' };
  });

  // ---------- 메모 저장 & 사본 ----------
  ipcMain.handle('memo:save', (_e, id, body) => {
    if (typeof body !== 'string') throw new TypeError('본문이 문자열이 아닙니다.');
    const vault = getVault();
    const summary = vault.save(id, body);
    wm.noteWins.get(id)?.setTitle(summary.title);
    return summary;
  });
  ipcMain.handle('memo:keep-copy', (_e, sourceId, body, copyId, { unlocked = false } = {}) => {
    const vault = getVault();
    if (!vault || typeof body !== 'string') return null;
    if (copyId && vault.get(copyId)) {
      const r = vault.save(copyId, body);
      if (!r?.refused || r.copied) return copyId;
    }
    if (unlocked && !vault.locks.has(sourceId)) return vault.import({ body, color: vault.get(sourceId)?.color });
    return vault.importCopyOf(sourceId, body, { color: vault.get(sourceId)?.color });
  });
  ipcMain.on('memo:save-sync', (event, id, body) => {
    try {
      const vault = getVault();
      let r = typeof body === 'string' && vault ? vault.save(id, body) : null;
      if (r?.retry) {
        vault.scan();
        r = vault.save(id, body);
      }
      if (r?.refused && !r.copied && !r.invalid && !isBlankBody(body)) {
        if (vault.locks.has(id)) vault.importCopyOf(id, body, { color: vault.get(id)?.color });
        else vault.import({ body, color: vault.get(id)?.color });
      }
      event.returnValue = true;
    } catch (err) {
      console.error('저장 실패', err);
      event.returnValue = false;
    }
  });
  ipcMain.handle('memo:set', (_e, id, patch) => {
    const memo = getVault()?.setMeta(id, patch ?? {});
    const win = wm.noteWins.get(id);
    if (memo && win) {
      win.setBackgroundColor(noteBg(memo.color));
      win.webContents.send('memo:meta', memo);
    }
    return memo;
  });
  ipcMain.handle('memo:remove', (_e, id) => {
    wm.removeFromStack(id, 'none');
    const win = wm.noteWins.get(id);
    const vault = getVault();
    const title = vault?.get?.(id)?.title ?? '';
    const ok = vault?.trash(id) ?? false;
    win?.destroy();
    if (typeof ok === 'string') {
      wm.listWin?.webContents.send('memo:trashed', { name: ok, title });
      // 목록 창이 없거나 숨어 있으면 되돌리기 띠가 보이지 않는다 — 어디로 갔는지만이라도 알린다
      if (!wm.listWin || !wm.listWin.isVisible() || wm.listWin.isMinimized()) {
        toast({ title: '휴지통으로 옮겼어요', body: `“${title || '제목 없음'}” 메모는 목록 › 설정 › 휴지통에서 되살릴 수 있어요` });
      }
    }
    return Boolean(ok);
  });

  // ---------- 그림/PDF 저장 ----------
  ipcMain.handle('image:copy', async (_e, base64) => {
    await writeClipboard({ png: Buffer.from(String(base64), 'base64') });
    return { ok: true };
  });
  ipcMain.handle('image:save', async (event, id, base64) => {
    const memo = getVault()?.get(String(id));
    const name = `${pdfFileName(memo?.title ?? '메모').replace(/\.pdf$/i, '')}.png`;
    let file = SMOKE ? path.join(app.getPath('temp'), `memoking-smoke-${Date.now()}.png`) : null;
    if (!file) {
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) ?? undefined, {
        title: '그림으로 저장',
        defaultPath: path.join(app.getPath('pictures'), name),
        filters: [{ name: 'PNG 그림', extensions: ['png'] }],
      });
      if (r.canceled || !r.filePath) return { cancelled: true };
      file = r.filePath;
    }
    fs.writeFileSync(file, Buffer.from(String(base64), 'base64'));
    return { file, name: path.basename(file) };
  });
  ipcMain.handle('pdf:open', (_e, id) => wm.openPdfWindow(String(id)));
  ipcMain.handle('pdf:memo', (_e, id) => {
    const m = getVault()?.get(String(id));
    return m ? { title: m.title, body: m.body, color: m.color, tables: m.tables, created: m.created, updated: m.updated } : null;
  });
  ipcMain.handle('pdf:save', (event, id, options) => wm.savePdf(String(id), options ?? {}, BrowserWindow.fromWebContents(event.sender)));

  // ---------- 버전 기록 & 링크 ----------
  ipcMain.handle('memo:versions', (_e, id) => getVault()?.versions(String(id)) ?? []);
  ipcMain.handle('memo:version', (_e, id, name) => getVault()?.version(String(id), String(name)) ?? null);
  ipcMain.handle('memo:restore-version', (_e, id, name) => {
    const restored = getVault()?.restoreVersion(String(id), String(name)) ?? null;
    if (restored && !restored.error) wm.noteWins.get(String(id))?.setTitle(restored.title);
    return restored;
  });
  ipcMain.handle('memo:links', (_e, id) => getVault()?.links(id) ?? { links: [], backlinks: [], suggestions: [] });
  ipcMain.handle('memo:link', (_e, id, targetId, on) => {
    const result = getVault()?.link(id, targetId, on !== false);
    wm.sendToNote(targetId, 'memo:links-changed');
    return result;
  });

  // ---------- 첨부 파일 ----------
  ipcMain.handle('attachment:read', (_e, rel) => {
    const file = getVault()?.resolve(String(rel ?? ''));
    if (!file || !fs.existsSync(file)) throw new Error('파일을 찾지 못했어요');
    if (fs.statSync(file).size > 500 * 1024 * 1024) throw new Error('파일이 너무 커요 (500MB 넘음)');
    return new Uint8Array(fs.readFileSync(file));
  });
  ipcMain.handle('attachment:save', (_e, bytes, ext) => {
    const vault = getVault();
    if (!vault) throw new Error('메모 폴더가 아직 없어요.');
    if (!(bytes instanceof Uint8Array)) throw new TypeError('넣으려는 파일을 읽지 못했어요.');
    return vault.saveAttachment(bytes, ext);
  });
  ipcMain.handle('attachment:fetch', (_e, url) => fetchRemoteImage(getVault(), String(url ?? '')));
  ipcMain.handle('attachment:open', async (e, rel) => {
    let decoded = String(rel ?? '');
    try {
      decoded = decodeURI(decoded);
    } catch {
      // 이미 디코딩됨
    }
    const file = getVault()?.resolve(decoded);
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return '파일을 찾지 못했어요. 메모 폴더에서 옮겨졌거나 지워졌을 수 있어요.';
    const result = await openVaultFile(file, BrowserWindow.fromWebContents(e.sender));
    return result && result !== 'cancelled' ? '파일을 열지 못했어요. 이 파일을 열 수 있는 프로그램이 있는지 확인해 주세요.' : result;
  });
  ipcMain.handle('attachment:copy', async (_e, rel) => {
    let decoded = String(rel ?? '');
    try {
      decoded = decodeURI(decoded);
    } catch {
      // 이미 디코딩됨
    }
    const file = getVault()?.resolve(decoded);
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
    if (SMOKE) {
      smokeOpened.push({ kind: 'copy-file', target: file });
      return true;
    }
    return copyFileToClipboard(file);
  });
  // 저장 · 공유가 함께 쓰는 것: 파일 이름 다듬기 · 메모 폴더의 첨부 찾기
  const safeName = (name) => path.basename(String(name ?? '메모 내용')).replace(/[\\/:*?"<>|]+/g, ' ').trim() || '메모 내용';
  /** 메모 폴더 attachments/ 안의 파일 → { file } | { error } (화면이 이미 풀어 보낸 경로 — 다시 풀면 이름의 %XX 가 깨진다) */
  const attachmentFile = (rel) => {
    const file = /^attachments\//.test(String(rel)) ? getVault()?.resolve(String(rel)) : null;
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return { error: '파일을 찾지 못했어요. 메모 폴더에서 옮겨졌거나 지워졌을 수 있어요' };
    return { file };
  };
  ipcMain.handle('attachment:save-as', async (e, f = {}) => {
    const name = safeName(f.name);
    let source = null;
    if (f.rel) {
      const found = attachmentFile(f.rel);
      if (found.error) return found;
      source = found.file;
    } else if (typeof f.base64 !== 'string') return { error: '저장할 내용이 없어요' };
    const ext = path.extname(name).slice(1);
    let file = SMOKE ? path.join(app.getPath('temp'), `memoking-smoke-save-${Date.now()}-${name}`) : null;
    if (!file) {
      const dir = /^image\//.test(f.mime ?? '') || /^(png|jpe?g|gif|webp|bmp)$/i.test(ext) ? app.getPath('pictures') : app.getPath('downloads');
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined, {
        title: '저장',
        defaultPath: path.join(dir, name),
        filters: ext ? [{ name: `${ext.toUpperCase()} 파일`, extensions: [ext] }, { name: '모든 파일', extensions: ['*'] }] : [],
      });
      if (r.canceled || !r.filePath) return { cancelled: true };
      file = r.filePath;
    }
    try {
      if (source) await fs.promises.copyFile(source, file);
      else await fs.promises.writeFile(file, Buffer.from(f.base64, 'base64'));
    } catch (err) {
      console.warn('[save-as]', err);
      return { error: '저장하지 못했어요. 다른 폴더를 골라 주세요' };
    }
    if (SMOKE) smokeOpened.push({ kind: 'save', target: file });
    return { name: SMOKE ? name : path.basename(file) };
  });
  // ---------- 공유 (내용 단추 › 공유 › 방법 고르기) ----------
  // 공유할 파일: 메모 폴더의 첨부는 그대로, 만든 내용(표 CSV · 글 · 그림 PNG)은 임시 파일로
  const shareSource = (f) => {
    if (f.rel) return attachmentFile(f.rel);
    if (typeof f.base64 !== 'string') return { error: '공유할 내용이 없어요' };
    const root = path.join(app.getPath('temp'), 'memoking-share');
    try {
      fs.mkdirSync(root, { recursive: true });
      // 지난 공유 때 만든 임시 파일은 하루가 지나면 치운다 (공유 창이 넘겨받을 동안은 남겨 두고)
      for (const old of fs.readdirSync(root)) {
        const p = path.join(root, old);
        if (Date.now() - (fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 86_400_000) fs.rmSync(p, { recursive: true, force: true });
      }
      // 공유마다 제 폴더에 (같은 이름으로 잇따라 공유해도 앞의 파일을 덮어쓰지 않게 — 이름은 그대로 보이도록)
      const dir = fs.mkdtempSync(path.join(root, 's-'));
      const file = path.join(dir, safeName(f.name));
      fs.writeFileSync(file, Buffer.from(f.base64, 'base64'));
      return { file };
    } catch (err) {
      console.warn('[share]', err);
      return { error: '공유할 파일을 만들지 못했어요. 다시 눌러 주세요' };
    }
  };
  // 고를 수 있는 방법과 지금 쓸 수 있는지
  ipcMain.handle('share:targets', () => {
    const drive = getDriveAuth()?.connected ?? false;
    const localSend = Boolean(findLocalSend());
    return [
      { id: 'sheet', label: 'Windows 공유', sub: '근처 공유 · Quick Share · 메일 · 카카오톡 등 공유를 받는 앱', ready: process.platform === 'win32' || SMOKE },
      { id: 'drive', label: 'Google Drive 링크', sub: drive ? '올리고 링크를 복사해요 (링크가 있는 사람은 보기)' : '설정에서 Google Drive 를 연결하면 쓸 수 있어요', ready: drive },
      { id: 'localsend', label: 'LocalSend', sub: localSend ? '같은 와이파이의 휴대폰 · PC 로 바로 (오픈소스)' : '무료 오픈소스 앱 — 누르면 내려받기 페이지를 열어요', ready: true },
      { id: 'mail', label: '메일에 첨부', sub: '기본 메일 앱(Outlook 등)의 새 메일에', ready: process.platform === 'win32' || SMOKE },
    ];
  });
  ipcMain.handle('attachment:share', async (e, f = {}) => {
    const via = String(f.via ?? 'sheet');
    const src = shareSource(f);
    if (src.error) return src;
    const { file } = src;
    const title = path.basename(file);
    if (SMOKE) {
      smokeOpened.push({ kind: 'share', via, target: file });
      return via === 'drive' ? { ok: true, link: 'https://drive.google.com/smoke' } : { ok: true };
    }
    if (via === 'drive') {
      const api = getDriveApi();
      if (!api || !getDriveAuth()?.connected) return { error: '설정에서 Google Drive 를 먼저 연결해 주세요' };
      try {
        // 공유 폴더 id 는 따로 (Drive 동기화 폴더를 바꿀 때 settings.drive 를 통째로 갈아 끼우므로)
        const link = await driveShareLink(api, {
          folderId: settings.driveShareFolderId,
          saveFolderId: (id) => {
            settings.driveShareFolderId = id;
            saveSettings();
          },
        }, file, title);
        clipboard.writeText(link);
        return { ok: true, link };
      } catch (err) {
        return { error: err?.status === 403 ? '조직 설정 때문에 링크로 공유할 수 없어요. Windows 공유나 메일을 써 주세요' : `Google Drive 에 올리지 못했어요 (${err?.message ?? err})` };
      }
    }
    if (via === 'localsend') {
      const r = await openLocalSend(file);
      if (r === 'missing') {
        shell.openExternal(LOCALSEND_DOWNLOAD);
        return { missing: true };
      }
      return r === 'ok' ? { ok: true } : { error: `LocalSend 를 열지 못했어요 (${r.replace(/^err /, '')})` };
    }
    if (via === 'mail') {
      const r = await mailAttach(file, title);
      return r === 'ok' ? { ok: true } : { error: /mapi/.test(r) ? '기본 메일 앱을 찾지 못했어요. Windows 공유를 써 보세요' : `새 메일을 만들지 못했어요 (${r.replace(/^err /, '')})` };
    }
    const r = await shareSheet(file, title);
    if (r === 'ok') return { ok: true };
    console.warn('[share] Windows 공유 창:', r);
    shell.showItemInFolder(file); // 공유 창을 열지 못하면 탐색기에서 골라 두어 오른쪽 클릭 › 공유 · 끌어다 보내기
    return { fallback: true, reason: r.replace(/^err /, '') };
  });
  ipcMain.handle('attachment:info', (_e, rel) => {
    let decoded = String(rel ?? '');
    try {
      decoded = decodeURI(decoded);
    } catch {
      // 이미 디코딩됨
    }
    const file = getVault()?.resolve(decoded);
    const stat = file ? fs.statSync(file, { throwIfNoEntry: false }) : null;
    return stat?.isFile() ? { exists: true, size: stat.size } : { exists: false, size: 0 };
  });

  // ---------- 링크 카드 ----------
  ipcMain.handle('link:preview', (_e, url, options) => {
    const vault = getVault();
    if (!vault || settings.linkPreviews === false) return null; // 미리보기를 끄면 사이트에 가지 않는다 (화면 쪽이 깜빡 묻더라도)
    return getLinkPreviews().get(vault, String(url ?? ''), { refresh: Boolean(options?.refresh) });
  });
  ipcMain.handle('link:open', (_e, url) => openWebPage(url));

  // ---------- 드래그 ----------
  ipcMain.handle('drag:start', (_e, id) => wm.dragStart(id));
  ipcMain.on('drag:move', (_e, point) => {
    const p = asPoint(point);
    if (p) wm.dragMove(p);
  });
  ipcMain.handle('drag:end', (_e, point) => wm.dragEnd(asPoint(point)));

  // ---------- 스택 (탭) ----------
  ipcMain.handle('win:close', (event) => senderWindow(event)?.close());
  ipcMain.handle('stack:activate', (_e, id) => Boolean(wm.openNote(String(id))));
  ipcMain.handle('stack:new-tab', (_e, fromId) => {
    const vault = getVault();
    if (!vault?.get(fromId)) return null;
    const id = vault.create({ color: vault.get(fromId).color });
    wm.stacks.addAfter(fromId, id);
    wm.showTab(id);
    return id;
  });
  ipcMain.handle('stack:remove', (_e, id) => wm.removeFromStack(String(id), 'close'));
  ipcMain.handle('stack:detach', (_e, id) => wm.removeFromStack(String(id), 'detach'));
  ipcMain.handle('stack:tear-start', (_e, id, offset, point) => {
    const p = asPoint(point);
    return p ? wm.tearStart(String(id), offset, p) : false;
  });
  ipcMain.on('stack:tear-move', (_e, point) => {
    const p = asPoint(point);
    if (p) wm.tearMove(p);
  });
  ipcMain.handle('stack:tear-end', (_e, point) => wm.tearEnd(asPoint(point)));
  ipcMain.handle('stack:cycle', (_e, id, dir) => {
    const next = wm.stacks?.neighbor(String(id), dir < 0 ? -1 : 1);
    return next ? Boolean(wm.showTab(next)) : false;
  });
  ipcMain.handle('stack:join-menu', (event, id) => {
    const self = String(id);
    const mine = wm.stacks?.stackOf(self);
    const seen = new Set();
    const items = [];
    for (const [m, w] of wm.noteWins) {
      if (m === self || w.isDestroyed() || !w.isVisible() || mine?.memos.includes(m)) continue;
      const key = wm.stacks?.stackOf(m)?.memos[0] ?? m;
      if (seen.has(key)) continue;
      seen.add(key);
      const count = wm.stacks?.stackOf(m)?.memos.length ?? 1;
      items.push({ label: `${getVault()?.get(m)?.title || '제목 없음'}${count > 1 ? ` (탭 ${count}개)` : ''}`, click: () => wm.stackInto(m, self) });
    }
    Menu.buildFromTemplate(items.length ? items : [{ label: '합칠 수 있는 다른 메모 창이 없어요', enabled: false }])
      .popup({ window: senderWindow(event) });
  });
  ipcMain.handle('stack:menu', (event, id) => {
    Menu.buildFromTemplate([
      { label: '따로 떼어 보기', click: () => wm.removeFromStack(String(id), 'detach') },
      { label: '탭 닫기', click: () => wm.removeFromStack(String(id), 'close') },
    ]).popup({ window: senderWindow(event) });
  });

  // ---------- 창 최소화 / 늘 위 / 스티커 ----------
  ipcMain.handle('win:minimize', (event) => senderWindow(event)?.minimize());
  ipcMain.handle('capture:done', (event, rect) => {
    const r = rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])) ? rect : null;
    return wm.finishAreaCapture(event.sender.id, r);
  });
  ipcMain.handle('capture:cancel', () => {
    wm.endAreaCapture();
  });
  ipcMain.handle('list:toggle-top', () => wm.setListOnTop(!wm.listWin?.isAlwaysOnTop()));
  ipcMain.on('sticker:hover', (event, over) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!over, { forward: true });
    wm.stickerHover(event.sender, over);
  });
  ipcMain.handle('sticker:peel', (event) => wm.peelSticker(event.sender));
  ipcMain.handle('list:on-top', () => Boolean(wm.listWin?.isAlwaysOnTop()));
  ipcMain.handle('win:dim-titlebar', (event, level) => {
    if (!wm.listWin || senderWindow(event) !== wm.listWin) return;
    setTitleBarDim(level === 'dialog' || level === 'coach' ? level : false);
    wm.listWin.setTitleBarOverlay(titleBarOverlay());
  });
  ipcMain.handle('win:inking', (event, on) => {
    const win = senderWindow(event);
    if (!win) return;
    if (!on) return void wm.inkingWins.delete(win);
    wm.inkingWins.add(win);
    if (wm.windowDrag && wm.noteWins.get(wm.windowDrag.id) === win) {
      wm.clearStackTarget(wm.windowDrag);
      wm.windowDrag = null;
    }
  });
  // 왕관(늘 위) · 테이프(바탕화면 층): 켜져 있으면 떼고, 아니면 붙인다 (다른 하나가 붙어 있으면 바꿔 붙임) → { top, bottom, canTape }
  ipcMain.handle('win:toggle-layer', (event, id, layer) => {
    if (!senderWindow(event)) return null;
    const key = String(id);
    const want = layer === 'bottom' ? 'bottom' : 'top';
    // 바탕화면 층에 붙일 수 없는 PC 에서 테이프(Ctrl+Shift+G)는 아무 일도 하지 않는다 — 붙어 있던 왕관을 떼지 않게
    if (want === 'bottom' && !wm.canTape) return wm.layerState(key);
    return wm.setNoteLayer(key, wm.layerOf(key) === want ? null : want);
  });
  ipcMain.handle('list:show', () => {
    wm.createListWindow();
  });

  // ---------- OCR 창 결과 수신 ----------
  ipcMain.on('ocr:result', (_e, data) => {
    const job = wm.ocrPending.get(data?.id);
    if (!job) return;
    wm.ocrPending.delete(data.id);
    clearTimeout(job.timer);
    job.resolve(data);
  });
}
