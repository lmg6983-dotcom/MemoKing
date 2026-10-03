// 메모 화면 — 데스크탑 스티커 창(app/js/note.js)을 휴대폰 한 화면으로.
// 편집기(app/js/editor.js)·예약 알림 패널(app/js/reminder-panel.js)은 데스크탑과 같은 코드를 쓴다.
import { icon } from '../../app/js/icons.js';
import { createNoteEditor } from '../../app/js/editor.js';
import { TEXT_COLORS, HIGHLIGHT_COLORS } from '../../app/js/core/html-marks.js';
import { fileExtension, mediaKind, baseName } from '../../app/js/media.js';
import { isDataImage, decodeDataImage } from '../../app/js/core/remote-images.js';
import { setupReminderPanel } from '../../app/js/reminder-panel.js';
import { collectTags } from '../../app/js/core/tags.js';
import { app, reduceMotion } from './state.js';
import { call } from './native.js';
import { fetchRemoteImage } from './web-fetch.js';
import { openSheet, closeSheet, adoptSheet, releaseSheet, toast, matchChrome } from './ui.js';

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
  editor.setMarkdown(next.body);
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
  matchChrome(el.bar);
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

function refreshLinks() {
  if (!id) return;
  const { links, backlinks, suggestions } = app.vault.links(id);
  const total = new Set([...links, ...backlinks].map((m) => m.id)).size;
  el.linksCount.textContent = total ? String(total) : '';
  el.linksBtn.classList.toggle('has-links', total > 0);
  if (el.linksPanel.hidden) return;
  el.linksOut.replaceChildren(...links.map((m) => linkItem(m, { onRemove: () => setLink(m.id, false) })));
  el.linksIn.replaceChildren(...backlinks.map((m) => linkItem(m)));
  el.linksSuggest.replaceChildren(...suggestions.map((m) => linkItem(m, { onAdd: () => setLink(m.id, true), score: m.score })));
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

const actions = {
  file: () => pickAndInsert('*/*'),
  camera: () => pickAndInsert('image/*'),
  table: () => editor.insertTable(),
  tag: () => {
    editor.focus();
    document.execCommand('insertText', false, '#');
  },
  undo: () => pressKey('z'),
  redo: () => pressKey('z', true),
  done: () => document.activeElement?.blur(),
  color: (btn) => (paletteKind === 'color' ? closePalette() : openPalette('color', btn)),
  highlight: (btn) => (paletteKind === 'highlight' ? closePalette() : openPalette('highlight', btn)),
};

el.formatBar.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서(키보드)를 유지
el.formatBar.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !editor) return;
  if (btn.dataset.cmd) {
    closePalette();
    editor.run(btn.dataset.cmd);
  } else if (btn.dataset.action) {
    if (!['color', 'highlight'].includes(btn.dataset.action)) closePalette();
    actions[btn.dataset.action]?.(btn);
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!el.palette.hidden && !el.palette.contains(e.target) && !e.target.closest?.('[data-action="color"],[data-action="highlight"]')) closePalette();
});

// 표 막대: 표 안에 커서가 있을 때만
function showTableBar(table) {
  el.tableBar.hidden = !table;
  for (const b of document.querySelectorAll('[data-action="table"]')) b.classList.toggle('active', Boolean(table));
  if (!table) return;
  el.tableBar.querySelector('[data-table="delRow"]').disabled = table.header;
  el.tableBar.querySelector('[data-table="delCol"]').disabled = table.cols <= 1;
}
el.tableBar.addEventListener('mousedown', (e) => e.preventDefault());
el.tableBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-table]');
  if (b && !b.disabled) editor.tableCommand(b.dataset.table);
});

function showActive(active) {
  showTableBar(active.table);
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
    });
    // 편집기가 불러온 뒤 정리한 마크다운을 기준으로 (열기만 해도 저장되는 일 방지)
    current = saved = editor.getMarkdown();
    reminderPanel.set(memo.reminders);
    refreshLinks();
    if (options.alarm) showAlarm(options.alarm);
    if (options.highlight) highlight();
    if (options.capture) await options.capture(editor);
    if (options.fresh && !options.capture) editor.focus();
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
  const closing = id;
  closePalette();
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
  clearTimeout(saveTimer);
  editor?.destroy();
  editor = null;
  id = null;
  memo = null;
  el.screen.hidden = true;
  delete document.body.dataset.noteColor;
}

export function editorMarkdown() {
  if (editor) current = editor.getMarkdown();
  return current;
}

paintSwatchBars();
