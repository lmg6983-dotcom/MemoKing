// 태블릿(넓은 화면) 칸 나누기 — 목록 · 고치는 메모 · 옆 메모(보기만)
//   - 메모를 열면 목록은 숨고 메모가 화면을 가득 (메모 위 막대의 목록 단추로 옆에 꺼내기·넣기)
//   - 메모는 한 번에 둘까지 나란히: 목록 카드를 오른쪽으로 밀면 "옆에 열기". 고치기·녹음은 한쪽(고치는 칸)만,
//     옆 메모를 누르면 그쪽이 고치는 칸이 된다 (자리는 그대로)
//   - 둘일 때 각 메모 맨 위 막대를 꾹 눌러 끌면: 다른 메모 위에 놓아 자리 바꾸기 · 왼쪽 끝으로 던져 목록으로 · 오른쪽 끝으로 던져 지우기
import { isTwoPane } from './ui.js';
import { showPeek, hidePeek, peekId, peekChanged } from './peek-view.js';
import { haptic, reduceMotion } from '../../app/js/dom.js';

const $ = (id) => document.getElementById(id);
let deps = null; // { note, openMemo, deleteMemo, showList, refreshList }
let listShown = false;
let activeRight = false;

export { peekId, peekChanged };
export const splitOpen = () => Boolean(peekId());
export const listBeside = () => listShown;

/** @param {{ note, openMemo: (id) => Promise<void>, deleteMemo: (id) => Promise<void>, showList: () => void }} d */
export function setupPanes(d) {
  deps = d;
  $('peek-screen').addEventListener('click', (e) => {
    if (drag || e.target.closest('a, button, input, audio, video')) return;
    activatePeek();
  });
  for (const bar of [document.querySelector('#note-screen .bar'), document.querySelector('#peek-screen .bar')]) {
    bar.addEventListener('pointerdown', startPress);
  }
  // 목록에서 지금 열린 메모(고치는 칸 · 옆 메모) 카드를 표시 — 목록이 다시 그려져도
  new MutationObserver(markCards).observe($('cards'), { childList: true, subtree: true });
  window.addEventListener('memoking:pane', () => {
    if (!isTwoPane() && peekId()) hidePeek();
    sync();
  });
  sync();
}

/** 화면 상태 → body 표시 (CSS 가 칸 자리를 정한다) */
export function sync() {
  const two = isTwoPane();
  const open = deps?.note.isOpen() ?? false;
  if (!open && peekId()) hidePeek();
  const b = document.body.classList;
  b.toggle('note-open', two && open);
  b.toggle('pane-list', two && open && listShown);
  b.toggle('pane-split', two && open && Boolean(peekId()));
  b.toggle('active-right', two && open && Boolean(peekId()) && activeRight);
  markCards();
  const back = $('back-btn');
  if (back) {
    back.setAttribute('aria-label', two ? (listShown ? '목록 숨기기' : '목록 옆에 보기') : '목록으로');
    back.setAttribute('aria-pressed', String(two && listShown));
    back.querySelector('use')?.setAttribute('href', two ? '#i-list' : '#i-back');
  }
}

let marking = false;
function markCards() {
  if (marking) return;
  marking = true;
  const open = isTwoPane() && deps?.note.isOpen() ? [deps.note.currentId(), peekId()] : [];
  for (const c of document.querySelectorAll('#cards .card')) {
    const on = open.includes(c.dataset.id);
    if (c.classList.contains('current') !== on) c.classList.toggle('current', on);
    const peek = on && c.dataset.id === peekId();
    if (c.classList.contains('current-peek') !== peek) c.classList.toggle('current-peek', peek);
  }
  marking = false;
}

/** 메모 위 막대의 목록 단추 (태블릿): 목록을 옆에 꺼내거나 넣는다 */
export function toggleList(force) {
  listShown = force ?? !listShown;
  sync();
}
/** 메모를 새로 열 때: 목록은 숨기고 메모를 가득 */
export function hideListForMemo() {
  listShown = false;
}

/** 목록 카드를 오른쪽으로 밀었을 때: 지금 메모 옆에 열기 (없으면 그냥 열기) */
export async function openBeside(id) {
  const { note } = deps;
  if (!isTwoPane() || !note.isOpen()) return deps.openMemo(id);
  if (id === note.currentId()) return;
  if (id === peekId()) return activatePeek();
  const prev = note.currentId();
  listShown = false;
  // 지금 메모는 그 자리에서 보기로, 새 메모는 다른 쪽(고치기)에 — 옆 메모가 있었으면 그 자리를 새 메모가 차지
  activeRight = peekId() ? !activeRight : true;
  await deps.openMemo(id, { beside: true });
  await showPeek(prev);
  sync();
}

/** 옆 메모를 고치는 칸으로 (지금 메모는 보기로 — 자리는 그대로) */
export async function activatePeek() {
  const pid = peekId();
  if (!pid) return;
  const prev = deps.note.currentId();
  activeRight = !activeRight;
  await deps.openMemo(pid, { beside: true });
  await showPeek(prev);
  sync();
}

/** 칸 닫기: 'active' 고치는 칸 · 'peek' 옆 메모 — 남은 메모가 화면을 가득 */
export async function closePane(which) {
  const pid = peekId();
  hidePeek();
  activeRight = false;
  if (which === 'active' && pid) await deps.openMemo(pid, { beside: true });
  sync();
}

/** 칸의 메모 지우기 (휴지통 · 되돌리기 가능) */
export async function deletePane(which) {
  const pid = peekId();
  const aid = deps.note.currentId();
  if (which === 'peek') {
    hidePeek();
    activeRight = false;
    sync();
    await deps.deleteMemo(pid);
    return;
  }
  hidePeek();
  activeRight = false;
  await deps.deleteMemo(aid);
  if (pid) await deps.openMemo(pid, { beside: true });
  sync();
}

export function swapPanes() {
  activeRight = !activeRight;
  sync();
}

/** 뒤로 가기 (태블릿): 옆 메모 → 목록 → 메모 닫기 순으로 */
export function back() {
  if (!isTwoPane() || !deps.note.isOpen()) return false;
  if (listShown) {
    toggleList(false);
    return true;
  }
  if (peekId()) {
    closePane('peek');
    return true;
  }
  return false;
}

// ---------- 맨 위 막대를 꾹 눌러 끌기 (둘일 때) ----------

const HOLD_MS = 320;
const EDGE = 64;
let press = null;
let drag = null;

function screenOf(bar) {
  return bar.closest('#note-screen') ? 'active' : 'peek';
}
function paneEl(which) {
  return which === 'active' ? $('note-screen') : $('peek-screen');
}

function startPress(e) {
  if (!splitOpen() || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (e.target.closest('button, a, input')) return;
  const which = screenOf(e.currentTarget);
  press = { which, id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(() => lift(e), HOLD_MS) };
  e.currentTarget.setPointerCapture?.(e.pointerId);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function lift(e) {
  if (!press) return;
  const pane = paneEl(press.which);
  const r = pane.getBoundingClientRect();
  drag = { ...press, pane, ox: press.x, oy: press.y, rect: r, zone: null, hist: [{ x: press.x, t: performance.now() }] };
  press = null;
  pane.classList.add('pane-lifted');
  // 비워진 자리: 점선 칸 (놓으면 돌아올 곳)
  Object.assign($('pane-slot').style, { left: `${r.left + 10}px`, top: `${r.top + 10}px`, width: `${r.width - 20}px`, height: `${r.height - 20}px` });
  $('pane-slot').hidden = false;
  document.body.classList.add('pane-dragging');
  edges(true);
  haptic(12);
  badge(null);
  void e;
}

function onMove(e) {
  if (press && e.pointerId === press.id) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
    return;
  }
  if (!drag || e.pointerId !== drag.id) return;
  e.preventDefault();
  const dx = e.clientX - drag.ox;
  const dy = e.clientY - drag.oy;
  drag.pane.style.transform = `translate(${dx}px, ${dy * 0.35}px) scale(0.94) rotate(${dx / 90}deg)`;
  drag.hist.push({ x: e.clientX, t: performance.now() });
  if (drag.hist.length > 6) drag.hist.shift();
  const zone = zoneAt(e.clientX, e.clientY);
  if (zone !== drag.zone) {
    drag.zone = zone;
    haptic(6);
    for (const p of [$('note-screen'), $('peek-screen')]) p.classList.toggle('pane-swap-target', zone === 'swap' && p !== drag.pane);
    document.body.dataset.paneZone = zone ?? '';
  }
  badge(zone, e.clientX, e.clientY);
}

function zoneAt(x, y) {
  const list = document.body.classList.contains('pane-list') ? $('list-screen').getBoundingClientRect().right : 0;
  if (x < list + EDGE) return 'close';
  if (x > window.innerWidth - EDGE) return 'delete';
  const other = paneEl(drag.which === 'active' ? 'peek' : 'active').getBoundingClientRect();
  if (x >= other.left && x <= other.right && y >= other.top && y <= other.bottom) return 'swap';
  return null;
}

const BADGES = { swap: '⇅ 자리 바꾸기', close: '↩ 목록으로', delete: '🗑 지우기' };
function badge(zone, x = 0, y = 0) {
  const b = $('pane-badge');
  if (!zone) {
    b.hidden = true;
    return;
  }
  b.textContent = BADGES[zone];
  b.dataset.kind = zone;
  b.hidden = false;
  const w = b.offsetWidth;
  b.style.left = `${Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8)}px`;
  b.style.top = `${Math.max(8, y - 70)}px`;
}

function edges(on) {
  $('pane-edge-left').hidden = !on;
  $('pane-edge-right').hidden = !on;
  if (on) {
    const list = document.body.classList.contains('pane-list') ? $('list-screen').getBoundingClientRect().right : 0;
    $('pane-edge-left').style.left = `${list}px`;
  }
}

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
  unlisten();
}
function unlisten() {
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onUp);
}

async function onUp(e) {
  if (press && e.pointerId === press.id) return cancelPress();
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  unlisten();
  // 던지기: 마지막 순간의 빠르기
  const h = d.hist;
  const v = h.length > 1 ? (h.at(-1).x - h[0].x) / Math.max(1, h.at(-1).t - h[0].t) : 0;
  let action = e.type === 'pointercancel' ? null : d.zone;
  if (action !== 'swap' && v < -0.9) action = 'close';
  if (action !== 'swap' && v > 0.9) action = 'delete';
  badge(null);
  edges(false);
  $('pane-slot').hidden = true;
  delete document.body.dataset.paneZone;
  for (const p of [$('note-screen'), $('peek-screen')]) p.classList.remove('pane-swap-target');
  document.body.classList.remove('pane-dragging');
  const pane = d.pane;
  const fly = (to) => new Promise((resolve) => {
    if (reduceMotion()) return resolve();
    pane.style.transition = 'transform 0.2s ease-in, opacity 0.2s ease-in';
    pane.style.transform = to;
    pane.style.opacity = '0';
    setTimeout(resolve, 200);
  });
  const reset = () => {
    pane.classList.remove('pane-lifted');
    pane.style.transition = '';
    pane.style.transform = '';
    pane.style.opacity = '';
  };
  if (action === 'close') {
    await fly(`translateX(-${window.innerWidth * 0.6}px) scale(0.8)`);
    reset();
    await closePane(d.which);
    toggleList(true); // 목록으로 돌아갔음을 보이게 목록을 옆에 꺼내 둔다
  } else if (action === 'delete') {
    await fly(`translateX(${window.innerWidth * 0.6}px) scale(0.8) rotate(8deg)`);
    reset();
    await deletePane(d.which);
  } else if (action === 'swap') {
    reset();
    swapPanes();
    haptic(10);
  } else {
    pane.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)';
    pane.style.transform = '';
    setTimeout(reset, 230);
  }
}
