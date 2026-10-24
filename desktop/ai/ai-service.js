// AI 글 도우미 (PC 메인 프로세스, PC 에만) — llama.cpp 의 llama-server 를 자식 프로세스로 띄워 이 PC 안에서만 글 모델을 돌린다 (인터넷 없이).
//   정리 · 지시대로 고치기 · 문체 · 맞춤법 · 초안. 모델 파일(.gguf)은 카나나2(1.3B · 3B, PC 메모리에 맞춰 추천)를 받거나 사용자가 고른 파일을
//   이 PC 의 앱 데이터 폴더(ai\)로 복사해 둔다 — USB 로 옮긴 파일도 되고, 메모 폴더(동기화)에는 넣지 않는다.
//   메모리 8GB PC 를 생각해 쓸 때만 띄우고 몇 분 쓰지 않으면 끈다. 모델이 멈추거나 꺼져도 앱은 그대로.
import { spawn as childSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { llamaClient, engineError } from '../../app/js/core/llama-client.js';
import { WRITE_MODELS, recommendModel } from '../../app/js/core/model-catalog.js';

export const AI_ROLES = { chat: '글 모델' };
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
 *           setName: (role: string, name: string) => void, onStatus: (status) => void, spawn?: typeof childSpawn, fetch?: typeof fetch }} opts
 *   fetch: 모델 받기 (PC 는 Electron net.fetch — 시스템 프록시를 따른다)
 */
export function createAiService(opts) {
  const { dir, serverPath, spawn = childSpawn, fetch: get = fetch } = opts;
  const servers = new Map(); // role → { proc, base, key, ready, timer }
  const copying = new Set();
  const progress = new Map(); // role → 기본 모델을 받은 정도 (0~1)
  const errors = new Map(); // role → 마지막 오류 (화면에 보임)
  const fileOf = (role) => path.join(dir, `${role}.gguf`);

  function status() {
    const one = (role) => {
      let size = 0;
      try {
        size = fs.statSync(fileOf(role)).size;
      } catch { /* 없음 */ }
      const state = copying.has(role) ? 'copying' : !size ? 'missing' : servers.has(role) ? 'running' : 'ready';
      return { state, name: size ? (opts.getNames()[role] ?? '') : '', size, error: errors.get(role) ?? '', progress: progress.get(role) ?? null };
    };
    return { engine: fs.existsSync(serverPath), chat: one('chat'), recommended: recommendModel(os.totalmem()).id };
  }
  const emit = () => opts.onStatus(status());

  // ---------- 모델 파일 ----------

  // 모델을 .part 로 채운 뒤(fill → 이름) 다 됐을 때만 바꿔 넣는다 — 몇 GB 라 도중에 끊겨도 쓰던 모델이 깨지지 않게
  async function bringIn(role, fill) {
    if (copying.has(role)) return status();
    copying.add(role);
    errors.delete(role);
    emit();
    const part = `${fileOf(role)}.part`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const name = await fill(part);
      await stop(role);
      fs.renameSync(part, fileOf(role));
      opts.setName(role, name);
    } catch (err) {
      fs.rmSync(part, { force: true });
      errors.set(role, err.code === 'ENOSPC' ? '저장 공간이 모자라요' : err.message);
      throw new Error(errors.get(role));
    } finally {
      copying.delete(role);
      progress.delete(role);
      emit();
    }
    return status();
  }

  async function importModel(role, source) {
    if (!AI_ROLES[role]) throw new Error('모르는 모델이에요');
    if (!isGguf(source)) throw new Error('모델 파일(.gguf)이 아니에요');
    return bringIn(role, async (part) => {
      await fs.promises.copyFile(source, part);
      return path.basename(source);
    });
  }

  /** 글 모델 받기 (core/model-catalog.js WRITE_MODELS 의 id) — 크기 · SHA-256 이 맞아야 넣는다 */
  function download(id) {
    const f = WRITE_MODELS.find((m) => m.id === id);
    if (!f) return Promise.reject(new Error('모르는 모델이에요'));
    const role = 'chat';
    return bringIn(role, async (part) => {
      const res = await get(f.url).catch(() => { throw new Error('인터넷에 연결하지 못했어요. 인터넷이 될 때 다시 누르거나, 모델 파일을 직접 넣어 주세요'); });
      if (!res.ok || !res.body) throw new Error(`받지 못했어요 (${res.status}). 인터넷을 확인하고 다시 눌러 주세요`);
      const out = fs.createWriteStream(part);
      const hash = createHash('sha256');
      let got = 0;
      let shown = 0;
      try {
        for await (const chunk of res.body) {
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          got += chunk.length;
          if (f.size && got / f.size - shown >= 0.01) {
            progress.set(role, (shown = got / f.size));
            emit();
          }
        }
      } catch (err) {
        throw err.code === 'ENOSPC' ? err : new Error('받다가 끊겼어요. 인터넷을 확인하고 다시 눌러 주세요');
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (got !== f.size || hash.digest('hex') !== f.sha256) throw new Error('받은 파일이 맞지 않아요. 다시 받아 주세요');
      return f.url.split('/').pop();
    });
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
    if (!fs.existsSync(fileOf(role))) return Promise.reject(new Error(`${AI_ROLES[role]} 파일을 먼저 넣어 주세요 (설정의 AI 글 도우미)`));
    const s = {};
    servers.set(role, s);
    s.ready = (async () => {
      const port = await freePort();
      if (servers.get(role) !== s) throw new Error('모델을 바꾸는 중이에요. 다시 해 주세요'); // 그사이 stop() — 띄우지 않는다
      s.base = `http://127.0.0.1:${port}`;
      s.key = randomBytes(16).toString('hex'); // 이 PC 의 다른 프로그램 · 웹 페이지가 모델을 부르지 못하게
      const args = ['-m', fileOf(role), '--host', '127.0.0.1', '--port', String(port), '--api-key', s.key, '--no-webui', '-c', '4096', '-np', '1'];
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
          errors.set(role, engineError(log.join('\n'), code));
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

  // onLine 을 주면 답을 줄(SSE "data: {…}")마다 받는다
  async function request(role, route, body, { signal, onLine } = {}) {
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
      if (!onLine) return await res.json();
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) onLine(line);
      }
      return null;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('멈췄어요');
      throw err;
    } finally {
      s.timer = setTimeout(() => stop(role).then(emit), IDLE_MS);
    }
  }

  const { chat } = llamaClient(request);

  return {
    status, emit, importModel, download, remove, chat,
    close: () => {
      for (const s of servers.values()) {
        clearTimeout(s.timer);
        s.proc?.kill();
      }
    },
  };
}
