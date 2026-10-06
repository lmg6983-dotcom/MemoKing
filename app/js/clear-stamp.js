// CLEAR 도장: 체크리스트를 모두 끝내면 메모 본문 정중앙에 (v0.17.13 · PC·휴대폰 같음)
import { haptic, replayClass } from './dom.js';

/**
 * @param {HTMLElement} parent  도장을 붙일 곳
 * @param {HTMLElement} area    도장이 가운데에 올 본문
 */
export function createClearStamp(parent, area) {
  const stamp = document.createElement('div');
  stamp.className = 'clear-stamp';
  stamp.textContent = 'CLEAR';
  stamp.setAttribute('role', 'status');
  stamp.setAttribute('aria-label', '체크리스트를 모두 끝냈어요');
  stamp.hidden = true;
  parent.append(stamp);
  const place = () => {
    const r = area.getBoundingClientRect();
    stamp.style.left = `${Math.round(r.left + r.width / 2)}px`;
    stamp.style.top = `${Math.round(r.top + r.height / 2)}px`;
  };
  new ResizeObserver(() => {
    if (!stamp.hidden) place();
  }).observe(area);

  return {
    // 처음 열 때는 그냥 찍혀 있고, 방금 끝냈을 때만 "쿵"
    show({ total, done }, { initial = false } = {}) {
      const clear = total > 0 && done === total;
      const was = !stamp.hidden;
      stamp.hidden = !clear;
      if (!clear) {
        stamp.classList.remove('stamp-in');
        return;
      }
      place();
      if (!was && !initial) {
        replayClass(stamp, 'stamp-in');
        haptic(30);
      }
    },
    hide() {
      stamp.hidden = true;
    },
  };
}
