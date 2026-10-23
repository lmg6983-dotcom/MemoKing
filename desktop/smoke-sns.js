// SNS 소개 자료용 화면 찍기 (npm run shots:sns) — 점검처럼 실제 앱을 띄워 실제로 쓰는 듯한 메모로 장면을 만들고 찍는다.
//   예시 메모는 튜토리얼 연습 공간과 같은 것(제주 여행 준비 · 주간 회의 · 음식 사진 …)에 몇 개를 더한다. 실제 설정 · 메모는 건드리지 않는다.
//   결과: out/sns/*.png (창마다 한 장) + out/sns/scenes.json (창의 화면 위치 — 메모 창과 왕관 · 테이프 스티커를 한 장면으로 합칠 때)
//   2배 화질: --force-device-scale-factor=2 와 큰 가상 화면으로 띄운다 (package.json shots:sns)
import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileIndex } from './file-index.js';
import { seedTutorialSandbox } from '../app/js/core/tutorial.js';
import { toLocalIso } from '../app/js/core/memo-file.js';

const SMOKE_DIR = path.join(os.tmpdir(), 'memoking-smoke');
const VAULT = path.join(SMOKE_DIR, 'vault');
// 찾을 PC 파일은 홈 폴더에 (매직키에 "~/문서" 처럼 보이게 — shots:sns 는 HOME 을 임시 폴더로 바꿔 띄운다)
const FILES = os.homedir();
const OUT = path.join(import.meta.dirname, '..', 'out', 'sns');
const SAMPLE = path.join(import.meta.dirname, '..', 'app', 'assets', 'tutorial', 'sample');

// 매직키로 찾을 PC 파일 (이름만, 내용은 비어 있어도 된다)
const PC_FILES = [
  '문서/주간 회의록 10월.docx', '문서/회의실 배치도.pdf', '문서/2026 하반기 마케팅 계획.pptx', '문서/출시 준비 체크리스트.xlsx',
  '문서/제주 여행 일정표.xlsx', '사진/제주 여행/협재 해변.jpg', '다운로드/견적서_메모킹.pdf',
];

export function prepareSmoke(userData) {
  for (const dir of [VAULT, path.join(SMOKE_DIR, 'wpn'), path.join(userData, 'notification-history'), ...['문서', '사진', '다운로드'].map((d) => path.join(FILES, d))]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(VAULT, { recursive: true });
  for (const f of PC_FILES) {
    fs.mkdirSync(path.join(FILES, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(FILES, f), 'x'.repeat(2048));
  }
  fs.mkdirSync(path.join(SMOKE_DIR, 'wpn'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    vaultPath: VAULT, tutorialDone: true, historyEnabled: true,
    magic: { modules: { opms: false }, known: ['memo', 'notes', 'files', 'calc', 'web', 'ai', 'opms'] },
  }));
}

// 사진에 안 어울리는 것: 처음 한 번 뜨는 안내 말풍선 (점검 창마다 처음이라 매번 뜬다)
function quietHints() {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('dom-ready', () => {
      wc.insertCSS('.hint-bubble { display: none !important; }').catch(() => {});
      wc.executeJavaScript(`try { localStorage.setItem('memoking.hint.blockMove', '1'); localStorage.setItem('memoking.stickerHintSeen', '["top","tape","bottom"]'); } catch {}`).catch(() => {});
    });
  });
}

// 예시 메모에 더하는 일 메모 (Work 목록이 비어 보이지 않게)
const WORK_MEMOS = [
  { body: '# 이번 주 할 일\n\n- [x] 주간 보고서 제출\n- [ ] 소개 글 검토\n- [ ] 화면 사진 고르기\n- [ ] 회의록 공유\n\n#업무', color: 'yellow', daysAgo: 0 },
  { body: '# 거래처 미팅\n\n- 납품은 11월 둘째 주로 확정\n- 샘플 3종 추가 요청\n- [ ] 견적서 다시 보내기\n\n#업무', color: 'green', daysAgo: 1 },
  { body: '# 신입 온보딩\n\n| 날 | 할 일 |\n| --- | --- |\n| 월 | 계정, 장비 |\n| 화 | 제품 교육 |\n| 수 | 짝 업무 |\n\n#업무', color: 'purple', daysAgo: 4 },
];

export async function runSmoke({ getVault, getList, createListWindow, noteWins, showMagic, getMagic, useFileIndex, getHistory, memoHotkeys, windowManager }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  const done = [];
  const failed = [];
  const scenes = {};
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
  async function shot(win, name, scene = name) {
    await wait(500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    (scenes[scene] ??= []).push({ file: `${name}.png`, bounds: win.getBounds() });
    done.push(name);
  }
  async function scene(name, fn) {
    try {
      await fn();
    } catch (err) {
      failed.push(`${name}: ${err.message}`);
      console.error(`✖ ${name}`, err);
    }
  }
  const ready = (win) => until(() => js(win, `document.documentElement.dataset.ready === 'true' && !!document.querySelector('.mk-doc')`), '메모 준비');
  async function open(id, bounds) {
    windowManager.openNote(id);
    const win = await until(() => noteWins.get(id)?.isVisible() && noteWins.get(id), '메모 창');
    if (bounds) win.setBounds(bounds);
    await ready(win);
    await wait(300);
    return win;
  }
  const close = async (id) => {
    noteWins.get(id)?.close();
    await until(() => !noteWins.has(id), '메모 창 닫힘').catch(() => {});
  };
  const mouse = (win, type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  async function drag(win, pts) {
    mouse(win, 'mouseMove', ...pts[0]);
    await wait(30);
    mouse(win, 'mouseDown', ...pts[0]);
    for (const p of pts.slice(1)) {
      mouse(win, 'mouseMove', ...p, { modifiers: ['leftButtonDown'] });
      await wait(14);
    }
    mouse(win, 'mouseUp', ...pts.at(-1));
    await wait(200);
  }
  // 손으로 그은 듯한 선: 점 사이를 촘촘히, 살짝 흔들리게
  const hand = (pts, step = 6) => pts.flatMap(([x, y], i) => {
    if (!i) return [[x, y]];
    const [px, py] = pts[i - 1];
    const n = Math.max(1, Math.round(Math.hypot(x - px, y - py) / step));
    return Array.from({ length: n }, (_, k) => [px + ((x - px) * (k + 1)) / n + Math.sin(k) * 0.6, py + ((y - py) * (k + 1)) / n + Math.cos(k) * 0.6]);
  });
  const ellipse = (cx, cy, rx, ry, turns = 1.08) => Array.from({ length: 48 }, (_, i) => {
    const a = -Math.PI * 0.75 + (i / 47) * Math.PI * 2 * turns;
    return [cx + Math.cos(a) * rx * (1 + i / 400), cy + Math.sin(a) * ry];
  });
  // 메모 창 안 글자의 화면 속 자리 (창 안 좌표)
  const textRect = (win, text) => js(win, `(() => {
    const walker = document.createTreeWalker(document.querySelector('.mk-doc'), NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const i = n.data.indexOf(${JSON.stringify(text)});
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + ${text.length});
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    return null;
  })()`);

  quietHints();
  let exitCode = 1;
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const area = screen.getPrimaryDisplay().workArea;
    const vault = getVault();
    const photo = (name) => vault.saveAttachment(fs.readFileSync(path.join(SAMPLE, `${name}.jpg`)), 'jpg');
    await seedTutorialSandbox(vault, toLocalIso, { photo });
    const find = (title) => vault.list().find((m) => m.title === title)?.id;
    vault.trash(find('연습 공간이에요')); // 튜토리얼 안내 메모는 빼고
    { // 튜토리얼 예시의 "예시 문서" 링크는 실제로 쓰는 듯한 공유 폴더로
      const file = path.join(VAULT, vault.get(find('출시 준비')).file);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('[예시 문서](https://example.com) 에', '[팀 공유 폴더](https://drive.google.com) 에 있어요'));
      await wait(600);
    }
    for (const m of WORK_MEMOS) {
      const at = toLocalIso(new Date(Date.now() - m.daysAgo * 86_400_000));
      vault.import({ body: m.body, color: m.color, mode: 'work', created: at, updated: at });
    }
    const idx = new FileIndex({ roots: () => [{ dir: FILES }] });
    idx.stopped = false;
    await idx.rebuild();
    useFileIndex(idx);

    // 바탕화면: 영역 캡처 장면에서 뒤에 깔리는 화면 (가상 화면은 까맣다)
    const wallpaper = new BrowserWindow({ ...area, frame: false, focusable: false, skipTaskbar: true, show: false, backgroundColor: '#dfe7ef' });
    await wallpaper.loadURL(`data:text/html,${encodeURIComponent('<body style="margin:0;height:100vh;background:linear-gradient(135deg,#e7eef6 0%,#f4efe4 55%,#efe2d6 100%)"></body>')}`);
    wallpaper.showInactive();

    const list = getList() ?? createListWindow();
    await until(() => js(list, `document.documentElement.dataset.ready === 'true'`), '목록');
    list.setBounds({ x: area.x + 40, y: area.y + 40, width: 460, height: 760 });
    await until(() => js(list, `document.querySelectorAll('.card').length >= 10`), '예시 메모 카드');
    await js(list, `window.memoking.settings.setMagic({ enabled: true, modules: { memo: true, notes: true, files: true, calc: true, web: true, ai: true, opms: false }, paused: {}, known: ['memo', 'notes', 'files', 'calc', 'web', 'ai', 'opms'] })`);
    await wait(800);

    // 1) Work / Life — 같은 목록, 일할 때와 일상
    await scene('worklife', async () => {
      await js(list, `window.memoking.mode.setWorkLife(true)`);
      await js(list, `window.memoking.mode.set('life')`);
      await wait(900);
      await shot(list, 'list-life', 'worklife');
      await js(list, `window.memoking.mode.set('work')`);
      await wait(1200);
      await shot(list, 'list-work', 'worklife');
      await js(list, `window.memoking.mode.set('life')`);
      await wait(900);
    });

    // 2) 회상 — 사진 달력과 그날의 기록
    await scene('recall', async () => {
      list.setBounds({ x: area.x + 40, y: area.y + 40, width: 620, height: 800 });
      await js(list, `document.querySelector('[data-tab="reminders"]').click()`);
      await wait(400);
      await js(list, `document.querySelector('[data-view="memories"]').click()`);
      await until(() => js(list, `document.querySelectorAll('.mem-day.has-photo img').length >= 3`), '회상 달력');
      await until(() => js(list, `[...document.querySelectorAll('.mem-day.has-photo img')].every((i) => i.complete && i.naturalWidth)`), '사진').catch(() => {});
      await shot(list, 'recall-month', 'recall');
      await js(list, `(document.querySelector('.mem-day.has-photo.many') ?? document.querySelector('.mem-day.has-photo')).click()`);
      await wait(1200);
      await shot(list, 'recall-day', 'recall');
      await js(list, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(400);
      await js(list, `document.querySelector('[data-tab="memos"]')?.click()`);
      list.setBounds({ x: area.x + 40, y: area.y + 40, width: 460, height: 760 });
      await wait(500);
    });

    // 3) 알림 보관함 — 지운 알림 · 카카오톡 알림 창도
    await scene('history', async () => {
      const history = getHistory();
      const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
      const add = (e) => history.add({ appId: `sns.${e.app}`, ...e });
      add({ source: 'windows', app: '쿠팡', title: '배송 완료', body: '주문하신 상품이 문 앞에 도착했어요', time: ago(210) });
      add({ source: 'popup', app: '카카오톡', title: '엄마', body: '주말에 김장하러 올 수 있니? 고무장갑 챙겨 와', time: ago(150), via: 'uia' });
      add({ source: 'windows', app: 'Outlook', title: '출시 준비 회의', body: '목요일 오후 3시, 3층 큰 회의실', time: ago(95) });
      add({ source: 'popup', app: '카카오톡', title: '김지민 (출시 준비)', body: '소개 글 초안 드라이브에 올렸어요. 금요일까지 봐 주세요', time: ago(42), via: 'uia' });
      add({ source: 'windows', app: 'Microsoft Teams', title: '박현우', body: '화면 사진 새로 찍어서 공유드렸습니다', time: ago(18) });
      add({ source: 'memoking', app: '메모킹', title: '주간 회의', body: '10분 뒤에 시작해요', time: ago(6) });
      await js(list, `document.querySelector('[data-tab="history"]').click()`);
      await until(() => js(list, `document.querySelectorAll('#history-rows .noti-title').length >= 6`), '보관함 목록');
      await shot(list, 'history', 'history');
      await js(list, `document.querySelector('[data-tab="memos"]')?.click()`);
      await wait(400);
    });

    // 4) 매직키 — 찾기 · 계산 · AI
    await scene('magic', async () => {
      const type = async (text) => {
        await js(getMagic(), `(() => { const i = document.getElementById('magic-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
        await wait(900);
      };
      showMagic();
      const magic = await until(() => getMagic(), '매직키 창');
      await until(() => js(magic, `!!document.getElementById('magic-input')`), '매직키 화면');
      await wait(600); // 계산기(math.js) 불러오기
      await type('회의');
      await until(() => js(magic, `document.querySelectorAll('.magic-row.kind-file').length >= 1`), '찾기 결과').catch(() => {});
      await shot(magic, 'magic-search', 'magic');
      await type('320,000 + 68,000 + 24,900');
      await until(() => js(magic, `!!document.querySelector('.magic-row.kind-calc')`), '계산 결과').catch(() => {});
      await shot(magic, 'magic-calc', 'magic');
      await type('제주 3박 4일 일정 짜 줘. 렌터카로 동쪽 해안 위주로');
      await js(magic, `document.querySelector('.magic-row.kind-ai')?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: 1 }))`);
      await shot(magic, 'magic-ai', 'magic');
      await js(magic, `(() => { const i = document.getElementById('magic-input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
      magic.hide();
      await wait(300);
    });

    // 5) 메모 단축키 — Ctrl+Alt+3 으로 자주 쓰는 문구를 어디서든 복사
    await scene('hotkey', async () => {
      const id = vault.import({ body: '# 회신 인사말\n\n안녕하세요, 메모 잘 받았습니다.\n확인하고 오늘 안에 다시 연락드릴게요. 감사합니다.\n', color: 'blue', mode: 'work' });
      memoHotkeys.set(id, '3', { copy: true, show: false });
      const win = await open(id, { x: area.x + 560, y: area.y + 120, width: 360, height: 300 });
      await shot(win, 'hotkey-note', 'hotkey');
      win.close();
      await until(() => !noteWins.has(id), '닫힘').catch(() => {});
      await memoHotkeys.onPress('3');
      const hud = await until(() => windowManager.hudWin?.isVisible() && windowManager.hudWin, '복사 말풍선', 3000).catch(() => null);
      if (hud) await shot(hud, 'hotkey-hud', 'hotkey');
      memoHotkeys.set(id, null);
    });

    // 6) 빠른 메모 — 워드에서 고른 글을 출처까지 메모로
    await scene('quick', async () => {
      const html = '<h2>하반기 마케팅 핵심</h2><ul><li><b>10월</b> 체험단 30명 모집, 후기 이벤트</li><li><b>11월</b> 블랙프라이데이 1+1 쿠폰</li><li><b>12월</b> 연말 감사 메일, 재구매 할인</li></ul><p>예산은 분기별로 나눠 쓰고, 결과는 매주 월요일 회의에서 공유</p>';
      const id = windowManager.openCaptureMemo({
        heading: null, html, text: '', items: [], skipped: [],
        source: { window: '2026 하반기 마케팅 계획.docx - Word', process: 'WINWORD', url: '', time: new Date().toISOString(), copied: true },
      }, { x: area.x + 620, y: area.y + 160 }, { title: '메모를 만들었어요', body: '' });
      const win = await until(() => noteWins.get(id), '빠른 메모 창');
      win.setBounds({ x: area.x + 600, y: area.y + 140, width: 380, height: 400 });
      win.showInactive();
      await until(() => js(win, `/출처/.test(document.querySelector('.mk-doc')?.textContent ?? '')`), '빠른 메모 내용');
      await shot(win, 'quick-memo', 'quick');
      await close(id);
    });

    // 7) 메모 스택 — 서류철 색인 탭처럼 한 창에
    await scene('stack', async () => {
      const a = find('주간 회의');
      const b = find('출시 준비');
      const c = find('이번 달 생활비');
      const bounds = { x: area.x + 560, y: area.y + 100, width: 400, height: 420 };
      await open(a, bounds);
      await open(b, { ...bounds, x: bounds.x + 60 });
      await open(c, { ...bounds, x: bounds.x + 120 });
      windowManager.stackInto(a, b);
      await wait(900);
      windowManager.stackInto(a, c);
      await wait(1200);
      const w = noteWins.get(c) ?? noteWins.get(a);
      await until(() => js(w, `document.querySelectorAll('.stack-tab, [data-stack-tab]').length >= 3 || true`), '탭');
      await shot(w, 'stack', 'stack');
      for (const id of [a, b, c]) await close(id);
    });

    // 8) 왕관 · 테이프 — 늘 위에, 바탕화면에
    await scene('stickers', async () => {
      const top = find('제주 여행 준비');
      const tw = await open(top, { x: area.x + 560, y: area.y + 140, width: 340, height: 380 });
      await js(tw, `document.getElementById('top-btn').click()`);
      await until(() => windowManager.stickers.get(tw.id)?.win?.isVisible(), '왕관 스티커');
      await wait(900);
      await shot(tw, 'crown-note', 'crown');
      await shot(windowManager.stickers.get(tw.id).win, 'crown-sticker', 'crown');
      const bottom = find('운동 기록');
      const bw = await open(bottom, { x: area.x + 960, y: area.y + 200, width: 320, height: 340 });
      await js(bw, `document.getElementById('tape-btn').click()`);
      await until(() => windowManager.stickers.get(bw.id)?.kind === 'tape' && windowManager.stickers.get(bw.id)?.win?.isVisible(), '테이프');
      await wait(900);
      await shot(bw, 'tape-note', 'tape');
      await shot(windowManager.stickers.get(bw.id).win, 'tape-sticker', 'tape');
      // 영역 캡처 장면을 위해 떼어 둔다 (가상 화면에는 투명 창을 합쳐 주는 프로그램이 없어 스티커 자리가 까맣게 찍힌다)
      windowManager.setNoteLayer(top, null);
      windowManager.setNoteLayer(bottom, null);
      scenes.areaTarget = tw.getBounds();
      await close(bottom);
      await wait(600);
      for (const b of windowManager.statusBubbles?.byOwner?.values() ?? []) if (b.win && !b.win.isDestroyed()) b.win.hide(); // "뗐어요" 말풍선도 투명 창이라
      await wait(300);
    });

    // 9) 영역 캡처 — 화면이 어두워지고 끌어서 고르기 (메모 창들이 떠 있는 바탕화면 그대로)
    await scene('area', async () => {
      list.showInactive();
      await wait(600);
      const started = await windowManager.startAreaCapture({ show: true });
      if (!started) throw new Error('영역 캡처를 시작하지 못함');
      const cw = await until(() => windowManager.areaCapture?.wins?.[0], '캡처 창');
      await until(() => js(cw, `!!document.querySelector('img, canvas, #shot')`), '캡처 화면', 5000).catch(() => {});
      await wait(800);
      // 왕관을 붙였던 제주 여행 메모를 끌어서 고른다
      const t = scenes.areaTarget ?? { x: 560, y: 140, width: 340, height: 380 };
      const o = cw.getBounds();
      const from = [t.x - o.x - 10, t.y - o.y - 10];
      const to = [t.x - o.x + t.width + 10, t.y - o.y + t.height + 10];
      mouse(cw, 'mouseMove', ...from);
      mouse(cw, 'mouseDown', ...from);
      for (let i = 1; i <= 12; i++) {
        mouse(cw, 'mouseMove', from[0] + ((to[0] - from[0]) * i) / 12, from[1] + ((to[1] - from[1]) * i) / 12, { modifiers: ['leftButtonDown'] });
        await wait(30);
      }
      await wait(400);
      await shot(cw, 'area-capture', 'area');
      windowManager.endAreaCapture();
    });

    // 10) 손 메모 · 주석 — 표 위에 펜으로 동그라미와 화살표
    await scene('ink', async () => {
      const id = find('출시 준비');
      const win = await open(id, { x: area.x + 560, y: area.y + 100, width: 420, height: 440 });
      await js(win, `document.getElementById('add-btn').click()`);
      await wait(300);
      await js(win, `document.querySelector('#add-menu [data-add="annotate"]').click()`);
      await until(() => js(win, `!!document.querySelector('.mk-annot.drawing')`), '주석 모드');
      const fri = await textRect(win, '금요일');
      if (fri) await drag(win, hand(ellipse(fri.x + fri.w / 2, fri.y + fri.h / 2, fri.w * 0.85, fri.h * 0.95)));
      const cmd = await textRect(win, 'npm test');
      if (cmd) {
        await drag(win, hand([[cmd.x - 4, cmd.y + cmd.h + 3], [cmd.x + cmd.w * 0.5, cmd.y + cmd.h + 5], [cmd.x + cmd.w + 4, cmd.y + cmd.h + 2]]));
        await drag(win, hand([[cmd.x + cmd.w + 70, cmd.y - 34], [cmd.x + cmd.w + 30, cmd.y - 12], [cmd.x + cmd.w + 8, cmd.y + 2]]));
        await drag(win, hand([[cmd.x + cmd.w + 8, cmd.y + 2], [cmd.x + cmd.w + 22, cmd.y - 2]]));
        await drag(win, hand([[cmd.x + cmd.w + 8, cmd.y + 2], [cmd.x + cmd.w + 10, cmd.y - 13]]));
      }
      await wait(300);
      await js(win, `document.querySelector('.mk-annot-bar .ink-done')?.click()`);
      await wait(800);
      await shot(win, 'annotate', 'ink');
      await close(id);
    });

    // 11) 드라이브의 파일 + AI 연결 — 설정의 AI 비서와 연결
    await scene('ai', async () => {
      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-claude-'));
      process.env.MEMOKING_CLAUDE_CONFIG = path.join(cfgDir, 'claude_desktop_config.json');
      fs.writeFileSync(process.env.MEMOKING_CLAUDE_CONFIG, '{}');
      list.setBounds({ x: area.x + 40, y: area.y + 40, width: 460, height: 760 });
      await js(list, `document.getElementById('settings-btn').click()`);
      await wait(500);
      await js(list, `document.getElementById('mcp-connect').click()`);
      await until(() => js(list, `/연결됨/.test(document.getElementById('mcp-title').textContent)`), 'Claude 연결').catch(() => {});
      await js(list, `document.getElementById('set-ai').scrollIntoView({ block: 'start' })`);
      await wait(500);
      await shot(list, 'ai-settings', 'ai');
      await js(list, `document.getElementById('ai-drive-guide').click()`);
      await wait(900);
      await shot(list, 'ai-drive-guide', 'ai');
      fs.writeFileSync(path.join(OUT, 'vault-files.json'), JSON.stringify(fs.readdirSync(VAULT).filter((f) => f.endsWith('.md')).sort()));
    });

    fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(scenes, null, 2));
    exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('✖ SNS 화면 찍기 오류', err);
  }
  console.log(`찍은 화면 ${done.length}장: ${done.join(', ')}`);
  for (const f of failed) console.log(`✖ ${f}`);
  console.log(exitCode ? 'SNS 화면 찍기 일부 실패' : 'SNS 화면 찍기 완료');
  app.exit(exitCode);
}
