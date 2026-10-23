// AI 검색 (순수 함수) — 내 메모에서 찾아 출처를 단 답. 모델은 desktop/ai (이 PC 안, 인터넷 없이).
//   찾기는 셋을 섞는다: 낱말(TF-IDF, 지금 앱과 같은 토큰) · 뜻(검색 모델 벡터, 있으면) · 그래프(연결 · 관련도, index.json).
//   작은 모델은 지어내기 쉬워 찾기가 일을 대부분 하고, 모델은 고른 메모만 보고 짧게 답한다 (없으면 없다고).
import { tokenize, tfidfVectors, cosine as mapCosine } from './indexer.js';
import { plainLines, extractTitle } from './memo-file.js';

const CHUNK = 400; // 글자 — 한 조각이 문맥에 여럿 들어가게
const MAX_CHUNKS = 20; // 메모 하나에서
const CONTEXT = 1800; // 답할 때 모델에 주는 메모 글자 (4096 토큰 문맥에 질문 · 답과 함께)
const RRF_K = 60;

/** 메모 → 조각 글들 (줄을 모아 CHUNK 자 안팎, 첫 조각 앞에 제목) */
export function chunkMemo(body) {
  const title = extractTitle(body);
  const lines = plainLines(body).slice(1);
  const out = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length > CHUNK) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur || !out.length) out.push(cur);
  return out.slice(0, MAX_CHUNKS).map((text, i) => (i === 0 ? `${title}\n${text}`.trim() : text));
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

/**
 * 관련 메모 찾기
 * @param {string} query
 * @param {{ id: string, title: string, text: string, vec?: ArrayLike<number> }[]} chunks 모든 메모의 조각
 * @param {{ qvec?: ArrayLike<number>, related?: (id: string) => { id: string, score: number }[], limit?: number }} o
 * @returns {{ id: string, title: string, score: number, via: 'match' | 'graph', texts: string[] }[]}
 */
export function retrieve(query, chunks, { qvec, related = () => [], limit = 4 } = {}) {
  if (!chunks.length) return [];
  const rank = (scores) => scores.map((s, i) => [i, s]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const vecs = tfidfVectors([...chunks.map((c) => tokenize(c.text)), tokenize(query)]);
  const q = vecs.pop();
  const lists = [rank(vecs.map((v) => mapCosine(q, v)))];
  if (qvec) lists.push(rank(chunks.map((c) => (c.vec ? cosine(qvec, c.vec) : 0))));
  // 두 순위를 섞기 (RRF): 한쪽에서만 높아도 올라오고, 양쪽에서 높으면 더
  const fused = new Map();
  for (const list of lists) list.slice(0, 50).forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + r + 1)));
  const memos = new Map();
  for (const [i, score] of [...fused].sort((a, b) => b[1] - a[1])) {
    const c = chunks[i];
    const m = memos.get(c.id) ?? memos.set(c.id, { id: c.id, title: c.title, score, via: 'match', texts: [] }).get(c.id);
    if (m.texts.length < 2) m.texts.push(c.text);
  }
  const top = [...memos.values()].slice(0, limit);
  // 그래프: 찾은 메모와 연결 · 비슷한 메모 (찾기에서 놓친 것) — 앞 메모 점수의 절반 × 관련도
  const byId = new Map(chunks.map((c) => [c.id, c]));
  for (const m of top.slice(0, 2)) {
    for (const r of related(m.id).slice(0, 2)) {
      if (memos.has(r.id) || !byId.has(r.id)) continue;
      const c = byId.get(r.id);
      const g = { id: r.id, title: c.title, score: m.score * 0.5 * r.score, via: 'graph', texts: [c.text] };
      memos.set(r.id, g);
      top.push(g);
    }
  }
  return top.sort((a, b) => b.score - a.score).slice(0, limit + 1);
}

/** 답하기: 고른 메모만 근거로, 번호로 출처를 달게 */
export function ragMessages(question, picked) {
  let budget = CONTEXT;
  const parts = [];
  picked.forEach((m, i) => {
    const text = m.texts.join('\n').slice(0, Math.max(0, budget));
    budget -= text.length;
    if (text) parts.push(`[${i + 1}] ${m.title}\n${text}`);
  });
  return [
    { role: 'system', content: '너는 사용자의 메모에서 답을 찾는 도우미다. 아래 [번호] 메모에 적힌 것만 근거로 한국어 해요체로 짧게 답한다. 문장 끝에 근거 메모 번호를 [1] 처럼 붙인다. 메모에 답이 없으면 "메모에서 찾지 못했어요."라고만 답한다. 지어내지 않는다.' },
    { role: 'user', content: `메모:\n${parts.join('\n\n')}\n\n질문: ${question}` },
  ];
}
