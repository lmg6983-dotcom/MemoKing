// 줄 앞 띄어쓰기 지키기 — "  국내사업부 대표…" 처럼 문장 앞에 넣은 빈칸이 저장 · 붙여넣기 · 복사에서 사라지지 않게
//   마크다운은 문단 앞의 빈칸(띄어쓰기 · 탭)을 지우고, 네 칸 이상이면 코드 블록으로 읽는다.
//   그래서 줄 앞 빈칸은 "줄 바꿈 없는 빈칸"(U+00A0) 으로 둔다 — 마크다운이 지우지 않고, 파일에서도 그냥 빈칸으로 보인다.
//   밖으로 복사할 때 일반 글자에는 다시 보통 빈칸으로 (plainSpaces).

export const NBSP = ' ';
const TAB = NBSP.repeat(4);

/** 줄 앞 빈칸(띄어쓰기 · 탭) → U+00A0 (탭은 네 칸) */
export const keepIndent = (ws) => ws.replace(/\t/g, TAB).replace(/ /g, NBSP);

// 마크다운에서 뜻이 있는 들여쓰기: 하위 목록 · 인용 (그대로 둔다)
const MARKDOWN_ITEM = /^([-*+]|\d{1,9}[.)])[ \t]|^>/;

/**
 * 붙여넣을 일반 글자: 줄마다 앞 빈칸을 지킨다 (``` 코드 블록 · 하위 목록 · 인용 줄은 그대로)
 * @param {string} text
 */
export function keepLeadingSpaces(text) {
  let fence = false;
  return String(text ?? '').split('\n').map((line) => {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence) return line;
    const m = /^[ \t]+/.exec(line);
    if (!m || m[0].length === line.length) return line;
    const rest = line.slice(m[0].length);
    return MARKDOWN_ITEM.test(rest) ? line : keepIndent(m[0]) + rest;
  }).join('\n');
}

/** 앞 빈칸이 있는 줄이 있는가 (코드 블록 밖, 빈 줄 · 하위 목록 · 인용은 빼고) */
export function hasLeadingSpaces(text) {
  return keepLeadingSpaces(text) !== String(text ?? '');
}

/** 밖으로 복사하는 일반 글자: U+00A0 → 보통 빈칸 (메모장 · 메신저 · 입력 칸에서 그냥 띄어쓰기로) */
export const plainSpaces = (s) => String(s ?? '').replace(/ /g, ' ');

/** 서식(HTML)으로 복사하는 글: 이어진 빈칸 · 줄 앞 빈칸이 워드 · 메일에서 하나로 줄지 않게 U+00A0 로 */
//   lineStart: 줄(문단)의 맨 앞 글이면 빈칸 하나도
export function htmlSpaces(s, lineStart = false) {
  const out = String(s ?? '').replace(/ {2,}/g, (m) => NBSP.repeat(m.length));
  return lineStart ? out.replace(/^ /, NBSP) : out;
}
