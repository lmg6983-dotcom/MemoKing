// 메모 목록 창 — 폴더 지정, 메모 카드 목록, 검색, 새 메모.
import { hotkeyLabel } from './core/memo-hotkeys.js';
import { setupAiAsk } from './ai-ask.js';
import { DEFAULT_MODEL } from './core/model-catalog.js';
import { daysAgoText } from './core/time.js';
import { trashedText } from './core/format.js';
import { captureGlobalKey, stopKeyCapture, isCapturing, globalShortcutResult } from './key-capture.js';
import { injectIcons, icon } from './icons.js';
import { handoffText } from './core/handoff.js';
import { friendlyTime, shortUrls } from './core/format.js';
import { vaultUrl, mediaKind, fileExtension } from './media.js';
import { videoThumb } from './video-poster.js';
import { memoBodyFromFile } from './core/file-memo.js';
import { isTextDocument } from './core/markdown-import.js';
import { setupRemindersTab } from './list-reminders.js';
import { setupHistoryTab } from './list-history.js';
import { renderReleaseNotes } from './release-notes-view.js';
import { filterMemos, parseQuery, KIND_FILTERS, sameTag } from './core/tags.js';
import { COLORS, COLOR_NAMES } from './core/memo-file.js';
import { setupCoach } from './coach.js';
import { hintOnce } from './hints.js';
import { openCardMenu } from './list-card-menu.js';
import { openMemoryDay, dayText } from './memory-day.js';
import { renderCollage, collageName } from './memories-collage.js';
import { base64Bytes, collageMemoBody } from './collage-preview.js';
import { ANDROID_APK, WINDOWS_SETUP, installShareText } from './core/install-links.js';
import { chooseShare, showSharePop, SHARE_DONE } from './share-menu.js';
import { validMode, splitByMode, memoMode, otherMode, MODE_LABEL, fillModeTag } from './core/modes.js';
import { openModeHelper } from './mode-helper-dialog.js';
import { renderWorkSettings } from './work-settings.js';
import { SORTS, DEFAULT_SORT, sortMemos, validSort, sortLabel } from './core/memo-sort.js';
import { setupDrivePanel } from './drive-panel.js';
import { isAllClear } from './core/tasks.js';
import { stepZoom, clampZoom, zoomLabel } from './core/zoom.js';
import { attachSlider } from './seg-slider.js';
import { reduceMotion, tabKeys, syncTabStops, radioGroups, stackCards, withViewTransition, setModeSwitch, swipeDismiss, EASE_OUT } from './dom.js';
import { UI } from './core/ui-text.js';
import { holdTune, setHoldTune } from './hold-tune.js';
import { renderFolderList, askFolderName, pickFolder, createPickBar } from './folder-ui.js';
import { folderList, movedText, isFolderName } from './core/folders.js';
import { hasRememberedChoices, forgetChoices } from './rename-content.js';

let listZoom = 1; // 메모 카드 확대 배율 (아래 "메모 카드 확대·축소")

const api = window.memoking;
const $ = (id) => document.getElementById(id);
const aiAsk = api.ai ? setupAiAsk({ btn: $('ai-ask-btn'), box: $('ai-ask'), input: $('search'), api }) : null; // 검색창 안 ✦ › 매직 에이전트 (글 모델을 넣은 PC 에서만)
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
  sortGroup: $('sort-group'),
  layoutGroup: $('layout-group'),
  search: $('search'),
  settingsBtn: $('settings-btn'),
  cards: $('cards'),
  empty: $('empty'),
  count: $('count'),
  settings: $('settings-dialog'),
  vaultPath: $('vault-path'),
  confirm: $('confirm-dialog'),
  confirmMessage: $('confirm-message'),
  dragHint: $('drag-hint'),
  filterBtn: $('filter-btn'),
  filterCount: $('filter-count'),
  filterPanel: $('filter-panel'),
  colorFilter: $('color-filter'),
  kindFilter: $('kind-filter'),
  folderSide: $('folder-side'),
  folderBtn: $('folder-btn'),
  folderTitle: $('folder-title'),
  filterSummary: $('filter-summary'),
  filterSummaryText: $('filter-summary-text'),
};

const state = {
  info: null, memos: [], results: null, query: '', queryTags: [], droppedId: null, droppedUntil: 0,
  mode: 'life', // 메모킹 Work / Life — 목록 · 검색 · 일정은 이 모드의 메모만 (core/modes.js)
  workLife: false, // 설정 › Work / Life 나누기 (꺼져 있으면 모든 메모가 한 목록 · 밝기는 시스템 설정)
  // 필터 (창을 닫으면 잊는다): 태그는 모두 가진 메모, 색은 그중 하나, 담긴 것은 모두 해당
  filter: { tags: [], colors: [], kinds: [] },
  folder: '', // 보고 있는 메모킹 폴더 ("" = 전체, core/folders.js) — 이 PC 에 기억
  folderDirs: null, // 메모 폴더 맨 위의 하위 폴더 (빈 폴더도) — 받기 전에는 null
  picked: new Set(), // Ctrl+클릭으로 고른 카드 (폴더로 옮기기)
};
try {
  state.folder = localStorage.getItem('memoking.folder') ?? '';
} catch {
  // 전체
}
let searchTimer = null;
let drivePanel = null; // Google Drive 직접 동기화 (설정 · 처음 화면)

// ---------- 화면 전환 ----------

function applyInfo(info) {
  if (state.onlyFiles && info.vaultPath !== state.info?.vaultPath) closeOnlyFiles(); // 다른 메모 폴더로 바뀌면 사본만 보기를 푼다
  state.info = info;
  const ready = Boolean(info.vaultPath);
  const lost = !ready && Boolean(info.missingPath);
  el.setup.hidden = ready || lost;
  $('lost').hidden = !lost;
  $('lost-path').textContent = info.missingPath ?? '';
  el.main.hidden = !ready;
  el.suggested.textContent = info.suggestedPath;
  el.setupError.hidden = !info.vaultError;
  el.setupError.textContent = info.vaultError ?? '';
  // 설정의 메모 폴더: 폴더 이름은 굵게, 전체 경로는 그 아래 작게 (긴 경로가 이름을 묻지 않게)
  const vp = info.vaultPath ?? '';
  const name = document.createElement('b');
  name.textContent = vp.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  const full = document.createElement('small');
  full.textContent = vp;
  el.vaultPath.replaceChildren(name, full);
}

// 목록을 이 파일들만으로 좁히기 (동기화 충돌 사본) — 위에 "N개만 보는 중 · 모두 보기"
function showOnlyFiles(files) {
  const bar = $('conflict-bar');
  const only = files?.length ? new Set(files.map((f) => String(f).replace(/\\/g, '/'))) : null;
  // 탭 바꾸기 · 검색 지우기를 먼저 (둘 다 검색을 다시 돌린다) — 사본만 보기를 정한 뒤에 하면 곧바로 풀린다
  if (only && activeTab !== 'memos') showTab('memos');
  else if (only && el.search.value) {
    el.search.value = '';
    runSearch();
  }
  state.onlyFiles = only;
  if (state.onlyFiles) {
    const all = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: '모두 보기' });
    all.addEventListener('click', () => showOnlyFiles(null));
    bar.replaceChildren(Object.assign(document.createElement('span'), { id: 'conflict-bar-text' }), all);
  }
  bar.hidden = !state.onlyFiles;
  render();
}

function closeOnlyFiles() {
  state.onlyFiles = null;
  $('conflict-bar').hidden = true;
}

// ---------- 목록 ----------

let sort = 'updated'; // 목록 정렬 (아래 "정렬")
try {
  sort = validSort(localStorage.getItem('memoking.sort'));
} catch {
  // 기본
}
let renderPending = false;
let memosStale = false; // 메모 탭이 덮인 동안 메모가 바뀌었다 (돌아오면 다시 그린다)
let glide = false; // 카드 모양을 바꿀 때는 glideCards 가 움직임을 맡는다

function render() {
  // 끄는 중에 카드를 다시 그리면 잡고 있던 카드가 사라지므로, 끝난 뒤로 미룬다.
  if (press?.dragging) {
    renderPending = true;
    return;
  }
  renderPending = false;
  memosStale = false;
  keepFolderValid();
  // 동기화 충돌 사본만 보기 (위쪽 구름 단추 · 설정의 "충돌 사본 보기") — 검색 · 필터와 겹치지 않게 따로, 다 지우면 저절로 풀린다
  let only = null;
  if (state.onlyFiles) {
    only = state.memos.filter((m) => state.onlyFiles.has(String(m.file ?? '').replace(/\\/g, '/')));
    if (only.length) $('conflict-bar-text').textContent = `동기화 충돌 사본 ${only.length}개만 보는 중, 원래 메모와 견주어 보고 필요 없으면 삭제하세요`;
    else {
      closeOnlyFiles();
      only = null;
    }
  }
  const narrowed = !only && (Boolean(state.query) || filterCount() > 0);
  // 폴더: 고른 폴더의 메모만 (검색은 모든 폴더에서 — 카드에 폴더 이름이 보인다)
  const all = split(state.results ?? state.memos, state.mode).mine;
  const mine = state.query ? all : inFolder(all);
  const memos = only ?? sortMemos(filterMemos(mine, { ...state.filter, tags: [...state.filter.tags, ...state.queryTags] }), sort);
  // 검색어가 다른 모드의 메모에도 걸리면 알려 준다 (누르면 그 모드로)
  const elsewhere = !only && state.query && state.workLife ? filterMemos(splitByMode(state.results ?? state.memos, otherMode(state.mode)).mine, { ...state.filter, tags: [...state.filter.tags, ...state.queryTags] }).length : 0;
  const before = glide ? null : cardRects();
  layoutCards(memos);
  if (before) animateCards(before);
  el.empty.hidden = memos.length > 0;
  el.cards.classList.toggle('is-empty', !memos.length); // 빈 카드 칸이 자리를 반 나눠 가져 안내가 아래로 치우치지 않게
  if (!memos.length) renderEmpty(narrowed, elsewhere);
  // 검색·필터로 좁혔을 때만 "N개 중 M개" (평소 개수는 메모 탭에)
  el.count.replaceChildren(`메모 ${(state.query ? modeMemos() : inFolder(modeMemos())).length}개 중 ${memos.length}개`);
  if (elsewhere) el.count.append(', ', otherModeLink(elsewhere));
  el.count.hidden = !narrowed || !memos.length; // 하나도 없으면 빈 화면 안내가 "다른 모드에서 보기" 를 맡는다
  renderFilters();
  renderFolders();
}

// ---------- 폴더 (folder-ui.js · core/folders.js) ----------

const inFolder = (memos) => (state.folder ? memos.filter((m) => m.folder === state.folder) : memos);
// 새 메모는 보고 있는 폴더에
const newMemo = (opts = {}) => api.memo.create({ ...opts, ...(state.folder ? { folder: state.folder } : {}) });

async function loadFolders() {
  state.folderDirs = await api.memos.folders?.().catch(() => []) ?? [];
  render(); // 카드도 (고른 폴더가 없어졌으면 전체로 — keepFolderValid)
}

// 고른 폴더가 없어졌으면(탐색기에서 지움 · 다른 기기) 전체로 — 카드를 거르기 전에 (폴더 목록을 받기 전에는 그대로)
function keepFolderValid() {
  if (!state.folder || !state.folderDirs) return;
  if (state.folderDirs.includes(state.folder) || modeMemos().some((m) => m.folder === state.folder)) return;
  state.folder = '';
}

function setFolder(name) {
  state.folder = name;
  try {
    localStorage.setItem('memoking.folder', name);
  } catch {
    // 이번만
  }
  render();
  el.cards.scrollTop = 0;
}

async function newFolder() {
  const name = await askFolderName({ existing: state.folderDirs ?? [] });
  if (!name) return;
  try {
    await api.memos.createFolder(name);
  } catch (err) {
    return flashStatus(err.message || '폴더를 만들지 못했어요');
  }
  await loadFolders();
  setFolder(name);
}

function renderFolders() {
  if (!el.folderSide) return;
  const memos = modeMemos();
  const folders = folderList(state.folderDirs ?? [], memos);
  renderFolderList(el.folderSide, { folders, total: memos.length, current: state.folder, onPick: setFolder, onNew: newFolder });
  // 막대를 숨겼으면 카드 위에 지금 폴더 이름
  el.folderTitle.textContent = state.folder;
  el.folderTitle.hidden = !state.folder || !el.folderSide.hidden || Boolean(state.query);
}

// 폴더 막대 보이기 · 숨기기 (이 PC 에 기억) — 좁은 창에서 카드 자리를 넓게 쓰려면 숨긴다
function showFolderSide(on) {
  el.folderSide.hidden = !on;
  el.folderBtn.setAttribute('aria-pressed', String(on));
  try {
    localStorage.setItem('memoking.folderSide', on ? '1' : '0');
  } catch {
    // 이번만
  }
  renderFolders();
  queueMicrotask(() => render()); // 카드 줄 수를 새 폭에 맞춘다
}
el.folderBtn?.addEventListener('click', () => showFolderSide(el.folderSide.hidden));
try {
  if (localStorage.getItem('memoking.folderSide') === '0') {
    el.folderSide.hidden = true;
    el.folderBtn.setAttribute('aria-pressed', 'false');
  }
} catch {
  // 보임
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
  stackCards(columns, memos.map(renderCard)); // 높이는 한 번에 재고 나눈다 (dom.js — 카드마다 재면 메모가 많을 때 느렸다)
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
  // 먼저 모두 재고 나서 움직인다 (재기 · 움직이기를 번갈아 하면 카드마다 화면 배치를 다시 계산했다). 화면 근처 카드만
  const vh = window.innerHeight;
  const near = (r) => r.bottom > -vh && r.top < vh * 2;
  const items = [...cardItems()].map((li) => {
    const old = before.get(li.querySelector('.card')?.dataset.id);
    return { li, old, now: old && near(old) ? li.getBoundingClientRect() : null };
  });
  items.forEach(({ li, old, now }, i) => {
    if (old) {
      if (!now) return;
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        li.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: EASE_OUT });
      }
    } else if (first || before.size) {
      // 처음 열 때는 위에서부터 차례로, 그 뒤엔 새로 생긴 카드만
      li.animate([{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
        { duration: 200, easing: EASE_OUT, delay: first ? Math.min(i, 10) * 18 : 0, fill: 'backwards' });
    }
  });
}

// ---------- 필터: 태그 줄 · 색 · 담긴 것 ----------

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

/** 지금 모드의 메모 */
const modeMemos = () => split(state.memos, state.mode).mine;
/** 지금 모드의 메모 (Work / Life 를 나눠 쓰지 않으면 모두) */
function split(memos, mode) {
  return state.workLife ? splitByMode(memos, mode) : { mine: memos ?? [], other: 0 };
}

function otherModeLink(n) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-btn other-mode';
  b.textContent = `${MODE_LABEL[otherMode(state.mode)]}에서 ${n}개 더`;
  b.title = `${MODE_LABEL[otherMode(state.mode)]}로 바꿔 보기`;
  b.addEventListener('click', () => setMode(otherMode(state.mode)));
  return b;
}

// ---------- Work / Life 바꾸기 (제목 줄 왼쪽) ----------
let tutModeStep = null; // 튜토리얼: Work 로 바꾼 단계 (그 단계에서 Life 로 돌아오면 다음으로)
// 해 · 달 스위치 (화면 전환 속에서 바꿀 때는 전환이 끝난 뒤에 — dom.js setModeSwitch)
const syncSwitch = () => setModeSwitch($('mode-switch'), state.mode);
/** @param {{ later?: boolean }} [o] later: 스위치는 부른 쪽이 나중에 (syncSwitch) */
function showMode({ later = false } = {}) {
  if (!later) syncSwitch();
  const root = document.documentElement;
  root.dataset.mode = state.mode;
  $('mode-switch').hidden = !state.workLife;
  for (const b of document.querySelectorAll('#mode-switch [data-mode]')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
    b.tabIndex = b.dataset.mode === state.mode ? 0 : -1;
  }
  $('count-memos').textContent = modeMemos().length ? String(modeMemos().length) : ''; // 0 은 숨김 (일정 탭과 같이)
}

// 정리 도우미: Life 메모 중 일 이야기 같은 것을 골라 Work 로
async function openHelper() {
  const n = await openModeHelper({
    memos: state.memos,
    move: async (ids) => {
      let moved = 0;
      for (const id of ids) if (await api.memo.set(id, { mode: 'work' })) moved += 1;
      return moved;
    },
  });
  if (n) flashStatus(`메모 ${n}개를 Work로 옮겼어요`);
}

async function setMode(mode) {
  mode = validMode(mode);
  if (mode === state.mode) return;
  state.mode = mode;
  // 튜토리얼 "Work 로 바꿔 보고 다시 Life 로": 이 단계에서 Work 에 다녀오면 해 낸 것
  if (mode === 'work') tutModeStep = coach.step?.id ?? null;
  else if (tutModeStep && tutModeStep === coach.step?.id) tutEvent('mode-switched');
  withViewTransition(() => {
    showMode({ later: true });
    state.filter.tags = []; // 다른 모드에는 없는 태그일 수 있다
    render();
    remindersTab.modeChanged();
  }).then(syncSwitch);
  if (mode === 'work' && state.workLife) hintOnce('mode-work', 'Work에서는 일할 때 쓰는 메모와 일정만 보여요. 새 메모도 Work로 들어가요. 카드 메뉴의 "Work로 옮기기"나 설정의 정리 도우미로 옮길 수 있어요', { anchor: $('mode-switch') });
  const saved = await api.mode?.set(mode);
  if (saved && saved !== state.mode) {
    state.mode = saved;
    showMode();
    render();
  }
}

function renderFilters() {
  el.colorFilter.replaceChildren(...COLORS.map((c) => {
    const b = chip('color-dot', '', state.filter.colors.includes(c), { filterColor: c, color: c });
    b.title = COLOR_NAMES[c] ?? c;
    b.setAttribute('aria-label', `${COLOR_NAMES[c] ?? c} 메모`);
    return b;
  }));
  el.kindFilter.replaceChildren(...KIND_FILTERS.map((k) => chip('filter-chip', k.label, state.filter.kinds.includes(k.id), { kind: k.id })));
  const n = filterCount();
  el.filterCount.textContent = n ? String(n) : '';
  el.filterBtn.classList.toggle('active', n > 0 || sort !== DEFAULT_SORT); // 기본 보기가 아니면 단추에 표시
  el.filterSummary.hidden = n === 0;
  const parts = [
    ...state.filter.tags.map((t) => `#${t}`),
    ...state.filter.colors.map((c) => COLOR_NAMES[c] ?? c),
    ...state.filter.kinds.map((id) => KIND_FILTERS.find((k) => k.id === id)?.label ?? id),
  ];
  el.filterSummaryText.textContent = `필터 ${n}개: ${parts.join(', ')}`;
}

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
// 보기 판: 카드 위에 떠서 목록을 밀지 않는다 — 밖을 누르거나 Esc 로 닫힌다
async function setFilterPanel(open) {
  const p = el.filterPanel;
  if (open === !p.hidden) return false;
  el.filterBtn.setAttribute('aria-expanded', String(open));
  if (open) p.hidden = false;
  if (!reduceMotion()) {
    const frames = [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }];
    await p.animate(open ? frames : frames.slice().reverse(), { duration: open ? 160 : 120, easing: EASE_OUT }).finished.catch(() => {});
  }
  if (!open) p.hidden = true;
  return true;
}
el.filterBtn.addEventListener('click', () => setFilterPanel(el.filterPanel.hidden));
document.addEventListener('pointerdown', (e) => {
  if (!el.filterPanel.hidden && !el.filterPanel.contains(e.target) && !el.filterBtn.contains(e.target) && !e.target.closest?.('.coach-bubble')) setFilterPanel(false);
}, true);
$('filter-clear').addEventListener('click', () => {
  state.filter = { tags: [], colors: [], kinds: [] };
  render();
});

// 빈 목록: 그림 + 다음에 할 일 단추 (휴대폰과 같음) — 검색·필터로 비었으면 풀기, 메모가 없으면 새 메모
function renderEmpty(narrowed, elsewhere = 0) {
  const art = document.createElement('span');
  art.className = 'empty-art';
  art.textContent = narrowed ? '🔍' : '📝';
  const text = document.createElement('span');
  const other = MODE_LABEL[otherMode(state.mode)];
  text.textContent = narrowed && elsewhere
    ? `${MODE_LABEL[state.mode]}에는 '${state.query}' 메모가 없어요.\n${other}에서 ${elsewhere}개를 찾았어요.`
    : narrowed
    ? state.query ? `'${state.query}' 검색 결과가 없어요.` : UI.noMatch
    : state.mode === 'work' ? '아직 Work 메모가 없어요.\n일할 때 쓸 메모를 적거나, 카드 메뉴의 "Work로 옮기기"로 옮겨 보세요.'
      : '아직 메모가 없어요.\n떠오른 생각을 바로 적어 보세요.';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn primary';
  b.textContent = narrowed && elsewhere ? `${other}에서 보기` : narrowed ? UI.clearFilters : '새 메모 (Ctrl+N)';
  b.addEventListener('click', () => {
    if (narrowed && elsewhere) return setMode(otherMode(state.mode));
    if (!narrowed) return newMemo();
    state.filter = { tags: [], colors: [], kinds: [] };
    el.search.value = '';
    runSearch();
  });
  const actions = document.createElement('span');
  actions.className = 'empty-actions';
  actions.append(b);
  if (!narrowed && state.workLife && state.mode === 'work') {
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'btn';
    help.textContent = UI.findWithHelper;
    help.addEventListener('click', () => openHelper());
    actions.append(help);
  }
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
  if (state.picked.has(memo.id)) card.classList.add('picked');
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
  } else if (memo.video) card.append(videoThumb(memo.video)); // 사진이 없고 동영상이 있으면 첫 장면 + ▶

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
  if (state.workLife) tags.append(fillModeTag(document.createElement('span'), memo, true));
  // 폴더 이름: 전체 · 검색에서만 (폴더 안에서는 다 같으니 빼서 조용하게) — 누르면 그 폴더로
  if (memo.folder && (!state.folder || state.query)) {
    const f = document.createElement('span');
    f.className = 'card-folder';
    f.dataset.cardFolder = memo.folder;
    f.title = `${memo.folder} 폴더 보기`;
    f.append(icon('folder'), memo.folder);
    tags.append(f);
  }
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
  if (memo.locked) { // 잠근 메모: 미리 보기가 없어 빈 카드처럼 보이던 것
    const lk = badge('lock', '', 'locked');
    lk.title = '잠근 메모예요';
    meta.append(lk);
  }
  if (memo.reminderCount) meta.append(badge('bell', memo.reminderCount));
  if (memo.hasAudio) meta.append(badge('audio', ''));
  if (memo.hasVideo) meta.append(badge('video', ''));
  if (memo.hasFile) meta.append(badge('clip', ''));
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
  // 이름은 오른쪽 클릭 메뉴 · 휴대폰과 같게 — 지우는 게 아니라 휴지통으로 (되돌릴 수 있다). 키는 Delete
  del.title = UI.toTrash;
  del.setAttribute('aria-label', `${memo.title} 휴지통으로 옮기기`);
  del.dataset.delete = memo.id;
  del.append(icon('trash'));

  // 목록 맨 위에 고정 (압정)
  const pin = document.createElement('button');
  pin.className = `icon-btn card-pin${memo.pinned ? ' on' : ''}`;
  pin.title = memo.pinned ? UI.unpin : UI.pin;
  pin.setAttribute('aria-label', `${memo.title} ${pin.title}`);
  pin.setAttribute('aria-pressed', String(Boolean(memo.pinned)));
  pin.dataset.pin = memo.id;
  pin.append(icon(memo.pinned ? 'pin-fill' : 'pin'));

  // 마우스를 올리면(카드에 키보드 포커스가 있어도) 카드 오른쪽 아래에 뜨는 버튼 묶음 (데스크탑만 — 휴대폰은 길게 눌러 메뉴)
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  // PDF 로 저장
  const pdf = document.createElement('button');
  pdf.className = 'icon-btn card-pdf';
  pdf.title = UI.saveAsPdf;
  pdf.setAttribute('aria-label', `${memo.title} PDF로 저장`);
  pdf.dataset.pdf = memo.id;
  pdf.append(icon('pdf'));
  actions.append(pdf, pin, del);
  // 키보드는 카드 하나에 Tab 한 번 — 단추 셋은 Delete 키 · 메뉴 키(오른쪽 클릭 메뉴)로 (카드마다 Tab 4번이던 것)
  for (const b of actions.children) b.tabIndex = -1;

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
  loadFolders();
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
  aiAsk?.update(text);
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
  // 묻지 않고 바로 휴지통으로 — 카드의 떠 있는 복사본이 제자리에서 흐려지는 동안 목록은 곧바로 다시 그려져
  //   남은 카드가 빈자리로 미끄러진다, 아래에 "되돌리기"
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
dropShade.innerHTML = '<div class="file-drop-box"><b>놓으면 메모로 만들어요</b><span>.md, .txt는 글 그대로, 그림과 파일은 메모 안에</span></div>';
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
        if (file.size > MAX_TEXT_BYTES) throw new Error('글 파일이 너무 커요. 더 작게 나눠서 다시 해 주세요');
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
    // 옆으로 끌어 밀면 바로 닫힌다 (터치 화면 PC 도)
    swipeDismiss(bar, () => {
      clearTimeout(undoTimer);
      bar.hidden = true;
    });
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
    // × 말고도 옆으로 끌어 밀면 닫힌다 (터치 화면 PC 도) · Esc 는 아래 keydown
    swipeDismiss(bar, () => {
      clearTimeout(handoffTimer);
      bar.hidden = true;
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
// 설정 바로가기: 그 묶음으로 넘기기 (AI 도우미가 숨어 있으면 다른 AI 앱 연결로)
document.querySelector('.set-jump')?.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  e.preventDefault();
  const head = [a.getAttribute('href').slice(1), a.dataset.alt].map((id) => id && $(id)).find((h) => h && !h.closest('[hidden]'));
  head?.closest('section')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});
// 쓰던 폴더를 찾지 못했을 때: 옮긴 폴더 고르기 · 다시 찾아보기 · (확인 뒤) 새 빈 폴더
$('lost-pick').addEventListener('click', async () => applyInfo(await api.vault.choose()));
$('lost-retry').addEventListener('click', async () => {
  const info = await api.vault.retry();
  applyInfo(info);
  if (info.stillMissing) $('lost-note').textContent = '아직 찾지 못했어요. 폴더를 옮겼다면 옮긴 폴더 고르기로 알려 주세요.';
});
$('lost-fresh').addEventListener('click', async () => {
  const ok = await confirmDialog(`${state.info.suggestedPath}에서 새로 시작할까요?\n찾지 못한 폴더의 메모는 그대로 있어요. 나중에 설정 › 메모 폴더에서 다시 고를 수 있어요.`, '새로 시작');
  if (ok) applyInfo(await api.vault.use(state.info.suggestedPath));
});

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
  newMemo(b.dataset.new === 'voice' ? { record: true } : b.dataset.new === 'ink' ? { ink: true } : {});
});
el.settingsBtn.addEventListener('click', async () => {
  await loadSettings();
  drivePanel?.refresh();
  paintPhoneQr().catch((err) => console.warn('[휴대폰 앱 QR]', err));
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
  $('auto-tags').checked = $('auto-tags-ai').checked = s.autoTags !== false;
  $('magic-polish').checked = s.magicPolish !== false;
  $('auto-events').checked = s.autoEvents !== false;
  $('ai-phone').checked = s.aiPhone === true;
  $('link-previews').checked = s.linkPreviews !== false;
  showQuickMemo(s.quickMemo);
  showShortcuts(s.shortcuts);
  showMcp(s.mcp);
  $('trash-days').value = String(s.trashDays);
  renderWorkSettings($('work-settings'), {
    enabled: s.workLife === true,
    setEnabled: (on) => api.mode?.setWorkLife(on), // 목록은 mode:changed 로 따라간다
    hours: s.workHours,
    save: (h) => api.mode?.setHours(h),
    openHelper: () => openHelper(),
    quietNote: '업무 시간 밖에는 Work 메모의 알림을 띄우지 않고 알림 보관함에 모아요. 고정한 메모의 알림은 늘 울려요',
  });
  if (api.stt) renderStt(await api.stt.status());
  if (api.ai) renderAi(await api.ai.status());
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
  $('mcp-title').textContent = m.connected && !m.stale ? 'Claude 데스크톱에 연결됨' : m.stale ? '다시 연결이 필요해요' : UI.notConnected;
  $('mcp-sub').textContent = message || (m.broken
    ? 'Claude 데스크톱 설정 파일을 읽지 못했어요. 설정 복사로 직접 넣어 주세요'
    : m.stale ? '메모킹을 다른 곳에 다시 설치했어요. 연결을 눌러 새 위치로 맞춰 주세요'
      : m.connected ? 'Claude 데스크톱을 껐다 켜면 메모킹 도구(메모 찾기, 읽기, 남기기)가 보여요'
        : m.claudeFound ? '연결하면 Claude에게 "장보기 메모에 우유 추가해 줘" 처럼 부탁할 수 있어요'
          : 'Claude 데스크톱이 없으면 설정 복사로 다른 AI 앱(Cursor 등)에 넣을 수 있어요');
  $('mcp-box').classList.toggle('on', m.connected && !m.stale);
  if (m.connected) $('mcp-adv').open = true; // 연결해 둔 사람에게는 상태가 보이게
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
// 다른 기기에 설치: 휴대폰 앱(QR 코드 · 링크 복사 · 브라우저로) · Windows PC 버전(링크 복사 · 브라우저로) — 늘 최신 설치 파일 주소
let phoneQrDone = false;
async function paintPhoneQr() {
  if (phoneQrDone) return;
  phoneQrDone = true;
  const { default: qrcode } = await import('../vendor/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData(ANDROID_APK);
  qr.make();
  $('phone-qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
}
$('phone-copy').addEventListener('click', async () => {
  await api.copyText(ANDROID_APK);
  $('phone-note').textContent = '설치 링크를 복사했어요. 메신저나 메일로 휴대폰에 보내 열어 주세요';
});
$('phone-open').dataset.url = ANDROID_APK;
$('phone-open').addEventListener('click', () => api.links.open(ANDROID_APK));
$('pc-open').dataset.url = WINDOWS_SETUP;
$('pc-open').addEventListener('click', () => api.links.open(WINDOWS_SETUP));
$('pc-copy').addEventListener('click', async () => {
  await api.copyText(WINDOWS_SETUP);
  $('pc-note').textContent = 'PC 설치 링크를 복사했어요. 메신저나 메일로 보내 주세요';
});
$('share-both').addEventListener('click', async () => {
  await api.copyText(installShareText());
  $('pc-note').textContent = 'PC와 휴대폰 설치 링크를 함께 복사했어요';
});

// ---------- 전역 단축키 바꾸기 (매직 카피 · 메모 목록) ----------
// 키 단추를 누르고 새 조합을 누르면 바뀐다. 다른 앱이 이미 쓰는 키면 바꾸지 않고 알려 준다 (Esc·다른 곳 누르기 = 그만)
let shortcutState = {};
const SC_TAKEN = '다른 앱이 이 키를 먼저 쓰고 있어서 작동하지 않아요 (예: 같은 단축키를 쓰는 다른 프로그램). 다른 키로 바꿔 주세요';
function showShortcuts(sc) {
  shortcutState = sc ?? {};
  for (const name of ['quickMemo', 'list']) {
    const st = shortcutState[name];
    if (!st || !$(`sc-${name}`)) continue;
    $(`sc-${name}`).textContent = st.label;
    $(`sc-${name}`).setAttribute('aria-label', `${name === 'quickMemo' ? '매직 카피' : '메모 목록'} 단축키 ${st.label}, 눌러서 바꾸기`);
    $(`sc-${name}-reset`).hidden = st.isDefault;
    $(`sc-${name}-note`).textContent = st.enabled && !st.registered ? SC_TAKEN : '';
    $(`sc-${name}-note`).classList.toggle('warn', st.enabled && !st.registered);
  }
}
function setScNote(name, text, warn = false) {
  if (!$(`sc-${name}-note`)) return;
  $(`sc-${name}-note`).textContent = text;
  $(`sc-${name}-note`).classList.toggle('warn', warn);
}
/** onlyIfChanged: 키도 상태도 그대로면 칸은 다시 그리지 않는다 (방금 띄운 "바꿨어요" 안내가 지워지지 않게) */
async function refreshShortcuts({ onlyIfChanged = false } = {}) {
  const s = await api.settings.get();
  const same = onlyIfChanged && ['quickMemo', 'list'].every((n) => JSON.stringify(s.shortcuts?.[n]) === JSON.stringify(shortcutState[n]));
  if (!same) showShortcuts(s.shortcuts);
  showQuickMemo(s.quickMemo);
}
// 매직 카피 · 메모 목록 칸: 새 키 받기 (key-capture.js — 단축키 설정 창과 같은 동작)
function startCapture(name) {
  const el = $(`sc-${name}`);
  if (!el) return;
  captureGlobalKey(el, {
    api,
    name,
    note: (text, warn) => setScNote(name, text, warn),
    done: () => refreshShortcuts(),
    stopped: (reason) => reason !== 'commit' && refreshShortcuts(),
  });
}
$('keymap-open').addEventListener('click', () => api.keymap.openWindow());
for (const name of ['quickMemo', 'list']) {
  const btn = $(`sc-${name}`);
  const rst = $(`sc-${name}-reset`);
  if (btn) btn.addEventListener('click', () => (isCapturing(btn) ? stopKeyCapture('cancel') : startCapture(name)));
  if (rst) rst.addEventListener('click', async () => {
    const res = await api.settings.setShortcut(name, null);
    await refreshShortcuts();
    if (!res.ok) setScNote(name, globalShortcutResult(res, '', { reset: true }).text, true);
  });
}
// 다른 앱이 놓아 주어 1분마다 다시 잡기에 성공했을 때 등
api.on('shortcuts:changed', async () => {
  if (isCapturing()) return; // 여기서 바꾸는 중이면 끝날 때 다시 그린다
  await refreshShortcuts({ onlyIfChanged: true });
});
// ---------- 음성 녹음 · 받아쓰기 (desktop/stt) ----------
// 데이터는 처음 한 번 받는다 (받아쓰기 약 80MB, 말한 사람 나누기 약 30MB) — 이 PC 의 앱 데이터 폴더에, 메모 폴더에는 넣지 않음
function renderStt(st) {
  if (!st || !api.stt) return;
  const asr = st.asr;
  const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
  $('stt-enabled').checked = st.enabled;
  $('stt-note').textContent = asr.state === 'ready' ? '말하면 문장마다 글로 나타나고, 끝내면 소리와 함께 음성 카드로'
    : asr.state === 'downloading' ? `받아쓰기 데이터를 받는 중 ${pct(asr.progress)}`
      : asr.error ? `받지 못했어요: ${asr.error}` : `받아쓰기 데이터(${asr.size})가 필요해요. 한 번만 받으면 돼요`;
  const dl = $('stt-download');
  dl.hidden = asr.state === 'ready';
  dl.disabled = asr.state === 'downloading';
  dl.textContent = asr.state === 'downloading' ? `받는 중 ${pct(asr.progress)}` : `받아쓰기 데이터 받기 (${asr.size})`;
  $('stt-remove').hidden = asr.state !== 'ready';
  const spk = st.speaker;
  const sw = $('stt-speaker');
  sw.checked = st.speakerOn;
  sw.disabled = !st.enabled;
  $('stt-speaker-note').textContent = spk.state === 'downloading' ? `말한 사람 나누기 데이터를 받는 중 ${pct(spk.progress)}`
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
    if (!(await confirmDialog('받아쓰기 데이터를 삭제할까요?\n다시 쓰려면 다시 받아야 해요.', '삭제'))) return;
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
// ---------- AI 도우미 (desktop/ai — 인터넷 없이 이 PC 안에서) ----------
// 모델 파일(.gguf)은 사용자가 넣는다 (USB 로 옮긴 파일도). 이 PC 의 앱 데이터 폴더에 복사되고, 메모 폴더에는 넣지 않음
const AI_HINT = {
  chat: '맞춤법, 태그, 일정, 매직 에이전트에 써요. 아래에서 카나나2를 받아 주세요 (인터넷이 없는 PC는 받아 둔 파일 넣기)',
};
// 모델 이름: 기본 모델은 이름으로 (파일 이름은 사용자 말이 아님), 직접 넣은 모델은 파일 이름
const modelName = (m) => (DEFAULT_MODEL.file.test(m.name ?? '') ? DEFAULT_MODEL.label : m.name || '모델');
function renderAi(st, failed = {}) {
  if (!st) return;
  for (const role of ['chat']) {
    const m = st[role];
    const have = m.state === 'ready' || m.state === 'running';
    $(`ai-${role}-note`).textContent = !st.engine ? 'AI를 쓸 준비가 덜 됐어요. 백신이 AI 파일을 막았을 수 있어요. 아래에서 설치 파일을 다시 받아 덮어 설치하면 메모는 그대로예요'
      : failed[role] || m.error || (m.state === 'copying' ? (m.progress != null ? `${DEFAULT_MODEL.label}를 받는 중이에요 ${Math.round(m.progress * 100)}%` : '모델 파일을 복사하는 중이에요. 몇 분 걸릴 수 있어요')
        : have ? `${modelName(m)} · ${(m.size / 2 ** 30).toFixed(1)}GB${m.state === 'running' ? ' · 켜져 있어요' : ''}` : AI_HINT[role]);
    $(`ai-${role}-import`).disabled = !st.engine || m.state === 'copying';
    $(`ai-${role}-import`).title = !st.engine ? 'AI를 쓸 준비가 되면 넣을 수 있어요' : m.state === 'copying' ? '받거나 복사하는 중이에요' : '';
    $(`ai-${role}-import`).textContent = have ? '다른 파일로 바꾸기' : '받아 둔 파일 넣기';
    $(`ai-${role}-remove`).hidden = !have;
  }
  $('ai-reinstall-row').hidden = Boolean(st.engine);
  const ready = st.engine && ['ready', 'running'].includes(st.chat.state);
  // 기본 모델: 글 모델이 없을 때 한 번 받기 (인터넷이 없는 곳은 위 모델 파일 넣기). 예전 기본(젬마)을 받은 PC 는 바꾸기로, 받는 중이면 멈추기
  const old = st.chat.state === 'ready' && /gemma/i.test(st.chat.name ?? '');
  const downloading = st.chat.state === 'copying' && st.chat.progress != null;
  $('ai-default-row').hidden = !st.engine || !(st.chat.state === 'missing' || old || downloading);
  $('ai-default').hidden = downloading;
  $('ai-default-stop').hidden = !downloading;
  $('ai-default').textContent = old ? `${DEFAULT_MODEL.label}로 바꾸기 (${DEFAULT_MODEL.approx}, 한국어에 맞춘 모델)` : `${DEFAULT_MODEL.label} 받기 (${DEFAULT_MODEL.approx})`;
  $('ai-try').hidden = !ready;
  // 글 모델이 있으면 태그 켜고 끄기는 "AI 가 자동으로 하는 일" 묶음에서 (위 태그 자동 추가 줄은 AI 없는 PC 용)
  $('ai-auto-group').hidden = !ready;
  $('auto-tags').closest('label').hidden = ready;
}
// AI 태그: 예전 메모에도 달기 ⇄ 멈추기, 진행은 메인이 'ai:tagging' 으로 ({ done, total } · { error } · null = 끝)
const AI_TAGS_NOTE = $('ai-tags-note').textContent;
function renderAiTagging(p) {
  const on = Boolean(p && !p.error);
  $('ai-tags-note').textContent = p?.error ?? (on ? `AI 태그를 다는 중이에요 ${p.done} / ${p.total}` : AI_TAGS_NOTE);
  $('ai-tags-all').textContent = on ? '멈추기' : '예전 메모에도 달기';
  $('ai-tags-clear').hidden = on; // 다는 중에는 지우기를 멈추기 옆에 두지 않는다
}
if (api.ai) {
  api.on('ai:status', (st) => renderAi(st));
  for (const role of ['chat']) {
    $(`ai-${role}-import`).addEventListener('click', async () => {
      const st = await api.ai.importModel(role);
      renderAi(st, st?.error ? { [role]: st.error } : {});
    });
    $(`ai-${role}-remove`).addEventListener('click', async () => {
      if (!(await confirmDialog('이 모델 파일을 삭제할까요?\n다시 쓰려면 다시 넣어야 해요.', '삭제'))) return;
      renderAi(await api.ai.remove(role));
    });
  }
  $('ai-default').addEventListener('click', async () => {
    $('ai-default').hidden = true;
    const st = await api.ai.downloadDefault();
    renderAi(st, st?.error ? { chat: st.error } : {});
  });
  $('ai-default-stop').addEventListener('click', () => api.ai.cancelDownload());
  $('ai-reinstall').addEventListener('click', () => api.links.open(WINDOWS_SETUP));
  api.on('ai:tagging', renderAiTagging);
  api.tags.aiStatus().then(renderAiTagging);
  $('ai-tags-all').addEventListener('click', async () => {
    if ($('ai-tags-all').textContent === '멈추기') return api.tags.aiStop();
    const p = await api.tags.aiAll();
    if (!p?.total) $('ai-tags-note').textContent = '예전 메모도 모두 봤어요';
  });
  $('ai-tags-clear').addEventListener('click', async () => {
    if (!(await confirmDialog('AI가 단 태그를 모든 메모에서 지울까요?\n지운 메모에는 AI 태그를 다시 달지 않아요. 직접 단 태그는 그대로예요.', '지우기'))) return;
    const n = await api.tags.aiClear();
    $('ai-tags-note').textContent = n ? `메모 ${n}개에서 AI 태그를 지웠어요` : '지울 AI 태그가 없어요';
  });
  $('ai-try').addEventListener('click', async () => {
    const btn = $('ai-try');
    btn.disabled = true;
    $('ai-try-out').textContent = '모델을 올리고 묻는 중이에요…';
    const r = await api.ai.try();
    btn.disabled = false;
    $('ai-try-out').textContent = r.error ? r.error : `답: ${r.text} (${r.seconds.toFixed(1)}초)`;
  });
} else {
  $('local-ai-sec').hidden = true;
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
// 태그 자동 추가: AI 없는 PC 는 위 줄, 글 모델이 있으면 AI 묶음의 줄 (같은 설정)
for (const id of ['auto-tags', 'auto-tags-ai']) {
  $(id).addEventListener('change', async (e) => {
    $('auto-tags').checked = $('auto-tags-ai').checked = await api.settings.setAutoTags(e.target.checked);
  });
}
$('magic-polish').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setMagicPolish(e.target.checked);
});
$('auto-events').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setAutoEvents(e.target.checked);
});
$('ai-phone').addEventListener('change', async (e) => {
  e.target.checked = await api.settings.setAiPhone(e.target.checked);
});

// 메모 보기 › 내 손에 맞추기: 꾹 눌러 줄 옮기기 시간 (메모 창들과 같은 저장소 — hold-tune.js)
// 메모 보기 › 넣을 때 묻기: "앞으로 이렇게" 로 기억한 것을 지운다 (메모 창들과 같은 저장소 — rename-content.js)
const choicesBtn = $('choices-reset');
const paintChoices = () => {
  const kept = hasRememberedChoices();
  choicesBtn.hidden = !kept; // 지울 것이 없으면 꺼진 단추 대신 지금 상태만 글로
  $('choices-note').textContent = kept
    ? '사진 여러 장 · 문서를 넣을 때 "앞으로 이렇게" 로 정해 둔 것이 있어요. 지우면 다시 물어요'
    : '사진 여러 장 · 문서를 넣을 때마다 어떻게 넣을지 물어요';
};
choicesBtn.addEventListener('click', () => {
  forgetChoices();
  paintChoices();
});
window.addEventListener('focus', paintChoices); // 메모 창에서 정하고 돌아왔을 때
window.addEventListener('storage', (e) => e.key === 'memoking.choices' && paintChoices()); // 메모 창에서 정하면 바로
paintChoices();
$('hold-tune').checked = holdTune().on;
$('hold-tune').addEventListener('change', (e) => setHoldTune({ on: e.target.checked }));
$('hold-reset').addEventListener('click', () => {
  setHoldTune({ reset: true });
  const b = $('hold-reset');
  b.textContent = '되돌렸어요';
  b.disabled = true;
  setTimeout(() => {
    b.textContent = '처음 값으로';
    b.disabled = false;
  }, 1500);
});
$('history-enabled').addEventListener('change', async (e) => {
  e.target.checked = await api.history.setEnabled(e.target.checked);
  historyTab.refresh();
});

// ---------- 탭: 메모 · 알림 예약 · 알림 보관함 ----------

const TAB_PLACEHOLDER = { memos: '메모 검색 (Ctrl+F)', reminders: '일정 검색', history: UI.searchHistory };
let activeTab = 'memos';

const remindersTab = setupRemindersTab({
  api, container: $('reminder-groups'), countEl: $('count-reminders'),
  notify: (text, isErr) => (isErr ? window.alert(text) : flashStatus(text)),
  // 다른 캘린더 함께 보기 (읽기만): 구독은 메인이 받는다, 일정 속 주소는 브라우저로
  calendars: api.calendars && { ...api.calendars, openUrl: (url) => api.links.open(url) },
  // 회상 "한 장으로": 미리보기에서 공유(Drive · LocalSend · 메일) · 복사 · 저장 · 메모로 만들기
  // 지금 모드의 메모 일정만 (목록에 아직 없는 새 메모의 일정은 우선 보인다)
  visible: (item) => {
    const memo = state.memos.find((m) => m.id === item.memoId);
    return !state.workLife || !memo || memoMode(memo) === state.mode;
  },
  memories: {
    mode: () => (state.workLife ? state.mode : null), // 회상도 지금 모드의 메모로 (나눠 쓰지 않으면 모두)
    notify: (text) => flashStatus(text),
    collage: {
      render: (o) => renderCollage(o),
      actions: (base64, o) => [
        { id: 'share', label: '공유', icon: 'share', run: async (button) => {
          const targets = await api.attachments.shareTargets();
          const via = await chooseShare(button, targets);
          if (!via) return '';
          if (!targets.find((t) => t.id === via)?.ready) {
            el.settingsBtn.click();
            return UI.driveFirst;
          }
          if (via === 'drive') flashStatus(UI.driveUploading);
          const r = await api.attachments.share({ name: collageName(o), mime: 'image/png', base64, via });
          if (r?.error) throw new Error(r.error);
          if (r?.missing) return SHARE_DONE['localsend-missing'];
          if (via === 'drive') {
            showSharePop({ title: UI.linkCopied, sub: UI.pasteHint });
            return '';
          }
          return SHARE_DONE[via] ?? '보냈어요';
        } },
        { id: 'copy', label: '복사', icon: 'copy', run: async () => {
          await api.image.copy(base64);
          return UI.imageCopied;
        } },
        { id: 'save', label: '저장', icon: 'folder', run: async () => {
          const r = await api.image.save(null, base64, collageName(o));
          return r?.file ? `${r.name}로 저장했어요` : '';
        } },
        { id: 'memo', label: UI.makeMemo, icon: 'note', close: true, run: async () => {
          const rel = await api.attachments.save(base64Bytes(base64), 'png');
          await api.memo.import(collageMemoBody(o.title, rel), { open: true });
          return UI.madeNewMemo;
        } },
      ],
    },
  },
});
// 앱 하나를 더 모으지 않기: 이미 모은 것도 지울지 묻는다
async function blockHistoryApp(appId, appName) {
  if (!(await confirmDialog(`${appName} 알림을 더 이상 보관하지 않을까요?\n알림 보관함의 모을 앱에서 다시 켤 수 있어요.`, '보관 중지'))) return false;
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
    small.textContent = a.blocked ? UI.noHistory : `알림 ${a.count}개 보관 중`;
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
  notify: (text) => flashStatus(text),
  menu: (items, at) => api.menu.choose(items, at),
  els: {
    consent: $('history-consent'), body: $('history-body'), enable: $('history-enable'),
    clear: $('history-clear'), app: $('history-app'), rows: $('history-rows'), empty: $('history-empty'),
  },
});

// 탭의 흰 선택 표시가 다음 탭으로 미끄러진다 (seg-slider.js — 휴대폰·다른 고르기 칸과 같은 움직임)
attachSlider(document.querySelector('.tabs'), { className: 'tab-indicator' });

function showTab(tab) {
  if (!TAB_PLACEHOLDER[tab]) return;
  // 메모 탭을 떠날 때: 일정 · 보관함이 메모 칸과 같은 자리 · 크기로 그 위를 덮는다 (list.css) — 돌아올 때 카드 배치를 처음부터 다시 계산하지 않게
  const memosView = $('view-memos');
  if (tab !== 'memos' && !memosView.hidden) {
    el.main.style.setProperty('--park-top', `${memosView.offsetTop}px`);
  }
  activeTab = tab;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  syncTabStops(document.querySelector('.tabs'));
  for (const name of Object.keys(TAB_PLACEHOLDER)) if (name !== 'memos') $(`view-${name}`).hidden = name !== tab;
  // 메모 칸은 숨기지 않고 덮는다 (누르기 · Tab · 화면 읽기 프로그램에서는 빠짐)
  memosView.inert = tab !== 'memos';
  memosView.classList.toggle('covered', tab !== 'memos');
  document.body.dataset.tab = tab;
  el.search.placeholder = TAB_PLACEHOLDER[tab];
  el.search.value = '';
  // 메모 탭으로 돌아올 때: 그사이 바뀐 것이 없으면 다시 그리지 않는다 (숨겨 둔 카드는 그대로 남아 있다)
  //   — 늘 모든 카드를 다시 쌓아(배치 계산) 탭의 표시가 미끄러지는 동안 화면이 멈칫했다
  if (tab === 'memos' && (memosStale || state.query || lastCols !== columnsFor(el.cards.clientWidth || window.innerWidth))) runSearch();
  if (tab === 'reminders') {
    // 달력은 탭 표시가 먼저 바뀐 다음 프레임에, 바뀐 일정이 없으면 다시 그리지 않고 (달력 그리기가 탭 전환을 붙잡았다)
    remindersTab.setQuery('', { quiet: true });
    const my = ++tabSeq;
    requestAnimationFrame(() => setTimeout(() => my === tabSeq && activeTab === 'reminders' && remindersTab.refresh({ ifChanged: true }), 0));
  }
  if (tab === 'history') historyTab.setQuery('');
}
let tabSeq = 0;
for (const b of document.querySelectorAll('.tabs [data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
tabKeys(document.querySelector('.tabs'));
api.on('list:tab', showTab);
api.on('reminders:changed', () => remindersTab.refresh({ quiet: activeTab !== 'reminders' })); // 안 보이는 달력은 탭으로 갈 때 그린다
api.on('history:changed', () => activeTab === 'history' && historyTab.refresh());
$('reveal-vault').addEventListener('click', () => api.vault.reveal());
$('change-vault').addEventListener('click', async () => {
  el.settings.close();
  applyInfo(await api.vault.choose());
});

// 카드 오른쪽 클릭(또는 메뉴 키 · Shift+F10): 맨 위 아이콘 줄(복사 · 공유 · PDF · 휴지통) + 열기 · 고정 · 색 · 잠그기 · 이전 버전 (list-card-menu.js)
async function togglePin(m) {
  // 목록이 새로 오기 전에 한 번 더 눌러도 맞게 되도록 바로 바꿔 보여 준다
  m.pinned = !m.pinned;
  render();
  const want = m.pinned;
  const memo = await api.memo.set(m.id, { pinned: want });
  // 저장하지 못했다(파일이 잠깐 없는 등) — 바꿔 보여 준 것을 되돌린다
  if (!memo && m.pinned === want) {
    m.pinned = !want;
    render();
  }
}
// 카드 위에 마우스를 잠깐 두면(처음 한 번) 오른쪽 클릭 메뉴가 있다고 알려 준다
{
  let hoverTimer = 0;
  el.cards.addEventListener('mouseover', (e) => {
    clearTimeout(hoverTimer);
    const card = e.target.closest?.('.card');
    if (!card || !api.memo.cardCommand) return;
    hoverTimer = setTimeout(() => card.isConnected && card.matches(':hover') && hintOnce('card-menu', '카드를 오른쪽 클릭하면 복사, 공유, 색, 고정 같은 메뉴가 떠요', { anchor: card }), 1500);
  });
  el.cards.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
}
el.cards.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.defaultPrevented || !api.memo.cardCommand) return;
  e.preventDefault();
  const memo = state.memos.find((m) => m.id === card.dataset.id);
  if (!memo) return;
  // 키보드(메뉴 키 · Shift+F10 — button 0)로 열면 마우스 자리가 아니라 그 카드 자리에
  const r = card.getBoundingClientRect();
  const at = e.button !== 2 ? { x: Math.round(r.left + 16), y: Math.round(r.top + 16) } : { x: e.clientX, y: e.clientY };
  openCardMenu({
    memo, at, api, workLife: state.workLife,
    run: {
      open: (id) => api.memo.open(id),
      pin: togglePin,
      color: (m, color) => api.memo.set(m.id, { color }),
      day: async (m) => {
        const day = await openMemoryDay({ created: m.created, day: m.day });
        if (day === null) return;
        await api.memo.set(m.id, { day });
        flashStatus(day ? `회상 달력의 ${dayText(day)}에 두었어요` : UI.dateReset);
      },
      // Work ↔ Life로 옮기기: 카드는 지금 목록에서 빠진다
      mode: async (m) => {
        const to = otherMode(memoMode(m));
        if (await api.memo.set(m.id, { mode: to })) flashStatus(`${MODE_LABEL[to]}로 옮겼어요. 위의 ${MODE_LABEL[to]}에서 보여요`);
        else flashStatus(UI.moveFail);
      },
      folder: (m) => moveToFolder([m.id], m.folder ?? ''),
      trash: (id) => deleteMemo(id),
      flash: flashStatus,
      openSettings: () => el.settingsBtn.click(),
    },
  }).then(() => card.isConnected && document.activeElement === document.body && card.focus({ preventScroll: true }));
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
    return m ? togglePin(m) : undefined;
  }
  const cardFolder = e.target.closest('[data-card-folder]');
  if (cardFolder) {
    el.search.value = '';
    state.query = '';
    setFolder(cardFolder.dataset.cardFolder);
    return runSearch();
  }
  const card0 = e.target.closest('.card');
  // Ctrl(⌘)+클릭: 여러 장 고르기 (아래 막대에서 폴더로 옮기기)
  if (card0 && (e.ctrlKey || e.metaKey)) return togglePick(card0.dataset.id);
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
  markFolderDrop(e.clientX, e.clientY);
});

el.cards.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  const p = press;
  press = null;
  if (!p.dragging) return; // 그냥 클릭 → click 이벤트가 연다
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  // 왼쪽 폴더 막대에 놓으면 그 폴더로 (고른 카드가 여럿이고 이 카드도 골랐으면 모두)
  const target = markFolderDrop(e.clientX, e.clientY);
  markFolderDrop(-1, -1);
  if (target != null) {
    finishDrag(p, null);
    return moveToFolder(state.picked.has(p.id) ? [...state.picked] : [p.id], null, target);
  }
  finishDrag(p, { x: e.screenX, y: e.screenY });
});

el.cards.addEventListener('dragstart', (e) => e.preventDefault()); // 브라우저 기본 드래그 끄기

// 끄는 카드 아래의 폴더 (막대에 있으면 그 폴더 이름, "" 은 전체 = 폴더에서 빼기) — 표시도 한다
function markFolderDrop(x, y) {
  const item = el.folderSide.hidden ? null : document.elementFromPoint(x, y)?.closest('#folder-side [data-folder]');
  for (const b of el.folderSide.querySelectorAll('.drop-on')) if (b !== item) b.classList.remove('drop-on');
  item?.classList.add('drop-on');
  return item ? item.dataset.folder : null;
}

// ---------- 폴더로 옮기기 (카드 메뉴 · 끌어 놓기 · 여러 장 고르기) ----------

const pickBar = createPickBar({ onMove: () => moveToFolder([...state.picked], ''), onCancel: () => clearPicks() });

function showPicks() {
  for (const c of el.cards.querySelectorAll('.card')) c.classList.toggle('picked', state.picked.has(c.dataset.id));
  pickBar.show(state.picked.size, state.picked.size > 0);
}

function togglePick(id) {
  if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  showPicks();
}

function clearPicks() {
  if (!state.picked.size) return false;
  state.picked.clear();
  showPicks();
  return true;
}

/** 메모들을 폴더로: to 가 없으면 폴더 고르기 창 (current: 지금 폴더 — 고르기 창에서 흐리게) */
async function moveToFolder(ids, current, to = undefined) {
  if (!ids.length) return;
  let target = to;
  if (target === undefined) {
    target = await pickFolder({ folders: state.folderDirs ?? [], current: ids.length === 1 ? current : null, count: ids.length });
    if (target === null) return;
  }
  try {
    const moved = await api.memos.moveToFolder(ids, target);
    clearPicks();
    loadFolders();
    flashStatus(movedText(moved, target));
  } catch (err) {
    flashStatus(err.message || '옮기지 못했어요');
  }
}

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
  if (state.onlyFiles) closeOnlyFiles(); // 검색하면 사본만 보기는 푼다 (메모가 바뀌어 검색을 다시 돌릴 때는 그대로)
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cancelDrag()) return;
  if (e.key === 'Escape' && clearPicks()) return;
  if (e.key === 'Escape' && setFabMenu(false)) return;
  if (e.key === 'Escape' && !el.filterPanel.hidden) {
    setFilterPanel(false);
    el.filterBtn.focus();
    return;
  }
  if (el.settings.open || el.confirm.open || el.main.hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyN') {
    e.preventDefault();
    newMemo();
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
  if (state.folderDirs && memos.some((m) => isFolderName(m.folder) && !state.folderDirs.includes(m.folder))) loadFolders(); // 다른 기기 · 탐색기에서 생긴 폴더
  // 이어 쓰기 막대의 메모를 다른 길(카드 두 번 누르기 등)로 열었으면 막대를 치운다
  const hb = $('handoff-bar');
  if (hb && !hb.hidden && memos.some((m) => m.id === hb.dataset.id && m.open)) hb.hidden = true;
  $('count-memos').textContent = modeMemos().length ? String(modeMemos().length) : ''; // 0 은 숨김 (일정 탭과 같이)
  if (activeTab !== 'memos') {
    memosStale = true; // 메모 탭으로 돌아오면 다시 그린다
    return remindersTab.refresh({ quiet: activeTab !== 'reminders' }); // 메모 제목이 바뀌면 알림 탭에도
  }
  if (state.query) runSearch();
  else render();
});
api.on('vault:opened', (info) => {
  applyInfo(info);
  refresh();
});

// ---------- 시작 ----------

injectIcons();
// 튜토리얼 뒷정리: 연습하라고 바꾸게 한 것(카드 모양 · 확대 · 태그 고르기 · Work/Life · 목록 늘 위에)은 끝나면 처음대로
//   첫 말풍선이 이 창에 뜰 때 지금 모습을 적어 두고, 끝나거나 그만두면(tutorial:finished) 되돌린다
let tutBefore = null;
const coach = setupCoach(api, {
  onStep: (step) => {
    if (step && !tutBefore) tutBefore = { layout, zoom: listZoom, tags: [...state.filter.tags], mode: state.mode, top: Boolean(listTop), panel: !el.filterPanel.hidden };
  },
});
api.on('tutorial:finished', () => {
  const b = tutBefore;
  tutBefore = null;
  if (!b) return;
  if (layout !== b.layout) {
    layout = b.layout;
    applyLayout();
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // 지금 창에서만
    }
  }
  if (listZoom !== b.zoom) setListZoom(b.zoom, { show: false });
  state.filter.tags = b.tags;
  if (state.workLife && state.mode !== b.mode) setMode(b.mode);
  if (!b.top && listTop) api.win.toggleListTop();
  if (!b.panel && !el.filterPanel.hidden) el.filterBtn.click(); // "보기"를 열어 보라고 했던 칸도 닫는다
  render();
});
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
  tutEvent('list-zoomed'); // 튜토리얼: 카드를 크게, 작게
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

// ---------- 정렬 (최신순 · 오래된순 · 많이 본 순 · 이름순) — "보기" 패널, 휴대폰과 같은 규칙(core/memo-sort.js), 이 PC 에 기억 ----------
//   고정한 메모는 늘 맨 앞. 많이 본 순은 이 PC 에서 메모 창을 연 횟수 (main.js noteOpened)
const SORT_KEY = 'memoking.sort';
// 보기 패널의 고르기 칩 (정렬 · 카드 모양): 하나만 켜짐
function radioChips(box, options, current) {
  box.replaceChildren(...options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter-chip';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(o.id === current));
    b.tabIndex = o.id === current ? 0 : -1;
    b.dataset.value = o.id;
    b.textContent = o.label;
    return b;
  }));
}
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
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // 지금 창에서만
  }
  render(); // 카드들이 새 순서로 미끄러져 간다 (animateCards)
  el.sortGroup.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
});

// ---------- 카드 모양 (격자 / 한 줄씩) — 휴대폰과 같은 단추, 이 PC 에 기억 ----------
const LAYOUTS = [{ id: 'grid', label: '격자' }, { id: 'rows', label: '한 줄씩' }];
function applyLayout() {
  el.cards.dataset.layout = layout;
  radioChips(el.layoutGroup, LAYOUTS, layout);
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
el.layoutGroup.addEventListener('click', (e) => {
  const b = e.target.closest('[data-value]');
  if (!b || b.dataset.value === layout) return;
  layout = b.dataset.value === 'rows' ? 'rows' : 'grid';
  tutEvent('layout-changed');
  glideCards(() => {
    applyLayout();
    renderNow();
  });
  el.layoutGroup.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // 지금 창에서만
  }
});
// 목록 창 늘 위에 두기 (창 제목 줄, 최소화 버튼 옆)
const listTopBtn = $('list-top-btn');
// 스티커를 붙이고 떼는 느낌: 누르면 버튼의 왕관이 떨어져 나가 창 위 가장자리 스티커가 되고(버튼은 빈 자리),
// 스티커를 누르면 떼어져 늘 위에 두기가 꺼지고 왕관이 버튼으로 돌아온다.
// 창이 좁아지거나 최대화 · 화면 끝이라 스티커가 잘릴 때는 스티커가 작아져 이 단추 자리에 작은 왕관으로 들어온다 (docked — 누르면 떼어짐).
//   자리가 나면 작은 왕관이 들려 나가고 다시 스티커가 붙는다 (window-manager listStickerFits)
let listTop = null;
let crownDocked = false;
const crownMini = listTopBtn.querySelector('.crown-mini');
const crownLine = listTopBtn.querySelector('.crown-line');
function paintListTop() {
  const on = Boolean(listTop);
  const docked = on && crownDocked;
  listTopBtn.setAttribute('aria-pressed', String(on));
  listTopBtn.classList.toggle('peeled', on && !docked);
  listTopBtn.classList.toggle('docked', docked);
  listTopBtn.tabIndex = on && !docked ? -1 : 0;
  listTopBtn.setAttribute('aria-hidden', String(on && !docked));
  listTopBtn.title = docked ? '늘 위에 두는 중이에요. 창이 좁아 왕관 스티커를 여기에 넣어 두었어요. 누르면 늘 위에 두기가 꺼져요'
    : on ? '창 위의 왕관 스티커를 누르면 늘 위에 두기가 꺼져요' : '왕관 스티커를 붙여 목록을 다른 창보다 늘 위에 두기';
  listTopBtn.setAttribute('aria-label', on ? '목록 늘 위에 두기 끄기' : '목록을 다른 창보다 늘 위에 두기');
}
const showListTop = (on, animate = true) => {
  const was = { top: Boolean(listTop), docked: Boolean(listTop) && crownDocked };
  const first = listTop === null;
  listTop = on;
  if (!on) crownDocked = false; // 떼면 다음에 붙일 때는 메인이 다시 알려 준다 (처음부터 잘릴 자리면 list:crown-docked 가 먼저 온다)
  paintListTop();
  if (first || !animate || reduceMotion() || was.top === on) return;
  if (on && crownDocked) {
    // 좁은 창에서 붙임: 스티커 대신 줄 그림 왕관이 작은 왕관으로 바뀌며 통 하고 들어앉는다
    crownMini.animate([{ opacity: 0, transform: 'scale(0.4) rotate(12deg)' }, { opacity: 1, transform: 'scale(1.15)', offset: 0.7 }, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE_OUT });
    return;
  }
  const lineAnim = () => crownLine.animate(on
    ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px) rotate(-12deg) scale(0.7)' }]
    : [{ opacity: 0, transform: 'scale(0.4) rotate(12deg)' }, { opacity: 1, transform: 'scale(1.15)', offset: 0.7 }, { opacity: 1, transform: 'none' }],
  { duration: on ? 200 : 280, easing: EASE_OUT });
  if (!(was.docked && !on)) return lineAnim();
  // 작은 왕관을 눌러 뗌: 작은 왕관이 들리며 사라진 뒤(그동안은 작은 왕관을 보인 채로) 줄 그림 왕관이 돌아온다
  listTopBtn.classList.add('undocking');
  crownMini.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px) rotate(10deg) scale(1.2)' }], { duration: 160, easing: EASE_OUT })
    .finished.catch(() => {}).finally(() => {
      listTopBtn.classList.remove('undocking');
      if (!listTop) lineAnim(); // 그사이 다시 붙였으면 그 상태 그대로
    });
};
// 스티커 ↔ 작은 왕관 (늘 위에 두는 동안 창 크기 · 자리에 따라)
function setCrownDocked(docked, animate = true) {
  if (docked === crownDocked) return;
  crownDocked = docked;
  const shown = Boolean(listTop);
  if (!shown || !animate || reduceMotion()) return paintListTop();
  if (docked) {
    paintListTop();
    // 스티커가 작아지며 사라지는 사이(0.15초) 작은 왕관이 위에서 내려와 들어앉는다
    crownMini.animate([{ opacity: 0, transform: 'translateY(-10px) scale(1.6) rotate(-10deg)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: 60, easing: EASE_OUT, fill: 'backwards' });
  } else {
    // 작은 왕관이 들려 나간 뒤 단추는 빈 자리 (곧 창 위에 스티커가 붙는다)
    listTopBtn.classList.add('undocking');
    crownMini.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px) scale(1.3)' }], { duration: 160, easing: EASE_OUT })
      .finished.catch(() => {}).finally(() => {
        listTopBtn.classList.remove('undocking');
        paintListTop();
      });
  }
}
// 버튼: 붙이기 · 작은 왕관이면 떼기 (스티커는 창 위의 스티커를 눌러서). 상태는 list:on-top 으로 돌아온다
listTopBtn.addEventListener('click', () => {
  if (!listTop || crownDocked) api.win.toggleListTop();
});
api.on('list:on-top', (on) => {
  showListTop(on);
  if (on) tutEvent('list-crown-on'); // 튜토리얼: 목록도 늘 위에
});
api.on('list:crown-docked', ({ docked, animate } = {}) => setCrownDocked(Boolean(docked), animate !== false));
Promise.all([api.win.listOnTop(), api.win.listCrownDocked?.() ?? false]).then(([on, docked]) => {
  crownDocked = Boolean(docked);
  showListTop(on, false);
});
// 대화 상자·튜토리얼이 떠 있으면 창 버튼 줄도 어둡게 (Windows 가 그리는 줄이라 화면의 막이 닿지 않는다)
let dimLevel = false;
function syncTitlebarDim() {
  const level = el.settings.open || el.confirm.open || $('trash-dialog').open || $('apps-dialog').open || $('drive-dialog')?.open || document.querySelector('body > :is(.mem-album, .mem-preview):not(.closing)') ? 'dialog' : document.body.classList.contains('coaching') ? 'coach' : false;
  if (level === dimLevel) return;
  dimLevel = level;
  api.win.dimTitlebar(level);
}
const dimWatcher = new MutationObserver(syncTitlebarDim);
for (const d of [el.settings, el.confirm, $('trash-dialog'), $('apps-dialog'), $('drive-dialog')].filter(Boolean)) dimWatcher.observe(d, { attributes: true, attributeFilter: ['open'] });
dimWatcher.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true }); // 회상 달력의 그날의 기록도 (body 에 붙었다 떨어짐)
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
    ? `삭제한 메모는 여기에 있다가 ${DAYS_LABEL[s.trashDays] ?? `${s.trashDays}일`}이 지나면 저절로 삭제돼요.`
    : '삭제한 메모는 직접 삭제할 때까지 여기에 있어요.';
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
    // 저절로 비우는 휴지통이면 남은 날도 (언제 사라지는지 몰라 불안하지 않게)
    const left = s.trashDays > 0 ? Math.ceil(s.trashDays - (Date.now() - Date.parse(t.deletedAt)) / 86400e3) : null;
    const leftText = left == null || Number.isNaN(left) ? '' : left <= 1 ? '곧 영구 삭제' : `${left}일 뒤 영구 삭제`;
    sub.textContent = [`${agoText(t.deletedAt)} 지움`, leftText, t.preview].filter(Boolean).join(', ');
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

// 문제 보내기: 최근 오류 기록을 붙인 새 메일 (전체 기록은 클립보드에) — 보낼지는 사용자가
$('report-btn').addEventListener('click', async () => {
  const r = await api.reportProblem?.();
  $('report-btn').textContent = r?.ok ? '메일 앱을 열었어요 · 기록은 클립보드에' : '메일 앱을 열지 못했어요';
  setTimeout(() => ($('report-btn').textContent = '문제 보내기'), 4000);
});
$('tutorial-btn').addEventListener('click', () => {
  el.settings.close();
  api.tutorial.start();
});
// 처음 한 번만 뜨던 작은 안내(hints.js · 왕관/테이프 안내)를 다시 — 지나간 안내를 다시 볼 길 (모든 창이 같은 기억을 쓴다)
$('hints-reset').addEventListener('click', () => {
  try {
    for (const k of ['memoking.hints', 'memoking.stickerHintSeen']) localStorage.removeItem(k);
  } catch {
    // 기억을 못 지우면 그대로
  }
  flashStatus('작은 안내를 그 상황이 되면 다시 보여 드릴게요');
});
applyInfo(await api.info());
// 업데이트 뒤 한 번: 개선된 점 (메인이 한 번만 준다)
api.whatsNew?.().then((n) => {
  if (!n?.items?.length || !$('whatsnew-dialog')) return;
  $('whatsnew-title').textContent = `v${n.version}으로 업데이트했어요`;
  $('whatsnew-list').replaceChildren(...n.items.map((it) => Object.assign(document.createElement('li'), { textContent: it.title })));
  $('whatsnew-dialog').showModal();
}, () => {});
$('whatsnew-ok')?.addEventListener('click', () => $('whatsnew-dialog').close());
if (api.drive) drivePanel = setupDrivePanel({ api, onVault: (info) => applyInfo(info), confirm: confirmDialog, showFiles: (files) => showOnlyFiles(files),
  memoFiles: () => (state.memos.length ? new Set(state.memos.map((m) => String(m.file ?? '').replace(/\\/g, '/'))) : null) });
{
  const s = await api.settings.get().catch(() => null);
  state.workLife = s?.workLife === true;
  state.mode = state.workLife ? validMode(s?.mode) : 'life';
}
showMode();
for (const b of document.querySelectorAll('#mode-switch [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
// 다른 곳에서 모드 · 나누기가 바뀜 (업무 시간 시계 · 설정)
api.on('mode:changed', ({ mode, enabled } = {}) => {
  const next = enabled ? validMode(mode) : 'life';
  if (next === state.mode && Boolean(enabled) === state.workLife) return;
  state.workLife = Boolean(enabled);
  state.mode = next;
  withViewTransition(() => {
    showMode({ later: true });
    render();
    remindersTab.modeChanged();
  }).then(syncSwitch);
});
await refresh();
showMode();
await remindersTab.refresh();
showTab(new URLSearchParams(location.search).get('tab') ?? 'memos');
document.documentElement.dataset.ready = 'true';

// 고르기 칸(role=radiogroup): 칸마다 radio, 화살표로 고르기 (dom.js)
radioGroups();

// ---------- 자동 업데이트 (desktop/updater.js) ----------
// 새 버전: 바뀐 점을 보여 주고 받기 → 진행률 → 다 받으면 "지금 재시작" / "나중에 (끝낼 때 설치)".
//   "나중에" 를 고른 버전은 24시간 다시 묻지 않는다 (main 이 기억). 설정 › 업데이트 확인 은 숨겨 둔 버전도 다시 보여 준다
const updateEl = {
  dialog: $('update-dialog'), title: $('update-title'), version: $('update-version'), notes: $('update-notes'),
  progress: $('update-progress'), fill: $('update-bar-fill'), progressText: $('update-progress-text'), error: $('update-error'),
  later: $('update-later'), go: $('update-go'), note: $('update-note'), current: $('update-current'), check: $('update-check'),
};
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
let updateSt = { status: 'idle' };

function showUpdateRow(st) {
  updateEl.current.textContent = st.current ? `v${st.current}` : '';
  const text = {
    idle: UI.updWait,
    checking: UI.updChecking,
    latest: UI.updLatest,
    dev: '개발 중에는 확인하지 않아요',
    available: `새 버전 v${st.version}이 나왔어요`,
    downloading: UI.updDownloading,
    ready: `v${st.version}을 받아 뒀어요. 끝낼 때도 설치돼요`,
    error: st.message ?? '',
  }[st.status] ?? '';
  updateEl.note.textContent = text;
  updateEl.note.classList.toggle('warn', st.status === 'error');
  // 단추: 최신이면 초록 "최신 버전", 새 버전이 있으면 노랑 "업데이트" (누르면 바뀐 점 · 받기), 받는 중 · 받아 둠도 그 자리에서
  const label = {
    checking: UI.updCheckingShort,
    latest: UI.updLatestShort,
    available: `업데이트 v${st.version}`,
    downloading: `받는 중 ${st.percent ?? 0}%`,
    ready: '재시작해서 설치',
  }[st.status];
  updateEl.check.dataset.state = label ? st.status : 'idle';
  updateEl.check.textContent = label ?? UI.updCheck;
  updateEl.check.classList.toggle('primary', st.status === 'available' || st.status === 'ready'); // 노랑 (기본 단추 모양)
  updateEl.check.title = { latest: '눌러서 다시 확인', available: '다시 확인한 뒤 바뀐 점을 보고 받아요', ready: '쓰던 메모를 저장하고 다시 시작해 설치해요' }[st.status] ?? '';
  updateEl.check.disabled = st.status === 'checking';
}

function renderUpdateDialog(st) {
  const ready = st.status === 'ready';
  const downloading = st.status === 'downloading';
  updateEl.title.textContent = ready ? UI.updReady : UI.updNew;
  // "v0.44.0 → v0.45.0": 지금 버전은 흐리게, 새 버전은 또렷하게 (화면 읽기 프로그램에는 "에서 로" 로 읽힌다)
  const from = document.createElement('span');
  from.className = 'from';
  from.textContent = `v${st.current ?? ''}`;
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';
  const to = document.createElement('span');
  to.className = 'to';
  to.textContent = `v${st.version ?? ''}`;
  updateEl.version.replaceChildren(from, arrow, to);
  updateEl.version.setAttribute('aria-label', `지금 ${from.textContent}에서 ${to.textContent}으로`);
  renderReleaseNotes(updateEl.notes, st.notes);
  updateEl.notes.scrollTop = 0;
  updateEl.progress.hidden = !downloading;
  updateEl.fill.style.transform = `scaleX(${Math.max(0, Math.min(100, st.percent ?? 0)) / 100})`;
  updateEl.progressText.textContent = downloading
    ? `${st.percent ?? 0}%${st.total ? ` · ${mb(st.transferred ?? 0)} / ${mb(st.total)}` : ''}${st.bytesPerSecond ? ` · 초당 ${mb(st.bytesPerSecond)}` : ''}`
    : '';
  updateEl.error.hidden = st.status !== 'error';
  updateEl.error.textContent = st.status === 'error' ? st.message ?? '' : '';
  updateEl.go.textContent = ready ? '지금 재시작' : downloading ? '받는 중' : st.status === 'error' ? '다시 확인' : '받기';
  updateEl.go.disabled = downloading;
  updateEl.later.textContent = ready ? '나중에 (끝낼 때 설치)' : downloading ? UI.updCloseKeep : '나중에';
}

function onUpdate(st, { open = false } = {}) {
  updateSt = st ?? updateSt;
  showUpdateRow(updateSt);
  if (updateEl.dialog.open || open) renderUpdateDialog(updateSt);
  if (open && !updateEl.dialog.open) updateEl.dialog.showModal();
}

api.on('update:state', (st) => onUpdate(st));
api.on('update:available', (st) => onUpdate(st, { open: true }));
api.on('update:ready', (st) => onUpdate(st, { open: true }));
updateEl.check.addEventListener('click', async () => {
  if (updateSt.status === 'ready') return api.update.install(); // 받아 둔 것: 메모를 저장하고 바로 재시작
  if (updateSt.status === 'downloading') return onUpdate(updateSt, { open: true }); // 진행률
  // 그 밖(새 버전이 있어도): 다시 확인하고 — 더 새 버전이 나왔거나 내려갔을 수 있다 — 새 버전이면 바뀐 점
  const before = updateSt;
  onUpdate({ ...updateSt, status: 'checking' });
  let st;
  try {
    st = await api.update.check();
  } catch {
    st = { ...before, status: 'error', message: '업데이트를 확인하지 못했어요. 잠시 뒤 다시 눌러 주세요' };
  }
  onUpdate(st, { open: st.status === 'available' || st.status === 'ready' });
});
updateEl.go.addEventListener('click', async () => {
  if (updateSt.status === 'ready') return api.update.install(); // 쓰던 메모를 저장하고 다시 시작
  if (updateSt.status === 'error') {
    const st = await api.update.check();
    if (st.status === 'available' || st.status === 'ready' || st.status === 'error') return onUpdate(st, { open: true });
    updateEl.dialog.close(); // 최신이거나 확인 중 — 받을 것이 없으니 대화 상자를 닫고 설정 칸에만
    return onUpdate(st);
  }
  onUpdate(await api.update.download());
});
updateEl.later.addEventListener('click', async () => {
  if (updateSt.status !== 'downloading') onUpdate(await api.update.later());
  updateEl.dialog.close();
});
// 목록 창을 열 때: 숨기지 않은 새 버전 · 받아 둔 업데이트가 있으면 (알림을 눌러 열었을 때 등)
api.update.state().then((st) => onUpdate(st, { open: st.ask }), () => {});
