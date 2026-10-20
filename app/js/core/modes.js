// 메모킹 Work / Life — 일할 때 쓰는 메모와 나머지 일상 메모를 나눠 본다 (PC · 휴대폰 같은 규칙)
//   메모 파일 머리말의 mode: work (없으면 Life — 예전 메모는 모두 Life). 지금 보는 모드는 기기마다 따로 고른다.
//   목록 · 검색 · 일정은 지금 모드의 메모만, 검색은 다른 모드에서 찾은 수를 함께 알려 준다. 추억 달력은 Life 에만.
export const MODES = ['life', 'work'];
export const MODE_LABEL = { life: 'Life', work: 'Work' };
export const MODE_KEY = 'memoking.mode';

export const validMode = (m) => (m === 'work' ? 'work' : 'life');
export const memoMode = (memo) => validMode(memo?.mode);
export const otherMode = (m) => (validMode(m) === 'work' ? 'life' : 'work');
export const inMode = (memo, mode) => memoMode(memo) === validMode(mode);

/** 지금 모드의 메모 · 다른 모드에서 찾은 수 */
export function splitByMode(memos, mode) {
  const mine = [];
  let other = 0;
  for (const m of memos ?? []) {
    if (inMode(m, mode)) mine.push(m);
    else other += 1;
  }
  return { mine, other };
}

/** 메뉴 글: "Work로 옮기기" / "Life로 옮기기" */
export const moveLabel = (memo) => `${MODE_LABEL[otherMode(memoMode(memo))]}로 옮기기`;
