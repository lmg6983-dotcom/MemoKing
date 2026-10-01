// 영역 캡처 오버레이 — 메인 프로세스가 찍어 준 화면 위에서 끌어 사각형을 고른다.
// 좌표는 이 모니터 기준 화면 좌표(창 = 모니터 전체). 자르기는 메인이 원래 해상도로 한다.
const api = window.memoking;
const $ = (id) => document.getElementById(id);
const sel = $('sel');
const size = $('size');
let start = null;
let done = false;

api.on('capture:image', ({ src }) => {
  $('shot').onload = () => {
    document.documentElement.dataset.ready = 'true';
  };
  $('shot').src = src;
});

function rectOf(e) {
  const x = Math.min(start.x, e.clientX);
  const y = Math.min(start.y, e.clientY);
  return { x, y, width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) };
}

function draw(r) {
  sel.hidden = false;
  Object.assign(sel.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  size.textContent = `${Math.round(r.width * devicePixelRatio)} × ${Math.round(r.height * devicePixelRatio)}`;
  sel.classList.toggle('near-top', r.y < 32);
}

function cancel() {
  if (done) return;
  done = true;
  api.capture.cancel();
}

window.addEventListener('mousedown', (e) => {
  if (done) return;
  if (e.button !== 0) return cancel(); // 오른쪽 클릭 = 취소
  start = { x: e.clientX, y: e.clientY };
  document.body.classList.add('selecting');
  draw({ x: start.x, y: start.y, width: 0, height: 0 });
});
window.addEventListener('mousemove', (e) => {
  if (start && !done) draw(rectOf(e));
});
window.addEventListener('mouseup', (e) => {
  if (!start || done) return;
  const r = rectOf(e);
  start = null;
  // 너무 작으면(그냥 누름) 다시 고르게
  if (r.width < 4 || r.height < 4) {
    sel.hidden = true;
    document.body.classList.remove('selecting');
    return;
  }
  done = true;
  api.capture.done(r);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
});
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  cancel();
});
