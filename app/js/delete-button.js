// 지우기 단추 (×) — 꾹 눌렀다 그 자리에 놓은 것의 오른쪽 위에 잠깐 (block-move.js 내용 줄 · list-drag.js 목록 항목 함께)
//   한 번에 하나만. DELETE_SHOW_MS 뒤에, 또는 글을 고치거나 커서를 옮기면 사라진다
export const DELETE_SHOW_MS = 2500;

let current = null;

/**
 * @param {import('prosemirror-view').EditorView} view
 * @param {{ pos: number, node: import('prosemirror-model').Node, target: Element, label?: string,
 *           mark?: (on: boolean) => void, remove?: (view, pos: number, node) => void }} opts
 *   target: 단추를 붙일 상자 · mark: 대상 표시 켜고 끄기(기본은 target 의 class) · remove: 지우기(기본은 그 노드를 지움)
 */
export function showDeleteButton(view, { pos, node, target, label = '이 내용 지우기', mark, remove }) {
  hideDeleteButton(true);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mk-delete-btn';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  document.body.append(btn);
  const place = () => {
    const r = target.getBoundingClientRect();
    btn.style.left = `${Math.round(Math.min(window.innerWidth - 40, r.right - 30))}px`;
    btn.style.top = `${Math.round(Math.max(4, r.top - 10))}px`;
  };
  place();
  const setMark = mark ?? ((on) => target.classList.toggle('mk-delete-target', on));
  setMark(true);
  const del = { view, btn, pos, node, state: view.state, place, setMark };
  current = del;
  const press = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (view.state.doc.nodeAt(pos) !== node) return hideDeleteButton();
    navigator.vibrate?.(15);
    target.classList.add('mk-deleting');
    btn.remove();
    setTimeout(() => {
      if (!view.isDestroyed && view.state.doc.nodeAt(pos) === node) {
        if (remove) remove(view, pos, node);
        else view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView());
      }
      target.classList.remove('mk-deleting');
      hideDeleteButton(true);
    }, 180);
  };
  btn.addEventListener('mousedown', press);
  btn.addEventListener('touchstart', press, { passive: false });
  window.addEventListener('scroll', place, true);
  del.timer = setTimeout(() => hideDeleteButton(), DELETE_SHOW_MS);
}

export function hideDeleteButton(now = false) {
  const del = current;
  if (!del) return;
  current = null;
  clearTimeout(del.timer);
  window.removeEventListener('scroll', del.place, true);
  if (!del.view.isDestroyed) del.setMark(false);
  if (now) return del.btn.remove();
  del.btn.classList.add('fading');
  setTimeout(() => del.btn.remove(), 260);
}

/** 그 편집기의 글이나 커서가 바뀌었으면 단추를 거둔다 (플러그인 view.update 에서) */
export function hideDeleteIfChanged(view) {
  const del = current;
  if (del && del.view === view && (view.state.doc !== del.state.doc || !view.state.selection.eq(del.state.selection))) hideDeleteButton();
}

