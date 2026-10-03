// 그림·소리·동영상·파일·링크 카드 같은 "내용" 줄 옮기기 (편집기 플러그인, 데스크탑·휴대폰 함께)
//   - 내용을 누르면(고르면) 그 줄 오른쪽 위에 작은 막대: ↑ 위로 · ⠿ 끌어 옮기기 · ↓ 아래로
//   - ↑·↓ 는 위·아래 줄과 자리를 맞바꾼다 (한 줄씩). 키보드: Alt+↑ / Alt+↓
//   - ⠿ 를 끌면 목록 끌기와 같은 규칙: 다른 줄의 가운데에 놓으면 맞바꾸기, 줄과 줄 사이에 놓으면 끼우기 (놓기 전 미리 보기, Esc 취소)
//   - 마우스와 터치(포인터 이벤트) 모두. 줄 = 같은 상자(본문·인용·목록 항목) 안의 블록 하나
import { Plugin, PluginKey, TextSelection, NodeSelection, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { previewOrder, dropAt } from './core/list-order.js';

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
  const pos = depth > $from.depth ? sel.from : $from.before(depth);
  const $pos = state.doc.resolve(pos);
  if (NO_MOVE_PARENTS.test($pos.parent.type.name)) return null;
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  return { pos, node, depth, start: $pos.start(), index: $pos.index(), count: $pos.parent.childCount, inner };
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
    else tr.setSelection(TextSelection.create(tr.doc, at + 1 + inner.offset));
  } catch {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size))));
  }
  return tr.scrollIntoView();
}

// 한 줄 위(-1)·아래(+1) 줄과 맞바꾸기
export function moveBlockBy(state, dispatch, dir) {
  const block = contentBlockAt(state);
  if (!block) return false;
  const other = block.index + dir;
  if (other < 0 || other >= block.count) return false;
  const tr = reorderTr(state, block, previewOrder(block.count, block.index, { kind: 'swap', index: other }));
  if (!tr) return false;
  dispatch?.(tr);
  return true;
}

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const ARROW_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></g></svg>';

/** @param {{ readOnly?: boolean }} options */
export function createBlockMove({ readOnly = false } = {}) {
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
        return moveBlockBy(view.state, view.dispatch, event.key === 'ArrowUp' ? -1 : 1);
      },
    },
    view: (view) => (readOnly ? {} : new MoveBar(view)),
  });
}

class MoveBar {
  constructor(view) {
    this.view = view;
    this.block = null;
    this.drag = null;
    this.bar = el('div', 'mk-move-bar', { role: 'toolbar', 'aria-label': '이 줄 옮기기' });
    this.up = el('button', 'mk-move-btn', { type: 'button', title: '위 줄과 바꾸기 (Alt+↑)', 'aria-label': '위로' });
    this.grip = el('button', 'mk-move-btn mk-move-grip', { type: 'button', title: '끌어서 옮기기 — 다른 줄 가운데는 맞바꾸기, 줄 사이는 끼우기', 'aria-label': '끌어서 옮기기' });
    this.down = el('button', 'mk-move-btn', { type: 'button', title: '아래 줄과 바꾸기 (Alt+↓)', 'aria-label': '아래로' });
    this.up.innerHTML = ARROW_UP;
    this.grip.innerHTML = GRIP;
    this.down.innerHTML = ARROW_DOWN;
    this.bar.append(this.up, this.grip, this.down);
    this.bar.hidden = true;
    document.body.append(this.bar);
    // 막대를 눌러도 편집기의 선택(고른 그림)이 그대로 남게
    this.bar.addEventListener('mousedown', (e) => e.preventDefault());
    this.up.addEventListener('click', () => this.step(-1));
    this.down.addEventListener('click', () => this.step(1));
    this.grip.addEventListener('pointerdown', (e) => this.lift(e));
    this.grip.addEventListener('click', (e) => e.preventDefault());
    this.reposition = () => this.place();
    window.addEventListener('scroll', this.reposition, true);
    window.addEventListener('resize', this.reposition);
    this.update(view);
  }

  step(dir) {
    const { view } = this;
    if (moveBlockBy(view.state, view.dispatch, dir)) {
      this.flash();
      if (!view.hasFocus()) view.focus();
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
      if (!this.drag && !view.isDestroyed) this.decorate([]);
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

  update(view) {
    this.view = view;
    if (this.drag) return;
    this.block = view.editable ? contentBlockAt(view.state) : null;
    this.bar.hidden = !this.block;
    if (!this.block) return;
    this.up.disabled = this.block.index === 0;
    this.down.disabled = this.block.index >= this.block.count - 1;
    this.grip.disabled = this.block.count < 2;
    this.place();
  }

  place() {
    if (!this.block || this.bar.hidden || this.drag) return;
    const dom = this.view.nodeDOM(this.block.pos);
    if (!(dom instanceof Element) || !dom.isConnected) {
      this.bar.hidden = true;
      return;
    }
    const r = dom.getBoundingClientRect();
    const box = this.view.dom.getBoundingClientRect();
    const w = this.bar.offsetWidth || 110;
    const h = this.bar.offsetHeight || 36;
    // 줄의 오른쪽 위 안쪽 (본문 밖으로 나가지 않게)
    const left = Math.max(box.left + 4, Math.min(r.right, box.right) - w - 4);
    const top = Math.max(4, Math.min(window.innerHeight - h - 4, r.top + 6));
    this.bar.style.left = `${Math.round(left)}px`;
    this.bar.style.top = `${Math.round(top)}px`;
  }

  // ---------- ⠿ 끌어 옮기기 (포인터: 마우스·터치) ----------

  lift(e) {
    const { view } = this;
    const block = contentBlockAt(view.state);
    if (!block || block.count < 2 || (e.button ?? 0) !== 0) return;
    e.preventDefault();
    const parent = view.state.doc.resolve(block.pos).parent;
    const positions = [];
    let p = block.start;
    parent.forEach((c) => {
      positions.push(p);
      p += c.nodeSize;
    });
    const doms = positions.map((q) => view.nodeDOM(q));
    if (doms.some((d) => !(d instanceof Element))) return;
    const scroller = scrollerOf(view.dom);
    const st = scroller?.scrollTop ?? 0;
    const rects = doms.map((d) => d.getBoundingClientRect());
    const tops = rects.map((r) => r.top + st);
    const heights = rects.map((r) => r.height);
    const slots = tops.map((t, i) => (i < tops.length - 1 ? tops[i + 1] - t : heights[i]));
    const scale = doms[block.index].offsetHeight ? heights[block.index] / doms[block.index].offsetHeight : 1;
    const badge = el('div', 'mk-drag-badge');
    badge.hidden = true;
    document.body.append(badge);
    this.drag = {
      block, positions, tops, heights, slots, scale, scroller, badge, drop: null,
      x: e.clientX, y: e.clientY, startY: e.clientY + st, pointer: e.pointerId, pointerType: e.pointerType, raf: 0, timer: 0,
    };
    try {
      this.grip.setPointerCapture(e.pointerId);
    } catch {
      // 캡처가 안 되어도 창 전체에서 받는다
    }
    this.bar.classList.add('dragging');
    document.body.classList.add('mk-block-dragging');
    if (e.pointerType === 'touch') navigator.vibrate?.(15);
    this.preview();
    this.onMove = (ev) => {
      if (!this.drag || ev.pointerId !== this.drag.pointer) return;
      ev.preventDefault();
      this.drag.x = ev.clientX;
      this.drag.y = ev.clientY;
      if (!this.drag.raf) {
        this.drag.raf = requestAnimationFrame(() => {
          if (!this.drag) return;
          this.drag.raf = 0;
          this.judge();
        });
      }
    };
    this.onUp = (ev) => {
      if (!this.drag || ev.pointerId !== this.drag.pointer) return;
      ev.preventDefault();
      this.drag.x = ev.clientX;
      this.drag.y = ev.clientY;
      this.judge();
      this.finish(ev.type === 'pointerup');
    };
    this.onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      this.finish(false);
    };
    window.addEventListener('pointermove', this.onMove, { capture: true, passive: false });
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onUp, true);
    window.addEventListener('keydown', this.onKey, true);
    // 위·아래 끝 가까이에서는 저절로 스크롤 (가까울수록 빠르게)
    this.drag.timer = setInterval(() => {
      const d = this.drag;
      if (!d?.scroller) return;
      const r = d.scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : d.scroller.getBoundingClientRect();
      const edge = 48;
      const upBy = r.top + edge - d.y;
      const downBy = d.y - (r.bottom - edge);
      const dy = upBy > 0 ? -Math.ceil(upBy / 3) : downBy > 0 ? Math.ceil(downBy / 3) : 0;
      if (dy) {
        d.scroller.scrollTop += dy;
        this.judge();
      }
    }, 30);
  }

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
    b.style.left = `${Math.min(window.innerWidth - 120, d.x + 16)}px`;
    b.style.top = `${d.y + (d.pointerType === 'touch' ? -44 : 14)}px`;
  }

  // 끄는 줄은 손가락·마우스를 따라오고, 다른 줄들은 놓았을 때의 자리로 미끄러진다
  preview() {
    const d = this.drag;
    const { tops, slots, positions, heights, scale } = d;
    const s = d.block.index;
    const order = previewOrder(positions.length, s, d.drop);
    const bottom = tops.at(-1) + heights.at(-1);
    let follow = d.y + (d.scroller?.scrollTop ?? 0) - d.startY;
    follow = Math.min(bottom - heights[s] + 6, Math.max(tops[0] - 6, tops[s] + follow)) - tops[s];
    const specs = [];
    let y = tops[0];
    order.forEach((i) => {
      if (i === s) {
        specs.push({ pos: positions[i], cls: 'mk-block-lift', style: `transform: translateY(${(follow / scale).toFixed(1)}px)` });
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
    window.removeEventListener('pointermove', this.onMove, { capture: true, passive: false });
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onUp, true);
    window.removeEventListener('keydown', this.onKey, true);
    d.badge.remove();
    this.bar.classList.remove('dragging');
    document.body.classList.remove('mk-block-dragging');
    this.drag = null;
    const { view } = this;
    if (view.isDestroyed) return;
    this.decorate([]);
    if (commit && d.drop) {
      const block = contentBlockAt(view.state) ?? d.block;
      const tr = reorderTr(view.state, block, previewOrder(d.positions.length, d.block.index, d.drop));
      if (tr) {
        view.dispatch(tr);
        this.flash();
      }
    }
    this.update(view);
  }

  destroy() {
    if (this.drag) this.finish(false);
    clearTimeout(this.flashTimer);
    window.removeEventListener('scroll', this.reposition, true);
    window.removeEventListener('resize', this.reposition);
    this.bar.remove();
  }
}

function scrollerOf(node) {
  for (let s = node?.parentElement; s; s = s.parentElement) {
    const oy = getComputedStyle(s).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && s.scrollHeight > s.clientHeight) return s;
  }
  return document.scrollingElement;
}
