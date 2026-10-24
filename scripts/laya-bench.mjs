#!/usr/bin/env node
// AI 태그(Laya) 시험 — 한국어 메모에 기존 태그를 얼마나 맞게 고르는지 · 얼마나 걸리는지 (scripts/laya-bench/tags.json).
//   node scripts/laya-bench.mjs <모델 폴더(encoder.onnx · head.onnx · tokenizer.json · rl_agent_config.json)> [--dump 질문.json]
//   onnxruntime-node 가 있어야 한다 (CI: .github/workflows/laya-bench.yml). 질문은 앱과 같은 core/laya-tags.js
//   보기 수(limit)와 AI 없는 추천 점수를 섞는 몫(weight)을 바꿔 가며 견준다 — weight 1 은 AI 없이 추천 점수만
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagQuestion, rankedTags, blend, pickTags } from '../app/js/core/laya-tags.js';
import { layaAgent, ortProvider } from '../app/js/core/laya-agent.js';

const LIMITS = [20, 8, 5];
const WEIGHTS = [0, 0.3, 0.5, 0.7, 1];

const [dir, flag, dumpTo] = process.argv.slice(2);
if (!dir) throw new Error('모델 폴더를 주세요');
const ort = await import('onnxruntime-node');
const here = path.dirname(fileURLToPath(import.meta.url));
const { vault, cases } = JSON.parse(fs.readFileSync(path.join(here, 'laya-bench', 'tags.json'), 'utf8'));
const memos = vault.map((m, i) => ({ id: `v${i}`, updated: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, body: `# ${m.title}\n\n${m.body ?? ''}\n\n${m.tags.map((t) => `#${t}`).join(' ')}\n` }));

const t0 = Date.now();
const [encoder, head] = await Promise.all(['encoder.onnx', 'head.onnx'].map((f) => ort.InferenceSession.create(path.join(dir, f))));
const agent = layaAgent({
  tokenizerJson: JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')),
  cfg: JSON.parse(fs.readFileSync(path.join(dir, 'rl_agent_config.json'), 'utf8')),
  provider: ortProvider(ort, encoder, head),
});
console.log(`불러오기 ${((Date.now() - t0) / 1000).toFixed(1)}초 · 메모 폴더 ${memos.length}개 · 문제 ${cases.length}개\n`);

const pct = (x) => `${Math.round(x * 100)}%`;
const score = (rows) => {
  const n = rows.length;
  return {
    top1: rows.filter((r) => r.gold.includes(r.ranked[0]?.name)).length / n,
    hit3: rows.filter((r) => r.picked.some((x) => r.gold.includes(x))).length / n,
    precision: rows.reduce((a, r) => a + r.picked.filter((x) => r.gold.includes(x)).length / Math.max(1, r.picked.length), 0) / n,
    recall: rows.reduce((a, r) => a + r.gold.filter((x) => r.picked.includes(x)).length / r.gold.length, 0) / n,
  };
};

const dump = [];
const table = [];
for (const limit of LIMITS) {
  const answers = [];
  const times = [];
  for (const c of cases) {
    const q = tagQuestion(c.text, memos, { limit });
    const t = Date.now();
    const ranked = rankedTags(await agent.predict(q.state, q.questions));
    times.push(Date.now() - t);
    answers.push({ c, q, ranked });
    if (limit === LIMITS[0]) dump.push({ state: q.state, questions: q.questions, gold: c.gold, js: ranked.slice(0, 3) });
  }
  times.sort((a, b) => a - b);
  for (const weight of WEIGHTS) {
    const rows = answers.map(({ c, q, ranked }) => {
      const r = blend(ranked, q.scores, weight);
      return { title: c.text.split('\n')[0], gold: c.gold, ranked: r, picked: pickTags(r) };
    });
    table.push({ limit, weight, ms: times[times.length >> 1], rows, ...score(rows) });
  }
}

console.log('| 보기 수 | 섞는 몫 | 첫째가 맞음 | 셋 안에 정답 | 정밀도(셋) | 재현율(셋) | 한 번에 |');
console.log('|---|---|---|---|---|---|---|');
for (const t of table) console.log(`| ${t.limit} | ${t.weight === 1 ? '1 (AI 없이)' : t.weight} | ${pct(t.top1)} | ${pct(t.hit3)} | ${pct(t.precision)} | ${pct(t.recall)} | ${t.ms}ms |`);
const best = table.filter((t) => t.weight < 1).sort((a, b) => b.hit3 + b.top1 - (a.hit3 + a.top1))[0];
console.log(`\n가장 나은 것: 보기 ${best.limit}개 · 섞는 몫 ${best.weight}`);
for (const r of best.rows) console.log(`${r.gold.includes(r.ranked[0]?.name) ? '✓' : '✗'} ${r.title} → ${r.picked.map((x) => (r.gold.includes(x) ? `#${x}✓` : `#${x}`)).join(' ')} · 정답: ${r.gold.join(', ')}`);
if (flag === '--dump') fs.writeFileSync(dumpTo, JSON.stringify(dump));
