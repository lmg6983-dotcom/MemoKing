import { reduceMotion } from './dom.js';
// 바탕화면 위젯의 셀로판 테이프 창 — 메인 프로세스가 위젯 위 가장자리에 반쯤 걸쳐 띄운다 (window-manager.js openWidgetTape)
//   테이프를 끌면 위젯이 따라 옮겨지고, 움직이지 않고 누르면(클릭) 떼어져 바탕화면에서 사라진다 (메모는 그대로).
//   테이프 모양 위에서만 마우스를 받고, 나머지 투명한 곳은 아래로 통과.
const api = window.memoking;
const tape = document.getElementById('tape');
const DRAG_PX = 4; // 이만큼 움직이면 클릭이 아니라 끌기
let over = false;
let peeled = false;
let press = null; // { id, x, y, dragging }

api.on('tape:show', ({ animate } = {}) => {
  peeled = false;
  tape.classList.remove('peeling', 'sticking');
  if (animate && !reduceMotion()) {
    void tape.getBoundingClientRect();
    tape.classList.add('sticking');
  }
});

function setOver(next) {
  if (next === over) return;
  over = next;
  tape.classList.toggle('hover', over);
  api.sticker.hover(over); // 테이프 위에서만 마우스를 받는다 (왕관 스티커와 같은 방법)
}

// 투명한 곳의 움직임도 전달받으므로(forward), 테이프 모양 위인지 보고 마우스를 받을지 정한다
document.addEventListener('mousemove', (e) => {
  if (!peeled && !press) setOver(Boolean(e.target.closest?.('.hit')));
});
document.addEventListener('mouseleave', () => !press && setOver(false));

tape.addEventListener('pointerdown', (e) => {
  if (peeled || e.button !== 0 || !e.target.closest?.('.hit')) return;
  e.preventDefault();
  press = { id: e.pointerId, x: e.screenX, y: e.screenY, dragging: false };
  try {
    tape.setPointerCapture(e.pointerId); // 테이프 창이 위젯을 따라 움직여도 손을 놓을 때까지 받는다
  } catch {
    // 흉내 낸 이벤트
  }
});
tape.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const dx = e.screenX - press.x;
  const dy = e.screenY - press.y;
  if (!press.dragging && Math.hypot(dx, dy) < DRAG_PX) return;
  if (!press.dragging) {
    press.dragging = true;
    tape.classList.add('dragging');
    api.tape.dragStart();
  }
  api.tape.drag(dx, dy);
});
function release(e, cancelled = false) {
  if (!press || e.pointerId !== press.id) return;
  const { dragging } = press;
  press = null;
  tape.classList.remove('dragging');
  if (dragging) return void api.tape.dragEnd();
  if (cancelled) return;
  // 누르기만 했으면 떼기: 테이프가 들려 떨어지고 위젯도 사라진다
  peeled = true;
  setOver(false);
  if (!reduceMotion()) tape.classList.add('peeling');
  api.tape.peel();
}
tape.addEventListener('pointerup', (e) => release(e));
tape.addEventListener('pointercancel', (e) => release(e, true));

document.documentElement.dataset.ready = 'true';
