// 목록·체크리스트 항목 순서 바꾸기 (편집기 플러그인)
//   - 항목에 마우스를 올리면 왼쪽에 손잡이(⠿)가 보이고, 끌어서 다른 항목 위·아래에 놓으면 그 자리로 옮겨진다
//     (하위 항목은 함께 움직이고, 다른 목록으로도 옮길 수 있다. 놓을 자리에는 가로줄로 표시)
//   - 키보드: Alt+↑ / Alt+↓ 로 지금 항목을 한 칸 위·아래로
import { Plugin, PluginKey, Decoration, DecorationSet, TextSelection } from '../vendor/milkdown.js';

export const listDragKey = new PluginKey('memoking-list-drag');

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

function handleWidget() {
  const h = document.createElement('span');
  h.className = 'mk-drag-handle';
  h.contentEditable = 'false';
  h.title = '끌어서 순서 바꾸기 (Alt+↑ / Alt+↓)';
  h.setAttribute('aria-hidden', 'true');
  return h;
}

function handleDecos(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (isItem(node)) decos.push(Decoration.widget(pos + 1, handleWidget, { side: -1, key: 'mk-drag', ignoreSelection: true }));
    return true;
  });
  return DecorationSet.create(doc, decos);
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
  return null;
}

/** @param {{ readOnly?: boolean }} options */
export function createListDrag({ readOnly = false } = {}) {
  let drag = null;

  function finish(view, commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    window.removeEventListener('mousemove', d.move, true);
    window.removeEventListener('mouseup', d.up, true);
    window.removeEventListener('keydown', d.key, true);
    clearInterval(d.timer);
    d.line.remove();
    d.srcEl?.classList.remove('mk-drag-source');
    document.body.classList.remove('mk-list-dragging');
    if (!commit || d.target == null) return;
    const tr = moveItemTr(view.state, d.src, d.target);
    if (tr) view.dispatch(tr);
    view.focus();
  }

  function start(view, event, handle) {
    const srcEl = handle.closest('li');
    const src = srcEl && itemPosOf(view, srcEl);
    if (src == null) return false;
    event.preventDefault();
    const line = document.createElement('div');
    line.className = 'mk-drop-line';
    line.hidden = true;
    document.body.append(line);
    const scroller = scrollerOf(view.dom);
    drag = { src, srcEl, line, target: null, y: event.clientY, timer: 0 };
    srcEl.classList.add('mk-drag-source');
    document.body.classList.add('mk-list-dragging');

    const place = (x, y) => {
      drag.target = null;
      line.hidden = true;
      const hit = document.elementFromPoint(x, y);
      const li = hit?.closest?.('li');
      if (!li || !view.dom.contains(li) || srcEl.contains(li)) return;
      const pos = itemPosOf(view, li);
      if (pos == null) return;
      const node = view.state.doc.nodeAt(pos);
      const r = li.getBoundingClientRect();
      // 하위 목록이 있는 항목은 첫 줄의 가운데를 기준으로 (그 아래는 "뒤에")
      const first = li.querySelector(':scope > p')?.getBoundingClientRect() ?? r;
      const before = y < first.top + first.height / 2;
      drag.target = before ? pos : pos + node.nodeSize;
      line.hidden = false;
      line.style.left = `${r.left}px`;
      line.style.width = `${Math.max(40, r.width)}px`;
      line.style.top = `${(before ? r.top : r.bottom) - 1}px`;
    };
    drag.move = (e) => {
      if (!drag) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      place(e.clientX, e.clientY);
    };
    drag.up = (e) => {
      if (drag) place(e.clientX, e.clientY);
      finish(view, true);
    };
    drag.key = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(view, false);
      }
    };
    // 위·아래 끝 가까이에서는 저절로 스크롤
    drag.timer = setInterval(() => {
      if (!drag || !scroller) return;
      const r = scroller.getBoundingClientRect();
      const edge = 28;
      const dy = drag.y < r.top + edge ? -12 : drag.y > r.bottom - edge ? 12 : 0;
      if (dy) {
        scroller.scrollTop += dy;
        if (drag.x != null) place(drag.x, drag.y);
      }
    }, 30);
    window.addEventListener('mousemove', drag.move, true);
    window.addEventListener('mouseup', drag.up, true);
    window.addEventListener('keydown', drag.key, true);
    return true;
  }

  return new Plugin({
    key: listDragKey,
    state: {
      init: (_c, state) => (readOnly ? DecorationSet.empty : handleDecos(state.doc)),
      apply: (tr, old) => (readOnly ? old : tr.docChanged ? handleDecos(tr.doc) : old),
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
          if (event.button !== 0) return false;
          const handle = event.target instanceof Element ? event.target.closest('.mk-drag-handle') : null;
          if (!handle || !view.dom.contains(handle)) return false;
          return start(view, event, handle);
        },
      },
    },
    view: (view) => ({ destroy: () => finish(view, false) }),
  });
}
