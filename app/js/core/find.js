// 메모 안 찾기 · 바꾸기 (워드의 찾기 및 바꾸기처럼) — 글자 줄에서 찾을 말의 자리 찾기 (순수 함수, 단위 테스트 대상)
//   편집기(find-replace.js)는 문단마다 글을 모아 이것으로 찾고, 찾은 자리를 표시 · 바꾼다.

// 낱말 글자: 글자 · 숫자 · 밑줄 (한글 포함)
const WORD = /[\p{L}\p{N}_]/u;

/**
 * 글에서 찾을 말의 자리들 [시작, 끝) — 겹치지 않게 앞에서부터
 * @param {string} text
 * @param {string} query
 * @param {{ caseSensitive?: boolean, wholeWord?: boolean }} [o]
 *   caseSensitive: 대소문자 구분 (기본은 구분 안 함) · wholeWord: 낱말 전체만 (앞뒤가 낱말 글자가 아닐 때)
 * @returns {[number, number][]}
 */
export function findInText(text, query, { caseSensitive = false, wholeWord = false } = {}) {
  const s = String(text ?? '');
  const q = String(query ?? '');
  if (!q || !s) return [];
  // 대소문자를 무시할 때: 소문자로 바꿔도 길이가 같을 때만 (자리가 어긋나지 않게 — 아니면 그대로 찾는다)
  let hay = s;
  let needle = q;
  if (!caseSensitive) {
    const ls = s.toLowerCase();
    const lq = q.toLowerCase();
    if (ls.length === s.length && lq.length === q.length) {
      hay = ls;
      needle = lq;
    }
  }
  const out = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i)) {
    const end = i + needle.length;
    if (!wholeWord || ((i === 0 || !WORD.test(s[i - 1])) && (end === s.length || !WORD.test(s[end])))) {
      out.push([i, end]);
      i = end;
    } else i += 1;
  }
  return out;
}

/**
 * 지금 자리(pos)에서 다음 · 이전으로 갈 찾은 곳의 번호 (끝에서는 처음으로 돌아간다)
 * @param {{ from: number }[]} matches 문서 순서대로
 * @param {number} pos 커서 자리
 * @param {1|-1} dir
 */
export function stepMatch(matches, pos, dir = 1) {
  if (!matches.length) return -1;
  if (dir > 0) {
    const i = matches.findIndex((m) => m.from >= pos);
    return i < 0 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].from < pos) return i;
  return matches.length - 1;
}

/** 찾은 개수 글: "3/12" · 없으면 "없음" · 아직 안 찾았으면 "" */
export function findCountText(current, total, query) {
  if (!query) return '';
  if (!total) return '없음';
  return `${current >= 0 ? current + 1 : 0}/${total}`;
}
