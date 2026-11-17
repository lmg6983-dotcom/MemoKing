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
    // 이벤트를 받을 준비는 미리 (Tauri 의 listen 은 비동기로 자리 잡는다)
    let trashed = null;
    mk.on('memo:trashed', (t) => (trashed = t));
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
    const fresh = pushed.find((m) => m.title === '새 메모');
    // 메모 창 점검이 끝난 뒤에 그 메모를 지운다 (창이 먼저 닫히면 그쪽 결과가 오지 않는다)
    let noteDone = false;
    window.__TAURI__.event.listen('smoke:note-done', () => (noteDone = true));
    await until(() => noteDone, 15000).catch(() => {});
    await check('태그 목록', async () => (await mk.tags.list()).some((t) => t.name === '점검' && t.count === 1));
    await check('초성 찾기', async () => (await mk.memos.search('ㅅㅎ')).some((m) => m.id === seed.id));
    await check('폴더 만들고 옮기기', async () => (await mk.memos.createFolder('업무')) === '업무' && (await mk.memos.moveToFolder([seed.id], '업무')) === 1
      && (await mk.memos.folders()).includes('업무') && (await mk.memos.list()).find((m) => m.id === seed.id).folder === '업무');
    await check('색 바꾸기', async () => (await mk.memo.set(fresh.id, { color: 'pink' }))?.color === 'pink');
    await check('버전 목록 (저장 전 글)', async () => Array.isArray(await mk.memo.versions(fresh.id)));
    await check('지우기 → 휴지통 · 되돌리기 띠', async () => (await mk.memo.remove(fresh.id)) === true && (await until(() => trashed)).title === '새 메모');
    await check('휴지통 되살리기', async () => (await mk.trash.restore(trashed.name)) === fresh.id && (await mk.trash.list()).length === 0);
    await check('설정 읽기', async () => /^\d+\.\d+\.\d+$/.test((await mk.settings.get()).version));
    await check('가져오기 → 새 메모', async () => {
      const got = await mk.memo.import('# 가져온 글\n본문');
      return (await mk.memos.list()).some((m) => m.id === got && m.title === '가져온 글');
    });
    await check('사본 남기기', async () => {
      const copy = await mk.memo.keepCopy(seed.id, '# 남긴 사본\n글', null);
      return copy && copy !== seed.id && (await mk.memo.get(copy)).body.includes('남긴 사본');
    });
    // 색인(index.json) · 안내(README): 2초마다의 다시 읽기가 쓴다
    const text = async (rel) => new TextDecoder().decode(await mk.attachments.read(rel).catch(() => new Uint8Array()));
    await check('색인 파일 (AI 비서용)', () => until(async () => {
      const idx = JSON.parse((await text('_memoking/index.json')) || '{}');
      return idx.schema === 'memoking.index/v1' && idx.memos?.some((m) => m.title === '가져온 글');
    }, 8000));
    await check('안내 파일', async () => (await text('_memoking/README.md')).startsWith('# 메모킹 폴더 안내'));
    await check('메모 글 복사 (제목 줄 아래만)', async () => (await mk.copyMemoText(seed.id)) === true);
    await check('공유용 글 파일', async () => {
      const f = await mk.memo.shareFile(seed.id);
      return f.name === '시험 메모.txt' && atob(f.base64).length > 0;
    });
    await check('따로 남긴 글 수', async () => (await mk.recovered.count()) === 0);
    await check('이어 쓰기 안내 없음 (모두 이 PC 에서 고침)', async () => (await mk.memo.handoff()) === null);
    // 앱 화면 밖으로 넘어가지 않는다 (넘어가면 이 점검이 끝나지 않아 실패로 보인다)
    await check('다른 주소로 넘어가지 않음', async () => {
      const here = location.href;
      location.href = 'file:///memoking-smoke-nowhere.html';
      await new Promise((r) => setTimeout(r, 800));
      return location.href === here && Boolean(document.querySelector('.titlebar'));
    });
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
  await check('잠그기 (연 채로 읽힘)', async () => {
    const m = await mk.memo.lock(id, '비밀번호1');
    return m.locked === true && m.needsPassword === false && m.body.includes('닫으며 저장');
  });
  await check('짧은 비밀번호는 거절', async () => /4자/.test((await mk.memo.lock(id, '12'))?.error ?? '') || (await mk.memo.get(id)).locked);
  await check('풀기', async () => (await mk.memo.unlock(id)).locked === false);
  // 첨부: 바이트가 그대로 오가는지 (0~255 모두)
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  let rel = '';
  await check('첨부 넣기', async () => /^attachments\/\d{8}-\d{6}-[0-9a-f]{4}\.bin$/.test((rel = await mk.attachments.save(bytes, 'bin'))));
  await check('첨부 읽기 (바이트 그대로)', async () => {
    const back = await mk.attachments.read(rel);
    return back instanceof Uint8Array && back.length === 256 && back.every((b, i) => b === i);
  });
  await check('첨부 정보', async () => (await mk.attachments.info(rel)).size === 256);
  await check('다른 이름으로 저장', async () => (await mk.attachments.saveAs({ name: '내/보내기:파일.bin', rel })).name === '보내기 파일.bin'); // Electron safeName 처럼 경로 앞은 뗀다
  await check('CSS app-region 읽힘 (창 끌기)', () => dragRegion('.bar'));
  done();
}, 1500));
