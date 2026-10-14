// 메모 목록 창 — 폴더 지정, 메모 카드 목록, 검색, 새 메모.
import { hotkeyLabel } from './core/memo-hotkeys.js';
import { daysAgoText } from './core/time.js';
import { trashedText } from './core/format.js';
import { acceleratorFromKey, displayAccelerator } from './core/accelerators.js';
import { injectIcons, icon } from './icons.js';
import { handoffText } from './core/handoff.js';
import { friendlyTime } from './core/format.js';
import { vaultUrl, mediaKind, fileExtension } from './media.js';
import { memoBodyFromFile } from './core/file-memo.js';
import { isTextDocument } from './core/markdown-import.js';
import { setupRemindersTab } from './list-reminders.js';
import { setupHistoryTab } from './list-history.js';
import { collectTags, filterMemos, parseQuery, KIND_FILTERS, sameTag } from './core/tags.js';
import { COLORS } from './core/memo-file.js';
import { setupCoach } from './coach.js';
import { setupDrivePanel } from './drive-panel.js';
import { isAllClear } from './core/tasks.js';
import { MAGIC_MODULES } from './core/magic-modules.js';
import { stepZoom, clampZoom, zoomLabel } from './core/zoom.js';
import { attachSlider } from './seg-slider.js';
import { reduceMotion, tabKeys, syncTabStops, radioGroups } from './dom.js';

let listZoom = 1; // 메모 카드 확대 배율 (아래 "메모 카드 확대·축소")

const api = window.memoking;
const $ = (id) => document.getElementById(id);
const el = {
  setup: $('setup'),
  suggested: $('suggested-path'),
  useSuggested: $('use-suggested'),
  chooseFolder: $('choose-folder'),
  setupError: $('setup-error'),
  main: $('main'),
  fab: $('fab'),
  fabMenu: $('fab-menu'),
  fabScrim: $('fab-scrim'),
  layoutBtn: $('layout-btn'),
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
let drivePanel = null; // Google Drive 직접 동기화 (설정 · 처음 화면)

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
  el.version.textContent = `메모킹 ${info.version}`;
}

// ---------- 목록 ----------

let renderPending = false;
let glide = false; // 카드 모양을 바꿀 때는 glideCards 가 움직임을 맡는다

function render() {
  // 끄는 중에 카드를 다시 그리면 잡고 있던 카드가 사라지므로, 끝난 뒤로 미룬다.
  if (press?.dragging) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const narrowed = Boolean(state.query) || filterCount() > 0;
  const memos = filterMemos(state.results ?? state.memos, { ...state.filter, tags: [...state.filter.tags, ...state.queryTags] });
  const before = glide ? null : cardRects();
  layoutCards(memos);
  if (before) animateCards(before);
  el.empty.hidden = memos.length > 0;
  if (!memos.length) renderEmpty(narrowed);
  // 검색·필터로 좁혔을 때만 "N개 중 M개" (평소 개수는 메모 탭에)
  el.count.textContent = `메모 ${state.memos.length}개 중 ${memos.length}개`;
  el.count.hidden = !narrowed || !memos.length;
  renderFilters();
}

// ---------- 카드 쌓기 (휴대폰과 같음): 메모지처럼 엇갈려 — 카드마다 지금 가장 짧은 줄(같으면 왼쪽)에 붙인다 ----------
// 격자: 목록 폭에 맞춰 2~6줄 (카드 폭 180px 쯤 — 축소하면 줄이 늘고, 확대하면 준다) · 한 줄씩: 1줄

const LAYOUT_KEY = 'memoking.layout';
let layout = 'grid';
let lastCols = 0;

function columnsFor(width) {
  if (layout === 'rows') return 1;
  return Math.max(2, Math.min(6, Math.floor(width / 180)));
}

function layoutCards(memos) {
  // 다시 쌓는 동안 목록이 잠깐 비어 스크롤이 맨 위로 튀지 않게 — 지우거나 바뀌어도 보던 자리 그대로
  const top = el.cards.scrollTop;
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
  if (top) el.cards.scrollTop = top;
}

const cardItems = () => el.cards.querySelectorAll('.item');

function renderNow() {
  glide = true;
  try {
    render();
  } finally {
    glide = false;
  }
}

// ---------- 움직임 (디자인 시스템: 짧고 조용하게, 움직임 줄이기 존중) ----------

const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
let firstCards = true;

function cardRects() {
  const map = new Map();
  for (const li of cardItems()) {
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
  [...cardItems()].forEach((li, i) => {
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
  el.filterSummaryText.textContent = `필터 ${n}개: ${parts.join(', ')}`;
}

el.tagStrip.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (b) {
    toggleTagFilter(b.dataset.tag);
    tutEvent('tag-filtered');
  }
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

// 빈 목록: 그림 + 다음에 할 일 단추 (휴대폰과 같음) — 검색·필터로 비었으면 풀기, 메모가 없으면 새 메모
function renderEmpty(narrowed) {
  const art = document.createElement('span');
  art.className = 'empty-art';
  art.textContent = narrowed ? '🔍' : '📝';
  const text = document.createElement('span');
  text.textContent = narrowed
    ? state.query ? `"${state.query}" 이(가) 든 메모가 없어요.` : '조건에 맞는 메모가 없어요.'
    : '아직 메모가 없어요.\n떠오른 생각을 바로 적어 보세요.';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn primary';
  b.textContent = narrowed ? '검색과 필터 풀기' : '새 메모 (Ctrl+N)';
  b.addEventListener('click', () => {
    if (!narrowed) return api.memo.create();
    state.filter = { tags: [], colors: [], kinds: [] };
    el.search.value = '';
    runSearch();
  });
  const actions = document.createElement('span');
  actions.className = 'empty-actions';
  actions.append(b);
  el.empty.replaceChildren(art, text, actions);
}

function renderCard(memo) {
  const li = document.createElement('div');
  li.className = 'item';
  li.setAttribute('role', 'listitem');
  const card = document.createElement('button');
  const justDropped = memo.id === state.droppedId && Date.now() < state.droppedUntil;
  card.className = `card${memo.open ? ' open' : ''}${justDropped ? ' dropped' : ''}`;
  card.dataset.id = memo.id;
  card.dataset.color = memo.color; // 카드 바탕·글씨 = 실제 메모 창의 색
  if (memo.open) card.title = '메모 창이 열려 있어요';

  // 제목 줄: 제목(두 줄까지) (고정 압정) — 휴대폰과 같은 모양
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
    // 태그는 카드 아래 줄에 따로 보이므로 미리 보기 글에서는 뺀다 (휴대폰과 같음)
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

  // 체크리스트를 모두 끝낸 메모: CLEAR 도장 (v0.17.13)
  if (isAllClear(memo.tasks)) {
    const clear = document.createElement('span');
    clear.className = 'card-clear';
    clear.textContent = 'CLEAR';
    clear.setAttribute('aria-label', `체크리스트 ${memo.tasks.total}개를 모두 끝냈어요`);
    card.classList.add('all-clear');
    card.append(clear);
  }

  // 아랫줄: 왼쪽 태그(누르면 그 태그로 거르기), 오른쪽 표시 · 마지막 고친 때 (휴대폰과 같음)
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
  // 테이프로 바탕화면에 붙여 둔 메모 (창이 떠 있을 때)
  if (memo.taped) {
    const wg = badge('tape', '', 'taped');
    wg.title = '바탕화면에 붙어 있어요';
    meta.append(wg);
  }
  // 메모 단축키: Ctrl+Alt+숫자 로 어디서든 불러오는 메모 (메모 창 › 단축키로 불러오기)
  if (memo.hotkey) {
    const hk = badge('zap', memo.hotkey, 'hotkey');
    hk.title = `단축키 ${hotkeyLabel(memo.hotkey)}`;
    meta.append(hk);
  }
  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = friendlyTime(memo.updated);
  time.title = `마지막으로 고친 때 ${new Date(memo.updated).toLocaleString('ko-KR')}`;
  meta.append(time);
  foot.append(tags, meta);
  card.append(foot);

  const del = document.createElement('button');
  del.className = 'icon-btn danger card-delete';
  del.title = '삭제';
  del.setAttribute('aria-label', `${memo.title} 지우기`);
  del.dataset.delete = memo.id;
  del.append(icon('trash'));

  // 목록 맨 위에 고정 (압정)
  const pin = document.createElement('button');
  pin.className = `icon-btn card-pin${memo.pinned ? ' on' : ''}`;
  pin.title = memo.pinned ? '목록 고정 풀기' : '목록 맨 위에 고정';
  pin.setAttribute('aria-label', `${memo.title} ${pin.title}`);
  pin.setAttribute('aria-pressed', String(Boolean(memo.pinned)));
  pin.dataset.pin = memo.id;
  pin.append(icon(memo.pinned ? 'pin-fill' : 'pin'));

  // 마우스를 올리면 카드 오른쪽 위에 뜨는 버튼 묶음 (데스크탑만 — 휴대폰은 길게 눌러 메뉴)
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

  li.append(card, actions);
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

function confirmDialog(message, okLabel = '삭제') {
  el.confirmMessage.textContent = message;
  $('confirm-ok').textContent = okLabel;
  el.confirm.returnValue = '';
  el.confirm.showModal();
  // 처음 포커스는 취소에 (Enter · Space 한 번에 영구 삭제 · 휴지통 비우기가 되지 않게)
  el.confirm.querySelector('button[value="cancel"]')?.focus();
  return new Promise((resolve) => {
    el.confirm.addEventListener('close', () => resolve(el.confirm.returnValue === 'ok'), { once: true });
  });
}

async function deleteMemo(id) {
  const memo = state.memos.find((m) => m.id === id);
  if (!memo) return;
  // 묻지 않고 바로 휴지통으로 — 카드의 떠 있는 복사본이 옆으로 날아가는 동안 목록은 곧바로 다시 그려져
  //   남은 카드가 빈자리로 미끄러진다 (휴대폰과 같음), 아래에 "되돌리기"
  const card = el.cards.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card && !reduceMotion()) {
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('card-ghost');
    ghost.removeAttribute('data-id');
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    document.body.append(ghost);
    card.style.visibility = 'hidden';
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
    setTimeout(() => ghost.remove(), 600);
  }
  await api.memo.remove(id);
}

// ---------- 파일을 끌어다 놓으면 메모로 (.md · .txt · 그림 · 그 밖의 파일) ----------
// 파일 하나에 메모 하나. 하나만 놓으면 그 메모 창을 바로 연다. 폴더는 넣지 않는다.
const MAX_DROP_FILES = 30;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const dropShade = document.createElement('div');
dropShade.className = 'file-drop';
dropShade.hidden = true;
dropShade.innerHTML = '<div class="file-drop-box"><b>놓으면 메모로 만들어요</b><span>.md · .txt 는 글 그대로, 그림·파일은 메모 안에</span></div>';
document.body.append(dropShade);
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || el.main.hidden) return;
  e.preventDefault();
  dragDepth++;
  dropShade.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); // 놓을 수 있게 (안 하면 Electron 이 파일을 창에 열어 버린다)
  e.dataTransfer.dropEffect = el.main.hidden ? 'none' : 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropShade.hidden = true;
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropShade.hidden = true;
  if (el.main.hidden) return;
  // 폴더는 빼고 (폴더는 webkitGetAsEntry 로만 알 수 있다)
  const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry?.());
  const files = [...e.dataTransfer.files].filter((_f, i) => !entries[i]?.isDirectory).slice(0, MAX_DROP_FILES);
  if (!files.length) return;
  const made = [];
  let failed = 0;
  for (const file of files) {
    try {
      let body;
      if (isTextDocument(file.name, file.type)) {
        if (file.size > MAX_TEXT_BYTES) throw new Error('너무 큰 글 파일');
        body = memoBodyFromFile({ name: file.name, kind: 'text', text: await file.text() });
      } else {
        const rel = await api.attachments.save(new Uint8Array(await file.arrayBuffer()), fileExtension(file));
        body = memoBodyFromFile({ name: file.name, kind: mediaKind(file) === 'image' ? 'image' : 'file', rel });
      }
      made.push(await api.memo.import(body, { open: files.length === 1 }));
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  if (activeTab !== 'memos') showTab('memos');
  flashStatus(made.length
    ? `파일 ${made.length}개로 메모를 만들었어요${failed ? ` (${failed}개는 못 만들었어요)` : ''}`
    : '이 파일로는 메모를 만들지 못했어요');
});

// 잠깐 보이는 안내 한 줄 (되돌리기 막대와 같은 자리·모양)
let flashTimer = 0;
function flashStatus(message) {
  let bar = $('flash-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'flash-bar';
    bar.className = 'undo-bar flash-bar';
    bar.setAttribute('role', 'status');
    document.body.append(bar);
  }
  bar.textContent = message;
  bar.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (bar.hidden = true), 3500);
}

// 지운 뒤 잠깐 "되돌리기" (메모 창에서 지워도 여기에)
let undoTimer = 0;
function showUndo({ name, title }) {
  let bar = $('undo-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'undo-bar';
    bar.className = 'undo-bar';
    bar.setAttribute('role', 'status');
    // 읽는 동안(마우스를 올리거나 되돌리기에 포커스) 사라지지 않게
    const hold = () => clearTimeout(undoTimer);
    const resume = () => {
      if (bar.hidden || bar.matches(':hover') || bar.contains(document.activeElement)) return;
      clearTimeout(undoTimer);
      undoTimer = setTimeout(() => (bar.hidden = true), 6000);
    };
    bar.addEventListener('pointerenter', hold);
    bar.addEventListener('focusin', hold);
    bar.addEventListener('pointerleave', resume);
    bar.addEventListener('focusout', () => setTimeout(resume, 0));
    document.body.append(bar);
  }
  const text = document.createElement('span');
  text.textContent = trashedText(title);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '되돌리기';
  btn.addEventListener('click', async () => {
    bar.hidden = true;
    await api.trash.restore(name);
  });
  bar.replaceChildren(text, btn);
  bar.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => (bar.hidden = true), 6000);
}
api.on('memo:trashed', showUndo);

// ---------- 이어 쓰기: 다른 기기에서 방금 고친 메모 → 위쪽에 "열기" 막대 (2분 뒤, 또는 열면 사라짐) ----------
let handoffTimer = null;
function showHandoff(h) {
  if (!h) return;
  let bar = $('handoff-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'handoff-bar';
    bar.className = 'undo-bar handoff-bar';
    bar.setAttribute('role', 'status');
    bar.addEventListener('pointerenter', () => clearTimeout(handoffTimer));
    bar.addEventListener('pointerleave', () => {
      clearTimeout(handoffTimer);
      handoffTimer = setTimeout(() => (bar.hidden = true), 20_000);
    });
    document.body.append(bar);
  }
  // 두 줄: 작게 "휴대폰에서 방금 고친 메모" · 굵게 제목 (좁은 목록 창에서도 제목이 보이게)
  const text = document.createElement('span');
  text.className = 'handoff-text';
  const from = document.createElement('small');
  from.textContent = handoffText(h.from, '').replace(/:\s*$/, '');
  const title = document.createElement('b');
  title.textContent = h.title;
  text.append(from, title);
  text.title = handoffText(h.from, h.title);
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = '열기';
  bar.dataset.id = h.id;
  open.addEventListener('click', () => {
    bar.hidden = true;
    api.memo.open(h.id);
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'handoff-close';
  close.setAttribute('aria-label', '안내 닫기');
  close.append(icon('close'));
  close.addEventListener('click', () => (bar.hidden = true));
  bar.replaceChildren(text, open, close);
  bar.hidden = false;
  clearTimeout(handoffTimer);
  handoffTimer = setTimeout(() => (bar.hidden = true), 120_000);
}
api.on('memo:handoff', showHandoff);
api.memo.handoff().then(showHandoff).catch(() => {});

el.useSuggested.addEventListener('click', async () => applyInfo(await api.vault.use(state.info.suggestedPath)));
el.chooseFolder.addEventListener('click', async () => applyInfo(await api.vault.choose()));

// ---------- 새 메모: + 를 누르면 위로 위성 버튼 (음성 메모 · 손 메모 · 글 메모) — 휴대폰과 같음 ----------
function setFabMenu(open, { keyboard = false } = {}) {
  if (open === !el.fabMenu.hidden) return false;
  el.fab.setAttribute('aria-expanded', String(open));
  el.fab.classList.toggle('open', open);
  el.fabScrim.hidden = !open;
  if (open) {
    el.fabMenu.hidden = false;
    el.fabMenu.classList.remove('closing');
    if (keyboard) el.fabMenu.querySelector('[data-new="text"]')?.focus({ preventScroll: true }); // 키보드로 열면 글 메모에 초점
  } else {
    el.fabMenu.classList.add('closing');
    setTimeout(() => {
      if (el.fab.getAttribute('aria-expanded') === 'false') el.fabMenu.hidden = true;
      el.fabMenu.classList.remove('closing');
    }, 160);
  }
  return true;
}
el.fab.addEventListener('click', (e) => setFabMenu(el.fabMenu.hidden, { keyboard: e.detail === 0 }));
el.fabScrim.addEventListener('click', () => setFabMenu(false));
el.fabMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-new]');
  if (!b) return;
  setFabMenu(false);
  api.memo.create(b.dataset.new === 'voice' ? { record: true } : b.dataset.new === 'ink' ? { ink: true } : {});
});
el.settingsBtn.addEventListener('click', async () => {
  await loadSettings();
  drivePanel?.refresh();
  openPanelDialog(el.settings);
});

// ---------- 설정: 자동 실행 · 알림 보관 ----------

async function loadSettings() {
  const s = await api.settings.get();
  const auto = $('auto-start');
  auto.checked = s.autoStart.enabled;
  auto.disabled = !s.autoStart.available;
  $('auto-start-note').textContent = s.autoStart.available ? '알림 영역에서 조용히 시작해요' : '설치한 메모킹에서 쓸 수 있어요';
  $('history-enabled').checked = s.historyEnabled;
  showBlockedCount();
  $('fit-tables').checked = s.fitTables !== false;
  $('auto-tags').checked = s.autoTags !== false;
  $('link-previews').checked = s.linkPreviews !== false;
  magicIndex = s.magicIndex ?? null;
  showMagic(s.magic);
  showQuickMemo(s.quickMemo);
  showShortcuts(s.shortcuts);
  showMcp(s.mcp);
  $('trash-days').value = String(s.trashDays);
  if (api.stt) renderStt(await api.stt.status());
  $('trash-count').textContent = s.trashCount ? String(s.trashCount) : '';
}
function showQuickMemo(q) {
  $('quick-memo').checked = q.enabled && q.registered;
  $('quick-memo-note').textContent = q.enabled && !q.registered
    ? '다른 앱이 이 단축키를 먼저 쓰고 있어서 작동하지 않아요. 아래에서 다른 키로 바꿔 주세요'
    : '어디서든 고른 내용을 바로 메모로 만들어요. 두 번 누르면 화면 영역 캡처';
}

// ---------- AI 비서 연결 (MCP) ----------
function showMcp(m, message = '') {
  if (!m) return;
  $('mcp-title').textContent = m.connected && !m.stale ? 'Claude 데스크톱에 연결됨' : m.stale ? '다시 연결이 필요해요' : '연결 안 됨';
  $('mcp-sub').textContent = message || (m.broken
    ? 'Claude 데스크톱 설정 파일을 읽지 못했어요. 설정 복사로 직접 넣어 주세요'
    : m.stale ? '메모킹을 다른 곳에 다시 설치했어요. 연결을 눌러 새 위치로 맞춰 주세요'
      : m.connected ? 'Claude 데스크톱을 껐다 켜면 메모킹 도구(메모 찾기, 읽기, 남기기)가 보여요'
        : m.claudeFound ? '연결하면 Claude에게 "장보기 메모에 우유 추가해 줘" 처럼 부탁할 수 있어요'
          : 'Claude 데스크톱이 없으면 설정 복사로 다른 AI 앱(Cursor 등)에 넣을 수 있어요');
  $('mcp-box').classList.toggle('on', m.connected && !m.stale);
  $('mcp-connect').textContent = m.stale ? '다시 연결' : 'Claude 데스크톱에 연결';
  $('mcp-connect').hidden = m.connected && !m.stale;
  $('mcp-disconnect').hidden = !m.connected;
  $('mcp-write').checked = m.write;
}
$('mcp-connect').addEventListener('click', async () => {
  const m = await api.mcp.connect(true);
  showMcp(m, m.error ?? '연결했어요. Claude 데스크톱을 껐다 켜면 메모킹 도구가 보여요');
});
$('mcp-disconnect').addEventListener('click', async () => {
  const m = await api.mcp.connect(false);
  showMcp(m, m.error ?? '');
});
$('mcp-copy').addEventListener('click', async () => {
  await api.mcp.copy();
  showMcp((await api.settings.get()).mcp, '설정을 복사했어요. AI 앱의 MCP 설정(mcpServers)에 붙여 넣어 주세요');
});
$('mcp-write').addEventListener('change', async (e) => showMcp(await api.mcp.setWrite(e.target.checked)));

// ---------- 전역 단축키 바꾸기 (빠른 메모·매직키) ----------
// 키 단추를 누르고 새 조합을 누르면 바뀐다. 다른 앱이 이미 쓰는 키면 바꾸지 않고 알려 준다 (Esc·다른 곳 누르기 = 그만)
let shortcutState = {};
const SC_TAKEN = '다른 앱이 이 키를 먼저 쓰고 있어서 작동하지 않아요 (예: 같은 단축키를 쓰는 다른 프로그램). 다른 키로 바꿔 주세요';
function showShortcuts(sc) {
  shortcutState = sc ?? {};
  for (const name of ['quickMemo', 'magic']) {
    const st = shortcutState[name];
    if (!st) continue;
    $(`sc-${name}`).textContent = st.label;
    $(`sc-${name}`).setAttribute('aria-label', `${name === 'quickMemo' ? '빠른 메모' : '매직키'} 단축키 ${st.label}, 눌러서 바꾸기`);
    $(`sc-${name}-reset`).hidden = st.isDefault;
    $(`sc-${name}-note`).textContent = st.enabled && !st.registered ? SC_TAKEN : '';
    $(`sc-${name}-note`).classList.toggle('warn', st.enabled && !st.registered);
    $(name === 'quickMemo' ? 'quick-memo-kbd' : 'magic-kbd').textContent = st.label;
  }
}
let capturing = null; // { name, btn, onKey, onBlur }
async function stopCapture(message = '', warn = false) {
  if (!capturing) return;
  const { name, onKey, onDown } = capturing;
  capturing = null;
  window.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onDown, true);
  $(`sc-${name}`).classList.remove('capturing');
  await api.settings.pauseShortcuts(false);
  const s = await api.settings.get();
  showShortcuts(s.shortcuts);
  showQuickMemo(s.quickMemo);
  if (message) {
    $(`sc-${name}-note`).textContent = message;
    $(`sc-${name}-note`).classList.toggle('warn', warn);
  }
}
async function startCapture(name) {
  if (capturing) await stopCapture();
  const btn = $(`sc-${name}`);
  await api.settings.pauseShortcuts(true); // 지금 키를 눌러도 빠른 메모가 뜨지 않게 잠시 놓는다
  btn.classList.add('capturing');
  btn.textContent = '새 키 조합을 누르세요…';
  $(`sc-${name}-note`).textContent = 'Ctrl, Alt, Win 중 하나와 함께 눌러요. Esc 는 그만';
  $(`sc-${name}-note`).classList.remove('warn');
  const onKey = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) return stopCapture();
    const r = acceleratorFromKey(e);
    if (r.pending) {
      btn.textContent = `${[e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean).join('+')}+…`;
      return;
    }
    if (r.error) {
      $(`sc-${name}-note`).textContent = r.error;
      $(`sc-${name}-note`).classList.add('warn');
      return; // 계속 기다린다
    }
    const res = await api.settings.setShortcut(name, r.acc);
    if (res.ok) return stopCapture(`${displayAccelerator(r.acc)} 키로 바꿨어요`);
    if (res.reason === 'taken') return stopCapture(`${res.label} 키는 다른 앱이 이미 쓰고 있어요. 다른 키를 골라 주세요`, true);
    if (res.reason === 'same') return stopCapture(`${res.other}와 같은 키예요. 다른 키를 골라 주세요`, true);
    return stopCapture('이 키는 쓸 수 없어요', true);
  };
  const onDown = (e) => {
    if (e.target !== btn) stopCapture();
  };
  capturing = { name, onKey, onDown };
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
}
for (const name of ['quickMemo', 'magic']) {
  $(`sc-${name}`).addEventListener('click', () => (capturing?.name === name ? stopCapture() : startCapture(name)));
  $(`sc-${name}-reset`).addEventListener('click', async () => {
    const res = await api.settings.setShortcut(name, null);
    const s = await api.settings.get();
    showShortcuts(s.shortcuts);
    showQuickMemo(s.quickMemo);
    if (!res.ok && res.reason === 'taken') {
      $(`sc-${name}-note`).textContent = `기본 키 ${res.label} 키는 다른 앱이 쓰고 있어요`;
      $(`sc-${name}-note`).classList.add('warn');
    }
  });
}
// 다른 앱이 놓아 주어 1분마다 다시 잡기에 성공했을 때 등
api.on('shortcuts:changed', async () => {
  const s = await api.settings.get();
  showShortcuts(s.shortcuts);
  showQuickMemo(s.quickMemo);
});
// ---------- 음성 녹음 · 받아쓰기 (desktop/stt) ----------
// 데이터는 처음 한 번 받는다 (받아쓰기 약 80MB, 말한 사람 나누기 약 30MB) — 이 PC 의 앱 데이터 폴더에, 메모 폴더에는 넣지 않음
function renderStt(st) {
  if (!st || !api.stt) return;
  const asr = st.asr;
  const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
  $('stt-enabled').checked = st.enabled;
  $('stt-note').textContent = asr.state === 'ready' ? '말하면 문장마다 글로 나타나고, 끝내면 소리와 함께 음성 카드로'
    : asr.state === 'downloading' ? `받아쓰기 데이터를 받는 중… ${pct(asr.progress)}`
      : asr.error ? `받지 못했어요: ${asr.error}` : `받아쓰기 데이터(${asr.size})가 필요해요 — 한 번만 받으면 돼요`;
  const dl = $('stt-download');
  dl.hidden = asr.state === 'ready';
  dl.disabled = asr.state === 'downloading';
  dl.textContent = asr.state === 'downloading' ? `받는 중… ${pct(asr.progress)}` : `받아쓰기 데이터 받기 (${asr.size})`;
  $('stt-remove').hidden = asr.state !== 'ready';
  const spk = st.speaker;
  const sw = $('stt-speaker');
  sw.checked = st.speakerOn;
  sw.disabled = !st.enabled;
  $('stt-speaker-note').textContent = spk.state === 'downloading' ? `말한 사람 나누기 데이터를 받는 중… ${pct(spk.progress)}`
    : spk.error && st.speakerOn ? `받지 못했어요: ${spk.error}`
      : st.speakerOn && spk.state !== 'ready' ? `데이터(${spk.size})를 받으면 켜져요`
        : '녹음이 끝난 뒤 "화자 1:" 처럼 이름표를 붙여요 (긴 녹음은 몇 분 걸려요)';
}
if (api.stt) {
  api.on('stt:status', renderStt);
  $('stt-enabled').addEventListener('change', async (e) => renderStt(await api.stt.setOptions({ enabled: e.target.checked })));
  $('stt-download').addEventListener('click', async () => {
    const st = await api.stt.download('asr');
    renderStt(st);
  });
  $('stt-remove').addEventListener('click', async () => {
    if (!(await confirmDialog('받아쓰기 데이터를 지울까요?\n다시 쓰려면 다시 받아야 해요.', '지우기'))) return;
    renderStt(await api.stt.remove('asr'));
  });
  $('stt-speaker').addEventListener('change', async (e) => {
    let st = await api.stt.setOptions({ speaker: e.target.checked });
    renderStt(st);
    if (e.target.checked && st.speaker.state === 'missing') renderStt(await api.stt.download('speaker'));
  });
} else {
  for (const x of ['stt-enabled', 'stt-download', 'stt-speaker']) $(x).closest('label, div').hidden = true;
}
$('quick-memo').addEventListener('change', async (e) => showQuickMemo(await api.settings.setQuickMemo(e.target.checked)));
$('auto-start').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setAutoStart(e.target.checked);
});
$('fit-tables').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setFitTables(e.target.checked);
});
$('link-previews').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setLinkPreviews(e.target.checked);
});
$('auto-tags').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setAutoTags(e.target.checked);
});

// 매직키 설정: 켜고 끄기 + 기능 모듈 끄고 켜기 (준비 중 모듈은 끌 수 없음)
let magicState = { enabled: true, modules: {}, paused: {} };
let magicIndex = null; // 파일 검색 목록 상태 { count, builtAt, building }
const indexNote = (st) => (!st ? '' : st.building && !st.count ? ', 파일 목록을 만드는 중…' : st.count ? `, 파일 ${st.count.toLocaleString('ko-KR')}개${st.building ? ' (새로 고치는 중)' : ''}` : '');
function renderMagicModules() {
  const list = $('magic-modules-list');
  list.replaceChildren(...MAGIC_MODULES.filter((m) => m.ready).map((m) => { // 준비 중인 기능은 설정에도 보이지 않게
    const row = document.createElement('label');
    row.className = `magic-mod${m.ready ? '' : ' soon'}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'switch';
    cb.checked = m.ready && magicState.modules[m.id] !== false && !!magicState.modules[m.id];
    cb.disabled = !m.ready || !magicState.enabled;
    cb.addEventListener('change', async () => {
      // 설정에서 켜면 매직키 창에서 잠깐 꺼 둔 것도 함께 풀어 바로 쓰게 (끈 기능은 매직키 창에 캡슐도 없음)
      const paused = { ...(magicState.paused ?? {}) };
      delete paused[m.id];
      magicState = await api.settings.setMagic({ enabled: magicState.enabled, modules: { ...magicState.modules, [m.id]: cb.checked }, paused });
      renderMagicModules();
    });
    const text = document.createElement('span');
    text.append(m.name);
    if (!m.ready) {
      const em = document.createElement('em');
      em.textContent = ' (준비 중)';
      text.append(em);
    }
    const small = document.createElement('small');
    small.textContent = m.description + (m.id === 'files' && cb.checked ? indexNote(magicIndex) : '') + (cb.checked && magicState.paused?.[m.id] ? ' · 지금은 매직키 창에서 잠깐 꺼 둠' : '');
    text.append(' ', small);
    row.append(cb, text);
    return row;
  }));
}
function showMagic(magic) {
  magicState = magic ?? { enabled: true, modules: {} };
  $('magic-enabled').checked = magicState.enabled;
  $('magic-modules-row').hidden = !magicState.enabled;
  renderMagicModules();
}
$('magic-enabled').addEventListener('change', async (e) => {
  magicState = await api.settings.setMagic({ enabled: e.target.checked, modules: magicState.modules, paused: magicState.paused });
  showMagic(magicState);
});
$('history-enabled').addEventListener('change', async (e) => {
  e.target.checked = await api.history.setEnabled(e.target.checked);
  historyTab.refresh();
});

// ---------- 탭: 메모 · 알림 예약 · 알림 보관함 ----------

const TAB_PLACEHOLDER = { memos: '메모 검색 (Ctrl+F)', reminders: '일정 검색', history: '보관한 알림 검색' };
let activeTab = 'memos';

const remindersTab = setupRemindersTab({
  api, container: $('reminder-groups'), countEl: $('count-reminders'),
});
// 앱 하나를 더 모으지 않기: 이미 모은 것도 지울지 묻는다
async function blockHistoryApp(appId, appName) {
  if (!(await confirmDialog(`${appName} 알림을 더 이상 보관하지 않을까요?\n알림 보관함 › 모을 앱에서 다시 켤 수 있어요.`, '보관 중지'))) return false;
  const apps = await api.history.apps();
  const count = apps.find((a) => a.appId === appId)?.count ?? 0;
  const remove = count > 0 && await confirmDialog(`보관된 ${appName} 알림 ${count}개도 삭제할까요?`, '삭제');
  await api.history.blockApp(appId, appName, remove);
  historyTab.refresh();
  return true;
}

// 알림 모을 앱 고르기
async function renderApps() {
  const apps = (await api.history.apps()).sort((a, b) => b.count - a.count || a.app.localeCompare(b.app, 'ko'));
  $('apps-empty').hidden = apps.length > 0;
  $('apps-list').replaceChildren(...apps.map((a) => {
    const li = document.createElement('li');
    li.className = `app-row${a.blocked ? ' off' : ''}`;
    const letter = document.createElement('span');
    letter.className = 'avatar letter';
    letter.textContent = (a.app || '?').trim().charAt(0).toUpperCase();
    let h = 0;
    for (const ch of a.app) h = (h * 31 + ch.codePointAt(0)) % 360;
    letter.style.background = `hsl(${h} 55% 50%)`;
    const name = document.createElement('span');
    name.className = 'app-name';
    const b = document.createElement('b');
    b.textContent = a.app;
    const small = document.createElement('small');
    small.textContent = a.blocked ? '보관 안 함' : `알림 ${a.count}개 보관 중`;
    name.append(b, small);
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.checked = !a.blocked;
    sw.setAttribute('aria-label', `${a.app} 알림 모으기`);
    sw.addEventListener('change', async () => {
      if (sw.checked) await api.history.unblockApp(a.appId);
      else if (!(await blockHistoryApp(a.appId, a.app))) sw.checked = true;
      renderApps();
      showBlockedCount();
      historyTab.refresh();
    });
    li.append(letter, name, sw);
    return li;
  }));
}
async function showBlockedCount() {
  const n = (await api.history.apps()).filter((a) => a.blocked).length;
  $('blocked-count').textContent = n ? `${n}개 꺼짐` : '';
}
$('history-apps-btn').addEventListener('click', async () => {
  await renderApps();
  openPanelDialog($('apps-dialog'));
});

const historyTab = setupHistoryTab({
  // 보관함의 알림을 펼친 곳의 "이 앱 알림 그만 모으기"
  api: { ...api, history: { ...api.history, block: (e) => blockHistoryApp(e.appId, e.app) } },
  confirm: confirmDialog,
  els: {
    consent: $('history-consent'), body: $('history-body'), enable: $('history-enable'),
    clear: $('history-clear'), app: $('history-app'), rows: $('history-rows'), empty: $('history-empty'),
  },
});

// 탭의 흰 선택 표시가 다음 탭으로 미끄러진다 (seg-slider.js — 휴대폰·다른 고르기 칸과 같은 움직임)
attachSlider(document.querySelector('.tabs'), { className: 'tab-indicator' });

function showTab(tab) {
  if (!TAB_PLACEHOLDER[tab]) return;
  activeTab = tab;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  syncTabStops(document.querySelector('.tabs'));
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
tabKeys(document.querySelector('.tabs'));
api.on('list:tab', showTab);
api.on('reminders:changed', () => remindersTab.refresh());
api.on('history:changed', () => activeTab === 'history' && historyTab.refresh());
$('reveal-vault').addEventListener('click', () => api.vault.reveal());
$('change-vault').addEventListener('click', async () => {
  el.settings.close();
  applyInfo(await api.vault.choose());
});

// 카드에 포커스가 있을 때 Delete: 그 메모를 휴지통으로 (아래 되돌리기 띠로 되살림)
el.cards.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' || e.ctrlKey || e.altKey || e.metaKey) return;
  const card = e.target.closest?.('.card');
  if (!card || e.target !== card) return;
  e.preventDefault();
  deleteMemo(card.dataset.id);
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
    const want = m.pinned;
    return api.memo.set(m.id, { pinned: want }).then((memo) => {
      // 저장하지 못했다(파일이 잠깐 없는 등) — 바꿔 보여 준 것을 되돌린다
      if (!memo && m.pinned === want) {
        m.pinned = !want;
        render();
      }
    });
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
  el.dragHint.textContent = outside ? '놓으면 여기에 열려요. 취소는 Esc' : '목록 밖으로 끌어내면 그 자리에 열려요';
});

el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cancelDrag()) return;
  if (e.key === 'Escape' && setFabMenu(false)) return;
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
  // 이어 쓰기 막대의 메모를 다른 길(카드 두 번 누르기 등)로 열었으면 막대를 치운다
  const hb = $('handoff-bar');
  if (hb && !hb.hidden && memos.some((m) => m.id === hb.dataset.id && m.open)) hb.hidden = true;
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
const coach = setupCoach(api);
/** 튜토리얼 직접 해 보기: 지금 단계가 이 일을 기다리면 알린다 */
const tutEvent = (name) => {
  if (coach.step?.advance === name) api.tutorial.event(name);
};
// 목록 폭이 바뀌어 줄 수가 달라지면 다시 쌓는다 (다음 화면에서 한 번만)
let relayoutFrame = 0;
function relayoutIfNeeded() {
  relayoutFrame = 0;
  if (el.main.hidden || activeTab !== 'memos') return;
  if (columnsFor(el.cards.clientWidth || window.innerWidth) !== lastCols) render();
}
const scheduleRelayout = () => {
  if (!relayoutFrame) relayoutFrame = requestAnimationFrame(relayoutIfNeeded);
};
// ---------- 메모 카드 확대·축소 (Ctrl+마우스 휠, Ctrl+= / Ctrl+-), 이 PC 에 기억 ----------
// 카드 목록 전체를 키우고 줄인다(CSS zoom). 줄이면 한 줄에 카드가 더 들어가고(격자 줄 수가 늘고), 키우면 준다.
const LIST_ZOOM_KEY = 'memoking.listZoom';
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
const LIST_ZOOM_MAX = 1.75;
function setListZoom(z, { show = true } = {}) {
  listZoom = Math.min(LIST_ZOOM_MAX, clampZoom(z));
  el.cards.style.zoom = listZoom === 1 ? '' : String(listZoom);
  document.body.dataset.listZoom = String(listZoom);
  try {
    if (listZoom === 1) localStorage.removeItem(LIST_ZOOM_KEY);
    else localStorage.setItem(LIST_ZOOM_KEY, String(listZoom));
  } catch {
    // 기억 못 해도 지금 창에서는 그대로
  }
  scheduleRelayout();
  if (!show) return;
  listZoomText.textContent = `메모 ${zoomLabel(listZoom)}`;
  listZoomReset.hidden = listZoom === 1;
  listZoomBadge.classList.add('show');
  clearTimeout(listZoomTimer);
  listZoomTimer = setTimeout(() => listZoomBadge.classList.remove('show'), 1600);
}
setListZoom(listZoom, { show: false });
/** 카드 확대·축소는 메모 탭에서만 (일정·보관함은 카드가 아니라서) */
const zoomable = () => activeTab === 'memos' && !el.main.hidden;
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault(); // 창 전체(Chromium) 확대는 막는다
  if (!zoomable()) return; // 메모 카드에만 — 일정·보관함 탭에서는 아무 일 없음
  if (e.deltaY) setListZoom(stepZoom(listZoom, e.deltaY < 0 ? 1 : -1));
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.shiftKey && e.code !== 'Equal')) return;
  if (e.target.closest?.('input, textarea, [contenteditable="true"]') && e.code !== 'Equal' && e.code !== 'Minus') return;
  if (!zoomable() && /^(Equal|Minus|NumpadAdd|NumpadSubtract)$/.test(e.code)) return void e.preventDefault();
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setListZoom(stepZoom(listZoom, 1));
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') setListZoom(stepZoom(listZoom, -1));
  else return;
  e.preventDefault();
});

new ResizeObserver(scheduleRelayout).observe(el.cards);

// ---------- 카드 모양 (격자 / 한 줄씩) — 휴대폰과 같은 단추, 이 PC 에 기억 ----------
function applyLayout() {
  el.cards.dataset.layout = layout;
  el.layoutBtn.replaceChildren(icon(layout === 'rows' ? 'grid' : 'rows'));
  const label = layout === 'rows' ? '격자로 보기 (여러 줄)' : '한 줄씩 보기';
  el.layoutBtn.title = label;
  el.layoutBtn.setAttribute('aria-label', label);
}
try {
  layout = localStorage.getItem(LAYOUT_KEY) === 'rows' ? 'rows' : 'grid';
} catch {
  // 기본은 격자
}
applyLayout();
// 카드들이 새 자리로 미끄러져 간다 (옛 자리 → 새 자리) — 모양이 바뀐 것을 눈으로 따라갈 수 있게
function glideCards(change) {
  const before = new Map([...el.cards.querySelectorAll('.card')].map((c) => [c.dataset.id, c.getBoundingClientRect()]));
  change();
  if (reduceMotion()) return;
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
  tutEvent('layout-changed');
  if (!reduceMotion()) el.layoutBtn.animate([{ transform: 'rotate(-90deg) scale(0.6)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  glideCards(() => {
    applyLayout();
    renderNow();
  });
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // 지금 창에서만
  }
});
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
  { duration: on ? 200 : 280, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
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
  const level = el.settings.open || el.confirm.open || $('trash-dialog').open || $('apps-dialog').open || $('drive-dialog')?.open ? 'dialog' : document.body.classList.contains('coaching') ? 'coach' : false;
  if (level === dimLevel) return;
  dimLevel = level;
  api.win.dimTitlebar(level);
}
const dimWatcher = new MutationObserver(syncTitlebarDim);
for (const d of [el.settings, el.confirm, $('trash-dialog'), $('apps-dialog'), $('drive-dialog')].filter(Boolean)) dimWatcher.observe(d, { attributes: true, attributeFilter: ['open'] });
dimWatcher.observe(document.body, { attributes: true, attributeFilter: ['class'] });
// ---------- 휴지통 ----------
const trashEl = {
  dialog: $('trash-dialog'), list: $('trash-list'), empty: $('trash-empty'), note: $('trash-note'), clear: $('trash-clear'),
};
const DAYS_LABEL = { 7: '7일', 30: '30일', 90: '90일', 365: '1년' };
const agoText = (iso) => daysAgoText(iso);

// 설정·휴지통처럼 둘러보는 창: 열 때 창 자체에 포커스 (첫 단추에 굵은 포커스 테두리가 먼저 생기지 않게, Tab 을 누르면 첫 단추부터)
// 설정·휴지통·알림 모을 앱 창: 위 오른쪽 × 로 닫기 (긴 설정을 끝까지 내려가지 않아도 되게, Esc 도 그대로)
document.addEventListener('click', (e) => e.target.closest('[data-dialog-close]')?.closest('dialog')?.close());
function openPanelDialog(dialog) {
  dialog.tabIndex = -1;
  dialog.showModal();
  dialog.focus();
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
    sub.textContent = [`${agoText(t.deletedAt)} 지움`, t.preview].filter(Boolean).join(', ');
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
  openPanelDialog(trashEl.dialog);
  // 설정에서 왔으면 휴지통을 닫을 때 설정으로 돌아간다 (막다른 길이 되지 않게)
  trashEl.dialog.addEventListener('close', () => openPanelDialog(el.settings), { once: true });
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
  if (await confirmDialog(`"${title}" 메모를 영구 삭제할까요?\n되돌릴 수 없어요.`, '영구 삭제')) {
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
if (api.drive) drivePanel = setupDrivePanel({ api, onVault: (info) => applyInfo(info), confirm: confirmDialog });
await refresh();
$('count-memos').textContent = String(state.memos.length);
await remindersTab.refresh();
showTab(new URLSearchParams(location.search).get('tab') ?? 'memos');
document.documentElement.dataset.ready = 'true';

// 고르기 칸(role=radiogroup): 칸마다 radio, 화살표로 고르기 (dom.js)
radioGroups();
