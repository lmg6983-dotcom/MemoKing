// 메모 목록 화면 — 카드(실제 메모 색) · 검색 · 태그 줄 · 필터 · 알림 예약 탭
import { icon } from '../../app/js/icons.js';
import { formatStamp } from '../../app/js/core/format.js';
import { vaultUrl } from '../../app/js/media.js';
import { setupRemindersTab } from '../../app/js/list-reminders.js';
import { setupHistoryTab } from '../../app/js/list-history.js';
import { collectTags, filterMemos, parseQuery, KIND_FILTERS, sameTag } from '../../app/js/core/tags.js';
import { COLORS } from '../../app/js/core/memo-file.js';
import { app, COLOR_NAMES } from './state.js';
import { matchChrome, confirmDialog } from './ui.js';

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
  layoutBtn: $('layout-btn'),
};

let layout = 'grid';
const state = {
  memos: [],
  results: null, // 글자 검색 결과 (없으면 전체)
  query: '',
  queryTags: [],
  filter: { tags: [], colors: [], kinds: [] },
  tab: 'memos',
};

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
  if (memo.pinned) head.append(badge('pin-fill', '', 'pin'));
  card.append(head);

  if (memo.preview) {
    const preview = document.createElement('div');
    preview.className = 'card-preview';
    preview.textContent = memo.preview;
    card.append(preview);
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

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const tags = document.createElement('div');
  tags.className = 'card-tags';
  tags.textContent = (memo.tags ?? []).map((t) => `#${t}`).join(' ');
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  if (memo.reminderCount) meta.append(badge('bell', memo.reminderCount));
  if (memo.hasAudio) meta.append(badge('audio', ''));
  if (memo.hasVideo) meta.append(badge('video', ''));
  if (memo.hasFile) meta.append(badge('clip', ''));
  if (memo.linkCount) meta.append(badge('link', memo.linkCount));
  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatStamp(memo.updated);
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
  for (const memo of memos) {
    const shortest = columns.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
    shortest.append(renderCard(memo));
  }
}

new ResizeObserver(() => {
  if (!el.screen.hidden && columnsFor(el.cards.clientWidth) !== lastCols) render();
}).observe(el.cards);

function filterCount() {
  return state.filter.tags.length + state.filter.colors.length + state.filter.kinds.length;
}

export function render() {
  const narrowed = Boolean(state.query) || filterCount() > 0;
  const memos = filterMemos(state.results ?? state.memos, { ...state.filter, tags: [...state.filter.tags, ...state.queryTags] });
  layoutCards(memos);
  el.empty.hidden = memos.length > 0;
  el.empty.textContent = narrowed
    ? '조건에 맞는 메모가 없어요.'
    : '아직 메모가 없어요.\n오른쪽 아래 + 버튼으로 첫 메모를 만들어 보세요.';
  $('count-memos').textContent = state.memos.length ? String(state.memos.length) : '';
  renderFilters();
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
  const tags = collectTags(state.memos);
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
  el.filterBtn.classList.toggle('on', n > 0);
  el.filterSummary.hidden = n === 0;
  const parts = [
    ...state.filter.tags.map((t) => `#${t}`),
    ...state.filter.colors.map((c) => COLOR_NAMES[c] ?? c),
    ...state.filter.kinds.map((kid) => KIND_FILTERS.find((k) => k.id === kid)?.label ?? kid),
  ];
  el.filterSummaryText.textContent = `필터 ${n}개 · ${parts.join(', ')}`;
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
  else state.filter.tags.push(b.dataset.tag);
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
  searchTimer = setTimeout(runSearch, 120);
});
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.search.blur(); // 키보드 내리기
});

// ---------- 탭 ----------

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('view-memos').hidden = tab !== 'memos';
  $('view-reminders').hidden = tab !== 'reminders';
  $('view-history').hidden = tab !== 'history';
  el.filterBtn.hidden = tab !== 'memos';
  el.search.placeholder = { memos: '메모 검색 · #태그', reminders: '알림 검색', history: '보관한 알림 검색' }[tab];
  $('fab').hidden = tab === 'history';
  if (tab === 'reminders') remindersTab.refresh();
  runSearch();
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

// ---------- 카드 누르기 · 길게 누르기 ----------

el.cards.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) app.openMemo(card.dataset.id);
});
// 길게 누르면 메뉴 (고정·색·보내기·지우기)
el.cards.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  navigator.vibrate?.(12);
  app.memoMenu(card.dataset.id);
});

// ---------- 카드 모양 (격자 / 한 줄씩) ----------

function applyLayout(layout) {
  el.cards.dataset.layout = layout;
  el.layoutBtn.replaceChildren(icon(layout === 'rows' ? 'grid' : 'rows'));
  el.layoutBtn.setAttribute('aria-label', layout === 'rows' ? '두 줄 격자로 보기' : '한 줄씩 보기');
}
try {
  layout = localStorage.getItem('memoking.layout') ?? 'grid';
} catch {
  // 기본
}
applyLayout(layout);
el.layoutBtn.addEventListener('click', () => {
  layout = layout === 'rows' ? 'grid' : 'rows';
  applyLayout(layout);
  render();
  try {
    localStorage.setItem('memoking.layout', layout);
  } catch {
    // 무시
  }
});

// ---------- 밖에서 쓰는 것 ----------

export function setup() {
  remindersTab = setupRemindersTab({
    api: app.api,
    container: $('reminder-groups'),
    empty: $('reminders-empty'),
    countEl: $('count-reminders'),
  });
  $('fab').addEventListener('click', () => app.newMemo());
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
}

/** 알림 보관함 탭이 보이면 다시 그린다 (새 알림·설정에서 돌아옴) */
export function refreshHistory() {
  if (state.tab === 'history') historyTab?.refresh();
}

export function refresh() {
  if (!app.vault) return;
  state.memos = app.vault.list();
  if (state.query) {
    const { text } = parseQuery(state.query);
    state.results = text ? app.vault.search(text) : null;
  }
  render();
  remindersTab?.refresh();
}

export function show() {
  const wasHidden = el.screen.hidden;
  el.screen.hidden = false;
  if (wasHidden) render(); // 숨어 있던 동안에는 카드 높이를 잴 수 없어 다시 쌓는다
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
