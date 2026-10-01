// 스티커 메모 창 — 메모 1개 = 창 1개 = 파일 1개.
import { injectIcons, icon } from './icons.js';
import { createNoteEditor } from './editor.js';
import { COLORS, extractTitle, isBlankBody } from './core/memo-file.js';
import { TEXT_COLORS, HIGHLIGHT_COLORS } from './core/html-marks.js';
import { fileExtension } from './media.js';
import { isDataImage, decodeDataImage } from './core/remote-images.js';
import { setupReminderPanel } from './reminder-panel.js';
import { formatBytes } from './core/file-kinds.js';
import { extractTags } from './core/tags.js';
import { setupCoach } from './coach.js';
import { stepZoom, clampZoom, zoomLabel } from './core/zoom.js';

const SAVE_DELAY = 600;
const COLOR_NAMES = { yellow: '노랑', green: '초록', pink: '분홍', purple: '보라', blue: '파랑', gray: '회색', charcoal: '검정' };

const api = window.memoking;
const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);
const el = {
  status: $('status'),
  editorRoot: $('editor'),
  linksBtn: $('links-btn'),
  linksCount: $('links-count'),
  menu: $('menu'),
  menuBtn: $('menu-btn'),
  swatches: $('swatches'),
  pinToggle: $('pin-toggle'),
  topBtn: $('top-btn'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  linksPanel: $('links-panel'),
  linkSearch: $('link-search'),
  linkResults: $('link-results'),
  linksOut: $('links-out'),
  linksIn: $('links-in'),
  linksSuggest: $('links-suggest'),
  formatBar: $('format-bar'),
  formatItems: $('format-items'),
  moreBtn: $('more-btn'),
  morePanel: $('more-panel'),
  palette: $('palette'),
  fileInput: $('file-input'),
  confirm: $('confirm-dialog'),
};

let editor = null;
let reminderPanel = null;
let memo = null;
let current = '';   // 편집기의 최신 마크다운
let saved = '';     // 마지막으로 저장한 마크다운
let saveTimer = null;
let pendingExternal = null;

// ---------- 저장 ----------

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

// 편집기의 변경 알림은 약간 늦게 오므로, 저장 직전에는 편집기에서 직접 읽는다.
function isDirty() {
  if (editor) current = editor.getMarkdown();
  return current !== saved;
}

function onChange(md) {
  current = md;
  // 튜토리얼 따라 하기: 글을 쓰면 · 태그를 붙이면 다음 단계로
  const advance = coach?.step?.advance;
  if (advance === 'typed' && !isBlankBody(md)) api.tutorial.event('typed');
  if (advance === 'tagged' && extractTags(md).length) api.tutorial.event('tagged');
  document.title = extractTitle(md);
  if (current === saved) return;
  setStatus('');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

// 빈 메모 안내 문구: 편집기 내용이 바뀌는 즉시 끄고 켠다. 한글 조합 중에는 글자가 아직 문서에 안 들어왔어도 끈다.
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

async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!isDirty()) return;
  const body = current;
  try {
    await api.memo.save(id, body);
    saved = body;
    setStatus('저장했어요');
  } catch (err) {
    console.error(err);
    setStatus('저장하지 못했어요. 메모 폴더가 연결돼 있는지 확인해 주세요.', true);
  }
}

// 창을 닫는 순간 — 남은 내용을 동기 저장
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  if (isDirty()) {
    api.memo.saveSync(id, current);
    saved = current;
  }
});

// ---------- 다른 곳(다른 PC, 다른 앱)에서 바뀐 경우 ----------

function applyExternal(next) {
  editor.setMarkdown(next.body, next.tables ?? []);
  current = saved = editor.getMarkdown();
  el.banner.hidden = true;
  pendingExternal = null;
  setStatus('바뀐 내용을 불러왔어요');
}

api.on('memo:external', (next) => {
  if (!next) return;
  if (!isDirty()) applyExternal(next);
  else {
    pendingExternal = next;
    el.bannerText.textContent = '다른 곳에서 이 메모를 고쳤어요.';
    el.banner.hidden = false;
  }
});
api.on('memo:removed', () => {
  el.bannerText.textContent = '메모 폴더에서 이 메모가 사라졌어요. 계속 쓰면 다시 저장할게요.';
  $('banner-load').hidden = true;
  el.banner.hidden = false;
});
$('banner-load').addEventListener('click', () => pendingExternal && applyExternal(pendingExternal));
$('banner-keep').addEventListener('click', () => {
  el.banner.hidden = true;
  pendingExternal = null;
  saved = '';
  flush(); // 내 내용으로 덮어쓴다
});

// ---------- 색·고정·항상 위 ----------

function applyMeta(next) {
  memo = { ...memo, ...next };
  document.body.dataset.color = memo.color;
  for (const s of el.swatches.children) s.setAttribute('aria-checked', String(s.dataset.color === memo.color));
  el.pinToggle.setAttribute('aria-checked', String(memo.pinned));
  el.pinToggle.querySelector('span').textContent = memo.pinned ? '목록 맨 위 고정 풀기' : '목록 맨 위에 고정';
}

for (const color of COLORS) {
  const swatch = document.createElement('button');
  swatch.className = 'swatch';
  swatch.dataset.color = color;
  swatch.title = COLOR_NAMES[color];
  swatch.setAttribute('role', 'menuitemradio');
  swatch.addEventListener('click', async () => applyMeta(await api.memo.set(id, { color })));
  el.swatches.append(swatch);
}

el.pinToggle.addEventListener('click', async () => {
  await flush();
  applyMeta(await api.memo.set(id, { pinned: !memo.pinned }));
  closeMenu();
});
// ---------- 항상 위 고정 ----------

// 스티커를 붙이고 떼는 느낌: 켜면 버튼의 왕관이 떨어져 나가 창 위 가장자리 스티커가 되고(버튼은 빈 자리),
// 스티커를 누르면 떼어져 꺼지고 왕관이 버튼으로 돌아온다 (메인 프로세스가 따로 띄우는 스티커 창)
let topOn = null;
function applyTop(on) {
  const changed = topOn !== null && topOn !== on;
  topOn = on;
  el.topBtn.classList.toggle('peeled', on);
  el.topBtn.tabIndex = on ? -1 : 0;
  el.topBtn.setAttribute('aria-hidden', String(on));
  if (changed && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.topBtn.querySelector('svg').animate(on
      ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px) rotate(-12deg) scale(0.7)' }]
      : [{ opacity: 0, transform: 'scale(0.4) rotate(12deg)' }, { opacity: 1, transform: 'scale(1.15)', offset: 0.7 }, { opacity: 1, transform: 'none' }],
    { duration: on ? 200 : 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
  el.topBtn.setAttribute('aria-pressed', String(on));
  const label = on ? '늘 위에 두기 끄기' : '다른 창보다 늘 위에 두기';
  el.topBtn.title = '왕관 스티커를 붙여 다른 창보다 늘 위에 두기 (Ctrl+Shift+T)';
  el.topBtn.setAttribute('aria-label', label);
  document.body.classList.toggle('on-top', on);
}

// 버튼·Ctrl+Shift+T 는 붙이기만 (떼기는 창 위의 왕관 스티커를 눌러서)
async function toggleTop() {
  if (topOn) return;
  applyTop(await api.win.toggleTop(id));
}
el.topBtn.addEventListener('click', toggleTop);
$('pdf-btn').addEventListener('click', async () => {
  closeMenu();
  await flush(); // 지금 적은 내용까지 PDF 에
  api.pdf.open(id);
});
$('show-list').addEventListener('click', () => {
  api.win.showList();
  closeMenu();
});
$('delete-btn').addEventListener('click', async () => {
  closeMenu();
  if (!isBlankBody(current)) {
    $('confirm-message').textContent = `"${extractTitle(current)}" 메모를 지울까요?\n지운 메모는 메모 폴더 안 휴지통에 보관돼요.`;
    el.confirm.returnValue = '';
    el.confirm.showModal();
    const ok = await new Promise((resolve) => el.confirm.addEventListener('close', () => resolve(el.confirm.returnValue === 'ok'), { once: true }));
    if (!ok) return;
  }
  saved = current; // 삭제하는 메모는 저장하지 않는다
  await api.memo.remove(id);
});

api.on('memo:meta', applyMeta);

function toggleMenu() {
  el.menu.hidden = !el.menu.hidden;
}
function closeMenu() {
  el.menu.hidden = true;
}
el.menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});
document.addEventListener('mousedown', (e) => {
  if (!el.menu.hidden && !el.menu.contains(e.target) && !el.menuBtn.contains(e.target)) closeMenu();
});

// ---------- 연결 패널 ----------

function linkItem(target, { onRemove, onAdd, score } = {}) {
  const li = document.createElement('li');
  li.className = 'link-item';
  const open = document.createElement('button');
  open.className = 'link-open';
  open.dataset.color = target.color;
  open.title = '메모 열기';
  const dot = document.createElement('span');
  dot.className = 'link-dot';
  const title = document.createElement('span');
  title.textContent = target.title;
  open.append(dot, title);
  open.addEventListener('click', () => api.memo.open(target.id));
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
    b.title = label;
    b.setAttribute('aria-label', `${target.title} ${label}`);
    b.append(icon(name));
    b.addEventListener('click', handler);
    li.append(b);
  };
  if (onAdd) addBtn('plus', '연결하기', onAdd);
  if (onRemove) addBtn('close', '연결 끊기', onRemove);
  return li;
}

async function setLink(targetId, on) {
  await flush();
  await api.memo.link(id, targetId, on);
  el.linkSearch.value = '';
  el.linkResults.replaceChildren();
  await refreshLinks();
}

async function refreshLinks() {
  const { links, backlinks, suggestions } = await api.memo.links(id);
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
  linkSearchTimer = setTimeout(async () => {
    const q = el.linkSearch.value.trim();
    if (!q) return el.linkResults.replaceChildren();
    const { links } = await api.memo.links(id);
    const linked = new Set(links.map((m) => m.id));
    const results = (await api.memos.search(q, id)).filter((m) => !linked.has(m.id)).slice(0, 8);
    el.linkResults.replaceChildren(...results.map((m) => linkItem(m, { onAdd: () => setLink(m.id, true) })));
  }, 150);
});

async function toggleLinks(force) {
  el.linksPanel.hidden = force === undefined ? !el.linksPanel.hidden : !force;
  if (!el.linksPanel.hidden) {
    if (reminderPanel?.open) reminderPanel.toggle(false); // 패널은 하나씩
    await flush();
    await refreshLinks();
    el.linkSearch.focus();
  } else editor.focus();
}
el.linksBtn.addEventListener('click', () => toggleLinks());
$('links-close').addEventListener('click', () => toggleLinks(false));
api.on('memo:links-changed', refreshLinks);

// ---------- 예약 알림 ----------

// 알림으로 이 메모가 떴을 때 보여주는 띠
function showAlarm(alarm) {
  $('alarm-text').textContent = alarm.label; // 종 아이콘이 앞에 있으므로 글자만
  $('alarm-banner').hidden = false;
  $('alarm-banner').classList.remove('ring');
  void $('alarm-banner').offsetWidth; // 애니메이션 다시 시작
  $('alarm-banner').classList.add('ring');
}
$('alarm-ok').addEventListener('click', () => {
  $('alarm-banner').hidden = true;
  editor?.focus();
});
api.on('memo:alarm', showAlarm);

// 빠른 메모 알림을 눌러 이 메모로 왔을 때 등: 창 테두리가 두 번 반짝여 "이 메모" 임을 알린다
api.on('memo:highlight', () => {
  document.body.classList.remove('highlight');
  void document.body.offsetWidth; // 애니메이션 다시 시작
  document.body.classList.add('highlight');
});
document.body.addEventListener('animationend', (e) => {
  if (e.animationName === 'note-highlight') document.body.classList.remove('highlight');
});
api.on('memo:reminders', (list) => reminderPanel?.set(list));
// 스택의 다른 탭에서 늘 위에 두기를 바꾼 경우 (이 창은 숨어 있었음)
api.on('memo:on-top', (on) => applyTop(on));

// ---------- 빠른 메모 (Ctrl+Alt+C) ----------
// 메인 프로세스가 복사해 온 내용으로 새 메모를 채운다: 제목(파일·그림일 때) → 글(붙여넣기) → 파일·그림 → 출처

const escapeMd = (s) => s.replace(/([\\`*_[\]<>#])/g, '\\$1');

async function applyCapture(c) {
  if (c.heading) editor.setMarkdown(`# ${escapeMd(c.heading)}\n`);
  editor.focusEnd();
  if (c.html || c.text) editor.pasteData({ html: c.html, text: c.text });
  editor.insertItems(c.items);
  await new Promise((r) => setTimeout(r, 30)); // 붙여넣기가 반영된 뒤
  editor.appendMarkdown(c.sourceMd);
  editor.focusEnd();
  // 웹 사진을 받는 중에 저장하면 주소 교체와 엇갈릴 수 있어, 받기가 끝난 뒤 한 번에 저장
  if (c.html) {
    setStatus('사진을 메모 폴더에 받고 있어요');
    await editor.imagesSettled();
  }
  await flush();
  const skipped = c.skipped.length ? ` · 폴더 ${c.skipped.length}개는 넣을 수 없어서 뺐어요` : '';
  setStatus(c.source.copied ? `고른 내용으로 메모를 만들었어요${skipped}` : `복사해 둔 내용으로 메모를 만들었어요${skipped}`);
}

// ---------- 파일 넣기 ----------
// 이미지는 바로 보이고, 소리·동영상은 플레이어로, 그 밖의 파일은 파일 칩(누르면 열림)으로 들어간다.

async function saveFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return api.attachments.save(bytes, fileExtension(file));
}

// 붙여넣은 인터넷·data: 사진을 메모 폴더에 저장 → "attachments/..."
async function fetchImage(src) {
  if (isDataImage(src)) {
    const image = decodeDataImage(src);
    if (!image) throw new Error('지원하지 않는 그림 형식');
    return api.attachments.save(image.bytes, image.ext);
  }
  return api.attachments.fetch(src);
}

async function insertFiles(files) {
  try {
    await editor.insertFiles(files);
  } catch (err) {
    console.error(err);
    setStatus('파일을 넣지 못했어요. 다시 시도해 주세요.', true);
  }
}

el.fileInput.addEventListener('change', () => {
  insertFiles([...el.fileInput.files]);
  el.fileInput.value = '';
});

// ---------- 링크·파일 한 번 눌러 열기 ----------
// 인터넷 링크는 기본 브라우저로, 파일 칩은 메모 폴더의 복사본을 기본 앱으로. 사진은 두 번 누르면 사진 앱으로.

async function openAttachment(rel) {
  const result = await api.attachments.open(rel);
  if (result && result !== 'cancelled') setStatus(result, true);
}

function openHref(href) {
  if (/^https?:/i.test(href)) api.links.open(href);
  else if (href.startsWith('attachments/')) openAttachment(href);
}

el.editorRoot.addEventListener('click', (e) => {
  if (e.button !== 0 || e.shiftKey) return;
  const a = e.target.closest?.('a[href]');
  if (!a || !el.editorRoot.contains(a)) return;
  e.preventDefault();
  // 글자를 끌어서 고르던 중이면 열지 않는다
  if (!window.getSelection()?.isCollapsed) return;
  openHref(a.getAttribute('href'));
});

// memoking://vault/attachments/a.png → attachments/a.png
function vaultPathOf(src) {
  try {
    const u = new URL(src);
    if (u.protocol === 'memoking:' && u.host === 'vault') return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
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

// 파일 칩에 마우스를 올리면 이름·크기 안내
const hint = document.createElement('div');
hint.className = 'hover-hint';
hint.hidden = true;
document.body.append(hint);
let hintFor = null;
el.editorRoot.addEventListener('mouseover', async (e) => {
  const a = e.target.closest?.('a[data-file]');
  if (!a || a === hintFor) return;
  hintFor = a;
  const href = a.getAttribute('href');
  const info = await api.attachments.info(href).catch(() => null);
  if (hintFor !== a) return;
  const program = a.dataset.file === 'program';
  hint.textContent = !info?.exists
    ? '이 PC의 메모 폴더에 파일이 아직 없어요'
    : `${a.textContent} · ${formatBytes(info.size)} · ${program ? '누르면 실행할지 물어볼게요' : '누르면 열려요'}`;
  const r = a.getBoundingClientRect();
  hint.hidden = false;
  const left = Math.max(6, Math.min(r.left, window.innerWidth - hint.offsetWidth - 6));
  const top = r.bottom + 6 + hint.offsetHeight > window.innerHeight ? r.top - hint.offsetHeight - 6 : r.bottom + 6;
  hint.style.left = `${left}px`;
  hint.style.top = `${top}px`;
});
el.editorRoot.addEventListener('mouseout', (e) => {
  const a = e.target.closest?.('a[data-file]');
  if (!a || a.contains(e.relatedTarget)) return;
  hintFor = null;
  hint.hidden = true;
});
el.editorRoot.addEventListener('scroll', () => {
  hintFor = null;
  hint.hidden = true;
}, true);

// ---------- 글자 색 · 하이라이트 색판 ----------

const PALETTES = {
  color: { title: '글자 색', colors: TEXT_COLORS, apply: (c) => editor.setTextColor(c) },
  highlight: { title: '형광펜', colors: HIGHLIGHT_COLORS, apply: (c) => editor.setHighlight(c) },
};
// 마지막으로 쓴 색 (이 PC 에서만 기억하는 편의 설정)
const lastColor = { color: TEXT_COLORS[0].value, highlight: HIGHLIGHT_COLORS[0].value };
try {
  Object.assign(lastColor, JSON.parse(localStorage.getItem('memoking.lastColor') ?? '{}'));
} catch {
  // 저장소를 못 쓰면 기본색
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
    b.title = name;
    b.setAttribute('aria-label', `${def.title} ${name}`);
    // 글자 색: 흰 칩 위에 그 색으로 쓴 A / 형광펜: 그 색 바탕
    if (kind === 'color') {
      b.textContent = 'A';
      b.classList.add('text-sample');
      b.style.color = value;
    } else b.style.background = value;
    b.setAttribute('aria-checked', String(value === lastColor[kind]));
    return b;
  }));
  el.palette.hidden = false;
  placePopover(el.palette, anchor);
}

function closePalette() {
  el.palette.hidden = true;
  paletteKind = null;
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
  closeMore();
}

el.palette.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 선택 유지
el.palette.addEventListener('click', (e) => {
  const swatch = e.target.closest('[data-color]');
  if (swatch) applyPaletteColor(swatch.dataset.color);
  else if (e.target.closest('#palette-clear')) applyPaletteColor(null);
});

// 도구막대 위쪽에, 창 밖으로 나가지 않게 띄운다
function placePopover(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = pop.offsetWidth;
  const left = Math.min(Math.max(6, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 6);
  pop.style.left = `${left}px`;
  pop.style.bottom = `${Math.max(6, window.innerHeight - rect.top + 6)}px`;
}

// ---------- 서식 도구막대 (넘치면 » 더보기) ----------

const toolbarItems = [...el.formatItems.children]; // 원래 순서

function closeMore() {
  el.morePanel.hidden = true;
  el.moreBtn.setAttribute('aria-expanded', 'false');
}

// 창 폭에 들어가는 만큼만 막대에 두고, 나머지는 더보기 안으로 옮긴다.
function layoutToolbar() {
  el.formatItems.append(...toolbarItems);
  el.moreBtn.hidden = true;
  if (el.formatItems.scrollWidth <= el.formatItems.clientWidth) {
    el.morePanel.replaceChildren();
    closeMore();
    return;
  }
  el.moreBtn.hidden = false;
  const overflow = [];
  while (el.formatItems.scrollWidth > el.formatItems.clientWidth && el.formatItems.children.length > 1) {
    overflow.unshift(el.formatItems.lastElementChild);
    el.formatItems.lastElementChild.remove();
  }
  // 막대 끝에 남은 구분선은 더보기 쪽으로
  while (el.formatItems.lastElementChild?.classList.contains('sep')) {
    overflow.unshift(el.formatItems.lastElementChild);
    el.formatItems.lastElementChild.remove();
  }
  while (overflow[0]?.classList.contains('sep')) overflow.shift();
  el.morePanel.replaceChildren(...overflow);
  if (!el.morePanel.hidden) placePopover(el.morePanel, el.moreBtn);
}
new ResizeObserver(layoutToolbar).observe(el.formatBar);

el.moreBtn.addEventListener('mousedown', (e) => e.preventDefault());
el.moreBtn.addEventListener('click', () => {
  closePalette();
  const open = el.morePanel.hidden;
  el.morePanel.hidden = !open;
  el.moreBtn.setAttribute('aria-expanded', String(open));
  if (open) placePopover(el.morePanel, el.moreBtn);
});

// ---------- 스타일 고르기 (H1·H2 버튼 대신): 본문 · 제목 1·2·3 · 인용 · 코드 블록 ----------
const styleMenu = $('style-menu');
const STYLE_NAMES = { paragraph: '본문', h1: '제목 1', h2: '제목 2', h3: '제목 3', quote: '인용', codeBlock: '코드 블록' };
let currentStyle = 'paragraph';

function closeStyleMenu() {
  styleMenu.hidden = true;
  for (const b of document.querySelectorAll('[data-action="style"]')) b.setAttribute('aria-expanded', 'false');
}
function openStyleMenu(anchor) {
  closePalette();
  for (const b of styleMenu.querySelectorAll('[data-style]')) b.setAttribute('aria-selected', String(b.dataset.style === currentStyle));
  styleMenu.hidden = false;
  for (const b of document.querySelectorAll('[data-action="style"]')) b.setAttribute('aria-expanded', 'true');
  placePopover(styleMenu, anchor);
}
// 지금 줄의 스타일 (코드 블록 > 제목 > 인용 > 본문)
function styleOf(active) {
  if (active.codeBlock) return 'codeBlock';
  for (const h of ['h1', 'h2', 'h3']) if (active[h]) return h;
  return active.quote ? 'quote' : 'paragraph';
}
function showStyle(active) {
  currentStyle = styleOf(active);
  for (const b of document.querySelectorAll('[data-action="style"]')) {
    b.querySelector('.style-name').textContent = STYLE_NAMES[currentStyle];
    b.classList.toggle('active', currentStyle !== 'paragraph');
  }
  if (!styleMenu.hidden) for (const b of styleMenu.querySelectorAll('[data-style]')) b.setAttribute('aria-selected', String(b.dataset.style === currentStyle));
}
styleMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서 유지
styleMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-style]');
  if (!b) return;
  editor.setStyle(b.dataset.style);
  closeStyleMenu();
  closeMore();
});
styleMenu.addEventListener('keydown', (e) => {
  const items = [...styleMenu.querySelectorAll('[data-style]')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  }
});

const actions = {
  style: (btn) => (styleMenu.hidden ? openStyleMenu(btn) : closeStyleMenu()),
  file: () => el.fileInput.click(),
  table: () => editor.insertTable(),
  color: (btn) => (paletteKind === 'color' ? closePalette() : openPalette('color', btn)),
  highlight: (btn) => (paletteKind === 'highlight' ? closePalette() : openPalette('highlight', btn)),
};

// 막대와 더보기 패널의 버튼은 같은 방식으로 동작한다.
function onToolbarClick(e) {
  const btn = e.target.closest('button');
  if (!btn || btn === el.moreBtn) return;
  if (btn.dataset.cmd) {
    editor.run(btn.dataset.cmd);
    closeMore();
  } else if (btn.dataset.action) {
    if (btn.dataset.action === 'file') closeMore();
    actions[btn.dataset.action]?.(el.morePanel.contains(btn) ? el.moreBtn : btn);
  }
}
for (const container of [el.formatBar, el.morePanel]) {
  container.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서를 유지
  container.addEventListener('click', onToolbarClick);
}

// 도구막대·팝업 밖을 누르면 팝업을 닫는다
document.addEventListener('mousedown', (e) => {
  if (!el.palette.hidden && !el.palette.contains(e.target) && !e.target.closest?.('[data-action="color"],[data-action="highlight"]')) closePalette();
  if (!el.morePanel.hidden && !el.morePanel.contains(e.target) && !el.moreBtn.contains(e.target) && !el.palette.contains(e.target) && !styleMenu.contains(e.target)) closeMore();
  if (!styleMenu.hidden && !styleMenu.contains(e.target) && !e.target.closest?.('[data-action="style"]')) closeStyleMenu();
});

// 표 열 너비·행 높이·머리글 강조 → 메모 머리말 (끄는 동안 여러 번 바뀌어도 한 번에)
let tablesTimer = 0;
let pendingTables = null;
function saveTables(tables) {
  pendingTables = tables;
  clearTimeout(tablesTimer);
  tablesTimer = setTimeout(flushTables, 400);
}
function flushTables() {
  clearTimeout(tablesTimer);
  if (!pendingTables) return;
  const t = pendingTables;
  pendingTables = null;
  api.memo.set(id, { tables: t }).catch(() => setStatus('표 크기를 저장하지 못했어요', true));
}
window.addEventListener('beforeunload', flushTables);

// 표 막대: 표 안에 커서가 있을 때만. 머리글 행과 마지막 남은 열은 지울 수 없으므로 막는다.
const tableBar = $('table-bar');
function showTableBar(table) {
  tableBar.hidden = !table;
  document.body.classList.toggle('in-table', Boolean(table));
  for (const b of document.querySelectorAll('[data-action="table"]')) b.classList.toggle('active', Boolean(table));
  if (!table) return;
  const delRow = tableBar.querySelector('[data-table="delRow"]');
  const delCol = tableBar.querySelector('[data-table="delCol"]');
  // 머리글 아래 행은 마지막 하나까지 지울 수 있다 (머리글 행만 남은 1행 표도 된다).
  // 머리글 행만 남았을 때 머리글에서 누르면, 열이 하나뿐일 때 누르면 표 전체를 지운다 (표 막대에 "표 지우기"가 따로 없음)
  const lastRow = table.header && table.rows <= 1;
  delRow.disabled = table.header && !lastRow;
  delRow.textContent = lastRow ? '표 지우기' : '행 지우기';
  delRow.title = lastRow ? '머리글 행만 남았어요. 누르면 표를 지워요' : table.header ? '머리글 행은 지울 수 없어요 (아래 행을 다 지운 뒤 누르면 표를 지워요)' : '이 행 지우기';
  // 셀 병합: 여러 칸을 골랐으면 "셀 병합", 병합한 칸 안이면 "병합 풀기"
  const merge = tableBar.querySelector('[data-table="merge"]');
  merge.textContent = table.merged ? '병합 풀기' : '셀 병합';
  merge.disabled = !table.canMerge && !table.merged;
  merge.title = table.merged ? '합친 칸을 다시 나누기' : table.canMerge ? '고른 칸들을 하나로 합치기' : '합칠 칸들을 끌어서 골라 주세요';
  delCol.textContent = table.cols <= 1 ? '표 지우기' : '열 지우기';
  delCol.title = table.cols <= 1 ? '열이 하나뿐이에요. 누르면 표를 지워요' : '이 열 지우기';
}
tableBar.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서가 표 안에 남게
tableBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-table]');
  if (!b || b.disabled) return;
  // 마지막 남은 머리글 행·열을 지우면 표 전체를 지운다
  const lastOne = (b.dataset.table === 'delRow' || b.dataset.table === 'delCol') && b.textContent === '표 지우기';
  editor.tableCommand(lastOne ? 'delTable' : b.dataset.table);
});

function showActive(active) {
  showTableBar(active.table);
  showStyle(active);
  for (const btn of document.querySelectorAll('[data-cmd]')) {
    btn.classList.toggle('active', Boolean(active[btn.dataset.cmd]));
  }
  for (const kind of ['color', 'highlight']) {
    for (const btn of document.querySelectorAll(`[data-action="${kind}"]`)) btn.classList.toggle('active', Boolean(active[kind]));
  }
}

// e.code 기준이라 한글 입력 상태에서도 동작한다.
const SHORTCUTS = {
  'ctrl+KeyB': ['cmd', 'bold'],
  'ctrl+KeyI': ['cmd', 'italic'],
  'ctrl+KeyU': ['cmd', 'underline'],
  'ctrl+shift+KeyC': ['color', 'color'],
  'ctrl+shift+KeyH': ['color', 'highlight'],
  'ctrl+KeyT': ['cmd', 'strike'],
  'ctrl+KeyE': ['cmd', 'code'],
  'ctrl+Digit1': ['cmd', 'h1'],
  'ctrl+Digit2': ['cmd', 'h2'],
  'ctrl+Digit3': ['cmd', 'h3'],
  'ctrl+Digit0': ['cmd', 'paragraph'],
  'ctrl+shift+Digit8': ['cmd', 'bullet'],
  'ctrl+shift+KeyL': ['cmd', 'bullet'],
  'ctrl+shift+Digit7': ['cmd', 'ordered'],
  'ctrl+shift+Digit9': ['cmd', 'task'],
  'ctrl+shift+KeyB': ['cmd', 'quote'],
  'ctrl+shift+KeyI': ['action', 'file'],
  'ctrl+shift+KeyT': ['app', 'top'],
  'ctrl+shift+KeyA': ['app', 'reminders'],
  'ctrl+KeyK': ['app', 'links'],
  'ctrl+KeyN': ['app', 'new'],
  'ctrl+KeyW': ['app', 'close'],
};

window.addEventListener('keydown', (e) => {
  if (!editor || el.confirm.open) return;
  if (e.key === 'Escape') {
    if (!styleMenu.hidden) closeStyleMenu();
    else if (!el.palette.hidden) closePalette();
    else if (!el.morePanel.hidden) closeMore();
    else if (!el.menu.hidden) closeMenu();
    else if (!el.linksPanel.hidden) toggleLinks(false);
    else if (reminderPanel?.open) reminderPanel.toggle(false);
    return;
  }
  // Ctrl+Tab / Ctrl+Shift+Tab: 스택의 다음·이전 탭
  if (e.ctrlKey && e.code === 'Tab' && !tabsEl.hidden) {
    e.preventDefault();
    e.stopPropagation();
    flush().then(() => api.stack.cycle(id, e.shiftKey ? -1 : 1));
    return;
  }
  const combo = `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.code}`;
  const hit = SHORTCUTS[combo];
  if (!hit) return;
  const inEditor = el.editorRoot.contains(document.activeElement);
  if ((hit[0] === 'cmd' || hit[0] === 'color') && !inEditor) return;
  e.preventDefault();
  e.stopPropagation();
  const [kind, name] = hit;
  if (kind === 'cmd') editor.run(name);
  else if (kind === 'color') {
    if (name === 'color') editor.toggleTextColor(lastColor.color);
    else editor.toggleHighlight(lastColor.highlight);
  } else if (kind === 'action') actions[name]();
  else if (name === 'links') toggleLinks();
  else if (name === 'top') toggleTop();
  else if (name === 'reminders') reminderPanel?.toggle();
  else if (name === 'new') api.memo.create({ color: memo.color });
  else if (name === 'close') closeTabOrWindow();
}, true);

// ---------- 본문 확대·축소 (Ctrl+마우스 휠, Ctrl+= / Ctrl+-) — 웹 브라우저처럼 글·사진·표가 함께 ----------
// 배율은 메모마다 이 PC 에 기억한다. 위 막대·서식 막대는 그대로.
const ZOOM_KEY = `memoking.zoom.${id}`;
let zoom = 1;
try {
  zoom = clampZoom(localStorage.getItem(ZOOM_KEY) ?? 1);
} catch {
  // 저장소를 못 써도 100% 로
}
const zoomBadge = document.createElement('div');
zoomBadge.className = 'zoom-badge';
zoomBadge.setAttribute('role', 'status');
const zoomText = document.createElement('span');
const zoomReset = document.createElement('button');
zoomReset.type = 'button';
zoomReset.textContent = '원래대로';
zoomReset.addEventListener('click', () => setZoom(1));
zoomBadge.append(zoomText, zoomReset);
document.body.append(zoomBadge);
let zoomTimer = 0;

function setZoom(z, { show = true } = {}) {
  const scroller = el.editorRoot;
  // 보던 곳이 그대로 보이게: 스크롤 위치를 배율에 맞춰 옮긴다
  const ratio = scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) : 0;
  zoom = clampZoom(z);
  el.editorRoot.style.setProperty('--note-zoom', String(zoom));
  document.body.dataset.zoom = String(zoom);
  scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  try {
    if (zoom === 1) localStorage.removeItem(ZOOM_KEY);
    else localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    // 기억 못 해도 지금 창에서는 그대로
  }
  if (!show) return;
  zoomText.textContent = `확대 ${zoomLabel(zoom)}`;
  zoomReset.hidden = zoom === 1;
  zoomBadge.classList.add('show');
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => zoomBadge.classList.remove('show'), 1600);
}
setZoom(zoom, { show: false });

// Ctrl+휠: 위로 굴리면 크게, 아래로 굴리면 작게 (창 전체가 아니라 본문만 — Chromium 의 페이지 확대는 막는다)
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (e.deltaY) setZoom(stepZoom(zoom, e.deltaY < 0 ? 1 : -1));
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey && e.code !== 'Equal') return;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setZoom(stepZoom(zoom, 1));
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') setZoom(stepZoom(zoom, -1));
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

async function closeWindow() {
  await flush();
  api.win.close();
}

// Ctrl+W: 스택이면 보이는 탭만 닫는다 (탭의 × 와 같음). 스택이 아니면 창을 닫는다.
async function closeTabOrWindow() {
  if (tabsEl.hidden) return closeWindow();
  await flush();
  api.stack.remove(id);
}

// 윗막대 + : 새 메모를 이 창의 새 탭으로 (스택이 아니면 스택이 된다). 따로 새 창은 Ctrl+N
$('new-btn').addEventListener('click', async () => {
  await flush();
  api.stack.newTab(id);
});
$('close-btn').addEventListener('click', closeWindow);
el.editorRoot.addEventListener('mousedown', (e) => {
  // 글 아래 빈 곳을 눌러도 편집을 시작할 수 있게
  if (e.target === el.editorRoot) {
    e.preventDefault();
    editor.focus();
  }
});

// ---------- 메모 스택: 브라우저처럼 탭 ----------
// 탭을 누르면 메인 프로세스가 그 메모의 창을 같은 자리에 보여 준다 (창마다 메모 하나).

const tabsEl = $('stack-tabs');
let coach = null; // 튜토리얼 말풍선

const TAB_CHARS = 7;
function renderStack(state) {
  const members = state?.members ?? [];
  const stacked = members.length >= 2;
  tabsEl.hidden = !stacked;
  document.body.classList.toggle('stacked', stacked);
  if (!stacked) return tabsEl.replaceChildren();
  const tabs = members.map((m) => {
    const tab = document.createElement('div');
    tab.className = 'stack-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(m.id === id));
    tab.dataset.tabId = m.id;
    tab.dataset.color = m.color; // 탭 바탕 = 그 메모의 색
    tab.title = m.id === id ? m.title : `${m.title} (Ctrl+Tab)`;
    const title = document.createElement('span');
    title.className = 'stack-title';
    title.textContent = Array.from(m.title).slice(0, TAB_CHARS).join(''); // 줄임표 없이 앞 7자
    const close = document.createElement('button');
    close.className = 'stack-close';
    close.type = 'button';
    close.title = '스택에서 빼기';
    close.setAttribute('aria-label', `${m.title} 스택에서 빼기`);
    close.dataset.closeTab = m.id;
    close.append(icon('close'));
    tab.append(title, close);
    return tab;
  });
  const add = document.createElement('button');
  add.className = 'stack-add';
  add.type = 'button';
  add.title = '새 탭 (새 메모)';
  add.setAttribute('aria-label', '새 탭');
  add.append(icon('plus'));
  tabsEl.replaceChildren(...tabs, add);
}

tabsEl.addEventListener('click', async (e) => {
  const close = e.target.closest('[data-close-tab]');
  if (close) {
    if (close.dataset.closeTab === id) await flush();
    return api.stack.remove(close.dataset.closeTab);
  }
  if (e.target.closest('.stack-add')) {
    await flush();
    return api.stack.newTab(id);
  }
  const tab = e.target.closest('[data-tab-id]');
  if (tab && tab.dataset.tabId !== id) {
    await flush();
    api.stack.activate(tab.dataset.tabId);
  }
});
// 탭 끌기: 왼쪽 탭 줄 안에서는 탭이 들려 위아래로 따라오고, 탭 줄 밖(오른쪽으로 20px 넘게·창 밖)으로 끌어내면
// 그 탭이 제 메모 창이 되어 커서를 따라온다 (브라우저 탭처럼). 조금만 끌었다 놓으면 그 탭으로 전환.
// 끌어내면 탭이 화면에서 사라지므로 포인터는 문서 전체가 잡고, 화면 좌표를 메인 프로세스로 보낸다.
const TEAR_DISTANCE = 20;
let tabPress = null; // { tabId, pointerId, sx, sy, cx, el, moved, torn }
tabsEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('[data-close-tab]')) return;
  const tab = e.target.closest('[data-tab-id]');
  if (!tab) return;
  tabPress = { tabId: tab.dataset.tabId, pointerId: e.pointerId, sx: e.screenX, sy: e.screenY, cx: e.clientX - tab.getBoundingClientRect().left + 10, el: tab, moved: false, torn: false };
});
window.addEventListener('pointermove', (e) => {
  const p = tabPress;
  if (!p || e.pointerId !== p.pointerId) return;
  const dx = e.screenX - p.sx;
  const dy = e.screenY - p.sy;
  if (!p.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    p.moved = true;
    // 움직이기 시작한 뒤부터 잡는다 (그냥 누르기는 보통 click 으로)
    try {
      document.documentElement.setPointerCapture(e.pointerId);
    } catch {
      // 자동 점검의 가짜 포인터 등
    }
  }
  if (p.torn) {
    api.stack.tearMove(e.screenX, e.screenY);
    return;
  }
  const strip = tabsEl.getBoundingClientRect();
  const out = e.clientX > strip.right + TEAR_DISTANCE || e.clientX < 0 || e.clientY < 0 || e.clientY > window.innerHeight;
  if (out) {
    p.torn = true;
    p.el.classList.remove('lifting');
    p.el.style.transform = '';
    document.body.classList.remove('tab-dragging');
    if (p.tabId === id) flush();
    // 끌어낸 창은 커서가 창 왼쪽 위(윗막대)를 잡은 모양으로 따라온다
    api.stack.tearStart(p.tabId, { x: 24, y: 17 }, { x: e.screenX, y: e.screenY });
    return;
  }
  p.el.classList.add('lifting');
  document.body.classList.add('tab-dragging');
  p.el.style.transform = `translate(${Math.max(-6, Math.min(6, dx))}px, ${dy}px)`;
});
function endTabPress(e, cancelled = false) {
  const p = tabPress;
  if (!p || e.pointerId !== p.pointerId) return;
  tabPress = null;
  p.el.classList.remove('lifting');
  p.el.style.transform = '';
  document.body.classList.remove('tab-dragging');
  if (p.torn) api.stack.tearEnd(e.screenX, e.screenY);
  else if (p.moved && !cancelled && p.tabId !== id) flush().then(() => api.stack.activate(p.tabId));
}
window.addEventListener('pointerup', (e) => endTabPress(e));
window.addEventListener('pointercancel', (e) => endTabPress(e, true));

// 가운데 버튼으로 누르면 빼기 (브라우저 탭처럼), 오른쪽 클릭은 메뉴
tabsEl.addEventListener('auxclick', (e) => {
  const tab = e.target.closest('[data-tab-id]');
  if (tab && e.button === 1) api.stack.remove(tab.dataset.tabId);
});
tabsEl.addEventListener('contextmenu', (e) => {
  const tab = e.target.closest('[data-tab-id]');
  if (!tab) return;
  e.preventDefault();
  api.stack.menu(tab.dataset.tabId);
});
api.on('stack:state', renderStack);
// 다른 메모를 이 창 위로 끌고 와 머물면: 놓으면 탭으로 합쳐진다는 표시
api.on('stack:hover', (on) => {
  $('stack-drop').hidden = !on;
});
// 다른 탭으로 바뀌어 숨겨질 때 바로 저장
document.addEventListener('visibilitychange', () => {
  if (document.hidden && editor) flush();
});

// ---------- 시작 ----------

injectIcons();
paintSwatchBars();
coach = setupCoach(api);
memo = await api.memo.get(id);
if (!memo) {
  setStatus('메모를 찾지 못했어요. 메모 폴더에서 옮겨졌거나 지워졌을 수 있어요.', true);
} else {
  applyMeta(memo);
  applyTop(memo.onTop === true);
  renderStack(memo.stack);
  document.title = memo.title;
  current = saved = memo.body;
  editor = await createNoteEditor(el.editorRoot, {
    markdown: memo.body, onChange, onState: showActive, saveFile, fetchImage, onNotice: setStatus,
    tables: memo.tables ?? [], onTables: saveTables,
    fetchPreview: (url) => api.links.preview(url),
    openLink: (url) => api.links.open(url),
    getTags: () => api.tags.list(),
    onEmpty: showPlaceholder,
  });
  // 편집기가 불러온 뒤 정리한 마크다운을 기준으로 삼는다 (열기만 해도 저장되는 일 방지).
  current = saved = editor.getMarkdown();
  refreshLinks();
  reminderPanel = setupReminderPanel({
    api,
    memoId: id,
    setStatus,
    onToggle: (open) => open && !el.linksPanel.hidden && toggleLinks(false),
  });
  reminderPanel.set(memo.reminders);
  if (memo.alarm) showAlarm(memo.alarm);
  editor.focus();
  if (memo.capture) await applyCapture(memo.capture);
  document.documentElement.dataset.ready = 'true';
}
