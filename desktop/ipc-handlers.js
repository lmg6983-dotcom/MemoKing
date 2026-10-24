// IPC 라우팅 및 핸들러 등록 — 렌더러와 메인 프로세스 간 통신 채널 바인딩.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectTags } from '../app/js/core/tags.js';
import { autoTagsFor } from '../app/js/core/auto-tags.js';
import { suggestTagsFor } from '../app/js/core/tag-suggest.js';
import { newLockSession, openLock, isLockedBody } from '../app/js/core/memo-lock.js';
import { normalizeReminder, eventFromDate, describeReminder } from '../app/js/core/reminders.js';
import { looksLikeOpmsQuery, learnShapes } from '../app/js/core/opms-search.js';
import { activeModules, memoBodyFromText, magicChips, toggleMagicChip, reorderMagicChips, normalizeMagicSettings } from '../app/js/core/magic-modules.js';
import { WEB_ENGINES, AI_SITES, siteLink, siteUrl } from '../app/js/core/magic-tools.js';
import { searchMemos } from '../app/js/core/memo-search.js';
import { isOpenableFile, foreignSummary, caseMemoMarkdown, normalizeOpmsHost } from './opms.js';
import { isBlankBody } from '../app/js/core/memo-file.js';
import { pdfFileName } from '../app/js/core/pdf-page.js';
import { TUTORIAL_EVENTS } from '../app/js/core/tutorial.js';
import { cleanOverrides, setActionKey } from '../app/js/core/keymap.js';
import { HANDOFF_MS } from '../app/js/core/handoff.js';
import { noteBg, setTitleBarDim, titleBarOverlay, bringToFront, broadcast, APP_ICON_PNG } from './window-utils.js';
import { SMOKE, toast, copyFileToClipboard, smokeOpened } from './utils.js';
import { insideDriveForDesktop } from './drive/drive-sync.js';
import { hotkeyCopyText } from '../app/js/core/memo-hotkeys.js';
import { mailAttach, openLocalSend, findLocalSend, LOCALSEND_DOWNLOAD } from './share-file.js';
import { driveShareLink } from './share-drive.js';
import { UI } from '../app/js/core/ui-text.js';

const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);
// 메뉴를 띄울 자리 (화면이 준 창 안 좌표 — 키보드로 연 메뉴는 마우스 자리가 아니라 그 카드 · 내용 자리에). 없으면 마우스 자리
const popupAt = (at) => (Number.isFinite(at?.x) && Number.isFinite(at?.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : {});
const asPoint = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y) } : null);

export function registerIpc(ctx) {
  const {
    setAppMode,
    setWorkLife,
    setWorkHours,
    calendarFeeds,
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
    findOrCreateDriveFolder,
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
    getUpdater,
    updateState,
    tutorialWin,
    tutorialEvent,
    tutorialAction,
    purgeTrash,
    TRASH_DAYS,
    getStt,
    sttOptions,
    getAi,
    getAiTasks: aiTasks,
    getAiTagger,
    aiNotices,
    showAiNotice,
    getLinkPreviews,
    openWebPage,
    openVaultFile,
    writeClipboard,
    fetchRemoteImage,
    getLastHandoff,
  } = ctx;

  // ---------- 로컬 AI (desktop/ai) ----------
  ipcMain.handle('ai:status', () => getAi()?.status());
  ipcMain.handle('ai:import', async (event, role) => {
    const r = await dialog.showOpenDialog(senderWindow(event), {
      title: '모델 파일(.gguf) 고르기',
      filters: [{ name: 'AI 모델', extensions: ['gguf'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return getAi()?.status();
    try {
      return await getAi().importModel(role, r.filePaths[0]);
    } catch (err) {
      return { ...getAi().status(), error: err.message };
    }
  });
  ipcMain.handle('ai:remove', (_e, role) => getAi()?.remove(role));
  ipcMain.handle('ai:cancel-download', () => getAi()?.cancelDownload());
  // AI 가 뒤에서 한 일 (main.js showAiNotice): 메모 창 아래 막대 — 마지막 것부터 보이고, 되돌리거나 닫으면 그 앞의 것
  const lastNotice = (id) => aiNotices.get(id)?.at(-1) ?? null;
  const dropNotice = (id) => {
    const left = (aiNotices.get(id) ?? []).slice(0, -1);
    if (left.length) aiNotices.set(id, left);
    else aiNotices.delete(id);
  };
  ipcMain.handle('ai:notice', (_e, id) => (lastNotice(String(id)) ? { text: lastNotice(String(id)).text } : null));
  ipcMain.handle('ai:notice-undo', (_e, id) => {
    const n = lastNotice(String(id));
    dropNotice(String(id));
    const r = n ? n.undo() : { ok: false, message: '되돌릴 것이 없어요' };
    const next = lastNotice(String(id));
    return { ...r, next: next && { text: next.text } };
  });
  ipcMain.handle('ai:notice-dismiss', (_e, id) => {
    dropNotice(String(id));
    const next = lastNotice(String(id));
    return next && { text: next.text };
  });
  ipcMain.handle('ai:download-default', async () => {
    try {
      return await getAi().downloadDefault();
    } catch (err) {
      return { ...getAi().status(), error: err.message };
    }
  });
  // 글 도우미 · AI 검색 (core/ai-tasks.js — 휴대폰과 같은 흐름). 조각은 ai:token, 진행은 ai:progress 로 보낸 창에
  const aiJobs = new Map(); // 보낸 창:작업 → 멈추기
  async function aiJob(e, id, run) {
    const key = `${e.sender.id}:${id}`;
    const ctrl = new AbortController();
    aiJobs.set(key, ctrl);
    const send = (channel, data) => !e.sender.isDestroyed() && e.sender.send(channel, { id, ...data });
    try {
      return await run({
        signal: ctrl.signal,
        onToken: (text) => send('ai:token', { text }),
        onProgress: (done, total) => send('ai:progress', { done, total }),
      });
    } catch (err) {
      return { error: err.message };
    } finally {
      aiJobs.delete(key);
    }
  }
  ipcMain.handle('ai:write', (e, { id, ...job }) => aiJob(e, id, (o) => aiTasks().write(job, o)));
  ipcMain.handle('ai:ask', (e, { id, question }) => aiJob(e, id, (o) => aiTasks().ask(question, o)));
  ipcMain.handle('ai:cancel', (e, id) => aiJobs.get(`${e.sender.id}:${id}`)?.abort());
  ipcMain.handle('ai:try', async () => {
    const started = Date.now();
    try {
      const text = await getAi().chat([{ role: 'user', content: '메모 앱을 한 문장으로 소개해 주세요.' }], { maxTokens: 80 });
      return { text, seconds: (Date.now() - started) / 1000 };
    } catch (err) {
      return { error: err.message };
    }
  });

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
    else tutorialAction(action); // jump:<번호> · enable:workLife
  });
  ipcMain.handle('tutorial:event', (_e, name) => {
    if (TUTORIAL_EVENTS.includes(name) && name !== 'memo-created' && name !== 'note-closed') tutorialEvent(name);
  });

  // ---------- 메모 목록·검색·태그 ----------
  ipcMain.handle('memos:list', () => wm.listMemos());
  ipcMain.handle('tags:list', () => collectTags(getVault()?.list() ?? []));
  ipcMain.handle('tags:suggest', (_e, body, id) => suggestTagsFor(String(body ?? ''), getVault()?.bodies() ?? [], { excludeId: id }));
  // 추천 태그 막대 › AI로 고르기 (이 PC 안의 글 모델, 후보 중에서만)
  ipcMain.handle('tags:ai', async (_e, body, id) => {
    try {
      return await aiTasks().pickTags(String(body ?? ''), id);
    } catch (err) {
      return { error: err.message };
    }
  });
  // 메모 창을 닫은 뒤: AI 가 고른 태그를 사용자 태그와 합쳐 3개까지 (설정 › 태그 자동 추가, ai/ai-tagger.js).
  //   모델을 올리는 몇 초 동안 창이 안 닫히면 안 되므로 창은 먼저 닫고 뒤에서 한다
  ipcMain.handle('tags:ai-auto', (_e, id) => {
    getAiTagger()?.add([String(id)]);
  });
  // 설정 › AI 도우미: 아직 보지 않은 모든 메모에 AI 태그 · 멈추기 · AI 태그 모두 지우기
  ipcMain.handle('tags:ai-all', () => getAiTagger()?.all());
  ipcMain.handle('tags:ai-stop', () => getAiTagger()?.stop());
  ipcMain.handle('tags:ai-clear', () => getAiTagger()?.clearAll() ?? 0);
  ipcMain.handle('tags:ai-status', () => getAiTagger()?.status() ?? null);
  ipcMain.handle('tags:auto', (_e, body, source, id) => autoTagsFor(String(body ?? ''), getVault()?.bodies() ?? [], { source, excludeId: id }));
  ipcMain.handle('memos:search', (_e, query, excludeId) => wm.withOpenFlag(getVault()?.search(String(query ?? ''), excludeId) ?? []));

  // ---------- 예약 알림 ----------
  ipcMain.handle('reminders:set', (_e, id, list) => {
    const vault = getVault();
    if (!vault || !Array.isArray(list)) return null;
    const reminders = list.map((r) => normalizeReminder(r)).filter(Boolean);
    const saved = vault.setReminders(id, reminders);
    if (!saved) throw new Error(UI.savedElsewhere);
    wm.sendToNote(id, 'memo:reminders', saved);
    pushReminders();
    alarms.tick();
    return saved;
  });
  ipcMain.handle('reminders:all', () => getVault()?.allReminders() ?? []);
  // body: 새 메모를 만들 때 쓸 본문 (다른 캘린더 일정 가져오기 — 달력 그림 · 장소 · 설명). 없으면 "# 일정 이름" 만
  ipcMain.handle('reminders:add', (_e, id, reminder, newTitle, body) => {
    const vault = getVault();
    if (!vault) return null;
    const r = normalizeReminder(reminder);
    if (!r) return null;
    let memoId = id ? String(id) : null;
    if (!memoId) {
      const title = String(newTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '새 일정';
      memoId = vault.import({ body: typeof body === 'string' && /^# \S/.test(body) ? body.slice(0, 20000) : `# ${title}\n` });
    }
    const memo = memoId ? vault.get(memoId) : null;
    if (!memo) throw new Error(UI.memoPickAgain);
    const saved = vault.setReminders(memoId, [...(memo.reminders ?? []), r]);
    if (!saved) throw new Error(UI.savedElsewhere);
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

  // ---------- 일정 탭: 다른 캘린더 구독 (.ics 주소 — 이 PC 설정에만) ----------
  ipcMain.handle('calendars:feeds', () => calendarFeeds.list());
  ipcMain.handle('calendars:set-feeds', (_e, list) => calendarFeeds.save(Array.isArray(list) ? list : []));
  // Google 캘린더 상호 동기화
  ipcMain.handle('calendars:fetch', (_e, id, force) => calendarFeeds.get(String(id ?? ''), { force: force === true }));

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
  ipcMain.handle('drive:folders', async (_e, parent) => {
    const api = getDriveApi();
    if (!api) throw new Error(UI.driveUnavailable);
    return (await api.folders(String(parent || 'root'))).map((f) => ({ id: f.id, name: f.name, created: f.created }));
  });
  // 같은 이름 폴더가 이미 있으면 새로 만들지 않고 그것을 돌려준다 (existed: true)
  ipcMain.handle('drive:create-folder', async (_e, parent, name) => {
    const f = await findOrCreateDriveFolder(String(parent || 'root'), String(name).trim());
    return { id: f.id, name: f.name, created: f.created, existed: f.existed };
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
  // 자동 업데이트 (updater.js): 상태 · 확인(설정의 단추) · 받기 · 나중에 · 지금 재시작
  ipcMain.handle('update:state', () => updateState());
  ipcMain.handle('update:check', async () => {
    const r = await getUpdater()?.check({ manual: true });
    // 확인할 수 없는 때(개발 실행 · 준비 실패)는 그 결과를 그대로 — 상태는 바뀌지 않아 그냥 돌려주면 아무 안내도 없다
    if (r && (r.status === 'dev' || (r.status === 'error' && r !== getUpdater()?.state))) return { ...updateState(), ...r };
    return updateState();
  });
  ipcMain.handle('update:download', async () => {
    await getUpdater()?.download();
    return updateState();
  });
  ipcMain.handle('update:later', () => {
    getUpdater()?.later();
    return updateState();
  });
  ipcMain.handle('update:install', () => getUpdater()?.installNow() ?? false);
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
  // 메모킹 Work / Life 바꾸기 — 목록이 그 모드의 메모만 보이고, 새 메모(빠른 메모 · 캡처 포함)도 그 모드로
  ipcMain.handle('mode:set', (_e, mode) => setAppMode(mode));
  ipcMain.handle('mode:hours', (_e, hours) => setWorkHours(hours));
  ipcMain.handle('mode:work-life', (_e, on) => setWorkLife(on)); // 설정 › Work / Life 나누기
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
  ipcMain.handle('app:set-auto-events', (_e, on) => {
    settings.autoEvents = Boolean(on);
    saveSettings();
    return settings.autoEvents;
  });
  ipcMain.handle('app:set-magic-polish', (_e, on) => {
    settings.magicPolish = Boolean(on);
    saveSettings();
    return settings.magicPolish;
  });
  ipcMain.handle('app:set-magic', (_e, next) => setMagicSettings({ ...next, order: settings.magic?.order })); // 순서는 매직키 창에서만 바꾼다 (열어 둔 설정 창의 지난 순서로 덮지 않게)
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
  const magicModuleList = () => magicChips(settings.magic).map(({ id, name, chip, description, on }) => ({ id, name, chip, description, on }));
  ipcMain.handle('magic:modules', () => magicModuleList());
  ipcMain.handle('magic:toggle-module', (_e, id) => {
    setMagicSettings(toggleMagicChip(settings.magic, String(id)));
    return magicModuleList();
  });
  ipcMain.handle('magic:reorder-modules', (_e, ids) => {
    setMagicSettings(reorderMagicChips(settings.magic, Array.isArray(ids) ? ids.map(String) : []));
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
    const memos = mods.has('notes') && vault ? vault.searchable() : [];
    const updatedOf = new Map(memos.map((m) => [m.id, m.updated]));
    // 한 번에 앞 5건 + 맞는 것 전부의 개수 — 예전에는 개수를 세려고 한 번 더 찾았다
    const found = searchMemos(memos, q, 5);
    const notes = found.map((n) => ({ ...n, updated: updatedOf.get(n.id) }));
    const notesTotal = found.total;
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
  // 웹 검색 · AI 에게 묻기 기본 사이트 (매직키 창의 할 일 단추 순서)
  ipcMain.handle('magic:prefs', () => {
    const m = normalizeMagicSettings(settings.magic);
    return { engine: m.engine, ai: m.ai, opms: Boolean(wm.opmsSettings().host), opmsShapes: settings.opmsShapes ?? [] }; // opms: 서버 주소를 넣었나 (없으면 "OPMS 에서 찾기" 줄도 없음)
  });
  // 계산 결과 복사 · 웹 검색 · AI 에게 묻기 · 사이트 열기 — 고른 줄을 실행할 때만 브라우저로 (주소는 여기서 만든다)
  ipcMain.handle('magic:tool', (_e, req) => {
    const mods = new Set(activeModules(settings.magic).map((m) => m.id));
    const text = String(req?.text ?? '').slice(0, 4000);
    if (req?.type === 'copy' && mods.has('calc')) {
      if (!SMOKE) clipboard.writeText(text); // 점검은 진짜 클립보드를 건드리지 않는다
      return { ok: true, message: '계산 결과를 복사했어요' };
    }
    if (req?.type === 'site' && mods.has('web')) {
      const url = siteUrl(text);
      return { ok: Boolean(url && openWebPage(url)) };
    }
    const kind = req?.type === 'web' ? 'web' : req?.type === 'ai' ? 'ai' : null;
    if (!kind || !mods.has(kind)) return { ok: false };
    const link = siteLink(kind === 'web' ? WEB_ENGINES : AI_SITES, String(req.site), text);
    if (!link) return { ok: false };
    // 주소로 질문을 넘길 수 없는 사이트(Gemini)는 질문을 복사해 두고 연다
    if (link.paste && !SMOKE) clipboard.writeText(text.trim());
    if (!openWebPage(link.url)) return { ok: false };
    if (link.paste) toast({ title: `${link.name} 를 열었어요`, body: '질문을 복사해 두었어요. 입력 칸에 붙여 넣기(Ctrl+V)만 하면 돼요' });
    return { ok: true };
  });
  // 사용자가 골라 찾은 사건의 번호 양식을 배워 둔다 — 같은 양식의 번호는 앞으로 매직키가 저절로 찾는다 (설정에서 지우기)
  const learnOpms = (rows) => {
    const next = learnShapes(settings.opmsShapes, rows);
    if (next !== settings.opmsShapes) {
      settings.opmsShapes = next;
      saveSettings();
    }
    return next;
  };
  ipcMain.handle('magic:opms-search', async (_e, query) => {
    const q = String(query ?? '').slice(0, 40);
    if (!activeModules(settings.magic).some((m) => m.id === 'opms') || !looksLikeOpmsQuery(q)) return { cases: [], total: 0 };
    if (!wm.opmsSettings().host) return { cases: [], total: 0, error: '설정 매직키의 OPMS 연결에 서버 주소를 넣으면 OPMS 사건도 찾아요' }; // 주소를 넣기 전
    try {
      // 정확한 것부터 6건 (번호 일부 · 출원인 · 발명자 · 초성), 나머지는 "OPMS 다른 n건 더 보기"
      const { rows, total } = await wm.opmsClient().search(q, { timeoutMs: 5000, retries: 0, limit: 60 });
      const top = rows.slice(0, 6);
      wm.rememberCases(top);
      return { cases: top.map((r) => wm.opmsBrief(r, q)), total, shapes: learnOpms(rows) };
    } catch (err) {
      return { cases: [], total: 0, error: err.offline ? '사내망에 연결돼 있지 않아 OPMS 를 찾지 못했어요' : err.message };
    }
  });

  // ---------- OPMS 창 ----------
  // OPMS 창: 정확한 것부터 200건까지 + 맞는 것 전부의 개수
  ipcMain.handle('opms:search', async (_e, query) => {
    const q = String(query ?? '').slice(0, 60);
    const { rows, total } = await wm.opmsClient().search(q, { retries: 1 });
    wm.rememberCases(rows);
    learnOpms(rows);
    return { list: rows.map((r) => wm.opmsBrief(r, q)), total };
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
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('opms:progress', { ...p, idx: c.idx }); }, // 여러 사건을 함께 받아도 어느 사건의 진행인지 알게
    });
    for (const u of gone) res.failed.push({ upload: u, name: path.basename(u), error: 'OPMS 목록에서 사라졌어요. 새로 고침 해 주세요' });
    wm.opmsDirs.add(res.dir);
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
  // 설정 › 매직키 › OPMS: 서버 주소 · 전자포대 폴더 (코드에 두지 않고 사용자가 넣는다)
  ipcMain.handle('opms:settings', () => ({ ...wm.opmsSettings(), hostSet: Boolean(wm.opmsSettings().host), shapes: settings.opmsShapes ?? [] }));
  ipcMain.handle('opms:clear-shapes', () => {
    settings.opmsShapes = [];
    saveSettings();
    return [];
  });
  ipcMain.handle('opms:set-host', (_e, text) => {
    const raw = String(text ?? '').trim();
    const host = raw ? normalizeOpmsHost(raw) : '';
    if (host == null) return { error: '주소를 알아보지 못했어요. 예: 192.168.0.10:8181 또는 http://서버이름:8181' };
    settings.opms = { ...settings.opms, host };
    saveSettings();
    return { ok: true, host };
  });
  // 폴더 열기: dir 이 이번에 받은 사건 폴더면 그 폴더, 아니면 전자포대 저장 폴더 (화면이 아무 경로나 열게 하지 않는다)
  ipcMain.handle('opms:open-folder', async (_e, dir) => {
    const target = typeof dir === 'string' && wm.opmsDirs.has(dir) ? dir : wm.opmsSettings().wrapperDir;
    await fs.promises.mkdir(target, { recursive: true }).catch(() => {});
    return SMOKE ? target : shell.openPath(target);
  });
  ipcMain.handle('opms:choose-dir', async (event) => {
    const r = await dialog.showOpenDialog(senderWindow(event), { title: '전자포대를 저장할 폴더', defaultPath: wm.opmsSettings().wrapperDir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return wm.opmsSettings().wrapperDir;
    settings.opms = { ...settings.opms, wrapperDir: r.filePaths[0] };
    getFileIndex()?.watch([r.filePaths[0]]);
    saveSettings();
    return r.filePaths[0];
  });
  ipcMain.handle('opms:copy', (_e, text) => clipboard.writeText(String(text ?? '').slice(0, 20000))); // 서지사항 전체(긴 비고 포함)도
  ipcMain.handle('opms:to-memo', async (_e, idx) => {
    const vault = getVault();
    if (!vault) throw new Error(UI.noVault);
    const known = wm.caseOf(idx);
    const client = wm.opmsClient();
    const c = (await client.caseByIdx(known.idx).catch(() => null)) ?? known;
    const [foreign, mywork, details] = await Promise.all([client.foreign(c).catch(() => []), client.mywork(c.idx).catch(() => []), client.details(c).catch(() => null)]);
    const id = vault.import({ body: caseMemoMarkdown(c, { mywork, foreign, summary: foreignSummary(c, foreign), details }) });
    if (!id) throw new Error('메모를 만들지 못했어요. 메모 폴더의 쓰기 권한과 빈 공간을 확인하고 다시 해 주세요');
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
    const searchable = mods.has('notes') && vault ? vault.searchable() : [];
    const updatedOf = new Map(searchable.map((m) => [m.id, m.updated]));
    const notes = searchable.length ? searchMemos(searchable, q, 300).map((n) => ({ kind: 'note', ...n, updated: updatedOf.get(n.id) })) : [];
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
  // 매직키로 저장한 메모를 뒤에서 다듬고(맞춤법 · 띄어쓰기 · 긴 첫 줄이면 제목, core/ai-tasks.js polish) 그다음 AI 태그.
  //   창은 이미 닫혔다. 연 메모 · 그사이 고친 메모는 건드리지 않고, 알림을 누르면 원래 글로 (이전 버전에도 남음)
  async function polishMagicMemo(id) {
    const vault = getVault();
    const before = vault?.get(id)?.body;
    try {
      if (before && settings.magicPolish !== false && ['ready', 'running'].includes((await getAi().status()).chat?.state)) {
        const r = await aiTasks().polish(before);
        const untouched = () => getVault() === vault && !wm.noteWins.has(id);
        if (r.body !== before && untouched() && vault.get(id)?.body === before && !vault.save(id, r.body).refused) {
          const what = [r.fixes && `맞춤법 ${r.fixes}곳`, r.title && `제목 "${r.title}"`].filter(Boolean).join(' · ');
          showAiNotice(id, {
            title: 'AI 가 메모를 다듬었어요', body: what, text: `AI 가 다듬었어요: ${what}`,
            undo: () => {
              if (getVault() !== vault || vault.get(id)?.body !== r.body) return { ok: false, message: '그사이 고쳐서 되돌리지 않았어요. 메뉴 › 이전 버전에서 원래 글을 볼 수 있어요' };
              if (vault.save(id, before).refused) return { ok: false, message: '되돌리지 못했어요. 메뉴 › 이전 버전에서 원래 글을 볼 수 있어요' };
              wm.sendToNote(id, 'memo:external', vault.get(id));
              return { ok: true, message: '원래 글로 돌렸어요' };
            },
          });
        }
      }
    } catch (err) {
      console.error('AI 다듬기', err.message); // 다듬지 못해도 메모는 이미 저장됨
    }
    getAiTagger()?.add([id]);
  }
  ipcMain.handle('magic:run', (_e, payload) => {
    const vault = getVault();
    const mods = activeModules(settings.magic);
    if (!vault || payload?.module !== 'memo' || !mods.some((m) => m.id === 'memo')) return { ok: false };
    const body = memoBodyFromText(payload.text);
    if (!body) return { ok: false };
    const id = vault.import({ body });
    if (!id) return { ok: false };
    // "알림 맞춰 저장": 글 속 날짜로 일정 하나 (미리 알림은 기본값 — 바꾸려면 메모의 종 버튼)
    const reminder = payload.remind ? eventFromDate(payload.remind) : null;
    const saved = reminder ? vault.setReminders(id, [reminder]) : null;
    if (saved) {
      pushReminders();
      alarms.tick();
    }
    const when = saved ? `\n알림: ${describeReminder(saved[0])}` : '';
    if (payload.open) getAiTagger()?.add([id]); // 연 메모는 다듬지 않고, 태그는 닫을 때
    else polishMagicMemo(id);
    if (payload.open) wm.openNote(id);
    else {
      const showNow = () => wm.openNote(id, { inactive: true });
      if (!toast({ memoId: id, kind: 'magic-memo', title: UI.memoCreated, body: `${body.split('\n')[0].slice(0, 40)}${when}\n눌러서 열기`, onClick: () => wm.revealNote(id), onFail: showNow })) showNow();
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
  ipcMain.handle('memo:open', (e, id) => {
    // 목록에서 고른 테이프 메모: 테이프를 떼고 앞으로
    const untaped = e.sender === wm.listWin?.webContents && wm.untapeFromList(String(id));
    const win = wm.openNote(id);
    // 바탕화면 층에서 풀리는 사이 뒤로 밀렸을 수 있다 — 한 번 더 위로만 (입력은 뺏지 않게 moveTop)
    if (untaped && win) setTimeout(() => !win.isDestroyed() && win.moveTop(), 300);
    return Boolean(win);
  });
  ipcMain.handle('memo:handoff', () => {
    const last = getLastHandoff();
    return (last && Date.now() - last.at < HANDOFF_MS && !wm.noteWins.has(last.id) ? last : null);
  });
  ipcMain.handle('memo:create', (_e, options) => wm.createNote(options ?? {}));
  ipcMain.handle('memo:import', (_e, body, opts) => {
    const vault = getVault();
    if (!vault) throw new Error(UI.noVault);
    const id = vault.import({ body: String(body ?? '').slice(0, 5_000_000) });
    if (!id) throw new Error('이 파일로는 메모를 만들 수 없어요. 글 파일(.txt, .md 등)을 골라 주세요');
    if (opts?.open) wm.openNote(id);
    return id;
  });
  ipcMain.handle('memo:get', (_e, id) => {
    const memo = getVault()?.get(id);
    if (!memo) return null;
    const alarm = wm.pendingAlarms.get(id) ?? null;
    const capture = wm.pendingCaptures.get(id) ?? null;
    const command = wm.pendingCommands.get(id) ?? null;
    wm.pendingAlarms.delete(id);
    wm.pendingCaptures.delete(id);
    wm.pendingCommands.delete(id);
    return { ...memo, ...wm.layerState(id), onTop: settings.onTop[id] === true, alarm, capture, command, stack: wm.stackState(id), linkPreviews: settings.linkPreviews !== false, workLife: settings.workLife === true };
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
      return vault?.openLock(String(id), session) ?? { error: UI.memoOpenFail };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('memo:unlock', (_e, id) => {
    const vault = getVault();
    if (!vault) return { error: '메모 폴더가 열려 있지 않아요' };
    const m = vault.get(String(id));
    if (!m) return { error: UI.memoMissing };
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
  const setMemo = (id, patch) => {
    const memo = getVault()?.setMeta(id, patch ?? {});
    const win = wm.noteWins.get(id);
    if (memo && win) {
      win.setBackgroundColor(noteBg(memo.color, settings.workLife === true ? memo.mode ?? 'life' : null));
      win.webContents.send('memo:meta', memo);
    }
    return memo;
  };
  ipcMain.handle('memo:set', (_e, id, patch) => setMemo(id, patch));
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
        toast({ title: '휴지통으로 옮겼어요', body: `“${title || '제목 없음'}” 메모는 목록 설정의 휴지통에서 되살릴 수 있어요` });
      }
    }
    return Boolean(ok);
  });

  // ---------- 그림/PDF 저장 ----------
  ipcMain.handle('image:copy', async (_e, base64) => {
    await writeClipboard({ png: Buffer.from(String(base64), 'base64') });
    return { ok: true };
  });
  // fileName: 메모가 아닌 그림(회상 한 장으로)의 이름
  ipcMain.handle('image:save', async (event, id, base64, fileName) => {
    const memo = id ? getVault()?.get(String(id)) : null;
    const name = typeof fileName === 'string' && /^[^\\/:*?"<>|]{1,120}\.png$/i.test(fileName) ? fileName : `${pdfFileName(memo?.title ?? '메모').replace(/\.pdf$/i, '')}.png`;
    let file = SMOKE ? path.join(app.getPath('temp'), `memoking-smoke-${Date.now()}.png`) : null;
    if (!file) {
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) ?? undefined, {
        title: UI.saveAsImage,
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
    if (!file || !fs.existsSync(file)) throw new Error('파일을 찾지 못했어요. 메모 폴더에서 삭제됐거나 옮겨졌는지 확인해 주세요');
    if (fs.statSync(file).size > 500 * 1024 * 1024) throw new Error('파일이 너무 커요 (500MB 넘음). 더 작은 파일로 해 주세요');
    return new Uint8Array(fs.readFileSync(file));
  });
  ipcMain.handle('attachment:save', (_e, bytes, ext) => {
    const vault = getVault();
    if (!vault) throw new Error(UI.noVault);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('넣으려는 파일을 읽지 못했어요. 파일을 다시 골라 주세요');
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
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return '파일을 찾지 못했어요. 메모 폴더에서 옮겨졌거나 삭제됐는지 확인해 주세요.';
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
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return { error: '파일을 찾지 못했어요. 메모 폴더에서 옮겨졌거나 삭제됐는지 확인해 주세요' };
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
  // ---------- 끌어내기 (메모 안 내용 → 탐색기 · 바탕화면 · 카카오톡 같은 다른 프로그램) ----------
  //   메모 폴더의 첨부 그대로 끌면 받는 쪽이 "이동" 으로 가져가 첨부가 사라질 수 있고 이름도 날짜 이름이라, 보이는 이름의 임시 복사본을 끈다.
  //   임시 복사본은 memoking-drag 폴더에 (화면이 이 폴더에서 온 파일이 도로 떨어지면 무시한다), 한 시간이 지나면 치운다
  const DRAG_ROOT = path.join(app.getPath('temp'), 'memoking-drag');
  const dragIcon = () => nativeImage.createFromPath(APP_ICON_PNG).resize({ width: 40, height: 40 });
  ipcMain.on('attachment:drag-out', (event, f = {}) => {
    try {
      let bytes = null;
      let source = null;
      if (f.rel) {
        const found = attachmentFile(f.rel);
        if (found.error) return;
        source = found.file;
      } else if (typeof f.base64 === 'string') bytes = Buffer.from(f.base64, 'base64');
      else return;
      fs.mkdirSync(DRAG_ROOT, { recursive: true });
      for (const old of fs.readdirSync(DRAG_ROOT)) {
        const p = path.join(DRAG_ROOT, old);
        if (Date.now() - (fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 3_600_000) fs.rmSync(p, { recursive: true, force: true });
      }
      let name = safeName(f.name).slice(0, 120);
      const ext = source ? path.extname(source) : '';
      if (ext && !path.extname(name)) name += ext; // 이름에 확장자가 없으면 원래 파일의 것을 (받는 쪽이 파일 종류를 알도록)
      const dir = fs.mkdtempSync(path.join(DRAG_ROOT, 'd-'));
      const file = path.join(dir, name);
      if (source) fs.copyFileSync(source, file);
      else fs.writeFileSync(file, bytes);
      if (SMOKE) return void smokeOpened.push({ kind: 'drag-out', target: file });
      event.sender.startDrag({ file, icon: dragIcon() });
    } catch (err) {
      console.warn('[drag-out]', err);
    }
  });
  // 고를 수 있는 방법과 지금 쓸 수 있는지
  ipcMain.handle('share:targets', () => {
    const drive = getDriveAuth()?.connected ?? false;
    const localSend = Boolean(findLocalSend());
    return [
      { id: 'drive', label: 'Google Drive 링크', sub: drive ? '올리고 링크를 복사해요 (링크가 있는 사람은 보기)' : '아직 연결 전이에요. 눌러서 설정에서 연결하기', ready: drive, connect: !drive },
      { id: 'localsend', label: 'LocalSend', sub: localSend ? '같은 와이파이의 휴대폰, PC 로 바로 (오픈소스)' : '무료 오픈소스 앱, 누르면 내려받기 페이지를 열어요', ready: true },
      { id: 'mail', label: '메일에 첨부', sub: '기본 메일 앱(Outlook 등)의 새 메일에', ready: process.platform === 'win32' || SMOKE },
    ];
  });
  // 공유가 안 될 때 까닭을 남긴다 (설정 폴더의 share.log — 사용자가 보내 주면 고칠 수 있게)
  const shareLog = (via, what) => {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'share.log'), `${new Date().toISOString()} [${via}] ${String(what).slice(0, 2000)}\n`);
    } catch {
      // 못 남겨도 공유는 계속
    }
  };
  ipcMain.handle('attachment:share', async (e, f = {}) => {
    const r = await shareOnce(f);
    if (r?.error) shareLog(String(f.via ?? ''), r.error);
    return r;
  });
  const shareOnce = async (f) => {
    const via = String(f.via ?? '');
    if (!['drive', 'localsend', 'mail'].includes(via)) return { error: '공유 방법을 다시 골라 주세요' };
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
        return { error: err?.status === 403 ? '조직 설정 때문에 링크로 공유할 수 없어요. 메일이나 LocalSend 를 써 주세요' : `Google Drive 에 올리지 못했어요 (${err?.message ?? err})` };
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
    // 남은 것은 메일 (위에서 방법을 걸렀다)
    const r = await mailAttach(file, title);
    return r === 'ok' ? { ok: true } : { error: /mapi/.test(r) ? '기본 메일 앱을 찾지 못했어요. Google Drive 링크나 LocalSend 를 써 보세요' : `새 메일을 만들지 못했어요 (${r.replace(/^err /, '')})` };
  };
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
  // 탭 줄 안에서 끌어 순서 바꾸기
  ipcMain.handle('stack:reorder', (_e, id, index) => {
    const stack = wm.stacks?.reorder(String(id), index);
    if (stack) wm.pushStackTo(stack.memos);
    return Boolean(stack);
  });
  ipcMain.handle('stack:activate', (_e, id) => Boolean(wm.openNote(String(id))));
  const newTabAfter = (fromId) => {
    const vault = getVault();
    if (!vault?.get(fromId)) return null;
    const id = vault.create({ color: vault.get(fromId).color });
    wm.stacks.addAfter(fromId, id);
    wm.showTab(id);
    return id;
  };
  ipcMain.handle('stack:new-tab', (_e, fromId) => newTabAfter(fromId));
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
  // 이 창을 합칠 수 있는 다른 메모 창들 (탭 막대 › 합치기 · 탭 오른쪽 클릭 › 다른 창과 합치기)
  const joinItems = (self) => {
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
    return items.length ? items : [{ label: '합칠 수 있는 다른 메모 창이 없어요', enabled: false }];
  };
  ipcMain.handle('stack:join-menu', (event, id) => {
    Menu.buildFromTemplate(joinItems(String(id))).popup({ window: senderWindow(event) });
  });
  // 목록 카드 오른쪽 클릭 메뉴는 화면이 그린다 (app/js/list.js · ctx-menu.js — 아이콘 줄을 네이티브 메뉴는 못 그린다). 여기는 그 메뉴가 부르는 일들
  //   잠그기 · 이전 버전은 메모 창을 열어 그 창에서
  const CARD_COMMANDS = new Set(['lock', 'unlock', 'versions']);
  ipcMain.handle('card:command', (_e, rawId, command) => {
    const id = String(rawId);
    if (!getVault()?.get(id) || !CARD_COMMANDS.has(command)) return false;
    const win = wm.noteWins.get(id);
    if (win && !win.webContents.isLoading()) {
      wm.openNote(id);
      win.webContents.send('memo:command', command);
    } else {
      wm.pendingCommands.set(id, command);
      wm.openNote(id);
    }
    return true;
  });
  ipcMain.handle('card:copy', async (_e, rawId) => {
    const m = getVault()?.get(String(rawId));
    if (!m || m.locked) return false;
    return writeClipboard({ text: hotkeyCopyText(m.body) }).then(() => true, () => false);
  });
  // 메모 공유: 글을 "제목.txt" 파일로 (Drive 링크 · LocalSend · 메일은 파일을 보낸다) — share:targets · attachment:share 가 이어서
  ipcMain.handle('card:share-file', (_e, rawId) => {
    const m = getVault()?.get(String(rawId));
    if (!m) return { error: UI.memoPickAgain };
    if (m.locked) return { error: '잠긴 메모는 잠금을 풀어야 공유할 수 있어요' };
    const text = hotkeyCopyText(m.body);
    if (!text.trim()) return { error: '공유할 글이 없어요' };
    return { base64: Buffer.from(text, 'utf8').toString('base64'), name: `${safeName(m.title || '메모').slice(0, 60)}.txt`, mime: 'text/plain' };
  });
  // 화면이 그린 메뉴(표 오른쪽 클릭)의 편집 명령 — 그 창의 포커스가 있는 글 칸에 (네이티브 메뉴의 role 과 같은 일)
  ipcMain.handle('edit:run', async (event, name) => {
    const wc = event.sender;
    if (name === 'cut') wc.cut();
    else if (name === 'copy') wc.copy();
    else if (name === 'paste') wc.paste();
    else if (name === 'pastePlain') wc.send('edit:paste-plain', await clipboard.readText());
    return true;
  });
  // 화면이 정한 오른쪽 클릭 메뉴 (메모 창 내용 — block-move.js): [{ id, label, accelerator? } | { type: 'separator' }], 자리 { x, y }? → 고른 id | null
  //   점검(SMOKE)에서는 띄우지 않고 globalThis.mkSmokeMenu 에 두어 점검이 고른다
  ipcMain.handle('menu:choose', (event, raw, at) => new Promise((resolve) => {
    const items = (Array.isArray(raw) ? raw : []).slice(0, 24).filter((it) => it && (it.type === 'separator' || (typeof it.id === 'string' && typeof it.label === 'string')));
    if (!items.some((it) => it.type !== 'separator')) return resolve(null);
    let chosen = null;
    if (SMOKE) {
      globalThis.mkSmokeMenu = { items, pick: (id) => resolve(items.some((it) => it.id === id) ? id : null) };
      return;
    }
    Menu.buildFromTemplate(items.map((it) => (it.type === 'separator' ? { type: 'separator' }
      : { label: it.label.slice(0, 80), enabled: it.enabled !== false, ...(typeof it.accelerator === 'string' ? { accelerator: it.accelerator, registerAccelerator: false } : {}), click: () => (chosen = it.id) })))
      // 메뉴가 닫힌 뒤에 click 이 오는 경우가 있어 한 박자 기다렸다 알린다
      .popup({ window: senderWindow(event), ...popupAt(at), callback: () => setTimeout(() => resolve(chosen), 50) });
  }));
  ipcMain.handle('stack:menu', (event, id) => {
    const self = String(id);
    Menu.buildFromTemplate([
      { label: '오른쪽에 새 탭', click: () => newTabAfter(self) },
      { label: '다른 창과 합치기', submenu: joinItems(self) },
      { type: 'separator' },
      { label: '따로 떼어 보기', click: () => wm.removeFromStack(self, 'detach') },
      { label: '탭 닫기', click: () => wm.removeFromStack(self, 'close') },
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
  ipcMain.handle('list:crown-docked', () => wm.listCrownDocked());
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
  // 메모 창 상태 줄이 잘렸을 때 전문 말풍선 (null 이면 거둠) — 메모 창만
  ipcMain.handle('win:status-bubble', (event, b) => {
    const owner = senderWindow(event);
    if (!owner || ![...wm.noteWins.values()].includes(owner)) return;
    if (b?.text) return wm.statusBubbles.show(owner, { text: String(b.text), error: Boolean(b.error), x: Number(b.x) || 0 }); // → 보였는지
    wm.statusBubbles.hide(owner);
    return false;
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
