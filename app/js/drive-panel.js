// 설정의 "Google Drive 동기화" — Google Drive 데스크탑 앱 없이 구글 로그인으로 메모 폴더를 Drive 폴더와 맞춘다.
// 연결: ① (처음 한 번) OAuth 클라이언트 붙여 넣기 ② 브라우저 로그인 ③ Drive 폴더 고르기 ④ 첫 동기화
import { formatStamp } from './core/format.js';

const $ = (id) => document.getElementById(id);

// Electron 이 붙이는 "Error invoking remote method 'drive:login': AuthError: …" 를 걷어낸다
export const cleanError = (err) => String(err?.message ?? err ?? '')
  .replace(/^Error invoking remote method '[^']+':\s*/, '')
  .replace(/^(\w*Error|SafetyStop):\s*/, '') || '알 수 없는 오류';

/**
 * @param {{ api: any, onVault: (info: any) => void, confirm: (msg: string, ok: string) => Promise<boolean> }} options
 */
export function setupDrivePanel({ api, onVault, confirm }) {
  const dialog = $('drive-dialog');
  const box = $('drive-box');
  let info = null;
  let path = [{ id: 'root', name: '내 드라이브' }];
  let loginRun = 0;

  // ---------- 설정 안 상태 ----------

  function render(next) {
    if (next) info = next;
    if (!info) return;
    const st = info.status ?? { state: 'off' };
    const on = info.connected && info.active;
    box.classList.toggle('on', on);
    box.classList.toggle('error', on && st.state === 'error');
    let title = '연결 안 됨';
    let sub = 'Google 계정으로 로그인하면 휴대폰 메모킹과 같은 메모를 써요';
    if (info.connected && !info.active) {
      title = `${info.email || 'Google 계정'} 로그인됨`;
      sub = '맞출 Drive 폴더를 아직 고르지 않았어요';
    } else if (on) {
      title = `${info.email || 'Google 계정'} · 내 드라이브 › ${info.folderName || '메모킹'}`;
      if (st.state === 'syncing') sub = '동기화하는 중…';
      else if (st.state === 'error') sub = st.error || '동기화하지 못했어요';
      else if (st.lastSync) sub = `마지막 동기화 ${formatStamp(st.lastSync)}`;
      else sub = '곧 동기화해요';
      if (st.conflicts?.length) sub += `\n양쪽에서 고친 메모 ${st.conflicts.length}개는 "(PC 충돌 …)" 사본으로 남겼어요`;
    }
    $('drive-title').textContent = title;
    $('drive-sub').textContent = sub;
    $('drive-connect').textContent = on ? '폴더 변경' : '연결하기';
    $('drive-sync-now').hidden = !on;
    $('drive-sync-now').disabled = st.state === 'syncing';
    $('drive-disconnect').hidden = !info.connected;
  }

  async function refresh() {
    try {
      render(await api.drive.status());
    } catch {
      // 오래된 preload — 표시만 안 함
    }
  }

  // ---------- 연결 창 ----------

  function step(name) {
    for (const s of dialog.querySelectorAll('.drive-step')) s.hidden = s.dataset.step !== name;
  }

  async function connect() {
    info = await api.drive.status();
    if (!dialog.open) dialog.showModal();
    if (!info.configured) {
      step('client');
      $('client-id').focus();
      return;
    }
    if (!info.connected) return login();
    return openFolders();
  }

  async function login() {
    const run = ++loginRun;
    step('login');
    try {
      await api.drive.login();
      if (run !== loginRun) return;
      info = await api.drive.status();
      render();
      await openFolders();
    } catch (err) {
      if (run !== loginRun) return;
      dialog.close();
      const msg = cleanError(err);
      if (!/취소/.test(msg)) await confirm(`Google 로그인을 끝내지 못했어요.\n${msg}`, '확인');
    }
  }

  async function openFolders() {
    step('folder');
    $('drive-account').textContent = info.email ? `${info.email} 의 Drive` : '';
    $('folder-local').textContent = info.insideDriveApp || !info.root
      ? `이 PC 에서는 ${info.insideDriveApp ? 'Google Drive 앱 폴더 대신 ' : ''}"문서\\메모킹" 폴더에 메모를 두고 맞춰요.`
      : `이 PC 의 메모 폴더: ${info.root}`;
    path = [{ id: 'root', name: '내 드라이브' }];
    await showFolder();
  }

  async function showFolder() {
    const cur = path.at(-1);
    $('new-folder-row').hidden = true;
    const crumbs = $('crumbs');
    crumbs.replaceChildren();
    path.forEach((p, i) => {
      if (i) crumbs.append(Object.assign(document.createElement('span'), { className: 'sep', textContent: '›' }));
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: p.name });
      b.addEventListener('click', () => {
        path = path.slice(0, i + 1);
        showFolder();
      });
      crumbs.append(b);
    });
    const use = $('folder-use');
    use.disabled = cur.id === 'root';
    use.textContent = cur.id === 'root' ? '폴더를 선택하세요' : `"${cur.name}" 폴더 사용`;
    const list = $('folder-list');
    list.innerHTML = '<li class="loading">불러오는 중…</li>';
    let folders;
    try {
      folders = await api.drive.folders(cur.id);
    } catch (err) {
      list.innerHTML = '';
      list.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: cleanError(err) }));
      return;
    }
    if (path.at(-1) !== cur) return; // 그새 다른 폴더로 감
    list.replaceChildren();
    if (!folders.length) {
      list.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: '안에 폴더가 없어요' }));
    }
    for (const f of folders) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<svg><use href="#i-folder"/></svg>';
      b.append(Object.assign(document.createElement('span'), { textContent: f.name }));
      b.addEventListener('click', () => {
        path.push(f);
        showFolder();
      });
      li.append(b);
      list.append(li);
    }
  }

  function newFolder() {
    const row = $('new-folder-row');
    const input = $('new-folder-name');
    row.hidden = false;
    input.value = path.length === 1 ? '메모킹' : '';
    input.focus();
    input.select();
  }

  async function createFolder() {
    const cur = path.at(-1);
    const name = $('new-folder-name').value.trim();
    if (!name) return;
    $('new-folder-row').hidden = true;
    try {
      const f = await api.drive.createFolder(cur.id, name);
      path.push(f);
      showFolder();
    } catch (err) {
      await confirm(`폴더를 만들지 못했어요.\n${cleanError(err)}`, '확인');
    }
  }

  async function useFolder() {
    const cur = path.at(-1);
    if (cur.id === 'root') return;
    step('syncing');
    try {
      const res = await api.drive.use(cur.id, cur.name);
      onVault(res.info);
      render(res.drive);
      dialog.close();
      const st = res.status ?? {};
      if (st.state === 'error') await confirm(`Drive 폴더를 골랐지만 동기화하지 못했어요.\n${st.error}`, '확인');
    } catch (err) {
      dialog.close();
      await confirm(`Drive 폴더를 쓰지 못했어요.\n${cleanError(err)}`, '확인');
    }
    refresh();
  }

  // ---------- 버튼 ----------

  $('drive-connect').addEventListener('click', () => connect());
  $('setup-drive')?.addEventListener('click', () => connect());
  $('drive-sync-now').addEventListener('click', async () => {
    $('drive-sync-now').disabled = true;
    try {
      await api.drive.sync();
    } finally {
      refresh();
    }
  });
  $('drive-disconnect').addEventListener('click', async () => {
    if (!(await confirm('Google Drive 연결을 끊을까요?\n이 PC의 메모는 그대로 남고, 휴대폰과 더 이상 동기화하지 않아요.', '연결 끊기'))) return;
    render(await api.drive.disconnect());
  });
  $('client-save').addEventListener('click', async () => {
    const id = $('client-id').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(id)) {
      $('client-id').focus();
      $('client-id').setCustomValidity?.('…apps.googleusercontent.com 으로 끝나는 클라이언트 ID 를 넣어 주세요');
      $('client-id').reportValidity?.();
      return;
    }
    render(await api.drive.setClient(id, $('client-secret').value.trim()));
    login();
  });
  $('client-id').addEventListener('input', (e) => e.target.setCustomValidity?.(''));
  $('client-edit').addEventListener('click', () => {
    loginRun++;
    api.drive.cancelLogin();
    step('client');
  });
  $('login-cancel').addEventListener('click', () => {
    loginRun++;
    api.drive.cancelLogin();
    dialog.close();
  });
  $('folder-new').addEventListener('click', () => newFolder());
  $('folder-use').addEventListener('click', () => useFolder());
  $('new-folder-ok').addEventListener('click', () => createFolder());
  $('new-folder-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createFolder();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      $('new-folder-row').hidden = true;
    }
  });
  for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (!dialog.querySelector('[data-step="login"]').hidden) {
      loginRun++;
      api.drive.cancelLogin();
    }
  });
  dialog.addEventListener('cancel', (e) => {
    if (!dialog.querySelector('[data-step="syncing"]').hidden) e.preventDefault(); // 첫 동기화 중엔 닫지 않음
  });

  api.on('drive:status', (next) => render(next));
  refresh();
  return { refresh };
}
