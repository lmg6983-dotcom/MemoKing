// memoking --smoke : 연결 층(shim.js)이 이 PC 의 웹뷰에서 Electron 때처럼 되는지 앱 안에서 본다.
//   창마다 자기 점검을 돌려 smoke:done 으로 알리고, Rust 가 모아 찍은 뒤 끝낸다 (ipc.rs). 스티커 창은 눈으로만 (화면 사진)
window.addEventListener('load', () => setTimeout(async () => {
  const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
  if (label !== 'list' && label !== 'note') return;
  const results = [];
  const check = async (name, fn) => {
    try {
      results.push({ name: `${label}: ${name}`, ok: Boolean(await fn()) });
    } catch (err) {
      results.push({ name: `${label}: ${name}`, ok: false, detail: String(err?.message ?? err) });
    }
  };
  const mk = window.memoking;
  const dragRegion = (sel) => {
    const s = getComputedStyle(document.querySelector(sel));
    return (s.webkitAppRegion || s.appRegion) === 'drag';
  };
  if (label === 'list') {
    await check('window.memoking (preload.cjs 그대로)', () => mk?.platform === 'desktop');
    await check('invoke: app:info', async () => /^\d+\.\d+\.\d+$/.test((await mk.info()).version));
    await check('invoke: 옮기지 않은 채널은 실패로', () => mk.memos.list().then(() => false, (e) => /memos:list/.test(e.message)));
    await check('이벤트: Rust → 이 창', () => new Promise((resolve, reject) => {
      // listen 은 비동기로 자리 잡는다 — 받을 때까지 0.3초마다 다시 보낸다
      const emit = () => window.__TAURI_INTERNALS__.invoke('ipc', { channel: 'smoke:emit', args: ['memos:changed'] });
      const timer = setInterval(emit, 300);
      const off = mk.on('memos:changed', (n) => { clearInterval(timer); off(); resolve(n === 42); });
      setTimeout(() => { clearInterval(timer); reject(new Error('3초 안에 오지 않음')); }, 3000);
    }));
    await check('CSS app-region 읽힘 (창 끌기)', () => dragRegion('.titlebar'));
    await check('창 단추 셋 (CSP 아래에서도 모양)', () => {
      const b = document.querySelectorAll('.mk-caption button');
      return b.length === 3 && getComputedStyle(b[0]).width === '46px';
    });
  } else {
    await check('sendSync: 동기 호출이 Rust 까지', () => {
      try {
        mk.memo.saveSync('smoke', '', {});
      } catch (e) {
        if (/memo:save-sync/.test(e.message)) return true;
        throw e;
      }
      throw new Error('실패가 오지 않음');
    });
    await check('CSS app-region 읽힘 (창 끌기)', () => dragRegion('.bar'));
  }
  window.__TAURI_INTERNALS__.invoke('ipc', { channel: 'smoke:done', args: [results] });
}, 1500));
