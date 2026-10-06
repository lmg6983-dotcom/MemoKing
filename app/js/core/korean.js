// 한국어 글자 도구 (순수 함수) — 받아쓰기 고치기·태그 추천이 함께 쓴다
//   자모 나누기(ㅎ ㅚ ㅇ ㅢ …)와 자모 편집 거리: "엄무" ↔ "업무" 처럼 소리가 비슷한 말 찾기
//   조사·어미 떼기: "회의록을" → "회의록", "정리했어요" → "정리"

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

export const isHangul = (s) => /^[가-힣]+$/.test(s);

/** 글자 → 자모 배열 (받침 없는 글자는 자모 2개) */
export function jamo(word) {
  const out = [];
  for (const ch of String(word ?? '')) {
    const c = ch.codePointAt(0) - 0xac00;
    if (c < 0 || c > 11171) {
      out.push(ch.toLowerCase());
      continue;
    }
    out.push(CHO[Math.floor(c / 588)], JUNG[Math.floor((c % 588) / 28)]);
    if (c % 28) out.push(JONG[c % 28]);
  }
  return out;
}

/** 자모 편집 거리 (Levenshtein) */
export function jamoDistance(a, b) {
  const x = jamo(a);
  const y = jamo(b);
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

// 조사·어미 (긴 것부터) — 떼고 두 글자 이상 남을 때만
const ENDINGS = [
  '에서부터', '으로부터', '이라는', '이라고', '에게서', '한테서', '까지는', '부터는', '에서는', '으로는', '이에요', '입니다',
  '했어요', '했습니다', '합니다', '해요', '하고', '하는', '했다', '하기', '에서', '에게', '한테', '으로', '까지', '부터', '처럼',
  '보다', '라는', '이나', '이랑', '이다', '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만', '랑', '나', '요',
];

/** 낱말 끝의 조사·어미를 뗀 줄기 (한글이 아니면 그대로, 소문자) */
export function stem(word) {
  const w = String(word ?? '').trim().replace(/[.,!?~…'"“”‘’()[\]{}:;]+$/g, '');
  if (!isHangul(w)) return w.toLowerCase();
  for (const e of ENDINGS) if (w.length - e.length >= 2 && w.endsWith(e)) return w.slice(0, -e.length);
  return w;
}

/** 두 태그·낱말이 사실상 같은가: 대소문자·띄어쓰기·_- 차이, 한쪽이 다른 쪽 + 짧은 꼬리(회의 ↔ 회의록·회의들) */
export function normalizeTag(name) {
  return String(name ?? '').toLocaleLowerCase('ko').replace(/[\s_\-·.]+/g, '');
}
