// 체크리스트 진행 — 마크다운의 "- [ ] 할 일" / "- [x] 한 일" 을 센다 (순수 함수, 단위 테스트 대상)
// 코드 블록(``` · ~~~) 안의 줄은 세지 않는다.

const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?=\s|$)/;
const FENCE = /^\s*(```|~~~)/;

/**
 * @param {string} markdown 메모 본문
 * @returns {{ total: number, done: number }}
 */
export function taskProgress(markdown) {
  let total = 0;
  let done = 0;
  let fence = null;
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = TASK.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { total, done };
}

// 모든 체크리스트를 끝냈는가 (체크리스트가 하나 이상 있을 때만) — 메모와 목록 카드의 CLEAR 도장
export const isAllClear = (p) => Boolean(p && p.total > 0 && p.done === p.total);
