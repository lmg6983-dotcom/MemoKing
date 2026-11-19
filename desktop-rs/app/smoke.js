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
  // 약속: 창 위쪽 띠(위에서 6px)의 어딘가는 창 끌기 영역 — shim.js 처럼 누른 곳부터 위로 올라가며 본다 (no-drag 가 먼저면 끌 수 없음)
  //   덮는 화면(PDF 보기 · 사진 보기)이 떠 있어도 마찬가지 (tests/window-drag.test.js 는 CSS 만 본다)
  const draggableAt = (x, y) => {
    for (let el = document.elementFromPoint(x, y); el instanceof Element; el = el.parentElement) {
      const s = getComputedStyle(el);
      const r = s.webkitAppRegion || s.appRegion;
      if (r === 'no-drag') return false;
      if (r === 'drag') return true;
    }
    return false;
  };
  const topMovable = () => [0.2, 0.4, 0.6].some((f) => draggableAt(innerWidth * f, 6));
  const pressEsc = () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
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
    const ready = new Set(); // HEVC 사본이 다 된 영상 (video.rs)
    mk.on('media:ready', (path) => ready.add(path));
    await check('window.memoking (preload.cjs 그대로)', () => mk?.platform === 'desktop');
    await check('메모 폴더 열림', async () => Boolean((await mk.info()).vaultPath));
    await check('모르는 채널은 실패로', () => window.__TAURI_INTERNALS__.invoke('ipc', { channel: 'smoke:nope', args: [] }).then(() => false, (e) => /smoke:nope/.test(String(e))));
    const seed = (await mk.memos.list()).find((m) => m.title === '시험 메모');
    await check('목록: 메모 · 태그 · 그림', () => seed?.color === 'green' && seed.tags.includes('점검') && seed.thumb === 'attachments/dot.png');
    await check('목록 카드가 화면에', () => until(() => document.body.innerText.includes('시험 메모')));
    await check('메모 폴더 그림 (memoking 주소)', () => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth === 1);
      img.onerror = () => reject(new Error(`못 읽음 ${img.src}`));
      img.src = `${mk.vaultBase}attachments/dot.png`;
    }));
    // 동영상: 메모 속 재생기처럼(출처 허락 없이) 한 장면이 나오는지, 목록 첫 장면처럼(crossOrigin) 캔버스에 그려 꺼낼 수 있는지
    const clip = (cors, name = 'clip.mp4') => new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      if (cors) v.crossOrigin = 'anonymous';
      v.onerror = () => reject(new Error(`재생 못 함 code=${v.error?.code} ${v.error?.message ?? ''}`));
      v.onloadeddata = () => {
        v.currentTime = 1;
        v.onseeked = () => {
          if (!cors) return resolve(v.videoWidth === 96);
          const c = document.createElement('canvas');
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          c.getContext('2d').drawImage(v, 0, 0);
          resolve(c.toDataURL('image/jpeg').length > 100);
        };
      };
      setTimeout(() => reject(new Error(`10초 안에 못 읽음 readyState=${v.readyState} network=${v.networkState}`)), 10000);
      v.src = `${mk.vaultBase}attachments/${name}`;
    });
    await check('동영상 재생 (메모 속 재생기)', () => clip(false));
    await check('동영상 첫 장면 그리기 (목록 카드)', () => clip(true));
    // HEVC 10비트: 이 PC 가 풀면 원본 그대로, 못 풀면 처음엔 503 으로 실패하고 H.264 사본이 다 되면(media:ready) 다시
    await check('HEVC 동영상 재생 (풀 수 없으면 H.264 사본)', () => clip(false, 'clip-hevc.mp4').catch(async () => {
      await until(() => ready.has('attachments/clip-hevc.mp4'), 20000);
      return clip(false, 'clip-hevc.mp4');
    }));
    await check('HEVC 동영상 첫 장면 그리기', () => clip(true, 'clip-hevc.mp4'));
    // 목록 카드의 첫 장면은 메인이 ffmpeg 로 뽑는다 (video.rs poster) — HEVC 도 사본 없이
    const poster = async (name) => {
      const res = await fetch(`${mk.posterBase}attachments/${name}`);
      return res.status === 200 && res.headers.get('content-type') === 'image/jpeg' && (await res.blob()).size > 100;
    };
    await check('동영상 첫 장면 (메인 ffmpeg)', () => poster('clip.mp4'));
    await check('HEVC 동영상 첫 장면 (메인 ffmpeg)', () => poster('clip-hevc.mp4'));
    // 매직 카피: 상주 PowerShell 도우미가 클립보드를 풀어 온다 (점검은 Ctrl+C 를 보내지 않는다, capture.rs)
    await check('매직 카피 도우미가 클립보드 읽기', async () => {
      await mk.copyText('매직 카피 점검 글');
      const d = await window.__TAURI_INTERNALS__.invoke('ipc', { channel: 'smoke:clipboard-dump', args: [] });
      return d.info.text === true && d.text === '매직 카피 점검 글';
    });
    await check('동영상이 아닌 파일의 첫 장면은 204', async () => (await fetch(`${mk.posterBase}attachments/dot.png`)).status === 204);
    await check('CSS app-region 읽힘 (창 끌기)', () => dragRegion('.titlebar'));
    await check('창 위쪽 띠로 창을 옮길 수 있음', () => topMovable());
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
    await check('메모 글 복사 (제목 줄 아래만)', async () => (await mk.memo.copyText(seed.id)) === true);
    await check('공유용 글 파일', async () => {
      const f = await mk.memo.shareFile(seed.id);
      return f.name === '시험 메모.txt' && atob(f.base64).length > 0;
    });
    await check('목록 카드 메뉴 → 메모 창에서 하기', async () => (await mk.memo.cardCommand(seed.id, 'versions')) === true && (await mk.memo.cardCommand(seed.id, 'nope')) === false);
    await check('따로 남긴 글 수', async () => (await mk.recovered.count()) === 0);
    await check('이어 쓰기 안내 없음 (모두 이 PC 에서 고침)', async () => (await mk.memo.handoff()) === null);
    // ---------- 빠르게 열기 · 메모리 (0.88.x) ----------
    await check('켤 때 로딩 화면이 걷힘', () => until(() => !document.getElementById('boot') || document.getElementById('boot').classList.contains('done'), 8000));
    await check('켤 때 복원 끝남 (app:restoring)', async () => (await mk.app.restoring()) === false);
    const pic = (src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`못 읽음 ${src}`));
      img.src = src;
    });
    await check('줄인 그림 주소 (작은 그림은 원본 그대로)', async () => (await pic(`${mk.vaultBase}attachments/dot.png?thumb=480`)).naturalWidth === 1);
    await check('줄인 그림 (큰 그림은 긴 변 256)', async () => {
      // 무늬를 채운 600x400 PNG (150KB 를 넘어야 줄인다)
      const c = document.createElement('canvas');
      c.width = 600;
      c.height = 400;
      const g = c.getContext('2d');
      const px = g.createImageData(600, 400);
      for (let i = 0; i < px.data.length; i++) px.data[i] = (i * 2654435761) >>> 24;
      g.putImageData(px, 0, 0);
      const bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      const big = await mk.attachments.save(bytes, 'png');
      const img = await pic(`${mk.vaultBase}${big}?thumb=256`);
      return bytes.length > 150 * 1024 && img.naturalWidth === 256 && Math.abs(img.naturalHeight - 171) <= 1; // 400 × 256 / 600 = 170.7
    });
    await check('AI 엔진: 받을 수 있음 (설치 파일에 없어도)', async () => (await mk.ai.status()).engine === true);
    await check('속도 기록', async () => (await mk.perf.log('점검')) === null);
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
  // 파일 끌어 놓기 (file-drop.js): 글 밖 아래 여백에 놓아도 들어간다 — 예전에는 편집기가 자리를 못 찾아 말없이 끝났다.
  //   끄는 동안 놓을 자리 표시 → 놓으면 파일 칩 → 되돌리기 (목록 쪽 점검이 이 메모의 제목 "새 메모" 를 본다)
  await check('파일 끌어 놓기 (글 밖 여백에)', async () => {
    const doc = await until(() => document.querySelector('.mk-doc'));
    const r = document.getElementById('editor').getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.bottom - 6, bubbles: true, cancelable: true };
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], '끌어 넣기.bin'));
    const target = document.elementFromPoint(at.clientX, at.clientY) ?? document.body;
    const stage = (name, p) => p.catch(() => { throw new Error(name); }); // 실패하면 어느 단계인지
    target.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer: dt }));
    if (document.querySelector('.mk-file-drop')?.hidden !== false) throw new Error('끄는 동안 놓을 자리 표시가 안 보임');
    target.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: dt }));
    const chip = () => [...doc.querySelectorAll('a[href^="attachments/"]')].some((a) => a.textContent.includes('끌어 넣기.bin'));
    await stage('놓은 파일이 메모에 안 들어감', until(chip));
    doc.focus();
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
    await stage('되돌리기가 안 됨', until(() => !chip()));
    return document.querySelector('.mk-file-drop').hidden;
  });
  await check('창 위쪽 띠로 창을 옮길 수 있음', () => topMovable());
  // 덮는 화면: 떠 있는 동안에도 창을 옮길 수 있고, Esc 로 닫힌다 (빈 바이트 — 못 읽어도 보기와 위 막대는 뜬다)
  await check('PDF 보기: 창 옮기기 · Esc 로 닫기', async () => {
    const { openPdfViewer } = await import(new URL('js/pdf-viewer.js', location.href).href);
    void openPdfViewer({ bytes: new Uint8Array([1, 2, 3]), name: '점검.pdf' });
    await until(() => document.querySelector('.mk-pdf-view'));
    if (!topMovable()) throw new Error('PDF 보기가 떠 있으면 창을 옮길 수 없음');
    pressEsc();
    await until(() => !document.querySelector('.mk-pdf-view')).catch(() => { throw new Error('Esc 로 닫히지 않음'); });
    return true;
  });
  await check('사진 보기: 창 옮기기 · Esc 로 닫기', async () => {
    const { openAlbumViewer } = await import(new URL('js/album-viewer.js', location.href).href);
    openAlbumViewer({ images: [{ src: 'attachments/dot.png', alt: '점' }], url: (src) => `${mk.vaultBase}${src}` });
    const view = await until(() => document.querySelector('.mk-album-view'));
    view.classList.add('ui-active'); // 단추 줄이 보일 때 (마우스를 움직이면 보인다)
    if (!topMovable()) throw new Error('사진 보기가 떠 있으면 창을 옮길 수 없음');
    pressEsc();
    await until(() => !document.querySelector('.mk-album-view')).catch(() => { throw new Error('Esc 로 닫히지 않음'); });
    return true;
  });
  await check('닫을 때 화면 스냅샷이 남음', () => {
    window.mkFlushSync?.();
    return JSON.parse(localStorage.getItem(`memoking.snap.${id}`) ?? 'null')?.html?.includes('milkdown');
  });
  done();
}, 1500));
