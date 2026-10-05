// 메모 화면 — 데스크탑 스티커 창(app/js/note.js)을 휴대폰 한 화면으로.
// 편집기(app/js/editor.js)·예약 알림 패널(app/js/reminder-panel.js)은 데스크탑과 같은 코드를 쓴다.
import { icon } from '../../app/js/icons.js';
import { createNoteEditor } from '../../app/js/editor.js';
import { TEXT_COLORS, HIGHLIGHT_COLORS } from '../../app/js/core/html-marks.js';
import { fileExtension, mediaKind, baseName } from '../../app/js/media.js';
import { isDataImage, decodeDataImage } from '../../app/js/core/remote-images.js';
import { setupReminderPanel } from '../../app/js/reminder-panel.js';
import { collectTags, extractTags, sameTag } from '../../app/js/core/tags.js';
import { suggestTagsFor, appendTags } from '../../app/js/core/tag-suggest.js';
import { clampZoom, zoomLabel } from '../../app/js/core/zoom.js';
import { app, reduceMotion } from './state.js';
import { call } from './native.js';
import { fetchRemoteImage } from './web-fetch.js';
import { openSheet, closeSheet, adoptSheet, releaseSheet, toast, matchChrome, isTwoPane } from './ui.js';
import * as recorder from './recorder.js';

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
let reminderPanel = null;
let id = null;
let memo = null;
let current = '';   // 편집기의 최신 마크다운
let saved = '';     // 마지막으로 저장한 마크다운
let saveTimer = null;
let pendingExternal = null;
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
  if (current === saved) return;
  if (!el.tagBar.hidden || !extractTags(md).length) scheduleTagBar();
  setStatus('');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

// 빈 메모 안내 문구 (한글 조합 중에도 바로 끈다)
let docEmpty = true;
let composing = false;
function showPlaceholder(empty = docEmpty) {
  docEmpty = empty;
  el.editorRoot.classList.toggle('is-empty', empty && !composing);
}
el.editorRoot.addEventListener('compositionstart', () => {
  composing = true;
  showPlaceholder();
});
el.editorRoot.addEventListener('compositionend', () => {
  composing = false;
  showPlaceholder();
});
el.editorRoot.addEventListener('beforeinput', (e) => {
  if (e.inputType.startsWith('insert') && docEmpty) el.editorRoot.classList.remove('is-empty');
});

/** 쓰던 내용을 바로 저장 (화면을 떠나거나 앱이 뒤로 갈 때) */
export function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!id || !isDirty()) return;
  const body = current;
  try {
    app.vault.save(id, body);
    saved = body;
    setStatus('저장했어요');
  } catch (err) {
    console.error(err);
    setStatus('저장하지 못했어요. 메모 폴더가 연결돼 있는지 확인해 주세요.', true);
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

/** 메모 폴더가 바뀌었을 때 (vault 'changed') */
export function onVaultChanged({ ids, external, removed }) {
  if (!id || !editor) return;
  if (removed.includes(id)) {
    el.bannerText.textContent = '메모 폴더에서 이 메모가 사라졌어요. 계속 쓰면 다시 저장할게요.';
    el.bannerLoad.hidden = true;
    el.banner.hidden = false;
    return;
  }
  if (external.includes(id)) {
    const next = app.vault.get(id);
    if (!next) return;
    if (!isDirty()) applyExternal(next);
    else {
      pendingExternal = next;
      el.bannerText.textContent = '다른 곳에서 이 메모를 고쳤어요.';
      el.bannerLoad.hidden = false;
      el.banner.hidden = false;
    }
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
el.bannerLoad.addEventListener('click', () => pendingExternal && applyExternal(pendingExternal));
$('banner-keep').addEventListener('click', () => {
  el.banner.hidden = true;
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
  $('alarm-banner').classList.remove('ring');
  void $('alarm-banner').offsetWidth;
  $('alarm-banner').classList.add('ring');
}
$('alarm-ok').addEventListener('click', () => ($('alarm-banner').hidden = true));

function highlight() {
  el.screen.classList.remove('highlight');
  void el.screen.offsetWidth;
  el.screen.classList.add('highlight');
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
    more.textContent = g.memos.length ? '누르면 목록에서 모아 보기' : '아직 이 태그를 단 다른 메모가 없어요';
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
  $('links-in-title').hidden = backlinks.length === 0;
  el.linksIn.replaceChildren(...backlinks.map((m) => linkItem(m)));
  $('links-suggest-title').hidden = suggestions.length === 0;
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
  el.tagChips.replaceChildren(...list.map((t) => {
    const b = tagChip(t.name, { add: true, onClick: () => addTags([t.name]) });
    if (t.sure) b.classList.add('sure');
    if (!t.existing) b.classList.add('new');
    if (t.why) b.title = t.why;
    return b;
  }));
  if (list.length > 1) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'link-btn';
    all.textContent = '모두 달기';
    all.addEventListener('click', () => addTags(list.map((t) => t.name)));
    el.tagChips.append(all);
  }
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
  toast(`태그 ${sure.map((t) => `#${t.name}`).join(' ')} 를 달았어요`, false, {
    label: '되돌리기',
    run: () => {
      app.vault.save(memoId, body);
      dismissed.add(memoId);
      toast('태그를 떼었어요');
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
    setStatus(`파일 ${files.length}개를 메모 폴더에 넣고 있어요`);
    const items = tempsToItems(files);
    // 쓰던 자리가 있으면 그 자리에, 아니면(키보드를 내리고 버튼만 누름) 메모 끝에
    const typing = el.editorRoot.contains(document.activeElement);
    editor.insertItems(items, { atCursor: typing });
    flush();
    setStatus(`파일 ${items.length}개를 넣었어요`);
  } catch (err) {
    console.error(err);
    setStatus('파일을 넣지 못했어요. 다시 시도해 주세요.', true);
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
    b.setAttribute('aria-checked', String(value === lastColor[kind]));
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

const actions = {
  file: () => pickAndInsert('*/*'),
  record: () => recorder.toggle(),
  table: () => editor.insertTable(),
  style: (btn) => (el.styleMenu.hidden ? openStyleMenu(btn) : closeStyleMenu()),
  color: (btn) => (paletteKind === 'color' ? closePalette() : openPalette('color', btn)),
  highlight: (btn) => (paletteKind === 'highlight' ? closePalette() : openPalette('highlight', btn)),
};

el.formatBar.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서(키보드)를 유지
el.formatBar.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !editor) return;
  if (btn.dataset.cmd) {
    closePalette();
    closeStyleMenu();
    editor.run(btn.dataset.cmd);
  } else if (btn.dataset.action) {
    if (!['color', 'highlight'].includes(btn.dataset.action)) closePalette();
    if (btn.dataset.action !== 'style') closeStyleMenu();
    actions[btn.dataset.action]?.(btn);
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!el.palette.hidden && !el.palette.contains(e.target) && !e.target.closest?.('[data-action="color"],[data-action="highlight"]')) closePalette();
  if (!el.styleMenu.hidden && !el.styleMenu.contains(e.target) && !e.target.closest?.('[data-action="style"]')) closeStyleMenu();
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
  showTableBar(active.table);
  currentStyle = styleOf(active);
  for (const b of document.querySelectorAll('[data-action="style"]')) {
    b.querySelector('.style-name').textContent = STYLE_NAMES[currentStyle];
    b.classList.toggle('active', currentStyle !== 'paragraph');
  }
  el.undoBtn.disabled = !active.canUndo;
  el.redoBtn.disabled = !active.canRedo;
  for (const btn of el.formatBar.querySelectorAll('[data-cmd]')) btn.classList.toggle('active', Boolean(active[btn.dataset.cmd]));
  for (const kind of ['color', 'highlight']) {
    for (const btn of el.formatBar.querySelectorAll(`[data-action="${kind}"]`)) btn.classList.toggle('active', Boolean(active[kind]));
  }
}

// 키보드가 올라와 있을 때만 "키보드 닫기" 버튼
export function setKeyboard(open) {
  el.screen.classList.toggle('keyboard', open);
}

// ---------- 위쪽 버튼 ----------

$('back-btn').addEventListener('click', () => app.showList());
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
    toast('메모를 찾지 못했어요. 메모 폴더에서 옮겨졌거나 지워졌을 수 있어요.', true);
    return;
  }
  opening = (async () => {
    id = memoId;
    memo = next;
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
    });
    // 편집기가 불러온 뒤 정리한 마크다운을 기준으로 (열기만 해도 저장되는 일 방지)
    current = saved = editor.getMarkdown();
    reminderPanel.set(memo.reminders);
    refreshLinks();
    el.undoBtn.disabled = true;
    el.redoBtn.disabled = true;
    renderTagBar();
    recorder.attach(memoId);
    if (options.alarm) showAlarm(options.alarm);
    if (options.highlight) highlight();
    if (options.capture) await options.capture(editor);
    if (options.record) recorder.start(memoId);
    else if (options.fresh && !options.capture) editor.focus();
  })();
  try {
    await opening;
  } finally {
    opening = null;
  }
}

/** 목록으로: 저장하고, 빈 메모는 치우고, 제목이 바뀌었으면 파일 이름을 맞춘다 */
export function closeNote({ quiet = false } = {}) {
  if (!id) return;
  flush();
  flushTables();
  clearStamp.hidden = true;
  const closing = id;
  const body = current;
  closePalette();
  closeStyleMenu();
  clearTimeout(suggestTimer);
  el.tagBar.hidden = true;
  recorder.detach();
  for (const panel of [el.linksPanel, $('reminder-panel')]) if (!panel.hidden) closeSheet(panel);
  editor?.destroy();
  editor = null;
  id = null;
  memo = null;
  pendingExternal = null;
  delete document.body.dataset.noteColor;
  try {
    app.vault.finalize(closing);
  } catch (err) {
    console.error(err);
  }
  if (app.vault.get(closing)) autoTag(closing, body);
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
  clearStamp.hidden = true;
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

// ---------- CLEAR 도장: 체크리스트를 모두 끝내면 (데스크탑 v0.17.13 과 같음) ----------
const clearStamp = document.createElement('div');
clearStamp.className = 'clear-stamp';
clearStamp.textContent = 'CLEAR';
clearStamp.setAttribute('role', 'status');
clearStamp.setAttribute('aria-label', '체크리스트를 모두 끝냈어요');
clearStamp.hidden = true;
el.screen.append(clearStamp);
const placeClearStamp = () => {
  const r = el.editorRoot.getBoundingClientRect();
  clearStamp.style.left = `${Math.round(r.left + r.width / 2)}px`;
  clearStamp.style.top = `${Math.round(r.top + r.height / 2)}px`;
};
new ResizeObserver(() => {
  if (!clearStamp.hidden) placeClearStamp();
}).observe(el.editorRoot);

// 처음 열 때는 그냥 찍혀 있고, 방금 끝냈을 때만 "쿵"
function showTasks({ total, done }, { initial = false } = {}) {
  const clear = total > 0 && done === total;
  const was = !clearStamp.hidden;
  clearStamp.hidden = !clear;
  if (!clear) {
    clearStamp.classList.remove('stamp-in');
    return;
  }
  placeClearStamp();
  if (!was && !initial) {
    clearStamp.classList.remove('stamp-in');
    void clearStamp.offsetWidth;
    clearStamp.classList.add('stamp-in');
    navigator.vibrate?.(30);
  }
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
  for (const child of root.children) child.style.width = zoom > 1 ? `${base}px` : '';
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
new ResizeObserver(() => applyZoom()).observe(el.editorRoot);
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
  setStatus(zoom >= 1 ? `매직 줌 · 확대 ${zoomLabel(zoom)}` : `매직 줌 · 글자 ${zoomLabel(zoom)}`);
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

/** 본문을 통째로 바꾸고 저장 (다시 받아쓴 글을 녹음 아래에 넣을 때) */
export function replaceBody(md) {
  if (!editor) return;
  editor.setMarkdown(md);
  current = editor.getMarkdown();
  saved = '';
  flush();
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

/** 받아쓴 글을 그 소리 줄에 붙여 음성 카드로 */
export function attachTranscript(src, text) {
  if (!editor?.attachTranscript(src, text)) return false;
  flush();
  return true;
}
