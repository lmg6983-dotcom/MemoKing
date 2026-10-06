// 음성 메모 녹음 (PC 메모 창) — 마이크로 녹음하고, 끝내면 소리 파일을 메모 폴더에 저장해 음성 카드로 넣는다.
//   휴대폰과 같은 모양: 녹음 중에는 위쪽 막대에 빨간 점 · 시간 · 소리 크기 · 잠시 멈춤 · 끝내기.
//   파일은 m4a(가능하면) 또는 weba(WebM 소리) — 휴대폰·다른 PC 에서도 그대로 재생된다.
//   받아쓰기(글로 옮기기)는 아직 휴대폰에서만.
import { voiceCardMarkdown, recordingClock, recordingWhen } from './core/voice-card.js';

// 앞에서부터 이 PC 의 녹음기가 만들 수 있는 것 — MP4(AAC, 없으면 Opus)는 길이가 바로 보여 끌어서 넘기기 쉽다.
// WebM 은 녹음기가 길이를 적지 않아 마지막 수단
const FORMATS = [
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },
  { mime: 'audio/mp4;codecs=opus', ext: 'm4a' },
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/webm;codecs=opus', ext: 'weba' },
  { mime: 'audio/webm', ext: 'weba' },
];

export function pickFormat(isSupported = (m) => globalThis.MediaRecorder?.isTypeSupported?.(m)) {
  return FORMATS.find((f) => isSupported(f.mime)) ?? null;
}

/** 마이크를 못 쓸 때 사람이 알아듣는 말로 */
export function micErrorText(err) {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '마이크를 쓸 수 없어요. Windows 설정 › 개인 정보 › 마이크에서 앱의 마이크 사용을 켜 주세요';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '마이크를 찾지 못했어요. 마이크가 연결돼 있는지 확인해 주세요';
  if (name === 'NotReadableError') return '다른 프로그램이 마이크를 쓰고 있어요. 그 프로그램을 끄고 다시 해 주세요';
  return '녹음을 시작하지 못했어요';
}

/**
 * @param {{ panel: HTMLElement, time: HTMLElement, state: HTMLElement, wave: HTMLElement, pause: HTMLElement, stop: HTMLElement,
 *           buttons: () => Iterable<HTMLElement>, saveAudio: (bytes: Uint8Array, ext: string) => Promise<string>,
 *           insert: (cardMarkdown: string, heading: string) => void | Promise<void>, notice: (text: string, isError?: boolean) => void,
 *           onChange?: (active: boolean) => void }} opts
 */
export function setupVoiceRecorder(opts) {
  const { panel, time, state, wave, pause, stop } = opts;
  let rec = null; // { recorder, stream, chunks, format, startedAt, elapsed, resumedAt, paused, audio, timer }
  let finishing = null;

  const elapsed = () => (rec ? rec.elapsed + (rec.paused ? 0 : Date.now() - rec.resumedAt) : 0);

  function render() {
    const on = Boolean(rec);
    panel.hidden = !on;
    document.body.classList.toggle('recording', on);
    for (const b of opts.buttons()) {
      b.classList.toggle('active', on);
      const label = on ? '녹음 끝내기 (Ctrl+Shift+R)' : '음성 녹음 (Ctrl+Shift+R)';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', String(on));
    }
    if (!on) return;
    time.textContent = recordingClock(elapsed());
    state.textContent = rec.paused ? '일시 정지' : '녹음 중';
    panel.classList.toggle('paused', rec.paused);
    pause.replaceChildren(svg(rec.paused ? 'play' : 'pause'));
    const label = rec.paused ? '이어서 녹음' : '일시 정지';
    pause.title = label;
    pause.setAttribute('aria-label', label);
  }

  // 소리 크기 막대: 새 크기가 오른쪽에서 들어와 왼쪽으로 흘러간다 (말하면 출렁)
  const levels = Array(7).fill(0);
  function meter() {
    if (!rec?.audio) return;
    const { analyser, data } = rec.audio;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    const level = rec.paused ? 0 : Math.min(1, Math.sqrt(sum / data.length) * 4);
    levels.shift();
    levels.push(level);
    [...wave.children].forEach((bar, i) => bar.style.setProperty('--lv', levels[i].toFixed(2)));
  }

  async function start() {
    if (rec || finishing) return;
    const format = pickFormat();
    if (!format || !navigator.mediaDevices?.getUserMedia) {
      opts.notice('이 PC 에서는 녹음할 수 없어요', true);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      opts.notice(micErrorText(err), true);
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: format.mime, audioBitsPerSecond: 64_000 });
    const chunks = [];
    recorder.addEventListener('dataavailable', (e) => e.data?.size && chunks.push(e.data));
    let audio = null;
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audio = { ctx, analyser, data: new Uint8Array(analyser.fftSize) };
    } catch {
      // 소리 크기 막대 없이 녹음만
    }
    const now = Date.now();
    rec = { recorder, stream, chunks, format, startedAt: now, elapsed: 0, resumedAt: now, paused: false, audio };
    rec.timer = setInterval(() => {
      render();
    }, 500);
    rec.meter = setInterval(meter, 110);
    recorder.start(1000);
    render();
    opts.onChange?.(true);
  }

  function togglePause() {
    if (!rec) return;
    if (rec.paused) {
      rec.recorder.resume();
      rec.resumedAt = Date.now();
      rec.paused = false;
    } else {
      rec.recorder.pause();
      rec.elapsed += Date.now() - rec.resumedAt;
      rec.paused = true;
    }
    render();
  }

  /** 녹음을 끝내고 메모에 넣는다 (창을 닫기 전에도 불러 기다린다) */
  function finish() {
    if (finishing) return finishing;
    if (!rec) return Promise.resolve(null);
    const r = rec;
    const durationMs = elapsed();
    finishing = (async () => {
      stop.disabled = true;
      const stopped = new Promise((resolve) => r.recorder.addEventListener('stop', resolve, { once: true }));
      try {
        if (r.recorder.state !== 'inactive') r.recorder.stop();
        await stopped;
      } finally {
        clearInterval(r.timer);
        clearInterval(r.meter);
        for (const t of r.stream.getTracks()) t.stop();
        r.audio?.ctx.close().catch(() => {});
        rec = null;
        render();
        opts.onChange?.(false);
      }
      const blob = new Blob(r.chunks, { type: r.format.mime.split(';')[0] });
      if (!blob.size) {
        opts.notice('녹음된 소리가 없어요', true);
        return null;
      }
      const src = await opts.saveAudio(new Uint8Array(await blob.arrayBuffer()), r.format.ext);
      const when = recordingWhen(r.startedAt);
      const duration = recordingClock(durationMs);
      const card = voiceCardMarkdown({ alt: `녹음 ${when} · ${duration}`, src });
      await opts.insert(card, `음성 메모 · ${when}`);
      opts.notice(`녹음(${duration})을 저장했어요`);
      return src;
    })().catch((err) => {
      console.error(err);
      opts.notice('녹음을 저장하지 못했어요. 메모 폴더를 확인해 주세요', true);
      return null;
    }).finally(() => {
      finishing = null;
      stop.disabled = false;
    });
    return finishing;
  }

  pause.addEventListener('click', togglePause);
  stop.addEventListener('click', () => finish());
  for (const b of [pause, stop]) b.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서 유지
  render();

  return {
    start,
    finish,
    toggle: () => (rec ? finish() : start()),
    togglePause,
    get active() {
      return Boolean(rec);
    },
  };
}

function svg(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  s.append(use);
  return s;
}
