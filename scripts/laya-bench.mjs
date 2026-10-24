#!/usr/bin/env node
// AI 태그(Laya) 시험 — 한국어 메모에 기존 태그를 얼마나 맞게 고르는지 · 얼마나 걸리는지.
//   node scripts/laya-bench.mjs <모델 폴더(encoder.onnx · head.onnx · tokenizer.json · rl_agent_config.json)> [--dump 질문.json]
//   onnxruntime-node 가 있어야 한다 (CI: .github/workflows/laya-model.yml). 질문은 앱과 같은 core/laya-tags.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagQuestion, rankedTags, pickTags } from '../app/js/core/laya-tags.js';
import { layaAgent, ortProvider } from '../app/js/core/laya-agent.js';

const [dir, flag, dumpTo] = process.argv.slice(2);
if (!dir) throw new Error('모델 폴더를 주세요');
const ort = await import('onnxruntime-node');
const here = path.dirname(fileURLToPath(import.meta.url));
const { vault, cases } = JSON.parse(fs.readFileSync(path.join(here, 'laya-bench', 'tags.json'), 'utf8'));
const memos = vault.map((m, i) => ({ id: `v${i}`, updated: `2026-10-${String(i + 1).padStart(2, '0')}`, body: `# ${m.title}\n\n${m.tags.map((t) => `#${t}`).join(' ')}\n` }));

const t0 = Date.now();
const [encoder, head] = await Promise.all(['encoder.onnx', 'head.onnx'].map((f) => ort.InferenceSession.create(path.join(dir, f))));
const agent = layaAgent({
  tokenizerJson: JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')),
  cfg: JSON.parse(fs.readFileSync(path.join(dir, 'rl_agent_config.json'), 'utf8')),
  provider: ortProvider(ort, encoder, head),
});
console.log(`불러오기 ${((Date.now() - t0) / 1000).toFixed(1)}초`);

const rows = [];
const dump = [];
for (const c of cases) {
  const q = tagQuestion(c.text, memos);
  const t = Date.now();
  const ranked = rankedTags(await agent.predict(q.state, q.questions));
  const ms = Date.now() - t;
  const picked = pickTags(ranked);
  dump.push({ state: q.state, questions: q.questions, gold: c.gold, js: ranked.slice(0, 3) });
  rows.push({ title: c.text.split('\n')[0], gold: c.gold, ranked, picked, ms });
}
// 첫째가 맞음 · 단 태그(pickTags) 중 맞은 비율(정밀도) · 정답 태그 중 단 비율(재현율) · 단 태그에 정답이 하나라도
const n = rows.length;
const top1 = rows.filter((r) => r.gold.includes(r.ranked[0]?.name)).length;
const hit = rows.filter((r) => r.picked.some((x) => r.gold.includes(x))).length;
const precision = rows.reduce((a, r) => a + r.picked.filter((x) => r.gold.includes(x)).length / Math.max(1, r.picked.length), 0) / n;
const recall = rows.reduce((a, r) => a + r.gold.filter((x) => r.picked.includes(x)).length / r.gold.length, 0) / n;
const avgPicked = rows.reduce((a, r) => a + r.picked.length, 0) / n;
for (const r of rows) console.log(`${r.gold.includes(r.ranked[0]?.name) ? '✓' : '✗'} ${r.title} → 단 것: ${r.picked.map((x) => (r.gold.includes(x) ? `#${x}✓` : `#${x}`)).join(' ')} · 확률: ${r.ranked.slice(0, 4).map((x) => `${x.name} ${x.p.toFixed(2)}`).join(', ')} · 정답: ${r.gold.join(', ')} · ${r.ms}ms`);
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const pct = (x) => `${Math.round(x * 100)}%`;
console.log(`\n첫째가 맞음 ${top1}/${n} · 단 태그에 정답 ${hit}/${n} · 단 태그 평균 ${avgPicked.toFixed(1)}개 · 정밀도 ${pct(precision)} · 재현율 ${pct(recall)} · 한 번에 가운데 ${ms[ms.length >> 1]}ms`);
if (flag === '--dump') fs.writeFileSync(dumpTo, JSON.stringify(dump));
