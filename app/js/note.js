// 스티커 메모 창 — 메모 1개 = 창 1개 = 파일 1개.
import { injectIcons, icon } from './icons.js';
import { COPY_ICON, SHARE_ICON, SAVE_ICON, TRASH_ICON } from './content-icons.js';
import { shareMemo } from './list-card-menu.js';
import { createNoteEditor } from './editor.js';
import { setCopyHost } from './copy-content.js';
import { hideDeleteButton } from './delete-button.js';
import { attachStatusBubble, statusChanged } from './status-bubble.js';
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
import { reduceMotion, replayClass, menuKeys, focusFirstIfKeyboard, radioGroups, swipeDismiss, EASE_OUT } from './dom.js';
import { createClearStamp } from './clear-stamp.js';
import { fillSuggestChips, trackPlaceholder } from './suggest-chips.js';
import { renderVersions } from './versions-view.js';
import { hintOnce } from './hints.js';
import { toggleShortcutSheet } from './shortcut-sheet.js';
import { chooseShare, showSharePop } from './share-menu.js';
import { KEYMAP_ACTIONS, keymapTable, resolveKeymap, comboLabel } from './core/keymap.js';
import { hotkeyDialog } from './hotkey-dialog.js';
import { hotkeyLabel } from './core/memo-hotkeys.js';
import { openMemoryDay, dayText } from './memory-day.js';
import { memoMode, otherMode, moveLabel, MODE_LABEL, fillModeTag } from './core/modes.js';
import { createFindBar } from './find-bar.js';
import { createAiWritePanel } from './ai-write-panel.js';
import { UI } from './core/ui-text.js';
import { paintTableBar, bindTableBar, createPalette, linkItem as sharedLinkItem, showNoteBanner } from './note-shared.js';

const SAVE_DELAY = 600;

const api = window.memoking;
// 복사 단추 · 그림 Ctrl+C: 시스템 클립보드에 그림 그대로 / 서식 + 글
setCopyHost({
  image: (b64) => api.image.copy(b64),
  text: ({ text, html }) => api.copyRich({ text, html }),
  file: (href) => api.attachments.copy(href), // PDF · 소리 같은 첨부는 파일 그대로
  // 저장 단추: 어디에 저장할지 고르는 창 → 저장한 파일 이름 | 'cancelled'
  save: async (f) => {
    const r = await api.attachments.saveAs(f);
    if (r?.error) throw new Error(r.error);
    return r?.cancelled ? 'cancelled' : r.name;
  },
  // 공유 단추: 방법을 고른다 (Google Drive 링크 · LocalSend · 메일) — share-menu.js
  share: async (f, target) => {
    const targets = await api.attachments.shareTargets();
    // 메뉴는 공유 단추 자리에 (오른쪽 클릭 메뉴로 고르면 그 내용 자리에) — 내용 위의 단추 4개(지우기 · 복사 · 저장 · 공유)는 먼저 거둬 메뉴 위에 남지 않게
    const at = (document.querySelector('.mk-share-btn') ?? target ?? document.activeElement ?? document.body).getBoundingClientRect();
    hideDeleteButton(true);
    const via = await chooseShare({ getBoundingClientRect: () => at }, targets);
    if (!via) return 'cancelled';
    if (via === 'drive') setStatus(UI.driveUploading);
    const r = await api.attachments.share({ ...f, via });
    if (r?.error) throw new Error(r.error);
    if (r?.missing) return 'localsend-missing';
    if (via === 'drive') showSharePop({ title: UI.linkCopied, sub: UI.pasteHint });
    return { drive: 'link', localsend: 'localsend', mail: 'mail' }[via];
  },
  dragOut: (payload) => api.attachments.dragOut(payload), // 메모 안 내용을 탐색기 · 카카오톡으로 끌어내기 (block-move.js)
  pathOf: (file) => api.attachments.pathOf(file),
  contentMenu: true, // 내용을 오른쪽 클릭하면 아이콘 줄이 있는 메뉴 (block-move.js · ctx-menu.js) — 마우스를 올려도 단추가 뜨지 않는다
});
// 저장 단추의 결과 (delete-button.js)
window.addEventListener('mk:notice', (e) => setStatus(e.detail?.text ?? '', Boolean(e.detail?.error)));
const params = new URLSearchParams(location.search);
// 미리 불러 둔 예비 창(window-manager.js makeSpare): 편집기 코드는 다 읽어 두고, 열 메모가 정해질 때까지 기다린다
if (params.get('spare') === '1') {
  const job = await api.win.spare();
  if (!job?.id) {
    window.close();
    await new Promise(() => {});
  }
  params.delete('spare');
  params.set('id', job.id);
  if (job.record) params.set('record', '1');
  if (job.ink) params.set('ink', '1');
  try {
    history.replaceState(null, '', `${location.pathname}?${params}`); // 새로 고쳐도 같은 메모
  } catch {
    // 주소를 못 바꿔도 이 창은 그대로
  }
}
const id = params.get('id');
// 메모를 그렸다 → 예비 창이면 이제 보여 달라고 (보통 창은 ready-to-show 로 이미 보임 — 메인이 무시)
let paintedSent = false;
function markPainted() {
  if (paintedSent) return;
  paintedSent = true;
  let done = false;
  const send = () => {
    if (done) return;
    done = true;
    api.win.painted?.();
  };
  requestAnimationFrame(() => requestAnimationFrame(send));
  setTimeout(send, 120); // 숨은 창이라 그리기가 멈춰 있어도
}
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
  dayBtn: $('day-btn'),
  topBtn: $('top-btn'),
  tapeBtn: $('tape-btn'),
  banner: $('banner'),
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
attachStatusBubble(el.status);

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
  statusChanged(); // 창이 좁아 잘리면 말풍선으로 전문 (status-bubble.js)
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
  const ai = (await api.ai?.status().catch(() => null))?.chat.state;
  if (seq !== tagSeq) return;
  fillSuggestChips($('tag-suggest-chips'), list, addTags);
  $('tag-ai-btn').hidden = !['ready', 'running'].includes(ai); // 글 모델을 넣은 PC 에서만
  tagBar.hidden = list.length === 0; // 추천이 있을 때만 (AI 단추만으로 모든 메모에 막대를 띄우지 않게 — 닫을 때 AI 태그는 그대로)
}
// AI로 고르기: 쓰는 동안 저절로 돌리면 8GB PC 가 무거워져 누를 때만 (모델은 이 PC 안)
$('tag-ai-btn')?.addEventListener('click', async () => {
  const btn = $('tag-ai-btn');
  const seq = ++tagSeq;
  btn.disabled = true;
  btn.textContent = 'AI가 고르는 중…';
  const r = await api.tags.ai(editor.getMarkdown(), id).catch((err) => ({ error: err.message }));
  btn.disabled = false;
  btn.textContent = 'AI로 고르기';
  if (seq !== tagSeq) return;
  if (r.error) return setStatus(r.error, true);
  if (!r.length) return setStatus('AI가 맞는 태그를 찾지 못했어요');
  fillSuggestChips($('tag-suggest-chips'), r, addTags);
});
function addTags(names) {
  if (!editor || !names.length) return;
  editor.appendMarkdown(names.map((n) => `#${n}`).join(' '));
  flush();
  setStatus(`${names.map((n) => `#${n}`).join(' ')} 태그를 달았어요`);
  tagBar.hidden = true;
}
tagBar?.addEventListener('mousedown', (e) => e.preventDefault()); // 커서 유지
// AI 가 뒤에서 한 일 (매직키 다듬기 · 일정 자동 등록): 알림을 눌러 열면 아래 막대에서 되돌리기 (메인 aiNotices)
function showAiNotice(n) {
  const bar = $('ai-notice-bar');
  if (!bar) return;
  bar.hidden = !n;
  if (n) $('ai-notice-text').textContent = n.text;
}
api.ai?.notice(id).then(showAiNotice, () => {});
api.on('ai:notice', showAiNotice);
$('ai-notice-undo')?.addEventListener('click', async () => {
  const r = await api.ai.noticeUndo(id).catch(() => null);
  showAiNotice(r?.next ?? null);
  if (r?.message) setStatus(r.message, !r.ok);
});
$('ai-notice-close')?.addEventListener('click', async () => showAiNotice(await api.ai.noticeDismiss(id).catch(() => null)));
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
    const r = await api.memo.save(id, body);
    if (r?.retry) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 800); // 파일을 다시 읽은 뒤 다시 저장 (지워졌으면 새로, 잠겼으면 잠금 안내)
      return;
    }
    if (r?.invalid) return setStatus('잠금 메모 형식의 글은 그대로 저장할 수 없어요 (아무도 열 수 없게 돼요). 글을 고쳐 주세요', true);
    if (r?.refused) {
      // 다른 기기가 이 메모를 잠갔다 — 파일은 그쪽 것 그대로. 사본으로 남겼으면 쓴 글은 안전, 아니면 아직 저장 안 된 글로 둔다
      if (r.copied) {
        saved = body;
        setStatus(UI.lockedElsewhereCopy, true);
      } else setStatus('잠긴 메모라 저장하지 못했어요. 쓰던 글을 복사해 두세요', true);
      return;
    }
    saved = body;
    setStatus('저장했어요');
  } catch (err) {
    console.error(err);
    setStatus('저장하지 못했어요. 메모 폴더를 확인해 주세요', true);
  }
}

// 창을 닫는 순간 — 남은 내용을 동기 저장 (업데이트 설치로 다시 시작하기 전에도 main 이 부른다: mkFlushSync)
function flushSync() {
  clearTimeout(saveTimer);
  if (isDirty()) {
    api.memo.saveSync(id, current);
    saved = current;
  }
  flushTables();
}
window.mkFlushSync = flushSync;
window.addEventListener('beforeunload', flushSync);

// ---------- 다른 곳(다른 PC, 다른 앱)에서 바뀐 경우 ----------

function applyExternal(next) {
  editor.setMarkdown(next.body, next.tables ?? []);
  current = saved = editor.getMarkdown();
  el.banner.hidden = true;
  pendingExternal = null;
  setStatus(UI.reloaded);
}

let conflictCopy = null; // 쓰는 중에 다른 기기에서도 고쳐 들어온 내용을 따로 남긴 사본 메모 (창이 열린 동안 한 사본만)

const showBanner = (text, { load = null, keep = UI.keepMine } = {}) => showNoteBanner(text, { load, keep });

// 고를 것이 없는 안내("다른 기기에서도 고쳤어요 · 확인")는 옆으로 밀어 닫는다 — 바뀐 내용을 볼지 고르는 중이면 제자리로
swipeDismiss(el.banner, () => $('banner-keep').click(), { can: () => !pendingExternal });

api.on('memo:external', async (next) => {
  // 아직 편집기가 없다(잠긴 메모의 비밀번호 화면) — 비밀번호 화면은 열 때 지금 파일로 푸므로 할 일이 없다
  // (같은 비밀번호로 다른 기기가 고친 것을 "비밀번호를 바꿨어요" 로 오해해 창을 닫지 않게)
  if (!next || !editor) return;
  if (next.needsPassword) {
    // 다른 기기에서 이 메모를 잠갔거나(이 창에선 안 잠긴 메모) 다른 비밀번호로 다시 잠갔다 — 이 창의 열쇠로는 풀 수 없으니
    // 메모를 덮어쓰지 않는다. 다만 아직 저장 못 한 쓰던 글은 사본 메모로 먼저 남긴 뒤 닫는다 (쓰던 글이 사라지지 않게)
    clearTimeout(saveTimer);
    const wasLocked = Boolean(memo?.locked);
    const what = wasLocked ? UI.passwordChangedElsewhere : UI.lockedElsewhere;
    let kept = '';
    const snapshot = isDirty() ? current : null; // 사본으로 남길 글 (기다리는 동안 더 친 글은 창을 닫을 때 다시 사본으로)
    if (snapshot !== null && !isBlankBody(snapshot)) {
      try {
        const copy = await api.memo.keepCopy(id, snapshot, null, { unlocked: !wasLocked });
        if (copy) kept = wasLocked ? UI.copyOldPassword : UI.copyKept;
      } catch (err) {
        console.error(err);
      }
      if (!kept) {
        // 사본도 못 만들었다 — 창을 닫지 않고 글을 그대로 둔다 (복사해 둘 수 있게)
        setStatus(`${what} 쓰던 내용을 저장하지 못했어요. 글을 복사해 두세요`, true);
        return;
      }
    }
    if (snapshot !== null) saved = snapshot;
    setStatus(`${what}${kept} 다시 열 때 비밀번호를 넣어 주세요`, true);
    setTimeout(() => window.close(), kept ? 4000 : 2500);
    return;
  }
  // 다른 기기에서 잠금을 풀었으면(또는 이 창의 열쇠로 풀리는 잠금이면) 메뉴의 잠금 상태를 맞춘다
  if (Boolean(memo?.locked) !== Boolean(next.locked)) {
    memo = { ...memo, locked: next.locked };
    showLockState();
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
    showBanner(UI.changedElsewhere, { load: UI.showChanges, keep: UI.keepMine });
    return;
  }
  pendingExternal = null;
  await flush();
  showBanner(conflictCopy ? UI.conflictSaved : UI.conflict, { load: conflictCopy ? UI.showTheirs : null, keep: '확인' });
});
api.on('settings:link-previews', (on) => editor?.setLinkPreviews(on));
// Work / Life 나누기: 메뉴의 "Work로 옮기기"는 나눠 쓸 때만 (밝기는 늘 시스템 설정 — 0.70.0)
function showModeTheme() {
  $('mode-btn').hidden = !memo?.workLife;
  fillModeTag($('mode-tag'), memo, Boolean(memo?.workLife));
}
api.on('mode:changed', ({ enabled } = {}) => {
  if (!memo) return;
  memo = { ...memo, workLife: Boolean(enabled) };
  showModeTheme();
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
  el.pinToggle.querySelector('span').textContent = memo.pinned ? UI.unpin : UI.pin;
  $('day-label').textContent = memo.day ? dayText(memo.day) : UI.madeDay;
  $('mode-btn').querySelector('span').textContent = moveLabel(memo);
  showModeTheme();
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
// Work ↔ Life 로 옮기기 — 메모 화면도 그 모드의 밝기로
async function moveMode(to) {
  await flush();
  const next = await api.memo.set(id, { mode: to });
  if (!next) return setStatus(UI.moveFail, true);
  applyMeta(next);
  setStatus(`${MODE_LABEL[to]}로 옮겼어요`);
}
// Work ↔ Life 로 옮기기 (목록에서는 그 모드에서 보인다)
$('mode-btn').addEventListener('click', () => {
  closeMenu();
  moveMode(otherMode(memoMode(memo)));
});
// 회상 달력에서 이 메모를 둘 날 (memory-day.js)
el.dayBtn.addEventListener('click', async () => {
  closeMenu();
  await flush();
  const day = await openMemoryDay({ created: memo.created, day: memo.day });
  if (day !== null) applyMeta(await api.memo.set(id, { day }));
});
// ---------- 왕관(늘 위) · 테이프(바탕화면에 붙이기) ----------

// 스티커를 붙이고 떼는 느낌: 왕관이나 테이프를 누르면 그것이 떨어져 나가 창 위 가장자리 스티커가 되고,
// 스티커를 누르면 떼어져 꺼지고 버튼으로 돌아온다 (메인 프로세스가 따로 띄우는 스티커 창). 둘은 함께 붙지 않아서
// 하나가 붙어 있는 동안 두 버튼 모두 사라진다 — 고른 버튼은 빈 자리로 남고(날아간 자리), 다른 하나는 접힌다.
let layer = null; // { top, bottom, canTape }
const stickerHint = { tape: '테이프를 누르면 떼어져요', crown: '왕관을 누르면 떼어져요' };
function flyButton(btn, off) {
  if (reduceMotion()) return;
  btn.querySelector('svg').animate(off
    ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px) rotate(-12deg) scale(0.7)' }]
    : [{ opacity: 0, transform: 'scale(0.4) rotate(12deg)' }, { opacity: 1, transform: 'scale(1.15)', offset: 0.7 }, { opacity: 1, transform: 'none' }],
  { duration: off ? 200 : 280, easing: EASE_OUT });
}
function applyLayer(next) {
  const top = next?.top === true;
  const bottom = next?.bottom === true;
  const prev = layer;
  layer = { top, bottom, canTape: next?.canTape === true };
  const stuck = top || bottom;
  const hadFocus = [el.topBtn, el.tapeBtn].includes(document.activeElement);
  el.tapeBtn.hidden = !layer.canTape; // 바탕화면 층에 붙일 수 없는 PC (Windows 가 아님 등)
  for (const [btn, mine] of [[el.topBtn, top], [el.tapeBtn, bottom]]) {
    btn.classList.toggle('peeled', mine);
    btn.classList.toggle('folded', stuck && !mine);
    btn.tabIndex = stuck ? -1 : 0;
    btn.setAttribute('aria-hidden', String(stuck));
    btn.setAttribute('aria-pressed', String(mine));
    if (prev && (prev.top || prev.bottom) !== stuck) flyButton(btn, stuck);
  }
  el.topBtn.setAttribute('aria-label', '다른 창보다 늘 위에 두기');
  el.tapeBtn.setAttribute('aria-label', '바탕화면에 붙여 다른 창 뒤에 두기');
  document.body.classList.toggle('on-top', top);
  document.body.classList.toggle('on-desktop', bottom);
  if (stuck && hadFocus) editor?.focus(); // 사라진 버튼에 포커스가 남지 않게
  // 무엇이 바뀌었는지 (스크린 리더에도 — 상태 줄은 role=status). 처음 열 때는 말하지 않는다
  if (!prev) return;
  if ((prev.top || prev.bottom) && (top !== prev.top || bottom !== prev.bottom)) clearStickerHint(); // 떼어진 스티커의 "누르면 떼어져요" 가 남지 않게
  if (bottom && !prev.bottom) setStatus('바탕화면에 붙였어요');
  else if (!bottom && prev.bottom) setStatus(next.note || (top ? '' : '바탕화면에서 뗐어요')); // 목록에서 골라 떼어졌으면 그 까닭
  if (top && !prev.top) setStatus('늘 위에 둬요');
  else if (!top && prev.top && !bottom && el.status.textContent === '늘 위에 둬요') setStatus('');
}

// 버튼은 붙이기만 (붙으면 두 버튼이 숨고, 떼기는 창 위의 스티커를 눌러서). 단축키는 붙이고 떼기 둘 다
async function toggleLayer(which) {
  if (!memo || document.body.classList.contains('memo-locked')) return; // 잠금을 풀기 전에는
  const next = await api.win.toggleLayer(id, which);
  if (!next) return;
  applyLayer(next);
  if (next.top) tutEvent('crown-on'); // 튜토리얼은 왕관으로만 (테이프는 메모를 다른 창 뒤로 보내 다음 말풍선이 가려진다)
}
el.topBtn.addEventListener('click', () => !layer?.top && !layer?.bottom && toggleLayer('top'));
el.tapeBtn.addEventListener('click', () => !layer?.top && !layer?.bottom && toggleLayer('bottom'));
// 스티커에 마우스를 올리면 무엇을 누르는지 상태 줄에 (스티커 창은 글을 띄우지 못한다)
//   왕관 · 테이프마다 처음 한 번만 — 한 번 알면 그다음부터는 띄우지 않는다
const STICKER_HINT_KEY = 'memoking.stickerHintSeen';
const stickerHintSeen = (kind) => {
  try {
    return JSON.parse(localStorage.getItem(STICKER_HINT_KEY) ?? '[]').includes(kind);
  } catch {
    return false;
  }
};
const rememberStickerHint = (kind) => {
  try {
    const seen = JSON.parse(localStorage.getItem(STICKER_HINT_KEY) ?? '[]');
    if (!seen.includes(kind)) localStorage.setItem(STICKER_HINT_KEY, JSON.stringify([...seen, kind]));
  } catch {
    // 기억 못 하면 다음에 한 번 더 볼 뿐
  }
};
function clearStickerHint() {
  if (Object.values(stickerHint).includes(el.status.textContent)) setStatus('');
}
api.on('sticker:hover', ({ kind, over } = {}) => {
  const hint = stickerHint[kind];
  if (!hint) return;
  if (!over) return el.status.textContent === hint && setStatus('');
  if (stickerHintSeen(kind)) return;
  rememberStickerHint(kind);
  setStatus(hint);
});
// 바탕화면에 붙인 메모는 탐색기가 다시 시작될 때 창이 함께 없어질 수 있어, 다른 데를 누르면 바로 저장해 둔다
window.addEventListener('blur', () => {
  if (layer?.bottom) flush();
});
// 메모를 그림 카드(PNG) 한 장으로 — 메모 색 종이에 본문 그대로 (휴대폰 "그림으로 공유" 와 같은 모양)
async function memoImage(kind) {
  closeMenu();
  await flush();
  setStatus('그림을 만드는 중');
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
// 메뉴 맨 위 아이콘: 목록 카드 메뉴와 같은 그림 · 같은 순서 · 같은 일 (같은 아이콘은 같은 뜻)
$('copy-text-btn').innerHTML = COPY_ICON;
$('share-btn').innerHTML = SHARE_ICON;
$('pdf-btn').innerHTML = SAVE_ICON;
$('delete-btn').innerHTML = TRASH_ICON;
$('copy-text-btn').addEventListener('click', async () => {
  closeMenu();
  await flush(); // 지금 적은 글까지
  setStatus((await api.memo.copyText(id).catch(() => false)) ? UI.textCopied : memo?.locked ? '잠긴 메모는 잠금을 풀어야 복사할 수 있어요' : UI.copyFail);
});
$('share-btn').addEventListener('click', async () => {
  const r = el.menuBtn.getBoundingClientRect();
  closeMenu();
  await flush();
  await shareMemo({ id }, { x: Math.round(r.left), y: Math.round(r.bottom) }, api, { flash: (text) => setStatus(text) });
});
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
    const ok = await confirmDialog(UI.unlockAsk, '잠금 풀기');
    if (!ok) return;
    const r = await api.memo.unlock(id);
    if (r?.error) return setStatus(r.error, true);
    memo = { ...memo, ...r };
    showLockState();
    setStatus(UI.unlocked);
    return;
  }
  const locked = await lockDialog({
    title: memo?.title ?? '',
    onLock: async (password, { hideTitle }) => {
      await flush();
      const r = await api.memo.lock(id, password, { hideTitle });
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
// 단축키 정하기 (Ctrl+Alt+1~9): 어느 앱에서든 이 메모를 복사하거나 띄운다 (hotkey-dialog.js)
//   윗막대 번개 단추는 정했을 때만 (숫자를 작게) · ⋯ 메뉴에서 정하기 (다른 메모가 그 숫자를 가져갈 수 있어 창에 돌아올 때마다 다시 본다)
function showHotkey(state) {
  const btn = $('hotkey-btn');
  const slot = state?.slot ?? null;
  $('hotkey-num').textContent = slot ? String(slot) : '';
  btn.classList.toggle('off', !slot);
  const what = slot ? `${hotkeyLabel(slot)}로 불러와요` : '아직 없어요';
  btn.title = `불러오기 키 정하기: ${what} (Ctrl+Alt+숫자로 어디서든 이 메모를 불러와요)`;
  btn.setAttribute('aria-label', `불러오기 키 정하기, ${slot ? hotkeyLabel(slot) : '아직 없음'}`);
  $('hotkey-menu-label').textContent = slot ? hotkeyLabel(slot) : 'Ctrl+Alt+숫자'; // 정하기 전에도 무슨 키인지
}
const refreshHotkey = () => api.hotkeys?.state(id).then(showHotkey, () => {});
window.addEventListener('focus', () => memo && refreshHotkey());
async function editHotkey() {
  closeMenu();
  await flush();
  const state = await api.hotkeys.state(id);
  const next = await hotkeyDialog({ state, locked: Boolean(memo?.locked), onSave: (slot, opts) => api.hotkeys.set(id, slot, opts) });
  editor?.focus();
  if (!next) return;
  showHotkey(next);
  setStatus(next.slot ? `단축키를 정했어요: ${hotkeyLabel(next.slot)}` : '단축키를 풀었어요');
}
$('hotkey-btn').addEventListener('click', editHotkey);
$('hotkey-menu-btn').addEventListener('click', editHotkey);
// 메모 단축키로 복사하기 직전: 막 고친 글까지 저장 (main.js memoHotkeyPressed)
window.__memokingFlush = () => flush();
$('image-save-btn').addEventListener('click', () => memoImage('save'));
$('pdf-btn').addEventListener('click', async () => {
  closeMenu();
  await flush(); // 지금 적은 내용까지 PDF 에
  api.pdf.open(id);
});
// 첨부 경로 (attachments/%EC… → 풀린 이름)
function decodePath(src) {
  try {
    return decodeURI(src);
  } catch {
    return src; // 이미 풀린 경로
  }
}
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
    await document.body.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(24px) scale(0.92)' }], { duration: 180, easing: EASE_OUT, fill: 'forwards' }).finished.catch(() => {});
  }
  await api.memo.remove(id);
});

api.on('memo:meta', applyMeta);

function toggleMenu(e) {
  el.menu.hidden = !el.menu.hidden;
  el.menuBtn.setAttribute('aria-expanded', String(!el.menu.hidden));
  if (!el.menu.hidden) focusFirstIfKeyboard(e, el.menu, '.menu-item:not(.menu-ic)'); // 키보드로 열면 글 메뉴 첫 항목에 (위 아이콘 줄은 ↑ · Home 으로)
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

const linkItem = (target, opts = {}) => sharedLinkItem(target, { ...opts, onOpen: () => api.memo.open(target.id) });

async function setLink(targetId, on) {
  await flush();
  if (!(await api.memo.link(id, targetId, on))) setStatus(UI.linkSaveFail, true);
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
    if (aiPanel?.open) aiPanel.toggle(false);
    await flush();
    await refreshLinks();
    el.linkSearch.focus();
  } else editor.focus();
}
el.linksBtn.addEventListener('click', () => {
  closeMenu(); // ⋯ 메뉴 안의 항목
  toggleLinks();
});

// ---------- 이전 버전 ----------

const versionsPanel = $('versions-panel');
async function refreshVersions() {
  const versions = await api.memo.versions(id);
  renderVersions($('versions-list'), versions, restoreVersion);
}
async function restoreVersion(name) {
  await flush(); // 지금 내용이 버전으로 남도록 먼저 저장
  const restored = await api.memo.restoreVersion(id, name);
  if (!restored) return setStatus(UI.versionMissing, true);
  if (restored.error) return setStatus(restored.error, true);
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
    if (aiPanel?.open) aiPanel.toggle(false);
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

// ---------- AI 글쓰기 (서식 막대 끝 ✦ → ai-write-panel.js) ----------
const aiBtn = $('ai-btn');
const aiPanel = api.ai ? createAiWritePanel({
  panel: $('ai-pop'),
  api,
  editor: () => editor,
  title: () => extractTitle(editor?.getMarkdown() ?? ''),
  onOpen: () => {
    closeMore();
    closePalette();
  },
  show: (p) => {
    p.hidden = false;
    placePopover(p, aiBtn);
    aiBtn.setAttribute('aria-expanded', 'true');
  },
  hide: (p) => {
    p.hidden = true;
    aiBtn.setAttribute('aria-expanded', 'false');
    editor?.focus();
  },
}) : null;
aiBtn.addEventListener('click', () => aiPanel?.toggle());
// ✦ 는 글 모델을 넣어 둔 PC 에서만 (설정 › AI 도우미) — 설정에서 넣고 돌아와도 보이게 창에 들어올 때마다
async function showAiBtn() {
  const st = await api.ai?.status().catch(() => null);
  aiBtn.hidden = !['ready', 'running'].includes(st?.chat.state);
}
if (api.ai) {
  showAiBtn();
  window.addEventListener('focus', showAiBtn);
}
// 끌어서 합치기(스택)의 메뉴 버전 — 끌기가 어려운 사람도
$('join-btn').addEventListener('click', async () => {
  closeMenu();
  await flush();
  api.stack.joinMenu(id);
});
// 단축키 모음: 전역 단축키(매직 카피·매직키)는 설정에서 바꾼 키로
async function openShortcutSheet() {
  let keys;
  try {
    const s = await api.settings.get();
    keys = { quickMemo: s.shortcuts?.quickMemo?.key, magic: s.shortcuts?.magic?.key };
  } catch {
    keys = undefined;
  }
  toggleShortcutSheet(keys, keymapOverrides);
}
$('shortcuts-btn').addEventListener('click', () => {
  closeMenu();
  openShortcutSheet();
});
// 메모 안 찾기 · 바꾸기 (Ctrl+F · Ctrl+H, 메뉴 › 찾기, 바꾸기) — 워드처럼 한 막대에서 찾기 · 바꾸기 · 모두 바꾸기
const findBar = createFindBar({ host: document.body, after: document.querySelector('body > .bar'), find: () => editor?.find, notify: (text, o) => setStatus(o?.undo ? `${text}. 되돌리려면 Ctrl+Z` : text) });
$('find-btn').addEventListener('click', () => {
  closeMenu();
  findBar.open();
});
// 메모 창을 몇 번 써 본 뒤 한 번: 단축키 모음이 있다는 것
setTimeout(() => {
  const k = resolveKeymap(keymapOverrides).shortcuts[0];
  hintOnce('shortcuts', k ? `${comboLabel(k)}를 누르면 단축키를 한눈에 볼 수 있어요` : '메뉴의 단축키 보기에서 단축키를 한눈에 볼 수 있어요', { anchor: el.menuBtn });
}, 2500);
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
// 밖(목록 카드 오른쪽 클릭)에서 부탁한 일: 메뉴의 그 단추를 누른 것과 같게
function runCommand(command) {
  if ((command === 'lock' && !memo?.locked) || (command === 'unlock' && memo?.locked)) $('lock-btn').click();
  else if (command === 'versions') $('versions-btn').click();
}
api.on('memo:command', runCommand);
// 오른쪽 클릭 메뉴(메인) › 서식 없이 붙여넣기 · 서식 지우기 — 편집기가 맡는다 (Ctrl+Shift+V · Ctrl+\\ 와 같은 일)
api.on('edit:paste-plain', (text) => {
  if (editor?.pastePlain(text)) return;
  if (text && document.activeElement?.matches('input, textarea')) document.execCommand('insertText', false, text); // 편집기가 아닌 글 칸(찾기 등)
});
api.on('edit:clear-format', () => editor?.run('clearFormat'));
// 표 오른쪽 클릭 메뉴(block-move.js)의 글 항목 · 표 바꾸기 — 메뉴가 닫히며 편집기에 포커스를 돌려준 뒤에 온다
window.addEventListener('mk:edit', (e) => {
  const name = e.detail?.name;
  if (name === 'clear-format') editor?.run('clearFormat');
  else if (name === 'paste-plain') api.edit.run('pastePlain');
  else if (name === 'copy-text') api.edit.run('copy');
  else if (['cut', 'paste'].includes(name)) api.edit.run(name);
});
window.addEventListener('mk:table-command', (e) => editor?.tableCommand(e.detail?.name));

// 매직 카피 알림을 눌러 이 메모로 왔을 때 등: 창 테두리가 두 번 반짝여 "이 메모" 임을 알린다
api.on('memo:highlight', () => {
  replayClass(document.body, 'highlight');
});
document.body.addEventListener('animationend', (e) => {
  if (e.animationName === 'note-highlight') document.body.classList.remove('highlight');
});
api.on('memo:reminders', (list) => reminderPanel?.set(list));
// 스티커를 눌러 뗐을 때 · 스택의 다른 탭에서 왕관 · 테이프를 바꾼 경우 (이 창은 숨어 있었음)
api.on('memo:layer', (state) => applyLayer(state));

// ---------- 매직 카피 (Ctrl+Alt+C) ----------
// 메인 프로세스가 복사해 온 내용으로 새 메모를 채운다: 제목(파일·그림일 때) → 글(붙여넣기) → 파일·그림 → 출처

const escapeMd = (s) => s.replace(/([\\`*_[\]<>#])/g, '\\$1');

async function applyCapture(c) {
  if (c.heading) editor.setMarkdown(`# ${escapeMd(c.heading)}\n`);
  editor.focusEnd();
  if (c.html || c.text) editor.pasteData({ html: c.html, text: c.text });
  editor.insertItems(await editor.arrangeItems(c.items)); // 사진 여러 장 · 문서는 어떻게 넣을지 묻는다 (+ 로 넣을 때와 같게)
  await new Promise((r) => setTimeout(r, 30)); // 붙여넣기가 반영된 뒤
  editor.appendMarkdown(c.sourceMd);
  editor.focusEnd();
  // 웹 사진을 받는 중에 저장하면 주소 교체와 엇갈릴 수 있어, 받기가 끝난 뒤 한 번에 저장
  if (c.html) {
    setStatus('사진을 저장하는 중');
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
    if (!image) throw new Error(UI.imageType);
    return api.attachments.save(image.bytes, image.ext);
  }
  return api.attachments.fetch(src);
}

async function insertFiles(files) {
  try {
    await editor.insertFiles(files);
  } catch (err) {
    console.error(err);
    setStatus(UI.fileAddFail, true);
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
  const openBtn = e.target.closest?.('.mk-file-open');
  if (openBtn && el.editorRoot.contains(openBtn)) {
    e.preventDefault();
    e.stopPropagation();
    openHref(openBtn.dataset.fileOpen);
    return;
  }
  const a = e.target.closest?.('a[href]');
  if (!a || !el.editorRoot.contains(a)) return;
  e.preventDefault();
  const href = a.getAttribute('href') || '';
  if (href.startsWith('attachments/') && !e.mkOpen) return;
  // 글자를 끌어서 고르던 중이면 열지 않는다
  if (!e.mkOpen && !window.getSelection()?.isCollapsed) return; // "열기" 단추로 연 것은 고른 글자와 상관없이
  openHref(href);
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
  const fileChip = e.target.closest?.('a[href^="attachments/"]');
  if (fileChip && el.editorRoot.contains(fileChip)) {
    e.preventDefault();
    openHref(fileChip.getAttribute('href'));
    return;
  }
  const img = e.target.closest?.('img.mk-image');
  if (!img || img.classList.contains('mk-album-img')) return; // 묶음 사진은 한 번 눌러 크게 보기 (editor.js)
  const target = vaultPathOf(img.src);
  if (!target) return;
  e.preventDefault();
  openHref(target);
});

// 파일 칩에 마우스를 올리면 이름·크기 안내 (PC는 누르면 바로 열리고, 휴대폰은 눌러서 나오는 단추 줄의 "열기" — block-move.js)
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
// 색판 (휴대폰과 같은 코드 — note-shared.js). 고르면 더 보기 판도 닫는다
const palette = createPalette({ palette: el.palette, palettes: PALETTES, place: (pop, anchor) => placePopover(pop, anchor), afterApply: () => closeMore() });
const { applied: appliedColor, last: lastColor } = palette;
const closePalette = () => palette.close();

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
// 위성 단추 뒤를 옅게 덮는다 (휴대폰처럼 + 단추만 또렷하게) — 누르면 닫힘
const addScrim = Object.assign(document.createElement('div'), { className: 'add-scrim', hidden: true });
addMenu.before(addScrim);
addScrim.addEventListener('mousedown', (e) => {
  e.preventDefault();
  closeAddMenu();
});
let addCloseTimer = 0;
function openAddMenu() {
  closePalette();
  closeStyleMenu();
  closeMore();
  clearTimeout(addCloseTimer);
  addMenu.classList.remove('closing');
  addMenu.hidden = false;
  addScrim.hidden = false;
  document.body.classList.add('add-open');
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
  addScrim.hidden = true;
  document.body.classList.remove('add-open');
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
  color: (btn) => palette.toggle('color', btn),
  highlight: (btn) => palette.toggle('highlight', btn),
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
  if (aiPanel?.open && !$('ai-pop').contains(e.target) && !aiBtn.contains(e.target) && !e.target.closest?.('.mk-doc')) aiPanel.toggle(false);
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
  api.memo.set(id, { tables: t }).catch(() => setStatus(UI.tableSizeFail, true));
}

// 표 막대: 표 안에 커서가 있을 때만. 머리글 행과 마지막 남은 열은 지울 수 없으므로 막는다.
const tableBar = $('table-bar');
// 낮은 창에서 한 줄로 밀리는 표 막대: 마우스 바퀴(위·아래)로도 옆으로 (note.css)
tableBar?.addEventListener('wheel', (e) => {
  if (tableBar.scrollWidth <= tableBar.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  tableBar.scrollLeft += e.deltaY;
}, { passive: false });
function showTableBar(table) {
  if (!table) closeTableMore();
  tableBar.hidden = !table;
  document.body.classList.toggle('in-table', Boolean(table));
  for (const b of document.querySelectorAll('[data-action="table"]')) b.classList.toggle('active', Boolean(table));
  if (table) paintTableBar(tableBar, table); // 버튼 상태는 휴대폰과 같은 코드 (note-shared.js)
}
// 좁은 창: 덜 쓰는 표 도구(표 · 바꾸기)는 "⋯" 로 막대 위에 펼친다 (휴대폰 note-view.js 와 같이) — 하나를 고르거나 바깥을 누르면 접힘
const tableMoreBtn = $('table-more-btn');
function closeTableMore() {
  tableBar.classList.remove('more-open');
  tableMoreBtn.setAttribute('aria-expanded', 'false');
}
tableMoreBtn.addEventListener('click', () => {
  const open = !tableBar.classList.contains('more-open');
  tableBar.classList.toggle('more-open', open);
  tableMoreBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('pointerdown', (e) => {
  if (tableBar.classList.contains('more-open') && !tableBar.contains(e.target)) closeTableMore();
}, true);
bindTableBar(tableBar, (cmd, b) => {
  editor.tableCommand(cmd);
  if (b.closest('.tb-more')) closeTableMore();
});

// 처음 그 상황이 됐을 때 한 번만: 눈에 안 보이는 동작(꾹 눌러 옮기기·테두리 끌기) 알려 주기
// (그림·파일 옮기기 안내는 block-move.js가 따로)
function firstTimeHints(active) {
  // 안내는 표에 붙인다 (표 막대에 붙이면 설명하는 막대를 풍선이 가린다)
  if (active.table) hintOnce('table', '표: 아래 막대로 줄 · 칸을 더하고 빼요. 칸 테두리를 끌면 크기가 바뀌고, Tab은 다음 칸이에요', { anchor: (() => { const t = getSelection()?.anchorNode?.parentElement?.closest('table') ?? el.editorRoot.querySelector('table'); return t?.closest('.tableWrapper') ?? t ?? tableBar; })(), avoid: tableBar }); // 표를 감싼 상자(가로 막대 · 아래 테두리까지)를 피해 그 밖에
  else if (active.task || active.bullet || active.ordered) hintOnce('list-move', '목록 항목은 글자를 꾹 누르면 들어 올려져 순서를 바꿀 수 있어요. 키보드는 Alt+↑ / Alt+↓', { anchor: el.editorRoot.querySelector('li') });
}

function showActive(active) {
  appliedColor.color = active.color ?? null;
  appliedColor.highlight = active.highlight ?? null;
  showTableBar(active.table);
  document.body.classList.toggle('content-fixed', Boolean(active.fixed)); // 파일 · 소리 같은 내용: 글 서식 막대는 쓸 수 없다
  firstTimeHints(active);
  showStyle(active);
  for (const btn of document.querySelectorAll('[data-cmd]')) {
    btn.classList.toggle('active', Boolean(active[btn.dataset.cmd]));
    if (btn.hasAttribute('aria-pressed')) btn.setAttribute('aria-pressed', String(Boolean(active[btn.dataset.cmd])));
  }
  for (const kind of ['color', 'highlight']) {
    for (const btn of document.querySelectorAll(`[data-action="${kind}"]`)) btn.classList.toggle('active', Boolean(active[kind]));
  }
}

// e.code 기준이라 한글 입력 상태에서도 동작한다. 키는 설정 › 단축키 설정에서 바꿀 수 있다 (core/keymap.js)
let keymapOverrides = {};
let SHORTCUTS = keymapTable(keymapOverrides);
function useKeymap(overrides) {
  keymapOverrides = overrides ?? {};
  SHORTCUTS = keymapTable(keymapOverrides);
  // 메뉴에 지금 키를 함께 보인다 (PDF로 저장 Ctrl+Shift+P 등)
  const keys = resolveKeymap(keymapOverrides);
  // 메뉴 단추마다 그 단추가 하는 일의 키 (찾기 · 바꾸기는 한 줄에 둘 다) — 단축키 창에 있는 키는 메뉴에도 모두
  const byBtn = new Map();
  for (const a of KEYMAP_ACTIONS) {
    const btnId = a.run[0] === 'menu' ? a.run[1] : { shortcuts: 'shortcuts-btn', find: 'find-btn', replace: 'find-btn', links: 'links-btn' }[a.id];
    if (btnId) byBtn.set(btnId, [...(byBtn.get(btnId) ?? []), ...keys[a.id]]);
  }
  for (const [btnId, combos] of byBtn) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    // 맨 위 아이콘 줄 · 아래 작은 줄은 글자 자리가 없어 풍선말에 키를 함께
    if (btn.matches('.menu-ic, .menu-mini')) {
      const k = combos.map(comboLabel).join(', ');
      const name = btn.getAttribute('aria-label') ?? (btn.dataset.name ??= btn.title.replace(/ \(.*\)$/, ''));
      btn.title = k ? `${name} (${k})` : name;
      continue;
    }
    // 키 글자는 메뉴 글(잠그기 ↔ 잠금 풀기처럼 바뀜)과 따로, 단추 오른쪽 끝에
    btn.querySelector(':scope > span > small:not([id])')?.remove(); // 예전에 글 안에 적어 둔 키 글자
    let hint = btn.querySelector(':scope > .key-hint');
    if (!hint) {
      hint = document.createElement('kbd');
      hint.className = 'key-hint';
      btn.append(hint);
    }
    hint.textContent = combos.map(comboLabel).join(', ');
    hint.hidden = !hint.textContent;
  }
  // 단추 풍선말(title) · 글자 모양 메뉴의 키 글자도 지금 키로 (처음 적힌 기본 키 글자를 바꿔 끼운다)
  const swap = new Map(KEYMAP_ACTIONS.filter((a) => a.keys.length).map((a) => [comboLabel(a.keys[0]), keys[a.id].length ? comboLabel(keys[a.id][0]) : '키 없음']));
  const re = new RegExp(`(?<![\\w+])(${[...swap.keys()].sort((x, y) => y.length - x.length).map((k) => k.replace(/[+]/g, '\\+')).join('|')})(?![\\w+])`, 'g');
  for (const node of document.querySelectorAll('[title], #style-menu kbd')) {
    const attr = node.matches('kbd') ? 'text' : 'title';
    node.dataset.keyText0 ??= attr === 'text' ? node.textContent : node.getAttribute('title');
    const next = node.dataset.keyText0.replace(re, (m) => swap.get(m) ?? m);
    if (attr === 'text') node.textContent = next === '키 없음' ? '' : next;
    else node.setAttribute('title', next);
  }
}
useKeymap({});
api.on('keymap:changed', (o) => useKeymap(o));

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
    else if (aiPanel?.open) aiPanel.toggle(false);
    else if (reminderPanel?.open) reminderPanel.toggle(false);
    else if (findBar.isOpen) findBar.close({ focus: true }); // 글을 고치다가 Esc: 찾기 막대를 닫고 찾은 곳을 고른 채
    return;
  }
  // F3 · Shift+F3: 찾기 막대가 열려 있으면 글에서도 다음 · 이전 찾은 곳으로 (워드처럼)
  if (e.key === 'F3' && findBar.isOpen && !findBar.el.contains(document.activeElement)) { // 막대 안에서는 막대가 받는다
    e.preventDefault();
    findBar.step(e.shiftKey ? -1 : 1);
    return;
  }
  // Ctrl+Tab / Ctrl+Shift+Tab: 스택의 다음·이전 탭
  if (e.ctrlKey && e.code === 'Tab' && !tabsEl.hidden) {
    e.preventDefault();
    e.stopPropagation();
    flush(); // 저장을 기다리지 않고 바로 (위 탭 누르기와 같음)
    api.stack.cycle(id, e.shiftKey ? -1 : 1);
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
  else if (name === 'top') toggleLayer('top'); // 붙어 있으면 떼고, 테이프가 붙어 있으면 왕관으로 바꿔 붙임
  else if (name === 'tape') toggleLayer('bottom');
  else if (name === 'reminders') reminderPanel?.toggle();
  else if (name === 'new') api.memo.create({ color: memo.color });
  else if (name === 'close') closeTabOrWindow();
  else if (name === 'shortcuts') openShortcutSheet();
  else if (name === 'find') findBar.open();
  else if (name === 'replace') findBar.open({ replace: true });
  else if (kind === 'menu') {
    closeMenu();
    document.getElementById(name)?.click(); // 메뉴의 그 단추와 똑같이
  }
}, true);

// ---------- 본문 확대·축소 (Ctrl+마우스 휠, Ctrl+= / Ctrl+-) — 웹 브라우저처럼 글·사진·표가 함께 ----------
// 배율은 메모마다 이 PC에 기억한다. 위 막대·서식 막대는 그대로.
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
// 측정은 화면 px로 (표는 배율이 걸린 .mk-doc 안, 편집 영역은 배율이 없음).
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
  // 지금 배율에서 표가 avail에 들어갈 배율. 더 키우지는 않는다 (줄이기만)
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

// Ctrl+휠: 위로 굴리면 크게, 아래로 굴리면 작게 (창 전체가 아니라 본문만 — Chromium의 페이지 확대는 막는다)
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (!e.deltaY) return;
  setZoom(stepZoom(zoom, e.deltaY < 0 ? 1 : -1));
  tutEvent('note-zoomed'); // 튜토리얼: 글을 크게, 작게
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey && e.code !== 'Equal') return;
  if (document.querySelector('.mk-album-view')) return; // 묶음 사진 보기가 떠 있으면 그 장을 확대 · 축소
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setZoom(stepZoom(zoom, 1));
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') setZoom(stepZoom(zoom, -1));
  else return;
  tutEvent('note-zoomed');
  e.preventDefault();
  e.stopPropagation();
}, true);

// ---------- 아래 서식 도구막대: 메모 창이 활성일 때나 마우스가 창 아래쪽에 있을 때만 (미끄러져 올라옴, v0.17.16) ----------
let barHover = false;
let tabArriving = false; // 스택 탭으로 바뀌는 중 (아래 stack:activating)
let tabArriveTimer = 0;
let tabLeaving = false; // 스택의 다른 탭이 이 창을 덮는 중 (아래 stack:leaving)
let tabLeaveTimer = 0;
const barHeight = () => el.formatBar.offsetHeight || 38;
const popoverOpen = () => !el.palette.hidden || !el.morePanel.hidden || !document.getElementById('style-menu').hidden;
function updateBar() {
  document.body.style.setProperty('--bar-h', `${barHeight()}px`);
  const coaching = document.body.classList.contains('coaching'); // 튜토리얼 말풍선이 도구막대를 가리킬 수 있게
  if (tabLeaving) return; // 다른 탭이 덮을 때까지 지금 모습 그대로
  document.body.classList.toggle('bar-hidden', !(document.hasFocus() || barHover || popoverOpen() || coaching || tabArriving));
  markInactive();
}
// 다른 창에 가 있는 동안은 고른 그림 · 손 메모의 노란 테두리를 거둔다 (note.css .win-inactive) — 돌아오면 그대로 되살아남
function markInactive() {
  if (tabLeaving) return;
  document.body.classList.toggle('win-inactive', !document.hasFocus());
}
// 스택에서 이 탭으로 바뀌려 할 때 (main이 보이기 전에 알림): 서식 막대를 움직임 없이 미리 펴 둔다 —
//   보인 뒤 포커스를 받으며 막대가 올라오면 본문 높이가 바뀌어 한 번 출렁이므로. 포커스가 오면(또는 잠시 뒤) 평소대로
api.on('stack:activating', () => {
  tabArriving = true;
  document.body.classList.add('tab-arriving');
  updateBar();
  clearTimeout(tabArriveTimer);
  tabArriveTimer = setTimeout(() => {
    tabArriving = false;
    document.body.classList.remove('tab-arriving');
    updateBar();
  }, 600);
});
// 스택에서 다른 탭으로 바뀌는 중 (그 탭 창이 이 창 위에 뜨고 이 창은 곧 숨는다): 포커스를 잃어도 서식 막대 · 테두리를 그대로 —
//   덮이기 전에 막대가 내려가는 움직임이 비쳐 탭을 바꿀 때 출렁였다. 숨으면(또는 잠시 뒤) 평소대로
api.on('stack:leaving', () => {
  tabLeaving = true;
  clearTimeout(tabLeaveTimer);
  tabLeaveTimer = setTimeout(() => {
    tabLeaving = false;
    updateBar();
  }, 700);
});
window.addEventListener('focus', () => {
  // 바꾸다 말고 이 탭으로 돌아왔다
  if (!tabLeaving) return;
  clearTimeout(tabLeaveTimer);
  tabLeaving = false;
  updateBar();
}, true);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || !tabLeaving) return;
  clearTimeout(tabLeaveTimer);
  tabLeaving = false;
  updateBar(); // 숨은 뒤라 보이지 않는다 — 다시 보일 때는 평소 모습으로
});
let wasCoaching = false;
new MutationObserver(() => {
  const now = document.body.classList.contains('coaching');
  if (now !== wasCoaching) {
    wasCoaching = now;
    updateBar();
  }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
markInactive(); // 처음에도 (포커스 없이 열린 창은 선택 테두리를 거둔 채로 — 막대는 건드리지 않는다)
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
const clearStamp = createClearStamp(document.body, el.editorRoot, { reserve: () => barHeight() }); // 도구막대가 숨었다 나와도 제자리
function showTasks(tasks, opts) {
  document.body.dataset.tasks = tasks.total ? `${tasks.done}/${tasks.total}` : '';
  clearStamp.show(tasks, opts);
}

// 닫을 때: 태그 · 일정을 저절로 (설정 › 태그 자동 추가 · 일정 자동 등록)
//   글 모델을 넣은 PC: AI가 고른 태그를 사용자 태그와 합쳐 3개까지 — 창을 닫은 뒤 메인이 단다(aiTagAfterClose, 메모마다 한 번).
//   아니면 태그 없는 메모에 확실한 추천 태그 (휴대폰과 같음)
async function autoTagOnClose() {
  if (!editor || tagDismissed || memo?.locked) return false; // 잠긴 메모의 태그는 목록에 보이지 않으므로 달지 않는다
  try {
    const s = await api.settings.get();
    const tagsOn = s?.autoTags !== false;
    const body = editor.getMarkdown();
    if (isBlankBody(body)) return false;
    // 일정 자동 등록(설정 › AI 도우미)도 같은 길로 — 메인이 새로 쓴 줄의 일정 · 태그를 차례로
    if ((tagsOn || s?.autoEvents !== false) && ['ready', 'running'].includes((await api.ai?.status())?.chat.state)) return true;
    if (!tagsOn || extractTags(body).length) return false;
    const list = (await api.tags.suggest?.(body, id)) ?? [];
    const sure = list.filter((t) => t.sure && t.existing).slice(0, 2);
    if (sure.length) editor.appendMarkdown(sure.map((t) => `#${t.name}`).join(' '));
  } catch {
    // 태그를 못 달아도 닫기는 그대로
  }
  return false;
}
const aiTagAfterClose = (ask) => ask && api.tags.aiAuto?.(id).catch(() => {}); // 기다리지 않는다 (저장한 뒤에 부름)

async function closeWindow() {
  await recorder?.finish(); // 녹음 중이면 끝내서 메모에 넣고 닫는다
  await annotation?.exit(); // 주석을 그리던 중이면 저장하고 닫는다
  const askAi = await autoTagOnClose();
  await flush();
  aiTagAfterClose(askAi);
  api.win.close();
}

// Ctrl+W: 스택이면 보이는 탭만 닫는다 (탭의 × 와 같음). 스택이 아니면 창을 닫는다.
async function closeTabOrWindow() {
  if (tabsEl.hidden) return closeWindow();
  await recorder?.finish();
  const askAi = await autoTagOnClose();
  await flush();
  aiTagAfterClose(askAi);
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
// 사진 · 손 메모 · 파일의 복사 · 저장 · 공유 단추를 눌러 해 내면 (delete-button.js가 알린다)
document.addEventListener('mk:content-tools', () => tutEvent('content-tools'));

const TAB_CHARS = 7;
let stackKey = '';
function renderStack(state) {
  // 같은 탭 줄이면 그대로 (탭을 바꿀 때 두 번씩 와서 탭 줄을 통째로 다시 그리면 깜빡인다)
  const key = JSON.stringify(state?.members ?? []);
  if (key === stackKey) return;
  stackKey = key;
  const members = state?.members ?? [];
  const stacked = members.length >= 2;
  tabsEl.hidden = !stacked;
  document.body.classList.toggle('stacked', stacked);
  if (stacked) setTimeout(() => hintOnce('stack-reorder', '탭을 위아래로 끌어 순서를 바꾸고, 옆으로 끌어내면 따로 떼어져요', { anchor: tabsEl }), 800);
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
    // 저장을 기다리지 않고 바로 바꾼다 (저장은 함께 진행 — 다른 탭은 이 메모의 글이 필요 없다)
    flush();
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
  tabPress = { tabId: tab.dataset.tabId, pointerId: e.pointerId, sx: e.screenX, sy: e.screenY, cy: e.clientY, cx: e.clientX - tab.getBoundingClientRect().left + 10, el: tab, moved: false, torn: false };
});
window.addEventListener('pointermove', (e) => {
  const p = tabPress;
  if (!p || e.pointerId !== p.pointerId) return;
  const dx = e.screenX - p.sx;
  const dy = e.screenY - p.sy;
  if (!p.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    p.moved = true;
    // 움직이기 시작한 뒤부터 잡는다 (그냥 누르기는 보통 click으로)
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
    clearTabDrop(); // 끌어내면 비켜 섰던 탭들은 제자리로
    document.body.classList.remove('tab-dragging');
    if (p.tabId === id) flush();
    // 끌어낸 창은 커서가 창 왼쪽 위(윗막대)를 잡은 모양으로 따라온다
    api.stack.tearStart(p.tabId, { x: 24, y: 17 }, { x: e.screenX, y: e.screenY });
    return;
  }
  p.el.classList.add('lifting');
  document.body.classList.add('tab-dragging');
  liveReorderTabs(p, e.clientY - p.cy, dx); // 누른 자리에서 움직인 만큼 탭이 따라온다
});
// 탭 순서 바꾸기 (크롬 탭처럼): 끄는 동안 탭이 커서를 따라오고, 그 탭이 넘어간 자리의 다른 탭들은 미리 한 칸씩 비켜 서로 자리를 바꾼다.
//   놓으면 그 순서로 확정 (새 순서는 메인이 알려 줘 탭 줄이 다시 그려진다)
function liveReorderTabs(p, dy, dx) {
  const tabs = [...tabsEl.querySelectorAll('[data-tab-id]')];
  if (!p.slots) {
    // 끌기 시작 때의 자리(위아래)를 기억 — 끄는 동안 transform이 바뀌어도 기준은 그대로
    p.slots = tabs.map((t) => ({ el: t, top: t.offsetTop, h: t.offsetHeight }));
    p.from = tabs.indexOf(p.el);
    p.to = p.from;
  }
  const slots = p.slots;
  const me = slots[p.from];
  const last = slots.at(-1);
  // 한 칸 = 내 자리에서 이웃 자리까지 (탭끼리 살짝 겹쳐 있어 높이와 다르다)
  const stride = slots.length < 2 ? me.h : slots[1].top - slots[0].top || me.h;
  // 줄의 맨 위 · 맨 아래 탭 가운데까지 (1px 더 — 끝 탭의 가운데를 넘은 것으로 쳐 맨 끝으로 놓을 수 있게)
  const mid = (sl) => sl.top + sl.h / 2;
  const min = mid(slots[0]) - mid(me) - 1;
  const max = mid(last) - mid(me) + 1;
  const move = Math.max(min, Math.min(max, dy));
  p.el.style.transform = `translate(${Math.max(-6, Math.min(6, dx))}px, ${move}px)`;
  // 내 가운데가 어느 자리에 있나 → 새 순서 자리
  const center = me.top + me.h / 2 + move;
  let to = 0;
  slots.forEach((sl, i) => {
    if (i !== p.from && sl.top + sl.h / 2 < center) to += 1;
  });
  p.to = to;
  p.index = to;
  slots.forEach((sl, i) => {
    if (i === p.from) return;
    let shift = 0;
    if (to > p.from && i > p.from && i <= to) shift = -stride; // 내가 아래로 가면 사이의 탭들은 한 칸 위로
    else if (to < p.from && i >= to && i < p.from) shift = stride; // 위로 가면 한 칸 아래로
    sl.el.classList.add('shifting');
    sl.el.style.transform = shift ? `translateY(${shift}px)` : '';
  });
  p.stride = stride;
}
function clearTabDrop() {
  for (const t of tabsEl.querySelectorAll('.shifting')) {
    t.classList.remove('shifting');
    t.style.transform = '';
  }
}
function endTabPress(e, cancelled = false) {
  const p = tabPress;
  if (!p || e.pointerId !== p.pointerId) return;
  tabPress = null;
  p.el.classList.remove('lifting');
  document.body.classList.remove('tab-dragging');
  const reorder = !p.torn && p.moved && !cancelled && p.slots && p.to !== p.from;
  if (reorder) {
    // 놓은 자리로 스르르 앉힌다 — 비켜 선 탭들은 이미 새 자리라 그대로 두고, 새 순서가 오면 탭 줄이 다시 그려진다 (안 와도 잠시 뒤 정리)
    p.el.classList.add('shifting');
    p.el.style.transform = `translateY(${(p.to - p.from) * p.stride}px)`;
    setTimeout(clearTabDrop, 700);
  } else {
    p.el.style.transform = '';
    clearTabDrop();
  }
  if (p.torn) api.stack.tearEnd(e.screenX, e.screenY);
  else if (p.moved && !cancelled) {
    if (reorder) api.stack.reorder(p.tabId, p.to);
    if (p.tabId !== id) {
      flush(); // 저장을 기다리지 않고 바로 (탭 누르기와 같음)
      api.stack.activate(p.tabId);
    }
  }
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
let tutZoomBefore = null; // 매직 줌 연습 전 배율 — 단계를 지나면 처음대로 (배율은 메모마다 기억되므로 연습한 크기가 남지 않게)
coach = setupCoach(api, {
  onStep: (step) => {
    tutBase = step ? tutCounts(current ?? '') : null;
    if (step?.id === 'note-zoom') tutZoomBefore ??= zoom;
    else if (tutZoomBefore !== null) {
      if (zoom !== tutZoomBefore) setZoom(tutZoomBefore, { show: false });
      tutZoomBefore = null;
    }
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
  applyLayer(memo); // 잠금 화면에서도 왕관 · 테이프 버튼이 지금 상태대로 (풀기 전에는 누를 수 없음)
  const unlocking = lockScreen(el.editorRoot, {
    title: memo.title,
    onTry: async (password) => {
      const r = await api.memo.openLock(id, password);
      if (r?.error) return r.error;
      memo = { ...memo, ...r };
      return null;
    },
    onCancel: () => window.close(),
  });
  markPainted();
  const opened = await unlocking;
  // "닫기": 창이 닫히는 동안 암호문으로 편집기를 만들지 않는다 (여기서 멈춤)
  if (!opened) await new Promise(() => {});
  document.body.classList.remove('memo-locked');
}
if (!memo) {
  setStatus(UI.memoMissing, true);
  markPainted();
} else {
  applyMeta(memo);
  applyLayer(memo);
  renderStack(memo.stack);
  document.title = memo.title;
  current = saved = memo.body;
  // 링크 미리보기 설정 (끄면 카드 대신 링크 글자) — 설정을 바꾸면 바로
  const linkPreviews = memo.linkPreviews !== false; // memo:get이 함께 보낸다 (창을 열 때 설정을 따로 묻지 않게)
  editor = await createNoteEditor(el.editorRoot, {
    markdown: memo.body, onChange, onState: showActive, saveFile, fetchImage, onNotice: setStatus, linkPreviews,
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
  refreshHotkey();
  scheduleTagBar();
  reminderPanel = setupReminderPanel({
    api,
    memoId: id,
    setStatus,
    onToggle: (open) => open && (!el.linksPanel.hidden && toggleLinks(false), aiPanel?.open && aiPanel.toggle(false)),
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
  markPainted();
  if (memo.capture) await applyCapture(memo.capture);
  if (memo.command) runCommand(memo.command); // 목록 카드 오른쪽 클릭 › 잠그기 · 잠금 풀기 · 이전 버전
  if (params.get('record') === '1') recorder.start(); // 목록 + › 음성 메모
  if (params.get('ink') === '1') editor.insertInk(); // 목록 + › 손 메모
  // 주석: 메모 위에 겹쳐 그린 손 메모 (머리말 ink: 의 파일)
  annotation = setupAnnotation({
    scroller: el.editorRoot,
    docEl: () => el.editorRoot.querySelector('.ProseMirror'),
    read: async () => (memo.ink ? JSON.parse(new TextDecoder().decode(await api.attachments.read(memo.ink))) : null),
    save: async (data) => {
      const rel = data ? await saveFile(new File([JSON.stringify(data)], UI.annotateFile, { type: 'application/json' })) : '';
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
    const st = await api.settings.get();
    fitTables = st?.fitTables !== false;
    useKeymap(st?.keymap);
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
