// 메모킹 안드로이드 — 시작, 화면 바꾸기, 설정·휴지통, 다른 앱에서 받은 것, 예약 알림
import { daysAgoText } from '../../app/js/core/time.js';
import { clampPrintScale } from '../../app/js/core/pdf-page.js';
import { trashedText } from '../../app/js/core/format.js';
import { injectIcons, icon } from '../../app/js/icons.js';
import { normalizeReminder } from '../../app/js/core/reminders.js';
import { FeedStore, feedResponseText, MAX_FEED_BYTES } from '../../app/js/core/calendar-feed-list.js';
import { extractTitle, isBlankBody, COLORS, COLOR_NAMES } from '../../app/js/core/memo-file.js';
import { loneUrl } from '../../app/js/core/link-preview.js';
import { shareText } from '../../app/js/core/share-text.js';
import { importText, isTextDocument, stripFrontMatter } from '../../app/js/core/markdown-import.js';
import { mediaKind } from '../../app/js/media.js';
import { vocabularyFrom, fixTranscript } from '../../app/js/core/transcript-fix.js';
import { voiceCardMarkdown, attachTranscript, recordingWhen } from '../../app/js/core/voice-card.js';
import { native, call, on, setBackHandler, drive, history, fs } from './native.js';
import { matchesQuery } from '../../app/js/core/notifications.js';
import { startConnect, renderStatus as renderDrive, syncNow } from './drive.js';
import { Vault } from './vault.js';
import { LinkPreviews } from './web-fetch.js';
import { createAlarms } from './alarms.js';
import { injectMobileIcons } from './m-icons.js';
import { app } from './state.js';
import { openSheet, closeSheet, closeTopSheet, closeAllSheets, sheetOpen, toast, confirmDialog, closeConfirm, cancelTopDialog, matchChrome, isTwoPane } from './ui.js';
import * as recorder from './recorder.js';
import { renderMemoImage } from '../../app/js/share-image.js';
import * as widgets from './widgets.js';
import { lockDialog } from '../../app/js/lock-ui.js';
import { newLockSession } from '../../app/js/core/memo-lock.js';
import { pickHandoff, recentlyUpdated, handoffText } from '../../app/js/core/handoff.js';
import * as list from './list-view.js';
import { setupUpdates, checkForUpdate, refreshUpdateRow } from './updates.js';
import * as note from './note-view.js';
import { setupTutorial, maybeStartTutorial, startTutorial, tutEvent, tutorialWaitsFor } from './tutorial.js';
import * as panes from './panes.js';
import { attachSliders } from '../../app/js/seg-slider.js';
import { printHtml } from './print-html.js';
import { haptic, reduceMotion, radioGroups } from '../../app/js/dom.js';
import { renderVersions } from '../../app/js/versions-view.js';

const $ = (x) => document.getElementById(x);

// 공용 코드(app/js/media.js)가 첨부 주소를 만들 때 쓴다
window.memoking = { platform: 'android', vaultBase: `${location.origin}/vault/`, historyBase: `${location.origin}/history/` };

injectIcons();
attachSliders(); // 탭·고르기 칸: 선택 표시가 미끄러진다
injectMobileIcons();

// ---------- 일정 탭의 다른 캘린더 (list-reminders.js 가 씀) ----------
// 구독 주소는 비밀(누구나 그 캘린더를 볼 수 있음)이라 메모 폴더(Drive 동기화)가 아니라 이 휴대폰에만 둔다
const FEEDS_KEY = 'memoking.calendarFeeds';
const DEVICE_KEY = 'memoking.deviceCalendar';
const FEED_CACHE_MAX = 400 * 1024; // 이보다 큰 캘린더는 앱을 켤 때마다 다시 받는다
const lsGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // 저장 공간이 꽉 참 — 다음에 다시 받는다
  }
};
// 예전(0.27.0)의 Google 캘린더 상호 동기화는 없앴다 — 그 설정만 지운다 (Google 의 "메모킹" 캘린더는 그대로)
for (const k of ['memoking.gcal', 'memoking.gcalDevice', 'memoking.gcalMine']) lsSet(k, null);

function calendarApi() {
  const mem = new Map(); // id → { url, text, at }
  const cacheKey = (id) => `memoking.calendarFeed.${id}`;
  // 받는 규칙(15분 · 겹쳐 받지 않기 · 끊은 구독은 남기지 않기)은 PC 와 같은 FeedStore
  const store = new FeedStore({
    getList: () => {
      try {
        return JSON.parse(lsGet(FEEDS_KEY) ?? '[]');
      } catch {
        return [];
      }
    },
    setList: (list) => lsSet(FEEDS_KEY, JSON.stringify(list)),
    download: async (url) => {
      const res = await call('http', { url, accept: 'text/calendar, */*;q=0.5', limit: MAX_FEED_BYTES, timeout: 20_000 });
      return feedResponseText(res.status, new TextDecoder().decode(Uint8Array.from(res.latin1 ?? '', (c) => c.charCodeAt(0) & 0xff)));
    },
    cache: {
      read: (f) => {
        if (!mem.has(f.id)) {
          try {
            const c = JSON.parse(lsGet(cacheKey(f.id)) ?? 'null');
            if (c) mem.set(f.id, c);
          } catch {
            // 깨진 저장 — 다시 받는다
          }
        }
        return mem.get(f.id) ?? null;
      },
      write: (f, entry) => {
        mem.set(f.id, entry);
        // 다시 켰을 때 · 인터넷이 없을 때 보이게 작은 캘린더만 저장 (localStorage 는 몇 MB 뿐 — 다른 설정을 밀어내지 않게)
        lsSet(cacheKey(f.id), entry.text.length <= FEED_CACHE_MAX ? JSON.stringify(entry) : null);
      },
      remove: (id) => {
        mem.delete(id);
        lsSet(cacheKey(id), null);
      },
    },
  });
  return {
    feeds: async () => store.list(),
    setFeeds: async (list) => store.save(list),
    fetch: (id, force = false) => store.get(id, { force }),
    openUrl: (url) => call('openUrl', { url }), // 일정 속 주소 (회의 링크 등)
    // 휴대폰 캘린더 (삼성 캘린더 · Google 캘린더 등 — 안드로이드 CalendarContract)
    device: {
      enabled: () => lsGet(DEVICE_KEY) === '1',
      // 켜기: 권한을 물어 허용해야 켜짐 → 켜졌는가
      setEnabled: async (on) => {
        if (!on) {
          lsSet(DEVICE_KEY, null);
          return false;
        }
        const granted = await call('calendarPermission').catch(() => false);
        lsSet(DEVICE_KEY, granted ? '1' : null);
        return Boolean(granted);
      },
      events: async (from, to) => {
        const res = await call('calendarEvents', { from: from.getTime(), to: to.getTime() });
        if (!res.granted) lsSet(DEVICE_KEY, null); // 설정에서 권한을 거둬 갔다
        return res;
      },
    },
  };
}

// ---------- 데스크탑 모양의 API (reminder-panel.js · list-reminders.js 가 씀) ----------

app.api = {
  reminders: {
    set: async (memoId, next) => app.setReminders(memoId ?? note.currentId(), next),
    all: async () => app.vault?.allReminders() ?? [],
    // 일정 탭 달력에서 바로 만들기 (PC 의 reminders:add 와 같음): 고른 메모, 없으면 일정 이름으로 새 메모
    //   body: 새 메모의 본문 (다른 캘린더 일정 가져오기 — 달력 그림 · 장소 · 설명). 없으면 "# 일정 이름" 만
    add: async (memoId, reminder, newTitle, body) => {
      if (!app.vault) return null;
      let id = memoId;
      if (!id) {
        const title = String(newTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '새 일정';
        id = app.vault.import({ body: typeof body === 'string' && /^# \S/.test(body) ? body.slice(0, 20000) : `# ${title}\n` });
      }
      const memo = id ? app.vault.get(id) : null;
      if (!memo) throw new Error('메모를 찾지 못했어요. 목록에서 다시 골라 주세요');
      app.setReminders(id, [...(memo.reminders ?? []), reminder]);
      list.refresh();
      return id;
    },
  },
  memos: { search: async (query) => app.vault?.search(String(query ?? '')) ?? [] },
  // 첨부 저장 (PC 의 attachments.save 와 같음) — 가져온 일정의 달력 그림
  attachments: { save: async (bytes, ext) => (app.vault ? app.vault.saveAttachment(bytes, ext) : null) },
  // 일정 탭이 함께 보는 다른 캘린더 — .ics 구독(이 휴대폰에만 저장) · 휴대폰 캘린더(삼성 캘린더 · Google 캘린더)
  calendars: calendarApi(),
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
      const memoId = app.vault.import({ body: `# ${e.title || e.app}\n\n${e.body ? `${e.body}\n\n` : ''}> ${e.app} 알림, ${when}` });
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
    toast('설정에서 "메모킹" 알림 접근을 켜 주세요');
    await call('historyPermission').catch(() => {});
  }
  list.refreshHistory();
  refreshHistoryRow();
  return granted;
}

// 앱 하나를 더 모으지 않기: 이미 모은 것도 지울지 묻는다
async function blockApp(appId, appName) {
  if (!(await confirmDialog(`${appName} 알림을 더 이상 보관하지 않을까요?\n알림 보관함 › 모을 앱에서 다시 켤 수 있어요.`, '보관 중지'))) return false;
  const count = history.all().entries.filter((x) => x.appId === appId && x.source !== 'memoking').length;
  const remove = count > 0 && await confirmDialog(`보관된 ${appName} 알림 ${count}개도 삭제할까요?`, '삭제', { cancelLabel: '남겨 두기' });
  const removed = history.block(appId, appName, remove);
  toast(removed ? `${appName} 알림 보관을 멈추고 ${removed}개를 삭제했어요` : `${appName} 알림을 더 이상 보관하지 않아요`);
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
    small.textContent = off ? '보관 안 함' : `알림 ${a.count}개 보관 중`;
    name.append(b, small);
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.checked = !off;
    sw.setAttribute('aria-label', `${a.app} 알림 모으기`);
    sw.addEventListener('change', async () => {
      if (sw.checked) {
        history.unblock(a.appId);
        toast(`${a.app} 알림을 다시 보관해요`);
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
  $('blocked-count').textContent = blockedCount ? `${blockedCount}개 꺼짐` : '';
  $('history-apps-2').disabled = !(enabled && granted); // 모으기가 꺼져 있으면 고를 것이 없다
  $('history-note').textContent = enabled && !granted
    ? '휴대폰 설정에서 "알림 접근"을 허용해 주세요'
    : '보관함 탭에 모아요. 이 휴대폰에만 저장해요'
}

let notifyAsked = false;
app.setReminders = (memoId, next) => {
  if (!app.vault || !memoId || !Array.isArray(next)) return null;
  note.flush(); // 아직 파일이 없는 새 메모면 먼저 저장
  const reminders = next.map((r) => normalizeReminder(r)).filter(Boolean);
  const saved = app.vault.setReminders(memoId, reminders);
  if (!saved) throw new Error('그사이 이 메모가 다른 기기에서 바뀌어 저장하지 못했어요. 다시 해 주세요');
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
// 메모 위 막대의 ← (휴대폰: 목록으로) · ≡ (태블릿: 목록을 옆에 꺼내기·넣기)
//   튜토리얼이 "목록으로 돌아가요"를 기다리는 동안은 태블릿도 메모를 닫는다 (옆에 꺼내기만 하면 다음 단계로 못 감)
app.noteBack = () => {
  if (isTwoPane() && !tutorialWaitsFor('note-closed')) panes.toggleList();
  else app.showList();
};
app.isNoteOpen = () => note.isOpen();

// 넓은 화면: 메모를 고르지 않았으면 오른쪽에 안내
function syncPane() {
  $('pane-empty').hidden = true; // v0.14.0: 메모가 없으면 목록이 화면 가득 (빈 오른쪽 안내는 쓰지 않음)
  panes.sync();
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
  // 위젯에 보일 메모를 고르는 중: 목록 카드를 누른 것만 고른 것으로, 다른 길(새 메모·알림 등)로 열면 고르기를 그만둔다
  if (options.fromList && widgets.takePick(id, { toast })) return;
  widgets.cancelPick();
  closeAllSheets();
  // 태블릿: 새로 열면 목록은 숨기고 메모를 가득
  if (isTwoPane()) panes.hideListForMemo();
  $('list-screen').hidden = false; // 메모 뒤에 목록이 있어야 닫을 때 바로 보인다
  await note.openNote(id, options);
  syncPane();
};

app.newMemo = async ({ color, voice = false, ink = false } = {}) => {
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
  await app.openMemo(id, { fresh: true, record: Boolean(voice), ink: Boolean(ink) });
  if (!voice && !ink) tutEvent('memo-created');
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
  pin.querySelector('span').textContent = memo.pinned ? '목록 고정 풀기' : '목록 맨 위에 고정';
  memoSheet.querySelector('[data-memo-action="lock"] span').textContent = memo.locked ? '잠금 풀기' : '잠그기';
  pin.querySelector('svg').replaceWith(icon(memo.pinned ? 'pin-fill' : 'pin'));
  openSheet(memoSheet);
};

swatches.addEventListener('click', (e) => {
  const s = e.target.closest('[data-color]');
  if (!s || !swatches.contains(s) || !menuFor) return; // 칩 사이 빈 곳을 눌러 바깥의 [data-color] 를 잡지 않게
  note.flush();
  if (!app.vault.setMeta(menuFor, { color: s.dataset.color })) {
    toast('색을 저장하지 못했어요 — 잠시 뒤 다시 해 주세요', true);
    return;
  }
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
      closeSheet(memoSheet);
      if (!app.vault.setMeta(id, { pinned: !memo.pinned })) toast('고정을 저장하지 못했어요 — 잠시 뒤 다시 해 주세요', true);
      else toast(memo.pinned ? '목록 고정을 풀었어요' : '목록 맨 위에 고정했어요');
      break;
    case 'share':
      closeSheet(memoSheet);
      openShare(id);
      break;
    case 'copy':
      closeSheet(memoSheet);
      native.copyText(shareText(body)); // 마크다운 원문(<br /> · \* · - [ ]) 대신 보이는 글 그대로
      toast('글을 복사했어요');
      break;
    case 'print':
      closeSheet(memoSheet);
      openPrint(id, 'print');
      break;
    case 'delete':
      closeSheet(memoSheet);
      deleteMemo(id);
      break;
    case 'versions':
      closeSheet(memoSheet);
      openVersions(id);
      break;
    case 'lock':
      closeSheet(memoSheet);
      note.flush();
      if (memo.locked) {
        if (note.currentId() !== id || memo.needsPassword) {
          toast('먼저 비밀번호로 열고, 메뉴에서 잠금을 풀어 주세요');
          app.openMemo(id);
          break;
        }
        if (!(await confirmDialog('잠금을 풀까요? 내용이 그대로 파일에 저장되고, 비밀번호 없이 열려요.', '잠금 풀기'))) break;
        if (app.vault.unlock(id)) {
          note.lockChanged(false);
          toast('잠금을 풀었어요');
        } else toast('잠금을 풀지 못했어요. 그사이 다른 기기에서 다시 잠갔을 수 있어요 — 메모를 다시 열어 주세요', true);
        break;
      }
      if (await lockDialog({
        title: memo.title,
        onLock: async (password, { hideTitle }) => {
          try {
            note.flush();
            const session = await newLockSession(password);
            // 목록에서 잠갔으면 열쇠를 들고 있지 않는다 — 바로 눌러도 비밀번호를 묻게
            if (!app.vault.lock(id, session, { keepOpen: note.currentId() === id, hideTitle })) return '잠그지 못했어요. 그사이 다른 기기에서 잠갔을 수 있어요';
            if (note.currentId() === id) note.lockChanged(true);
            return null;
          } catch (err) {
            return err.message;
          }
        },
      })) toast(note.currentId() === id ? '잠갔어요. 메모를 닫으면 다시 비밀번호로 열려요' : '잠갔어요');
      break;
    case 'widget':
      closeSheet(memoSheet);
      note.flush();
      widgets.pin(id, { toast });
      break;
    default:
  }
});

// ---------- 이전 버전 ----------

const versionsSheet = $('versions-sheet');
function openVersions(id) {
  note.flush(); // 지금 내용이 버전으로 남도록 먼저 저장
  const show = () => renderVersions($('versions-list'), app.vault.versions(id), (name) => {
    if (note.currentId() === id) note.flush();
    const restored = app.vault.restoreVersion(id, name);
    if (!restored) return toast('그 버전을 찾지 못했어요', true);
    if (restored.error) return toast(restored.error, true);
    if (note.currentId() === id) note.showRestored(restored);
    toast('되돌렸어요');
    show();
  });
  show();
  openSheet(versionsSheet);
}
$('versions-close').addEventListener('click', () => closeSheet(versionsSheet));

// ---------- 지우기: 묻지 않고 바로 휴지통으로 (애니메이션 + 되돌리기) ----------

const titleOf = (body) => (isBlankBody(body) ? '새 메모' : extractTitle(body));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 메모를 지운다. 열려 있으면 메모 화면이 휴지통으로 빨려 들어가듯, 목록이면 카드가 접히며 사라진다 */
/** @param {{ flown?: boolean }} [o] flown: 카드가 이미 밀려 날아갔다 (목록 밀어 지우기) — 따로 날리지 않는다 */
async function deleteMemo(id, { flown = false } = {}) {
  if (!app.vault?.get(id)) return;
  const inNote = note.currentId() === id;
  const body = inNote ? note.editorMarkdown() : app.vault.get(id)?.body ?? '';
  const motion = !reduceMotion();
  if (inNote) {
    note.flush();
    if (motion) {
      $('note-screen').classList.add('trashing');
      await wait(260);
    }
    note.discardAndClose();
    $('note-screen').classList.remove('trashing');
  } else if (motion && !flown) {
    list.animateRemove(id);
    // 날아가는 카드를 먼저 화면에 올린 뒤 (그다음부터는 따로 움직여 안 끊김) 무거운 일(지우기 · 다시 그리기)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  haptic(10);
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
    toast('메모를 삭제했어요');
    return;
  }
  toast(trashedText(titleOf(body)), false, {
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
  $('share-sheet-title').textContent = '공유';
  $('share-busy').hidden = true;
  for (const b of shareSheet.querySelectorAll('[data-share]')) b.disabled = false;
  openSheet(shareSheet);
}

const PDF_WAIT_MS = 30_000; // 앱 쪽은 15초 안에 못 만들면 인쇄 화면으로 넘어간다
const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
};

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
  // PDF 는 먼저 종이에 담을 내용 크기를 고른다 (미리보기와 함께)
  if (kind === 'pdf') {
    closeSheet(shareSheet);
    openPrint(id, 'share');
    return;
  }
  // 그림은 메모 화면에 그려진 모습으로 만든다 (닫혀 있으면 연다)
  for (const x of shareSheet.querySelectorAll('[data-share]')) x.disabled = true;
  $('share-busy').hidden = false;
  $('share-busy-text').textContent = '이미지를 만드는 중…';
  try {
    if (note.currentId() !== id) {
      closeSheet(shareSheet);
      await app.openMemo(id);
      openSheet(shareSheet);
    }
    note.flush();
    await note.settled();
    const base64 = await renderMemoImage(note.getEditor(), { color: app.vault.get(id)?.color });
    await call('shareFile', { base64, name: fileName(title, 'png'), mime: 'image/png', title });
    closeSheet(shareSheet);
  } catch (err) {
    console.error(err);
    toast(err.message || '공유하지 못했어요', true);
  } finally {
    $('share-busy').hidden = true;
    for (const x of shareSheet.querySelectorAll('[data-share]')) x.disabled = false;
  }
});

// ---------- PDF · 인쇄: 종이에 담을 내용 크기 ----------
//   크기를 고르면 첫 쪽 미리보기가 바로 바뀐다. 고른 크기는 다음에도 (이 휴대폰에만)
const printSheet = $('print-sheet');
const SCALE_KEY = 'memoking.printScale';
const printJob = { id: null, mode: 'share', scale: 1 };
try {
  printJob.scale = clampPrintScale(localStorage.getItem(SCALE_KEY));
} catch {
  // 기본 크기
}

function printTitle(id) {
  return titleOf(note.currentId() === id ? note.editorMarkdown() : app.vault.get(id)?.body ?? '');
}
function printDoc(id, preview = false) {
  return printHtml(note.getEditor().dom(), { title: printTitle(id), color: app.vault.get(id)?.color, scale: printJob.scale, preview });
}
let previewTimer = 0;
function drawPrintSize() {
  const pct = Math.round(printJob.scale * 100);
  $('print-scale').value = String(pct);
  $('print-scale-out').textContent = `${pct}%`;
  for (const b of printSheet.querySelectorAll('[data-scale]')) b.setAttribute('aria-checked', String(Math.abs(Number(b.dataset.scale) - printJob.scale) < 0.001));
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!printJob.id || printSheet.hidden) return;
    $('print-frame').srcdoc = printDoc(printJob.id, true);
  }, 120);
}
function fitPreview() {
  const box = $('print-preview');
  box.style.setProperty('--fit', String(box.clientWidth / 794));
}
async function openPrint(id, mode) {
  if (note.currentId() !== id) await app.openMemo(id);
  note.flush();
  await note.settled();
  printJob.id = id;
  printJob.mode = mode;
  $('print-sheet-title').textContent = mode === 'print' ? '인쇄할 크기' : 'PDF에 담을 크기';
  $('print-go').textContent = mode === 'print' ? '인쇄' : 'PDF로 공유';
  $('print-go').disabled = false;
  $('print-busy').hidden = true;
  openSheet(printSheet);
  fitPreview();
  drawPrintSize();
}
function setPrintScale(v) {
  printJob.scale = clampPrintScale(v);
  try {
    localStorage.setItem(SCALE_KEY, String(printJob.scale));
  } catch {
    // 이번만
  }
  drawPrintSize();
}
printSheet.querySelector('#print-size-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scale]');
  if (b) setPrintScale(Number(b.dataset.scale));
});
$('print-scale').addEventListener('input', (e) => setPrintScale(Number(e.target.value) / 100));
window.addEventListener('resize', () => !printSheet.hidden && fitPreview());
$('print-go').addEventListener('click', async () => {
  const id = printJob.id;
  if (!id) return;
  const title = printTitle(id);
  const html = printDoc(id);
  if (printJob.mode === 'print') {
    closeSheet(printSheet);
    call('print', { title, html }).catch((err) => toast(err.message, true));
    return;
  }
  $('print-go').disabled = true;
  $('print-busy').hidden = false;
  try {
    // 앱이 PDF 를 바로 만들지 못하면 스스로 인쇄 화면("PDF로 저장")을 연다. 그래도 답이 없으면 계속 기다리지 않는다
    await withTimeout(call('sharePdf', { title, name: fileName(title, 'pdf'), html }), PDF_WAIT_MS, 'PDF를 만들지 못했어요. 잠시 뒤 다시 해 주세요');
    closeSheet(printSheet);
  } catch (err) {
    console.error(err);
    toast(err.message || 'PDF를 만들지 못했어요', true);
  } finally {
    $('print-go').disabled = false;
    $('print-busy').hidden = true;
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

const whenLabel = recordingWhen;

// 녹음하던 잠긴 메모를 닫았을 때 들고 있는 열쇠 (memoId → 세션) — 녹음·받아쓰기를 넣을 때만 잠깐 연다
app.heldLocks = new Map();
// 열쇠는 늦어도 30분 뒤 버린다 (녹음이 버려지는 등 넣을 일이 끝내 없을 때 닫힌 잠긴 메모의 열쇠가 남지 않게)
app.holdLock = (memoId, session) => {
  app.heldLocks.set(memoId, session);
  const expire = () => {
    if (app.heldLocks.get(memoId) !== session) return;
    // 아직 녹음·받아쓰기 중이면 더 기다린다 (긴 회의 녹음이 끝났을 때 넣을 열쇠가 없어지지 않게)
    if (recorder.recordingFor() === memoId || app.transcribing?.has(memoId)) setTimeout(expire, 10 * 60_000);
    else app.heldLocks.delete(memoId);
  };
  setTimeout(expire, 30 * 60_000);
};
/** 닫힌 잠긴 메모를 잠깐 연다: 열었으면 true, 열 필요가 없으면 null, 못 열면 false */
function openHeld(memoId) {
  const memo = memoId && app.vault.get(memoId);
  if (!memo?.needsPassword) return null;
  const session = app.heldLocks.get(memoId);
  return Boolean(session && app.vault.openLock(memoId, session));
}
function closeHeld(memoId, opened) {
  // 편집기로 연 메모가 아니면 다시 잠근다 (비밀번호 화면이 떠 있는 중이어도 — 그 화면이 열쇠를 다시 받는다)
  if (opened && !(note.currentId() === memoId && note.getEditor())) app.vault.closeLock(memoId);
}

app.deliverRecording = async (r) => {
  if (!app.vault || !r?.temp) return;
  const duration = recorder.formatDuration(r.durationMs ?? 0);
  const alt = `녹음 ${whenLabel(r.startedAt)} (${duration})`;
  const [item] = note.tempsToItems([{ temp: r.temp, name: r.name || 'recording.m4a', mime: r.mime || 'audio/mp4' }]);
  item.alt = alt;
  const transcript = polish(String(r.transcript ?? '').trim());
  // 소리와 받아쓴 글을 한 칸(음성 카드)에 — 문장마다 줄, 말한 사람이 바뀌면 이름표
  const card = voiceCardMarkdown(item, transcript);
  let memoId = r.memoId;
  let lockedOut = false;
  let missing = false;
  let secretOut = false; // 잠긴 메모의 녹음을 풀린 새 메모에 넣었다
  // 편집기가 떠 있을 때만 화면에 (잠긴 메모의 비밀번호 화면이면 아직 편집기가 없다 — 파일에 넣는다)
  if (note.currentId() === memoId && note.getEditor()) {
    note.insertRecording(card, `음성 메모 ${whenLabel(r.startedAt)}`);
  } else {
    const opened = openHeld(memoId);
    const memo = memoId && app.vault.get(memoId);
    const parts = card;
    const heading = `# 음성 메모 ${whenLabel(r.startedAt)}`;
    if (memo?.needsPassword) {
      // 잠긴 메모를 열 열쇠가 없다(앱을 다시 켬 등) — 잠긴 글에 덧붙이면 저장되지 않으므로, 소리만 새 메모에 (받아쓴 글은 넣지 않음)
      lockedOut = true;
      memoId = app.vault.import({ body: `${heading}\n\n${voiceCardMarkdown(item, '')}\n` });
    } else if (memo) {
      const nextOf = (m) => (isBlankBody(m.body) ? `${heading}\n\n${parts}\n` : `${m.body.replace(/\s+$/, '')}\n\n${parts}\n`);
      let res = app.vault.save(memoId, nextOf(memo));
      if (res?.retry) {
        app.vault.scan(); // 파일이 잠깐 없었다 — 다시 읽은 글에 덧붙여 한 번 더
        const fresh = app.vault.get(memoId);
        res = fresh && !fresh.needsPassword ? app.vault.save(memoId, nextOf(fresh)) : { refused: true, gone: !fresh };
      }
      if (res?.retry || res?.gone) {
        // 다시 읽어도 메모 파일이 없다 — 녹음을 잃지 않게 새 메모에 (잠긴 메모였으면 받아쓴 글은 넣지 않음)
        missing = true;
        secretOut = memo.locked;
        memoId = app.vault.import({ body: `${heading}\n\n${memo.locked ? voiceCardMarkdown(item, '') : parts}\n` });
      } else if (res?.refused && !res.copied) {
        // 그사이 다른 기기가 다시 잠가 넣지 못했다 — 소리만 새 메모에 (받아쓴 글은 잠긴 글이었을 수 있어 넣지 않음)
        lockedOut = true;
        memoId = app.vault.import({ body: `${heading}\n\n${voiceCardMarkdown(item, '')}\n` });
      }
    } else memoId = app.vault.import({ body: `${heading}\n\n${parts}\n` });
    closeHeld(r.memoId, opened);
    list.refresh();
  }
  if (lockedOut) toast(`잠긴 메모를 열 수 없어 녹음(${duration})은 새 메모에 저장했어요`, true);
  else if (missing) toast(`원래 메모에 넣지 못해 녹음(${duration})은 새 메모에 저장했어요`, true);
  else toast(transcript ? `녹음(${duration})과 받아쓴 내용을 저장했어요` : `녹음(${duration})을 저장했어요`);
  // 잠긴 메모의 녹음을 (파일이 없어) 풀린 새 메모에 넣었으면 나중에 받아쓴 글도 넣지 않는다
  const transcribeLater = !lockedOut && !secretOut && r.sttPending && recorder.sttOn() && recorder.sttReady();
  if (!transcribeLater || memoId !== r.memoId) app.heldLocks.delete(r.memoId); // 받아쓸 곳이 다른 메모면 원래 메모의 열쇠는 지금 거둔다
  // 녹음 중에 받아쓰지 못했으면(음성 인식이 잠깐 안 됐음) 이제 녹음 파일로
  if (transcribeLater) transcribeInto(memoId, [item]); // 끝나면 transcribeInto 가 열쇠를 거둔다
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
    ? '알림이 오지 않으면 허용해 주세요'
    : '정확한 시각에 받으려면 "알람 및 리마인더" 권한이 필요해요';
  $('notify-btn').textContent = exact ? '허용' : '설정 열기';
  $('notify-btn').onclick = () => (exact ? call('notifyPermission').then((ok) => toast(ok ? '알림을 허용했어요' : '휴대폰 설정에서 메모킹 알림을 켜 주세요', !ok)) : call('exactAlarmSettings'));
}

function openSettings() {
  const info = native.info();
  $('vault-path').textContent = info.vault?.label || '(없음)';
  $('use-internal-2').hidden = Boolean(info.vault?.internal);
  $('change-vault').textContent = info.vault?.drive ? '휴대폰 폴더 선택' : '위치 변경';
  $('vault-hint').hidden = Boolean(info.vault?.drive);
  $('trash-days').value = String(trashDays());
  $('version').textContent = `메모킹 ${info.version}`;
  refreshUpdateRow(info.version);
  const n = app.vault?.trashList().length ?? 0;
  $('trash-count').textContent = n ? String(n) : '';
  refreshNotifyRow();
  refreshHistoryRow();
  renderDrive();
  $('auto-tags').checked = note.autoTagsOn();
  $('link-previews').checked = note.linkPreviewsOn();
  $('pen-writing').checked = note.penWriting() !== 'off';
  $('rec-stt').checked = recorder.sttOn();
  $('rec-stt-note').textContent = recorder.sttReady()
    ? '말하는 내용을 휴대폰의 Google 음성 인식으로 바로 글로 받아써요'
    : '이 휴대폰은 Google 음성 인식(안드로이드 13 이상)을 쓸 수 없어 녹음만 해요';
  $('rec-stt').disabled = !recorder.sttReady();
  refreshSpeakerRow();
  openSheet($('settings-sheet'));
}

// 말한 사람 나누기: 다른 켜고 끄기와 같은 스위치 (PC 설정과 같음). 데이터(약 28MB)가 없으면 켤 때 받고, 받는 동안은 켜진 채 잠금
function refreshSpeakerRow(progress) {
  const st = recorder.sttStatus();
  $('spk-row').hidden = !recorder.sttReady() || st.speakerSupported === false;
  const busy = progress != null || st.speaker === 'downloading';
  const ready = st.speaker === 'ready';
  $('spk-note').textContent = busy
    ? `데이터를 받는 중… ${progress ?? 0}%`
    : `녹음이 끝난 뒤 "화자 1:" 처럼 이름표를 붙여요${ready ? '' : ` (켜면 데이터 ${(st.speakerSize ?? '약 28MB').replace('약 ', '')}를 받아요)`}`;
  $('spk-switch').checked = busy || (ready && st.speakerOn);
  $('spk-switch').disabled = busy;
}
$('spk-switch').addEventListener('change', async () => {
  const on = $('spk-switch').checked;
  const st = recorder.sttStatus();
  try {
    if (st.speaker === 'ready') await call('speakerModel', { on });
    else if (on) {
      refreshSpeakerRow(0);
      await call('speakerModel', {});
      toast('말한 사람 나누기를 켰어요. 다음 녹음부터 붙어요');
    }
  } catch (err) {
    toast(err.message || '받지 못했어요. 인터넷 연결을 확인해 주세요', true);
  }
  refreshSpeakerRow();
});
on('speakerModel', ({ progress }) => {
  if (!$('settings-sheet').hidden) refreshSpeakerRow(progress < 100 ? progress : undefined);
});

$('auto-tags').addEventListener('change', () => note.setAutoTags($('auto-tags').checked));
$('link-previews').addEventListener('change', () => note.setLinkPreviews($('link-previews').checked));
$('pen-writing').addEventListener('change', () => note.setPenWriting($('pen-writing').checked ? 'edit' : 'off'));
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
  else if (error === '') toast('저장 위치를 바꿨어요');
});
$('use-internal-2').addEventListener('click', async () => {
  // 지금 폴더의 메모는 옮겨지지 않아 목록에서 사라져 보인다 — 지워진 줄 알지 않게 미리 알린다
  const ok = await confirmDialog('저장 위치를 이 휴대폰으로 바꿀까요?\n지금 폴더의 메모는 옮겨지지 않아요. 바꾸면 목록에는 이 휴대폰에 새로 쓴 메모만 보여요.', '위치 바꾸기', { danger: false });
  if (!ok) return;
  note.flush();
  native.useInternalVault();
  openVault();
  toast('이 휴대폰에 저장해요');
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
    sub.textContent = [`${daysAgoText(t.deletedAt)} 지움`, t.attachments ? `첨부 ${t.attachments}개` : ''].filter(Boolean).join(', ');
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
$('tutorial-btn').addEventListener('click', () => {
  closeAllSheets();
  if (note.isOpen()) app.showList();
  setTimeout(startTutorial, 250);
});
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
  return `> 출처: ${esc(appName || '공유하기')}, ${when}`;
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
  const canStt = recorder.sttReady(); // 휴대폰의 Google 음성 인식 (안드로이드 13+)
  let last = true;
  try {
    last = localStorage.getItem(IMPORT_STT_KEY) !== 'off';
  } catch {
    // 기본은 받아쓰기
  }
  $('import-stt').checked = canStt && last;
  $('import-stt').disabled = !canStt;
  $('import-stt-note').textContent = canStt
    ? '소리 내용을 Google 음성 인식으로 글로 옮겨 메모에 함께 넣어요 (길면 시간이 걸려요)'
    : '이 휴대폰은 Google 음성 인식(안드로이드 13 이상)을 쓸 수 없어 소리 파일만 넣어요';
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
// 받아쓰는 중인 메모 (그사이 잠긴 메모를 닫아도 열쇠를 들고 있다가 넣게)
app.transcribing = new Map(); // memoId → 진행 중인 수
async function transcribeInto(memoId, items) {
  app.transcribing.set(memoId, (app.transcribing.get(memoId) ?? 0) + 1);
  try {
    await transcribeEach(memoId, items);
  } finally {
    const n = (app.transcribing.get(memoId) ?? 1) - 1;
    if (n > 0) app.transcribing.set(memoId, n);
    else {
      app.transcribing.delete(memoId);
      app.heldLocks.delete(memoId);
    }
  }
}
async function transcribeEach(memoId, items) {
  for (const item of items) {
    try {
      toast('받아쓰는 중…');
      const res = await call('transcribe', { rel: item.src, terms: app.sttTerms() });
      const text = polish(String(res?.text ?? '').trim());
      if (!text) {
        toast('인식된 말소리가 없어요');
        continue;
      }
      // 그 소리 줄에 붙여 음성 카드로 (소리 줄을 못 찾으면 메모 끝에)
      if (note.currentId() === memoId && note.getEditor()) {
        if (!note.attachTranscript(item.src, text)) note.appendText(importText(text).markdown);
      } else {
        const opened = openHeld(memoId);
        const memo = app.vault.get(memoId);
        if (memo?.needsPassword) {
          closeHeld(memoId, opened);
          toast('잠긴 메모라 받아쓴 내용을 넣지 못했어요. 메모를 열고 다시 받아써 주세요', true);
          continue;
        }
        const next = memo && attachTranscript(memo.body, item.src, text);
        if (next) app.vault.save(memoId, next);
        else if (memo) app.vault.save(memoId, `${memo.body.replace(/\s+$/, '')}\n\n${importText(text).markdown}\n`);
        closeHeld(memoId, opened);
      }
      toast('받아쓴 내용을 추가했어요');
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
      else if (!text && !docTexts.length && files.length) editor.setMarkdown(`# ${esc(sharedFilesTitle(files, audio.length, payload.app))}\n`);
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
      // 태그를 저절로: 그림만 받았으면 화면 캡처, 주소 하나면 링크, 소리면 음성, 그 밖은 공유
      const onlyImages = !text && !docTexts.length && files.length > 0 && files.every((f) => mediaKind({ name: f.name || '', type: f.mime || '' }) === 'image');
      const source = onlyImages ? 'capture' : url ? 'link' : audio.length ? 'audio' : 'share';
      const tags = note.autoTagIncoming(source);
      note.flush();
      document.activeElement?.blur(); // 키보드는 올리지 않는다 (이어 쓰려면 누르기)
      toast(tags.length ? `메모를 만들었어요, ${tags.map((t) => `#${t}`).join(' ')}` : '메모를 만들었어요');
    },
  });
  if (stt && audioItems.length && recorder.sttReady()) transcribeInto(id, audioItems);
}

// 글 없이 파일만 받았을 때의 제목: 파일 이름(Screenshot_2026….png) 대신 사람이 읽는 이름 — 음성 메모와 같은 모양
//   화면 캡처 · 10월 5일 오전 8:34 / 사진 3장 · … / 음성 메모 · … / 파일 하나는 그 이름 (보고서.pdf)
const SCREENSHOT = /screen ?shot|screencap|스크린샷|화면 ?캡처|캡처/i;
function sharedFilesTitle(files, audioCount, fromApp = '') {
  const when = whenLabel(Date.now());
  if (audioCount === files.length) return `음성 메모 ${when}`;
  const images = files.filter((f) => mediaKind({ name: f.name || '', type: f.mime || '' }) === 'image');
  if (images.length === files.length) {
    if (files.some((f) => SCREENSHOT.test(f.name || '')) || SCREENSHOT.test(fromApp)) return `화면 캡처 ${when}`;
    return files.length === 1 ? `사진 ${when}` : `사진 ${files.length}장 ${when}`;
  }
  return files.length === 1 ? files[0].name : `파일 ${files.length}개 ${when}`;
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
    app.newMemo({ voice: payload.voice === true });
  } else if (payload.type === 'widget-pick') {
    widgets.startPick(payload.widgetId, { toast });
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
    haptic(8);
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
fab.addEventListener('click', () => {
  // 일정 탭: 바로 새 일정 (메모 종류를 고르는 위성 버튼 없이)
  if (!$('list-screen').hidden && list.currentTab() === 'reminders') {
    haptic(8);
    list.addEvent();
    return;
  }
  setFabMenu(fabMenu.hidden);
});
$('fab-scrim').addEventListener('click', () => setFabMenu(false));
fabMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-new]');
  if (!b) return;
  setFabMenu(false);
  app.newMemo({ voice: b.dataset.new === 'voice', ink: b.dataset.new === 'ink' });
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
    widgets.publishSoon();
    // 이어 쓰기 안내는 다른 기기에서 내용이 바뀌어 들어온 것만 (휴대폰에서 고정·색·알림을 바꾼 것으로 뜨지 않게)
    showHandoff((detail.external ?? []).filter((id) => !detail.removed?.includes(id)));
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
  setTimeout(maybeStartTutorial, 700); // 처음이면 사용법 둘러보기 (메모 폴더를 연 뒤 한 번)
  if (app.vaultInfo?.drive) drive.syncSoon();
  recorder.resume(); // 녹음이 도는 중인지, 꺼져 있는 동안 끝난 녹음이 있는지
  widgets.publishSoon(0); // 앱이 꺼져 있는 동안 바뀐 메모(동기화 등)를 위젯에도
  // 켜기 전에 PC 에서 방금 고친 메모가 있으면 (가장 최근 하나)
  if (!pendingIntent) showHandoff(recentlyUpdated(vault.list()).map((m) => m.id));
  if (pendingIntent) {
    const p = pendingIntent;
    pendingIntent = null;
    if (p.type === 'open') app.openMemo(p.memoId, { alarm: p.label ? { label: p.label } : undefined, highlight: true });
    else if (p.type === 'new') app.newMemo({ voice: p.voice === true });
    else if (p.type === 'widget-pick') widgets.startPick(p.widgetId, { toast });
    else if (p.type === 'share') memoFromShare(p);
  }
}

// ---------- 이어 쓰기: PC·AI 비서에서 방금 고친 메모 → "PC에서 방금 고친 메모: 장보기 [열기]" ----------
const handoffSeen = new Set();
// 규칙(지금 보고 있는 메모는 본 것으로, 처음 하나만)은 core/handoff.js 의 pickHandoff — PC 와 같음
function showHandoff(ids) {
  const hit = pickHandoff(ids.map((id) => app.vault?.get(id)), { mine: 'phone', seen: handoffSeen, isOpen: (id) => note.currentId() === id });
  if (hit) toast(handoffText(hit.from, hit.memo.title), false, { label: '열기', run: () => app.openMemo(hit.memo.id) });
}

// ---------- 앱의 소식 ----------

on('intent', handleIntent);
on('widget', () => app.vault?.scan()); // 위젯에서 할 일을 체크함 → 파일을 다시 읽는다
on('history', () => list.refreshHistory());
// Google Drive 동기화 소식: 내려받은 게 있으면 메모 폴더를 바로 다시 읽는다
on('sync', (st) => {
  renderDrive();
  if (st.changed) app.vault?.scan();
  if (st.conflicts?.length) toast(`두 기기에서 동시에 고친 메모 ${st.conflicts.length}개는 사본으로 남겼어요`);
});
on('alarm', () => alarms.tick());
// S펜 버튼을 누르고 있는지 (앱이 알려 줌) → 손 메모 그리기가 지우개로 (app/js/ink-editor.js)
on('penButton', ({ down }) => window.dispatchEvent(new CustomEvent('memoking:pen-button', { detail: Boolean(down) })));
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
  if (!document.hidden) return;
  note.flush();
  widgets.cancelPick(); // 위젯 고르기 중에 앱을 떠나면 그만 (돌아와 연 메모가 위젯에 놓이지 않게)
});

// 뒤로 가기: 확인 창 → 열린 창(다른 캘린더 · 일정 만들기 등) → 색판 → 시트 → 메모 → 목록의 검색·필터 → (앱이 뒤로)
setBackHandler(() => {
  if (closeConfirm()) return true;
  if (cancelTopDialog()) return true;
  if (note.closePalette()) return true;
  if (note.closeStyleMenu()) return true;
  if (note.closeInk()) return true;
  if (note.closeAddMenu()) return true;
  if (setFabMenu(false)) return true;
  if (sheetOpen()) return closeTopSheet();
  if (panes.back()) return true; // 태블릿: 옆에 꺼낸 목록부터 넣기
  if (note.isOpen()) {
    app.showList();
    return true;
  }
  if (!$('list-screen').hidden) return list.back();
  return false;
});

// ---------- 시작 ----------

list.setup();
panes.setupPanes({ note });
setupTutorial({
  screen: () => (note.isOpen() ? 'note' : 'list'),
  markdown: () => (note.isOpen() ? note.editorMarkdown() : ''),
  append: (md) => note.appendText(md),
  edit: () => note.useEditMode(),
});
const info = native.info();
if (info.vault?.ok) openVault();
else showSetup(info.vault ? '메모 폴더에 더 이상 접근할 수 없어요. 폴더를 다시 골라 주세요.' : '');
native.ready();
// 앱 안 업데이트: 설정의 줄을 맡기고, 켠 뒤 조금 있다 조용히 새 버전 확인 (목록이 먼저 뜨게. 새 버전이 있을 때만 시트가 뜬다)
setupUpdates({ currentVersion: info.version });
setTimeout(() => checkForUpdate({ silent: true }), 4000);
// 지난번에 앱이 멈췄거나 위젯에서 오류가 났으면: 알리고 그 내용을 복사해 보낼 수 있게 (휴대폰에서만 나는 오류를 고치려고)
try {
  const lastError = native.lastError();
  if (lastError) {
    setTimeout(() => toast('지난번에 메모킹에 오류가 있었어요', true, {
      label: '내용 복사',
      run: () => {
        native.copyText(lastError);
        toast('오류 내용을 복사했어요. 개발자에게 붙여 넣어 보내 주세요');
      },
    }), 800);
  }
} catch (err) {
  console.warn('오류 기록', err);
}
await handleIntent();
// 업데이트로 Drive 연결 방식이 바뀐 경우: 한 번 알려 주고, 누르면 바로 다시 연결 (메모는 그대로)
try {
  const ds = drive.status();
  if (ds.reconnect && !ds.connected && app.vault) {
    toast('Google Drive 동기화를 다시 켜 주세요 (메모는 그대로예요)', false, { label: '연결', run: () => startConnect(() => openVault()) });
  }
} catch {
  // 미리보기 등
}
document.documentElement.dataset.ready = 'true';

// 고르기 칸(role=radiogroup): 칸마다 radio, 화살표로 고르기 (dom.js)
radioGroups();
