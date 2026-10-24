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

test('기본 모델: 목록에서 본 파일만 (보조 파일 빼고), 커밋 고정 · 해시 필수', async () => {
  const { DEFAULT_MODEL, pickModelFile } = await import('../app/js/core/model-catalog.js');
  const sha = 'a'.repeat(64);
  const info = {
    sha: 'c0ffee',
    siblings: [
      { rfilename: 'mtp-gemma-4-E2B-it-UD-Q4_K_XL.gguf', lfs: { sha256: sha, size: 1 } },
      { rfilename: 'mmproj-F16.gguf', lfs: { sha256: sha, size: 1 } },
      { rfilename: 'gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf', lfs: { sha256: sha, size: 2_800_000_000 } },
    ],
  };
  assert.deepEqual(pickModelFile(DEFAULT_MODEL, info), {
    name: 'gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-qat-GGUF/resolve/c0ffee/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf',
    size: 2_800_000_000,
    sha256: sha,
  });
  assert.throws(() => pickModelFile(DEFAULT_MODEL, { siblings: [{ rfilename: 'x-UD-Q4_K_XL.gguf' }] }), /찾지 못했어요/);
});

test('기본 모델 받기: 해시가 맞을 때만 넣고, 틀리면 버린다', async () => {
  const { createHash } = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ai-dl-'));
  const body = Buffer.from('GGUF 모델 내용');
  let sha = createHash('sha256').update(body).digest('hex');
  const names = {};
  const fakeFetch = async (url) => (url.includes('/api/models/')
    ? new Response(JSON.stringify({ sha: 'abc', siblings: [{ rfilename: 'gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf', lfs: { sha256: sha, size: body.length } }] }))
    : new Response(body));
  const ai = createAiService({ dir, serverPath: process.execPath, getNames: () => names, setName: (r, n) => { names[r] = n; }, onStatus: () => {}, fetch: fakeFetch });
  try {
    const st = await ai.downloadDefault();
    assert.equal(st.chat.state, 'ready');
    assert.equal(names.chat, 'gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'chat.gguf')), body);

    await ai.remove('chat');
    sha = 'b'.repeat(64); // 목록이 알려 준 해시와 다른 파일
    await assert.rejects(ai.downloadDefault(), /맞지 않아요/);
    assert.equal(ai.status().chat.state, 'missing');
    assert.ok(!fs.existsSync(path.join(dir, 'chat.gguf.part')));
  } finally {
    ai.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
