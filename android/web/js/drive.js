// Google Drive 연결 화면 (① OAuth 클라이언트 ② 로그인 ③ 폴더 고르기) 과 동기화 상태 표시
import { drive, call } from './native.js';
import { app } from './state.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { icon } from '../../app/js/icons.js';

const $ = (x) => document.getElementById(x);
const sheet = $('drive-sheet');
const SUGGEST = '메모킹';

let path = [{ id: 'root', name: '내 드라이브' }];
let onConnected = () => {};
let loggingIn = false;

function showStep(step) {
  for (const el of sheet.querySelectorAll('.drive-step')) el.hidden = el.dataset.step !== step;
}

/** 연결 시작 (처음 화면·설정에서). done: 메모 폴더를 Drive 로 바꾼 뒤 */
export function startConnect(done) {
  onConnected = done;
  const s = drive.status();
  openSheet(sheet, {
    onClose: () => {
      if (loggingIn && browserLogin) drive.cancelLogin();
    },
  });
  if (s.connected) openFolders();
  else if (s.nativeAvailable) {
    // 휴대폰 구글 계정: 바로 계정 고르기·허용 화면으로
    showStep('login');
    login(false);
  } else showStep(s.configured ? 'login' : 'client');
}

// ---------- ① OAuth 클라이언트 ----------

$('client-save').addEventListener('click', () => {
  const id = $('client-id').value.trim();
  const secret = $('client-secret').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    toast('클라이언트 ID는 ".apps.googleusercontent.com" 으로 끝나요', true);
    return;
  }
  if (!secret) {
    toast('클라이언트 보안 비밀번호를 넣어 주세요', true);
    return;
  }
  drive.setClient(id, secret);
  showStep('login');
  login(true);
});
$('client-edit').addEventListener('click', () => {
  // 예비: 브라우저 로그인 (클라이언트 ID 가 있어야 함)
  if (drive.status().browserConfigured) login(true);
  else {
    $('client-id').value = '';
    $('client-secret').value = '';
    showStep('client');
  }
});

// ---------- ② 로그인 ----------

let browserLogin = false;
async function login(browser) {
  browserLogin = browser;
  loggingIn = true;
  $('drive-login').disabled = true;
  $('login-wait').hidden = false;
  $('login-cancel').hidden = !browser;
  $('login-wait-text').textContent = browser ? '브라우저에서 로그인을 기다리고 있어요' : '구글 계정을 확인하고 있어요';
  try {
    const { email } = await call('driveLogin', { browser });
    toast(email ? `${email} 계정으로 연결했어요` : '구글 계정으로 연결했어요');
    openFolders();
  } catch (err) {
    if (!sheet.hidden) toast(err.message, true);
  } finally {
    loggingIn = false;
    $('drive-login').disabled = false;
    $('login-wait').hidden = true;
  }
}
$('drive-login').addEventListener('click', () => login(!drive.status().nativeAvailable));
$('login-cancel').addEventListener('click', () => drive.cancelLogin());

// ---------- ③ 폴더 고르기 ----------

function openFolders() {
  path = [{ id: 'root', name: '내 드라이브' }];
  showStep('folder');
  const s = drive.status();
  $('drive-account').textContent = s.email ? `${s.email} 의 Google Drive` : '';
  const count = app.vault && !app.vaultInfo?.drive ? app.vault.list().length : 0;
  $('import-row').hidden = count === 0;
  $('import-note').textContent = `메모 ${count}개 — 같은 이름의 메모가 이미 있으면 Drive 것을 남기고 휴대폰 것은 사본으로 둬요`;
  loadFolders();
}

let loadSeq = 0;
async function loadFolders() {
  const here = path.at(-1);
  const seq = ++loadSeq;
  renderCrumbs();
  $('folder-list').replaceChildren();
  $('folder-empty').hidden = true;
  const use = $('folder-use');
  use.disabled = here.id === 'root';
  use.textContent = here.id === 'root' ? '폴더를 골라 주세요' : `"${here.name}" 폴더 쓰기`;
  let folders;
  try {
    folders = await call('driveFolders', { parent: here.id });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  if (seq !== loadSeq) return;
  // PC 메모킹 폴더(이름 "메모킹")를 맨 위에
  folders.sort((a, b) => Number(b.name === SUGGEST) - Number(a.name === SUGGEST));
  $('folder-empty').hidden = folders.length > 0;
  $('folder-list').replaceChildren(...folders.map((f) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = `folder-item${f.name === SUGGEST ? ' suggest' : ''}`;
    const name = document.createElement('span');
    name.textContent = f.name;
    b.append(icon('folder'), name);
    if (f.name === SUGGEST && here.id === 'root') {
      const tag = document.createElement('small');
      tag.textContent = 'PC 메모 폴더';
      b.append(tag);
    }
    b.append(icon('chevron'));
    b.addEventListener('click', () => {
      path.push(f);
      loadFolders();
    });
    li.append(b);
    return li;
  }));
}

function renderCrumbs() {
  const nodes = [];
  path.forEach((p, i) => {
    if (i) nodes.push(icon('chevron'));
    const b = document.createElement('button');
    b.textContent = p.name;
    b.addEventListener('click', () => {
      path = path.slice(0, i + 1);
      loadFolders();
    });
    nodes.push(b);
  });
  $('crumbs').replaceChildren(...nodes);
}

$('folder-new').addEventListener('click', async () => {
  const here = path.at(-1);
  const name = window.prompt('새 폴더 이름', here.id === 'root' ? SUGGEST : '')?.trim();
  if (!name) return;
  try {
    const f = await call('driveCreateFolder', { parent: here.id, name });
    path.push(f);
    loadFolders();
  } catch (err) {
    toast(err.message, true);
  }
});

$('folder-use').addEventListener('click', async () => {
  const here = path.at(-1);
  if (here.id === 'root') return;
  showStep('syncing');
  try {
    const { status } = await call('driveUse', { folderId: here.id, name: here.name, import: !$('import-row').hidden && $('import-local').checked });
    closeSheet(sheet);
    onConnected();
    if (status.state === 'error') toast(status.error, true);
    else toast(`Google Drive "${here.name}" 폴더와 동기화했어요`);
  } catch (err) {
    toast(err.message, true);
    showStep('folder');
  }
});

// ---------- 상태 표시 ----------

function ago(ms) {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}시간 전` : new Date(ms).toLocaleDateString('ko-KR');
}

/** 설정 화면의 Drive 상자와 목록 위 동기화 버튼 */
export function renderStatus(s = drive.status()) {
  const st = s.status ?? {};
  const btn = $('sync-btn');
  btn.hidden = !s.active;
  btn.classList.toggle('syncing', st.state === 'syncing');
  btn.classList.toggle('error', st.state === 'error' || (s.active && !s.connected));
  btn.replaceChildren(icon(st.state === 'error' || !s.connected ? 'cloud-alert' : 'cloud'));
  btn.setAttribute('aria-label', st.state === 'error' ? `동기화 오류: ${st.error}` : 'Google Drive와 지금 동기화');

  const box = $('drive-box');
  box.classList.toggle('on', s.active && s.connected);
  box.classList.toggle('error', s.active && (st.state === 'error' || !s.connected));
  if (s.active) {
    $('drive-title').textContent = `내 드라이브 › ${s.folderName || '메모 폴더'}`;
    $('drive-sub').textContent = !s.connected
      ? '로그인이 끊겼어요. 연결하기를 눌러 다시 로그인해 주세요'
      : st.state === 'syncing' ? `${s.email} · 동기화하는 중…`
      : st.state === 'error' ? st.error
      : `${s.email} · ${st.lastSync ? `${ago(st.lastSync)} 동기화` : '곧 동기화해요'}`;
  } else {
    $('drive-title').textContent = s.connected ? '폴더를 아직 고르지 않았어요' : '연결 안 됨';
    $('drive-sub').textContent = s.connected ? s.email : 'PC 메모킹과 같은 메모를 쓰려면 연결하세요';
  }
  $('drive-sync-now').hidden = !(s.active && s.connected);
  $('drive-disconnect').hidden = !s.connected;
  $('drive-connect').textContent = s.active && s.connected ? '폴더 바꾸기' : '연결하기';
}

export async function syncNow() {
  renderStatus({ ...drive.status(), status: { ...drive.status().status, state: 'syncing' } });
  try {
    const st = await call('driveSync');
    if (st.state === 'error') toast(st.error, true);
    else toast('Google Drive와 맞췄어요');
  } catch (err) {
    toast(err.message, true);
  }
  renderStatus();
}
