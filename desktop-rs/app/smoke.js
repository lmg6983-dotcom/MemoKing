// memoking --smoke : 연결 층(shim.js)이 이 PC 의 웹뷰에서 Electron 때처럼 되는지 앱 안에서 본다 → Rust 가 결과를 찍고 끝낸다
window.addEventListener('load', () => setTimeout(async () => {
  const results = [];
  const check = async (name, fn) => {
    try {
      results.push({ name, ok: Boolean(await fn()) });
    } catch (err) {
      results.push({ name, ok: false, detail: String(err?.message ?? err) });
    }
  };
  const mk = window.memoking;
  await check('window.memoking (preload.cjs 그대로)', () => mk?.platform === 'desktop');
  await check('invoke: app:info', async () => /^\d+\.\d+\.\d+$/.test((await mk.info()).version));
  await check('invoke: 옮기지 않은 채널은 실패로', () => mk.memos.list().then(() => false, (e) => /memos:list/.test(e.message)));
  await check('sendSync: 동기 호출이 Rust 까지', () => {
    try {
      mk.memo.saveSync('smoke', '', {});
    } catch (e) {
      if (/memo:save-sync/.test(e.message)) return true;
      throw e;
    }
    throw new Error('실패가 오지 않음');
  });
  await check('이벤트: Rust → 이 창', () => new Promise((resolve, reject) => {
    const off = mk.on('memos:changed', (n) => { off(); resolve(n === 42); });
    setTimeout(() => window.__TAURI_INTERNALS__.invoke('ipc', { channel: 'smoke:emit', args: ['memos:changed'] }), 300); // listen 이 자리 잡은 뒤
    setTimeout(() => reject(new Error('3초 안에 오지 않음')), 3000);
  }));
  await check('CSS app-region 읽힘 (창 끌기)', () => {
    const s = getComputedStyle(document.querySelector('.titlebar'));
    return (s.webkitAppRegion || s.appRegion) === 'drag';
  });
  await check('목록 창 단추 셋', () => document.querySelectorAll('.mk-caption button').length === 3);
  window.__TAURI_INTERNALS__.invoke('ipc', { channel: 'smoke:done', args: [results] });
}, 1500));
