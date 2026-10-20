// 앱 안 업데이트 (휴대폰) — PC 의 새 버전 안내(app/js/list.js)와 같은 약속:
//   앱을 켤 때 조용히 새 버전을 확인(6시간에 한 번) → 있으면 "바뀐 점 · 받아서 설치" 시트 → 받고 → 안드로이드 설치 화면 ("업데이트" 한 번)
//   "나중에" 를 고른 버전은 24시간 다시 묻지 않는다. 설정 › 업데이트 확인 은 언제나 (숨겨 둔 버전도 다시 보여 준다)
//   받는 곳 · 안전 검사는 앱(AppUpdate.kt): 우리 배포 저장소의 파일만, 크기 · SHA-256 이 맞을 때만 설치로 넘긴다
import { call, on } from './native.js';
import { openSheet, closeSheet } from './ui.js';
import { renderReleaseNotes } from '../../app/js/release-notes-view.js';
import { dueForCheck, isSnoozed, progressLabel, normalizeInfo, SNOOZE_MS } from '../../app/js/core/app-update.js';

const KEY = 'memoking.update';
const $ = (id) => document.getElementById(id);

let store = {}; // { checkedAt, snooze: { version, until } } — 기기에 기억
try {
  store = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
} catch {
  store = {};
}
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // 저장소를 못 쓰면 이번 실행 동안만 기억
  }
};

// 안드로이드 설치기가 돌려준 결과(AppUpdate.failStatus) → 안내
const INSTALL_FAIL = {
  3: '설치를 취소했어요. 준비는 되어 있으니 "설치하기" 를 다시 눌러 주세요',
  4: '설치 파일에 문제가 있어요. 다시 받아 주세요',
  5: '이미 설치 중인 것과 겹쳤어요. 잠시 뒤 다시 눌러 주세요',
  6: '휴대폰 저장 공간이 모자라요. 공간을 비우고 다시 눌러 주세요',
  7: '지금 설치된 앱과 서명이 달라 덮어 설치할 수 없어요. 앱을 지우고 새로 설치해야 해요 (메모는 폴더에 남아 있어요)',
};

let info = normalizeInfo(null);
let state = { status: 'idle', current: '', done: 0, total: 0, message: '' }; // idle | checking | latest | available | downloading | ready | installing | error
let busy = false;

/** 설정의 업데이트 줄 + 시트를 지금 상태로 */
function render() {
  const st = state.status;
  const v = info.version ? `v${info.version.replace(/^v/, '')}` : '';
  const note = {
    idle: '새 버전이 나오면 알려 드려요',
    checking: '새 버전을 찾고 있어요',
    latest: '최신 버전을 쓰고 있어요',
    available: `새 버전 ${v} 이 나왔어요`,
    downloading: '새 버전을 받고 있어요',
    ready: `${v} 을 받아 뒀어요. 설치 화면에서 "업데이트" 를 눌러 주세요`,
    installing: '설치 화면에서 "업데이트" 를 눌러 주세요',
    error: state.message,
  }[st] ?? '';
  const label = {
    checking: '확인하는 중',
    latest: '✓ 최신 버전',
    available: `업데이트 ${v}`,
    downloading: `받는 중 ${Math.floor(state.total ? (state.done / state.total) * 100 : 0)}%`,
    ready: '설치하기',
    installing: '설치하기',
  }[st] ?? '업데이트 확인';
  const row = $('update-check');
  if (!row) return;
  $('update-current').textContent = state.current ? `v${state.current}` : '';
  const noteEl = $('update-note');
  noteEl.textContent = note;
  noteEl.classList.toggle('warn', st === 'error');
  row.dataset.state = ['latest', 'downloading'].includes(st) ? st : 'idle';
  row.textContent = label;
  row.classList.toggle('primary', ['available', 'ready', 'installing'].includes(st));
  row.disabled = st === 'checking';

  // 시트
  $('update-version').replaceChildren(...(() => {
    const from = Object.assign(document.createElement('span'), { className: 'from', textContent: state.current ? `v${state.current}` : '' });
    const arrow = Object.assign(document.createElement('span'), { className: 'arrow', textContent: '→' });
    arrow.setAttribute('aria-hidden', 'true');
    const to = Object.assign(document.createElement('span'), { className: 'to', textContent: v });
    return [from, arrow, to];
  })());
  const downloading = st === 'downloading';
  const ready = st === 'ready' || st === 'installing';
  $('update-title').textContent = ready ? '설치할 준비가 됐어요' : '새 버전이 나왔어요';
  $('update-progress').hidden = !downloading;
  $('update-bar-fill').style.transform = `scaleX(${state.total ? Math.min(1, state.done / state.total) : 0})`;
  $('update-progress-text').textContent = progressLabel(state.done, state.total);
  $('update-error').hidden = st !== 'error';
  $('update-error').textContent = st === 'error' ? state.message : '';
  $('update-go').textContent = st === 'installing' ? '다시 열기' : ready ? '설치하기' : downloading ? '받는 중' : st === 'error' ? '다시 시도' : '받아서 설치';
  $('update-go').disabled = downloading;
  $('update-later').textContent = downloading ? '닫기 (계속 받아요)' : '나중에';
}

function set(patch) {
  state = { ...state, ...patch };
  render();
}

function openSheetNow() {
  renderReleaseNotes($('update-notes'), info.notes);
  $('update-notes').scrollTop = 0;
  render();
  openSheet($('update-sheet'));
}

/** 새 버전이 있는지 본다. silent: 켤 때 조용히(6시간에 한 번 · "나중에" 고른 버전은 건너뜀) — 아니면 설정의 단추 */
export async function checkForUpdate({ silent = false } = {}) {
  if (busy || ['downloading', 'installing'].includes(state.status)) return state.status;
  if (silent && !dueForCheck(store.checkedAt)) return state.status;
  busy = true;
  if (!silent) set({ status: 'checking', message: '' });
  try {
    info = normalizeInfo(await call('updateCheck'));
    store.checkedAt = Date.now();
    save();
    set({ current: info.current || state.current });
    if (!info.available) {
      set({ status: silent ? 'idle' : 'latest' });
    } else {
      set({ status: 'available' });
      if (!silent || !isSnoozed(store.snooze, info.version)) openSheetNow();
    }
  } catch (err) {
    console.warn('[update]', err);
    // 조용한 확인은 오류를 보이지 않는다 (인터넷이 안 될 때마다 뜨면 귀찮다)
    set(silent ? { status: 'idle' } : { status: 'error', message: '새 버전을 확인하지 못했어요. 인터넷을 확인하고 다시 눌러 주세요' });
  } finally {
    busy = false;
  }
  return state.status;
}

/** 받기 → 설치 화면. 이미 받아 뒀으면 설치 화면만 */
async function download() {
  if (busy) return;
  busy = true;
  try {
    if (!['ready', 'installing'].includes(state.status)) {
      set({ status: 'downloading', done: 0, total: info.size, message: '' });
      await call('updateDownload', { apk: info.apk, size: info.size, sha256: info.sha256, version: info.version });
      set({ status: 'ready' });
    }
    $('update-go').disabled = true;
    $('update-go').textContent = '설치 화면 준비 중'; // 설치 파일을 넘기는 동안(몇 초) 다시 눌러 설치가 꼬이지 않게
    let result;
    try {
      result = await call('updateInstall');
    } finally {
      $('update-go').disabled = false;
    }
    if (result === 'permission') {
      // 안드로이드의 "이 출처 허용" 화면을 열었다 — 켜고 돌아오면 다시 누르게
      set({ status: 'ready', message: '' });
      $('update-hint').textContent = '"이 출처 허용"을 켜고 돌아와서 다시 눌러 주세요';
      $('update-hint').hidden = false;
    } else if (result === 'missing') {
      set({ status: 'available' });
      busy = false;
      return download();
    } else {
      $('update-hint').hidden = true;
      $('update-alt').hidden = true;
      set({ status: 'installing' });
    }
  } catch (err) {
    console.warn('[update]', err);
    set({ status: 'error', message: err?.message && !/^Error invoking/.test(err.message) ? err.message : '새 버전을 받지 못했어요. 다시 시도해 주세요' });
  } finally {
    busy = false;
  }
}

export function setupUpdates({ currentVersion }) {
  state.current = currentVersion ?? '';
  on('update', ({ done, total }) => set({ done, total: total || state.total }));
  // 설치가 끝나지 않았다(취소 · 실패) → "설치 화면에서…" 안내에 머물지 않고 다시 누를 수 있게 + 까닭
  on('updateResult', ({ status, why }) => {
    if (state.status !== 'installing') return;
    const text = INSTALL_FAIL[status] ?? `설치가 끝나지 않았어요${why ? ` (${why})` : ''}. 다시 눌러 주세요`;
    set({ status: 'ready' });
    $('update-hint').textContent = text;
    $('update-hint').hidden = false;
    $('update-alt').hidden = false; // 안 되면 브라우저로 내려받아 설치하는 다른 방법
  });
  $('update-check').addEventListener('click', () => {
    if (['available', 'ready', 'installing', 'downloading'].includes(state.status)) {
      closeSheetsThenOpen();
      return;
    }
    store.snooze = null; // 직접 확인하면 숨겨 둔 버전도 다시 보여 준다
    save();
    checkForUpdate();
  });
  $('update-go').addEventListener('click', download);
  // 다른 방법: 브라우저로 APK 를 내려받아 안드로이드 설치 화면으로 (앱 안 설치가 안 되는 휴대폰용)
  $('update-alt').addEventListener('click', () => {
    if (info.apk) call('openUrl', { url: info.apk }).catch(() => {});
  });
  $('update-later').addEventListener('click', () => {
    if (state.status !== 'downloading' && info.version) {
      store.snooze = { version: info.version, until: Date.now() + SNOOZE_MS };
      save();
    }
    closeSheet($('update-sheet'));
  });
  render();
}

// 설정 시트 위에 업데이트 시트가 바로 얹히게 (설정은 그대로 두고)
function closeSheetsThenOpen() {
  openSheetNow();
}

/** 설정을 열 때: 지금 버전 글을 새로 (앱이 새 버전으로 바뀌었을 수 있다) */
export function refreshUpdateRow(currentVersion) {
  if (currentVersion) state.current = currentVersion;
  render();
}
