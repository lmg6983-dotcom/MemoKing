// 메모 목록 화면 — 카드(실제 메모 색) · 검색 · 태그 줄 · 필터 · 알림 예약 탭
import { icon } from '../../app/js/icons.js';
import { formatStamp, friendlyTime } from '../../app/js/core/format.js';
import { vaultUrl } from '../../app/js/media.js';
import { setupRemindersTab } from '../../app/js/list-reminders.js';
import { setupHistoryTab } from '../../app/js/list-history.js';
import { collectTags, filterMemos, parseQuery, KIND_FILTERS, sameTag } from '../../app/js/core/tags.js';
import { COLORS } from '../../app/js/core/memo-file.js';
import { app, COLOR_NAMES } from './state.js';
import { isAllClear } from '../../app/js/core/tasks.js';
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
    // 태그는 아래 줄에 따로 보이므로 미리 보기 글에서는 뺀다
    const tagSet = new Set((memo.tags ?? []).map((t) => t.toLocaleLowerCase('ko')));
    preview.textContent = memo.preview.replace(/(^|\s)#([^\s#]+)/g, (m, sp, t) => (tagSet.has(t.toLocaleLowerCase('ko')) ? sp : m)).replace(/\s{2,}/g, ' ').trim();
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
  if (memo.reminderCount) meta.append(badge('bell', memo.reminderCount));
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
  for (const memo of memos) {
    const shortest = columns.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
    shortest.append(renderCard(memo));
  }
}

new ResizeObserver(() => {
  if (!el.screen.hidden && columnsFor(el.cards.clientWidth) !== lastCols) render();
}).observe(el.cards);

// 빈 목록: 그림 + 다음에 할 일 단추 (검색·필터로 비었으면 풀기, 메모가 없으면 첫 메모 만들기)
function renderEmpty(narrowed) {
  const art = document.createElement('span');
  art.className = 'empty-art';
  art.textContent = narrowed ? '🔍' : '📝';
  const text = document.createElement('span');
  text.textContent = narrowed
    ? state.query ? `"${state.query}" 이(가) 든 메모가 없어요.` : '조건에 맞는 메모가 없어요.'
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
  if (narrowed) {
    button('검색·필터 풀기', () => {
      state.filter = { tags: [], colors: [], kinds: [] };
      el.search.value = '';
      el.search.dispatchEvent(new Event('input', { bubbles: true }));
      render();
    }, true);
  } else {
    button('글 메모', () => app.newMemo(), true);
    button('🎙 음성 메모', () => app.newMemo({ voice: true }));
  }
  el.empty.replaceChildren(art, text, actions);
}

function filterCount() {
  return state.filter.tags.length + state.filter.colors.length + state.filter.kinds.length;
}

export function render() {
  const narrowed = Boolean(state.query) || filterCount() > 0;
  const memos = filterMemos(state.results ?? state.memos, { ...state.filter, tags: [...state.filter.tags, ...state.queryTags] });
  layoutCards(memos);
  el.empty.hidden = memos.length > 0;
  if (!memos.length) renderEmpty(narrowed);
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
// 카드를 옆으로 밀어 지우기 (여러 개를 빨리 지울 때) — 묻지 않고 휴지통으로, 되돌리기 가능
let swipe = null;
el.cards.addEventListener('touchstart', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.touches.length !== 1) return;
  swipe = { card, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, active: false };
}, { passive: true });
el.cards.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
      swipe = null; // 세로 = 스크롤
      return;
    }
    if (Math.abs(dx) < 14) return;
    swipe.active = true;
    swipe.card.classList.add('swiping');
  }
  e.preventDefault();
  swipe.dx = dx;
  const w = swipe.card.offsetWidth || 1;
  const ready = Math.abs(dx) > w * 0.38;
  swipe.card.style.transform = `translateX(${dx}px) rotate(${dx / w * 4}deg)`;
  swipe.card.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / w * 0.7));
  swipe.card.classList.toggle('swipe-ready', ready);
}, { passive: false });
function endSwipe() {
  if (!swipe) return;
  const { card, dx, active } = swipe;
  swipe = null;
  if (!active) return;
  card.classList.remove('swiping', 'swipe-ready');
  const w = card.offsetWidth || 1;
  if (Math.abs(dx) > w * 0.38) {
    card.style.transition = 'transform 0.18s ease-in, opacity 0.18s ease-in';
    card.style.transform = `translateX(${Math.sign(dx) * w * 1.3}px) rotate(${Math.sign(dx) * 8}deg)`;
    card.style.opacity = '0';
    card.dataset.swiped = '1';
    setTimeout(() => app.deleteMemo(card.dataset.id), 120);
    return;
  }
  card.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s';
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
// 카드들이 새 자리로 미끄러져 간다 (FLIP: 옛 자리 → 새 자리) — 모양이 바뀐 것을 눈으로 따라갈 수 있게
function glideCards(change) {
  const before = new Map([...el.cards.querySelectorAll('.card')].map((c) => [c.dataset.id, c.getBoundingClientRect()]));
  change();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const c of el.cards.querySelectorAll('.card')) {
    const a = before.get(c.dataset.id);
    if (!a) continue;
    const b = c.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    c.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: 320, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' });
  }
}

el.layoutBtn.addEventListener('click', () => {
  layout = layout === 'rows' ? 'grid' : 'rows';
  el.layoutBtn.animate([{ transform: 'rotate(-90deg) scale(0.6)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.3, 1.4, 0.5, 1)' });
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

// ---------- 밖에서 쓰는 것 ----------

export function setup() {
  remindersTab = setupRemindersTab({
    api: app.api,
    container: $('reminder-groups'),
    empty: $('reminders-empty'),
    countEl: $('count-reminders'),
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

/** 지우는 카드가 옆으로 밀려 접히며 사라진다 */
export async function animateRemove(id, { dir = 1 } = {}) {
  const card = el.cards.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  const item = card?.closest('.item');
  if (!item) return;
  item.style.height = `${item.offsetHeight}px`;
  item.style.setProperty('--fly', `${dir * 110}%`);
  void item.offsetHeight;
  item.classList.add('removing');
  await new Promise((r) => setTimeout(r, 280));
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
