// 스티커 메모 창 — 메모 1개 = 창 1개 = 파일 1개.
import { injectIcons, icon } from './icons.js';
import { createNoteEditor } from './editor.js';
import { COLORS, COLOR_NAMES, extractTitle, isBlankBody, conflictCopyBody, sameBody } from './core/memo-file.js';
import { TEXT_COLORS, HIGHLIGHT_COLORS } from './core/html-marks.js';
import { fileExtension } from './media.js';
import { isDataImage, decodeDataImage } from './core/remote-images.js';
import { setupReminderPanel } from './reminder-panel.js';
import { reminderAt } from './date-remind.js';
import { renderMemoImage } from './share-image.js';
import { lockDialog, lockScreen } from './lock-ui.js';
import { formatBytes } from './core/file-kinds.js';
import { extractTags } from './core/tags.js';
import { tutorialCounts, tutorialDone, TUTORIAL_SAMPLE, hasTutorialSample } from './core/tutorial.js';
import { setupCoach } from './coach.js';
import { stepZoom, clampZoom, zoomLabel } from './core/zoom.js';
import { attachSliders } from './seg-slider.js';
import { setupVoiceRecorder } from './voice-recorder.js';
import { setupAnnotation } from './ink-annotate.js';
import { audioNeedingTranscript } from './core/voice-card.js';
import { reduceMotion, replayClass, menuKeys, focusFirstIfKeyboard, radioGroups } from './dom.js';
import { createClearStamp } from './clear-stamp.js';
import { fillSuggestChips, trackPlaceholder } from './suggest-chips.js';
import { renderVersions } from './versions-view.js';
import { hintOnce } from './hints.js';
import { toggleShortcutSheet } from './shortcut-sheet.js';

const SAVE_DELAY = 600;

const api = window.memoking;
const params = new URLSearchParams(location.search);
const id = params.get('id');
const $ = (x) => document.getElementById(x);
const el = {
  status: $('status'),
  editorRoot: $('editor'),
  linksBtn: $('links-btn'),
  linksCount: $('links-count'),
  menu: $('menu'),
  menuBtn: $('menu-btn'),
  swatches: $('swatches'),
  pinToggle: $('pin-toggle'),
  topBtn: $('top-btn'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  linksPanel: $('links-panel'),
  linkSearch: $('link-search'),
  linkResults: $('link-results'),
  linksOut: $('links-out'),
  linksIn: $('links-in'),
  linksSuggest: $('links-suggest'),
  formatBar: $('format-bar'),
  formatItems: $('format-items'),
  moreBtn: $('more-btn'),
  morePanel: $('more-panel'),
  palette: $('palette'),
  fileInput: $('file-input'),
  confirm: $('confirm-dialog'),
};

let editor = null;
let reminderPanel = null;
let recorder = null; // 음성 녹음 (voice-recorder.js)
let annotation = null; // 주석: 메모 위에 그리기 (ink-annotate.js)

// 녹음 받아쓰기를 메인 프로세스와 잇는다 (녹음마다 번호)
function sttBridge() {
  let seq = 0;
  let cur = 0;
  const lineFns = [];
  const speakFns = [];
  api.on('stt:line', ({ id: n, text }) => n === cur && lineFns.forEach((f) => f(text)));
  api.on('stt:speaking', ({ id: n, on }) => n === cur && speakFns.forEach((f) => f(on)));
  return {
    start: () => {
      cur = ++seq;
      return api.stt.start(cur);
    },
    audio: (samples) => api.stt.audio(cur, samples),
    stop: ({ src }) => api.stt.stop(cur, { memoId: id, src }),
    onLine: (f) => lineFns.push(f),
    onSpeaking: (f) => speakFns.push(f),
  };
}
let memo = null;
let current = '';   // 편집기의 최신 마크다운
let tutBase = null; // 튜토리얼 직접 해 보기 단계가 시작될 때의 본문 수 (core/tutorial.js tutorialCounts)
let saved = '';     // 마지막으로 저장한 마크다운
let saveTimer = null;
let pendingExternal = null;

// ---------- 저장 ----------

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

// 편집기의 변경 알림은 약간 늦게 오므로, 저장 직전에는 편집기에서 직접 읽는다.
function isDirty() {
  if (editor) current = editor.getMarkdown();
  return current !== saved;
}

// ---------- 추천 태그 (휴대폰과 같음): 태그 없는 메모에 이 폴더의 태그 중 맞는 것을 아래 막대에 ----------
const tagBar = $('tag-suggest-bar');
let tagTimer = 0;
let tagDismissed = false;
let tagSeq = 0;
function scheduleTagBar() {
  clearTimeout(tagTimer);
  tagTimer = setTimeout(renderTagBar, 1500); // 쓰는 동안은 기다렸다가
}
async function renderTagBar() {
  if (!tagBar || !editor || tagDismissed) return;
  const body = editor.getMarkdown();
  if (extractTags(body).length) {
    tagBar.hidden = true;
    return;
  }
  const seq = ++tagSeq;
  let list = [];
  try {
    list = (await api.tags.suggest?.(body, id)) ?? [];
  } catch {
    list = [];
  }
  if (seq !== tagSeq) return;
  fillSuggestChips($('tag-suggest-chips'), list, addTags);
  tagBar.hidden = list.length === 0;
}
function addTags(names) {
  if (!editor || !names.length) return;
  editor.appendMarkdown(names.map((n) => `#${n}`).join(' '));
  flush();
  setStatus(`${names.map((n) => `#${n}`).join(' ')} 태그를 달았어요`);
  tagBar.hidden = true;
}
tagBar?.addEventListener('mousedown', (e) => e.preventDefault()); // 커서 유지
$('tag-suggest-close')?.addEventListener('click', () => {
  tagDismissed = true;
  tagBar.hidden = true;
});

function onChange(md) {
  current = md;
  scheduleTagBar();
  // 튜토리얼 따라 하기: 글을 쓰면 · 꾸미면 · 체크리스트 · 태그를 붙이면 (단계 시작 때보다 늘면) 다음 단계로
  const advance = coach?.step?.advance;
  if (advance && tutBase && tutorialDone(advance, tutBase, tutCounts(md))) {
    tutBase = null;
    api.tutorial.event(advance);
  }
  document.title = extractTitle(md);
  if (current === saved) return;
  setStatus('');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

// 빈 메모 안내 문구
const showPlaceholder = trackPlaceholder(el.editorRoot);

async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!isDirty()) return;
  const body = current;
  try {
    await api.memo.save(id, body);
    saved = body;
    setStatus('저장했어요');
  } catch (err) {
    console.error(err);
    setStatus('저장하지 못했어요. 메모 폴더를 확인해 주세요', true);
  }
}

// 창을 닫는 순간 — 남은 내용을 동기 저장
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  if (isDirty()) {
    api.memo.saveSync(id, current);
    saved = current;
  }
});

// ---------- 다른 곳(다른 PC, 다른 앱)에서 바뀐 경우 ----------

function applyExternal(next) {
  editor.setMarkdown(next.body, next.tables ?? []);
  current = saved = editor.getMarkdown();
  el.banner.hidden = true;
  pendingExternal = null;
  setStatus('바뀐 내용을 불러왔어요');
}

let conflictCopy = null; // 쓰는 중에 다른 기기에서도 고쳐 들어온 내용을 따로 남긴 사본 메모 (창이 열린 동안 한 사본만)

function showBanner(text, { load = null, keep = '지금 내용 두기' } = {}) {
  el.bannerText.textContent = text;
  $('banner-load').hidden = !load;
  if (load) $('banner-load').textContent = load;
  $('banner-keep').textContent = keep;
  el.banner.hidden = false;
}

api.on('memo:external', async (next) => {
  // 아직 편집기가 없다(잠긴 메모의 비밀번호 화면) — 비밀번호 화면은 열 때 지금 파일로 푸므로 할 일이 없다
  // (같은 비밀번호로 다른 기기가 고친 것을 "비밀번호를 바꿨어요" 로 오해해 창을 닫지 않게)
  if (!next || !editor) return;
  if (next.needsPassword) {
    // 다른 기기에서 이 메모를 잠갔거나(이 창에선 안 잠긴 메모) 다른 비밀번호로 다시 잠갔다 — 이 창의 열쇠로는 풀 수 없으니
    // 메모를 덮어쓰지 않는다. 다만 아직 저장 못 한 쓰던 글은 사본 메모로 먼저 남긴 뒤 닫는다 (쓰던 글이 사라지지 않게)
    clearTimeout(saveTimer);
    const wasLocked = Boolean(memo?.locked);
    const what = wasLocked ? '다른 기기에서 이 메모의 비밀번호를 바꿨어요.' : '다른 기기에서 이 메모를 잠갔어요.';
    let kept = '';
    if (isDirty() && !isBlankBody(current)) {
      try {
        const copy = await api.memo.keepCopy(id, current, null, { unlocked: !wasLocked });
        if (copy) kept = wasLocked ? ' 쓰던 내용은 예전 비밀번호로 잠근 사본 메모로 남겼어요.' : ' 쓰던 내용은 사본 메모로 따로 남겼어요.';
      } catch (err) {
        console.error(err);
      }
      if (!kept) {
        // 사본도 못 만들었다 — 창을 닫지 않고 글을 그대로 둔다 (복사해 둘 수 있게)
        setStatus(`${what} 쓰던 내용을 저장하지 못했어요. 글을 복사해 두세요`, true);
        return;
      }
    }
    saved = current;
    setStatus(`${what}${kept} 다시 열 때 비밀번호를 넣어 주세요`, true);
    setTimeout(() => window.close(), kept ? 4000 : 2500);
    return;
  }
  if (sameBody(next.body, current)) {
    saved = current; // 지금 쓰는 글과 같은 내용 — 할 일 없음
    return;
  }
  if (!isDirty()) return applyExternal(next);
  // 쓰는 중에 다른 기기에서도 고쳤을 때: 지금 쓰는 글은 이 메모에 그대로 저장하고, 들어온 내용은 사본 메모로 따로
  // (고르기 전에 자동 저장이 들어온 내용을 덮어써 사라지는 일이 없게 — 휴대폰과 같게). 사본을 못 만들면 예전처럼 고르게
  let copied = isBlankBody(next.body);
  if (!copied) {
    try {
      conflictCopy = await api.memo.keepCopy(id, conflictCopyBody(next.body), conflictCopy);
      copied = Boolean(conflictCopy);
    } catch (err) {
      console.error(err);
    }
  }
  if (!copied) {
    pendingExternal = next;
    showBanner('다른 기기에서 이 메모가 바뀌었어요.', { load: '바뀐 내용 보기', keep: '지금 내용 두기' });
    return;
  }
  pendingExternal = null;
  await flush();
  showBanner(conflictCopy ? '다른 기기에서도 이 메모를 고쳤어요. 그쪽 내용은 따로 저장해 뒀어요.' : '다른 기기에서도 이 메모를 고쳤어요.', { load: conflictCopy ? '그쪽 내용 보기' : null, keep: '확인' });
});
api.on('memo:removed', () => {
  showBanner('이 메모가 메모 폴더에서 사라졌어요. 계속 쓰면 다시 저장돼요.', { keep: '확인' });
});
$('banner-load').addEventListener('click', () => {
  if (pendingExternal) return applyExternal(pendingExternal);
  if (conflictCopy) {
    el.banner.hidden = true;
    api.memo.open(conflictCopy);
  }
});
$('banner-keep').addEventListener('click', () => {
  el.banner.hidden = true;
  if (!pendingExternal) return; // 사본으로 따로 남긴 뒤라 고를 것이 없다
  pendingExternal = null;
  saved = '';
  flush(); // 내 내용으로 덮어쓴다
});

// ---------- 색·고정·항상 위 ----------

function applyMeta(next) {
  const inkBefore = memo?.ink ?? '';
  memo = { ...memo, ...next };
  // 다른 기기에서 주석이 바뀌면 다시 (주석을 그리는 중이면 끝낼 때 내 것이 저장된다)
  if (annotation && !annotation.active && (memo.ink ?? '') !== inkBefore) annotation.load(Boolean(memo.ink));
  document.body.dataset.color = memo.color;
  for (const s of el.swatches.children) s.setAttribute('aria-checked', String(s.dataset.color === memo.color));
  el.pinToggle.setAttribute('aria-checked', String(memo.pinned));
  el.pinToggle.querySelector('span').textContent = memo.pinned ? '목록 고정 풀기' : '목록 맨 위에 고정';
}

for (const color of COLORS) {
  const swatch = document.createElement('button');
  swatch.className = 'swatch';
  swatch.dataset.color = color;
  swatch.title = COLOR_NAMES[color];
  swatch.setAttribute('role', 'menuitemradio');
  swatch.addEventListener('click', async () => applyMeta(await api.memo.set(id, { color })));
  el.swatches.append(swatch);
}

el.pinToggle.addEventListener('click', async () => {
  await flush();
  applyMeta(await api.memo.set(id, { pinned: !memo.pinned }));
  closeMenu();
});
// ---------- 항상 위 고정 ----------

// 스티커를 붙이고 떼는 느낌: 켜면 버튼의 왕관이 떨어져 나가 창 위 가장자리 스티커가 되고(버튼은 빈 자리),
// 스티커를 누르면 떼어져 꺼지고 왕관이 버튼으로 돌아온다 (메인 프로세스가 따로 띄우는 스티커 창)
let topOn = null;
function applyTop(on) {
  const changed = topOn !== null && topOn !== on;
  topOn = on;
  el.topBtn.classList.toggle('peeled', on);
  el.topBtn.tabIndex = on ? -1 : 0;
  el.topBtn.setAttribute('aria-hidden', String(on));
  if (changed && !reduceMotion()) {
    el.topBtn.querySelector('svg').animate(on
      ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px) rotate(-12deg) scale(0.7)' }]
      : [{ opacity: 0, transform: 'scale(0.4) rotate(12deg)' }, { opacity: 1, transform: 'scale(1.15)', offset: 0.7 }, { opacity: 1, transform: 'none' }],
    { duration: on ? 200 : 280, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }
  el.topBtn.setAttribute('aria-pressed', String(on));
  const label = on ? '늘 위에 두기 끄기' : '다른 창보다 늘 위에 두기';
  el.topBtn.title = '왕관 스티커를 붙여 다른 창보다 늘 위에 두기 (Ctrl+Shift+T, 다시 누르면 떼기)';
  el.topBtn.setAttribute('aria-label', label);
  document.body.classList.toggle('on-top', on);
}

// 버튼은 붙이기만 (붙으면 버튼이 숨고, 떼기는 창 위의 왕관 스티커를 눌러서). Ctrl+Shift+T 는 붙이고 떼기 둘 다
async function toggleTop() {
  if (topOn) return;
  applyTop(await api.win.toggleTop(id));
  if (topOn) tutEvent('crown-on');
}
async function toggleTopKey() {
  if (!topOn) return toggleTop();
  applyTop(await api.win.toggleTop(id)); // 스티커가 떼어지는 모습은 스티커를 누를 때와 같다
}
el.topBtn.addEventListener('click', toggleTop);
// 메모를 그림 카드(PNG) 한 장으로 — 메모 색 종이에 본문 그대로 (휴대폰 "그림으로 공유" 와 같은 모양)
async function memoImage(kind) {
  closeMenu();
  await flush();
  setStatus('그림을 만드는 중…');
  try {
    const base64 = await renderMemoImage(editor, { color: memo?.color ?? document.body.dataset.color });
    const r = kind === 'copy' ? await api.image.copy(base64) : await api.image.save(id, base64);
    if (r?.cancelled) return setStatus('');
    setStatus(kind === 'copy' ? '그림을 복사했어요. 붙여 넣으면 돼요' : `그림으로 저장했어요: ${r?.name ?? ''}`);
  } catch (err) {
    console.error(err);
    setStatus('그림을 만들지 못했어요. 다시 해 주세요', true);
  }
}
$('image-copy-btn').addEventListener('click', () => memoImage('copy'));
/** 확인 창 (confirm-dialog): 확인 단추 글자를 바꿔 쓴다 */
function confirmDialog(message, okLabel) {
  return new Promise((resolve) => {
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = okLabel;
    el.confirm.addEventListener('close', () => resolve(el.confirm.returnValue === 'ok'), { once: true });
    el.confirm.returnValue = '';
    el.confirm.showModal();
  });
}
// 잠그기 / 잠금 풀기 (연 동안만)
function showLockState() {
  const label = $('lock-btn').querySelector('span');
  label.textContent = memo?.locked ? '잠금 풀기' : '잠그기';
  document.body.classList.toggle('is-locked', Boolean(memo?.locked));
}
$('lock-btn').addEventListener('click', async () => {
  closeMenu();
  await flush();
  if (memo?.locked) {
    const ok = await confirmDialog('잠금을 풀까요? 내용이 그대로 파일에 저장되고, 비밀번호 없이 열려요.', '잠금 풀기');
    if (!ok) return;
    const r = await api.memo.unlock(id);
    if (r?.error) return setStatus(r.error, true);
    memo = { ...memo, ...r };
    showLockState();
    setStatus('잠금을 풀었어요');
    return;
  }
  const locked = await lockDialog({
    onLock: async (password) => {
      await flush();
      const r = await api.memo.lock(id, password);
      if (r?.error) return r.error;
      memo = { ...memo, ...r };
      return null;
    },
  });
  editor?.focus(); // 창이 닫히면 쓰던 자리로
  if (!locked) return;
  showLockState();
  setStatus('잠갔어요. 창을 닫으면 다시 비밀번호로 열려요');
});
$('image-save-btn').addEventListener('click', () => memoImage('save'));
$('pdf-btn').addEventListener('click', async () => {
  closeMenu();
  await flush(); // 지금 적은 내용까지 PDF 에
  api.pdf.open(id);
});
// 소리 받아쓰기: 이 메모의 받아쓴 글이 없는 소리 파일들을 글로 (녹음할 때 받아쓰기 데이터가 없었거나, 넣은 소리 파일)
//   소리를 16kHz 로 풀어(브라우저 디코더) 메인 프로세스의 받아쓰기로 → 그 소리의 음성 카드에. 말한 사람은 나눈 뒤 다시 고친다
function decodePath(src) {
  try {
    return decodeURI(src);
  } catch {
    return src; // 이미 풀린 경로
  }
}
async function decode16k(src) {
  const bytes = await api.attachments.read(decodePath(src));
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / audio.numberOfChannels;
    }
    return out;
  } finally {
    ctx.close().catch(() => {});
  }
}
async function transcribeAudio() {
  closeMenu();
  if (!editor) return;
  const st = await api.stt.status();
  if (st.asr.state !== 'ready') return setStatus('받아쓰기 데이터를 먼저 받아 주세요 (목록 창 설정 › 음성 녹음과 받아쓰기)', true);
  const list = audioNeedingTranscript(editor.getMarkdown());
  if (!list.length) return setStatus('받아쓸 소리가 없어요 (모두 받아썼어요)');
  let done = 0;
  for (const [i, src] of list.entries()) {
    setStatus(list.length > 1 ? `받아쓰는 중… (${i + 1}/${list.length})` : '받아쓰는 중…');
    try {
      const r = await api.stt.transcribe({ memoId: id, src, samples: await decode16k(src) });
      if (r.error) throw new Error(r.error);
      if (r.text && editor.attachTranscript(src, r.text)) done++;
    } catch (err) {
      console.error(err);
      setStatus(err.message || '받아쓰지 못했어요', true);
      return;
    }
  }
  await flush();
  setStatus(done ? `받아쓴 글을 넣었어요${st.speakerOn && st.speaker.state === 'ready' ? '. 말한 사람을 나누는 중…' : ''}` : '알아들은 말이 없어요');
}
$('transcribe-btn').addEventListener('click', transcribeAudio);
// 말한 사람을 나눈 뒤: 음성 카드의 받아쓴 글에 "화자 N:" 을 붙여 다시
api.on('stt:speakers', async ({ src, text }) => {
  if (!editor?.replaceTranscript(src, text)) return;
  await flush();
  setStatus('말한 사람을 나눴어요');
});

$('show-list').addEventListener('click', () => {
  api.win.showList();
  closeMenu();
});
$('delete-btn').addEventListener('click', async () => {
  closeMenu();
  // 묻지 않고 바로 휴지통으로 (목록 창에 되돌리기) — 창이 휴지통으로 빨려 들어가듯 사라진다
  saved = current; // 삭제하는 메모는 저장하지 않는다
  if (!reduceMotion()) {
    await document.body.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(24px) scale(0.92)' }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' }).finished.catch(() => {});
  }
  await api.memo.remove(id);
});

api.on('memo:meta', applyMeta);

function toggleMenu(e) {
  el.menu.hidden = !el.menu.hidden;
  el.menuBtn.setAttribute('aria-expanded', String(!el.menu.hidden));
  if (!el.menu.hidden) focusFirstIfKeyboard(e, el.menu, '.menu-item');
}
function closeMenu() {
  if (el.menu.hidden) return;
  el.menu.hidden = true;
  el.menuBtn.setAttribute('aria-expanded', 'false');
  if (el.menu.contains(document.activeElement)) el.menuBtn.focus(); // 키보드로 쓰던 사람이 제자리로
}
el.menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu(e);
});
menuKeys(el.menu, '.menu-item');
document.addEventListener('mousedown', (e) => {
  if (!el.menu.hidden && !el.menu.contains(e.target) && !el.menuBtn.contains(e.target)) closeMenu();
});

// ---------- 연결 패널 ----------

function linkItem(target, { onRemove, onAdd, score } = {}) {
  const li = document.createElement('li');
  li.className = 'link-item';
  const open = document.createElement('button');
  open.className = 'link-open';
  open.dataset.color = target.color;
  open.title = '메모 열기';
  const dot = document.createElement('span');
  dot.className = 'link-dot';
  const title = document.createElement('span');
  title.textContent = target.title;
  open.append(dot, title);
  open.addEventListener('click', () => api.memo.open(target.id));
  li.append(open);
  if (score != null) {
    const s = document.createElement('span');
    s.className = 'link-score';
    s.textContent = `${Math.round(score * 100)}%`;
    li.append(s);
  }
  const addBtn = (name, label, handler) => {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = label;
    b.setAttribute('aria-label', `${target.title} ${label}`);
    b.append(icon(name));
    b.addEventListener('click', handler);
    li.append(b);
  };
  if (onAdd) addBtn('plus', '연결하기', onAdd);
  if (onRemove) addBtn('close', '연결 끊기', onRemove);
  return li;
}

async function setLink(targetId, on) {
  await flush();
  await api.memo.link(id, targetId, on);
  el.linkSearch.value = '';
  el.linkResults.replaceChildren();
  await refreshLinks();
}

async function refreshLinks() {
  const { links, backlinks, suggestions } = await api.memo.links(id);
  const total = new Set([...links, ...backlinks].map((m) => m.id)).size;
  el.linksCount.textContent = total ? String(total) : '';
  el.linksBtn.classList.toggle('has-links', total > 0);
  if (el.linksPanel.hidden) return;
  el.linksOut.replaceChildren(...links.map((m) => linkItem(m, { onRemove: () => setLink(m.id, false) })));
  el.linksIn.replaceChildren(...backlinks.map((m) => linkItem(m)));
  el.linksSuggest.replaceChildren(...suggestions.map((m) => linkItem(m, { onAdd: () => setLink(m.id, true), score: m.score })));
}

let linkSearchTimer = null;
el.linkSearch.addEventListener('input', () => {
  clearTimeout(linkSearchTimer);
  linkSearchTimer = setTimeout(async () => {
    const q = el.linkSearch.value.trim();
    if (!q) return el.linkResults.replaceChildren();
    const { links } = await api.memo.links(id);
    const linked = new Set(links.map((m) => m.id));
    const results = (await api.memos.search(q, id)).filter((m) => !linked.has(m.id)).slice(0, 8);
    el.linkResults.replaceChildren(...results.map((m) => linkItem(m, { onAdd: () => setLink(m.id, true) })));
  }, 150);
});

async function toggleLinks(force) {
  el.linksPanel.hidden = force === undefined ? !el.linksPanel.hidden : !force;
  if (!el.linksPanel.hidden) {
    if (reminderPanel?.open) reminderPanel.toggle(false); // 패널은 하나씩
    if (!versionsPanel.hidden) toggleVersions(false);
    await flush();
    await refreshLinks();
    el.linkSearch.focus();
  } else editor.focus();
}
el.linksBtn.addEventListener('click', () => toggleLinks());

// ---------- 이전 버전 ----------

const versionsPanel = $('versions-panel');
async function refreshVersions() {
  const versions = await api.memo.versions(id);
  renderVersions($('versions-list'), versions, restoreVersion);
}
async function restoreVersion(name) {
  await flush(); // 지금 내용이 버전으로 남도록 먼저 저장
  const restored = await api.memo.restoreVersion(id, name);
  if (!restored) return setStatus('그 버전을 찾지 못했어요', true);
  editor.setMarkdown(restored.body, restored.tables ?? []);
  current = saved = editor.getMarkdown();
  setStatus('되돌렸어요');
  await refreshVersions();
}
async function toggleVersions(force) {
  versionsPanel.hidden = force === undefined ? !versionsPanel.hidden : !force;
  if (!versionsPanel.hidden) {
    if (!el.linksPanel.hidden) toggleLinks(false);
    if (reminderPanel?.open) reminderPanel.toggle(false);
    await flush();
    await refreshVersions();
    $('versions-close').focus();
  } else editor.focus();
}
$('versions-btn').addEventListener('click', () => {
  closeMenu();
  toggleVersions(true);
});
$('versions-close').addEventListener('click', () => toggleVersions(false));
// 끌어서 합치기(스택)의 메뉴 버전 — 끌기가 어려운 사람도
$('join-btn').addEventListener('click', async () => {
  closeMenu();
  await flush();
  api.stack.joinMenu(id);
});
// 단축키 모음: 전역 단축키(빠른 메모·매직키)는 설정에서 바꾼 키로
async function openShortcutSheet() {
  let keys;
  try {
    const s = await api.settings.get();
    keys = { quickMemo: s.shortcuts?.quickMemo?.key, magic: s.shortcuts?.magic?.key };
  } catch {
    keys = undefined;
  }
  toggleShortcutSheet(keys);
}
$('shortcuts-btn').addEventListener('click', () => {
  closeMenu();
  openShortcutSheet();
});
// 메모 창을 몇 번 써 본 뒤 한 번: 단축키 모음이 있다는 것
setTimeout(() => hintOnce('shortcuts', 'Ctrl+/ 를 누르면 단축키를 한눈에 볼 수 있어요', { anchor: el.menuBtn }), 2500);
$('links-close').addEventListener('click', () => toggleLinks(false));
api.on('memo:links-changed', refreshLinks);

// ---------- 예약 알림 ----------

// 알림으로 이 메모가 떴을 때 보여주는 띠
function showAlarm(alarm) {
  $('alarm-text').textContent = alarm.label; // 종 아이콘이 앞에 있으므로 글자만
  $('alarm-banner').hidden = false;
  replayClass($('alarm-banner'), 'ring');
}
$('alarm-ok').addEventListener('click', () => {
  $('alarm-banner').hidden = true;
  editor?.focus();
});
api.on('memo:alarm', showAlarm);

// 빠른 메모 알림을 눌러 이 메모로 왔을 때 등: 창 테두리가 두 번 반짝여 "이 메모" 임을 알린다
api.on('memo:highlight', () => {
  replayClass(document.body, 'highlight');
});
document.body.addEventListener('animationend', (e) => {
  if (e.animationName === 'note-highlight') document.body.classList.remove('highlight');
});
api.on('memo:reminders', (list) => reminderPanel?.set(list));
// 스택의 다른 탭에서 늘 위에 두기를 바꾼 경우 (이 창은 숨어 있었음)
api.on('memo:on-top', (on) => applyTop(on));

// ---------- 빠른 메모 (Ctrl+Alt+C) ----------
// 메인 프로세스가 복사해 온 내용으로 새 메모를 채운다: 제목(파일·그림일 때) → 글(붙여넣기) → 파일·그림 → 출처

const escapeMd = (s) => s.replace(/([\\`*_[\]<>#])/g, '\\$1');

async function applyCapture(c) {
  if (c.heading) editor.setMarkdown(`# ${escapeMd(c.heading)}\n`);
  editor.focusEnd();
  if (c.html || c.text) editor.pasteData({ html: c.html, text: c.text });
  editor.insertItems(c.items);
  await new Promise((r) => setTimeout(r, 30)); // 붙여넣기가 반영된 뒤
  editor.appendMarkdown(c.sourceMd);
  editor.focusEnd();
  // 웹 사진을 받는 중에 저장하면 주소 교체와 엇갈릴 수 있어, 받기가 끝난 뒤 한 번에 저장
  if (c.html) {
    setStatus('사진을 저장하는 중…');
    await editor.imagesSettled();
  }
  // 태그를 저절로: 화면 캡처는 #캡처, 웹에서 가져온 것은 링크, 그 밖은 공유 (+ 내용에 맞는 기존 태그)
  const source = c.source.window === '화면 캡처' ? 'capture' : c.source.url ? 'link' : 'share';
  let tags = [];
  try {
    tags = (await api.tags.auto?.(editor.getMarkdown(), source, id)) ?? [];
  } catch {
    tags = [];
  }
  if (tags.length) editor.appendMarkdown(tags.map((t) => `#${t}`).join(' '));
  await flush();
  const skipped = c.skipped.length ? `. 폴더 ${c.skipped.length}개는 넣을 수 없어서 뺐어요` : '';
  const tagged = tags.length ? `, ${tags.map((t) => `#${t}`).join(' ')}` : '';
  setStatus(c.source.copied ? `고른 내용으로 메모를 만들었어요${tagged}${skipped}` : `복사해 둔 내용으로 메모를 만들었어요${tagged}${skipped}`);
}

// ---------- 파일 넣기 ----------
// 이미지는 바로 보이고, 소리·동영상은 플레이어로, 그 밖의 파일은 파일 칩(누르면 열림)으로 들어간다.

async function saveFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return api.attachments.save(bytes, fileExtension(file));
}

// 붙여넣은 인터넷·data: 사진을 메모 폴더에 저장 → "attachments/..."
async function fetchImage(src) {
  if (isDataImage(src)) {
    const image = decodeDataImage(src);
    if (!image) throw new Error('지원하지 않는 그림 형식');
    return api.attachments.save(image.bytes, image.ext);
  }
  return api.attachments.fetch(src);
}

async function insertFiles(files) {
  try {
    await editor.insertFiles(files);
  } catch (err) {
    console.error(err);
    setStatus('파일을 추가하지 못했어요. 다시 시도해 주세요', true);
  }
}

el.fileInput.addEventListener('change', () => {
  insertFiles([...el.fileInput.files]);
  el.fileInput.value = '';
});
$('photo-input').addEventListener('change', (e) => {
  insertFiles([...e.target.files]);
  e.target.value = '';
});

// ---------- 링크·파일 한 번 눌러 열기 ----------
// 인터넷 링크는 기본 브라우저로, 파일 칩은 메모 폴더의 복사본을 기본 앱으로. 사진은 두 번 누르면 사진 앱으로.

async function openAttachment(rel) {
  const result = await api.attachments.open(rel);
  if (result && result !== 'cancelled') setStatus(result, true);
}

function openHref(href) {
  if (/^https?:/i.test(href)) api.links.open(href);
  else if (href.startsWith('attachments/')) openAttachment(href);
}

el.editorRoot.addEventListener('click', (e) => {
  if (e.button !== 0 || e.shiftKey) return;
  const a = e.target.closest?.('a[href]');
  if (!a || !el.editorRoot.contains(a)) return;
  e.preventDefault();
  // 글자를 끌어서 고르던 중이면 열지 않는다
  if (!window.getSelection()?.isCollapsed) return;
  openHref(a.getAttribute('href'));
});

// memoking://vault/attachments/a.png → attachments/a.png
function vaultPathOf(src) {
  try {
    const u = new URL(src);
    if (u.protocol === 'memoking:' && u.host === 'vault') return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    if (/^https?:$/.test(u.protocol)) return u.href;
  } catch {
    // 알 수 없는 주소
  }
  return null;
}

el.editorRoot.addEventListener('dblclick', (e) => {
  const img = e.target.closest?.('img.mk-image');
  if (!img) return;
  const target = vaultPathOf(img.src);
  if (!target) return;
  e.preventDefault();
  openHref(target);
});

// 파일 칩에 마우스를 올리면 이름·크기 안내
const hint = document.createElement('div');
hint.className = 'hover-hint';
hint.hidden = true;
document.body.append(hint);
let hintFor = null;
el.editorRoot.addEventListener('mouseover', async (e) => {
  const a = e.target.closest?.('a[data-file]');
  if (!a || a === hintFor) return;
  hintFor = a;
  const href = a.getAttribute('href');
  const info = await api.attachments.info(href).catch(() => null);
  if (hintFor !== a) return;
  const program = a.dataset.file === 'program';
  hint.textContent = !info?.exists
    ? '이 PC의 메모 폴더에 파일이 아직 없어요'
    : `${a.textContent} (${formatBytes(info.size)}). ${program ? '누르면 실행할지 물어볼게요' : '누르면 열려요'}`;
  const r = a.getBoundingClientRect();
  hint.hidden = false;
  const left = Math.max(6, Math.min(r.left, window.innerWidth - hint.offsetWidth - 6));
  const top = r.bottom + 6 + hint.offsetHeight > window.innerHeight ? r.top - hint.offsetHeight - 6 : r.bottom + 6;
  hint.style.left = `${left}px`;
  hint.style.top = `${top}px`;
});
el.editorRoot.addEventListener('mouseout', (e) => {
  const a = e.target.closest?.('a[data-file]');
  if (!a || a.contains(e.relatedTarget)) return;
  hintFor = null;
  hint.hidden = true;
});
el.editorRoot.addEventListener('scroll', () => {
  hintFor = null;
  hint.hidden = true;
}, true);

// ---------- 글자 색 · 하이라이트 색판 ----------

const PALETTES = {
  color: { title: '글자 색', colors: TEXT_COLORS, apply: (c) => editor.setTextColor(c) },
  highlight: { title: '형광펜', colors: HIGHLIGHT_COLORS, apply: (c) => editor.setHighlight(c) },
};
// 지금 커서·고른 글자에 칠해진 색 (showActive 가 채움) — 판에서 같은 색을 다시 누르면 지우고, 판에 지금 색을 표시
const appliedColor = { color: null, highlight: null };
const sameColor = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
// 마지막으로 쓴 색 (이 PC 에서만 기억하는 편의 설정)
const lastColor = { color: TEXT_COLORS[0].value, highlight: HIGHLIGHT_COLORS[0].value };
try {
  Object.assign(lastColor, JSON.parse(localStorage.getItem('memoking.lastColor') ?? '{}'));
} catch {
  // 저장소를 못 쓰면 기본색
}
let paletteKind = null;

function paintSwatchBars() {
  for (const bar of document.querySelectorAll('[data-bar]')) bar.style.background = lastColor[bar.dataset.bar];
}

function openPalette(kind, anchor) {
  const def = PALETTES[kind];
  paletteKind = kind;
  $('palette-title').textContent = def.title;
  $('palette-swatches').replaceChildren(...def.colors.map(({ name, value }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'palette-swatch';
    b.dataset.color = value;
    b.title = name;
    b.setAttribute('aria-label', `${def.title} ${name}`);
    // 글자 색: 흰 칩 위에 그 색으로 쓴 A / 형광펜: 그 색 바탕
    if (kind === 'color') {
      b.textContent = 'A';
      b.classList.add('text-sample');
      b.style.color = value;
    } else b.style.background = value;
    b.setAttribute('aria-checked', String(sameColor(value, appliedColor[kind] ?? lastColor[kind])));
    if (sameColor(value, appliedColor[kind])) b.title = `${name} (다시 누르면 색을 지워요)`;
    return b;
  }));
  el.palette.hidden = false;
  placePopover(el.palette, anchor);
}

function closePalette() {
  el.palette.hidden = true;
  paletteKind = null;
}

function applyPaletteColor(color) {
  const kind = paletteKind;
  if (!kind) return;
  if (color && sameColor(color, appliedColor[kind])) color = null; // 지금 칠해진 색을 다시 고르면 지운다
  if (color) {
    lastColor[kind] = color;
    try {
      localStorage.setItem('memoking.lastColor', JSON.stringify(lastColor));
    } catch {
      // 무시
    }
    paintSwatchBars();
  }
  PALETTES[kind].apply(color);
  closePalette();
  closeMore();
}

el.palette.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 선택 유지
el.palette.addEventListener('click', (e) => {
  const swatch = e.target.closest('[data-color]');
  if (swatch) applyPaletteColor(swatch.dataset.color);
  else if (e.target.closest('#palette-clear')) applyPaletteColor(null);
});

// 도구막대 위쪽에, 창 밖으로 나가지 않게 띄운다
function placePopover(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = pop.offsetWidth;
  const left = Math.min(Math.max(6, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 6);
  pop.style.left = `${left}px`;
  pop.style.bottom = `${Math.max(6, window.innerHeight - rect.top + 6)}px`;
}

// ---------- 서식 도구막대 (넘치면 » 더보기) ----------

const toolbarItems = [...el.formatItems.children]; // 원래 순서

function closeMore() {
  el.morePanel.hidden = true;
  el.moreBtn.setAttribute('aria-expanded', 'false');
}

// 창 폭에 들어가는 만큼만 막대에 두고, 나머지는 더보기 안으로 옮긴다.
function layoutToolbar() {
  el.formatItems.append(...toolbarItems);
  el.moreBtn.hidden = true;
  if (el.formatItems.scrollWidth <= el.formatItems.clientWidth) {
    el.morePanel.replaceChildren();
    closeMore();
    return;
  }
  el.moreBtn.hidden = false;
  const overflow = [];
  while (el.formatItems.scrollWidth > el.formatItems.clientWidth && el.formatItems.children.length > 1) {
    overflow.unshift(el.formatItems.lastElementChild);
    el.formatItems.lastElementChild.remove();
  }
  // 막대 끝에 남은 구분선은 더보기 쪽으로
  while (el.formatItems.lastElementChild?.classList.contains('sep')) {
    overflow.unshift(el.formatItems.lastElementChild);
    el.formatItems.lastElementChild.remove();
  }
  while (overflow[0]?.classList.contains('sep')) overflow.shift();
  el.morePanel.replaceChildren(...overflow);
  if (!el.morePanel.hidden) placePopover(el.morePanel, el.moreBtn);
}
new ResizeObserver(layoutToolbar).observe(el.formatBar);

el.moreBtn.addEventListener('mousedown', (e) => e.preventDefault());
el.moreBtn.addEventListener('click', () => {
  closePalette();
  const open = el.morePanel.hidden;
  el.morePanel.hidden = !open;
  el.moreBtn.setAttribute('aria-expanded', String(open));
  if (open) placePopover(el.morePanel, el.moreBtn);
});

// ---------- 스타일 고르기 (H1·H2 버튼 대신): 본문 · 제목 1·2·3 · 인용 · 코드 블록 ----------
const styleMenu = $('style-menu');
const STYLE_NAMES = { paragraph: '본문', h1: '제목 1', h2: '제목 2', h3: '제목 3', quote: '인용', codeBlock: '코드 블록' };
let currentStyle = 'paragraph';

function closeStyleMenu() {
  styleMenu.hidden = true;
  for (const b of document.querySelectorAll('[data-action="style"]')) b.setAttribute('aria-expanded', 'false');
}
function openStyleMenu(anchor) {
  closePalette();
  for (const b of styleMenu.querySelectorAll('[data-style]')) b.setAttribute('aria-selected', String(b.dataset.style === currentStyle));
  styleMenu.hidden = false;
  for (const b of document.querySelectorAll('[data-action="style"]')) b.setAttribute('aria-expanded', 'true');
  placePopover(styleMenu, anchor);
}
// 지금 줄의 스타일 (코드 블록 > 제목 > 인용 > 본문)
function styleOf(active) {
  if (active.codeBlock) return 'codeBlock';
  for (const h of ['h1', 'h2', 'h3']) if (active[h]) return h;
  return active.quote ? 'quote' : 'paragraph';
}
function showStyle(active) {
  currentStyle = styleOf(active);
  for (const b of document.querySelectorAll('[data-action="style"]')) {
    b.querySelector('.style-name').textContent = STYLE_NAMES[currentStyle];
    b.classList.toggle('active', currentStyle !== 'paragraph');
  }
  if (!styleMenu.hidden) for (const b of styleMenu.querySelectorAll('[data-style]')) b.setAttribute('aria-selected', String(b.dataset.style === currentStyle));
}
styleMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서 유지
styleMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-style]');
  if (!b) return;
  editor.setStyle(b.dataset.style);
  closeStyleMenu();
  closeMore();
});
styleMenu.addEventListener('keydown', (e) => {
  const items = [...styleMenu.querySelectorAll('[data-style]')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  }
});

// ---------- 콘텐츠 추가 (+): 위로 위성 단추 (휴대폰과 같음) ----------
const addMenu = $('add-menu');
const addBtn = $('add-btn');
let addCloseTimer = 0;
function openAddMenu() {
  closePalette();
  closeStyleMenu();
  closeMore();
  clearTimeout(addCloseTimer);
  addMenu.classList.remove('closing');
  addMenu.hidden = false;
  const r = addBtn.getBoundingClientRect();
  addMenu.style.left = `${Math.max(8, Math.round(r.left))}px`;
  addMenu.style.bottom = `${Math.round(window.innerHeight - r.top + 10)}px`;
  addBtn.classList.add('open');
  addBtn.setAttribute('aria-expanded', 'true');
  tutEvent('add-opened');
}
function closeAddMenu() {
  if (addMenu.hidden || addMenu.classList.contains('closing')) return false;
  addBtn.classList.remove('open');
  addBtn.setAttribute('aria-expanded', 'false');
  if (addMenu.contains(document.activeElement)) addBtn.focus(); // 키보드로 쓰던 사람이 제자리로 (고른 동작이 편집기로 옮겨 감)
  addMenu.classList.add('closing');
  addCloseTimer = setTimeout(() => {
    addMenu.hidden = true;
    addMenu.classList.remove('closing');
  }, 150);
  return true;
}
const ADD = {
  record: () => recorder?.toggle(),
  ink: () => editor.insertInk().then(() => tutEvent('ink-done')),
  annotate: () => annotation?.toggle(),
  photo: () => $('photo-input').click(),
  file: () => el.fileInput.click(),
  table: () => editor.insertTable(),
  math: () => editor.setStyle('math'),
};
addMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서 유지
// 키보드: + 에서 ↑ 를 누르면 펼치고 가장 가까운(맨 아래) 항목으로, 항목 사이는 ↑↓
menuKeys(addMenu, '.add-sat');
addBtn.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp') return;
  e.preventDefault();
  if (addMenu.hidden || addMenu.classList.contains('closing')) openAddMenu();
  requestAnimationFrame(() => [...addMenu.querySelectorAll('.add-sat')].filter((b) => !b.hidden).at(-1)?.focus());
});
addMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (!b || !editor) return;
  closeAddMenu();
  ADD[b.dataset.add]?.();
});

const actions = {
  add: () => (addMenu.hidden || addMenu.classList.contains('closing') ? openAddMenu() : closeAddMenu()),
  ink: () => editor.insertInk().then(() => tutEvent('ink-done')),
  annotate: () => annotation?.toggle(),
  style: (btn) => (styleMenu.hidden ? openStyleMenu(btn) : closeStyleMenu()),
  file: () => el.fileInput.click(),
  table: () => editor.insertTable(),
  record: () => recorder?.toggle(),
  color: (btn) => (paletteKind === 'color' ? closePalette() : openPalette('color', btn)),
  highlight: (btn) => (paletteKind === 'highlight' ? closePalette() : openPalette('highlight', btn)),
};

// 막대와 더보기 패널의 버튼은 같은 방식으로 동작한다.
function onToolbarClick(e) {
  const btn = e.target.closest('button');
  if (!btn || btn === el.moreBtn) return;
  if (btn.dataset.cmd) {
    editor.run(btn.dataset.cmd);
    closeMore();
  } else if (btn.dataset.action) {
    if (btn.dataset.action === 'file') closeMore();
    actions[btn.dataset.action]?.(el.morePanel.contains(btn) ? el.moreBtn : btn);
  }
}
for (const container of [el.formatBar, el.morePanel]) {
  container.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서를 유지
  container.addEventListener('click', onToolbarClick);
}

// 도구막대·팝업 밖을 누르면 팝업을 닫는다
document.addEventListener('mousedown', (e) => {
  if (!addMenu.hidden && !addMenu.contains(e.target) && !e.target.closest?.('[data-action="add"]')) closeAddMenu();
  if (!el.palette.hidden && !el.palette.contains(e.target) && !e.target.closest?.('[data-action="color"],[data-action="highlight"]')) closePalette();
  if (!el.morePanel.hidden && !el.morePanel.contains(e.target) && !el.moreBtn.contains(e.target) && !el.palette.contains(e.target) && !styleMenu.contains(e.target)) closeMore();
  if (!styleMenu.hidden && !styleMenu.contains(e.target) && !e.target.closest?.('[data-action="style"]')) closeStyleMenu();
});

// 표 열 너비·행 높이·머리글 강조 → 메모 머리말 (끄는 동안 여러 번 바뀌어도 한 번에)
let tablesTimer = 0;
let pendingTables = null;
function saveTables(tables) {
  pendingTables = tables;
  clearTimeout(tablesTimer);
  tablesTimer = setTimeout(flushTables, 400);
}
function flushTables() {
  clearTimeout(tablesTimer);
  if (!pendingTables) return;
  const t = pendingTables;
  pendingTables = null;
  api.memo.set(id, { tables: t }).catch(() => setStatus('표 크기를 저장하지 못했어요', true));
}
window.addEventListener('beforeunload', flushTables);

// 표 막대: 표 안에 커서가 있을 때만. 머리글 행과 마지막 남은 열은 지울 수 없으므로 막는다.
const tableBar = $('table-bar');
function showTableBar(table) {
  tableBar.hidden = !table;
  document.body.classList.toggle('in-table', Boolean(table));
  for (const b of document.querySelectorAll('[data-action="table"]')) b.classList.toggle('active', Boolean(table));
  if (!table) return;
  const delRow = tableBar.querySelector('[data-table="delRow"]');
  const delCol = tableBar.querySelector('[data-table="delCol"]');
  // 머리글 아래 행은 마지막 하나까지 지울 수 있다 (머리글 행만 남은 1행 표도 된다).
  // 머리글 행만 남았을 때 머리글에서 누르면, 열이 하나뿐일 때 누르면 표 전체를 지운다 (표 막대에 "표 지우기"가 따로 없음)
  const lastRow = table.header && table.rows <= 1;
  delRow.disabled = table.header && !lastRow;
  delRow.textContent = lastRow ? '표 삭제' : '행 삭제';
  delRow.title = lastRow ? '머리글 행만 남았어요. 누르면 표를 삭제해요' : table.header ? '머리글 행은 삭제할 수 없어요 (아래 행을 모두 삭제하면 표를 삭제할 수 있어요)' : '이 행 지우기';
  // 셀 병합: 여러 칸을 골랐으면 "셀 병합", 병합한 칸 안이면 "병합 풀기"
  const merge = tableBar.querySelector('[data-table="merge"]');
  merge.textContent = table.merged ? '병합 풀기' : '셀 병합';
  merge.disabled = !table.canMerge && !table.merged;
  merge.title = table.merged ? '합친 칸을 다시 나누기' : table.canMerge ? '고른 칸들을 하나로 합치기' : '합칠 칸들을 끌어서 골라 주세요';
  delCol.textContent = table.cols <= 1 ? '표 삭제' : '열 삭제';
  delCol.title = table.cols <= 1 ? '열이 하나뿐이에요. 누르면 표를 삭제해요' : '이 열 삭제';
}
tableBar.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서가 표 안에 남게
tableBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-table]');
  if (!b || b.disabled) return;
  // 마지막 남은 머리글 행·열을 지우면 표 전체를 지운다
  const lastOne = (b.dataset.table === 'delRow' || b.dataset.table === 'delCol') && b.textContent === '표 삭제';
  editor.tableCommand(lastOne ? 'delTable' : b.dataset.table);
});

// 처음 그 상황이 됐을 때 한 번만: 눈에 안 보이는 동작(꾹 눌러 옮기기·테두리 끌기) 알려 주기
// (그림·파일 옮기기 안내는 block-move.js 가 따로)
function firstTimeHints(active) {
  if (active.table) hintOnce('table', '표: 칸 테두리를 끌면 크기가 바뀌어요. Tab 은 다음 칸, 마지막 칸에서 Tab 은 새 줄이에요', { anchor: tableBar });
  else if (active.task || active.bullet || active.ordered) hintOnce('list-move', '목록 항목은 글자를 꾹 누르면 들어 올려져 순서를 바꿀 수 있어요. 키보드는 Alt+↑ / Alt+↓', { anchor: el.editorRoot.querySelector('li') });
}

function showActive(active) {
  appliedColor.color = active.color ?? null;
  appliedColor.highlight = active.highlight ?? null;
  showTableBar(active.table);
  firstTimeHints(active);
  showStyle(active);
  for (const btn of document.querySelectorAll('[data-cmd]')) {
    btn.classList.toggle('active', Boolean(active[btn.dataset.cmd]));
  }
  for (const kind of ['color', 'highlight']) {
    for (const btn of document.querySelectorAll(`[data-action="${kind}"]`)) btn.classList.toggle('active', Boolean(active[kind]));
  }
}

// e.code 기준이라 한글 입력 상태에서도 동작한다.
const SHORTCUTS = {
  'ctrl+KeyB': ['cmd', 'bold'],
  'ctrl+KeyI': ['cmd', 'italic'],
  'ctrl+KeyU': ['cmd', 'underline'],
  'ctrl+shift+KeyC': ['color', 'color'],
  'ctrl+shift+KeyH': ['color', 'highlight'],
  'ctrl+KeyT': ['cmd', 'strike'],
  'ctrl+KeyE': ['cmd', 'code'],
  'ctrl+Digit1': ['cmd', 'h1'],
  'ctrl+Digit2': ['cmd', 'h2'],
  'ctrl+Digit3': ['cmd', 'h3'],
  'ctrl+Digit0': ['cmd', 'paragraph'],
  'ctrl+shift+Digit8': ['cmd', 'bullet'],
  'ctrl+shift+KeyL': ['cmd', 'bullet'],
  'ctrl+shift+Digit7': ['cmd', 'ordered'],
  'ctrl+shift+Digit9': ['cmd', 'task'],
  'ctrl+shift+KeyB': ['cmd', 'quote'],
  'ctrl+shift+KeyI': ['action', 'file'],
  'ctrl+shift+KeyR': ['action', 'record'],
  'ctrl+shift+KeyD': ['action', 'ink'],
  'ctrl+shift+KeyE': ['action', 'annotate'],
  'ctrl+shift+KeyT': ['app', 'top'],
  'ctrl+shift+KeyA': ['app', 'reminders'],
  'ctrl+KeyK': ['app', 'links'],
  'ctrl+Slash': ['app', 'shortcuts'],
  'ctrl+KeyN': ['app', 'new'],
  'ctrl+KeyW': ['app', 'close'],
};

window.addEventListener('keydown', (e) => {
  if (!editor || el.confirm.open) return;
  if (e.key === 'Escape') {
    if (closeAddMenu()) return;
    if (!styleMenu.hidden) closeStyleMenu();
    else if (!el.palette.hidden) closePalette();
    else if (!el.morePanel.hidden) closeMore();
    else if (!el.menu.hidden) closeMenu();
    else if (!el.linksPanel.hidden) toggleLinks(false);
    else if (!versionsPanel.hidden) toggleVersions(false);
    else if (reminderPanel?.open) reminderPanel.toggle(false);
    return;
  }
  // Ctrl+Tab / Ctrl+Shift+Tab: 스택의 다음·이전 탭
  if (e.ctrlKey && e.code === 'Tab' && !tabsEl.hidden) {
    e.preventDefault();
    e.stopPropagation();
    flush().then(() => api.stack.cycle(id, e.shiftKey ? -1 : 1));
    return;
  }
  const combo = `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.code}`;
  const hit = SHORTCUTS[combo];
  if (!hit) return;
  const inEditor = el.editorRoot.contains(document.activeElement);
  if ((hit[0] === 'cmd' || hit[0] === 'color') && !inEditor) return;
  e.preventDefault();
  e.stopPropagation();
  const [kind, name] = hit;
  if (kind === 'cmd') editor.run(name);
  else if (kind === 'color') {
    if (name === 'color') editor.toggleTextColor(lastColor.color);
    else editor.toggleHighlight(lastColor.highlight);
  } else if (kind === 'action') actions[name]();
  else if (name === 'links') toggleLinks();
  else if (name === 'top') toggleTopKey();
  else if (name === 'reminders') reminderPanel?.toggle();
  else if (name === 'new') api.memo.create({ color: memo.color });
  else if (name === 'close') closeTabOrWindow();
  else if (name === 'shortcuts') openShortcutSheet();
}, true);

// ---------- 본문 확대·축소 (Ctrl+마우스 휠, Ctrl+= / Ctrl+-) — 웹 브라우저처럼 글·사진·표가 함께 ----------
// 배율은 메모마다 이 PC 에 기억한다. 위 막대·서식 막대는 그대로.
const ZOOM_KEY = `memoking.zoom.${id}`;
let zoom = 1;
try {
  zoom = clampZoom(localStorage.getItem(ZOOM_KEY) ?? 1);
} catch {
  // 저장소를 못 써도 100% 로
}
const zoomBadge = document.createElement('div');
zoomBadge.className = 'zoom-badge';
zoomBadge.setAttribute('role', 'status');
const zoomText = document.createElement('span');
const zoomReset = document.createElement('button');
zoomReset.type = 'button';
zoomReset.textContent = '원래대로';
zoomReset.addEventListener('click', () => setZoom(1));
zoomBadge.append(zoomText, zoomReset);
document.body.append(zoomBadge);
let zoomTimer = 0;

// 매직 줌 (휴대폰과 같음): 100% 보다 크게는 페이지째 — 100% 의 폭으로 배치한 채 크게, 넓어지면 옆으로 밀어 보기.
// 100% 보다 작게는 글자 크기만 줄여 줄이 창 폭에 다시 맞춰진다 (넓은 표를 맞추는 축소도 이쪽)
function applyMagicZoom() {
  const root = el.editorRoot;
  const cs = getComputedStyle(root);
  const base = Math.max(200, root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  root.style.setProperty('--note-zoom', String(zoom));
  root.classList.toggle('zoomed', zoom > 1);
  // 폭은 확대되는 요소 자신에게 (저절로 맞는 폭은 확대해도 창 폭에 맞춰져 버리므로)
  for (const child of root.children) child.style.width = zoom > 1 ? `${base}px` : '';
}
new ResizeObserver(() => applyMagicZoom()).observe(el.editorRoot);

function setZoom(z, { show = true } = {}) {
  const scroller = el.editorRoot;
  // 보던 곳이 그대로 보이게: 스크롤 위치를 배율에 맞춰 옮긴다
  const ratio = scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) : 0;
  zoom = clampZoom(z);
  applyMagicZoom();
  document.body.dataset.zoom = String(zoom);
  scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  try {
    if (zoom === 1) localStorage.removeItem(ZOOM_KEY);
    else localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    // 기억 못 해도 지금 창에서는 그대로
  }
  if (!show) return;
  zoomText.textContent = zoom >= 1 ? `매직 줌: 확대 ${zoomLabel(zoom)}` : `매직 줌: 글자 ${zoomLabel(zoom)}`;
  zoomReset.hidden = zoom === 1;
  zoomBadge.classList.add('show');
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => zoomBadge.classList.remove('show'), 1600);
}
setZoom(zoom, { show: false });

// ---------- 표가 넘치면 메모를 줄여 맞추고, 더 못 줄이면 창을 넓힌다 (v0.17.13, 설정으로 끄고 켬) ----------
// 열 너비를 줄이지 않고(사용자 요청) 본문 배율(--note-zoom)을 낮춰 표 가로가 잘리지 않게 한다.
// 측정은 화면 px 로 (표는 배율이 걸린 .mk-doc 안, 편집 영역은 배율이 없음).
let fitTables = true;
let fitTimer = 0;
let growing = false;
const MIN_ZOOM = 0.5;

function widestTableWidth() {
  let w = 0;
  for (const t of el.editorRoot.querySelectorAll('.mk-doc table')) w = Math.max(w, t.getBoundingClientRect().width);
  return w;
}
function availWidth() {
  const cs = getComputedStyle(el.editorRoot);
  return el.editorRoot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

async function fitWide() {
  if (!fitTables || growing) return;
  const avail = availWidth();
  const widest = widestTableWidth();
  if (widest <= 1 || avail <= 1) return;
  if (widest <= avail + 1) return; // 이미 들어온다
  // 지금 배율에서 표가 avail 에 들어갈 배율. 더 키우지는 않는다 (줄이기만)
  const target = clampZoom(Math.max(MIN_ZOOM, (zoom * avail) / widest));
  if (target < zoom - 0.001) {
    setZoom(target);
    await new Promise((r) => requestAnimationFrame(r));
  }
  // 최소 배율에서도 넘치면 창을 넓힌다 (화면 안에서)
  const stillWidest = widestTableWidth();
  if (stillWidest > availWidth() + 1 && zoom <= MIN_ZOOM + 0.001) {
    growing = true;
    try {
      const grown = await api.win.growWidth(Math.ceil(stillWidest - availWidth()) + 8);
      if (grown > 0) {
        await new Promise((r) => requestAnimationFrame(r));
        // 창을 넓혀 공간이 생겼으면 배율을 다시 올려 본다
        const avail2 = availWidth();
        const widest2 = widestTableWidth();
        if (widest2 > 1) setZoom(Math.min(1, clampZoom((zoom * avail2) / widest2)));
      }
    } finally {
      growing = false;
    }
  }
}
const scheduleFit = () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitWide, 250);
};

// Ctrl+휠: 위로 굴리면 크게, 아래로 굴리면 작게 (창 전체가 아니라 본문만 — Chromium 의 페이지 확대는 막는다)
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (e.deltaY) setZoom(stepZoom(zoom, e.deltaY < 0 ? 1 : -1));
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey && e.code !== 'Equal') return;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setZoom(stepZoom(zoom, 1));
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') setZoom(stepZoom(zoom, -1));
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// ---------- 아래 서식 도구막대: 메모 창이 활성일 때나 마우스가 창 아래쪽에 있을 때만 (미끄러져 올라옴, v0.17.16) ----------
let barHover = false;
const barHeight = () => el.formatBar.offsetHeight || 38;
const popoverOpen = () => !el.palette.hidden || !el.morePanel.hidden || !document.getElementById('style-menu').hidden;
function updateBar() {
  document.body.style.setProperty('--bar-h', `${barHeight()}px`);
  const coaching = document.body.classList.contains('coaching'); // 튜토리얼 말풍선이 도구막대를 가리킬 수 있게
  document.body.classList.toggle('bar-hidden', !(document.hasFocus() || barHover || popoverOpen() || coaching));
}
let wasCoaching = false;
new MutationObserver(() => {
  const now = document.body.classList.contains('coaching');
  if (now !== wasCoaching) {
    wasCoaching = now;
    updateBar();
  }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('focus', updateBar);
window.addEventListener('blur', updateBar); // 창을 떠나거나 마우스가 아래쪽을 벗어나면 바로 내려간다 (v0.17.19)
document.addEventListener('mousemove', (e) => {
  const near = e.clientY >= window.innerHeight - (barHeight() + 22);
  if (near === barHover) return;
  barHover = near;
  updateBar();
});
document.documentElement.addEventListener('mouseleave', () => {
  barHover = false;
  updateBar();
});
updateBar();

// ---------- CLEAR 도장: 체크리스트를 모두 끝내면 ----------
const clearStamp = createClearStamp(document.body, el.editorRoot);
function showTasks(tasks, opts) {
  document.body.dataset.tasks = tasks.total ? `${tasks.done}/${tasks.total}` : '';
  clearStamp.show(tasks, opts);
}

// 닫을 때: 태그 없는 메모에 확실한 추천 태그를 저절로 (설정 › 태그 자동 추가, 휴대폰과 같음)
async function autoTagOnClose() {
  if (!editor || tagDismissed || memo?.locked) return; // 잠긴 메모의 태그는 목록에 보이지 않으므로 달지 않는다
  try {
    const s = await api.settings.get();
    if (s?.autoTags === false) return;
    const body = editor.getMarkdown();
    if (isBlankBody(body) || extractTags(body).length) return;
    const list = (await api.tags.suggest?.(body, id)) ?? [];
    const sure = list.filter((t) => t.sure && t.existing).slice(0, 2);
    if (sure.length) editor.appendMarkdown(sure.map((t) => `#${t.name}`).join(' '));
  } catch {
    // 태그를 못 달아도 닫기는 그대로
  }
}

async function closeWindow() {
  await recorder?.finish(); // 녹음 중이면 끝내서 메모에 넣고 닫는다
  await annotation?.exit(); // 주석을 그리던 중이면 저장하고 닫는다
  await autoTagOnClose();
  await flush();
  api.win.close();
}

// Ctrl+W: 스택이면 보이는 탭만 닫는다 (탭의 × 와 같음). 스택이 아니면 창을 닫는다.
async function closeTabOrWindow() {
  if (tabsEl.hidden) return closeWindow();
  await recorder?.finish();
  await autoTagOnClose();
  await flush();
  api.stack.remove(id);
}

// 윗막대 + : 새 메모를 이 창의 새 탭으로 (스택이 아니면 스택이 된다). 따로 새 창은 Ctrl+N
$('new-btn').addEventListener('click', async () => {
  await flush();
  api.stack.newTab(id);
});
$('close-btn').addEventListener('click', closeWindow);
el.editorRoot.addEventListener('mousedown', (e) => {
  // 글 아래 빈 곳을 눌러도 편집을 시작할 수 있게
  if (e.target === el.editorRoot) {
    e.preventDefault();
    editor.focus();
  }
});

// ---------- 메모 스택: 브라우저처럼 탭 ----------
// 탭을 누르면 메인 프로세스가 그 메모의 창을 같은 자리에 보여 준다 (창마다 메모 하나).

const tabsEl = $('stack-tabs');
let coach = null; // 튜토리얼 말풍선
const tutCounts = (md) => tutorialCounts(md, extractTags(md));
/** 직접 해 보기: 지금 단계가 이 일을 기다리면 알린다 */
function tutEvent(name) {
  if (coach?.step?.advance === name) api.tutorial.event(name);
}

const TAB_CHARS = 7;
function renderStack(state) {
  const members = state?.members ?? [];
  const stacked = members.length >= 2;
  tabsEl.hidden = !stacked;
  document.body.classList.toggle('stacked', stacked);
  if (!stacked) return tabsEl.replaceChildren();
  const tabs = members.map((m) => {
    const tab = document.createElement('div');
    tab.className = 'stack-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(m.id === id));
    tab.dataset.tabId = m.id;
    tab.dataset.color = m.color; // 탭 바탕 = 그 메모의 색
    tab.title = m.id === id ? m.title : `${m.title} (Ctrl+Tab)`;
    const title = document.createElement('span');
    title.className = 'stack-title';
    title.textContent = Array.from(m.title).slice(0, TAB_CHARS).join(''); // 줄임표 없이 앞 7자
    const close = document.createElement('button');
    close.className = 'stack-close';
    close.type = 'button';
    close.title = '탭 닫기';
    close.setAttribute('aria-label', `${m.title} 스택에서 빼기`);
    close.dataset.closeTab = m.id;
    close.append(icon('close'));
    tab.append(title, close);
    return tab;
  });
  const add = document.createElement('button');
  add.className = 'stack-add';
  add.type = 'button';
  add.title = '새 탭 (새 메모)';
  add.setAttribute('aria-label', '새 탭');
  add.append(icon('plus'));
  tabsEl.replaceChildren(...tabs, add);
}

tabsEl.addEventListener('click', async (e) => {
  const close = e.target.closest('[data-close-tab]');
  if (close) {
    if (close.dataset.closeTab === id) await flush();
    return api.stack.remove(close.dataset.closeTab);
  }
  if (e.target.closest('.stack-add')) {
    await flush();
    return api.stack.newTab(id);
  }
  const tab = e.target.closest('[data-tab-id]');
  if (tab && tab.dataset.tabId !== id) {
    await flush();
    api.stack.activate(tab.dataset.tabId);
  }
});
// 탭 끌기: 왼쪽 탭 줄 안에서는 탭이 들려 위아래로 따라오고, 탭 줄 밖(오른쪽으로 20px 넘게·창 밖)으로 끌어내면
// 그 탭이 제 메모 창이 되어 커서를 따라온다 (브라우저 탭처럼). 조금만 끌었다 놓으면 그 탭으로 전환.
// 끌어내면 탭이 화면에서 사라지므로 포인터는 문서 전체가 잡고, 화면 좌표를 메인 프로세스로 보낸다.
const TEAR_DISTANCE = 20;
let tabPress = null; // { tabId, pointerId, sx, sy, cx, el, moved, torn }
tabsEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('[data-close-tab]')) return;
  const tab = e.target.closest('[data-tab-id]');
  if (!tab) return;
  tabPress = { tabId: tab.dataset.tabId, pointerId: e.pointerId, sx: e.screenX, sy: e.screenY, cx: e.clientX - tab.getBoundingClientRect().left + 10, el: tab, moved: false, torn: false };
});
window.addEventListener('pointermove', (e) => {
  const p = tabPress;
  if (!p || e.pointerId !== p.pointerId) return;
  const dx = e.screenX - p.sx;
  const dy = e.screenY - p.sy;
  if (!p.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    p.moved = true;
    // 움직이기 시작한 뒤부터 잡는다 (그냥 누르기는 보통 click 으로)
    try {
      document.documentElement.setPointerCapture(e.pointerId);
    } catch {
      // 자동 점검의 가짜 포인터 등
    }
  }
  if (p.torn) {
    api.stack.tearMove(e.screenX, e.screenY);
    return;
  }
  const strip = tabsEl.getBoundingClientRect();
  const out = e.clientX > strip.right + TEAR_DISTANCE || e.clientX < 0 || e.clientY < 0 || e.clientY > window.innerHeight;
  if (out) {
    p.torn = true;
    p.el.classList.remove('lifting');
    p.el.style.transform = '';
    document.body.classList.remove('tab-dragging');
    if (p.tabId === id) flush();
    // 끌어낸 창은 커서가 창 왼쪽 위(윗막대)를 잡은 모양으로 따라온다
    api.stack.tearStart(p.tabId, { x: 24, y: 17 }, { x: e.screenX, y: e.screenY });
    return;
  }
  p.el.classList.add('lifting');
  document.body.classList.add('tab-dragging');
  p.el.style.transform = `translate(${Math.max(-6, Math.min(6, dx))}px, ${dy}px)`;
});
function endTabPress(e, cancelled = false) {
  const p = tabPress;
  if (!p || e.pointerId !== p.pointerId) return;
  tabPress = null;
  p.el.classList.remove('lifting');
  p.el.style.transform = '';
  document.body.classList.remove('tab-dragging');
  if (p.torn) api.stack.tearEnd(e.screenX, e.screenY);
  else if (p.moved && !cancelled && p.tabId !== id) flush().then(() => api.stack.activate(p.tabId));
}
window.addEventListener('pointerup', (e) => endTabPress(e));
window.addEventListener('pointercancel', (e) => endTabPress(e, true));

// 가운데 버튼으로 누르면 빼기 (브라우저 탭처럼), 오른쪽 클릭은 메뉴
tabsEl.addEventListener('auxclick', (e) => {
  const tab = e.target.closest('[data-tab-id]');
  if (tab && e.button === 1) api.stack.remove(tab.dataset.tabId);
});
tabsEl.addEventListener('contextmenu', (e) => {
  const tab = e.target.closest('[data-tab-id]');
  if (!tab) return;
  e.preventDefault();
  api.stack.menu(tab.dataset.tabId);
});
api.on('stack:state', renderStack);
// 다른 메모를 이 창 위로 끌고 와 머물면: 놓으면 탭으로 합쳐진다는 표시
api.on('stack:hover', (on) => {
  $('stack-drop').hidden = !on;
});
// 손 메모·주석을 그리는 동안: 창을 끌어도 다른 메모와 합치지 않게 (ink-editor.js inkMode)
window.addEventListener('memoking:inking', (e) => {
  api.win.inking?.(e.detail)?.catch?.(() => {});
});
// 다른 탭으로 바뀌어 숨겨질 때 바로 저장
document.addEventListener('visibilitychange', () => {
  if (document.hidden && editor) flush();
});

// ---------- 시작 ----------

injectIcons();
paintSwatchBars();
coach = setupCoach(api, {
  onStep: (step) => {
    tutBase = step ? tutCounts(current ?? '') : null;
    // 옮기기를 배우기 전: 옮겨 볼 예시 목록을 메모 끝에
    if (step?.sample && editor && !hasTutorialSample(editor.getMarkdown())) {
      editor.appendMarkdown(TUTORIAL_SAMPLE);
      flush();
    }
  },
});
memo = await api.memo.get(id);
// 잠긴 메모: 비밀번호를 넣어야 편집기를 만든다 (풀린 글은 메인 프로세스가 이 창을 닫을 때까지만 기억)
if (memo?.needsPassword) {
  document.body.dataset.color = memo.color;
  document.title = memo.title;
  document.body.classList.add('memo-locked');
  const opened = await lockScreen(el.editorRoot, {
    title: memo.title,
    onTry: async (password) => {
      const r = await api.memo.openLock(id, password);
      if (r?.error) return r.error;
      memo = { ...memo, ...r };
      return null;
    },
    onCancel: () => window.close(),
  });
  // "닫기": 창이 닫히는 동안 암호문으로 편집기를 만들지 않는다 (여기서 멈춤)
  if (!opened) await new Promise(() => {});
  document.body.classList.remove('memo-locked');
}
if (!memo) {
  setStatus('메모를 찾을 수 없어요. 이동했거나 삭제됐을 수 있어요', true);
} else {
  applyMeta(memo);
  applyTop(memo.onTop === true);
  renderStack(memo.stack);
  document.title = memo.title;
  current = saved = memo.body;
  editor = await createNoteEditor(el.editorRoot, {
    markdown: memo.body, onChange, onState: showActive, saveFile, fetchImage, onNotice: setStatus,
    tables: memo.tables ?? [], onTables: saveTables,
    readAttachment: async (src) => new TextDecoder().decode(await api.attachments.read(decodePath(src))),
    fetchPreview: (url) => api.links.preview(url),
    openLink: (url) => api.links.open(url),
    getTags: () => api.tags.list(),
    onEmpty: showPlaceholder,
    onTasks: showTasks,
    onDateReminder: (event) => reminderPanel?.addEvent(event) ?? false,
    hasReminderAt: (d) => reminderAt(reminderPanel?.list, d),
  });
  // 편집기가 불러온 뒤 정리한 마크다운을 기준으로 삼는다 (열기만 해도 저장되는 일 방지).
  current = saved = editor.getMarkdown();
  refreshLinks();
  scheduleTagBar();
  reminderPanel = setupReminderPanel({
    api,
    memoId: id,
    setStatus,
    onToggle: (open) => open && !el.linksPanel.hidden && toggleLinks(false),
    onChange: () => editor?.refreshDates(),
  });
  reminderPanel.set(memo.reminders);
  showLockState();
  recorder = setupVoiceRecorder({
    panel: $('rec-panel'), time: $('rec-time'), state: $('rec-state'), wave: $('rec-wave'), pause: $('rec-pause'), stop: $('rec-stop'),
    buttons: () => document.querySelectorAll('[data-action="record"]'),
    saveAudio: (bytes, ext) => api.attachments.save(bytes, ext),
    text: $('rec-text'),
    stt: sttBridge(),
    // 빈 메모면 제목을 달고, 소리(음성 카드)는 메모 끝에 (휴대폰과 같음)
    insert: async (card, heading) => {
      if (isBlankBody(editor.getMarkdown())) editor.setMarkdown(`# ${heading}\n`);
      editor.appendMarkdown(card);
      await flush();
    },
    notice: setStatus,
  });
  if (memo.alarm) showAlarm(memo.alarm);
  editor.focus();
  if (memo.capture) await applyCapture(memo.capture);
  if (params.get('record') === '1') recorder.start(); // 목록 + › 음성 메모
  if (params.get('ink') === '1') editor.insertInk(); // 목록 + › 손 메모
  // 주석: 메모 위에 겹쳐 그린 손 메모 (머리말 ink: 의 파일)
  annotation = setupAnnotation({
    scroller: el.editorRoot,
    docEl: () => el.editorRoot.querySelector('.ProseMirror'),
    read: async () => (memo.ink ? JSON.parse(new TextDecoder().decode(await api.attachments.read(memo.ink))) : null),
    save: async (data) => {
      const rel = data ? await saveFile(new File([JSON.stringify(data)], '글 위에 그리기.json', { type: 'application/json' })) : '';
      const next = await api.memo.set(id, { ink: rel });
      if (next) memo = { ...memo, ...next };
    },
    onMode: (on) => {
      setStatus(on ? '글 위에 그리기. 다 그렸으면 완료 (Esc)' : '');
      if (!on) {
        editor.focus();
        tutEvent('annotate-done');
      }
    },
    notice: setStatus,
  });
  annotation.start();
  annotation.load(Boolean(memo.ink));
  // 표가 넘치면 메모를 줄여 맞추기 (설정) — 열 때 한 번, 그리고 본문이 바뀔 때(표 붙여넣기·넣기)
  try {
    fitTables = (await api.settings.get())?.fitTables !== false;
  } catch {
    // 설정을 못 읽으면 기본(켜짐)
  }
  new MutationObserver(scheduleFit).observe(el.editorRoot, { childList: true, subtree: true, characterData: true });
  scheduleFit();
  document.documentElement.dataset.ready = 'true';
}

attachSliders(document, '.seg'); // 알림 종류 고르기: 선택 표시가 미끄러진다

// 고르기 칸(role=radiogroup): 칸마다 radio, 화살표로 고르기 (dom.js)
radioGroups();
