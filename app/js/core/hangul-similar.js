// 작은 글씨에서 서로 헷갈리는 한글 — 글자 인식 결과를 같은 글꼴로 그려 견줄 후보 (순수 함수, 단위 테스트 대상)
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

// 획 하나 차이로 헷갈리는 자모끼리 (초성 · 중성 · 종성)
const SIMILAR = {
  cho: [['ㅁ', 'ㅂ'], ['ㄱ', 'ㅋ'], ['ㄷ', 'ㅌ', 'ㄹ'], ['ㅈ', 'ㅊ'], ['ㅇ', 'ㅎ']],
  jung: [['ㅗ', 'ㅜ', 'ㅡ'], ['ㅓ', 'ㅕ'], ['ㅏ', 'ㅑ'], ['ㅐ', 'ㅔ'], ['ㅚ', 'ㅟ', 'ㅢ'], ['ㅛ', 'ㅠ']],
  jong: [['ㅁ', 'ㅂ'], ['ㄴ', 'ㄹ'], ['ㄱ', 'ㄲ']],
};

const mates = (kind, jamo) => (SIMILAR[kind].find((g) => g.includes(jamo)) ?? []).filter((x) => x !== jamo);
const compose = (c, v, t) => String.fromCharCode(0xac00 + (c * 21 + v) * 28 + t);

export const isHangul = (ch) => /^[가-힣]$/.test(ch);

/** 한 글자(완성형 한글)의 비슷한 글자들 — 자모 하나만 비슷한 것으로 바꾼다 ("몰" → "볼" · "물" · "믈" …) */
export function similarSyllables(ch) {
  if (!isHangul(ch)) return [];
  const code = ch.charCodeAt(0) - 0xac00;
  const c = Math.floor(code / 588);
  const v = Math.floor((code % 588) / 28);
  const t = code % 28;
  return [
    ...mates('cho', CHO[c]).map((m) => compose(CHO.indexOf(m), v, t)),
    ...mates('jung', JUNG[v]).map((m) => compose(c, JUNG.indexOf(m), t)),
    ...mates('jong', JONG[t]).map((m) => compose(c, v, JONG.indexOf(m))),
  ];
}
