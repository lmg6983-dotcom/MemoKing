// 바뀐 기능만 확인하는 짧은 점검 (npm run smoke:new) — 전체 점검(npm run smoke)은 요청할 때만.
// 버전마다 아래 "이번 버전" 부분을 새 기능에 맞게 바꾼다. 임시 폴더(%TEMP%\memoking-smoke)만 쓴다.
// 이번 버전: v0.19.0 — 메모 목록을 휴대폰과 같은 모양으로 (엇갈려 쌓은 카드 · 격자/한 줄씩 단추 · 오른쪽 아래 + 와 위성 버튼)
//            · 음성 메모 녹음 (+ › 음성 메모, 메모 창의 마이크 단추·Ctrl+Shift+R)
//   녹음은 점검용 가짜 마이크(삐 소리)로 한다 (main.js 가 점검 때만 켬)
//   v0.21.0 — 손 메모 (콘텐츠: 목록 + › 손 메모 · 메모 + › 손 메모, 주석: + › 주석 · Ctrl+Shift+E), 도구막대는 휴대폰처럼 + 하나로
//   v0.20.0 — PC 받아쓰기: MEMOKING_STT_DIR(받아 둔 데이터)·MEMOKING_FAKE_AUDIO(가짜 마이크가 들려줄 한국어 wav)가 있으면
//             녹음하며 받아쓰기 · 음성 카드 · 말한 사람 나누기 · 메뉴의 소리 받아쓰기까지
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

export async function runSmoke({ noteWins, getVault, createListWindow, getList, getStacks, isInking, trackWindowDrag, endWindowDrag }) {
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
    check('오른쪽 아래 노란 + (위 도구막대의 + 는 없어짐) → 위성 버튼 음성 메모·글 메모, Esc 로 닫힘', fab.right > 10 && fab.right < 30 && fab.bottom > 10 && fab.bottom < 30 && !fab.toolbarPlus && menu.open && menu.sats.join() === 'voice,ink,text' && menu.expanded === 'true' && closed, JSON.stringify({ fab, menu, closed }));
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
    const recOn = await until(() => vj(`!document.getElementById('rec-panel').hidden && document.querySelector('.add-sat[data-action="record"]').classList.contains('active') && document.body.classList.contains('recording')`), '녹음 시작', 8000).catch(() => false);
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

    // 8) 손 메모: 목록 + › 손 메모 → 그리기 화면 → 완료하면 그린 만큼의 SVG 한 칸, 두 번 눌러 이어 그리기, 주석은 글 위에
    {
      before = new Set(noteWins.keys());
      await lj(`document.getElementById('fab').click()`);
      await wait(250);
      await lj(`document.querySelector('#fab-menu [data-new="ink"]').click()`);
      const ink = await newWindow(before);
      const ij = (code) => js(ink.win, code);
      const sheetOpen = await until(() => ij(`!!document.querySelector('.ink-sheet')`), '그리기 화면', 6000).catch(() => false);
      const size = ink.win.getSize();
      const mouse = (type, x, y, extra = {}) => ink.win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
      const stroke = async (pts) => {
        mouse('mouseMove', pts[0][0], pts[0][1]);
        await wait(30);
        mouse('mouseDown', pts[0][0], pts[0][1]);
        for (const [x, y] of pts.slice(1)) {
          mouse('mouseMove', x, y, { modifiers: ['leftButtonDown'] });
          await wait(16);
        }
        mouse('mouseUp', pts.at(-1)[0], pts.at(-1)[1]);
        await wait(80);
      };
      const wave = (x0, y0, w) => Array.from({ length: 14 }, (_, i) => [x0 + (w * i) / 13, y0 + Math.sin(i / 1.7) * 16]);
      await stroke(wave(60, 140, 200));
      await stroke(wave(80, 220, 140));
      const drawn = await ij(`document.querySelectorAll('.ink-sheet .ink-strokes path').length`);
      await capture(ink.win, 'smoke-new-ink-editor.png');
      check('목록 + › 손 메모 → 넓은 메모 창에 그리기 화면 · 마우스로 그린 획', sheetOpen && size[0] >= 540 && drawn === 2, JSON.stringify({ sheetOpen, size, drawn }));
      // v0.22.0: 취소 없음 · 완료 하나 · 떠 있는 도구 막대 · 그리는 칸은 창을 끌지 않음 (머리 줄만 끌기)
      const ui = await ij(`(() => {
        const q = (s) => document.querySelector(s);
        const region = (s) => getComputedStyle(q(s)).webkitAppRegion ?? getComputedStyle(q(s)).getPropertyValue('-webkit-app-region');
        return { buttons: [...document.querySelectorAll('.ink-head button')].map((b) => b.textContent.trim()).join(), sheet: region('.ink-sheet'), head: region('.ink-head'), done: region('.ink-head .ink-done'), dock: !!q('.ink-sheet .ink-dock'), empty: q('.ink-empty').classList.contains('gone') };
      })()`);
      check('그리기 화면: 취소 없이 완료 하나 · 그리는 칸 no-drag · 머리 줄로 창 옮기기 · 떠 있는 도구 막대 · 그리면 안내 사라짐', ui.buttons === '완료' && ui.sheet === 'no-drag' && ui.head === 'drag' && ui.done === 'no-drag' && ui.dock && ui.empty, JSON.stringify(ui));
      // 그리는 동안 창을 끌어 다른 메모 위에 머물러도 합치지 않고, 다른 메모도 이 창으로 합쳐 들어오지 않는다
      const center = (w) => {
        const b = w.getBounds();
        return { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) };
      };
      const otherId = vault.create();
      vault.save(otherId, '# 옆 메모');
      await lj(`window.memoking.memo.open(${JSON.stringify(otherId)})`);
      const other = await until(() => noteWins.get(otherId), '옆 메모 창');
      await ready(other);
      const inkingNow = await until(() => isInking(ink.id), '그리기 표시', 3000).catch(() => false);
      trackWindowDrag(ink.id, center(other));
      await wait(400);
      const hoverOnOther = await js(other, `!document.getElementById('stack-drop').hidden`);
      endWindowDrag(ink.id);
      trackWindowDrag(otherId, center(ink.win));
      await wait(400);
      endWindowDrag(otherId);
      await wait(300);
      check('그리는 중에는 창을 끌어 머물러도 탭으로 합쳐지지 않음 (양쪽 모두)', inkingNow && !hoverOnOther && !getStacks().stackOf(ink.id) && !getStacks().stackOf(otherId), JSON.stringify({ inkingNow, hoverOnOther }));
      other.close();
      ink.win.focus();
      // 색·굵기 작은 판: 고른 도구를 한 번 더 누르면 열리고, Esc 는 판부터 닫는다 (그리기 화면은 그대로)
      await ij(`document.querySelector('.ink-sheet .ink-tool-pen').click()`);
      const popOpen = await ij(`!document.querySelector('.ink-sheet .ink-pop').hidden && document.querySelectorAll('.ink-sheet .ink-pop .ink-color').length`);
      await capture(ink.win, 'smoke-new-ink-pop.png');
      ink.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await wait(100);
      const popClosed = await ij(`document.querySelector('.ink-sheet .ink-pop').hidden && !!document.querySelector('.ink-sheet:not(.closing)')`);
      check('펜을 한 번 더 누르면 색·굵기 판 · Esc 는 판만 닫음', popOpen === 7 && popClosed, JSON.stringify({ popOpen, popClosed }));
      await ij(`document.querySelector('.ink-sheet .ink-done').click()`);
      const inkBody = await until(() => {
        const m = vault.get(ink.id);
        return m && /!\[손 메모\]\(attachments\/[^)]+\.svg\)/.test(m.body) && m.body;
      }, '손 메모 저장', 8000).catch(() => null);
      const svgRel = inkBody?.match(/\((attachments\/[^)]+\.svg)\)/)?.[1];
      const svgText = svgRel ? fs.readFileSync(path.join(VAULT, svgRel), 'utf8') : '';
      const shown = await until(() => ij(`(() => { const i = document.querySelector('.mk-ink img'); return i && i.complete && i.naturalWidth > 0 && { w: i.naturalWidth, h: i.naturalHeight }; })()`), '손 메모 칸').catch(() => null);
      check('완료 → 메모에 그린 만큼의 손 메모 한 칸 (SVG · 고칠 자료 포함)', svgRel && /memoking-ink/.test(svgText) && shown && shown.w > 180 && shown.w < 260 && shown.h < 160, JSON.stringify({ inkBody, shown }));
      await capture(ink.win, 'smoke-new-ink-memo.png');
      // 두 번 누르면 이어 그리기 → 검은 바탕으로 한 획 더
      await ij(`document.querySelector('.mk-ink img').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      const reopened = await until(() => ij(`document.querySelectorAll('.ink-sheet .ink-strokes path').length`), '이어 그리기', 6000).catch(() => 0);
      await ij(`document.querySelector('.ink-sheet .ink-bg-btn').click()`);
      await ij(`document.querySelector('.ink-sheet .ink-pop .ink-bg[data-bg="black"]').click()`);
      await capture(ink.win, 'smoke-new-ink-bg.png');
      await stroke(wave(60, 300, 120));
      await ij(`document.querySelector('.ink-sheet .ink-done').click()`);
      const inkBody2 = await until(() => {
        const m = vault.get(ink.id);
        return m && /!\[손 메모 · 검은 바탕\]/.test(m.body) && m.body;
      }, '이어 그린 손 메모', 8000).catch(() => null);
      const svg2 = inkBody2 ? fs.readFileSync(path.join(VAULT, inkBody2.match(/\((attachments\/[^)]+\.svg)\)/)[1]), 'utf8') : '';
      check('두 번 누르면 이어 그리기 (그린 획 그대로) → 검은 바탕: 이미 그린 검은 획도 흰색으로 · 흰 펜으로 저장', reopened === 2 && (svg2.match(/<path /g) ?? []).length === 3 && /#111111/.test(svg2) && (svg2.match(/fill="#ffffff"/g) ?? []).length === 3, JSON.stringify({ reopened, inkBody2 }));
      // 주석: Ctrl+Shift+E → 글 위에 그리기 → Esc 로 끝내면 머리말 ink:
      await ij(`(() => { const v = document.querySelector('.ProseMirror'); v.focus(); })()`);
      ink.win.webContents.insertText('');
      await ij(`document.querySelector('.ProseMirror').focus()`);
      ink.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'E', modifiers: ['control', 'shift'] });
      const annotOn = await until(() => ij(`!!document.querySelector('.mk-annot.drawing') && !!document.querySelector('.mk-annot-bar')`), '주석 모드', 5000).catch(() => false);
      const at = await ij(`(() => { const r = document.querySelector('.ProseMirror > :first-child').getBoundingClientRect(); return { x: r.left + 10, y: r.top + 20 }; })()`);
      await stroke([[at.x, at.y], [at.x + 60, at.y + 3], [at.x + 120, at.y - 2]]);
      await capture(ink.win, 'smoke-new-annotate.png');
      ink.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      const annBody = await until(() => {
        const m = vault.get(ink.id);
        return m?.ink && m;
      }, '주석 저장', 8000).catch(() => null);
      const ann = annBody ? JSON.parse(fs.readFileSync(path.join(VAULT, annBody.ink), 'utf8')) : null;
      const raw = annBody ? fs.readFileSync(path.join(VAULT, annBody.file), 'utf8') : '';
      check('주석: Ctrl+Shift+E → 글 위에 그리고 Esc → 머리말 ink: 파일 (제목 문단에 붙음) · 보이는 층에 남음', annotOn && ann?.strokes?.length === 1 && ann.strokes[0].anchor?.b === 0 && /^ink: attachments\//m.test(raw) && (await ij(`document.querySelectorAll('.mk-annot path').length`)) === 1, JSON.stringify({ annotOn, ann: ann?.strokes?.[0]?.anchor, raw: raw.slice(0, 200) }));
      check('주석을 끝내면 합치기 다시 됨', !isInking(ink.id));
      ink.win.close();
      await until(() => !noteWins.get(ink.id), '손 메모 창 닫힘').catch(() => {});
      // 다시 열면 주석이 그대로 보인다
      await lj(`window.memoking.memo.open(${JSON.stringify(ink.id)})`);
      const again = await until(() => noteWins.get(ink.id), '다시 열기');
      await ready(again);
      const kept = await until(() => js(again, `document.querySelectorAll('.mk-annot path').length`), '주석 다시 보임', 5000).catch(() => 0);
      check('다시 열어도 주석이 그 자리에', kept === 1, String(kept));
      // + 메뉴: 음성 녹음·손 메모·주석·사진·파일·표·수식 (휴대폰과 같음)
      await js(again, `document.getElementById('add-btn').click()`);
      await wait(300);
      const sats = await js(again, `[...document.querySelectorAll('#add-menu:not([hidden]) .add-sat')].map((b) => b.dataset.add).join()`);
      await capture(again, 'smoke-new-add-menu.png');
      check('메모 창 + → 음성 녹음·손 메모·주석·사진·파일·표·수식', sats === 'record,ink,annotate,photo,file,table,math', sats);
      // + › 수식: 한 번에 고치기 창이 뜬다 (실제 마우스로)
      const mclick = async (sel) => {
        const r = await js(again, `(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        for (const type of ['mouseDown', 'mouseUp']) again.webContents.sendInputEvent({ type, x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 });
      };
      await mclick('.add-sat[data-add="math"]');
      const mathOpen = await until(() => js(again, `!!document.querySelector('.mk-math-editor')`), '수식 창', 3000).catch(() => false);
      const mathState = await js(again, `({ editors: document.querySelectorAll('.mk-math-editor').length, blocks: document.querySelectorAll('.mk-math-block').length })`);
      await capture(again, 'smoke-new-math.png');
      check('+ › 수식 → 한 번에 수식 고치기 창', mathOpen, JSON.stringify(mathState));
      again.close();
    }

    // 8) 받아쓰기 (데이터와 한국어 소리가 있을 때만)
    if (process.env.MEMOKING_STT_DIR && process.env.MEMOKING_FAKE_AUDIO) {
      await lj(`document.getElementById('settings-btn').click()`);
      await wait(400);
      let sttUi = await lj(`({ on: document.getElementById('stt-enabled').checked, note: document.getElementById('stt-note').textContent, dl: document.getElementById('stt-download').hidden })`);
      await lj(`document.getElementById('stt-speaker').click()`);
      await until(() => lj(`document.getElementById('stt-speaker').checked`), '말한 사람 나누기 켬').catch(() => {});
      await capture(getList(), 'smoke-new-stt-settings.png');
      await lj(`document.getElementById('settings-dialog').close()`);
      check('설정 › 음성 녹음: 받아쓰기 켜짐 · 데이터 있음(받기 단추 숨김) · 말한 사람 나누기 켜기', sttUi.on && sttUi.dl && /문장마다/.test(sttUi.note), JSON.stringify(sttUi));
      before = new Set(noteWins.keys());
      await lj(`document.getElementById('fab').click()`);
      await wait(250);
      await lj(`document.querySelector('#fab-menu [data-new="voice"]').click()`);
      const talk = await newWindow(before);
      const tj = (code) => js(talk.win, code);
      const live = await until(async () => {
        const t = await tj(`[...document.querySelectorAll('#rec-text > div:not(.rec-hint):not(.rec-listening)')].map((d) => d.textContent)`);
        return t.length >= 2 && t;
      }, '녹음하며 받아쓴 글', 30000).catch(() => null);
      const state = await tj(`document.getElementById('rec-state').textContent`);
      await capture(talk.win, 'smoke-new-stt-live.png');
      check('녹음하는 동안 문장마다 글이 나타남 ("받아쓰는 중")', live && state === '받아쓰는 중' && live.some((l) => /생각을 하면서/.test(l)), JSON.stringify({ live, state }));
      await tj(`document.getElementById('rec-stop').click()`);
      const body = await until(() => {
        const m = vault.get(talk.id);
        return m && /> !\[녹음/.test(m.body) && /> .*(생각|괜찮은|주민등록증|지하철)/.test(m.body) && m.body;
      }, '받아쓴 글이 든 음성 카드', 20000).catch(() => null);
      check('끝내기 → 소리와 받아쓴 글이 한 음성 카드로 (문장마다 줄)', body && (body.match(/^> (?!!\[)\S/gm) ?? []).length >= 2, body);
      const labelled = await until(() => {
        const m = vault.get(talk.id);
        return m && /\*\*화자 \d:\*\*/.test(m.body) && m.body;
      }, '화자 이름표', 60000).catch(() => null);
      const cardUi = await tj(`({ card: !!document.querySelector('.mk-voice'), spk: document.querySelectorAll('.mk-voice [class*="mk-spk-"]').length })`);
      await capture(talk.win, 'smoke-new-stt-card.png');
      check('말한 사람을 나눈 뒤 음성 카드에 "화자 N:" 이름표', labelled, labelled ?? vault.get(talk.id)?.body);
      // 메뉴 › 소리 받아쓰기: 받아쓴 글이 없는 소리 파일
      const wavRel = vault.saveAttachment(fs.readFileSync(process.env.MEMOKING_FAKE_AUDIO), 'wav');
      const fileMemo = vault.create();
      vault.save(fileMemo, `# 회의 녹음\n\n![회의](${wavRel})\n`);
      await lj(`window.memoking.memo.open(${JSON.stringify(fileMemo)})`);
      const fw = await until(() => noteWins.get(fileMemo), '소리 메모 창');
      await ready(fw);
      await js(fw, `document.getElementById('transcribe-btn').click()`);
      const filed = await until(() => {
        const m = vault.get(fileMemo);
        return m && /> !\[회의\]/.test(m.body) && /주민등록증/.test(m.body) && m.body;
      }, '소리 받아쓰기', 40000).catch(() => null);
      check('메뉴 › 소리 받아쓰기 → 그 소리의 음성 카드에 받아쓴 글', filed, filed ?? vault.get(fileMemo)?.body);
      void cardUi;
      fw.close();
      talk.win.close();
    }

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  }

  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `바뀐 기능 점검 통과 (${checks.length}개)` : '바뀐 기능 점검 실패');
  app.exit(exitCode);
}
