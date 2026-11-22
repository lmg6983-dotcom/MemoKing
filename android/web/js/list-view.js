// 메모 목록 화면 — 카드(실제 메모 색) · 검색 · 태그 줄 · 필터 · 알림 예약 탭
import { icon } from '../../app/js/icons.js';
import { formatStamp, friendlyTime, shortUrls } from '../../app/js/core/format.js';
import { vaultUrl } from '../../app/js/media.js';
import { videoThumb } from '../../app/js/video-poster.js';
import { setupRemindersTab } from '../../app/js/list-reminders.js';
import { setupHistoryTab } from '../../app/js/list-history.js';
import { collectTags, filterMemos, parseQuery, KIND_FILTERS, sameTag, titleTagsOnly } from '../../app/js/core/tags.js';
import { COLORS, COLOR_NAMES } from '../../app/js/core/memo-file.js';
import { app } from './state.js';
import { isAllClear } from '../../app/js/core/tasks.js';
import { matchChrome, confirmDialog, isTwoPane, toast, copiedToast, adoptSheet, releaseSheet } from './ui.js';
import { call } from './native.js';
import { renderCollage, collageName } from '../../app/js/memories-collage.js';
import { base64Bytes, collageMemoBody } from '../../app/js/collage-preview.js';
import { tutEvent, tutorialStepId } from './tutorial.js';
import { haptic, reduceMotion, tabKeys, syncTabStops, stackCards, withViewTransition, setModeSwitch, EASE_OUT, slideSide } from '../../app/js/dom.js';
import { hintOnce, closeHint } from '../../app/js/hints.js';
import { SORTS, DEFAULT_SORT, sortMemos, validSort, sortLabel } from '../../app/js/core/memo-sort.js';
import { MODE_KEY, MODE_LABEL, validMode, splitByMode, memoMode, otherMode, fillModeTag } from '../../app/js/core/modes.js';
import { modeClock } from '../../app/js/core/work-hours.js';
import { openModeHelper } from '../../app/js/mode-helper-dialog.js';
import { workHours, onWorkHours } from './work-mode.js';
import { UI } from '../../app/js/core/ui-text.js';
import { pickFolder, createPickBar, askFolderName, renderFolderList, markCurrentFolder, pinItem } from '../../app/js/folder-ui.js';
import { isSecretFolder, secretFolderId, SECRET_FOLDER } from './vault-secret.js';
import { askSecretPassword, askNewSecretPassword } from '../../app/js/secret-ui.js';
import { isSecretId } from '../../app/js/core/secret-folders.js';
import { openContextMenu } from '../../app/js/ctx-menu.js';
import { folderList, movedText, isFolderName, UNFILED, UNFILED_LABEL, memosInFolder, withUnfiled } from '../../app/js/core/folders.js';

const $ = (x) => document.getElementById(x);
const el = {
  screen: $('list-screen'),
  search: $('search'),
  cards: $('cards'),
  empty: $('empty'),
  folderSide: $('folder-side'),
  folderBtn: $('folder-btn'),
  filterBtn: $('filter-btn'),
  filterCount: $('filter-count'),
  filterPanel: $('filter-panel'),
  colorFilter: $('color-filter'),
  kindFilter: $('kind-filter'),
  tagFilter: $('tag-filter'),
  filterSummary: $('filter-summary'),
  filterSummaryText: $('filter-summary-text'),
  sortGroup: $('sort-group'),
  layoutGroup: $('layout-group'),
};

let layout = 'grid';
let sort = 'updated'; // 목록 정렬 (아래 "정렬")
try {
  sort = validSort(localStorage.getItem('memoking.sort'));
} catch {
  // 기본
}
let viewCounts = {}; // 메모 id → 이 휴대폰에서 연 횟수
try {
  viewCounts = JSON.parse(localStorage.getItem('memoking.views') ?? '{}') ?? {};
} catch {
  viewCounts = {};
}
const withViews = (memos) => (sort === 'views' ? memos.map((m) => ({ ...m, views: viewCounts[m.id] ?? 0 })) : memos);
/** 메모를 열었다 (많이 본 순 정렬) */
export function countView(id) {
  viewCounts[id] = (viewCounts[id] ?? 0) + 1;
  try {
    localStorage.setItem('memoking.views', JSON.stringify(viewCounts));
  } catch {
    // 이번 실행 동안만
  }
}
const state = {
  memos: [],
  results: null, // 글자 검색 결과 (없으면 전체)
  query: '',
  queryTags: [],
  filter: { tags: [], colors: [], kinds: [] },
  tab: 'memos',
  mode: 'life', // 메모킹 Work / Life — 이 휴대폰에서 고른 것 (메모 파일에는 메모마다 mode)
  workLife: null, // 설정 › Work / Life 나누기 (null: 정한 적 없음 — 처음 목록을 읽을 때 Work 메모가 있으면 켬)
  folder: '', // 보고 있는 메모킹 폴더 ("" = 전체, core/folders.js) — 이 휴대폰에 기억
  folderDirs: null, // 메모 폴더 맨 위의 하위 폴더 (빈 폴더도) — 앱에 묻는 일이라 기억해 두고 필요할 때만 다시 (loadFolderDirs)
  pinnedFolders: [], // 상단 고정한 폴더 (_memoking/pinned-folders.json, loadFolderDirs)
  picking: false, // 여러 장 고르기 (메모 메뉴 › 여러 개 고르기) — 카드를 누르면 열지 않고 고른다
  picked: new Set(),
};
try {
  state.folder = localStorage.getItem('memoking.folder') ?? '';
} catch {
  // 전체
}
/** 보고 있는 폴더 — 새 메모는 이 폴더에 (app.newMemo) */
export const currentFolder = () => (state.folder === UNFILED ? '' : state.folder); // 새 메모를 넣을 폴더 (미분류에서는 폴더 없이)
const inFolder = (memos) => memosInFolder(memos, state.folder);
const WORK_LIFE_KEY = 'memoking.workLife';
try {
  state.mode = validMode(localStorage.getItem(MODE_KEY));
  const v = localStorage.getItem(WORK_LIFE_KEY);
  state.workLife = v === '1' ? true : v === '0' ? false : null;
} catch {
  // Life
}
if (!state.workLife) state.mode = 'life';
export const workLifeOn = () => state.workLife === true;

/** 지금 모드의 메모 (Work / Life 를 나눠 쓰지 않으면 모두) */
function split(memos, mode) {
  return workLifeOn() ? splitByMode(memos, mode) : { mine: memos ?? [], other: 0 };
}
const modeMemos = () => split(state.memos, state.mode).mine;

/** 설정 › Work / Life 나누기 켜고 끄기 (끄면 Life · 모든 메모가 한 목록 · 밝기는 시스템 설정) */
export function setWorkLife(on) {
  state.workLife = Boolean(on);
  try {
    localStorage.setItem(WORK_LIFE_KEY, on ? '1' : '0');
  } catch {
    // 이번 실행 동안만
  }
  if (!on) setMode('life');
  withViewTransition(() => {
    showMode({ later: true });
    render();
    remindersTab?.modeChanged();
  }).then(syncSwitch);
  if (on) workClock();
  app.rescheduleAlarms?.(); // 퇴근 뒤 조용히가 켜지거나 꺼진다
}

/** 튜토리얼 뒷정리 (tutorial.js): 시작할 때 모습을 적어 두고, 끝나면 연습으로 바꾼 카드 모양 · 태그 고르기 · 모드 · Work/Life 켜기를 처음대로 */
export const tutorialSnapshot = () => ({ layout, tags: [...state.filter.tags], mode: state.mode, panel: !el.filterPanel.hidden, workLife: workLifeOn() });
export function tutorialRestore(b) {
  if (!b) return;
  if (layout !== b.layout) {
    layout = b.layout;
    applyLayout(layout);
    try {
      localStorage.setItem('memoking.layout', layout);
    } catch {
      // 무시
    }
  }
  state.filter.tags = b.tags;
  if (workLifeOn() !== b.workLife) setWorkLife(b.workLife);
  if (state.mode !== b.mode) setMode(b.mode);
  if (!b.panel && !el.filterPanel.hidden) toggleFilterPanel(false); // "보기"를 열어 보라고 했던 칸도 닫는다
  render();
}

// 해 · 달 스위치 (화면 전환 속에서 바꿀 때는 전환이 끝난 뒤에 — dom.js setModeSwitch)
const syncSwitch = () => setModeSwitch($('mode-switch'), state.mode);
/** @param {{ later?: boolean }} [o] later: 스위치는 부른 쪽이 나중에 (syncSwitch) */
function showMode({ later = false } = {}) {
  if (!later) syncSwitch();
  document.documentElement.dataset.mode = state.mode;
  $('mode-switch').hidden = !workLifeOn();
  if (app.vault) app.vault.defaultMode = state.mode; // 새 메모도 이 모드로
  for (const b of document.querySelectorAll('#mode-switch [data-mode]')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
    b.tabIndex = b.dataset.mode === state.mode ? 0 : -1;
  }
}

let tutModeStep = null; // 튜토리얼: Work 로 바꾼 단계
export function setMode(mode) {
  mode = validMode(mode);
  if (mode === state.mode || (mode === 'work' && !workLifeOn())) return; // 나눠 쓰지 않으면 늘 Life
  state.mode = mode;
  // 튜토리얼 "Work 로 바꿔 보고 다시 Life 로": 이 단계에서 Work 에 다녀오면 해 낸 것
  if (mode === 'work') tutModeStep = tutorialStepId();
  else if (tutModeStep && tutModeStep === tutorialStepId()) tutEvent('mode-switched');
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // 이번 실행 동안만
  }
  haptic(8);
  withViewTransition(() => {
    showMode({ later: true });
    state.filter.tags = [];
    render();
    remindersTab?.modeChanged();
  }).then(syncSwitch);
  if (mode === 'work' && workLifeOn()) hintOnce('mode-work', 'Work에서는 일할 때 쓰는 메모와 일정만 보여요. 새 메모도 Work로 들어가요. 메모를 꾹 눌러 "Work로 옮기기"나 설정의 정리 도우미로 옮길 수 있어요', { anchor: $('mode-switch') });
}
for (const b of document.querySelectorAll('#mode-switch [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));

// 업무 시간이 시작되면 Work, 끝나면 Life (설정 › Work / Life에서 켰을 때 · 경계를 넘을 때만)
const workClock = modeClock({ getHours: () => (workLifeOn() ? workHours() : null), onChange: (mode) => setMode(mode) });
setInterval(() => workClock(), 30_000);
document.addEventListener('visibilitychange', () => !document.hidden && workClock());
onWorkHours(() => {
  workClock();
  app.rescheduleAlarms?.(); // 조용히 둘 알림이 바뀐다
});

/** 정리 도우미: Life 메모 중 일 이야기 같은 것을 골라 Work로 */
export async function openHelper() {
  const n = await openModeHelper({
    memos: state.memos,
    move: (ids) => ids.filter((id) => app.vault?.setMeta(id, { mode: 'work' })).length,
  });
  if (n) toast(`메모 ${n}개를 Work로 옮겼어요`);
}
$('other-mode').addEventListener('click', () => setMode(otherMode(state.mode)));
showMode();

let remindersTab = null;
let historyTab = null;

// ---------- 카드 ----------

function badge(name, text, extra = '') {
  const span = document.createElement('span');
  span.className = `card-badge ${extra}`;
  span.append(icon(name));
  if (text !== '') span.append(String(text));
  return span;
}

function renderCard(memo) {
  const li = document.createElement('div');
  li.className = 'item';
  li.setAttribute('role', 'listitem');
  const card = document.createElement('button');
  card.className = 'card';
  card.dataset.id = memo.id;
  if (state.picking) {
    card.classList.toggle('picked', state.picked.has(memo.id));
    card.setAttribute('aria-pressed', String(state.picked.has(memo.id)));
  }
  card.dataset.color = memo.color;

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = memo.title;
  head.append(title);
  card.append(head);

  if (memo.preview) {
    const preview = document.createElement('div');
    preview.className = 'card-preview';
    // 태그는 아래 줄에 따로 보이므로 미리 보기 글에서는 뺀다
    const tagSet = new Set((memo.tags ?? []).map((t) => t.toLocaleLowerCase('ko')));
    preview.textContent = shortUrls(memo.preview).replace(/(^|\s)#([^\s#]+)/g, (m, sp, t) => (tagSet.has(t.toLocaleLowerCase('ko')) ? sp : m)).replace(/\s{2,}/g, ' ').trim();
    if (preview.textContent) card.append(preview);
  }
  if (memo.thumb) {
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = vaultUrl(memo.thumb);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async'; // 큰 사진을 푸는 동안 스크롤이 멈추지 않게
    img.draggable = false;
    img.onerror = () => img.remove();
    card.append(img);
  } else if (memo.video) card.append(videoThumb(memo.video)); // 사진이 없고 동영상이 있으면 첫 장면 + ▶

  // 체크리스트를 모두 끝낸 메모: CLEAR 도장 (데스크탑과 같은 모양)
  if (isAllClear(memo.tasks)) {
    const clear = document.createElement('span');
    clear.className = 'card-clear';
    clear.textContent = 'CLEAR';
    clear.setAttribute('aria-label', `체크리스트 ${memo.tasks.total}개를 모두 끝냈어요`);
    card.classList.add('all-clear');
    card.append(clear);
  }

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const tags = document.createElement('div');
  tags.className = 'card-tags';
  if (workLifeOn()) tags.append(fillModeTag(document.createElement('span'), memo, true), ' ');
  // 폴더 이름: 전체 · 검색에서만 (폴더 안에서는 다 같으니 빼서 조용하게)
  if (memo.folder && (!state.folder || state.query)) {
    const f = document.createElement('span');
    f.className = 'card-folder';
    f.append(icon('folder'), Object.assign(document.createElement('span'), { textContent: memo.folder })); // 이름은 따로 — 길면 … 로 (태그 자리를 남기게)
    tags.append(f, ' ');
  }
  // 태그: 누르면 그 태그의 메모만 (PC 카드와 같음)
  // 첫 줄이 태그뿐인 메모: 제목에 이미 보이는 태그는 아래 줄에서 뺀다 (#내일할일 이 두 번 보이던 것)
  const inTitle = titleTagsOnly(memo.title) ? new Set(String(memo.title).match(/#[^\s#]+/g).map((t) => t.slice(1).toLocaleLowerCase('ko'))) : null;
  for (const name of memo.tags ?? []) {
    if (inTitle?.has(name.toLocaleLowerCase('ko'))) continue;
    const t = document.createElement('span');
    t.className = 'card-tag';
    t.dataset.cardTag = name;
    t.textContent = `#${name}`;
    tags.append(t, ' ');
  }
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  if (memo.reminderCount) {
    const bell = badge('bell', memo.reminderCount);
    bell.setAttribute('role', 'img');
    bell.setAttribute('aria-label', `알림 ${memo.reminderCount}개`);
    meta.append(bell);
  }
  if (memo.hasAudio) meta.append(badge('audio', ''));
  if (memo.hasVideo) meta.append(badge('video', ''));
  if (memo.hasFile) meta.append(badge('clip', ''));
  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = friendlyTime(memo.updated);
  time.title = formatStamp(memo.updated);
  meta.append(time);
  foot.append(tags, meta);
  card.append(foot);

  li.append(card);
  return li;
}

// 메모지처럼 엇갈려 쌓기: 카드마다 지금 가장 짧은 줄(같으면 왼쪽)에 붙인다
let lastCols = 0;
function columnsFor(width) {
  if (layout === 'rows') return 1;
  return width >= 900 ? 4 : width >= 600 ? 3 : width >= 300 ? 2 : 1; // 폴더 목록 옆 좁은 자리(휴대폰)는 한 줄
}

// 지금 목록에 쌓인 메모 (빠진 것만 있으면 그 카드만 들어낸다 — 아래 layoutCards)
let shownIds = [];
let shownPinned = 0;
function layoutCards(memos) {
  const cols = columnsFor(el.cards.clientWidth || window.innerWidth);
  // 메모 몇 개만 빠졌고(지우기 · 다른 폴더로 옮기기) 나머지 카드가 그대로면 그 카드만 들어낸다 —
  //   모든 카드를 다시 쌓으면 메모가 많을 때 화면 모양을 통째로 다시 계산해, 밀어 지운 뒤 화면이 잠깐 멈췄다.
  //   남은 카드는 제 줄에서 위로 미끄러진다 (glideCards). 줄 길이가 조금 어긋나는 것은 다음에 다시 쌓을 때 맞춘다
  const ids = memos.map((m) => m.id);
  const pinnedCount = memos.filter((m) => m.pinned).length;
  // 상단 고정 수가 그대로고 일반 메모가 남을 때만 (일반 메모가 다 빠지면 "메모" 이름 줄도 없애야 해서 다시 쌓는다)
  if (cols === lastCols && pinnedCount === shownPinned && (pinnedCount === 0 || ids.length > pinnedCount) && shownIds.length > ids.length && el.cards.querySelector('.item')) {
    const keep = new Set(ids);
    const gone = shownIds.filter((id) => !keep.has(id));
    const same = gone.length === shownIds.length - ids.length && shownIds.filter((id) => keep.has(id)).every((id, i) => id === ids[i])
      && memos.every((m) => cardCache.get(m.id)?.key === cardKey(m) && cardCache.get(m.id).li.isConnected);
    if (same) {
      for (const id of gone) cardCache.get(id)?.li.remove();
      for (const m of memos) cardFor(m); // 남은 카드의 밀다 만 자리 · 표시를 정리 (그대로인 카드라 새로 만들지 않는다)
      shownIds = ids;
      return;
    }
  }
  shownIds = ids;
  shownPinned = pinnedCount;
  lastCols = cols;
  const columns = Array.from({ length: cols }, () => {
    const c = document.createElement('div');
    c.className = 'col';
    return c;
  });
  // 다시 쌓는 동안 보던 자리(스크롤)를 지킨다: 목록이 잠깐 비면 브라우저가 스크롤을 맨 위로 당겨, 메모를 지우거나 고친 뒤 맨 위로 튀었다
  //   — 쌓는 동안은 옛 높이를 붙들고, 다 쌓은 뒤 보던 자리로 돌린다
  const scroller = el.cards.closest('.view');
  const top = scroller?.scrollTop ?? 0;
  const had = Boolean(el.cards.querySelector('.item'));
  if (had) el.cards.style.minHeight = `${el.cards.offsetHeight}px`;
  // 상단 고정한 메모가 있으면 "상단 고정" 묶음 · 선 · "메모" 묶음으로 (PC list.js 와 같음)
  const pinned = memos.filter((m) => m.pinned);
  const rest = pinned.length ? memos.filter((m) => !m.pinned) : memos;
  const pinCols = pinned.length ? columns.map(() => Object.assign(document.createElement('div'), { className: 'col' })) : [];
  const sep = (text) => Object.assign(document.createElement('div'), { className: 'card-sep', role: 'separator', textContent: text });
  el.cards.classList.toggle('sectioned', pinned.length > 0);
  el.cards.replaceChildren(...(pinned.length ? [sep('상단 고정'), ...pinCols, ...(rest.length ? [sep('메모')] : [])] : []), ...(rest.length || !pinned.length ? columns : []));
  if (pinned.length) stackCards(pinCols, pinned.map(cardFor), { chunk: false });
  stackCards(columns, rest.map(cardFor), { chunk: !had, late: (items) => items.forEach((li) => (li.style.animation = 'none')) }); // 나눠 쌓이는 뒤쪽 카드는 튀어나오지 않게
  el.cards.style.minHeight = '';
  if (scroller && top && scroller.scrollTop !== top) scroller.scrollTop = top;
  if (cardCache.size > memos.length + 200) for (const id of cardCache.keys()) if (!memos.some((m) => m.id === id)) cardCache.delete(id);
}

// 바뀌지 않은 메모의 카드는 다시 만들지 않고 그대로 옮겨 쌓는다
//   — 지우기 · 되돌리기 · 저장 때마다 모든 카드를 새로 만들어, 남은 카드가 미끄러지는 중에 화면이 잠깐 멈췄다
const cardCache = new Map(); // 메모 id → { key, li }
// 메모 내용뿐 아니라 그릴 때 보는 것도 열쇠에: 폴더 이름을 보일지(전체 · 검색에서만) · Work/Life 표시
//   (빠뜨리면 전체에서 만든 카드가 폴더 안에서도 폴더 이름을 달고, 폴더 안에서 만든 카드는 전체에서도 이름이 없었다)
// 비밀 메모는 잠근 사진을 풀어 둔 주소까지 (뒤에서 풀리면 카드를 다시 — vault-secret.js prepareThumbs)
const cardKey = (memo) => `${JSON.stringify(memo)}${memo.secret && memo.thumb ? vaultUrl(memo.thumb) : ''}|${friendlyTime(memo.updated)}|${workLifeOn() ? 1 : 0}|${!state.folder || state.query ? 1 : 0}`;
function cardFor(memo) {
  const key = cardKey(memo);
  const hit = cardCache.get(memo.id);
  if (hit?.key === key) {
    const card = hit.li.querySelector('.card');
    card.removeAttribute('style'); // 밀다 만 자리 · 숨김(animateRemove)이 남지 않게
    card.classList.remove('swiping', 'swipe-ready', 'swipe-open', 'flying', 'lifted', 'drag-source');
    hit.li.classList.remove('mk-live');
    delete card.dataset.swiped;
    hit.li.style.animation = ''; // 다시 나타난 카드는 등장 움직임 (이미 있던 카드는 glideCards 가 끈다)
    return hit.li;
  }
  const li = renderCard(memo);
  cardCache.set(memo.id, { key, li });
  return li;
}


new ResizeObserver(() => {
  if (!el.screen.hidden && columnsFor(el.cards.clientWidth) !== lastCols) render();
}).observe(el.cards);
// 메모 칸의 보이는 높이: 왼쪽 폴더 목록이 그만큼만 차지하고 넘치면 따로 스크롤 (mobile.css --view-h)
{
  const view = el.cards.closest('.view');
  new ResizeObserver(() => view.style.setProperty('--view-h', `${view.clientHeight}px`)).observe(view);
}

// 빈 목록: 그림 + 다음에 할 일 단추 (검색·필터로 비었으면 풀기, 메모가 없으면 첫 메모 만들기)
function renderEmpty(narrowed, elsewhere = 0) {
  const art = document.createElement('span');
  art.className = 'empty-art';
  art.append(icon(narrowed ? 'search' : 'note')); // 이모지 대신 앱의 선 아이콘 (보관함 빈 화면과 같은 모양)
  const text = document.createElement('span');
  const other = MODE_LABEL[otherMode(state.mode)];
  const receiving = !narrowed && document.body.dataset.sync === 'syncing'; // 첫 동기화: Drive 에서 메모를 받는 중
  if (receiving) art.replaceChildren(icon('cloud'));
  text.textContent = receiving ? 'Google Drive에서 메모를 받아 오는 중이에요.\n그동안 새 메모를 바로 써도 돼요.'
    : narrowed && elsewhere
    ? `${MODE_LABEL[state.mode]}에는 '${state.query}' 메모가 없어요.\n${other}에서 ${elsewhere}개를 찾았어요.`
    : narrowed
    ? state.query ? `'${state.query}' 검색 결과가 없어요.` : UI.noMatch
    : state.folder === UNFILED ? `${UNFILED_LABEL} 메모가 없어요.\n모든 메모가 폴더에 들어 있어요. 여기서 쓰는 새 메모는 폴더 없이 만들어져요.`
    : state.folder ? `${folderLabel(state.folder)} 폴더가 비어 있어요.\n여기서 쓰는 새 메모는 이 폴더에 들어가요. 다른 메모를 꾹 눌러 끌어 이 폴더에 놓아도 돼요.`
    : state.mode === 'work' ? '아직 Work 메모가 없어요.\n일할 때 쓸 메모를 적거나, 메모를 꾹 눌러 "Work로 옮기기" 해 보세요.'
      : '아직 메모가 없어요.\n떠오른 생각을 바로 적거나 말로 남겨 보세요.';
  const actions = document.createElement('span');
  actions.className = 'empty-actions';
  const button = (label, run, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'btn primary' : 'btn';
    b.textContent = label;
    b.addEventListener('click', run);
    actions.append(b);
  };
  if (narrowed && elsewhere) button(`${other}에서 보기`, () => setMode(otherMode(state.mode)), true);
  else if (narrowed) {
    button(UI.clearFilters, () => {
      state.filter = { tags: [], colors: [], kinds: [] };
      el.search.value = '';
      el.search.dispatchEvent(new Event('input', { bubbles: true }));
      render();
    }, true);
  } else {
    button('글 메모', () => app.newMemo(), true);
    button('🎙 음성 메모', () => app.newMemo({ voice: true }));
    if (workLifeOn() && state.mode === 'work') button(UI.findWithHelper, () => openHelper());
  }
  el.empty.replaceChildren(art, text, actions);
}

function filterCount() {
  return state.filter.tags.length + state.filter.colors.length + state.filter.kinds.length;
}

export function render() {
  stale = false;
  clearTimeout(staleTimer);
  keepFolderValid();
  applyFolderSide();
  const narrowed = Boolean(state.query) || filterCount() > 0;
  const pick = { ...state.filter, tags: [...state.filter.tags, ...state.queryTags] };
  // 폴더: 고른 폴더의 메모만 (검색은 모든 폴더에서 — 카드에 폴더 이름이 보인다)
  const all = split(state.results ?? state.memos, state.mode).mine;
  // 비밀 폴더: 그 폴더의 메모만 (전체 · 검색에는 들지 않는다 — vault-secret.js)
  const source = state.query ? all : isSecretFolder(state.folder) ? (app.vault?.secretList(secretFolderId(state.folder)) ?? []) : inFolder(all);
  const memos = sortMemos(withViews(filterMemos(source, pick)), sort);
  // 검색어가 다른 모드의 메모에도 걸리면 알려 준다 (누르면 그 모드로)
  const elsewhere = state.query && workLifeOn() ? filterMemos(splitByMode(state.results ?? state.memos, otherMode(state.mode)).mine, pick).length : 0;
  $('other-mode').hidden = !elsewhere || !memos.length; // 하나도 없으면 빈 화면 안내가 대신
  $('other-mode').textContent = elsewhere ? `${MODE_LABEL[otherMode(state.mode)]}에서 ${elsewhere}개 더 찾았어요` : '';
  // 다시 그려도 남은 카드는 옛 자리에서 새 자리로 미끄러진다 (지우기·되돌리기·필터 — 툭 끊겨 바뀌지 않게)
  glideCards(() => layoutCards(memos));
  el.empty.hidden = memos.length > 0;
  el.empty.parentElement.classList.toggle('is-empty', !memos.length); // 안내 · 단추를 목록 칸 가운데에 (PC 와 같이)
  if (!memos.length) renderEmpty(narrowed, elsewhere);
  renderFilters();
  renderFolderSide();
  if (memos.length >= 2) setTimeout(hintCards, 800);
}

// ---------- 폴더 (folder-ui.js · core/folders.js) ----------

function loadFolderDirs() {
  state.folderDirs = app.vault?.folders?.() ?? [];
  state.pinnedFolders = app.vault?.pinnedFolders?.() ?? [];
}

// 폴더 목록: 기억해 둔 것 + 메모가 든 폴더 (처음 · 모르는 폴더의 메모가 들어왔을 때만 앱에 다시 묻는다)
function folders() {
  const memos = modeMemos();
  // (폴더 이름으로 못 쓰는 폴더 — Drive 웹에서 만든 "회의:2026" 등 — 는 목록에 들지 않으니 묻지 않는다: 그리면서 매번 묻게 되므로)
  if (!state.folderDirs || memos.some((m) => isFolderName(m.folder) && !state.folderDirs.includes(m.folder))) loadFolderDirs();
  return folderList(state.folderDirs, memos, state.pinnedFolders);
}

// 고른 폴더가 없어졌으면(다른 기기 · 파일 앱에서 지움) 전체로 — 카드를 거르기 전에
function keepFolderValid() {
  if (isSecretFolder(state.folder)) {
    if (!secretFolders().some((f) => f.name === state.folder && !f.locked)) state.folder = ''; // 잠겼다 (앱을 나갔다 등) — 전체로
    return;
  }
  if (state.folder === UNFILED ? !folders().length : state.folder && !folders().some((f) => f.name === state.folder)) state.folder = '';
}

// 폴더 고르기: 누른 줄은 바로 고른 모양이 되고, 카드 다시 그리기는 그 모습이 화면에 나온 다음 프레임에
//   (예전: 누르는 순간 카드 전체를 다시 쌓고 옛 자리 · 새 자리를 모두 재느라 누른 표시까지 늦게 떠 툭툭 끊겼다)
let folderSeq = 0;
function setFolder(name) {
  // 잠긴 비밀 폴더: 비밀번호부터 (맞으면 그 폴더를)
  if (isSecretFolder(name) && secretFolders().find((f) => f.name === name)?.locked) {
    unlockFolder(name).then((ok) => ok && setFolder(name));
    return;
  }
  const changed = name !== state.folder;
  state.folder = name;
  try {
    if (!isSecretFolder(name)) localStorage.setItem('memoking.folder', name); // 비밀 폴더는 기억하지 않는다 (다시 켜면 잠겨 있다)
  } catch {
    // 이번만
  }
  if (!changed) return render();
  markCurrentFolder(el.folderSide, name);
  haptic(5);
  const my = ++folderSeq;
  requestAnimationFrame(() => setTimeout(() => {
    if (my !== folderSeq) return; // 그사이 다른 폴더를 눌렀다
    const scroller = el.cards.closest('.view');
    if (scroller) scroller.scrollTop = 0; // 다른 폴더는 처음부터 (먼저 올려 두면 위쪽 카드만 그린다)
    glideOff = true; // 다른 폴더의 카드는 대부분 다른 카드 — 옛 자리에서 미끄러질 것이 없다 (재는 일만 줄인다)
    try {
      render();
    } finally {
      glideOff = false;
    }
    // 다른 폴더의 카드로 툭 바뀌지 않게: 살짝 떠오르며 나타난다
    if (!reduceMotion()) el.cards.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: EASE_OUT });
  }, 0));
}

// ---------- 폴더 목록 (왼쪽 · PC 처럼 탐색기 모양) ----------
//   위 폴더 단추로 접고 편다 (이 휴대폰에 기억). 정한 적이 없으면 폴더가 있을 때만 펴 둔다 — 폴더를 쓰지 않는 사람의 카드 자리를 빼앗지 않게
let sideWanted = null;
try {
  const v = localStorage.getItem('memoking.folderSide');
  sideWanted = v === null ? null : v !== '0';
} catch {
  // 정하지 않음
}
let sideSliding = false;
const sideShown = () => (sideWanted ?? (folders().length > 0 || secretFolders().length > 0)) && !state.query;
/** 연 비밀 폴더 — 폴더 목록의 '비밀 폴더' 묶음 */
/** 화면에 쓸 폴더 이름 (비밀 폴더는 secret:<id> 대신 그 이름) */
const folderLabel = (name) => secretFolders().find((f) => f.name === name)?.label ?? name;
const secretFolders = () => (app.vault?.secretFolders?.() ?? []).map((f) => ({ ...f, secret: true })); // 검색은 모든 폴더에서라 그동안은 접는다

// 목록을 보일지 정한다 (카드 줄 수를 재기 전에 — render 맨 앞에서)
function applyFolderSide() {
  const shown = sideShown();
  if (!sideSliding) el.folderSide.hidden = !shown;
  el.screen.classList.toggle('has-side', shown);
  el.folderBtn.setAttribute('aria-pressed', String(shown));
  el.folderBtn.setAttribute('aria-label', shown ? '폴더 목록 접기' : '폴더 목록 펴기');
}

function renderFolderSide() {
  const mine = split(state.memos, state.mode).mine;
  const list = [...withUnfiled(folders(), mine), ...secretFolders()];
  renderFolderList(el.folderSide, { folders: list, total: mine.length, current: state.folder, onPick: setFolder, onNew: newFolder, onMenu: folderMenu });
  // 폴더가 생기면 한 번: 메모를 꾹 눌러 끌면 폴더로 (눈에 안 보이는 동작)
  if (list.length && !el.folderSide.hidden) setTimeout(() => {
    const first = el.folderSide.querySelector(`[data-folder]:not([data-folder=""]):not([data-folder="${UNFILED}"])`);
    if (first?.getClientRects().length && state.tab === 'memos') hintOnce('folder-drag', '메모를 꾹 누른 채 끌어 폴더에 놓으면 옮겨져요. 폴더를 꾹 누르면 이름을 바꾸거나 삭제할 수 있어요', { anchor: first });
  }, 900);
}

async function newFolder() {
  loadFolderDirs();
  const name = await askFolderName({ existing: state.folderDirs ?? [] });
  if (!name) return;
  try {
    app.vault.createFolder(name);
    loadFolderDirs();
  } catch (err) {
    return toast(err.message || '폴더를 만들지 못했어요', true);
  }
  setFolder(name);
}

// 접고 펼 때 목록이 옆에서 미끄러져 나오고 들어간다 (카드 자리도 함께 밀린다)
el.folderBtn.addEventListener('click', async () => {
  if (sideSliding) return;
  sideWanted = !sideShown();
  if (state.query && sideWanted) {
    el.search.value = ''; // 검색 중에 펴면 검색을 푼다 (폴더는 검색하지 않을 때만)
    runSearch();
  }
  try {
    localStorage.setItem('memoking.folderSide', sideWanted ? '1' : '0');
  } catch {
    // 이번만
  }
  haptic(5);
  const side = el.folderSide;
  if (reduceMotion() || typeof side.animate !== 'function') return render();
  sideSliding = true;
  // 카드는 slideSide 가 자리만 미끄러뜨린다 (크기까지 늘이고 줄이면 글자가 찌그러져 보였다)
  try {
    await slideSide(side, sideWanted, () => {
      glideOff = true;
      try {
        render();
      } finally {
        glideOff = false;
      }
    }, el.cards);
  } finally {
    sideSliding = false; // 움직임이 중간에 실패해도 단추가 계속 안 눌리지 않게
  }
  applyFolderSide();
});

// 폴더 메뉴 (폴더 목록에서 꾹 누르기): 상단 고정 · 이름 바꾸기 · 지우기 (메모는 폴더 밖으로)
async function folderMenu(name, anchor) {
  haptic(12);
  const r = anchor.getBoundingClientRect();
  if (isSecretFolder(name)) return secretFolderMenu(name, r);
  const pick = await openContextMenu({
    x: Math.round(r.left), y: Math.round(r.bottom), label: `${name} 폴더`, clamp: true,
    items: [pinItem(state.pinnedFolders, name), { id: 'rename', label: '이름 바꾸기' }, { id: 'secret', label: '비밀 폴더로 만들기' }, { id: 'delete', label: '폴더 삭제', danger: true }],
  });
  try {
    if (pick === 'secret') {
      await makeSecret(name);
    } else if (pick === 'pin') {
      state.pinnedFolders = app.vault.pinFolder(name, !state.pinnedFolders.includes(name));
      render();
    } else if (pick === 'rename') {
      const to = await askFolderName({ existing: (state.folderDirs ?? []).filter((f) => f !== name), title: '폴더 이름 바꾸기', value: name, okLabel: '바꾸기' });
      if (!to || to === name) return;
      const done = app.vault.renameFolder(name, to);
      loadFolderDirs();
      if (state.folder === name) setFolder(done);
      else render();
      toast(`폴더 이름을 "${done}"(으)로 바꿨어요`);
    } else if (pick === 'delete') {
      const { moved, removed, ids = [] } = app.vault.deleteFolder(name);
      loadFolderDirs();
      if (state.folder === name) setFolder('');
      else render();
      // 메모는 지우지 않고 폴더 밖으로 — 되돌리기: 폴더를 다시 만들고 꺼낸 메모를 그 폴더로
      toast(!removed ? `메모 ${moved}개를 폴더 밖으로 옮겼어요. 메모가 아닌 파일이 있어 폴더는 남겨 뒀어요`
        : moved ? `${name} 폴더를 삭제했어요. 메모 ${moved}개는 폴더 밖에 그대로 있어요` : `${name} 폴더를 삭제했어요`, false, {
        label: '되돌리기',
        run: () => {
          app.vault.createFolder(name);
          for (const id of ids) app.vault.moveToFolder(id, name);
          loadFolderDirs();
          setFolder(name);
        },
      });
    }
  } catch (err) {
    toast(err.message || '폴더를 바꾸지 못했어요', true);
  }
}

/** 폴더를 바로 보여 준다 (잠긴 비밀 폴더면 비밀번호부터 — 비밀 메모 알림을 눌렀을 때 app.js) */
export function openFolder(name) {
  sideWanted = true;
  setFolder(name);
}

/** 잠긴 비밀 폴더를 비밀번호로 연다 → 열었나 */
export async function unlockFolder(name) {
  const fid = secretFolderId(name);
  const label = secretFolders().find((f) => f.name === name)?.label ?? '비밀';
  return askSecretPassword({
    name: label,
    onTry: async (password) => {
      try {
        await app.vault.unlockSecret(fid, password);
        return null;
      } catch (err) {
        return err.message || '열지 못했어요';
      }
    },
  });
}

// 폴더 메뉴 › 비밀 폴더로 만들기: 비밀번호를 정하면 안의 메모 · 사진 · 파일을 모두 잠가 같은 이름의 비밀 폴더로
async function makeSecret(name) {
  const count = state.memos.filter((m) => m.folder === name).length;
  let made = null;
  const ok = await askNewSecretPassword({
    name,
    count,
    onMake: async (password) => {
      try {
        made = await app.vault.makeSecretFolder(name, password);
        return null;
      } catch (err) {
        return err.message || '비밀 폴더로 만들지 못했어요';
      }
    },
  });
  if (!ok || !made) return;
  loadFolderDirs();
  setFolder(`${SECRET_FOLDER}${made.fid}`);
  toast(made.left ? `${name} 폴더를 비밀 폴더로 만들었어요. 잠긴 메모 ${made.left}개는 열 수 없어 원래 폴더에 남겼어요` : `${name} 폴더를 비밀 폴더로 만들었어요. 사진 · 파일까지 잠겼어요`);
}

// 비밀 폴더 메뉴: 잠긴 것은 열기만, 연 것은 잠그기 · 이름 바꾸기 · 보통 폴더로 되돌리기 · 지우기 (지우기는 그 안 메모까지 — 한 번 더 묻는다)
async function secretFolderMenu(name, r) {
  const fid = secretFolderId(name);
  const f = secretFolders().find((x) => x.name === name);
  const label = f?.label ?? '비밀 폴더';
  const pick = await openContextMenu({
    x: Math.round(r.left), y: Math.round(r.bottom), label: `${label} 비밀 폴더`, clamp: true,
    items: f?.locked ? [{ id: 'open', label: '열기' }]
      : [{ id: 'lock', label: '잠그기' }, { id: 'rename', label: '이름 바꾸기' }, { id: 'plain', label: '보통 폴더로 되돌리기' }, { id: 'delete', label: '비밀 폴더 삭제', danger: true }],
  });
  try {
    if (pick === 'open') {
      setFolder(name);
    } else if (pick === 'lock') {
      app.lockSecrets(fid);
    } else if (pick === 'rename') {
      const to = await askFolderName({ title: '비밀 폴더 이름 바꾸기', value: label, okLabel: '바꾸기' });
      if (!to || to === label) return;
      await app.vault.secret.rename(fid, to);
      app.vault.refreshSecretFolders();
      render();
    } else if (pick === 'plain') {
      if (!(await app.confirmDanger(`${label} 비밀 폴더를 보통 폴더로 되돌릴까요?`, '안의 메모 · 사진 · 파일의 잠금이 풀려 누구나 볼 수 있어요.', '되돌리기'))) return;
      const dir = await app.vault.makePlainFolder(fid);
      loadFolderDirs();
      setFolder(dir);
      toast(`${dir} 폴더를 보통 폴더로 되돌렸어요`);
    } else if (pick === 'delete') {
      const count = app.vault.secretList(fid).length;
      if (!(await app.confirmDanger(`${label} 비밀 폴더를 삭제할까요?`, `${count ? `안의 메모 ${count}개와 사진 · 파일도 함께 지워져요. ` : ''}휴지통에 두지 않아 되돌릴 수 없어요.`, '삭제'))) return;
      await app.vault.secret.removeFolder(fid);
      app.lockSecrets(fid);
      app.vault.refreshSecretFolders();
      if (state.folder === name) setFolder('');
      toast(`${label} 비밀 폴더를 삭제했어요`);
    }
  } catch (err) {
    toast(err.message || '비밀 폴더를 바꾸지 못했어요', true);
  }
}

/** 비밀 폴더로 넣거나 비밀 폴더에서 꺼내기 (to: 폴더 이름 · "secret:<id>") → 옮긴 수. 되돌리기 없음 (잠금이 바뀌므로) */
export async function moveSecretAware(ids, to) {
  let moved = 0;
  for (const id of ids) {
    if (isSecretFolder(to)) {
      if (isSecretId(id)) continue; // 비밀 폴더끼리는 꺼냈다 넣는다 (비밀번호가 다르므로) — 아직은 막는다
      if (secretFolders().find((f) => f.name === to)?.locked && !(await unlockFolder(to))) return moved; // 잠긴 폴더에 놓으면 비밀번호부터
      await app.vault.moveToSecret(id, secretFolderId(to));
      moved++;
    } else if (isSecretId(id)) {
      await app.vault.moveOutOfSecret(id, to === UNFILED ? '' : to);
      moved++;
    }
  }
  return moved;
}

// ---------- 폴더로 옮기기 · 여러 장 고르기 ----------

/** 메모들을 폴더로: 폴더 고르기 창 (current: 지금 폴더 — 흐리게) */
export async function moveToFolder(ids, current) {
  if (!ids.length || !app.vault) return;
  loadFolderDirs();
  const to = await pickFolder({ folders: folderList(state.folderDirs ?? [], [], state.pinnedFolders).map((f) => f.name), current: ids.length === 1 ? current ?? '' : null, count: ids.length });
  if (to === null) return;
  let moved = 0;
  try {
    for (const id of ids) if (app.vault.moveToFolder(id, to)) moved++;
  } catch (err) {
    toast(err.message || '옮기지 못했어요', true);
  }
  stopPicking();
  loadFolderDirs(); // 새 폴더로 옮겼으면 그 폴더도
  render();
  if (moved) toast(movedText(moved, to));
}

const pickBar = createPickBar({ onMove: () => moveToFolder([...state.picked], null), onCancel: () => stopPicking() });

function showPicks() {
  for (const c of el.cards.querySelectorAll('.card')) {
    c.classList.toggle('picked', state.picked.has(c.dataset.id));
    if (state.picking) c.setAttribute('aria-pressed', String(state.picked.has(c.dataset.id)));
    else c.removeAttribute('aria-pressed');
  }
  pickBar.show(state.picked.size, state.picking);
  document.body.classList.toggle('picking', state.picking); // 고르는 동안 + 단추는 숨긴다 (막대와 겹치지 않게)
}

/** 여러 장 고르기 시작 (이 메모를 고른 채) */
export function startPicking(id) {
  state.picking = true;
  state.picked = new Set(id ? [id] : []);
  showPicks();
}

function togglePick(id) {
  if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  haptic(5);
  showPicks();
}

function stopPicking() {
  if (!state.picking) return false;
  state.picking = false;
  state.picked.clear();
  showPicks();
  return true;
}


// 카드가 두 개 이상 보일 때 한 번: 옆으로 밀기·꾹 누르기 (눈에 안 보이는 동작)
function hintCards() {
  if (state.tab !== 'memos') return; // 그사이 일정 · 보관함 탭으로 갔으면 다음에 (달력 위에 메모 카드 안내가 뜨지 않게)
  const card = document.querySelector('.item .card');
  if (!card?.getClientRects().length) return; // 목록이 안 보이면 다음에
  hintOnce('card-gestures', '카드를 오른쪽으로 밀면 휴지통으로 가요(되돌릴 수 있어요). 꾹 누르면 메뉴가 뜨고, 꾹 누르거나 왼쪽으로 당긴 채 멈추면 들려서 폴더로 옮길 수 있어요', { anchor: card });
}

// ---------- 필터 ----------

function chip(className, content, pressed, data = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.setAttribute('aria-pressed', String(pressed));
  for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
  if (Array.isArray(content)) b.append(...content);
  else if (content) b.append(content);
  return b;
}

const MAX_TAG_CHIPS = 30;

// 보기 판의 태그 칩: 지금 모드에서 쓰는 태그를 많이 쓴 순으로 (골라 둔 태그는 앞에, 없어졌어도 남겨 풀 수 있게)
function renderTagChips() {
  const tags = collectTags(modeMemos());
  for (const t of state.filter.tags) if (!tags.some((x) => sameTag(x.name, t))) tags.unshift({ name: t, count: 0 });
  const picked = (name) => state.filter.tags.some((t) => sameTag(t, name));
  $('tag-filter-group').hidden = !tags.length;
  el.tagFilter.replaceChildren(...tags.slice(0, MAX_TAG_CHIPS).map((t) => {
    const count = document.createElement('small');
    count.textContent = String(t.count);
    return chip('tag-chip', [`#${t.name}`, count], picked(t.name), { tag: t.name });
  }));
}

// 태그 고르기 · 풀기 (보기 판의 칩 · 카드의 태그)
function toggleTag(name, { only = false } = {}) {
  const i = state.filter.tags.findIndex((t) => sameTag(t, name));
  if (only) state.filter.tags = i >= 0 && state.filter.tags.length === 1 ? [] : [name];
  else if (i >= 0) state.filter.tags.splice(i, 1);
  else {
    state.filter.tags.push(name);
    tutEvent('tag-filtered');
  }
  render();
}

function renderFilters() {
  renderTagChips();
  el.colorFilter.replaceChildren(...COLORS.map((c) => {
    const b = chip('color-dot', '', state.filter.colors.includes(c), { filterColor: c, color: c });
    b.setAttribute('aria-label', `${COLOR_NAMES[c] ?? c} 메모`);
    return b;
  }));
  el.kindFilter.replaceChildren(...KIND_FILTERS.map((k) => chip('chip', k.label, state.filter.kinds.includes(k.id), { kind: k.id })));
  const n = filterCount();
  el.filterCount.textContent = n ? String(n) : '';
  el.filterBtn.classList.toggle('on', n > 0 || sort !== DEFAULT_SORT); // 기본 보기가 아니면 단추에 표시
  el.filterSummary.hidden = n === 0;
  const parts = [
    ...state.filter.tags.map((t) => `#${t}`),
    ...state.filter.colors.map((c) => COLOR_NAMES[c] ?? c),
    ...state.filter.kinds.map((kid) => KIND_FILTERS.find((k) => k.id === kid)?.label ?? kid),
  ];
  el.filterSummaryText.textContent = `필터 ${n}개: ${parts.join(', ')}`;
}

const toggleIn = (list, value) => {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  else list.push(value);
};

el.tagFilter.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (b) toggleTag(b.dataset.tag);
});
el.colorFilter.addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter-color]');
  if (!b) return;
  toggleIn(state.filter.colors, b.dataset.filterColor);
  render();
});
el.kindFilter.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  toggleIn(state.filter.kinds, b.dataset.kind);
  render();
});
el.filterBtn.addEventListener('click', () => toggleFilterPanel());
$('filter-clear').addEventListener('click', () => {
  state.filter = { tags: [], colors: [], kinds: [] };
  render();
});

function toggleFilterPanel(force) {
  const open = force ?? el.filterPanel.hidden;
  el.filterPanel.hidden = !open;
  el.filterBtn.setAttribute('aria-expanded', String(open));
}

// ---------- 검색 ----------

let searchTimer = null;
function runSearch() {
  if (state.tab === 'reminders') return remindersTab?.setQuery(el.search.value);
  if (state.tab === 'history') return historyTab?.setQuery(el.search.value);
  state.query = el.search.value.trim();
  const { text, tags } = parseQuery(state.query);
  state.queryTags = tags;
  state.results = text ? app.vault.search(text) : null;
  render();
}
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    calmRender = true; // 글자를 칠 때마다 카드가 전부 튀어나오고 미끄러지면 정신없다 — 바로 바뀌게
    try {
      runSearch();
    } finally {
      calmRender = false;
    }
  }, 120);
});
let calmRender = false;
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.search.blur(); // 키보드 내리기
});

// ---------- 탭 ----------

function setTab(tab) {
  state.tab = tab;
  closeHint(); // 앞 탭의 안내는 닫는다
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  syncTabStops(document.querySelector('.tabs'));
  $('view-memos').hidden = tab !== 'memos';
  $('view-reminders').hidden = tab !== 'reminders';
  $('view-history').hidden = tab !== 'history';
  placeBar(tab);
  el.filterBtn.hidden = tab !== 'memos';
  el.folderBtn.hidden = tab !== 'memos'; // 폴더는 메모에만 (일정 · 보관함에는 쓸 데가 없다)
  el.search.placeholder = { memos: '메모나 #태그 검색', reminders: '일정 검색', history: UI.searchHistory }[tab];
  $('fab').hidden = tab !== 'memos'; // + 는 메모 탭에만. 일정 탭은 아래 빠른 추가 캡슐(list-reminders.js), 보관함엔 없음
  // 무거운 일(달력 · 카드 다시 그리기)은 탭 표시가 먼저 바뀐 다음 프레임에 — 누른 손가락 아래에서 탭이 바로 바뀌게
  //   (예전: 누르는 순간 목록 카드 전체를 다시 그려 150ms 넘게 멈춘 뒤에야 탭이 바뀌어 끊겨 보였다)
  const my = ++tabSeq;
  requestAnimationFrame(() => setTimeout(() => {
    if (my !== tabSeq || state.tab !== tab) return; // 그사이 다른 탭을 눌렀다
    if (tab === 'reminders') {
      remindersTab.setQuery(el.search.value, { quiet: true }); // 달력은 refresh 가 한 번만 그린다
      remindersTab.refresh({ ifChanged: true });
    } else if (tab === 'history' || stale || el.search.value.trim() !== state.query || !el.cards.querySelector('.col')) runSearch();
    // 메모 탭: 검색어도 메모도 그대로면 그려 둔 카드를 그대로 보인다 (바뀐 메모는 refresh 가 이미 그려 둠)
  }, 0));
}
let tabSeq = 0;
// 맨 위 줄 · 검색 줄을 지금 탭의 목록 칸 맨 앞에 두고 함께 스크롤한다.
//   검색 줄은 칸 위에 붙어 남는다 (sticky, 위 두 줄 높이만큼 위로 올라간 자리) — 제목을 접고 펴며 목록을 밀지 않으니
//   맨 위로 올라와도 카드가 손가락 밑에서 갑자기 내려가지 않는다
const searchbar = document.querySelector('.searchbar');
function placeBar(tab) {
  const view = $(`view-${tab}`);
  if (searchbar.parentElement !== view) view.prepend(searchbar);
  stickBar();
}
function stickBar() {
  const row = el.search.closest('.search');
  if (!row?.getClientRects().length) return;
  const above = row.getBoundingClientRect().top - searchbar.getBoundingClientRect().top - 8; // 검색 줄 위 8px 여백은 남긴다
  searchbar.style.setProperty('--bar-stick', `${-Math.max(0, Math.round(above))}px`);
  searchbar.parentElement.style.setProperty('--bar-full', `${searchbar.offsetHeight}px`); // 빈 화면 안내를 머리 아래 남은 칸 가운데에
}
new ResizeObserver(stickBar).observe(searchbar);
placeBar(state.tab ?? 'memos');
tabKeys(document.querySelector('.tabs'));
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  if (b.dataset.tab !== state.tab) haptic(5); // 손끝에 짧게 (바뀔 때만)
  setTab(b.dataset.tab);
});

// ---------- 카드 누르기 · 길게 누르기 ----------

el.cards.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card && state.picking) return togglePick(card.dataset.id);
  const tag = e.target.closest('[data-card-tag]');
  if (tag) return toggleTag(tag.dataset.cardTag, { only: true });
  // 찾는 중이면 그 말을 넘겨, 메모가 열리면 찾은 자리로 가고 칠한다
  const find = state.query ? parseQuery(state.query).text : '';
  if (card) app.openMemo(card.dataset.id, { fromList: true, from: card.getBoundingClientRect(), ...(find ? { find } : {}) }); // 그 카드가 커지며 메모 화면이 된다
});
// 카드 손짓 (휴대폰)
//   - 오른쪽으로 밀기: 휴지통으로 (묻지 않고, 되돌리기 가능)
//   - 왼쪽으로 당긴 채 잠깐 멈추면 카드가 톡 튀어 올라 끌기로 — 왼쪽 폴더 목록에 놓아 옮긴다
//     (iOS 홈 화면 · Gmail 처럼 "당기고 기다리면 들린다"). 그냥 놓으면 제자리 (태블릿 두 칸 화면은 왼쪽이 열기)
//   - 꾹 누르기: 카드가 들리고, 그대로 떼면 메뉴 · 끌면 왼쪽 폴더 목록에 놓아 그 폴더로 옮긴다
//   - 위아래로 훑기는 스크롤: 방향은 처음 12px 에서 한 번만 정하고, 가로가 세로의 1.5배를 넘어야 밀기.
//     스크롤이 아직 미끄러지는 중(멈춘 지 0.25초 안)에 닿은 손가락은 밀기를 시작하지 않는다 (훑다가 지워지던 것)
//   카드는 손가락을 프레임마다 한 번만(requestAnimationFrame) 따라가고, 미는 동안은 따로 그리는 층(will-change)이다.
//   미는 카드의 칸에는 .mk-live — 화면 밖 칸의 그리기 건너뛰기(base.css)가 칸 밖으로 나간 카드를 자르지 않게
const HOLD_MS = 280; // 꾹 눌러 끌기를 기다리는 때 (길면 끌기가 굼떠 보인다)
const PULL_HOLD_MS = 150; // 왼쪽으로 당긴 채 이만큼 멈추면 끌기로
const PULL_MIN = 24; // 이만큼 당겨야 기다리기 시작 (살짝 흔들린 것은 아니다)
const PULL_NOW = 64; // 이만큼 당기면 멈추기를 기다리지 않고 바로 들린다
let swipe = null;
let swipeFrame = 0;
let lastScroll = 0;
el.cards.closest('.view')?.addEventListener('scroll', () => (lastScroll = performance.now()), { passive: true });
const liveOn = (card, on) => card.closest('.item')?.classList.toggle('mk-live', on);

el.cards.addEventListener('touchstart', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.touches.length !== 1) return;
  const t = e.touches[0];
  swipe = { card, x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, dx: 0, active: false, t: e.timeStamp, vx: 0, id: t.identifier, w: 1,
    flinging: performance.now() - lastScroll < 250, held: false, drag: null, hold: 0 };
  // 꾹 누르기: 손가락이 거의 그대로면 들어 올린다 (안드로이드의 contextmenu 보다 먼저 · 같은 때)
  swipe.hold = setTimeout(() => holdCard(card), HOLD_MS);
}, { passive: true });

function holdCard(card) {
  if (!swipe || swipe.card !== card || swipe.active || swipe.held) return;
  swipe.held = true;
  haptic(12);
  card.classList.add('lifted');
}

function drawSwipe() {
  swipeFrame = 0;
  if (!swipe?.active) return;
  const { card, dx, w } = swipe;
  // 태블릿: 왼쪽으로 밀면 열기 — 카드는 목록 안에서만 살짝 따라온다
  const open = isTwoPane() && dx < 0;
  card.classList.toggle('swipe-open', open);
  if (open) {
    const pull = Math.min(-dx, w * 0.32) + Math.max(0, -dx - w * 0.32) * 0.15;
    card.dataset.openLabel = '열기 ▸';
    card.style.transform = `translate3d(${-pull}px, 0, 0)`;
    card.style.opacity = '';
    card.classList.toggle('swipe-ready', -dx > w * 0.28);
    return;
  }
  if (dx < 0) {
    // 왼쪽: 지우지 않는다 — 고무줄처럼 조금만 따라오고, 충분히 당기면 "폴더로" 표시 (그대로 멈추면 들린다)
    card.style.transform = `translate3d(${Math.max(dx * 0.25, -28)}px, 0, 0)`;
    card.style.opacity = '';
    card.classList.remove('swipe-ready');
    card.classList.toggle('swipe-folder', -dx >= PULL_MIN);
    return;
  }
  card.classList.remove('swipe-folder');
  card.style.transform = `translate3d(${dx}px, 0, 0) rotate(${dx / w * 4}deg)`;
  card.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / w * 0.7));
  card.classList.toggle('swipe-ready', dx > w * 0.4);
}

el.cards.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  // 두 번째 손가락이 닿아도 카드가 튀지 않게 첫 손가락만 따른다
  const t = [...e.touches].find((x) => x.identifier === swipe.id);
  if (!t) return;
  if (swipe.drag) {
    if (e.cancelable) e.preventDefault();
    swipe.drag.px = t.clientX; // 그리기는 프레임마다 한 번 (dragTick)
    swipe.drag.py = t.clientY;
    return;
  }
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (swipe.held) {
    // 들어 올린 뒤 움직이면 끌기 (폴더에 넣기) — 밀어 지우기가 아니다
    if (Math.hypot(dx, dy) < 5) return;
    if (e.cancelable) e.preventDefault();
    startDrag(t.clientX, t.clientY);
    return;
  }
  if (!swipe.active) {
    if (Math.hypot(dx, dy) < 12) return;
    clearTimeout(swipe.hold);
    if (swipe.flinging || Math.abs(dx) < Math.abs(dy) * 1.5) {
      swipe = null; // 세로 = 스크롤
      return;
    }
    swipe.active = true;
    swipe.x = t.clientX - Math.sign(dx) * Math.min(12, Math.abs(dx)); // 문턱만큼 뛰지 않고 손가락 자리에서 이어서
    swipe.w = swipe.card.offsetWidth || 1; // 크기는 한 번만 읽는다 (움직일 때마다 읽으면 레이아웃을 다시 계산)
    swipe.card.classList.add('swiping');
    liveOn(swipe.card, true);
    // 첫 움직임을 막을 수 없으면(스크롤이 미끄러지는 중) 목록 스크롤을 잠근다 — 늘 잠그면 목록 모양을 통째로 다시 따져 버벅였다
    if (!e.cancelable) el.screen.classList.add('swipe-lock');
  }
  if (e.cancelable) e.preventDefault();
  const nx = t.clientX - swipe.x;
  // 손을 뗄 때의 빠르기 (px/ms) — 짧게 '휙' 밀어도 지워지게
  const dt = e.timeStamp - swipe.t;
  if (dt > 0) swipe.vx = (nx - swipe.dx) / dt;
  swipe.t = e.timeStamp;
  swipe.dx = nx;
  swipe.lx = t.clientX;
  swipe.ly = t.clientY;
  // 왼쪽으로 충분히 당겼으면 멈추기를 기다린다 — 그사이 많이 움직이면 다시 기다린다
  if (!isTwoPane() && -nx >= PULL_NOW) {
    clearTimeout(swipe.pull?.timer);
    pullToDrag();
    return;
  }
  if (!isTwoPane() && -nx >= PULL_MIN) {
    if (!swipe.pull || Math.hypot(t.clientX - swipe.pull.x, t.clientY - swipe.pull.y) > 12) {
      clearTimeout(swipe.pull?.timer);
      swipe.pull = { x: t.clientX, y: t.clientY, timer: setTimeout(pullToDrag, PULL_HOLD_MS) };
    }
  } else if (swipe.pull) {
    clearTimeout(swipe.pull.timer);
    swipe.pull = null;
  }
  if (!swipeFrame) swipeFrame = requestAnimationFrame(drawSwipe);
}, { passive: false });

// 왼쪽으로 당긴 채 멈춤 → 카드가 톡 튀어 올라 끌기로 (손가락은 떼지 않은 채 그대로 폴더로)
function pullToDrag() {
  if (!swipe?.active || swipe.drag) return;
  const { card } = swipe;
  cancelAnimationFrame(swipeFrame);
  swipeFrame = 0;
  el.screen.classList.remove('swipe-lock');
  card.classList.remove('swiping', 'swipe-ready', 'swipe-folder');
  card.style.transform = card.style.opacity = '';
  swipe.active = false;
  swipe.held = true;
  swipe.pull = null;
  haptic(14);
  startDrag(swipe.lx, swipe.ly, { pop: true });
}

// ---------- 꾹 눌러 끌어 폴더에 넣기 ----------
function startDrag(x, y, { pop = false } = {}) {
  const { card } = swipe;
  const r = card.getBoundingClientRect();
  const clone = card.cloneNode(true);
  clone.classList.remove('lifted', 'swiping');
  clone.classList.add('m-drag-clone');
  Object.assign(clone.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, transformOrigin: `${x - r.left}px ${y - r.top}px` });
  document.body.append(clone);
  card.classList.add('drag-source');
  document.body.classList.add('m-dragging');
  // 폴더 목록을 접어 두었으면 끄는 동안만 왼쪽에 띄운다 (메모 칸의 높이에 맞춰)
  if (el.folderSide.hidden) {
    const v = el.cards.closest('.view').getBoundingClientRect();
    renderFolderSide();
    Object.assign(el.folderSide.style, { top: `${v.top}px`, height: `${v.height}px` });
    el.folderSide.classList.add('peek');
  }
  // 폴더 줄의 자리는 처음 한 번만 잰다 — 움직일 때마다 elementFromPoint 로 찾으면 레이아웃을 다시 따져 버벅였다
  const side = el.folderSide;
  const sr = side.getBoundingClientRect();
  const rows = [...side.querySelectorAll('[data-folder]')].map((row) => {
    const r = row.getBoundingClientRect();
    return { row, top: r.top - sr.top + side.scrollTop, bottom: r.bottom - sr.top + side.scrollTop };
  });
  // 끄는 동안은 작게 (손가락 둘레에 들린 쪽지처럼 — 큰 카드가 폴더 목록을 가리지 않게). 긴 카드일수록 더 작게
  const small = Math.max(0.28, Math.min(0.55, 150 / r.width, 170 / r.height));
  swipe.drag = { clone, x, y, px: x, py: y, overRow: null, rows, small, top: sr.top, bottom: sr.bottom, left: sr.left - 14, right: sr.right,
    scroll: side.scrollTop, maxScroll: side.scrollHeight - side.clientHeight, frame: 0 };
  moveDrag(swipe.drag);
  // 당겨서 들었으면 한 번 톡 튄다 (들렸다는 것을 손끝과 눈으로)
  if (pop && !reduceMotion()) clone.animate([{ transform: 'none' }, { transform: 'scale(1.12)' }, { transform: 'none' }], { duration: 220, easing: EASE_OUT });
}

// 프레임마다 한 번: 손가락 자리로 카드를 옮기고, 아래 폴더를 찾고, 끝에 머물면 목록을 계속 넘긴다
function moveDrag(d) {
  d.frame = requestAnimationFrame(() => moveDrag(d));
  const { px: x, py: y } = d;
  const inSide = x >= d.left && x <= d.right && y >= d.top && y <= d.bottom;
  // 폴더가 많아 목록이 넘치면: 목록의 위 · 아래 끝 가까이에 대고 있으면 그쪽으로 넘겨 준다 (손가락이 멈춰 있어도)
  if (inSide && d.maxScroll > 0) {
    const step = y < d.top + 44 ? -8 : y > d.bottom - 44 ? 8 : 0;
    const next = Math.max(0, Math.min(d.maxScroll, d.scroll + step));
    if (next !== d.scroll) el.folderSide.scrollTop = d.scroll = next;
  }
  const at = y - d.top + d.scroll;
  const row = inSide ? d.rows.find((r) => at >= r.top && at < r.bottom)?.row ?? null : null;
  if (row !== d.overRow) {
    d.overRow?.classList.remove('drop-on');
    row?.classList.add('drop-on');
    if (row) haptic(6);
    d.overRow = row;
  }
  // 손가락 자리를 기준으로 작게 들고 다니고, 폴더 위에서는 조금 더 작아진다 (크기 바뀜은 CSS 가 부드럽게 — m-drag-clone)
  d.clone.style.translate = `${x - d.x}px ${y - d.y}px`;
  d.clone.style.scale = String(row ? Math.min(d.small, 0.36) * 0.85 : d.small);
  d.clone.classList.toggle('over-folder', Boolean(row));
}

function endDrag(drop) {
  const d = swipe.drag;
  cancelAnimationFrame(d.frame);
  const { card } = swipe;
  const row = drop ? d.overRow : null;
  d.overRow?.classList.remove('drop-on');
  document.body.classList.remove('m-dragging');
  el.folderSide.classList.remove('peek');
  el.folderSide.style.top = el.folderSide.style.height = '';
  const clone = d.clone;
  const finish = () => {
    clone.remove();
    card.classList.remove('drag-source', 'lifted');
  };
  if (row && !reduceMotion()) {
    // 폴더 줄로 작아지며 들어가고, 그 줄이 한 번 튄다
    const c = clone.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    clone.style.transition = `translate 0.22s ${EASE_OUT}, scale 0.22s ${EASE_OUT}, opacity 0.22s ${EASE_OUT}`;
    clone.style.translate = `${d.px - d.x + r.left + r.width / 2 - (c.left + c.width / 2)}px ${d.py - d.y + r.top + r.height / 2 - (c.top + c.height / 2)}px`;
    clone.style.scale = '0.08';
    clone.style.opacity = '0';
    row.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 260, easing: EASE_OUT });
  } else if (!reduceMotion()) {
    // 놓을 곳이 아니면 제자리로 돌아간다
    clone.style.transition = `translate 0.2s ${EASE_OUT}, scale 0.2s ${EASE_OUT}, rotate 0.2s ${EASE_OUT}`;
    clone.style.translate = clone.style.scale = '';
    clone.style.rotate = '0deg';
  }
  setTimeout(finish, reduceMotion() ? 0 : 230);
  card.dataset.swiped = '1'; // 뒤따르는 "눌림" 으로 메모가 열리지 않게
  setTimeout(() => delete card.dataset.swiped, 400);
  if (row) {
    const to = row.dataset.folder === UNFILED ? '' : row.dataset.folder; // 전체 · 미분류에 놓기 = 폴더에서 빼기
    const id = card.dataset.id;
    moveIdsTo(state.picking && state.picked.has(id) ? [...state.picked] : [id], to);
  }
}

function endSwipe(e) {
  if (!swipe) return;
  // 다른 손가락만 뗀 경우는 계속 민다
  if (e?.touches && [...e.touches].some((x) => x.identifier === swipe.id)) return;
  clearTimeout(swipe.hold);
  clearTimeout(swipe.pull?.timer);
  if (swipe.drag) {
    endDrag(e?.type === 'touchend');
    swipe = null;
    return;
  }
  const { card, dx, active, held } = swipe;
  // 멈췄다가 뗀 건 튕긴 게 아니다
  const vx = e && e.timeStamp - swipe.t < 100 ? swipe.vx : 0;
  swipe = null;
  if (!active) {
    card.classList.remove('lifted');
    if (held && e?.type === 'touchend') {
      // 꾹 누른 채 움직이지 않고 뗐으면 메뉴 — 뒤따르는 "눌림" 으로 메모가 열리지 않게 잠깐 막는다
      card.dataset.swiped = '1';
      setTimeout(() => delete card.dataset.swiped, 400);
      app.memoMenu(card.dataset.id);
    }
    return;
  }
  cancelAnimationFrame(swipeFrame);
  swipeFrame = 0;
  el.screen.classList.remove('swipe-lock');
  const opening = card.classList.contains('swipe-open');
  card.classList.remove('swiping', 'swipe-ready', 'swipe-open', 'lifted', 'swipe-folder');
  const w = card.offsetWidth || 1;
  const settle = () => {
    card.style.transition = `transform 0.2s ${EASE_OUT}, opacity 0.2s`;
    card.style.transform = '';
    card.style.opacity = '';
    setTimeout(() => {
      card.style.transition = '';
      liveOn(card, false);
    }, 220);
  };
  if (opening) {
    settle();
    if (-dx > w * 0.28) {
      card.dataset.swiped = '1';
      setTimeout(() => delete card.dataset.swiped, 400);
      haptic(8);
      app.openMemo(card.dataset.id, { fromList: true });
    }
    return;
  }
  // 오른쪽으로 멀리 밀었거나, 오른쪽으로 휙 튕겼으면 (빠르기 0.35px/ms 넘고 폭의 1/5 넘게) 지운다
  const flick = vx > 0.35 && dx > w * 0.2;
  if (dx > w * 0.4 || flick) {
    // 카드가 끝까지 날아간 뒤에 지운다 — 날아가는 중에 목록을 다시 그리면(무거운 일) 카드가 중간에 멈칫했다
    card.classList.add('flying');
    card.style.transition = `transform 0.2s ${EASE_OUT}, opacity 0.2s ${EASE_OUT}`;
    card.style.transform = `translate3d(${w * 1.3}px, 0, 0) rotate(8deg)`;
    card.style.opacity = '0';
    card.dataset.swiped = '1';
    let done = false;
    const remove = () => {
      if (done) return;
      done = true;
      card.style.visibility = 'hidden'; // 다시 그리기 전까지 제자리에 다시 보이지 않게
      app.deleteMemo(card.dataset.id, { flown: true });
    };
    card.addEventListener('transitionend', (ev) => ev.propertyName === 'transform' && remove());
    setTimeout(remove, 260); // transitionend 가 오지 않을 때(움직임 줄이기 등)
    return;
  }
  settle();
}
el.cards.addEventListener('touchend', endSwipe);
el.cards.addEventListener('touchcancel', endSwipe);
// 밀거나 끈 카드는 눌린 것으로 치지 않는다
el.cards.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card?.dataset.swiped || card?.classList.contains('swiping')) e.stopImmediatePropagation();
}, true);

// 길게 누르기 (안드로이드 · 화면 읽기의 메뉴 키): 손가락이면 위 타이머와 같은 들어 올리기 — 메뉴는 뗄 때, 끌면 폴더로.
//   손가락이 아닌 길(키보드 · 화면 읽기)이면 바로 메뉴
el.cards.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  if (swipe?.active || swipe?.drag || card.classList.contains('swiping')) return;
  if (swipe && swipe.card.dataset.id === card.dataset.id) { // 목록을 다시 그렸으면 카드 요소가 바뀌었을 수 있어 메모로 비교
    clearTimeout(swipe.hold);
    holdCard(swipe.card);
    return;
  }
  haptic(12);
  app.memoMenu(card.dataset.id);
});

/** 끌어 놓은 메모들을 그 폴더로 ("" = 폴더에서 빼기) — 되돌리기는 알림에서 */
function moveIdsTo(ids, to) {
  if (!app.vault) return;
  if (isSecretFolder(to) || ids.some(isSecretId)) {
    // 비밀 폴더로 넣기 · 꺼내기: 잠그고 푸는 일이라 기다린다 (되돌리기 없음)
    moveSecretAware(ids, to).then((moved) => {
      stopPicking();
      render();
      if (moved) toast(isSecretFolder(to) ? `메모 ${moved}개를 비밀 폴더로 옮겼어요` : `메모 ${moved}개를 비밀 폴더에서 꺼냈어요`);
    }, (err) => toast(err.message || '옮기지 못했어요', true));
    return;
  }
  const before = new Map(ids.map((id) => [id, state.memos.find((m) => m.id === id)?.folder ?? '']));
  const go = ids.filter((id) => before.get(id) !== to);
  if (!go.length) return;
  let moved = 0;
  try {
    for (const id of go) if (app.vault.moveToFolder(id, to)) moved++;
  } catch (err) {
    return toast(err.message || '옮기지 못했어요', true);
  }
  stopPicking();
  loadFolderDirs();
  render();
  if (moved) toast(movedText(moved, to), false, {
    label: '되돌리기',
    run: () => {
      for (const id of go) app.vault.moveToFolder(id, before.get(id));
      loadFolderDirs();
      render();
    },
  });
}

// ---------- 카드 모양 (격자 / 한 줄씩) ----------

// 보기 패널의 고르기 칩 (정렬 · 카드 모양): 하나만 켜짐
function radioChips(box, options, current) {
  box.replaceChildren(...options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(o.id === current));
    b.tabIndex = o.id === current ? 0 : -1;
    b.dataset.value = o.id;
    b.textContent = o.label;
    return b;
  }));
}
const LAYOUTS = [{ id: 'grid', label: '두 줄' }, { id: 'rows', label: '한 줄씩' }];
function applyLayout(layout) {
  el.cards.dataset.layout = layout;
  radioChips(el.layoutGroup, LAYOUTS, layout);
}
try {
  layout = localStorage.getItem('memoking.layout') ?? 'grid';
} catch {
  // 기본
}
applyLayout(layout);
// 카드들이 새 자리로 미끄러져 간다 (FLIP: 옛 자리 → 새 자리) — 모양이 바뀐 것을 눈으로 따라갈 수 있게
//   재기 → 쓰기를 나눈다: 카드마다 재고 바로 고치면 그때마다 화면 배치를 다시 계산했다 (메모 1,500개에 3초 넘게).
//   미끄러짐은 화면 근처 카드만 (보이지 않는 카드는 움직여도 보이지 않는다)
let glideOff = false; // 폴더 목록을 펴고 접을 때: 카드 움직임은 slideSide 가 맡는다
function glideCards(change) {
  const vh = window.innerHeight;
  const near = (r) => r.bottom > -vh && r.top < vh * 2;
  // 카드를 감싼 칸(.item)을 잰다 — 화면 밖 칸은 그리기를 건너뛰는데(base.css), 그 안의 카드를 재면 건너뛴 것을 모두 다시 계산한다
  const idOf = (item) => item.firstElementChild?.dataset.id;
  const before = new Map([...el.cards.querySelectorAll('.item')].map((it) => [idOf(it), it.getBoundingClientRect()]).filter(([, r]) => r.width));
  change();
  const still = [];
  const moves = [];
  const animate = !reduceMotion() && !calmRender && !glideOff;
  const items = [...el.cards.querySelectorAll('.item')];
  if (calmRender) for (const item of items) item.style.animation = 'none'; // 검색 중: 다시 보인 카드도 튀어나오지 않게
  for (const it of items) {
    const a = before.get(idOf(it));
    if (!a) continue;
    still.push(it);
    if (animate && near(a)) moves.push([it, a, it.getBoundingClientRect()]);
  }
  for (const it of still) it.style.animation = 'none'; // 이미 있던 카드는 다시 튀어나오지 않는다 (새 카드만 등장 움직임)
  for (const [it, a, b] of moves) {
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    it.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: 260, easing: EASE_OUT });
  }
}

el.layoutGroup.addEventListener('click', (e) => {
  const b = e.target.closest('[data-value]');
  if (!b || b.dataset.value === layout) return;
  layout = b.dataset.value === 'rows' ? 'rows' : 'grid';
  tutEvent('layout-changed');
  glideCards(() => {
    applyLayout(layout);
    render();
  });
  try {
    localStorage.setItem('memoking.layout', layout);
  } catch {
    // 무시
  }
});

// ---------- 정렬 (최신순 · 오래된순 · 많이 본 순 · 이름순) — "보기" 패널, PC 와 같은 규칙(core/memo-sort.js), 이 휴대폰에 기억 ----------
//   고정한 메모는 늘 맨 앞. 많이 본 순은 이 휴대폰에서 메모를 연 횟수 (countView — 메모 파일에는 쓰지 않는다: 열 때마다 동기화되지 않게)
function applySortLabel() {
  radioChips(el.sortGroup, SORTS, sort);
  el.sortGroup.setAttribute('aria-label', `정렬: ${sortLabel(sort)}`);
}
applySortLabel();
el.sortGroup.addEventListener('click', (e) => {
  const b = e.target.closest('[data-value]');
  if (!b || b.dataset.value === sort) return;
  sort = validSort(b.dataset.value);
  applySortLabel();
  try {
    localStorage.setItem('memoking.sort', sort);
  } catch {
    // 이번 실행 동안만
  }
  render(); // 카드들이 새 순서로 미끄러져 간다 (glideCards)
});

// ---------- 밖에서 쓰는 것 ----------

export function setup() {
  remindersTab = setupRemindersTab({
    api: app.api,
    container: $('reminder-groups'),
    countEl: $('count-reminders'),
    notify: (text, isError) => toast(text, isError),
    // 지금 모드의 메모 일정만 (목록에 아직 없는 새 메모의 일정은 우선 보인다)
    visible: (item) => {
      const memo = state.memos.find((m) => m.id === item.memoId);
      return !workLifeOn() || !memo || memoMode(memo) === state.mode;
    },
    // 회상 보기: 그날의 기록은 뒤로 가기로 닫힌다
    memories: {
      mode: () => (workLifeOn() ? state.mode : null), // 회상도 지금 모드의 메모로
      onOverlay: (el, close) => {
        adoptSheet(el, close);
        return () => releaseSheet(el);
      },
      // 한 장으로: 미리보기에서 공유(안드로이드 공유 창) · 복사 · 저장(저장 창) · 메모로 만들기
      collage: {
        render: (o) => renderCollage(o),
        actions: (base64, o) => [
          { id: 'share', label: '공유', icon: 'share', run: async () => {
            await call('shareFile', { base64, name: collageName(o), mime: 'image/png', title: o.title });
            return '';
          } },
          { id: 'copy', label: '복사', icon: 'copy', run: async () => {
            await call('copyImage', { base64 });
            copiedToast(UI.imageCopied);
            return '';
          } },
          { id: 'save', label: '저장', icon: 'folder', run: async () => {
            const name = await call('saveAs', { name: collageName(o), mime: 'image/png', base64 });
            return name ? `${name}로 저장했어요` : '';
          } },
          { id: 'memo', label: UI.makeMemo, icon: 'note', close: true, run: async () => {
            if (!app.vault) throw new Error('메모 폴더가 아직 없어요');
            const rel = app.vault.saveAttachment(base64Bytes(base64), 'png');
            const id = app.vault.import({ body: collageMemoBody(o.title, rel) });
            if (!id) throw new Error(UI.memoCreateFail);
            refresh();
            app.api.memo.open(id);
            return UI.madeNewMemo;
          } },
        ],
      },
    },
  });
  historyTab = setupHistoryTab({
    api: app.api,
    els: {
      consent: $('history-consent'),
      body: $('history-body'),
      enable: $('history-enable'),
      app: $('history-app'),
      clear: $('history-clear'),
      rows: $('history-rows'),
      empty: $('history-empty'),
    },
    confirm: confirmDialog,
  });
  workClock(); // 켤 때 업무 시간이면 Work로 시작 (저절로 바꾸기를 켰을 때)
}

/** 태그 하나로 거르기 (연결 패널의 태그를 눌렀을 때) */
export function filterTag(name) {
  if (state.tab !== 'memos') setTab('memos');
  state.filter = { tags: [name], colors: [], kinds: [] };
  el.search.value = '';
  state.query = '';
  state.queryTags = [];
  state.results = null;
  render();
  $('view-memos').scrollTop = 0;
}

/**
 * 지우는 카드: 떠 있는 복사본이 옆으로 날아가는 동안, 목록은 곧바로 다시 그려져 남은 카드가 빈자리로 미끄러진다
 *   (예전: 그 줄만 접힌 뒤 두 줄 배치를 다시 짜며 카드가 툭 건너뛰었다)
 */
export function animateRemove(id, { dir = 1 } = {}) {
  const card = el.cards.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('card-ghost');
  ghost.removeAttribute('data-id');
  Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, transform: card.style.transform, opacity: card.style.opacity });
  ghost.style.setProperty('--fly', `${dir * 110}%`);
  document.body.append(ghost);
  card.style.visibility = 'hidden'; // 다시 그리기 전까지 같은 카드가 둘로 보이지 않게
  ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  setTimeout(() => ghost.remove(), 600);
}

/** 알림 보관함 탭이 보이면 다시 그린다 (새 알림·설정에서 돌아옴) */
export function refreshHistory() {
  if (state.tab === 'history') historyTab?.refresh();
}

let shownKey = ''; // 지금 목록에 그린 메모들 (같으면 다시 그리지 않는다 — 지운 뒤 폴더 변경 소식으로 또 그려 끊겼다)
export function refresh() {
  if (!app.vault) return;
  app.vault.defaultMode = state.mode; // 폴더를 다시 열어 새 저장소가 됐어도 지금 모드로
  state.memos = app.vault.list();
  state.folderDirs = null; // 폴더 목록도 다시 묻는다 — 다른 기기에서 만들거나 지운 빈 폴더는 메모만 봐서는 알 수 없다
  // Work / Life 나누기를 정한 적이 없으면: 이미 Work 메모가 있을 때만 켠다 (PC 에서 옮겨 둔 것 등)
  if (state.workLife === null && state.memos.length) {
    state.workLife = state.memos.some((m) => m.mode === 'work');
    try {
      localStorage.setItem(WORK_LIFE_KEY, state.workLife ? '1' : '0');
    } catch {
      // 다음에 다시
    }
    showMode();
  }
  if (state.query) {
    const { text } = parseQuery(state.query);
    state.results = text ? app.vault.search(text) : null;
  }
  const key = (state.results ?? state.memos).map(cardKey).join('\n') + (state.results ? '' : '|all') + state.memos.length
    + secretFolders().map((f) => `${f.name}${f.locked ? 'L' : ''}${f.label}`).join() // 비밀 폴더는 목록(list) 밖 — 열고 잠그거나 그 안 메모를 고치면 다시 그린다
    + (isSecretFolder(state.folder) ? (app.vault.secretList(secretFolderId(state.folder)) ?? []).map(cardKey).join('\n') : '');
  remindersTab?.refresh({ quiet: state.tab !== 'reminders' }); // 일정 탭으로 가면 setTab 이 다시 그린다
  if (key === shownKey && el.cards.querySelector('.col')) return;
  shownKey = key;
  // 휴대폰에서 메모를 쓰는 동안 목록은 메모 화면 뒤에 가려 있다 — 저장할 때마다 바로 다시 그리면 글자를 치다 걸렸다.
  //   손을 쉴 때(잠깐 뒤 · 한가할 때) 그리고, 그 전에 목록으로 돌아오면 show() 가 바로 그린다
  if (covered()) {
    stale = true;
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => (window.requestIdleCallback ?? setTimeout)(() => stale && render(), { timeout: 3000 }), 1200);
    return;
  }
  render();
}
let stale = false;
let staleTimer = null;
const covered = () => !isTwoPane() && !$('note-screen').hidden;

export function show() {
  const wasHidden = el.screen.hidden;
  el.screen.hidden = false;
  if (wasHidden) render(); // 숨어 있던 동안에는 카드 높이를 잴 수 없어 다시 쌓는다
  else if (stale) {
    // 메모 화면이 내려가는 동안(0.16초)은 그대로 두고, 다 내려간 뒤에 카드들이 새 자리로 미끄러진다 — 닫는 움직임이 걸리지 않게
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => stale && render(), 200);
  }
  matchChrome(el.screen);
}

/** 뒤로 가기: 필터 패널 → 검색어 → 알림 탭 순으로 풀고, 더 없으면 false */
export function back() {
  if (stopPicking()) return true;
  // 일정 탭의 펼친 입력창을 먼저 (메모 탭의 검색 · 필터보다 — 보이지 않는 것이 먼저 풀리지 않게)
  if (state.tab === 'reminders' && remindersTab?.closeQuick?.()) return true;
  if (!el.filterPanel.hidden) {
    toggleFilterPanel(false);
    return true;
  }
  if (el.search.value) {
    el.search.value = '';
    runSearch();
    return true;
  }
  if (filterCount()) {
    state.filter = { tags: [], colors: [], kinds: [] };
    render();
    return true;
  }
  if (state.tab !== 'memos') {
    setTab('memos');
    return true;
  }
  return false;
}

