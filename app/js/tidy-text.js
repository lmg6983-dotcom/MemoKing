// 다듬기의 글자 규칙 (순수 함수, tidy.js 가 쓴다)
export const INVISIBLE = /[\u200B\uFEFF\u2060]/g;

/** 글 한 덩어리의 띄어쓰기 고침 (atStart·atEnd: 이 덩어리가 줄의 처음·끝인가) */
export function tidyText(text, { atStart = true, atEnd = true } = {}) {
  let out = text.replace(INVISIBLE, '').replace(/\u00A0/g, ' ');
  out = out.replace(/ {2,}/g, ' ');
  out = out.replace(/,{2,}/g, ',');
  out = out.replace(/([가-힣]) +([.,!?])(?=\s|$)/g, '$1$2');
  if (atStart) out = out.replace(/^ +/, '');
  if (atEnd) out = out.replace(/ +$/, '');
  return out;
}

