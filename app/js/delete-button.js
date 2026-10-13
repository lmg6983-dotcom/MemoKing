import { haptic } from './dom.js';
import { copyBlock } from './copy-content.js';
// 지우기 단추 (×) — 꾹 눌렀다 그 자리에 놓은 것의 오른쪽 위에 잠깐 (block-move.js 내용 줄·목록 전체 · list-drag.js 목록 항목 함께)
//   흰 동그라미에 빨간 ×. 한 번에 하나만, DELETE_SHOW_MS 뒤에(또는 글을 고치거나 커서를 옮기면) 흐려지며 사라진다.
//   PC(마우스): 그림·손 메모·소리·파일·링크 카드에 마우스를 올려도 뜬다 (hover — 시간으로 사라지지 않고, 마우스가 떠나면 거둔다.
//   빨갛게 비치는 표시는 × 위에 올렸을 때만)
//   누르면: 대상이 붉게 비쳤다가 작아지며 흐려지고, 그 자리가 접히며 아래 줄들이 부드럽게 올라온 뒤 지운다.
//   × 왼쪽에는 복사 단추 (그림은 그림으로, 그 밖의 내용은 서식 + 글로 — copy-content.js). 누르면 잠깐 ✓
export const DELETE_SHOW_MS = 2500;
const FADE_MS = 200; // 작아지며 흐려지기
const COLLAPSE_MS = 200; // 그 자리 접기

let current = null;
const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.5v-.4A1.6 1.6 0 0 0 8.9 1.5H4.1A1.6 1.6 0 0 0 2.5 3.1v4.8a1.6 1.6 0 0 0 1.6 1.6h.4"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const FAIL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v5.5M8 12.2v.3"/></svg>';
// 화면 읽기 프로그램에 "복사했어요" 를 알려 주는 숨은 자리 (하나만)
function announce(text) {
  let live = document.getElementById('mk-copy-live');
  if (!live) {
    live = document.createElement('div');
    live.id = 'mk-copy-live';
    live.className = 'mk-sr-only';
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = '';
  requestAnimationFrame(() => (live.textContent = text));
}

/** 대상을 담고 스크롤되는 상자 (없으면 null = 창) */
function scrollParent(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * @param {import('prosemirror-view').EditorView} view
 * @param {{ pos: number, node: import('prosemirror-model').Node, target: Element, label?: string,
 *           deco: (spec: { cls: string, style?: string } | null) => void, markTarget?: boolean,
 *           remove?: (view, pos: number, node) => void, hover?: { enter: () => void, leave: () => void } }} opts
 *   pos·node: 지울 노드 · target: 단추를 붙일 상자 (사진·소리면 그 상자, 아니면 그 줄)
 *   deco: 지울 노드에 표시(데코레이션)를 달고 떼기 — 편집기가 그리는 줄은 class 를 직접 바꾸면 되돌려지므로
 *   markTarget: 대상 표시를 target 의 class 로 (사진·소리처럼 편집기가 다시 그리지 않는 상자)
 *   remove: 지우기 (기본은 그 노드를 지움)
 */
export function showDeleteButton(view, { pos, node, target, label = '이 내용 지우기', deco, markTarget = false, remove, hover = null }) {
  hideDeleteButton(true);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `mk-delete-btn${hover ? ' hover' : ''}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6"/></svg>';
  // 복사 단추 (× 왼쪽)
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = `mk-copy-btn${hover ? ' hover' : ''}`;
  const copyLabel = label.replace(/지우기$/, '복사'); // "이 목록 지우기" → "이 목록 복사"
  copyBtn.title = copyLabel;
  copyBtn.setAttribute('aria-label', copyLabel);
  copyBtn.innerHTML = COPY_ICON;
  document.body.append(copyBtn, btn);
  // 단추는 화면에 고정(position: fixed)이라, 큰 그림을 스크롤하면 위 막대에 올라탈 수 있다 →
  //   편집기에서 보이는 칸 안으로만: 대상의 위가 가려지면 보이는 부분의 위에 붙고, 대상이 다 가려지면 숨는다
  const scroller = scrollParent(target);
  const place = () => {
    const r = target.getBoundingClientRect();
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const top = Math.max(r.top - 9, box.top + 4);
    const visible = r.bottom - 12 > box.top + 4 && r.top < box.bottom - 12 && top + 24 <= Math.min(r.bottom + 9, box.bottom);
    const left = Math.round(Math.min(window.innerWidth - 32, r.right - 22));
    btn.style.visibility = visible ? '' : 'hidden';
    btn.style.left = `${left}px`;
    btn.style.top = `${Math.round(top)}px`;
    copyBtn.style.visibility = visible ? '' : 'hidden';
    copyBtn.style.left = `${left - 36}px`; // × 와 손가락 닿는 범위가 겹치지 않게
    copyBtn.style.top = `${Math.round(top)}px`;
  };
  place();
  const setMark = (on) => {
    if (markTarget) target.classList.toggle('mk-delete-target', on);
    else if (on) deco({ cls: 'mk-delete-target' });
    else setTimeout(() => !view.isDestroyed && deco(null), 0); // 편집기 갱신 중일 수 있어 한 박자 뒤에
  };
  if (!hover) setMark(true);
  const del = { view, btn, copyBtn, pos, node, target, state: view.state, place, setMark: hover ? (on) => !on && setMark(false) : setMark };
  if (hover) {
    btn.addEventListener('mouseenter', () => {
      hover.enter();
      setMark(true);
    });
    btn.addEventListener('mouseleave', () => {
      setMark(false);
      hover.leave();
    });
    // 복사 단추 위에 있어도 단추들은 그대로 (붉은 표시는 × 위에서만)
    copyBtn.addEventListener('mouseenter', () => hover.enter());
    copyBtn.addEventListener('mouseleave', () => hover.leave());
  }
  let copying = false;
  const copy = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (copying) return; // mousedown 뒤 따라오는 click 은 한 번으로
    if (view.state.doc.nodeAt(pos) !== node) return hideDeleteButton();
    copying = true;
    // 다시 누르면 다시 복사 (실패한 뒤 다시 해 보기 · 그사이 다른 것을 복사했을 때)
    copyBtn.classList.remove('done', 'failed');
    copyBtn.innerHTML = COPY_ICON;
    haptic(8);
    clearTimeout(del.timer); // 누른 뒤에는 ✓ 를 볼 만큼 더 둔다
    copyBlock(view, pos, node, target).then((what) => {
      copyBtn.classList.add('done');
      copyBtn.innerHTML = DONE_ICON;
      copyBtn.title = what === '그림' ? '그림을 복사했어요' : what === '주소' ? '그림 주소를 복사했어요'
        : what === '파일' ? '파일을 복사했어요. 탐색기 · 메신저에 붙여 넣으세요' : '내용을 복사했어요';
      announce(copyBtn.title);
    }, (err) => {
      copyBtn.classList.add('failed');
      copyBtn.innerHTML = FAIL_ICON;
      copyBtn.title = `복사하지 못했어요: ${err?.message ?? err}`;
      announce(copyBtn.title);
    }).finally(() => {
      setTimeout(() => (copying = false), 0); // 바로 뒤따르는 click 까지는 막고
      if (!hover && current === del) del.timer = setTimeout(() => hideDeleteButton(), 1600);
    });
  };
  copyBtn.addEventListener('mousedown', copy);
  copyBtn.addEventListener('touchstart', copy, { passive: false });
  copyBtn.addEventListener('click', copy); // 키보드(Enter · Space)
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
    copyBtn.remove();
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
  // 키보드(Enter · Space)로 누른 것만 — 마우스 · 손가락은 위에서 이미 처리 (detail 0 = 키보드)
  btn.addEventListener('click', (e) => { if (e.detail === 0 && current === del) press(e); });
  window.addEventListener('scroll', place, true);
  if (!hover) del.timer = setTimeout(() => hideDeleteButton(), DELETE_SHOW_MS);
}

/** 지금 이 상자에 지우기 단추가 떠 있는가 */
export const deleteShownFor = (target) => Boolean(current && current.target === target);

export function hideDeleteButton(now = false) {
  const del = current;
  if (!del) return;
  current = null;
  clearTimeout(del.timer);
  window.removeEventListener('scroll', del.place, true);
  if (!del.view.isDestroyed) del.setMark(false);
  if (now) {
    del.copyBtn.remove();
    return del.btn.remove();
  }
  del.btn.classList.add('fading');
  del.copyBtn.classList.add('fading');
  setTimeout(() => {
    del.btn.remove();
    del.copyBtn.remove();
  }, 260);
}

/** 그 편집기의 글이나 커서가 바뀌었으면 단추를 거둔다 (플러그인 view.update 에서) */
export function hideDeleteIfChanged(view) {
  const del = current;
  if (del && del.view === view && (view.state.doc !== del.state.doc || !view.state.selection.eq(del.state.selection))) hideDeleteButton();
}
