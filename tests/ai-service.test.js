import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiService } from '../desktop/ai/ai-service.js';

// llama-server 흉내: /health, 키가 맞을 때만 답, 생각 블록이 붙은 답
const FAKE = `
import http from 'node:http';
const a = process.argv.slice(2);
const arg = (k) => a[a.indexOf(k) + 1];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    if (req.url === '/health') return res.end('{}');
    if (req.headers.authorization !== 'Bearer ' + arg('--api-key')) { res.statusCode = 401; return res.end('{}'); }
    const j = JSON.parse(body);
    if (req.url === '/v1/embeddings') return res.end(JSON.stringify({ data: j.input.map((t, index) => ({ index, embedding: [t.length] })).reverse() }));
    if (j.stream) {
      for (const piece of ['<think>음', '</think> 답', ': ', j.messages[0].content]) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\\n\\n');
      return res.end('data: [DONE]\\n\\n');
    }
    res.end(JSON.stringify({ choices: [{ message: { content: '<think>음</think> 답: ' + j.messages[0].content } }] }));
  });
}).listen(Number(arg('--port')), arg('--host'));
`;

test('AI 글 도우미(PC): 모델 넣기 · 묻기 · 지우기', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ai-'));
  const fake = path.join(dir, 'fake-server.mjs');
  fs.writeFileSync(fake, FAKE);
  const model = path.join(dir, 'qwen3-4b.gguf');
  fs.writeFileSync(model, 'GGUF....');
  const notModel = path.join(dir, 'note.txt');
  fs.writeFileSync(notModel, 'hello');
  const names = {};
  const ai = createAiService({
    dir: path.join(dir, 'ai'),
    serverPath: process.execPath, // 있기만 하면 됨 — 실제로는 아래 spawn 이 가짜 서버를 띄운다
    getNames: () => names,
    setName: (role, name) => { names[role] = name; },
    onStatus: () => {},
    spawn: (_cmd, args, o) => spawn(process.execPath, [fake, ...args], o),
  });
  try {
    assert.equal(ai.status().chat.state, 'missing');
    await assert.rejects(ai.chat([{ role: 'user', content: '안녕' }]), /먼저 넣어/);
    await assert.rejects(ai.importModel('chat', notModel), /gguf/);

    await ai.importModel('chat', model);
    assert.equal(ai.status().chat.state, 'ready');
    assert.equal(ai.status().chat.name, 'qwen3-4b.gguf');

    assert.equal(await ai.chat([{ role: 'user', content: '안녕' }]), '답: 안녕');
    assert.equal(ai.status().chat.state, 'running');

    const seen = [];
    assert.equal(await ai.chat([{ role: 'user', content: '조각' }], { onToken: (t) => seen.push(t) }), '답: 조각');
    assert.deepEqual(seen, ['', '답', '답:', '답: 조각']); // 다 오기 전의 생각 블록은 보이지 않는다

    await assert.rejects(ai.importModel('embed', model), /모르는 모델/); // 검색 모델은 없어짐 (AI 태그는 Laya)

    await ai.remove('chat');
    assert.equal(ai.status().chat.state, 'missing');
    assert.equal(names.chat, '');
  } finally {
    ai.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('로컬 AI: 엔진이 꺼진 까닭을 알아듣게', async () => {
  const { engineError } = await import('../app/js/core/llama-client.js');
  assert.match(engineError("llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'kanana2tiny'", 1), /모르는 모델 구조예요 \(kanana2tiny\)/);
  assert.match(engineError('ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer', 1), /메모리가 모자라요/);
  assert.equal(engineError('', 3), '모델이 멈췄어요 (3)');
});

test('글 모델 추천: 8GB PC 는 1.3B, 16GB 는 3B', async () => {
  const { recommendModel } = await import('../app/js/core/model-catalog.js');
  assert.equal(recommendModel(7.8 * 2 ** 30).id, '1.3b'); // 윈도가 알려 주는 8GB
  assert.equal(recommendModel(15.9 * 2 ** 30).id, '3b');
});

test('글 모델 받기: 크기 · 해시가 맞을 때만 넣고, 틀리면 버린다', async () => {
  const { createHash } = await import('node:crypto');
  const { WRITE_MODELS } = await import('../app/js/core/model-catalog.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ai-dl-'));
  const body = Buffer.from('GGUF 모델 내용');
  const m = WRITE_MODELS[0];
  const saved = { size: m.size, sha256: m.sha256 };
  Object.assign(m, { size: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  const names = {};
  const ai = createAiService({ dir, serverPath: process.execPath, getNames: () => names, setName: (r, n) => { names[r] = n; }, onStatus: () => {}, fetch: async () => new Response(body) });
  try {
    const st = await ai.download(m.id);
    assert.equal(st.chat.state, 'ready');
    assert.equal(names.chat, m.url.split('/').pop());
    assert.deepEqual(fs.readFileSync(path.join(dir, 'chat.gguf')), body);

    await ai.remove('chat');
    m.sha256 = 'b'.repeat(64); // 올린 것과 다른 파일
    await assert.rejects(ai.download(m.id), /맞지 않아요/);
    assert.equal(ai.status().chat.state, 'missing');
    assert.ok(!fs.existsSync(path.join(dir, 'chat.gguf.part')));
    await assert.rejects(ai.download('7b'), /모르는 모델/);
  } finally {
    Object.assign(m, saved);
    ai.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
