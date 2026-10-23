#!/usr/bin/env node
// 0단계: 로컬 LLM · 임베딩 모델 비교 (이 PC 에서, 인터넷 없이)
//   llama.cpp 의 llama-server 를 모델마다 띄워 같은 한국어 과제를 풀리고 결과표(마크다운)를 쓴다.
//   node scripts/ai-bench.mjs --server C:\llama\llama-server.exe --vault "G:\내 드라이브\메모킹" \
//     --model kanana-1.5-2.1b.gguf --model qwen3-4b.gguf --embed kure-v1.gguf --embed qwen3-emb-0.6b.gguf \
//     [--queries 질문.json] [--out ai-bench-결과.md] [-- llama-server 에 더 줄 인자]
//   질문.json: [{ "q": "지난달 회의에서 정한 출시일", "file": "주간 회의.md" }] — 없으면 메모 제목으로 본문 찾기
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemoFile, extractTitle, plainLines, UNTITLED } from '../app/js/core/memo-file.js';
import { extractTags, collectTags } from '../app/js/core/tags.js';
import { isLockedBody } from '../app/js/core/memo-lock.js';
import { suggestTagsFor } from '../app/js/core/tag-suggest.js';
import { tokenize, tfidfVectors, cosine as mapCosine } from '../app/js/core/indexer.js';
import { spellOk, hasHan, stripThink, endingRate, stripTags, rankScores, cosine, tagScore } from './ai-bench/score.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-bench');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const serverExtra = dash >= 0 ? argv.slice(dash + 1) : [];
const opts = { model: [], embed: [] };
for (let i = 0; i < (dash >= 0 ? dash : argv.length); i += 2) {
  const key = argv[i].replace(/^--/, '');
  if (Array.isArray(opts[key])) opts[key].push(argv[i + 1]);
  else opts[key] = argv[i + 1];
}
if (!opts.server || !opts.vault || (!opts.model.length && !opts.embed.length)) {
  console.error('사용법: node scripts/ai-bench.mjs --server <llama-server> --vault <메모 폴더> --model <gguf>… [--embed <gguf>…] [--queries <json>] [--out <md>]');
  process.exit(1);
}
const PORT = Number(opts.port ?? 8079);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = opts.out ?? 'ai-bench-결과.md';

// ---------- llama-server ----------

async function startServer(model, args) {
  const started = Date.now();
  const proc = spawn(opts.server, ['-m', model, '--port', String(PORT), '-c', '4096', ...args, ...serverExtra], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const log = [];
  let memMiB = 0;
  proc.stderr.setEncoding('utf8').on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      // 모델 · KV 캐시 · 계산 버퍼 크기의 합 = 대략 쓰는 메모리 (CPU + GPU)
      const m = /buffer size\s*=\s*([\d.]+) MiB/.exec(line);
      if (m) memMiB += Number(m[1]);
      log.push(line);
      if (log.length > 40) log.shift();
    }
  });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  while (Date.now() - started < 300_000) {
    if (exited) throw new Error(`llama-server 가 꺼졌어요:\n${log.join('\n')}`);
    const ok = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
    if (ok) return { proc, loadSec: (Date.now() - started) / 1000, mem: () => Math.round(memMiB) };
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error(`5분 안에 모델을 못 올렸어요:\n${log.join('\n')}`);
}

async function stopServer(server) {
  if (server.proc.exitCode !== null || server.proc.signalCode) return; // 도중에 꺼졌으면 기다릴 것 없음
  const done = new Promise((r) => server.proc.once('exit', r));
  server.proc.kill();
  await done;
}

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${route} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function chat(system, user, { maxTokens = 512, schema } = {}) {
  const started = Date.now();
  const data = await post('/v1/chat/completions', {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false }, // Qwen3 · Qwen3.5 생각 모드 끄기 (다른 모델은 무시)
    ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'out', schema } } } : {}),
  });
  return { text: stripThink(data.choices[0].message.content), tps: data.timings?.predicted_per_second ?? 0, ms: Date.now() - started };
}

// ---------- 메모 폴더 ----------

function readVault(root) {
  const memos = [];
  const walk = (dir, rel) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = item.name;
      if (name.startsWith('.') || name.startsWith('~$') || (!rel && (name === '_memoking' || name === 'attachments'))) continue;
      const file = rel ? `${rel}/${name}` : name;
      if (item.isDirectory()) walk(path.join(dir, name), file);
      else if (name.toLowerCase().endsWith('.md')) {
        const { meta, body } = parseMemoFile(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (isLockedBody(body)) continue; // 잠금 메모는 AI 에 보이지 않는다 (앱과 같은 규칙)
        memos.push({ id: meta.id ?? file, file, updated: meta.updated ?? '', body, title: extractTitle(body), tags: extractTags(body) });
      }
    }
  };
  walk(root, '');
  return memos;
}

// ---------- 과제 ----------

const SPELL_SYSTEM = '너는 한국어 맞춤법 검사기다. 사용자가 준 글의 맞춤법, 띄어쓰기, 오탈자만 고쳐서 고친 글만 출력한다. 뜻, 말투, 문장부호는 바꾸지 않는다. 틀린 곳이 없으면 그대로 출력한다. 설명은 쓰지 않는다.';
const STYLE_HINT = { 해요체: '해요체(~해요)', 합니다체: '합니다체(~합니다)', 간결체: '짧은 개조식(줄마다 "- " 로 시작)', 보고서체: '보고서 문체(~함, ~임 으로 끝맺음)' };
const TAG_SYSTEM = '너는 메모에 태그를 다는 도우미다. 메모 내용에 가장 어울리는 태그를 후보 중에서 1~3개 고른다.';

async function runChatModel(model, typos, styles, tagCases, candidates) {
  const server = await startServer(model, []);
  try {
    const r = { model: path.basename(model), loadSec: server.loadSec, mem: server.mem(), tps: [], han: 0, spell: [], style: [], tags: [] };
    const record = (out) => {
      r.tps.push(out.tps);
      if (hasHan(out.text)) r.han++;
      return out;
    };
    for (const [i, t] of typos.entries()) {
      const out = record(await chat(SPELL_SYSTEM, t.text, { maxTokens: 200 }));
      if (i === 0) r.firstMs = out.ms; // Qwen3.5 는 처음 요청이 아주 느리다는 보고가 있어 따로 잰다
      r.spell.push({ ...t, out: out.text, ok: spellOk(out.text, t.fixed) });
    }
    for (const s of styles) {
      const out = record(await chat(`다음 글을 ${STYLE_HINT[s.style]}로 바꿔 쓴다. 내용은 더하거나 빼지 않는다. 바꾼 글만 출력한다.`, s.text));
      r.style.push({ ...s, out: out.text, rate: endingRate(out.text, s.style) });
    }
    const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', enum: candidates }, minItems: 1, maxItems: 3 } }, required: ['tags'] };
    for (const c of tagCases) {
      const out = record(await chat(TAG_SYSTEM, `후보: ${candidates.join(', ')}\n\n메모:\n${c.text}`, { maxTokens: 80, schema }));
      let picked = [];
      try { picked = JSON.parse(out.text).tags ?? []; } catch { /* 깨진 JSON = 못 고름 */ }
      r.tags.push({ title: c.title, actual: c.actual, picked, ...tagScore(picked, c.actual) });
    }
    return r;
  } finally {
    await stopServer(server);
  }
}

async function runEmbedModel(model, docs, queries) {
  const server = await startServer(model, ['--embedding', '-b', '4096', '-ub', '4096']); // 긴 메모 한 개를 한 번에 (기본 512 토큰이면 거절)
  try {
    // shortcut: Qwen3-Embedding 은 질문 앞에 지시문을 붙여야 제 성능 — 파일 이름으로만 가린다
    const prefix = /qwen/i.test(model) ? 'Instruct: Given a search query, retrieve relevant notes\nQuery: ' : '';
    const embed = async (texts) => {
      const out = [];
      for (let i = 0; i < texts.length; i += 16) {
        const data = await post('/v1/embeddings', { input: texts.slice(i, i + 16) });
        out.push(...data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
      }
      return out;
    };
    const started = Date.now();
    const docVecs = await embed(docs.map((d) => d.text));
    const perDocMs = (Date.now() - started) / docs.length;
    const qVecs = await embed(queries.map((q) => prefix + q.q));
    const ranks = queries.map((q, i) => rankOf(docs, q.file, docVecs.map((v) => cosine(qVecs[i], v))));
    return { model: path.basename(model), loadSec: server.loadSec, mem: server.mem(), perDocMs, ...rankScores(ranks) };
  } finally {
    await stopServer(server);
  }
}

function rankOf(docs, file, scores) {
  const order = docs.map((d, i) => [d.file, scores[i]]).sort((a, b) => b[1] - a[1]);
  return order.findIndex(([f]) => f === file) + 1;
}

// 지금 앱이 쓰는 TF-IDF 로 같은 질문을 풀어 비교 기준으로 쓴다
function tfidfBaseline(docs, queries) {
  const vecs = tfidfVectors([...docs, ...queries.map((q) => ({ text: q.q }))].map((d) => tokenize(d.text)));
  const ranks = queries.map((q, i) => rankOf(docs, q.file, docs.map((_, j) => mapCosine(vecs[docs.length + i], vecs[j]))));
  return { model: 'TF-IDF (지금 앱)', ...rankScores(ranks) };
}

// ---------- 결과표 ----------

const pct = (n) => `${Math.round(n * 100)}%`;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');

function report(chats, tagBase, embeds, queryNote) {
  const lines = [`# 로컬 AI 비교 (${new Date().toLocaleString('ko-KR')})`, ''];
  if (chats.length) {
    lines.push('## 글 모델', '', '| 모델 | 올리기 | 메모리 | 생성 속도 | 첫 요청 | 맞춤법 | 과교정 | 한자 섞임 | 어미 맞춤 | 태그 맞힘 | 태그 정확도 |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of chats) {
      const wrong = r.spell.filter((s) => s.text !== s.fixed);
      const clean = r.spell.filter((s) => s.text === s.fixed);
      const rates = r.style.map((s) => s.rate).filter((x) => x !== null);
      lines.push(`| ${r.model} | ${r.loadSec.toFixed(1)}초 | ${r.mem} MiB | ${avg(r.tps).toFixed(1)} 토큰/초 | ${(r.firstMs / 1000).toFixed(1)}초 | ${wrong.filter((s) => s.ok).length}/${wrong.length} | ${clean.filter((s) => !s.ok).length}/${clean.length} | ${r.han} | ${pct(avg(rates))} | ${pct(avg(r.tags.map((t) => +t.hit)))} | ${pct(avg(r.tags.map((t) => t.precision)))} |`);
    }
    lines.push(`| 지금 앱 태그 추천 (AI 없이) | | | | | | | | | ${pct(avg(tagBase.map((t) => +t.hit)))} | ${pct(avg(tagBase.map((t) => t.precision)))} |`, '');
    lines.push('- 맞춤법: 틀린 문장을 고친 수 (띄어쓰기 차이는 봐줌) · 과교정: 맞는 문장을 바꾼 수 · 한자 섞임: 답에 한자가 나온 횟수', '- 어미 맞춤: 해요체 · 합니다체 과제에서 문장 끝이 그 어미인 비율. 간결체 · 보고서체는 아래 글을 사람이 봐 주세요', '');
    for (const r of chats) {
      lines.push(`### ${r.model}`, '', '| 과제 | 원문 | 답 |', '|---|---|---|');
      for (const s of r.spell.filter((x) => !x.ok)) lines.push(`| 맞춤법 ✗ (정답: ${cell(s.fixed)}) | ${cell(s.text)} | ${cell(s.out)} |`);
      for (const s of r.style) lines.push(`| ${s.style} | ${cell(s.text)} | ${cell(s.out)} |`);
      for (const t of r.tags) lines.push(`| 태그 ${t.hit ? '✓' : '✗'} (실제: ${cell(t.actual.join(', '))}) | ${cell(t.title)} | ${cell(t.picked.join(', '))} |`);
      lines.push('');
    }
  }
  if (embeds.length) {
    lines.push('## 임베딩 (AI 검색)', '', queryNote, '', '| 모델 | 올리기 | 메모리 | 메모 1개 | 5위 안 | MRR |', '|---|---|---|---|---|---|');
    for (const e of embeds) lines.push(`| ${e.model} | ${e.loadSec ? `${e.loadSec.toFixed(1)}초` : ''} | ${e.mem ? `${e.mem} MiB` : ''} | ${e.perDocMs ? `${Math.round(e.perDocMs)}ms` : ''} | ${pct(e.recall)} | ${e.mrr.toFixed(2)} |`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- 실행 ----------

const memos = readVault(opts.vault);
console.log(`메모 ${memos.length}개 (잠금 메모 뺌)`);

const chats = [];
let tagBase = [];
if (opts.model.length) {
  const typos = readJson(path.join(HERE, 'typos.json'));
  const styles = readJson(path.join(HERE, 'style.json'));
  const candidates = collectTags(memos).slice(0, 60).map((t) => t.name);
  const tagCases = memos.filter((m) => m.tags.length).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 20)
    .map((m) => ({ id: m.id, title: m.title, actual: m.tags, text: stripTags(m.body).slice(0, 1500) }));
  tagBase = tagCases.map((c) => {
    const picked = suggestTagsFor(c.text, memos, { limit: 3, excludeId: c.id }).map((t) => t.name);
    return tagScore(picked, c.actual);
  });
  for (const model of opts.model) {
    console.log(`글 모델: ${path.basename(model)}`);
    chats.push(await runChatModel(model, typos, styles, tagCases, candidates));
  }
}

const embeds = [];
let queryNote = '';
if (opts.embed.length) {
  const docs = memos.map((m) => ({ file: m.file, text: plainLines(m.body).slice(1).join('\n').slice(0, 2000) })).filter((d) => d.text.trim());
  const files = new Set(docs.map((d) => d.file));
  const queries = opts.queries
    ? readJson(opts.queries).filter((q) => files.has(q.file))
    : memos.filter((m) => files.has(m.file) && m.title && m.title !== UNTITLED).slice(0, 50).map((m) => ({ q: m.title, file: m.file }));
  queryNote = opts.queries ? `질문 ${queries.length}개 (${path.basename(opts.queries)})` : `질문 ${queries.length}개: 메모 제목으로 그 메모 본문 찾기 (질문 파일을 주면 더 정확해요)`;
  embeds.push(tfidfBaseline(docs, queries));
  for (const model of opts.embed) {
    console.log(`임베딩: ${path.basename(model)}`);
    embeds.push(await runEmbedModel(model, docs, queries));
  }
}

fs.writeFileSync(OUT, report(chats, tagBase, embeds, queryNote));
console.log(`결과: ${path.resolve(OUT)}`);
