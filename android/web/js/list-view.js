// 메모 목록 화면 — 카드(실제 메모 색) · 검색 · 태그 줄 · 필터 · 알림 예약 탭
import { icon } from '../../app/js/icons.js';
import { formatStamp, friendlyTime, shortUrls } from '../../app/js/core/format.js';
import { vaultUrl } from '../../app/js/media.js';
import { setupRemindersTab } from '../../app/js/list-reminders.js';
import { setupHistoryTab } from '../../app/js/list-history.js';
import { collectTags, filterMemos, parseQuery, KIND_FILTERS, sameTag } from '../../app/js/core/tags.js';
import { COLORS, COLOR_NAMES } from '../../app/js/core/memo-file.js';
import { app } from './state.js';
import { isAllClear } from '../../app/js/core/tasks.js';
import { matchChrome, confirmDialog, isTwoPane, toast, adoptSheet, releaseSheet } from './ui.js';
import { call } from './native.js';
import { renderCollage, collageName } from '../../app/js/memories-collage.js';
import { base64Bytes, collageMemoBody } from '../../app/js/collage-preview.js';
import { tutEvent, tutorialStepId } from './tutorial.js';
import { haptic, reduceMotion, tabKeys, syncTabStops, stackCards, withViewTransition, setModeSwitch } from '../../app/js/dom.js';
import { hintOnce, closeHint } from '../../app/js/hints.js';
import { SORTS, DEFAULT_SORT, sortMemos, validSort, sortLabel } from '../../app/js/core/memo-sort.js';
import { MODE_KEY, MODE_LABEL, validMode, splitByMode, memoMode, otherMode } from '../../app/js/core/modes.js';
import { modeClock } from '../../app/js/core/work-hours.js';
import { openModeHelper } from '../../app/js/mode-helper-dialog.js';
import { workHours, onWorkHours } from './work-mode.js';
import { setListTheme } from './theme.js';

const $ = (x) => document.getElementById(x);
const el = {
  screen: $('list-screen'),
  search: $('search'),
  cards: $('cards'),
  empty: $('empty'),
  tagStrip: $('tag-strip'),
  filterBtn: $('filter-btn'),
  filterCount: $('filter-count'),
  filterPanel: $('filter-panel'),
  colorFilter: $('color-filter'),
  kindFilter: $('kind-filter'),
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
};
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
export const currentMode = () => state.mode;

// 해 · 달 스위치 (화면 전환 속에서 바꿀 때는 전환이 끝난 뒤에 — dom.js setModeSwitch)
const syncSwitch = () => setModeSwitch($('mode-switch'), state.mode);
/** @param {{ later?: boolean }} [o] later: 스위치는 부른 쪽이 나중에 (syncSwitch) */
function showMode({ later = false } = {}) {
  if (!later) syncSwitch();
  document.documentElement.dataset.mode = state.mode;
  setListTheme(workLifeOn() ? state.mode : null, { noteOpen: app.isNoteOpen?.() ?? false }); // Work 는 어두운 화면 · Life 는 밝은 화면 (나눠 쓰지 않으면 시스템 설정)
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
  card.dataset.color = memo.color;

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = memo.title;
  head.append(title);
  if (memo.pinned) {
    const pin = badge('pin-fill', '', 'pin');
    pin.setAttribute('role', 'img');
    pin.setAttribute('aria-label', '고정됨');
    head.append(pin);
  }
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
    img.draggable = false;
    img.onerror = () => img.remove();
    card.append(img);
  }

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
  tags.textContent = (memo.tags ?? []).map((t) => `#${t}`).join(' ');
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
  if (memo.linkCount) meta.append(badge('link', memo.linkCount));
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
  return width >= 900 ? 4 : width >= 600 ? 3 : 2;
}

function layoutCards(memos) {
  const cols = columnsFor(el.cards.clientWidth || window.innerWidth);
  lastCols = cols;
  const columns = Array.from({ length: cols }, () => {
    const c = document.createElement('div');
    c.className = 'col';
    return c;
  });
  el.cards.replaceChildren(...columns);
  stackCards(columns, memos.map(cardFor));
  if (cardCache.size > memos.length + 200) for (const id of cardCache.keys()) if (!memos.some((m) => m.id === id)) cardCache.delete(id);
}

// 바뀌지 않은 메모의 카드는 다시 만들지 않고 그대로 옮겨 쌓는다
//   — 지우기 · 되돌리기 · 저장 때마다 모든 카드를 새로 만들어, 남은 카드가 미끄러지는 중에 화면이 잠깐 멈췄다
const cardCache = new Map(); // 메모 id → { key, li }
const cardKey = (memo) => JSON.stringify(memo) + friendlyTime(memo.updated);
function cardFor(memo) {
  const key = cardKey(memo);
  const hit = cardCache.get(memo.id);
  if (hit?.key === key) {
    const card = hit.li.querySelector('.card');
    card.removeAttribute('style'); // 밀다 만 자리 · 숨김(animateRemove)이 남지 않게
    card.classList.remove('swiping', 'swipe-ready', 'swipe-open', 'flying');
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

// 빈 목록: 그림 + 다음에 할 일 단추 (검색·필터로 비었으면 풀기, 메모가 없으면 첫 메모 만들기)
function renderEmpty(narrowed, elsewhere = 0) {
  const art = document.createElement('span');
  art.className = 'empty-art';
  art.textContent = narrowed ? '🔍' : '📝';
  const text = document.createElement('span');
  const other = MODE_LABEL[otherMode(state.mode)];
  const receiving = !narrowed && document.body.dataset.sync === 'syncing'; // 첫 동기화: Drive 에서 메모를 받는 중
  if (receiving) art.textContent = '☁️';
  text.textContent = receiving ? 'Google Drive에서 메모를 받아 오는 중이에요.\n그동안 새 메모를 바로 써도 돼요.'
    : narrowed && elsewhere
    ? `${MODE_LABEL[state.mode]}에는 '${state.query}' 메모가 없어요.\n${other}에서 ${elsewhere}개를 찾았어요.`
    : narrowed
    ? state.query ? `'${state.query}' 검색 결과가 없어요.` : '조건에 맞는 메모가 없어요.'
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
    button('검색과 필터 풀기', () => {
      state.filter = { tags: [], colors: [], kinds: [] };
      el.search.value = '';
      el.search.dispatchEvent(new Event('input', { bubbles: true }));
      render();
    }, true);
  } else {
    button('글 메모', () => app.newMemo(), true);
    button('🎙 음성 메모', () => app.newMemo({ voice: true }));
    if (workLifeOn() && state.mode === 'work') button('정리 도우미로 찾기', () => openHelper());
  }
  el.empty.replaceChildren(art, text, actions);
}

function filterCount() {
  return state.filter.tags.length + state.filter.colors.length + state.filter.kinds.length;
}

export function render() {
  stale = false;
  clearTimeout(staleTimer);
  const narrowed = Boolean(state.query) || filterCount() > 0;
  const pick = { ...state.filter, tags: [...state.filter.tags, ...state.queryTags] };
  const memos = sortMemos(withViews(filterMemos(split(state.results ?? state.memos, state.mode).mine, pick)), sort);
  // 검색어가 다른 모드의 메모에도 걸리면 알려 준다 (누르면 그 모드로)
  const elsewhere = state.query && workLifeOn() ? filterMemos(splitByMode(state.results ?? state.memos, otherMode(state.mode)).mine, pick).length : 0;
  $('other-mode').hidden = !elsewhere || !memos.length; // 하나도 없으면 빈 화면 안내가 대신
  $('other-mode').textContent = elsewhere ? `${MODE_LABEL[otherMode(state.mode)]}에서 ${elsewhere}개 더 찾았어요` : '';
  // 다시 그려도 남은 카드는 옛 자리에서 새 자리로 미끄러진다 (지우기·되돌리기·필터 — 툭 끊겨 바뀌지 않게)
  glideCards(() => layoutCards(memos));
  el.empty.hidden = memos.length > 0;
  el.empty.parentElement.classList.toggle('is-empty', !memos.length); // 안내 · 단추를 목록 칸 가운데에 (PC 와 같이)
  if (!memos.length) renderEmpty(narrowed, elsewhere);
  $('count-memos').textContent = modeMemos().length ? String(modeMemos().length) : '';
  renderFilters();
  if (memos.length >= 2) setTimeout(hintCards, 800);
}

// 카드가 두 개 이상 보일 때 한 번: 옆으로 밀기·꾹 누르기 (눈에 안 보이는 동작)
function hintCards() {
  if (state.tab !== 'memos') return; // 그사이 일정 · 보관함 탭으로 갔으면 다음에 (달력 위에 메모 카드 안내가 뜨지 않게)
  const card = document.querySelector('.item .card');
  if (!card?.getClientRects().length) return; // 목록이 안 보이면 다음에
  hintOnce('card-gestures', '카드를 옆으로 밀면 휴지통으로 가요(되돌릴 수 있어요). 꾹 누르면 색, 고정, 공유 메뉴가 떠요', { anchor: card });
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

function renderFilters() {
  const tags = collectTags(modeMemos());
  for (const t of state.filter.tags) if (!tags.some((x) => sameTag(x.name, t))) tags.unshift({ name: t, count: 0 });
  const picked = (name) => state.filter.tags.some((t) => sameTag(t, name));
  // 고른 태그를 앞으로
  tags.sort((a, b) => Number(picked(b.name)) - Number(picked(a.name)));
  el.tagStrip.hidden = tags.length === 0;
  el.tagStrip.replaceChildren(...tags.map((t) => {
    const count = document.createElement('small');
    count.textContent = String(t.count);
    return chip('tag-chip', [`#${t.name}`, count], picked(t.name), { tag: t.name });
  }));
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

el.tagStrip.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  const i = state.filter.tags.findIndex((t) => sameTag(t, b.dataset.tag));
  if (i >= 0) state.filter.tags.splice(i, 1);
  else {
    state.filter.tags.push(b.dataset.tag);
    tutEvent('tag-filtered');
  }
  render();
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
  el.filterBtn.hidden = tab !== 'memos';
  el.search.placeholder = { memos: '메모나 #태그 검색', reminders: '일정 검색', history: '보관한 알림 검색' }[tab];
  $('fab').hidden = tab === 'history'; // 보관함엔 + 없음. 일정 탭의 + 는 새 일정 (메모 탭과 같은 자리)
  $('fab').setAttribute('aria-label', tab === 'reminders' ? '새 일정' : '새 메모');
  if (tab === 'reminders') $('fab').removeAttribute('aria-haspopup');
  else $('fab').setAttribute('aria-haspopup', 'menu');
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
  if (card) app.openMemo(card.dataset.id, { fromList: true, from: card.getBoundingClientRect() }); // 그 카드가 커지며 메모 화면이 된다
});
// 카드를 옆으로 밀어 지우기 (여러 개를 빨리 지울 때) — 묻지 않고 휴지통으로, 되돌리기 가능
//   카드는 손가락을 프레임마다 한 번만(requestAnimationFrame) 따라가고, 미는 동안은 compositor 층(will-change)이라
//   좌우로 빠르게 흔들어도 끊기지 않는다. 가로 움직임은 브라우저가 화면을 끌지 않게(.card touch-action: pan-y)
//   — 밀기 시작하면 목록 스크롤도 잠근다 (화면 전체가 같이 흔들리지 않게)
let swipe = null;
let swipeFrame = 0;
el.cards.addEventListener('touchstart', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.touches.length !== 1) return;
  swipe = { card, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, active: false, t: e.timeStamp, vx: 0, id: e.touches[0].identifier, w: 1 };
}, { passive: true });
function drawSwipe() {
  swipeFrame = 0;
  if (!swipe?.active) return;
  const { card, dx, w } = swipe;
  // 태블릿: 오른쪽으로 밀면 열기 — 카드는 목록 안에서만 살짝 따라온다 · 지우기는 왼쪽으로만
  const open = isTwoPane() && dx > 0;
  card.classList.toggle('swipe-open', open);
  if (open) {
    const pull = Math.min(dx, w * 0.32) + Math.max(0, dx - w * 0.32) * 0.15;
    card.dataset.openLabel = '열기 ▸';
    card.style.transform = `translate3d(${pull}px, 0, 0)`;
    card.style.opacity = '';
    card.classList.toggle('swipe-ready', dx > w * 0.28);
    return;
  }
  card.style.transform = `translate3d(${dx}px, 0, 0) rotate(${dx / w * 4}deg)`;
  card.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / w * 0.7));
  card.classList.toggle('swipe-ready', Math.abs(dx) > w * 0.38);
}
el.cards.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  // 두 번째 손가락이 닿아도 카드가 튀지 않게 첫 손가락만 따른다
  const t = [...e.touches].find((x) => x.identifier === swipe.id);
  if (!t) return;
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (!swipe.active) {
    // 방향은 손가락이 10px 움직였을 때 한 번만 정한다 — 처음에 살짝 위아래로 흔들려도(비스듬히 밀어도) 가로가 세로의 0.8배 넘으면 밀기
    if (Math.hypot(dx, dy) < 10) return;
    if (Math.abs(dx) < Math.abs(dy) * 0.8) {
      swipe = null; // 세로 = 스크롤
      return;
    }
    // 스크롤이 아직 미끄러지는 중에 누르면 브라우저가 첫 움직임을 막을 수 없게(cancelable=false) 보내도 밀기는 한다
    //   — 아래 swipe-lock 이 목록 스크롤을 멈춰 화면이 같이 움직이지 않는다
    swipe.active = true;
    swipe.menu = false; // 꾹 눌렀다가 밀면 메뉴 대신 밀기
    swipe.x = t.clientX - Math.sign(dx) * Math.min(10, Math.abs(dx)); // 문턱만큼 뛰지 않고 손가락 자리에서 이어서
    swipe.w = swipe.card.offsetWidth || 1; // 크기는 한 번만 읽는다 (움직일 때마다 읽으면 레이아웃을 다시 계산)
    swipe.card.classList.add('swiping');
    el.screen.classList.add('swipe-lock');
  }
  if (e.cancelable) e.preventDefault();
  const nx = t.clientX - swipe.x;
  // 손을 뗄 때의 빠르기 (px/ms) — 짧게 '휙' 밀어도 지워지게
  const dt = e.timeStamp - swipe.t;
  if (dt > 0) swipe.vx = (nx - swipe.dx) / dt;
  swipe.t = e.timeStamp;
  swipe.dx = nx;
  if (!swipeFrame) swipeFrame = requestAnimationFrame(drawSwipe);
}, { passive: false });
function endSwipe(e) {
  if (!swipe) return;
  // 다른 손가락만 뗀 경우는 계속 민다
  if (e?.touches && [...e.touches].some((x) => x.identifier === swipe.id)) return;
  const { card, dx, active, menu } = swipe;
  // 멈췄다가 뗀 건 튕긴 게 아니다
  const vx = e && e.timeStamp - swipe.t < 100 ? swipe.vx : 0;
  swipe = null;
  if (!active) {
    if (menu) {
      // 꾹 누른 채 밀지 않고 뗐으면 메뉴 — 뒤따르는 "눌림" 으로 메모가 열리지 않게 잠깐 막는다
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
  card.classList.remove('swiping', 'swipe-ready', 'swipe-open');
  const w = card.offsetWidth || 1;
  if (opening) {
    card.style.transition = 'transform 0.22s cubic-bezier(0.23, 1, 0.32, 1)';
    card.style.transform = '';
    setTimeout(() => (card.style.transition = ''), 240);
    if (dx > w * 0.28) {
      card.dataset.swiped = '1';
      setTimeout(() => delete card.dataset.swiped, 400);
      haptic(8);
      app.openMemo(card.dataset.id, { fromList: true });
    }
    return;
  }
  // 멀리 밀었거나, 같은 방향으로 휙 튕겼으면 (빠르기 0.11px/ms 넘음 · 너무 짧은 건 빼고) 지운다
  const flick = Math.abs(vx) > 0.11 && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) > w * 0.12;
  if (Math.abs(dx) > w * 0.38 || flick) {
    // 카드가 끝까지 날아간 뒤에 지운다 — 날아가는 중에 목록을 다시 그리면(무거운 일) 카드가 중간에 멈칫했다.
    //   날아가는 동안도 따로 그리는 층(flying: will-change)에 둬 화면 스레드가 바빠도 매끄럽게
    card.classList.add('flying');
    card.style.transition = 'transform 0.2s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.2s cubic-bezier(0.23, 1, 0.32, 1)';
    card.style.transform = `translate3d(${Math.sign(dx) * w * 1.3}px, 0, 0) rotate(${Math.sign(dx) * 8}deg)`;
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
  card.style.transition = 'transform 0.2s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.2s';
  card.style.transform = '';
  card.style.opacity = '';
  setTimeout(() => (card.style.transition = ''), 220);
}
el.cards.addEventListener('touchend', endSwipe);
el.cards.addEventListener('touchcancel', endSwipe);
// 밀어서 지운 카드는 눌린 것으로 치지 않는다
el.cards.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card?.dataset.swiped || card?.classList.contains('swiping')) e.stopImmediatePropagation();
}, true);

// 길게 누르면 메뉴 (고정·색·보내기·지우기)
el.cards.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  if (swipe?.active || card.classList.contains('swiping')) return; // 누른 채 옆으로 밀고 있으면 메뉴는 띄우지 않는다
  haptic(12);
  // 손가락으로 꾹 누른 것이면 메뉴는 뗄 때 — 그 사이 옆으로 밀면 메뉴 대신 밀기 (잠깐 멈췄다 밀어도 밀리게)
  if (swipe && swipe.card.dataset.id === card.dataset.id) { // 목록을 다시 그렸으면 카드 요소가 바뀌었을 수 있어 메모로 비교
    swipe.menu = true;
    return;
  }
  app.memoMenu(card.dataset.id);
});

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
function glideCards(change) {
  const vh = window.innerHeight;
  const near = (r) => r.bottom > -vh && r.top < vh * 2;
  const before = new Map([...el.cards.querySelectorAll('.card')].map((c) => [c.dataset.id, c.getBoundingClientRect()]).filter(([, r]) => r.width));
  change();
  const still = [];
  const moves = [];
  const animate = !reduceMotion() && !calmRender;
  if (calmRender) for (const item of el.cards.querySelectorAll('.item')) item.style.animation = 'none'; // 검색 중: 다시 보인 카드도 튀어나오지 않게
  for (const c of el.cards.querySelectorAll('.card')) {
    const a = before.get(c.dataset.id);
    if (!a) continue;
    still.push(c);
    if (animate && near(a)) moves.push([c, a, c.getBoundingClientRect()]);
  }
  for (const c of still) c.closest('.item').style.animation = 'none'; // 이미 있던 카드는 다시 튀어나오지 않는다 (새 카드만 등장 움직임)
  for (const [c, a, b] of moves) {
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    c.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
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
            return '그림을 복사했어요. 붙여 넣어 보낼 수 있어요';
          } },
          { id: 'save', label: '저장', icon: 'folder', run: async () => {
            const name = await call('saveAs', { name: collageName(o), mime: 'image/png', base64 });
            return name ? `${name}로 저장했어요` : '';
          } },
          { id: 'memo', label: '메모로 만들기', icon: 'note', close: true, run: async () => {
            if (!app.vault) throw new Error('메모 폴더가 아직 없어요');
            const rel = app.vault.saveAttachment(base64Bytes(base64), 'png');
            const id = app.vault.import({ body: collageMemoBody(o.title, rel) });
            if (!id) throw new Error('메모를 만들지 못했어요');
            refresh();
            app.api.memo.open(id);
            return '새 메모로 만들었어요';
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
  const key = (state.results ?? state.memos).map(cardKey).join('\n') + (state.results ? '' : '|all') + state.memos.length;
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

/** 지금 보는 목록 탭 (memos · reminders · history) */
export const currentTab = () => state.tab;

/** 일정 탭의 + : 고른 날에 새 일정 */
export function addEvent() {
  return remindersTab?.addEvent();
}
