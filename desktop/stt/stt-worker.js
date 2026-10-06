// 받아쓰기 작업 스레드 (PC) — 메인 프로세스가 띄우고, 무거운 일은 모두 여기서 (창·메인이 멈추지 않게)
//   엔진: 오픈소스 sherpa-onnx (k2-fsa, Apache-2.0) 의 WebAssembly 판 — 인터넷 없이 이 PC 안에서만
//   - 말소리 구간 나누기: Silero VAD — 0.5초 쉬면 한 문장, 15초 넘게 이어지면 끊어서
//   - 받아쓰기: 한국어 Zipformer (KsponSpeech 로 학습, 문장부호까지) — 구간마다 바로 (녹음하는 동안 글이 나타남).
//     구간 앞뒤로 조금(0.3초·0.15초) 더 붙여 첫 글자가 잘리지 않게, 띄어쓰기는 낱말 경계 표시(▁)로
//   - 말한 사람 나누기 (켰을 때, 녹음이 끝난 뒤): pyannote 구간 + CAM++ 목소리 특징으로 사람마다 묶기
//   - 받은 모델 압축(.tar.bz2) 풀기
// 주고받는 말: { type, id, ... } — 자세한 것은 아래 handlers
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SpeechConditioner, tokensToText } from '../../app/js/core/transcript-lines.js';

const require = createRequire(import.meta.url);
const RATE = 16000;
const WINDOW = 512; // VAD 가 한 번에 보는 소리 (32ms)

let sherpa = null;
const engine = () => (sherpa ??= require(path.join(workerData.vendor, 'sherpa-onnx')));

let recognizer = null; // { dir, rec }
let diarizer = null; // { dir, sd }
const sessions = new Map(); // id → { vad, cond, pending: Float32Array, raw: Int16Array[], rawLength, lines, speaking, dirs }

const post = (msg) => parentPort.postMessage(msg);

function loadRecognizer(dir) {
  if (recognizer?.dir === dir) return recognizer.rec;
  recognizer?.rec.free?.();
  const rec = engine().createOfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, 'encoder.onnx'), decoder: path.join(dir, 'decoder.onnx'), joiner: path.join(dir, 'joiner.onnx') },
      tokens: path.join(dir, 'tokens.txt'),
      modelType: 'transducer',
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
    },
    decodingMethod: 'greedy_search',
  });
  recognizer = { dir, rec };
  return rec;
}

function loadDiarizer(dir) {
  if (diarizer?.dir === dir) return diarizer.sd;
  diarizer?.sd.free?.();
  const sd = engine().createOfflineSpeakerDiarization({
    segmentation: { pyannote: { model: path.join(dir, 'segmentation.onnx') } },
    embedding: { model: path.join(dir, 'embedding.onnx') },
    clustering: { numClusters: -1, threshold: 0.5 },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  });
  diarizer = { dir, sd };
  return sd;
}

function createVad(dir) {
  return engine().createVad({
    sileroVad: {
      model: path.join(dir, 'silero_vad.onnx'),
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 15,
      windowSize: WINDOW,
    },
    sampleRate: RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 60,
  });
}

// 받아쓴 글이 문장부호·군말 하나뿐이면 버린다
const meaningful = (text) => /[\p{L}\p{N}]/u.test(text);

const PRE = Math.round(RATE * 0.3); // 구간 앞에 더 붙일 소리
const POST = Math.round(RATE * 0.15);
const KEEP = RATE * 40; // 앞뒤를 붙이려고 기억해 두는 최근 소리

function decode(rec, samples) {
  const stream = rec.createStream();
  try {
    stream.acceptWaveform(RATE, samples);
    rec.decode(stream);
    const r = rec.getResult(stream);
    return tokensToText(r?.tokens, r?.text);
  } finally {
    stream.free?.();
  }
}

// 기억해 둔 소리에서 [from, to) 를 꺼낸다 (절대 위치, 표본 단위)
function slice(s, from, to) {
  const out = new Float32Array(Math.max(0, to - from));
  for (const c of s.hist) {
    const a = Math.max(from, c.at);
    const b = Math.min(to, c.at + c.data.length);
    if (a < b) out.set(c.data.subarray(a - c.at, b - c.at), a - from);
  }
  return out;
}

/** VAD 가 끊어 둔 구간들을 받아쓴다 → 줄 */
function drain(id, s) {
  while (!s.vad.isEmpty()) {
    const seg = s.vad.front();
    s.vad.pop();
    const end = seg.start + seg.samples.length;
    const from = Math.max(seg.start - PRE, s.lastEnd, s.fed - KEEP, 0);
    const to = Math.min(end + POST, s.fed);
    s.lastEnd = end;
    const text = decode(loadRecognizer(s.dirs.asr), from < seg.start || to > end ? slice(s, from, to) : seg.samples);
    if (!meaningful(text)) continue;
    const line = { text, start: seg.start / RATE, end: end / RATE };
    s.lines.push(line);
    post({ type: 'line', id, ...line });
  }
  const speaking = s.vad.isDetected();
  if (speaking !== s.speaking) {
    s.speaking = speaking;
    post({ type: 'speaking', id, on: speaking });
  }
}

function feed(id, s, chunk) {
  if (s.keepRaw) {
    const raw = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) raw[i] = Math.max(-32768, Math.min(32767, Math.round(chunk[i] * 32767)));
    s.raw.push(raw);
    s.rawLength += raw.length;
  }
  const x = s.cond.process(Float32Array.from(chunk));
  s.hist.push({ at: s.fed, data: x });
  s.fed += x.length;
  while (s.hist.length > 1 && s.hist[1].at < s.fed - KEEP) s.hist.shift();
  let buf = s.pending.length ? concat([s.pending, x]) : x;
  let at = 0;
  for (; at + WINDOW <= buf.length; at += WINDOW) s.vad.acceptWaveform(buf.subarray(at, at + WINDOW));
  s.pending = buf.slice(at);
  drain(id, s);
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function rawSamples(s) {
  const out = new Float32Array(s.rawLength);
  let o = 0;
  for (const r of s.raw) {
    for (let i = 0; i < r.length; i++) out[o + i] = r[i] / 32768;
    o += r.length;
  }
  return out;
}

function begin(id, { dirs, speaker }) {
  end(id);
  const s = {
    vad: createVad(dirs.vad), cond: new SpeechConditioner(RATE), pending: new Float32Array(0), hist: [], fed: 0, lastEnd: 0,
    raw: [], rawLength: 0, lines: [], speaking: false, dirs, keepRaw: Boolean(speaker),
  };
  loadRecognizer(dirs.asr); // 첫 구간에서 기다리지 않게 미리
  sessions.set(id, s);
  return s;
}

function end(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.vad.free?.();
  sessions.delete(id);
}

/** 남은 소리까지 받아쓰고 끝낸다 → 줄 · (켰으면) 이어서 말한 사람 나누기 */
function finish(id, s, { speaker }) {
  if (s.pending.length) {
    const tail = new Float32Array(WINDOW);
    tail.set(s.pending.subarray(0, WINDOW));
    s.vad.acceptWaveform(tail);
    s.pending = new Float32Array(0);
  }
  s.vad.flush();
  drain(id, s);
  post({ type: 'done', id, lines: s.lines, seconds: s.rawLength / RATE });
  const samples = speaker?.dir && s.keepRaw && s.lines.length && s.rawLength > RATE * 2 ? rawSamples(s) : null;
  end(id);
  if (!samples) return;
  try {
    post({ type: 'progress', id, stage: 'speakers' });
    const segments = loadDiarizer(speaker.dir).process(samples).map((g) => ({ start: g.start, end: g.end, speaker: g.speaker }));
    post({ type: 'speakers', id, segments });
  } catch (err) {
    post({ type: 'error', id, stage: 'speakers', message: String(err?.message ?? err) });
  }
}

// ---------- 모델 압축 풀기 (.tar.bz2) — PC 의 tar 가 되면 그것으로, 안 되면 직접 ----------

function systemTar(archive, dest) {
  return new Promise((resolve) => {
    execFile('tar', ['-xjf', archive, '-C', dest], { windowsHide: true, timeout: 10 * 60_000 }, (err) => resolve(!err));
  });
}

function untar(buf, onFile) {
  let at = 0;
  let longName = null;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const body = buf.subarray(at + 512, at + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '\0' || type === '7') onFile(name, body);
    at += 512 + Math.ceil(size / 512) * 512;
  }
}

async function extract({ archive, dest, files }) {
  // files: { '압축 안 이름(끝부분)': '저장할 이름' }
  const want = Object.entries(files);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-stt-'));
  try {
    const found = new Map();
    if (await systemTar(archive, tmp)) {
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else for (const [tail, to] of want) if (p.replaceAll('\\', '/').endsWith(`/${tail}`)) found.set(to, p);
        }
      };
      walk(tmp);
    }
    if (found.size < want.length) {
      found.clear();
      const bunzip = require(path.join(workerData.vendor, 'seek-bzip', 'index.js'));
      const tar = bunzip.decode(fs.readFileSync(archive));
      untar(tar, (name, body) => {
        for (const [tail, to] of want) {
          if (name === tail || name.endsWith(`/${tail}`)) {
            const p = path.join(tmp, `${to}.out`);
            fs.writeFileSync(p, body);
            found.set(to, p);
          }
        }
      });
    }
    const missing = want.filter(([, to]) => !found.has(to)).map(([tail]) => tail);
    if (missing.length) throw new Error(`압축 안에 ${missing.join(', ')} 이(가) 없어요`);
    fs.mkdirSync(dest, { recursive: true });
    for (const [to, p] of found) fs.copyFileSync(p, path.join(dest, to));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- 주고받기 ----------

const handlers = {
  // 녹음 받아쓰기: start → audio(16kHz Float32 조각) … → stop
  start: (m) => {
    begin(m.id, m);
    post({ type: 'started', id: m.id });
  },
  audio: (m) => {
    const s = sessions.get(m.id);
    if (s) feed(m.id, s, m.samples);
  },
  stop: (m) => {
    const s = sessions.get(m.id);
    if (!s) return post({ type: 'done', id: m.id, lines: [], seconds: 0 });
    finish(m.id, s, m);
  },
  cancel: (m) => end(m.id),
  // 소리 파일 받아쓰기 (이미 16kHz Float32 로 풀어 옴): 같은 길로 한 번에
  file: (m) => {
    const s = begin(m.id, m);
    const step = RATE * 10;
    for (let at = 0; at < m.samples.length; at += step) {
      feed(m.id, s, m.samples.subarray(at, at + step));
      post({ type: 'progress', id: m.id, stage: 'transcribe', pct: Math.min(100, Math.round(((at + step) / m.samples.length) * 100)) });
    }
    finish(m.id, s, m);
  },
  extract: async (m) => {
    await extract(m);
    post({ type: 'extracted', id: m.id });
  },
};

parentPort.on('message', async (m) => {
  try {
    await handlers[m.type]?.(m);
  } catch (err) {
    post({ type: 'error', id: m.id, stage: m.type, message: String(err?.message ?? err) });
  }
});
