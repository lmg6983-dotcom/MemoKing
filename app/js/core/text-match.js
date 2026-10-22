// 검색어가 글에 들어 있나 — 대소문자 무시, 띄어 쓴 낱말은 모두 들어 있어야, 자음만 쓰면 초성 검색 (ㅈㅂㄱ → 장보기)
// 초성 뽑기는 es-hangul(토스, MIT)
import { getChoseong } from '../../vendor/es-hangul.js';

const CHOSEONG_ONLY = /^[ㄱ-ㅎ]+$/;

// 관리번호처럼 글자·숫자 사이에 - / . _ 등이 낀 말: 기호를 빼고도 비교 (P2026-1170-KR01 ↔ P20261170KR01, FPD/202608-0118/E ↔ FPD2026080118E)
const SEPARATORS = /[^\p{L}\p{N}]+/gu;
/** 기호(띄어쓰기 포함)를 뺀 글 — 소문자 */
export const compactText = (s) => String(s ?? '').toLowerCase().replace(SEPARATORS, '');
/** 기호를 빼고 비교할 낱말인가: 숫자가 있고, 뺀 뒤에도 4글자 이상 (짧은 말은 엉뚱한 곳에 걸리기 쉬워) */
export const compactTermOf = (term) => {
  const c = compactText(term);
  return /\d/.test(c) && c.length >= 4 ? c : null;
};

export const isChoseongQuery = (term) => CHOSEONG_ONLY.test(term);

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
/** 한글 글자만 초성으로 (다른 글자는 그대로 — 길이가 같아 찾은 자리를 원래 글에 그대로 쓴다) */
export const choseongAligned = (s) => String(s ?? '').replace(/[가-힣]/g, (ch) => CHO[Math.floor((ch.charCodeAt(0) - 0xac00) / 588)]);

/** 초성 검색어(ㄱㅈㅅ)가 글의 어디에 맞나 — 띄어쓰기는 건너뛰고 ("회의 록" 도 ㅎㅇㄹ) [from, to) 또는 null */
export function choseongRange(text, term) {
  const t = String(text ?? '');
  if (!isChoseongQuery(term)) return null;
  const initials = choseongAligned(t).toLowerCase();
  let compact = '';
  const at = [];
  for (let i = 0; i < initials.length; i++) {
    if (/\s/.test(initials[i])) continue;
    compact += initials[i];
    at.push(i);
  }
  const k = compact.indexOf(term);
  return k < 0 ? null : [at[k], at[k + term.length - 1] + 1];
}

/**
 * @param {string} query
 * @returns {(...texts: string[]) => boolean} 낱말마다 texts 중 하나에 들어 있으면 true (빈 검색어는 늘 true)
 */
export function textMatcher(query) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  const needChoseong = terms.some(isChoseongQuery);
  const compactTerms = terms.map(compactTermOf);
  return (...texts) => {
    const lower = texts.map((t) => String(t ?? '').toLowerCase());
    let initials = null; // 필요할 때만 한 번 (긴 메모가 많아도 가볍게)
    let compact = null;
    return terms.every((term, i) => {
      if (lower.some((t) => t.includes(term))) return true;
      if (compactTerms[i]) {
        compact ??= lower.map((t) => t.replace(SEPARATORS, ''));
        if (compact.some((t) => t.includes(compactTerms[i]))) return true;
      }
      if (!needChoseong || !isChoseongQuery(term)) return false;
      initials ??= lower.map((t) => { const c = getChoseong(t); return [c, c.replace(/\s+/g, '')]; }).flat();
      return initials.some((c) => c.includes(term));
    });
  };
}
