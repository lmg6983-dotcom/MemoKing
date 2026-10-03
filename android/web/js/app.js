// 메모킹 안드로이드 — 시작, 화면 바꾸기, 설정·휴지통, 다른 앱에서 받은 것, 예약 알림
import { injectIcons, icon } from '../../app/js/icons.js';
import { normalizeReminder } from '../../app/js/core/reminders.js';
import { extractTitle, isBlankBody, plainText, COLORS } from '../../app/js/core/memo-file.js';
import { loneUrl } from '../../app/js/core/link-preview.js';
import { native, call, on, setBackHandler, drive, history } from './native.js';
import { matchesQuery } from '../../app/js/core/notifications.js';
import { startConnect, renderStatus as renderDrive, syncNow } from './drive.js';
import { Vault } from './vault.js';
import { LinkPreviews } from './web-fetch.js';
import { createAlarms } from './alarms.js';
import { injectMobileIcons } from './m-icons.js';
import { app, COLOR_NAMES } from './state.js';
import { openSheet, closeSheet, closeTopSheet, closeAllSheets, sheetOpen, toast, confirmDialog, closeConfirm, matchChrome } from './ui.js';
import * as list from './list-view.js';
import * as note from './note-view.js';

const $ = (x) => document.getElementById(x);

// 공용 코드(app/js/media.js)가 첨부 주소를 만들 때 쓴다
window.memoking = { platform: 'android', vaultBase: `${location.origin}/vault/`, historyBase: `${location.origin}/history/` };

injectIcons();
injectMobileIcons();

// ---------- 데스크탑 모양의 API (reminder-panel.js · list-reminders.js 가 씀) ----------

app.api = {
  reminders: {
    set: async (memoId, next) => app.setReminders(memoId ?? note.currentId(), next),
    all: async () => app.vault?.allReminders() ?? [],
  },
  memo: { open: (id) => app.openMemo(id) },
  copyText: async (text) => {
    native.copyText(text);
    toast('복사했어요');
  },
  // 알림 보관함 (app/js/list-history.js 가 씀) — 거르기·검색은 여기서
  history: {
    list: async ({ query = '', app: appName = '' } = {}) => {
      const { enabled, granted, entries } = history.all();
      const counts = new Map();
      for (const e of entries) counts.set(e.app, (counts.get(e.app) ?? 0) + 1);
      const shown = entries.filter((e) => (!appName || e.app === appName) && matchesQuery(e, query));
      return {
        enabled: enabled && granted,
        total: entries.length,
        apps: [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
        entries: shown.slice(0, 500),
      };
    },
    setEnabled: async (on) => enableHistory(on),
    remove: async (id) => {
      history.remove(id);
      list.refreshHistory();
    },
    clear: async () => {
      history.clear();
      list.refreshHistory();
    },
    toMemo: async (id) => {
      const e = history.all().entries.find((x) => x.id === id);
      if (!e || !app.vault) return null;
      const when = new Date(e.time).toLocaleString('ko-KR');
      const memoId = app.vault.import({ body: `# ${e.title || e.app}\n\n${e.body ? `${e.body}\n\n` : ''}> ${e.app} 알림 · ${when}` });
      await app.openMemo(memoId);
      toast('알림으로 메모를 만들었어요');
      return memoId;
    },
  },
};

// 알림 모아두기 켜기: 안드로이드 설정의 "알림 접근" 을 허용해야 한다 (켜고 돌아오면 바로 시작)
async function enableHistory(on) {
  const granted = history.setEnabled(on);
  if (on && !granted) {
    toast('설정에서 "메모킹 알림 보관함"을 켜고 돌아와 주세요');
    await call('historyPermission').catch(() => {});
  }
  list.refreshHistory();
  refreshHistoryRow();
  return granted;
}

function refreshHistoryRow() {
  const { enabled, granted } = history.all();
  $('history-enabled').checked = enabled && granted;
  $('history-note').textContent = enabled && !granted
    ? '안드로이드 설정에서 "알림 접근"을 허용해야 모을 수 있어요'
    : '다른 앱 알림을 이 휴대폰에만 모아 둬요 (알림 보관함 탭)';
}

let notifyAsked = false;
app.setReminders = (memoId, next) => {
  if (!app.vault || !memoId || !Array.isArray(next)) return null;
  note.flush(); // 아직 파일이 없는 새 메모면 먼저 저장
  const reminders = next.map((r) => normalizeReminder(r)).filter(Boolean);
  const saved = app.vault.setReminders(memoId, reminders);
  alarms.schedule();
  alarms.tick(); // 방금 만든 알림이 이미 울릴 때면 바로
  if (!notifyAsked && reminders.some((r) => r.enabled)) {
    notifyAsked = true;
    call('notifyPermission').then((ok) => {
      if (!ok) toast('알림이 꺼져 있어요. 휴대폰 설정에서 메모킹 알림을 켜 주세요.', true);
      refreshNotifyRow();
    }).catch(() => {});
  }
  return saved;
};

// ---------- 예약 알림 ----------

const alarms = createAlarms({
  getVault: () => app.vault,
  onFire: (memoId, reminder, alarm) => {
    // "메모 띄우기" 알림: 앱이 보이고 있으면 바로 그 메모를 연다
    if (reminder.action === 'open' && !document.hidden) app.openMemo(memoId, { alarm, highlight: true });
  },
});

// ---------- 화면 바꾸기 ----------

function showSetup(error = '') {
  $('list-screen').hidden = true;
  $('note-screen').hidden = true;
  $('setup').hidden = false;
  $('setup-error').hidden = !error;
  $('setup-error').textContent = error;
  matchChrome($('setup'));
}

app.showList = () => {
  closeAllSheets();
  note.closeNote();
  list.refresh();
  list.show();
};

app.openMemo = async (id, options = {}) => {
  if (!app.vault) return;
  closeAllSheets();
  $('list-screen').hidden = false; // 메모 뒤에 목록이 있어야 닫을 때 바로 보인다
  await note.openNote(id, options);
};

app.newMemo = async ({ color } = {}) => {
  if (!app.vault) return null;
  let pick = color;
  if (!pick) {
    try {
      pick = localStorage.getItem('memoking.newColor') ?? undefined;
    } catch {
      // 기본 노랑
    }
  }
  const id = app.vault.create({ color: pick });
  await app.openMemo(id, { fresh: true });
  return id;
};

// ---------- 메모 메뉴 (메모 화면 ⋮ · 카드 길게 누르기) ----------

let menuFor = null;
const memoSheet = $('memo-sheet');
const swatches = $('swatches');
for (const color of COLORS) {
  const s = document.createElement('button');
  s.className = 'swatch';
  s.dataset.color = color;
  s.setAttribute('role', 'radio');
  s.setAttribute('aria-label', COLOR_NAMES[color]);
  swatches.append(s);
}

app.memoMenu = (id) => {
  const memo = app.vault?.get(id);
  if (!memo) return;
  menuFor = id;
  const inNote = note.currentId() === id;
  const body = inNote ? note.editorMarkdown() : memo.body;
  $('memo-sheet-title').textContent = isBlankBody(body) ? '새 메모' : extractTitle(body);
  for (const s of swatches.children) s.setAttribute('aria-checked', String(s.dataset.color === memo.color));
  memoSheet.querySelector('[data-memo-action="open"]').hidden = inNote;
  memoSheet.querySelector('[data-memo-action="print"]').hidden = !inNote;
  const pin = memoSheet.querySelector('[data-memo-action="pin"]');
  pin.querySelector('span').textContent = memo.pinned ? '목록 맨 위 고정 풀기' : '목록 맨 위에 고정';
  pin.querySelector('svg').replaceWith(icon(memo.pinned ? 'pin-fill' : 'pin'));
  openSheet(memoSheet);
};

swatches.addEventListener('click', (e) => {
  const s = e.target.closest('[data-color]');
  if (!s || !menuFor) return;
  note.flush();
  app.vault.setMeta(menuFor, { color: s.dataset.color });
  try {
    localStorage.setItem('memoking.newColor', s.dataset.color); // 다음 새 메모도 이 색으로
  } catch {
    // 무시
  }
  for (const x of swatches.children) x.setAttribute('aria-checked', String(x === s));
});

memoSheet.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-memo-action]');
  if (!b || !menuFor) return;
  const id = menuFor;
  const memo = app.vault.get(id);
  const body = note.currentId() === id ? note.editorMarkdown() : memo?.body ?? '';
  const title = isBlankBody(body) ? '새 메모' : extractTitle(body);
  switch (b.dataset.memoAction) {
    case 'open':
      closeSheet(memoSheet);
      app.openMemo(id);
      break;
    case 'pin':
      note.flush();
      app.vault.setMeta(id, { pinned: !memo.pinned });
      closeSheet(memoSheet);
      toast(memo.pinned ? '고정을 풀었어요' : '목록 맨 위에 고정했어요');
      break;
    case 'share':
      closeSheet(memoSheet);
      call('share', { title, text: plainText(body) }).catch((err) => toast(err.message, true));
      break;
    case 'copy':
      closeSheet(memoSheet);
      native.copyText(body);
      toast('글을 복사했어요 (마크다운)');
      break;
    case 'print':
      closeSheet(memoSheet);
      note.flush();
      call('print', { title }).catch((err) => toast(err.message, true));
      break;
    case 'delete': {
      closeSheet(memoSheet);
      if (!isBlankBody(body)) {
        const ok = await confirmDialog(`"${title}" 메모를 지울까요?\n지운 메모는 메모 폴더 안 휴지통에 보관돼요.`);
        if (!ok) return;
      }
      if (note.currentId() === id) note.discardAndClose();
      try {
        app.vault.trash(id);
        toast('메모를 휴지통으로 옮겼어요');
      } catch (err) {
        toast(err.message, true);
      }
      app.showList();
      break;
    }
    default:
  }
});

// ---------- 설정 ----------

const TRASH_DAYS_KEY = 'memoking.trashDays';
const trashDays = () => {
  try {
    const v = localStorage.getItem(TRASH_DAYS_KEY);
    return v == null ? 30 : Number(v);
  } catch {
    return 30;
  }
};

function refreshNotifyRow() {
  const info = native.info();
  const exact = info.exactAlarms;
  $('notify-note').textContent = exact
    ? '알림이 꺼져 있으면 버튼을 눌러 허용해 주세요'
    : '정확한 시각에 울리려면 "알람 및 리마인더" 권한이 필요해요';
  $('notify-btn').textContent = exact ? '알림 허용하기' : '권한 설정 열기';
  $('notify-btn').onclick = () => (exact ? call('notifyPermission').then((ok) => toast(ok ? '알림을 허용했어요' : '휴대폰 설정에서 메모킹 알림을 켜 주세요', !ok)) : call('exactAlarmSettings'));
}

function openSettings() {
  const info = native.info();
  $('vault-path').textContent = info.vault?.label || '(없음)';
  $('use-internal-2').hidden = Boolean(info.vault?.internal);
  $('change-vault').textContent = info.vault?.drive ? '휴대폰 폴더 고르기' : '폴더 바꾸기';
  $('vault-hint').hidden = Boolean(info.vault?.drive);
  $('trash-days').value = String(trashDays());
  $('version').textContent = `메모킹 안드로이드 ${info.version}`;
  const n = app.vault?.trashList().length ?? 0;
  $('trash-count').textContent = n ? String(n) : '';
  refreshNotifyRow();
  refreshHistoryRow();
  renderDrive();
  openSheet($('settings-sheet'));
}
$('settings-btn').addEventListener('click', openSettings);
$('history-enabled').addEventListener('change', () => enableHistory($('history-enabled').checked));
$('trash-days').addEventListener('change', () => {
  try {
    localStorage.setItem(TRASH_DAYS_KEY, $('trash-days').value);
  } catch {
    // 무시
  }
  purgeOldTrash();
});

async function chooseFolder() {
  let info;
  try {
    info = await call('pickFolder');
  } catch (err) {
    return err.message;
  }
  if (!info) return null; // 취소
  openVault();
  return '';
}

// Google Drive 연결 (처음 화면 · 설정)
$('choose-drive').addEventListener('click', () => startConnect(() => openVault()));
$('drive-connect').addEventListener('click', () => startConnect(() => openVault()));
$('drive-sync-now').addEventListener('click', () => syncNow());
$('sync-btn').addEventListener('click', () => syncNow());
$('drive-disconnect').addEventListener('click', async () => {
  const ok = await confirmDialog('Google Drive 연결을 끊을까요?\n휴대폰에 받아 둔 메모는 그대로 볼 수 있지만, 다시 연결할 때까지 PC와 맞추지 않아요.', '연결 끊기');
  if (!ok) return;
  drive.disconnect();
  renderDrive();
  toast('Google Drive 연결을 끊었어요');
});

$('choose-folder').addEventListener('click', async () => {
  const error = await chooseFolder();
  if (error) showSetup(error);
});
$('use-internal').addEventListener('click', () => {
  native.useInternalVault();
  openVault();
});
$('change-vault').addEventListener('click', async () => {
  note.flush();
  const error = await chooseFolder();
  if (error) toast(error, true);
  else if (error === '') toast('메모 폴더를 바꿨어요');
});
$('use-internal-2').addEventListener('click', async () => {
  const ok = await confirmDialog('메모 폴더를 이 휴대폰 안으로 바꿀까요?\n지금 폴더의 메모는 그대로 남아요.', '바꾸기');
  if (!ok) return;
  note.flush();
  native.useInternalVault();
  openVault();
  toast('이 휴대폰 안 폴더로 바꿨어요');
});

// ---------- 휴지통 ----------

function renderTrash() {
  const items = app.vault.trashList();
  const days = trashDays();
  $('trash-note').textContent = days
    ? `지운 메모는 ${days}일 동안 보관한 뒤 영구 삭제돼요.`
    : '지운 메모는 직접 지울 때까지 보관돼요.';
  $('trash-empty').hidden = items.length > 0;
  $('trash-clear').disabled = items.length === 0;
  $('trash-list').replaceChildren(...items.map((t) => {
    const li = document.createElement('li');
    li.className = 'trash-item';
    li.dataset.color = t.color;
    const dot = document.createElement('span');
    dot.className = 'row-dot';
    const text = document.createElement('div');
    text.className = 'trash-text';
    const title = document.createElement('span');
    title.className = 'trash-title';
    title.textContent = t.title;
    const sub = document.createElement('span');
    sub.className = 'trash-sub';
    const at = new Date(t.deletedAt);
    sub.textContent = `${at.getMonth() + 1}월 ${at.getDate()}일에 지움${t.attachments ? ` · 첨부 ${t.attachments}개` : ''}`;
    text.append(title, sub);
    const restore = document.createElement('button');
    restore.className = 'btn';
    restore.textContent = '되살리기';
    restore.addEventListener('click', () => {
      const id = app.vault.restoreTrash(t.name);
      renderTrash();
      list.refresh();
      toast(id ? '메모를 되살렸어요' : '되살리지 못했어요', !id);
    });
    const del = document.createElement('button');
    del.className = 'icon-btn danger';
    del.setAttribute('aria-label', `${t.title} 영구 삭제`);
    del.append(icon('trash'));
    del.addEventListener('click', async () => {
      if (!(await confirmDialog(`"${t.title}" 메모를 영구 삭제할까요?\n되돌릴 수 없어요.`, '영구 삭제'))) return;
      app.vault.deleteTrash(t.name);
      renderTrash();
    });
    li.append(dot, text, restore, del);
    return li;
  }));
}
$('trash-btn').addEventListener('click', () => {
  renderTrash();
  openSheet($('trash-sheet'));
});
$('trash-clear').addEventListener('click', async () => {
  if (!(await confirmDialog('휴지통의 메모를 모두 영구 삭제할까요?\n되돌릴 수 없어요.', '모두 삭제'))) return;
  const { memos } = app.vault.emptyTrash();
  renderTrash();
  toast(`메모 ${memos}개를 영구 삭제했어요`);
});

function purgeOldTrash() {
  const days = trashDays();
  if (!days || !app.vault) return;
  try {
    app.vault.emptyTrash({ olderThanDays: days });
  } catch (err) {
    console.warn('휴지통 정리 실패', err);
  }
}

// ---------- 다른 앱에서 들어온 것 ----------

const esc = (s) => String(s).replace(/([\\[\]*_`<>])/g, '\\$1');

function sourceLine(appName) {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const when = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `> 출처: ${esc(appName || '공유하기')} · ${when}`;
}

// 공유하기로 받은 글·주소·파일로 새 메모 (PC 의 빠른 메모와 같은 모양: 제목 → 글 → 파일 → 출처)
async function memoFromShare(payload) {
  const text = String(payload.text ?? '').trim();
  const subject = String(payload.subject ?? '').trim();
  const files = payload.files ?? [];
  if (!text && !files.length) return;
  const id = app.vault.create({});
  await app.openMemo(id, {
    capture: async (editor) => {
      const url = loneUrl(text);
      if (subject && !text.includes(subject) && !url) editor.setMarkdown(`# ${esc(subject)}\n`);
      else if (!text && files.length) editor.setMarkdown(`# ${esc(files.length === 1 ? files[0].name : `파일 ${files.length}개`)}\n`);
      editor.focusEnd();
      // 공유받은 글은 줄마다 문단으로 (마크다운에서 줄 하나 바꿈은 같은 문단으로 붙어 버린다)
      if (text) editor.pasteData({ text: url ?? text.replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1\n\n') });
      if (files.length) editor.insertItems(note.tempsToItems(files));
      await new Promise((r) => setTimeout(r, 30));
      editor.appendMarkdown(sourceLine(payload.app));
      await editor.imagesSettled();
      note.flush();
      document.activeElement?.blur(); // 키보드는 올리지 않는다 (이어 쓰려면 누르기)
      toast('공유받은 내용으로 메모를 만들었어요');
    },
  });
}

async function handleIntent() {
  let payload;
  try {
    payload = native.takeIntent();
  } catch {
    return;
  }
  if (!payload || !app.vault) {
    pendingIntent = payload ?? pendingIntent;
    return;
  }
  if (payload.type === 'open' && payload.memoId) {
    app.openMemo(payload.memoId, { alarm: payload.label ? { label: payload.label } : undefined, highlight: true });
  } else if (payload.type === 'new') {
    app.newMemo();
  } else if (payload.type === 'share') {
    await memoFromShare(payload);
  }
}
let pendingIntent = null;

// ---------- 메모 폴더 열기 ----------

let started = false;
let changeTimer = null;

function openVault() {
  app.vault?.close();
  note.closeNote({ quiet: true });
  closeAllSheets();
  const vault = new Vault();
  try {
    vault.open();
  } catch (err) {
    console.error(err);
    showSetup(`메모 폴더를 열지 못했어요. 다른 폴더를 골라 주세요. (${err.message})`);
    return;
  }
  app.vault = vault;
  app.vaultInfo = native.info().vault;
  app.previews ??= new LinkPreviews();
  app.previews.reset();
  vault.on('changed', (detail) => {
    note.onVaultChanged(detail);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => list.refresh(), 60);
    alarms.scheduleSoon();
  });
  vault.on('error', (err) => console.warn('[메모 폴더]', err));
  $('setup').hidden = true;
  list.refresh();
  list.show();
  purgeOldTrash();
  if (!started) {
    started = true;
    alarms.startup();
  }
  alarms.start();
  alarms.schedule();
  renderDrive();
  if (app.vaultInfo?.drive) drive.syncSoon();
  if (pendingIntent) {
    const p = pendingIntent;
    pendingIntent = null;
    if (p.type === 'open') app.openMemo(p.memoId, { alarm: p.label ? { label: p.label } : undefined, highlight: true });
    else if (p.type === 'new') app.newMemo();
    else if (p.type === 'share') memoFromShare(p);
  }
}

// ---------- 앱의 소식 ----------

on('intent', handleIntent);
on('history', () => list.refreshHistory());
// Google Drive 동기화 소식: 내려받은 게 있으면 메모 폴더를 바로 다시 읽는다
on('sync', (st) => {
  renderDrive();
  if (st.changed) app.vault?.scan();
  if (st.conflicts?.length) toast(`PC와 휴대폰에서 함께 고친 메모 ${st.conflicts.length}개는 "(휴대폰 충돌 …)" 사본으로 남겼어요`);
});
on('alarm', () => alarms.tick());
on('keyboard', ({ open }) => {
  nativeKeyboard = true;
  note.setKeyboard(open);
});
// 안드로이드 11 아래는 앱이 키보드 소식을 못 보내므로 화면 높이로 짐작한다
let nativeKeyboard = false;
let fullHeight = window.innerHeight;
window.addEventListener('resize', () => {
  if (nativeKeyboard) return;
  fullHeight = Math.max(fullHeight, window.innerHeight);
  note.setKeyboard(window.innerHeight < fullHeight * 0.8);
});
on('app', (state) => {
  if (state === 'pause') {
    note.flush();
    app.vault?.pause();
    alarms.stop();
  } else if (state === 'resume' && app.vault) {
    app.vault.scan();
    renderDrive();
    list.refreshHistory(); // "알림 접근" 을 켜고 돌아왔을 때
    app.vault.resume();
    alarms.start();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) note.flush();
});

// 뒤로 가기: 확인 창 → 색판 → 시트 → 메모 → 목록의 검색·필터 → (앱이 뒤로)
setBackHandler(() => {
  if (closeConfirm()) return true;
  if (note.closePalette()) return true;
  if (sheetOpen()) return closeTopSheet();
  if (note.isOpen()) {
    app.showList();
    return true;
  }
  if (!$('list-screen').hidden) return list.back();
  return false;
});

// ---------- 시작 ----------

list.setup();
const info = native.info();
if (info.vault?.ok) openVault();
else showSetup(info.vault ? '메모 폴더에 더 이상 접근할 수 없어요. 폴더를 다시 골라 주세요.' : '');
native.ready();
await handleIntent();
document.documentElement.dataset.ready = 'true';
