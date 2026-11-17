// memoking --smoke : 앱 안에서 Electron 때처럼 되는지 본다. 창마다 점검을 돌려 smoke:done 으로 알리고, Rust 가 모아 찍은 뒤 끝낸다 (ipc.rs)
//   메모 폴더는 임시 폴더 — "시험 메모"(그림 하나)가 들어 있다 (memos.rs start)
window.addEventListener('load', () => setTimeout(async () => {
  const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
  const mk = window.memoking;
  const results = [];
  const check = async (name, fn) => {
    try {
      results.push({ name: `${label}: ${name}`, ok: Boolean(await fn()) });
    } catch (err) {
      results.push({ name: `${label}: ${name}`, ok: false, detail: String(err?.message ?? err) });
    }
  };
  const done = () => window.__TAURI_INTERNALS__.invoke('ipc', { channel: 'smoke:done', args: [results] });
  const dragRegion = (sel) => {
    const s = getComputedStyle(document.querySelector(sel));
    return (s.webkitAppRegion || s.appRegion) === 'drag';
  };
  const until = (fn, ms = 5000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      const v = await fn();
      if (v) resolve(v);
      else if (Date.now() - t0 > ms) reject(new Error(`${ms / 1000}초 안에 되지 않음`));
      else setTimeout(tick, 150);
    };
    tick();
  });

  if (label === 'list') {
    await check('window.memoking (preload.cjs 그대로)', () => mk?.platform === 'desktop');
    await check('메모 폴더 열림', async () => Boolean((await mk.info()).vaultPath));
    await check('옮기지 않은 채널은 실패로', () => mk.tags.aiStatus().then(() => false, (e) => /tags:ai-status/.test(e.message)));
    const seed = (await mk.memos.list()).find((m) => m.title === '시험 메모');
    await check('목록: 메모 · 태그 · 그림', () => seed?.color === 'green' && seed.tags.includes('점검') && seed.thumb === 'attachments/dot.png');
    await check('목록 카드가 화면에', () => until(() => document.body.innerText.includes('시험 메모')));
    await check('메모 폴더 그림 (memoking 주소)', () => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth === 1);
      img.onerror = () => reject(new Error(`못 읽음 ${img.src}`));
      img.src = `${mk.vaultBase}attachments/dot.png`;
    }));
    await check('CSS app-region 읽힘 (창 끌기)', () => dragRegion('.titlebar'));
    await check('창 단추 셋 (CSP 아래에서도 모양)', () => {
      const b = document.querySelectorAll('.mk-caption button');
      return b.length === 3 && getComputedStyle(b[0]).width === '46px';
    });
    // 새 메모 → 메모 창이 열려 글을 저장하면(아래 note 점검) 목록이 새로 그린다
    let pushed = null;
    mk.on('memos:changed', (memos) => (pushed = memos));
    await check('새 메모 창 열기', async () => typeof (await mk.memo.create({})) === 'string');
    await check('저장한 메모가 목록에 (이벤트)', () => until(() => pushed?.some((m) => m.title === '새 메모' && m.open), 15000));
    return done();
  }

  // 메모 창: 새 메모일 때만 (목록이 연 것)
  const id = new URLSearchParams(location.search).get('id');
  const memo = await mk.memo.get(id);
  if (!memo || memo.body) return;
  await check('메모 열기', () => memo.id === id && memo.color === 'yellow');
  await check('저장 → 목록 카드', async () => (await mk.memo.save(id, '# 새 메모\n\n본문 #태그')).title === '새 메모');
  await check('다시 읽기', async () => (await mk.memo.get(id)).body === '# 새 메모\n\n본문 #태그');
  await check('창을 닫을 때 저장 (동기)', () => mk.memo.saveSync(id, '# 새 메모\n\n본문 #태그\n닫으며 저장', {}) === true);
  await check('CSS app-region 읽힘 (창 끌기)', () => dragRegion('.bar'));
  done();
}, 1500));
