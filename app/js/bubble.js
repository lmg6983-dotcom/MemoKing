// 상태 말풍선 창 (메인 프로세스가 메모 창 바깥에 띄운다 — desktop/status-bubble-window.js)
//   place: above(창 위, 꼬리 아래로) · right / left(창 옆, 꼬리가 창 쪽으로) · over(창 안 윗막대 위, 꼬리 없음)
//   above 에서 위 스티커(왕관 · 테이프)와 겹치면: 스티커 왼쪽에 들어가면 그 폭으로, 안 되면 스티커 위로 올린다
import { reduceMotion } from './dom.js';

const bubble = document.getElementById('bubble');
const EDGE = 8;
const MIN_W = 140; // 스티커 왼쪽에 넣을 때 이보다 좁으면 (글이 너무 여러 줄로 쪼개져) 위로 올린다
const PLACES = ['above', 'right', 'left', 'over'];

function setTail(x, y) {
  bubble.style.setProperty('--tail-x', `${Math.round(x)}px`);
  bubble.style.setProperty('--tail-y', `${Math.round(y)}px`);
}

/** 가로 자리: 꼬리(ax)가 말풍선 안에 들게, 창 안에서 */
function placeX(ax, maxRight = innerWidth - EDGE) {
  const w = bubble.offsetWidth;
  const left = Math.max(EDGE, Math.min(ax - 24, maxRight - w));
  bubble.style.left = `${Math.round(left)}px`;
  return { left, w };
}

window.memoking.on('bubble:show', ({ text = '', error = false, place = 'above', ax = 24, ay = 30, avoid = null } = {}) => {
  const body = document.createElement('span'); // 글은 안쪽 칸에 (넘치면 이 칸만 잘린다 — 꼬리는 바깥에 그대로)
  body.className = 'bubble-text';
  body.textContent = text;
  bubble.replaceChildren(body);
  bubble.classList.toggle('error', error);
  bubble.classList.remove('lifted');
  bubble.style.removeProperty('--max-h');
  for (const p of PLACES) document.body.classList.toggle(`p-${p}`, p === place);
  Object.assign(bubble.style, { left: '', right: '', top: '', bottom: '', maxWidth: '' });
  const fresh = bubble.hidden;
  bubble.hidden = false;
  if (place === 'above' || place === 'over') {
    let { left, w } = placeX(ax);
    if (place === 'above' && avoid && left < avoid.right && left + w > avoid.left) {
      const room = avoid.left - 6 - left;
      if (ax < avoid.left && room >= MIN_W) {
        bubble.style.maxWidth = `${Math.round(room)}px`; // 스티커 왼쪽에 들어가게 좁혀서
        ({ left, w } = placeX(ax, avoid.left - 6));
      } else {
        // 스티커 위로 올린다 — 꼬리는 스티커를 가리키게 되므로 감추고, 창 위 끝에 잘리지 않게 높이를 묶는다
        bubble.style.bottom = `${EDGE + avoid.rise}px`;
        bubble.classList.add('lifted');
        bubble.style.setProperty('--max-h', `${Math.max(40, innerHeight - EDGE * 2 - avoid.rise)}px`);
      }
    }
    setTail(Math.max(14, Math.min(ax - left, w - 14)), 0);
  } else {
    const h = bubble.offsetHeight;
    const top = Math.max(4, Math.min(ay - 16, innerHeight - h - 4));
    bubble.style.top = `${Math.round(top)}px`;
    setTail(0, Math.max(12, Math.min(ay - top, h - 12)));
  }
  if (fresh && !reduceMotion()) {
    bubble.classList.remove('in');
    void bubble.offsetWidth;
    bubble.classList.add('in');
  }
});
window.memoking.on('bubble:hide', () => {
  bubble.hidden = true;
});
