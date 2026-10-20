// 음성 메모 녹음 (PC 메모 창) — 마이크로 녹음하고, 끝내면 소리 파일을 메모 폴더에 저장해 음성 카드로 넣는다.
//   휴대폰과 같은 모양: 녹음 중에는 위쪽 막대에 빨간 점 · 시간 · 소리 크기 · 잠시 멈춤 · 끝내기.
//   파일은 m4a(가능하면) 또는 weba(WebM 소리) — 휴대폰·다른 PC 에서도 그대로 재생된다.
//   받아쓰기(켰고 데이터가 있으면): 녹음하는 소리를 16kHz 로 바꿔 메인 프로세스(desktop/stt)로 보내고,
//   한 문장이 끝날 때마다 패널에 글이 나타난다. 끝내면 소리와 받아쓴 글이 한 음성 카드로.
import { voiceCardMarkdown, recordingClock, recordingWhen } from './core/voice-card.js';
import { icon as svg } from './icons.js';

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
  if (name === 'NotAllowedError' || name === 'SecurityError') return '마이크를 쓸 수 없어요. Windows 설정 개인 정보의 마이크에서 앱의 마이크 사용을 켜 주세요';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '마이크를 찾지 못했어요. 마이크가 연결돼 있는지 확인해 주세요';
  if (name === 'NotReadableError') return '다른 프로그램이 마이크를 쓰고 있어요. 그 프로그램을 끄고 다시 해 주세요';
  return '녹음을 시작하지 못했어요';
}

/**
 * @param {{ panel: HTMLElement, time: HTMLElement, state: HTMLElement, wave: HTMLElement, pause: HTMLElement, stop: HTMLElement,
 *           buttons: () => Iterable<HTMLElement>, saveAudio: (bytes: Uint8Array, ext: string) => Promise<string>,
 *           insert: (cardMarkdown: string, heading: string) => void | Promise<void>, notice: (text: string, isError?: boolean) => void,
 *           onChange?: (active: boolean) => void, text?: HTMLElement,
 *           stt?: { start: () => Promise<{ stt: boolean, reason?: string, speaker?: boolean }>, audio: (samples: Float32Array) => void,
 *                   stop: (target: { src: string }) => Promise<{ text: string, speakers?: boolean, error?: string }>,
 *                   onLine: (fn: (text: string) => void) => void, onSpeaking: (fn: (on: boolean) => void) => void } }} opts
 */
export function setupVoiceRecorder(opts) {
  const { panel, time, state, wave, pause, stop } = opts;
  let rec = null; // { recorder, stream, chunks, format, startedAt, elapsed, resumedAt, paused, audio, timer }
  let finishing = null;
  const textBox = opts.text ?? null;

  // 받아쓴 글: 줄마다, 말하는 동안은 "듣는 중…"
  function renderText() {
    if (!textBox) return;
    textBox.hidden = !rec?.stt;
    if (!rec?.stt) return;
    textBox.replaceChildren();
    for (const line of rec.lines) {
      const div = document.createElement('div');
      div.textContent = line;
      textBox.append(div);
    }
    if (rec.speaking && !rec.paused) {
      const div = document.createElement('div');
      div.className = 'rec-listening';
      div.textContent = '듣는 중';
      textBox.append(div);
    } else if (!rec.lines.length) {
      const div = document.createElement('div');
      div.className = 'rec-hint';
      div.textContent = '말하면 여기에 글로 나타나요';
      textBox.append(div);
    }
    textBox.scrollTop = textBox.scrollHeight;
  }
  opts.stt?.onLine((text) => {
    if (!rec?.stt) return;
    rec.lines.push(text);
    renderText();
  });
  opts.stt?.onSpeaking((on) => {
    if (!rec?.stt) return;
    rec.speaking = on;
    renderText();
  });

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
    state.textContent = rec.paused ? '일시 정지' : rec.stt ? '받아쓰는 중' : '녹음 중';
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
      // 16kHz: 받아쓰기 엔진이 듣는 빠르기 (소리 크기 막대도 같은 곳에서)
      const ctx = new AudioContext({ sampleRate: 16000 });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      audio = { ctx, analyser, source, data: new Uint8Array(analyser.fftSize) };
    } catch {
      // 소리 크기 막대 없이 녹음만
    }
    const now = Date.now();
    rec = { recorder, stream, chunks, format, startedAt: now, elapsed: 0, resumedAt: now, paused: false, audio, stt: false, lines: [], speaking: false };
    const r = rec;
    rec.timer = setInterval(() => {
      render();
    }, 500);
    rec.meter = setInterval(meter, 110);
    recorder.start(1000);
    render();
    opts.onChange?.(true);
    // 받아쓰기: 켰고 데이터가 있으면 녹음하는 소리를 그대로 보낸다 (잠시 멈춘 동안은 보내지 않음)
    if (opts.stt && audio) {
      try {
        const st = await opts.stt.start();
        if (st?.stt && rec === r) {
          await audio.ctx.audioWorklet.addModule(new URL('./pcm-tap-worklet.js', import.meta.url));
          const tap = new AudioWorkletNode(audio.ctx, 'pcm-tap', { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
          const mute = audio.ctx.createGain();
          mute.gain.value = 0;
          audio.source.connect(tap).connect(mute).connect(audio.ctx.destination);
          tap.port.onmessage = (e) => {
            if (rec === r && !r.paused) opts.stt.audio(e.data);
          };
          r.stt = true;
          r.speaker = Boolean(st.speaker);
          render();
          renderText();
        } else if (st?.stt) {
          opts.stt.stop({ src: '' }).catch(() => {}); // 받아쓰기가 시작되기 전에 녹음을 끝냄 — 메인 쪽 작업도 거둔다
        } else if (st?.reason === 'missing') {
          opts.notice('받아쓰기 데이터가 없어 녹음만 해요. 목록 창 설정의 음성 녹음에서 받을 수 있어요');
        }
      } catch (err) {
        console.error(err);
        opts.notice('받아쓰기를 시작하지 못해 녹음만 해요', true);
      }
    }
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
    renderText();
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
        renderText();
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
      let text = '';
      let speakers = false;
      if (r.stt) {
        opts.notice('받아쓴 글을 마무리하는 중');
        const t = await opts.stt.stop({ src });
        text = t?.text ?? '';
        speakers = Boolean(t?.speakers);
        if (t?.error) console.warn('받아쓰기:', t.error);
      }
      const card = voiceCardMarkdown({ alt: `녹음 ${when} (${duration})`, src }, text);
      await opts.insert(card, `음성 메모 ${when}`);
      opts.notice(text
        ? `녹음(${duration})과 받아쓴 글을 저장했어요${speakers ? '. 말한 사람을 나누는 중' : ''}`
        : `녹음(${duration})을 저장했어요${r.stt ? '. 알아들은 말이 없어요' : ''}`);
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
