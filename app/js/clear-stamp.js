// CLEAR 도장: 체크리스트를 모두 끝내면 메모 본문 정중앙에 (v0.17.13 · PC·휴대폰 같음)
import { haptic, replayClass } from './dom.js';

/**
 * @param {HTMLElement} parent  도장을 붙일 곳
 * @param {HTMLElement} area    도장이 가운데에 올 본문
 * @param {{ reserve?: () => number }} [o] reserve: 창 아래에 늘 비워 둘 높이 (PC 도구막대) — 주면 본문 크기가 아니라
 *   "본문 위 ~ 창 아래 - 도구막대" 의 가운데에 둔다. 도구막대가 숨었다 나타나며 본문 높이가 바뀌어도 도장이 움직이지 않게
 */
export function createClearStamp(parent, area, { reserve = null, inside = false } = {}) {
  const stamp = document.createElement('div');
  stamp.className = 'clear-stamp';
  stamp.textContent = 'CLEAR';
  stamp.setAttribute('role', 'status');
  stamp.setAttribute('aria-label', '체크리스트를 모두 끝냈어요');
  stamp.hidden = true;
  parent.append(stamp);
  // inside (휴대폰): 도장을 parent 안의 자리로 둔다 — 화면 좌표가 아니라 parent 기준이라, 메모 화면이 열리고 닫히며
  //   움직이거나 커지는 동안에도 도장이 따로 놀지 않는다. 키보드가 올라와 본문이 줄어도 제자리 (가장 컸던 높이의 가운데)
  let seen = { width: 0, height: 0 };
  const place = () => {
    if (inside) {
      const w = area.offsetWidth;
      const h = area.offsetHeight;
      if (!w || !h) return;
      if (w !== seen.width) seen = { width: w, height: h }; // 화면을 돌렸다 — 새로 잰다
      else seen.height = Math.max(seen.height, h);
      stamp.style.left = `${Math.round(area.offsetLeft + w / 2)}px`;
      stamp.style.top = `${Math.round(area.offsetTop + seen.height / 2)}px`;
      return;
    }
    const r = area.getBoundingClientRect();
    const bottom = reserve ? window.innerHeight - reserve() : r.bottom;
    stamp.style.left = `${Math.round(r.left + r.width / 2)}px`;
    stamp.style.top = `${Math.round(r.top + (bottom - r.top) / 2)}px`;
  };
  new ResizeObserver(() => {
    if (!stamp.hidden) place();
  }).observe(area);
  if (reserve) window.addEventListener('resize', () => !stamp.hidden && place());

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
