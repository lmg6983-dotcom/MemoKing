// 다듬기의 글자 규칙 (순수 함수, tidy.js 가 쓴다)
export const INVISIBLE = /[\u200B\uFEFF\u2060]/g;

/**
 * 글 한 덩어리의 띄어쓰기 고침 (atEnd: 이 덩어리가 줄의 끝인가)
 *   줄 앞 띄어쓰기 · 겹친 띄어쓰기 · 줄 바꿈 없는 빈칸(U+00A0)은 그대로 — 안내 문구처럼 일부러 들여 쓰거나
 *   칸을 맞춘 글이 복사 · 붙여넣기에서 흐트러지지 않게 (core/indent-spaces.js)
 */
export function tidyText(text, { atEnd = true } = {}) {
  let out = text.replace(INVISIBLE, '');
  // 겹친 쉼표(",,")는 그대로 둔다 — "그래,,, 알겠어" 처럼 말줄임으로 일부러 쓰는 경우가 많다
  out = out.replace(/([가-힣]) +([.,!?])(?=\s|$)/g, '$1$2');
  if (atEnd) out = out.replace(/ +$/, '');
  return out;
}

