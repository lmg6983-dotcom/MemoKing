// 목록·체크리스트 항목 순서 바꾸기 (편집기 플러그인)
//   - 항목에 마우스를 올리면 옮길 수 있다는 흐린 점선 테두리, 글자를 꾹(0.3초) 누르면 테두리가 점점 진해지다가
//     들어 올려지고, 그대로 끌면 순서를 바꾼다
//     (바로 끌면 지금처럼 글자 선택 — 여러 줄을 골라 체크리스트로 바꾸는 일과 겹치지 않게)
//   - 다른 항목의 가운데에 놓으면 두 항목이 서로 맞바뀌고, 위·아래 가장자리(줄과 줄 사이)에 놓으면 그 사이에 끼워진다
//   - 놓기 전에 바뀔 모습을 미리 보여 준다 (같은 목록은 항목들이 바뀔 자리로 미끄러지고, 다른 목록은 가로줄·테두리)
//   - 하위 항목은 함께 움직인다. Esc 로 취소. 키보드: Alt+↑ / Alt+↓ 로 한 칸 위·아래로
import { Plugin, PluginKey, TextSelection, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { previewOrder, dropAt } from './core/list-order.js';

export const listDragKey = new PluginKey('memoking-list-drag');

export const HOLD_MS = 300; // 이만큼 누르고 있으면 들어 올림 (그동안 테두리가 점점 진해진다)
const MOVE_TOLERANCE = 5; // 그 전에 이만큼 움직이면 글자 선택으로 본다

const isItem = (node) => node?.type.name === 'list_item';

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
function currentItem(state) {
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
    window.removeEventListener('mousemove', p.move, true);
    window.removeEventListener('mouseup', p.up, true);
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
    drag.line.hidden = true;
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

  function finish(view, commit) {
    if (!drag) return;
    const d = drag;
    cancelAnimationFrame(d.raf);
    clearPreview(view);
    drag = null;
    window.removeEventListener('mousemove', d.move, true);
    window.removeEventListener('mouseup', d.up, true);
    window.removeEventListener('keydown', d.key, true);
    window.removeEventListener('selectstart', d.block, true);
    clearInterval(d.timer);
    d.line.remove();
    d.badge.remove();
    document.body.classList.remove('mk-list-dragging');
    const { state } = view;
    if (!commit || !d.drop) {
      // 끄는 동안 늘어난 글자 선택은 버리고 커서를 그 항목에
      view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(Math.min(d.srcPos + 2, state.doc.content.size)))));
      view.focus();
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
  function previewSame(view, drop, extra = [], { free = false } = {}) {
    const { tops, slots, s, scale, positions, listPos, heights } = drag;
    const order = previewOrder(positions.length, s, drop);
    const specs = [{ pos: listPos, cls: 'mk-sorting' }];
    let follow = drag.y + scrollTop() - drag.startY; // 끄는 항목이 커서를 따라간 거리
    if (!free) follow = Math.min(drag.bottom - heights[s] + 6, Math.max(tops[0] - 6, tops[s] + follow)) - tops[s];
    let y = tops[0];
    order.forEach((i) => {
      if (i === s) {
        specs.push({ pos: positions[i], cls: 'mk-lift', style: `transform: translateY(${(follow / scale).toFixed(1)}px)` });
      } else {
        const dy = y - tops[i];
        const cls = drop?.kind === 'swap' && i === drop.index ? 'mk-swap-target' : '';
        specs.push({ pos: positions[i], cls, style: dy ? `transform: translateY(${(dy / scale).toFixed(1)}px)` : '' });
      }
      y += slots[i];
    });
    decorate(view, [...specs, ...extra]);
  }

  // 커서 옆 안내: 지금 놓으면 무엇이 되는지
  function showBadge(kind) {
    const b = drag.badge;
    b.dataset.kind = kind ?? '';
    b.textContent = kind === 'swap' ? '⇅ 맞바꾸기' : kind === 'insert' ? '↳ 여기에 넣기' : '';
    b.hidden = !kind;
    b.style.left = `${drag.x + 16}px`;
    b.style.top = `${drag.y + 14}px`;
  }

  function place(view, x, y) {
    const d = drag;
    d.drop = null;
    d.line.hidden = true;
    // 1) 다른 목록(하위 목록 포함)의 항목 위면 그쪽으로 — 끄는 항목은 마우스를 통과시켜 그 아래가 잡힌다
    const hit = document.elementFromPoint(x, y)?.closest?.('li');
    const other = hit && view.dom.contains(hit) && hit.parentElement !== d.list && !d.src.contains(hit) && !hit.contains(d.src) ? hit : null;
    if (other) {
      const pos = itemPosOf(view, other);
      if (pos != null) {
        const node = view.state.doc.nodeAt(pos);
        const first = other.querySelector(':scope > p')?.getBoundingClientRect() ?? other.getBoundingClientRect();
        const drop = dropAt(0, (y - first.top) / Math.max(1, first.height));
        if (drop.kind === 'swap') {
          d.drop = { cross: true, kind: 'swap', pos };
          previewSame(view, null, [{ pos, cls: 'mk-swap-target' }], { free: true });
        } else {
          const before = drop.index === 0;
          d.drop = { cross: true, kind: 'insert', pos: before ? pos : pos + node.nodeSize };
          previewSame(view, null, [], { free: true });
          const r = other.getBoundingClientRect();
          d.line.hidden = false;
          d.line.style.left = `${r.left}px`;
          d.line.style.width = `${Math.max(40, r.width)}px`;
          d.line.style.top = `${(before ? r.top : r.bottom) - 1}px`;
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
    d.drop = same ? null : drop;
    previewSame(view, d.drop);
    showBadge(d.drop?.kind);
  }

  // 마우스가 움직이면 다음 화면 그리기 때 한 번만 (빠르게 끌어도 매끄럽게)
  function schedulePlace(view) {
    if (!drag || drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      place(view, drag.x, drag.y);
    });
  }

  function lift(view, li, x, y) {
    const srcPos = itemPosOf(view, li);
    const list = li.parentElement;
    if (srcPos == null || !list) return;
    const scroller = scrollerOf(view.dom);
    const items = directItems(list);
    const st = scroller?.scrollTop ?? 0;
    const rects = items.map((it) => it.getBoundingClientRect());
    const tops = rects.map((r) => r.top + st);
    const heights = rects.map((r) => r.height);
    const gap = items.length > 1 ? Math.max(0, tops[1] - (tops[0] + heights[0])) : 0;
    const slots = tops.map((t, i) => (i < tops.length - 1 ? tops[i + 1] - t : heights[i] + gap));
    const scale = li.offsetHeight ? rects[items.indexOf(li)].height / li.offsetHeight : 1; // 본문 확대·축소 배율
    const line = document.createElement('div');
    line.className = 'mk-drop-line';
    line.hidden = true;
    const badge = document.createElement('div');
    badge.className = 'mk-drag-badge';
    badge.hidden = true;
    document.body.append(line, badge);
    getSelection()?.removeAllRanges(); // 누르는 동안 시작된 글자 선택은 버린다
    const $src = view.state.doc.resolve(srcPos);
    drag = {
      view, src: li, srcPos, list, listPos: $src.before(), positions: items.map((it) => itemPosOf(view, it)), s: items.indexOf(li),
      tops, heights, slots, bottom: tops.at(-1) + heights.at(-1), scale, scroller, line, badge,
      drop: null, x, y, startY: y + st, timer: 0, raf: 0,
    };
    document.body.classList.add('mk-list-dragging');
    previewSame(view, null); // 들어 올린 모습
    drag.block = (e) => e.preventDefault();
    drag.move = (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation(); // 편집기의 글자 선택 늘리기를 막는다
      drag.x = e.clientX;
      drag.y = e.clientY;
      schedulePlace(view);
    };
    drag.up = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (drag) {
        drag.x = e.clientX;
        drag.y = e.clientY;
        place(view, e.clientX, e.clientY); // 놓은 자리로 마지막 판정
      }
      finish(view, true);
    };
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
      const edge = 40;
      const up = r.top + edge - drag.y;
      const down = drag.y - (r.bottom - edge);
      const dy = up > 0 ? -Math.ceil(up / 3) : down > 0 ? Math.ceil(down / 3) : 0;
      if (dy) {
        scroller.scrollTop += dy;
        place(view, drag.x, drag.y);
      }
    }, 30);
    window.addEventListener('mousemove', drag.move, true);
    window.addEventListener('mouseup', drag.up, true);
    window.addEventListener('keydown', drag.key, true);
    window.addEventListener('selectstart', drag.block, true);
  }

  function startPress(view, event) {
    const target = event.target instanceof Element ? event.target : null;
    const li = target?.closest('li');
    if (!li || !view.dom.contains(li)) return;
    // 체크 네모(항목 왼쪽 바깥)·링크·그림·버튼은 제외
    if (event.clientX < li.getBoundingClientRect().left) return;
    if (target.closest('a, img, video, audio, button, input, .mk-link-card, .mk-file')) return;
    cancelPress();
    press = { li, view, x: event.clientX, y: event.clientY };
    // 잠깐 뒤(그냥 누르는 클릭에는 깜빡이지 않게)부터 테두리가 점점 진해진다 → 다 진해지면 들어 올림
    press.markTimer = setTimeout(() => {
      const pos = press && itemPosOf(view, li);
      if (pos == null) return;
      press.marked = true;
      decorate(view, [{ pos, cls: 'mk-pressing' }]);
    }, 70);
    press.move = (e) => {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress(); // 바로 끌기 = 글자 선택
      else {
        press.x2 = e.clientX;
        press.y2 = e.clientY;
      }
    };
    press.up = () => cancelPress();
    press.timer = setTimeout(() => {
      const p = press;
      cancelPress({ keepMark: true });
      if (p?.li.isConnected) lift(view, p.li, p.x2 ?? p.x, p.y2 ?? p.y);
    }, HOLD_MS);
    window.addEventListener('mousemove', press.move, true);
    window.addEventListener('mouseup', press.up, true);
  }

  return new Plugin({
    key: listDragKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, old) => tr.getMeta(listDragKey) ?? (tr.docChanged ? DecorationSet.empty : old),
    },
    props: {
      decorations: (state) => listDragKey.getState(state),
      handleKeyDown(view, event) {
        if (readOnly || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
        return moveItemBy(view.state, view.dispatch, event.key === 'ArrowUp' ? -1 : 1);
      },
      handleDOMEvents: readOnly ? {} : {
        mousedown(view, event) {
          if (event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.detail === 1) startPress(view, event);
          return false; // 편집기는 지금처럼 (커서 놓기·글자 선택)
        },
        dragstart(_view, event) {
          if (!drag) return false;
          event.preventDefault(); // 들어 올린 동안 브라우저 끌어 놓기는 막는다
          return true;
        },
      },
    },
    view: (view) => ({
      destroy: () => {
        cancelPress();
        finish(view, false);
      },
    }),
  });
}
