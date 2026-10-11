// 메모 화면 — 데스크탑 스티커 창(app/js/note.js)을 휴대폰 한 화면으로.
// 편집기(app/js/editor.js)·예약 알림 패널(app/js/reminder-panel.js)은 데스크탑과 같은 코드를 쓴다.
import { icon } from '../../app/js/icons.js';
import { createNoteEditor } from '../../app/js/editor.js';
import { TEXT_COLORS, HIGHLIGHT_COLORS } from '../../app/js/core/html-marks.js';
import { fileExtension, mediaKind, baseName, vaultUrl } from '../../app/js/media.js';
import { isDataImage, decodeDataImage } from '../../app/js/core/remote-images.js';
import { setupReminderPanel } from '../../app/js/reminder-panel.js';
import { reminderAt } from '../../app/js/date-remind.js';
import { lockScreen } from '../../app/js/lock-ui.js';
import { openLock } from '../../app/js/core/memo-lock.js';
import { collectTags, extractTags, sameTag } from '../../app/js/core/tags.js';
import { suggestTagsFor, appendTags } from '../../app/js/core/tag-suggest.js';
import { clampZoom, zoomLabel } from '../../app/js/core/zoom.js';
import { app } from './state.js';
import { tutEvent, textChanged, screenChanged } from './tutorial.js';
import { call, native } from './native.js';
import { fetchRemoteImage } from './web-fetch.js';
import { openSheet, closeSheet, adoptSheet, releaseSheet, toast, matchChrome, isTwoPane } from './ui.js';
import * as recorder from './recorder.js';
import { setupAnnotation } from '../../app/js/ink-annotate.js';
import { autoTagsFor } from '../../app/js/core/auto-tags.js';
import { conflictCopyBody, isBlankBody, sameBody } from '../../app/js/core/memo-file.js';
import { haptic, reduceMotion, replayClass } from '../../app/js/dom.js';
import { createClearStamp } from '../../app/js/clear-stamp.js';
import { fillSuggestChips, trackPlaceholder } from '../../app/js/suggest-chips.js';
import { setTouchMode, penJustTouched } from '../../app/js/keyboard-guard.js';
import { setupModeKnob, MODES } from './mode-knob.js';

const SAVE_DELAY = 600;
const $ = (x) => document.getElementById(x);
const el = {
  screen: $('note-screen'),
  bar: document.querySelector('#note-screen .bar'),
  status: $('status'),
  editorRoot: $('editor'),
  linksBtn: $('links-btn'),
  linksCount: $('links-count'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerLoad: $('banner-load'),
  linksPanel: $('links-panel'),
  linkSearch: $('link-search'),
  linkResults: $('link-results'),
  linksOut: $('links-out'),
  linksIn: $('links-in'),
  linksSuggest: $('links-suggest'),
  formatBar: $('format-bar'),
  palette: $('palette'),
  tableBar: $('table-bar'),
  styleMenu: $('style-menu'),
  undoBtn: $('undo-btn'),
  redoBtn: $('redo-btn'),
  tagBar: $('tag-suggest-bar'),
  tagChips: $('tag-suggest-chips'),
  linksTags: $('links-tags'),
  linksTagsEmpty: $('links-tags-empty'),
  linksTagSuggest: $('links-tag-suggest'),
};

let editor = null;
let annotation = null; // 주석: 메모 위에 그리기 (app/js/ink-annotate.js)
let reminderPanel = null;
let id = null;
let memo = null;
let current = '';   // 편집기의 최신 마크다운
let saved = '';     // 마지막으로 저장한 마크다운
let saveTimer = null;
let pendingExternal = null;
let conflictCopy = null; // 쓰는 중에 다른 기기에서도 고쳐 들어온 내용을 따로 남긴 사본 메모 (여는 동안 한 사본만 고쳐 쓴다)
let opening = null;

export const currentId = () => id;
export const isOpen = () => id !== null;

// ---------- 저장 ----------

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
  if (isError) toast(text, true);
}

function isDirty() {
  if (editor) current = editor.getMarkdown();
  return current !== saved;
}

function onChange(md) {
  current = md;
  textChanged(md); // 튜토리얼 직접 해 보기 (쓰기·꾸미기·체크리스트·태그)
  if (current === saved) return;
  if (!el.tagBar.hidden || !extractTags(md).length) scheduleTagBar();
  setStatus('');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

// 빈 메모 안내 문구 (한글 조합 중에도 바로 끈다)
const showPlaceholder = trackPlaceholder(el.editorRoot);

/** 쓰던 내용을 바로 저장 (화면을 떠나거나 앱이 뒤로 갈 때) */
export function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  flushTables(); // 표 너비·높이도 (앱을 내릴 때 함께)
  if (!id || !isDirty()) return;
  const body = current;
  try {
    app.vault.save(id, body);
    saved = body;
    setStatus('저장했어요');
  } catch (err) {
    console.error(err);
    setStatus('저장하지 못했어요. 저장 위치를 확인해 주세요', true);
  }
}

// ---------- 다른 기기(PC)에서 바뀐 경우 ----------

function applyExternal(next) {
  editor.setMarkdown(next.body, next.tables ?? []);
  current = saved = editor.getMarkdown();
  el.banner.hidden = true;
  pendingExternal = null;
  setStatus('바뀐 내용을 불러왔어요');
}

/** 이전 버전으로 되돌린 내용을 지금 화면에 */
export function showRestored(next) {
  applyExternal(next);
  setStatus('되돌렸어요');
}

/** 메모 폴더가 바뀌었을 때 (vault 'changed') */
export function onVaultChanged({ ids, external, removed }) {
  if (!id || !editor) return;
  if (removed.includes(id)) {
    showBanner('이 메모가 저장 위치에서 사라졌어요. 계속 쓰면 다시 저장돼요.', { keep: '확인' });
    return;
  }
  if (external.includes(id)) {
    const next = app.vault.get(id);
    if (!next) return;
    if (next.needsPassword) {
      // 다른 기기에서 다른 비밀번호로 다시 잠갔다 — 덮어쓰지 않고 닫는다
      saved = current;
      toast('다른 기기에서 이 메모의 비밀번호를 바꿨어요. 다시 열어 주세요', true);
      closeNote();
      return;
    }
    if (sameBody(next.body, current)) saved = current; // 지금 쓰는 글과 같은 내용 — 할 일 없음
    else if (!isDirty()) applyExternal(next);
    else keepTheirsAsCopy(next);
  }
  if (ids.includes(id)) {
    const next = app.vault.get(id);
    if (next) {
      applyMeta(next);
      reminderPanel?.set(next.reminders);
    }
    refreshLinks();
  }
}
// 쓰는 중에 다른 기기에서도 이 메모를 고쳤을 때: 지금 쓰는 글은 이 메모에 그대로 저장하고, 들어온 내용은 사본 메모로
// 따로 남긴다 (고르기 전에 자동 저장이 들어온 내용을 덮어써 사라지는 일이 없게). 사본을 못 만들면 예전처럼 고르게
function keepTheirsAsCopy(next) {
  let copied = isBlankBody(next.body); // 다른 기기에서 비웠다면 남길 것이 없다
  if (!copied) {
    try {
      const body = conflictCopyBody(next.body);
      if (conflictCopy && app.vault.get(conflictCopy)) app.vault.save(conflictCopy, body);
      else conflictCopy = app.vault.importCopyOf(id, body, { color: next.color });
      if (!conflictCopy) throw new Error('잠긴 메모의 사본을 만들 수 없어요');
      copied = true;
    } catch (err) {
      console.error(err);
    }
  }
  if (!copied) {
    pendingExternal = next;
    showBanner('다른 기기에서 이 메모가 바뀌었어요.', { load: '바뀐 내용 보기', keep: '지금 내용 두기' });
    return;
  }
  flush(); // 들어온 내용으로 바뀐 파일을 지금 쓰는 글로
  showBanner(conflictCopy ? '다른 기기에서도 이 메모를 고쳤어요. 그쪽 내용은 따로 저장해 뒀어요.' : '다른 기기에서도 이 메모를 고쳤어요.', { load: conflictCopy ? '그쪽 내용 보기' : null, keep: '확인' });
}

function showBanner(text, { load = null, keep = '지금 내용 두기' } = {}) {
  el.bannerText.textContent = text;
  el.bannerLoad.hidden = !load;
  if (load) el.bannerLoad.textContent = load;
  $('banner-keep').textContent = keep;
  el.banner.hidden = false;
}

el.bannerLoad.addEventListener('click', () => {
  if (pendingExternal) return applyExternal(pendingExternal);
  if (conflictCopy && app.vault.get(conflictCopy)) {
    el.banner.hidden = true;
    app.openMemo(conflictCopy);
  }
});
$('banner-keep').addEventListener('click', () => {
  el.banner.hidden = true;
  if (!pendingExternal) return; // 사본으로 따로 남긴 뒤라 고를 것이 없다
  pendingExternal = null;
  saved = '';
  flush(); // 내 내용으로 덮어쓴다
});

// ---------- 색 ----------

function applyMeta(next) {
  memo = { ...memo, ...next };
  el.screen.dataset.color = memo.color;
  document.body.dataset.noteColor = memo.color;
  if (!isTwoPane()) matchChrome(el.bar); // 넓은 화면은 목록과 메모가 함께 보이므로 위 막대는 목록 색
}

// ---------- 알림으로 열렸을 때 ----------

function showAlarm(alarm) {
  $('alarm-text').textContent = alarm.label;
  $('alarm-banner').hidden = false;
  replayClass($('alarm-banner'), 'ring');
}
$('alarm-ok').addEventListener('click', () => ($('alarm-banner').hidden = true));

function highlight() {
  replayClass(el.screen, 'highlight');
}
el.screen.addEventListener('animationend', (e) => {
  if (e.animationName === 'note-highlight') el.screen.classList.remove('highlight');
});

// ---------- 연결 패널 ----------

function linkItem(target, { onRemove, onAdd, score } = {}) {
  const li = document.createElement('li');
  li.className = 'link-item';
  const open = document.createElement('button');
  open.className = 'link-open';
  open.dataset.color = target.color;
  const dot = document.createElement('span');
  dot.className = 'link-dot';
  const title = document.createElement('span');
  title.textContent = target.title;
  open.append(dot, title);
  open.addEventListener('click', () => {
    closeSheet(el.linksPanel);
    app.openMemo(target.id);
  });
  li.append(open);
  if (score != null) {
    const s = document.createElement('span');
    s.className = 'link-score';
    s.textContent = `${Math.round(score * 100)}%`;
    li.append(s);
  }
  const addBtn = (name, label, handler) => {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.setAttribute('aria-label', `${target.title} ${label}`);
    b.append(icon(name));
    b.addEventListener('click', handler);
    li.append(b);
  };
  if (onAdd) addBtn('plus', '연결하기', onAdd);
  if (onRemove) addBtn('close', '연결 끊기', onRemove);
  return li;
}

function setLink(targetId, on) {
  flush();
  app.vault.link(id, targetId, on);
  el.linkSearch.value = '';
  el.linkResults.replaceChildren();
  refreshLinks();
}

// 태그로 이어진 메모: 이 메모의 태그마다 같은 태그를 단 메모 (최근 고친 순, 태그마다 6개까지)
function tagGroups() {
  const tags = extractTags(editorMarkdown());
  if (!tags.length) return [];
  const all = app.vault.list().filter((m) => m.id !== id);
  return tags.map((name) => ({ name, memos: all.filter((m) => (m.tags ?? []).some((t) => sameTag(t, name))) }));
}

function relatedCount() {
  const { links, backlinks } = app.vault.links(id);
  const ids = new Set([...links, ...backlinks].map((m) => m.id));
  for (const g of tagGroups()) for (const m of g.memos) ids.add(m.id);
  return ids.size;
}

function tagChip(name, { count, add = false, onClick } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `tag-chip${add ? ' add' : ''}`;
  b.append(add ? `+ #${name}` : `#${name}`);
  if (count != null) {
    const small = document.createElement('small');
    small.textContent = String(count);
    b.append(small);
  }
  b.addEventListener('click', onClick);
  return b;
}

function renderTagGroups() {
  const groups = tagGroups();
  el.linksTagsEmpty.hidden = groups.length > 0;
  el.linksTags.replaceChildren(...groups.map((g) => {
    const box = document.createElement('div');
    box.className = 'link-tag-group';
    const head = document.createElement('div');
    head.className = 'link-tag-head';
    head.append(tagChip(g.name, { count: g.memos.length, onClick: () => app.filterByTag(g.name) }));
    const more = document.createElement('span');
    more.className = 'link-tag-hint';
    more.textContent = g.memos.length ? '목록에서 모아 보기' : '같은 태그의 다른 메모가 없어요';
    head.append(more);
    const ul = document.createElement('ul');
    ul.className = 'link-list';
    ul.append(...g.memos.slice(0, 6).map((m) => linkItem(m)));
    box.append(head, ul);
    return box;
  }));
  // 태그가 없으면 추천 태그를 여기서도 달 수 있게
  const suggestions = groups.length ? [] : currentSuggestions();
  el.linksTagSuggest.replaceChildren(...suggestions.map((t) => tagChip(t.name, { add: true, onClick: () => addTags([t.name]) })));
}

function refreshLinks() {
  if (!id) return;
  const { links, backlinks, suggestions } = app.vault.links(id);
  const total = relatedCount();
  el.linksCount.textContent = total ? String(total) : '';
  el.linksBtn.classList.toggle('has-links', total > 0);
  if (el.linksPanel.hidden) return;
  renderTagGroups();
  const mine = new Set(extractTags(editorMarkdown()).map((t) => t.toLocaleLowerCase('ko')));
  el.linksOut.replaceChildren(...links.map((m) => linkItem(m, { onRemove: () => setLink(m.id, false) })));
  // 이 메모를 연결한 메모·비슷한 메모는 있을 때만 (제목만 숨기면 빈 목록의 "아직 없어요"가 하나 더 보였다)
  $('links-in-title').hidden = el.linksIn.hidden = backlinks.length === 0;
  el.linksIn.replaceChildren(...backlinks.map((m) => linkItem(m)));
  $('links-suggest-title').hidden = el.linksSuggest.hidden = suggestions.length === 0;
  el.linksSuggest.replaceChildren(...suggestions.map((m) => {
    const li = linkItem(m, { onAdd: () => setLink(m.id, true), score: m.score });
    // 닮은 메모의 태그 중 이 메모에 없는 것: 함께 달면 태그로도 이어진다
    const theirs = (app.vault.list().find((x) => x.id === m.id)?.tags ?? []).filter((t) => !mine.has(t.toLocaleLowerCase('ko'))).slice(0, 3);
    if (theirs.length) {
      const row = document.createElement('div');
      row.className = 'link-borrow';
      row.append(...theirs.map((t) => tagChip(t, { add: true, onClick: () => addTags([t]) })));
      li.append(row);
    }
    return li;
  }));
}

// ---------- 추천 태그 (태그가 없는 메모) ----------

const AUTO_TAGS_KEY = 'memoking.autoTags';
export const autoTagsOn = () => {
  try {
    return localStorage.getItem(AUTO_TAGS_KEY) !== 'off';
  } catch {
    return true;
  }
};
export function setAutoTags(on) {
  try {
    localStorage.setItem(AUTO_TAGS_KEY, on ? 'on' : 'off');
  } catch {
    // 이번에만
  }
}

let suggestCache = { body: null, list: [] };
let suggestTimer = 0;
const dismissed = new Set(); // 이번에 닫은 메모 (다시 열 때까지 추천 막대를 숨김)

function suggestionsFor(body, memoId = id) {
  if (!app.vault || extractTags(body).length) return [];
  if (suggestCache.body === body) return suggestCache.list;
  let list = [];
  try {
    list = suggestTagsFor(body, app.vault.bodies(), { excludeId: memoId });
  } catch (err) {
    console.warn('태그 추천 실패', err);
  }
  suggestCache = { body, list };
  return list;
}
const currentSuggestions = () => (id ? suggestionsFor(editorMarkdown()) : []);

function renderTagBar() {
  if (!id || !editor || dismissed.has(id)) {
    el.tagBar.hidden = true;
    return;
  }
  const list = currentSuggestions();
  el.tagBar.hidden = list.length === 0;
  fillSuggestChips(el.tagChips, list, addTags, (name, onClick) => tagChip(name, { add: true, onClick }));
}
function scheduleTagBar() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(renderTagBar, 1500); // 쓰는 동안은 기다렸다가
}
el.tagBar.addEventListener('mousedown', (e) => e.preventDefault()); // 키보드 유지
$('tag-suggest-close').addEventListener('click', () => {
  if (id) dismissed.add(id);
  el.tagBar.hidden = true;
});

/** 본문 끝 줄에 태그를 단다 */
function addTags(names) {
  if (!editor || !names.length) return;
  editor.appendMarkdown(names.map((n) => `#${n}`).join(' '));
  flush();
  toast(`${names.map((n) => `#${n}`).join(' ')} 태그를 달았어요`);
  el.tagBar.hidden = true;
  setTimeout(() => {
    renderTagBar();
    refreshLinks();
  }, 50);
}

/** 닫을 때: 태그 없는 메모에 확실한 추천 태그를 저절로 (설정, 되돌리기 가능) */
function autoTag(memoId, body) {
  if (!autoTagsOn() || dismissed.has(memoId) || extractTags(body).length) return;
  const sure = suggestionsFor(body, memoId).filter((t) => t.sure).slice(0, 2);
  if (!sure.length) return;
  const next = appendTags(body, sure.map((t) => t.name));
  try {
    app.vault.save(memoId, next);
  } catch {
    return;
  }
  toast(`${sure.map((t) => `#${t.name}`).join(' ')} 태그를 달았어요`, false, {
    label: '되돌리기',
    run: () => {
      app.vault.save(memoId, body);
      dismissed.add(memoId);
      toast('태그를 뺐어요');
    },
  });
}

let linkSearchTimer = null;
el.linkSearch.addEventListener('input', () => {
  clearTimeout(linkSearchTimer);
  linkSearchTimer = setTimeout(() => {
    const q = el.linkSearch.value.trim();
    if (!q) return el.linkResults.replaceChildren();
    const linked = new Set(app.vault.links(id).links.map((m) => m.id));
    const results = app.vault.search(q, id).filter((m) => !linked.has(m.id)).slice(0, 8);
    el.linkResults.replaceChildren(...results.map((m) => linkItem(m, { onAdd: () => setLink(m.id, true) })));
  }, 150);
});

el.linksBtn.addEventListener('click', () => {
  flush();
  openSheet(el.linksPanel);
  refreshLinks();
});
$('links-close').addEventListener('click', () => closeSheet(el.linksPanel));

// ---------- 파일 넣기 ----------

// 붙여넣기·끌어 놓기로 들어온 파일 (작은 것) — 화면에서 바로 저장
async function saveFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return app.vault.saveAttachment(bytes, fileExtension(file));
}

// 붙여넣은 인터넷·data: 사진을 메모 폴더에 저장 → "attachments/..."
async function fetchImage(src) {
  if (isDataImage(src)) {
    const image = decodeDataImage(src);
    if (!image) throw new Error('지원하지 않는 그림 형식');
    return app.vault.saveAttachment(image.bytes, image.ext);
  }
  return fetchRemoteImage(app.vault, src);
}

/** 앱이 임시 폴더에 받아 둔 파일들([{ temp, name, mime }])을 첨부로 저장하고 편집기에 넣을 모양으로 */
export function tempsToItems(files) {
  const items = [];
  for (const f of files) {
    const file = { name: f.name || '파일', type: f.mime || '' };
    const ext = fileExtension(file);
    const src = app.vault.commitAttachment(f.temp, ext);
    const kind = mediaKind(file);
    if (kind === 'file') items.push({ kind, src, name: file.name });
    else items.push({ kind, src, alt: kind === 'video' ? `동영상 ${baseName(file.name)}` : baseName(file.name) });
  }
  return items;
}

async function pickAndInsert(accept) {
  let files;
  try {
    files = await call('pickFiles', { accept });
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  if (!files?.length || !editor) return;
  try {
    setStatus(`파일 ${files.length}개 추가 중…`);
    const items = tempsToItems(files);
    // 쓰던 자리가 있으면 그 자리에, 아니면(키보드를 내리고 버튼만 누름) 메모 끝에
    //   (+ 를 펼치면 키보드를 닫으므로, 펼칠 때 쓰던 중이었는지를 본다)
    const typing = addFromCursor || el.editorRoot.contains(document.activeElement);
    editor.insertItems(items, { atCursor: typing });
    flush();
    setStatus(`파일 ${items.length}개를 추가했어요`);
  } catch (err) {
    console.error(err);
    setStatus('파일을 추가하지 못했어요. 다시 시도해 주세요', true);
  }
}

// ---------- 링크·파일 눌러 열기 ----------

async function openAttachment(rel) {
  try {
    const result = await call('openFile', { rel });
    if (result) setStatus(result, true);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function openHref(href) {
  if (/^https?:/i.test(href)) call('openUrl', { url: href }).catch((err) => setStatus(err.message, true));
  else if (href.startsWith('attachments/')) openAttachment(href);
}

el.editorRoot.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || !el.editorRoot.contains(a)) return;
  e.preventDefault();
  if (!window.getSelection()?.isCollapsed) return;
  openHref(a.getAttribute('href'));
});

// 사진은 두 번 눌러 사진 앱으로
function vaultPathOf(src) {
  try {
    const u = new URL(src);
    const base = new URL(window.memoking.vaultBase);
    if (u.origin === base.origin && u.pathname.startsWith(base.pathname)) return decodeURIComponent(u.pathname.slice(base.pathname.length));
    if (/^https?:$/.test(u.protocol)) return u.href;
  } catch {
    // 알 수 없는 주소
  }
  return null;
}
el.editorRoot.addEventListener('dblclick', (e) => {
  const img = e.target.closest?.('img.mk-image');
  if (!img) return;
  const target = vaultPathOf(img.src);
  if (!target) return;
  e.preventDefault();
  openHref(target);
});

// ---------- 글자 색 · 형광펜 ----------

const PALETTES = {
  color: { title: '글자 색', colors: TEXT_COLORS, apply: (c) => editor.setTextColor(c) },
  highlight: { title: '형광펜', colors: HIGHLIGHT_COLORS, apply: (c) => editor.setHighlight(c) },
};
const lastColor = { color: TEXT_COLORS[0].value, highlight: HIGHLIGHT_COLORS[0].value };
// 지금 커서·고른 글자에 칠해진 색 (showActive 가 채움) — 판에서 같은 색을 다시 누르면 지우고, 판에 지금 색을 표시
const appliedColor = { color: null, highlight: null };
const sameColor = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
try {
  Object.assign(lastColor, JSON.parse(localStorage.getItem('memoking.lastColor') ?? '{}'));
} catch {
  // 기본색
}
let paletteKind = null;

function paintSwatchBars() {
  for (const bar of document.querySelectorAll('[data-bar]')) bar.style.background = lastColor[bar.dataset.bar];
}

function openPalette(kind, anchor) {
  const def = PALETTES[kind];
  paletteKind = kind;
  $('palette-title').textContent = def.title;
  $('palette-swatches').replaceChildren(...def.colors.map(({ name, value }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'palette-swatch';
    b.dataset.color = value;
    b.setAttribute('aria-label', `${def.title} ${name}`);
    if (kind === 'color') {
      b.textContent = 'A';
      b.classList.add('text-sample');
      b.style.color = value;
    } else b.style.background = value;
    b.setAttribute('aria-checked', String(sameColor(value, appliedColor[kind] ?? lastColor[kind])));
    if (sameColor(value, appliedColor[kind])) b.title = '다시 누르면 색을 지워요';
    return b;
  }));
  el.palette.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = el.palette.offsetWidth;
  el.palette.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8)}px`;
  el.palette.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
}

export function closePalette() {
  if (el.palette.hidden) return false;
  el.palette.hidden = true;
  paletteKind = null;
  return true;
}

function applyPaletteColor(color) {
  const kind = paletteKind;
  if (!kind) return;
  if (color && sameColor(color, appliedColor[kind])) color = null; // 지금 칠해진 색을 다시 고르면 지운다
  if (color) {
    lastColor[kind] = color;
    try {
      localStorage.setItem('memoking.lastColor', JSON.stringify(lastColor));
    } catch {
      // 무시
    }
    paintSwatchBars();
  }
  PALETTES[kind].apply(color);
  closePalette();
}

el.palette.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 선택 유지
el.palette.addEventListener('click', (e) => {
  const swatch = e.target.closest('[data-color]');
  if (swatch) applyPaletteColor(swatch.dataset.color);
  else if (e.target.closest('#palette-clear')) applyPaletteColor(null);
});

// ---------- 서식 도구막대 ----------

// 되돌리기·다시 하기: 편집기의 단축키를 그대로 누른 것처럼
function pressKey(key, shift = false) {
  const pm = el.editorRoot.querySelector('.ProseMirror');
  pm?.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
}

// ---------- 스타일 고르기 (데스크탑과 같음): 본문 · 제목 1·2·3 · 인용 · 코드 블록 · 수식 ----------
const STYLE_NAMES = { paragraph: '본문', h1: '제목 1', h2: '제목 2', h3: '제목 3', quote: '인용', codeBlock: '코드 블록' };
let currentStyle = 'paragraph';
const styleOf = (active) => {
  if (active.codeBlock) return 'codeBlock';
  for (const h of ['h1', 'h2', 'h3']) if (active[h]) return h;
  return active.quote ? 'quote' : 'paragraph';
};
function openStyleMenu(anchor) {
  closePalette();
  for (const b of el.styleMenu.querySelectorAll('[data-style]')) b.setAttribute('aria-selected', String(b.dataset.style === currentStyle));
  el.styleMenu.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  const rect = anchor.getBoundingClientRect();
  const width = el.styleMenu.offsetWidth;
  el.styleMenu.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8)}px`;
  el.styleMenu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
}
export function closeStyleMenu() {
  if (el.styleMenu.hidden) return false;
  el.styleMenu.hidden = true;
  for (const b of document.querySelectorAll('[data-action="style"]')) b.setAttribute('aria-expanded', 'false');
  return true;
}
el.styleMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서(키보드) 유지
el.styleMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-style]');
  if (!b || !editor) return;
  editor.setStyle(b.dataset.style);
  closeStyleMenu();
});

// ---------- 콘텐츠 추가 (+): 사진 · 파일 · 음성 녹음 · 표 · 수식 위성 단추 ----------
const addMenu = $('add-menu');
const addBtn = $('add-btn');
let addCloseTimer = 0;
let addFromCursor = false; // + 를 펼칠 때 글을 쓰던 중이었나 (사진·파일을 커서 자리에 넣을지)
function openAddMenu() {
  closePalette();
  closeStyleMenu();
  clearTimeout(addCloseTimer);
  addMenu.classList.remove('closing');
  addMenu.hidden = false;
  // 키보드를 닫는다 — 위성 단추가 글자판에 가리지 않게 (커서 자리는 편집기가 기억해 넣을 곳은 그대로)
  addFromCursor = el.editorRoot.contains(document.activeElement);
  if (addFromCursor) document.activeElement.blur();
  placeAddMenu();
  addBtn.classList.add('open');
  addBtn.setAttribute('aria-expanded', 'true');
  haptic(8);
  tutEvent('add-opened');
}
// + 단추 바로 위에 — 키보드가 닫히며 도구막대가 내려가도 따라간다
function placeAddMenu() {
  const r = addBtn.getBoundingClientRect();
  addMenu.style.left = `${Math.max(8, Math.round(r.left))}px`;
  addMenu.style.bottom = `${Math.round(window.innerHeight - r.top + 12)}px`;
}
window.addEventListener('resize', () => {
  if (!addMenu.hidden) placeAddMenu();
});
/** 뒤로 가기: 손 메모 그리기 화면 → 주석 모드 순으로 저장하고 닫는다 (취소는 없다) */
export function closeInk() {
  if (document.querySelector('.ink-sheet:not(.closing)')) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  }
  if (annotation?.active) {
    annotation.exit();
    return true;
  }
  return false;
}
export function closeAddMenu() {
  if (addMenu.hidden || addMenu.classList.contains('closing')) return false;
  addBtn.classList.remove('open');
  addBtn.setAttribute('aria-expanded', 'false');
  addMenu.classList.add('closing');
  addCloseTimer = setTimeout(() => {
    addMenu.hidden = true;
    addMenu.classList.remove('closing');
  }, 160);
  return true;
}
const ADD = {
  photo: () => pickAndInsert('image/*'),
  file: () => pickAndInsert('*/*'),
  record: () => recorder.toggle(),
  table: () => editor.insertTable(),
  math: () => editor.setStyle('math'),
  ink: () => editor.insertInk().then(() => tutEvent('ink-done')),
};
addMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서(키보드) 유지
addMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (!b || !editor) return;
  closeAddMenu();
  ADD[b.dataset.add]?.();
});

const actions = {
  keyboard: () => toggleKeyboard(),
  add: () => (addMenu.hidden || addMenu.classList.contains('closing') ? openAddMenu() : closeAddMenu()),
  table: () => editor.insertTable(),
  style: (btn) => (el.styleMenu.hidden ? openStyleMenu(btn) : closeStyleMenu()),
  // 글자 색·형광펜: 누르면 고른(지난번) 색을 바로, 꾹 누르면 색 고르기 판 (아래 longPressColor)
  color: (btn) => applyPreset('color', btn),
  highlight: (btn) => applyPreset('highlight', btn),
};
function applyPreset(kind, btn) {
  if (btn.dataset.longPressed) {
    delete btn.dataset.longPressed; // 꾹 눌러 판을 연 손가락을 뗀 것 — 색은 판에서
    return;
  }
  if (paletteKind) return closePalette();
  // 누르기 = 켜고 끄기: 이미 칠해져 있으면 지우고, 아니면 지난번 색으로 (PC 단축키 Ctrl+Shift+C·H 와 같음)
  if (kind === 'color') editor.toggleTextColor(lastColor.color);
  else editor.toggleHighlight(lastColor.highlight);
  haptic(6);
}
// 꾹(0.45초) 누르면 색 고르기 판 — 판에서 고른 색은 다음부터 누르기만 해도 쓰는 색이 된다
for (const btn of el.formatBar.querySelectorAll('[data-action="color"], [data-action="highlight"]')) {
  let timer = 0;
  btn.addEventListener('pointerdown', () => {
    delete btn.dataset.longPressed;
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.dataset.longPressed = '1';
      haptic(12);
      closeStyleMenu();
      closeAddMenu();
      openPalette(btn.dataset.action, btn);
    }, 450);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(t, () => clearTimeout(timer));
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // 꾹 누를 때 휴대폰 메뉴 대신
}

el.formatBar.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서(키보드)를 유지
// + 는 도구막대 밖(왼쪽 아래) — 펼치면 키보드를 닫는다 (openAddMenu)
//   누르는 순간 초점이 단추로 옮겨 가지 않게 (쓰던 중이었는지 알아야 사진·파일을 커서 자리에 넣는다)
addBtn.addEventListener('mousedown', (e) => e.preventDefault());
addBtn.addEventListener('click', () => {
  if (!editor) return;
  closePalette();
  closeStyleMenu();
  actions.add();
});
el.formatBar.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !editor) return;
  if (btn.dataset.cmd) {
    closePalette();
    closeStyleMenu();
    closeAddMenu();
    editor.run(btn.dataset.cmd);
  } else if (btn.dataset.action) {
    if (!['color', 'highlight'].includes(btn.dataset.action)) closePalette();
    if (btn.dataset.action !== 'style') closeStyleMenu();
    if (btn.dataset.action !== 'add') closeAddMenu();
    actions[btn.dataset.action]?.(btn);
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!el.palette.hidden && !el.palette.contains(e.target) && !e.target.closest?.('[data-action="color"],[data-action="highlight"]')) closePalette();
  if (!el.styleMenu.hidden && !el.styleMenu.contains(e.target) && !e.target.closest?.('[data-action="style"]')) closeStyleMenu();
  if (!addMenu.hidden && !addMenu.contains(e.target) && !e.target.closest?.('[data-action="add"]')) closeAddMenu();
});

// 되돌리기·다시 하기: 자주 쓰므로 위 막대에 늘 (누를 것이 없으면 흐리게)
for (const [btn, shift] of [[el.undoBtn, false], [el.redoBtn, true]]) {
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // 키보드를 내리지 않는다
  btn.addEventListener('click', () => {
    if (!editor) return;
    const typing = el.editorRoot.contains(document.activeElement);
    pressKey('z', shift);
    if (!typing) document.activeElement?.blur();
  });
}

// 표 막대: 표 안에 커서가 있을 때만
function showTableBar(table) {
  el.tableBar.hidden = !table;
  for (const b of document.querySelectorAll('[data-action="table"]')) b.classList.toggle('active', Boolean(table));
  if (!table) return;
  el.tableBar.querySelector('[data-table="delRow"]').disabled = table.header;
  el.tableBar.querySelector('[data-table="delCol"]').disabled = table.cols <= 1;
  // 셀 병합: 여러 칸을 골랐으면 "셀 병합", 병합한 칸 안이면 "병합 풀기"
  const merge = el.tableBar.querySelector('[data-table="merge"]');
  merge.textContent = table.merged ? '병합 풀기' : '셀 병합';
  merge.disabled = !table.canMerge && !table.merged;
}
el.tableBar.addEventListener('mousedown', (e) => e.preventDefault());
el.tableBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-table]');
  if (b && !b.disabled) editor.tableCommand(b.dataset.table);
});

function showActive(active) {
  appliedColor.color = active.color ?? null;
  appliedColor.highlight = active.highlight ?? null;
  showTableBar(active.table);
  currentStyle = styleOf(active);
  for (const b of document.querySelectorAll('[data-action="style"]')) {
    b.querySelector('.style-name').textContent = STYLE_NAMES[currentStyle];
    b.classList.toggle('active', currentStyle !== 'paragraph');
  }
  el.undoBtn.disabled = !active.canUndo;
  el.redoBtn.disabled = !active.canRedo;
  for (const btn of el.formatBar.querySelectorAll('[data-cmd]')) btn.classList.toggle('active', Boolean(active[btn.dataset.cmd]));
  el.formatBar.querySelector('[data-cmd="moveUp"]').disabled = !active.canMoveUp;
  el.formatBar.querySelector('[data-cmd="moveDown"]').disabled = !active.canMoveDown;
  for (const kind of ['color', 'highlight']) {
    for (const btn of el.formatBar.querySelectorAll(`[data-action="${kind}"]`)) btn.classList.toggle('active', Boolean(active[kind]));
  }
}

// 키보드가 올라와 있을 때만 "키보드 닫기" 버튼
export function setKeyboard(open) {
  el.screen.classList.toggle('keyboard', open);
  $('kb-btn')?.setAttribute('aria-pressed', String(open));
  $('kb-btn')?.setAttribute('aria-label', open ? '키보드 넣기' : '키보드 꺼내기');
  // 키보드가 올라와 화면이 줄면 쓰던 줄이 가려지지 않게 다시 맞춘다 (S펜으로 쓰는 중에는 글을 움직이지 않는다 — 손글씨 막대가 떠도)
  if (open && !penWriting_) requestAnimationFrame(() => editor?.revealCaret());
  // 키보드 단추로 꺼냈던 키보드를 넣으면 손글씨를 다시
  if (!open && kbTyping) {
    kbTyping = false;
    applyHandwriting(el.screen.dataset.touchMode);
  }
}

// 키보드 단추 (펜을 쓰는 기기, 글 고치기): S펜으로 쓰는 중에도 키보드로 치고 싶을 때. 한 번 더 누르면 넣는다
export function toggleKeyboard() {
  if (!editor) return;
  if (el.screen.classList.contains('keyboard')) {
    native.showKeyboard?.(false);
    return;
  }
  kbTyping = true;
  penDone();
  applyHandwriting(el.screen.dataset.touchMode); // 키보드로 치는 동안 펜으로 누르면 커서만 옮긴다
  const pm = el.editorRoot.querySelector('.ProseMirror');
  pm?.removeAttribute('inputmode');
  if (pm) delete pm.dataset.mkNoKeyboard;
  editor.focus();
  try {
    native.showKeyboard(true);
  } catch {
    // 미리보기
  }
}

// ---------- 다루기 방식 다이얼 (오른쪽 아래): 글 고치기 · 옮기기 · 글 위에 그리기 ----------
//   고치기: 꾹 누르면 글자 고르기(복사·고치기), 옮기기 손짓 없음, 키보드 씀
//   옮기기: 키보드 없이 줄·그림을 짧게 눌러 끌기 · 그리기: 키보드 없이 글 위에 그리기 (완료하면 앞의 방식으로)
//   고치기·옮기기는 기억해 두고 메모를 열 때 이어 쓴다 (새 글 메모는 쓰려고 연 것이니 고치기로)
const MODE_KEY = 'memoking.touchMode';
let knob = null;
let placeKnob = () => {};
const DOCK_H = 52; // 아래 막대 높이 (mobile.css 의 #format-bar · .move-bar · 그리기 도구 막대)
let restMode = 'edit'; // 그리기를 끝내면 돌아갈 방식
function storedMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'move' ? 'move' : 'edit';
  } catch {
    return 'edit';
  }
}
// ---------- S펜 손글씨 → 글자 (안드로이드 14+ · 삼성 S펜으로 텍스트 쓰기) ----------
//   글 고치기 방식에서만, 설정에서 끌 수도 있다. 옮기기 · 그리기에서는 펜이 닿아도 커서 막대·손글씨가 생기지 않게
//   (웹 화면: touch-action 에서 handwriting 을 빼면 그 칸은 손글씨를 시작하지 않는다 · 앱: WebView 손글씨 켜고 끄기)
const PEN_WRITE_KEY = 'memoking.penHandwriting'; // 'edit'(기본) | 'off'
const PEN_HINT_KEY = 'memoking.penWriteHint';
export function penWriting() {
  try {
    return localStorage.getItem(PEN_WRITE_KEY) === 'off' ? 'off' : 'edit';
  } catch {
    return 'edit';
  }
}
export function setPenWriting(value) {
  try {
    localStorage.setItem(PEN_WRITE_KEY, value === 'off' ? 'off' : 'edit');
  } catch {
    // 이번에만
  }
  applyHandwriting(el.screen.dataset.touchMode);
}
let handwritingOn = null;
let kbTyping = false; // 키보드 단추로 키보드를 꺼낸 동안은 손글씨를 잠깐 쉰다 (펜으로 눌러도 커서만 옮기게)
function applyHandwriting(mode) {
  const on = mode === 'edit' && penWriting() !== 'off' && !kbTyping;
  el.screen.dataset.handwriting = on ? 'on' : 'off';
  if (on === handwritingOn) return;
  handwritingOn = on;
  try {
    native.setHandwriting(on);
  } catch {
    // 미리보기 · 예전 앱
  }
}
// 옮기기 · 그리기에서 펜이 글에 닿아 편집기에 초점이 가면 바로 놓는다 (편집기는 그때 고칠 수 없게 두지만 한 번 더)
el.editorRoot.addEventListener('focusin', (e) => {
  const mode = el.screen.dataset.touchMode;
  if (mode === 'edit' || !penJustTouched()) return;
  if (e.target instanceof HTMLElement && e.target.closest('.ProseMirror')) e.target.closest('.ProseMirror').blur();
});

// 펜을 쓰는 기기: 한 번이라도 펜이 닿거나 화면 위에 뜨면 키보드 단추를 보인다 (손가락만 쓰면 글자를 눌러 키보드가 뜨니 필요 없다)
const PEN_SEEN_KEY = 'memoking.penSeen';
const markPen = () => {
  if (el.screen.classList.contains('pen-seen')) return;
  el.screen.classList.add('pen-seen');
  try {
    localStorage.setItem(PEN_SEEN_KEY, '1');
  } catch {
    // 이번에만
  }
};
try {
  if (localStorage.getItem(PEN_SEEN_KEY)) el.screen.classList.add('pen-seen');
} catch {
  // 처음
}
el.screen.addEventListener('pointerover', (e) => e.pointerType === 'pen' && markPen(), { passive: true });

// S펜으로 쓰는 동안(글 고치기): 글이 움직이지 않게 — 커서 따라 스크롤 · 키보드 자리 맞추기를 쉰다.
//   손글씨는 화면에 그은 자리로 들어가는데, 쓰는 사이 글이 밀리면 다음 획이 엉뚱한 곳에 닿거나 씹힌다.
//   펜을 뗀 뒤 2.5초 동안 아무것도 쓰지 않으면(손글씨가 넣는 글도 포함) 원래대로
let penWriting_ = false;
let penIdle = 0;
function penActive() {
  if (!penWriting_) {
    penWriting_ = true;
    editor?.setScrollMargin(0);
    el.screen.classList.add('pen-writing');
  }
  clearTimeout(penIdle);
  penIdle = setTimeout(penDone, 2500);
}
function penDone() {
  clearTimeout(penIdle);
  if (!penWriting_) return;
  penWriting_ = false;
  editor?.setScrollMargin(96);
  el.screen.classList.remove('pen-writing');
}
el.editorRoot.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') {
    markPen();
    if (el.screen.dataset.handwriting === 'on') penActive();
  } else if (penWriting_) penDone(); // 손가락으로 돌아오면 바로 원래대로
}, true);
for (const type of ['beforeinput', 'compositionupdate']) {
  el.editorRoot.addEventListener(type, () => penWriting_ && penActive(), true); // 손글씨가 글을 넣는 동안은 쓰는 중
}

// 글 고치기에서 펜을 처음 대면 한 번만: 무엇이 되는지와 끄는 곳
el.editorRoot.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'pen' || el.screen.dataset.handwriting !== 'on') return;
  try {
    if (localStorage.getItem(PEN_HINT_KEY)) return;
    localStorage.setItem(PEN_HINT_KEY, '1');
  } catch {
    return;
  }
  showGuide('글자 칸에 쓰면 글자로 바뀌어요. 톡 누르면 커서, 꾹 누르면 고르기예요. 키보드는 아래 키보드 단추로 꺼내요', 'S펜 손글씨', 4200);
}, true);

function applyMode(mode, { user = false, quiet = false } = {}) {
  el.screen.dataset.touchMode = mode;
  // 글 고치기에서만 고칠 수 있다 — 옮기기·그리기에서 펜을 대도 커서 막대·손글씨 아이콘이 생기지 않게 (고칠 칸이 없으므로)
  editor?.setEditable(mode === 'edit');
  if (mode !== 'edit') {
    kbTyping = false;
    penDone();
  }
  applyHandwriting(mode);
  recorder.holdStop(); // 아래 막대가 바뀌며 녹음 판이 움직인다 — 그 사이 눌림으로 녹음이 끝나지 않게
  $('mode-guide').hidden = true; // 앞 방식의 안내는 거둔다
  // 다이얼로 바꾸면 그 방식이 무엇인지 아래 가운데 흰 안내로 — 방식마다 처음 한 번만 (돌릴 때마다 뜨면 메모를 가린다)
  const m = MODES.find((x) => x.id === mode);
  if (user && !quiet && m) showGuideOnce(`mode-${m.id}`, m.hint, m.label);
  setTouchMode(mode, el.editorRoot.querySelector('.ProseMirror'));
  closeAddMenu();
  if (mode !== 'draw') {
    restMode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // 이번에만
    }
  }
  if (mode === 'draw') annotation?.enter();
  else if (annotation?.active) annotation.exit();
  // 고치기로 돌렸으면 바로 쓸 수 있게 (커서는 있던 자리)
  if (user && mode === 'edit' && editor) editor.focus();
  if (user && mode === 'move') tutEvent('mode-moved');
}
// 아래쪽 안내 (그리기 도구 막대와 같은 흰 모양) — 잠깐 떴다 사라진다
let guideTimer = 0;
// 힌트처럼 한 번만: 같은 안내는 이 휴대폰에서 다시 띄우지 않는다 (다이얼을 돌릴 때마다 메모를 가리지 않게)
const GUIDES_SEEN_KEY = 'memoking.guidesSeen';
function showGuideOnce(name, text, title) {
  let seen = [];
  try {
    seen = JSON.parse(localStorage.getItem(GUIDES_SEEN_KEY) ?? '[]');
  } catch {
    seen = [];
  }
  if (seen.includes(name)) return;
  try {
    localStorage.setItem(GUIDES_SEEN_KEY, JSON.stringify([...seen, name]));
  } catch {
    // 저장 못 해도 이번에는 보여 준다
  }
  showGuide(text, title);
}
function showGuide(text, title = '', ms = 2600) {
  const g = $('mode-guide');
  // 제목은 굵게 한 줄, 설명은 그 아래 (가운데 점으로 잇지 않는다)
  g.replaceChildren(...(title ? [Object.assign(document.createElement('b'), { textContent: title }), document.createElement('br')] : []), text);
  g.hidden = false;
  replayClass(g, 'show');
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => (g.hidden = true), ms);
}
// 옮기기 방식에서 글을 톡 누르면(커서를 놓으려는 것) 글 고치기로 넘어가 누른 그 자리에 커서를 둔다 (빈 자리면 가까운 줄)
//   손가락만 — S펜은 옮기기에서 끌기에 쓰므로 톡 눌러도 넘어가지 않는다.
//   끌기·스크롤(움직임)·꾹 누르기는 아니고, 체크 네모·그림·링크·단추를 누른 것도 아닐 때만
let tapDown = null;
el.editorRoot.addEventListener('pointerdown', (e) => {
  tapDown = knob?.mode === 'move' && e.isPrimary && e.pointerType !== 'pen' ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
}, true);
el.editorRoot.addEventListener('pointerup', (e) => {
  const d = tapDown;
  tapDown = null;
  if (!d || !editor || knob?.mode !== 'move' || e.timeStamp - d.t > 300 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
  const t = e.target instanceof Element ? e.target : null;
  if (!t || t.closest('a, img, button, input, .mk-media, .mk-link-card, .mk-file, .mk-math, .mk-math-block, .mk-annot')) return; // 태그 알약도 글자다
  const li = t.closest('.ProseMirror li');
  const firstBlock = li?.querySelector(':scope > p, :scope > div');
  if (li && firstBlock && e.clientX < firstBlock.getBoundingClientRect().left) return; // 체크 네모
  if (document.querySelector('.mk-list-dragging, .mk-block-dragging, body.mk-list-dragging, body.mk-block-dragging')) return;
  const { clientX: x, clientY: y } = e;
  setTimeout(() => {
    if (knob?.mode !== 'move') return;
    knob.set('edit', { quiet: true }); // → applyMode: 고칠 수 있게 · 키보드를 풀고
    const pm = el.editorRoot.querySelector('.ProseMirror');
    pm?.removeAttribute('inputmode');
    if (pm) delete pm.dataset.mkNoKeyboard;
    editor.focusAt(x, y);
    showGuideOnce('tap-to-edit', '옮기려면 다이얼을 옮기기로 돌려요', '글 고치기로 바꿨어요');
  }, 30);
});

// 글 고치기에서 글 아래 빈 자리(편집기 밖)를 누르면 글 끝에 커서를 두고 키보드를 올린다
el.editorRoot.addEventListener('click', (e) => {
  const pm = el.editorRoot.querySelector('.ProseMirror');
  if (!editor || !pm || !(e.target instanceof Element) || pm.contains(e.target) || knob?.mode !== 'edit') return;
  if (e.target.closest('button, a, input, .mk-annot')) return;
  if (e.clientY < pm.getBoundingClientRect().bottom) return; // 글 옆 여백은 편집기가 알아서
  if (document.querySelector('.mk-list-dragging, .mk-block-dragging, body.mk-list-dragging, body.mk-block-dragging')) return;
  // 앞서 그림 등을 눌러 키보드를 막아 두었더라도 글을 쓰려는 것이니 푼다
  pm.removeAttribute('inputmode');
  delete pm.dataset.mkNoKeyboard;
  editor.focusEnd();
});

/** 글을 써야 하는 때(튜토리얼의 쓰기 단계 등): 다이얼을 글 고치기로 — 안내로 바뀐 것을 알린다 */
export function useEditMode() {
  if (knob && knob.mode !== 'edit') knob.set('edit');
}
function setupKnob() {
  knob ??= setupModeKnob(el.screen, { value: storedMode(), onChange: (m, { quiet }) => applyMode(m, { user: true, quiet }) });
  // 다이얼은 아래쪽 막대들(도구막대 · 녹음 판 · 추천 태그 줄) 바로 위 — 녹음 정지 단추 등을 가리지 않고,
  //   키보드가 올라와 막대가 움직여도 따라간다
  //   도구막대 · 옮기기 막대 · 그리기 도구 막대는 같은 높이(52px)·같은 자리라 그만큼은 고정 — 방식을 바꿔도
  //   (막대가 올라오는 움직임 도중에 재더라도) 다이얼 · 안내가 제자리. 녹음 판 · 추천 태그 줄이 더 얹히면 그만큼 위로
  const extras = [el.formatBar, $('rec-panel'), el.tagBar].filter(Boolean); // 도구막대도 — 두 줄로 접힐 때(좁은 화면) 위로
  placeKnob = () => {
    const bottom = el.screen.getBoundingClientRect().bottom;
    const base = DOCK_H + (parseFloat(getComputedStyle($('move-bar')).marginBottom) || 8);
    const tops = extras.filter((e) => e.offsetHeight).map((e) => e.getBoundingClientRect().top);
    const over = tops.length ? Math.round(bottom - Math.min(...tops)) : 0;
    el.screen.style.setProperty('--fb-h', `${Math.max(base, over)}px`);
  };
  const ro = new ResizeObserver(() => placeKnob());
  for (const e of [el.screen, ...extras]) ro.observe(e);
  // 녹음 판 · 추천 태그 줄은 아래에서 미끄러져 올라온다 — 크기가 바뀐 순간(움직이기 전)에 재면 아직 아래에 있어
  //   다이얼이 "끝내기" 단추를 가리므로, 다 올라온 뒤 한 번 더 잰다
  for (const e of extras) e.addEventListener('animationend', () => placeKnob());
}

// ---------- 위쪽 버튼 ----------

$('back-btn').addEventListener('click', () => app.noteBack());
$('menu-btn').addEventListener('click', () => {
  flush();
  app.memoMenu(id);
});

// ---------- 열기 · 닫기 ----------

function setupPanels() {
  if (reminderPanel) return;
  // 패널은 한 번만 만들고, 저장할 때는 지금 열린 메모의 알림으로
  reminderPanel = setupReminderPanel({
    api: app.api,
    memoId: null,
    setStatus,
    onToggle: (open) => {
      const panel = $('reminder-panel');
      if (open) adoptSheet(panel, () => reminderPanel.toggle(false));
      else releaseSheet(panel);
    },
    onChange: () => editor?.refreshDates(),
  });
}

/**
 * @param {string} memoId
 * @param {{ fresh?: boolean, alarm?: object, highlight?: boolean, capture?: (editor) => Promise<void> }} options
 */
export async function openNote(memoId, options = {}) {
  setupPanels();
  if (opening) await opening;
  if (id === memoId && editor) {
    if (options.alarm) showAlarm(options.alarm);
    if (options.highlight) highlight();
    return;
  }
  if (id) closeNote({ quiet: true });
  const next = app.vault.get(memoId);
  if (!next) {
    toast('메모를 찾을 수 없어요. 이동했거나 삭제됐을 수 있어요', true);
    return;
  }
  opening = (async () => {
    id = memoId;
    memo = next;
    pendingExternal = null;
    conflictCopy = null;
    applyMeta(memo);
    el.banner.hidden = true;
    $('alarm-banner').hidden = true;
    setStatus('');
    el.screen.hidden = false;
    el.screen.classList.remove('leaving');
    if (!reduceMotion()) {
      el.screen.classList.add('entering');
      setTimeout(() => el.screen.classList.remove('entering'), 260);
    }
    current = saved = memo.body;
    el.editorRoot.replaceChildren();
    el.editorRoot.scrollTop = 0;
    $('format-items').scrollLeft = 0; // 도구막대는 늘 처음(+ · 굵게)부터 — 지난 메모에서 옆으로 밀어 둔 채로 열리지 않게
    if (memo.needsPassword) {
      // 잠긴 메모: 비밀번호를 넣어야 편집기를 만든다 (열쇠는 메모를 닫을 때까지만)
      el.screen.classList.add('memo-locked');
      const opened = await lockScreen(el.editorRoot, {
        title: memo.title,
        onTry: async (password) => {
          try {
            const { session } = await openLock(memo.body, password);
            const r = app.vault.openLock(memoId, session);
            if (!r) return '메모를 열지 못했어요';
            memo = r;
            return null;
          } catch (err) {
            return err.message;
          }
        },
        onCancel: () => {},
      });
      el.screen.classList.remove('memo-locked');
      if (!opened) {
        id = null;
        memo = null;
        el.screen.hidden = true;
        return;
      }
      current = saved = memo.body;
    }
    editor = await createNoteEditor(el.editorRoot, {
      markdown: memo.body,
      onChange,
      onState: showActive,
      saveFile,
      fetchImage,
      onNotice: setStatus,
      fetchPreview: (url) => app.previews.get(url),
      openLink: (url) => call('openUrl', { url }),
      getTags: async () => collectTags(app.vault.list()),
      onEmpty: showPlaceholder,
      onTasks: showTasks,
      tables: memo.tables ?? [],
      onTables: saveTables,
      readAttachment: async (src) => (await fetch(vaultUrl(src))).text(),
      onDateReminder: (event) => reminderPanel?.addEvent(event) ?? false,
      hasReminderAt: (d) => reminderAt(reminderPanel?.list, d),
      tapContinuesList: true, // 목록 아래 줄을 눌러 줄을 바꾸는 사람도 목록이 이어지게
      scrollMargin: 96, // 쓰는 줄이 아래쪽 + · 다이얼에 가리지 않게
    });
    // 편집기가 불러온 뒤 정리한 마크다운을 기준으로 (열기만 해도 저장되는 일 방지)
    current = saved = editor.getMarkdown();
    if (!knob) setupKnob();
    if (options.fresh && !options.record && !options.ink) knob.set('edit', { quiet: true }); // 새 글 메모는 쓰려고 연 것
    applyMode(knob.mode === 'draw' ? restMode : knob.mode); // 새로 만든 편집기에도 키보드 설정을
    reminderPanel.set(memo.reminders);
    refreshLinks();
    el.undoBtn.disabled = true;
    el.redoBtn.disabled = true;
    renderTagBar();
    recorder.attach(memoId);
    if (options.alarm) showAlarm(options.alarm);
    if (options.highlight) highlight();
    if (options.capture) await options.capture(editor);
    annotation ??= setupAnnotation({
      scroller: el.editorRoot,
      docEl: () => el.editorRoot.querySelector('.ProseMirror'),
      read: async () => (memo?.ink ? (await fetch(vaultUrl(memo.ink))).json() : null),
      save: async (data) => {
        const memoId = id; // 닫으면서 저장할 때도 그 메모에
        const rel = data ? await saveFile(new File([JSON.stringify(data)], '글 위에 그리기.json', { type: 'application/json' })) : '';
        if (memoId && app.vault.get(memoId)) app.vault.setMeta(memoId, { ink: rel });
        if (memoId === id && memo) memo = { ...memo, ink: rel };
      },
      onMode: (on) => {
        closeAddMenu();
        // 다이얼도 맞춘다: 그리기를 끝내면(완료·뒤로) 앞의 방식으로
        if (!on && knob?.mode === 'draw') knob.set(restMode, { quiet: true });
        if (on && knob && knob.mode !== 'draw') knob.set('draw', { quiet: true });
        el.screen.classList.toggle('annotating', on);
        placeKnob(); // 그리기 도구 막대가 생기고 없어질 때
        if (on) document.activeElement?.blur(); // 키보드를 내리고 그리기
        else tutEvent('annotate-done');
      },
      notice: (text, err) => toast(text, err),
      done: false, // 끝내기는 다이얼(또는 뒤로 가기) — 완료 단추와 겹치지 않게
    });
    annotation.load(Boolean(memo.ink));
    if (options.record) recorder.start(memoId);
    else if (options.ink) editor.insertInk();
    else if (options.fresh && !options.capture) editor.focus();
  })();
  try {
    await opening;
  } finally {
    opening = null;
  }
  screenChanged(); // 튜토리얼: 메모 단계 말풍선
}

/** 목록으로: 저장하고, 빈 메모는 치우고, 제목이 바뀌었으면 파일 이름을 맞춘다 */
export function closeNote({ quiet = false } = {}) {
  if (!id) return;
  el.editorRoot.querySelector('.lock-screen [data-lock-cancel]')?.click(); // 비밀번호 화면에서 뒤로 가기 = 닫기
  flush();
  flushTables();
  clearStamp.hide();
  const closing = id;
  const body = current;
  closePalette();
  closeStyleMenu();
  clearTimeout(suggestTimer);
  el.tagBar.hidden = true;
  recorder.detach();
  annotation?.exit(); // 주석을 그리던 중이면 저장
  for (const panel of [el.linksPanel, $('reminder-panel')]) if (!panel.hidden) closeSheet(panel);
  editor?.destroy();
  editor = null;
  id = null;
  screenChanged(); // 튜토리얼: 메모 단계는 끝 → 목록 단계로
  memo = null;
  pendingExternal = null;
  delete document.body.dataset.noteColor;
  try {
    app.vault.finalize(closing);
  } catch (err) {
    console.error(err);
  }
  if (app.vault.get(closing) && !app.vault.get(closing).locked) autoTag(closing, body);
  app.vault.closeLock(closing); // 잠금 메모는 닫으면 다시 비밀번호로
  document.activeElement?.blur();
  if (quiet || reduceMotion()) {
    el.screen.hidden = true;
    return;
  }
  el.screen.classList.add('leaving');
  setTimeout(() => {
    if (!id) el.screen.hidden = true;
    el.screen.classList.remove('leaving');
  }, 170);
}

/** 이 메모를 지우기 (메뉴) — 지운 메모는 저장하지 않는다 */
export function discardAndClose() {
  saved = current;
  el.tagBar.hidden = true;
  closeStyleMenu();
  recorder.detach();
  pendingTables = null;
  clearStamp.hide();
  clearTimeout(saveTimer);
  editor?.destroy();
  editor = null;
  id = null;
  memo = null;
  el.screen.hidden = true;
  delete document.body.dataset.noteColor;
}

// ---------- 표 열 너비·행 높이·머리글 강조·병합 → 메모 머리말 (데스크탑과 같음) ----------
let tablesTimer = 0;
let pendingTables = null;
function saveTables(tables) {
  pendingTables = { id, tables };
  clearTimeout(tablesTimer);
  tablesTimer = setTimeout(flushTables, 400);
}
function flushTables() {
  clearTimeout(tablesTimer);
  if (!pendingTables) return;
  const p = pendingTables;
  pendingTables = null;
  try {
    app.vault.setMeta(p.id, { tables: p.tables });
  } catch {
    setStatus('표 크기를 저장하지 못했어요', true);
  }
}

// ---------- CLEAR 도장: 체크리스트를 모두 끝내면 (PC 와 같음) ----------
const clearStamp = createClearStamp(el.screen, el.editorRoot);
function showTasks(tasks, opts) {
  clearStamp.show(tasks, opts);
}

// ---------- 두 손가락으로 본문 확대·축소: 매직 줌 ----------
//   100% 보다 크게: 페이지째 (지도·PDF 처럼) — 글자·그림·표가 같은 비율로 커지고, 줄은 100% 일 때 그대로 둔 채
//                   화면보다 넓어지면 옆으로 밀어서 본다 (자세히 들여다보기)
//   100% 보다 작게: 글자 크기 줄이기 — 줄이 화면 폭에 다시 맞춰져 한 화면에 더 많이 (한눈에 훑어보기, 옆으로 밀 일 없음)
//   두 손가락 가운데를 중심으로, 배율은 모든 메모에 기억 (데스크탑 Ctrl+휠과 같은 단계)
const ZOOM_KEY = 'memoking.noteZoom';
let zoom = 1;
try {
  zoom = clampZoom(localStorage.getItem(ZOOM_KEY) ?? 1);
} catch {
  // 기억 못 해도 100%
}
// 100% 일 때의 본문 폭 (확대해도 이 폭으로 배치한 채 크게 그린다)
function baseWidth() {
  const cs = getComputedStyle(el.editorRoot);
  return Math.max(200, el.editorRoot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
}
function applyZoom(focus) {
  const root = el.editorRoot;
  const before = Number(root.style.getPropertyValue('--note-zoom')) || 1;
  const base = baseWidth();
  root.style.setProperty('--note-base-w', `${base}px`);
  root.style.setProperty('--note-zoom', String(zoom));
  // 폭은 확대되는 요소(편집기 바로 아래 틀) 자신에게 — 저절로 맞는 폭은 확대해도 화면 폭에 맞춰져 버리므로
  //   작게(100% 아래)는 폭을 비워 두어 줄이 화면 폭에 다시 맞춰지게
  for (const child of root.children) if (!child.classList.contains('mk-annot')) child.style.width = zoom > 1 ? `${base}px` : ''; // 주석 층은 스스로 맞춘다
  root.classList.toggle('zoomed', zoom > 1);
  root.classList.toggle('zoomed-out', zoom < 1);
  // 두 손가락 가운데(focus)의 내용이 그 자리에 머물게 스크롤을 맞춘다
  if (focus && before !== zoom) {
    const r = root.getBoundingClientRect();
    const fx = focus.x - r.left;
    const fy = focus.y - r.top;
    const k = zoom / before;
    if (zoom > 1) root.scrollLeft = (root.scrollLeft + fx) * k - fx;
    else root.scrollLeft = 0;
    root.scrollTop = (root.scrollTop + fy) * k - fy;
  }
}
applyZoom();
new ResizeObserver(() => {
  applyZoom();
  el.screen.style.setProperty('--editor-h', `${el.editorRoot.clientHeight}px`); // 글 고치기의 본문 높이 (빈 자리도 글자 칸)
}).observe(el.editorRoot);
new MutationObserver(() => applyZoom()).observe(el.editorRoot, { childList: true }); // 새 메모를 열면 그 본문에도
let pinch = null;
const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const middle = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
el.editorRoot.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) pinch = { d: Math.max(1, spread(e.touches)), z: zoom };
}, { passive: true });
el.editorRoot.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const next = Math.round(clampZoom(pinch.z * (spread(e.touches) / pinch.d)) * 20) / 20;
  if (next === zoom) return;
  zoom = next;
  applyZoom(middle(e.touches));
  setStatus(zoom >= 1 ? `매직 줌: 확대 ${zoomLabel(zoom)}` : `매직 줌: 글자 ${zoomLabel(zoom)}`);
}, { passive: false });
el.editorRoot.addEventListener('touchend', (e) => {
  if (!pinch || e.touches.length >= 2) return;
  pinch = null;
  // 100% 가까이면 딱 100% 로 (가로로 조금 밀리는 일 없게)
  if (Math.abs(zoom - 1) < 0.08) {
    zoom = 1;
    applyZoom();
  }
  try {
    if (zoom === 1) localStorage.removeItem(ZOOM_KEY);
    else localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    // 이번에만
  }
});

export function editorMarkdown() {
  if (editor) current = editor.getMarkdown();
  return current;
}

paintSwatchBars();

export const getEditor = () => editor;

/** 붙여넣은 사진 받기 등 편집기 일이 끝날 때까지 (그림·PDF 로 보내기 전에) */
export async function settled() {
  if (opening) await opening;
  await editor?.imagesSettled(8000);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
}

/** 받아쓴 글 등을 메모 끝에 (서식대로) */
export function appendText(md) {
  if (!editor || !md) return;
  editor.appendMarkdown(md);
  flush();
}

/** 녹음 결과: 음성 카드(소리 + 받아쓴 글)를 메모 끝에. 빈 메모면 제목 줄부터 */
export function insertRecording(cardMd, heading) {
  if (!editor) return;
  if (!editorMarkdown().trim() && heading) editor.setMarkdown(`# ${heading}\n`);
  editor.appendMarkdown(cardMd);
  flush();
}

/** 밖에서 들어온 메모(캡처·공유)에 태그를 저절로: 내용에 맞는 기존 태그 + 들어온 곳 태그 → 단 태그 이름들 */
export function autoTagIncoming(source) {
  if (!editor || !id || !app.vault) return [];
  const tags = autoTagsFor(editorMarkdown(), app.vault.bodies(), { source, excludeId: id });
  if (tags.length) editor.appendMarkdown(tags.map((t) => `#${t}`).join(' '));
  return tags;
}

/** 받아쓴 글을 그 소리 줄에 붙여 음성 카드로 */
export function attachTranscript(src, text) {
  if (!editor?.attachTranscript(src, text)) return false;
  flush();
  return true;
}
