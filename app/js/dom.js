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
