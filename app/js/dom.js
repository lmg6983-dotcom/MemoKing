// 화면 쪽 작은 도우미 — PC·휴대폰이 같이 쓴다

// 톡 하는 진동: 손가락으로 쓰는 기기만 (PC 크롬은 막고 경고를 남긴다)
export function haptic(pattern) {
  if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(pattern);
}

// 움직임 줄이기를 켠 사람에게는 날아다니는 효과를 쉬게
export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// 같은 애니메이션 클래스를 다시 붙여 처음부터 다시 돌린다
export function replayClass(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// 자리·크기가 바뀐 요소를 transform 으로만 옛 자리에서 미끄러져 오게 (FLIP).
//   width·left 같은 배치 속성을 애니메이션하지 않아 매 프레임 레이아웃을 다시 잡지 않는다.
//   prev: 바꾸기 전 getBoundingClientRect(). 요소의 인라인 transform(자리 잡기용 translate)은 끝값으로 지킨다
export function flipFrom(el, prev, { duration = 200, easing = 'cubic-bezier(0.23, 1, 0.32, 1)' } = {}) {
  const next = el.getBoundingClientRect();
  if (!prev?.width || !prev.height || !next.width || !next.height || reduceMotion()) return;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  const sx = prev.width / next.width;
  const sy = prev.height / next.height;
  if (!dx && !dy && sx === 1 && sy === 1) return;
  const base = el.style.transform || '';
  el.animate([
    { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) ${base} scale(${sx}, ${sy})` },
    { transformOrigin: '0 0', transform: base || 'none' },
  ], { duration, easing });
}
