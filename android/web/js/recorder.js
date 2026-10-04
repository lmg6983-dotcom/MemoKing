// 녹음 · 받아쓰기 (휴대폰) — 녹음은 앱(RecorderService.kt)이 화면이 꺼져도 계속하고, 여기서는 보여 주기만.
//   시작: 메모 화면의 🎙 또는 목록 + › 음성 메모. 녹음하는 동안 시간·받아쓴 글이 보이고(잠시 멈춤·끝내기),
//   끝내면 소리 파일(.m4a)과 받아쓴 글이 그 메모에 들어간다. 알림에서 끝내도(앱이 꺼져 있어도) 다음에 열 때 들어간다.
import { app } from './state.js';
import { native, call, on, record } from './native.js';
import { toast } from './ui.js';

const $ = (x) => document.getElementById(x);
const el = {
  panel: $('rec-panel'),
  time: $('rec-time'),
  state: $('rec-state'),
  text: $('rec-text'),
  pause: $('rec-pause'),
  stop: $('rec-stop'),
  pill: null,
};

const STT_KEY = 'memoking.recordStt';
export const sttOn = () => {
  try {
    return localStorage.getItem(STT_KEY) !== 'off';
  } catch {
    return true;
  }
};
export function setStt(on) {
  try {
    localStorage.setItem(STT_KEY, on ? 'on' : 'off');
  } catch {
    // 이번에만
  }
}

const ENGINE_KEY = 'memoking.sttEngine';
export const sttEngine = () => {
  try {
    return localStorage.getItem(ENGINE_KEY) === 'system' ? 'system' : 'vosk';
  } catch {
    return 'vosk';
  }
};
export function setSttEngine(engine) {
  try {
    localStorage.setItem(ENGINE_KEY, engine);
  } catch {
    // 이번에만
  }
}

/** { model: 'ready'|'missing'|'downloading', progress, modelSize, system } */
export function sttStatus() {
  try {
    return native.sttStatus() ?? {};
  } catch {
    return {};
  }
}
/** 지금 고른 엔진으로 받아쓸 준비가 됐나 */
export const sttReady = () => (sttEngine() === 'system' ? Boolean(sttStatus().system) : sttStatus().model === 'ready');

let downloading = null;
/** Vosk 한국어 모델 받기 (약 87MB, 한 번만) — 진행은 on('sttModel') */
export function downloadModel() {
  downloading ??= call('sttModel', {})
    .then((st) => {
      toast('받아쓰기 모델을 받았어요. 이제 인터넷 없이 받아써요');
      return st;
    })
    .catch((err) => {
      toast(err.message || '모델을 받지 못했어요. 인터넷 연결을 확인해 주세요', true);
      throw err;
    })
    .finally(() => (downloading = null));
  return downloading;
}

let status = { active: false, paused: false, memoId: null, elapsedMs: 0, stt: false, text: '', partial: '' };
let attached = null; // 지금 열린 메모 id
let tickBase = { at: 0, elapsed: 0 };
let ticker = 0;
let stopping = false;

const pad = (n) => String(n).padStart(2, '0');
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function elapsed() {
  if (!status.active) return status.elapsedMs;
  return status.paused ? tickBase.elapsed : tickBase.elapsed + (Date.now() - tickBase.at);
}

function render() {
  const show = status.active && attached && attached === status.memoId;
  el.panel.hidden = !show;
  document.getElementById('note-screen').classList.toggle('recording', Boolean(status.active && attached === status.memoId));
  for (const b of document.querySelectorAll('[data-action="record"]')) {
    b.classList.toggle('active', Boolean(status.active && attached === status.memoId));
    b.setAttribute('aria-label', status.active ? '녹음 끝내기' : '녹음 · 받아쓰기');
  }
  renderPill();
  if (!show) return;
  el.time.textContent = formatDuration(elapsed());
  el.state.textContent = status.paused ? '잠시 멈춤' : status.stt ? '녹음 · 받아쓰는 중' : '녹음 중';
  el.panel.classList.toggle('paused', status.paused);
  el.pause.replaceChildren(svg(status.paused ? 'play' : 'pause'));
  el.pause.setAttribute('aria-label', status.paused ? '이어서 녹음' : '잠시 멈춤');
  const text = status.text || '';
  el.text.hidden = !status.stt && !text;
  el.text.replaceChildren();
  if (text) el.text.append(text);
  if (status.partial) {
    const span = document.createElement('span');
    span.className = 'rec-partial';
    span.textContent = `${text ? ' ' : ''}${status.partial}`;
    el.text.append(span);
  }
  if (!text && !status.partial) {
    const span = document.createElement('span');
    span.className = 'rec-hint';
    span.textContent = status.stt ? '말하면 여기에 글로 나타나요' : '받아쓰기 없이 녹음만 해요';
    el.text.append(span);
  }
  el.text.scrollTop = el.text.scrollHeight;
}

function svg(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  s.append(use);
  return s;
}

// 목록 화면에서도 녹음 중임을 (+ 버튼 위 작은 알약, 누르면 그 메모로)
function renderPill() {
  if (!el.pill) {
    el.pill = document.createElement('button');
    el.pill.className = 'rec-pill';
    el.pill.addEventListener('click', () => status.memoId && app.openMemo(status.memoId));
    $('list-screen').append(el.pill);
  }
  const show = status.active && attached !== status.memoId;
  el.pill.hidden = !show;
  if (show) {
    el.pill.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'rec-dot';
    el.pill.append(dot, `${status.paused ? '멈춤' : '녹음 중'} ${formatDuration(elapsed())}`);
  }
}

function setStatus(next) {
  const was = status.active;
  status = { ...status, ...next };
  tickBase = { at: Date.now(), elapsed: status.elapsedMs ?? 0 };
  clearInterval(ticker);
  if (status.active) ticker = setInterval(render, 500);
  if (was && !status.active) el.panel.hidden = true;
  render();
}

export const isRecording = () => status.active;
export const recordingMemo = () => (status.active ? status.memoId : null);

export function attach(memoId) {
  attached = memoId;
  render();
}
export function detach() {
  attached = null;
  render();
}

export async function start(memoId) {
  if (!memoId) return;
  if (status.active) {
    if (status.memoId !== memoId) toast('다른 메모에서 녹음하고 있어요. 그 녹음을 먼저 끝내 주세요', true);
    return;
  }
  try {
    if (!(await call('micPermission'))) {
      toast('녹음하려면 마이크를 허용해 주세요 (휴대폰 설정 › 앱 › 메모킹 › 권한)', true);
      return;
    }
    const res = await call('recordStart', { memoId, stt: sttOn(), engine: sttEngine() });
    setStatus({ active: true, paused: false, memoId, elapsedMs: 0, stt: Boolean(res?.stt), text: '', partial: '' });
    navigator.vibrate?.(20);
    if (sttOn() && !res?.stt) {
      // 모델이 없으면 녹음은 그대로 하면서 받아 두고, 끝내면 녹음 파일로 받아쓴다
      if (sttEngine() === 'vosk' && sttStatus().model !== 'ready') {
        toast(`받아쓰기 모델(${sttStatus().modelSize ?? '약 87MB'})이 필요해요. 녹음은 계속돼요`, false, { label: '지금 받기', run: () => downloadModel().catch(() => {}) });
      } else toast(res?.reason || '받아쓰기를 할 수 없어 녹음만 해요');
    }
    document.activeElement?.blur();
  } catch (err) {
    toast(err.message || '녹음을 시작하지 못했어요', true);
  }
}

export async function stop() {
  if (!status.active || stopping) return;
  stopping = true;
  el.stop.disabled = true;
  try {
    const result = await call('recordStop');
    setStatus({ active: false, paused: false, partial: '' });
    if (result) {
      await app.deliverRecording(result);
      record.ack(result.id);
    }
  } catch (err) {
    toast(err.message || '녹음을 끝내지 못했어요', true);
  } finally {
    stopping = false;
    el.stop.disabled = false;
  }
}

export function toggle() {
  if (status.active && status.memoId === attached) return stop();
  return start(attached);
}

el.stop.addEventListener('click', () => stop());
el.pause.addEventListener('click', () => {
  try {
    const next = status.paused ? record.resume() : record.pause();
    if (next) setStatus(next);
  } catch (err) {
    toast(err.message, true);
  }
});
for (const b of [el.stop, el.pause]) b.addEventListener('mousedown', (e) => e.preventDefault());

// 앱이 보내는 소식: 시간·받아쓴 글·상태, 알림에서 끝냈을 때의 결과
on('record', (ev) => {
  if (!ev) return;
  if (ev.type === 'done') {
    setStatus({ active: false, paused: false, partial: '' });
    if (ev.result) app.deliverRecording(ev.result).then(() => record.ack(ev.result.id)).catch(() => {});
    return;
  }
  if (ev.type === 'error') {
    toast(ev.message || '녹음 중 문제가 생겼어요', true);
    return;
  }
  setStatus(ev.status ?? {});
});

/** 앱을 다시 열었을 때: 녹음이 아직 도는지, 꺼져 있는 동안 끝난 녹음이 있는지 */
export async function resume() {
  let st = null;
  try {
    st = record.status();
  } catch {
    return; // 미리보기 등
  }
  if (st) setStatus(st);
  let done = [];
  try {
    done = record.takeDone() ?? [];
  } catch {
    done = [];
  }
  for (const result of done) {
    try {
      await app.deliverRecording(result);
      record.ack(result.id);
    } catch (err) {
      console.warn('녹음을 메모에 넣지 못했어요', err);
    }
  }
}

export const nativeInfo = () => {
  try {
    return native.info().record ?? {};
  } catch {
    return {};
  }
};
