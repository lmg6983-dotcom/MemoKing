// 로컬 AI (휴대폰) — 엔진은 앱(LocalAi.kt)이 띄우고, 묻는 말 · 답 풀기 · 작업 흐름은 PC 와 같은 공용 코드 (인터넷 없이)
//   aiApi 는 PC 의 window.memoking 과 같은 모양 (ai · on · memo.open) — 공용 화면 모듈(ai-write-panel.js · ai-ask.js)이 그대로 쓴다
import { call, on, localAiNative as raw } from './native.js';
import { app } from './state.js';
import { llamaClient } from '../../app/js/core/llama-client.js';
import { createAiTasks } from '../../app/js/core/ai-tasks.js';
import { createRagStore } from '../../app/js/core/rag-store.js';

export const aiSupported = Boolean(raw);
export const aiStatus = () => raw?.status() ?? null;
export const chatReady = () => ['ready', 'running'].includes(aiStatus()?.chat.state);

// ---------- 엔진에 묻기 (앱을 거쳐 127.0.0.1 의 llama-server 로) ----------

const lineHandlers = new Map(); // 스트리밍 작업 → 줄마다
on('aiLine', ({ job, line }) => lineHandlers.get(job)?.(line));
let seq = 0;

async function request(role, route, body, { signal, onLine } = {}) {
  if (signal?.aborted) throw new Error('멈췄어요');
  const job = `j${++seq}`;
  if (onLine) lineHandlers.set(job, onLine);
  const stop = () => raw.cancel(job);
  signal?.addEventListener('abort', stop);
  try {
    const text = await call('aiRequest', { role, route, body: JSON.stringify(body), job, stream: Boolean(onLine) });
    return text ? JSON.parse(text) : null;
  } catch (err) {
    throw signal?.aborted ? new Error('멈췄어요') : err;
  } finally {
    lineHandlers.delete(job);
    signal?.removeEventListener('abort', stop);
  }
}

const localAi = { status: aiStatus, ...llamaClient(request) };

export const aiTasks = createAiTasks({
  ai: localAi,
  memos: () => app.vault?.bodies() ?? [],
  graph: () => app.vault?.index?.memos ?? [],
  store: createRagStore({ load: async () => raw.cacheRead(), save: async (text) => raw.cacheWrite(text) }), // 이 휴대폰에만
});

// ---------- PC 와 같은 모양의 api ----------

const listeners = new Map();
const emit = (name, data) => listeners.get(name)?.forEach((fn) => fn(data));
const jobs = new Map(); // 화면 작업 id → 멈추기

async function runJob(id, run) {
  const ctrl = new AbortController();
  jobs.set(id, ctrl);
  try {
    return await run({
      signal: ctrl.signal,
      onToken: (text) => emit('ai:token', { id, text }),
      onProgress: (done, total) => emit('ai:progress', { id, done, total }),
    });
  } catch (err) {
    return { error: err.message };
  } finally {
    jobs.delete(id);
  }
}

export const aiApi = {
  ai: {
    status: async () => aiStatus(),
    importModel: (role) => call('aiImport', { role }), // 고르고 복사 (진행은 on('aiImport'))
    remove: (role) => call('aiRemove', { role }),
    async try() {
      const started = Date.now();
      try {
        const text = await localAi.chat([{ role: 'user', content: '메모 앱을 한 문장으로 소개해 주세요.' }], { maxTokens: 80 });
        return { text, seconds: (Date.now() - started) / 1000 };
      } catch (err) {
        return { error: err.message };
      }
    },
    write: ({ id, ...job }) => runJob(id, (o) => aiTasks.write(job, o)),
    ask: ({ id, question }) => runJob(id, (o) => aiTasks.ask(question, o)),
    cancel: async (id) => jobs.get(id)?.abort(),
  },
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  },
  memo: { open: (id) => app.openMemo(id) },
};
