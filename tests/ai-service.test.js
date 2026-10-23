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

test('로컬 AI: 모델 넣기 · 묻기 · 지우기', async () => {
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

    await ai.importModel('embed', model);
    assert.deepEqual(await ai.embed(['가', '가나다']), [[1], [3]]);

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
