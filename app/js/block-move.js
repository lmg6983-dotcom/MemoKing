// 그림·소리·동영상·파일·링크 카드 같은 "내용" 줄 옮기기 (편집기 플러그인, 데스크탑·휴대폰 함께)
// 따로 손잡이·버튼 없이 내용 자체를 잡아 옮긴다 (목록·체크리스트 끌기와 같은 감각)
//   - 마우스: 내용을 누른 채 끌면 바로 들어 올려진다 (그냥 누르면 지금처럼 고르기·열기)
//   - 터치: 꾹(0.4초) 누르면 테두리가 진해지다 "톡" 들어 올려지고, 손가락을 떼지 않고 끈다 (그냥 밀면 스크롤)
//   - 끄는 줄은 손을 따라오고, 다른 줄들은 놓으면 될 자리로 미끄러져 틈을 연다.
//     다른 줄의 가운데 = 맞바꾸기, 줄과 줄 사이 = 끼우기 (손 옆에 ⇅ 맞바꾸기 / ↳ 여기에 넣기). Esc 취소
//   - 키보드: 내용을 고른 채 Alt+↑ / Alt+↓ 로 한 줄씩
//   - 처음 한 번, 내용을 고르면 옮기는 방법을 작은 안내로 알려 준다
//   - 줄 = 같은 상자(본문·인용·목록 항목) 안의 블록 하나
//   - 소리·동영상은 위의 이름 줄, 수식 블록·가로줄은 그대로 잡는다
//   - 글 문단·제목·표·코드 블록·인용·음성 카드는 목록 항목과 같은 방식: 글자를 꾹(마우스 0.3초·터치 0.4초) 누르면
//     테두리가 점점 진해지다 들어 올려진다 (그 전에 움직이면 지금처럼 글자 고르기·스크롤). 목록 항목은 list-drag.js
//     PC 는 어느 줄에서든 Alt+↑ / Alt+↓
import { holdKeyboard, keyboardFor, edgeScroll } from './keyboard-guard.js';
import { Plugin, PluginKey, TextSelection, NodeSelection, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { previewOrder, dropAt } from './core/list-order.js';
import { HOLD_MS, TOUCH_HOLD_MS } from './list-drag.js';
import { isVoiceCard } from './voice-card-view.js';

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

const GRAB_TARGET = 'img.mk-image, .mk-media, .mk-link-card, [data-link-card], a, .mk-math-block, hr';
const NO_GRAB = '.plyr__controls, .plyr__control, button, input, select, textarea, [contenteditable="true"] [contenteditable="true"]';

/** 화면에서 누른 곳(target)이 옮길 수 있는 내용 줄이면 그 줄 */
export function blockFromTarget(view, target) {
  const t = target instanceof Element ? target : target?.parentElement;
  const host = t?.closest(GRAB_TARGET);
  if (!host || !view.dom.contains(host) || t.closest(NO_GRAB)) return null;
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
  touch: { move: 'touchmove', up: 'touchend', cancel: 'touchcancel', hold: 400, tolerance: 10 },
};
const pointOf = (e) => e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
const LISTEN = { capture: true, passive: false };
const HINT_KEY = 'memoking.hint.blockMove';
const THUMB_MIN = 90; // 이보다 높은 내용은 들어 올릴 때 썸네일로 줄인다 (px)
const THUMB_H = 84; // 썸네일 높이 (px)
const coarse = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;

/** @param {{ readOnly?: boolean }} options */
export function createBlockMove({ readOnly = false } = {}) {
  let mover = null;
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
          if (event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) mover?.press(event, 'mouse');
          return false; // 그냥 누르면 지금처럼 (고르기·열기)
        },
        touchstart(view, event) {
          keyboardFor(view, event.target);
          if (event.touches.length === 1) mover?.press(event, 'touch');
          else mover?.cancelPress();
          return false; // 그냥 누르면 고르기, 밀면 스크롤
        },
        dragstart(_view, event) {
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
  }

  busy() {
    return Boolean(this.pressing || this.drag);
  }

  // ---------- 누르기 → 들어 올리기 ----------

  press(event, kind) {
    const { view } = this;
    if (this.drag) return;
    let block = blockFromTarget(view, event.target);
    // 내용 줄이 아니면 글 줄(문단·제목·표·코드·인용·음성 카드): 꾹 눌러야 들어 올린다
    const text = !block;
    if (text) block = textBlockFromTarget(view, event);
    if (!block || block.count < 2) return;
    this.cancelPress();
    const io = INPUT[kind];
    const pt = pointOf(event);
    const p = { block, kind, text, x: pt.clientX, y: pt.clientY, x2: pt.clientX, y2: pt.clientY };
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
    p.up = () => this.cancelPress();
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
        navigator.vibrate?.(12);
        this.lift(p);
      }, text ? (kind === 'touch' ? TOUCH_HOLD_MS : HOLD_MS) : io.hold);
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
    const doms = positions.map((x) => view.nodeDOM(x));
    if (doms.some((d) => !(d instanceof Element))) return;
    getSelection()?.removeAllRanges();
    const scroller = scrollerOf(view.dom);
    const st = scroller?.scrollTop ?? 0;
    const rects = doms.map((d) => d.getBoundingClientRect());
    const tops = rects.map((r) => r.top + st);
    const heights = rects.map((r) => r.height);
    const slots = tops.map((t, i) => (i < tops.length - 1 ? tops[i + 1] - t : heights[i]));
    const src = doms[block.index];
    const scale = src.offsetHeight ? heights[block.index] / src.offsetHeight : 1;
    const badge = document.createElement('div');
    badge.className = 'mk-drag-badge';
    badge.hidden = true;
    document.body.append(badge);
    this.hideHint();
    // 큰 내용(그림·동영상·링크 카드)은 들어 올린 동안 작은 썸네일로 줄여 손가락 위에 띄운다 — 놓을 자리 주변 글이 가리지 않게
    const h = heights[block.index];
    const shrink = h > THUMB_MIN ? Math.max(0.22, Math.min(0.7, THUMB_H / h)) : 1;
    const grabX = p.x - rects[block.index].left; // 누른 자리 (내용 안, 화면 px) — 여기를 중심으로 줄인다
    const grabY = p.y - rects[block.index].top;
    const d = {
      block, positions, tops, heights, slots, scale, scroller, badge, drop: null, kind: p.kind,
      x: p.x2, y: p.y2, startY: p.y + st, raf: 0, timer: 0, shrink, grabX, grabY,
    };
    this.drag = d;
    document.body.classList.add('mk-block-dragging');
    if (p.kind === 'touch') navigator.vibrate?.(15);
    this.judge();

    const io = INPUT[p.kind];
    d.move = (e) => {
      if (!this.drag) return;
      e.preventDefault(); // 터치: 스크롤 대신 끌기
      e.stopPropagation(); // 편집기의 글자 고르기 늘리기를 막는다
      const pt = pointOf(e);
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
      const dy = edgeScroll(d.y, r.top, r.bottom, 48);
      if (dy) {
        d.scroller.scrollTop += dy;
        this.judge();
      }
    }, 30);
  }

  // ---------- 끄는 동안: 어디에 놓일지 판정 · 미리 보기 ----------

  judge() {
    const d = this.drag;
    if (!d) return;
    const cy = d.y + (d.scroller?.scrollTop ?? 0);
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
    d.drop = same ? null : drop;
    this.preview();
    const b = d.badge;
    b.dataset.kind = d.drop?.kind ?? '';
    b.textContent = d.drop?.kind === 'swap' ? '⇅ 맞바꾸기' : d.drop?.kind === 'insert' ? '↳ 여기에 넣기' : '';
    b.hidden = !d.drop;
    // 터치: 썸네일은 손가락 위, 안내는 손가락 오른쪽 (둘 다 가리지 않게)
    b.style.left = `${Math.min(window.innerWidth - 120, d.x + (d.kind === 'touch' ? 28 : 16))}px`;
    b.style.top = `${d.y + (d.kind === 'touch' ? -12 : 14)}px`;
  }

  // 끄는 줄은 손을 따라오고, 다른 줄들은 놓았을 때의 자리로 미끄러진다
  preview() {
    const d = this.drag;
    const { tops, slots, positions, heights, scale } = d;
    const s = d.block.index;
    const order = previewOrder(positions.length, s, d.drop);
    const bottom = tops.at(-1) + heights.at(-1);
    let follow = d.y + (d.scroller?.scrollTop ?? 0) - d.startY;
    follow = Math.min(bottom - heights[s] + 8, Math.max(tops[0] - 8, tops[s] + follow)) - tops[s];
    const specs = [];
    let y = tops[0];
    order.forEach((i) => {
      if (i === s) {
        let style = `transform: translateY(${(follow / scale).toFixed(1)}px)`;
        if (d.shrink < 1) {
          // 누른 자리를 중심으로 줄이고, 손가락에 가리지 않게 썸네일 아래 끝이 손가락보다 위에 오도록 올린다
          const k = d.shrink;
          const up = d.kind === 'touch' ? (heights[s] - d.grabY) * k + 18 : 0;
          style = `transform-origin: ${(d.grabX / scale).toFixed(1)}px ${(d.grabY / scale).toFixed(1)}px; `
            + `transform: translateY(${((follow - up) / scale).toFixed(1)}px) scale(${k.toFixed(3)}); opacity: 0.88`;
        }
        specs.push({ pos: positions[i], cls: `mk-block-lift${d.shrink < 1 ? ' mk-block-thumb' : ''}`, style });
      } else {
        const dy = y - tops[i];
        const cls = ['mk-block-sorting', d.drop?.kind === 'swap' && i === d.drop.index ? 'mk-block-swap-target' : ''].filter(Boolean).join(' ');
        specs.push({ pos: positions[i], cls, style: dy ? `transform: translateY(${(dy / scale).toFixed(1)}px)` : '' });
      }
      y += slots[i];
    });
    this.decorate(specs);
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
    d.badge.remove();
    document.body.classList.remove('mk-block-dragging');
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
    if (commit && d.drop) {
      const block = blockInfo(view.state.doc, d.block.pos, d.block.inner) ?? d.block;
      const tr = reorderTr(view.state, block, previewOrder(d.positions.length, d.block.index, d.drop));
      if (tr) {
        view.dispatch(tr);
        this.flash();
      }
    }
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
    if (this.drag || this.pressing) return;
    const block = view.editable ? contentBlockAt(view.state) : null;
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
    hint.textContent = coarse() ? '꾹 눌러 끌면 다른 줄로 옮겨요' : '끌어서 다른 줄로 옮길 수 있어요 · Alt+↑↓';
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
    this.cancelPress();
    if (this.drag) this.finish(false);
    clearTimeout(this.flashTimer);
    this.hideHint();
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
export function createContentLines() {
  let cache = { doc: null, set: DecorationSet.empty };
  return new Plugin({
    key: new PluginKey('memoking-content-lines'),
    props: {
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
