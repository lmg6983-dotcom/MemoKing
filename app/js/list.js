// 메모 목록 창 — 폴더 지정, 메모 카드 목록, 검색, 새 메모.
import { injectIcons, icon } from './icons.js';
import { formatStamp } from './core/format.js';
import { chooseDensity } from './core/list-density.js';
import { vaultUrl } from './media.js';
import { setupRemindersTab } from './list-reminders.js';
import { setupHistoryTab } from './list-history.js';
import { collectTags, filterMemos, parseQuery, KIND_FILTERS, sameTag } from './core/tags.js';
import { COLORS } from './core/memo-file.js';
import { setupCoach } from './coach.js';
import { stepZoom, clampZoom, zoomLabel } from './core/zoom.js';

const api = window.memoking;
const $ = (id) => document.getElementById(id);
const el = {
  setup: $('setup'),
  suggested: $('suggested-path'),
  useSuggested: $('use-suggested'),
  chooseFolder: $('choose-folder'),
  setupError: $('setup-error'),
  main: $('main'),
  newBtn: $('new-btn'),
  search: $('search'),
  settingsBtn: $('settings-btn'),
  cards: $('cards'),
  empty: $('empty'),
  count: $('count'),
  settings: $('settings-dialog'),
  vaultPath: $('vault-path'),
  version: $('version'),
  confirm: $('confirm-dialog'),
  confirmMessage: $('confirm-message'),
  dragHint: $('drag-hint'),
  filterBtn: $('filter-btn'),
  filterCount: $('filter-count'),
  filterPanel: $('filter-panel'),
  colorFilter: $('color-filter'),
  kindFilter: $('kind-filter'),
  tagStrip: $('tag-strip'),
  filterSummary: $('filter-summary'),
  filterSummaryText: $('filter-summary-text'),
};

const state = {
  info: null, memos: [], results: null, query: '', queryTags: [], droppedId: null, droppedUntil: 0,
  // 필터 (창을 닫으면 잊는다): 태그는 모두 가진 메모, 색은 그중 하나, 담긴 것은 모두 해당
  filter: { tags: [], colors: [], kinds: [] },
};
let searchTimer = null;

// ---------- 화면 전환 ----------

function applyInfo(info) {
  state.info = info;
  const ready = Boolean(info.vaultPath);
  el.setup.hidden = ready;
  el.main.hidden = !ready;
  el.suggested.textContent = info.suggestedPath;
  el.setupError.hidden = !info.vaultError;
  el.setupError.textContent = info.vaultError ?? '';
  el.vaultPath.textContent = info.vaultPath ?? '';
  el.version.textContent = `메모킹 v${info.version}`;
}

// ---------- 목록 ----------

let renderPending = false;

function render() {
  // 끄는 중에 카드를 다시 그리면 잡고 있던 카드가 사라지므로, 끝난 뒤로 미룬다.
  if (press?.dragging) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const narrowed = Boolean(state.query) || filterCount() > 0;
  const memos = filterMemos(state.results ?? state.memos, { ...state.filter, tags: [...state.filter.tags, ...state.queryTags] });
  const before = cardRects();
  el.cards.replaceChildren(...memos.map(renderCard));
  applyDensity();
  animateCards(before);
  el.empty.hidden = memos.length > 0;
  el.empty.textContent = narrowed
    ? '조건에 맞는 메모가 없어요.'
    : '아직 메모가 없어요.\n+ 버튼(Ctrl+N)으로 첫 메모를 만들어 보세요.';
  el.count.textContent = narrowed ? `메모 ${state.memos.length}개 중 ${memos.length}개` : `메모 ${state.memos.length}개`;
  renderFilters();
}

// ---------- 움직임 (디자인 시스템: 짧고 조용하게, 움직임 줄이기 존중) ----------

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
let firstCards = true;

function cardRects() {
  const map = new Map();
  for (const li of el.cards.children) {
    const id = li.querySelector('.card')?.dataset.id;
    if (id) map.set(id, li.getBoundingClientRect());
  }
  return map;
}

// 고정·필터·검색으로 순서가 바뀌면 카드가 새 자리로 미끄러진다. 새로 나타난 카드는 흐릿→선명·살짝 커짐.
function animateCards(before) {
  const first = firstCards;
  firstCards = false;
  if (reduceMotion() || document.hidden) return;
  [...el.cards.children].forEach((li, i) => {
    const id = li.querySelector('.card')?.dataset.id;
    const old = before.get(id);
    if (old) {
      const now = li.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        li.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: EASE });
      }
    } else if (first || before.size) {
      // 처음 열 때는 위에서부터 차례로, 그 뒤엔 새로 생긴 카드만
      li.animate([{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
        { duration: 200, easing: EASE, delay: first ? Math.min(i, 10) * 18 : 0, fill: 'backwards' });
    }
  });
}

// ---------- 필터: 태그 줄 · 색 · 담긴 것 ----------

const COLOR_LABEL = { yellow: '노랑', green: '초록', pink: '분홍', purple: '보라', blue: '파랑', gray: '회색', charcoal: '검정' };
const filterCount = () => state.filter.tags.length + state.filter.colors.length + state.filter.kinds.length;

function toggleIn(list, value, same = (a, b) => a === b) {
  const i = list.findIndex((v) => same(v, value));
  if (i >= 0) list.splice(i, 1);
  else list.push(value);
}

function toggleTagFilter(name, { only = false } = {}) {
  if (only) {
    // 카드의 태그를 누르면: 이미 걸려 있으면 그대로, 아니면 그 태그를 더한다
    if (!state.filter.tags.some((t) => sameTag(t, name))) state.filter.tags.push(name);
  } else toggleIn(state.filter.tags, name, sameTag);
  render();
}

function chip(className, label, pressed, data) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.setAttribute('aria-pressed', String(pressed));
  Object.assign(b.dataset, data);
  if (typeof label === 'string') b.textContent = label;
  else b.append(...label);
  return b;
}

function renderFilters() {
  const tags = collectTags(state.memos);
  // 골라 둔 태그가 지금은 없더라도 줄에 남겨 풀 수 있게
  for (const t of state.filter.tags) if (!tags.some((x) => sameTag(x.name, t))) tags.unshift({ name: t, count: 0 });
  const picked = (name) => state.filter.tags.some((t) => sameTag(t, name));
  el.tagStrip.hidden = tags.length === 0;
  el.tagStrip.replaceChildren(...tags.map((t) => {
    const count = document.createElement('small');
    count.textContent = String(t.count);
    return chip('tag-chip', [`#${t.name}`, count], picked(t.name), { tag: t.name });
  }));
  el.colorFilter.replaceChildren(...COLORS.map((c) => {
    const b = chip('color-dot', '', state.filter.colors.includes(c), { filterColor: c, color: c });
    b.title = COLOR_LABEL[c] ?? c;
    b.setAttribute('aria-label', `${COLOR_LABEL[c] ?? c} 메모`);
    return b;
  }));
  el.kindFilter.replaceChildren(...KIND_FILTERS.map((k) => chip('filter-chip', k.label, state.filter.kinds.includes(k.id), { kind: k.id })));
  const n = filterCount();
  el.filterCount.textContent = n ? String(n) : '';
  el.filterBtn.classList.toggle('active', n > 0);
  el.filterSummary.hidden = n === 0;
  const parts = [
    ...state.filter.tags.map((t) => `#${t}`),
    ...state.filter.colors.map((c) => COLOR_LABEL[c] ?? c),
    ...state.filter.kinds.map((id) => KIND_FILTERS.find((k) => k.id === id)?.label ?? id),
  ];
  el.filterSummaryText.textContent = `필터 ${n}개 · ${parts.join(', ')}`;
}

el.tagStrip.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (b) toggleTagFilter(b.dataset.tag);
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
el.filterBtn.addEventListener('click', async () => {
  const open = el.filterPanel.hidden;
  el.filterBtn.setAttribute('aria-expanded', String(open));
  const p = el.filterPanel;
  if (open) p.hidden = false;
  if (!reduceMotion()) {
    const h = p.scrollHeight;
    const frames = [{ height: '0px', opacity: 0, marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' }, { height: `${h}px`, opacity: 1 }];
    await p.animate(open ? frames : frames.slice().reverse(), { duration: 200, easing: EASE }).finished.catch(() => {});
  }
  if (!open) p.hidden = true;
});
$('filter-clear').addEventListener('click', () => {
  state.filter = { tags: [], colors: [], kinds: [] };
  render();
});

function renderCard(memo) {
  const li = document.createElement('li');
  const card = document.createElement('button');
  const justDropped = memo.id === state.droppedId && Date.now() < state.droppedUntil;
  card.className = `card${memo.open ? ' open' : ''}${justDropped ? ' dropped' : ''}`;
  card.dataset.id = memo.id;
  card.dataset.color = memo.color; // 카드 바탕·글씨 = 실제 메모 창의 색
  card.title = '눌러서 열어요. 목록 밖으로 끌어 놓으면 그 자리에 열려요';

  // 제목 줄: (고정 압정) 제목
  const head = document.createElement('div');
  head.className = 'card-head';
  if (memo.pinned) head.append(badge('pin-fill', '', 'pin'));
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = memo.title;
  head.append(title);
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

  // 아랫줄 하나: 왼쪽 태그(누르면 그 태그로 거르기), 오른쪽 표시 · 마지막 고친 시각(작게)
  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const tags = document.createElement('div');
  tags.className = 'card-tags';
  for (const name of memo.tags ?? []) {
    const t = document.createElement('span');
    t.className = 'card-tag';
    t.dataset.cardTag = name;
    t.title = `#${name} 태그만 보기`;
    t.textContent = `#${name}`;
    tags.append(t);
  }
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  if (memo.reminderCount) meta.append(badge('bell', memo.reminderCount));
  if (memo.hasAudio) meta.append(badge('audio', ''));
  if (memo.hasVideo) meta.append(badge('video', ''));
  if (memo.hasFile) meta.append(badge('clip', ''));
  if (memo.linkCount) meta.append(badge('link', memo.linkCount));
  if (memo.stack) meta.append(badge('tabs', memo.stack, 'stack'));
  foot.append(tags, meta);
  // 태그·표시가 있을 때만 아랫줄 (없으면 한 줄 아낌)
  if (tags.childElementCount || meta.childElementCount) card.append(foot);

  const del = document.createElement('button');
  del.className = 'icon-btn danger card-delete';
  del.title = '지우기';
  del.setAttribute('aria-label', `${memo.title} 지우기`);
  del.dataset.delete = memo.id;
  del.append(icon('trash'));

  // 목록 맨 위에 고정 (압정)
  const pin = document.createElement('button');
  pin.className = `icon-btn card-pin${memo.pinned ? ' on' : ''}`;
  pin.title = memo.pinned ? '목록 맨 위 고정 풀기' : '목록 맨 위에 고정';
  pin.setAttribute('aria-label', `${memo.title} ${pin.title}`);
  pin.setAttribute('aria-pressed', String(Boolean(memo.pinned)));
  pin.dataset.pin = memo.id;
  pin.append(icon(memo.pinned ? 'pin-fill' : 'pin'));

  // 마우스를 올리면 카드 오른쪽 위에 뜨는 버튼 묶음 (그동안 제목은 묶음 앞에서 줄임표)
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  // PDF 로 저장
  const pdf = document.createElement('button');
  pdf.className = 'icon-btn card-pdf';
  pdf.title = 'PDF로 저장';
  pdf.setAttribute('aria-label', `${memo.title} PDF로 저장`);
  pdf.dataset.pdf = memo.id;
  pdf.append(icon('pdf'));
  actions.append(pdf, pin, del);

  // 마지막으로 고친 때: 카드 밖, 카드와 카드 사이 틈에 작게
  const stamp = document.createElement('span');
  stamp.className = 'card-stamp';
  stamp.textContent = formatStamp(memo.updated);
  stamp.title = `마지막으로 고친 때 ${new Date(memo.updated).toLocaleString('ko-KR')}`;

  li.append(card, stamp, actions);
  return li;
}

function badge(name, text, extra = '') {
  const span = document.createElement('span');
  span.className = `card-badge ${extra}`;
  span.append(icon(name));
  if (text !== '') span.append(String(text));
  return span;
}

async function refresh() {
  state.memos = await api.memos.list();
  await runSearch();
}

// 검색창은 지금 보고 있는 탭을 검색한다
async function runSearch() {
  if (activeTab === 'reminders') return remindersTab.setQuery(el.search.value);
  if (activeTab === 'history') return historyTab.setQuery(el.search.value);
  state.query = el.search.value.trim();
  // 검색어의 #태그 는 태그 필터로, 나머지는 글자 검색으로
  const { text, tags } = parseQuery(state.query);
  state.queryTags = tags;
  state.results = text ? await api.memos.search(text) : null;
  render();
}

// ---------- 동작 ----------

function confirmDialog(message, okLabel = '지우기') {
  el.confirmMessage.textContent = message;
  $('confirm-ok').textContent = okLabel;
  el.confirm.returnValue = '';
  el.confirm.showModal();
  $('confirm-ok').focus();
  return new Promise((resolve) => {
    el.confirm.addEventListener('close', () => resolve(el.confirm.returnValue === 'ok'), { once: true });
  });
}

async function deleteMemo(id) {
  const memo = state.memos.find((m) => m.id === id);
  if (!memo) return;
  const ok = await confirmDialog(`"${memo.title}" 메모를 지울까요?\n지운 메모는 메모 폴더 안 휴지통에 보관돼요.`);
  if (!ok) return;
  const li = el.cards.querySelector(`.card[data-id="${id}"]`)?.closest('li');
  if (li && !reduceMotion()) {
    await li.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 160, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {});
  }
  await api.memo.remove(id);
}

el.useSuggested.addEventListener('click', async () => applyInfo(await api.vault.use(state.info.suggestedPath)));
el.chooseFolder.addEventListener('click', async () => applyInfo(await api.vault.choose()));
el.newBtn.addEventListener('click', () => api.memo.create());
el.settingsBtn.addEventListener('click', async () => {
  await loadSettings();
  el.settings.showModal();
});

// ---------- 설정: 자동 실행 · 알림 보관 ----------

async function loadSettings() {
  const s = await api.settings.get();
  const auto = $('auto-start');
  auto.checked = s.autoStart.enabled;
  auto.disabled = !s.autoStart.available;
  $('auto-start-note').textContent = s.autoStart.available ? '작업 표시줄 알림 영역에서 조용히 시작해요' : '설치한 메모킹에서 쓸 수 있어요';
  $('history-enabled').checked = s.historyEnabled;
  showQuickMemo(s.quickMemo);
  $('trash-days').value = String(s.trashDays);
  $('trash-count').textContent = s.trashCount ? String(s.trashCount) : '';
}
function showQuickMemo(q) {
  $('quick-memo').checked = q.enabled && q.registered;
  $('quick-memo-note').textContent = q.enabled && !q.registered
    ? '다른 프로그램이 이 단축키를 쓰고 있어서 켜지 못했어요'
    : '어디서든 고른 내용을 바로 메모로 만들어요. 두 번 누르면 화면 영역 캡처';
}
$('quick-memo').addEventListener('change', async (e) => showQuickMemo(await api.settings.setQuickMemo(e.target.checked)));
$('auto-start').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setAutoStart(e.target.checked);
});
$('history-enabled').addEventListener('change', async (e) => {
  e.target.checked = await api.history.setEnabled(e.target.checked);
  historyTab.refresh();
});

// ---------- 탭: 메모 · 알림 예약 · 알림 보관함 ----------

const TAB_PLACEHOLDER = { memos: '메모 검색 (Ctrl+F)', reminders: '알림 검색', history: '보관한 알림 검색' };
let activeTab = 'memos';

const remindersTab = setupRemindersTab({
  api, container: $('reminder-groups'), empty: $('reminders-empty'), countEl: $('count-reminders'),
});
const historyTab = setupHistoryTab({
  api,
  confirm: confirmDialog,
  els: {
    consent: $('history-consent'), body: $('history-body'), enable: $('history-enable'),
    clear: $('history-clear'), app: $('history-app'), rows: $('history-rows'), empty: $('history-empty'),
  },
});

const tabIndicator = document.createElement('span');
tabIndicator.className = 'tab-indicator';
document.querySelector('.tabs')?.prepend(tabIndicator);
function moveTabIndicator() {
  const sel = document.querySelector('.tabs [aria-selected="true"]');
  if (!sel || !sel.offsetWidth) return;
  tabIndicator.style.width = `${sel.offsetWidth}px`;
  tabIndicator.style.transform = `translateX(${sel.offsetLeft}px)`;
}
new ResizeObserver(moveTabIndicator).observe(document.querySelector('.tabs'));

function showTab(tab) {
  if (!TAB_PLACEHOLDER[tab]) return;
  activeTab = tab;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  moveTabIndicator();
  for (const name of Object.keys(TAB_PLACEHOLDER)) $(`view-${name}`).hidden = name !== tab;
  document.body.dataset.tab = tab;
  el.search.placeholder = TAB_PLACEHOLDER[tab];
  el.search.value = '';
  if (tab === 'memos') runSearch();
  if (tab === 'reminders') {
    remindersTab.setQuery('');
    remindersTab.refresh();
  }
  if (tab === 'history') historyTab.setQuery('');
}
for (const b of document.querySelectorAll('.tabs [data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
api.on('list:tab', showTab);
api.on('reminders:changed', () => remindersTab.refresh());
api.on('history:changed', () => activeTab === 'history' && historyTab.refresh());
$('reveal-vault').addEventListener('click', () => api.vault.reveal());
$('change-vault').addEventListener('click', async () => {
  el.settings.close();
  applyInfo(await api.vault.choose());
});

el.cards.addEventListener('click', (e) => {
  if (suppressClick) {
    suppressClick = false; // 끌기가 끝난 직후의 클릭은 무시
    return;
  }
  const del = e.target.closest('[data-delete]');
  if (del) return deleteMemo(del.dataset.delete);
  const pdfBtn = e.target.closest('[data-pdf]');
  if (pdfBtn) return api.pdf.open(pdfBtn.dataset.pdf);
  const pinBtn = e.target.closest('[data-pin]');
  if (pinBtn) {
    const m = state.memos.find((x) => x.id === pinBtn.dataset.pin);
    if (!m) return;
    // 목록이 새로 오기 전에 한 번 더 눌러도 맞게 되도록 바로 바꿔 보여 준다
    m.pinned = !m.pinned;
    render();
    return api.memo.set(m.id, { pinned: m.pinned });
  }
  const cardTag = e.target.closest('[data-card-tag]');
  if (cardTag) return toggleTagFilter(cardTag.dataset.cardTag, { only: true });
  const card = e.target.closest('.card');
  if (card) api.memo.open(card.dataset.id);
});

// ---------- 카드를 끌어 화면에 놓기 ----------
// 목록 안: 카드 복제본이 커서를 따라온다. 목록 밖: 메인 프로세스가 실제 크기의 미리보기 창을 띄운다.
// 포인터 캡처 덕분에 커서가 창 밖에 있어도 이동·놓기 이벤트를 계속 받는다.

const DRAG_THRESHOLD = 6;
let press = null; // { id, card, x, y, pointerId, dragging, clone }
let suppressClick = false;

function beginDrag() {
  const { card } = press;
  const rect = card.getBoundingClientRect();
  const clone = card.cloneNode(true);
  clone.classList.add('drag-clone');
  clone.classList.remove('open');
  Object.assign(clone.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
  // 커서가 잡은 지점을 기준으로 기울어지게
  clone.style.transformOrigin = `${press.x - rect.left}px ${press.y - rect.top}px`;
  document.body.append(clone);
  card.classList.add('drag-source');
  document.body.classList.add('is-dragging');
  el.dragHint.textContent = '목록 밖으로 끌어내면 그 자리에 열려요';
  press.clone = clone;
  press.dragging = true;
  api.drag.start(press.id);
}

async function finishDrag(p, point) {
  const result = await api.drag.end(point);
  document.body.classList.remove('is-dragging', 'drag-outside');
  const { clone, card } = p;
  if (result.opened) {
    // 밖으로 날아가 열린 경우: 복제본은 사라지고, 카드가 한 번 반짝인다
    clone.classList.add('drop-out');
    card.classList.remove('drag-source');
    state.droppedId = p.id;
    state.droppedUntil = Date.now() + 700;
    card.classList.add('dropped');
  } else {
    // 취소: 복제본이 제자리로 돌아간다
    clone.classList.add('returning');
    clone.style.transform = '';
  }
  const cleanup = () => {
    clone.remove();
    card.classList.remove('drag-source');
  };
  clone.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 400);
  if (renderPending) render();
}

el.cards.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('[data-delete], [data-pin], [data-pdf]')) return;
  const card = e.target.closest('.card');
  if (!card || press) return;
  press = { id: card.dataset.id, card, x: e.clientX, y: e.clientY, pointerId: e.pointerId, dragging: false, clone: null };
  try {
    card.setPointerCapture(e.pointerId);
  } catch {
    // 합성 이벤트 등 캡처할 수 없는 포인터
  }
});

el.cards.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;
  if (!press.dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    beginDrag();
  }
  press.clone.style.transform = `translate(${dx}px, ${dy}px) rotate(-2deg) scale(1.03)`;
  api.drag.move(e.screenX, e.screenY);
});

el.cards.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  const p = press;
  press = null;
  if (!p.dragging) return; // 그냥 클릭 → click 이벤트가 연다
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  finishDrag(p, { x: e.screenX, y: e.screenY });
});

el.cards.addEventListener('dragstart', (e) => e.preventDefault()); // 브라우저 기본 드래그 끄기

el.cards.addEventListener('pointercancel', () => {
  if (!press) return;
  const p = press;
  press = null;
  if (p.dragging) finishDrag(p, null);
});

function cancelDrag() {
  if (!press?.dragging) return false;
  const p = press;
  press = null;
  finishDrag(p, null);
  return true;
}

api.on('drag:state', ({ outside }) => {
  document.body.classList.toggle('drag-outside', outside);
  el.dragHint.textContent = outside ? '놓으면 여기에 열려요 · 취소는 Esc' : '목록 밖으로 끌어내면 그 자리에 열려요';
});

el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cancelDrag()) return;
  if (el.settings.open || el.confirm.open || el.main.hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyN') {
    e.preventDefault();
    api.memo.create();
  } else if (mod && e.code === 'KeyF') {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  } else if (e.key === 'Escape' && document.activeElement === el.search) {
    el.search.value = '';
    runSearch();
  }
});

api.on('memos:changed', (memos) => {
  state.memos = memos;
  $('count-memos').textContent = String(memos.length);
  if (activeTab !== 'memos') return remindersTab.refresh(); // 메모 제목이 바뀌면 알림 탭에도
  if (state.query) runSearch();
  else render();
});
api.on('vault:opened', (info) => {
  applyInfo(info);
  refresh();
});

// ---------- 시작 ----------

injectIcons();
setupCoach(api);
// 카드 모양: 목록 크기를 보고 한 화면에 메모 8개 이상 들어가게 (넉넉 · 보통 · 촘촘, 넓으면 여러 열). 창 크기를 바꾸면 바로.
let densityFrame = 0;
function applyDensity() {
  densityFrame = 0;
  const cs = getComputedStyle(el.cards);
  const width = el.cards.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const height = el.cards.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (width <= 0 || height <= 0) return;
  const d = chooseDensity({ width, height }, el.cards.children.length);
  const set = (name, value) => {
    if (el.cards.style.getPropertyValue(name) !== value) el.cards.style.setProperty(name, value);
  };
  if (el.cards.dataset.density !== d.mode) el.cards.dataset.density = d.mode;
  set('--cols', String(d.cols));
  set('--preview-lines', String(Math.max(1, d.previewLines)));
  set('--thumb-h', `${d.thumbHeight}px`);
  // 메모가 적으면 목록 높이를 같은 높이로 나눠 채운다
  // 남는 몇 px 까지 똑같이 나누되, 카드 내용보다 낮아지지는 않게 (창이 작으면 목록이 스크롤 — 카드가 넘쳐 틈의 스탬프와 겹치지 않게)
  set('--row-h', d.fill ? 'minmax(min-content, 1fr)' : 'auto');
  el.cards.classList.toggle('fill', d.fill);
}
// ---------- 메모 카드 확대·축소 (Ctrl+마우스 휠, Ctrl+= / Ctrl+-) — 메모 창과 같은 단계, 이 PC 에 기억 ----------
// 카드 목록만 확대한다 (위 막대·탭·검색은 그대로). 크게 하면 한 화면에 들어가는 카드가 줄어 모양(넉넉·보통·촘촘)도 따라 바뀐다.
const LIST_ZOOM_KEY = 'memoking.listZoom';
let listZoom = 1;
try {
  listZoom = clampZoom(localStorage.getItem(LIST_ZOOM_KEY) ?? 1);
} catch {
  // 저장소를 못 써도 100% 로
}
const listZoomBadge = document.createElement('div');
listZoomBadge.className = 'zoom-badge';
listZoomBadge.setAttribute('role', 'status');
const listZoomText = document.createElement('span');
const listZoomReset = document.createElement('button');
listZoomReset.type = 'button';
listZoomReset.textContent = '원래대로';
listZoomReset.addEventListener('click', () => setListZoom(1));
listZoomBadge.append(listZoomText, listZoomReset);
document.body.append(listZoomBadge);
let listZoomTimer = 0;
function setListZoom(z, { show = true } = {}) {
  listZoom = clampZoom(z);
  el.cards.style.zoom = listZoom === 1 ? '' : String(listZoom);
  document.body.dataset.listZoom = String(listZoom);
  try {
    if (listZoom === 1) localStorage.removeItem(LIST_ZOOM_KEY);
    else localStorage.setItem(LIST_ZOOM_KEY, String(listZoom));
  } catch {
    // 기억 못 해도 지금 창에서는 그대로
  }
  if (!densityFrame) densityFrame = requestAnimationFrame(applyDensity);
  if (!show) return;
  listZoomText.textContent = `메모 ${zoomLabel(listZoom)}`;
  listZoomReset.hidden = listZoom === 1;
  listZoomBadge.classList.add('show');
  clearTimeout(listZoomTimer);
  listZoomTimer = setTimeout(() => listZoomBadge.classList.remove('show'), 1600);
}
setListZoom(listZoom, { show: false });
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault(); // 창 전체(Chromium) 확대는 막는다
  if (e.deltaY) setListZoom(stepZoom(listZoom, e.deltaY < 0 ? 1 : -1));
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.shiftKey && e.code !== 'Equal')) return;
  if (e.target.closest?.('input, textarea, [contenteditable="true"]') && e.code !== 'Equal' && e.code !== 'Minus') return;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setListZoom(stepZoom(listZoom, 1));
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') setListZoom(stepZoom(listZoom, -1));
  else return;
  e.preventDefault();
});

// 크기가 바뀌면 다음 화면에서 한 번만 (모양을 바꾸며 생기는 크기 변화가 다시 불러들이지 않게)
new ResizeObserver(() => {
  if (!densityFrame) densityFrame = requestAnimationFrame(applyDensity);
}).observe(el.cards);
// 목록 창 늘 위에 두기 (창 제목 줄, 최소화 버튼 옆)
const listTopBtn = $('list-top-btn');
// 스티커를 붙이고 떼는 느낌: 누르면 버튼의 왕관이 떨어져 나가 창 위 가장자리 스티커가 되고(버튼은 빈 자리),
// 스티커를 누르면 떼어져 늘 위에 두기가 꺼지고 왕관이 버튼으로 돌아온다
let listTop = null;
const showListTop = (on, animate = true) => {
  const changed = listTop !== null && listTop !== on;
  listTop = on;
  listTopBtn.setAttribute('aria-pressed', String(on));
  listTopBtn.classList.toggle('peeled', on);
  listTopBtn.tabIndex = on ? -1 : 0;
  listTopBtn.setAttribute('aria-hidden', String(on));
  listTopBtn.title = on ? '창 위의 왕관 스티커를 누르면 늘 위에 두기가 꺼져요' : '왕관 스티커를 붙여 목록을 다른 창보다 늘 위에 두기';
  listTopBtn.setAttribute('aria-label', on ? '목록 늘 위에 두기 끄기' : '목록을 다른 창보다 늘 위에 두기');
  if (!changed || !animate || reduceMotion()) return;
  const icon = listTopBtn.querySelector('svg');
  icon.animate(on
    ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px) rotate(-12deg) scale(0.7)' }]
    : [{ opacity: 0, transform: 'scale(0.4) rotate(12deg)' }, { opacity: 1, transform: 'scale(1.15)', offset: 0.7 }, { opacity: 1, transform: 'none' }],
  { duration: on ? 200 : 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
};
// 버튼은 붙이기만 (떼기는 창 위의 왕관 스티커를 눌러서). 상태는 list:on-top 으로 돌아온다
listTopBtn.addEventListener('click', () => {
  if (!listTop) api.win.toggleListTop();
});
api.on('list:on-top', (on) => showListTop(on));
api.win.listOnTop().then((on) => showListTop(on, false));
// 대화 상자·튜토리얼이 떠 있으면 창 버튼 줄도 어둡게 (Windows 가 그리는 줄이라 화면의 막이 닿지 않는다)
let dimLevel = false;
function syncTitlebarDim() {
  const level = el.settings.open || el.confirm.open || $('trash-dialog').open ? 'dialog' : document.body.classList.contains('coaching') ? 'coach' : false;
  if (level === dimLevel) return;
  dimLevel = level;
  api.win.dimTitlebar(level);
}
const dimWatcher = new MutationObserver(syncTitlebarDim);
for (const d of [el.settings, el.confirm, $('trash-dialog')]) dimWatcher.observe(d, { attributes: true, attributeFilter: ['open'] });
dimWatcher.observe(document.body, { attributes: true, attributeFilter: ['class'] });
// ---------- 휴지통 ----------
const trashEl = {
  dialog: $('trash-dialog'), list: $('trash-list'), empty: $('trash-empty'), note: $('trash-note'), clear: $('trash-clear'),
};
const DAYS_LABEL = { 7: '7일', 30: '30일', 90: '90일', 365: '1년' };
function agoText(iso) {
  const d = new Date(iso);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  return days <= 0 ? '오늘' : days === 1 ? '어제' : `${days}일 전`;
}
async function renderTrash() {
  const [items, s] = await Promise.all([api.trash.list(), api.settings.get()]);
  $('trash-count').textContent = items.length ? String(items.length) : '';
  trashEl.note.textContent = s.trashDays > 0
    ? `지운 메모는 여기에 있다가 ${DAYS_LABEL[s.trashDays] ?? `${s.trashDays}일`}이 지나면 저절로 지워져요.`
    : '지운 메모는 직접 지울 때까지 여기에 있어요.';
  trashEl.empty.hidden = items.length > 0;
  trashEl.clear.disabled = items.length === 0;
  trashEl.list.replaceChildren(...items.map((t) => {
    const li = document.createElement('li');
    li.className = 'trash-row';
    li.dataset.color = t.color;
    li.dataset.name = t.name;
    const dot = document.createElement('span');
    dot.className = 'row-dot';
    const text = document.createElement('div');
    text.className = 'trash-text';
    const title = document.createElement('div');
    title.className = 'trash-title';
    title.textContent = t.title;
    const sub = document.createElement('div');
    sub.className = 'trash-sub';
    sub.textContent = [`${agoText(t.deletedAt)} 지움`, t.preview].filter(Boolean).join(' · ');
    text.append(title, sub);
    const restore = document.createElement('button');
    restore.className = 'btn trash-restore';
    restore.dataset.restore = t.name;
    restore.textContent = '되살리기';
    const remove = document.createElement('button');
    remove.className = 'icon-btn danger trash-remove';
    remove.dataset.remove = t.name;
    remove.title = '영구 삭제';
    remove.setAttribute('aria-label', `${t.title} 영구 삭제`);
    remove.append(icon('trash'));
    li.append(dot, text, restore, remove);
    return li;
  }));
}
async function refreshTrashCount() {
  const items = await api.trash.list();
  $('trash-count').textContent = items.length ? String(items.length) : '';
}
$('trash-btn').addEventListener('click', async () => {
  el.settings.close();
  await renderTrash();
  trashEl.dialog.showModal();
});
$('trash-close').addEventListener('click', () => trashEl.dialog.close());
trashEl.list.addEventListener('click', async (e) => {
  const restore = e.target.closest('[data-restore]');
  if (restore) {
    restore.disabled = true;
    await api.trash.restore(restore.dataset.restore);
    return renderTrash();
  }
  const remove = e.target.closest('[data-remove]');
  if (!remove) return;
  const title = remove.closest('.trash-row').querySelector('.trash-title').textContent;
  if (await confirmDialog(`"${title}" 메모를 영구 삭제할까요?\n영구 삭제한 메모는 되돌릴 수 없어요.`, '영구 삭제')) {
    await api.trash.remove(remove.dataset.remove);
    renderTrash();
  }
});
trashEl.clear.addEventListener('click', async () => {
  const n = trashEl.list.children.length;
  if (await confirmDialog(`휴지통의 메모 ${n}개를 모두 영구 삭제할까요?\n되돌릴 수 없어요.`, '휴지통 비우기')) {
    await api.trash.empty();
    renderTrash();
  }
});
$('trash-days').addEventListener('change', async (e) => {
  const s = await api.settings.setTrashDays(Number(e.target.value));
  e.target.value = String(s.trashDays);
  refreshTrashCount();
});

$('tutorial-btn').addEventListener('click', () => {
  el.settings.close();
  api.tutorial.start();
});
applyInfo(await api.info());
await refresh();
$('count-memos').textContent = String(state.memos.length);
await remindersTab.refresh();
showTab(new URLSearchParams(location.search).get('tab') ?? 'memos');
document.documentElement.dataset.ready = 'true';
