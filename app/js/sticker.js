// 늘 위에 두기 왕관 스티커 창 — 메인 프로세스가 창 위 가장자리에 반쯤 걸쳐 띄운다.
// 왕관 위에서만 마우스를 받고(손 모양·살짝 들림), 누르면 떼어져 늘 위에 두기가 꺼진다. 나머지 투명한 곳은 통과.
const api = window.memoking;
const crown = document.getElementById('crown');
const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let over = false;
let peeled = false;

api.on('sticker:show', ({ animate } = {}) => {
  peeled = false;
  crown.classList.remove('peeling', 'sticking');
  if (animate && !reduce()) {
    void crown.getBoundingClientRect();
    crown.classList.add('sticking');
  }
});
api.on('sticker:peel', () => {
  peeled = true;
  setOver(false);
  crown.classList.remove('sticking');
  if (!reduce()) crown.classList.add('peeling');
});

function setOver(next) {
  if (next === over) return;
  over = next;
  crown.classList.toggle('hover', over);
  api.sticker.hover(over);
}

// 투명한 곳의 움직임도 전달받으므로(forward), 왕관 모양 위인지 보고 마우스를 받을지 정한다
document.addEventListener('mousemove', (e) => {
  if (!peeled) setOver(Boolean(e.target.closest?.('.hit')));
});
document.addEventListener('mouseleave', () => setOver(false));
crown.addEventListener('click', (e) => {
  if (peeled || !e.target.closest?.('.hit')) return;
  api.sticker.peel();
});

document.documentElement.dataset.ready = 'true';
