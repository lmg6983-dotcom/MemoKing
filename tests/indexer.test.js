import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, tfidfVectors, tokenize, cosine } from '../app/js/core/indexer.js';
import { extractTitle, plainLines } from '../app/js/core/memo-file.js';

// 예전 방식(모든 메모 쌍을 cosine) 그대로 — 빠르게 바꾼 buildIndex 의 related 와 같아야 한다
function bruteRelated(memos) {
  const sorted = [...memos].sort((a, b) => a.file.localeCompare(b.file, 'ko'));
  const vectors = tfidfVectors(sorted.map((m) => tokenize(`${extractTitle(m.body)} ${extractTitle(m.body)} ${plainLines(m.body).join(' ')}`)));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return sorted.map((m, i) => {
    const out = m.meta.links.filter((id) => id !== m.id);
    const back = sorted.filter((o) => o.meta.links.includes(m.id) && o.id !== m.id).map((o) => o.id);
    const rel = [];
    sorted.forEach((o, j) => {
      if (i === j) return;
      const sim = cosine(vectors[i], vectors[j]);
      const reasons = [];
      let score = 0;
      if (out.includes(o.id)) { reasons.push('link'); score += 0.6; }
      if (back.includes(o.id)) { reasons.push('backlink'); score += 0.4; }
      if (sim >= 0.08) { reasons.push('similar'); score += sim; }
      if (reasons.length) rel.push({ id: o.id, score: r3(Math.min(1, score)), similarity: r3(sim), reasons });
    });
    rel.sort((a, b) => b.score - a.score || sorted.findIndex((x) => x.id === a.id) - sorted.findIndex((x) => x.id === b.id));
    return rel.slice(0, 8);
  });
}

test('색인 related: 같은 낱말이 있는 메모끼리만 더해도 예전(모든 쌍 cosine)과 같은 결과 · 순서', () => {
  const words = '회의 견적 보고서 일정 고객 예산 출장 디자인 개발 배포 사과 바나나 여행 제주 부산'.split(' ');
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const memos = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`, file: `메모${String(i).padStart(2, '0')}.md`,
    meta: { links: i % 7 === 0 ? [`m${(i + 3) % 40}`] : [] },
    body: `# ${words[i % words.length]} ${i}\n\n${Array.from({ length: 12 }, () => words[Math.floor(rand() * words.length)]).join(' ')}`,
  }));
  const index = buildIndex(memos, { now: 'x' });
  const want = bruteRelated(memos);
  index.memos.forEach((m, i) => {
    assert.deepEqual(m.related.map(({ id, score, similarity, reasons }) => ({ id, score, similarity, reasons })), want[i], m.file);
  });
});
