// 검색어가 글에 들어 있나 — 대소문자 무시, 띄어 쓴 낱말은 모두 들어 있어야, 자음만 쓰면 초성 검색 (ㅈㅂㄱ → 장보기)
// 초성 뽑기는 es-hangul(토스, MIT)
import { getChoseong } from '../../vendor/es-hangul.js';

const CHOSEONG_ONLY = /^[ㄱ-ㅎ]+$/;

export const isChoseongQuery = (term) => CHOSEONG_ONLY.test(term);

/**
 * @param {string} query
 * @returns {(...texts: string[]) => boolean} 낱말마다 texts 중 하나에 들어 있으면 true (빈 검색어는 늘 true)
 */
export function textMatcher(query) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  const needChoseong = terms.some(isChoseongQuery);
  return (...texts) => {
    const lower = texts.map((t) => String(t ?? '').toLowerCase());
    let initials = null; // 필요할 때만 한 번 (긴 메모가 많아도 가볍게)
    return terms.every((term) => {
      if (lower.some((t) => t.includes(term))) return true;
      if (!needChoseong || !isChoseongQuery(term)) return false;
      initials ??= lower.map((t) => { const c = getChoseong(t); return [c, c.replace(/\s+/g, '')]; }).flat();
      return initials.some((c) => c.includes(term));
    });
  };
}
