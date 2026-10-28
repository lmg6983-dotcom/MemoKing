// AI 글 도우미 (순수 함수, PC 에만) — 정리 · 지시대로 고치기 · 문체 · 맞춤법 · 초안의 묻는 말, 바뀐 곳 비교, 작은 모델의 엉뚱한 답 거르기.
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

// 작은 모델(1~3B)은 규칙만 주면 지시를 되풀이하거나 줄만 바꾼다 — 짧은 보기 하나(묻고 답한 한 쌍)를 앞에 두면 따라 한다
const TIDY = '너는 메모 정리 도우미다. 서식 없이 대충 적은 메모를 마크다운으로 정리한다. 주제마다 ## 제목, 나열은 - 목록, 해야 할 일은 - [ ] , 여러 항목을 같은 기준으로 견주면 표로. 내용은 더하거나 빼지 않고 숫자, 날짜, 이름, #태그, 링크 주소는 그대로 둔다. 맺음말이나 설명 없이 정리한 글만 쓴다.';
const TIDY_EXAMPLE = [
  '주간회의 월요일 10시 참석 민수 지영 다음주까지 견적서 보내기 서버비 A사 월 30만 B사 월 25만 비교',
  '## 주간 회의\n- 월요일 10시\n- 참석: 민수, 지영\n\n## 할 일\n- [ ] 다음 주까지 견적서 보내기\n\n## 서버비 비교\n| 회사 | 월 비용 |\n|---|---|\n| A사 | 30만 |\n| B사 | 25만 |',
];

export const tidyMessages = (text) => [
  { role: 'system', content: TIDY },
  { role: 'user', content: TIDY_EXAMPLE[0] },
  { role: 'assistant', content: TIDY_EXAMPLE[1] },
  { role: 'user', content: text },
];

const ask = (instruction, text) => `지시: ${instruction}\n\n글:\n${text}`;

/** 지시대로 고치기 ("더 공손하게", "세 줄로 줄여 줘" …) — 문체 단추도 같은 길 */
export const customMessages = (text, instruction) => [
  { role: 'system', content: '너는 글을 고쳐 쓰는 도우미다. 사용자가 준 지시대로 글을 고쳐 쓴다. 지시하지 않은 내용은 지어내지 않고 #태그와 링크 주소는 그대로 둔다. 지시문을 되풀이하지 말고 고친 글만 쓴다.' },
  { role: 'user', content: ask('더 짧게', '오늘 회의에서는 다음 달 출시 일정에 대해 이야기를 나누었고, 참석한 사람 모두 그 일정에 동의했습니다.') },
  { role: 'assistant', content: '회의에서 다음 달 출시 일정에 모두 동의했습니다.' },
  { role: 'user', content: ask(instruction, text) },
];

export const styleMessages = (text, style) => customMessages(text, `${STYLES[style] ?? style}로 바꿔 써 줘. 내용은 그대로`);

/** 모델이 묻는 말을 되풀이한 머리("지시: …", "글:", 지시문 그대로)를 뗀다 */
export function cleanReply(out, instruction = '') {
  const lines = String(out ?? '').split('\n');
  const echo = (l) => /^(지시:|글:|\s*$)/.test(l) || (instruction && l.trim() === instruction.trim());
  while (lines.length > 1 && echo(lines[0])) lines.shift();
  return lines.join('\n').trim();
}

export function draftMessages({ title, body, request }) {
  const parts = [`메모 제목: ${title || '(없음)'}`];
  if (body?.trim()) parts.push(`지금까지 쓴 내용:\n${body.trim().slice(0, MAX_CHARS)}`);
  parts.push(`부탁: ${request?.trim() || '이 제목에 맞는 메모 초안을 써 줘'}`);
  return [
    { role: 'system', content: '너는 메모 초안을 쓰는 도우미다. 한국어 해요체로, 마크다운(제목은 ##, 목록은 -)으로 짧고 쓸모 있게 쓴다. 모르는 사실은 지어내지 말고 [ ] 빈칸으로 남긴다. 초안만 출력한다.' },
    { role: 'user', content: parts.join('\n\n') },
  ];
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

/**
 * 글 도우미 작업 하나 (desktop/ipc-handlers.js llm:write) — chat: (messages, o) => Promise<string>
 *   spell → { fixed: [] } (믿을 만한 답만, 아니면 원래 글) · tidy · custom · style · draft → { text }
 */
export async function runWrite(chat, { task, text = '', blocks = [], style, instruction, title, request }, { signal, onToken, onProgress } = {}) {
  if (task === 'spell') {
    const fixed = [];
    for (const [i, block] of blocks.entries()) {
      onProgress?.(i, blocks.length);
      const out = await chat(spellMessages(block), { temperature: 0, maxTokens: block.length * 2 + 32, signal });
      fixed.push(plausibleFix(block, out) ? out : block);
    }
    return { fixed };
  }
  const messages = task === 'tidy' ? tidyMessages(text)
    : task === 'custom' ? customMessages(text, instruction)
      : task === 'style' ? styleMessages(text, style)
        : draftMessages({ title, body: text, request });
  return { text: cleanReply(await chat(messages, { maxTokens: 1536, signal, onToken }), instruction) };
}
