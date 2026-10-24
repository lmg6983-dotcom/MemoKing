// AI 글 도우미 (순수 함수) — 맞춤법 검사 · 문체 바꾸기 · 초안 쓰기의 묻는 말, 바뀐 곳 비교, 작은 모델의 엉뚱한 답 거르기.
//   모델은 desktop/ai (이 PC 안, 인터넷 없이). 고친 글은 바로 덮지 않고 바뀐 곳을 보여 주고 사용자가 고른다.

export const STYLES = {
  해요체: '해요체(~해요)',
  합니다체: '합니다체(~합니다)',
  간결체: '짧은 개조식(줄마다 "- " 로 시작)',
  보고서체: '보고서 문체(~함, ~임 으로 끝맺음)',
};
export const MAX_CHARS = 1500; // 글 모델 문맥(4096 토큰) 안에 묻는 글 · 바꾼 글이 함께 들어가게

const SPELL = '너는 한국어 맞춤법 검사기다. 사용자가 준 글의 맞춤법, 띄어쓰기, 오탈자만 고쳐서 고친 글만 출력한다. 뜻, 말투, 문장부호, #태그, 링크 주소는 바꾸지 않는다. 틀린 곳이 없으면 그대로 출력한다. 설명은 쓰지 않는다.';

export const spellMessages = (text) => [{ role: 'system', content: SPELL }, { role: 'user', content: text }];

export const styleMessages = (text, style) => [
  { role: 'system', content: `다음 글을 ${STYLES[style] ?? style}로 바꿔 쓴다. 내용은 더하거나 빼지 않는다. #태그와 링크 주소는 그대로 둔다. 바꾼 글만 출력한다.` },
  { role: 'user', content: text },
];

export function draftMessages({ title, body, request }) {
  const parts = [`메모 제목: ${title || '(없음)'}`];
  if (body?.trim()) parts.push(`지금까지 쓴 내용:\n${body.trim().slice(0, MAX_CHARS)}`);
  parts.push(`부탁: ${request?.trim() || '이 제목에 맞는 메모 초안을 써 줘'}`);
  return [
    { role: 'system', content: '너는 메모 초안을 쓰는 도우미다. 한국어 해요체로, 마크다운(제목은 ##, 목록은 -)으로 짧고 쓸모 있게 쓴다. 모르는 사실은 지어내지 말고 [ ] 빈칸으로 남긴다. 초안만 출력한다.' },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// 매직키로 저장한 메모 다듬기: 첫 줄이 이보다 길면 짧은 제목 줄을 맨 위에 (메모킹은 첫 줄이 목록의 제목)
export const TITLE_OVER = 30;
const TITLE = '너는 메모 제목을 짓는 도우미다. 메모 내용을 15자 안팎의 짧은 한국어 명사구 제목 하나로 쓴다. 제목만 출력한다. 따옴표, 마침표, #태그는 쓰지 않는다.';
export const titleMessages = (text) => [{ role: 'system', content: TITLE }, { role: 'user', content: text }];

/** 제목 답 → 제목 | '' (한 줄, 기호 없이, TITLE_OVER 자 이하, 한자 섞이면 버림) */
export function cleanTitle(out) {
  const t = String(out ?? '').trim().split('\n')[0].replace(/^#+\s*/, '').replace(/["'“”‘’]/g, '').replace(/[.。]+$/, '').trim();
  return t && t.length <= TITLE_OVER && !/\p{Script=Han}/u.test(t) ? t : '';
}

const KEEP = /#[\p{L}\p{N}_-]+|https?:\/\/\S+/gu; // 고친 글에도 그대로 있어야 하는 것

/** 맞춤법 답이 믿을 만한가 — 작은 모델은 글을 통째로 바꾸거나 한자를 섞거나 태그를 지우곤 한다 */
export function plausibleFix(before, after) {
  if (!after?.trim()) return false;
  if (/\p{Script=Han}/u.test(after) && !/\p{Script=Han}/u.test(before)) return false;
  const ratio = after.length / Math.max(1, before.length);
  if (ratio < 0.7 || ratio > 1.4) return false;
  return (before.match(KEEP) ?? []).every((k) => after.includes(k));
}

const tokens = (s) => s.match(/\s+|[^\s]+/g) ?? [];

/** 낱말(띄어쓰기 단위) 비교 → [{ type: 'same' | 'del' | 'ins', text }] */
export function wordDiff(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  // shortcut: LCS 표 O(n·m) — 문단 하나(수백 낱말)용. 아주 긴 글이면 줄 단위로 먼저 나눌 것
  const L = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  const push = (type, text) => (out.at(-1)?.type === type ? (out.at(-1).text += text) : out.push({ type, text }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      push('same', x[i]);
      i++;
      j++;
    } else if (i < x.length && (j === y.length || L[i + 1][j] >= L[i][j + 1])) push('del', x[i++]); // 지운 것을 먼저 (화면: ~~옛~~ 새)
    else push('ins', y[j++]);
  }
  return out;
}

/** 비교 결과 → 원래 글에 할 고침 [{ from, to, text }] (글자 위치, 앞에서부터) — 바뀌지 않은 글자의 서식은 그대로 남는다 */
export function diffEdits(ops) {
  const edits = [];
  let pos = 0;
  for (const op of ops) {
    if (op.type === 'same') {
      pos += op.text.length;
      continue;
    }
    let last = edits.at(-1);
    if (!last || last.to !== pos) edits.push((last = { from: pos, to: pos, text: '', old: '' }));
    if (op.type === 'del') {
      last.to = pos += op.text.length;
      last.old += op.text;
    } else last.text += op.text;
  }
  // 낱말 안에서도 바뀐 글자만 (됬어요. → 됐어요. 는 '됬' 만) — 옆 글자의 서식이 번지지 않게
  return edits.map(({ from, to, text, old }) => {
    let p = 0;
    while (p < old.length && p < text.length && old[p] === text[p]) p++;
    let s = 0;
    while (s < old.length - p && s < text.length - p && old.at(-1 - s) === text.at(-1 - s)) s++;
    return { from: from + p, to: to - s, text: text.slice(p, text.length - s) };
  });
}

/** 고침을 글에 적용 (테스트 · 확인용) */
export const applyEdits = (text, edits) => edits.reduceRight((s, e) => s.slice(0, e.from) + e.text + s.slice(e.to), text);
