// AI 태그 (순수 함수) — Laya 다국어 모델(글을 쓰지 않고 보기 중 하나를 고르는 모델)이 이 폴더의 기존 태그 중에서 고른다.
//   PC(desktop/ai/laya-service.js) · 휴대폰(android/web/js/local-ai.js) · 시험(scripts/laya-bench.mjs)이 같은 질문으로 묻는다.
//   후보: AI 없이 고른 추천(tag-suggest.js) + 많이 쓰는 기존 태그. 보기는 태그 이름만 — 설명(그 태그를 단 메모 제목)을 붙이면
//   한국어 시험(scripts/laya-bench)에서 오히려 덜 맞았다 (24개 중 6개 → 이름만 11개)
import { suggestTagsFor, MIN_TEXT } from './tag-suggest.js';
import { extractTags } from './tags.js';
import { plainLines } from './memo-file.js';

const MAX_CANDIDATES = 20; // Laya 가 시험한 보기 수 (20개)
const MAX_TEXT = 1500; // 글자 — 앞부분이면 태그를 고르기에 충분하다

const keyOf = (name) => name.toLocaleLowerCase('ko');

/** → { state, questions, candidates } | null (너무 짧거나 · 기존 태그가 없거나 · 이미 다 달린 메모) */
export function tagQuestion(body, memos, { excludeId } = {}) {
  const state = plainLines(body).join('\n').slice(0, MAX_TEXT);
  if (state.replace(/\s/g, '').length < MIN_TEXT) return null;
  const taken = new Set(extractTags(body).map(keyOf));
  const uses = new Map(); // 태그 → 단 메모 수
  for (const m of memos) {
    if (m.id === excludeId) continue;
    for (const t of extractTags(m.body)) uses.set(t, (uses.get(t) ?? 0) + 1);
  }
  const byUse = [...uses.keys()].sort((a, b) => uses.get(b) - uses.get(a));
  const fit = suggestTagsFor(body, memos, { limit: 8, excludeId }).filter((t) => t.existing).map((t) => t.name);
  const candidates = [...new Set([...fit, ...byUse])].filter((t) => !taken.has(keyOf(t))).slice(0, MAX_CANDIDATES);
  if (!candidates.length) return null;
  return {
    state,
    questions: { tag: { type: 'choice', instructions: '이 메모에 가장 알맞은 태그는?', criteria: candidates } },
    candidates,
  };
}

/** Laya 답 → 태그를 확률 높은 순으로 [{ name, p }] */
export function rankedTags(result) {
  const probs = result?.answers?.tag?.probabilities ?? {};
  return Object.entries(probs).map(([name, p]) => ({ name, p })).sort((a, b) => b.p - a.p);
}

/** 추천 칩(tag-suggest.js) 순서를 Laya 확률로 — Laya 가 첫째로 고른 기존 태그가 없으면 맨 앞에 넣는다. 새 태그 추천은 뒤로 */
export function withLaya(list, ranked, limit = 3) {
  if (!ranked.length) return list;
  const p = new Map(ranked.map((r) => [r.name, r.p]));
  const top = ranked[0].name;
  const all = list.some((t) => t.name === top) ? [...list] : [{ name: top, existing: true, sure: false, why: 'AI 가 고른 태그' }, ...list];
  return all.sort((a, b) => (p.get(b.name) ?? -1) - (p.get(a.name) ?? -1)).slice(0, limit);
}
