// 목록·체크리스트 항목 순서 바꾸기 (편집기 플러그인)
//   - 항목에 마우스를 올리면 옮길 수 있다는 흐린 점선 테두리, 글자를 꾹(0.35초) 누르면 테두리가 점점 진해지다가
//     들어 올려지고, 그대로 끌면 순서를 바꾼다
//     (바로 끌면 지금처럼 글자 선택 — 여러 줄을 골라 체크리스트로 바꾸는 일과 겹치지 않게)
//   - 다른 항목의 가운데에 놓으면 두 항목이 서로 맞바뀌고, 위·아래 가장자리(줄과 줄 사이)에 놓으면 그 사이에 끼워진다
//   - 놓기 전에 바뀔 모습을 미리 보여 준다 (같은 목록은 항목들이 바뀔 자리로 미끄러지고 놓을 자리에 점선 칸, 다른 목록은
//     얇은 칸·테두리). 안내 캡슐은 그 틀 오른쪽에 — 그림·글 줄 옮기기(block-move.js)와 같은 틀(drag-frames.js)
//   - 하위 항목은 함께 움직인다. Esc 로 취소. 키보드: Alt+↑ / Alt+↓ 로 한 칸 위·아래로
//   - 휴대폰(터치): 글자를 꾹(0.35초) 누르면 들어 올려지고, 손가락을 떼지 않고 끌면 같은 규칙으로 옮긴다
//   - 하위·상위 항목: 항목을 오른쪽으로 밀면 바로 위 항목의 하위로, 왼쪽으로 밀면 한 단계 위로 (터치는 그냥 옆으로 밀기,
//     마우스는 꾹 눌러 들어 올린 채 옆으로) — 체크리스트·점 목록·번호 목록 모두
//   - 커서가 있는 항목에 흐린 점선 테두리 (Enter 로 새 항목을 만들면 따라간다)
import { Plugin, PluginKey, TextSelection, Decoration, DecorationSet, sinkListItem, liftListItem } from '../vendor/milkdown.js';
import { previewOrder, dropAt } from './core/list-order.js';
import { holdKeyboard, edgeScroll, canDrag, holdFor, isStylusTouch } from './keyboard-guard.js';
import { HYSTERESIS_PX } from './core/drag-geometry.js';
import { DragFrames } from './drag-frames.js';
import { showDeleteButton, hideDeleteButton, hideDeleteIfChanged } from './delete-button.js';
import { haptic } from './dom.js';
import { UI } from './core/ui-text.js';

export const listDragKey = new PluginKey('memoking-list-drag');

// 이만큼 누르고 있으면 들어 올림 (그동안 테두리가 점점 진해진다). PC·휴대폰이 같은 손맛이 되게 마우스·터치 모두 0.35초
//   (터치는 휴대폰의 글자 고르기(약 0.5초)보다 먼저여야 한다)
export const HOLD_MS = 350;
const MOVE_TOLERANCE = 5; // 그 전에 이만큼 움직이면 글자 선택으로 본다
export const TOUCH_HOLD_MS = HOLD_MS;
const TOUCH_TOLERANCE = 10; // 손가락은 조금 흔들린다

// 마우스와 터치의 이벤트 이름·좌표를 하나로
const INPUT = {
  mouse: { move: 'mousemove', up: 'mouseup', cancel: null, hold: HOLD_MS, tolerance: MOVE_TOLERANCE },
  touch: { move: 'touchmove', up: 'touchend', cancel: 'touchcancel', hold: TOUCH_HOLD_MS, tolerance: TOUCH_TOLERANCE },
};
const pointOf = (e) => e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
const LISTEN = { capture: true, passive: false }; // 터치로 끄는 동안 화면이 스크롤되지 않게 preventDefault 할 수 있어야 한다

const isItem = (node) => node?.type.name === 'list_item';

export const SWIPE_DISTANCE = 48; // 이만큼 옆으로 밀면 하위·상위로
const EDIT_SWIPE_WINDOW_MS = 350; // 글 고치기 방식: 손가락을 댄 뒤 이 안에 옆으로 밀어야 하위·상위 (더 머물면 글자 고르기)
// 들어 올린 항목을 움직이지 않고 더 누르고 있으면 목록 전체를 옮긴다 (GATHER_MS 부터 목록 테두리가 차오름)
export const WHOLE_LIST_MS = 650;
const GATHER_MS = 200;
const SWIPE_START = 12; // 이만큼 옆으로 먼저 움직이면 (세로보다 확실히) 밀기로 본다

// 항목(pos) 을 한 단계 들여쓰기(dir>0, 바로 위 항목의 하위로) · 내어쓰기(dir<0). 맨 바깥 항목은 목록 밖으로 빼지 않는다.
// 바꿀 수 없으면 false
export function shiftItem(view, pos, dir) {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!isItem(node)) return false;
  const $pos = state.doc.resolve(pos);
  if (dir > 0 && $pos.index() === 0) return false; // 위에 항목이 없으면 하위로 갈 곳이 없다
  if (dir < 0 && !isItem($pos.node($pos.depth - 1))) return false; // 이미 맨 바깥
  const type = state.schema.nodes.list_item;
  const sel = state.tr.setSelection(TextSelection.near(state.doc.resolve(Math.min(pos + 2, state.doc.content.size))));
  const next = state.apply(sel);
  let tr = null;
  const capture = (t) => (tr = t);
  if (!(dir > 0 ? sinkListItem(type) : liftListItem(type))(next, capture) || !tr) return false;
  // 하위 목록의 종류는 위 항목의 목록을 따른다 (체크리스트 안이면 체크 네모도 유지)
  view.dispatch(sel);
  view.dispatch(tr.scrollIntoView());
  return true;
}

// 커서가 있는 가장 안쪽 항목에 테두리 표시 (끄는 중이 아닐 때)
function caretDecoration(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if (isItem($from.node(d))) {
      const pos = $from.before(d);
      return DecorationSet.create(state.doc, [Decoration.node(pos, pos + $from.node(d).nodeSize, { class: 'mk-caret-item' })]);
    }
  }
  return DecorationSet.empty;
}

// pos 에서 시작하는 항목을 target(다른 항목의 앞·뒤 자리)으로 옮기는 트랜잭션. 옮길 수 없으면 null.
export function moveItemTr(state, src, target) {
  const node = state.doc.nodeAt(src);
  if (!isItem(node)) return null;
  const end = src + node.nodeSize;
  if (target >= src && target <= end) return null; // 제자리이거나 자기 안
  const $src = state.doc.resolve(src);
  // 목록에 항목이 하나뿐이면 빈 목록이 남지 않도록 목록째 지운다
  const lone = $src.parent.childCount === 1;
  const from = lone ? $src.before() : src;
  const to = lone ? $src.after() : end;
  if (target > from && target < to) return null;
  const $target = state.doc.resolve(target);
  if (!/^(bullet_list|ordered_list)$/.test($target.parent.type.name)) return null; // 목록 안의 항목 사이 자리만
  const tr = state.tr.delete(from, to);
  const at = tr.mapping.map(target);
  tr.insert(at, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + 2, tr.doc.content.size))));
  return tr.scrollIntoView();
}

// 두 항목을 서로 맞바꾸는 트랜잭션 (한쪽이 다른 쪽 안에 있으면 null). 커서는 끌었던 항목(src)으로
export function swapItemsTr(state, src, other) {
  const [a, b] = src < other ? [src, other] : [other, src];
  const A = state.doc.nodeAt(a);
  const B = state.doc.nodeAt(b);
  if (!isItem(A) || !isItem(B) || a === b || a + A.nodeSize > b) return null;
  const tr = state.tr.replaceWith(b, b + B.nodeSize, A).replaceWith(a, a + A.nodeSize, B);
  const srcAt = src === a ? b + B.nodeSize - A.nodeSize : a; // 끌었던 항목의 새 자리
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(srcAt + 2, tr.doc.content.size))));
  return tr.scrollIntoView();
}

// 커서가 있는 (가장 안쪽) 항목
export function currentItem(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if (isItem($from.node(d))) return { node: $from.node(d), pos: $from.before(d) };
  return null;
}

// Alt+↑/↓: 같은 목록 안에서 한 칸 위·아래로
export function moveItemBy(state, dispatch, dir) {
  const item = currentItem(state);
  if (!item) return false;
  const $item = state.doc.resolve(item.pos);
  const list = $item.parent;
  const index = $item.index();
  let target;
  if (dir < 0) {
    if (index === 0) return false;
    target = item.pos - list.child(index - 1).nodeSize;
  } else {
    if (index >= list.childCount - 1) return false;
    target = item.pos + item.node.nodeSize + list.child(index + 1).nodeSize;
  }
  const tr = moveItemTr(state, item.pos, target);
  if (!tr) return false;
  dispatch?.(tr);
  return true;
}

// 목록 항목 li 의 문서 위치
function itemPosOf(view, li) {
  let pos;
  try {
    pos = view.posAtDOM(li, 0);
  } catch {
    return null;
  }
  const $p = view.state.doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) if (isItem($p.node(d))) return $p.before(d);
  return null;
}

// 스크롤되는 조상 (끌면서 위·아래 끝에 가면 저절로 스크롤)
function scrollerOf(el) {
  for (let s = el?.parentElement; s; s = s.parentElement) {
    const oy = getComputedStyle(s).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && s.scrollHeight > s.clientHeight) return s;
  }
  return document.scrollingElement;
}

const directItems = (list) => [...list.children].filter((c) => c.tagName === 'LI');

// 항목 테두리(li::after — 체크 네모·글머리까지 감싼다)의 가로 자리. 화면 px (본문 확대·축소 포함)
function xExtent(li, r = li.getBoundingClientRect()) {
  const k = li.offsetWidth ? r.width / li.offsetWidth : 1;
  const a = getComputedStyle(li, '::after');
  const l = parseFloat(a.left);
  const rt = parseFloat(a.right);
  const fs = parseFloat(getComputedStyle(li).fontSize) || 16;
  const left = r.left + (Number.isFinite(l) ? l : -(1.35 * fs + 7)) * k;
  const right = r.right - (Number.isFinite(rt) ? rt : -6) * k;
  return { left, width: right - left };
}

/** @param {{ readOnly?: boolean }} options */
export function createListDrag({ readOnly = false } = {}) {
  let press = null; // 누르고 기다리는 중 { li, x, y, timer }
  let drag = null; // 들어 올린 뒤

  const scrollTop = () => drag?.scroller?.scrollTop ?? 0;

  // keepMark: 들어 올리기로 넘어갈 때는 누름 표시를 지우지 않는다 (곧 들어 올린 모습으로 바뀜)
  function cancelPress({ keepMark = false } = {}) {
    if (!press) return;
    const p = press;
    press = null;
    clearTimeout(p.timer);
    clearTimeout(p.markTimer);
    const io = INPUT[p.kind];
    window.removeEventListener(io.move, p.move, LISTEN);
    window.removeEventListener(io.up, p.up, LISTEN);
    if (io.cancel) window.removeEventListener(io.cancel, p.up, LISTEN);
    if (p.marked && !keepMark && !drag && p.view && !p.view.isDestroyed) decorate(p.view, []);
  }

  // 미리 보기는 데코레이션으로 (편집기가 관리하는 DOM 의 class·style 을 직접 바꾸면 편집기가 되돌린다)
  // specs: [{ pos, cls?, style? }] — pos 는 항목(또는 목록) 노드의 시작
  function decorate(view, specs) {
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
    view.dispatch(view.state.tr.setMeta(listDragKey, DecorationSet.create(doc, decos)));
  }

  function clearPreview(view) {
    if (!drag) return;
    for (const name of ['lift', 'target', 'slot']) drag.frames.set(name, null);
    drag.frames.label(null);
    decorate(view, []);
  }

  // 놓은 뒤: 옮겨진 항목이 잠깐 반짝여 어디로 갔는지 보여 준다
  function flashMoved(view) {
    const { $from } = view.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if (!isItem($from.node(d))) continue;
      const pos = $from.before(d);
      decorate(view, [{ pos, cls: 'mk-dropped' }]);
      setTimeout(() => {
        if (!drag && !press && !view.isDestroyed && listDragKey.getState(view.state)?.find().length) decorate(view, []);
      }, 700);
      return;
    }
  }

  // 목록 항목 지우기 단추 — 항목 하나뿐인 목록이면 목록째로 (지워지는 모습도 목록째로)
  function showItemDelete(view, pos) {
    const item = view.state.doc.nodeAt(pos);
    const li = view.nodeDOM(pos);
    if (!item || !isItem(item) || !(li instanceof Element)) return;
    const $pos = view.state.doc.resolve(pos);
    const only = $pos.parent.childCount === 1;
    const at = only ? $pos.before() : pos;
    const node = only ? $pos.parent : item;
    const deco = (spec) => {
      if (spec) decorate(view, [{ pos: at, ...spec }]);
      else if (!drag && !press && listDragKey.getState(view.state)?.find().length) decorate(view, []);
    };
    showDeleteButton(view, { pos: at, node, target: li, label: only ? '이 목록 지우기' : '이 항목 지우기', deco });
  }

  // 들어 올린 항목 대신 목록 전체(맨 바깥 줄)를 들어 올린다 — 손가락은 그대로, 옮기기는 block-move.js 가
  function liftWholeList(view) {
    const d = drag;
    if (!d || d.moved || d.wholePos == null) return;
    const { x, y, kind, wholePos } = d;
    finish(view, false, { quiet: true });
    const detail = { pos: wholePos + 1, x, y, kind, ok: false };
    view.dom.dispatchEvent(new CustomEvent('mk-lift-block', { detail }));
    if (!detail.ok && !view.isDestroyed) decorate(view, []);
  }

  function finish(view, commit, { quiet = false } = {}) {
    if (!drag) return;
    const d = drag;
    cancelAnimationFrame(d.raf);
    clearTimeout(d.gatherTimer);
    clearTimeout(d.wholeTimer);
    const stillAt = Math.hypot(d.x - d.startX, d.y + (d.scroller?.scrollTop ?? 0) - d.startY) < 14;
    clearPreview(view);
    drag = null;
    const io = INPUT[d.kind];
    window.removeEventListener(io.move, d.move, LISTEN);
    window.removeEventListener(io.up, d.up, LISTEN);
    if (io.cancel) window.removeEventListener(io.cancel, d.cancel, LISTEN);
    window.removeEventListener('keydown', d.key, true);
    window.removeEventListener('selectstart', d.block, true);
    window.removeEventListener('contextmenu', d.block, true);
    clearInterval(d.timer);
    d.frames.destroy();
    document.body.classList.remove('mk-list-dragging');
    if (quiet) return; // 목록 전체 옮기기로 넘김 (block-move.js 가 이어서)
    const { state } = view;
    if (commit && !d.drop && d.shift) {
      if (shiftItem(view, d.srcPos, d.shift)) flashMoved(view);
      view.focus();
      return;
    }
    if (!commit || !d.drop) {
      // 끄는 동안 늘어난 글자 선택은 버리고 커서를 그 항목에
      view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(Math.min(d.srcPos + 2, state.doc.content.size)))));
      view.focus();
      // (터치) 꾹 눌러 들어 올렸다가 그 자리에 놓으면: 사진·소리처럼 오른쪽 위에 지우기 단추
      if (commit && !d.shift && stillAt && d.kind === 'touch') showItemDelete(view, d.srcPos);
      return;
    }
    let tr = null;
    if (d.drop.cross) {
      tr = d.drop.kind === 'swap' ? swapItemsTr(state, d.srcPos, d.drop.pos) : moveItemTr(state, d.srcPos, d.drop.pos);
    } else if (d.drop.kind === 'swap') {
      tr = swapItemsTr(state, d.srcPos, d.positions[d.drop.index]);
    } else {
      const i = d.drop.index;
      const target = i < d.positions.length ? d.positions[i] : d.positions.at(-1) + state.doc.nodeAt(d.positions.at(-1)).nodeSize;
      tr = moveItemTr(state, d.srcPos, target);
    }
    if (tr) {
      view.dispatch(tr);
      flashMoved(view);
    }
    view.focus();
  }

  // 미리 보기: 끄는 항목은 커서를 그대로 따라오고, 같은 목록의 다른 항목들은 놓았을 때의 자리로 미끄러져
  // 들어갈 틈을 연다 (원래 자리 기준으로 계산 — 미리 보기가 다시 판정에 끼지 않게)
  // free: 다른 목록으로 가는 중이면 커서를 그대로 따라가고, 같은 목록 안에서는 목록의 맨 위·맨 아래에서 멈춘다
  // (커서가 목록 밖으로 멀리 가도 항목은 맨 끝 자리에 머물러 "맨 끝으로" 가 보이게, 본문 밖으로 잘리지도 않게)
  // 틀(항목의 테두리 ::after 와 같은 자리 — 체크 네모·글머리까지): fx 는 들어 올릴 때 잰 가로 자리
  const itemFrame = (i, top, dx = 0) => ({ left: drag.fx[i].left + dx, top: top - 2, width: drag.fx[i].width, height: drag.heights[i] + 4 });
  function previewSame(view, drop, extra = [], { free = false, dx = 0 } = {}) {
    const { tops, slots, s, scale, positions, listPos, heights, frames } = drag;
    const st = scrollTop();
    const order = previewOrder(positions.length, s, drop);
    const specs = [{ pos: listPos, cls: 'mk-sorting' }];
    if (drag.gathering) specs.push({ pos: drag.wholePos, cls: 'mk-list-gather' }); // 곧 목록 전체를 들어 올림
    let follow = drag.y + st - drag.startY; // 끄는 항목이 커서를 따라간 거리
    if (!free) follow = Math.min(drag.bottom - heights[s] + 6, Math.max(tops[0] - 6, tops[s] + follow)) - tops[s];
    let y = tops[0];
    let slot = null;
    let target = null;
    const sx = Math.max(-56, Math.min(56, dx * 0.7));
    order.forEach((i) => {
      if (i === s) {
        if (drop) slot = itemFrame(s, y - st); // 놓으면 갈 자리 (다른 항목들이 비켜 연 틈)
        specs.push({ pos: positions[i], cls: 'mk-lift', style: `transform: translate(${(sx / scale).toFixed(1)}px, ${(follow / scale).toFixed(1)}px)` });
      } else {
        const dy = y - tops[i];
        const swap = drop?.kind === 'swap' && i === drop.index;
        if (swap) target = itemFrame(i, y - st);
        specs.push({ pos: positions[i], cls: swap ? 'mk-swap-target' : '', style: dy ? `transform: translateY(${(dy / scale).toFixed(1)}px)` : '' });
      }
      y += slots[i];
    });
    decorate(view, [...specs, ...extra]);
    frames.set('lift', itemFrame(s, tops[s] + follow - st, sx), { outer: true, draw: false });
    if (!free) {
      frames.set('target', target, { outer: true, draw: false });
      frames.set('slot', slot, { outer: true });
    }
  }

  // 틀 오른쪽 안내: 지금 놓으면 무엇이 되는지
  const BADGES = { swap: UI.swapHere, insert: UI.dropHere, indent: '→ 하위 항목으로', outdent: '← 상위 항목으로', blocked: '더 옮길 수 없어요' };
  function showBadge(kind) {
    drag.frames.label(kind ?? null, BADGES[kind] ?? '', { x: drag.x, y: drag.y }, drag.kind);
    // 놓을 자리가 바뀔 때 톡 (터치)
    const key = drag.drop ? (drag.drop.cross ? `c:${drag.drop.kind}:${drag.drop.pos}` : `${drag.drop.kind}:${drag.drop.index}`) : drag.shift ? `s:${drag.shift}` : '';
    if (key && key !== drag.buzzKey && drag.kind === 'touch') haptic(6);
    drag.buzzKey = key;
  }

  // 다른 목록 항목의 틀 (지금 화면 자리)
  function frameOfLi(li) {
    const r = li.getBoundingClientRect();
    const { left, width } = xExtent(li, r);
    return { left, top: r.top - 2, width, height: r.height + 4 };
  }

  function place(view, x, y) {
    const d = drag;
    d.drop = null;
    d.shift = 0;
    // 1) 다른 목록(하위 목록 포함)의 항목 위면 그쪽으로 — 끄는 항목은 마우스를 통과시켜 그 아래가 잡힌다
    const hit = document.elementFromPoint(x, y)?.closest?.('li');
    const other = hit && view.dom.contains(hit) && hit.parentElement !== d.list && !d.src.contains(hit) && !hit.contains(d.src) ? hit : null;
    if (other) {
      const pos = itemPosOf(view, other);
      if (pos != null) {
        const node = view.state.doc.nodeAt(pos);
        const first = other.querySelector(':scope > p')?.getBoundingClientRect() ?? other.getBoundingClientRect();
        const drop = dropAt(0, (y - first.top) / Math.max(1, first.height));
        const f = frameOfLi(other);
        if (drop.kind === 'swap') {
          d.drop = { cross: true, kind: 'swap', pos };
          previewSame(view, null, [{ pos, cls: 'mk-swap-target' }], { free: true });
          d.frames.set('target', f, { outer: true, draw: false });
          d.frames.set('slot', null);
        } else {
          const before = drop.index === 0;
          d.drop = { cross: true, kind: 'insert', pos: before ? pos : pos + node.nodeSize };
          previewSame(view, null, [], { free: true });
          d.frames.set('target', null);
          d.frames.set('slot', { left: f.left + 6, top: before ? f.top + 1 : f.top + f.height - 1, width: Math.max(40, f.width - 12), height: 0 }, { line: true });
        }
        showBadge(d.drop.kind);
        return;
      }
    }
    // 2) 같은 목록: 목록 위·아래로 벗어나도 맨 앞·맨 끝으로 (멀리 옮겨도 미리 보기가 끊기지 않게)
    const cy = y + scrollTop(); // 스크롤과 상관없는 세로 위치
    const n = d.tops.length;
    let drop;
    if (cy < d.tops[0]) drop = { kind: 'insert', index: 0 };
    else if (cy > d.bottom) drop = { kind: 'insert', index: n };
    else {
      let k = d.tops.findIndex((t, i) => cy < t + d.slots[i]);
      if (k < 0) k = n - 1;
      drop = dropAt(k, Math.min(1, Math.max(0, (cy - d.tops[k]) / Math.max(1, d.heights[k]))));
    }
    const same = drop.kind === 'swap' ? drop.index === d.s : drop.index === d.s || drop.index === d.s + 1;
    const next = same ? null : drop;
    const key = next ? `${next.kind}:${next.index}` : '';
    // 경계 근처의 작은 떨림으로는 바꾸지 않는다 (바뀐 자리에서 HYSTERESIS_PX 는 더 움직여야)
    if (key !== d.lastKey && !(d.lastCy != null && Math.abs(cy - d.lastCy) < HYSTERESIS_PX)) {
      d.lastKey = key;
      d.lastCy = cy;
      d.lastDrop = next;
    } else if (d.lastCy == null) d.lastCy = cy;
    d.drop = d.lastDrop;
    // 제자리에서 옆으로 밀면 하위·상위로 (세로로는 같은 자리, 가로로 충분히)
    const dx = x - d.startX;
    d.shift = 0;
    if (!d.drop && Math.abs(dx) >= SWIPE_DISTANCE) d.shift = dx > 0 ? 1 : -1;
    previewSame(view, d.drop, [], { dx: d.drop ? 0 : dx });
    showBadge(d.shift ? (canShift(view, d.srcPos, d.shift) ? (d.shift > 0 ? 'indent' : 'outdent') : 'blocked') : d.drop?.kind);
  }

  const canShift = (view, pos, dir) => canSwipe(view, pos, dir);

  // 마우스가 움직이면 다음 화면 그리기 때 한 번만 (빠르게 끌어도 매끄럽게)
  function schedulePlace(view) {
    if (!drag || drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      place(view, drag.x, drag.y);
    });
  }

  function lift(view, li, x, y, kind = 'mouse') {
    const srcPos = itemPosOf(view, li);
    const list = li.parentElement;
    if (srcPos == null || !list) return;
    if (kind === 'touch') holdKeyboard(view); // 옮기는 동안 키보드는 절대 뜨지 않게 (떠 있으면 내림)
    const scroller = scrollerOf(view.dom);
    const items = directItems(list);
    const st = scroller?.scrollTop ?? 0;
    const rects = items.map((it) => it.getBoundingClientRect());
    const tops = rects.map((r) => r.top + st);
    const heights = rects.map((r) => r.height);
    const gap = items.length > 1 ? Math.max(0, tops[1] - (tops[0] + heights[0])) : 0;
    const slots = tops.map((t, i) => (i < tops.length - 1 ? tops[i + 1] - t : heights[i] + gap));
    const scale = li.offsetHeight ? rects[items.indexOf(li)].height / li.offsetHeight : 1; // 본문 확대·축소 배율
    getSelection()?.removeAllRanges(); // 누르는 동안 시작된 글자 선택은 버린다
    const $src = view.state.doc.resolve(srcPos);
    drag = {
      view, src: li, srcPos, list, listPos: $src.before(), positions: items.map((it) => itemPosOf(view, it)), s: items.indexOf(li),
      tops, heights, slots, bottom: tops.at(-1) + heights.at(-1), scale, scroller, frames: new DragFrames(view.dom),
      fx: items.map((it, i) => xExtent(it, rects[i])), lastKey: '', lastCy: null, lastDrop: null, buzzKey: '',
      drop: null, shift: 0, x, y, startX: x, startY: y + st, timer: 0, raf: 0, kind,
    };
    // 더 누르고 있으면 목록 전체: 맨 바깥 줄이 목록이고 옮길 다른 줄이 있을 때만
    const top = view.state.doc.resolve(srcPos);
    const wholePos = top.depth >= 1 ? top.before(1) : null;
    const whole = wholePos != null ? view.state.doc.nodeAt(wholePos) : null;
    if (whole && /list/.test(whole.type.name) && view.state.doc.childCount >= 2) {
      drag.wholePos = wholePos;
      drag.gatherTimer = setTimeout(() => {
        if (!drag || drag.moved) return;
        drag.gathering = true;
        previewSame(view, null);
      }, GATHER_MS);
      drag.wholeTimer = setTimeout(() => liftWholeList(view), WHOLE_LIST_MS);
    }
    if (kind === 'touch') haptic(15); // 들어 올렸다는 느낌
    document.body.classList.add('mk-list-dragging');
    previewSame(view, null); // 들어 올린 모습
    drag.block = (e) => e.preventDefault();
    drag.move = (e) => {
      if (!drag) return;
      e.preventDefault(); // (터치) 화면 스크롤 대신 끌기
      e.stopPropagation(); // 편집기의 글자 선택 늘리기를 막는다
      const p = pointOf(e);
      drag.x = p.clientX;
      drag.y = p.clientY;
      // 움직이기 시작하면 이 항목만 옮긴다 (목록 전체로 넘어가지 않음)
      if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y + scrollTop() - drag.startY) > INPUT[drag.kind].tolerance) {
        drag.moved = true;
        clearTimeout(drag.gatherTimer);
        clearTimeout(drag.wholeTimer);
        drag.gathering = false;
      }
      schedulePlace(view);
    };
    drag.up = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (drag) {
        const p = pointOf(e);
        drag.x = p.clientX;
        drag.y = p.clientY;
        place(view, p.clientX, p.clientY); // 놓은 자리로 마지막 판정
      }
      finish(view, true);
    };
    drag.cancel = () => finish(view, false);
    drag.key = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(view, false);
      }
    };
    // 위·아래 끝 가까이에서는 저절로 스크롤 (가까울수록 빠르게)
    drag.timer = setInterval(() => {
      if (!drag || !scroller) return;
      const r = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      const dy = edgeScroll(drag.y, r.top, r.bottom, 40);
      if (dy) {
        scroller.scrollTop += dy;
        place(view, drag.x, drag.y);
      }
    }, 30);
    const io = INPUT[kind];
    window.addEventListener(io.move, drag.move, LISTEN);
    window.addEventListener(io.up, drag.up, LISTEN);
    if (io.cancel) window.addEventListener(io.cancel, drag.cancel, LISTEN);
    window.addEventListener('keydown', drag.key, true);
    window.addEventListener('selectstart', drag.block, true);
    window.addEventListener('contextmenu', drag.block, true); // (터치) 꾹 누르기 메뉴가 뜨지 않게
  }

  // 손가락으로 항목을 옆으로 밀기: 따라 움직이다가 SWIPE_DISTANCE 를 넘기고 떼면 하위(→)·상위(←)로
  let swipe = null;
  function startSwipe(view, li, x0, y0, event) {
    const pos = itemPosOf(view, li);
    if (pos == null) return;
    event.preventDefault();
    holdKeyboard(view);
    const scale = li.offsetWidth ? li.getBoundingClientRect().width / li.offsetWidth : 1;
    // 안내 캡슐은 옮기기와 같은 자리 — 항목 틀의 오른쪽 (손가락에 가리면 비킨다)
    const frames = new DragFrames(view.dom);
    const home = frameOfLi(li);
    // 테두리는 항목과 함께 밀리다가 본문 칸 끝에 닿으면 거기서 멈춘다 (화면 밖으로 잘려 나가지 않게)
    const clip = (view.dom.closest('.editor') ?? view.dom).getBoundingClientRect();
    swipe = { view, pos, x0, y0, dx: 0, frames, scale };
    const show = () => {
      const { dx } = swipe;
      const dir = Math.abs(dx) >= SWIPE_DISTANCE ? Math.sign(dx) : 0;
      const ok = dir && canSwipe(view, pos, dir);
      const shown = Math.max(-72, Math.min(72, dx * 0.75));
      const cutR = Math.max(0, home.left + home.width + shown - (clip.right - 2));
      const cutL = Math.max(0, clip.left + 2 - (home.left + shown));
      const style = `transform: translateX(${(shown / scale).toFixed(1)}px); --swipe-cut-r: ${(cutR / scale).toFixed(1)}px; --swipe-cut-l: ${(cutL / scale).toFixed(1)}px`;
      decorate(view, [{ pos, cls: `mk-swiping${ok ? ' mk-swipe-ready' : ''}`, style }]);
      frames.set('lift', { ...home, left: home.left + shown }, { outer: true, draw: false });
      const kind = dir ? (ok ? (dir > 0 ? 'indent' : 'outdent') : 'blocked') : 'swipe';
      frames.label(kind, dir ? (ok ? (dir > 0 ? '→ 하위 항목으로' : '← 상위 항목으로') : '더 옮길 수 없어요') : dx > 0 ? '→ 밀면 하위로' : '← 밀면 상위로', { x: x0 + dx, y: y0 }, 'touch');
    };
    const move = (e) => {
      e.preventDefault();
      e.stopPropagation();
      swipe.dx = pointOf(e).clientX - x0;
      show();
    };
    const end = (e, commit = true) => {
      window.removeEventListener('touchmove', move, LISTEN);
      window.removeEventListener('touchend', up, LISTEN);
      window.removeEventListener('touchcancel', cancel, LISTEN);
      frames.destroy();
      const { dx } = swipe;
      swipe = null;
      if (view.isDestroyed) return;
      const dir = Math.abs(dx) >= SWIPE_DISTANCE ? Math.sign(dx) : 0;
      if (commit && dir && shiftItem(view, pos, dir)) {
        haptic(12);
        flashMoved(view);
        return;
      }
      // 제자리로 미끄러져 돌아감
      decorate(view, [{ pos, cls: 'mk-swipe-back', style: 'transform: translateX(0)' }]);
      setTimeout(() => {
        if (!drag && !press && !swipe && !view.isDestroyed) decorate(view, []);
      }, 200);
    };
    const up = (e) => {
      e.preventDefault();
      end(e, true);
    };
    const cancel = (e) => end(e, false);
    window.addEventListener('touchmove', move, LISTEN);
    window.addEventListener('touchend', up, LISTEN);
    window.addEventListener('touchcancel', cancel, LISTEN);
    swipe.dx = pointOf(event).clientX - x0;
    show();
  }

  function canSwipe(view, pos, dir) {
    const $pos = view.state.doc.resolve(pos);
    return dir > 0 ? $pos.index() > 0 : isItem($pos.node($pos.depth - 1));
  }

  function startPress(view, event, kind = 'mouse') {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement ?? null;
    const li = target?.closest('li');
    if (!li || !view.dom.contains(li)) return;
    const pt = pointOf(event);
    // 체크 네모(항목 왼쪽 바깥)·링크·그림·버튼은 제외
    if (pt.clientX < li.getBoundingClientRect().left) return;
    if (target.closest('a, img, video, audio, button, input, .mk-link-card, .mk-file')) return;
    cancelPress();
    hideDeleteButton(true);
    const io = INPUT[kind];
    press = { li, view, kind, x: pt.clientX, y: pt.clientY, t0: Date.now() };
    // 글 고치기 방식(휴대폰 다이얼): 꾹 누르기는 글자 고르기에 맡기고, 곧바로 옆으로 미는 것만 하위·상위로
    const lifting = canDrag();
    // 잠깐 뒤(그냥 누르는 클릭에는 깜빡이지 않게)부터 테두리가 점점 진해진다 → 다 진해지면 들어 올림
    if (lifting) press.markTimer = setTimeout(() => {
      const pos = press && itemPosOf(view, li);
      if (pos == null) return;
      press.marked = true;
      decorate(view, [{ pos, cls: 'mk-pressing' }]);
    }, 70);
    press.move = (e) => {
      const p = pointOf(e);
      const dx = p.clientX - press.x;
      const dy = p.clientY - press.y;
      // 글 고치기 방식: 누른 채 머문 뒤의 움직임은 글자 고르기 (밀기로 보지 않는다)
      if (!lifting && Date.now() - press.t0 > EDIT_SWIPE_WINDOW_MS) {
        cancelPress();
        return;
      }
      // (터치) 옆으로 먼저 밀면 하위·상위로 옮기기
      if (kind === 'touch' && Math.abs(dx) > SWIPE_START && Math.abs(dx) > Math.abs(dy) * 1.6) {
        const { li: item, x: x0, y: y0 } = press;
        cancelPress();
        startSwipe(view, item, x0, y0, e);
        return;
      }
      if (Math.hypot(dx, dy) > io.tolerance) cancelPress(); // 바로 끌기 = 글자 선택 (터치는 스크롤)
      else {
        press.x2 = p.clientX;
        press.y2 = p.clientY;
      }
    };
    press.up = () => cancelPress();
    if (lifting) press.timer = setTimeout(() => {
      const p = press;
      cancelPress({ keepMark: true });
      if (p?.li.isConnected) lift(view, p.li, p.x2 ?? p.x, p.y2 ?? p.y, kind);
    }, holdFor(io.hold));
    window.addEventListener(io.move, press.move, LISTEN);
    window.addEventListener(io.up, press.up, LISTEN);
    if (io.cancel) window.addEventListener(io.cancel, press.up, LISTEN);
  }

  return new Plugin({
    key: listDragKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, old) => tr.getMeta(listDragKey) ?? (tr.docChanged ? DecorationSet.empty : old),
    },
    props: {
      decorations: (state) => {
        const set = listDragKey.getState(state);
        return set.find().length || drag || readOnly ? set : caretDecoration(state);
      },
      handleKeyDown(view, event) {
        if (readOnly || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
        return moveItemBy(view.state, view.dispatch, event.key === 'ArrowUp' ? -1 : 1);
      },
      handleDOMEvents: readOnly ? {} : {
        mousedown(view, event) {
          if (!canDrag()) return false; // 글 고치기 방식: 꾹 눌러도 글자 고르기
          if (event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.detail === 1) startPress(view, event);
          return false; // 편집기는 지금처럼 (커서 놓기·글자 선택)
        },
        touchstart(view, event) {
          // 글 고치기 방식에서 S펜으로 긋는 것은 손글씨(글자 입력) — 옆으로 밀기(하위·상위)로 보지 않는다
          if (!canDrag() && isStylusTouch(event)) {
            cancelPress();
            return false;
          }
          if (event.touches.length === 1) startPress(view, event, 'touch'); // 글 고치기 방식도 옆으로 휙 밀기(하위·상위)는 받는다
          else cancelPress();
          return false; // 그냥 누르면 지금처럼 커서, 밀면 스크롤
        },
        dragstart(_view, event) {
          if (!drag) return false;
          event.preventDefault(); // 들어 올린 동안 브라우저 끌어 놓기는 막는다
          return true;
        },
      },
    },
    view: (view) => {
      // 치는 동안은 마우스를 올린 항목 테두리를 숨기고 커서 항목만 (마우스를 움직이면 다시)
      const typing = (e) => {
        if (view.dom.contains(e.target) && !e.ctrlKey && !e.metaKey) document.body.classList.add('mk-typing');
      };
      const moved = () => document.body.classList.remove('mk-typing');
      window.addEventListener('keydown', typing, true);
      window.addEventListener('mousemove', moved, { passive: true });
      return {
        update: (v) => hideDeleteIfChanged(v),
        destroy: () => {
          window.removeEventListener('keydown', typing, true);
          window.removeEventListener('mousemove', moved);
          cancelPress();
          finish(view, false);
        },
      };
    },
  });
}
