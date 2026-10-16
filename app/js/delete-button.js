import { haptic } from './dom.js';
import { copyBlock, saveBlock, shareBlock, canShare } from './copy-content.js';
import { SHARE_DONE } from './share-menu.js';
// 지우기 단추 (×) — 꾹 눌렀다 그 자리에 놓은 것의 오른쪽 위에 잠깐 (block-move.js 내용 줄·목록 전체 · list-drag.js 목록 항목 함께)
//   흰 동그라미에 빨간 ×. 한 번에 하나만, DELETE_SHOW_MS 뒤에(또는 글을 고치거나 커서를 옮기면) 흐려지며 사라진다.
//   PC(마우스): 그림·손 메모·소리·파일·링크 카드에 마우스를 올려도 뜬다 (hover — 시간으로 사라지지 않고, 마우스가 떠나면 거둔다.
//   빨갛게 비치는 표시는 × 위에 올렸을 때만)
//   누르면: 대상이 붉게 비쳤다가 작아지며 흐려지고, 그 자리가 접히며 아래 줄들이 부드럽게 올라온 뒤 지운다.
//   × 왼쪽에는 복사 단추 (그림은 그림으로, 그 밖의 내용은 서식 + 글로 — copy-content.js), 그 왼쪽에 저장 단추
//   (그림 · 파일은 파일 그대로, 표는 CSV, 그 밖은 글 파일 — 어디에 저장할지 고르는 창),
//   휴대폰은 맨 왼쪽에 공유 단추 (카톡 · 메일 등으로 보내기 — 글은 글로, 그 밖은 파일로). 누르면 잠깐 ✓
export const DELETE_SHOW_MS = 2500;
const FADE_MS = 200; // 작아지며 흐려지기
const COLLAPSE_MS = 200; // 그 자리 접기

let current = null;
const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.5v-.4A1.6 1.6 0 0 0 8.9 1.5H4.1A1.6 1.6 0 0 0 2.5 3.1v4.8a1.6 1.6 0 0 0 1.6 1.6h.4"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const FAIL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v5.5M8 12.2v.3"/></svg>';
const SHARE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="11.5" cy="3.8" r="1.8"/><circle cx="4.5" cy="8" r="1.8"/><circle cx="11.5" cy="12.2" r="1.8"/><path d="M6.1 7.1l3.8-2.3M6.1 8.9l3.8 2.3"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';
const SAVE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 12.8h10"/></svg>';
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

// 지운 자리에 "표를 지웠어요 · Ctrl+Z 로 되돌리기" 를 2.5초 (하나만)
function undoHint(what, rect) {
  document.getElementById('mk-undo-hint')?.remove();
  const tip = document.createElement('div');
  tip.id = 'mk-undo-hint';
  tip.className = 'mk-undo-hint';
  tip.setAttribute('role', 'status');
  tip.innerHTML = '<span></span> · <kbd>Ctrl+Z</kbd> 로 되돌리기';
  tip.firstChild.textContent = `${what}${/[가-힣]$/.test(what) && (what.charCodeAt(what.length - 1) - 0xac00) % 28 ? '을' : '를'} 지웠어요`;
  document.body.append(tip);
  const top = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, rect.top));
  const left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, rect.left + rect.width / 2 - tip.offsetWidth / 2));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  const gone = () => tip.remove();
  setTimeout(() => {
    tip.classList.add('fading');
    setTimeout(gone, 260);
  }, 2500);
  document.addEventListener('keydown', gone, { once: true });
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
 *           remove?: (view, pos: number, node) => void, hover?: { enter: () => void, leave: () => void }, showMs?: number }} opts
 *   pos·node: 지울 노드 · target: 단추를 붙일 상자 (사진·소리면 그 상자, 아니면 그 줄)
 *   deco: 지울 노드에 표시(데코레이션)를 달고 떼기 — 편집기가 그리는 줄은 class 를 직접 바꾸면 되돌려지므로
 *   markTarget: 대상 표시를 target 의 class 로 (사진·소리처럼 편집기가 다시 그리지 않는 상자)
 *   remove: 지우기 (기본은 그 노드를 지움)
 *   open: { label, run } — 누르면 바로 열리던 것(파일·링크 카드·수식)은 누르면 단추만, 여는 것은 이 "열기" 단추로
 */
export function showDeleteButton(view, { pos, node, target, label = '이 내용 지우기', copyLabel = null, deco, markTarget = false, remove, hover = null, showMs = DELETE_SHOW_MS, open = null }) {
  hideDeleteButton(true);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `mk-delete-btn${hover ? ' hover' : ''}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6"/></svg>';
  // 복사 단추 (× 왼쪽) · 저장 단추 (그 왼쪽)
  const actionBtn = (cls, verb, icon) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${cls}${hover ? ' hover' : ''}`;
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
    openBtn.className = `mk-open-btn${hover ? ' hover' : ''}`;
    openBtn.title = open.label;
    openBtn.setAttribute('aria-label', open.label);
    openBtn.innerHTML = OPEN_ICON;
  }
  const extras = [copyBtn, saveBtn, shareBtn, openBtn].filter(Boolean); // × 에서 왼쪽으로 차례로 (열기는 ×에서 가장 먼 맨 왼쪽)
  document.body.append(...extras, btn);
  // 단추는 화면에 고정(position: fixed)이라, 큰 그림을 스크롤하면 위 막대에 올라탈 수 있다 →
  //   편집기에서 보이는 칸 안으로만: 대상의 위가 가려지면 보이는 부분의 위에 붙고, 대상이 다 가려지면 숨는다
  const scroller = scrollParent(target);
  const place = () => {
    const r = target.getBoundingClientRect();
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const top = Math.max(r.top - 9, box.top + 4);
    const visible = r.bottom - 12 > box.top + 4 && r.top < box.bottom - 12 && top + 24 <= Math.min(r.bottom + 9, box.bottom);
    // 왼쪽 끝에 붙은 작은 대상(짧은 파일 칩 등)이면 단추들이 겹치지 않게 그만큼 오른쪽으로
    const left = Math.round(Math.max(4 + 36 * extras.length, Math.min(window.innerWidth - 32, r.right - 22)));
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
  place();
  const setMark = (on) => {
    if (markTarget) target.classList.toggle('mk-delete-target', on);
    else if (on) deco({ cls: 'mk-delete-target' });
    // 편집기 갱신 중일 수 있어 한 박자 뒤에 — 그 사이 같은 편집기에 새 단추 줄이 표시를 달았으면 지우지 않는다
    else setTimeout(() => !view.isDestroyed && !(current && current !== del && current.view === view && !current.markTarget) && deco(null), 0);
  };
  if (!hover) setMark(true);
  const del = { view, btn, extras, pos, node, target, markTarget, state: view.state, place, setMark: hover ? (on) => !on && setMark(false) : setMark };
  if (hover) {
    btn.addEventListener('mouseenter', () => {
      hover.enter();
      setMark(true);
    });
    btn.addEventListener('mouseleave', () => {
      setMark(false);
      hover.leave();
    });
    // 복사 · 저장 단추 위에 있어도 단추들은 그대로 (붉은 표시는 × 위에서만)
    for (const b of extras) {
      b.addEventListener('mouseenter', () => hover.enter());
      b.addEventListener('mouseleave', () => hover.leave());
    }
  }
  // 누르면 그 일을 하고 ✓ (실패하면 !, 저장을 그만두면 그대로) — 다시 누르면 다시 (실패한 뒤 다시 해 보기 등)
  const action = (b, icon, run, doneText) => {
    let busy = false;
    const go = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'click' && e.detail > 0) return; // 마우스는 mousedown 으로 이미 — click 은 키보드(Enter · Space)만
      if (busy) return; // mousedown 뒤 따라오는 click 은 한 번으로
      if (view.state.doc.nodeAt(pos) !== node) return hideDeleteButton();
      busy = true;
      b.classList.remove('done', 'failed');
      b.innerHTML = icon;
      haptic(8);
      clearTimeout(del.timer); // 누른 뒤에는 ✓ 를 볼 만큼 더 둔다 (저장은 고르는 창이 닫힐 때까지)
      run().then((what) => {
        if (what === 'cancelled') return;
        if (markTarget) document.dispatchEvent(new CustomEvent('mk:content-tools')); // 튜토리얼: 넣은 내용(그림 · 파일 등)을 복사 · 저장 · 공유해 봤다
        b.classList.add('done');
        b.innerHTML = DONE_ICON;
        b.title = doneText(what);
        announce(b.title);
        notice(b.title);
      }, (err) => {
        b.classList.add('failed');
        b.innerHTML = FAIL_ICON;
        console.warn(b.className, err);
        const fileAct = b.classList.contains('mk-save-btn') ? '저장' : b.classList.contains('mk-share-btn') ? '공유' : null;
        // 저장 · 공유는 앱이 알려 준 이유(파일을 찾지 못했어요 등)를 그대로
        b.title = fileAct && err?.message && !/^Error invoking/.test(err.message) ? err.message : `${fileAct ?? '복사'}하지 못했어요. 다시 눌러 주세요`;
        announce(b.title);
        notice(b.title, true);
      }).finally(() => {
        setTimeout(() => (busy = false), 0); // 바로 뒤따르는 click 까지는 막고
        if (!hover && current === del) del.timer = setTimeout(() => hideDeleteButton(), 1600);
      });
    };
    b.addEventListener('mousedown', go);
    b.addEventListener('touchstart', go, { passive: false });
    b.addEventListener('click', go); // 키보드(Enter · Space)
  };
  action(copyBtn, COPY_ICON, () => copyBlock(view, pos, node, target), (what) => (what === '그림' ? '그림을 복사했어요' : what === '주소' ? '그림 주소를 복사했어요'
    : what === '파일' ? '파일을 복사했어요. 탐색기 · 메신저에 붙여 넣으세요' : what === '링크' ? '링크 주소를 복사했어요' : '내용을 복사했어요'));
  action(saveBtn, SAVE_ICON, () => saveBlock(view, pos, node, target), (name) => `저장했어요: ${name}`);
  if (shareBtn) action(shareBtn, SHARE_ICON, () => shareBlock(view, pos, node, target), (what) => SHARE_DONE[what] ?? '공유했어요');
  if (openBtn) {
    let opened = false;
    const go = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (opened) return; // touchstart 뒤 따라오는 mousedown · click 은 한 번으로
      opened = true;
      if (view.state.doc.nodeAt(pos) !== node) return hideDeleteButton();
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
    if (view.state.doc.nodeAt(pos) !== node) return hideDeleteButton();
    haptic(15);
    // 단추는 눌린 듯 작아지며 사라지고
    clearTimeout(del.timer);
    window.removeEventListener('scroll', place, true);
    current = null;
    btn.classList.add('pressed');
    for (const b of del.extras) b.remove();
    setTimeout(() => btn.remove(), 180);
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
      // PC: 표 · 수식처럼 공들인 것도 한 번에 지워지므로, 그 자리에 되돌리는 법을 잠깐 (휴대폰은 목록의 되돌리기 띠)
      if (hover) undoHint(label.replace(/ 지우기$/, '').replace(/^이 /, ''), where);
    }, FADE_MS + COLLAPSE_MS);
  };
  btn.addEventListener('mousedown', press);
  btn.addEventListener('touchstart', press, { passive: false });
  // 키보드(Enter · Space)로 누른 것만 — 마우스 · 손가락은 위에서 이미 처리 (detail 0 = 키보드)
  btn.addEventListener('click', (e) => { if (e.detail === 0 && current === del) press(e); });
  window.addEventListener('scroll', place, true);
  if (!hover) del.timer = setTimeout(() => hideDeleteButton(), showMs);
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

/** 그 편집기의 글이나 커서가 바뀌었으면 단추를 거둔다 (플러그인 view.update 에서) */
export function hideDeleteIfChanged(view) {
  const del = current;
  if (del && del.view === view && (view.state.doc !== del.state.doc || !view.state.selection.eq(del.state.selection))) hideDeleteButton();
}
