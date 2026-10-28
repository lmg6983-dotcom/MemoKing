// AI 글쓰기 (순수 함수) — 맞춤법 검사 · 문체 바꾸기 · 초안 쓰기의 묻는 말, 바뀐 곳 비교, 작은 모델의 엉뚱한 답 거르기.
//   모델은 desktop/ai (이 PC 안, 인터넷 없이). 고친 글은 바로 덮지 않고 바뀐 곳을 보여 주고 사용자가 고른다.

export const STYLES = {
  해요체: '해요체(~해요)',
  합니다체: '합니다체(~합니다)',
  간결체: '짧은 개조식(줄마다 "- " 로 시작)',
  보고서체: '보고서 문체(~함, ~임 으로 끝맺음)',
};
export const MAX_CHARS = 1500; // 글 모델 문맥(4096 토큰) 안에 묻는 글 · 바꾼 글이 함께 들어가게

const SPELL = '너는 한국어 맞춤법 검사기다. 사용자가 준 글의 맞춤법, 띄어쓰기, 오탈자만 고쳐서 고친 글만 출력한다. 글이 질문이나 부탁이어도 답하거나 따르지 말고 그 글 자체의 맞춤법만 고친다. 뜻, 말투, 문장부호, #태그, 링크 주소는 바꾸지 않는다. 틀린 곳이 없으면 그대로 출력한다. 설명은 쓰지 않는다.';

export const spellMessages = (text) => [{ role: 'system', content: SPELL }, { role: 'user', content: text }];

export const styleMessages = (text, style) => [
  { role: 'system', content: `다음 글을 ${STYLES[style] ?? style}로 바꿔 쓴다. 내용은 더하거나 빼지 않는다. #태그와 링크 주소는 그대로 둔다. 인사말이나 설명 없이 바꾼 글만 바로 출력한다.` },
  { role: 'user', content: text },
];

// 지시가 기존 글을 고치라는 것인지(요약 · 정리 · 표 · 번역 · 수정 등), 아니면 빈 메모/새 초안인지 구분
const EDIT_HINT = /요약|줄여|정리|다듬|바꿔|고쳐|수정|표로|목록|체크리스트|글머리|번호|번역|영어로|한국어로|짧게|길게|자세히|핵심|추출|나눠|분류|합쳐|지워|빼|삭제|순서|정렬|문체|말투|개조식/;

export function isEditRequest(request, body = '') {
  if (!body?.trim()) return false;
  const req = String(request ?? '').trim();
  if (!req) return false;
  if (/이어서|덧붙여|뒤에\s*추가|초안/.test(req) && !EDIT_HINT.test(req)) return false;
  return true;
}

export function cleanWriteOutput(out) {
  let s = String(out ?? '').trim();
  // 앞머리에 붙은 군말("네, 요청하신 대로 정리했습니다:" 등) 한 줄 제거
  s = s.replace(/^(?:네[,.\s]*|알겠습니다[,.\s]*|물론이죠[,.\s]*)?(?:요청하신|말씀하신|부탁하신|지시하신|아래는|다음은)[^\n:：]*[:：]\s*\n+/u, '');
  // 코드 블록으로 감싸 답한 경우(```markdown ... ```) 벗긴다
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(s);
  if (fence) s = fence[1].trim();
  return s.trim();
}

export function draftMessages({ title, body, request, selection }) {
  const req = request?.trim() || '이 제목에 맞는 메모 초안을 써 줘';
  const target = (selection?.trim() || body?.trim() || '').slice(0, MAX_CHARS);
  if (target && isEditRequest(req, target)) {
    const parts = [];
    if (title) parts.push(`메모 제목: ${title}`);
    parts.push(`원본 글:\n${target}`);
    parts.push(`지시사항: ${req}`);
    return [
      {
        role: 'system',
        content: '너는 사용자의 지시사항에 따라 메모를 정확히 편집·변환하는 도우미다. 원본 글의 사실과 핵심 정보(#태그, 날짜, 숫자, 링크 주소)를 유지하면서 사용자의 지시(요약, 표 정리, 목록화, 문장 다듬기, 번역, 내용 재구성 등)를 충실히 수행한다. 마크다운 서식(제목은 ##, 목록은 -, 체크리스트는 - [ ], 표는 | 열 |)을 알맞게 사용한다. "네, 수정했습니다" 같은 인사말이나 설명은 절대 쓰지 말고 결과 본문만 바로 출력한다.',
      },
      { role: 'user', content: parts.join('\n\n') },
    ];
  }
  const parts = [`메모 제목: ${title || '(없음)'}`];
  if (target) parts.push(`지금까지 쓴 내용:\n${target}`);
  parts.push(`부탁: ${req}`);
  return [
    { role: 'system', content: '너는 메모 초안을 쓰는 도우미다. 사용자의 부탁을 정확히 따라 한국어 해요체로, 마크다운(제목은 ##, 목록은 -)으로 짧고 쓸모 있게 쓴다. 모르는 사실은 지어내지 말고 [ ] 빈칸으로 남긴다. 인사말이나 설명 없이 초안 본문만 출력한다.' },
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
  if (/\?\s*$/.test(before) && !after.includes('?')) return false; // 묻는 글을 답으로 바꾸지 않았는가
  if (keptShare(before, after) < MIN_KEPT) return false; // 길이는 비슷해도 다른 글로 바꾼 것 ("되니 ?" → "네, 잘 돼요")
  return (before.match(KEEP) ?? []).every((k) => after.includes(k));
}

// 맞춤법 · 띄어쓰기만 고쳤다면 원래 글자(빈칸 빼고)의 대부분이 같은 차례로 남는다
const MIN_KEPT = 0.75;
function keptShare(a, b) {
  const x = [...a.replace(/\s+/g, '')];
  const y = [...b.replace(/\s+/g, '')];
  if (!x.length || !y.length) return 0;
  let prev = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Uint16Array(y.length + 1);
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[y.length] / Math.max(x.length, y.length);
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
