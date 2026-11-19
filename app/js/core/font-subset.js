// 글자 묶음(unicode-range)으로 나눈 글꼴(Pretendard 나눠 읽기 판)에서, 이 글에 나오는 글자를 가진 조각만 고른다.
//   그림으로 저장 · 복사(share-image.js)가 글꼴을 그림에 넣을 때 — 92조각을 다 넣지 않게

/** "U+AC00-D7A3, U+0041" → [[0xac00, 0xd7a3], [0x41, 0x41]] ("U+4??" 같은 와일드카드도) */
export function parseUnicodeRange(range) {
  return String(range).split(',').map((r) => r.trim().replace(/^U\+/i, '')).filter(Boolean).map((r) => {
    const [a, b] = r.split('-');
    return [parseInt(a.replace(/\?/g, '0'), 16), parseInt((b ?? a).replace(/\?/g, 'F'), 16)];
  }).filter(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi));
}

/** @font-face 묶음 글 → 이 글의 글자를 가진 조각만 남긴 글 (unicode-range 가 없는 규칙 · 그 밖의 글은 그대로) */
export function fontFacesFor(css, text) {
  const cps = [...new Set([...String(text ?? '')].map((c) => c.codePointAt(0)))];
  return String(css ?? '').split(/(?=@font-face)/).filter((block) => {
    if (!block.trimStart().startsWith('@font-face')) return true;
    const m = /unicode-range\s*:\s*([^;}]+)/i.exec(block);
    if (!m) return true;
    const ranges = parseUnicodeRange(m[1]);
    return cps.some((cp) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi));
  }).join('');
}

/** 캔버스에 쓸 글자의 글꼴 조각을 미리 읽는다 — 나눠 읽기 판은 화면에 아직 안 나온 글자의 조각이 없어, 그대로 그리면 그 글자만 다른 글꼴로 나왔다 */
export async function loadFontFor(family, text) {
  try {
    await globalThis.document?.fonts?.load(`16px ${family}`, String(text ?? '') || ' ');
  } catch {
    // 못 읽으면 다른 글꼴로라도 그린다
  }
}
