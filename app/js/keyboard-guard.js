// 휴대폰(손가락): 무언가를 옮기는 동안에는 키보드가 절대 뜨지 않게 한다.
//   - 목록 항목·그림 등을 들어 올리거나 옆으로 밀기 시작하면 편집기에 inputmode="none" 을 달고, 떠 있던 키보드는 내린다
//   - 그림·소리·동영상·파일·링크 카드·수식을 누르기만 해도 키보드를 올리지 않는다
//   - 글자를 다시 누르면 떼어 평소처럼 키보드가 올라온다
// 마우스(PC)에는 아무 일도 하지 않는다.
const coarse = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
const NO_KEYBOARD_TARGET = 'img, .mk-media, .mk-link-card, .mk-file, a[href], .mk-math, .mk-math-block, .mk-voice-bar';

/** 옮기기 시작: 키보드를 막고, 떠 있으면 내린다 */
export function holdKeyboard(view, { hide = true } = {}) {
  if (!coarse() || view.isDestroyed) return;
  const dom = view.dom;
  dom.setAttribute('inputmode', 'none');
  dom.dataset.mkNoKeyboard = '1';
  if (hide && view.hasFocus()) dom.blur(); // 떠 있던 키보드 내리기 (놓은 뒤 커서는 다시 오지만 키보드는 뜨지 않는다)
}

/** 손가락이 닿을 때: 내용(그림 등)이면 키보드를 막고, 글자면 다시 풀어 준다 */
export function keyboardFor(view, target) {
  if (!coarse()) return;
  const el = target instanceof Element ? target : target?.parentElement;
  if (!el || !view.dom.contains(el)) return;
  const dom = view.dom;
  if (el.closest(NO_KEYBOARD_TARGET)) {
    holdKeyboard(view, { hide: false });
  } else if (dom.dataset.mkNoKeyboard) {
    // 글자를 누름: 키보드를 다시 쓸 수 있게 (이미 초점이 있으면 한 번 놓아 새로 누른 것처럼 키보드가 뜨게)
    dom.removeAttribute('inputmode');
    delete dom.dataset.mkNoKeyboard;
    if (view.hasFocus()) dom.blur();
  }
}

/**
 * 끄는 동안 위·아래 끝 가까이에서 저절로 스크롤할 양 (px, 30ms 마다).
 * 가장자리 안쪽에서 가까울수록 빠르지만 상한이 있다 — 손가락이 끝 밖(도구막대 등)으로 멀리 나가도 휙 내려가지 않게.
 */
export function edgeScroll(y, top, bottom, edge = 44, max = 14) {
  const up = top + edge - y;
  const down = y - (bottom - edge);
  if (up > 0) return -Math.min(max, Math.ceil(Math.min(up, edge * 1.5) / 3));
  if (down > 0) return Math.min(max, Math.ceil(Math.min(down, edge * 1.5) / 3));
  return 0;
}
