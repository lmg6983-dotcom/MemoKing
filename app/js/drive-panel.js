// 설정의 "Google Drive 동기화" — Google Drive 데스크탑 앱 없이 구글 로그인으로 메모 폴더를 Drive 폴더와 맞춘다.
// 연결: ① (처음 한 번) OAuth 클라이언트 붙여 넣기 ② 브라우저 로그인 ③ Drive 폴더 고르기 ④ 첫 동기화
import { koClock, relativeDay, koMonthDay } from './core/time.js';

const $ = (id) => document.getElementById(id);
// 메모킹이 Drive 에 만드는 폴더 이름 (예전 "메모킹" 폴더는 Google Drive 데스크탑 앱이 만든 것이라 메모킹이 볼 수 없다)
export const SYNC_FOLDER = '메모킹 동기화';

// Electron 이 붙이는 "Error invoking remote method 'drive:login': AuthError: …" 를 걷어낸다
export const cleanError = (err) => String(err?.message ?? err ?? '')
  .replace(/^Error invoking remote method '[^']+':\s*/, '')
  .replace(/^(\w*Error|SafetyStop):\s*/, '') || '알 수 없는 오류';

/** 마지막 동기화: "방금" · "5분 전" · "오늘 오후 3:20" · "10월 14일" */
export function syncedAgo(ms, now = Date.now()) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const d = new Date(ms);
  const rel = relativeDay(d, new Date(now));
  return rel ? `${rel} ${koClock(d)}` : koMonthDay(d);
}

// 양쪽에서 고친 메모의 사본 — 다음 동기화가 시작되면 상태에서 사라지므로, 확인할 때까지 기억해 둔다
//   이미 본 사본은 다시 알리지 않는다 (같은 동기화 결과가 다시 와도)
const CONFLICT_KEY = 'memoking.syncConflicts';
const SEEN_KEY = 'memoking.syncConflictsSeen';
const loadList = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]');
  } catch {
    return [];
  }
};
const saveList = (key, list) => {
  try {
    if (list.length) localStorage.setItem(key, JSON.stringify(list.slice(-200)));
    else localStorage.removeItem(key);
  } catch {
    // 이번 창에서만
  }
};
const loadConflicts = () => loadList(CONFLICT_KEY);
const saveConflicts = (list) => saveList(CONFLICT_KEY, list);
/** 로그인을 다시 해야 고쳐지는 오류인가 */
const needsLogin = (msg) => /로그인|인증|권한|401|invalid_grant/i.test(msg ?? '');

/**
 * @param {{ api: any, onVault: (info: any) => void, confirm: (msg: string, ok: string) => Promise<boolean>,
 *           showFiles?: (files: string[]|null) => void }} options
 *   showFiles: 목록을 이 파일들(충돌 사본)만으로 좁히기 (null 이면 풀기)
 */
export function setupDrivePanel({ api, onVault, confirm, showFiles = () => {} }) {
  const dialog = $('drive-dialog');
  const box = $('drive-box');
  let info = null;
  let path = [{ id: 'root', name: '내 드라이브' }];
  let loginRun = 0;
  let fullBusy = false;
  let conflicts = loadConflicts();
  const seen = new Set(loadList(SEEN_KEY));

  // ---------- 설정 안 상태 ----------

  /** 지금 상태 한 줄 요약: { tone: 'off'|'ok'|'busy'|'error', title, sub } — 설정 칸 · 위쪽 구름 단추 · 작은 창이 같은 글 */
  function summary() {
    const st = info.status ?? { state: 'off' };
    const on = info.connected && info.active;
    if (info.reconnect && !info.connected) return { tone: 'error', title: '다시 연결해 주세요', sub: 'Google Drive 연결 방식이 바뀌었어요 (메모킹이 만든 폴더만 봐요). 메모는 이 PC 에 그대로 있어요', on };
    if (!info.connected) return { tone: 'off', title: '동기화 꺼짐', sub: 'Google 계정으로 연결하면 휴대폰 메모킹과 같은 메모를 써요', on };
    if (!info.active) return { tone: 'off', title: `${info.email || 'Google 계정'} 로그인됨`, sub: '동기화할 Drive 폴더를 아직 고르지 않았어요', on };
    const where = `${info.email || 'Google 계정'} › ${info.folderName || '메모킹'}`;
    if (st.state === 'syncing') return { tone: 'busy', title: '동기화하는 중…', sub: where, on };
    if (st.state === 'error') return { tone: 'error', title: needsLogin(st.error) ? '다시 로그인해 주세요' : '동기화하지 못했어요', sub: st.error || '잠시 뒤 다시 시도해 주세요', on, error: true };
    return { tone: 'ok', title: st.lastSync ? `동기화됨 · ${syncedAgo(st.lastSync)}` : '곧 동기화해요', sub: where, on };
  }

  function render(next) {
    if (next) info = next;
    if (!info) return;
    const st = info.status ?? { state: 'off' };
    // 새로 생긴 충돌 사본은 확인할 때까지 기억
    const fresh = (st.conflicts ?? []).filter((f) => !seen.has(f) && !conflicts.includes(f));
    if (fresh.length) {
      conflicts = [...conflicts, ...fresh];
      saveConflicts(conflicts);
    }
    const sum = summary();
    const on = sum.on;
    box.classList.toggle('on', on);
    box.classList.toggle('error', sum.tone === 'error');
    $('drive-title').textContent = on ? (sum.tone === 'ok' ? `${info.email || 'Google 계정'} › ${info.folderName || '메모킹'}` : sum.title) : sum.title;
    $('drive-sub').textContent = on ? (sum.tone === 'ok' ? sum.title : sum.sub) : sum.sub;
    const login = sum.error && needsLogin(st.error);
    // 단추: 연결 전 [연결하기] / 연결 뒤 [지금 동기화] (오류면 [다시 시도], 로그인이 풀렸으면 [다시 로그인]) · 충돌 · 다른 폴더 · 끊기
    $('drive-connect').hidden = on && !login;
    $('drive-connect').textContent = login || (info.reconnect && !info.connected) ? '다시 로그인' : '연결하기';
    $('drive-sync-now').hidden = !on || login;
    $('drive-sync-now').textContent = sum.error ? '다시 시도' : '지금 동기화';
    $('drive-sync-now').disabled = st.state === 'syncing';
    $('drive-conflicts').hidden = !conflicts.length;
    $('drive-conflicts').textContent = `충돌 사본 ${conflicts.length}개 보기`;
    $('drive-folder').hidden = !on;
    $('drive-disconnect').hidden = !info.connected;
    // 외부 앱 메모 연동: 연결돼 있을 때만 (켜는 중에는 누르지 못하게)
    $('drive-full-row').hidden = !info.connected;
    if (!fullBusy) $('drive-full').checked = Boolean(info.fullScope);
    renderHeader(sum);
  }

  // ---------- 목록 창 위쪽: 구름 단추 + 작은 창 ----------

  const syncBtn = $('sync-btn');
  const pop = $('sync-pop');
  function renderHeader(sum = summary()) {
    if (!syncBtn) return;
    syncBtn.hidden = false;
    syncBtn.dataset.tone = sum.tone;
    $('sync-mark').textContent = conflicts.length && sum.tone !== 'error' ? String(conflicts.length) : '';
    syncBtn.classList.toggle('has-conflicts', Boolean(conflicts.length) && sum.tone !== 'error');
    const label = `Google Drive 동기화: ${sum.title}${conflicts.length ? `, 충돌 사본 ${conflicts.length}개` : ''}`;
    syncBtn.title = label;
    syncBtn.setAttribute('aria-label', label);
    if (!pop.hidden) fillPop(sum);
  }
  function fillPop(sum = summary()) {
    const st = info.status ?? {};
    const head = document.createElement('div');
    head.className = `sync-pop-head tone-${sum.tone}`;
    head.append(Object.assign(document.createElement('b'), { textContent: sum.title }), Object.assign(document.createElement('small'), { textContent: sum.sub }));
    const actions = document.createElement('div');
    actions.className = 'sync-pop-actions';
    const btn = (text, cls, fn) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text });
      b.addEventListener('click', fn);
      actions.append(b);
      return b;
    };
    const login = sum.error && needsLogin(st.error);
    if (!sum.on || login) btn(login || info.reconnect ? '다시 로그인' : '연결하기', 'btn primary', () => { closePop(); connect(); });
    else {
      const now = btn(sum.error ? '다시 시도' : '지금 동기화', 'btn primary', () => syncNow());
      now.disabled = st.state === 'syncing';
    }
    if (conflicts.length) btn(`충돌 사본 ${conflicts.length}개 보기`, 'btn', () => { closePop(); viewConflicts(); });
    btn('설정', 'link-btn', () => { closePop(); openSettings(); });
    pop.replaceChildren(head, actions);
    if (conflicts.length) {
      const note = document.createElement('p');
      note.className = 'sync-pop-note';
      note.textContent = '양쪽에서 같은 메모를 고쳐 이 PC 에서 쓴 것을 "(PC 충돌 …)" 사본으로 남겼어요. 확인하고 필요 없으면 지우세요';
      pop.append(note);
    }
  }
  function openPop() {
    fillPop();
    pop.hidden = false;
    syncBtn.setAttribute('aria-expanded', 'true');
    pop.querySelector('button')?.focus();
  }
  function closePop() {
    if (pop.hidden) return;
    pop.hidden = true;
    syncBtn.setAttribute('aria-expanded', 'false');
  }
  syncBtn?.addEventListener('click', () => (pop.hidden ? openPop() : closePop()));
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !syncBtn.contains(e.target)) closePop();
  }, true);
  pop?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePop();
      syncBtn.focus();
    }
  });
  // 1분마다 "5분 전" 같은 글을 새로
  setInterval(() => info && renderHeader(), 60_000);

  function openSettings() {
    $('settings-btn')?.click();
  }

  async function syncNow() {
    $('drive-sync-now').disabled = true;
    try {
      await api.drive.sync();
    } finally {
      refresh();
    }
  }

  // 충돌 사본: 목록을 그 메모들만으로 (확인하면 기억을 지운다)
  function viewConflicts() {
    const files = conflicts.slice();
    for (const f of files) seen.add(f);
    saveList(SEEN_KEY, [...seen]);
    conflicts = [];
    saveConflicts(conflicts);
    render();
    showFiles(files);
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

  async function connect({ folder = false } = {}) {
    info = await api.drive.status();
    if (!dialog.open) dialog.showModal();
    if (!info.configured) {
      step('client');
      $('client-id').focus();
      return;
    }
    const st = info.status ?? {};
    if (!info.connected || (st.state === 'error' && needsLogin(st.error) && !folder)) return login();
    return info.active ? openFolders() : autoFolder(); // 연결된 뒤 "다른 폴더로 바꾸기" 만 폴더 목록
  }

  // 로그인하면 바로: "메모킹 동기화" 폴더를 찾거나(휴대폰이 먼저 만들었을 수 있음) 만들어 맞춘다 — 폴더를 고를 일이 없게
  async function autoFolder() {
    step('syncing');
    try {
      const res = await api.drive.auto();
      onVault(res.info);
      render(res.drive);
      dialog.close();
      const st = res.status ?? {};
      if (st.state === 'error') await confirm(`Google Drive와 연결했지만 동기화하지 못했어요.\n${st.error}`, '확인');
    } catch (err) {
      dialog.close();
      await confirm(`Google Drive와 연결하지 못했어요.\n${cleanError(err)}`, '확인');
    }
    refresh();
  }

  async function login() {
    const run = ++loginRun;
    step('login');
    try {
      await api.drive.login();
      if (run !== loginRun) return;
      info = await api.drive.status();
      render();
      await autoFolder();
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
    $('folder-local').textContent = info.insideDriveApp
      ? `지금 메모 폴더(${info.root})의 메모를 "문서\\메모킹" 으로 복사해서 맞춰요. 원래 폴더는 그대로 둬요.`
      : !info.root ? '이 PC 에서는 "문서\\메모킹" 폴더에 메모를 두고 맞춰요.'
      : `이 PC 의 메모 폴더: ${info.root} (처음 맞출 때 이 메모들을 새 폴더로 올려요)`;
    $('folder-change-note').hidden = !info.active;
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
    // 아래 단추는 폴더 안에 들어갔을 때만 ("이 폴더 사용") — 맨 위에서는 줄마다 "사용"
    const use = $('folder-use');
    use.hidden = cur.id === 'root';
    use.disabled = info.active && cur.id === info.folderId;
    use.textContent = `"${cur.name}" 폴더 사용`;
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
      const top = cur.id === 'root';
      list.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: top ? '메모킹이 만든 폴더가 아직 없어요 — 새 폴더를 만들어 주세요' : '안에 폴더가 없어요' }));
      if (top) newFolder();
    }
    // 줄 누르기 = 그 안으로, 오른쪽 "사용" = 이 폴더로 동기화 (예전: 들어간 뒤 아래 단추로만 고를 수 있어 헷갈림)
    for (const f of folders) {
      const li = document.createElement('li');
      li.className = 'folder-row';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'folder-open';
      b.title = '안으로 들어가기';
      b.innerHTML = '<svg><use href="#i-folder"/></svg>';
      b.append(Object.assign(document.createElement('span'), { textContent: f.name }), Object.assign(document.createElement('i'), { className: 'folder-chev', textContent: '›' }));
      b.addEventListener('click', () => {
        path.push(f);
        showFolder();
      });
      const current = info.active && f.id === info.folderId;
      const use = Object.assign(document.createElement('button'), { type: 'button', className: 'btn folder-pick', textContent: current ? '지금 폴더' : '사용' });
      use.disabled = current;
      use.setAttribute('aria-label', `"${f.name}" 폴더로 동기화`);
      use.addEventListener('click', () => {
        path.push(f);
        useFolder();
      });
      li.append(b, use);
      list.append(li);
    }
  }

  function newFolder() {
    const row = $('new-folder-row');
    const input = $('new-folder-name');
    row.hidden = false;
    input.value = path.length === 1 ? SYNC_FOLDER : '';
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
  $('drive-sync-now').addEventListener('click', () => syncNow());
  $('drive-folder').addEventListener('click', () => connect({ folder: true }));
  $('drive-conflicts').addEventListener('click', () => {
    $('settings-dialog')?.close?.();
    viewConflicts();
  });
  $('login-reopen').addEventListener('click', () => {
    // 브라우저 창을 닫았거나 놓쳤을 때: 로그인을 처음부터 다시 (새 창)
    loginRun++;
    api.drive.cancelLogin();
    login();
  });
  $('sync-bg').addEventListener('click', () => dialog.close()); // 첫 동기화는 뒤에서 계속 (끝나면 위쪽 구름 단추에)
  // 외부 앱 메모 연동 (전체 드라이브 권한): 그 범위로 다시 로그인 — 취소·실패하면 꺼진 채 (지금 연결은 그대로)
  const fullNote = $('drive-full-note').textContent;
  $('drive-full').addEventListener('change', async (e) => {
    const on = e.target.checked;
    fullBusy = true;
    e.target.disabled = true;
    $('drive-full-note').textContent = '브라우저에서 Google 계정을 고르고 허용해 주세요…';
    let res;
    try {
      res = await api.drive.setFullScope(on);
    } catch (err) {
      res = { full: info?.fullScope ?? false, error: cleanError(err) };
    } finally {
      fullBusy = false;
      e.target.disabled = false;
      $('drive-full-note').textContent = fullNote;
    }
    e.target.checked = Boolean(res.full);
    if (res.drive) render(res.drive);
    else refresh();
    const msg = res.error ? cleanError(res.error) : '';
    if (on && msg && !/취소/.test(msg)) await confirm(`외부 앱 메모 연동을 켜지 못했어요. 지금 연결은 그대로예요.\n${msg}`, '확인');
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
    if (!dialog.open) dialog.showModal();
    step('client');
    $('client-id').focus();
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

  api.on('drive:status', (next) => render(next));
  refresh().then(async () => {
    // 업데이트로 연결 방식이 바뀐 경우: 한 번 묻고, 누르면 바로 다시 연결 (메모는 그대로)
    if (!info?.reconnect || info.connected) return;
    try {
      if (sessionStorage.getItem('mk-drive-reconnect-asked')) return;
      sessionStorage.setItem('mk-drive-reconnect-asked', '1');
    } catch {
      // 이번에만 묻기
    }
    if (await confirm('Google Drive 동기화를 다시 켜 주세요.\n연결 방식이 더 안전하게 바뀌었어요 (메모킹이 만든 폴더만 봐요). 메모는 이 PC 에 그대로 있어요.', '다시 연결')) connect();
  });
  return { refresh };
}
