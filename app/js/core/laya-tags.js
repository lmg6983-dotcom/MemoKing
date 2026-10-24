// AI 태그 (순수 함수) — Laya 다국어 모델(글을 쓰지 않고 보기 중 하나를 고르는 모델)이 이 폴더의 기존 태그 중에서 고른다.
//   PC(desktop/ai/laya-service.js) · 휴대폰(android/web/js/local-ai.js) · 시험(scripts/laya-bench.mjs)이 같은 질문으로 묻는다.
//   후보: AI 없이 고른 추천(tag-suggest.js) + 많이 쓰는 기존 태그. 후보마다 "이 태그가 어울리나?" 를 따로 묻는다(noul — 예일 확률),
//   한 번에 묶어서. 보기 중 하나를 고르게(choice) 하면 엉뚱한 보기로 튀는 일이 잦았다 (scripts/laya-bench)
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
    questions: Object.fromEntries(candidates.map((t) => [t, { type: 'noul', instructions: `이 메모에 #${t} 태그가 어울리나요?` }])),
    candidates,
  };
}

/** Laya 답 → 태그를 어울릴 확률 높은 순으로 [{ name, p }] */
export function rankedTags(result) {
  return Object.entries(result?.answers ?? {}).map(([name, a]) => ({ name, p: a?.noul ?? 0 })).sort((a, b) => b.p - a.p);
}

/** 닫을 때 저절로 달 태그: 위에서 셋, 그 밖에도 꽤 어울리면(절반 넘게) 더 */
export const pickTags = (ranked) => ranked.filter((r, i) => i < 3 || r.p >= 0.5).map((r) => r.name);

/** 추천 칩(tag-suggest.js) 순서를 Laya 확률로 — Laya 가 첫째로 고른 기존 태그가 없으면 맨 앞에 넣는다. 새 태그 추천은 뒤로 */
export function withLaya(list, ranked, limit = 3) {
  if (!ranked.length) return list;
  const p = new Map(ranked.map((r) => [r.name, r.p]));
  const top = ranked[0].name;
  const all = list.some((t) => t.name === top) ? [...list] : [{ name: top, existing: true, sure: false, why: 'AI 가 고른 태그' }, ...list];
  return all.sort((a, b) => (p.get(b.name) ?? -1) - (p.get(a.name) ?? -1)).slice(0, limit);
}
