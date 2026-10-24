// AI 로 태그 고르기 (순수 함수) — 메모 창 추천 태그 막대의 "AI로 고르기".
//   AI 없이 고른 추천(tag-suggest.js)과 많이 쓰는 기존 태그를 후보로 주고, 모델은 그중에서만 고른다 (JSON 모양 강제).
//   새 태그는 맞는 후보가 없을 때 하나만 — 그것도 기존 태그와 사실상 같은 말이면 기존 태그로 (태그가 흩어지지 않게).
import { suggestTagsFor, matchExisting } from './tag-suggest.js';
import { extractTags, isValidTag } from './tags.js';
import { plainLines } from './memo-file.js';

const keyOf = (name) => name.toLocaleLowerCase('ko');

/** → { messages, schema, existing: [{ name, count }] } */
export function aiTagRequest(body, memos, { excludeId } = {}) {
  const counts = new Map();
  for (const m of memos) {
    if (m.id === excludeId) continue;
    for (const t of extractTags(m.body)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const existing = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const fit = suggestTagsFor(body, memos, { limit: 8, excludeId }).filter((t) => t.existing).map((t) => t.name);
  const candidates = [...new Set([...fit, ...existing.slice(0, 40).map((t) => t.name)])];
  const schema = {
    type: 'object',
    properties: {
      tags: { type: 'array', items: candidates.length ? { type: 'string', enum: candidates } : { type: 'string' }, maxItems: 3 },
      new: { type: 'string', maxLength: 12 },
    },
    required: ['tags'],
  };
  const messages = [
    { role: 'system', content: '너는 메모에 태그를 다는 도우미다. 후보 태그 중 이 메모에 꼭 맞는 것만 0~3개 고른다. 맞는 후보가 없을 때만 new에 새 태그 하나(띄어쓰기 없는 짧은 명사)를 쓴다.' },
    { role: 'user', content: `후보: ${candidates.join(', ') || '(없음)'}\n\n메모:\n${plainLines(body).join('\n').slice(0, 1500)}` },
  ];
  return { messages, schema, existing };
}

/** 모델 답(JSON 글) → 추천 칩 목록 [{ name, existing, sure, why }] — 이미 단 태그 · 후보 밖 태그는 뺀다 */
export function aiTagResult(json, existing, body) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const known = new Map(existing.map((t) => [keyOf(t.name), t.name]));
  const taken = new Set(extractTags(body).map(keyOf));
  const out = [];
  const add = (name, why, isExisting) => {
    if (out.length >= 3 || taken.has(keyOf(name))) return;
    taken.add(keyOf(name));
    out.push({ name, existing: isExisting, sure: false, why });
  };
  for (const t of Array.isArray(data.tags) ? data.tags : []) if (known.has(keyOf(String(t)))) add(known.get(keyOf(String(t))), 'AI가 고른 태그', true);
  const fresh = String(data.new ?? '').replace(/^#/, '').trim();
  if (fresh && isValidTag(fresh)) {
    const same = matchExisting(fresh, existing);
    add(same?.name ?? fresh, same ? `"${fresh}" 대신 이미 쓰는 #${same.name}` : 'AI가 제안한 새 태그', Boolean(same));
  }
  return out;
}
