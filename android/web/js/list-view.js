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
import { matchChrome, confirmDialog, isTwoPane, toast } from './ui.js';
import { tutEvent } from './tutorial.js';
import { haptic, reduceMotion, tabKeys, syncTabStops, stackCards } from '../../app/js/dom.js';
import { hintOnce, closeHint } from '../../app/js/hints.js';

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
  stackCards(columns, memos.map(renderCard));
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
    ? state.query ? `'${state.query}' 검색 결과가 없어요.` : '조건에 맞는 메모가 없어요.'
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
    button('검색과 필터 풀기', () => {
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
  // 다시 그려도 남은 카드는 옛 자리에서 새 자리로 미끄러진다 (지우기·되돌리기·필터 — 툭 끊겨 바뀌지 않게)
  glideCards(() => layoutCards(memos));
  el.empty.hidden = memos.length > 0;
  el.empty.parentElement.classList.toggle('is-empty', !memos.length); // 안내 · 단추를 목록 칸 가운데에 (PC 와 같이)
  if (!memos.length) renderEmpty(narrowed);
  $('count-memos').textContent = state.memos.length ? String(state.memos.length) : '';
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
  searchTimer = setTimeout(runSearch, 120);
});
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
  el.layoutBtn.hidden = tab !== 'memos'; // 한 줄씩 보기도 메모 탭에서만
  el.search.placeholder = { memos: '메모나 #태그 검색', reminders: '일정 검색', history: '보관한 알림 검색' }[tab];
  $('fab').hidden = tab === 'history'; // 보관함엔 + 없음. 일정 탭의 + 는 새 일정 (메모 탭과 같은 자리)
  $('fab').setAttribute('aria-label', tab === 'reminders' ? '새 일정' : '새 메모');
  if (tab === 'reminders') $('fab').removeAttribute('aria-haspopup');
  else $('fab').setAttribute('aria-haspopup', 'menu');
  if (tab === 'reminders') remindersTab.refresh();
  runSearch();
}
tabKeys(document.querySelector('.tabs'));
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

// ---------- 카드 누르기 · 길게 누르기 ----------

el.cards.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) app.openMemo(card.dataset.id, { fromList: true });
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
    card.style.transition = 'transform 0.18s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.18s cubic-bezier(0.23, 1, 0.32, 1)';
    card.style.transform = `translateX(${Math.sign(dx) * w * 1.3}px) rotate(${Math.sign(dx) * 8}deg)`;
    card.style.opacity = '0';
    card.dataset.swiped = '1';
    setTimeout(() => app.deleteMemo(card.dataset.id), 120);
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
//   재기 → 쓰기를 나눈다: 카드마다 재고 바로 고치면 그때마다 화면 배치를 다시 계산했다 (메모 1,500개에 3초 넘게).
//   미끄러짐은 화면 근처 카드만 (보이지 않는 카드는 움직여도 보이지 않는다)
function glideCards(change) {
  const vh = window.innerHeight;
  const near = (r) => r.bottom > -vh && r.top < vh * 2;
  const before = new Map([...el.cards.querySelectorAll('.card')].map((c) => [c.dataset.id, c.getBoundingClientRect()]).filter(([, r]) => r.width));
  change();
  const still = [];
  const moves = [];
  const animate = !reduceMotion();
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
    c.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: 300, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }
}

el.layoutBtn.addEventListener('click', () => {
  layout = layout === 'rows' ? 'grid' : 'rows';
  tutEvent('layout-changed');
  el.layoutBtn.animate([{ transform: 'rotate(-90deg) scale(0.6)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
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
    countEl: $('count-reminders'),
    notify: (text, isError) => toast(text, isError),
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

/** 지금 보는 목록 탭 (memos · reminders · history) */
export const currentTab = () => state.tab;

/** 일정 탭의 + : 고른 날에 새 일정 */
export function addEvent() {
  return remindersTab?.addEvent();
}
