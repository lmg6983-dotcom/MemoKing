// 정확하게 다시 받아쓰기(Whisper) · 말한 사람 구분 — 앱(Pro.kt, sherpa-onnx)이 화면을 꺼도 끝까지 하고, 여기서는 고르기·진행·결과 넣기.
//   메모 메뉴 › 정확하게 다시 받아쓰기 · 말한 사람 구분 (녹음이 든 메모), 또는 설정에서 "녹음을 끝내면 저절로".
//   결과는 그 녹음 줄 바로 아래에 **화자 1** (00:00) … 으로.
import { app } from './state.js';
import { call, on, pro } from './native.js';
import { openSheet, closeSheet, toast, confirmDialog } from './ui.js';
import { audioSources } from '../../app/js/core/transcript-format.js';

const $ = (x) => document.getElementById(x);
const sheet = $('pro-sheet');
const MODEL_KEYS = ['whisper', 'diarize'];
let sheetFor = null; // { memoId, sources }
let pollTimer = 0;
const delivered = new Set();

const AUTO_KEY = 'memoking.autoPro';
export const autoOn = () => {
  try {
    return localStorage.getItem(AUTO_KEY) === 'on';
  } catch {
    return false;
  }
};
export function setAuto(on) {
  try {
    localStorage.setItem(AUTO_KEY, on ? 'on' : 'off');
  } catch {
    // 이번에만
  }
}

export function status() {
  try {
    return pro.status() ?? {};
  } catch {
    return {};
  }
}
const needed = (diarize) => (diarize ? MODEL_KEYS : ['whisper']);
const missing = (st, diarize) => needed(diarize).filter((k) => st[k]?.state !== 'ready');
export const ready = (diarize = true) => Boolean(status().available) && missing(status(), diarize).length === 0;
export const hasAudio = (body) => audioSources(body).length > 0;

// ---------- 시트 ----------

const STAGES = { decode: '소리 파일 읽는 중', load: '모델 불러오는 중', diarize: '말한 사람 나누는 중', transcribe: '받아쓰는 중' };

function renderModels(st, live = {}) {
  const diarize = $('pro-diarize').checked;
  $('pro-models').replaceChildren(...needed(diarize).map((key) => {
    const m = st[key] ?? {};
    const li = document.createElement('li');
    li.className = `pro-model ${m.state ?? 'missing'}`;
    const text = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = m.label ?? key;
    const small = document.createElement('small');
    const p = live[key] ?? (m.state === 'downloading' ? m.progress : null);
    small.textContent = m.state === 'ready' ? '받아 둠' : p != null && p >= 0 ? `받는 중 ${p}%` : `${m.size ?? ''} · 아직 안 받음`;
    text.append(b, small);
    li.append(text);
    if (m.state === 'ready') {
      const del = document.createElement('button');
      del.className = 'link-btn';
      del.textContent = '지우기';
      del.addEventListener('click', async () => {
        if (!(await confirmDialog(`${m.label} 모델을 지울까요?\n다시 쓰려면 다시 받아야 해요.`, '지우기'))) return;
        await call('proModels', { delete: key }).catch((err) => toast(err.message, true));
        renderModels(status());
      });
      li.append(del);
    }
    return li;
  }));
}

function renderProgress(busy) {
  const box = $('pro-progress');
  box.hidden = !busy;
  $('pro-start').disabled = Boolean(busy);
  if (!busy) return;
  const p = Math.max(0, Math.min(100, busy.progress ?? 0));
  $('pro-bar-fill').style.width = `${p}%`;
  $('pro-progress-text').textContent = `${STAGES[busy.stage] ?? '받아쓰는 중'} ${p}% · 화면을 꺼도 계속해요`;
}

function render() {
  const st = status();
  $('pro-unavailable').hidden = st.available !== false;
  $('pro-speakers-row').hidden = !$('pro-diarize').checked;
  renderModels(st);
  renderProgress(st.busy);
  const diarize = $('pro-diarize').checked;
  const need = missing(st, diarize);
  $('pro-start').textContent = need.length ? '모델 받고 받아쓰기 시작' : '받아쓰기 시작';
  $('pro-start').disabled = st.available === false || Boolean(st.busy);
}

/** 메모 메뉴에서: 이 메모의 녹음을 골라 다시 받아쓰기 */
export function open(memoId, body) {
  const sources = audioSources(body);
  if (!sources.length) {
    toast('이 메모에는 녹음(소리 파일)이 없어요', true);
    return;
  }
  sheetFor = { memoId, sources };
  $('pro-audio').replaceChildren(...sources.map((s, i) => {
    const label = document.createElement('label');
    label.className = 'rem-radio';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'pro-audio';
    input.value = s.src;
    input.checked = i === sources.length - 1; // 보통 가장 최근 녹음
    label.append(input, ` ${s.alt || s.src.split('/').pop()}`);
    return label;
  }));
  $('pro-audio').hidden = sources.length < 2;
  render();
  openSheet(sheet);
}

$('pro-diarize').addEventListener('change', render);
$('pro-cancel').addEventListener('click', () => {
  try {
    pro.cancel();
    toast('그만두는 중이에요');
  } catch (err) {
    toast(err.message, true);
  }
});
$('pro-start').addEventListener('click', async () => {
  if (!sheetFor) return;
  const rel = sheet.querySelector('input[name="pro-audio"]:checked')?.value ?? sheetFor.sources.at(-1).src;
  const diarize = $('pro-diarize').checked;
  const speakers = Number($('pro-speakers').value) || 0;
  $('pro-start').disabled = true;
  try {
    await start({ memoId: sheetFor.memoId, rel, diarize, speakers });
    render();
  } catch (err) {
    toast(err.message || '시작하지 못했어요', true);
    render();
  }
});

// ---------- 시작 · 모델 받기 ----------

async function ensureModels(diarize) {
  const need = missing(status(), diarize);
  if (!need.length) return;
  toast('받아쓰기 모델을 받고 있어요 (처음 한 번)');
  await call('proModels', { keys: need });
}

/** 다시 받아쓰기 시작 (모델이 없으면 먼저 받는다) */
export async function start({ memoId, rel, diarize = true, speakers = 0 }) {
  if (status().available === false) throw new Error('이 빌드에는 정확한 받아쓰기가 들어 있지 않아요');
  await ensureModels(diarize);
  app.flushNote?.();
  await call('retranscribe', { memoId, rel, diarize, speakers });
  toast('정확하게 다시 받아쓰기를 시작했어요. 끝나면 녹음 아래에 넣을게요');
  watch();
}

// 끝났는지: 앱의 소식(on 'pro')이 주로, 놓친 경우를 위해 몇 초마다 확인
function watch() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    takeDone();
    const busy = status().busy;
    if (!sheet.hidden) renderProgress(busy);
    if (!busy) {
      clearInterval(pollTimer);
      if (!sheet.hidden) render();
    }
  }, 3000);
}

async function deliver(result) {
  if (!result?.id || delivered.has(result.id)) return;
  delivered.add(result.id);
  try {
    if (result.ok) {
      const n = await app.insertTranscript(result);
      toast(n ? `정확하게 다시 받아쓴 글을 녹음 아래에 넣었어요${result.speakers ? ` (말한 사람 ${result.speakers}명)` : ''}` : '받아쓸 말소리를 찾지 못했어요');
    } else if (!result.cancelled) toast(`다시 받아쓰지 못했어요 — ${result.message ?? ''}`, true, { label: '확인', run: () => {} }); // 이유를 읽을 수 있게 조금 더 오래
    else toast('받아쓰기를 그만뒀어요');
    pro.ack(result.id);
  } catch (err) {
    delivered.delete(result.id);
    console.warn('받아쓴 글을 넣지 못했어요', err);
  }
}

function takeDone() {
  let done = [];
  try {
    done = pro.takeDone() ?? [];
  } catch {
    return;
  }
  for (const r of done) deliver(r);
}

on('pro', (ev) => {
  if (ev?.type === 'progress' && !sheet.hidden) renderProgress(ev.status);
  if (ev?.type === 'done') {
    deliver(ev.result);
    if (!sheet.hidden) render();
  }
});
on('proModel', ({ key, progress }) => {
  if (!sheet.hidden) renderModels(status(), { [key]: progress < 100 ? progress : null });
});

/** 앱을 열 때·돌아왔을 때: 끝난 결과 넣기, 도는 중이면 지켜보기 */
export function resume() {
  takeDone();
  if (status().busy) watch();
}

export const closeProSheet = () => closeSheet(sheet);
