// 메모킹 안드로이드 — 시작, 화면 바꾸기, 설정·휴지통, 다른 앱에서 받은 것, 예약 알림
import { injectIcons, icon } from '../../app/js/icons.js';
import { normalizeReminder } from '../../app/js/core/reminders.js';
import { extractTitle, isBlankBody, COLORS } from '../../app/js/core/memo-file.js';
import { loneUrl } from '../../app/js/core/link-preview.js';
import { shareText } from '../../app/js/core/share-text.js';
import { importText, isTextDocument, stripFrontMatter } from '../../app/js/core/markdown-import.js';
import { mediaKind } from '../../app/js/media.js';
import { vocabularyFrom, fixTranscript } from '../../app/js/core/transcript-fix.js';
import { voiceCardMarkdown, attachTranscript } from '../../app/js/core/voice-card.js';
import { native, call, on, setBackHandler, drive, history, fs } from './native.js';
import { matchesQuery } from '../../app/js/core/notifications.js';
import { startConnect, renderStatus as renderDrive, syncNow } from './drive.js';
import { Vault } from './vault.js';
import { LinkPreviews } from './web-fetch.js';
import { createAlarms } from './alarms.js';
import { injectMobileIcons } from './m-icons.js';
import { app, COLOR_NAMES } from './state.js';
import { openSheet, closeSheet, closeTopSheet, closeAllSheets, sheetOpen, toast, confirmDialog, closeConfirm, matchChrome, isTwoPane } from './ui.js';
import * as recorder from './recorder.js';
import { renderMemoImage } from './share-image.js';
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
    // 이 앱 알림 그만 모으기 (보관함의 알림을 펼친 곳)
    block: async (e) => {
      await blockApp(e.appId, e.app);
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

// 앱 하나를 더 모으지 않기: 이미 모은 것도 지울지 묻는다
async function blockApp(appId, appName) {
  if (!(await confirmDialog(`${appName} 알림을 앞으로 모으지 않을까요?\n설정 › 알림 모을 앱 고르기에서 다시 켤 수 있어요.`, '그만 모으기'))) return false;
  const count = history.all().entries.filter((x) => x.appId === appId && x.source !== 'memoking').length;
  const remove = count > 0 && await confirmDialog(`이미 모은 ${appName} 알림 ${count}개도 지울까요?`, '지우기');
  const removed = history.block(appId, appName, remove);
  toast(removed ? `${appName} 알림을 그만 모으고 ${removed}개를 지웠어요` : `${appName} 알림을 앞으로 모으지 않아요`);
  return true;
}

// 알림 모을 앱 고르기: 지금까지 알림이 온 앱 + 끈 앱, 앱마다 스위치
function renderApps() {
  const { entries, blocked } = history.all();
  const apps = new Map();
  for (const e of entries) {
    if (e.source === 'memoking') continue;
    const a = apps.get(e.appId) ?? { appId: e.appId, app: e.app, image: e.image, count: 0 };
    a.count++;
    apps.set(e.appId, a);
  }
  for (const [appId, app] of Object.entries(blocked ?? {})) if (!apps.has(appId)) apps.set(appId, { appId, app, image: `${appId}.png`, count: 0 });
  const rows = [...apps.values()].sort((a, b) => b.count - a.count || a.app.localeCompare(b.app, 'ko'));
  $('apps-empty').hidden = rows.length > 0;
  $('apps-list').replaceChildren(...rows.map((a) => {
    const off = Boolean(blocked?.[a.appId]);
    const li = document.createElement('li');
    li.className = `app-row${off ? ' off' : ''}`;
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.src = `${window.memoking.historyBase}${encodeURIComponent(a.image ?? `${a.appId}.png`)}`;
    img.onerror = () => {
      const letter = document.createElement('span');
      letter.className = 'avatar letter';
      letter.textContent = (a.app || '?').charAt(0).toUpperCase();
      let h = 0;
      for (const ch of a.app) h = (h * 31 + ch.codePointAt(0)) % 360;
      letter.style.background = `hsl(${h} 55% 50%)`;
      img.replaceWith(letter);
    };
    const name = document.createElement('span');
    name.className = 'app-name';
    const b = document.createElement('b');
    b.textContent = a.app;
    const small = document.createElement('small');
    small.textContent = off ? '모으지 않아요' : `알림 ${a.count}개 보관 중`;
    name.append(b, small);
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.checked = !off;
    sw.setAttribute('aria-label', `${a.app} 알림 모으기`);
    sw.addEventListener('change', async () => {
      if (sw.checked) {
        history.unblock(a.appId);
        toast(`${a.app} 알림을 다시 모아요`);
      } else if (!(await blockApp(a.appId, a.app))) sw.checked = true;
      renderApps();
      refreshHistoryRow();
      list.refreshHistory();
    });
    li.append(img, name, sw);
    return li;
  }));
}

function openAppsSheet() {
  renderApps();
  openSheet($('apps-sheet'));
}
$('history-apps').addEventListener('click', openAppsSheet);
$('history-apps-2').addEventListener('click', openAppsSheet);

function refreshHistoryRow() {
  const { enabled, granted } = history.all();
  $('history-enabled').checked = enabled && granted;
  const blockedCount = Object.keys(history.all().blocked ?? {}).length;
  $('blocked-count').textContent = blockedCount ? `${blockedCount}개 끔` : '';
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
  syncPane();
};

// 넓은 화면: 메모를 고르지 않았으면 오른쪽에 안내
function syncPane() {
  $('pane-empty').hidden = !isTwoPane() || note.isOpen() || $('list-screen').hidden;
}
window.addEventListener('memoking:pane', () => {
  syncPane();
  if (note.isOpen() && !isTwoPane()) matchChrome(document.querySelector('#note-screen .bar'));
  else if (!$('list-screen').hidden) matchChrome($('list-screen'));
});

// 태그를 눌러 그 태그의 메모 모아 보기 (연결 패널 · 추천 태그)
app.filterByTag = (name) => {
  closeAllSheets();
  if (!isTwoPane()) note.closeNote();
  list.filterTag(name);
  list.show();
  syncPane();
};

app.openMemo = async (id, options = {}) => {
  if (!app.vault) return;
  closeAllSheets();
  $('list-screen').hidden = false; // 메모 뒤에 목록이 있어야 닫을 때 바로 보인다
  await note.openNote(id, options);
  syncPane();
};

app.newMemo = async ({ color, voice = false } = {}) => {
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
  await app.openMemo(id, { fresh: true, record: Boolean(voice) });
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
      openShare(id);
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
    case 'delete':
      closeSheet(memoSheet);
      deleteMemo(id);
      break;
    default:
  }
});

// ---------- 지우기: 묻지 않고 바로 휴지통으로 (애니메이션 + 되돌리기) ----------

const titleOf = (body) => (isBlankBody(body) ? '새 메모' : extractTitle(body));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 메모를 지운다. 열려 있으면 메모 화면이 휴지통으로 빨려 들어가듯, 목록이면 카드가 접히며 사라진다 */
async function deleteMemo(id) {
  if (!app.vault?.get(id)) return;
  const inNote = note.currentId() === id;
  const body = inNote ? note.editorMarkdown() : app.vault.get(id)?.body ?? '';
  const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (inNote) {
    note.flush();
    if (motion) {
      $('note-screen').classList.add('trashing');
      await wait(260);
    }
    note.discardAndClose();
    $('note-screen').classList.remove('trashing');
  } else if (motion) await list.animateRemove(id);
  navigator.vibrate?.(10);
  let name;
  try {
    name = app.vault.trash(id);
  } catch (err) {
    toast(err.message, true);
    list.refresh();
    return;
  }
  if (inNote) app.showList();
  else list.refresh();
  if (isBlankBody(body) || typeof name !== 'string') {
    toast('메모를 지웠어요');
    return;
  }
  toast(`"${titleOf(body)}" 를 휴지통으로 옮겼어요`, false, {
    label: '되돌리기',
    run: () => {
      const restored = app.vault.restoreTrash(name);
      list.refresh();
      toast(restored ? '메모를 되살렸어요' : '되살리지 못했어요', !restored);
    },
  });
}
app.deleteMemo = deleteMemo;

// ---------- 보내기: 글(목록 모양 그대로) · 그림 · PDF ----------

let shareFor = null;
const shareSheet = $('share-sheet');
function openShare(id) {
  shareFor = id;
  const memo = app.vault.get(id);
  const body = note.currentId() === id ? note.editorMarkdown() : memo?.body ?? '';
  $('share-sheet-title').textContent = `"${titleOf(body)}" 보내기`;
  $('share-busy').hidden = true;
  for (const b of shareSheet.querySelectorAll('[data-share]')) b.disabled = false;
  openSheet(shareSheet);
}

const fileName = (title, ext) => `${title.replace(/[\\/:*?"<>|#]+/g, ' ').trim().slice(0, 60) || '메모'}.${ext}`;

shareSheet.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-share]');
  if (!b || !shareFor) return;
  const id = shareFor;
  const kind = b.dataset.share;
  const body = note.currentId() === id ? note.editorMarkdown() : app.vault.get(id)?.body ?? '';
  const title = titleOf(body);
  if (kind === 'text') {
    closeSheet(shareSheet);
    call('share', { title, text: shareText(body) }).catch((err) => toast(err.message, true));
    return;
  }
  // 그림·PDF 는 메모 화면에 그려진 모습으로 만든다 (닫혀 있으면 연다)
  for (const x of shareSheet.querySelectorAll('[data-share]')) x.disabled = true;
  $('share-busy').hidden = false;
  $('share-busy-text').textContent = kind === 'image' ? '그림을 만들고 있어요' : 'PDF를 만들고 있어요';
  try {
    if (note.currentId() !== id) {
      closeSheet(shareSheet);
      await app.openMemo(id);
      openSheet(shareSheet);
    }
    note.flush();
    await note.settled();
    if (kind === 'image') {
      const base64 = await renderMemoImage(note.getEditor(), { color: app.vault.get(id)?.color });
      await call('shareFile', { base64, name: fileName(title, 'png'), mime: 'image/png', title });
    } else {
      try {
        await call('sharePdf', { title, name: fileName(title, 'pdf') });
      } catch (err) {
        console.warn('PDF 파일을 바로 만들지 못해 인쇄 화면으로', err);
        await call('print', { title });
      }
    }
    closeSheet(shareSheet);
  } catch (err) {
    console.error(err);
    toast(err.message || '보내지 못했어요', true);
  } finally {
    $('share-busy').hidden = true;
    for (const x of shareSheet.querySelectorAll('[data-share]')) x.disabled = false;
  }
});

// ---------- 녹음을 메모에 넣기 (녹음을 끝냈을 때 · 앱이 꺼져 있는 동안 끝난 녹음) ----------


// 받아쓰기 말모음: 이 메모 폴더의 태그·제목에 자주 나온 낱말 (힌트로 넘기고, 받아쓴 글을 고칠 때 쓴다)
let vocabCache = { at: 0, list: [] };
function sttVocab() {
  if (!app.vault) return [];
  if (Date.now() - vocabCache.at > 60_000) vocabCache = { at: Date.now(), list: vocabularyFrom(app.vault.bodies()) };
  return vocabCache.list;
}
app.sttTerms = () => sttVocab().map((t) => t.term);
const polish = (text) => fixTranscript(text, sttVocab());

function whenLabel(ms) {
  const d = new Date(ms || Date.now());
  const h = d.getHours();
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

app.deliverRecording = async (r) => {
  if (!app.vault || !r?.temp) return;
  const duration = recorder.formatDuration(r.durationMs ?? 0);
  const alt = `녹음 ${whenLabel(r.startedAt)} · ${duration}`;
  const [item] = note.tempsToItems([{ temp: r.temp, name: r.name || 'recording.m4a', mime: r.mime || 'audio/mp4' }]);
  item.alt = alt;
  const transcript = polish(String(r.transcript ?? '').trim());
  // 소리와 받아쓴 글을 한 칸(음성 카드)에 — 문장마다 줄, 말한 사람이 바뀌면 이름표
  const card = voiceCardMarkdown(item, transcript);
  let memoId = r.memoId;
  if (note.currentId() === memoId) {
    note.insertRecording(card, `음성 메모 · ${whenLabel(r.startedAt)}`);
  } else {
    const memo = memoId && app.vault.get(memoId);
    const parts = card;
    const heading = `# 음성 메모 · ${whenLabel(r.startedAt)}`;
    if (memo && !isBlankBody(memo.body)) app.vault.save(memoId, `${memo.body.replace(/\s+$/, '')}\n\n${parts}\n`);
    else if (memo) app.vault.save(memoId, `${heading}\n\n${parts}\n`);
    else memoId = app.vault.import({ body: `${heading}\n\n${parts}\n` });
    list.refresh();
  }
  toast(transcript ? `녹음 ${duration}과 받아쓴 글을 메모에 넣었어요` : `녹음 ${duration}을 메모에 넣었어요`);
  // 녹음 중에는 못 받아썼으면(모델이 없었음) 이제 녹음 파일로
  if (r.sttPending && recorder.sttOn()) {
    if (recorder.sttReady()) transcribeInto(memoId, [item]);
    else if (recorder.sttEngine() === 'vosk') {
      toast('받아쓰기 모델을 받으면 이 녹음을 글로 옮길게요', false, {
        label: '모델 받기',
        run: () => recorder.downloadModel().then(() => transcribeInto(memoId, [item])).catch(() => {}),
      });
    }
  }
};

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
  $('auto-tags').checked = note.autoTagsOn();
  $('rec-stt').checked = recorder.sttOn();
  $('rec-stt-note').textContent = '말하는 대로 글로 옮겨요 · 화면을 꺼도 계속 녹음해요';
  $('stt-engine').value = recorder.sttEngine();
  $('stt-engine').querySelector('[value="system"]').disabled = !info.record?.system;
  refreshSttRow();
  openSheet($('settings-sheet'));
}

function refreshSttRow(progress) {
  const st = recorder.sttStatus();
  const vosk = recorder.sttEngine() === 'vosk';
  $('stt-model-row').hidden = !vosk;
  $('stt-engine-note').textContent = vosk
    ? 'Vosk 는 오픈소스라 인터넷 없이 휴대폰 안에서만 받아써요 (회의 내용이 밖으로 나가지 않아요)'
    : '휴대폰에 들어 있는 음성 인식(보통 Google)으로 받아써요. 더 정확하지만 휴대폰에 따라 인터넷을 쓸 수 있어요';
  const busy = progress != null || st.model === 'downloading';
  $('stt-model-note').textContent = st.model === 'ready'
    ? '받아 둠 · 인터넷 없이 받아써요'
    : busy ? `받는 중 ${progress ?? st.progress ?? 0}%` : `처음 한 번 받아요 (${st.modelSize ?? '약 87MB'}, Wi-Fi 추천)`;
  $('stt-model-btn').textContent = st.model === 'ready' ? '지우기' : busy ? '받는 중' : '받기';
  $('stt-model-btn').disabled = busy;
  refreshSpeakerRow();
}

// 말한 사람 나누기: Vosk 말한 사람 모델(약 13MB)을 받으면 받아쓴 글에 "화자 1·2" 이름표
function refreshSpeakerRow(progress) {
  const st = recorder.sttStatus();
  const vosk = recorder.sttEngine() === 'vosk';
  $('spk-row').hidden = !vosk || st.model !== 'ready';
  const busy = progress != null || st.speaker === 'downloading';
  const ready = st.speaker === 'ready';
  $('spk-note').textContent = busy
    ? `받는 중 ${progress ?? 0}%`
    : ready
      ? st.speakerOn ? '켜짐 · 말한 사람이 바뀌면 "화자 2:" 처럼 표시해요' : '꺼짐 · 눌러서 다시 켜기'
      : `목소리 특징으로 회의 참석자를 나눠요 (${st.speakerSize ?? '약 13MB'}, 인터넷 없이)`;
  $('spk-btn').textContent = busy ? '받는 중' : ready ? (st.speakerOn ? '끄기' : '켜기') : '받기';
  $('spk-btn').disabled = busy;
}
$('spk-btn').addEventListener('click', async () => {
  const st = recorder.sttStatus();
  try {
    if (st.speaker === 'ready') await call('speakerModel', { on: !st.speakerOn });
    else {
      refreshSpeakerRow(0);
      await call('speakerModel', {});
      toast('말한 사람 나누기를 켰어요. 다음 녹음부터 사람별로 나눠 적어요');
    }
  } catch (err) {
    toast(err.message || '말한 사람 모델을 받지 못했어요. 인터넷 연결을 확인해 주세요', true);
  }
  refreshSpeakerRow();
});
on('speakerModel', ({ progress }) => {
  if (!$('settings-sheet').hidden) refreshSpeakerRow(progress < 100 ? progress : undefined);
});
$('stt-engine').addEventListener('change', () => {
  recorder.setSttEngine($('stt-engine').value);
  refreshSttRow();
});
$('stt-model-btn').addEventListener('click', async () => {
  if (recorder.sttStatus().model === 'ready') {
    if (!(await confirmDialog('받아쓰기 모델을 지울까요?\n다시 받아쓰려면 다시 받아야 해요.', '지우기'))) return;
    await call('sttModel', { delete: true }).catch((err) => toast(err.message, true));
    refreshSttRow();
    return;
  }
  refreshSttRow(0);
  recorder.downloadModel().catch(() => {}).finally(() => refreshSttRow());
});
on('sttModel', ({ progress }) => {
  if (!$('settings-sheet').hidden) refreshSttRow(progress < 100 ? progress : undefined);
});
$('auto-tags').addEventListener('change', () => note.setAutoTags($('auto-tags').checked));
$('rec-stt').addEventListener('change', () => recorder.setStt($('rec-stt').checked));
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

// 받은 소리 파일: 받아쓸지 그때마다 묻는다 (지난번 고른 것이 기본)
const IMPORT_STT_KEY = 'memoking.importStt';
function askAudioImport(files) {
  const sheet = $('import-sheet');
  $('import-files').replaceChildren(...files.map((f) => {
    const li = document.createElement('li');
    li.append(icon('audio'), f.name || '소리 파일');
    if (f.size) {
      const small = document.createElement('small');
      small.textContent = f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(f.size / 1024))}KB`;
      li.append(small);
    }
    return li;
  }));
  const canStt = true; // Vosk 는 모든 안드로이드 버전 (모델이 없으면 받은 뒤)
  let last = true;
  try {
    last = localStorage.getItem(IMPORT_STT_KEY) !== 'off';
  } catch {
    // 기본은 받아쓰기
  }
  $('import-stt').checked = canStt && last;
  $('import-stt').disabled = !canStt;
  $('import-stt-note').textContent = recorder.sttReady()
    ? '소리 내용을 글로 옮겨 메모에 함께 넣어요 (길면 시간이 걸려요)'
    : `소리 내용을 글로 옮겨요 · 받아쓰기 모델(${recorder.sttStatus().modelSize ?? '약 87MB'})을 먼저 한 번 받아요`;
  $('import-sheet-title').textContent = files.length > 1 ? `음성 파일 ${files.length}개로 메모 만들기` : '음성 파일로 메모 만들기';
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      $('import-ok').onclick = null;
      $('import-cancel').onclick = null;
      closeSheet(sheet);
      resolve(value);
    };
    $('import-ok').onclick = () => {
      const stt = $('import-stt').checked;
      try {
        localStorage.setItem(IMPORT_STT_KEY, stt ? 'on' : 'off');
      } catch {
        // 이번에만
      }
      finish({ stt });
    };
    $('import-cancel').onclick = () => finish(null);
    openSheet(sheet, { onClose: () => finish(null) });
  });
}

// 메모 폴더의 소리 파일을 받아써서 그 메모 끝에 넣는다 (오래 걸리므로 메모를 만든 뒤 따로)
async function transcribeInto(memoId, items) {
  for (const item of items) {
    try {
      toast(`"${item.alt}" 를 받아쓰고 있어요…`);
      const res = await call('transcribe', { rel: item.src, engine: recorder.sttEngine(), terms: app.sttTerms() });
      const text = polish(String(res?.text ?? '').trim());
      if (!text) {
        toast('받아쓸 말소리를 찾지 못했어요');
        continue;
      }
      // 그 소리 줄에 붙여 음성 카드로 (소리 줄을 못 찾으면 메모 끝에)
      if (note.currentId() === memoId) {
        if (!note.attachTranscript(item.src, text)) note.appendText(importText(text).markdown);
      } else {
        const memo = app.vault.get(memoId);
        const next = memo && attachTranscript(memo.body, item.src, text);
        if (next) app.vault.save(memoId, next);
        else if (memo) app.vault.save(memoId, `${memo.body.replace(/\s+$/, '')}\n\n${importText(text).markdown}\n`);
      }
      toast('받아쓴 글을 메모에 넣었어요');
    } catch (err) {
      toast(err.message || '받아쓰지 못했어요', true);
    }
  }
}

// 공유하기로 받은 글·주소·파일로 새 메모 (PC 의 빠른 메모와 같은 모양: 제목 → 글 → 파일 → 출처)
//   마크다운 글·.md 파일은 서식대로, 소리 파일은 받아쓸지 묻는다
async function memoFromShare(payload) {
  const text = String(payload.text ?? '').trim();
  const subject = String(payload.subject ?? '').trim();
  let files = payload.files ?? [];
  if (!text && !files.length) return;
  const docs = files.filter((f) => isTextDocument(f.name, f.mime));
  const audio = files.filter((f) => !docs.includes(f) && mediaKind({ name: f.name || '', type: f.mime || '' }) === 'audio');
  let stt = false;
  if (audio.length) {
    const answer = await askAudioImport(audio);
    if (!answer) {
      for (const f of files) {
        try {
          fs.dropTemp(f.temp);
        } catch {
          // 임시 파일은 하루 뒤 치워진다
        }
      }
      return;
    }
    stt = answer.stt;
  }
  // .md · .txt 는 첨부가 아니라 글로
  const docTexts = [];
  for (const f of docs) {
    try {
      docTexts.push(stripFrontMatter(fs.readTempText(f.temp) ?? ''));
      fs.dropTemp(f.temp);
    } catch {
      docTexts.push('');
    }
  }
  files = files.filter((f) => !docs.includes(f));
  const id = app.vault.create({});
  let audioItems = [];
  await app.openMemo(id, {
    capture: async (editor) => {
      const url = loneUrl(text);
      const docHasTitle = docTexts.some((t) => /^#\s/.test(t));
      if (subject && !text.includes(subject) && !url && !docHasTitle) editor.setMarkdown(`# ${esc(subject)}\n`);
      else if (!text && !docTexts.length && files.length) {
        const name = audio.length === files.length ? `음성 메모 · ${whenLabel(Date.now())}` : files.length === 1 ? files[0].name : `파일 ${files.length}개`;
        editor.setMarkdown(`# ${esc(name)}\n`);
      }
      editor.focusEnd();
      // 주소 하나는 링크 카드, 마크다운 글은 서식대로, 그냥 글은 줄마다 문단으로
      if (text) editor.pasteData({ text: url ?? importText(text).markdown });
      for (const t of docTexts) if (t) editor.pasteData({ text: importText(t).markdown });
      if (files.length) {
        const items = note.tempsToItems(files);
        audioItems = items.filter((it) => it.kind === 'audio');
        editor.insertItems(items);
      }
      await new Promise((r) => setTimeout(r, 30));
      editor.appendMarkdown(sourceLine(payload.app));
      await editor.imagesSettled();
      note.flush();
      document.activeElement?.blur(); // 키보드는 올리지 않는다 (이어 쓰려면 누르기)
      toast(audio.length ? '음성 파일로 메모를 만들었어요' : docTexts.length ? '마크다운 문서로 메모를 만들었어요' : '공유받은 내용으로 메모를 만들었어요');
    },
  });
  if (stt && audioItems.length) {
    if (!recorder.sttReady() && recorder.sttEngine() === 'vosk') {
      try {
        toast('받아쓰기 모델을 받고 있어요…');
        await recorder.downloadModel();
      } catch {
        return;
      }
    }
    transcribeInto(id, audioItems);
  }
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

// ---------- 새 메모: + 를 누르면 위성 버튼 (음성 메모 · 글 메모) ----------

const fab = $('fab');
const fabMenu = $('fab-menu');
function setFabMenu(open) {
  if (open === !fabMenu.hidden) return false;
  fab.setAttribute('aria-expanded', String(open));
  fab.classList.toggle('open', open);
  $('fab-scrim').hidden = !open;
  if (open) {
    fabMenu.hidden = false;
    fabMenu.classList.remove('closing');
    navigator.vibrate?.(8);
  } else {
    fabMenu.classList.add('closing');
    setTimeout(() => {
      if (fab.getAttribute('aria-expanded') === 'false') fabMenu.hidden = true;
      fabMenu.classList.remove('closing');
    }, 160);
  }
  return true;
}
app.closeFabMenu = () => setFabMenu(false);
fab.addEventListener('click', () => setFabMenu(fabMenu.hidden));
$('fab-scrim').addEventListener('click', () => setFabMenu(false));
fabMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-new]');
  if (!b) return;
  setFabMenu(false);
  app.newMemo({ voice: b.dataset.new === 'voice' });
});

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
  recorder.resume(); // 녹음이 도는 중인지, 꺼져 있는 동안 끝난 녹음이 있는지
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
    recorder.resume();
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
  if (note.closeStyleMenu()) return true;
  if (setFabMenu(false)) return true;
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
