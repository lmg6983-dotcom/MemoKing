import { haptic } from './dom.js';
import { copyBlock, saveBlock, shareBlock, canShare } from './copy-content.js';
import { SHARE_DONE, isShareMenuOpen } from './share-menu.js';
import { openContextMenu } from './ctx-menu.js';
import { COPY_ICON, DONE_ICON, FAIL_ICON, SHARE_ICON, OPEN_ICON, SAVE_ICON, TRASH_ICON, CLOSE_ICON } from './content-icons.js';
// 내용(그림 · 파일 · 표 …)의 복사 · 저장 · 공유 · 지우기 — 두 가지 모양
//   휴대폰(손가락): 꾹 눌렀다 놓거나 짧게 누른 내용의 오른쪽 위에 단추 줄이 잠깐 (showDeleteButton) — 흰 동그라미에 빨간 ×.
//     한 번에 하나만, DELETE_SHOW_MS 뒤에(또는 글을 고치거나 커서를 옮기면) 흐려지며 사라진다.
//     표는 고치는 동안 표 위 오른쪽 밖(표를 가리지 않는 자리)에 계속 떠 있다 (placement 'above' + persist).
//     × 왼쪽에는 복사 단추 (그림은 그림으로, 그 밖의 내용은 서식 + 글로 — copy-content.js), 그 왼쪽에 저장 단추
//     (그림 · 파일은 파일 그대로, 표는 CSV, 그 밖은 글 파일 — 어디에 저장할지 고르는 창), 맨 왼쪽에 공유 단추. 누르면 잠깐 ✓
//   PC(마우스): 단추를 띄우지 않는다 — 셀 · 글을 가려 고치기 어려웠다. 내용을 오른쪽 클릭하면 Windows 11 메뉴처럼 맨 위 한 줄에
//     아이콘(복사 · 저장 · 공유 · 지우기)이 있는 메뉴 (showContentMenu).
//   지우기: 대상이 붉게 비쳤다가 작아지며 흐려지고, 그 자리가 접히며 아래 줄들이 부드럽게 올라온 뒤 지운다 (PC 는 그 자리에 "되돌리기" 안내)
export const DELETE_SHOW_MS = 2500;
const FADE_MS = 200; // 작아지며 흐려지기
const COLLAPSE_MS = 200; // 그 자리 접기

let current = null;
// 저장 창을 다녀오면 단추는 이미 거둬졌을 수 있어 메모 창 상태 줄에도 (PC note.js)
const notice = (text, error = false) => window.dispatchEvent(new CustomEvent('mk:notice', { detail: { text, error } }));
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

// 지운 자리에 "표를 지웠어요 [되돌리기] (Ctrl+Z)" 를 잠깐 (하나만) — 마우스로도 되돌릴 수 있게 (목록 카드의 되돌리기 띠처럼)
function undoHint(what, rect, view) {
  document.getElementById('mk-undo-hint')?.remove();
  const tip = document.createElement('div');
  tip.id = 'mk-undo-hint';
  tip.className = 'mk-undo-hint';
  tip.setAttribute('role', 'status');
  tip.innerHTML = '<span></span> <button type="button" class="mk-undo-btn">되돌리기</button> <kbd>Ctrl+Z</kbd>';
  tip.firstChild.textContent = `${what}${/[가-힣]$/.test(what) && (what.charCodeAt(what.length - 1) - 0xac00) % 28 ? '을' : '를'} 지웠어요`;
  const undoBtn = tip.querySelector('.mk-undo-btn');
  undoBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서를 빼앗지 않게
  undoBtn.addEventListener('click', () => {
    tip.remove();
    if (view.isDestroyed) return;
    view.focus();
    // 편집기의 Ctrl+Z 와 똑같이 (같은 되돌리기 기록)
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  document.body.append(tip);
  const top = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, rect.top));
  const left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, rect.left + rect.width / 2 - tip.offsetWidth / 2));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  const gone = () => {
    tip.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  // 글을 치거나 Esc 를 누르면 거둔다 — Ctrl · Shift 만 눌러도 사라지면 Ctrl+Z 를 누르는 사이 안내가 없어졌다
  const onKey = (e) => {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    gone();
  };
  let timer = 0;
  const later = () => {
    timer = setTimeout(() => {
      tip.classList.add('fading');
      setTimeout(gone, 260);
    }, 5000); // 되돌리기 단추를 누를 틈
  };
  later();
  tip.addEventListener('mouseenter', () => clearTimeout(timer)); // 단추로 가는 동안 사라지지 않게
  tip.addEventListener('mouseleave', later);
  document.addEventListener('keydown', onKey, true);
}

const COPY_DONE = (what) => (what === '그림' ? '그림을 복사했어요' : what === '주소' ? '그림 주소를 복사했어요'
  : what === '파일' ? '파일을 복사했어요. 탐색기 · 메신저에 붙여 넣으세요' : what === '링크' ? '링크 주소를 복사했어요' : '내용을 복사했어요');
const SAVE_DONE = (name) => `저장했어요: ${name}`;
const SHARE_DONE_TEXT = (what) => SHARE_DONE[what] ?? '공유했어요';
// 저장 · 공유는 앱이 알려 준 이유(파일을 찾지 못했어요 등)를 그대로
const failText = (fileAct, err) => (fileAct && err?.message && !/^Error invoking/.test(err.message) ? err.message : `${fileAct ?? '복사'}하지 못했어요. 다시 눌러 주세요`);

/** 대상을 담고 스크롤되는 상자 (없으면 null = 창) */
function scrollParent(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * 지우기 (붉게 비침 → 작아지며 흐려짐 → 그 자리가 접힘 → 지움). 단추(휴대폰)와 오른쪽 클릭 메뉴(PC)가 함께 쓴다
 * @param {{ pos: number, node: object, target: Element, markTarget?: boolean, deco: Function, label?: string, remove?: Function }} o
 * @param {{ undo?: boolean }} how undo: 지운 자리에 되돌리기 안내 (PC)
 */
export function deleteContent(view, { pos, node, target, markTarget = false, deco, label = '이 내용 지우기', remove }, { undo = false } = {}) {
  if (view.state.doc.nodeAt(pos) !== node) return false;
  if (markTarget) target.classList.remove('mk-delete-target');
  // 대상: 붉게 비쳤다가 작아지며 흐려지고 → 그 자리가 접힌다 (높이를 정해 두어야 접히는 모습이 보인다)
  const box = view.nodeDOM(pos);
  const where = target.getBoundingClientRect();
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
    if (undo) undoHint(label.replace(/ 지우기$/, '').replace(/^이 /, ''), where, view);
  }, FADE_MS + COLLAPSE_MS);
  return true;
}

/**
 * PC: 내용을 오른쪽 클릭했을 때의 메뉴 — 맨 위 한 줄에 아이콘(복사 · 저장 · 공유 · 지우기), 아래에 글 항목 (열기 · 표 바꾸기 …)
 *   opts 는 showDeleteButton 과 같다 + extraItems(메뉴 글 항목 더) · onExtra(id) (그 항목을 골랐을 때). 다 하면 메모 창 상태 줄에 알린다.
 * @param {{ x: number, y: number } | null} at 메뉴를 띄울 자리 (창 안 좌표)
 * @returns {Promise<boolean>} 메뉴를 띄웠는가
 */
export async function showContentMenu(view, opts, at) {
  const { pos, node, target, label = '이 내용 지우기', copyLabel = null, open = null, extraItems = [], onExtra = null } = opts;
  hideDeleteButton(true);
  const verb = (v) => label.replace(/지우기$/, v); // "이 표 지우기" → "이 표 복사"
  const icons = [
    { id: 'copy', icon: COPY_ICON, label: copyLabel ?? verb('복사') },
    { id: 'save', icon: SAVE_ICON, label: `${verb('저장')}…` },
    ...(canShare() ? [{ id: 'share', icon: SHARE_ICON, label: `${verb('공유')}…` }] : []),
    { id: 'delete', icon: TRASH_ICON, label, danger: true },
  ];
  const items = [...(open ? [{ id: 'open', label: open.label, hint: 'Enter' }] : []), ...extraItems];
  const id = await openContextMenu({ x: at?.x ?? 0, y: at?.y ?? 0, icons, items, label: verb('메뉴').replace(/^이 /, '') });
  if (!view.isDestroyed) view.focus(); // 메뉴가 가져간 포커스를 편집기로 (고른 자리는 그대로)
  if (!id || view.isDestroyed) return true;
  if (extraItems.some((it) => it.id === id)) return onExtra?.(id), true;
  if (view.state.doc.nodeAt(pos) !== node) return true;
  if (id === 'open') return open.run(), true;
  if (id === 'delete') return deleteContent(view, opts, { undo: true }), true;
  const [run, done, act] = {
    copy: [() => copyBlock(view, pos, node, target), COPY_DONE, null],
    save: [() => saveBlock(view, pos, node, target), SAVE_DONE, '저장'],
    share: [() => shareBlock(view, pos, node, target), SHARE_DONE_TEXT, '공유'],
  }[id];
  try {
    const what = await run();
    if (what === 'cancelled') return true;
    if (opts.markTarget) document.dispatchEvent(new CustomEvent('mk:content-tools'));
    announce(done(what));
    notice(done(what));
  } catch (err) {
    console.warn('content menu', id, err);
    announce(failText(act, err));
    notice(failText(act, err), true);
  }
  return true;
}

/**
 * 휴대폰: 내용 곁에 단추 줄을 띄운다
 * @param {import('prosemirror-view').EditorView} view
 * @param {{ pos: number, node: import('prosemirror-model').Node, target: Element, label?: string,
 *           deco: (spec: { cls: string, style?: string } | null) => void, markTarget?: boolean,
 *           remove?: (view, pos: number, node) => void, showMs?: number, placement?: 'corner' | 'above', persist?: boolean,
 *           follow?: (view) => ({ pos: number, node: object, target: Element } | null) }} opts
 *   pos·node: 지울 노드 · target: 단추를 붙일 상자 (사진·소리면 그 상자, 아니면 그 줄)
 *   deco: 지울 노드에 표시(데코레이션)를 달고 떼기 — 편집기가 그리는 줄은 class 를 직접 바꾸면 되돌려지므로
 *   markTarget: 대상 표시를 target 의 class 로 (사진·소리처럼 편집기가 다시 그리지 않는 상자)
 *   remove: 지우기 (기본은 그 노드를 지움)
 *   open: { label, run } — 누르면 바로 열리던 것(파일·링크 카드·수식)은 누르면 단추만, 여는 것은 이 "열기" 단추로
 *   placement: 'corner'(기본) 대상의 오른쪽 위 모서리 · 'above' 대상 위 오른쪽 밖 — 표를 가리지 않게
 *   persist: 시간으로 사라지지 않고 follow 가 찾는 동안 계속 (표를 고치는 동안). 글을 쳐서 노드가 바뀌어도 follow 가 같은 표를 찾으면 그대로
 */
export function showDeleteButton(view, { pos, node, target, label = '이 내용 지우기', copyLabel = null, deco, markTarget = false, remove, showMs = DELETE_SHOW_MS, open = null, placement = 'corner', persist = false, follow = null }) {
  hideDeleteButton(true);
  if (isShareMenuOpen()) return; // 공유 방법을 고르는 동안은 메뉴만 (단추가 메뉴 위에 다시 뜨지 않게)
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mk-delete-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = CLOSE_ICON;
  // 복사 단추 (× 왼쪽) · 저장 단추 (그 왼쪽)
  const actionBtn = (cls, verb, icon) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    const text = label.replace(/지우기$/, verb); // "이 표 지우기" → "이 표 복사" · "이 표 저장"
    b.title = text;
    b.setAttribute('aria-label', text);
    b.innerHTML = icon;
    return b;
  };
  const copyBtn = actionBtn('mk-copy-btn', '복사', COPY_ICON);
  if (copyLabel) { // 링크 카드: 카드 모양이 아니라 주소를 — "링크 주소 복사"
    copyBtn.title = copyLabel;
    copyBtn.setAttribute('aria-label', copyLabel);
  }
  const saveBtn = actionBtn('mk-save-btn', '저장', SAVE_ICON);
  const shareBtn = canShare() ? actionBtn('mk-share-btn', '공유', SHARE_ICON) : null;
  let openBtn = null;
  if (open) {
    openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'mk-open-btn';
    openBtn.title = open.label;
    openBtn.setAttribute('aria-label', open.label);
    openBtn.innerHTML = OPEN_ICON;
  }
  const extras = [copyBtn, saveBtn, shareBtn, openBtn].filter(Boolean); // × 에서 왼쪽으로 차례로 (열기는 ×에서 가장 먼 맨 왼쪽)
  document.body.append(...extras, btn);
  // 단추는 화면에 고정(position: fixed)이라, 큰 그림을 스크롤하면 위 막대에 올라탈 수 있다 →
  //   편집기에서 보이는 칸 안으로만: 대상의 위가 가려지면 보이는 부분의 위에 붙고, 대상이 다 가려지면 숨는다
  let scroller = scrollParent(target);
  const place = () => {
    const r = del.target.getBoundingClientRect();
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    let top;
    let visible;
    let left;
    if (placement === 'above') {
      // 표 위 오른쪽 밖: 단추 아래 끝이 표 위 끝에서 4px 위 (표를 가리지 않는다). 위가 모자라면 보이는 칸의 맨 위에 붙는다
      top = Math.max(r.top - 30, box.top + 2);
      visible = r.bottom - 12 > box.top + 4 && r.top < box.bottom - 12;
      left = Math.round(Math.max(4 + 36 * extras.length, Math.min(window.innerWidth - 32, r.right - 4 - 24)));
    } else {
      top = Math.max(r.top - 9, box.top + 4);
      visible = r.bottom - 12 > box.top + 4 && r.top < box.bottom - 12 && top + 24 <= Math.min(r.bottom + 9, box.bottom);
      // 왼쪽 끝에 붙은 작은 대상(짧은 파일 칩 등)이면 단추들이 겹치지 않게 그만큼 오른쪽으로
      left = Math.round(Math.max(4 + 36 * extras.length, Math.min(window.innerWidth - 32, r.right - 22)));
    }
    btn.style.visibility = visible ? '' : 'hidden';
    btn.style.left = `${left}px`;
    btn.style.top = `${Math.round(top)}px`;
    // × 와 손가락 닿는 범위가 겹치지 않게 36px 씩 (화면 왼쪽 밖으로 나가지 않게)
    extras.forEach((b, i) => {
      b.style.visibility = visible ? '' : 'hidden';
      b.style.left = `${Math.max(4, left - 36 * (i + 1))}px`;
      b.style.top = `${Math.round(top)}px`;
    });
  };
  const setMark = (on) => {
    if (markTarget) del.target.classList.toggle('mk-delete-target', on);
    else if (on) deco({ cls: 'mk-delete-target' });
    // 편집기 갱신 중일 수 있어 한 박자 뒤에 — 그 사이 같은 편집기에 새 단추 줄이 표시를 달았으면 지우지 않는다
    else setTimeout(() => !view.isDestroyed && !(current && current !== del && current.view === view && !current.markTarget) && deco(null), 0);
  };
  // 표(persist)는 고치는 동안 계속 떠 있으므로 표 전체를 붉게 칠해 두지 않는다 (붉은 표시는 지우기를 누를 때만)
  const del = { view, btn, extras, pos, node, target, markTarget, state: view.state, place, setMark: persist ? (on) => !on && setMark(false) : setMark, persist, follow, rescroll: () => { scroller = scrollParent(del.target); } };
  place();
  if (!persist) setMark(true);
  // 누르면 그 일을 하고 ✓ (실패하면 !, 저장을 그만두면 그대로) — 다시 누르면 다시 (실패한 뒤 다시 해 보기 등)
  const action = (b, icon, run, doneText) => {
    let busy = false;
    const go = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'click' && e.detail > 0) return; // 마우스는 mousedown 으로 이미 — click 은 키보드(Enter · Space)만
      if (busy) return; // mousedown 뒤 따라오는 click 은 한 번으로
      if (view.state.doc.nodeAt(del.pos) !== del.node) return hideDeleteButton();
      busy = true;
      b.classList.remove('done', 'failed');
      b.innerHTML = icon;
      haptic(8);
      clearTimeout(del.timer); // 누른 뒤에는 ✓ 를 볼 만큼 더 둔다 (저장은 고르는 창이 닫힐 때까지)
      run().then((what) => {
        if (what === 'cancelled') return;
        if (del.markTarget || persist) document.dispatchEvent(new CustomEvent('mk:content-tools')); // 튜토리얼: 넣은 내용(그림 · 파일 등)을 복사 · 저장 · 공유해 봤다
        b.classList.add('done');
        b.innerHTML = DONE_ICON;
        b.title = doneText(what);
        announce(b.title);
        notice(b.title);
      }, (err) => {
        b.classList.add('failed');
        b.innerHTML = FAIL_ICON;
        console.warn(b.className, err);
        b.title = failText(b.classList.contains('mk-save-btn') ? '저장' : b.classList.contains('mk-share-btn') ? '공유' : null, err);
        announce(b.title);
        notice(b.title, true);
      }).finally(() => {
        setTimeout(() => (busy = false), 0); // 바로 뒤따르는 click 까지는 막고
        if (!persist && current === del) del.timer = setTimeout(() => hideDeleteButton(), 1600);
      });
    };
    b.addEventListener('mousedown', go);
    b.addEventListener('touchstart', go, { passive: false });
    b.addEventListener('click', go); // 키보드(Enter · Space)
  };
  action(copyBtn, COPY_ICON, () => copyBlock(view, del.pos, del.node, del.target), COPY_DONE);
  action(saveBtn, SAVE_ICON, () => saveBlock(view, del.pos, del.node, del.target), SAVE_DONE);
  if (shareBtn) action(shareBtn, SHARE_ICON, () => shareBlock(view, del.pos, del.node, del.target), SHARE_DONE_TEXT);
  if (openBtn) {
    let opened = false;
    const go = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (opened) return; // touchstart 뒤 따라오는 mousedown · click 은 한 번으로
      opened = true;
      if (view.state.doc.nodeAt(del.pos) !== del.node) return hideDeleteButton();
      haptic(8);
      hideDeleteButton(true);
      open.run();
    };
    openBtn.addEventListener('mousedown', go);
    openBtn.addEventListener('touchstart', go, { passive: false });
    openBtn.addEventListener('click', go);
  }
  current = del;
  const press = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (view.state.doc.nodeAt(del.pos) !== del.node) return hideDeleteButton();
    haptic(15);
    // 단추는 눌린 듯 작아지며 사라지고
    clearTimeout(del.timer);
    window.removeEventListener('scroll', place, true);
    current = null;
    btn.classList.add('pressed');
    for (const b of del.extras) b.remove();
    setTimeout(() => btn.remove(), 180);
    deleteContent(view, { pos: del.pos, node: del.node, target: del.target, markTarget, deco, label, remove });
  };
  btn.addEventListener('mousedown', press);
  // 키보드(Enter · Space)로 누른 것만 — 마우스 · 손가락은 위에서 이미 처리 (detail 0 = 키보드)
  btn.addEventListener('click', (e) => { if (e.detail === 0 && current === del) press(e); });
  btn.addEventListener('touchstart', press, { passive: false });
  window.addEventListener('scroll', place, true);
  if (!persist) del.timer = setTimeout(() => hideDeleteButton(), showMs);
}

/** 표를 고치는 동안 계속 떠 있는 단추(persist)가 있는가 */
export const persistentShown = () => Boolean(current?.persist);

/** 지금 이 상자에 지우기 단추가 떠 있는가 */
export const deleteShownFor = (target) => Boolean(current && current.target === target);

export function hideDeleteButton(now = false) {
  const del = current;
  if (!del) return;
  current = null;
  clearTimeout(del.timer);
  window.removeEventListener('scroll', del.place, true);
  if (!del.view.isDestroyed) del.setMark(false);
  del.target.classList?.remove('mk-ink-armed'); // 손 메모: 단추가 거둬지면 다시 처음 누르기부터
  if (now) {
    for (const b of del.extras) b.remove();
    return del.btn.remove();
  }
  for (const b of [del.btn, ...del.extras]) b.classList.add('fading');
  setTimeout(() => {
    for (const b of [del.btn, ...del.extras]) b.remove();
  }, 260);
}

/** 그 편집기의 글이나 커서가 바뀌었으면 단추를 거둔다 (플러그인 view.update 에서) — 표를 고치는 동안(persist)은 같은 표를 따라간다 */
export function hideDeleteIfChanged(view) {
  const del = current;
  if (!del || del.view !== view) return;
  if (del.persist) {
    const found = del.follow?.(view);
    if (!found) return hideDeleteButton();
    Object.assign(del, found, { state: view.state });
    del.rescroll();
    del.place();
    return;
  }
  if (view.state.doc !== del.state.doc || !view.state.selection.eq(del.state.selection)) hideDeleteButton();
}
