// 녹음 · 받아쓰기 (휴대폰) — 녹음은 앱(RecorderService.kt)이 화면이 꺼져도 계속하고, 여기서는 보여 주기만.
//   시작: 메모 화면의 🎙 또는 목록 + › 음성 메모. 녹음하는 동안 시간·받아쓴 글이 보이고(잠시 멈춤·끝내기),
//   끝내면 소리 파일(.m4a)과 받아쓴 글이 그 메모에 들어간다. 알림에서 끝내도(앱이 꺼져 있어도) 다음에 열 때 들어간다.
import { app } from './state.js';
import { native, call, on, record } from './native.js';
import { toast } from './ui.js';
import { recordingClock as formatDuration } from '../../app/js/core/voice-card.js';
import { haptic } from '../../app/js/dom.js';
import { icon as svg } from '../../app/js/icons.js';
import { UI } from '../../app/js/core/ui-text.js';

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

/** { system: 휴대폰 Google 음성 인식을 쓸 수 있나 (안드로이드 13+) } */
export function sttStatus() {
  try {
    return native.sttStatus() ?? {};
  } catch {
    return {};
  }
}
/** 받아쓸 수 있나 — 휴대폰의 Google 음성 인식만 쓴다 (따로 받을 데이터 없음) */
export const sttReady = () => Boolean(sttStatus().system);

let status = { active: false, paused: false, memoId: null, elapsedMs: 0, stt: false, text: '', partial: '' };
let attached = null; // 지금 열린 메모 id
let tickBase = { at: 0, elapsed: 0 };
let ticker = 0;
let stopping = false;

export { recordingClock as formatDuration } from '../../app/js/core/voice-card.js';

function elapsed() {
  if (!status.active) return status.elapsedMs;
  return status.paused ? tickBase.elapsed : tickBase.elapsed + (Date.now() - tickBase.at);
}

function render() {
  const show = status.active && attached && attached === status.memoId;
  el.panel.hidden = !show;
  document.getElementById('note-screen').classList.toggle('recording', Boolean(status.active && attached === status.memoId));
  const here = Boolean(status.active && attached === status.memoId);
  for (const b of document.querySelectorAll('[data-action="record"]')) {
    b.classList.toggle('active', here);
    b.setAttribute('aria-label', status.active ? '녹음 끝내기' : '녹음');
    const label = b.querySelector('.add-sat-label');
    if (label) label.textContent = here ? '녹음 끝내기' : '음성 녹음';
  }
  document.getElementById('add-btn')?.classList.toggle('recording', here); // + 단추에 녹음 중 빨간 점
  renderPill();
  if (!show) return;
  el.time.textContent = formatDuration(elapsed());
  el.state.textContent = status.paused ? '일시 정지' : status.stt ? UI.transcribing : '녹음 중'; // 짧게 (빨간 점·시간이 녹음 중임을 알린다)
  el.panel.classList.toggle('paused', status.paused);
  el.pause.replaceChildren(svg(status.paused ? 'play' : 'pause'));
  el.pause.setAttribute('aria-label', status.paused ? UI.recordMore : '일시 정지');
  const text = status.text || '';
  el.text.hidden = !status.stt && !text;
  el.text.replaceChildren();
  if (text) renderLines(el.text, text);
  if (status.partial) {
    const span = document.createElement('span');
    span.className = 'rec-partial';
    span.textContent = `${text ? '\n' : ''}${status.partial}`;
    el.text.append(span);
  }
  if (!text && !status.partial) {
    const span = document.createElement('span');
    span.className = 'rec-hint';
    span.textContent = status.stt ? UI.speakHint : '녹음만 하고 있어요';
    el.text.append(span);
  }
  el.text.scrollTop = el.text.scrollHeight;
}

// 소리 크기 막대: 새 크기가 오른쪽에서 들어와 왼쪽으로 흘러간다 (말하면 출렁)
const levels = Array(7).fill(0);
function showLevel(level) {
  levels.shift();
  levels.push(status.paused ? 0 : level);
  const bars = $('rec-wave')?.children ?? [];
  for (let i = 0; i < bars.length; i++) bars[i].style.setProperty('--lv', levels[i].toFixed(2));
}

// 받아쓴 글: 줄마다, "화자 N:" 은 색 이름표로
function renderLines(box, text) {
  for (const [i, line] of text.split('\n').entries()) {
    if (i) box.append('\n');
    const m = line.match(/^화자\s*(\d+)\s*:\s*/);
    if (m) {
      const chip = document.createElement('span');
      chip.className = `rec-spk mk-spk-${(Number(m[1]) - 1) % 6}`;
      chip.textContent = `화자 ${m[1]}`;
      box.append(chip, line.slice(m[0].length));
    } else box.append(line);
  }
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

/** 녹음 중인 메모 (없으면 null) */
export const recordingFor = () => (status.active ? status.memoId : null);

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
    if (status.memoId !== memoId) toast('다른 메모에서 녹음 중이에요. 먼저 끝내 주세요', true);
    return;
  }
  try {
    if (!(await call('micPermission'))) {
      toast('녹음하려면 마이크 권한을 허용해 주세요', true);
      return;
    }
    const res = await call('recordStart', { memoId, stt: sttOn(), terms: app.sttTerms?.() ?? [] });
    setStatus({ active: true, paused: false, memoId, elapsedMs: 0, stt: Boolean(res?.stt), text: '', partial: '' });
    haptic(20);
    if (sttOn() && !res?.stt) toast(res?.reason || '받아쓰기를 쓸 수 없어 녹음만 해요');
    document.activeElement?.blur();
  } catch (err) {
    toast(err.message || UI.recordFail, true);
  }
}

// 화면이 막 바뀐 때(다루기 방식을 바꿔 도구막대가 생기는 등)는 "끝내기" 가 손가락 밑으로 밀려올 수 있다 —
//   그 순간의 누름으로 회의 녹음이 끝나 버리지 않게 잠깐 받지 않는다
let holdUntil = 0;
export function holdStop(ms = 600) {
  holdUntil = performance.now() + ms;
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

el.stop.addEventListener('click', () => {
  if (performance.now() < holdUntil) return;
  stop();
});
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
    // 앱에서 끝내는 중이면 그쪽(stop)이 같은 결과를 넣는다
    if (ev.result && !stopping) app.deliverRecording(ev.result).then(() => record.ack(ev.result.id)).catch(() => {});
    return;
  }
  if (ev.type === 'level') {
    showLevel(ev.level ?? 0);
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
