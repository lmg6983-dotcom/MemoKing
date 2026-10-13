// 다듬기의 글자 규칙 (순수 함수, tidy.js 가 쓴다)
export const INVISIBLE = /[\u200B\uFEFF\u2060]/g;

/**
 * 글 한 덩어리의 띄어쓰기 고침 (atStart · atEnd: 이 덩어리가 줄의 처음 · 끝인가)
 *   일부러 들여 쓴 줄 앞 빈칸은 줄 바꿈 없는 빈칸(U+00A0)이라 그대로 (줄 앞에서 친 띄어쓰기 · 붙여 넣은 들여쓰기 —
 *   editor.js keepIndent). 줄을 나누다 남은 보통 띄어쓰기만 지운다. 겹친 띄어쓰기도 그대로 (안내 문구 칸 맞춤)
 */
export function tidyText(text, { atStart = true, atEnd = true } = {}) {
  let out = text.replace(INVISIBLE, '');
  // 겹친 쉼표(",,")는 그대로 둔다 — "그래,,, 알겠어" 처럼 말줄임으로 일부러 쓰는 경우가 많다
  out = out.replace(/([가-힣]) +([.,!?])(?=\s|$)/g, '$1$2');
  if (atStart) out = out.replace(/^ +/, '');
  if (atEnd) out = out.replace(/ +$/, '');
  return out;
}

