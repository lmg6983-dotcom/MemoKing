import { haptic } from './dom.js';
// 지우기 단추 (×) — 꾹 눌렀다 그 자리에 놓은 것의 오른쪽 위에 잠깐 (block-move.js 내용 줄·목록 전체 · list-drag.js 목록 항목 함께)
//   흰 동그라미에 빨간 ×. 한 번에 하나만, DELETE_SHOW_MS 뒤에(또는 글을 고치거나 커서를 옮기면) 흐려지며 사라진다.
//   누르면: 대상이 붉게 비쳤다가 작아지며 흐려지고, 그 자리가 접히며 아래 줄들이 부드럽게 올라온 뒤 지운다.
export const DELETE_SHOW_MS = 2500;
const FADE_MS = 200; // 작아지며 흐려지기
const COLLAPSE_MS = 200; // 그 자리 접기

let current = null;

/**
 * @param {import('prosemirror-view').EditorView} view
 * @param {{ pos: number, node: import('prosemirror-model').Node, target: Element, label?: string,
 *           deco: (spec: { cls: string, style?: string } | null) => void, markTarget?: boolean,
 *           remove?: (view, pos: number, node) => void }} opts
 *   pos·node: 지울 노드 · target: 단추를 붙일 상자 (사진·소리면 그 상자, 아니면 그 줄)
 *   deco: 지울 노드에 표시(데코레이션)를 달고 떼기 — 편집기가 그리는 줄은 class 를 직접 바꾸면 되돌려지므로
 *   markTarget: 대상 표시를 target 의 class 로 (사진·소리처럼 편집기가 다시 그리지 않는 상자)
 *   remove: 지우기 (기본은 그 노드를 지움)
 */
export function showDeleteButton(view, { pos, node, target, label = '이 내용 지우기', deco, markTarget = false, remove }) {
  hideDeleteButton(true);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mk-delete-btn';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6"/></svg>';
  document.body.append(btn);
  const place = () => {
    const r = target.getBoundingClientRect();
    btn.style.left = `${Math.round(Math.min(window.innerWidth - 32, r.right - 22))}px`;
    btn.style.top = `${Math.round(Math.max(4, r.top - 9))}px`;
  };
  place();
  const setMark = (on) => {
    if (markTarget) target.classList.toggle('mk-delete-target', on);
    else if (on) deco({ cls: 'mk-delete-target' });
    else setTimeout(() => !view.isDestroyed && deco(null), 0); // 편집기 갱신 중일 수 있어 한 박자 뒤에
  };
  setMark(true);
  const del = { view, btn, pos, node, state: view.state, place, setMark };
  current = del;
  const press = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (view.state.doc.nodeAt(pos) !== node) return hideDeleteButton();
    haptic(15);
    // 단추는 눌린 듯 작아지며 사라지고
    clearTimeout(del.timer);
    window.removeEventListener('scroll', place, true);
    current = null;
    btn.classList.add('pressed');
    setTimeout(() => btn.remove(), 180);
    if (markTarget) target.classList.remove('mk-delete-target');
    // 대상: 붉게 비쳤다가 작아지며 흐려지고 → 그 자리가 접힌다 (높이를 정해 두어야 접히는 모습이 보인다)
    const box = view.nodeDOM(pos);
    const h = box instanceof Element ? box.getBoundingClientRect().height : 0;
    const scale = box instanceof HTMLElement && box.offsetHeight ? h / box.offsetHeight : 1; // 본문 확대·축소
    const height = `height: ${(h / scale).toFixed(1)}px`;
    deco({ cls: 'mk-deleting', style: height });
    setTimeout(() => !view.isDestroyed && deco({ cls: 'mk-deleting mk-collapsing', style: 'height: 0px' }), FADE_MS);
    setTimeout(() => {
      if (view.isDestroyed) return;
      deco(null);
      if (view.state.doc.nodeAt(pos) !== node) return;
      if (remove) remove(view, pos, node);
      else view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView());
    }, FADE_MS + COLLAPSE_MS);
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
