// 그림·소리·동영상·파일·링크 카드 같은 "내용" 줄 옮기기 (편집기 플러그인, 데스크탑·휴대폰 함께)
// 따로 손잡이·버튼 없이 내용 자체를 잡아 옮긴다 (목록·체크리스트 끌기와 같은 감각)
//   - 마우스: 내용을 누른 채 끌면 바로 들어 올려진다 (그냥 누르면 지금처럼 고르기·열기)
//   - 터치: 꾹(0.35초) 누르면 테두리가 진해지다 "톡" 들어 올려지고, 손가락을 떼지 않고 끈다 (그냥 밀면 스크롤)
//   - 끄는 줄은 손을 따라오고, 다른 줄들은 놓으면 될 자리로 미끄러져 틈을 연다.
//     다른 줄의 가운데 = 맞바꾸기, 줄과 줄 사이 = 끼우기 (그 틀 오른쪽에 ⇅ 맞바꾸기 / ↳ 여기에 넣기 — drag-frames.js). Esc 취소
//   - 키보드: 내용을 고른 채 Alt+↑ / Alt+↓ 로 한 줄씩
//   - 처음 한 번, 내용을 고르면 옮기는 방법을 작은 안내로 알려 준다
//   - 줄 = 같은 상자(본문·인용·목록 항목) 안의 블록 하나
//   - 소리·동영상은 위의 이름 줄, 수식 블록·가로줄은 그대로 잡는다
//   - 글 문단·제목·표·코드 블록·인용·음성 카드는 목록 항목과 같은 방식: 글자를 꾹(마우스 0.35초·터치 0.4초) 누르면
//     테두리가 점점 진해지다 들어 올려진다 (그 전에 움직이면 지금처럼 글자 고르기·스크롤). 목록 항목은 list-drag.js
//     PC 는 어느 줄에서든 Alt+↑ / Alt+↓
import { holdKeyboard, keyboardFor, edgeScroll, canDrag, holdFor, touchMode } from './keyboard-guard.js';
import { Plugin, PluginKey, TextSelection, NodeSelection, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { previewOrder, dropAt } from './core/list-order.js';
import { HOLD_MS, TOUCH_HOLD_MS } from './list-drag.js';
import { isVoiceCard } from './voice-card-view.js';
import { mediaKindOf } from './core/memo-file.js';
import { warpDrag, slotGain, HYSTERESIS_PX } from './core/drag-geometry.js';
import { DragFrames } from './drag-frames.js';
import { showDeleteButton, showContentMenu, hideDeleteButton, hideDeleteIfChanged, deleteShownFor, persistentShown } from './delete-button.js';
import { canContentMenu, canDragOut, dragOutBlock } from './copy-content.js';
import { tableAt } from './table-extras.js';
import { isContextMenuOpen } from './ctx-menu.js';
import { haptic } from './dom.js';
import { renameTarget, renameContent, cleanName, promptName } from './rename-content.js';

export const blockMoveKey = new PluginKey('memoking-block-move');

const INLINE_CONTENT = new Set(['image', 'hardbreak', 'hard_break']);
const NO_MOVE_PARENTS = /^(table_cell|table_header|table_row|table_header_row|table)$/;

// 글자 없이 그림·파일 칩(링크)만 든 문단인가 — "내용 줄"
export function isContentParagraph(node) {
  if (node?.type.name !== 'paragraph' || node.childCount === 0) return false;
  let content = false;
  let ok = true;
  node.forEach((child) => {
    if (INLINE_CONTENT.has(child.type.name)) {
      if (child.type.name === 'image') content = true;
      return;
    }
    if (child.isText) {
      if (child.marks.some((m) => m.type.name === 'link')) content = true;
      else if (child.text.trim()) ok = false;
      return;
    }
    ok = false;
  });
  return ok && content;
}

/**
 * 지금 고른 내용 줄: { pos, node, depth, start, index, inner } 또는 null
 *   pos: 줄(블록)의 시작, depth: 줄의 깊이, start: 상자 안쪽 시작, index: 상자 안에서 몇 번째,
 *   inner: 다시 고를 때 쓸 정보 ({ kind: 'node' | 'text', offset })
 */
export function contentBlockAt(state) {
  const sel = state.selection;
  const { $from } = sel;
  let depth = null;
  let inner = null;
  if (sel instanceof NodeSelection) {
    const n = sel.node;
    if (n.type.name === 'mk_link_card' || (n.isBlock && n.isAtom)) {
      depth = $from.depth + 1;
      inner = { kind: 'node', offset: -1 };
    } else if (n.type.name === 'image' && isContentParagraph($from.parent)) {
      depth = $from.depth;
      inner = { kind: 'node', offset: sel.from - $from.start() };
    }
  } else if (sel.empty && isContentParagraph($from.parent)) {
    depth = $from.depth;
    inner = { kind: 'text', offset: sel.from - $from.start() };
  }
  if (depth == null || depth < 1) return null;
  // 음성 카드 안의 소리 줄 → 카드 통째로 (받아쓴 글도 함께)
  if (depth >= 2 && isVoiceCard($from.node(depth - 1))) return blockInfo(state.doc, $from.before(depth - 1), { kind: 'text', offset: 1 + (inner.offset < 0 ? 0 : inner.offset) });
  const pos = depth > $from.depth ? sel.from : $from.before(depth);
  return blockInfo(state.doc, pos, inner);
}

function blockInfo(doc, pos, inner) {
  const node = doc.nodeAt(pos);
  if (!node) return null;
  const $pos = doc.resolve(pos);
  if (NO_MOVE_PARENTS.test($pos.parent.type.name)) return null;
  return { pos, node, depth: $pos.depth + 1, start: $pos.start(), index: $pos.index(), count: $pos.parent.childCount, inner };
}

// 소리·동영상 플레이어에서 꾹 눌러도 옮기지 않는 곳 (설정 메뉴). 재생 막대는 밀면 감기, 꾹 누르면 옮기기 —
// 누르는 사이 감긴 재생 위치는 들어 올릴 때 되돌린다
export const MEDIA_SCRUB = '.plyr__menu__container';
const GRAB_TARGET = 'img.mk-image, .mk-ink, .mk-media, .mk-link-card, [data-link-card], a, .mk-math-block, hr';
// PC 에서 마우스를 올리면 복사 · 지우기 단추가 뜨는 "내용": 그림 · 손 메모 · 소리 · 동영상 · 링크 카드 · 파일 칩(PDF 등) ·
//   수식 블록 · 표 · 음성 카드 (글자 링크 · 글 속 수식 · 가로줄은 빼고 — 글을 읽는 데 방해되지 않게)
const HOVER_TARGET = 'img.mk-image, .mk-ink, .mk-media, .mk-link-card, [data-link-card], a[data-file], .mk-math-block, .mk-voice, .tableWrapper';
const NO_GRAB = '.plyr__controls, .plyr__control, button, input, select, textarea, [contenteditable="true"] [contenteditable="true"]';

/** 화면에서 누른 곳(target)이 옮길 수 있는 내용 줄이면 그 줄 */
export function blockFromTarget(view, target) {
  const t = target instanceof Element ? target : target?.parentElement;
  // 음성 카드의 접기 막대: 카드째로
  const bar = t?.closest('.mk-voice-bar');
  if (bar && view.dom.contains(bar)) return voiceCardOf(view, bar.closest('.mk-voice'));
  const host = t?.closest(GRAB_TARGET);
  if (!host || !view.dom.contains(host)) return null;
  // 소리·동영상 상자 안은 재생 막대(끌어서 감기)만 빼고 어디든 (단추는 짧게 누르면 단추 — editor.js mediaView)
  if (host.classList.contains('mk-media') ? t.closest(MEDIA_SCRUB) : t.closest(NO_GRAB)) return null;
  let pos;
  try {
    pos = view.posAtDOM(host, 0);
  } catch {
    return null;
  }
  const { doc } = view.state;
  for (const p of [pos, pos - 1]) {
    const n = p >= 0 ? doc.nodeAt(p) : null;
    // 통째로 잡는 줄: 링크 카드 · 수식 블록 · 가로줄
    if (n && (n.type.name === 'mk_link_card' || (n.isBlock && n.isAtom))) return blockInfo(doc, p, { kind: 'node', offset: -1 });
  }
  const $p = doc.resolve(Math.min(pos, doc.content.size));
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.name === 'mk_link_card') return blockInfo(doc, $p.before(d), { kind: 'node', offset: -1 });
    if (n.type.name !== 'paragraph') continue;
    if (!isContentParagraph(n)) return null;
    if (d >= 2 && isVoiceCard($p.node(d - 1))) return blockInfo(doc, $p.before(d - 1), { kind: 'text', offset: 1 });
    const isImage = doc.nodeAt(pos)?.type.name === 'image';
    return blockInfo(doc, $p.before(d), isImage ? { kind: 'node', offset: pos - $p.start(d) } : { kind: 'text', offset: 0 });
  }
  return null;
}

// 마우스를 올린 내용 상자 → 그 줄 (음성 카드는 카드째, 표는 표째, 그 밖은 blockFromTarget)
function hoverBlockOf(view, host) {
  if (host.classList.contains('mk-voice')) return voiceCardOf(view, host);
  if (host.classList.contains('tableWrapper')) {
    const table = host.querySelector('table');
    if (!table) return null;
    let pos;
    try {
      pos = view.posAtDOM(table, 0);
    } catch {
      return null;
    }
    const $p = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
    for (let d = $p.depth; d > 0; d--) {
      if ($p.node(d).type.name === 'table') return blockInfo(view.state.doc, $p.before(d), { kind: 'node', offset: -1 });
    }
    return null;
  }
  return blockFromTarget(view, host);
}

/** 지우기 · 복사 단추 이름에 쓰는 내용 이름: "이 표 지우기" · "이 파일 복사" */
export function contentKindName(node, dom) {
  const name = node.type.name;
  if (/list/.test(name)) return '목록';
  if (name === 'table') return '표';
  if (name === 'math_block') return '수식';
  if (name === 'mk_link_card') return '링크'; // 미리보기를 끄면 카드 없이 링크 한 줄이라 "링크" 로
  if (name === 'hr') return '가로줄';
  if (isVoiceCard(node)) return '음성';
  if (!(dom instanceof Element)) return '내용';
  if (dom.querySelector('.mk-ink')) return '손 메모';
  if (dom.querySelector('.mk-video')) return '동영상';
  if (dom.querySelector('.mk-media')) return '소리';
  if (dom.querySelector('img.mk-image')) return '그림';
  if (dom.querySelector('a[data-file]')) return '파일';
  if (dom.querySelector('.mk-link-card, [data-link-card]')) return '링크';
  return '내용';
}

// 화면의 음성 카드 상자 → 그 카드 줄
function voiceCardOf(view, dom) {
  if (!dom) return null;
  let found = null;
  view.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name === 'blockquote' && view.nodeDOM(pos) === dom) {
      found = pos;
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
  return found == null ? null : blockInfo(view.state.doc, found, { kind: 'text', offset: 1 });
}

/** 지우기 단추를 띄울 "내용" 줄: 그림·소리·파일 줄, 링크 카드·수식·가로줄, 음성 카드 */
export function isContentBlock(node) {
  return Boolean(node) && (isContentParagraph(node) || node.type.name === 'mk_link_card' || (node.isBlock && node.isAtom) || isVoiceCard(node));
}

// 꾹 눌러 옮길 글 줄: 누른 자리가 든 맨 바깥 줄 (목록 항목은 list-drag.js 가, 단추·체크 상자·음성 카드 막대는 그대로)
const NO_TEXT_GRAB = 'li, button, input, select, textarea, label, a, .mk-voice-bar, .plyr, .mk-tag, [data-tag]';
export function textBlockFromTarget(view, event) {
  const t = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!t || !view.dom.contains(t) || t === view.dom || t.closest(NO_TEXT_GRAB)) return null;
  const pt = pointOf(event);
  const hit = view.posAtCoords({ left: pt.clientX, top: pt.clientY });
  if (!hit) return null;
  return topBlockAt(view.state.doc, hit.inside >= 0 ? hit.inside : hit.pos, null);
}

// 상자 안의 줄 순서를 order(원래 번호들)로 바꾸고, 옮긴 줄(src)을 다시 고른다
export function reorderTr(state, block, order) {
  const parent = state.doc.resolve(block.pos).parent;
  const children = [];
  parent.forEach((c) => children.push(c));
  if (order.every((v, i) => v === i)) return null;
  const end = block.start + parent.content.size;
  const tr = state.tr.replaceWith(block.start, end, order.map((i) => children[i]));
  let at = block.start;
  for (const i of order) {
    if (i === block.index) break;
    at += children[i].nodeSize;
  }
  const { inner } = block;
  try {
    if (inner.kind === 'node' && inner.offset < 0) tr.setSelection(NodeSelection.create(tr.doc, at));
    else if (inner.kind === 'node') tr.setSelection(NodeSelection.create(tr.doc, at + 1 + inner.offset));
    else {
      const $p = tr.doc.resolve(Math.min(at + 1 + inner.offset, tr.doc.content.size));
      // 표·인용처럼 바로 글이 아닌 줄은 그 안의 가장 가까운 글 자리로
      tr.setSelection($p.parent.inlineContent ? TextSelection.create(tr.doc, $p.pos) : TextSelection.near($p));
    }
  } catch {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size))));
  }
  return tr.scrollIntoView();
}

/** 다시 고를 때 쓸 정보: 통째로 고르는 줄(그림 줄 말고 수식·가로줄·링크 카드)은 node, 나머지는 글 자리 */
const innerFor = (node, offset = 0) => (node?.isAtom ? { kind: 'node', offset: -1 } : { kind: 'text', offset: Math.max(0, offset) });

/** pos 가 든 맨 바깥 줄(본문의 블록 하나) — 손잡이·Alt+↑↓ 로 옮길 줄 */
export function topBlockAt(doc, pos, offset = null) {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  let at;
  if ($p.depth >= 1) at = $p.before(1);
  else if (doc.nodeAt($p.pos)) at = $p.pos;
  else return null;
  const node = doc.nodeAt(at);
  return blockInfo(doc, at, innerFor(node, offset ?? pos - at - 1));
}

// 한 줄 위(-1)·아래(+1) 줄과 맞바꾸기 (내용 줄이 아니면 커서가 든 맨 바깥 줄)
export function moveBlockBy(state, dispatch, dir) {
  const block = contentBlockAt(state) ?? topBlockAt(state.doc, state.selection.from);
  if (!block) return false;
  const other = block.index + dir;
  if (other < 0 || other >= block.count) return false;
  const tr = reorderTr(state, block, previewOrder(block.count, block.index, { kind: 'swap', index: other }));
  if (!tr) return false;
  dispatch?.(tr);
  return true;
}

// 마우스·터치 이벤트 이름과 좌표를 하나로 (list-drag.js 와 같은 기준)
const INPUT = {
  mouse: { move: 'mousemove', up: 'mouseup', cancel: null, hold: 0, tolerance: 4 },
  touch: { move: 'touchmove', up: 'touchend', cancel: 'touchcancel', hold: TOUCH_HOLD_MS, tolerance: 10 },
};
const pointOf = (e) => e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
const LISTEN = { capture: true, passive: false };
const HINT_KEY = 'memoking.hint.blockMove';
const COMPACT_H = 96; // 옮기는 동안 줄마다 이 높이까지만 보인다 (px) — note.css 의 .mk-block-compact-item 과 같게
const coarse = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;

// 끄는 내용이 갈 높이(화면 좌표): 터치는 지나가는 칸마다 보정 (core/drag-geometry.js — 어느 칸이든 손가락 약 40px),
// 마우스는 그대로. 스크롤된 만큼은 1배로 더하고, 화면 밖으로는 안 나가게
function virtualY(d) {
  const st = d.scroller?.scrollTop ?? 0;
  const base = d.c0 + (st - d.st0);
  const D = d.y - d.y0;
  const cy = d.kind === 'touch' ? warpDrag(base, D, d.tops, d.slots) : base + D;
  const r = !d.scroller || d.scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : d.scroller.getBoundingClientRect();
  return Math.min(r.bottom - 2, Math.max(r.top + 2, cy - st));
}

/** @param {{ readOnly?: boolean }} options */
// 휴대폰: 내용에 공유 · 저장 · 복사 · 지우기 단추를 띄운다 — 고를 시간을 넉넉히
//   짧게 누르기(탭): 그림 · 손 메모 · 소리/동영상/음성 카드의 이름 줄 (누르면 따로 하는 일이 없는 곳)
//   꾹 누르기(글 고치기 방식): 파일 칩 · 링크 카드 · 수식 — 짧게 누르면 열기 · 고치기라서
const TAP_TARGET = 'img.mk-image, .mk-ink, .mk-media-label';
const HOLD_TARGET = 'a[data-file], .mk-link-card, [data-link-card], .mk-math-block';
const TAP_MS = 400;
// 누르면 바로 열리던 것 → 단추 줄의 "열기" 단추가 그것을 대신 눌러 준다 (링크 카드는 안쪽 글 상자가 받는다)
const OPEN_TARGET = 'a[data-file], .mk-link-card, [data-link-card], .mk-math-block';
function openerOf(dom, kind) {
  const host = dom.matches(OPEN_TARGET) ? dom : dom.querySelector(OPEN_TARGET);
  if (!host) return null;
  const math = host.matches('.mk-math-block');
  return {
    label: math ? '이 수식 고치기' : host.matches('a[data-file]') && host.dataset.file === 'program' ? `이 ${kind} 실행` : `이 ${kind} 열기`,
    run: () => {
      const at = host.querySelector('.lc-main, .lc-plain') ?? host; // 미리보기를 끄면 카드 대신 링크 글자(.lc-plain)
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      e.mkOpen = true;
      at.dispatchEvent(e);
    },
  };
}
// 메모 밖으로 끌어낼 수 있는 내용(파일이 있는 것): 그림 · 손 메모 · 파일 칩 · 소리/동영상 · 음성 카드
const DRAG_OUT_HOST = 'img.mk-image, .mk-ink img, a[data-file], .mk-media-label';
/** 끌어낼 내용이면 받는 쪽에 보일 이름과 함께 { name } (아니면 null) — 칩은 칩에 적힌 이름 그대로, 그림 · 영상은 설명 글(alt) */
function dragOutInfo(dom, from = null) {
  if (!(dom instanceof Element)) return null;
  const host = from ?? (dom.matches(DRAG_OUT_HOST) ? dom : dom.querySelector(DRAG_OUT_HOST));
  if (!host && !dom.matches('.mk-voice')) return null;
  const chip = host?.closest('a[data-file]');
  const alt = host?.getAttribute?.('alt') || host?.closest?.('.mk-media')?.querySelector('.mk-media-label')?.textContent || '';
  return { name: (chip ? chip.textContent : alt).replace(/^동영상\s+/, '').trim() };
}
const HOLD_SHOW_MS = 450;
const CLICK_MAX_MS = 350; // PC: 이보다 오래 누른 채면 "클릭" 이 아니라 옮기기 · 고르기 — 열지 않는다
const TAP_SHOW_MS = 5000;

/** 누른 곳이 스크롤 상자(표를 감싼 상자 등)의 스크롤바인가 — 스크롤바를 잡아 끄는 동안 줄 옮기기가 시작되지 않게 */
function onScrollbar(event) {
  const el = event.target;
  if (!(el instanceof Element)) return false;
  const r = el.getBoundingClientRect();
  const x = event.clientX - r.left;
  const y = event.clientY - r.top;
  return (el.scrollHeight > el.clientHeight && el.offsetHeight - el.clientHeight - 2 * el.clientTop > 4 && y >= el.clientTop + el.clientHeight && y < el.offsetHeight)
    || (el.scrollWidth > el.clientWidth && el.offsetWidth - el.clientWidth - 2 * el.clientLeft > 4 && x >= el.clientLeft + el.clientWidth && x < el.offsetWidth);
}

export function createBlockMove({ readOnly = false } = {}) {
  let mover = null;
  let tap = null;
  let hold = null; // 꾹 누르기 { timer }

  // 꾹 눌러 단추를 띄웠으면 손을 뗄 때 오는 열기(click) · 길게 누르기 메뉴는 막는다
  //   (열기(click)는 Mover.onOpenClick 이 늘 막는다 — 단추가 떠 있으면 그대로 둔다)
  const swallowOpen = (view) => {
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    view.dom.addEventListener('contextmenu', stop, { capture: true, once: true });
    setTimeout(() => view.dom.removeEventListener('contextmenu', stop, { capture: true }), 1500);
  };
  const cancelHold = () => {
    clearTimeout(hold?.timer);
    hold = null;
  };
  return new Plugin({
    key: blockMoveKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, old) => tr.getMeta(blockMoveKey) ?? (tr.docChanged ? DecorationSet.empty : old.map(tr.mapping, tr.doc)),
    },
    props: {
      decorations: (state) => blockMoveKey.getState(state),
      handleKeyDown(view, event) {
        if (readOnly || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
        const moved = moveBlockBy(view.state, view.dispatch, event.key === 'ArrowUp' ? -1 : 1);
        if (moved) mover?.flash();
        return moved;
      },
      handleDOMEvents: readOnly ? {} : {
        mousedown(view, event) {
          if (!canDrag()) return false; // 글 고치기 방식: 내용을 눌러도 옮기지 않는다
          if (onScrollbar(event)) return false; // 표의 가로 스크롤바를 잡는 중에는 옮기지 않는다
          if (event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) mover?.press(event, 'mouse');
          return false; // 그냥 누르면 지금처럼 (고르기·열기)
        },
        touchstart(view, event) {
          keyboardFor(view, event.target);
          // 짧게 눌렀다 떼면(탭) 그림 · 손 메모에 저장 · 복사 · 지우기 단추 — 글 고치기 방식에서도 (touchend)
          const t = event.touches[0];
          tap = event.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, at: Date.now(), target: event.target } : null;
          cancelHold();
          if (!canDrag()) {
            // 글 고치기: 파일 칩 · 링크 카드 · 수식은 꾹 눌러 단추 (옮기기 방식에서는 꾹 누르면 들어 올림)
            const host = tap && event.target instanceof Element ? event.target.closest(HOLD_TARGET) : null;
            const block = host && view.dom.contains(host) ? blockFromTarget(view, host) : null;
            if (block && isContentBlock(block.node) && touchMode() === 'edit') {
              hold = { x: t.clientX, y: t.clientY };
              hold.timer = setTimeout(() => {
                hold = null;
                tap = null;
                if (view.isDestroyed || mover?.busy()) return;
                haptic(12);
                swallowOpen(view);
                mover?.showDelete(block, { showMs: TAP_SHOW_MS });
              }, HOLD_SHOW_MS);
            }
            return false;
          }
          if (event.touches.length === 1) mover?.press(event, 'touch');
          else mover?.cancelPress();
          return false; // 그냥 누르면 고르기, 밀면 스크롤
        },
        touchmove(_view, event) {
          const t = event.touches[0];
          if (hold && (!t || Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > 10)) cancelHold(); // 밀면 스크롤
          return false;
        },
        touchend(view, event) {
          cancelHold();
          const t0 = tap;
          tap = null;
          const t = event.changedTouches?.[0];
          if (!t0 || !t || !mover || mover.busy() || touchMode() === 'draw' || Date.now() - t0.at > TAP_MS) return false;
          if (Math.hypot(t.clientX - t0.x, t.clientY - t0.y) > 10) return false;
          const opens = t0.target instanceof Element ? t0.target.closest(HOLD_TARGET) : null;
          const host = t0.target instanceof Element ? t0.target.closest(TAP_TARGET) ?? opens : null;
          if (!host || !view.dom.contains(host)) return false;
          const block = blockFromTarget(view, host);
          if (!block || !isContentBlock(block.node)) return false;
          // 파일(PDF 등) · 링크 카드 · 수식: 누르자마자 열리지 않고 단추부터 — 여는 것은 단추 줄의 "열기"로 (click 은 onOpenClick 이 막는다)
          // 한 번 누른 손 메모를 또 누르면 이어 그리기로 넘어가니 단추를 다시 띄우지 않는다
          if (host.matches('.mk-ink.mk-ink-armed') || t0.target.closest?.('.mk-ink-edit')) return false;
          // 편집기가 누른 그림을 고르고 난 뒤에 (고르기가 바뀌면 단추가 거둬지므로)
          setTimeout(() => !view.isDestroyed && !mover.busy() && mover.showDelete(block, { showMs: TAP_SHOW_MS }), 60);
          return false;
        },
        dragstart(_view, event) {
          // 휴대폰 글 고치기: 그림·글을 브라우저 끌어 놓기로 옮기지 않는다 (옮기기는 다이얼의 옮기기 방식에서만)
          if (touchMode() === 'edit') {
            event.preventDefault();
            return true;
          }
          if (!mover?.busy()) return false;
          event.preventDefault(); // 브라우저 그림 끌어 놓기 대신 줄 옮기기
          return true;
        },
      },
    },
    view: (view) => {
      if (readOnly) return {};
      mover = new Mover(view);
      return mover;
    },
  });
}

class Mover {
  constructor(view) {
    this.view = view;
    this.pressing = null;
    this.drag = null;
    this.hint = null;
    this.lastBlock = null;
    // 재생 막대는 플레이어(RangeTouch)가 손가락이 닿는 순간 기본 동작을 막아 편집기에는 오지 않는다 —
    // 그 전에(잡는 단계) 직접 받아 꾹 누르기를 잰다
    this.onScrubTouch = (e) => {
      if (!canDrag() || e.touches.length !== 1 || !(e.target instanceof Element) || !e.target.closest('.mk-media input, .mk-media .plyr__progress')) return;
      keyboardFor(view, e.target);
      this.press(e, 'touch');
    };
    view.dom.addEventListener('touchstart', this.onScrubTouch, { capture: true, passive: true });
    // 목록 항목을 더 오래 누르면 list-drag.js 가 목록 전체(맨 바깥 줄)를 여기에 넘긴다
    this.onLiftRequest = (e) => {
      const { pos, x, y, kind } = e.detail ?? {};
      e.detail.ok = this.liftAt(pos, x, y, kind);
    };
    view.dom.addEventListener('mk-lift-block', this.onLiftRequest);
    // 휴대폰: 누르면 바로 열리던 내용(파일 칩 · 링크 카드 · 수식 — 한 줄을 차지하는 것)은 눌러도 열지 않고 단추 줄을 띄운다
    //   여는 것은 단추 줄의 "열기"로 (짧게 누르면). 글 사이에 낀 파일 링크는 그대로 열린다.
    //   PC 는 단추 줄이 없으니(오른쪽 클릭 메뉴) 눌러서 바로 열린다 — 메뉴에도 "열기"
    if (!canContentMenu()) {
      this.onOpenClick = (e) => {
        if (e.mkOpen || e.button !== 0) return;
        const host = e.target instanceof Element ? e.target.closest(OPEN_TARGET) : null;
        if (!host || !view.dom.contains(host) || e.target.closest('.lc-remove')) return;
        const block = blockFromTarget(view, host);
        if (!block || !isContentBlock(block.node)) return;
        e.preventDefault();
        e.stopPropagation();
        // 이미 이 내용의 단추가 떠 있으면 그대로
        const dom = view.nodeDOM(block.pos);
        const shown = this.shownTarget && deleteShownFor(this.shownTarget) && (this.shownTarget === dom || (dom instanceof Element && dom.contains(this.shownTarget)));
        if (!shown && !this.busy()) this.showDelete(block, { showMs: TAP_SHOW_MS });
      };
      view.dom.addEventListener('click', this.onOpenClick, true);
    }
    // PC: 열리는 내용(파일 칩 · 링크 카드 · 수식)은 짧게 눌렀다 뗄 때만 연다 — 오래 누르고 있다 떼면(옮기려다 만 것 등) 열지 않는다
    if (canContentMenu()) {
      let downAt = 0;
      this.onOpenDown = (e) => {
        downAt = e.button === 0 && e.target instanceof Element && e.target.closest(OPEN_TARGET) ? Date.now() : 0;
      };
      this.onLongClick = (e) => {
        if (e.mkOpen || e.button !== 0 || !downAt) return;
        const held = Date.now() - downAt;
        downAt = 0;
        if (held <= CLICK_MAX_MS || !(e.target instanceof Element) || !e.target.closest(OPEN_TARGET)) return;
        e.preventDefault();
        e.stopPropagation();
      };
      view.dom.addEventListener('mousedown', this.onOpenDown, true);
      view.dom.addEventListener('click', this.onLongClick, true);
    }
    // PC: 내용(그림 · 손 메모 · 소리 · 동영상 · 파일 · 링크 카드 · 수식 · 표)을 오른쪽 클릭하면 Windows 11 메뉴처럼 맨 위 한 줄에
    //   아이콘(복사 · 저장 · 공유 · 지우기)이 있는 메뉴 (ctx-menu.js). 예전에는 마우스를 올리면 단추가 떠서 표 칸을 가렸다.
    //   표는 칸 안에서 글을 고치므로 메뉴 아래에 글 항목(잘라내기 · 복사 · 붙여넣기 …)과 표 바꾸기도 함께.
    //   글을 고른 채 그림 위를 누르면 글 메뉴가 맞으므로 그대로 둔다 (네이티브 메뉴)
    if (canContentMenu()) {
      this.onContextMenu = (e) => {
        if (this.busy() || e.defaultPrevented || isContextMenuOpen()) return;
        const { selection } = view.state;
        let host = e.target instanceof Element ? e.target.closest(HOVER_TARGET) : null;
        // 키보드(Shift+F10 · 메뉴 키): 고른(NodeSelection) 그림 · 파일 등, 또는 커서가 있는 표
        let at = null;
        if (!host) {
          let dom = null;
          if (selection instanceof NodeSelection) dom = view.nodeDOM(selection.from);
          else {
            const t = tableAt(view.state);
            dom = t ? view.nodeDOM(t.pos) : null;
          }
          host = dom instanceof Element ? (dom.matches(HOVER_TARGET) ? dom : dom.querySelector(HOVER_TARGET)) : null;
          if (host) {
            let c = null;
            try {
              c = view.coordsAtPos(selection.head);
            } catch {
              c = null;
            }
            const r = host.getBoundingClientRect();
            at = c ? { x: Math.round(c.left), y: Math.round(c.bottom + 4) } : { x: Math.round(r.left + 8), y: Math.round(r.top + 8) };
          }
        }
        if (!host || !view.dom.contains(host)) return;
        const block = hoverBlockOf(view, host);
        const isTable = block?.node.type.name === 'table';
        if (!block || !(isContentBlock(block.node) || isTable)) return;
        // 그림 · 파일 위에서 글을 고른 채면 글 메뉴 (표는 칸의 글을 고른 채여도 이 메뉴가 글 항목을 함께 가진다)
        if (!isTable && !selection.empty && !(selection instanceof NodeSelection) && selection.from < block.pos + block.node.nodeSize && selection.to > block.pos) return;
        const opts = this.deleteOpts(block);
        if (!opts) return;
        e.preventDefault();
        e.stopPropagation();
        if (isTable) this.prepareTableMenu(block, e, Boolean(at));
        showContentMenu(view, { ...opts, ...(isTable ? this.tableMenuItems() : {}) }, at ?? { x: e.clientX, y: e.clientY });
      };
      view.dom.addEventListener('contextmenu', this.onContextMenu, true);
    }
    // PC: 그림 · 파일 칩 · 소리 · 동영상을 잡고 메모 밖(탐색기 · 바탕화면 · 카카오톡)으로 끌면 그 파일이 복사돼 간다
    //   (메모 안에서 순서를 바꾸는 것은 꾹 눌러 들어 올리기 — block-move 가 따로 한다. 이 끌기는 창 밖 프로그램용)
    if (canDragOut()) {
      this.onDragStart = (e) => {
        if (this.busy() || e.defaultPrevented) return;
        const host = e.target instanceof Element ? e.target.closest('img.mk-image, .mk-ink img, a[data-file], .mk-media-label') : null;
        if (!host || !view.dom.contains(host)) return;
        const block = blockFromTarget(view, host);
        if (!block || !isContentBlock(block.node)) return;
        const dom = view.nodeDOM(block.pos);
        e.preventDefault(); // 편집기 안에서 옮기는 기본 끌기 대신 (옮기기는 꾹 누르기)
        e.stopPropagation();
        hideDeleteButton(true);
        dragOutBlock(view, block.pos, block.node, dom instanceof Element ? dom : host, dragOutInfo(dom, host)?.name ?? '').catch((err) => console.warn('끌어내기', err));
      };
      view.dom.addEventListener('dragstart', this.onDragStart, true);
    }
  }

  /** 그 자리의 맨 바깥 줄을 바로 들어 올린다 (누르고 있는 손가락·마우스 그대로 이어서 끈다) */
  liftAt(pos, x, y, kind) {
    if (this.drag || pos == null) return false;
    const block = topBlockAt(this.view.state.doc, pos, null);
    if (!block || block.count < 2) return false;
    this.cancelPress();
    this.hideDelete(true);
    this.lift({ block, kind, text: true, x, y, x2: x, y2: y });
    if (this.drag) this.drag.whole = true;
    return Boolean(this.drag);
  }

  busy() {
    return Boolean(this.pressing || this.drag);
  }

  // ---------- 누르기 → 들어 올리기 ----------

  press(event, kind) {
    const { view } = this;
    if (this.drag) return;
    if (!persistentShown()) this.hideDelete(); // 표를 고치는 동안 표 위 단추는 눌러도 그대로 (휴대폰)
    let block = blockFromTarget(view, event.target);
    // 내용 줄이 아니면 글 줄(문단·제목·표·코드·인용·음성 카드): 꾹 눌러야 들어 올린다
    const text = !block;
    if (text) block = textBlockFromTarget(view, event);
    if (!block || block.count < 2) return;
    this.cancelPress();
    const io = INPUT[kind];
    const pt = pointOf(event);
    const p = { block, kind, text, x: pt.clientX, y: pt.clientY, x2: pt.clientX, y2: pt.clientY };
    const media = event.target instanceof Element ? event.target.closest('.mk-media')?.querySelector('audio, video') : null;
    if (media) p.media = { el: media, time: media.currentTime };
    this.pressing = p;
    p.move = (e) => {
      const q = pointOf(e);
      p.x2 = q.clientX;
      p.y2 = q.clientY;
      const far = Math.hypot(q.clientX - p.x, q.clientY - p.y) > io.tolerance;
      if (!far) return;
      if (kind === 'mouse' && !p.text) {
        // 마우스는 누른 채 움직이면 바로 들어 올림 (글자 고르기와 겹치지 않는 내용이므로)
        e.preventDefault();
        this.cancelPress({ keepMark: true });
        this.lift(p);
      } else this.cancelPress(); // 터치는 꾹 누르기 전에 밀면 스크롤
    };
    p.up = () => {
      this.cancelPress();
      // 누르는 동안에는 안내를 미뤘으므로 손을 뗀 뒤에 — 휴대폰 옮기기 방식은 글을 고를 수 없어 누른 줄로 알려 준다
      this.hintIfNew(p.block);
    };
    window.addEventListener(io.move, p.move, LISTEN);
    window.addEventListener(io.up, p.up, LISTEN);
    if (io.cancel) window.addEventListener(io.cancel, p.up, LISTEN);
    if (kind === 'touch' || text) {
      // 누르고 있는 동안 테두리가 점점 진해지고, 다 되면 들어 올림
      p.markTimer = setTimeout(() => {
        if (this.pressing !== p) return;
        p.marked = true;
        this.decorate([{ pos: block.pos, cls: 'mk-block-pressing' }]);
      }, 80);
      p.timer = setTimeout(() => {
        if (this.pressing !== p) return;
        this.cancelPress({ keepMark: true });
        haptic(12);
        if (p.media && p.media.el.currentTime !== p.media.time) p.media.el.currentTime = p.media.time; // 재생 막대를 눌러 감긴 것 되돌리기
        if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
        this.lift(p);
      }, holdFor(text ? (kind === 'touch' ? TOUCH_HOLD_MS : HOLD_MS) : io.hold));
    }
  }

  cancelPress({ keepMark = false } = {}) {
    const p = this.pressing;
    if (!p) return;
    this.pressing = null;
    clearTimeout(p.timer);
    clearTimeout(p.markTimer);
    const io = INPUT[p.kind];
    window.removeEventListener(io.move, p.move, LISTEN);
    window.removeEventListener(io.up, p.up, LISTEN);
    if (io.cancel) window.removeEventListener(io.cancel, p.up, LISTEN);
    if (p.marked && !keepMark && !this.view.isDestroyed) this.decorate([]);
  }

  lift(p) {
    holdKeyboard(this.view); // 옮기는 동안 키보드는 절대 뜨지 않게
    hideDeleteButton(true); // (표를 고치는 동안 떠 있던 단추도 옮기는 동안은 거둔다 — 놓으면 update 가 다시 띄운다)
    const { view } = this;
    // 누른 사이 문서가 바뀌었을 수 있으니 같은 자리의 줄을 다시 찾는다
    const block = blockInfo(view.state.doc, p.block.pos, p.block.inner);
    if (!block || block.count < 2) return;
    const parent = view.state.doc.resolve(block.pos).parent;
    const positions = [];
    let q = block.start;
    parent.forEach((c) => {
      positions.push(q);
      q += c.nodeSize;
    });
    let doms = positions.map((x) => view.nodeDOM(x));
    if (doms.some((d) => !(d instanceof Element))) return;
    getSelection()?.removeAllRanges();
    const scroller = scrollerOf(view.dom);
    // 옮기는 동안은 모든 줄을 짧게 접는다 (그림은 작은 썸네일, 긴 글·표는 첫 부분만) — 앞뒤 내용이 커도
    // 한 칸 옮기는 데 손가락을 조금만 움직이면 되게. 놓으면 원래 크기로
    const before = doms.map((el) => el.getBoundingClientRect().height);
    const srcBefore = doms[block.index].getBoundingClientRect();
    const ratio = srcBefore.height ? Math.min(1, Math.max(0, (p.y - srcBefore.top) / srcBefore.height)) : 0.5;
    const compactCls = (i) => `mk-block-compact-item${before[i] > COMPACT_H ? ' mk-block-clipped' : ''}`;
    document.body.classList.add('mk-block-compact');
    this.decorate(positions.map((pos, i) => ({ pos, cls: `${i === block.index ? 'mk-block-lift' : 'mk-block-sorting'} ${compactCls(i)}` })));
    doms = positions.map((x) => view.nodeDOM(x));
    // 접힌 뒤에도 들어 올린 줄이 손가락 아래에 있게 스크롤을 맞춘다
    if (scroller) {
      const r = doms[block.index].getBoundingClientRect();
      scroller.scrollTop += r.top - (p.y - ratio * r.height);
    }
    const st = scroller?.scrollTop ?? 0;
    const rects = doms.map((d) => d.getBoundingClientRect());
    const tops = rects.map((r) => r.top + st);
    const heights = rects.map((r) => r.height);
    const slots = tops.map((t, i) => (i < tops.length - 1 ? tops[i + 1] - t : heights[i]));
    const src = doms[block.index];
    const scale = src.offsetHeight ? heights[block.index] / src.offsetHeight : 1;
    this.hideHint();
    // 틀(들어 올린 것 · 맞바꿀 상대 · 넣을 자리)과 안내 캡슐은 화면 위 한 겹에 — 틀은 줄마다 내용 크기에 맞춘다
    // (사진 줄은 사진에, 글 줄은 글 폭에 — note.css 가 접는 동안 글 줄을 글 폭만큼만 차지하게 한다)
    const frames = new DragFrames(view.dom);
    const d = {
      frames, lefts: rects.map((r) => r.left), widths: rects.map((r) => r.width), compactCls, ratio,
      // 끄는 시작점 = 접힌 줄에서 누른 자리 (스크롤로 손가락 아래에 다 맞추지 못했어도(맨 위 등) 손가락이 움직인 만큼만 옮긴다)
      c0: tops[block.index] + ratio * heights[block.index], st0: st,
      gain: p.kind === 'touch' ? slotGain(slots[block.index]) : 1, lastKey: '', lastCy: null,
      block, positions, tops, heights, slots, scale, scroller, drop: null, kind: p.kind,
      x: p.x2, y: p.y2, x0: p.x2, y0: p.y2, raf: 0, timer: 0,
    };
    this.drag = d;
    document.body.classList.add('mk-block-dragging');
    document.body.dataset.dragGain = d.gain.toFixed(2); // 점검용 · 보정 배율
    if (p.kind === 'touch') haptic(15);
    this.judge();

    const io = INPUT[p.kind];
    d.move = (e) => {
      if (!this.drag) return;
      e.preventDefault(); // 터치: 스크롤 대신 끌기
      e.stopPropagation(); // 편집기의 글자 고르기 늘리기를 막는다
      const pt = pointOf(e);
      if (this.tryDragOut(d, pt)) return;
      d.x = pt.clientX;
      d.y = pt.clientY;
      if (!d.raf) {
        d.raf = requestAnimationFrame(() => {
          d.raf = 0;
          if (this.drag === d) this.judge();
        });
      }
    };
    d.up = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pt = pointOf(e);
      d.x = pt.clientX;
      d.y = pt.clientY;
      this.judge();
      this.finish(true);
    };
    d.cancel = () => this.finish(false);
    d.key = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.finish(false);
    };
    d.stop = (e) => e.preventDefault();
    window.addEventListener(io.move, d.move, LISTEN);
    window.addEventListener(io.up, d.up, LISTEN);
    if (io.cancel) window.addEventListener(io.cancel, d.cancel, LISTEN);
    window.addEventListener('keydown', d.key, true);
    window.addEventListener('selectstart', d.stop, true);
    window.addEventListener('contextmenu', d.stop, true);
    // 위·아래 끝 가까이에서는 저절로 스크롤 (가까울수록 빠르게)
    d.timer = setInterval(() => {
      if (this.drag !== d || !d.scroller) return;
      const r = d.scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : d.scroller.getBoundingClientRect();
      const dy = edgeScroll(virtualY(d), r.top, r.bottom, 48); // 끄는 내용(보정한 자리)이 가장자리에 닿으면
      if (dy) {
        d.scroller.scrollTop += dy;
        this.judge();
      }
    }, 30);
  }

  /**
   * PC: 들어 올린 내용을 잡은 채 마우스가 창 밖으로 나가면 순서 바꾸기는 접고, 그 파일을 탐색기 · 바탕화면 · 카카오톡 같은
   * 다른 프로그램으로 끌어낸다 (복사본이 간다 — 메모의 것은 그대로). 파일이 없는 내용(글 · 수식 · 링크 카드)은 해당 없음
   */
  tryDragOut(d, pt) {
    if (d.kind !== 'mouse' || !canDragOut() || d !== this.drag) return false;
    const m = 2;
    if (pt.clientX > -m && pt.clientY > -m && pt.clientX < window.innerWidth + m && pt.clientY < window.innerHeight + m) return false;
    const { view } = this;
    const block = blockInfo(view.state.doc, d.block.pos, d.block.inner);
    const dom = block ? view.nodeDOM(block.pos) : null;
    const info = block && isContentBlock(block.node) ? dragOutInfo(dom) : null;
    if (!info) return false;
    this.finish(false); // 들어 올린 것을 제자리에 내려놓고
    hideDeleteButton(true);
    dragOutBlock(view, block.pos, block.node, dom, info.name).catch((err) => console.warn('끌어내기', err));
    return true;
  }

  // ---------- 끄는 동안: 어디에 놓일지 판정 · 미리 보기 ----------

  judge() {
    const d = this.drag;
    if (!d) return;
    const cy = virtualY(d) + (d.scroller?.scrollTop ?? 0);
    const n = d.tops.length;
    const s = d.block.index;
    let drop;
    if (cy < d.tops[0]) drop = { kind: 'insert', index: 0 };
    else if (cy > d.tops[n - 1] + d.heights[n - 1]) drop = { kind: 'insert', index: n };
    else {
      let k = d.tops.findIndex((t, i) => cy < t + d.slots[i]);
      if (k < 0) k = n - 1;
      drop = dropAt(k, Math.min(1, Math.max(0, (cy - d.tops[k]) / Math.max(1, d.heights[k]))));
    }
    const same = drop.kind === 'swap' ? drop.index === s : drop.index === s || drop.index === s + 1;
    const next = same ? null : drop;
    const key = next ? `${next.kind}:${next.index}` : '';
    if (key !== d.lastKey) {
      // 경계 근처의 작은 떨림으로는 바꾸지 않는다
      if (d.lastCy != null && Math.abs(cy - d.lastCy) < HYSTERESIS_PX) return this.preview();
      d.lastKey = key;
      d.lastCy = cy;
      d.drop = next;
      if (d.kind === 'touch' && next) haptic(6); // 놓을 자리가 바뀔 때 톡
    } else d.lastCy = d.lastCy ?? cy;
    this.preview();
  }

  // 끄는 줄은 손을 따라오고, 다른 줄들은 놓았을 때의 자리로 미끄러진다. 틀·안내 캡슐도 함께
  preview() {
    const d = this.drag;
    const { tops, slots, positions, heights, scale, lefts, widths, frames } = d;
    const s = d.block.index;
    const st = d.scroller?.scrollTop ?? 0;
    const order = previewOrder(positions.length, s, d.drop);
    const bottom = tops.at(-1) + heights.at(-1);
    let follow = virtualY(d) + st - (tops[s] + d.ratio * heights[s]);
    follow = Math.min(bottom - heights[s] + 8, Math.max(tops[0] - 8, tops[s] + follow)) - tops[s];
    const box = (i, top) => ({ left: lefts[i], top: top - st, width: widths[i], height: heights[i] });
    const specs = [];
    let y = tops[0];
    let slot = null;
    let target = null;
    order.forEach((i) => {
      if (i === s) {
        // 놓으면 갈 자리(다른 줄들이 비켜 연 틈)에 점선 칸 — 맞바꾸기면 맞바꿀 줄에도 보라 점선 틀
        if (d.drop) slot = box(s, y);
        specs.push({ pos: positions[i], cls: `mk-block-lift ${d.compactCls(i)}`, style: `transform: translateY(${(follow / scale).toFixed(1)}px)` });
      } else {
        const dy = y - tops[i];
        const swap = d.drop?.kind === 'swap' && i === d.drop.index;
        if (swap) target = box(i, y);
        const cls = ['mk-block-sorting', d.compactCls(i), swap ? 'mk-block-swap-target' : ''].filter(Boolean).join(' ');
        specs.push({ pos: positions[i], cls, style: dy ? `transform: translateY(${(dy / scale).toFixed(1)}px)` : '' });
      }
      y += slots[i];
    });
    this.decorate(specs);
    frames.set('lift', box(s, tops[s] + follow));
    frames.set('target', target);
    frames.set('slot', slot);
    const kind = d.drop?.kind ?? null;
    frames.label(kind, kind === 'swap' ? '⇅ 맞바꾸기' : kind === 'insert' ? '↳ 여기에 넣기' : '', { x: d.x, y: d.y }, d.kind);
  }

  finish(commit) {
    const d = this.drag;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    clearInterval(d.timer);
    const io = INPUT[d.kind];
    window.removeEventListener(io.move, d.move, LISTEN);
    window.removeEventListener(io.up, d.up, LISTEN);
    if (io.cancel) window.removeEventListener(io.cancel, d.cancel, LISTEN);
    window.removeEventListener('keydown', d.key, true);
    window.removeEventListener('selectstart', d.stop, true);
    window.removeEventListener('contextmenu', d.stop, true);
    d.frames.destroy();
    document.body.classList.remove('mk-block-dragging', 'mk-block-compact');
    delete document.body.dataset.dragGain;
    this.drag = null;
    // 끈 뒤 따라오는 클릭(파일 열기·링크 열기)은 먹는다
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 400);
    const { view } = this;
    if (view.isDestroyed) return;
    this.decorate([]);
    // 꾹 눌러 들어 올렸다가 그 자리에 놓으면(옮기지 않음): 내용이면 오른쪽 위에 지우기 단추
    if (commit && !d.drop && Math.hypot(d.x - d.x0, d.y - d.y0) < 14) {
      const block = blockInfo(view.state.doc, d.block.pos, d.block.inner);
      // 목록 전체를 들어 올렸다 놓은 경우도 (목록 항목을 더 오래 눌러 넘어온 것)
      if (block && (isContentBlock(block.node) || (d.whole && /list/.test(block.node.type.name)))) this.showDelete(block);
      return;
    }
    if (commit && d.drop) {
      const block = blockInfo(view.state.doc, d.block.pos, d.block.inner) ?? d.block;
      const tr = reorderTr(view.state, block, previewOrder(d.positions.length, d.block.index, d.drop));
      if (tr) {
        view.dispatch(tr);
        this.flash();
      }
    }
  }

  // ---------- 지우기 단추: 꾹 눌렀다 놓은 내용의 오른쪽 위 (delete-button.js) ----------

  showDelete(block, { showMs } = {}) {
    const opts = this.deleteOpts(block, showMs);
    if (opts) showDeleteButton(this.view, opts);
  }

  /** 내용 단추 줄(휴대폰) · 오른쪽 클릭 메뉴(PC)에 넘길 것 (showDeleteButton · showContentMenu) */
  deleteOpts(block, showMs) {
    const { view } = this;
    const dom = view.nodeDOM(block.pos);
    if (!(dom instanceof Element)) return null;
    const media = isContentParagraph(block.node) ? dom.querySelector('img.mk-image, .mk-ink, .mk-media, .mk-link-card, a[data-file]') : null;
    const deco = (spec) => {
      if (spec) this.decorate([{ pos: block.pos, ...spec }]);
      else if (!this.drag && !this.pressing) this.decorate([]);
    };
    const kind = contentKindName(block.node, dom);
    // 표는 편집기가 감싼 상자(.tableWrapper)에 단추를 붙인다 (표 막대 · 크기 손잡이와 같은 자리)
    const target = media ?? (block.node.type.name === 'table' ? dom.closest('.tableWrapper') ?? dom.querySelector('.tableWrapper') ?? dom : dom);
    this.shownTarget = target;
    const copyLabel = block.node.type.name === 'mk_link_card' ? '링크 주소 복사' : null; // 카드 모양이 아니라 주소를
    const opts = { pos: block.pos, node: block.node, target, markTarget: Boolean(media), deco, label: `이 ${kind} 지우기`, copyLabel, showMs, open: media || ['math_block', 'mk_link_card'].includes(block.node.type.name) ? openerOf(dom, kind) : null };
    // PC 메뉴: 파일 · 소리 · 그림 · 음성 카드는 보이는 이름을 바꿀 수 있다 (rename-content.js)
    if (canContentMenu() && renameTarget(view.state.doc, block.pos, block.node)) {
      opts.extraItems = [{ id: 'rename', label: '이름 변경…' }];
      opts.onExtra = (id) => id === 'rename' && this.renameAt(block.pos, block.node);
    }
    return opts;
  }

  /** PC 메뉴 › 이름 변경…: 이름 입력 창 → 칩 글자 · 그림 설명을 새 이름으로 */
  async renameAt(pos, node) {
    const { view } = this;
    const target = view.state.doc.nodeAt(pos) === node ? renameTarget(view.state.doc, pos, node) : null;
    if (!target) return;
    const input = await promptName({ title: target.kind === 'chip' ? '파일 이름 변경' : '이름 변경', value: target.name });
    if (input == null || view.isDestroyed) return;
    const name = cleanName(input, target.name, target.kind === 'chip');
    const fresh = view.state.doc.nodeAt(pos) === node ? renameTarget(view.state.doc, pos, node) : null; // 입력 창이 떠 있는 동안 문서가 바뀌었을 수 있다
    const done = name && fresh ? renameContent(view, fresh, name) : false;
    const say = (text, error = false) => window.dispatchEvent(new CustomEvent('mk:notice', { detail: { text, error } }));
    if (done === true) say(`이름을 "${name}" 으로 바꿨어요`);
    else if (done === 'kind') say('이 이름으로는 바꿀 수 없어요 — 영상 파일은 이름에 "영상" 이 있어야 하고, 소리 파일에는 "영상" · "동영상" · "video" 를 쓸 수 없어요', true);
    view.focus();
  }

  /** PC: 표를 오른쪽 클릭했을 때 — 커서가 그 표 밖이면 누른 칸으로 옮긴다 (아래 메뉴의 표 바꾸기 · 칸 글 항목이 그 표에 듣도록). 키보드로 연 것은 커서가 이미 표 안 */
  prepareTableMenu(block, e, byKey) {
    const { view } = this;
    const { selection, doc } = view.state;
    if (byKey || (selection.from > block.pos && selection.to < block.pos + block.node.nodeSize)) return;
    const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (hit) view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(hit.pos))));
  }

  /** PC: 표 메뉴의 글 항목(칸의 글 — 잘라내기 · 복사 · 붙여넣기 …)과 표 바꾸기 */
  tableMenuItems() {
    const sel = this.view.state.selection;
    return {
      extraItems: [
        { id: 'cut', label: '잘라내기', hint: 'Ctrl+X', disabled: sel.empty },
        { id: 'copy-text', label: '복사', hint: 'Ctrl+C', disabled: sel.empty },
        { id: 'paste', label: '붙여넣기', hint: 'Ctrl+V' },
        { id: 'paste-plain', label: '서식 없이 붙여넣기', hint: 'Ctrl+Shift+V' },
        ...(sel.empty ? [] : [{ id: 'clear-format', label: '서식 지우기', hint: 'Ctrl+\\' }]),
        { type: 'separator' },
        { id: 'toList', label: '표를 목록으로' },
        { id: 'toTask', label: '표를 체크리스트로' },
        { id: 'toText', label: '표를 글로' },
        { id: 'autoFit', label: '열 너비 맞춤' },
      ],
      // 글 항목은 메모 창(note.js)이 받아 편집기 · 메인에 넘기고, 표 바꾸기는 편집기의 표 명령으로
      onExtra: (id) => {
        const edit = ['cut', 'copy-text', 'paste', 'paste-plain', 'clear-format'].includes(id);
        window.dispatchEvent(new CustomEvent(edit ? 'mk:edit' : 'mk:table-command', { detail: { name: id } }));
      },
    };
  }

  /** 지금 커서가 든 표 → { pos, node, target } (표 위 단추가 같은 표를 따라가게) */
  followTable(view) {
    const t = tableAt(view.state);
    const dom = t ? view.nodeDOM(t.pos) : null;
    const target = dom instanceof Element ? dom.closest('.tableWrapper') ?? dom.querySelector('.tableWrapper') ?? dom : null;
    return target ? { pos: t.pos, node: t.node, target } : null;
  }

  /**
   * 휴대폰: 표를 고치는 동안(커서가 표 안) 복사 · 저장 · 공유 · 지우기 단추가 표 위 오른쪽 밖에 계속 떠 있다 —
   * 그림과 같은 단추를 표를 가리지 않는 자리에. PC 는 오른쪽 클릭 메뉴라 해당 없음
   */
  syncTableButtons() {
    const { view } = this;
    if (canContentMenu() || !view.editable || this.drag || this.pressing) return;
    const t = tableAt(view.state);
    if (!t) return;
    if (persistentShown()) return; // 이미 떠 있다 (hideDeleteIfChanged 가 같은 표를 따라간다)
    const block = blockInfo(view.state.doc, t.pos, { kind: 'node', offset: -1 });
    const opts = block ? this.deleteOpts(block) : null;
    if (opts) showDeleteButton(view, { ...opts, placement: 'above', persist: true, follow: (v) => this.followTable(v) });
  }

  hideDelete(now = false) {
    hideDeleteButton(now);
  }

  // 옮긴 줄이 잠깐 반짝여 어디로 갔는지 보여 준다
  flash() {
    const { view } = this;
    const block = contentBlockAt(view.state);
    if (!block) return;
    this.decorate([{ pos: block.pos, cls: 'mk-block-dropped' }]);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      if (!this.drag && !this.pressing && !view.isDestroyed) this.decorate([]);
    }, 700);
  }

  decorate(specs) {
    // 표시가 없던 채로 "표시 없음" 을 또 알리면 아무것도 하지 않는다 — 내용이 그대로인 트랜잭션도 표를 통째로 다시 그려
    //   (누르는 순간 보낸 것이면 표 칸의 첫 클릭이 사라졌다: 눌렀던 자리의 요소가 바뀌면 click · 글 고르기가 일어나지 않는다)
    if (!specs.length && !this.decorated) return;
    this.decorated = specs.length > 0;
    const { view } = this;
    const { doc } = view.state;
    const decos = [];
    for (const { pos, cls, style } of specs) {
      const node = doc.nodeAt(pos);
      if (!node) continue;
      const attrs = {};
      if (cls) attrs.class = cls;
      if (style) attrs.style = style;
      decos.push(Decoration.node(pos, pos + node.nodeSize, attrs));
    }
    view.dispatch(view.state.tr.setMeta(blockMoveKey, DecorationSet.create(doc, decos)).setMeta('addToHistory', false));
  }

  // ---------- 처음 한 번: 내용을 고르면 옮기는 방법 안내 ----------

  update(view, prev) {
    this.view = view;
    hideDeleteIfChanged(view);
    this.syncTableButtons();
    this.hintIfNew();
  }

  hintIfNew(pressed = null) {
    const { view } = this;
    if (this.drag || this.pressing || view.isDestroyed) return;
    if (!view.editable && !pressed) return; // 고칠 수 없을 때(옮기기 방식)는 누른 줄로만 — 고르기가 바뀌어도 안내를 지우지 않게
    const block = view.editable ? contentBlockAt(view.state) : pressed;
    const key = block ? `${block.pos}` : null;
    if (key === this.lastBlock) return;
    this.lastBlock = key;
    if (!block || block.count < 2) return this.hideHint();
    let seen = false;
    try {
      seen = localStorage.getItem(HINT_KEY) === '1';
    } catch {
      seen = true;
    }
    if (seen) return;
    const dom = view.nodeDOM(block.pos);
    if (!(dom instanceof Element)) return;
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // 다음에 또 보여도 괜찮다
    }
    this.hideHint();
    const hint = document.createElement('div');
    hint.className = 'mk-move-hint';
    hint.setAttribute('role', 'status');
    // 휴대폰 다이얼이 글 고치기면 옮기는 방법은 다이얼부터 (옮기기 방식에서는 짧게 눌러 끈다)
    hint.textContent = touchMode() === 'edit' ? '옮기려면 오른쪽 아래 다이얼을 옮기기로 돌려요'
      : touchMode() === 'move' ? '짧게 눌러 끌면 다른 줄로 옮겨요'
        : coarse() ? '꾹 눌러 끌면 다른 줄로 옮겨요' : '끌어서 다른 줄로 옮길 수 있어요 (Alt+↑↓)';
    document.body.append(hint);
    const r = dom.getBoundingClientRect();
    const w = hint.offsetWidth;
    hint.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)))}px`;
    // 내용이 넉넉하면 그 위 아래쪽에 얹고(다른 글을 가리지 않게), 작으면 바로 아래에
    const h = hint.offsetHeight;
    const top = r.height > h * 3 ? r.bottom - h - 12 : r.bottom + 8;
    hint.style.top = `${Math.round(Math.max(8, Math.min(window.innerHeight - h - 8, top)))}px`;
    this.hint = hint;
    this.hintTimer = setTimeout(() => this.hideHint(), 3600);
  }

  hideHint() {
    clearTimeout(this.hintTimer);
    this.hint?.remove();
    this.hint = null;
  }

  destroy() {
    this.view.dom.removeEventListener('touchstart', this.onScrubTouch, true);
    this.view.dom.removeEventListener('mk-lift-block', this.onLiftRequest);
    if (this.onOpenClick) this.view.dom.removeEventListener('click', this.onOpenClick, true);
    if (this.onOpenDown) {
      this.view.dom.removeEventListener('mousedown', this.onOpenDown, true);
      this.view.dom.removeEventListener('click', this.onLongClick, true);
    }
    if (this.onContextMenu) this.view.dom.removeEventListener('contextmenu', this.onContextMenu, true);
    if (this.onDragStart) this.view.dom.removeEventListener('dragstart', this.onDragStart, true);
    this.cancelPress();
    if (this.drag) this.finish(false);
    clearTimeout(this.flashTimer);
    this.hideHint();
    this.hideDelete(true);
  }
}

function scrollerOf(node) {
  for (let s = node?.parentElement; s; s = s.parentElement) {
    const oy = getComputedStyle(s).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && s.scrollHeight > s.clientHeight) return s;
  }
  return document.scrollingElement;
}

// 그림만 든 줄: 줄 높이·보이지 않는 줄바꿈이 만든 여백을 없애 칸(누를 때 테두리)이 그림만 감싸게
const imageOnly = (node) => isContentParagraph(node) && node.content.content.every((c) => c.type.name === 'image' || INLINE_CONTENT.has(c.type.name));
// 그림만 든 줄 안에 글자 커서가 놓이면(그림 옆을 누름 · 휴대폰에서 눌러 커서 두기) 그 그림을 통째로 고른다 —
// 커서가 그림 높이만큼 길게 깜빡이지 않게 (사진을 눌렀을 때와 같음). 소리·동영상 줄은 플레이어를 쓰므로 그대로
function pictureAtCursor(selection) {
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  const line = $from.parent;
  if (!imageOnly(line)) return null;
  const images = [];
  line.forEach((child, offset) => {
    if (child.type.name === 'image') images.push({ child, pos: $from.start() + offset });
  });
  if (!images.length || images.some(({ child }) => /^(audio|video)$/.test(mediaKindOf(child.attrs.src, child.attrs.alt)))) return null;
  // 커서 바로 앞이나 뒤의 그림 (줄 끝이면 마지막 그림)
  return images.find(({ pos, child }) => $from.pos <= pos + child.nodeSize) ?? images.at(-1);
}

// pos(줄 경계) 다음의 첫 글 줄에 커서 — 없으면 거기에 빈 줄을 만들어 (그림 옆에 글자가 붙지 않게)
function caretBelow(tr, pos) {
  const next = TextSelection.findFrom(tr.doc.resolve(pos), 1, true); // (Selection 의 정적 함수 — 번들은 TextSelection 만 내보냄)
  if (next) return tr.setSelection(next);
  tr.insert(pos, tr.doc.type.schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, pos + 1));
}

function writeBelowPicture(view, text) {
  if (!view.editable) return false;
  const sel = view.state.selection;
  const onPicture = sel instanceof NodeSelection ? sel.node.type.name === 'image' : Boolean(pictureAtCursor(sel)); // 글 고치기: 그림 줄의 커서
  if (!onPicture) return false;
  const $p = view.state.doc.resolve(sel.from);
  if (!imageOnly($p.parent) || $p.depth < 1) return false;
  const after = $p.after();
  const { schema } = view.state;
  const tr = view.state.tr.insert(after, schema.nodes.paragraph.create(null, text ? schema.text(text) : null));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1 + text.length)).scrollIntoView());
  return true;
}

export function createContentLines() {
  let cache = { doc: null, set: DecorationSet.empty };
  return new Plugin({
    key: new PluginKey('memoking-content-lines'),
    appendTransaction(trs, _old, state) {
      if (!trs.some((tr) => tr.selectionSet)) return null;
      const pic = pictureAtCursor(state.selection);
      if (!pic) return null;
      // 휴대폰 글 고치기: 그림을 고르지 않는다 (그림은 옮기기 방식에서만 다룬다). 커서는 그 자리에 두고 — 커서가 움직일 때마다
      //   문서를 고치면 안드로이드의 Enter 처리와 엇갈린다 — 그 줄에서 쓰기 시작하면 writeBelowPicture 가 아래 새 줄로 보낸다
      if (touchMode() === 'edit') return null;
      return state.tr.setSelection(NodeSelection.create(state.doc, pic.pos));
    },
    props: {
      // 휴대폰 글 고치기: 그림·링크 카드·파일·수식 같은 내용을 눌러도 골라지지(테두리) 않는다.
      //   눌러서 여는 동작(파일 열기·수식 고치기 등)은 각자의 click 으로 그대로 된다
      //   그림·카드처럼 줄을 차지하는 것은 누르면 커서를 그 아래 글 줄로 (바로 이어 쓸 수 있게)
      //   손 메모: 처음 누르면 복사·저장·지우기 단추와 아래 "이어 그리기"만 보이고(바로 넘어가면 단추를 누를 틈이 없다),
      //   단추가 떠 있는 동안 한 번 더 누르면 (또는 "이어 그리기"를 누르면) 이어 그리기
      handleClickOn(view, _pos, node, nodePos, event, direct) {
        if (!direct || touchMode() !== 'edit' || !node.isAtom || node.isText) return false;
        const ink = event.target instanceof Element ? event.target.closest('.mk-ink') : null;
        if (ink) {
          if (ink.classList.contains('mk-ink-armed')) {
            ink.classList.remove('mk-ink-armed');
            ink.querySelector('.mk-ink-edit')?.click();
          } else {
            ink.classList.add('mk-ink-armed');
            clearTimeout(ink.mkArmTimer);
            ink.mkArmTimer = setTimeout(() => ink.classList.remove('mk-ink-armed'), TAP_SHOW_MS);
          }
          return true;
        }
        const $n = view.state.doc.resolve(nodePos);
        const line = node.isBlock ? nodePos + node.nodeSize : imageOnly($n.parent) ? $n.after() : null;
        if (line != null) view.dispatch(caretBelow(view.state.tr, line).scrollIntoView());
        return true;
      },
      // 그림을 고른 채 Enter · 글자를 치면 그림을 바꿔치지 않고 그림 줄 아래 새 줄에서 쓴다
      handleKeyDown(view, e) {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.ctrlKey || e.metaKey) return false;
        return writeBelowPicture(view, '');
      },
      handleTextInput(view, _from, _to, text) {
        return writeBelowPicture(view, text);
      },
      handleDOMEvents: {
        // 한글 조합이 시작될 때도 (조합은 handleTextInput 을 거치지 않는다) 먼저 아래 새 줄로
        compositionstart: (view) => {
          writeBelowPicture(view, '');
          return false;
        },
      },
      decorations(state) {
        if (cache.doc === state.doc) return cache.set;
        const decos = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'paragraph') return true;
          if (imageOnly(node)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mk-image-line' }));
          return false;
        });
        cache = { doc: state.doc, set: DecorationSet.create(state.doc, decos) };
        return cache.set;
      },
    },
  });
}
