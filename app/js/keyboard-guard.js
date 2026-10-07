// 휴대폰(손가락): 무언가를 옮기는 동안에는 키보드가 절대 뜨지 않게 한다.
//   - 목록 항목·그림 등을 들어 올리거나 옆으로 밀기 시작하면 편집기에 inputmode="none" 을 달고, 떠 있던 키보드는 내린다
//   - 그림·소리·동영상·파일·링크 카드·수식을 누르기만 해도 키보드를 올리지 않는다
//   - 글자를 다시 누르면 떼어 평소처럼 키보드가 올라온다
// 마우스(PC)에는 아무 일도 하지 않는다.
const coarse = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;

// ---------- 다루기 방식 (휴대폰 메모 화면 오른쪽 아래 다이얼, android/web/js/mode-knob.js) ----------
//   'both' 지금처럼(PC·기본): 글을 고치다가 꾹 누르면 옮기기
//   'edit' 글 고치기: 옮기기 손짓을 끄고 꾹 누르면 글자 고르기(복사·고치기) · 키보드 씀
//   'move' 옮기기: 키보드 없이, 짧게 눌러도 줄·항목을 들어 옮김
//   'draw' 글 위에 그리기: 키보드 없이 (그리기는 ink-annotate.js)
let mode = 'both';
export const touchMode = () => mode;
// 마지막으로 닿은 것이 펜인가 — pointerdown 이 touchstart 보다 먼저 오므로, touchType 을 알려 주지 않는 WebView 에서도 안다
let lastPointer = { type: '', at: 0 };
globalThis.addEventListener?.('pointerdown', (e) => {
  lastPointer = { type: e.pointerType, at: e.timeStamp };
}, { capture: true, passive: true });
/** 방금(0.6초 안) 펜이 닿았나 */
export const penJustTouched = (now = globalThis.performance?.now() ?? 0) => lastPointer.type === 'pen' && now - lastPointer.at < 600;
/** S펜(스타일러스)으로 닿은 터치인가 — 펜은 손가락과 같은 touch 이벤트로도 오므로 */
export const isStylusTouch = (e) => e?.touches?.[0]?.touchType === 'stylus' || e?.pointerType === 'pen' || (e?.type === 'touchstart' && penJustTouched(e.timeStamp));
/** 지금 끌어 옮기기 손짓을 받는가 */
export const canDrag = () => mode === 'both' || mode === 'move';
/** 옮기기 방식에서는 글자 고르기와 겹치지 않으니 짧게만 누르면 들어 올린다 (스크롤하려고 미는 것과는 구분) */
export const MOVE_MODE_HOLD_MS = 180;
export const holdFor = (ms) => (mode === 'move' ? Math.min(ms, MOVE_MODE_HOLD_MS) : ms);

/** 다루기 방식을 바꾼다 — 편집기 본문(dom)의 키보드도 함께 (고치기만 키보드를 쓴다) */
export function setTouchMode(next, dom) {
  mode = next;
  if (!dom) return;
  if (next === 'move' || next === 'draw') {
    dom.setAttribute('inputmode', 'none');
    dom.dataset.mkNoKeyboard = '1';
    if (dom.contains(document.activeElement) || document.activeElement === dom) dom.blur();
  } else {
    dom.removeAttribute('inputmode');
    delete dom.dataset.mkNoKeyboard;
  }
}
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
  if (!coarse() || mode === 'move' || mode === 'draw') return; // 옮기기·그리기 방식은 글자를 눌러도 키보드를 올리지 않는다
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
