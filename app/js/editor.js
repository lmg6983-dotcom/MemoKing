// 서식 편집기 (Milkdown) — 화면에는 서식이 적용된 모습, 저장은 마크다운.
import {
  Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx,
  commonmark, imageSchema, linkSchema, toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand,
  wrapInHeadingCommand, turnIntoTextCommand, wrapInBulletListCommand, wrapInOrderedListCommand,
  wrapInBlockquoteCommand, createCodeBlockCommand, insertHrCommand, liftListItemCommand, htmlSchema,
  gfm, toggleStrikethroughCommand, history, listener, listenerCtx, clipboard, trailing, upload, uploadConfig,
  callCommand, getMarkdown, replaceAll, insert, $view, $prose, $markSchema, $nodeSchema, $remark, Plugin, PluginKey, TextSelection,
  toggleMark, Decoration, DecorationSet, insertTableCommand, tableSchema,
  addRowAfter, addColumnAfter, deleteRow, deleteColumn, deleteTable, isInTable, goToNextCell, columnResizing,
  splitCell, CellSelection, TableMap,
} from '../vendor/milkdown.js';
import { Plyr } from '../vendor/plyr.js';
import plyrSprite from '../vendor/plyr-sprite.js';
import { mediaKindOf, trimTrailingBreaks } from './core/memo-file.js';
import { remarkInlineHtmlMarks, stringifyHandlers, safeColor, DEFAULT_HIGHLIGHT } from './core/html-marks.js';
import { needsLocalCopy, pickImageSource } from './core/remote-images.js';
import { vaultUrl, mediaKind, baseName } from './media.js';
import { CARD_TITLE, remarkLinkCards, loneUrl, pastedLinkTitle, hostOf } from './core/link-preview.js';
import { extOf, fileKind } from './core/file-kinds.js';
import { wrapOrphanRows, cellsToGrid, gridToHtml, parseTsv, CELL_BREAK_HTML } from './core/tables.js';
import { autoFitTable, tableReviewReasons } from './core/table-autofit.js';
import { plainTextOf } from './clipboard-text.js';
import { findTags, unescapeTags, suggestTags, TAG_CHAR } from './core/tags.js';
import { createTableExtras, applyTables, toggleAccent, resetTableSize, isAccent, tableExtrasKey, mergeSelectedCells } from './table-extras.js';

// ---------- 이미지·소리·동영상 표시 ----------
// 모두 마크다운 이미지 문법 ![설명](attachments/파일) 로 저장하고, 확장자로 구분해 보여준다.
// 소리·동영상은 오픈소스 Plyr 플레이어.

const PLYR_I18N = {
  play: '재생', pause: '일시정지', mute: '음소거', unmute: '음소거 해제', settings: '설정', speed: '재생 속도',
  normal: '보통', enterFullscreen: '전체 화면', exitFullscreen: '전체 화면 끝내기', pip: 'PIP', seek: '이동',
  currentTime: '현재 시간', duration: '길이', volume: '음량', played: '재생됨', buffered: '받음', restart: '처음부터',
};

let spriteInjected = false;
function injectPlyrSprite() {
  if (spriteInjected) return;
  spriteInjected = true;
  // 기본값은 아이콘을 인터넷에서 받아오므로, 문서에 직접 심고 iconUrl 을 비워 둔다 (오프라인 동작).
  const holder = document.createElement('div');
  holder.hidden = true;
  holder.innerHTML = plyrSprite;
  document.body.prepend(holder);
}

function playerOptions(kind) {
  return {
    iconUrl: '',
    loadSprite: false,
    blankVideo: '',
    i18n: PLYR_I18N,
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
    settings: ['speed'],
    // 스티커 창은 좁으므로 음량 막대는 빼고 음소거 버튼만 (시간 표시가 줄바꿈되지 않게)
    controls: kind === 'video'
      ? ['play-large', 'play', 'progress', 'current-time', 'mute', 'settings', 'fullscreen']
      : ['play', 'progress', 'current-time', 'duration', 'mute', 'settings'],
    keyboard: { focused: true, global: false },
    tooltips: { controls: true, seek: true },
  };
}

function mediaView(node) {
  const { src, alt, title } = node.attrs;
  const kind = mediaKindOf(src, alt);
  if (kind === 'audio' || kind === 'video') {
    injectPlyrSprite();
    const dom = document.createElement('span');
    dom.className = `mk-media mk-${kind}`;
    dom.contentEditable = 'false';
    if (alt) {
      const label = document.createElement('span');
      label.className = 'mk-media-label';
      label.textContent = alt;
      dom.append(label);
    }
    const el = document.createElement(kind);
    el.preload = 'metadata';
    el.src = vaultUrl(src);
    if (kind === 'video') el.setAttribute('playsinline', '');
    dom.append(el);
    const player = new Plyr(el, playerOptions(kind));
    return {
      dom,
      stopEvent: () => true, // 플레이어 조작이 편집기로 새지 않게
      ignoreMutation: () => true,
      destroy: () => player.destroy(),
    };
  }
  const dom = document.createElement('img');
  dom.className = 'mk-image';
  dom.src = vaultUrl(src);
  dom.alt = alt ?? '';
  if (title) dom.title = title;
  dom.onerror = () => dom.classList.add('broken');
  return { dom };
}

// ---------- 밑줄·글자 색·하이라이트 ----------
// 파일에는 <u>, <span style="color">, <mark> 로 저장된다 (core/html-marks.js).

const markFromTree = (attrs) => ({
  match: () => false, // 아래에서 type 별로 덮어씀
  runner: (state, node, markType) => {
    state.openMark(markType, attrs?.(node));
    state.next(node.children);
    state.closeMark(markType);
  },
});

const underlineMark = $markSchema('mk_underline', () => ({
  parseDOM: [{ tag: 'u' }],
  toDOM: () => ['u', 0],
  parseMarkdown: { ...markFromTree(), match: (node) => node.type === 'mkUnderline' },
  toMarkdown: {
    match: (mark) => mark.type.name === 'mk_underline',
    runner: (state, mark) => {
      state.withMark(mark, 'mkUnderline');
    },
  },
}));

const colorMark = $markSchema('mk_color', () => ({
  attrs: { color: { default: '' } },
  parseDOM: [{ tag: 'span[data-mk-color]', getAttrs: (dom) => ({ color: safeColor(dom.dataset.mkColor) ?? '' }) }],
  toDOM: (mark) => ['span', { 'data-mk-color': mark.attrs.color, style: `color: ${safeColor(mark.attrs.color) ?? 'inherit'}` }, 0],
  parseMarkdown: { ...markFromTree((node) => ({ color: node.color })), match: (node) => node.type === 'mkColor' },
  toMarkdown: {
    match: (mark) => mark.type.name === 'mk_color',
    runner: (state, mark) => {
      state.withMark(mark, 'mkColor', undefined, { color: mark.attrs.color });
    },
  },
}));

const highlightMark = $markSchema('mk_highlight', () => ({
  attrs: { color: { default: DEFAULT_HIGHLIGHT } },
  parseDOM: [{ tag: 'mark', getAttrs: (dom) => ({ color: safeColor(dom.dataset.mkColor) ?? DEFAULT_HIGHLIGHT }) }],
  toDOM: (mark) => ['mark', { 'data-mk-color': mark.attrs.color, style: `background: ${safeColor(mark.attrs.color) ?? DEFAULT_HIGHLIGHT}` }, 0],
  parseMarkdown: { ...markFromTree((node) => ({ color: node.color })), match: (node) => node.type === 'mkHighlight' },
  toMarkdown: {
    match: (mark) => mark.type.name === 'mk_highlight',
    runner: (state, mark) => {
      state.withMark(mark, 'mkHighlight', undefined, { color: mark.attrs.color });
    },
  },
}));

const inlineHtmlMarks = $remark('memoking-inline-html-marks', () => remarkInlineHtmlMarks);

// ---------- 체크리스트 ----------

// 체크리스트 네모를 누르면 체크/해제
function toggleTaskOnClick(view, event) {
  const li = event.target instanceof Element ? event.target.closest('li[data-item-type="task"]') : null;
  if (!li || event.target !== li || event.clientX > li.getBoundingClientRect().left) return false;
  const $pos = view.state.doc.resolve(view.posAtDOM(li, 0));
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'list_item') {
      view.dispatch(view.state.tr.setNodeMarkup($pos.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }));
      event.preventDefault();
      return true;
    }
  }
  return false;
}

// ---------- 링크 미리보기 카드 ----------
// 파일에는 [제목](주소 "미리보기") 한 줄 (core/link-preview.js). 화면에는 사이트·제목·설명·사진 카드.
// 제목·설명·사진은 메인 프로세스가 페이지를 읽어 메모 폴더에 모아 둔 것을 받아 온다.

const linkCardSchema = $nodeSchema('mk_link_card', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { href: { default: '' }, title: { default: '' } },
  parseDOM: [{
    tag: 'div[data-link-card]',
    getAttrs: (dom) => ({ href: dom.dataset.linkCard ?? '', title: dom.dataset.title ?? '' }),
  }],
  toDOM: (node) => ['div', { 'data-link-card': node.attrs.href, 'data-title': node.attrs.title }],
  parseMarkdown: {
    match: (node) => node.type === 'mkLinkCard',
    runner: (state, node, type) => {
      state.addNode(type, { href: node.url ?? '', title: node.title ?? '' });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'mk_link_card',
    runner: (state, node) => {
      const { href, title } = node.attrs;
      state.openNode('paragraph');
      state.addNode('link', [{ type: 'text', value: title || href }], undefined, { url: href, title: CARD_TITLE });
      state.closeNode();
    },
  },
}));
const linkCards = $remark('memoking-link-cards', () => remarkLinkCards);

// 같은 주소의 카드가 여러 번 그려져도 한 번만 묻는다
const previewRequests = new Map();
function requestPreview(fetchPreview, href) {
  if (!fetchPreview) return Promise.resolve(null);
  if (!previewRequests.has(href)) {
    previewRequests.set(href, fetchPreview(href).catch(() => null));
  }
  return previewRequests.get(href);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function linkCardView(node, view, getPos, { fetchPreview, openLink }) {
  const dom = el('div', 'mk-link-card');
  dom.contentEditable = 'false';
  const main = el('div', 'lc-main');
  main.setAttribute('role', 'link');
  const text = el('span', 'lc-text');
  const site = el('span', 'lc-site');
  const icon = el('img', 'lc-icon');
  icon.alt = '';
  icon.onerror = () => icon.remove();
  const siteName = el('span', 'lc-site-name');
  const title = el('span', 'lc-title');
  const desc = el('span', 'lc-desc');
  const thumb = el('img', 'lc-thumb');
  thumb.alt = '';
  thumb.onerror = () => thumb.remove();
  const remove = el('button', 'lc-remove');
  remove.type = 'button';
  remove.title = '카드 지우기';
  remove.setAttribute('aria-label', '카드 지우기');
  remove.innerHTML = '<svg><use href="#i-close"/></svg>';
  site.append(icon, siteName);
  text.append(site, title, desc);
  main.append(text, thumb);
  dom.append(main, remove);

  let current = node;
  let preview = null;

  function render() {
    const { href, title: saved } = current.attrs;
    main.title = `누르면 브라우저로 열려요\n${href}`;
    dom.dataset.state = preview ? (preview.ok ? 'ok' : 'plain') : 'loading';
    siteName.textContent = preview?.site || hostOf(href);
    title.textContent = saved && saved !== href ? saved : preview?.title || href;
    desc.textContent = preview?.description ?? '';
    desc.hidden = !desc.textContent;
    const img = preview?.image ? vaultUrl(preview.image) : preview?.imageUrl ?? '';
    if (img) {
      if (thumb.getAttribute('src') !== img) thumb.src = img;
      if (!thumb.isConnected) main.append(thumb);
    } else thumb.remove();
    const ico = preview?.icon ? vaultUrl(preview.icon) : '';
    if (ico) {
      if (icon.getAttribute('src') !== ico) icon.src = ico;
      if (!icon.isConnected) site.prepend(icon);
    } else icon.remove();
  }

  function load() {
    const href = current.attrs.href;
    requestPreview(fetchPreview, href).then((p) => {
      if (current.attrs.href !== href) return;
      preview = p ?? { ok: false };
      render();
      // 처음 받은 제목을 파일의 링크 글자에도 적어 둔다 (메모 제목·검색·AI 요약에 쓰이게). 실행 취소 기록에는 넣지 않는다.
      const saved = current.attrs.title;
      if (p?.title && (!saved || saved === href) && typeof getPos === 'function') {
        const pos = getPos();
        const at = pos == null ? null : view.state.doc.nodeAt(pos);
        if (at?.type.name === 'mk_link_card' && at.attrs.href === href) {
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...at.attrs, title: p.title }).setMeta('addToHistory', false));
        }
      }
    });
  }

  main.addEventListener('click', (e) => {
    e.preventDefault();
    openLink?.(current.attrs.href);
  });
  remove.addEventListener('click', (e) => {
    e.preventDefault();
    const pos = getPos?.();
    if (pos == null) return;
    view.dispatch(view.state.tr.delete(pos, pos + current.nodeSize));
    view.focus();
  });

  render();
  load();
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      const changed = next.attrs.href !== current.attrs.href;
      current = next;
      if (changed) {
        preview = null;
        load();
      }
      render();
      return true;
    },
    selectNode: () => dom.classList.add('selected'),
    deselectNode: () => dom.classList.remove('selected'),
    stopEvent: (e) => ['mousedown', 'click', 'dblclick', 'pointerdown'].includes(e.type),
    ignoreMutation: () => true,
  };
}

// ---------- 태그 (#태그) ----------
// 태그는 글자 그대로 두고(고치기·지우기가 자연스럽게) 화면에서만 알약 모양으로 칠한다.
// 코드·링크 글자 안의 # 는 태그가 아니다.

function tagRanges(doc) {
  const ranges = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    if (block.type.spec.code) return false;
    let text = '';
    block.forEach((child) => {
      if (child.isText) {
        const skip = child.marks.some((m) => m.type.spec.code || m.type.name === 'link');
        text += skip ? 'x'.repeat(child.text.length) : child.text;
      } else text += ' '.repeat(child.nodeSize); // 사진·줄바꿈 등은 띄어쓰기처럼
    });
    for (const t of findTags(text)) ranges.push({ from: pos + 1 + t.index, to: pos + 1 + t.index + t.length, name: t.name });
    return false;
  });
  return ranges;
}

const tagHighlightKey = new PluginKey('memoking-tags');
const tagHighlight = $prose(() => new Plugin({
  key: tagHighlightKey,
  state: {
    init: (_config, state) => buildTagDecorations(state.doc),
    apply: (tr, old) => (tr.docChanged ? buildTagDecorations(tr.doc) : old),
  },
  props: { decorations: (state) => tagHighlightKey.getState(state) },
}));

function buildTagDecorations(doc) {
  return DecorationSet.create(doc, tagRanges(doc).map((r) => Decoration.inline(r.from, r.to, { class: 'mk-tag', 'data-tag': r.name })));
}

// # 자동완성: 커서 바로 앞이 "#글자" 이면 지금까지 쓴 태그를 권한다.
// ↑↓ 고르기, Enter·Tab 넣기, Esc 닫기. 한글 입력 중(조합 중)에는 Enter 를 가로채지 않는다.
const TAG_BEFORE_CURSOR = new RegExp(`(^|[\\s(\\[{,;:!?'"“‘>])#(${TAG_CHAR}*)$`, 'u');

function createTagSuggest(getTags) {
  let tags = null; // # 를 새로 칠 때마다 받아 온다 (다른 메모에서 새 태그가 생겼을 수 있음)
  let fetchedFor = null;
  let loading = null;
  let active = null; // { from, to, prefix, items, index }
  let dismissedAt = null; // Esc 로 닫은 # 의 위치 (커서가 떠날 때까지 다시 열지 않음)
  let view = null;

  const box = document.createElement('div');
  box.className = 'tag-suggest';
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', '태그 자동완성');
  box.hidden = true;
  box.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 초점 유지
  box.addEventListener('click', (e) => {
    const item = e.target.closest('[data-index]');
    if (item && active) choose(Number(item.dataset.index));
  });

  function hide() {
    active = null;
    box.hidden = true;
  }

  function render() {
    box.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tag-suggest-head';
    head.textContent = active.prefix ? `"${active.prefix}" 로 시작하는 태그` : '지금까지 쓴 태그';
    box.append(head);
    active.items.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'tag-suggest-item';
      row.dataset.index = String(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === active.index));
      const name = document.createElement('span');
      name.textContent = `#${t.name}`;
      const count = document.createElement('small');
      count.textContent = `${t.count}`;
      row.append(name, count);
      box.append(row);
    });
    if (!box.isConnected) document.body.append(box);
    box.hidden = false;
    const at = view.coordsAtPos(active.from);
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.max(6, Math.min(at.left, window.innerWidth - width - 6));
    const top = at.bottom + 4 + height > window.innerHeight - 4 ? at.top - height - 4 : at.bottom + 4;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(4, top)}px`;
  }

  function choose(index) {
    const t = active?.items[index];
    if (!t || !view) return;
    const { from, to } = active;
    hide();
    const after = view.state.doc.textBetween(to, Math.min(to + 1, view.state.doc.content.size), '\n', ' ');
    const text = `#${t.name}${after === ' ' ? '' : ' '}`;
    view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
    view.focus();
  }

  function update(v) {
    view = v;
    const { selection } = v.state;
    const $from = selection.$from;
    if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.spec.code
      || $from.marks().some((m) => m.type.spec.code || m.type.name === 'link')) return hide();
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 60), $from.parentOffset, undefined, ' ');
    const m = TAG_BEFORE_CURSOR.exec(before);
    if (!m) {
      dismissedAt = null;
      return hide();
    }
    const prefix = m[2];
    const from = $from.pos - prefix.length - 1;
    if (dismissedAt === from) return hide();
    if (fetchedFor !== from && !loading) {
      tags = null;
      fetchedFor = from;
    }
    if (!tags) {
      loading ??= Promise.resolve(getTags?.()).then((list) => {
        tags = list ?? [];
        loading = null;
        if (view) update(view);
      }).catch(() => {
        tags = [];
        loading = null;
      });
      return;
    }
    const items = suggestTags(tags, prefix);
    if (!items.length) return hide();
    const index = active && active.from === from ? Math.min(active.index, items.length - 1) : 0;
    active = { from, to: $from.pos, prefix, items, index };
    render();
  }

  function handleKeyDown(v, event) {
    if (!active || box.hidden || event.isComposing || event.keyCode === 229) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const n = active.items.length;
      active.index = (active.index + (event.key === 'ArrowDown' ? 1 : n - 1)) % n;
      render();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      choose(active.index);
      return true;
    }
    if (event.key === 'Escape') {
      dismissedAt = active.from;
      hide();
      return true;
    }
    return false;
  }

  return { update, handleKeyDown, hide, destroy: () => box.remove() };
}

// 링크 표시: 첨부 파일이면 파일 칩(종류·확장자), 인터넷 주소면 "누르면 열려요" 안내
function linkDomAttrs(href) {
  if (/^https?:/i.test(href)) return { title: `누르면 브라우저로 열려요\n${href}` };
  if (!href.startsWith('attachments/')) return {};
  const ext = extOf(href);
  return {
    'data-file': fileKind(href),
    'data-ext': ext ? ext.toUpperCase() : '',
  };
}

// ---------- 표: 엑셀·구글 시트에서 붙여넣기 ----------
// 스타일·열 너비는 빼고, 첫 행은 머리글, 병합된 셀은 풀고, 셀 안은 글자·굵게·기울임·링크만 남긴다.

const CELL_INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'S', 'DEL', 'STRIKE', 'U', 'A', 'BR', 'CODE', 'MARK', 'SPAN']);

function cellInlineHtml(cell, boldClasses) {
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      out.push(node.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT') return;
    // 셀 안의 의도적인 줄바꿈(엑셀 Alt+Enter·시트의 줄바꿈)은 <br> 로 지킨다
    if (tag === 'BR' || (tag === 'SPAN' && node.dataset.type === 'html' && isBreakHtml(node.dataset.value))) return out.push(CELL_BREAK_HTML);
    const block = /^(P|DIV|LI|H[1-6])$/.test(tag);
    if (block && out.length) out.push(' ');
    const keep = CELL_INLINE.has(tag) && tag !== 'SPAN' && tag !== 'BR';
    const style = node.getAttribute('style') ?? '';
    const bold = !keep && (/font-weight:\s*(bold|[6-9]00)/i.test(style) || [...node.classList].some((c) => boldClasses.has(c)));
    const italic = !keep && /font-style:\s*italic/i.test(style);
    if (keep) out.push(tag === 'A' && /^https?:/i.test(node.getAttribute('href') ?? '') ? `<a href="${node.getAttribute('href').replace(/"/g, '&quot;')}">` : `<${tag.toLowerCase()}>`);
    if (bold) out.push('<b>');
    if (italic) out.push('<i>');
    node.childNodes.forEach(walk);
    if (italic) out.push('</i>');
    if (bold) out.push('</b>');
    if (keep) out.push(`</${tag.toLowerCase()}>`);
  };
  // 칸 자체의 굵게·기울임(구글 시트는 <td style="font-weight:bold">, 엑셀은 class)
  const style = cell.getAttribute('style') ?? '';
  const bold = /font-weight:\s*(bold|[6-9]00)/i.test(style) || [...cell.classList].some((c) => boldClasses.has(c)) || cell.tagName === 'TH';
  const italic = /font-style:\s*italic/i.test(style);
  cell.childNodes.forEach(walk);
  let html = out.join('').replace(/\s+/g, ' ').trim()
    .replace(/(?:\s*<span data-type="html" data-value="&lt;br&gt;"><\/span>\s*)+$/, '') // 끝의 빈 줄바꿈은 뺀다
    .replace(/^(?:\s*<span data-type="html" data-value="&lt;br&gt;"><\/span>\s*)+/, '');
  if (!html) return '';
  // 머리글은 원래 굵게 보이므로 굵게를 따로 두지 않는다 (첫 줄)
  if (italic) html = `<i>${html}</i>`;
  return { html, bold };
}

// 표 하나의 열 너비·정렬을 내용에 맞춘다 (병합한 칸은 첫 칸의 열에 내용이 있는 것으로 본다)
function fitTable(tr, node, pos, { available, measure }) {
  const map = TableMap.get(node);
  const grid = Array.from({ length: map.height }, () => Array(map.width).fill(''));
  const seen = new Set();
  for (const rel of map.map) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const r = map.findCell(rel);
    grid[r.top][r.left] = (node.nodeAt(rel)?.attrs.colspan ?? 1) > 1 ? '' : cellText(node.nodeAt(rel));
  }
  const fit = autoFitTable(grid, { available, measure });
  for (const rel of seen) {
    const cell = node.nodeAt(rel);
    const r = map.findCell(rel);
    tr.setNodeMarkup(tr.mapping.map(pos + 1 + rel), null, { ...cell.attrs, colwidth: fit.widths.slice(r.left, r.right), alignment: fit.align[r.left] });
  }
  return fit;
}

// 칸 안의 문단이 여럿이면(칸을 합친 뒤) 한 문단으로 — 마크다운 표 칸은 한 줄이라 문단 사이는 <br>
function oneLineCell(cell) {
  if (cell.childCount <= 1) return cell.content;
  const schema = cell.type.schema;
  const br = schema.nodes.html.create({ value: '<br>' });
  const inline = [];
  cell.forEach((block, _o, i) => {
    if (i > 0 && block.content.size) inline.push(br);
    block.content.forEach((n) => inline.push(n));
  });
  return schema.nodes.paragraph.create(null, inline);
}

// 병합한 칸이 있는 표 → 병합을 푼 표 (마크다운으로 쓰기 위해). 병합·여러 문단 칸이 없으면 그대로.
function unmergedTable(node) {
  const map = TableMap.get(node);
  let merged = false;
  node.descendants((n) => {
    if ((n.attrs.colspan ?? 1) > 1 || (n.attrs.rowspan ?? 1) > 1 || (/^table_(cell|header)$/.test(n.type.name) && n.childCount > 1)) merged = true;
    return !merged;
  });
  if (!merged) return node;
  const rows = [];
  for (let r = 0; r < map.height; r++) {
    const rowNode = node.child(r);
    const cells = [];
    for (let c = 0; c < map.width; c++) {
      const rel = map.map[r * map.width + c];
      const cell = node.nodeAt(rel);
      const at = map.findCell(rel);
      const cellType = rowNode.firstChild?.type ?? cell.type;
      if (at.top === r && at.left === c) cells.push(cellType.create({ ...cell.attrs, colspan: 1, rowspan: 1, colwidth: null }, oneLineCell(cell)));
      else cells.push(cellType.createAndFill({ ...cell.attrs, colspan: 1, rowspan: 1, colwidth: null }));
    }
    rows.push(rowNode.type.create(rowNode.attrs, cells));
  }
  return node.type.create(node.attrs, rows);
}

const isBreakHtml = (value) => /^<br\s*\/?>$/i.test(String(value ?? '').trim());

// 표 칸의 글 (칸 안 줄바꿈·문단은 "\n")
function cellText(cell) {
  const lines = [];
  cell.forEach((block) => {
    let line = '';
    block.descendants((n) => {
      if (n.isText) line += n.text;
      else if (n.type.name === 'hardbreak' || n.type.name === 'hard_break' || (n.type.name === 'html' && isBreakHtml(n.attrs.value))) line += '\n';
      return true;
    });
    lines.push(line);
  });
  return lines.join('\n');
}

// 표가 쓸 수 있는 본문 폭 (편집 영역 안쪽 여백·표 테두리·여유 몇 px 를 뺀다)
function tableBodyWidth(view) {
  const cs = getComputedStyle(view.dom);
  return Math.max(200, Math.floor(view.dom.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 4));
}

// 표 칸 글자 너비 재기 (편집기 글꼴, 표는 본문의 0.95배, 머리글은 굵게)
function tableMeasure(view) {
  const cs = getComputedStyle(view.dom);
  const size = parseFloat(cs.fontSize) * 0.95;
  const ctx = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return (text, bold) => {
    const key = `${bold ? 1 : 0}${text}`;
    if (!cache.has(key)) {
      ctx.font = `${bold ? 700 : 400} ${size}px ${cs.fontFamily}`;
      cache.set(key, Math.ceil(ctx.measureText(text).width));
    }
    return cache.get(key);
  };
}

// 붙여넣은 표마다 따로 살펴볼 이유(병합된 칸·표 안의 표·그림·수식) — 붙인 뒤 열 너비를 자동으로 맞출 때 쓴다
let pastedTableReviews = [];
let pastedTablesAt = 0; // 표가 든 내용을 붙여넣은 시각 (Milkdown 붙여넣기는 "paste" 표시 없이 문서를 바꾸므로 이것으로 안다)

function normalizePastedTables(html) {
  pastedTableReviews = [];
  if (!/<t[rdh][\s>]/i.test(html)) return html;
  const doc = new window.DOMParser().parseFromString(wrapOrphanRows(html), 'text/html');
  // 엑셀은 굵게를 <style> 의 class(.xl65 { font-weight:700 })로 준다
  const boldClasses = new Set();
  for (const st of doc.querySelectorAll('style')) {
    for (const m of st.textContent.matchAll(/\.([\w-]+)\s*\{[^}]*font-weight:\s*(?:700|bold)/gi)) boldClasses.add(m[1]);
  }
  let changed = false;
  for (const table of [...doc.querySelectorAll('table')]) {
    if (table.parentElement?.closest('table')) continue; // 표 안의 표는 바깥 표에서 글자로
    const review = tableReviewReasons(table);
    const rows = [...table.rows].map((tr) => [...tr.cells].map((cell) => {
      const inner = cellInlineHtml(cell, boldClasses);
      return {
        html: inner ? (inner.bold ? `<b>${inner.html}</b>` : inner.html) : '',
        colspan: cell.colSpan,
        rowspan: cell.rowSpan,
      };
    }));
    const grid = cellsToGrid(rows);
    if (grid.length === 1 && grid[0].length === 1) {
      // 셀 하나만 복사 → 표가 아니라 글자로
      const p = doc.createElement('p');
      p.innerHTML = grid[0][0].replace(/^<b>([\s\S]*)<\/b>$/, '$1');
      table.replaceWith(p);
      changed = true;
      continue;
    }
    if (!grid.length || !grid[0].length) {
      table.remove();
      changed = true;
      continue;
    }
    pastedTableReviews.push(review);
    const clean = gridToHtml(grid.map((row, r) => (r === 0 ? row.map((v) => v.replace(/^<b>([\s\S]*)<\/b>$/, '$1')) : row)), { cellHtml: true });
    const holder = doc.createElement('div');
    holder.innerHTML = clean;
    table.replaceWith(...holder.childNodes);
    changed = true;
  }
  if (pastedTableReviews.length) pastedTablesAt = Date.now();
  if (!changed) return html;
  doc.querySelectorAll('style, colgroup, col, meta, google-sheets-html-origin > style').forEach((n) => n.remove());
  return doc.body.innerHTML;
}

// ---------- 편집기 만들기 ----------

/**
 * @param {HTMLElement} root
 * @param {{ markdown: string, onChange: (md: string) => void, onState?: (active: object) => void,
 *           saveFile: (file: File) => Promise<string>,
 *           fetchImage?: (src: string) => Promise<string>, onNotice?: (text: string, isError?: boolean) => void,
 *           fetchPreview?: (url: string) => Promise<object|null>, openLink?: (url: string) => void,
 *           getTags?: () => Promise<{ name: string, count: number }[]> }} options
 *   fetchImage: 인터넷·data: 사진을 메모 폴더에 저장하고 "attachments/..." 를 돌려준다
 *   fetchPreview: 링크 카드에 보여줄 제목·설명·사진 (메인 프로세스가 메모 폴더에 모아 둔 것)
 */
// readOnly: 고칠 수 없이 보여 주기만 (PDF 만들기)
export async function createNoteEditor(root, { markdown, onChange, onState, onEmpty, saveFile, fetchImage, onNotice, fetchPreview, openLink, getTags, tables = [], onTables, readOnly = false }) {
  let ready = false;
  let editor = null;
  const view = () => editor.ctx.get(editorViewCtx);

  // 넣은 파일은 각자 한 줄(문단)을 차지한다.
  // 빈 줄이면 그 줄을 바꾸고, 글이 있는 줄이면 그 줄 바로 아래에 넣는다.
  // item: { kind: 'image'|'audio'|'video', src, alt } 또는 { kind: 'file', src, name } (파일 칩 = 링크)
  function insertBlocks(pos, items) {
    const v = view();
    const { schema } = v.state;
    const paragraphs = items.map((item) => {
      if (item.kind === 'file') {
        return schema.nodes.paragraph.create(null, schema.text(item.name, [schema.marks.link.create({ href: item.src })]));
      }
      return schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: item.src, alt: item.alt, title: '' }));
    });
    const $pos = v.state.doc.resolve(Math.min(pos, v.state.doc.content.size));
    const size = paragraphs.reduce((sum, p) => sum + p.nodeSize, 0);
    let tr = v.state.tr;
    let end;
    if ($pos.depth > 0 && $pos.parent.isTextblock && $pos.parent.content.size === 0) {
      tr = tr.replaceWith($pos.before(), $pos.after(), paragraphs);
      end = $pos.before() + size;
    } else if ($pos.depth > 0 && $pos.parent.isTextblock) {
      tr = tr.insert($pos.after(), paragraphs);
      end = $pos.after() + size;
    } else {
      tr = tr.insert($pos.pos, paragraphs);
      end = $pos.pos + size;
    }
    // 넣은 뒤 바로 이어서 쓸 수 있게 커서를 다음 줄로
    if (end >= tr.doc.content.size) tr = tr.insert(end, schema.nodes.paragraph.create());
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end + 1, tr.doc.content.size))));
    v.dispatch(tr.scrollIntoView());
    v.focus();
  }

  async function filesToItems(files) {
    const items = [];
    for (const file of files) {
      const kind = mediaKind(file);
      const src = await saveFile(file);
      if (kind === 'file') items.push({ kind, src, name: file.name });
      else items.push({ kind, src, alt: kind === 'video' ? `동영상 ${baseName(file.name)}` : baseName(file.name) });
    }
    return items;
  }

  // ---------- 붙여넣은 인터넷 사진을 메모 폴더로 ----------
  // 글과 함께 붙여넣은 사진은 먼저 인터넷 주소로 들어오고, 받아지는 대로 attachments/ 파일로 바뀐다.
  // 받지 못한 사진은 주소를 그대로 둔다. 주소 교체는 실행 취소 기록에 넣지 않는다 (Ctrl+Z 한 번에 붙여넣기 전체 취소).

  const imageSources = (doc) => {
    const srcs = new Set();
    doc.descendants((node) => {
      if (node.type.name === 'image') srcs.add(node.attrs.src);
    });
    return srcs;
  };

  async function localizeImages(srcs) {
    if (!srcs.length || !fetchImage) return;
    onNotice?.(`사진 ${srcs.length}개를 메모 폴더에 받고 있어요`);
    const results = await Promise.all(srcs.map((src) => fetchImage(src).then(
      (rel) => [src, rel],
      (err) => {
        console.warn('사진을 받지 못했습니다', src.slice(0, 120), err?.message);
        return [src, null];
      },
    )));
    const saved = new Map(results.filter(([, rel]) => rel));
    if (saved.size && editor) {
      const v = view();
      let tr = v.state.tr;
      v.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'image' || !saved.has(node.attrs.src)) return;
        // 브라우저가 설명(alt)을 제목(title)에도 복사해 넣으므로 같으면 비운다
        const title = node.attrs.title === node.attrs.alt ? '' : node.attrs.title;
        tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: saved.get(node.attrs.src), title });
      });
      v.dispatch(tr.setMeta('addToHistory', false));
    }
    const failed = srcs.length - saved.size;
    onNotice?.(failed
      ? `사진 ${saved.size}개를 저장했어요 · ${failed}개는 받지 못해서 인터넷 주소로 두었어요`
      : `사진 ${saved.size}개를 메모 폴더에 저장했어요`, failed > 0);
  }

  // 웹페이지의 지연 로딩 사진: src 는 빈 자리표시, 진짜 주소는 data-src·srcset 에 있다
  function revealLazyImages(html) {
    if (!/<img/i.test(html)) return html;
    const doc = new window.DOMParser().parseFromString(html, 'text/html');
    for (const img of doc.querySelectorAll('img')) {
      const attrs = Object.fromEntries([...img.attributes].map((a) => [a.name, a.value]));
      const src = pickImageSource(attrs);
      if (src) img.setAttribute('src', src);
      img.removeAttribute('srcset');
    }
    return doc.body.innerHTML;
  }

  // 붙여넣기 판단 (클립보드·업로드 플러그인보다 먼저)
  //   파일만                         → 첨부로 저장 (화면 캡처, 탐색기에서 복사한 파일)
  //   파일 + 그림뿐인 HTML           → 첨부로 저장 (브라우저 "이미지 복사")
  //   파일 + 글이 있는 HTML          → 글을 붙이고 파일은 버림 (워드·엑셀이 함께 넣는 "글을 찍은 그림")
  //   글·HTML 만                     → Milkdown 클립보드 플러그인이 붙이고, 들어온 인터넷 사진은 받아 둔다
  //
  // 새로 들어온 사진 찾기: 붙여넣기·놓기 순간의 사진 목록을 찍어 두고, 반영된 직후 현재 문서와 비교한다.
  // (Milkdown 이 붙여넣기를 반영하는 경로에서는 플러그인 뷰의 update 가 불리지 않는 경우가 있어 시간차로 확인)
  const localizing = new Set();
  let pendingChecks = 0;
  function watchForNewImages(v) {
    const before = imageSources(v.state.doc);
    pendingChecks += 2;
    const check = () => {
      pendingChecks--;
      if (!editor) return;
      const added = [...imageSources(view().state.doc)]
        .filter((src) => !before.has(src) && !localizing.has(src) && needsLocalCopy(src));
      if (!added.length) return;
      added.forEach((src) => localizing.add(src));
      localizeImages(added).finally(() => added.forEach((src) => localizing.delete(src)));
    };
    setTimeout(check, 0);
    setTimeout(check, 500); // 늦게 반영되는 경우 대비 (같은 사진은 두 번 받지 않음)
  }

  // 주소 하나만 붙여넣기: 빈 줄이면 링크 카드, 글 가운데면 링크, 글자를 골라 두었으면 그 글자에 링크를 건다
  // title: 엣지처럼 링크를 페이지 제목과 함께 복사한 경우의 제목 ('' 이면 주소 그대로)
  function pasteUrl(v, url, title = '') {
    const { schema, selection } = v.state;
    const { $from, from, to, empty } = selection;
    const link = schema.marks.link;
    if (!empty && $from.parent.isTextblock && $from.sameParent(selection.$to)) {
      v.dispatch(v.state.tr.addMark(from, to, link.create({ href: url })).scrollIntoView());
      return;
    }
    const card = schema.nodes.mk_link_card;
    const parent = $from.parent;
    if (card && parent.type.name === 'paragraph' && parent.content.size === 0 && $from.depth > 0) {
      const container = $from.node($from.depth - 1);
      const index = $from.index($from.depth - 1);
      if (container.canReplaceWith(index, index + 1, card)) {
        const node = card.create({ href: url, title });
        let tr = v.state.tr.replaceWith($from.before(), $from.after(), node);
        const after = $from.before() + node.nodeSize;
        // 이어서 쓸 수 있게 카드 아래 빈 줄로 커서를 옮긴다
        if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr = tr.insert(after, schema.nodes.paragraph.create());
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
        v.dispatch(tr.scrollIntoView());
        return;
      }
    }
    let tr = v.state.tr.replaceSelectionWith(schema.text(title || url, [link.create({ href: url })]), false);
    tr = tr.removeStoredMark(link); // 이어서 치는 글자는 링크가 아니게
    v.dispatch(tr.scrollIntoView());
  }

  const pastePlugin = $prose(() => new Plugin({
    key: new PluginKey('memoking-paste'),
    props: {
      // 복사·끌기: 서식 없는 곳에 붙일 "일반 글자"는 마크다운(\ 이스케이프가 섞임)이 아니라 읽는 글로 (Milkdown 클립보드보다 먼저)
      clipboardTextSerializer: (slice) => plainTextOf(slice.content),
      transformPastedHTML: (html) => revealLazyImages(normalizePastedTables(html)),
      handlePaste(v, event) {
        const data = event.clipboardData;
        const files = data ? Array.from(data.files) : [];
        const html = data?.getData('text/html') ?? '';
        // 엑셀·시트의 글자만 복사(HTML 없음)된 경우: 탭으로 나뉜 글 → 표
        if (!files.length && !html && !v.state.selection.$from.parent.type.spec.code && !isInTable(v.state)) {
          const grid = parseTsv(data?.getData('text/plain'));
          if (grid?.length) {
            event.preventDefault();
            v.pasteHTML(gridToHtml(grid));
            return true;
          }
        }
        const url = files.length ? null : loneUrl(data?.getData('text/plain'));
        const linkTitle = url ? pastedLinkTitle(html, url) : null;
        if (url && linkTitle !== null && !v.state.selection.$from.parent.type.spec.code) {
          event.preventDefault();
          pasteUrl(v, url, linkTitle);
          return true;
        }
        const htmlHasText = Boolean(html) && Boolean(new window.DOMParser().parseFromString(html, 'text/html').body.textContent.trim());
        if (!files.length || htmlHasText) return false;
        event.preventDefault();
        const pos = v.state.selection.from;
        filesToItems(files)
          .then((items) => items.length && insertBlocks(pos, items))
          .catch((err) => console.error('붙여넣은 파일을 넣지 못했습니다', err));
        return true;
      },
      // DOM 이벤트 단계는 어떤 플러그인의 handlePaste·handleDrop 보다 먼저 불린다 (붙여넣기 전 상태를 찍을 수 있음).
      handleDOMEvents: {
        paste: (v) => {
          watchForNewImages(v);
          return false;
        },
        drop: (v) => {
          watchForNewImages(v); // 웹페이지에서 글·사진을 끌어다 놓은 경우
          return false;
        },
      },
    },
  }));

  // 표 안 Tab: 다음 셀로, 마지막 셀이면 행을 더해 그 첫 셀로 (Shift+Tab 은 Milkdown 표 기능이 이전 셀로)
  // 표 안 Shift+Enter: 칸 안에서 줄바꿈 (마크다운에는 <br>)
  const tableTab = $prose(() => new Plugin({
    key: new PluginKey('memoking-table-tab'),
    props: {
      handleKeyDown(v, event) {
        if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && isInTable(v.state)) {
          const type = v.state.schema.nodes.html;
          if (!type) return false;
          v.dispatch(v.state.tr.replaceSelectionWith(type.create({ value: '<br>' })).scrollIntoView());
          return true;
        }
        if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || !isInTable(v.state)) return false;
        if (goToNextCell(1)(v.state, v.dispatch)) return true;
        if (addRowAfter(v.state, v.dispatch)) goToNextCell(1)(v.state, v.dispatch);
        return true;
      },
    },
  }));

  // 표 열 너비·행 높이·머리글 강조 (메모 머리말에 저장)
  let currentTables = tables;
  const extras = createTableExtras({
    readOnly,
    onChange: (next) => {
      currentTables = next;
      onTables?.(next);
    },
  });
  const tableExtras = $prose(() => extras.plugin);
  // 열 너비: 칸 오른쪽 테두리를 끌기 (prosemirror-tables — Milkdown gfm 묶음에는 빠져 있어 따로 켠다)
  const tableResize = $prose(() => columnResizing({ cellMinWidth: 24 }));

  // 붙여넣은 표(엑셀·구글 시트 등): 내용·본문 폭에 맞춰 열 너비·정렬을 자동으로 (core/table-autofit.js)
  // 병합된 칸·표 안의 표·그림·수식이 있던 표는 자동으로 맞추지 않고 확인해 달라고 알린다.
  let fitView = null;
  const tableAutoFit = $prose(() => new Plugin({
    key: new PluginKey('memoking-table-autofit'),
    view: (v) => {
      fitView = v;
      return { destroy: () => (fitView = null) };
    },
    appendTransaction(trs, _old, state) {
      if (readOnly || !fitView || !pastedTablesAt || Date.now() - pastedTablesAt > 3000) return null;
      if (!trs.some((tr) => tr.docChanged)) return null;
      // 바뀐 범위 (모든 트랜잭션 뒤 문서 기준)
      let from = Infinity;
      let to = -Infinity;
      trs.forEach((tr, t) => tr.mapping.maps.forEach((map, i) => map.forEach((_a, _b, start, end) => {
        let a = tr.mapping.slice(i + 1).map(start, -1);
        let b = tr.mapping.slice(i + 1).map(end, 1);
        for (const later of trs.slice(t + 1)) {
          a = later.mapping.map(a, -1);
          b = later.mapping.map(b, 1);
        }
        from = Math.min(from, a);
        to = Math.max(to, b);
      })));
      if (!(to > from)) return null;
      // 그 범위 안의, 아직 너비가 없는 표 = 방금 붙여넣은 표
      const tables = [];
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== 'table') return true;
        if (!node.firstChild?.firstChild?.attrs.colwidth) tables.push({ node, pos });
        return false;
      });
      if (!tables.length) return null;
      const reviews = pastedTableReviews;
      pastedTableReviews = [];
      pastedTablesAt = 0;
      const tr = state.tr;
      const measure = tableMeasure(fitView);
      const available = tableBodyWidth(fitView);
      let fitted = 0;
      const skipped = new Set();
      tables.forEach(({ node, pos }, i) => {
        const reasons = reviews[i] ?? [];
        if (reasons.length) {
          reasons.forEach((r) => skipped.add(r));
          return;
        }
        fitTable(tr, node, pos, { available, measure });
        fitted++;
      });
      if (skipped.size) onNotice?.(`붙여넣은 표에 ${[...skipped].join('·')}이 있어 열 너비를 자동으로 맞추지 않았어요. 표를 확인해 주세요`);
      else if (fitted) onNotice?.('붙여넣은 표의 열 너비·정렬을 내용에 맞춰 정리했어요');
      return tr.docChanged ? tr : null;
    },
  }));

  const media = $view(imageSchema.node, () => (node) => mediaView(node));
  const cardView = $view(linkCardSchema.node, () => (node, v, getPos) => linkCardView(node, v, getPos, { fetchPreview, openLink }));
  const taskToggle = $prose(() => new Plugin({
    key: new PluginKey('memoking-task-toggle'),
    props: { handleDOMEvents: { mousedown: toggleTaskOnClick } },
  }));
  const suggest = createTagSuggest(getTags);
  const tagSuggest = $prose(() => new Plugin({
    key: new PluginKey('memoking-tag-suggest'),
    props: { handleKeyDown: (v, event) => suggest.handleKeyDown(v, event) },
    view: (v) => {
      suggest.update(v);
      return { update: (next) => suggest.update(next), destroy: () => suggest.destroy() };
    },
  }));
  const stateWatcher = $prose(() => new Plugin({
    key: new PluginKey('memoking-state'),
    // 내용이 바뀌는 즉시(글자 하나) 알린다 — 저장용 마크다운은 조금 늦게 갱신되므로 안내 문구는 이것을 따른다
    view: (v) => {
      onEmpty?.(isEmptyDoc(v.state.doc));
      return {
        update: (view, prev) => {
          onState?.(activeFormats(view.state));
          if (!prev.doc.eq(view.state.doc)) onEmpty?.(isEmptyDoc(view.state.doc));
        },
      };
    },
  }));

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      // 목록 기호는 "-" (Obsidian·GitHub 와 같은 관례), 밑줄·색·하이라이트는 HTML 태그로 저장
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: '-',
        handlers: { ...prev.handlers, ...stringifyHandlers },
      }));
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: { class: 'mk-doc', spellcheck: 'false', 'aria-label': '메모 내용' },
        editable: () => !readOnly,
      }));
      // Milkdown 7.22.2 버그 우회: 제목 없는 이미지 ![a](b) 의 title 을 null 로 넘겨 불러오기가 실패한다.
      // 마크다운 표는 머리글 행만 있어도 된다 (Milkdown 기본은 "머리글 행 + 행 1개 이상")
      ctx.update(tableSchema.key, (factory) => (c) => {
        const schema = factory(c);
        return {
          ...schema,
          content: 'table_header_row table_row*',
          // 마크다운 표에는 병합이 없다 → 병합을 푼 표(내용은 첫 칸, 나머지는 빈 칸)로 쓴다. 병합은 머리말(tables)에
          toMarkdown: { ...schema.toMarkdown, runner: (state, node) => schema.toMarkdown.runner(state, unmergedTable(node)) },
        };
      });
      // 표 칸 안의 줄바꿈은 마크다운에 <br> (html 노드)로 저장된다 → 글자 "<br>" 대신 실제 줄바꿈으로 보이게
      ctx.update(htmlSchema.key, (factory) => (c) => {
        const schema = factory(c);
        return {
          ...schema,
          toDOM: (node) => (isBreakHtml(node.attrs.value) ? ['br', { 'data-type': 'html', 'data-value': node.attrs.value }] : schema.toDOM(node)),
          parseDOM: [{ tag: 'br[data-type="html"]', getAttrs: (dom) => ({ value: dom.dataset.value || '<br>' }) }, ...(schema.parseDOM ?? [])],
        };
      });
      ctx.update(imageSchema.key, (factory) => (c) => {
        const schema = factory(c);
        return {
          ...schema,
          parseMarkdown: {
            ...schema.parseMarkdown,
            runner: (state, node, type) => {
              state.addNode(type, { src: node.url ?? '', alt: node.alt ?? '', title: node.title ?? '' });
            },
          },
        };
      });
      // 링크: 첨부 파일은 파일 칩(종류·확장자 표시), 인터넷 주소는 누르면 열린다는 안내
      ctx.update(linkSchema.key, (factory) => (c) => {
        const schema = factory(c);
        return {
          ...schema,
          toDOM: (mark) => {
            const [tag, attrs] = schema.toDOM(mark);
            return [tag, { ...attrs, ...linkDomAttrs(String(mark.attrs.href ?? '')) }];
          },
        };
      });
      ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
        if (ready) onChange(unescapeTags(trimTrailingBreaks(md)));
      });
      // 끌어다 놓거나 붙여넣은 파일을 첨부 폴더에 저장하고 그 자리에 넣는다.
      ctx.update(uploadConfig.key, (prev) => ({
        ...prev,
        enableHtmlFileUploader: false,
        uploader: async (files, _schema, _ctx, insertPos) => {
          const items = await filesToItems(Array.from(files));
          if (items.length) insertBlocks(insertPos, items);
          return []; // 직접 넣었으므로 플러그인이 넣을 것은 없다
        },
      }));
    })
    .use(commonmark)
    .use(gfm)
    .use(tableTab)
    .use(tableAutoFit)
    .use(tableResize) // 읽기 전용(PDF)에서도 열 너비가 보이게 (끌기는 편집할 때만)
    .use(tableExtras)
    .use(tagSuggest) // 자동완성 목록이 떠 있을 때 Enter·↑↓ 를 먼저 받는다
    .use(pastePlugin) // 클립보드·업로드 플러그인보다 먼저 판단
    .use(inlineHtmlMarks)
    .use(linkCards)
    .use(linkCardSchema)
    .use(underlineMark)
    .use(colorMark)
    .use(highlightMark)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(trailing)
    .use(upload)
    .use(media)
    .use(cardView)
    .use(taskToggle)
    .use(tagHighlight)
    .use(stateWatcher)
    .create();

  ready = true;
  applyTables(view(), tables);
  extras.setLoading(false);
  const call = (command, payload) => editor.action(callCommand(command.key, payload));

  // 셀 병합: 여러 칸을 골랐으면 합치고, 병합한 칸 안이면 풀기
  function mergeOrSplit(v) {
    if (v.state.selection instanceof CellSelection && v.state.selection.ranges.length > 1) {
      const result = mergeSelectedCells(v.state, v.dispatch);
      if (result !== true) onNotice?.(result, true);
      return;
    }
    if (!splitCell(v.state, v.dispatch)) onNotice?.('합칠 칸들을 끌어서 골라 주세요 (병합한 칸 안에서 누르면 병합을 풀어요)');
  }

  function parentOfType(names) {
    const { $from } = view().state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if (names.includes($from.node(d).type.name)) return { node: $from.node(d), depth: d, pos: $from.before(d) };
    }
    return null;
  }

  function toggleHeading(level) {
    const heading = parentOfType(['heading']);
    if (heading && heading.node.attrs.level === level) call(turnIntoTextCommand);
    else call(wrapInHeadingCommand, level);
  }

  function toggleList(type) {
    const list = parentOfType(['bullet_list', 'ordered_list']);
    const item = parentOfType(['list_item']);
    const isTask = item && item.node.attrs.checked != null;
    if (list && list.node.type.name === type && !isTask) {
      call(liftListItemCommand);
      return;
    }
    if (!list) call(type === 'bullet_list' ? wrapInBulletListCommand : wrapInOrderedListCommand);
    else if (list.node.type.name !== type) {
      call(liftListItemCommand);
      call(type === 'bullet_list' ? wrapInBulletListCommand : wrapInOrderedListCommand);
    }
    setChecked(null);
  }

  function setChecked(checked) {
    const item = parentOfType(['list_item']);
    if (!item || item.node.attrs.checked === checked) return;
    const v = view();
    v.dispatch(v.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked }));
  }

  function toggleTask() {
    const item = parentOfType(['list_item']);
    if (item && item.node.attrs.checked != null) {
      call(liftListItemCommand);
      return;
    }
    if (!item) call(wrapInBulletListCommand);
    setChecked(false);
  }

  // 글자 색·하이라이트: 색을 주면 그 색으로 바꾸고, null 이면 지운다.
  // 선택이 없으면 이어서 쓸 글자에 적용된다.
  function setColor(markName, color) {
    const v = view();
    const type = v.state.schema.marks[markName];
    const { from, to, empty } = v.state.selection;
    let tr = v.state.tr;
    if (empty) {
      tr = tr.removeStoredMark(type);
      if (color) tr = tr.addStoredMark(type.create({ color }));
    } else {
      tr = tr.removeMark(from, to, type);
      if (color) tr = tr.addMark(from, to, type.create({ color }));
    }
    v.dispatch(tr);
  }

  // 단축키용: 이미 칠해져 있으면 지우고, 아니면 마지막 색으로 칠한다.
  function toggleColor(markName, color) {
    const active = activeFormats(view().state);
    const current = markName === 'mk_color' ? active.color : active.highlight;
    setColor(markName, current ? null : color);
  }

  // 스타일 고르기 (도구막대 "스타일"): 이 줄을 그 스타일로 — 이미 그 스타일이면 그대로 (H1·H2 버튼처럼 켜고 끄지 않음)
  function setStyle(name) {
    const v = view();
    const active = activeFormats(v.state);
    const inQuote = () => {
      const { $from, $to } = view().state.selection;
      return $from.blockRange($to, (n) => n.type.name === 'blockquote');
    };
    if (name === 'quote') {
      if (parentOfType(['heading', 'code_block'])) call(turnIntoTextCommand); // 인용은 본문 글을 감싼다
      if (!active.quote) call(wrapInBlockquoteCommand);
      return;
    }
    // 인용 밖으로 (인용이 아닌 스타일을 고르면)
    const range = inQuote();
    if (range) view().dispatch(view().state.tr.lift(range, range.depth - 1));
    if (name === 'paragraph') {
      if (parentOfType(['heading', 'code_block'])) call(turnIntoTextCommand);
    } else if (/^h[1-3]$/.test(name)) {
      const level = Number(name[1]);
      const heading = parentOfType(['heading']);
      if (!heading || heading.node.attrs.level !== level) call(wrapInHeadingCommand, level);
    } else if (name === 'codeBlock') {
      if (!parentOfType(['code_block'])) call(createCodeBlockCommand);
    }
  }

  const commands = {
    bold: () => call(toggleStrongCommand),
    italic: () => call(toggleEmphasisCommand),
    underline: () => {
      const v = view();
      toggleMark(v.state.schema.marks.mk_underline)(v.state, v.dispatch);
    },
    strike: () => call(toggleStrikethroughCommand),
    code: () => call(toggleInlineCodeCommand),
    h1: () => toggleHeading(1),
    h2: () => toggleHeading(2),
    h3: () => toggleHeading(3),
    paragraph: () => call(turnIntoTextCommand),
    bullet: () => toggleList('bullet_list'),
    ordered: () => toggleList('ordered_list'),
    task: toggleTask,
    quote: () => call(wrapInBlockquoteCommand),
    codeBlock: () => call(createCodeBlockCommand),
    divider: () => call(insertHrCommand),
  };

  return {
    run(name) {
      commands[name]?.();
      view().focus();
    },
    setStyle(name) {
      setStyle(name);
      view().focus();
    },
    setTextColor(color) {
      setColor('mk_color', color);
      view().focus();
    },
    setHighlight(color) {
      setColor('mk_highlight', color);
      view().focus();
    },
    // 표 ----------------------------------------------------------
    insertTable() {
      call(insertTableCommand, { row: 3, col: 3 });
      view().focus();
    },
    tableCommand(name) {
      const v = view();
      if (name === 'accent' || name === 'resetSize') {
        if (isInTable(v.state)) (name === 'accent' ? toggleAccent : resetTableSize)(v);
        return v.focus();
      }
      if (name === 'merge') {
        mergeOrSplit(v);
        return v.focus();
      }
      if (name === 'autoFit') {
        const table = parentOfType(['table']);
        if (table) {
          const tr = v.state.tr;
          fitTable(tr, table.node, table.pos, { available: tableBodyWidth(v), measure: tableMeasure(v) });
          // 끌어서 바꾼 행 높이도 내용에 맞춤으로
          const marks = [];
          let p = table.pos + 1;
          table.node.forEach((row) => {
            marks.push({ kind: 'row', pos: p, value: 0 });
            p += row.nodeSize;
          });
          v.dispatch(tr.setMeta(tableExtrasKey, { set: marks }));
          onNotice?.('표의 열 너비·정렬을 내용에 맞춰 정리했어요');
        }
        return v.focus();
      }
      const cmd = { addRow: addRowAfter, addCol: addColumnAfter, delRow: deleteRow, delCol: deleteColumn, delTable: deleteTable }[name];
      if (!cmd || !isInTable(v.state)) return v.focus();
      const tablePos = parentOfType(['table'])?.pos;
      cmd(v.state, v.dispatch);
      // 행·열을 지운 뒤 커서가 표 밖으로 나가면 표의 마지막 셀로 되돌린다 (표 막대가 계속 보이게)
      if (name !== 'delTable' && tablePos != null && !isInTable(view().state)) {
        const table = view().state.doc.nodeAt(tablePos);
        if (table?.type.name === 'table') {
          const s = view().state;
          view().dispatch(s.tr.setSelection(TextSelection.near(s.doc.resolve(tablePos + table.nodeSize - 1), -1)));
        }
      }
      view().focus();
    },
    toggleTextColor: (color) => toggleColor('mk_color', color),
    toggleHighlight: (color) => toggleColor('mk_highlight', color),
    getMarkdown: () => unescapeTags(trimTrailingBreaks(editor.action(getMarkdown()))),
    // 붙여넣은 인터넷 사진 받기가 모두 끝날 때까지 (최대 timeout)
    async imagesSettled(timeout = 25_000) {
      const end = Date.now() + timeout;
      while ((pendingChecks > 0 || localizing.size > 0) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    },
    // 본문을 통째로 바꾸면 표 모양은 지금 저장된 것으로 다시 입힌다 (바꾸는 동안은 저장하지 않음)
    setMarkdown(md, nextTables = currentTables) {
      extras.setLoading(true);
      editor.action(replaceAll(md));
      applyTables(view(), nextTables);
      currentTables = nextTables;
      extras.setLoading(false);
    },
    // 빠른 메모(Ctrl+Alt+C)로 받은 내용 채우기 --------------------------------
    focusEnd() {
      const v = view();
      v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(v.state.doc.content.size), -1)));
      v.focus();
    },
    // 실제 붙여넣기와 같은 경로로 넣는다 (서식 변환·인터넷 사진 저장이 그대로 적용)
    pasteData({ html, text }) {
      const data = new DataTransfer();
      if (html) data.setData('text/html', html);
      if (text) data.setData('text/plain', text);
      view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    insertItems(items) {
      if (items.length) insertBlocks(view().state.doc.content.size, items);
    },
    // 문서를 통째로 다시 쓰지 않고 끝에 끼워 넣는다 (받는 중인 사진의 주소 교체와 엇갈리지 않게)
    appendMarkdown(md) {
      const v = view();
      const end = v.state.doc.content.size;
      const last = v.state.doc.lastChild;
      // 끝이 빈 줄이면 그 줄에, 아니면 새 줄을 만들어 넣는다
      if (!last || last.type.name !== 'paragraph' || last.content.size > 0) {
        v.dispatch(v.state.tr.insert(end, v.state.schema.nodes.paragraph.create()));
      }
      v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(v.state.doc.content.size), -1)));
      editor.action(insert(md));
    },
    // 커서 자리에 파일들을 넣는다.
    async insertFiles(files) {
      const pos = view().state.selection.from;
      const items = await filesToItems(files);
      if (items.length) insertBlocks(pos, items);
    },
    focus: () => view().focus(),
    destroy: () => editor.destroy(),
  };
}

// 빈 줄 하나뿐인 문서 (안내 문구를 보일 때)
function isEmptyDoc(doc) {
  return doc.childCount === 1 && doc.firstChild.type.name === 'paragraph' && doc.firstChild.content.size === 0;
}

// 도구막대 버튼을 눌린 상태로 보여주기 위한 현재 서식
function activeFormats(state) {
  const { $from, from, to, empty } = state.selection;
  const marks = state.schema.marks;
  const findMark = (type) => {
    if (!type) return null;
    if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) ?? null;
    let found = null;
    state.doc.nodesBetween(from, to, (node) => {
      found ??= type.isInSet(node.marks) ?? null;
    });
    return found;
  };
  const active = {
    bold: Boolean(findMark(marks.strong)),
    italic: Boolean(findMark(marks.emphasis)),
    underline: Boolean(findMark(marks.mk_underline)),
    strike: Boolean(findMark(marks.strike_through)),
    code: Boolean(findMark(marks.inlineCode)),
    color: findMark(marks.mk_color)?.attrs.color ?? null,
    highlight: findMark(marks.mk_highlight)?.attrs.color ?? null,
  };
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    const name = node.type.name;
    if (name === 'heading') active[`h${node.attrs.level}`] = true;
    if (name === 'code_block') active.codeBlock = true;
    if (name === 'blockquote') active.quote = true;
    if (name === 'list_item' && node.attrs.checked != null && active.task === undefined) active.task = true;
    if (name === 'bullet_list' && !active.task && !active.ordered) active.bullet ??= true;
    if (name === 'ordered_list' && !active.bullet) active.ordered ??= true;
  }
  if (active.task) active.bullet = false;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'table_header_row') active.tableHeader = true;
    if (node.type.name === 'table') {
      const cellNode = $from.node(Math.min($from.depth, d + 2));
      const multi = state.selection instanceof CellSelection && state.selection.ranges.length > 1;
      active.table = {
        rows: node.childCount,
        cols: node.firstChild?.childCount ?? 0,
        header: Boolean(active.tableHeader),
        accent: isAccent(state, { node, pos: $from.before(d) }),
        canMerge: multi,
        merged: !multi && ((cellNode?.attrs.colspan ?? 1) > 1 || (cellNode?.attrs.rowspan ?? 1) > 1),
      };
      break;
    }
  }
  return active;
}
