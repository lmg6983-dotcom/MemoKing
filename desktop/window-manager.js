// 창 관리자 (WindowManager) — 목록 창, 메모 스티커 창, 탭 스택, 드래그 미리보기, 캡처 오버레이, PDF 및 보조 창 생명주기 관리.
import {
  app, BrowserWindow, desktopCapturer, dialog, nativeTheme, screen, shell,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, dropBounds, DEFAULT_NOTE_SIZE } from './placement.js';
import { StackStore } from './stacks.js';
import { ForegroundWatch, LEAVE_ON_TOP, hwndOf } from './foreground-watch.js';
import { Opms, isOpenableFile, cleanDate, foreignSummary, caseMemoMarkdown, DEFAULT_HOST as OPMS_HOST, DEFAULT_WRAPPER_DIR } from './opms.js';
import { CaptureHelper, readCaptureDir, buildCapture, sourceLine, captureTitle, captureWhere } from './quick-capture.js';
import { extractPreview, isBlankBody } from '../app/js/core/memo-file.js';
import { pdfFileName, mmToPx } from '../app/js/core/pdf-page.js';
import { activeModules, magicChips } from '../app/js/core/magic-modules.js';
import { searchMemos } from '../app/js/core/memo-search.js';
import { shareText } from '../app/js/core/share-text.js';
import {
  APP_DIR, MAGIC_PRELOAD, FINDER_PRELOAD, OPMS_PRELOAD, OCR_PRELOAD,
  webPreferences, windowIcon, noteBg, titleBarOverlay, bringToFront,
  guardWindow, onScreen, defaultNoteBounds, painted, trackPaint, whenPainted, animateBounds,
} from './window-utils.js';
import {
  settings, saveSettings, openWebPage, toast, copyFileToClipboard,
  copyImageToClipboard, CLIPBOARD_HELPER, SMOKE,
} from './utils.js';

const STICKER = { width: 64, height: 52 };
const GHOST_MARGIN = 24;
const STACK_DWELL_MS = 100;
const TEAR_OPACITY = 0.9;
const TEAR_ARMED_OPACITY = 0.55;
const UNSEEN_CAPTURE_MS = 3 * 60_000;

export class WindowManager {
  constructor(options = {}) {
    this.getVault = options.getVault ?? (() => null);
    this.onUpdateTray = options.onUpdateTray ?? (() => {});
    this.onNoteOpened = options.onNoteOpened ?? (() => {});
    this.getTutorial = options.getTutorial ?? (() => null);
    this.onTutorialEvent = options.onTutorialEvent ?? (() => {});
    this.onHoldLock = options.onHoldLock ?? (() => {});
    this.getStt = options.getStt ?? (() => null);
    this.getDriveSync = options.getDriveSync ?? (() => null);
    this.getFileIndex = options.getFileIndex ?? (() => null);
    this.isQuitting = options.isQuitting ?? (() => false);
    this.getShortcutLabel = options.getShortcutLabel ?? ((name) => '');

    this.listWin = null;
    this.noteWins = new Map();
    this.stickers = new Map();
    this.stacks = null;
    this.closingStacks = new Set();
    this.ghostWin = null;
    this.ghostLoaded = null;
    this.drag = null;
    this.windowDrag = null;
    this.tabTear = null;
    this.inkingWins = new WeakSet();
    this.spare = null; // 미리 불러 둔 메모 창 { win, assign }
    this.spareTimer = 0;
    this.paintMarks = new WeakMap(); // 예비 창: 화면이 "메모를 그렸다" 고 알려 오면 부를 함수
    this.hotkeySlotOf = () => null; // 메모 단축키 칸 (main.js 가 채움)
    this.hudWin = null;
    this.hudTimer = 0;
    this.smokeHud = [];

    this.pdfWin = null;
    this.smokePdf = [];

    this.ocrWin = null;
    this.ocrReady = null;
    this.ocrPending = new Map();
    this.ocrSeq = 0;

    this.magicWin = null;
    this.lastFileResults = new Set();
    this.lastFinderResults = new Set();
    this.iconCache = new Map();

    this.opmsWin = null;
    this.opmsLastDir = '';
    this.opmsCases = new Map();
    this.attachCache = new Map();

    this.finderWin = null;

    this.captureHelper = new CaptureHelper(CLIPBOARD_HELPER);
    this.pendingCaptures = new Map();
    this.pendingAlarms = new Map();
    this.unseenCaptures = new Set();
    this.capturing = false;
    this.lastCapturePoint = null;

    this.areaCapture = null;
    this.smokeClipboard = [];

    this.listTimer = null;
    this.topWatchTimer = 0;
    this.raiseTimer = 0;

    this._initTopWatch();
  }

  _initTopWatch() {
    this.topWatch = new ForegroundWatch({
      onEvent: (e) => {
        if (this.ownOverlayOpen()) return;
        if (e.type === 'lost') {
          const win = this.onTopWins().find((w) => hwndOf(w) === e.hwnd);
          if (win) this.reassertTop(win);
          return;
        }
        if (!e.topmost || LEAVE_ON_TOP.has(e.name)) return;
        if (BrowserWindow.getAllWindows().some((w) => hwndOf(w) === e.hwnd)) return;
        clearTimeout(this.raiseTimer);
        this.raiseTimer = setTimeout(() => {
          if (!this.ownOverlayOpen()) {
            for (const w of this.onTopWins()) this.reassertTop(w);
          }
        }, 120);
      },
    });
  }

  // ---------- 목록 창 ----------

  createListWindow(tab) {
    if (this.listWin) {
      bringToFront(this.listWin);
      if (tab) this.listWin.webContents.send('list:tab', tab);
      return this.listWin;
    }
    const bounds = onScreen(settings.listBounds) ? settings.listBounds : { width: 400, height: 680 };
    this.listWin = new BrowserWindow({
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
    guardWindow(this.listWin, { openWebPage });
    if (settings.listOnTop) {
      this.listWin.setAlwaysOnTop(true, 'floating');
      this.setSticker(this.listWin, true, { animate: false });
    }
    const remember = () => {
      if (this.listWin && !this.listWin.isDestroyed()) {
        settings.listBounds = this.listWin.getNormalBounds();
        saveSettings();
      }
    };
    this.listWin.on('moved', remember);
    this.listWin.on('resized', remember);
    this.listWin.once('ready-to-show', () => {
      this.listWin?.show();
      this.scheduleSpare(1500);
    });
    this.listWin.on('closed', () => {
      this.listWin = null;
      this.dropSpareIfIdle();
      this.drag = null;
      this.ghostWin?.destroy();
      this.ghostWin = null;
    });
    this.listWin.loadFile(path.join(APP_DIR, 'index.html'), tab ? { query: { tab } } : undefined);
    return this.listWin;
  }

  setListOnTop(on) {
    if (!this.listWin) return false;
    settings.listOnTop = Boolean(on);
    this.setTopmost(this.listWin, settings.listOnTop);
    this.setSticker(this.listWin, settings.listOnTop);
    saveSettings();
    this.listWin.webContents.send('list:on-top', settings.listOnTop);
    return settings.listOnTop;
  }

  // ---------- 메모 창 ----------

  openNote(id, { inactive = false, record = false, ink = false, big = false } = {}) {
    if (this.stacks?.stackOf(id)) return this.showTab(id, { inactive });
    const existing = this.noteWins.get(id);
    if (existing) {
      bringToFront(existing, { inactive });
      return existing;
    }
    return this.createNoteWindow(id, { inactive, record, ink, big });
  }

  createNoteWindow(id, { inactive = false, show = true, bounds = null, record = false, ink = false, big = false } = {}) {
    const vault = this.getVault();
    const memo = vault?.get(id);
    if (!memo) return null;

    const saved = settings.noteBounds[id];
    const defaultBounds = defaultNoteBounds(
      ink || big ? { width: 560, height: 640 } : DEFAULT_NOTE_SIZE,
      { listWin: this.listWin, noteWinsCount: this.noteWins.size },
    );
    const at = bounds ?? (onScreen(saved) ? saved : defaultBounds);
    // 보여 줄 창이면 미리 불러 둔 예비 창을 쓴다 (편집기를 새로 읽지 않아 바로 뜬다)
    const spare = show ? this.takeSpare() : null;
    let win;
    if (spare) {
      win = spare.win;
      win.setBounds(at);
      win.setTitle(memo.title);
      win.setBackgroundColor(noteBg(memo.color));
      win.setAlwaysOnTop(settings.onTop[id] === true);
    } else {
      win = new BrowserWindow({
        ...at,
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
      guardWindow(win, { openWebPage });
    }
    if (settings.onTop[id] === true) {
      win.setAlwaysOnTop(true, 'floating');
      this.setSticker(win, true, { animate: false });
    }
    this.noteWins.set(id, win);

    const setOpen = (open) => {
      if (this.isQuitting()) return;
      settings.openNotes = settings.openNotes.filter((x) => x !== id);
      if (open) settings.openNotes.push(id);
      saveSettings();
    };
    win.on('show', () => {
      setOpen(true);
      this.onNoteOpened(id);
      this.pushList();
    });
    win.on('hide', () => {
      setOpen(false);
      this.pushList();
    });

    const remember = () => this.syncStackBounds(id, win.getNormalBounds());
    win.on('will-move', () => this.trackWindowDrag(id));
    win.on('moved', () => {
      remember();
      this.endWindowDrag(id);
    });
    win.on('resized', remember);
    const reveal = () => (inactive ? win.showInactive() : win.show());
    if (spare) {
      // 이미 한 번 그린 창이라 ready-to-show 가 다시 오지 않는다 — 화면이 메모를 그렸다고 알려 오면(win:painted) 보인다
      const mark = trackPaint(win, { manual: true });
      const fallback = setTimeout(mark, 1500);
      this.paintMarks.set(win.webContents, () => {
        clearTimeout(fallback);
        mark();
      });
      whenPainted(win, reveal);
    } else {
      trackPaint(win);
      if (show) win.once('ready-to-show', reveal);
    }
    this.pushList();

    win.on('close', () => {
      if (this.isQuitting()) return;
      const stack = this.stacks?.stackOf(id);
      if (!stack || this.closingStacks.has(stack.id)) return;
      this.closingStacks.add(stack.id);
      for (const m of stack.memos) {
        if (m !== id) this.noteWins.get(m)?.close();
      }
      setTimeout(() => this.closingStacks.delete(stack.id), 1000);
    });

    win.on('closed', () => {
      this.noteWins.delete(id);
      this.dropSpareIfIdle();
      const currentVault = this.getVault();
      const stt = this.getStt();
      if (currentVault?.locks.has(id) && stt?.pendingFor?.(id)) {
        this.onHoldLock(id, currentVault.locks.get(id));
      }
      currentVault?.closeLock(id);
      const tut = this.getTutorial();
      if (tut && id === tut.memoId) this.onTutorialEvent('note-closed');
      currentVault?.finalize(id);
      if (!currentVault?.get(id) && this.stacks?.stackOf(id)) {
        const r = this.stacks.remove(id);
        this.pushStackTo(r.rest ?? []);
      }
      this.pushList();
      if (!this.isQuitting()) {
        settings.openNotes = settings.openNotes.filter((x) => x !== id);
        if (!currentVault?.get(id)) delete settings.noteBounds[id];
        saveSettings();
      }
    });

    if (spare) spare.assign({ id, record, ink });
    else {
      win.loadFile(path.join(APP_DIR, 'note.html'), {
        query: { id, ...(record ? { record: '1' } : {}), ...(ink ? { ink: '1' } : {}) },
      });
    }
    this.scheduleSpare();
    return win;
  }

  // ---------- 잠깐 알림 (HUD) ----------
  // 메모 단축키로 복사했을 때처럼 다른 앱을 쓰는 중에 "복사했어요" 만 잠깐 — 마우스 가까이, 포커스를 빼앗지 않고 1.6초 뒤 사라짐
  //   (Windows 알림은 알림 센터에 쌓이고 소리가 나서, 자주 쓰는 단축키에는 무겁다)

  showHud({ title, body = '', kind = 'ok' }) {
    if (SMOKE) this.smokeHud.push({ title, body, kind });
    const size = { width: 340, height: 64 };
    if (!this.hudWin || this.hudWin.isDestroyed()) {
      this.hudWin = new BrowserWindow({
        ...size,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        hasShadow: false,
        webPreferences,
      });
      this.hudWin.setAlwaysOnTop(true, 'screen-saver');
      this.hudWin.setIgnoreMouseEvents(true);
      this.hudLoaded = new Promise((resolve) => this.hudWin.webContents.once('did-finish-load', resolve));
      this.hudWin.on('closed', () => (this.hudWin = null));
      this.hudWin.loadFile(path.join(APP_DIR, 'hud.html'));
    }
    const win = this.hudWin;
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const x = Math.round(Math.min(Math.max(cursor.x - size.width / 2, area.x + 8), area.x + area.width - size.width - 8));
    const below = cursor.y + 28 + size.height <= area.y + area.height;
    const y = Math.round(below ? cursor.y + 28 : cursor.y - 28 - size.height);
    clearTimeout(this.hudTimer);
    this.hudLoaded.then(() => {
      if (win.isDestroyed()) return;
      win.setBounds({ x, y, ...size });
      win.webContents.send('hud:show', { title, body, kind });
      win.showInactive();
      this.hudTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        win.webContents.send('hud:hide');
        this.hudTimer = setTimeout(() => !win.isDestroyed() && win.hide(), 220);
      }, 1600);
    });
  }

  // ---------- 예비 메모 창 ----------
  // 메모 창을 열 때마다 편집기(milkdown·KaTeX 등)를 새로 읽고 컴파일하느라 한 박자 늦게 뜬다 →
  //   숨은 창 하나에 note.html 을 미리 불러 두고(메모는 아직 없음), 메모를 열면 그 창에 메모를 넣고 그린 뒤 보여 준다.
  //   쓰면 조금 뒤 새 예비 창을 다시 만든다. 목록 창도 메모 창도 없으면(알림 영역에만) 거둬 메모리를 쓰지 않는다

  scheduleSpare(delay = 1200) {
    clearTimeout(this.spareTimer);
    this.spareTimer = setTimeout(() => this.makeSpare(), delay);
  }

  makeSpare() {
    if (this.spare || this.isQuitting() || !this.getVault() || (!this.listWin && this.noteWins.size === 0)) return;
    const win = new BrowserWindow({
      ...DEFAULT_NOTE_SIZE,
      minWidth: 240,
      minHeight: 200,
      frame: false,
      show: false,
      backgroundColor: noteBg('yellow'),
      ...windowIcon,
      webPreferences,
    });
    guardWindow(win, { openWebPage });
    const spare = { win, assign: null };
    this.spare = spare;
    const forget = () => {
      if (this.spare !== spare) return;
      this.spare = null;
      if (!win.isDestroyed()) win.destroy();
    };
    win.on('closed', forget);
    win.webContents.once('render-process-gone', forget);
    win.webContents.once('did-fail-load', forget);
    win.loadFile(path.join(APP_DIR, 'note.html'), { query: { spare: '1' } });
  }

  dropSpareIfIdle() {
    if (this.listWin || this.noteWins.size) return;
    clearTimeout(this.spareTimer);
    const s = this.spare;
    this.spare = null;
    if (s && !s.win.isDestroyed()) s.win.destroy();
  }

  /** 예비 창의 화면이 다 불러졌다 (ipc 'win:spare') → 메모가 정해질 때까지 기다리는 약속. 예비 창이 아니면 null */
  spareWaiting(sender) {
    const s = this.spare;
    if (!s || s.win.isDestroyed() || s.win.webContents !== sender) return Promise.resolve(null);
    return new Promise((resolve) => (s.assign = resolve));
  }

  /** 쓸 수 있는 예비 창 (화면이 메모를 기다리는 중일 때만) — 가져가면 다음 것은 새로 */
  takeSpare() {
    const s = this.spare;
    if (!s?.assign || s.win.isDestroyed() || s.win.webContents.isCrashed()) return null;
    this.spare = null;
    return s;
  }

  /** 예비 창이 메모를 그렸다 (ipc 'win:painted') */
  notePainted(sender) {
    const mark = this.paintMarks.get(sender);
    if (!mark) return;
    this.paintMarks.delete(sender);
    mark();
  }

  revealNote(id) {
    const win = (this.stacks?.stackOf(id) ? this.openNote(id) : this.noteWins.get(id)) ?? this.openNote(id);
    if (!win) return null;
    const bring = () => {
      bringToFront(win, { raise: true });
      win.webContents.send('memo:highlight');
    };
    whenPainted(win, bring);
    return win;
  }

  showAllNotes() {
    for (const [id, win] of this.noteWins) {
      const stack = this.stacks?.stackOf(id);
      if (stack && stack.active !== id) continue;
      if (this.unseenCaptures.has(id)) continue;
      bringToFront(win, { inactive: true, raise: true });
    }
  }

  setNoteOnTop(id, next, { fromId = id } = {}) {
    const members = this.stacks?.stackOf(id)?.memos ?? [id];
    for (const m of members) {
      this.setTopmost(this.noteWins.get(m), next);
      this.setSticker(this.noteWins.get(m), next, { animate: m === fromId });
      this.noteWins.get(m)?.webContents.send('memo:on-top', next);
      if (next) settings.onTop[m] = true;
      else delete settings.onTop[m];
    }
    saveSettings();
    return next;
  }

  sendToNote(id, channel, ...args) {
    this.noteWins.get(id)?.webContents.send(channel, ...args);
  }

  withOpenFlag(memos) {
    return memos.map((m) => ({
      ...m,
      open: Boolean(this.noteWins.get(m.id)?.isVisible()),
      stack: this.stacks?.stackOf(m.id)?.memos.length ?? 0,
      hotkey: this.hotkeySlotOf(m.id),
    }));
  }

  listMemos() {
    return this.withOpenFlag(this.getVault()?.list() ?? []);
  }

  pushList() {
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => {
      this.listWin?.webContents.send('memos:changed', this.listMemos());
      this.pushAllStacks();
      this.onUpdateTray();
    }, 80);
  }

  placeNote(id, bounds) {
    if (this.stacks?.stackOf(id)) {
      this.hideGhost();
      const win = this.openNote(id);
      const move = () => {
        animateBounds(win, bounds);
        this.syncStackBounds(id, bounds);
      };
      if (win?.isVisible()) move();
      else win?.once('show', move);
      return;
    }
    settings.noteBounds[id] = bounds;
    saveSettings();
    const existing = this.noteWins.get(id);
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      this.hideGhost();
      animateBounds(existing, bounds);
      existing.show();
      existing.focus();
      return;
    }
    const win = this.openNote(id);
    if (!win) return this.hideGhost();
    const fallback = setTimeout(() => this.hideGhost(), 1500);
    win.once('show', () => {
      clearTimeout(fallback);
      setTimeout(() => this.hideGhost(), 60);
    });
  }

  createNote(options) {
    const vault = this.getVault();
    if (!vault) return null;
    const { record = false, ink = false, ...rest } = options ?? {};
    const id = vault.create(rest);
    const tut = this.getTutorial();
    const forTutorial = tut?.active && tut.advance === 'memo-created';
    this.openNote(id, { record: Boolean(record), ink: Boolean(ink), big: forTutorial });
    if (forTutorial) {
      tut.memoId = id;
      this.onTutorialEvent('memo-created');
    }
    return id;
  }

  // ---------- 메모 스택 (탭) ----------

  loadStacks() {
    const vault = this.getVault();
    if (!vault) return;
    const file = path.join(vault.appDir, 'stacks.json');
    this.stacks = new StackStore({
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
    }).load((id) => Boolean(this.getVault()?.get(id)));
  }

  stackState(id) {
    const stack = this.stacks?.stackOf(id);
    if (!stack) return { members: [], active: id };
    const vault = this.getVault();
    return {
      active: stack.active,
      members: stack.memos.map((m) => {
        const memo = vault?.get(m);
        return { id: m, title: memo?.title ?? '제목 없음', color: memo?.color ?? 'yellow' };
      }),
    };
  }

  pushStackTo(ids) {
    for (const m of ids) this.noteWins.get(m)?.webContents.send('stack:state', this.stackState(m));
  }

  pushAllStacks() {
    for (const s of this.stacks?.all() ?? []) this.pushStackTo(s.memos);
  }

  visibleStackWin(stack, exceptId = null) {
    for (const m of stack?.memos ?? []) {
      const w = this.noteWins.get(m);
      if (m !== exceptId && w && !w.isDestroyed() && w.isVisible()) return w;
    }
    return null;
  }

  stackOnTop(stack) {
    return stack.memos.some((m) => settings.onTop[m] === true);
  }

  syncStackBounds(id, bounds) {
    const stack = this.stacks?.stackOf(id);
    for (const m of stack ? stack.memos : [id]) {
      settings.noteBounds[m] = bounds;
      const w = this.noteWins.get(m);
      if (m !== id && w && !w.isDestroyed() && !w.isVisible()) w.setBounds(bounds);
    }
    saveSettings();
  }

  showTab(id, { inactive = false, bounds: at = null } = {}) {
    if (!this.stacks) return null;
    const stack = this.stacks.setActive(id);
    const current = this.visibleStackWin(stack, id);
    const defaultBounds = defaultNoteBounds(DEFAULT_NOTE_SIZE, { listWin: this.listWin, noteWinsCount: this.noteWins.size });
    const bounds = at ?? current?.getNormalBounds() ?? (onScreen(settings.noteBounds[id]) ? settings.noteBounds[id] : defaultBounds);
    const top = this.stackOnTop(stack);

    if (top && stack.memos.some((m) => settings.onTop[m] !== true)) {
      for (const m of stack.memos) settings.onTop[m] = true;
      saveSettings();
    }
    let win = this.noteWins.get(id);
    const reveal = () => {
      if (win.isDestroyed()) return;
      const now = this.stacks.stackOf(id);
      if (now && now.active !== id) return;
      if (win.isMinimized()) win.restore();
      const shown = now ? this.visibleStackWin(now, id) : null;
      win.setBounds(shown?.getNormalBounds() ?? bounds);
      this.setTopmost(win, top);
      const veiled = Boolean(shown) && !win.isVisible() && process.platform === 'win32';
      this.setSticker(win, top, { animate: false });
      const sticker = top ? this.stickers.get(win.id) : null;
      if (sticker && veiled) sticker.hold = true;
      else if (top) this.handOverSticker(shown, win);
      win.webContents.send('memo:on-top', top);
      if (veiled) win.setOpacity(0);
      if (inactive) win.showInactive();
      else {
        win.show();
        win.focus();
      }
      const hideOthers = () => {
        const st = this.stacks?.stackOf(id);
        if (!st || st.active !== id) return;
        for (const m of st.memos) {
          const w = this.noteWins.get(m);
          if (m !== id && w && !w.isDestroyed() && w.isVisible()) w.hide();
        }
      };
      if (!veiled) return void setTimeout(hideOthers, 30);
      painted(win).then(() => {
        if (win.isDestroyed()) return;
        if (sticker?.hold) {
          sticker.hold = false;
          if (this.stickers.get(win.id) === sticker && !this.handOverSticker(shown, win)) {
            this.openStickerWin(sticker, false);
          }
        }
        win.setOpacity(1);
        setTimeout(hideOthers, 16);
      });
    };
    if (!win) {
      win = this.createNoteWindow(id, { show: false, bounds });
      if (!win) return null;
      win.once('ready-to-show', reveal);
    } else reveal();
    this.pushStackTo(stack.memos);
    this.pushList();
    return win;
  }

  stackInto(targetId, movingId) {
    const targetWin = this.noteWins.get(targetId);
    if (!targetWin || targetId === movingId || !this.getVault()?.get(movingId) || !this.stacks) return false;
    const bounds = targetWin.getNormalBounds();
    const top = this.stackOnTop(this.stacks.stackOf(targetId) ?? { memos: [targetId] }) || settings.onTop[targetId] === true;
    const stack = this.stacks.merge(targetId, [movingId], { activate: movingId });
    for (const m of stack.memos) {
      settings.noteBounds[m] = bounds;
      if (top) settings.onTop[m] = true;
      const w = this.noteWins.get(m);
      if (w && m !== movingId && m !== targetId && w.isVisible()) w.hide();
    }
    saveSettings();
    let win = this.noteWins.get(movingId);
    const hideTarget = () => setTimeout(() => !targetWin.isDestroyed() && targetWin.hide(), 30);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.setAlwaysOnTop(top, 'floating');
      this.setSticker(win, top, { animate: false });
      if (top) this.handOverSticker(targetWin, win);
      if (win.isVisible()) animateBounds(win, bounds);
      else win.setBounds(bounds);
      win.show();
      win.focus();
      setTimeout(hideTarget, 200);
    } else {
      win = this.createNoteWindow(movingId, { show: false, bounds });
      win?.once('ready-to-show', () => {
        win.setAlwaysOnTop(top, 'floating');
        this.setSticker(win, top, { animate: false });
        win.show();
        win.focus();
        hideTarget();
      });
    }
    this.pushStackTo(stack.memos);
    this.pushList();
    return true;
  }

  removeFromStack(id, mode = 'close') {
    const stack = this.stacks?.stackOf(id);
    if (!stack) return false;
    const win = this.noteWins.get(id);
    const wasVisible = Boolean(win?.isVisible());
    const bounds = (wasVisible ? win.getNormalBounds() : this.visibleStackWin(stack)?.getNormalBounds()) ?? settings.noteBounds[id];
    const r = this.stacks.remove(id);
    const quiet = mode === 'tear';
    if (wasVisible && r.nextActive) {
      if (r.stack) this.showTab(r.nextActive, { inactive: quiet, bounds });
      else {
        const rest = this.noteWins.get(r.nextActive) ?? this.createNoteWindow(r.nextActive, { show: false, bounds });
        rest?.setBounds(bounds);
        const reveal = () => (quiet ? rest.showInactive() : rest.show());
        if (rest) whenPainted(rest, reveal);
      }
    }
    this.pushStackTo([...(r.rest ?? []), id]);
    if (mode === 'close') win?.close();
    else if (mode === 'detach') {
      const b = { ...bounds, x: bounds.x + 28, y: bounds.y + 28 };
      settings.noteBounds[id] = b;
      saveSettings();
      if (win) {
        win.setBounds(b);
        win.show();
        win.focus();
      } else this.createNoteWindow(id, { bounds: b });
    }
    this.pushList();
    return true;
  }

  stackTargetAt(point, excludeId) {
    const own = this.stacks?.stackOf(excludeId)?.memos ?? [excludeId];
    for (const [mid, w] of this.noteWins) {
      if (own.includes(mid) || w.isDestroyed() || !w.isVisible() || w.isMinimized() || this.inkingWins.has(w)) continue;
      if (isInside(point, w.getBounds())) return mid;
    }
    return null;
  }

  setStackHover(id, on) {
    if (id) this.noteWins.get(id)?.webContents.send('stack:hover', on);
  }

  trackStackTarget(state, point, excludeId, onChange) {
    const target = this.stackTargetAt(point, excludeId);
    if (target === state.target) return;
    clearTimeout(state.timer);
    this.setStackHover(state.target, false);
    const wasArmed = state.armed;
    state.target = target;
    state.armed = false;
    if (wasArmed) onChange?.(false);
    if (!target) return;
    state.timer = setTimeout(() => {
      if (state.target !== target) return;
      state.armed = true;
      this.setStackHover(target, true);
      onChange?.(true);
    }, STACK_DWELL_MS);
  }

  clearStackTarget(state) {
    clearTimeout(state?.timer);
    this.setStackHover(state?.target, false);
  }

  trackWindowDrag(id, point = screen.getCursorScreenPoint()) {
    const w = this.noteWins.get(id);
    if (w && this.inkingWins.has(w)) return;
    if (this.windowDrag?.id !== id) {
      this.clearStackTarget(this.windowDrag);
      this.windowDrag = { id, target: null, armed: false, timer: null };
    }
    this.trackStackTarget(this.windowDrag, point, id);
  }

  endWindowDrag(id) {
    const d = this.windowDrag;
    if (!d || d.id !== id) return;
    this.windowDrag = null;
    this.clearStackTarget(d);
    if (d.armed && d.target) this.stackInto(d.target, id);
  }

  tearStart(id, offset, point) {
    const stack = this.stacks?.stackOf(id);
    if (!stack || this.tabTear) return false;
    const defaultBounds = defaultNoteBounds(DEFAULT_NOTE_SIZE, { listWin: this.listWin, noteWinsCount: this.noteWins.size });
    const size = (this.visibleStackWin(stack) ?? this.noteWins.get(id))?.getNormalBounds() ?? settings.noteBounds[id] ?? defaultBounds;
    const off = { x: Math.max(12, Math.min(size.width - 40, Math.round(offset?.x ?? 60))), y: Math.round(offset?.y ?? 17) };
    const bounds = { x: Math.round(point.x - off.x), y: Math.round(point.y - off.y), width: size.width, height: size.height };
    this.removeFromStack(id, 'tear');
    let win = this.noteWins.get(id);
    if (win) win.setBounds(bounds);
    else win = this.createNoteWindow(id, { show: false, bounds });
    if (!win) return false;
    win.setOpacity(TEAR_OPACITY);
    const reveal = () => {
      if (win.isDestroyed()) return;
      if (!win.isVisible()) win.showInactive();
      win.moveTop();
    };
    whenPainted(win, reveal);
    this.tabTear = { id, offset: off, win, target: null, armed: false, timer: null };
    return true;
  }

  tearMove(point) {
    const t = this.tabTear;
    if (!t || t.win.isDestroyed()) return;
    t.win.setPosition(Math.round(point.x - t.offset.x), Math.round(point.y - t.offset.y));
    this.trackStackTarget(t, point, t.id, (armed) => {
      if (!t.win.isDestroyed()) t.win.setOpacity(armed ? TEAR_ARMED_OPACITY : TEAR_OPACITY);
    });
  }

  tearEnd(point) {
    const t = this.tabTear;
    if (!t) return false;
    if (point) this.tearMove(point);
    this.tabTear = null;
    this.clearStackTarget(t);
    if (t.win.isDestroyed()) return false;
    t.win.setOpacity(1);
    if (t.armed && t.target) return this.stackInto(t.target, t.id);
    settings.noteBounds[t.id] = t.win.getNormalBounds();
    saveSettings();
    t.win.focus();
    this.pushList();
    return true;
  }

  // ---------- 늘 위에 두기 = 왕관 스티커 ----------

  setTopmost(win, on) {
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(on, 'floating');
    if (on) this.reassertTop(win);
    this.refreshTopWatch();
  }

  reassertTop(win) {
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, 'floating');
  }

  onTopWins() {
    return [
      ...(settings.listOnTop && this.listWin && !this.listWin.isDestroyed() ? [this.listWin] : []),
      ...[...this.noteWins].filter(([id, w]) => settings.onTop[id] === true && !w.isDestroyed()).map(([, w]) => w),
    ];
  }

  ownOverlayOpen() {
    return Boolean(this.areaCapture) || [this.ghostWin, this.magicWin].some((w) => w && !w.isDestroyed() && w.isVisible());
  }

  refreshTopWatch() {
    clearTimeout(this.topWatchTimer);
    this.topWatchTimer = setTimeout(() => {
      if (this.isQuitting()) return this.topWatch.stop();
      this.topWatch.update(this.onTopWins().map(hwndOf));
    }, 300);
  }

  stickerBounds(owner) {
    const b = owner.getBounds();
    return { x: Math.round(b.x + b.width / 2 - STICKER.width / 2), y: Math.round(b.y - STICKER.height / 2), ...STICKER };
  }

  closeStickerWin(entry, { peel = false } = {}) {
    const win = entry.win;
    entry.win = null;
    if (!win || win.isDestroyed()) return;
    const owner = entry.owner;
    const destroy = () => {
      if (win.isDestroyed()) return;
      win.destroy();
      if (!owner.isDestroyed() && this.stickers.get(owner.id)) this.reassertTop(owner);
    };
    if (peel && win.isVisible()) {
      win.webContents.send('sticker:peel');
      setTimeout(destroy, 220);
    } else destroy();
  }

  openStickerWin(entry, animate) {
    const { owner } = entry;
    if (entry.win || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()) return;
    const win = new BrowserWindow({
      ...this.stickerBounds(owner),
      parent: owner,
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
    win.setIgnoreMouseEvents(true, { forward: true });
    guardWindow(win, { openWebPage });
    win.once('ready-to-show', () => {
      if (win.isDestroyed() || entry.win !== win || owner.isDestroyed()) return;
      win.setBounds(this.stickerBounds(owner));
      win.showInactive();
      win.webContents.send('sticker:show', { animate });
    });
    win.loadFile(path.join(APP_DIR, 'sticker.html'));
  }

  handOverSticker(from, to) {
    if (!from || !to || from === to || from.isDestroyed() || to.isDestroyed()) return false;
    const a = this.stickers.get(from.id);
    const b = this.stickers.get(to.id);
    if (!a?.win || a.win.isDestroyed() || !b || b.win) return false;
    const win = a.win;
    a.win = null;
    b.win = win;
    win.setParentWindow(to);
    win.setBounds(this.stickerBounds(to));
    return true;
  }

  setSticker(owner, on, { animate = true } = {}) {
    if (!owner || owner.isDestroyed()) return;
    const cur = this.stickers.get(owner.id);
    if (!on) {
      if (!cur) return;
      this.stickers.delete(owner.id);
      cur.off();
      this.closeStickerWin(cur, { peel: animate });
      return;
    }
    if (cur) {
      this.openStickerWin(cur, false);
      return;
    }
    const entry = { owner, win: null, off: () => {}, hold: false };
    const sync = () => {
      if (entry.win && !entry.win.isDestroyed() && !owner.isDestroyed()) entry.win.setBounds(this.stickerBounds(owner));
    };
    const visible = () => {
      if (owner.isDestroyed()) return;
      if (entry.hold) return;
      if (owner.isVisible() && !owner.isMinimized()) {
        this.openStickerWin(entry, false);
        this.reassertTop(owner);
      } else this.closeStickerWin(entry);
      this.refreshTopWatch();
    };
    const events = { move: sync, resize: sync, show: visible, hide: visible, minimize: visible, restore: visible };
    for (const [name, fn] of Object.entries(events)) owner.on(name, fn);
    entry.off = () => {
      if (!owner.isDestroyed()) {
        for (const [name, fn] of Object.entries(events)) owner.off(name, fn);
      }
    };
    this.stickers.set(owner.id, entry);
    owner.once('closed', () => {
      entry.off();
      this.closeStickerWin(entry);
      if (this.stickers.get(owner.id) === entry) this.stickers.delete(owner.id);
      this.refreshTopWatch();
    });
    this.openStickerWin(entry, animate);
  }

  peelSticker(sender) {
    for (const [, s] of this.stickers) {
      if (!s.win || s.win.isDestroyed() || s.win.webContents !== sender || s.owner.isDestroyed()) continue;
      if (s.owner === this.listWin) return this.setListOnTop(false) === false;
      const id = [...this.noteWins].find(([, w]) => w === s.owner)?.[0];
      if (id) return this.setNoteOnTop(id, false) === false;
    }
    return false;
  }

  // ---------- 드래그 미리보기 (Ghost) ----------

  ensureGhost() {
    if (this.ghostWin && !this.ghostWin.isDestroyed()) return;
    this.ghostWin = new BrowserWindow({
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
    this.ghostWin.setIgnoreMouseEvents(true);
    this.ghostWin.setAlwaysOnTop(true, 'screen-saver');
    this.ghostLoaded = new Promise((resolve) => this.ghostWin.webContents.once('did-finish-load', resolve));
    this.ghostWin.loadFile(path.join(APP_DIR, 'ghost.html'));
  }

  hideGhost() {
    if (this.ghostWin && !this.ghostWin.isDestroyed()) this.ghostWin.hide();
  }

  noteSize(id) {
    const saved = settings.noteBounds[id];
    return saved ? { width: saved.width, height: saved.height } : DEFAULT_NOTE_SIZE;
  }

  boundsAt(id, point) {
    return dropBounds(point, this.noteSize(id), screen.getDisplayNearestPoint(point).workArea);
  }

  async dragStart(id) {
    const memo = this.getVault()?.get(id);
    if (!memo || !this.listWin) return false;
    this.ensureGhost();
    this.clearStackTarget(this.drag?.stack);
    this.drag = { id, outside: false, bounds: null, ready: false, stack: { target: null, armed: false, timer: null } };
    await this.ghostLoaded;
    if (this.drag?.id !== id) return false;
    this.ghostWin.webContents.send('ghost:data', {
      color: memo.color,
      title: memo.title,
      preview: memo.locked ? '' : extractPreview(memo.body, 400),
      open: this.noteWins.has(id),
    });
    if (this.drag.outside) this.ghostWin.webContents.send('ghost:visible', true);
    this.drag.ready = true;
    return true;
  }

  dragMove(point) {
    if (!this.drag || !this.listWin || !this.ghostWin || this.ghostWin.isDestroyed()) return;
    const outside = !isInside(point, this.listWin.getBounds());
    if (outside) {
      this.drag.bounds = this.boundsAt(this.drag.id, point);
      const { x, y, width, height } = this.drag.bounds;
      this.ghostWin.setBounds({ x: x - GHOST_MARGIN, y: y - GHOST_MARGIN, width: width + GHOST_MARGIN * 2, height: height + GHOST_MARGIN * 2 });
      if (!this.drag.outside) {
        this.ghostWin.showInactive();
        if (this.drag.ready) this.ghostWin.webContents.send('ghost:visible', true);
      }
    } else if (this.drag.outside) {
      this.ghostWin.webContents.send('ghost:visible', false);
      this.hideGhost();
    }
    if (outside !== this.drag.outside) this.listWin.webContents.send('drag:state', { outside });
    this.drag.outside = outside;
    const current = this.drag;
    if (outside) {
      this.trackStackTarget(current.stack, point, current.id, (armed) => {
        if (this.drag === current) this.ghostWin?.webContents.send('ghost:mode', { stack: armed });
      });
    } else if (current.stack.target) {
      this.clearStackTarget(current.stack);
      current.stack = { target: null, armed: false, timer: null };
      this.ghostWin?.webContents.send('ghost:mode', { stack: false });
    }
  }

  dragEnd(point) {
    const current = this.drag;
    this.drag = null;
    if (!current) return { opened: false };
    this.clearStackTarget(current.stack);
    this.ghostWin?.webContents.send('ghost:mode', { stack: false });
    if (!point || !this.listWin || isInside(point, this.listWin.getBounds())) {
      this.hideGhost();
      return { opened: false };
    }
    if (current.stack.armed && current.stack.target) {
      this.hideGhost();
      this.stackInto(current.stack.target, current.id);
      return { opened: true, stacked: true };
    }
    const bounds = this.boundsAt(current.id, point);
    this.ghostWin?.webContents.send('ghost:drop');
    this.placeNote(current.id, bounds);
    return { opened: true, bounds };
  }

  // ---------- PDF 변환 창 ----------

  openPdfWindow(id, parent = BrowserWindow.getFocusedWindow()) {
    if (!this.getVault()?.get(id)) return false;
    this.pdfWin?.destroy();
    const area = screen.getDisplayMatching(parent?.getBounds() ?? screen.getPrimaryDisplay().workArea).workArea;
    const width = Math.min(820, area.width - 40);
    const height = Math.min(600, area.height - 40);
    this.pdfWin = new BrowserWindow({
      width, height, minWidth: 640, minHeight: 480,
      x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
      title: 'PDF로 저장',
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e0d' : '#f6f5f1',
      ...windowIcon,
      webPreferences: { ...webPreferences, nodeIntegrationInSubFrames: true },
    });
    guardWindow(this.pdfWin, { openWebPage });
    this.pdfWin.setMenu(null);
    const w = this.pdfWin;
    w.once('ready-to-show', () => w.show());
    w.on('closed', () => {
      if (this.pdfWin === w) this.pdfWin = null;
    });
    w.loadFile(path.join(APP_DIR, 'pdf.html'), { query: { id } });
    return true;
  }

  async savePdf(id, o, parent) {
    const memo = this.getVault()?.get(id);
    if (!memo) return null;
    let file = SMOKE ? this.smokePdf.shift() : null;
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
    const win = new BrowserWindow({
      show: false,
      width: Math.round(mmToPx(width)),
      height: Math.round(mmToPx(height)),
      webPreferences,
    });
    try {
      await win.loadFile(path.join(APP_DIR, 'print.html'), {
        query: {
          id, w: String(width), h: String(height), m: String(margin),
          bg: o.bg ? '1' : '0', date: o.date ? '1' : '0',
        },
      });
      const end = Date.now() + 15000;
      while (Date.now() < end && !(await win.webContents.executeJavaScript('document.documentElement.dataset.ready === "true"').catch(() => false))) {
        await new Promise((r) => setTimeout(r, 100));
      }
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

  // ---------- 숨은 OCR 창 ----------

  ensureOcrWindow() {
    if (this.ocrReady) return this.ocrReady;
    this.ocrReady = new Promise((resolve, reject) => {
      try {
        this.ocrWin = new BrowserWindow({
          show: false,
          skipTaskbar: true,
          webPreferences: { preload: OCR_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        const onReady = () => resolve(this.ocrWin);
        this.ocrWin.webContents.once('ipc-message', (_e, channel) => {
          if (channel === 'ocr:ready') onReady();
        });
        this.ocrWin.webContents.on('render-process-gone', () => { this.ocrWin = null; this.ocrReady = null; });
        this.ocrWin.on('closed', () => { this.ocrWin = null; this.ocrReady = null; });
        this.ocrWin.loadURL('memoking://ocr/ocr.html').catch(reject);
        setTimeout(() => reject(new Error('OCR 창 준비 시간 초과')), 20000);
      } catch (err) {
        this.ocrReady = null;
        reject(err);
      }
    }).catch((err) => {
      this.ocrReady = null;
      throw err;
    });
    return this.ocrReady;
  }

  async runOcr(imagePath, unit) {
    await this.ensureOcrWindow();
    const dataUrl = `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`;
    const id = ++this.ocrSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ocrPending.delete(id);
        reject(new Error('OCR 시간 초과'));
      }, 30000);
      this.ocrPending.set(id, { resolve, timer });
      this.ocrWin.webContents.send('ocr:request', { id, dataUrl, unit: unit || 1 });
    }).then((data) => {
      if (data.error) throw new Error(data.error);
      return data;
    });
  }

  // ---------- 매직키 / 검색 / 탐색기 창 ----------

  createMagicWindow() {
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
    win.on('blur', () => win.hide());
    win.on('moved', () => {
      if (!win.isVisible()) return;
      const [x, y] = win.getPosition();
      settings.magicPos = { x, y };
      saveSettings();
    });
    win.on('closed', () => {
      if (this.magicWin === win) this.magicWin = null;
    });
    return win;
  }

  showMagic() {
    if (!this.getVault()) {
      this.createListWindow();
      return;
    }
    this.magicWin ??= this.createMagicWindow();
    const [w] = this.magicWin.getSize();
    const saved = settings.magicPos;
    const isSavedOnScreen = saved && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x >= a.x - 40 && saved.x + 80 <= a.x + a.width && saved.y >= a.y - 10 && saved.y + 40 <= a.y + a.height;
    });
    if (isSavedOnScreen) this.magicWin.setPosition(Math.round(saved.x), Math.round(saved.y));
    else {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      this.magicWin.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + area.height * 0.22));
    }
    this.magicWin.show();
    this.magicWin.focus();
    this.magicWin.webContents.send('magic:show');
    this.getFileIndex()?.touch();
  }

  async fileIcon(p, isDir) {
    const ext = path.extname(p).toLowerCase();
    const key = isDir ? 'dir' : /^\.(exe|lnk|url|ico|appref-ms)$/.test(ext) ? p : ext || 'none';
    if (!this.iconCache.has(key)) {
      this.iconCache.set(key, app.getFileIcon(p, { size: 'normal' }).then((img) => img.toDataURL()).catch(() => ''));
      if (this.iconCache.size > 800) this.iconCache.delete(this.iconCache.keys().next().value);
    }
    return this.iconCache.get(key);
  }

  shownPath(p) {
    return typeof p === 'string' && (this.lastFileResults.has(p) || this.lastFinderResults.has(p));
  }

  async magicAct({ action, path: p, id, opms } = {}) {
    if (opms != null) {
      const c = this.caseOf(opms);
      if (action === 'copyOur' || action === 'copyApp') {
        const text = action === 'copyOur' ? c.ourref : c.n_app;
        if (!text) return { ok: false, message: action === 'copyOur' ? '관리번호가 없어요' : '출원번호가 없어요' };
        copyFileToClipboard(text);
        return { ok: true, message: `${action === 'copyOur' ? '관리번호' : '출원번호'}를 복사했어요`, close: true };
      }
      this.showOpms(c.idx, action === 'wrapper' ? 'wrapper' : 'info');
      return { ok: true, close: true };
    }
    if (id != null) {
      const memo = this.getVault()?.get(String(id));
      if (!memo) return { ok: false };
      if (action === 'copyText') {
        copyFileToClipboard(shareText(memo.body));
        return { ok: true, message: '메모 내용을 복사했어요', close: true };
      }
      this.revealNote(String(id));
      return { ok: true, close: true };
    }
    if (!this.shownPath(p) || !fs.existsSync(p)) return { ok: false, message: '찾을 수 없어요' };
    if (action === 'copyPath') {
      copyFileToClipboard(p);
      return { ok: true, message: '경로를 복사했어요', close: true };
    }
    if (action === 'copyFile') {
      const ok = await copyFileToClipboard(p);
      return ok ? { ok, message: fs.statSync(p).isDirectory() ? '폴더를 복사했어요 — 붙여 넣으면 돼요' : '파일을 복사했어요 — 붙여 넣으면 돼요', close: true } : { ok, message: '복사하지 못했어요' };
    }
    if (action === 'reveal') {
      shell.showItemInFolder(p);
      return { ok: true, close: true };
    }
    const err = await shell.openPath(p);
    if (err) toast({ title: '열지 못했어요', body: err });
    return { ok: !err, close: true };
  }

  showFinder(query) {
    if (!this.finderWin || this.finderWin.isDestroyed()) {
      this.finderWin = new BrowserWindow({
        width: 960,
        height: 620,
        minWidth: 560,
        minHeight: 360,
        show: false,
        title: '메모킹 — 모두 찾기',
        autoHideMenuBar: true,
        ...windowIcon,
        webPreferences: { preload: FINDER_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      this.finderWin.loadFile(path.join(APP_DIR, 'finder.html'));
      this.finderWin.once('ready-to-show', () => this.finderWin?.show());
      this.finderWin.on('closed', () => {
        this.finderWin = null;
        this.lastFinderResults = new Set();
      });
      this.finderWin.webContents.once('did-finish-load', () => this.finderWin?.webContents.send('finder:query', String(query ?? '')));
    } else {
      this.finderWin.webContents.send('finder:query', String(query ?? ''));
      if (this.finderWin.isMinimized()) this.finderWin.restore();
      this.finderWin.show();
    }
    this.finderWin.focus();
  }

  // ---------- OPMS ----------

  opmsSettings() {
    return {
      host: process.env.MEMOKING_OPMS_HOST || settings.opms?.host || OPMS_HOST,
      wrapperDir: settings.opms?.wrapperDir || DEFAULT_WRAPPER_DIR,
    };
  }

  opmsClient() {
    return new Opms({ host: this.opmsSettings().host, filesIndex: path.join(app.getPath('userData'), 'opms-files.json') });
  }

  rememberCases(rows) {
    for (const r of rows) if (r.idx) this.opmsCases.set(String(r.idx), r);
    while (this.opmsCases.size > 300) this.opmsCases.delete(this.opmsCases.keys().next().value);
  }

  opmsBrief(r) {
    return {
      idx: r.idx, ourref: r.ourref, yourref: r.yourref, n_app: r.n_app, div: r.div,
      applicant: r.applicant, title: r.title_kor, accepted: cleanDate(r.d_accept),
    };
  }

  showOpms(idx, tab = 'info') {
    if (!this.opmsWin || this.opmsWin.isDestroyed()) {
      this.opmsWin = new BrowserWindow({
        width: 980,
        height: 700,
        minWidth: 620,
        minHeight: 420,
        show: false,
        title: '메모킹 — OPMS',
        autoHideMenuBar: true,
        ...windowIcon,
        webPreferences: { preload: OPMS_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      this.opmsWin.loadFile(path.join(APP_DIR, 'opms.html'));
      this.opmsWin.once('ready-to-show', () => this.opmsWin?.show());
      this.opmsWin.on('closed', () => { this.opmsWin = null; });
      this.opmsWin.webContents.once('did-finish-load', () => this.opmsWin?.webContents.send('opms:show', { idx, tab }));
    } else {
      this.opmsWin.webContents.send('opms:show', { idx, tab });
      if (this.opmsWin.isMinimized()) this.opmsWin.restore();
      this.opmsWin.show();
    }
    this.opmsWin.focus();
  }

  caseOf(idx) {
    const c = this.opmsCases.get(String(idx ?? ''));
    if (!c) throw new Error('찾아본 사건이 아니에요 — 다시 찾아 주세요');
    return c;
  }

  // ---------- 빠른 메모 & 캡처 메모 ----------

  openCaptureMemo(capture, point, message) {
    const vault = this.getVault();
    if (!vault) return null;
    const id = vault.create();
    this.pendingCaptures.set(id, { ...capture, sourceMd: sourceLine(capture.source) });
    settings.noteBounds[id] = this.boundsAt(id, point);
    const win = this.createNoteWindow(id, { show: false });
    const closeUnseen = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible()) win.close();
    }, UNSEEN_CAPTURE_MS);
    if (win) this.unseenCaptures.add(id);
    const seen = () => {
      clearTimeout(closeUnseen);
      this.unseenCaptures.delete(id);
    };
    win?.once('show', seen);
    win?.once('closed', seen);
    const showNow = () => {
      if (!win || win.isDestroyed()) return;
      whenPainted(win, () => {
        if (win.isDestroyed()) return;
        win.showInactive();
        win.webContents.send('memo:highlight');
      });
    };
    if (!toast({ memoId: id, kind: 'quick-memo', ...message, onClick: () => this.revealNote(id), onFail: showNow })) showNow();
    return id;
  }

  captureToMemo(dir, info, point) {
    const vault = this.getVault();
    const capture = buildCapture(readCaptureDir(dir), info, vault);
    if (!capture) {
      toast({
        title: '가져올 내용이 없어요',
        body: `글, 파일, 그림을 고른 뒤 ${this.getShortcutLabel('quickMemo')}를 눌러 주세요.`,
      });
      return null;
    }
    const where = captureWhere(capture.source);
    return this.openCaptureMemo(capture, point, {
      title: '메모를 만들었어요',
      body: `${captureTitle(capture)}${where ? `\n${where}에서 가져왔어요` : ''}\n눌러서 열기`,
    });
  }

  async quickMemo({ copy = true, onlyPid = 0 } = {}) {
    if (this.capturing) return null;
    if (!this.getVault()) {
      this.createListWindow();
      return null;
    }
    this.capturing = true;
    const point = screen.getCursorScreenPoint();
    this.lastCapturePoint = point;
    const dir = path.join(os.tmpdir(), 'memoking-capture', `${Date.now()}`);
    try {
      const info = await this.captureHelper.capture(dir, { copy, onlyPid });
      if (info.error) throw new Error(info.error);
      if (info.copySkipped) return null;
      return this.captureToMemo(dir, info, point);
    } catch (err) {
      console.error('빠른 메모 실패', err);
      toast({
        title: '메모를 만들지 못했어요',
        body: `${this.getShortcutLabel('quickMemo')}를 한 번 더 눌러 주세요.`,
      });
      return null;
    } finally {
      this.capturing = false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------- 영역 캡처 (Ctrl+Alt+C 두 번) ----------

  async startAreaCapture({ show = !SMOKE } = {}) {
    if (this.areaCapture || !this.getVault()) return false;
    this.areaCapture = { wins: [], shots: new Map(), point: screen.getCursorScreenPoint() };
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
      this.areaCapture = null;
      toast({
        title: '화면을 캡처하지 못했어요',
        body: `잠시 뒤 ${this.getShortcutLabel('quickMemo')} 를 두 번 다시 눌러 주세요.`,
      });
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
      guardWindow(win, { openWebPage });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setBounds(d.bounds);
      this.areaCapture.shots.set(win.webContents.id, { image: src.thumbnail, display: d });
      this.areaCapture.wins.push(win);
      win.webContents.once('did-finish-load', () => {
        if (!this.areaCapture || win.isDestroyed()) return;
        win.webContents.send('capture:image', { src: `data:image/jpeg;base64,${src.thumbnail.toJPEG(92).toString('base64')}` });
        if (show) {
          win.show();
          win.moveTop();
          win.focus();
        }
      });
      win.loadFile(path.join(APP_DIR, 'capture.html'));
    }
    if (!this.areaCapture.wins.length) {
      this.areaCapture = null;
      return false;
    }
    return true;
  }

  endAreaCapture() {
    const c = this.areaCapture;
    this.areaCapture = null;
    for (const w of c?.wins ?? []) if (!w.isDestroyed()) w.destroy();
    return c;
  }

  finishAreaCapture(senderId, rect) {
    const shot = this.areaCapture?.shots.get(senderId);
    const c = this.endAreaCapture();
    const vault = this.getVault();
    if (!shot || !c || !rect || !vault) return null;
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
    return this.openCaptureMemo(capture, c.point, {
      title: '화면 캡처로 메모를 만들었어요',
      body: `${crop.width} × ${crop.height} 그림을 클립보드에도 복사했어요. 눌러서 열기`,
    });
  }
}
