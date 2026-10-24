// AI 로 태그 고르기 (순수 함수) — 메모 창 추천 태그 막대의 "AI로 고르기" · 메모를 닫을 때 다는 AI 태그.
//   모델이 메모 내용에서 태그를 짓는다 (0.70.0 — 예전엔 많이 쓰는 기존 태그 40개 중에서만 고르게 해서, 작은 모델이
//   인사 한 줄에도 #공유 · #ETRI 같은 흔한 태그를 골랐다). 기존 태그는 두 군데서만 쓴다:
//   · 지은 태그가 기존 태그와 사실상 같은 말이면 그 이름으로 (태그가 흩어지지 않게 — matchExisting)
//   · 근거 있는 기존 태그(본문에 나오거나 닮은 메모들이 단 것 — suggestTagsFor)는 "이 이름을 쓰라"고 알려 준다
//   본문에 근거가 없는 기존 태그는 모델이 골라도 버린다. 주제가 없으면 0개 (억지로 채우지 않는다)
import { suggestTagsFor, matchExisting, mentionsTag } from './tag-suggest.js';
import { extractTags, isValidTag } from './tags.js';
import { plainLines } from './memo-file.js';

const keyOf = (name) => name.toLocaleLowerCase('ko');
export const MIN_AI_TEXT = 20; // 이보다 짧은 메모(인사 · 한 줄 대답)에는 저절로 달지 않는다 (글자 수, 빈칸 빼고)
const VAGUE = new Set(['메모', '기타', '일반', '내용', '정리', '확인', '공지', '참고', '질문', '답변', '대화', '인사']);

/** → { messages, schema, existing: [{ name, count }], grounded: Set<key> } */
export function aiTagRequest(body, memos, { excludeId } = {}) {
  const counts = new Map();
  for (const m of memos) {
    if (m.id === excludeId) continue;
    for (const t of extractTags(m.body)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const existing = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const fit = suggestTagsFor(body, memos, { limit: 6, excludeId }).filter((t) => t.existing).map((t) => t.name);
  const schema = {
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string', maxLength: 12 }, maxItems: 3 } },
    required: ['tags'],
  };
  const messages = [
    { role: 'system', content: '너는 메모에 태그를 다는 도우미다. 메모 내용의 주제를 나타내는 태그를 0~3개 짓는다. 태그는 띄어쓰기 없는 짧은 한국어 명사(2~8자)다. 메모에 실제로 나오는 주제만 쓰고, 인사나 짧은 대답처럼 주제가 없으면 빈 배열로 둔다. 아래 "이미 쓰는 태그"와 뜻이 같으면 그 이름을 그대로 쓴다.' },
    { role: 'user', content: `이미 쓰는 태그: ${fit.join(', ') || '(없음)'}\n\n메모:\n${plainLines(body).join('\n').slice(0, 1500)}` },
  ];
  return { messages, schema, existing, grounded: new Set(fit.map(keyOf)) };
}

/**
 * 모델 답(JSON 글) → 추천 칩 목록 [{ name, existing, sure, why }]
 *   이미 단 태그 · 뜻이 넓은 말은 빼고, 기존 태그와 같은 말이면 그 이름으로 — 단 그 기존 태그에 본문 근거가 없으면 버린다
 */
export function aiTagResult(json, existing, body, grounded = new Set()) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const taken = new Set(extractTags(body).map(keyOf));
  const out = [];
  for (const raw of Array.isArray(data.tags) ? data.tags : []) {
    if (out.length >= 3) break;
    const name = String(raw ?? '').replace(/^#/, '').replace(/\s+/g, '').trim();
    if (!isValidTag(name) || name.length < 2 || VAGUE.has(name)) continue;
    const same = matchExisting(name, existing);
    // 기존 태그로 맞출 때는 근거가 있어야 (닮은 메모 근거 · 본문에 그 태그나 같은 뜻 말) — 없으면 모델이 흔한 태그를 고른 것
    if (same && !grounded.has(keyOf(same.name)) && !mentionsTag(same.name, body) && !mentionsTag(name, body)) continue;
    const pick = same?.name ?? name;
    if (taken.has(keyOf(pick))) continue;
    taken.add(keyOf(pick));
    out.push({ name: pick, existing: Boolean(same), sure: false, why: same && keyOf(same.name) !== keyOf(name) ? `"${name}" 대신 이미 쓰는 #${same.name}` : same ? 'AI가 고른 기존 태그' : 'AI가 내용에서 지은 태그' });
  }
  return out;
}
