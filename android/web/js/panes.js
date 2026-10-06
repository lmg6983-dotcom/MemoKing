// 태블릿(넓은 화면) — 메모를 열면 목록은 숨고 메모가 화면을 가득,
//   메모 위 막대의 목록 단추로 목록을 옆에 꺼내기·넣기 (v0.15: 메모 둘 나란히 보기는 뺐다)
import { isTwoPane } from './ui.js';

const $ = (id) => document.getElementById(id);
let deps = null; // { note }
let listShown = false;

/** @param {{ note }} d */
export function setupPanes(d) {
  deps = d;
  // 목록에서 지금 열린 메모 카드를 표시 — 목록이 다시 그려져도
  new MutationObserver(markCards).observe($('cards'), { childList: true, subtree: true });
  window.addEventListener('memoking:pane', sync);
  sync();
}

/** 화면 상태 → body 표시 (CSS 가 칸 자리를 정한다) */
export function sync() {
  const two = isTwoPane();
  const open = deps?.note.isOpen() ?? false;
  const b = document.body.classList;
  b.toggle('note-open', two && open);
  b.toggle('pane-list', two && open && listShown);
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
  const id = isTwoPane() && deps?.note.isOpen() ? deps.note.currentId() : null;
  for (const c of document.querySelectorAll('#cards .card')) {
    const on = c.dataset.id === id;
    if (c.classList.contains('current') !== on) c.classList.toggle('current', on);
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

/** 뒤로 가기 (태블릿): 옆에 꺼낸 목록부터 넣는다 */
export function back() {
  if (!isTwoPane() || !deps.note.isOpen() || !listShown) return false;
  toggleList(false);
  return true;
}
