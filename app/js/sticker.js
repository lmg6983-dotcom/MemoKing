import { reduceMotion } from './dom.js';
// 메모 창 위 가장자리에 반쯤 걸쳐 붙는 스티커 창 — 메인 프로세스가 띄운다.
//   왕관(kind=crown): 늘 위에 두기 · 테이프(kind=tape): 바탕화면에 붙이기 (메모 창이 다른 창 뒤, 바탕화면 층에).
// 스티커 모양 위에서만 마우스를 받고(손 모양·살짝 들림), 누르면 떼어진다. 나머지 투명한 곳은 통과.
const api = window.memoking;
const kind = new URLSearchParams(location.search).get('kind') === 'tape' ? 'tape' : 'crown';
const sticker = document.getElementById(kind);
// SVG 에는 .hidden 속성이 없어(HTML 요소만) 속성으로 직접 — 그러지 않으면 테이프 창에 왕관이 그려지고 눌러도 떼어지지 않는다
document.getElementById(kind === 'tape' ? 'crown' : 'tape').setAttribute('hidden', '');
sticker.removeAttribute('hidden');
let over = false;
let peeled = false;

api.on('sticker:show', ({ animate } = {}) => {
  peeled = false;
  sticker.classList.remove('peeling', 'sticking');
  if (animate && !reduceMotion()) {
    void sticker.getBoundingClientRect();
    sticker.classList.add('sticking');
  }
});
api.on('sticker:peel', () => {
  peeled = true;
  setOver(false);
  sticker.classList.remove('sticking');
  sticker.classList.add('peeling'); // 움직임을 줄이면 들리지 않고 흐려지기만 (sticker.css)
});

function setOver(next) {
  if (next === over) return;
  over = next;
  sticker.classList.toggle('hover', over);
  api.sticker.hover(over); // 메모 창에 "누르면 떼어져요" 안내도
}

// 투명한 곳의 움직임도 전달받으므로(forward), 스티커 모양 위인지 보고 마우스를 받을지 정한다
document.addEventListener('mousemove', (e) => {
  if (!peeled) setOver(Boolean(sticker.contains(e.target) && e.target.closest?.('.hit')));
});
document.addEventListener('mouseleave', () => setOver(false));
sticker.addEventListener('click', (e) => {
  if (peeled || !e.target.closest?.('.hit')) return;
  api.sticker.peel();
});

document.documentElement.dataset.ready = 'true';
