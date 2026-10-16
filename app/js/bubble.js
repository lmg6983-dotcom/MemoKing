// 상태 말풍선 창 (메인 프로세스가 메모 창 위 가장자리 바깥에 띄운다 — desktop/status-bubble-window.js)
//   above: 창 위에 매달림(꼬리가 아래로, 말풍선은 창 바닥에) · 아니면 창 안 윗막대 밑(꼬리가 위로)
//   anchor: 꼬리가 가리킬 x (창 안 좌표) — 말풍선은 글 너비에 맞춰 그 둘레에 두고, 꼬리는 늘 말풍선 안에
import { reduceMotion } from './dom.js';

const bubble = document.getElementById('bubble');
const EDGE = 8;
window.memoking.on('bubble:show', ({ text = '', error = false, above = true, anchor = 24 } = {}) => {
  bubble.textContent = text;
  bubble.classList.toggle('error', error);
  document.body.classList.toggle('above', above);
  const fresh = bubble.hidden;
  bubble.hidden = false;
  const w = bubble.offsetWidth;
  const left = Math.max(EDGE, Math.min(anchor - 24, innerWidth - w - EDGE));
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.setProperty('--tail-x', `${Math.round(Math.max(14, Math.min(anchor - left, w - 14)))}px`);
  if (fresh && !reduceMotion()) {
    bubble.classList.remove('in');
    void bubble.offsetWidth;
    bubble.classList.add('in');
  }
});
window.memoking.on('bubble:hide', () => {
  bubble.hidden = true;
});
