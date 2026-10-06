// 밖에서 들어온 글(공유하기·붙여넣기·.md 파일)이 마크다운인지 알아보고, 메모킹 편집기가 그대로 그릴 수 있게 다듬는다.
//   - "## 제목", "- 항목", "1. 항목", "- [ ] 할 일", "> 인용", ``` 코드, | 표 |, **굵게**, [글](주소) 같은 표시가 보이면 마크다운
//   - ChatGPT 등에서 온 수식 \( x \) · \[ x \] · $x$ 는 메모킹 수식 표기($$x$$)로
// 마크다운이 아니면 줄마다 문단으로 (마크다운에서 줄 하나 바꿈은 같은 문단으로 붙어 버린다).

const STRONG = [
  /^#{1,6}\s+\S/m, // 제목
  /^\s*(```|~~~)/m, // 코드 블록
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m, // 표 구분 줄
  /^\s*[-*+]\s+\[[ xX]\]\s+/m, // 체크리스트
  /^\s*\$\$\s*$/m, // 수식 블록
];
const WEAK = [
  /^\s*[-*+]\s+\S/m, // 점 목록
  /^\s*\d{1,3}[.)]\s+\S/m, // 번호 목록
  /^>\s?\S/m, // 인용
  /\*\*[^*\n]+\*\*|__[^_\n]+__/, // 굵게
  /\[[^\]\n]+\]\((https?:|attachments\/)[^)\s]+\)/, // 링크
  /`[^`\n]+`/, // 코드
  /~~[^~\n]+~~/, // 취소선
  /^\s*([-*_])(\s*\1){2,}\s*$/m, // 가로줄
  /\\\(|\\\[|\$\$[^$\n]+\$\$/, // 수식
];

/** 마크다운 서식이 들어 있는 글인가 */
export function looksLikeMarkdown(text) {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (STRONG.some((r) => r.test(t))) return true;
  let weak = 0;
  for (const r of WEAK) if (r.test(t)) weak++;
  // 목록 두 줄 이상이면 그것만으로도
  const listLines = t.split('\n').filter((l) => /^\s*([-*+]|\d{1,3}[.)])\s+\S/.test(l)).length;
  return weak >= 2 || listLines >= 2;
}

// 코드 블록·인라인 코드 바깥에서만 바꾼다
function outsideCode(text, fn) {
  const parts = text.split(/(^\s*(?:```|~~~)[^\n]*\n[\s\S]*?^\s*(?:```|~~~)\s*$|`[^`\n]*`)/m);
  return parts.map((p, i) => (i % 2 ? p : fn(p))).join('');
}

/** 다른 곳의 수식 표기를 메모킹 수식($$x$$, 블록은 $$ 줄)으로 */
export function normalizeMath(text) {
  return outsideCode(text, (s) => s
    // \[ ... \] (여러 줄) → 수식 블록
    .replace(/(^|\n)[ \t]*\\\[\s*([\s\S]+?)\s*\\\][ \t]*(?=\n|$)/g, (_m, pre, body) => `${pre}$$\n${body.trim()}\n$$`)
    // 글 가운데 \[..\] · \(..\) → $$..$$
    .replace(/\\\[\s*([^\n]+?)\s*\\\]/g, (_m, body) => `$$${body}$$`)
    .replace(/\\\(\s*([^\n]+?)\s*\\\)/g, (_m, body) => `$$${body}$$`)
    // $x$ (앞뒤 띄어쓰기 없고, 돈 표시가 아닌 것) → $$x$$
    .replace(/(^|[^$\\\w])\$(?!\$)([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?![$\d\w])/g, (m, pre, body) => (/^\d+([.,]\d+)?$/.test(body) ? m : `${pre}$$${body}$$`)));
}

/** 줄바꿈 맞추기 (\r\n → \n), 끝 공백 줄 정리 */
const tidy = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/**
 * 밖에서 받은 글 → 편집기에 붙일 마크다운
 * @returns {{ markdown: string, isMarkdown: boolean }}
 */
export function importText(text) {
  const t = tidy(text);
  if (looksLikeMarkdown(t)) return { markdown: normalizeMath(t), isMarkdown: true };
  // 그냥 글: 줄마다 문단으로, 마크다운으로 읽힐 기호는 그대로 보이게
  const escaped = t.replace(/^(\s*)(#{1,6}(?=\s)|>|[-*+](?=\s))/gm, '$1\\$2').replace(/^(\s*\d+)\.(?=\s)/gm, '$1\\.');
  return { markdown: escaped.replace(/([^\n])\n(?!\n)/g, '$1\n\n'), isMarkdown: false };
}

/** .md · .markdown · .txt 파일이면 글로 읽어 메모 본문으로 쓸 수 있다 */
export const isTextDocument = (name = '', mime = '') => /\.(md|markdown|mdown|mkd|txt)$/i.test(name) || /^text\/(markdown|x-markdown|plain)$/i.test(mime);

/** .md 파일 내용: 머리말(--- … ---)은 빼고 본문만 */
export function stripFrontMatter(text) {
  const t = tidy(text);
  const m = /^---\n[\s\S]*?\n---\n?/.exec(t);
  return m ? t.slice(m[0].length).trim() : t;
}
