// 로컬 AI (PC 메인 프로세스) — llama.cpp 의 llama-server 를 자식 프로세스로 띄워 이 PC 안에서만 모델을 돌린다 (인터넷 없이).
//   글 모델(초안 · 맞춤법 · 문체 · 태그)과 검색 모델(임베딩) 두 가지. 모델 파일(.gguf)은 사용자가 고른 파일을
//   이 PC 의 앱 데이터 폴더(ai\)로 복사해 둔다 — USB 로 옮긴 파일도 되고, 메모 폴더(동기화)에는 넣지 않는다.
//   메모리 8GB PC 를 생각해 쓸 때만 띄우고 몇 분 쓰지 않으면 끈다. 모델이 멈추거나 꺼져도 앱은 그대로.
import { spawn as childSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRagStore } from '../../app/js/core/rag-store.js';

export const AI_ROLES = { chat: '글 모델', embed: '검색 모델' };
const IDLE_MS = 5 * 60_000;
const START_MS = 3 * 60_000; // 느린 PC 에서 큰 모델을 올리는 시간

/** .gguf 파일인지 (앞 4바이트) — 엉뚱한 파일을 모델로 넣지 않게 */
export function isGguf(file) {
  const buf = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('latin1') === 'GGUF';
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/**
 * @param {{ dir: string, serverPath: string, getNames: () => { chat?: string, embed?: string },
 *           setName: (role: string, name: string) => void, onStatus: (status) => void, spawn?: typeof childSpawn }} opts
 */
export function createAiService(opts) {
  const { dir, serverPath, spawn = childSpawn } = opts;
  const servers = new Map(); // role → { proc, base, key, ready, timer }
  const copying = new Set();
  const errors = new Map(); // role → 마지막 오류 (화면에 보임)
  const fileOf = (role) => path.join(dir, `${role}.gguf`);

  function status() {
    const one = (role) => {
      let size = 0;
      try {
        size = fs.statSync(fileOf(role)).size;
      } catch { /* 없음 */ }
      const state = copying.has(role) ? 'copying' : !size ? 'missing' : servers.has(role) ? 'running' : 'ready';
      return { state, name: size ? (opts.getNames()[role] ?? '') : '', size, error: errors.get(role) ?? '' };
    };
    return { engine: fs.existsSync(serverPath), chat: one('chat'), embed: one('embed') };
  }
  const emit = () => opts.onStatus(status());

  // ---------- 모델 파일 ----------

  async function importModel(role, source) {
    if (!AI_ROLES[role]) throw new Error('모르는 모델이에요');
    if (copying.has(role)) return status();
    if (!isGguf(source)) throw new Error('모델 파일(.gguf)이 아니에요');
    copying.add(role);
    errors.delete(role);
    emit();
    const part = `${fileOf(role)}.part`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      await fs.promises.copyFile(source, part); // 몇 GB — 다 복사한 뒤에만 바꿔 넣어 쓰던 모델이 깨지지 않게
      await stop(role);
      fs.renameSync(part, fileOf(role));
      opts.setName(role, path.basename(source));
    } catch (err) {
      fs.rmSync(part, { force: true });
      errors.set(role, err.code === 'ENOSPC' ? '저장 공간이 모자라요' : err.message);
      throw new Error(errors.get(role));
    } finally {
      copying.delete(role);
      emit();
    }
    return status();
  }

  async function remove(role) {
    await stop(role);
    fs.rmSync(fileOf(role), { force: true });
    errors.delete(role);
    opts.setName(role, '');
    emit();
    return status();
  }

  // ---------- llama-server ----------

  function start(role) {
    const running = servers.get(role);
    if (running) return running.ready;
    if (!fs.existsSync(serverPath)) return Promise.reject(new Error('이 PC 에 AI 엔진이 없어요. 메모킹을 다시 설치해 주세요'));
    if (!fs.existsSync(fileOf(role))) return Promise.reject(new Error(`${AI_ROLES[role]} 파일을 먼저 넣어 주세요 (설정의 AI 도우미)`));
    const s = {};
    servers.set(role, s);
    s.ready = (async () => {
      const port = await freePort();
      if (servers.get(role) !== s) throw new Error('모델을 바꾸는 중이에요. 다시 해 주세요'); // 그사이 stop() — 띄우지 않는다
      s.base = `http://127.0.0.1:${port}`;
      s.key = randomBytes(16).toString('hex'); // 이 PC 의 다른 프로그램 · 웹 페이지가 모델을 부르지 못하게
      const args = ['-m', fileOf(role), '--host', '127.0.0.1', '--port', String(port), '--api-key', s.key, '--no-webui', '-c', '4096', '-np', '1'];
      if (role === 'embed') args.push('--embedding', '-b', '4096', '-ub', '4096'); // 긴 메모 하나를 한 번에
      s.proc = spawn(serverPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      const log = [];
      s.proc.stderr.setEncoding('utf8').on('data', (chunk) => {
        log.push(...chunk.split('\n').filter(Boolean));
        log.splice(0, Math.max(0, log.length - 20));
      });
      const exited = new Promise((resolve) => s.proc.once('exit', resolve));
      exited.then((code) => {
        if (servers.get(role) === s) servers.delete(role);
        clearTimeout(s.timer);
        if (code && !s.stopping) {
          console.error(`AI ${role} 꺼짐`, code, log.join('\n'));
          errors.set(role, /out of memory|failed to allocate|bad_alloc/i.test(log.join('\n')) ? '메모리가 모자라요. 더 작은 모델을 넣거나 다른 앱을 닫아 주세요' : `모델이 멈췄어요 (${code})`);
        }
        emit();
      });
      emit();
      const until = Date.now() + START_MS;
      while (Date.now() < until) {
        const ok = await Promise.race([fetch(`${s.base}/health`).then((r) => r.ok, () => false), exited.then(() => null)]);
        if (ok === null) throw new Error(errors.get(role) || '모델을 올리지 못했어요. 파일이 깨졌거나 이 엔진이 모르는 모델이에요');
        if (ok) {
          errors.delete(role);
          return s;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      await stop(role);
      throw new Error('모델을 올리는 데 너무 오래 걸려요');
    })();
    s.ready.catch(() => servers.get(role) === s && servers.delete(role));
    return s.ready;
  }

  async function stop(role) {
    const s = servers.get(role);
    if (!s) return;
    servers.delete(role);
    clearTimeout(s.timer);
    if (!s.proc || s.proc.exitCode !== null) return;
    s.stopping = true;
    const gone = new Promise((resolve) => s.proc.once('exit', resolve));
    s.proc.kill();
    await gone;
  }

  // onEvent 를 주면 답을 조각(SSE "data: {…}" 줄)마다 받는다
  async function request(role, route, body, { signal, onEvent } = {}) {
    const s = await start(role);
    clearTimeout(s.timer);
    try {
      const res = await fetch(`${s.base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(`AI 가 답하지 못했어요 (${res.status})`);
      if (!onEvent) return await res.json();
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const data = line.startsWith('data: ') ? line.slice(6).trim() : '';
          if (data && data !== '[DONE]') onEvent(JSON.parse(data));
        }
      }
      return null;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('멈췄어요');
      throw err;
    } finally {
      s.timer = setTimeout(() => stop(role).then(emit), IDLE_MS);
    }
  }

  const noThink = (text) => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(); // 다 오기 전의 생각 블록도

  /** 글 모델에 묻기 → 답 글. schema: 그 JSON 모양으로만 답 · onToken: 지금까지 온 글을 조각마다 · signal: 멈추기 */
  async function chat(messages, { maxTokens = 512, temperature = 0.3, schema, onToken, signal } = {}) {
    const body = {
      messages,
      max_tokens: maxTokens,
      temperature,
      chat_template_kwargs: { enable_thinking: false }, // Qwen3 계열의 생각 모드 끄기 (다른 모델은 무시)
      ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'out', schema } } } : {}),
    };
    if (!onToken) {
      const data = await request('chat', '/v1/chat/completions', body, { signal });
      return noThink(String(data.choices?.[0]?.message?.content ?? ''));
    }
    let text = '';
    await request('chat', '/v1/chat/completions', { ...body, stream: true }, {
      signal,
      onEvent: (e) => {
        const piece = e.choices?.[0]?.delta?.content;
        if (piece) onToken(noThink((text += piece)));
      },
    });
    return noThink(text);
  }

  /** 검색 모델로 글들의 벡터 */
  async function embed(texts) {
    const data = await request('embed', '/v1/embeddings', { input: texts });
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  return {
    status, emit, importModel, remove, chat, embed,
    // AI 검색용 조각 · 벡터 — 이 PC 에만
    rag: createRagStore({
      load: () => fs.promises.readFile(path.join(dir, 'vectors.json'), 'utf8').catch(() => null),
      save: async (text) => {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, 'vectors.json'), text);
      },
    }),
    close: () => {
      for (const s of servers.values()) {
        clearTimeout(s.timer);
        s.proc?.kill();
      }
    },
  };
}
