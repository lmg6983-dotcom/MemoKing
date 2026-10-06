// 바뀐 기능만 확인하는 짧은 점검 (npm run smoke:new) — 전체 점검(npm run smoke)은 요청할 때만.
// 버전마다 아래 "이번 버전" 부분을 새 기능에 맞게 바꾼다. 임시 폴더(%TEMP%\memoking-smoke)만 쓴다.
// 이번 버전: v0.19.0 — 메모 목록을 휴대폰과 같은 모양으로 (엇갈려 쌓은 카드 · 격자/한 줄씩 단추 · 오른쪽 아래 + 와 위성 버튼)
//            · 음성 메모 녹음 (+ › 음성 메모, 메모 창의 마이크 단추·Ctrl+Shift+R)
//   녹음은 점검용 가짜 마이크(삐 소리)로 한다 (main.js 가 점검 때만 켬)
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SMOKE_DIR = path.join(os.tmpdir(), 'memoking-smoke');
const VAULT = path.join(SMOKE_DIR, 'vault');
const OUT = app.isPackaged ? path.join(SMOKE_DIR, 'out') : path.join(import.meta.dirname, '..', 'out');

export function prepareSmoke(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.rmSync(VAULT, { recursive: true, force: true }); // 지난 점검의 메모·목록 모양은 지우고 새로
  fs.rmSync(path.join(userData, 'Local Storage'), { recursive: true, force: true });
  fs.mkdirSync(VAULT, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ vaultPath: VAULT, tutorialDone: true }));
}

export async function runSmoke({ noteWins, getVault, createListWindow, getList }) {
  const checks = [];
  const errors = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (...args) => {
      const [event, legacyLevel, legacyMessage] = args;
      const level = event?.level ?? legacyLevel;
      if (level === 'error' || level === 3) errors.push(event?.message ?? legacyMessage);
    });
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  async function until(fn, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        // 다시
      }
      await wait(100);
    }
    throw new Error(`시간 초과: ${label}`);
  }
  const ready = (win) => until(() => js(win, 'document.documentElement.dataset.ready === "true"'), '화면 준비', 12000);
  async function capture(win, name) {
    await wait(400);
    fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
  }
  const newWindow = async (before) => {
    const id = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), '새 메모 창');
    const win = noteWins.get(id);
    await ready(win);
    return { id, win };
  };

  let exitCode = 1;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const vault = getVault();
    const png = fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', 'icons', 'icon-256.png'));
    const shot = vault.saveAttachment(png, 'png');
    const lengths = [1, 6, 2, 9, 1, 4, 3];
    lengths.forEach((n, i) => {
      const m = vault.create();
      vault.save(m, `# 카드 ${i + 1}${i === 3 ? ' 아주 긴 제목이라 두 줄까지 보이고 나머지는 줄임표로 접혀야 하는 카드' : ''}\n\n${Array.from({ length: n }, (_, k) => `요약 ${k + 1}번째 줄이에요.`).join('\n\n')}${i === 1 ? `\n\n![사진](${shot}) #사진` : ''}${i === 2 ? ' #회의 #업무' : ''}`);
    });
    const total = lengths.length;
    const list = createListWindow();
    await ready(list);
    const lj = (code) => js(getList(), code);
    await until(() => lj(`document.querySelectorAll('#cards .card').length === ${total}`), '카드');
    getList().setSize(400, 680);
    await wait(500);

    // 1) 휴대폰과 같은 카드: 메모지처럼 엇갈려 쌓기 (2줄), 시각은 카드 아랫줄 안에
    const grid = await lj(`(() => {
      const cols = [...document.querySelectorAll('#cards > .col')];
      const h = cols.map((c) => Math.round(c.getBoundingClientRect().height));
      const card = document.querySelector('#cards .card');
      const titleLines = Math.round(document.querySelector('#cards .card-title').getBoundingClientRect().height / 21);
      const long = [...document.querySelectorAll('.card-title')].find((t) => t.textContent.includes('아주 긴'));
      return {
        layout: document.getElementById('cards').dataset.layout, cols: cols.length, perCol: cols.map((c) => c.children.length), h,
        time: !!card.querySelector('.card-foot .card-time') && !document.querySelector('.card-stamp'),
        longLines: Math.round(long.getBoundingClientRect().height / 21), titleLines,
        color: getComputedStyle(card).backgroundColor !== 'rgba(0, 0, 0, 0)',
      };
    })()`);
    check('목록: 격자 2줄로 메모지처럼 엇갈려 쌓기 (줄마다 카드, 높이 고르게)', grid.layout === 'grid' && grid.cols === 2 && grid.perCol.every((n) => n > 0) && Math.abs(grid.h[0] - grid.h[1]) < 260, JSON.stringify(grid));
    check('카드: 고친 때는 카드 아랫줄 안에 (휴대폰과 같음) · 긴 제목은 두 줄까지', grid.time && grid.longLines === 2, JSON.stringify(grid));
    await capture(getList(), 'smoke-new-list-grid.png');

    // 2) 넓히면 줄이 늘고 (2~6줄), Ctrl+- 로 줄이면 더 늘어난다
    getList().setSize(1000, 700);
    await until(async () => (await lj(`document.querySelectorAll('#cards > .col').length`)) >= 4, '넓은 창 4줄').catch(() => {});
    const wide = await lj(`document.querySelectorAll('#cards > .col').length`);
    getList().setSize(400, 680);
    await until(async () => (await lj(`document.querySelectorAll('#cards > .col').length`)) === 2, '좁은 창 2줄').catch(() => {});
    const key = (code) => lj(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code === 'Minus' ? '-' : code === 'Equal' ? '=' : '0'}', ctrlKey: true, bubbles: true }))`);
    for (let i = 0; i < 4; i++) await key('Minus');
    await until(async () => (await lj(`document.querySelectorAll('#cards > .col').length`)) >= 3, '축소 3줄').catch(() => {});
    const zoomed = await lj(`({ cols: document.querySelectorAll('#cards > .col').length, zoom: document.getElementById('cards').style.zoom })`);
    await lj(`document.querySelector('.zoom-badge button').click()`);
    await until(async () => (await lj(`document.querySelectorAll('#cards > .col').length`)) === 2, '원래대로').catch(() => {});
    check('넓은 창은 4줄 이상, Ctrl+- 로 줄이면 줄이 늘고 원래대로 누르면 2줄', wide >= 4 && zoomed.cols >= 3 && (await lj(`document.querySelectorAll('#cards > .col').length`)) === 2, JSON.stringify({ wide, zoomed }));

    // 3) 격자 / 한 줄씩 단추 — 이 PC 에 기억
    await lj(`document.getElementById('layout-btn').click()`);
    await wait(500);
    const rows = await lj(`({ layout: document.getElementById('cards').dataset.layout, cols: document.querySelectorAll('#cards > .col').length, saved: localStorage.getItem('memoking.layout'), label: document.getElementById('layout-btn').getAttribute('aria-label'), n: document.querySelectorAll('#cards .card').length })`);
    await capture(getList(), 'smoke-new-list-rows.png');
    getList().close();
    await until(() => !getList() || getList().isDestroyed(), '목록 닫힘').catch(() => {});
    createListWindow();
    await ready(getList());
    await until(() => lj(`document.querySelectorAll('#cards .card').length === ${total}`), '카드 다시');
    const kept = await lj(`document.getElementById('cards').dataset.layout`);
    check('한 줄씩 단추 → 카드가 한 줄로 · 목록 창을 다시 열어도 그대로', rows.layout === 'rows' && rows.cols === 1 && rows.n === total && rows.saved === 'rows' && /격자/.test(rows.label) && kept === 'rows', JSON.stringify({ rows, kept }));
    await lj(`document.getElementById('layout-btn').click()`);
    await wait(400);
    check('다시 누르면 격자로', (await lj(`document.getElementById('cards').dataset.layout`)) === 'grid');

    // 4) 데스크탑만의 기능은 그대로: 마우스를 올리면 PDF·압정·지우기, 왕관 스티커 단추
    const extras = await lj(`(() => { const it = document.querySelector('#cards .item'); return { actions: it.querySelectorAll('.card-actions button').length, crown: !!document.getElementById('list-top-btn'), tags: document.querySelectorAll('.card [data-card-tag]').length }; })()`);
    check('카드 버튼 묶음(PDF·압정·지우기) · 왕관 스티커 · 누르는 태그는 그대로', extras.actions === 3 && extras.crown && extras.tags >= 2, JSON.stringify(extras));

    // 5) 오른쪽 아래 + → 위성 버튼 (음성 메모 · 글 메모), Esc 로 닫힘
    const fab = await lj(`(() => { const r = document.getElementById('fab').getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom, w: r.width, toolbarPlus: !!document.getElementById('new-btn') }; })()`);
    await lj(`document.getElementById('fab').click()`);
    await wait(350);
    const menu = await lj(`({ open: !document.getElementById('fab-menu').hidden, sats: [...document.querySelectorAll('#fab-menu .fab-sat')].map((b) => b.dataset.new), expanded: document.getElementById('fab').getAttribute('aria-expanded') })`);
    await capture(getList(), 'smoke-new-fab.png');
    await lj(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(300);
    const closed = await lj(`document.getElementById('fab-menu').hidden`);
    check('오른쪽 아래 노란 + (위 도구막대의 + 는 없어짐) → 위성 버튼 음성 메모·글 메모, Esc 로 닫힘', fab.right > 10 && fab.right < 30 && fab.bottom > 10 && fab.bottom < 30 && !fab.toolbarPlus && menu.open && menu.sats.join() === 'voice,text' && menu.expanded === 'true' && closed, JSON.stringify({ fab, menu, closed }));
    let before = new Set(noteWins.keys());
    await lj(`document.getElementById('fab').click()`);
    await wait(250);
    await lj(`document.querySelector('#fab-menu [data-new="text"]').click()`);
    const text = await newWindow(before);
    const notRecording = await js(text.win, `document.getElementById('rec-panel').hidden`);
    check('글 메모 → 새 메모 창 (녹음은 시작하지 않음)', notRecording);
    text.win.close();

    // 6) 음성 메모 → 메모 창이 열리며 바로 녹음, 끝내면 소리 파일이 음성 카드로
    before = new Set(noteWins.keys());
    await lj(`document.getElementById('fab').click()`);
    await wait(250);
    await lj(`document.querySelector('#fab-menu [data-new="voice"]').click()`);
    const voice = await newWindow(before);
    const vj = (code) => js(voice.win, code);
    const recOn = await until(() => vj(`!document.getElementById('rec-panel').hidden && document.querySelector('.format-bar [data-action="record"]').classList.contains('active')`), '녹음 시작', 8000).catch(() => false);
    await wait(2600);
    const during = await vj(`({ time: document.getElementById('rec-time').textContent, wave: [...document.querySelectorAll('#rec-wave i')].some((i) => parseFloat(i.style.getPropertyValue('--lv') || 0) > 0.02) })`);
    await capture(voice.win, 'smoke-new-recording.png');
    // 잠시 멈춤 → 시간이 멈춤 → 이어서
    await vj(`document.getElementById('rec-pause').click()`);
    const paused1 = await vj(`document.getElementById('rec-time').textContent`);
    await wait(1200);
    const paused = await vj(`({ t: document.getElementById('rec-time').textContent, state: document.getElementById('rec-state').textContent, cls: document.getElementById('rec-panel').classList.contains('paused') })`);
    await vj(`document.getElementById('rec-pause').click()`);
    check('음성 메모 → 메모 창이 열리며 바로 녹음 (빨간 점·시간·소리 크기)', recOn && /^00:0[2-4]$/.test(during.time) && during.wave, JSON.stringify(during));
    check('잠시 멈춤 → 시간이 멈추고 "일시 정지"', paused.cls && paused.state === '일시 정지' && paused.t === paused1, JSON.stringify({ paused1, paused }));
    await wait(600);
    await vj(`document.getElementById('rec-stop').click()`);
    const saved = await until(() => {
      const m = vault.get(voice.id);
      return m && /> !\[녹음 [^\]]+ · 00:0\d\]\(attachments\/[^)]+\.(m4a|weba)\)/.test(m.body) && m;
    }, '녹음 저장', 10000).catch(() => null);
    const src = saved?.body.match(/\((attachments\/[^)]+)\)/)?.[1];
    const size = src ? fs.statSync(path.join(VAULT, src)).size : 0;
    const audio = await until(() => vj(`(() => { const a = document.querySelector('.mk-doc audio'); return a && a.readyState >= 1 && { duration: a.duration, card: !!a.closest('.mk-voice') }; })()`), '소리 재생기', 8000).catch(() => null);
    check('끝내기 → 소리 파일(m4a/weba)이 메모 폴더에, 메모에는 "음성 메모 · 날짜" 제목과 음성 카드', saved && /^# 음성 메모 · /.test(saved.body) && size > 2000 && !(await vj(`!document.getElementById('rec-panel').hidden`)), JSON.stringify({ body: saved?.body, size }));
    check('넣은 녹음은 바로 재생할 수 있음 (길이가 보임)', audio && audio.card && Number.isFinite(audio.duration) && audio.duration > 1.5, JSON.stringify(audio));
    await capture(voice.win, 'smoke-new-voice-card.png');

    // 7) 메모 창의 마이크 단추 / Ctrl+Shift+R — 녹음 중에 창을 닫아도 녹음은 메모에 들어간다
    await vj(`document.querySelector('.mk-doc').focus()`);
    voice.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control', 'shift'] });
    const again = await until(() => vj(`!document.getElementById('rec-panel').hidden`), 'Ctrl+Shift+R 녹음', 6000).catch(() => false);
    await wait(1500);
    await vj(`document.getElementById('close-btn').click()`);
    await until(() => !noteWins.get(voice.id), '창 닫힘', 10000).catch(() => {});
    const two = (vault.get(voice.id)?.body.match(/> !\[녹음/g) ?? []).length;
    check('Ctrl+Shift+R 로 녹음 → 녹음 중에 창을 닫아도 두 번째 녹음이 메모에 저장됨', again && two === 2, `again=${again} 녹음 ${two}개`);
    await until(() => lj(`!!document.querySelector('.card[data-id="${voice.id}"] .card-badge')`), '목록 카드 소리 표시').catch(() => {});
    const badge = await lj(`!!document.querySelector('.card[data-id="${voice.id}"] .card-meta .card-badge')`);
    check('목록 카드에 소리 표시', badge);

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  }

  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `바뀐 기능 점검 통과 (${checks.length}개)` : '바뀐 기능 점검 실패');
  app.exit(exitCode);
}
