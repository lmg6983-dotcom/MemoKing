// 받아쓰기 (PC 메인 프로세스) — 받아쓰기 데이터(모델) 받기·지우기, 작업 스레드(stt-worker.js) 띄우기, 메모 창과 주고받기.
//   데이터는 처음 한 번 받아 이 PC 의 앱 데이터 폴더(stt\)에 둔다. 메모 폴더(동기화)에는 넣지 않는다.
//   - 받아쓰기 (한국어, 약 80MB): 한국어 Zipformer(KsponSpeech) + 말소리 구간 나누기(Silero VAD)
//   - 말한 사람 나누기 (약 30MB, 켰을 때만): pyannote 구간 나누기 + CAM++ 목소리 특징
//   받은 글 다듬기는 휴대폰과 같다: 이 메모 폴더의 낱말로 고치기(core/transcript-fix.js) · 문장마다 줄 · 화자 이름표
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { joinTranscript, labelSpeakers } from '../../app/js/core/transcript-lines.js';
import { vocabularyFrom, fixTranscript } from '../../app/js/core/transcript-fix.js';
import { UI } from '../../app/js/core/ui-text.js';

const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const HF = 'https://huggingface.co/k2-fsa/sherpa-onnx-zipformer-korean-2024-06-24/resolve/main';
const KO_FILES = {
  'encoder-epoch-99-avg-1.int8.onnx': 'encoder.onnx',
  'decoder-epoch-99-avg-1.int8.onnx': 'decoder.onnx',
  'joiner-epoch-99-avg-1.int8.onnx': 'joiner.onnx',
  'tokens.txt': 'tokens.txt',
};

// 받을 것: 묶음 → 부분들 (모두 있어야 함) → 부분마다 받는 곳 (앞에서부터, 안 되면 다음)
//   files: 받은 뒤 크기로 확인 (중간에 끊기거나 엉뚱한 페이지를 받지 않았는지)
export const STT_PACKS = {
  asr: {
    label: '받아쓰기 데이터', size: '약 80MB',
    parts: [
      {
        dir: 'ko',
        files: { 'encoder.onnx': 70784728, 'decoder.onnx': 2844692, 'joiner.onnx': 2581421, 'tokens.txt': 60246 },
        sources: [
          { files: Object.fromEntries(Object.entries(KO_FILES).map(([from, to]) => [`${HF}/${from}`, to])), bytes: 76270000 },
          { archive: `${GH}/asr-models/sherpa-onnx-zipformer-korean-2024-06-24.tar.bz2`, pick: KO_FILES, bytes: 329740690 },
        ],
      },
      {
        dir: 'vad',
        files: { 'silero_vad.onnx': 643854 },
        sources: [{ files: { [`${GH}/asr-models/silero_vad.onnx`]: 'silero_vad.onnx' }, bytes: 643854 }],
      },
    ],
  },
  speaker: {
    label: '말한 사람 나누기 데이터', size: '약 30MB',
    parts: [
      {
        dir: 'speaker',
        files: { 'segmentation.onnx': 1540506 },
        sources: [{ archive: `${GH}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, pick: { 'model.int8.onnx': 'segmentation.onnx' }, bytes: 6958444 }],
      },
      {
        dir: 'speaker',
        files: { 'embedding.onnx': 28281138 },
        sources: [{ files: { [`${GH}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`]: 'embedding.onnx' }, bytes: 28281138 }],
      },
    ],
  },
};

const IDLE_MS = 3 * 60_000; // 쓰지 않으면 작업 스레드를 닫아 메모리(약 300MB)를 돌려준다

/**
 * @param {{ dir: string, workerPath: string, vendor: string, fetch: typeof fetch,
 *           getVault: () => any, getOptions: () => { enabled: boolean, speaker: boolean },
 *           onStatus: (status) => void, onSpeakers: (r: { memoId: string, src: string, text: string }) => void }} opts
 */
export function createSttService(opts) {
  const { dir } = opts;
  const downloads = new Map(); // 묶음 → { progress: 0~1, error }
  const jobs = new Map(); // 작업 id → { onLine, onSpeaking, done(resolve), lines, memoId, src, speakers }
  let worker = null;
  let idleTimer = 0;
  let seq = 0;
  let vocabCache = { at: 0, list: [] };

  const packDir = (sub) => path.join(dir, sub);
  const partReady = (part) => Object.entries(part.files).every(([name, size]) => {
    try {
      return fs.statSync(path.join(packDir(part.dir), name)).size === size;
    } catch {
      return false;
    }
  });
  const ready = (pack) => STT_PACKS[pack].parts.every(partReady);

  function status() {
    const one = (pack) => {
      const d = downloads.get(pack);
      return { state: d && !d.error ? 'downloading' : ready(pack) ? 'ready' : 'missing', progress: d?.progress ?? 0, error: d?.error ?? '', size: STT_PACKS[pack].size };
    };
    const o = opts.getOptions();
    return { asr: one('asr'), speaker: one('speaker'), enabled: o.enabled, speakerOn: o.speaker };
  }
  const emit = () => opts.onStatus(status());

  // ---------- 받기 ----------

  async function fetchTo(url, file, onBytes) {
    const res = await opts.fetch(url);
    if (!res.ok || !res.body) throw new Error(`받지 못했어요 (${res.status}). 인터넷을 확인하고 다시 눌러 주세요`);
    const out = fs.createWriteStream(file);
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        onBytes(value.length);
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
  }

  async function getPart(part, onFraction) {
    const dest = packDir(part.dir);
    fs.mkdirSync(dest, { recursive: true });
    let lastErr = null;
    for (const src of part.sources) {
      const tmp = path.join(dir, `.part-${process.pid}-${seq++}`);
      fs.mkdirSync(tmp, { recursive: true });
      let got = 0;
      const count = (n) => {
        got += n;
        onFraction(Math.min(1, got / src.bytes));
      };
      try {
        if (src.files) {
          for (const [url, to] of Object.entries(src.files)) await fetchTo(url, path.join(tmp, to), count);
          for (const to of Object.values(src.files)) {
            if (part.files[to] && fs.statSync(path.join(tmp, to)).size !== part.files[to]) throw new Error(`${to} 크기가 달라요`);
          }
          for (const to of Object.values(src.files)) fs.renameSync(path.join(tmp, to), path.join(dest, to));
        } else {
          const archive = path.join(tmp, 'pack.tar.bz2');
          await fetchTo(src.archive, archive, count);
          await call({ type: 'extract', archive, dest, files: src.pick });
        }
        if (partReady(part)) return;
        throw new Error('받은 파일이 맞지 않아요. 다시 받아 주세요');
      } catch (err) {
        lastErr = err;
        onFraction(0); // 다음 곳에서 처음부터
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    throw lastErr ?? new Error('받지 못했어요. 인터넷을 확인하고 다시 눌러 주세요');
  }

  async function download(pack) {
    if (!STT_PACKS[pack]) throw new Error('모르는 데이터예요');
    if (downloads.has(pack) && !downloads.get(pack).error) return status();
    const parts = STT_PACKS[pack].parts.filter((p) => !partReady(p));
    // 진행률: 부분마다 처음 받는 곳의 크기만큼 무게
    const weight = parts.map((p) => p.sources[0].bytes);
    const total = weight.reduce((a, b) => a + b, 0) || 1;
    const d = { progress: 0, error: '' };
    downloads.set(pack, d);
    emit();
    let before = 0;
    let shown = 0;
    try {
      for (const [i, part] of parts.entries()) {
        await getPart(part, (f) => {
          d.progress = Math.min(0.99, (before + f * weight[i]) / total);
          if (Math.abs(d.progress - shown) >= 0.01) {
            shown = d.progress;
            emit();
          }
        });
        before += weight[i];
      }
      downloads.delete(pack);
    } catch (err) {
      d.error = err.message || UI.downloadFail;
      emit();
      downloads.delete(pack);
      throw new Error(d.error);
    }
    emit();
    return status();
  }

  function remove(pack) {
    for (const part of STT_PACKS[pack]?.parts ?? []) {
      for (const name of Object.keys(part.files)) fs.rmSync(path.join(packDir(part.dir), name), { force: true });
    }
    emit();
    return status();
  }

  // ---------- 작업 스레드 ----------

  function ensureWorker() {
    clearTimeout(idleTimer);
    if (worker) return worker;
    worker = new Worker(opts.workerPath, { workerData: { vendor: opts.vendor } });
    worker.on('message', onMessage);
    worker.on('error', (err) => {
      console.error('받아쓰기 작업 오류', err);
      failAll(err.message || '받아쓰기 중 문제가 생겼어요');
    });
    worker.on('exit', () => {
      worker = null;
      failAll('받아쓰기가 멈췄어요');
    });
    return worker;
  }
  function idleLater() {
    clearTimeout(idleTimer);
    if (jobs.size) return;
    idleTimer = setTimeout(() => {
      if (!jobs.size && worker) worker.terminate();
    }, IDLE_MS);
  }
  function failAll(message) {
    for (const [id, job] of jobs) {
      job.reject?.(new Error(message));
      jobs.delete(id);
    }
  }

  // 한 번 묻고 답 받기 (압축 풀기)
  const calls = new Map();
  function call(msg) {
    const id = `c${seq++}`;
    ensureWorker().postMessage({ ...msg, id });
    return new Promise((resolve, reject) => calls.set(id, { resolve, reject })).finally(idleLater);
  }

  function onMessage(m) {
    const c = calls.get(m.id);
    if (c) {
      calls.delete(m.id);
      if (m.type === 'error') c.reject(new Error(m.message));
      else c.resolve(m);
      return;
    }
    const job = jobs.get(m.id);
    if (!job) return;
    if (m.type === 'line') job.onLine?.(m.text);
    else if (m.type === 'speaking') job.onSpeaking?.(m.on);
    else if (m.type === 'progress') job.onProgress?.(m);
    else if (m.type === 'done') {
      job.lines = m.lines;
      job.resolve?.({ text: polish(joinTranscript(m.lines)), lines: m.lines.length, speakers: Boolean(job.speakerDir && m.lines.length && m.seconds > 2) });
      job.resolve = job.reject = null;
      if (!job.speakerDir || !m.lines.length || m.seconds <= 2) finishJob(m.id);
    } else if (m.type === 'speakers') {
      const text = polish(joinTranscript(labelSpeakers(job.lines, m.segments)));
      if (job.memoId && job.src) opts.onSpeakers({ memoId: job.memoId, src: job.src, text });
      finishJob(m.id);
    } else if (m.type === 'error') {
      if (job.resolve) job.reject(new Error(m.message));
      else console.error('받아쓰기:', m.stage, m.message);
      finishJob(m.id);
    }
  }
  function finishJob(id) {
    jobs.delete(id);
    idleLater();
  }

  function dirs() {
    return { asr: packDir('ko'), vad: packDir('vad') };
  }
  const speakerDir = () => (opts.getOptions().speaker && ready('speaker') ? packDir('speaker') : '');

  // 이 메모 폴더의 낱말로 받아쓴 글 다듬기 (1분마다 새로)
  function polish(text) {
    if (!text) return '';
    const vault = opts.getVault();
    if (vault && Date.now() - vocabCache.at > 60_000) vocabCache = { at: Date.now(), list: vocabularyFrom(vault.bodies()) };
    return fixTranscript(text, vault ? vocabCache.list : []);
  }

  /** 녹음 받아쓰기 시작 → 받아쓸 수 없으면 이유 */
  function start(id, { onLine, onSpeaking } = {}) {
    if (!opts.getOptions().enabled) return { stt: false, reason: 'off' };
    if (!ready('asr')) return { stt: false, reason: 'missing' };
    const sd = speakerDir();
    jobs.set(id, { onLine, onSpeaking, lines: [], speakerDir: sd });
    ensureWorker().postMessage({ type: 'start', id, dirs: dirs(), speaker: Boolean(sd) });
    return { stt: true, speaker: Boolean(sd) };
  }

  function audio(id, samples) {
    if (jobs.has(id) && worker) worker.postMessage({ type: 'audio', id, samples }, [samples.buffer]);
  }

  /** 녹음 받아쓰기 끝 → { text, speakers: 말한 사람 나누기를 이어서 하는지 } (memoId·src: 나누기가 끝나면 고칠 음성 카드) */
  function stop(id, { memoId, src } = {}) {
    const job = jobs.get(id);
    if (!job || !worker) return Promise.resolve({ text: '', lines: 0, speakers: false });
    Object.assign(job, { memoId, src });
    return new Promise((resolve, reject) => {
      Object.assign(job, { resolve, reject });
      worker.postMessage({ type: 'stop', id, speaker: job.speakerDir ? { dir: job.speakerDir } : null });
    });
  }

  function cancel(id) {
    if (!jobs.has(id)) return;
    worker?.postMessage({ type: 'cancel', id });
    finishJob(id);
  }

  /** 소리 파일 받아쓰기 (16kHz Float32 로 풀어 옴) */
  function transcribe({ memoId, src, samples, onProgress }) {
    if (!ready('asr')) return Promise.reject(new Error('받아쓰기 데이터를 먼저 받아 주세요 (설정의 음성 녹음)'));
    const id = `f${seq++}`;
    const sd = speakerDir();
    return new Promise((resolve, reject) => {
      jobs.set(id, { lines: [], speakerDir: sd, memoId, src, resolve, reject, onProgress });
      ensureWorker().postMessage({ type: 'file', id, dirs: dirs(), samples, speaker: sd ? { dir: sd } : null }, [samples.buffer]);
    });
  }

  /** 이 메모의 받아쓰기(말한 사람 나누기 포함)가 아직 끝나지 않았는가 */
  const pendingFor = (memoId) => [...jobs.values()].some((j) => j.memoId === memoId);

  return {
    status, download, remove, start, audio, stop, cancel, transcribe, ready, pendingFor,
    emit,
    close: () => worker?.terminate(),
  };
}
