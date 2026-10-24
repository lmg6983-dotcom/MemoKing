// AI 태그 (순수 함수) — Laya 다국어 모델(글을 쓰지 않고 보기 중 하나를 고르는 모델)이 이 폴더의 기존 태그 중에서 고른다.
//   PC(desktop/ai/laya-service.js) · 휴대폰(android/web/js/local-ai.js) · 시험(scripts/laya-bench.mjs)이 같은 질문으로 묻는다.
//   후보: AI 없이 고른 추천(tag-suggest.js) + 많이 쓰는 기존 태그를 보기로 주고 하나를 고르게(choice) 해서 그 확률 순으로.
//   태그마다 "어울리나?" 를 따로 물으면(noul) 확률을 태그끼리 견줄 수 없어 더 틀리고 열 배 느렸다 (scripts/laya-bench)
import { suggestTagsFor, MIN_TEXT } from './tag-suggest.js';
import { extractTags } from './tags.js';
import { plainLines } from './memo-file.js';

const MAX_CANDIDATES = 20; // Laya 가 시험한 보기 수 (20개)
const MAX_TEXT = 1500; // 글자 — 앞부분이면 태그를 고르기에 충분하다

const keyOf = (name) => name.toLocaleLowerCase('ko');

/** → { state, questions, candidates, scores } | null (너무 짧거나 · 기존 태그가 없거나 · 이미 다 달린 메모)
 *    limit: 보기 수 · scores: 태그 → AI 없는 추천 점수(0~1, 없으면 0) */
export function tagQuestion(body, memos, { excludeId, limit = MAX_CANDIDATES } = {}) {
  const state = plainLines(body).join('\n').slice(0, MAX_TEXT);
  if (state.replace(/\s/g, '').length < MIN_TEXT) return null;
  const taken = new Set(extractTags(body).map(keyOf));
  const uses = new Map(); // 태그 → 단 메모 수
  for (const m of memos) {
    if (m.id === excludeId) continue;
    for (const t of extractTags(m.body)) uses.set(t, (uses.get(t) ?? 0) + 1);
  }
  const byUse = [...uses.keys()].sort((a, b) => uses.get(b) - uses.get(a));
  const fit = suggestTagsFor(body, memos, { limit: 8, excludeId }).filter((t) => t.existing);
  const scores = new Map(fit.map((t) => [t.name, t.score]));
  const candidates = [...new Set([...fit.map((t) => t.name), ...byUse])].filter((t) => !taken.has(keyOf(t))).slice(0, limit);
  if (!candidates.length) return null;
  return {
    state,
    questions: { tag: { type: 'choice', instructions: '이 메모에 가장 알맞은 태그는?', criteria: candidates } },
    candidates,
    scores,
  };
}

/** Laya 답 → 태그를 확률 높은 순으로 [{ name, p }] */
export function rankedTags(result) {
  const probs = result?.answers?.tag?.probabilities ?? {};
  return Object.entries(probs).map(([name, p]) => ({ name, p })).sort((a, b) => b.p - a.p);
}

/** 앱이 섞는 몫 — 시험(문제 99개)에서 0.5 가 가장 나았다: 셋 안에 정답 Laya 만 70% · AI 없이 77% · 섞어서 80% */
export const BLEND = 0.5;

/** Laya 확률과 AI 없는 추천 점수를 섞어 다시 줄 세우기 — weight: 추천 점수 쪽 몫 (0 이면 Laya 만) */
export function blend(ranked, scores, weight) {
  if (!weight) return ranked;
  return ranked.map((r) => ({ name: r.name, p: (1 - weight) * r.p + weight * (scores.get(r.name) ?? 0) })).sort((a, b) => b.p - a.p);
}

/** 닫을 때 저절로 달 태그: 확률 높은 셋 (첫째만 달 때보다 정답이 들어갈 때가 훨씬 많다) */
export const pickTags = (ranked) => ranked.slice(0, 3).map((r) => r.name);

/** 추천 칩(tag-suggest.js) 순서를 Laya 확률로 — Laya 가 첫째로 고른 기존 태그가 없으면 맨 앞에 넣는다. 새 태그 추천은 뒤로 */
export function withLaya(list, ranked, limit = 3) {
  if (!ranked.length) return list;
  const p = new Map(ranked.map((r) => [r.name, r.p]));
  const top = ranked[0].name;
  const all = list.some((t) => t.name === top) ? [...list] : [{ name: top, existing: true, sure: false, why: 'AI 가 고른 태그' }, ...list];
  return all.sort((a, b) => (p.get(b.name) ?? -1) - (p.get(a.name) ?? -1)).slice(0, limit);
}
