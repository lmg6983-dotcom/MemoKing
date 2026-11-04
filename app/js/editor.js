// 서식 편집기 (Milkdown) — 화면에는 서식이 적용된 모습, 저장은 마크다운.
import {
  Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, parserCtx,
  commonmark, imageSchema, linkSchema, toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand,
  wrapInHeadingCommand, turnIntoTextCommand, wrapInBulletListCommand, wrapInOrderedListCommand,
  wrapInBlockquoteCommand, createCodeBlockCommand, insertHrCommand, liftListItemCommand, htmlSchema,
  gfm, toggleStrikethroughCommand, history, listener, listenerCtx, clipboard, trailing, upload, uploadConfig,
  callCommand, getMarkdown, replaceAll, insert, $view, $prose, $markSchema, $nodeSchema, $remark, Plugin, PluginKey, TextSelection, NodeSelection,
  toggleMark, Decoration, DecorationSet, insertTableCommand, tableSchema,
  addRowAfter, addColumnAfter, deleteRow, deleteColumn, deleteTable, isInTable, goToNextCell, columnResizing,
  splitCell, CellSelection, TableMap, selectedRect, undoDepth, redoDepth,
} from '../vendor/milkdown.js';
import { Plyr } from '../vendor/plyr.js';
import plyrSprite from '../vendor/plyr-sprite.js';
import { mediaKindOf, trimTrailingBreaks, isAlbumTitle, isAlbumPageTitle, isInkedAlbumTitle, inkedAlbumTitle, ALBUM_TITLE, ALBUM_PAGE_TITLE } from './core/memo-file.js';
import { isInk, inkAlt, bgOfAlt, inkToSvg, parseInkSvg, inkForDark } from './core/ink.js';
import { getStroke } from '../vendor/perfect-freehand.js';
import { openInkEditor } from './ink-editor.js';
import { icon } from './icons.js';
import { remarkEmptyTasks } from './core/empty-tasks.js';
import { remarkInlineHtmlMarks, stringifyHandlers, safeColor, DEFAULT_HIGHLIGHT } from './core/html-marks.js';
import { needsLocalCopy, pickImageSource } from './core/remote-images.js';
import { vaultUrl, mediaKind, baseName } from './media.js';
import { videoPoster } from './video-poster.js';
import { openAlbumViewer } from './album-viewer.js';
import { promptChoice } from './rename-content.js';
import { isDocumentFile, documentPages, decodeTxtBytes } from './doc-pages.js';
import { CARD_TITLE, remarkLinkCards, loneUrl, pastedLinkTitle, hostOf } from './core/link-preview.js';
import { extOf, fileKind } from './core/file-kinds.js';
import { wrapOrphanRows, cellsToGrid, gridToHtml, parseTsv, CELL_BREAK_HTML } from './core/tables.js';
import { autoFitTable, tableReviewReasons } from './core/table-autofit.js';
import { keepIndent, keepLeadingSpaces, hasLeadingSpaces, NBSP } from './core/indent-spaces.js';
import { INVISIBLE } from './tidy-text.js';
import { plainTextOf, spacedHtml } from './clipboard-text.js';
import { isOwnDragOut, handleImageCopy, saveBlock, shareBlock, canShare } from './copy-content.js';
import { findTags, unescapeTags, suggestTags, sameTag, TAG_CHAR } from './core/tags.js';
import { createTableExtras, applyTables, toggleAccent, resetTableSize, isAccent, tableExtrasKey, mergeSelectedCells, tableAt, splitTableAt, joinNextTable, tableToBlocks, tableLines } from './table-extras.js';
import { createListDrag, moveItemBy, currentItem } from './list-drag.js';
import { createBlockMove, createContentLines, MEDIA_SCRUB, moveBlockBy } from './block-move.js';
import { createTapList } from './tap-list.js';
import { createVoiceCards, isVoiceCard, voiceAudioOf } from './voice-card-view.js';
import { createTidy } from './tidy.js';
import { createDateRemind, refreshDateRemind } from './date-remind.js';
import { transcriptLines, voiceCardMarkdown } from './core/voice-card.js';
import { burstAt } from './confetti-burst.js';
import { haptic } from './dom.js';
import { createFindPlugin, findController } from './find-replace.js';
import { mathPlugins, insertMathBlock } from './math.js';
import { fileChipGuard } from './file-chip-guard.js';
import { listContentGuard, listsFixed } from './list-content-guard.js';
import { listDeleteGuard } from './list-delete-guard.js';
import { looksLikeMarkdown, normalizeMath } from './core/markdown-import.js';

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
    settings: kind === 'video' ? ['speed'] : [], // 소리는 설정(재생 속도) 단추 없이 — 막대를 넓게
    // 스티커 창은 좁으므로 음량 막대는 빼고 음소거 버튼만 (시간 표시가 줄바꿈되지 않게)
    controls: kind === 'video'
      ? ['play-large', 'play', 'progress', 'current-time', 'mute', 'settings', 'fullscreen']
      : ['play', 'progress', 'current-time', 'duration'], // 소리: 음소거 단추는 두지 않는다 (소리는 기기 음량 키로)
    keyboard: { focused: true, global: false },
    tooltips: kind === 'video' ? { controls: true, seek: true } : { controls: false, seek: false }, // 소리는 말풍선 없이 — 작은 상자 안에서 잘렸다 (시간은 오른쪽에 늘 보임)
  };
}

// 플레이어에서 누르면 그 기능이 되는 곳 (재생 막대·단추). 그중 MEDIA_SCRUB(설정 메뉴)은 꾹 눌러도 옮기지 않음
const MEDIA_CONTROL = `${MEDIA_SCRUB}, .plyr__progress, input, [role="slider"], .plyr__control, button`;

// 손 메모 이어 그리기 (편집기마다 createNoteEditor 가 정함: (view, getPos) => void)
let inkEditHandler = null;
// 묶음 사진 한 장을 누르면 크게 넘겨 보기 (편집기마다 createNoteEditor 가 정함: (view, pos) => void)
let albumHandler = null;

let inkReader = null; // 손 메모 SVG 글 읽기 (createNoteEditor 의 readAttachment)
const INK_FILE = '손 메모';

// 손 메모 한 칸: 그린 만큼의 그림 + (마우스를 올리거나 고르면) "이어 그리기" — PC 는 두 번 눌러도
function inkView(node, view, getPos) {
  const dom = document.createElement('span');
  dom.className = `mk-ink bg-${bgOfAlt(node.attrs.alt)}`;
  dom.contentEditable = 'false';
  const img = document.createElement('img');
  img.src = vaultUrl(node.attrs.src);
  img.alt = node.attrs.alt ?? '';
  img.draggable = false;
  img.onerror = () => dom.classList.add('broken');
  img.className = 'ink-light-src';
  // 투명 바탕: 어두운 화면용 그림도 함께 (검은 펜 ↔ 흰 펜만 바꿈) — 어느 것을 보일지는 CSS 가 메모 색·다크 모드로 고른다
  const bg = bgOfAlt(node.attrs.alt);
  if (bg === 'none' && inkReader) {
    inkReader(node.attrs.src).then((text) => {
      const dark = inkForDark(parseInkSvg(text) ?? { strokes: [] });
      const svg = dark && inkToSvg(dark, getStroke);
      if (!svg) return;
      const alt = img.cloneNode();
      alt.className = 'ink-dark-src';
      alt.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      alt.addEventListener('dblclick', open);
      img.after(alt);
    }).catch(() => {});
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'mk-ink-edit';
  edit.append(icon('pen'), '이어 그리기');
  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof getPos === 'function' && view.editable) inkEditHandler?.(view, getPos());
  };
  edit.addEventListener('mousedown', (e) => e.preventDefault());
  edit.addEventListener('click', open);
  img.addEventListener('dblclick', open);
  dom.append(img, edit);
  return {
    dom,
    stopEvent: (e) => e.target === edit || edit.contains(e.target),
    ignoreMutation: () => true,
    selectNode: () => dom.classList.add('ProseMirror-selectednode'),
    deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
  };
}

function mediaView(node, view, getPos) {
  const { src, alt, title } = node.attrs;
  if (isInk(src, alt)) return inkView(node, view, getPos);
  const kind = mediaKindOf(src, alt);
  if (kind === 'audio' || kind === 'video') {
    injectPlyrSprite();
    const dom = document.createElement('span');
    dom.className = `mk-media mk-${kind}`;
    dom.contentEditable = 'false';
    // 이름 줄 = 잡는 곳: 꾹 눌러(휴대폰)·끌어(PC) 이 줄을 옮긴다 — 플레이어 단추는 재생용
    const label = document.createElement('span');
    label.className = 'mk-media-label';
    label.title = '잡고 끌어서 옮기기';
    label.textContent = alt || baseName(String(src).split('/').pop() ?? '') || (kind === 'video' ? '동영상' : '소리');
    dom.append(label);
    const el = document.createElement(kind);
    el.preload = 'metadata';
    el.src = vaultUrl(src);
    if (kind === 'video') el.setAttribute('playsinline', '');
    dom.append(el);
    const player = new Plyr(el, playerOptions(kind));
    // 재생 전 그림: 1초쯤의 장면 (휴대폰 WebView 는 그대로 두면 회색 기본 그림만 보인다)
    let gone = false;
    if (kind === 'video') videoPoster(src).then((url) => { if (url && !gone) player.poster = url; });
    // 재생할 수 없을 때(파일이 없거나 읽지 못함 · 형식을 못 읽음) 조용히 멈춰 있지 않고 알린다 — 휴대폰은 다른 앱으로 열기 안내 (note-view.js).
    //   메모를 열기만 해도 뜨면 귀찮으니 재생 단추를 누른 뒤에만 (이미 오류 상태면 누르는 즉시)
    let tried = 0;
    const fail = () => window.dispatchEvent(new CustomEvent('mk:media-error', { detail: { src, kind, code: el.error?.code ?? 0 } }));
    dom.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.plyr__control[data-plyr="play"], .plyr__poster')) return;
      tried = Date.now();
      if (el.error) fail();
    }, true);
    el.addEventListener('error', () => {
      if (el.isConnected && Date.now() - tried < 10_000) fail();
    });
    return {
      dom,
      // 상자 어디를 꾹 눌러도 줄을 옮긴다 (이름 줄·시간·빈 곳·동영상 화면은 편집기로).
      // 재생 단추·재생 막대는 짧게 누르거나 밀면 그 기능, 꾹 누르면 옮기기 — 손가락이 닿는 순간만 편집기도 받는다
      stopEvent: (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t || !t.closest(MEDIA_CONTROL)) return false;
        if (e.type === 'touchstart' && !t.closest(MEDIA_SCRUB)) return false;
        return true;
      },
      ignoreMutation: () => true,
      destroy: () => {
        gone = true;
        player.destroy();
      },
    };
  }
  const dom = document.createElement('img');
  const album = isAlbumTitle(title);
  dom.className = album ? `mk-image mk-album-img${isAlbumPageTitle(title) ? ' mk-album-page' : ''}` : 'mk-image'; // mk-album-page: 문서를 넣은 장 (종이 묶음 모양)
  dom.src = vaultUrl(src);
  dom.alt = alt ?? '';
  if (title && !album) dom.title = title;
  dom.onerror = () => dom.classList.add('broken');
  if (album) {
    dom.addEventListener('click', (e) => {
      if (e.defaultPrevented || typeof getPos !== 'function') return;
      albumHandler?.(view, getPos());
    });
  }
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

// 체크를 하면 체크 네모 자리에서 작은 폭죽 (confetti-burst.js)

// 체크 네모의 화면 좌표 (ProseMirror 가 체크 뒤 li 를 다시 그려 참조가 끊기므로 누르기 전에 잰다)
function checkboxPoint(li) {
  const r = li.getBoundingClientRect();
  const fs = parseFloat(getComputedStyle(li).fontSize) || 14;
  const scale = li.offsetWidth ? r.width / li.offsetWidth : 1;
  return { x: r.left - fs * 0.9 * scale, y: r.top + fs * 0.8 * scale };
}

// 체크리스트 네모를 누르면 체크/해제
function toggleTaskOnClick(view, event) {
  const li = event.target instanceof Element ? event.target.closest('li[data-item-type="task"]') : null;
  if (!li || event.target !== li || event.clientX > li.getBoundingClientRect().left) return false;
  const $pos = view.state.doc.resolve(view.posAtDOM(li, 0));
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'list_item') {
      const checked = !node.attrs.checked;
      const point = checked ? checkboxPoint(li) : null; // 다시 그리기 전에 미리 잰다
      view.dispatch(view.state.tr.setNodeMarkup($pos.before(d), undefined, { ...node.attrs, checked }));
      event.preventDefault();
      haptic(checked ? 10 : 4); // 휴대폰: 체크는 또렷하게, 풀기는 살짝
      if (point) burstAt(point.x, point.y);
      return true;
    }
  }
  return false;
}

// 문서의 체크리스트 진행 (CLEAR 도장)
function taskCounts(doc) {
  let total = 0;
  let done = 0;
  doc.descendants((node) => {
    if (node.type.name === 'list_item' && node.attrs.checked != null) {
      total++;
      if (node.attrs.checked) done++;
    }
    return true;
  });
  return { total, done };
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
    // 인터넷 주소만 카드로 (붙여 넣은 javascript: · data: 같은 주소가 복사로 다른 앱에 링크로 나가지 않게)
    getAttrs: (dom) => (/^https?:\/\//i.test(dom.dataset.linkCard ?? '') ? { href: dom.dataset.linkCard, title: dom.dataset.title ?? '' } : false),
  }],
  // 복사(Ctrl+C)할 때 다른 앱에도 링크로 붙도록 안에 <a> (편집기 화면은 linkCardView 가 그린다)
  toDOM: (node) => ['div', { 'data-link-card': node.attrs.href, 'data-title': node.attrs.title }, ['a', { href: node.attrs.href }, node.attrs.title || node.attrs.href]],
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
const emptyTasks = $remark('memoking-empty-tasks', () => remarkEmptyTasks);

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

// 링크 미리보기를 끈 설정이면 카드 대신 링크 글자 한 줄 (파일의 [제목](주소 "미리보기") 는 그대로 — 다시 켜면 카드)
//   cards: 그 편집기에 그려진 카드들 (설정을 바꾸면 바로 다시 그린다)
function linkCardView(node, view, getPos, { fetchPreview, openLink, previewsOn = () => true, cards }) {
  const dom = el('div', 'mk-link-card');
  dom.contentEditable = 'false';
  const main = el('div', 'lc-main');
  main.setAttribute('role', 'link');
  const play = el('span', 'lc-play'); // 유튜브: 썸네일 위 작은 재생 표시 (동영상인 줄 알게)
  play.setAttribute('aria-hidden', 'true');
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
  site.append(icon, siteName);
  text.append(site, title, desc);
  main.append(text, thumb);
  // 지우기 · 복사는 다른 내용(그림 · 파일)과 같은 단추로 (block-move.js · delete-button.js) — 카드에 따로 × 를 두면 두 개가 겹쳐 뜬다
  dom.append(main);
  const plain = el('a', 'lc-plain');

  let current = node;
  let preview = null;
  let loaded = false;

  function render() {
    const { href, title: saved } = current.attrs;
    const on = previewsOn();
    dom.classList.toggle('plain-link', !on);
    if (!on) {
      plain.href = href;
      plain.textContent = saved || href;
      plain.title = `누르면 브라우저로 열려요\n${href}`; // 글자만 보이니 어디로 가는지 주소를
      if (!plain.isConnected) dom.replaceChildren(plain);
      return;
    }
    if (!main.isConnected) dom.replaceChildren(main);
    if (!loaded) load();
    main.title = `열기 버튼으로 브라우저에서 열어요\n${href}`;
    const state = preview ? (preview.ok ? 'ok' : 'plain') : 'loading';
    dom.dataset.state = state;
    dom.dataset.kind = preview?.kind === 'youtube' || preview?.site === 'YouTube' ? 'youtube' : '';
    if (state === 'loading') main.setAttribute('aria-busy', 'true');
    else main.removeAttribute('aria-busy');
    siteName.textContent = preview?.site || hostOf(href);
    title.textContent = saved && saved !== href ? saved : preview?.title || href;
    // 불러오는 중과 못 불러온 카드가 같아 보이지 않게 (못 불러와도 누르면 열리는 링크 그대로)
    desc.textContent = state === 'loading' ? '미리보기 불러오는 중' : state === 'plain' ? '미리보기를 불러오지 못했어요' : preview?.description ?? '';
    desc.classList.toggle('lc-note', state !== 'ok');
    desc.hidden = !desc.textContent;
    main.setAttribute('aria-label', `${title.textContent}, ${siteName.textContent}`);
    const img = preview?.image ? vaultUrl(preview.image) : preview?.imageUrl ?? '';
    if (img) {
      if (thumb.getAttribute('src') !== img) thumb.src = img;
      if (!thumb.isConnected) main.append(thumb);
      if (dom.dataset.kind === 'youtube') thumb.after(play);
      else play.remove();
    } else {
      thumb.remove();
      play.remove();
    }
    const ico = preview?.icon ? vaultUrl(preview.icon) : '';
    if (ico) {
      if (icon.getAttribute('src') !== ico) icon.src = ico;
      if (!icon.isConnected) site.prepend(icon);
    } else icon.remove();
  }

  function load() {
    loaded = true;
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

  const open = (e) => {
    e.preventDefault();
    e.stopPropagation(); // 메모 창의 "링크 누르면 열기" 가 한 번 더 열지 않게
    openLink?.(current.attrs.href);
  };
  main.addEventListener('click', open);
  plain.addEventListener('click', open);

  render();
  cards?.add(render);
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      const changed = next.attrs.href !== current.attrs.href;
      current = next;
      if (changed) {
        preview = null;
        loaded = false;
      }
      render();
      return true;
    },
    destroy: () => cards?.delete(render),
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

// 다 쓴 태그(뒤에 띄어쓰기가 있는 알약)는 한 덩어리 — 사진처럼 다룬다:
//   눌러서 알약 가운데에 커서가 서면 끝으로, 화살표로 들어오면 건너편으로 · 바로 뒤에서 지우면 태그째, 바로 앞에서 Delete 도
//   (쓰는 중인 태그는 뒤가 비어 있어 글자 하나씩 고칠 수 있다)
function doneTagAt(doc, pos, { lineEnd = false } = {}) {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  const start = $pos.start();
  for (const r of tagRanges(doc)) {
    if (r.to < start || r.from > $pos.end()) continue;
    if (r.from > pos || r.to < pos) continue;
    const next = doc.textBetween(r.to, Math.min(r.to + 1, $pos.end()), '\n', '\ufffc');
    if (/^\s$/.test(next) || (lineEnd && r.to === $pos.end())) return r;
  }
  return null;
}
// 줄 앞 띄어쓰기 지키기 (core/indent-spaces.js): 문단 · 제목 · 항목의 맨 앞이나 줄바꿈(Shift+Enter) 뒤에
//   친 띄어쓰기 · 탭은 줄 바꿈 없는 빈칸(U+00A0)으로 바꿔 둔다 — 마크다운으로 저장했다 다시 열어도 그대로
//   일부러 넣은 것만: 줄 앞에서 친 띄어쓰기(handleTextInput)와 붙여 넣은 글의 들여쓰기(붙여넣기 트랜잭션의 바뀐 줄).
//   줄을 나누다 앞에 남은 띄어쓰기는 보통 띄어쓰기로 두어 다듬기(tidy)가 지운다. 코드 블록 · 글 속 코드는 그대로.
//   붙여 넣은 글의 줄바꿈도 그대로 줄바꿈으로
const BREAKS = new Set(['hardbreak', 'hard_break']);
let plainPasting = false; // 메모장 같은 일반 글자를 붙이는 중 (아래 붙여넣기에서 잠깐)
function indentFixes(doc, from, to) {
  const fixes = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    let lineStart = true;
    node.forEach((child, offset) => {
      if (child.isText && lineStart && !child.marks.some((m) => m.type.spec.code)) {
        const ws = /^[ \t]+/.exec(child.text);
        if (ws) fixes.push({ from: pos + 1 + offset, to: pos + 1 + offset + ws[0].length, text: keepIndent(ws[0]), marks: child.marks });
      }
      lineStart = BREAKS.has(child.type.name);
    });
    return false;
  });
  return fixes;
}
/** 여러 트랜잭션이 바꾼 범위 (마지막 문서 기준) — 없으면 null */
function changedRange(trs, doc) {
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
  return from > to ? null : { from: Math.max(0, from), to: Math.min(doc.content.size, to) };
}
/** 커서가 줄 맨 앞(또는 줄 앞 들여쓰기 바로 뒤)인가 */
function atLineIndent($pos) {
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return false;
  let start = $pos.start();
  // 줄바꿈(Shift+Enter) 뒤라면 그 줄의 시작부터
  $pos.parent.forEach((child, offset) => {
    if (BREAKS.has(child.type.name) && $pos.start() + offset < $pos.pos) start = $pos.start() + offset + child.nodeSize;
  });
  return /^\u00a0*$/.test($pos.doc.textBetween(start, $pos.pos, '', ''));
}
const fileChips = $prose(() => fileChipGuard());
const listContent = $prose(() => listContentGuard());
const protectListDelete = $prose(() => listDeleteGuard());

// 서식이 있는 HTML 인가 (글자 모양 · 목록 · 표 · 그림 · 링크 등) — 없으면 글자만 있는 것 (메신저 · 채팅 복사)
const RICH_TAGS = 'h1,h2,h3,h4,h5,h6,ul,ol,li,table,pre,code,blockquote,img,picture,video,audio,svg,hr,strong,b,em,i,u,s,del,strike,mark,sub,sup,a[href]';
export function isPlainHtml(html) {
  const doc = new window.DOMParser().parseFromString(html, 'text/html');
  if (doc.body.querySelector(RICH_TAGS)) return false;
  // 구글 문서 등은 굵게 · 기울임을 span 의 style 로 준다
  for (const el of doc.body.querySelectorAll('[style]')) {
    const st = el.getAttribute('style');
    if (/font-weight\s*:\s*(bold|[6-9]00)|font-style\s*:\s*italic|text-decoration[^;]*(underline|line-through)/i.test(st)) return false;
  }
  return true;
}

/** 일반 글자를 줄마다 문단으로 (빈 줄은 빈 문단, 줄 앞 띄어쓰기는 들여쓰기, 보이지 않는 글자는 빼고) — 커서 자리에 */
function pastePlainLines(v, plain) {
  const { schema } = v.state;
  const lines = keepLeadingSpaces(plain.replace(/\r\n?/g, '\n').replace(/\n+$/, '')).split('\n').map((l) => l.replace(INVISIBLE, ''));
  const paras = lines.map((l) => schema.nodes.paragraph.create(null, l ? schema.text(l) : null));
  // 문단들을 담은 문서에서 첫 문단 안 ~ 끝 문단 안을 잘라, 양 끝이 지금 줄에 이어 붙게 (열린 조각)
  const doc = schema.topNodeType.create(null, paras);
  v.dispatch(v.state.tr.replaceSelection(doc.slice(1, doc.content.size - 1)).setMeta('uiEvent', 'paste').scrollIntoView());
}

/**
 * 서식 없이 붙여넣기 (Ctrl+Shift+V · 오른쪽 클릭 › 서식 없이 붙여넣기) — 복사해 온 글자 모양 · 링크 · 목록 · 표를 버리고 글자만.
 * 코드 블록은 줄바꿈 그대로, 표 칸은 한 줄로(칸 안 줄바꿈은 <br> 이라야 저장된다), 그 밖은 줄마다 문단.
 */
function pasteAsText(v, text) {
  const plain = String(text ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
  if (!plain) return false;
  if (v.state.selection.$from.parent.type.spec.code) v.dispatch(v.state.tr.insertText(plain).setMeta('uiEvent', 'paste').scrollIntoView());
  else if (isInTable(v.state)) v.dispatch(v.state.tr.insertText(plain.replace(/\n+/g, ' ').trim()).setMeta('uiEvent', 'paste').scrollIntoView());
  else pastePlainLines(v, plain);
  return true;
}

const keepIndentPlugin = $prose(() => {
  let composing = false; // 한글 조합 중에는 손대지 않는다 (조합이 끝난 뒤 그 줄이 다시 바뀔 때 고친다)
  return new Plugin({
    key: new PluginKey('memoking-keep-indent'),
    props: {
      // 줄 앞에서 친 띄어쓰기 · 탭 → U+00A0 (일부러 들여 쓰는 것)
      handleTextInput(view, from, to, text) {
        if (composing || !/^[ \t]+$/.test(text) || !atLineIndent(view.state.doc.resolve(from))) return false;
        const $from = view.state.doc.resolve(from);
        view.dispatch(view.state.tr.insertText(keepIndent(text), from, to).setStoredMarks($from.marks()).scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        compositionstart: () => {
          composing = true;
          return false;
        },
        compositionend: () => {
          composing = false;
          return false;
        },
      },
    },
    appendTransaction(trs, _old, state) {
      // 붙여넣기 · 끌어다 놓기만 (치는 띄어쓰기는 handleTextInput 이 바로)
      const pasted = plainPasting || trs.some((tr) => /^(paste|drop)$/.test(tr.getMeta('uiEvent') ?? ''));
      if (composing || !pasted || !trs.some((tr) => tr.docChanged)) return null;
      const range = changedRange(trs, state.doc);
      if (!range) return null;
      const { from, to } = range;
      const tr = state.tr;
      // 붙여 넣은 글의 줄바꿈: 마크다운으로 읽으면 "부드러운 줄바꿈"(띄어쓰기로 보임)이 된다 → 진짜 줄바꿈으로 (메모장 글이 한 줄로 합쳐지지 않게)
      if (plainPasting) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.spec.code) return false;
          if (BREAKS.has(node.type.name) && node.attrs.isInline) tr.setNodeMarkup(pos, null, { ...node.attrs, isInline: false });
          return true;
        });
      }
      const fixes = indentFixes(tr.doc, from, to);
      for (const f of fixes.reverse()) tr.replaceWith(f.from, f.to, state.schema.text(f.text, f.marks));
      return tr.docChanged ? tr : null;
    },
  });
});

// 붙여 넣은 서식 글: 글 속 U+00A0 는 보통 띄어쓰기로, 줄 맨 앞(문단 처음 · 줄바꿈 뒤)의 U+00A0 는 들여쓰기라 그대로
//   (메모킹 · 워드에서 복사한 들여쓴 줄이 붙여넣기에서도 들여 쓴 채로)
function plainSpacesIn(fragment, lineStart = true) {
  let changed = false;
  let atLine = lineStart;
  const out = [];
  fragment.forEach((node) => {
    let next = node;
    if (node.isText) {
      if (node.text.includes(NBSP) && !node.marks.some((m) => m.type.spec.code)) {
        const lead = atLine ? /^\u00a0*/.exec(node.text)[0] : '';
        const text = lead + node.text.slice(lead.length).replaceAll(NBSP, ' ');
        if (text !== node.text) next = node.type.schema.text(text, node.marks);
      }
      atLine = false;
    } else if (BREAKS.has(node.type.name)) atLine = true;
    else if (!node.type.spec.code && !node.isLeaf) {
      const inner = plainSpacesIn(node.content, true);
      if (inner !== node.content) next = node.copy(inner);
      atLine = node.isInline ? false : atLine;
    } else if (node.isInline) atLine = false;
    if (next !== node) changed = true;
    out.push(next);
  });
  return changed ? fragment.constructor.fromArray(out) : fragment;
}

const tagCapsule = $prose(() => new Plugin({
  key: new PluginKey('memoking-tag-capsule'),
  appendTransaction(trs, old, state) {
    if (trs.some((tr) => tr.docChanged) || !state.selection.empty || state.selection.eq(old.selection)) return null;
    const pos = state.selection.head;
    const tag = doneTagAt(state.doc, pos, { lineEnd: true }); // 커서만 옮긴 것이니 줄 끝 태그도 다 쓴 것
    if (!tag || pos <= tag.from || pos >= tag.to) return null;
    // 왼쪽에서 들어오면 끝으로, 오른쪽에서 들어오면 앞으로, 눌러서 들어오면 끝으로
    const prev = old.selection.head;
    const to = prev >= tag.to && prev - pos === 1 ? tag.from : tag.to;
    return state.tr.setSelection(TextSelection.create(state.doc, to));
  },
  props: {
    handleKeyDown(view, event) {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
      const { selection, doc } = view.state;
      if (!selection.empty) return false;
      const pos = selection.head;
      const tag = doneTagAt(doc, pos);
      if (!tag || (event.key === 'Backspace' ? pos !== tag.to : pos !== tag.from)) return false;
      // 태그 양옆이 모두 띄어쓰기(또는 줄 앞)면 띄어쓰기 하나도 함께 — 빈칸 두 개가 남지 않게
      const $from = doc.resolve(tag.from);
      const before = tag.from > $from.start() ? doc.textBetween(tag.from - 1, tag.from) : ' ';
      const after = doc.textBetween(tag.to, Math.min(tag.to + 1, $from.end()));
      const to = /\s/.test(before) && /^\s$/.test(after) ? tag.to + 1 : tag.to;
      view.dispatch(view.state.tr.delete(tag.from, to).scrollIntoView());
      return true;
    },
  },
}));

// # 자동완성: 커서 바로 앞이 "#글자" 이면 지금까지 쓴 태그를 권한다.
// 맨 위는 늘 지금 쓴 그대로(#회 → "#회"), 처음엔 그것이 골라져 있다 — Enter 는 쓴 그대로 두고 줄을 바꾸고(목록은 닫힘),
//   ↑↓ 로 다른 태그를 골랐을 때만 Enter·Tab 이 그 태그로 바꾼다 (모르는 사이 다른 태그로 바뀌지 않게). Esc 닫기.
//   # 만 쳤을 때도 처음엔 아무것도 골라져 있지 않다. 한글 입력 중(조합 중)에는 Enter 를 가로채지 않는다.
const TAG_BEFORE_CURSOR = new RegExp(`(^|[\\s(\\[{,;:!?'"“‘>])#(${TAG_CHAR}*)$`, 'u');

function createTagSuggest(getTags) {
  let tags = null; // # 를 새로 칠 때마다 받아 온다 (다른 메모에서 새 태그가 생겼을 수 있음)
  let fetchedFor = null;
  let loading = null;
  let active = null; // { from, to, prefix, items, index, typed } — index -1 = 쓴 그대로, typed = 맨 위 "쓴 그대로" 줄
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
    head.textContent = active.prefix ? 'Enter는 쓴 그대로, ↓ 로 고르기' : '지금까지 쓴 태그 (↓ 로 고르기)';
    box.append(head);
    if (active.typed) {
      const row = document.createElement('div');
      row.className = 'tag-suggest-item typed';
      row.dataset.index = '-1';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(active.index === -1));
      const name = document.createElement('span');
      name.textContent = `#${active.prefix}`;
      const note = document.createElement('small');
      note.textContent = active.typed.count ? `${active.typed.count}` : '새 태그';
      row.append(name, note);
      box.append(row);
    }
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
    const t = index === -1 ? (active?.typed && { name: active.prefix }) : active?.items[index];
    if (!t || !view) return;
    const { from, to } = active;
    hide();
    const after = view.state.doc.textBetween(to, Math.min(to + 1, view.state.doc.content.size), '\n', ' ');
    const text = `#${t.name}${after === ' ' ? '' : ' '}`;
    view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
    view.focus();
  }

  // typed: 글자를 쳐서 바뀐 때만 새로 연다 (이미 쓴 태그를 누르거나 커서만 옮겨 온 때는 열지 않는다)
  let typingAt = null;
  function update(v, prev) {
    view = v;
    const { selection } = v.state;
    const typed = prev ? !prev.doc.eq(v.state.doc) : false;
    const $from = selection.$from;
    if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.spec.code
      || $from.marks().some((m) => m.type.spec.code || m.type.name === 'link')) return hide();
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 60), $from.parentOffset, undefined, ' ');
    const m = TAG_BEFORE_CURSOR.exec(before);
    if (!m) {
      dismissedAt = null;
      typingAt = null;
      return hide();
    }
    const prefix = m[2];
    const from = $from.pos - prefix.length - 1;
    if (dismissedAt === from) return hide();
    if (typed) typingAt = from;
    else if (typingAt !== from && !(active && active.from === from)) return hide();
    if (fetchedFor !== from && !loading) {
      tags = null;
      fetchedFor = from;
    }
    if (!tags) {
      loading ??= Promise.resolve(getTags?.()).then((list) => {
        tags = list ?? [];
        loading = null;
        if (view) update(view, null);
      }).catch(() => {
        tags = [];
        loading = null;
      });
      return;
    }
    const items = suggestTags(tags, prefix);
    // 맨 위 "쓴 그대로" 줄 (이미 있는 태그와 같으면 그 개수를 함께)
    const typedRow = prefix ? { count: tags.find((t) => sameTag(t.name, prefix))?.count ?? 0 } : null;
    if (!items.length) return hide(); // 권할 다른 태그가 없으면 목록도 없다 — 쓴 그대로
    const index = active && active.from === from ? Math.min(active.index, items.length - 1) : -1;
    active = { from, to: $from.pos, prefix, items, index, typed: typedRow };
    render();
  }

  function handleKeyDown(v, event) {
    if (!active || box.hidden || event.isComposing || event.keyCode === 229) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // -1(쓴 그대로) → 0 → … → 마지막 → -1 로 돈다
      const n = active.items.length + 1;
      active.index = ((active.index + 1 + (event.key === 'ArrowDown' ? 1 : n - 1)) % n) - 1;
      render();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (active.index === -1) {
        // 쓴 그대로: 목록만 닫고 Enter 는 원래대로(줄 바꿈), Tab 은 아무것도 바꾸지 않는다
        dismissedAt = active.from;
        hide();
        return event.key === 'Tab';
      }
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

// 붙여 넣은 표마다 따로 살펴볼 이유(병합된 칸·표 안의 표·그림·수식) — 붙인 뒤 열 너비를 자동으로 맞출 때 쓴다
let pastedTableReviews = [];
let pastedTablesAt = 0; // 표가 든 내용을 붙여 넣은 시각 (Milkdown 붙여넣기는 "paste" 표시 없이 문서를 바꾸므로 이것으로 안다)

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
 *   linkPreviews: 링크 미리보기 카드 (설정, 기본 켜짐) — 끄면 주소를 붙여도 링크 글자, 있던 카드도 링크 글자로 보임
 */
// readOnly: 고칠 수 없이 보여 주기만 (PDF 만들기)
export async function createNoteEditor(root, { markdown, onChange, onState, onEmpty, onTasks, saveFile, fetchImage, onNotice, fetchPreview, openLink, linkPreviews = true, getTags, tables = [], onTables, readOnly = false, readAttachment, tapContinuesList = false, scrollMargin = 0, onDateReminder, hasReminderAt }) {
  if (readAttachment) inkReader = readAttachment; // 그림 칸(inkView)이 만들어지기 전에
  let previewsOn = linkPreviews !== false;
  const linkCardRenders = new Set(); // 그려진 링크 카드들 — 설정을 바꾸면 다시 그린다
  let ready = false;
  let editor = null;
  const view = () => editor.ctx.get(editorViewCtx);

  // 넣은 파일은 각자 한 줄(문단)을 차지한다.
  // 빈 줄이면 그 줄을 바꾸고, 글이 있는 줄이면 그 줄 바로 아래에 넣는다.
  // item: { kind: 'image'|'audio'|'video', src, alt } 또는 { kind: 'file', src, name } (파일 칩 = 링크)
  // 음성 카드(받아쓴 글) 안에는 글자만 — 손 메모·사진·파일·표·수식 같은 칸은 카드 바로 아래로
  function voiceCardDepth($pos) {
    for (let d = $pos.depth; d > 0; d--) if (isVoiceCard($pos.node(d))) return d;
    return 0;
  }
  function afterVoiceCard(state, pos) {
    const $p = state.doc.resolve(Math.min(pos, state.doc.content.size));
    const d = voiceCardDepth($p);
    return d ? $p.after(d) : pos;
  }
  /** 커서가 음성 카드 안이면 카드 바로 아래 빈 줄로 (없으면 만든다) */
  function leaveVoiceCard() {
    const v = view();
    const { $from } = v.state.selection;
    const d = voiceCardDepth($from);
    if (!d) return;
    const after = $from.after(d);
    const next = v.state.doc.resolve(after).nodeAfter;
    let tr = v.state.tr;
    if (!(next?.type.name === 'paragraph' && next.content.size === 0)) tr = tr.insert(after, v.state.schema.nodes.paragraph.create());
    v.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)));
  }

  function insertBlocks(pos, items) {
    const v = view();
    const { schema } = v.state;
    pos = afterVoiceCard(v.state, pos);
    const paragraphs = items.map((item) => {
      if (item.kind === 'album') {
        return schema.nodes.paragraph.create(null, item.images.map((im) => schema.nodes.image.create({ src: im.src, alt: im.alt, title: im.page ? ALBUM_PAGE_TITLE : ALBUM_TITLE })));
      }
      if (item.kind === 'file') {
        return schema.nodes.paragraph.create(null, schema.text(item.name, [schema.marks.link.create({ href: item.src })]));
      }
      return schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: item.src, alt: item.alt, title: '' }));
    });
    const $pos = v.state.doc.resolve(Math.min(pos, v.state.doc.content.size));
    const size = paragraphs.reduce((sum, p) => sum + p.nodeSize, 0);
    // 표 칸에는 글 한 줄만 들어간다 — 칸 안이면 표 바로 아래에 (표가 둘로 쪼개지지 않게)
    let depth = $pos.depth;
    while (depth > 1 && !$pos.node(depth - 1).canReplaceWith($pos.index(depth - 1) + 1, $pos.index(depth - 1) + 1, schema.nodes.paragraph)) depth--;
    let tr = v.state.tr;
    let end;
    if (depth < $pos.depth) {
      tr = tr.insert($pos.after(depth), paragraphs);
      end = $pos.after(depth) + size;
    } else if ($pos.depth > 0 && $pos.parent.isTextblock && $pos.parent.content.size === 0) {
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

  // ---------- 손 메모 (콘텐츠): 그린 만큼의 SVG 한 칸 ----------
  async function saveInk(doc) {
    const svg = inkToSvg(doc, getStroke);
    if (!svg) return null;
    const src = await saveFile(new File([svg], `${INK_FILE}.svg`, { type: 'image/svg+xml' }));
    return { src, alt: inkAlt(doc.bg) };
  }
  // 새 손 메모: 그리기 화면 → 완료하면 커서 자리에 (빈 메모면 첫 줄)
  function insertInk() {
    const at = view().state.selection.from;
    return new Promise((resolve) => {
      openInkEditor({
        onSave: async (doc) => {
          if (!doc) return;
          const item = await saveInk(doc);
          if (item) insertBlocks(at, [{ kind: 'image', ...item }]);
          resolve(item);
        },
        onClose: () => {
          resolve(null);
          view().focus();
        },
      });
    });
  }
  // 손 메모 이어 그리기: 그 칸의 SVG 안 자료를 열고, 완료하면 새 파일로 바꾼다 (다 지우면 칸도 지움)
  async function editInk(v, pos) {
    const node = v.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'image' || !isInk(node.attrs.src, node.attrs.alt)) return;
    let doc = null;
    try {
      doc = parseInkSvg(await readAttachment?.(node.attrs.src));
    } catch (err) {
      console.warn('손 메모를 읽지 못했어요', err);
    }
    if (!doc) {
      onNotice?.('이 그림은 고칠 수 없어요 (메모킹으로 그린 손 메모가 아니에요)', true);
      return;
    }
    openInkEditor({
      doc,
      onSave: async (next) => {
        const cur = v.state.doc.nodeAt(pos);
        if (cur !== node && cur?.attrs.src !== node.attrs.src) return; // 그 사이 글이 바뀌어 자리가 달라짐
        if (next === null) {
          v.dispatch(v.state.tr.delete(pos, pos + node.nodeSize));
          return;
        }
        if (!next) return;
        const item = await saveInk(next);
        if (item) v.dispatch(v.state.tr.setNodeMarkup(pos, null, { ...node.attrs, src: item.src, alt: item.alt }));
      },
      onClose: () => v.focus(),
    });
  }
  if (!readOnly) inkEditHandler = (v, pos) => editInk(v, pos); // 보기만 하는 편집기(PDF·옆 메모)는 이어 그리기 없음
  // 묶음 사진: 누른 장부터 크게 넘겨 보기 · 그 장 위에 그리면 그린 것을 합친 새 그림으로 바꾼다 (보기만 하는 편집기는 그리기 없음)
  // 창 하나에 편집기가 여럿일 수 있어(옆 메모 · 스택 탭) 그리기는 그 편집기(v)가 고칠 수 있을 때만 — 보기만 하는 편집기가 나중에 만들어져도 덮어쓰지 않게
  if (!readOnly || !albumHandler) albumHandler = (v, pos) => {
    // 묶음 줄의 장들 (줄 자리 para 는 지우기 · 되돌리기 뒤에도 따라간다)
    let para = v.state.doc.resolve(pos).before();
    const collect = () => {
      const node = v.state.doc.nodeAt(para);
      const images = [];
      node?.forEach((child, offset) => {
        if (child.type.name !== 'image' || !isAlbumTitle(child.attrs.title)) return;
        images.push({ src: child.attrs.src, alt: child.attrs.alt, pos: para + 1 + offset, inked: isInkedAlbumTitle(child.attrs.title) });
      });
      return images;
    };
    const images = collect();
    const start = Math.max(0, images.findIndex((im) => im.pos === pos));
    if (!images.length) return;
    // 보는 사이 메모가 바뀌었으면(동기화 등) 엉뚱한 장을 고치지 않게 — 그 자리가 아직 그 장일 때만
    const nodeOf = (it) => {
      const cur = v.state.doc.nodeAt(it.pos);
      return !v.isDestroyed && cur?.type.name === 'image' && cur.attrs.src === it.src ? cur : null;
    };
    const editable = v.editable;
    openAlbumViewer({
      images,
      start,
      url: vaultUrl,
      onDraw: !editable ? null : async (i, png) => {
        const it = images[i];
        const src = await saveFile(new File([png], `${baseName(it.alt || '그림')} 그림.png`, { type: 'image/png' }));
        const cur = nodeOf(it);
        if (!cur) return null;
        it.src = src; // 같은 장을 또 그리면 이번 그림에서 이어서
        it.inked = true;
        v.dispatch(v.state.tr.setNodeMarkup(it.pos, null, { ...cur.attrs, src, title: inkedAlbumTitle(cur.attrs.title) }));
        return src;
      },
      // 이 장만 저장 · 공유 (원본 그대로) — 휴대폰은 공유 창
      onSave: async (i) => {
        const cur = nodeOf(images[i]);
        if (!cur) return null;
        const r = await saveBlock(v, images[i].pos, cur, null);
        return r && r !== 'cancelled' ? '이 장을 저장했어요' : null;
      },
      onShare: canShare() ? async (i) => {
        const cur = nodeOf(images[i]);
        if (cur) await shareBlock(v, images[i].pos, cur, null);
        return null;
      } : null,
      // 이 장만 묶음에서 빼기 → 남은 장들 (메모의 되돌리기 기록에 남아 되살릴 수 있다)
      onDelete: !editable ? null : (i) => {
        const it = images[i];
        if (!nodeOf(it)) return null;
        const tr = v.state.tr.delete(it.pos, it.pos + 1);
        para = tr.mapping.map(para);
        v.dispatch(tr);
        return collect();
      },
      onUndo: !editable ? null : () => {
        v.focus();
        v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true })); // 편집기의 Ctrl+Z 와 같은 기록
        return collect();
      },
    });
  };

  // 파일들을 메모 폴더에 저장 → 넣을 줄들. 하나가 안 읽혀도(폴더 · 잠긴 파일 · 너무 큰 파일) 나머지는 그대로 넣고 알린다
  //   (예전에는 하나만 실패해도 여러 파일을 한꺼번에 놓은 것이 통째로 사라졌다)
  async function filesToItems(files) {
    const items = [];
    const failed = [];
    for (const file of files) {
      try {
        const kind = mediaKind(file);
        const src = await saveFile(file);
        if (kind === 'file') items.push({ kind, src, name: file.name, file });
        else items.push({ kind, src, alt: kind === 'video' ? `동영상 ${baseName(file.name)}` : baseName(file.name) });
      } catch (err) {
        console.warn('파일을 넣지 못했어요', file.name, err);
        failed.push(file.name || '이름 없는 파일');
      }
    }
    if (failed.length) {
      const names = `${failed.slice(0, 2).join(', ')}${failed.length > 2 ? ' 등' : ''}`;
      onNotice?.(items.length
        ? `파일 ${items.length}개를 넣었어요. ${failed.length}개(${names})는 읽지 못해 넣지 못했어요`
        : `파일을 넣지 못했어요 (${names}). 폴더는 넣을 수 없어요`, true);
    } else if (items.length > 1) onNotice?.(`파일 ${items.length}개를 넣었어요`);
    return arrangeItems(items);
  }

  /**
   * 넣을 것 다듬기 (PC·휴대폰 같은 질문 — 휴대폰은 앱이 저장한 뒤 이것만 부른다):
   *   문서(PDF · Word · 한글)는 파일로 둘지 장마다 그림(묶음 사진)으로 바꿀지 — 원노트처럼
   *   사진 여러 장은 따로따로 둘지 묶음 사진(카카오톡처럼 몇 장만 모아 보이기)으로 할지
   */
  async function arrangeItems(items) {
    if (readOnly) return items;
    const docs = items.filter((it) => it.kind === 'file' && isDocumentFile({ name: it.name }));
    const docsAsPages = docs.length > 0 && await promptChoice({
      title: docs.length > 1 ? `문서 ${docs.length}개를 어떻게 넣을까요?` : `${docs[0].name}을 어떻게 넣을까요?`,
      message: '그림으로 넣으면 장마다 넘겨 보고, 그 위에 펜으로 쓸 수 있어요',
      choices: [{ id: 'file', label: '파일로' }, { id: 'pages', label: '그림으로', primary: true }],
      remember: 'doc-insert',
    }) === 'pages';
    const photos = items.filter((it) => it.kind === 'image');
    const asAlbum = photos.length > 1 && await promptChoice({
      title: `사진 ${photos.length}장을 어떻게 넣을까요?`,
      message: '묶음 사진은 몇 장만 모아 보이고, 누르면 크게 넘겨 봐요',
      choices: [{ id: 'each', label: '따로따로' }, { id: 'album', label: '묶음 사진으로', primary: true }],
      remember: 'photos-insert',
    }) === 'album';
    const out = [];
    let album = null; // 모으는 중인 묶음 (처음 사진 자리에 한 묶음)
    for (const it of items) {
      if (docsAsPages && docs.includes(it)) {
        // 원본 문서 파일(칩)을 묶음 바로 위 줄에 — 그림으로 본 뒤에도 원본을 열거나 보낼 수 있게 (바꾸지 못하면 칩만)
        const pages = await documentAlbum(it);
        out.push(it);
        if (pages !== it) out.push(pages);
        continue;
      }
      if (asAlbum && it.kind === 'image') {
        if (!album) out.push((album = { kind: 'album', images: [] }));
        album.images.push({ src: it.src, alt: it.alt });
        continue;
      }
      out.push(it);
    }
    return out;
  }

  // 메모 폴더에 넣은 문서 → 장마다 그림 → 묶음 사진 (바꾸지 못하면 받은 것(파일 칩) 그대로 돌려준다)
  async function documentAlbum(it) {
    const name = it.name;
    try {
      onNotice?.(`${name}을 그림으로 바꾸고 있어요`);
      const fileName = extOf(name) ? name : `${name}.${extOf(it.src) || 'txt'}`;
      // PC: Word · PowerPoint 는 Office 로 PDF 를 만들어 그 장들을 넣는다 (직접 그리면 그림이 깨지고 장이 어긋남) — Office 가 없으면 직접 그린다
      const pdf = await window.memoking?.attachments?.toPdf?.(it.src).catch(() => null);
      const srcFile = pdf
        ? new File([pdf], `${baseName(name)}.pdf`, { type: 'application/pdf' })
        : it.file instanceof File
        ? new File([await it.file.arrayBuffer()], fileName, { type: it.file.type })
        : new File([await (await fetch(vaultUrl(it.src))).blob()], fileName);
      const { pages, total } = await documentPages(srcFile, (n, all) => onNotice?.(`${name}을 그림으로 바꾸고 있어요 (${n}/${all})`));
      const images = [];
      for (let i = 0; i < pages.length; i++) {
        const alt = `${baseName(name)} ${i + 1}쪽`;
        images.push({ src: await saveFile(new File([pages[i]], `${alt}.png`, { type: 'image/png' })), alt, page: true });
      }
      onNotice?.(total > pages.length ? `${name}의 앞 ${pages.length}장을 넣었어요 (모두 ${total}장)` : `${name}을 ${pages.length}장의 그림으로 넣었어요`);
      return { kind: 'album', images };
    } catch (err) {
      console.warn('문서를 그림으로 바꾸지 못했어요', name, err);
      onNotice?.(`${name}은 그림으로 바꾸지 못해 파일로 넣었어요`, true);
      return it;
    }
  }

  // 파일 칩 우클릭 메뉴 › 그림으로 펼치기
  window.addEventListener('mk:expand-document-images', async (e) => {
    if (readOnly) return;
    const { pos, node, href, name } = e.detail ?? {};
    if (!href) return;
    const item = { kind: 'file', src: href, name: name || href.split('/').pop() };
    const album = await documentAlbum(item);
    if (album && album !== item && album.images?.length) {
      const v = view();
      const insertAt = pos != null ? pos + (node?.nodeSize ?? 0) : v.state.selection.head;
      insertBlocks(insertAt, [album]);
    }
  });

  // 파일 칩 우클릭 메뉴 › 텍스트로 본문에 풀기
  window.addEventListener('mk:expand-document-text', async (e) => {
    if (readOnly) return;
    const { pos, node, href, name } = e.detail ?? {};
    if (!href) return;
    try {
      onNotice?.(`${name}의 글을 읽고 있어요`);
      const buf = new Uint8Array(await (await fetch(vaultUrl(href))).arrayBuffer());
      const text = decodeTxtBytes(buf);
      const v = view();
      const { schema } = v.state;
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const paras = lines.map((l) => schema.nodes.paragraph.create(null, l ? schema.text(l) : null));
      const insertAt = pos != null ? pos + (node?.nodeSize ?? 0) : v.state.selection.head;
      const tr = v.state.tr.insert(insertAt, paras);
      v.dispatch(tr.scrollIntoView());
      onNotice?.(`${name}의 내용을 본문에 풀었어요`);
    } catch (err) {
      console.warn('텍스트 풀기 오류', err);
      onNotice?.(`${name}의 글을 읽지 못했어요`, true);
    }
  });

  // ---------- 붙여 넣은 인터넷 사진을 메모 폴더로 ----------
  // 글과 함께 붙여 넣은 사진은 먼저 인터넷 주소로 들어오고, 받아지는 대로 attachments/ 파일로 바뀐다.
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
        console.warn('사진을 받지 못했어요', src.slice(0, 120), err?.message);
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
      ? `사진 ${saved.size}개를 저장했어요. ${failed}개는 받지 못해서 인터넷 주소로 두었어요`
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
    const card = previewsOn ? schema.nodes.mk_link_card : null; // 미리보기를 끄면 언제나 링크 글자
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

  // ---------- 표 칸 안에 붙여넣기 ----------
  // 칸에는 글 한 줄(문단 하나)만 들어간다. 그대로 붙이면 줄마다 옆 칸을 덮어쓰거나(표 기능이 줄을 칸으로 읽음),
  // 표가 둘로 쪼개지거나, 표를 늘리다 멈춰 아무것도 붙지 않는다. 그래서 칸 안에서는 직접:
  //   표(엑셀·시트의 칸, 탭으로 나뉜 글) → 지금 칸부터 오른쪽·아래로 칸마다 글을 채운다 (모자라면 표를 늘림, 칸 모양은 그대로)
  //   여러 줄·여러 문단 → 줄마다 칸 안 줄바꿈(<br>)으로 이어 지금 칸에
  // 칸 여러 개를 골라 두고 붙이면(CellSelection) 표 기능에 맡긴다.

  const cellBreak = (schema) => schema.nodes.html.create({ value: '<br>' });

  // 블록들 → 칸 한 줄에 들어갈 글 노드들 (줄 사이는 <br>)
  function inlineLines(schema, fragment) {
    const inline = [];
    const line = (nodes) => {
      if (!nodes.length) return;
      if (inline.length) inline.push(cellBreak(schema));
      inline.push(...nodes);
    };
    fragment.descendants((node) => {
      if (node.type.name === 'math_block') {
        if (node.attrs.value) line([schema.nodes.math_inline.create({ value: node.attrs.value })]);
        return false;
      }
      if (node.type.name === 'mk_link_card') {
        line([schema.text(node.attrs.title || node.attrs.href, [schema.marks.link.create({ href: node.attrs.href })])]);
        return false;
      }
      if (!node.isTextblock) return true;
      if (node.type.spec.code) {
        for (const t of node.textContent.split('\n')) line(t ? [schema.text(t)] : []);
      } else {
        const nodes = [];
        node.forEach((c) => nodes.push(c));
        line(nodes);
      }
      return false;
    });
    return inline;
  }

  const textLines = (schema, text) => {
    const out = [];
    String(text ?? '').trim().split(/[ \t]*\n[ \t]*/).forEach((t, i) => {
      if (i && out.length) out.push(cellBreak(schema));
      if (t) out.push(schema.text(t));
    });
    return out;
  };

  // 붙일 것이 표 조각뿐이면 칸 글 격자 [행][열] = 글 노드들 (아니면 null — 표 앞뒤에 다른 글이 있으면 모두 한 칸에 이어 붙인다)
  function sliceGrid(schema, slice) {
    const rows = [];
    let loose = null; // 행 없이 칸만 (편집기 안에서 칸을 복사한 경우)
    if (!slice?.content.childCount) return null;
    for (let i = 0; i < slice.content.childCount; i++) if (!slice.content.child(i).type.spec.tableRole) return null;
    slice.content.descendants((node) => {
      const role = node.type.spec.tableRole;
      if (role === 'row') {
        const row = [];
        node.forEach((cell) => row.push(inlineLines(schema, cell.content)));
        rows.push(row);
        return false;
      }
      if (role === 'cell' || role === 'header_cell') {
        (loose ??= []).push(inlineLines(schema, node.content));
        return false;
      }
      return true;
    });
    if (rows.length) return rows;
    return loose ? [loose] : null;
  }

  // 지금 칸부터 grid 크기만큼 들어가게 표를 늘린다 (오른쪽에 열, 아래에 행)
  function growTableFor(tr, rect, rows, cols) {
    const { map, table, tableStart } = rect;
    const addRows = rect.top + rows - map.height;
    const addCols = rect.left + cols - map.width;
    const { schema } = tr.doc.type;
    // 새 칸의 정렬은 그 열의 머리글을 따른다 (새 열은 정렬 없음 — 파일에 :- 같은 표시가 새로 생기지 않게)
    const head = table.firstChild;
    const alignOf = (c) => (c < map.width ? head?.maybeChild(c)?.attrs.alignment ?? null : null);
    if (addCols > 0) {
      table.forEach((row, offset) => {
        const type = row.type.name === 'table_header_row' ? schema.nodes.table_header : schema.nodes.table_cell;
        tr.insert(tr.mapping.map(tableStart + offset + row.nodeSize - 1), Array.from({ length: addCols }, () => type.createAndFill({ alignment: null })));
      });
    }
    if (addRows > 0) {
      const width = Math.max(map.width, rect.left + cols);
      const newRows = Array.from({ length: addRows }, () => schema.nodes.table_row.create(null, Array.from({ length: width }, (_, c) => schema.nodes.table_cell.createAndFill({ alignment: alignOf(c) }))));
      tr.insert(tr.mapping.map(tableStart + table.content.size), newRows);
    }
  }

  // 칸마다 글을 바꿔 넣는다 (머리글·정렬·너비 같은 칸 모양은 그대로). 채운 칸들을 골라 둔다
  function fillCells(v, grid) {
    const rect = selectedRect(v.state);
    const rows = grid.length;
    const cols = Math.max(...grid.map((r) => r.length));
    const tr = v.state.tr;
    growTableFor(tr, rect, rows, cols);
    // 늘린 뒤의 표 기준 자리 (그 뒤에 바꾼 칸들만큼 옮겨 읽는다)
    const table = tr.doc.nodeAt(rect.tableStart - 1);
    const map = TableMap.get(table);
    const mapFrom = tr.mapping.maps.length;
    const posOf = (rel) => tr.mapping.slice(mapFrom).map(rect.tableStart + rel);
    const done = new Set();
    let first = null;
    let last = null;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const row = rect.top + r;
        const col = rect.left + c;
        const rel = map.map[row * map.width + col];
        if (done.has(rel)) continue; // 합친 칸은 한 번만
        done.add(rel);
        const at = map.findCell(rel);
        if (at.top !== row || at.left !== col) continue; // 합친 칸의 첫 칸이 아니면 그대로
        const cell = tr.doc.nodeAt(posOf(rel));
        const para = cell?.firstChild;
        if (!para?.isTextblock) continue;
        const from = posOf(rel) + 2; // 칸 · 문단 여는 자리 다음
        tr.replaceWith(from, from + para.content.size, grid[r][c] ?? []);
        first ??= rel;
        last = rel;
      }
    }
    if (first == null) return false;
    if (first === last) {
      tr.setSelection(TextSelection.create(tr.doc, posOf(last) + tr.doc.nodeAt(posOf(last)).nodeSize - 2)); // 그 칸 글 끝
    } else {
      tr.setSelection(CellSelection.create(tr.doc, posOf(first), posOf(last)));
    }
    v.dispatch(tr.scrollIntoView());
    return true;
  }

  // 여러 줄·여러 문단을 지금 칸에 (줄 사이 <br>)
  function pasteLines(v, slice) {
    const first = slice?.content.firstChild;
    if (!first || first.isInline || (slice.content.childCount === 1 && first.type.name === 'paragraph')) return false; // 한 줄은 평소대로
    const inline = inlineLines(v.state.schema, slice.content);
    if (!inline.length) return false;
    const tr = v.state.tr.deleteSelection();
    const pos = tr.selection.from;
    tr.insert(pos, inline);
    tr.setSelection(TextSelection.create(tr.doc, pos + inline.reduce((sum, n) => sum + n.nodeSize, 0)));
    v.dispatch(tr.scrollIntoView());
    return true;
  }

  // 표 기능(gfm)의 붙여넣기보다 먼저 받아야 해서 따로 (아래 .use 순서)
  const cellPaste = $prose(() => new Plugin({
    key: new PluginKey('memoking-cell-paste'),
    props: {
      handlePaste(v, event, slice) {
        const data = event.clipboardData;
        if (readOnly || !data || data.files.length || !isInTable(v.state) || v.state.selection instanceof CellSelection) return false;
        if (v.state.selection.$from.parent.type.spec.code) return false;
        const { schema } = v.state;
        const html = data.getData('text/html');
        // 엑셀·시트의 글자만(탭으로 나뉜 글) 복사한 경우: 줄 → 행, 탭 → 열
        const tsv = html ? null : parseTsv(data.getData('text/plain'));
        // 진짜 표(HTML 에 표가 있음)일 때만 칸으로 — 그냥 여러 줄도 붙이는 자리(칸)에 맞춰 칸들로 읽히므로
        const grid = tsv ? tsv.map((row) => row.map((t) => textLines(schema, t))) : /<t(able|r|d|h)[\s>]/i.test(html) ? sliceGrid(schema, slice) : null;
        pastedTablesAt = 0; // 있던 표의 열 너비·정렬을 붙여 넣은 표처럼 저절로 맞추지 않게
        const handled = grid?.length ? fillCells(v, grid) : pasteLines(v, slice);
        if (handled) event.preventDefault();
        return handled;
      },
    },
  }));

  let plainPasteKey = 0; // Ctrl+Shift+V 를 누른 때 (performance.now)
  const pastePlugin = $prose(() => new Plugin({
    key: new PluginKey('memoking-paste'),
    // 복사(서식): 편집기가 클립보드에 HTML 을 넣은 뒤 겹친 빈칸만 U+00A0 로 — 워드 · 메일에 붙여도 하나로 줄지 않게
    //   (편집기 안에서 끌어 옮기는 내용은 그대로 두려고 transformCopied 가 아니라 클립보드 글만 바꾼다. 편집기가 먼저 듣는다)
    view(v) {
      const onCopy = (e) => {
        if (!e.defaultPrevented || !e.clipboardData) return;
        const html = e.clipboardData.getData('text/html');
        if (html && / {2}/.test(html)) e.clipboardData.setData('text/html', spacedHtml(html));
      };
      v.dom.addEventListener('copy', onCopy);
      v.dom.addEventListener('cut', onCopy);
      return {
        destroy() {
          v.dom.removeEventListener('copy', onCopy);
          v.dom.removeEventListener('cut', onCopy);
        },
      };
    },
    props: {
      // 복사·끌기: 서식 없는 곳에 붙일 "일반 글자"는 마크다운(\ 이스케이프가 섞임)이 아니라 읽는 글로 (Milkdown 클립보드보다 먼저)
      clipboardTextSerializer: (slice) => plainTextOf(slice.content, { openStart: slice.openStart, openEnd: slice.openEnd }),
      // 붙여 넣은 서식 글의 글 속 U+00A0 는 보통 띄어쓰기로 (웹 · 워드의 &nbsp; · 메모킹에서 복사한 겹친 빈칸), 줄 앞은 들여쓰기라 그대로
      transformPasted: (slice) => new slice.constructor(plainSpacesIn(slice.content), slice.openStart, slice.openEnd),
      transformPastedHTML: (html) => revealLazyImages(normalizePastedTables(html)),
      handlePaste(v, event) {
        const data = event.clipboardData;
        const files = data ? Array.from(data.files) : [];
        const html = data?.getData('text/html') ?? '';
        // Ctrl+Shift+V: 서식 없이 글자만 (파일 · 그림만 복사한 경우는 평소처럼 넣는다)
        if (!readOnly && plainPasteKey && performance.now() - plainPasteKey < 1500 && !files.length && data?.getData('text/plain')) {
          plainPasteKey = 0;
          event.preventDefault();
          return pasteAsText(v, data.getData('text/plain'));
        }
        // 엑셀·시트의 글자만 복사(HTML 없음)된 경우: 탭으로 나뉜 글 → 표
        if (!files.length && !html && !v.state.selection.$from.parent.type.spec.code && !isInTable(v.state)) {
          const grid = parseTsv(data?.getData('text/plain'));
          if (grid?.length) {
            event.preventDefault();
            v.pasteHTML(gridToHtml(grid));
            return true;
          }
        }
        // 마크다운 원문을 글자로만 감싼 HTML(메신저·메모 앱 복사 등)이면 HTML 대신 마크다운으로 그린다
        const plain = data?.getData('text/plain') ?? '';
        if (!files.length && html && looksLikeMarkdown(plain) && !/<(h[1-6]|ul|ol|li|table|pre|blockquote|img|strong|b|em|a)[\s>]/i.test(html)
          && !v.state.selection.$from.parent.type.spec.code && editor) {
          event.preventDefault();
          editor.action(insert(normalizeMath(plain.replace(/\r\n?/g, '\n'))));
          return true;
        }
        // 메신저 · 채팅 · 웹의 글자만 있는 HTML(서식 · 목록 · 표 · 그림 · 링크 없음): 메모장에 붙인 것과 똑같이 —
        //   일반 글자를 한 줄씩, 빈 줄은 빈 줄로 (HTML 의 div 를 문단으로 읽으면 빈 줄이 사라지고, 마크다운으로 읽으면 "1." 같은 줄이 목록이 된다)
        if (!files.length && html && plain.includes('\n') && isPlainHtml(html)
          && !v.state.selection.$from.parent.type.spec.code && !isInTable(v.state)) {
          event.preventDefault();
          pastePlainLines(v, plain);
          return true;
        }
        // 메모장 등에서 복사한 일반 글자(HTML 없음): 마크다운으로 읽으면 줄 앞 띄어쓰기가 지워지므로, 줄마다 앞 빈칸을 지켜서
        //   여러 줄이면 줄바꿈도 그대로 (마크다운의 "부드러운 줄바꿈" 은 띄어쓰기로 보여 줄들이 한 줄로 합쳐진다 — keepIndentPlugin)
        //   고친 글로 붙여넣기를 한 번 더 하고, 그 뒤는 평소처럼 클립보드 플러그인이 서식대로
        //   (표 칸 안은 표 붙여넣기가 따로 — 칸 안 줄바꿈은 <br> 이라야 저장된다)
        if (!plainPasting && !files.length && !html && (hasLeadingSpaces(plain) || plain.includes('\n')) && !v.state.selection.$from.parent.type.spec.code && !isInTable(v.state)) {
          event.preventDefault();
          const dt = new DataTransfer();
          dt.setData('text/plain', keepLeadingSpaces(plain.replace(/\r\n?/g, '\n')));
          plainPasting = true;
          try {
            v.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          } finally {
            plainPasting = false;
          }
          return true;
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
          .catch((err) => console.error('붙여 넣은 파일을 넣지 못했어요', err));
        return true;
      },
      // 메모에서 끌어낸 파일이 도로 이 메모에 떨어지면 무시 (같은 파일이 한 번 더 들어가지 않게 — block-move.js 끌어내기)
      handleDrop(v, event) {
        if (!isOwnDragOut(event.dataTransfer)) return false;
        event.preventDefault();
        return true;
      },
      // DOM 이벤트 단계는 어떤 플러그인의 handlePaste·handleDrop 보다 먼저 불린다 (붙여넣기 전 상태를 찍을 수 있음).
      handleDOMEvents: {
        // Ctrl+Shift+V 를 눌렀다 (곧 오는 붙여넣기를 서식 없이)
        keydown: (v, event) => {
          plainPasteKey = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyV' ? performance.now() : 0;
          return false;
        },
        // 그림을 골라(눌러) 둔 채 Ctrl+C / Ctrl+X: 주소(<img src>)가 아니라 그림 자체를 복사 — 다른 앱에 그림으로 붙는다
        copy: (v, event) => handleImageCopy(v, event),
        cut: (v, event) => handleImageCopy(v, event),
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

  // 체크한 항목에서 Enter: 새 항목은 체크를 풀고 시작 (그대로 두면 다음 할 일이 이미 끝난 것으로 이어진다)
  //   쪼개기는 항목의 속성을 그대로 물려주므로, Enter 직후 커서가 놓인 새 항목만 풀어 준다. 위 항목은 체크한 채 그대로
  const uncheckedNext = $prose(() => {
    let armed = null; // 방금 누른 Enter 가 체크한 항목에서 시작됐다 { pos }
    const itemAt = ($pos) => {
      for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'list_item') return { node: $pos.node(d), pos: $pos.before(d) };
      return null;
    };
    return new Plugin({
      key: new PluginKey('memoking-unchecked-next'),
      props: {
        handleKeyDown(v, event) {
          armed = null;
          if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return false;
          const item = itemAt(v.state.selection.$from);
          if (item?.node.attrs.checked === true) {
            armed = { pos: item.pos };
            setTimeout(() => (armed = null), 0); // 이 키 하나에만 (Enter 가 아무것도 쪼개지 않았으면 남지 않게)
          }
          return false;
        },
      },
      appendTransaction(trs, _old, state) {
        if (!armed || !trs.some((t) => t.docChanged)) return null;
        const from = trs.reduce((pos, t) => t.mapping.map(pos, -1), armed.pos);
        const item = itemAt(state.selection.$from);
        if (!item || item.node.attrs.checked !== true || item.pos <= from) return null; // 쪼개지지 않았거나, 위 항목에 그대로 있음
        armed = null;
        return state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: false }).setMeta('addToHistory', true);
      },
    });
  });

  // 고른 링크 카드(화살표로 고른 상태)에서 Enter: 브라우저로 열기 (마우스 없이도 열리게)
  const linkCardKeys = $prose(() => new Plugin({
    key: new PluginKey('memoking-link-card-keys'),
    props: {
      handleKeyDown(v, event) {
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing) return false;
        const node = v.state.selection.node;
        if (node?.type.name !== 'mk_link_card' || !node.attrs.href) return false;
        openLink?.(node.attrs.href);
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

  // 붙여 넣은 표(엑셀·구글 시트 등): 내용·본문 폭에 맞춰 열 너비·정렬을 자동으로 (core/table-autofit.js)
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
      const range = changedRange(trs, state.doc);
      if (!range || !(range.to > range.from)) return null;
      const { from, to } = range;
      // 그 범위 안의, 아직 너비가 없는 표 = 방금 붙여 넣은 표
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
      if (skipped.size) onNotice?.(`붙여 넣은 표에 ${[...skipped].join(', ')}이 있어 열 너비를 자동으로 맞추지 않았어요. 표를 확인해 주세요`);
      else if (fitted) onNotice?.('붙여 넣은 표의 열 너비와 정렬을 내용에 맞춰 정리했어요');
      return tr.docChanged ? tr : null;
    },
  }));

  const media = $view(imageSchema.node, () => (node, v, getPos) => mediaView(node, v, getPos));
  const cardView = $view(linkCardSchema.node, () => (node, v, getPos) => linkCardView(node, v, getPos, { fetchPreview, openLink, previewsOn: () => previewsOn, cards: linkCardRenders }));
  const listDrag = $prose(() => createListDrag({ readOnly }));
  const blockMove = $prose(() => createBlockMove({ readOnly }));
  // 휴대폰: 목록 아래 빈 줄을 누르면 목록이 이어진다 (보기만 할 때는 없음)
  const tapList = $prose(() => (tapContinuesList && !readOnly ? createTapList() : new Plugin({})));
  const voiceCards = $prose(() => createVoiceCards());
  const contentLines = $prose(() => createContentLines());
  const tidy = $prose(() => createTidy({ readOnly }));
  const findPlugin = $prose(() => createFindPlugin()); // 메모 안 찾기 · 바꾸기 표시 (find-replace.js)
  const dateRemind = $prose(() => createDateRemind({ readOnly, onAdd: onDateReminder, hasReminderAt }));
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
      return { update: (next, prev) => suggest.update(next, prev), destroy: () => suggest.destroy() };
    },
  }));
  const stateWatcher = $prose(() => new Plugin({
    key: new PluginKey('memoking-state'),
    // 내용이 바뀌는 즉시(글자 하나) 알린다 — 저장용 마크다운은 조금 늦게 갱신되므로 안내 문구는 이것을 따른다
    view: (v) => {
      onEmpty?.(isEmptyDoc(v.state.doc));
      onTasks?.(taskCounts(v.state.doc), { initial: true });
      return {
        update: (view, prev) => {
          onState?.(activeFormats(view.state));
          if (!prev.doc.eq(view.state.doc)) {
            onEmpty?.(isEmptyDoc(view.state.doc));
            onTasks?.(taskCounts(view.state.doc), { initial: false });
          }
        },
      };
    },
  }));

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      // 목록 기호는 "-" (Obsidian·GitHub 와 같은 관례), 가로줄은 손으로 치는 "---", 밑줄·색·하이라이트는 HTML 태그로 저장
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: '-',
        rule: '-',
        handlers: { ...prev.handlers, ...stringifyHandlers },
      }));
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: { class: 'mk-doc', spellcheck: 'false', 'aria-label': '메모 내용' },
        editable: () => !readOnly,
        // 커서를 화면 아래쪽 떠 있는 단추들(휴대폰: + · 다이얼) 위에 두도록 스크롤할 여백
        ...(scrollMargin ? { scrollMargin: { top: 8, bottom: scrollMargin, left: 5, right: 5 }, scrollThreshold: { top: 0, bottom: scrollMargin, left: 0, right: 0 } } : {}),
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
          inclusive: false, // 링크 · 파일 칩 바로 뒤에서 친 글은 링크에 붙지 않는다 (한글 조합 중에도)
          toDOM: (mark) => {
            const [tag, attrs] = schema.toDOM(mark);
            return [tag, { ...attrs, ...linkDomAttrs(String(mark.attrs.href ?? '')) }];
          },
        };
      });
      ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
        if (ready) onChange(unescapeTags(trimTrailingBreaks(md)));
      });
      // 끌어다 놓거나 붙여 넣은 파일을 첨부 폴더에 저장하고 그 자리에 넣는다.
      ctx.update(uploadConfig.key, (prev) => ({
        ...prev,
        enableHtmlFileUploader: false,
        // 넣는 동안(어떻게 넣을지 묻는 창 · 문서를 그림으로 바꾸는 중) 그 자리에 영어 "Upload in progress..." 대신
        uploadWidgetFactory: (pos, spec) => {
          const el = document.createElement('span');
          el.className = 'mk-uploading';
          el.textContent = '넣는 중';
          return Decoration.widget(pos, el, spec);
        },
        uploader: async (files, _schema, _ctx, insertPos) => {
          const items = await filesToItems(Array.from(files));
          if (items.length) insertBlocks(insertPos, items);
          return []; // 직접 넣었으므로 플러그인이 넣을 것은 없다
        },
      }));
    })
    .use(protectListDelete) // 목록 맨 앞 Delete 시 서식이 깨지는 버그 방지 (commonmark 키맵보다 먼저)
    .use(commonmark)
    .use(cellPaste) // 표 칸에 여러 줄 붙이기 — 표 기능보다 먼저
    .use(gfm)
    .use(tableTab)
    .use(uncheckedNext)
    .use(linkCardKeys)
    .use(tableAutoFit)
    .use(tableResize) // 읽기 전용(PDF)에서도 열 너비가 보이게 (끌기는 편집할 때만)
    .use(tableExtras)
    .use(tagSuggest) // 자동완성 목록이 떠 있을 때 Enter·↑↓ 를 먼저 받는다
    .use(pastePlugin) // 클립보드·업로드 플러그인보다 먼저 판단
    .use(keepIndentPlugin)
    .use(fileChips) // 파일 칩 이름은 고칠 수 없게
    .use(listContent) // 목록 안에는 글만 (그림 · 파일 · 표 등은 목록 뒤로)
    .use(inlineHtmlMarks)
    .use(linkCards)
    .use(emptyTasks)
    .use(linkCardSchema)
    .use(mathPlugins({ readOnly }))
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
    .use(listDrag)
    .use(blockMove)
    .use(tapList)
    .use(voiceCards)
    .use(contentLines)
    .use(findPlugin)
    .use(tidy)
    .use(tagHighlight)
    .use(tagCapsule)
    .use(dateRemind)
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

  // 제목 · 점 목록 · 번호 목록 · 체크리스트는 한 줄에 하나만 (서로 바꾸면 앞의 것은 풀린다)

  // 목록 밖으로 (겹친 목록이면 바깥까지)
  function leaveLists() {
    for (let i = 0; i < 8 && parentOfType(['list_item']); i++) {
      const before = view().state.doc;
      call(liftListItemCommand);
      if (view().state.doc === before) break; // 더 풀 수 없음
    }
  }

  function leaveHeading() {
    if (parentOfType(['heading'])) call(turnIntoTextCommand);
  }

  function toggleHeading(level) {
    const heading = parentOfType(['heading']);
    if (heading && heading.node.attrs.level === level) {
      call(turnIntoTextCommand);
      return;
    }
    leaveLists();
    call(wrapInHeadingCommand, level);
  }

  // 선택한 범위(커서만 있으면 그 줄)의 목록 항목들
  function itemsInSelection() {
    const { state } = view();
    const { from, to } = state.selection;
    const items = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'list_item') items.push({ node, pos });
    });
    return items;
  }

  // 목록·체크리스트로 바꾸기 전에: 한 문단 안에서 줄바꿈(Shift+Enter·붙여 넣은 여러 줄)으로 나뉜 줄들을 문단으로 나눈다
  // → 줄마다 항목 하나 (그렇지 않으면 여러 줄이 항목 하나가 되어 맨 위에만 체크가 달린다)
  function splitLinesInSelection() {
    const v = view();
    const { state } = v;
    const { from, to } = state.selection;
    const breaks = [];
    state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (node.type.name === 'code_block') return false;
      if (parent?.type.name !== 'paragraph') return true;
      if (node.type.name === 'hardbreak' || node.type.name === 'hard_break' || (node.type.name === 'html' && isBreakHtml(node.attrs.value))) breaks.push({ pos, size: node.nodeSize });
      else if (node.isText) {
        for (let i = node.text.indexOf('\n'); i >= 0; i = node.text.indexOf('\n', i + 1)) breaks.push({ pos: pos + i, size: 1 });
      }
      return true;
    });
    if (!breaks.length) return;
    const tr = state.tr;
    for (const b of breaks.sort((a, c) => c.pos - a.pos)) {
      tr.delete(b.pos, b.pos + b.size);
      tr.split(b.pos);
    }
    v.dispatch(tr);
  }

  // 끌어서 고른 범위의 끝 다듬기: 앞 줄의 맨 끝에서 시작했거나(마우스로 줄 앞에서부터 끌면 흔함) 다음 줄 맨 앞에서 끝나면
  //   그 줄은 고른 것이 아니다 → 목록 등을 그 줄에까지 적용하지 않게 범위에서 뺀다
  function trimLineSelection() {
    const v = view();
    const { state } = v;
    const { from, to, empty } = state.selection;
    if (empty || !(state.selection instanceof TextSelection)) return;
    let a = from;
    let b = to;
    const $a = state.doc.resolve(a);
    if ($a.parent.isTextblock && $a.parentOffset === $a.parent.content.size && a < b) {
      const next = TextSelection.findFrom(state.doc.resolve(Math.min($a.after(), state.doc.content.size)), 1, true);
      if (next && next.from <= b) a = next.from;
    }
    const $b = state.doc.resolve(b);
    if ($b.parent.isTextblock && $b.parentOffset === 0 && b > a) {
      const prev = TextSelection.findFrom(state.doc.resolve(Math.max($b.before(), 0)), -1, true);
      if (prev && prev.to >= a) b = prev.to;
    }
    if (a !== from || b !== to) v.dispatch(state.tr.setSelection(TextSelection.create(state.doc, a, b)));
  }

  // 고른 줄마다 항목 하나인 목록으로 감싼다 — Milkdown 의 감싸기(wrapIn)는 고른 문단을 모두 항목 하나에 넣어
  //   체크 네모가 맨 위 하나만 생긴다. 고른 범위에 섞인 것도 줄마다: 제목은 글 줄로, 이미 있는 목록은 그 항목들을 그대로 옮기고,
  //   그 밖의 칸(표·코드 등)은 항목 하나에 담는다. 고른 범위 앞뒤의 줄은 건드리지 않는다
  function wrapLinesInList(typeName) {
    const v = view();
    const { state } = v;
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to, (node) => !['list_item', 'bullet_list', 'ordered_list'].includes(node.type.name));
    const listType = state.schema.nodes[typeName];
    const itemType = state.schema.nodes.list_item;
    const paragraph = state.schema.nodes.paragraph;
    if (!range || !listType || !itemType) return false;
    const listAttr = typeName === 'ordered_list' ? 'ordered' : 'bullet';
    const items = [];
    const add = (block) => {
      if (block.type.name === 'bullet_list' || block.type.name === 'ordered_list') {
        block.forEach((item) => items.push(item.type === itemType ? itemType.create({ ...item.attrs, listType: listAttr }, item.content) : itemType.create({ listType: listAttr }, item)));
      } else if (block.type.name === 'heading') items.push(itemType.create({ listType: listAttr }, paragraph.create(null, block.content)));
      else items.push(itemType.create({ listType: listAttr }, block));
    };
    for (let i = range.startIndex; i < range.endIndex; i++) add(range.parent.child(i));
    if (!items.length) return false;
    let list;
    try {
      list = listType.create(null, items);
      list.check();
    } catch {
      return false;
    }
    const tr = state.tr.replaceWith(range.start, range.end, list);
    tr.setSelection(TextSelection.between(tr.doc.resolve(range.start + 1), tr.doc.resolve(range.start + list.nodeSize - 1)));
    v.dispatch(tr.scrollIntoView());
    return true;
  }

  // 고른 범위가 지금 목록 하나 안에만 있는가 (목록 밖의 줄까지 골랐으면 false)
  function selectionInside(list) {
    const { from, to } = view().state.selection;
    return from >= list.pos && to <= list.pos + list.node.nodeSize;
  }

  // 선택한 항목 모두의 체크 상태 (null = 체크리스트 아님, false/true = 체크리스트)
  function setCheckedInSelection(checked) {
    const v = view();
    const tr = v.state.tr;
    for (const { node, pos } of itemsInSelection()) {
      if (node.attrs.checked !== checked) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
    }
    if (tr.docChanged) v.dispatch(tr);
  }

  // 이어진 목록 하나(지금 줄이 든 단계)를 통째로 다른 목록으로 — 한 줄씩 바꾸지 않아도 되게
  //   checked: null = 체크리스트 풀기, 'task' = 체크리스트로(이미 체크한 항목은 그대로)
  function convertList(list, typeName, checked) {
    const v = view();
    const tr = v.state.tr;
    convertInto(tr, list, typeName, checked);
    if (tr.docChanged) v.dispatch(tr);
  }

  // 목록 하나를 tr 안에서 바꾼다 (항목 자리는 그대로라 여러 목록을 한 tr 로 바꿔도 위치가 어긋나지 않는다)
  function convertInto(tr, list, typeName, checked) {
    const target = tr.doc.type.schema.nodes[typeName];
    if (!target) return;
    if (list.node.type !== target) {
      const attrs = { ...list.node.attrs };
      if (typeName === 'ordered_list') attrs.order = list.node.attrs.order ?? 1;
      tr.setNodeMarkup(list.pos, target, attrs);
    }
    let pos = list.pos + 1;
    list.node.forEach((item) => {
      if (item.type.name === 'list_item') {
        const next = { ...item.attrs, listType: typeName === 'ordered_list' ? 'ordered' : 'bullet' };
        next.checked = checked === 'task' ? (item.attrs.checked ?? false) : null;
        if (next.checked !== item.attrs.checked || next.listType !== item.attrs.listType) tr.setNodeMarkup(pos, undefined, next);
      }
      pos += item.nodeSize;
    });
  }

  // 고른 범위의 목록을 모두 풀어 보통 글로 — 겹친 목록까지 (항목 안의 글 · 목록을 그 자리에 꺼내 놓기를 바깥부터 되풀이)
  //   liftListItem 은 고른 범위가 목록 하나 안이어야 해서, 한 겹 풀고 나면 글 줄과 목록이 섞여 더 풀리지 않았다
  function liftAllInSelection() {
    const v = view();
    let { from, to } = v.state.selection;
    let tr = v.state.tr;
    for (let i = 0; i < 32; i++) {
      let found = null;
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (found) return false;
        if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
          found = { node, pos };
          return false;
        }
        return true;
      });
      if (!found) break;
      const content = [];
      found.node.forEach((item) => item.forEach((child) => content.push(child)));
      const step = tr.steps.length;
      tr = tr.replaceWith(found.pos, found.pos + found.node.nodeSize, content);
      const map = tr.mapping.slice(step);
      from = map.map(from, -1);
      to = map.map(to, 1);
    }
    if (!tr.docChanged) return;
    tr.setSelection(TextSelection.between(tr.doc.resolve(Math.min(from, tr.doc.content.size)), tr.doc.resolve(Math.min(to, tr.doc.content.size))));
    v.dispatch(tr.scrollIntoView());
  }

  // 고른 범위에 든 목록 — 항목 안에 든(겹친) 목록까지 모두
  function listsInSelection() {
    const { state } = view();
    const { from, to } = state.selection;
    const lists = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') lists.push({ node, pos });
    });
    return lists;
  }

  // 겹친 목록이 든 선택: 든 목록마다 통째로 같은 종류로 — 예전에는 바깥 목록만 바뀌거나
  //   (바깥이 이미 그 종류면) 목록이 아예 풀려 버려, 섞인 목록을 끌어 골라 한 서식으로 바꿀 수 없었다
  //   → true 바꿈 · false 이미 모두 그 종류(부른 쪽이 풀기로) · null 겹친 목록이 아님
  function convertNested(typeName, checked) {
    const lists = listsInSelection();
    const nested = lists.some((l) => lists.some((o) => o !== l && l.pos > o.pos && l.pos < o.pos + o.node.nodeSize));
    if (!nested) return null;
    const v = view();
    const target = v.state.schema.nodes[typeName];
    const fits = (item) => item.type.name !== 'list_item' || (checked === 'task' ? item.attrs.checked != null : item.attrs.checked == null);
    if (lists.every((l) => l.node.type === target && Array.from({ length: l.node.childCount }, (_, i) => l.node.child(i)).every(fits))) return false;
    const tr = v.state.tr;
    for (const l of lists) convertInto(tr, l, typeName, checked);
    if (tr.docChanged) v.dispatch(tr);
    return true;
  }

  function toggleList(type) {
    trimLineSelection();
    leaveHeading();
    const nested = convertNested(type, null);
    if (nested === true) return;
    if (nested === false) {
      liftAllInSelection(); // 이미 모두 그 목록 → 겹친 것까지 모두 풀기
      return;
    }
    const list = parentOfType(['bullet_list', 'ordered_list']);
    const items = itemsInSelection();
    const anyTask = items.some((i) => i.node.attrs.checked != null);
    if (list && selectionInside(list) && list.node.type.name === type && !anyTask) {
      call(liftListItemCommand);
      return;
    }
    // 목록 밖의 줄까지 골랐으면: 고른 줄 모두를 줄마다 항목 하나인 목록 하나로
    if (list && !selectionInside(list)) {
      splitLinesInSelection();
      if (wrapLinesInList(type)) {
        setCheckedInSelection(null);
        return;
      }
    }
    if (!list) {
      splitLinesInSelection();
      if (!wrapLinesInList(type)) call(type === 'bullet_list' ? wrapInBulletListCommand : wrapInOrderedListCommand);
      setCheckedInSelection(null);
      return;
    }
    convertList(list, type, null);
  }

  function toggleTask() {
    trimLineSelection();
    const nested = convertNested('bullet_list', 'task'); // 겹친 목록까지 모두 체크리스트로
    if (nested === true) return;
    if (nested === false) {
      liftAllInSelection();
      return;
    }
    const items = itemsInSelection();
    // 고른 항목이 모두 체크리스트면 체크리스트를 푼다
    if (items.length && items.every((i) => i.node.attrs.checked != null)) {
      call(liftListItemCommand);
      return;
    }
    leaveHeading();
    const list = parentOfType(['bullet_list', 'ordered_list']);
    if (!list || !selectionInside(list)) {
      splitLinesInSelection();
      if (!wrapLinesInList('bullet_list') && !list) call(wrapInBulletListCommand);
      setCheckedInSelection(false); // 고른 줄마다 체크 네모
      return;
    }
    convertList(list, 'bullet_list', 'task'); // 체크리스트는 번호 없이, 이어진 목록 전체를
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
    if (name === 'math') {
      leaveVoiceCard();
      insertMathBlock(view());
      return;
    }
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
      if (!heading || heading.node.attrs.level !== level) {
        leaveLists(); // 제목은 목록 밖 한 줄 (제목·목록은 한 줄에 하나만)
        call(wrapInHeadingCommand, level);
      }
    } else if (name === 'codeBlock') {
      if (!parentOfType(['code_block'])) call(createCodeBlockCommand);
    }
  }

  // ---------- 서식 지우기 (Ctrl+\ · 오른쪽 클릭 › 서식 지우기) ----------
  //   글을 골랐으면: 고른 글자의 모양(굵게 · 기울임 · 밑줄 · 취소선 · 코드 · 글자 색 · 형광펜)만 지운다 — 링크는 글의 내용이라 남긴다
  //   커서만 있으면: 그 자리의 문단을 보통 글로 — 표는 글 줄로, 목록은 풀어 문단으로, 인용은 벗기고, 제목 · 코드 블록은 본문으로, 글자 모양도 모두
  const clearMarksIn = (tr, from, to) => {
    if (from >= to) return;
    for (const type of Object.values(tr.doc.type.schema.marks)) if (type.name !== 'link') tr.removeMark(from, to, type);
  };
  // 목록 하나를 문단들로 (겹친 목록은 펴서 글이 나온 순서대로)
  const listToParagraphs = (list, schema) => {
    const out = [];
    const walk = (node) => node.forEach((item) => item.forEach((child) => {
      if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') walk(child);
      else if (child.isTextblock) out.push(schema.nodes.paragraph.create(null, child.content));
      else out.push(child);
    }));
    walk(list);
    return out.length ? out : [schema.nodes.paragraph.create()];
  };
  function clearFormat() {
    const v = view();
    const { state } = v;
    const { selection, schema } = state;
    const tr = state.tr;
    if (selection instanceof CellSelection) selection.forEachCell((cell, pos) => clearMarksIn(tr, pos + 1, pos + cell.nodeSize - 1));
    else if (selection.node) return false; // 그림 · 파일 같은 것을 골랐다 — 지울 글자 모양이 없다
    else if (!selection.empty) for (const r of selection.ranges) clearMarksIn(tr, r.$from.pos, r.$to.pos);
    else {
      let blocks = null; // 바꾼 덩어리 { from, to, step } — 글자 모양도 이 전체에서
      for (let i = 0; i < 6; i++) {
        const $f = tr.selection.$from;
        let hit = null;
        for (let d = 1; d <= $f.depth && !hit; d++) if (/^(table|bullet_list|ordered_list|blockquote)$/.test($f.node(d).type.name)) hit = d;
        if (!hit) break;
        const node = $f.node(hit);
        const before = $f.before(hit);
        const after = $f.after(hit);
        const step = tr.steps.length;
        if (node.type.name === 'blockquote') {
          tr.replaceWith(before, after, node.content);
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(before, $f.pos - 1))));
          blocks = { from: before, to: before + node.content.size, step };
        } else if (node.type.name === 'table') {
          const lines = tableLines(node, schema);
          tr.replaceWith(before, after, lines);
          tr.setSelection(TextSelection.near(tr.doc.resolve(before + 1)));
          blocks = { from: before, to: before + lines.reduce((n, l) => n + l.nodeSize, 0), step };
        } else {
          // 커서가 있던 글줄이 새 문단들 중 몇 번째인지 (목록이 풀려도 커서는 그 글에 그대로)
          let nth = 0;
          let found = -1;
          node.descendants((n, pos) => {
            if (!n.isTextblock) return true;
            if (before + 1 + pos === $f.before()) found = nth;
            nth++;
            return false;
          });
          const paras = listToParagraphs(node, schema);
          tr.replaceWith(before, after, paras);
          let at = before;
          let seen = 0;
          let caret = before + 1;
          for (const p of paras) {
            if (p.isTextblock && seen++ === found) caret = at + 1 + Math.min($f.parentOffset, p.content.size);
            at += p.nodeSize;
          }
          tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
          blocks = { from: before, to: at, step };
        }
      }
      const $f = tr.selection.$from;
      if ($f.parent.isTextblock && $f.parent.type.name !== 'paragraph') tr.setBlockType($f.before(), $f.after(), schema.nodes.paragraph); // 제목 · 코드 블록 → 본문
      const $c = tr.selection.$from;
      if ($c.parent.isTextblock) clearMarksIn(tr, $c.start(), $c.end());
      if (blocks) {
        const m = tr.mapping.slice(blocks.step + 1);
        clearMarksIn(tr, m.map(blocks.from, -1), m.map(blocks.to, 1));
      }
      tr.setStoredMarks([]);
    }
    if (!tr.docChanged) return false;
    v.dispatch(tr.scrollIntoView());
    return true;
  }

  const commands = {
    clearFormat: () => {
      if (readOnly) return;
      onNotice?.(clearFormat() ? '서식을 지웠어요 (되돌리기 Ctrl+Z)' : '지울 서식이 없어요');
    },
    // 끌지 않고 한 줄 위·아래로 (Alt+↑/↓ 와 같음 — 목록 안에서는 그 항목, 아니면 그 줄)
    moveUp: () => moveLineBy(view().state, view().dispatch, -1),
    moveDown: () => moveLineBy(view().state, view().dispatch, 1),
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
    /** 메모 안 찾기 · 바꾸기 (find-bar.js 가 쓴다) */
    find: findController(view),
    /** 링크 미리보기 설정을 바꾸면 그려진 카드를 바로 카드 ↔ 링크 글자로 */
    setLinkPreviews(on) {
      previewsOn = on !== false;
      for (const render of linkCardRenders) render();
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
      leaveVoiceCard();
      // 표 안에서 누르면 그 표 바로 아래 빈 줄에 (표 안에 표는 마크다운에 없어 표가 둘로 쪼개진다)
      const v = view();
      const outer = tableAt(v.state);
      if (outer) {
        const after = outer.pos + outer.node.nodeSize;
        const next = v.state.doc.resolve(after).nodeAfter;
        let tr = v.state.tr;
        if (!(next?.type.name === 'paragraph' && next.content.size === 0)) tr = tr.insert(after, v.state.schema.nodes.paragraph.create());
        v.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)));
      }
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
      if (name === 'toList' || name === 'toTask' || name === 'toText') {
        const result = tableToBlocks(v.state, v.dispatch, { toList: 'list', toTask: 'task', toText: 'text' }[name]);
        if (result !== true) onNotice?.(result, true);
        else onNotice?.(`표를 ${{ toList: '목록', toTask: '체크리스트', toText: '글' }[name]}${name === 'toTask' ? '로' : name === 'toList' ? '으로' : '로'} 바꿨어요 (행마다 한 줄, 되돌리기 Ctrl+Z)`);
        return v.focus();
      }
      if (name === 'splitTable' || name === 'joinTable') {
        const result = (name === 'splitTable' ? splitTableAt : joinNextTable)(v.state, v.dispatch);
        if (result !== true) onNotice?.(result, true);
        else onNotice?.(name === 'splitTable' ? '표를 둘로 나눴어요 (아래 표에도 머리글 행)' : '아래 표를 이어 붙였어요');
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
          onNotice?.('표의 열 너비와 정렬을 내용에 맞춰 정리했어요');
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
    // 보이는 그대로의 글 (목록은 • 1. ☐/☑, 표는 탭) — 다른 앱으로 보내기
    plainText: () => plainTextOf(view().state.doc.content),
    // 지금 보이는 본문 DOM (그림·PDF 로 보내기)
    dom: () => view().dom,
    // 붙여 넣은 인터넷 사진 받기가 모두 끝날 때까지 (최대 timeout)
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
    // 매직 카피(Ctrl+Alt+C)로 받은 내용 채우기 --------------------------------
    /** 휴대폰 다루기 방식: 글 고치기에서만 고칠 수 있게 (옮기기·그리기에서는 커서·손글씨 입력이 생기지 않게) */
    /** 알림 목록이 바뀌었을 때 글 속 날짜 밑줄(맞춤 표시)을 다시 */
    refreshDates() {
      refreshDateRemind(view());
    },
    setEditable(on) {
      const v = view();
      const next = Boolean(on) && !readOnly;
      if (v.editable === next) return;
      v.setProps({ editable: () => next });
    },
    /** 화면의 그 자리(손가락이 닿은 곳)에 커서를 두고 초점 */
    focusAt(x, y) {
      const v = view();
      const hit = v.posAtCoords({ left: x, top: y });
      if (hit) v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(hit.pos))));
      v.focus();
    },
    /** 커서를 화면 아래 떠 있는 단추들 위로 둘 여백 — S펜으로 쓰는 동안은 0 (쓰는 중에 글이 움직이면 획이 엉뚱한 곳에 가므로) */
    setScrollMargin(px) {
      const m = Math.max(0, Number(px) || 0);
      view().setProps({ scrollMargin: { top: 8, bottom: m || 8, left: 5, right: 5 }, scrollThreshold: { top: 0, bottom: m, left: 0, right: 0 } });
    },
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
    // atCursor: 커서 자리에 (안드로이드에서 앱이 저장해 둔 파일을 넣을 때). 기본은 문서 끝
    /** 앱이 저장해 둔 것을 넣기 전에: 문서 → 그림 묶음 · 사진 여러 장 → 묶음 사진 (물어본다) */
    arrangeItems: (items) => arrangeItems(items),
    insertItems(items, { atCursor = false } = {}) {
      if (items.length) insertBlocks(atCursor ? view().state.selection.from : view().state.doc.content.size, items);
    },
    // 마크다운을 커서 자리에 서식대로 넣는다 (공유받은 마크다운 글·녹음 받아쓰기)
    insertMarkdown(md) {
      if (md) editor.action(insert(md));
    },
    // AI 글쓰기 (서식 막대 ✦, ai-write-panel.js) ------------------------
    /** 고칠 문단: 고른 곳(없으면 메모 전체)에서 글자만 있는 문단 [{ pos, text }] — 그림 · 링크 카드 · 코드가 든 칸은 뺀다 */
    aiBlocks() {
      const { doc, selection } = view().state;
      const out = [];
      doc.nodesBetween(selection.empty ? 0 : selection.from, selection.empty ? doc.content.size : selection.to, (node, pos) => {
        if (!node.isTextblock) return true;
        if (node.type.name !== 'code_block' && node.textContent.trim().length > 1 && node.content.content.every((c) => c.isText)) out.push({ pos, text: node.textContent });
        return false;
      });
      return out;
    },
    /** 그 문단이 아직 before 그대로면 고침(글자 위치)을 넣는다 — 바뀌지 않은 글자의 서식은 남는다. 그사이 글이 바뀌었으면 false */
    aiApply(pos, before, edits) {
      const v = view();
      let at = -1; // 앞 문단을 고쳐 자리가 밀렸어도 찾는다 (같은 글이 여럿이면 가장 가까운 것)
      v.state.doc.descendants((node, p) => {
        if (node.isTextblock && node.textContent === before && (at < 0 || Math.abs(p - pos) < Math.abs(at - pos))) at = p;
        return !node.isTextblock;
      });
      if (at < 0) return false;
      let tr = v.state.tr;
      for (const e of [...edits].reverse()) tr = e.text ? tr.insertText(e.text, at + 1 + e.from, at + 1 + e.to) : tr.delete(at + 1 + e.from, at + 1 + e.to);
      v.dispatch(tr);
      return true;
    },
    /** 문체 바꿀 곳: 고른 곳(없으면 메모 전체)의 글 — 그림 · 표 · 파일이 섞이면 바꾸다 잃을 수 있어 null */
    aiRange() {
      const { doc, selection } = view().state;
      const [from, to] = selection.empty ? [0, doc.content.size] : [selection.from, selection.to];
      let plain = true;
      doc.nodesBetween(from, to, (node) => {
        if (!['doc', 'paragraph', 'heading', 'bullet_list', 'ordered_list', 'list_item', 'blockquote', 'text', 'hardbreak', 'hard_break'].includes(node.type.name)) plain = false;
        return plain;
      });
      return plain ? { from, to, text: doc.textBetween(from, to, '\n') } : null;
    },
    /** 그곳의 글이 그대로면 마크다운으로 바꿔 넣는다 (되돌리기 Ctrl+Z 한 번) */
    aiReplace({ from, to, text }, md) {
      const v = view();
      const { doc } = v.state;
      if (to > doc.content.size || doc.textBetween(from, to, '\n') !== text) return false;
      v.dispatch(v.state.tr.setSelection(TextSelection.between(doc.resolve(from), doc.resolve(to))));
      editor.action(insert(md));
      return true;
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
    // 이 소리 파일 줄에 받아쓴 글을 붙여 음성 카드로 (이미 카드면 끝에 이어서). 소리 줄이 없으면 false
    // 음성 카드의 받아쓴 글을 통째로 바꾼다 (말한 사람을 나눈 뒤 "화자 N:" 을 붙일 때). 카드가 아니면 붙이기. 소리 줄이 없으면 false
    replaceTranscript(src, transcript) {
      const v = view();
      let card = null;
      v.state.doc.descendants((node, pos) => {
        if (card) return false;
        if (voiceAudioOf(node)?.attrs.src === src) {
          card = { node, pos };
          return false;
        }
        return true;
      });
      if (!card) return this.attachTranscript(src, transcript);
      const lines = transcriptLines(transcript);
      const parse = (md) => editor.action((ctx) => ctx.get(parserCtx)(md));
      const from = card.pos + 1 + card.node.firstChild.nodeSize;
      const to = card.pos + card.node.nodeSize - 1;
      const tr = v.state.tr;
      if (lines.length) tr.replaceWith(from, to, parse(lines.join('\n\n')).content);
      else if (to > from) tr.delete(from, to);
      v.dispatch(tr);
      return true;
    },
    attachTranscript(src, transcript) {
      const v = view();
      const { doc } = v.state;
      let found = null;
      doc.descendants((node, pos) => {
        if (found) return false;
        if (node.type.name === 'image' && node.attrs.src === src) found = { node, pos };
        return true;
      });
      if (!found) return false;
      const parse = (md) => editor.action((ctx) => ctx.get(parserCtx)(md));
      const $p = doc.resolve(found.pos);
      const card = $p.depth >= 2 && isVoiceCard($p.node($p.depth - 1)) ? $p.depth - 1 : null;
      const tr = v.state.tr;
      if (card != null) {
        const lines = transcriptLines(transcript);
        if (!lines.length) return true;
        tr.insert($p.after(card) - 1, parse(lines.join('\n\n')).content);
      } else {
        const para = $p.node($p.depth);
        const alone = para.childCount === 1 || para.textContent.trim() === '';
        const cardDoc = parse(voiceCardMarkdown({ alt: found.node.attrs.alt, src }, transcript));
        if (alone) tr.replaceWith($p.before(), $p.after(), cardDoc.content);
        else {
          tr.insert($p.after(), cardDoc.content);
          tr.delete(found.pos, found.pos + found.node.nodeSize);
        }
      }
      v.dispatch(tr.scrollIntoView());
      return true;
    },
    // 손 메모: 새로 그려 넣기 · 그 자리의 손 메모 이어 그리기
    insertInk: () => insertInk(),
    editInk: (pos) => editInk(view(), pos),
    // 커서 자리에 파일들을 넣는다.
    async insertFiles(files) {
      const pos = view().state.selection.from;
      const items = await filesToItems(files);
      if (items.length) insertBlocks(pos, items);
    },
    focus: () => view().focus(),
    /** 서식 없이 붙여넣기 (오른쪽 클릭 메뉴 › 서식 없이 붙여넣기 — 클립보드의 글자) → 편집기에 넣었는가 */
    pastePlain: (text) => {
      const v = view();
      return !readOnly && v.hasFocus() ? pasteAsText(v, text) : false;
    },
    /** 목록 안 그림 등을 목록 뒤로 옮긴 적이 있나 (예전 메모를 열며 고쳤으면 저장해야 한다 — list-content-guard.js) */
    listsFixed: () => listsFixed(view().state),
    /** 커서가 보이게 스크롤 (키보드가 올라와 화면이 줄었을 때 등) */
    revealCaret: () => {
      const v = view();
      if (v.hasFocus()) v.dispatch(v.state.tr.scrollIntoView());
    },
    destroy: () => editor.destroy(),
  };
}

// 빈 줄 하나뿐인 문서 (안내 문구를 보일 때)
function isEmptyDoc(doc) {
  return doc.childCount === 1 && doc.firstChild.type.name === 'paragraph' && doc.firstChild.content.size === 0;
}

const safeDepth = (fn, state) => {
  try {
    return fn(state);
  } catch {
    return 1; // 기록 기능이 없으면 늘 누를 수 있게
  }
};

// 도구막대 버튼을 눌린 상태로 보여주기 위한 현재 서식
// 목록 항목이면 같은 목록 안에서, 아니면 그 줄을 한 칸 (dispatch 가 없으면 할 수 있는지만)
function moveLineBy(state, dispatch, dir) {
  try {
    return currentItem(state) ? moveItemBy(state, dispatch, dir) : moveBlockBy(state, dispatch, dir);
  } catch {
    return false;
  }
}

/** 글을 고치는 것이 아닌 내용(파일 칩 · 음성 카드의 소리 줄 · 그림 · 소리 · 링크 카드 …)을 골랐는가 — 서식 막대를 쓸 수 없게 */
function onFixedContent(state) {
  const { selection } = state;
  const { $from, from, to } = selection;
  if (selection instanceof NodeSelection) return selection.node.type.name !== 'table';
  const isFileLink = (m) => m.type.name === 'link' && typeof m.attrs.href === 'string' && m.attrs.href.startsWith('attachments/');
  let chip = selection.empty ? $from.marks().some(isFileLink) : false;
  if (!selection.empty) state.doc.nodesBetween(from, to, (node) => { chip ||= node.marks.some(isFileLink); });
  if (chip) return true;
  for (let d = $from.depth; d > 0; d--) if (isVoiceCard($from.node(d)) && $from.index(d) === 0) return true;
  return false;
}

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
    // 색 값이 비어 있는 글자 색도 '칠해짐'으로 (그래야 다시 눌러 지울 수 있다)
    color: (() => { const m = findMark(marks.mk_color); return m ? m.attrs.color || 'currentColor' : null; })(),
    highlight: findMark(marks.mk_highlight)?.attrs.color ?? null,
    canUndo: safeDepth(undoDepth, state) > 0,
    canRedo: safeDepth(redoDepth, state) > 0,
  };
  active.fixed = onFixedContent(state);
  active.canMoveUp = moveLineBy(state, null, -1);
  active.canMoveDown = moveLineBy(state, null, 1);
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    const name = node.type.name;
    if (name === 'heading') active[`h${node.attrs.level}`] = true;
    if (name === 'code_block') active.codeBlock = true;
    if (name === 'blockquote' && !isVoiceCard(node)) active.quote = true;
    if (name === 'list_item' && node.attrs.checked != null && active.task === undefined) active.task = true;
    if (name === 'bullet_list' && !active.task && !active.ordered) active.bullet ??= true;
    if (name === 'ordered_list' && !active.task && !active.bullet) active.ordered ??= true;
  }
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'blockquote' && !isVoiceCard($from.node(d))) active.quote = true;
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
        canSplit: splitTableAt(state) === true, // 이 행부터 아래를 새 표로
        canJoin: joinNextTable(state) === true, // 바로 아래 표(같은 열 수)를 이어 붙이기
        merged: !multi && ((cellNode?.attrs.colspan ?? 1) > 1 || (cellNode?.attrs.rowspan ?? 1) > 1),
      };
      break;
    }
  }
  return active;
}
