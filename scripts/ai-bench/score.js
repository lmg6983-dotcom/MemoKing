// 0단계 로컬 LLM 비교 — 채점용 순수 함수 (tests/ai-bench.test.js)
import { findTags } from '../../app/js/core/tags.js';

const noSpace = (s) => String(s ?? '').replace(/\s+/g, '');

/** 맞춤법: 띄어쓰기 차이는 빼고 정답과 같은지 (띄어쓰기는 정답이 여럿일 수 있어서) */
export const spellOk = (out, fixed) => noSpace(out) === noSpace(fixed);

/** 한국어 답에 한자(중국어)가 섞였는지 — Qwen 계열에서 커뮤니티가 자주 지적 */
export const hasHan = (s) => /\p{Script=Han}/u.test(s);

/** Qwen3 등이 남기는 생각 블록을 떼어 낸다 */
export const stripThink = (s) => String(s ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

const ENDINGS = { 해요체: /요[.!?]?$/, 합니다체: /(니다|니까)[.!?]?$/ };

/** 문체: 문장 끝이 그 문체 어미인 비율 (해요체 · 합니다체만, 나머지는 null — 사람이 봄) */
export function endingRate(text, style) {
  const re = ENDINGS[style];
  if (!re) return null;
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  return sentences.length ? sentences.filter((s) => re.test(s)).length / sentences.length : 0;
}

/** 본문에서 #태그 를 지운다 (모델이 답을 보지 못하게) */
export function stripTags(body) {
  return String(body).split('\n').map((line) => {
    let out = line;
    for (const t of findTags(line).reverse()) out = out.slice(0, t.index) + out.slice(t.index + t.length);
    return out;
  }).join('\n');
}

/** 정답 순위(1부터, 못 찾으면 0) 목록 → recall@k, MRR */
export function rankScores(ranks, k = 5) {
  const n = ranks.length || 1;
  return {
    recall: ranks.filter((r) => r > 0 && r <= k).length / n,
    mrr: ranks.reduce((sum, r) => sum + (r > 0 ? 1 / r : 0), 0) / n,
  };
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

/** 고른 태그 vs 실제 태그 → { hit: 하나라도 맞힘, precision } */
export function tagScore(picked, actual) {
  const gold = new Set(actual.map((t) => t.toLocaleLowerCase('ko')));
  const right = picked.filter((t) => gold.has(t.toLocaleLowerCase('ko'))).length;
  return { hit: right > 0, precision: picked.length ? right / picked.length : 0 };
}
