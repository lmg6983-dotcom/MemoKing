// AI 태그 (휴대폰) — Laya 한국어 모델을 이 휴대폰 안에서 (LayaTags.kt, 인터넷 없이).
//   질문 만들기 · 글 나누기 · 답 풀기는 PC 와 같은 공용 코드(app/js/core/laya-*.js), 계산(encoder · head)만 앱이 한다
import { call, aiStatusNative } from './native.js';
import { app } from './state.js';
import { LAYA_MODEL } from '../../app/js/core/model-catalog.js';
import { layaAgent } from '../../app/js/core/laya-agent.js';
import { tagQuestion, rankedTags, blend, BLEND } from '../../app/js/core/laya-tags.js';

const IDLE_MS = 5 * 60_000;

export const aiSupported = Boolean(aiStatusNative);
export const aiStatus = () => aiStatusNative?.() ?? null;
export const aiReady = () => ['ready', 'running'].includes(aiStatus()?.state);

export const downloadModel = () => call('aiDownload', { base: LAYA_MODEL.base, files: LAYA_MODEL.files });
export const removeModel = () => {
  agent = null;
  return call('aiRemove', {});
};

let agent = null; // Promise<Agent> — 토크나이저(수십 MB)를 들고 있으니 쉬면 놓는다
let idle = null;
const json = async (name) => (await fetch(`/ai/${name}`)).json(); // WebServer.kt 의 /ai/

function load() {
  agent ??= (async () => layaAgent({
    tokenizerJson: await json('tokenizer.json'),
    cfg: await json('rl_agent_config.json'),
    provider: {
      runEncoder: async () => ({ lastHidden: null }), // 가운데 결과는 앱 안에 두고 head 까지 한 번에 (layaRun)
      runHead: async (_hidden, batch) => call('layaRun', { batch: JSON.stringify(batch) }),
    },
  }))().catch((err) => {
    agent = null;
    throw err;
  });
  return agent;
}

/** 이 메모에 알맞은 기존 태그를 확률 높은 순으로 [{ name, p }] — 모델이 없거나 묻지 못하면 [] */
export async function aiRank(body, id) {
  if (!aiReady()) return [];
  const q = tagQuestion(body, app.vault?.bodies() ?? [], { excludeId: id });
  if (!q) return [];
  clearTimeout(idle);
  try {
    return blend(rankedTags(await (await load()).predict(q.state, q.questions)), q.scores, BLEND);
  } catch (err) {
    console.error('AI 태그', err.message);
    return [];
  } finally {
    idle = setTimeout(() => { agent = null; }, IDLE_MS);
  }
}
