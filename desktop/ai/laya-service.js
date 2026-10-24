// AI 태그 (PC 메인 프로세스) — Laya 다국어 모델(core/model-catalog.js 의 LAYA_MODEL)을 이 PC 안에서 돌려
//   태그 없는 메모에 기존 태그 중 알맞은 것을 고른다 (인터넷 없이). 모델은 한 번 받아 앱 데이터 폴더(ai\laya\)에.
//   계산은 onnxruntime-node — 메인 스레드를 막지 않는다. 쓸 때만 올리고 5분 쉬면 내려 메모리를 돌려준다
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LAYA_MODEL } from '../../app/js/core/model-catalog.js';
import { layaAgent, ortProvider } from '../../app/js/core/laya-agent.js';
import { tagQuestion, rankedTags, blend, BLEND } from '../../app/js/core/laya-tags.js';

const IDLE_MS = 5 * 60_000;

/**
 * @param {{ dir: string, onStatus: (status) => void, fetch?: typeof fetch, loadOrt?: () => Promise<any>, model?: typeof LAYA_MODEL }} opts
 *   fetch: 모델 받기 (PC 는 Electron net.fetch — 시스템 프록시를 따른다)
 */
export function createLayaService({ dir, onStatus, fetch: get = fetch, loadOrt = () => import('onnxruntime-node'), model = LAYA_MODEL }) {
  let downloading = null; // 받은 정도 (0~1)
  let error = '';
  let agent = null; // Promise<Agent>
  let idle = null;
  const file = (name) => path.join(dir, name);
  const have = () => model.files.every((f) => fs.existsSync(file(f.name)));

  function status() {
    const size = have() ? model.files.reduce((n, f) => n + fs.statSync(file(f.name)).size, 0) : 0;
    const state = downloading != null ? 'downloading' : !size ? 'missing' : agent ? 'running' : 'ready';
    return { state, size, progress: downloading, error };
  }
  const emit = () => onStatus(status());

  /** 모델 받기 — 파일마다 .part 로 받고 SHA-256 이 맞아야 넣는다 */
  async function download() {
    if (downloading != null) return status();
    downloading = 0;
    error = '';
    emit();
    const total = model.files.reduce((n, f) => n + f.size, 0);
    let done = 0;
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of model.files) {
        if (fs.existsSync(file(f.name)) && fs.statSync(file(f.name)).size === f.size) { // 끊겼다 다시 받을 때 다 받은 파일은 건너뛴다
          done += f.size;
          continue;
        }
        const res = await get(model.base + f.name).catch(() => { throw new Error('인터넷에 연결하지 못했어요. 인터넷이 될 때 다시 눌러 주세요'); });
        if (!res.ok || !res.body) throw new Error(`받지 못했어요 (${res.status}). 인터넷을 확인하고 다시 눌러 주세요`);
        const part = `${file(f.name)}.part`;
        const out = fs.createWriteStream(part);
        const hash = createHash('sha256');
        try {
          for await (const chunk of res.body) {
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            done += chunk.length;
            if (done / total - downloading >= 0.01) {
              downloading = done / total;
              emit();
            }
          }
        } catch (err) {
          throw err.code === 'ENOSPC' ? new Error('저장 공간이 모자라요') : new Error('받다가 끊겼어요. 인터넷을 확인하고 다시 눌러 주세요');
        } finally {
          await new Promise((r) => out.end(r));
        }
        if (hash.digest('hex') !== f.sha256) {
          fs.rmSync(part, { force: true });
          throw new Error('받은 파일이 맞지 않아요. 다시 받아 주세요');
        }
        fs.renameSync(part, file(f.name));
      }
    } catch (err) {
      error = err.code === 'ENOSPC' ? '저장 공간이 모자라요' : err.message;
    } finally {
      downloading = null;
      emit();
    }
    return status();
  }

  async function unload() {
    clearTimeout(idle);
    const a = agent;
    agent = null;
    if (a) await a.then((x) => x.release()).catch(() => {});
    emit();
  }

  async function remove() {
    await unload();
    for (const f of model.files) fs.rmSync(file(f.name), { force: true });
    error = '';
    emit();
    return status();
  }

  function load() {
    agent ??= (async () => {
      const ort = await loadOrt();
      const [encoder, head] = await Promise.all(['encoder.onnx', 'head.onnx'].map((f) => ort.InferenceSession.create(file(f))));
      const a = layaAgent({
        tokenizerJson: JSON.parse(await fs.promises.readFile(file('tokenizer.json'), 'utf8')),
        cfg: JSON.parse(await fs.promises.readFile(file('rl_agent_config.json'), 'utf8')),
        provider: ortProvider(ort, encoder, head),
      });
      a.release = () => Promise.all([encoder.release(), head.release()]);
      emit();
      return a;
    })().catch((err) => {
      agent = null;
      error = `AI 태그 모델을 올리지 못했어요 (${err.message}). 지우고 다시 받아 주세요`;
      emit();
      throw err;
    });
    return agent;
  }

  /** 이 메모에 알맞은 기존 태그를 확률 높은 순으로 [{ name, p }] — 모델이 없거나 후보가 없으면 [] */
  async function rank(body, memos, id) {
    if (!have() || downloading != null) return [];
    const q = tagQuestion(body, memos, { excludeId: id });
    if (!q) return [];
    clearTimeout(idle);
    try {
      return blend(rankedTags(await (await load()).predict(q.state, q.questions)), q.scores, BLEND);
    } finally {
      idle = setTimeout(unload, IDLE_MS);
    }
  }

  return { status, download, remove, rank, close: unload };
}
