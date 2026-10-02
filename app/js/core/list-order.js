// 목록 항목 끌어 옮기기의 순서 계산 (순수 함수, 단위 테스트 대상) — app/js/list-drag.js 가 쓴다

export const EDGE = 0.28; // 항목 높이의 위·아래 이만큼은 "사이에 끼우기", 가운데는 "맞바꾸기"

/**
 * 같은 목록 안에서 놓을 결과의 순서 (미리 보기·단위 테스트용, 순수 함수)
 * @param {number} n 항목 수 @param {number} s 끄는 항목 @param {{ kind: 'swap'|'insert', index: number }} drop
 *   swap: index 번째와 맞바꿈 / insert: index 번째 항목 앞(= n 이면 맨 끝)에 끼움
 * @returns {number[]} 새 순서 (원래 번호들)
 */
export function previewOrder(n, s, drop) {
  const order = [...Array(n).keys()];
  if (!drop) return order;
  if (drop.kind === 'swap') {
    if (drop.index === s) return order;
    [order[s], order[drop.index]] = [order[drop.index], order[s]];
    return order;
  }
  const rest = order.filter((i) => i !== s);
  const at = drop.index > s ? drop.index - 1 : drop.index;
  rest.splice(at, 0, s);
  return rest;
}

// 항목 안 어디에 놓였는지: 가운데 = 맞바꾸기, 위·아래 가장자리 = 그 앞·뒤에 끼우기
export function dropAt(index, frac) {
  if (frac < EDGE) return { kind: 'insert', index };
  if (frac > 1 - EDGE) return { kind: 'insert', index: index + 1 };
  return { kind: 'swap', index };
}

