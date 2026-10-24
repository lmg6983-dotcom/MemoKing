#!/usr/bin/env node
// AI 글 도우미 시험 — 떠 있는 llama-server 에 앱과 같은 묻는 말(core/ai-write.js)로 정리 · 고치기 · 문체 · 맞춤법을 물어 답과 걸린 시간을 찍는다.
//   node scripts/kanana-bench.mjs http://127.0.0.1:8080 [이름]   (.github/workflows/kanana-gguf.yml)
import { readFileSync } from 'node:fs';
import { runWrite } from '../app/js/core/ai-write.js';
import { llamaClient } from '../app/js/core/llama-client.js';

const [base = 'http://127.0.0.1:8080', name = ''] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(new URL('./kanana-bench/cases.json', import.meta.url)));
const { chat } = llamaClient(async (_role, route, body) => (await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());

let total = 0;
for (const c of cases) {
  const started = Date.now();
  const r = await runWrite((m, o) => chat(m, { ...o, temperature: 0 }), c);
  const s = (Date.now() - started) / 1000;
  total += s;
  console.log(`\n===== ${name} ${c.task}${c.instruction ? ` "${c.instruction}"` : c.style ? ` ${c.style}` : ''} (${s.toFixed(1)}초)`);
  console.log(`> ${c.text ?? c.blocks.join(' / ')}`);
  console.log(r.text ?? r.fixed.join('\n'));
}
console.log(`\n${name} 합계 ${total.toFixed(1)}초`);
