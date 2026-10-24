// 새 버전 안내의 "바뀐 점" 다듬기 — 릴리스 노트는 README 이력 표의 한 칸이라 줄바꿈 없이 이어진 한 덩어리 글이다
//   ("**제목**: 설명, 설명. **다음 제목** 설명. 설명 (휴대폰 0.31.0)"). 읽기 쉽게 제목 줄 + 항목 줄로 나눈다.
//   · 줄바꿈이 있으면 줄마다 따로 · 맨 앞 **굵은 글**: 은 제목 · 문장 끝 ". " 에서 항목을 나눈다
//     (버전 번호 0.45.0 · Ctrl+Z. 같은 것은 마침표 뒤에 빈칸이 없거나 숫자라 나뉘지 않는다)
//   · 안쪽 **굵은 글** 표시는 그대로 두고 화면이 굵게 그린다 (boldParts)

const stripMarkdown = (t) => t
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [글](주소) → 글
  .replace(/`([^`]+)`/g, '$1');

/** 한 덩어리 글을 문장 항목으로: 마침표 + 빈칸 뒤에서 (앞이 숫자가 아닐 때) */
export function splitSentences(text) {
  return text
    .split(/(?<=[^\d\s])\.\s+(?=\S)/)
    .map((s) => s.trim().replace(/\.$/, '').trim())
    .filter(Boolean);
}

/**
 * @param {string} notes 릴리스 노트 글
 * @returns {({ type: 'head' | 'item', text: string })[]}
 */
export function parseReleaseNotes(notes) {
  const blocks = [];
  const paragraphs = stripMarkdown(String(notes ?? '').replace(/\r\n?/g, '\n')).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (let para of paragraphs) {
    para = para.replace(/^(?:[-*•]|\d+[.)])\s+(?!\*)/, ''); // 줄 앞 목록 표시
    const head = para.match(/^\*\*([^*]+)\*\*\s*[:：]?\s*/);
    if (head) {
      blocks.push({ type: 'head', text: head[1].trim() });
      para = para.slice(head[0].length);
    }
    for (const sentence of splitSentences(para)) blocks.push({ type: 'item', text: sentence });
  }
  return blocks;
}

/** "앞 **굵게** 뒤" → [{ text, bold }] (화면이 <strong> 으로 그린다 — 글을 HTML 로 넣지 않는다) */
export function boldParts(text) {
  return String(text).split(/\*\*/).map((t, i) => ({ text: t, bold: i % 2 === 1 })).filter((p) => p.text);
}

const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * 업데이트 뒤 한 번 보여 줄 "개선된 점": README 이력 표에서 from 다음부터 to 까지 버전마다 제목 한 줄 (새것부터 limit 개).
 *   제목은 행의 첫 **굵은 글** — 끝의 "(휴대폰 0.47.0)" 같은 덧붙임은 뺀다. 제목 없는 옛 행은 건너뛴다
 * @returns {{ version: string, title: string }[]}
 */
export function versionTitles(readme, from, to, limit = 5) {
  const out = [];
  for (const line of String(readme ?? '').split('\n')) {
    const m = /^\| `v(\d+\.\d+\.\d+)` \|[^|]*\|[^|]*\| \*\*([^*]+)\*\*/.exec(line);
    if (!m || cmpVersion(m[1], to) > 0 || (from && cmpVersion(m[1], from) <= 0)) continue;
    out.push({ version: m[1], title: m[2].replace(/\s*\((?:휴대폰|PC)[^)]*\)\s*$/, '').trim() });
  }
  return out.sort((a, b) => cmpVersion(b.version, a.version)).slice(0, limit);
}
