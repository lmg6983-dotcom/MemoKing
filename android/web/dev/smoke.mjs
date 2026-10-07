// 휴대폰 화면 자동 점검 — 미리보기 서버를 띄우고 휴대폰 크기 크로미움으로 사용자처럼 조작한 뒤,
// 메모 폴더에 실제로 쓰인 파일(데스크탑과 같은 형식인지)을 확인한다. 캡처는 out/android/.
//   npm run android:smoke            (Playwright 필요: npm i -D playwright 또는 전역 설치)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.join(repo, 'out', process.env.MK_DARK ? 'android-dark' : 'android');
const port = 8799;
const base = `http://localhost:${port}`;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs'));
  } catch {
    console.error('Playwright 가 필요해요: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

// ---------- 시험용 메모 폴더 (데스크탑 메모킹이 만든 것과 같은 모양) ----------

// 지난 점검이 남긴 가짜 Drive 폴더는 지우고 시작 (남아 있으면 메모 수가 달라진다)
for (const d of fs.readdirSync(os.tmpdir())) if (d.startsWith('memoking-dev-drive-')) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-android-smoke-'));
fs.mkdirSync(path.join(vault, 'attachments'));
fs.copyFileSync(path.join(repo, 'assets/icons/icon-256.png'), path.join(vault, 'attachments/20261001-090000-ab12.png'));
const write = (name, text) => fs.writeFileSync(path.join(vault, name), text);
const read = (name) => fs.readFileSync(path.join(vault, name), 'utf8');
const pastIso = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, '+00:00');
write('회의 메모.md', `---
id: 00000000-0000-4000-8000-000000000001
created: 2026-10-01T09:00:00+09:00
updated: 2026-10-02T18:20:00+09:00
color: blue
pinned: true
---
# 회의 메모

다음 주 출시 일정 정리 #업무 #회의

- [x] 디자인 시안 확인
- [ ] 안드로이드 버전 테스트

**중요**: 금요일까지 <mark>배포</mark>
`);
write('로고 사진.md', `---
id: 00000000-0000-4000-8000-000000000002
created: 2026-10-01T10:00:00+09:00
updated: 2026-10-01T10:00:00+09:00
color: pink
---
# 로고 사진

![로고](attachments/20261001-090000-ab12.png)

새 아이콘 시안이에요 #디자인
`);
write('아이디어.md', '# 아이디어\n\n머리말 없이 직접 만든 파일도 읽혀야 해요. #업무\n');
write('약 먹기.md', `---
id: 00000000-0000-4000-8000-000000000003
created: 2026-10-01T00:00:00+00:00
updated: 2026-10-01T00:00:00+00:00
color: purple
reminders:
  - id: rpill01
    kind: at
    at: ${pastIso}
    action: notify
    created: 2026-10-01T00:00:00+00:00
---
# 약 먹기

점심 먹고 30분 뒤
`);

// ---------- 서버 ----------

const server = spawn(process.execPath, [path.join(here, 'server.mjs'), vault, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.once('data', resolve));
// 다이얼 둘레 칸은 다이얼을 누르는 동안만 펼쳐진다 — 펼친 것으로 놓고 그 칸을 바로 누른다
const pickMode = async (page, m) => {
  await page.evaluate(() => document.querySelector('.mode-knob').classList.add('open'));
  await page.waitForTimeout(250);
  await page.tap(`.mode-knob .mk-stop-${m}`);
};
const devLog = async () => (await fetch(`${base}/dev/log`)).json();
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) });

// ---------- 점검 ----------

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const errors = [];
try {
  // MK_DARK=1: 다크 모드로 같은 점검 (화면 사진은 out/android-dark)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', colorScheme: process.env.MK_DARK ? 'dark' : 'light' });
  // 처음 실행 튜토리얼은 저절로 뜨지 않게 (아래에서 설정 › 사용법 둘러보기로 따로 점검)
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('memoking.tutorialDone', '1');
    } catch {
      // 없음
    }
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); if (process.env.MK_DUMP) console.log('PAGEERROR', e.stack); });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
  const back = () => page.evaluate(() => window.__mk.back());

  await page.goto(`${base}/m/index.html`);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForTimeout(500);
  await shot('01-list');
  check('목록: 메모 4개 카드', (await page.locator('.card').count()) === 4);
  check('목록: 고정한 메모가 맨 앞', (await page.locator('.col').first().locator('.card').first().getAttribute('data-id')) === '00000000-0000-4000-8000-000000000001');
  check('목록: 첨부 사진 썸네일', await page.locator('.card-thumb').first().evaluate((img) => img.complete && img.naturalWidth > 0));

  check('알림: 지난 알림이 울림 (알림 막대)', (await devLog()).log.some((l) => l.notify?.title === '약 먹기'));
  check('알림: 울린 기록을 메모 파일에', /last:/.test(read('약 먹기.md')) && /enabled: false/.test(read('약 먹기.md')));

  // 태그 필터
  await page.tap('.tag-chip[data-tag="업무"]');
  check('태그 줄: #업무 메모만', (await page.locator('.card').count()) === 2);
  await back();
  check('뒤로 가기: 필터 풀기', (await page.locator('.card').count()) === 4);

  // 검색
  await page.fill('#search', '아이콘');
  await page.waitForTimeout(250);
  check('검색: 본문 글자', (await page.locator('.card').count()) === 1);
  await page.fill('#search', '없는말쯤');
  await page.waitForTimeout(250);
  check('빈 결과: 안내와 풀기 단추', await page.isVisible('#empty .btn.primary'));
  await page.tap('#empty .btn.primary');
  await page.waitForTimeout(250);
  check('빈 결과: 풀면 다시 모두', (await page.locator('.card').count()) === 4 && (await page.inputValue('#search')) === '');
  check('카드: 사람이 말하듯 시각 · 미리 보기에 태그 반복 없음', !(await page.locator('.card[data-id="00000000-0000-4000-8000-000000000001"] .card-preview').textContent()).includes('#업무'));
  await back();

  // 메모 열고 고치기
  await page.tap('.card[data-id="00000000-0000-4000-8000-000000000001"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(300);
  await shot('02-note');
  check('메모: 하이라이트 표시', await page.locator('.mk-doc mark').count() === 1);
  await page.locator('.mk-doc p').last().tap();
  await page.keyboard.press('End');
  await page.keyboard.type(' 휴대폰에서 추가');
  await page.waitForTimeout(900);
  check('메모: 자동 저장', read('회의 메모.md').includes('휴대폰에서 추가'));
  check('메모: 머리말 유지 (색·고정)', /color: blue/.test(read('회의 메모.md')) && /pinned: true/.test(read('회의 메모.md')));

  // 색 바꾸기 (메뉴)
  await page.tap('#menu-btn');
  await page.tap('#swatches [data-color="green"]');
  check('메뉴: 색 바꾸기', /color: green/.test(read('회의 메모.md')));
  await back();

  // 알림 추가
  await page.tap('#bell-btn');
  await page.tap('.rem-submit');
  await page.waitForTimeout(300);
  check('알림 패널: 10분 타이머 추가', /kind: timer/.test(read('회의 메모.md')));
  check('알림: 시스템에 예약', (await devLog()).scheduled.some((s) => s.key.endsWith(read('회의 메모.md').match(/- id: (r\w+)\n\s+kind: timer/)?.[1] ?? '?')));
  await back();
  await back();
  await page.waitForTimeout(250); // 닫히는 움직임
  check('뒤로 가기: 메모 → 목록', await page.isHidden('#note-screen'));

  // 새 메모 → 제목이 파일 이름 (+ 를 누르면 위성 버튼: 음성 메모 · 글 메모)
  await page.tap('#fab');
  await page.waitForTimeout(250);
  check('+ 위성 버튼: 음성 메모 · 글 메모', await page.isVisible('[data-new="voice"]') && await page.isVisible('[data-new="text"]'));
  await shot('02b-fab');
  await page.tap('[data-new="text"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.keyboard.type('# 휴대폰 첫 메모');
  await page.keyboard.press('Enter');
  await page.keyboard.type('장보기 #생활');
  // 제목·점 목록·번호 목록·체크리스트는 한 줄에 하나만 (버튼도 하나만 눌려 보임)
  const lineStyle = () => page.$$eval('#format-bar [data-cmd].active', (bs) => bs.map((b) => b.dataset.cmd).filter((c) => ['bullet', 'ordered', 'task'].includes(c)).join(','));
  const styleName = () => page.textContent('#format-bar .style-name');
  const pickStyle = async (name) => {
    await page.click('#format-bar [data-action="style"]');
    await page.click(`#style-menu [data-style="${name}"]`);
  };
  const steps = [['bullet', 'bullet'], ['ordered', 'ordered'], ['task', 'task'], ['h1', ''], ['ordered', 'ordered'], ['h2', ''], ['task', 'task'], ['task', '']];
  let exclusive = true;
  for (const [cmd, want] of steps) {
    if (/^h\d$/.test(cmd)) await pickStyle(cmd);
    else await page.click(`#format-bar [data-cmd="${cmd}"]`);
    await page.waitForTimeout(120);
    if ((await lineStyle()) !== want) exclusive = false;
    if (/^h\d$/.test(cmd) && (await styleName()) !== `제목 ${cmd[1]}`) exclusive = false;
  }
  check('서식: 제목·목록·체크리스트 버튼은 하나만 눌림', exclusive);
  await page.waitForTimeout(800);
  await back();
  await page.waitForTimeout(300);
  check('새 메모: 제목으로 파일', fs.existsSync(path.join(vault, '휴대폰 첫 메모.md')));
  check('새 메모: 태그 줄에 #생활', (await page.locator('.tag-chip[data-tag="생활"]').count()) === 1);

  // 빈 새 메모는 파일을 만들지 않음
  const before = fs.readdirSync(vault).length;
  await page.tap('#fab');
  await page.tap('[data-new="text"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await back();
  await page.waitForTimeout(300);
  check('빈 메모: 파일을 남기지 않음', fs.readdirSync(vault).length === before);

  // 다른 앱에서 공유하기
  const png = fs.readFileSync(path.join(repo, 'assets/icons/icon-256.png')).toString('base64');
  await post('/dev/intent', { type: 'share', text: '좋은 문장\n둘째 줄', app: 'Chrome', files: [{ name: 'photo.png', mime: 'image/png', base64: png }] });
  await page.evaluate(() => window.__mk.emit('intent', null));
  await page.waitForTimeout(1200);
  await shot('03-share');
  const shared = fs.readdirSync(vault).find((f) => f.startsWith('좋은 문장'));
  const sharedText = shared ? read(shared) : '';
  check('공유하기: 새 메모', Boolean(shared));
  check('공유하기: 줄마다 문단', /좋은 문장\n\n둘째 줄/.test(sharedText), sharedText);
  check('공유하기: 사진을 첨부로', /!\[photo\]\(attachments\/\d{8}-\d{6}-[0-9a-f]{4}\.png\)/.test(sharedText));
  check('공유하기: 출처 한 줄', /> 출처: Chrome · /.test(sharedText));
  check('공유하기: 태그를 저절로 (내용 태그가 없으면 #공유)', /#공유(\s|$)/.test(sharedText), sharedText);

  // 파일 넣기 (키보드를 내린 상태 → 메모 끝에)
  await post('/dev/pick', [{ name: '보고서.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64') }]);
  await page.tap('#add-btn');
  await page.waitForTimeout(350);
  check('도구막대: + 를 누르면 위성 단추 6개 (음성 녹음·손 메모·사진·파일·표·수식) · 글 위에 그리기는 다이얼로', (await page.locator('#add-menu:not([hidden]) .add-sat').count()) === 6 && !(await page.locator('#add-menu [data-add="annotate"]').count()));
  check('도구막대: + 를 펼치면 키보드를 닫음', await page.evaluate(() => !document.querySelector('.ProseMirror').contains(document.activeElement)));
  await shot('19-add-menu');
  await page.tap('[data-add="file"]');
  await page.waitForTimeout(800);
  check('도구막대: 고르면 위성 단추가 접힘', await page.isHidden('#add-menu'));
  const withFile = read(shared);
  check('파일 넣기: 파일 칩 링크', /\n\[보고서\.pdf\]\(attachments\/[^)]+\.pdf\)\n?$/.test(withFile), withFile);
  await back();

  // 데스크탑과 같은 편집 기능: 체크리스트 끝내면 CLEAR 도장 · 꾹 눌러 끌어 줄 바꾸기 · 그림 줄 옮기기
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await page.tap('.card[data-id="00000000-0000-4000-8000-000000000001"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(300);
  check('체크리스트: 아직 남았으면 도장 없음', await page.isHidden('#note-screen .clear-stamp'));
  const todo = await page.locator('.mk-doc li[data-checked="false"]').first().boundingBox();
  await page.touchscreen.tap(todo.x - 10, todo.y + 10);
  await page.waitForTimeout(900);
  check('체크리스트: 체크하면 저장', /- \[x\] 안드로이드 버전 테스트/.test(read('회의 메모.md')), read('회의 메모.md'));
  check('체크리스트: 모두 끝내면 CLEAR 도장', await page.isVisible('#note-screen .clear-stamp'));
  await shot('05-clear');
  // 다루기 방식 다이얼: 글 고치기(기본)에서는 꾹 눌러도 옮기지 않는다(글자 고르기) → 옮기기로 돌린 뒤 끌기
  {
    const li = await page.locator('.mk-doc li[data-item-type="task"]').nth(1).boundingBox();
    await touch('touchStart', li.x + 60, li.y + li.height / 2);
    await page.waitForTimeout(700);
    const liftedInEdit = await page.locator('.mk-doc li.mk-lift').count();
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(200);
    await pickMode(page, 'move');
    await page.waitForTimeout(250);
    const knob = await page.evaluate(() => ({ mode: document.querySelector('.mode-knob').dataset.mode, im: document.querySelector('.mk-doc').getAttribute('inputmode'),
      bar: getComputedStyle(document.getElementById('move-bar')).display !== 'none', tools: getComputedStyle(document.getElementById('format-bar')).display, plus: getComputedStyle(document.getElementById('add-btn')).display }));
    check('다이얼: 글 고치기에서는 꾹 눌러도 옮기지 않음 · 옮기기로 돌리면 키보드 막고 도구막대·+ 대신 "옮기기 모드" 막대', !liftedInEdit && knob.mode === 'move' && knob.im === 'none' && knob.bar && knob.tools === 'none' && knob.plus === 'none', JSON.stringify({ liftedInEdit, knob }));
    await shot('05b-knob-move');
  }
  // 둘째 항목을 꾹 눌러 첫째 항목 가운데로 → 맞바꾸기
  const items = page.locator('.mk-doc li[data-item-type="task"]');
  const a = await items.nth(0).boundingBox();
  const b = await items.nth(1).boundingBox();
  await touch('touchStart', b.x + 40, b.y + b.height / 2);
  await page.waitForTimeout(550);
  check('줄 바꾸기: 꾹 누르면 들어 올림', (await page.locator('.mk-doc li.mk-lift').count()) === 1);
  check('줄 바꾸기: 옮기는 동안 키보드 막기', (await page.getAttribute('.mk-doc', 'inputmode')) === 'none' && !(await page.evaluate(() => document.querySelector('.mk-doc').contains(document.activeElement))));
  const scrollBefore = await page.evaluate(() => document.getElementById('editor').scrollTop);
  // 손가락이 편집 영역 아래 끝 밖(도구막대 쪽)으로 멀리 나가도 맨 아래로 휙 가지 않는다
  await touch('touchMove', b.x + 40, 840);
  await page.waitForTimeout(300);
  const scrollAfter = await page.evaluate(() => document.getElementById('editor').scrollTop);
  check('줄 바꾸기: 아래 끝 밖으로 나가도 자동 스크롤 속도 상한', scrollAfter - scrollBefore <= 14 * 12, String(scrollAfter - scrollBefore));
  await touch('touchMove', b.x + 40, b.y + b.height / 2);
  for (let i = 1; i <= 6; i++) await touch('touchMove', b.x + 40, b.y + b.height / 2 - ((b.y - a.y) * i) / 6);
  await page.waitForTimeout(100);
  {
    // 목록도 그림·글 줄과 같은 틀: 놓을 자리에 점선 칸(노란 선 아님), 안내 캡슐은 맞바꿀 항목 틀의 오른쪽
    const st = await page.evaluate(() => {
      const box = (el) => el && el.getBoundingClientRect();
      const t = box(document.querySelector('.mk-doc li.mk-swap-target'));
      const b = document.querySelector('.mk-drag-badge:not([hidden])');
      const bb = box(b);
      return { slot: Boolean(document.querySelector('.mk-drop-slot:not([hidden])')), line: document.querySelectorAll('.mk-drop-line').length, side: b?.dataset.side, right: t && bb ? bb.left + bb.width / 2 > t.left + t.width / 2 : false };
    });
    check('목록 옮기기: 그림 줄과 같은 틀 (놓을 자리 점선 칸 · 캡슐은 틀 오른쪽)', st.slot && st.line === 0 && st.right && Boolean(st.side), JSON.stringify(st));
  }
  await shot('05b-drag');
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(900);
  const body = read('회의 메모.md');
  check('줄 바꾸기: 손가락으로 끌어 맞바꿈', body.indexOf('안드로이드 버전 테스트') < body.indexOf('디자인 시안 확인'), body);
  // 두 손가락으로 벌리면 본문 확대
  const pinchTo = async (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 600, id: 1 }, { x: 240, y: 600, id: 2 }] });
  for (let i = 1; i <= 5; i++) await pinchTo([{ x: 150 - i * 15, y: 600, id: 1 }, { x: 240 + i * 15, y: 600, id: 2 }]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const z = await page.evaluate(() => Number(document.getElementById('editor').style.getPropertyValue('--note-zoom')));
  check('두 손가락 확대: 본문 배율', z > 1.3, String(z));
  await page.waitForTimeout(200);
  const zoomed = await page.evaluate(() => { const ed = document.getElementById('editor'); const doc = ed.firstElementChild; return { wide: ed.scrollWidth > ed.clientWidth + 20, w: doc.getBoundingClientRect().width, base: parseFloat(ed.style.getPropertyValue('--note-base-w')) }; });
  if (process.env.MK_DUMP_ZOOM) console.log('ZOOMDBG', await page.evaluate(() => { const ed = document.getElementById('editor'); const doc = ed.querySelector('.mk-doc'); const cs = getComputedStyle(doc); return JSON.stringify({ zoom: cs.zoom, width: cs.width, edZoom: ed.style.cssText, cw: ed.clientWidth, sw: ed.scrollWidth, ow: doc.offsetWidth, rect: doc.getBoundingClientRect().width }); }));
  check('페이지째 확대: 본문 전체가 같은 비율로 커지고 옆으로 밀어 보기', zoomed.wide && Math.abs(zoomed.w / zoomed.base - z) < 0.05, JSON.stringify(zoomed));
  await shot('05d-zoom');
  // 두 손가락을 오므려 다시 100% 로
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 40, y: 600, id: 1 }, { x: 340, y: 600, id: 2 }] });
  const half = 150 / z; // 벌린 만큼 그대로 오므리기
  for (let i = 1; i <= 8; i++) { const h = 150 + ((half - 150) * i) / 8; await pinchTo([{ x: 190 - h, y: 600, id: 1 }, { x: 190 + h, y: 600, id: 2 }]); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
  const back1 = await page.evaluate(() => ({ z: document.getElementById('editor').style.getPropertyValue('--note-zoom'), saved: localStorage.getItem('memoking.noteZoom') }));
  check('두 손가락 오므리기: 다시 100%', back1.z === '1' && back1.saved == null, JSON.stringify(back1));
  // 매직 줌: 100% 아래로 오므리면 글자 크기만 줄고 줄이 화면 폭에 다시 맞춰진다 (옆으로 밀 일 없음)
  const h1Before = await page.evaluate(() => document.querySelector('.mk-doc h1').getBoundingClientRect().height);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: 600, id: 1 }, { x: 290, y: 600, id: 2 }] });
  for (let i = 1; i <= 6; i++) await pinchTo([{ x: 90 + i * 5, y: 600, id: 1 }, { x: 290 - i * 5, y: 600, id: 2 }]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
  const out = await page.evaluate(() => { const ed = document.getElementById('editor'); const box = ed.firstElementChild; return { z: Number(ed.style.getPropertyValue('--note-zoom')), wide: ed.scrollWidth > ed.clientWidth + 2, visW: box.getBoundingClientRect().width, cw: ed.clientWidth, h1: document.querySelector('.mk-doc h1').getBoundingClientRect().height, status: document.querySelector('#note-status, .note-status')?.textContent ?? '' }; });
  check('매직 줌: 100% 아래는 글자만 작게 · 줄은 화면 폭에 다시 맞춤', out.z < 1 && !out.wide && out.visW > out.cw * 0.85 && out.h1 < h1Before, JSON.stringify({ ...out, h1Before }));
  await shot('05e-magic-zoom-out');
  {
    const zz = out.z;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 140, y: 600, id: 1 }, { x: 240, y: 600, id: 2 }] });
    for (let i = 1; i <= 6; i++) { const h = 50 + ((50 / zz - 50) * i) / 6; await pinchTo([{ x: 190 - h, y: 600, id: 1 }, { x: 190 + h, y: 600, id: 2 }]); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
  }
  check('매직 줌: 다시 벌려 100%', (await page.evaluate(() => document.getElementById('editor').style.getPropertyValue('--note-zoom'))) === '1');
  await back();
  await page.waitForTimeout(300);
  check('목록: 다 끝낸 메모 카드에 CLEAR 도장', (await page.locator('.card[data-id="00000000-0000-4000-8000-000000000001"] .card-clear').count()) === 1);
  await shot('05c-list-clear');

  // 그림·파일 줄 옮기기: 버튼 없이 내용 자체를 꾹 눌러 끈다
  await page.tap('.card[data-id="00000000-0000-4000-8000-000000000002"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(400);
  await page.locator('.mk-doc img.mk-image').first().tap();
  await page.waitForTimeout(200);
  check('그림 줄 옮기기: 처음 한 번 옮기는 방법 안내 (옮기기 방식: 짧게 눌러)', (await page.textContent('.mk-move-hint').catch(() => '')).includes('짧게 눌러'));
  check('그림 누르기: 키보드를 올리지 않음', (await page.getAttribute('.mk-doc', 'inputmode')) === 'none');
  await shot('06-move-hint');
  check('그림 줄 옮기기: 따로 버튼·손잡이 없음', (await page.locator('.mk-move-bar, .mk-move-grip').count()) === 0);
  const img = await page.locator('.mk-doc img.mk-image').first().boundingBox();
  const textLine = await page.locator('.mk-doc p', { hasText: '새 아이콘 시안' }).boundingBox();
  // 꾹 누르기 전에 밀면 스크롤 (옮기지 않음)
  await touch('touchStart', img.x + 60, img.y + 60);
  await touch('touchMove', img.x + 60, img.y + 120);
  await page.waitForTimeout(500);
  check('그림 줄 옮기기: 그냥 밀면 들어 올리지 않음', (await page.locator('.mk-block-lift').count()) === 0);
  await touch('touchEnd', 0, 0);
  // 꾹 눌러 들어 올려 아래 글 줄 가운데로 → 맞바꾸기
  await touch('touchStart', img.x + 60, img.y + 60);
  await page.waitForTimeout(120); // 옮기기 방식은 짧게(0.18초) 누르면 들어 올림
  check('그림 줄 옮기기: 누르는 동안 테두리', (await page.locator('.mk-block-pressing').count()) === 1);
  await page.waitForTimeout(350);
  check('그림 줄 옮기기: 꾹 누르면 들어 올림', (await page.locator('.mk-block-lift').count()) === 1);
  check('그림 끌기: 키보드를 올리지 않음', (await page.getAttribute('.mk-doc', 'inputmode')) === 'none');
  // 옮기는 동안은 모든 줄이 짧게 접힌다 → 한 칸 옮기는 데 손가락을 조금만
  const liftBox = await page.locator('.mk-doc .mk-block-lift').boundingBox();
  check('옮기는 동안 접기: 들어 올린 그림도 짧게 (96px 이하)', liftBox.height <= 98 && (await page.locator('.mk-block-compact-item').count()) >= 2, JSON.stringify(liftBox));
  {
    // 사진과 틀이 딱 맞는다: 접힌 사진 = 줄 상자, 틀은 사진에서 4px 띄워 2px 선 (사방 6px)
    const fit = await page.evaluate(() => {
      const img = document.querySelector('.mk-block-lift img.mk-image').getBoundingClientRect();
      const line = document.querySelector('.mk-block-lift').getBoundingClientRect();
      const f = document.querySelector('.mk-drag-frame.lift').getBoundingClientRect();
      return { img: [img.width, img.height], line: [line.width, line.height], d: [img.left - f.left, f.right - img.right, img.top - f.top, f.bottom - img.bottom].map((v) => Math.round(v)) };
    });
    check('사진 틀: 사진에 딱 맞음 (사진 = 줄 상자 · 사방 6px)', Math.abs(fit.img[0] - fit.line[0]) <= 3 && fit.img[1] >= 80 && fit.d.every((v) => v >= 4 && v <= 8), JSON.stringify(fit));
  }
  await shot('06c-compact');
  // 손가락을 조금씩 움직여, 안내가 바뀌는 데 든 거리를 잰다 (보정: 어느 줄이든 약 40px 에 한 칸)
  const badgeText = () => page.evaluate(() => document.querySelector('.mk-drag-badge:not([hidden])')?.textContent ?? '');
  const creep = async (x, y0, dir, want, max = 120) => {
    for (let d = 4; d <= max; d += 4) {
      await touch('touchMove', x, y0 + dir * d);
      await page.waitForTimeout(40);
      if ((await badgeText()).includes(want)) return d;
    }
    return 0;
  };
  const f1 = await creep(img.x + 60, img.y + 60, 1, '맞바꾸기');
  const gain1 = Number(await page.evaluate(() => document.body.dataset.dragGain));
  check('손가락 입력 보정: 큰 사진 줄도 손가락 조금(60px 안)이면 옆 줄과 맞바꾸기', f1 > 0 && f1 <= 60 && gain1 > 1, JSON.stringify({ f1, gain1 }));
  await page.waitForTimeout(250);
  check('그림 줄 옮기기: 맞바꾸기 안내', (await page.textContent('.mk-drag-badge')).includes('맞바꾸기'));
  {
    // 안내 캡슐: 맞바꿀 줄 틀의 오른쪽에 붙고, 손가락에 가리지 않는다
    const fx = img.x + 60;
    const fy = img.y + 60 + f1;
    const st = await page.evaluate(() => {
      const b = document.querySelector('.mk-drag-badge:not([hidden])');
      const t = document.querySelector('.mk-drag-frame.target:not([hidden])');
      const bb = b.getBoundingClientRect();
      const tb = t?.getBoundingClientRect();
      return { side: b.dataset.side, bb: [bb.left, bb.top, bb.right, bb.bottom], tb: tb && [tb.left, tb.top, tb.right, tb.bottom] };
    });
    const [l, t, r, btm] = st.bb;
    const right = st.tb && (st.side === 'right' ? l >= st.tb[2] && t < st.tb[3] && btm > st.tb[1] : st.side === 'corner' && r <= st.tb[2] + 1 && Math.abs((t + btm) / 2 - st.tb[1]) < 4);
    const covered = fx > l - 20 && fx < r + 20 && fy > t - 20 && fy < btm + 30;
    check('안내 캡슐: 맞바꿀 틀 오른쪽에 · 손가락에 가리지 않음', right && !covered, JSON.stringify({ ...st, fx, fy }));
  }
  check('그림 줄 옮기기: 맞바꿀 줄에 보라 점선 틀 · 놓으면 갈 자리에 점선 칸', (await page.locator('.mk-block-swap-target').count()) === 1 && await page.isVisible('.mk-drag-frame.target') && await page.isVisible('.mk-drop-slot'));
  await shot('06b-move-drag');
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(900);
  let logo = read('로고 사진.md');
  check('그림 줄 옮기기: 글 줄과 맞바꿈', logo.indexOf('새 아이콘 시안') < logo.indexOf('![로고]'), logo);
  // 다시 꾹 눌러 제목과 글 줄 사이로 → 끼우기
  const img2 = await page.locator('.mk-doc img.mk-image').first().boundingBox();
  const text2 = await page.locator('.mk-doc p', { hasText: '새 아이콘 시안' }).boundingBox();
  await touch('touchStart', img2.x + 60, img2.y + 60);
  await page.waitForTimeout(550);
  {
    const f2 = await creep(img2.x + 60, img2.y + 60, -1, '넣기');
    check('손가락 입력 보정: 위로도 조금(70px 안)이면 두 줄 위 사이에', f2 > 0 && f2 <= 70, String(f2));
  }
  await page.waitForTimeout(250);
  check('그림 줄 옮기기: 끼우기 안내', (await page.textContent('.mk-drag-badge')).includes('넣기'));
  {
    const slotBox = await page.locator('.mk-drop-slot').boundingBox();
    check('그림 줄 옮기기: 끼울 자리에 점선 칸', Boolean(slotBox) && slotBox.height > 20, JSON.stringify(slotBox));
    await shot('06d-drop-slot');
  }
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(900);
  logo = read('로고 사진.md');
  const order = ['# 로고 사진', '![로고]', '새 아이콘 시안'].map((t) => logo.indexOf(t));
  check('그림 줄 옮기기: 제목 바로 아래로 끼움', order[0] < order[1] && order[1] < order[2], logo);
  await page.locator('.mk-doc p', { hasText: '새 아이콘 시안' }).tap();
  await page.waitForTimeout(400);
  const tapEdit = await page.evaluate(() => ({ mode: document.querySelector('.mode-knob').dataset.mode, im: document.querySelector('.mk-doc').getAttribute('inputmode'),
    focus: document.querySelector('.mk-doc').contains(document.activeElement) || document.activeElement === document.querySelector('.mk-doc'),
    guide: !document.getElementById('mode-guide').hidden && document.getElementById('mode-guide').textContent }));
  check('옮기기 방식: 글자를 톡 누르면 글 고치기로 · 그 자리에 커서와 키보드 · 아래에 안내', tapEdit.mode === 'edit' && tapEdit.im === null && tapEdit.focus && /글 고치기로/.test(tapEdit.guide), JSON.stringify(tapEdit));
  await shot('06e-tap-to-edit');
  await page.tap('.mode-knob .mk-dial'); // 글 고치기 → 옮기기 (누르면 다음 방식)
  await page.waitForTimeout(300);
  const nextMove = await page.getAttribute('.mode-knob', 'data-mode');
  await pickMode(page, 'draw'); // 둘레 칸 = 그 방식으로 바로
  await page.waitForTimeout(400);
  const drawOn = await page.evaluate(() => ({ on: document.body.classList.contains('annotating'), done: document.querySelectorAll('.mk-annot-bar .ink-done').length }));
  await pickMode(page, 'edit'); // 그리기는 다이얼로 끝낸다 (완료 단추 없음)
  await page.waitForTimeout(300);
  const editBack = await page.evaluate(() => ({ mode: document.querySelector('.mode-knob').dataset.mode, annot: document.body.classList.contains('annotating'), im: document.querySelector('.mk-doc').getAttribute('inputmode'), focus: document.querySelector('.mk-doc').contains(document.activeElement) || document.activeElement === document.querySelector('.mk-doc') }));
  check('다이얼: 누르면 다음 방식 · 둘레 칸은 바로 · 그리기는 완료 단추 없이 다이얼로 끝 · 글 고치기로 돌리면 키보드와 커서', nextMove === 'move' && drawOn.on && drawOn.done === 0 && editBack.mode === 'edit' && !editBack.annot && editBack.im === null && editBack.focus, JSON.stringify({ nextMove, drawOn, editBack }));
  await back();
  await page.waitForTimeout(300);

  await page.dispatchEvent('.card[data-id="00000000-0000-4000-8000-000000000002"]', 'contextmenu');
  await page.tap('[data-memo-action="delete"]');
  await page.waitForTimeout(500);
  check('지우기: 묻지 않음', !(await page.evaluate(() => document.getElementById('confirm-dialog').open)));
  check('지우기: 되돌리기 버튼', await page.isVisible('#toast-action'));
  check('지우기: 휴지통으로', !fs.existsSync(path.join(vault, '로고 사진.md')) && fs.readdirSync(path.join(vault, '_memoking/trash')).some((f) => f.startsWith('로고 사진 (')));
  check('지우기: 그 메모만 쓰던 첨부도 휴지통으로', fs.existsSync(path.join(vault, '_memoking/trash/attachments/20261001-090000-ab12.png')));
  await page.tap('#settings-btn');
  await page.locator('#rec-stt').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  check('설정: 받아쓰기는 Google 음성 인식 하나 (방식 고르기·데이터 받기 없음)', (await page.locator('#stt-engine, #stt-model-row').count()) === 0 && (await page.textContent('#rec-stt-note')).includes('Google'));
  await shot('17-settings-stt');
  check('설정: 화자 구분 줄 (처음엔 다운로드)', await page.isVisible('#spk-row') && (await page.textContent('#spk-btn')) === '다운로드' && (await page.textContent('#spk-note')).includes('화자 1·2'));
  await page.tap('#spk-btn');
  await page.waitForTimeout(300);
  check('설정: 화자 구분 받으면 켜짐 → 끄기 단추', (await page.textContent('#spk-btn')) === '끄기' && (await page.textContent('#spk-note')).includes('사용 중'));
  await page.tap('#spk-btn');
  await page.waitForTimeout(300);
  check('설정: 화자 구분 끄기 → 켜기 단추', (await page.textContent('#spk-btn')) === '켜기');
  await page.tap('#trash-btn');
  await page.waitForTimeout(200);
  await shot('04-trash');
  await page.tap('.trash-item .btn');
  await page.waitForTimeout(300);
  check('휴지통: 되살리기 (첨부도)', fs.existsSync(path.join(vault, '로고 사진.md')) && fs.existsSync(path.join(vault, 'attachments/20261001-090000-ab12.png')));
  await back();
  await back();

  // 다른 기기(PC)에서 고친 내용 반영
  await page.tap('.card[data-id="00000000-0000-4000-8000-000000000003"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  write('약 먹기.md', read('약 먹기.md').replace('점심 먹고 30분 뒤', 'PC에서 고친 내용'));
  await page.waitForTimeout(4800);
  check('동기화: 열린 메모에 PC 변경 반영', (await page.textContent('#editor')).includes('PC에서 고친 내용'));
  // 쓰는 중에 PC 에서도 고침 (자동 저장보다 먼저 파일이 바뀜): 내 글은 이 메모에, PC 쪽 내용은 사본 메모로 — 둘 다 남는다
  await page.locator('.mk-doc p', { hasText: 'PC에서 고친 내용' }).tap();
  await page.keyboard.press('End');
  await page.keyboard.type(' 휴대폰 글');
  write('약 먹기.md', read('약 먹기.md').replace('PC에서 고친 내용', 'PC에서 또 고친 내용'));
  await page.waitForTimeout(1500);
  {
    const copyName = fs.readdirSync(vault).find((f) => f.endsWith('.md') && f.includes('다른 기기'));
    const copyText = copyName ? read(copyName) : '';
    check('동시 수정: 내 글은 이 메모에 저장', read('약 먹기.md').includes('휴대폰 글'), read('약 먹기.md'));
    check('동시 수정: PC 에서 고친 내용은 "(다른 기기 …)" 사본 메모로', copyText.includes('PC에서 또 고친 내용') && /^# 약 먹기 \(다른 기기 /m.test(copyText), `${copyName}\n${copyText}`);
    if (copyName) fs.rmSync(path.join(vault, copyName)); // 뒤 점검(메모 수)에 끼지 않게
  }
  await back();

  // LLM 인덱스
  const index = JSON.parse(read('_memoking/index.json'));
  check('LLM 인덱스: 모든 메모', index.memos.length === fs.readdirSync(vault).filter((f) => f.endsWith('.md')).length);
  check('LLM 인덱스: 안내서', fs.existsSync(path.join(vault, '_memoking/README.md')));

  // 알림 보관함: 탭 → 보관 시작하기 → (설정에서 알림 접근 허용) → 모은 알림
  const thumbAt = () => page.evaluate(() => { const t = document.querySelector('.tabs > .seg-thumb'); const b = document.querySelector('.tabs [aria-selected="true"]'); return t && b && Math.round(new DOMMatrix(getComputedStyle(t).transform).m41) === b.offsetLeft ? b.dataset.tab : null; });
  check('탭: 선택 표시가 있는 칸에', (await thumbAt()) === 'memos');
  await page.tap('[data-tab="history"]');
  await page.waitForTimeout(400);
  check('탭: 고르면 선택 표시가 그 칸으로 미끄러짐', (await thumbAt()) === 'history');
  check('보관함: 처음엔 안내', await page.isVisible('#history-consent'));
  await page.tap('#history-enable');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(300);
  check('보관함: 모은 알림 4개', (await page.locator('.noti').count()) === 4);
  await page.fill('#search', '회의');
  await page.waitForTimeout(300);
  check('보관함: 검색', (await page.locator('.noti').count()) === 1);
  await page.locator('.noti').first().tap();
  await shot('07-history');
  await page.locator('.noti.expanded [aria-label="메모로 만들기"]').tap();
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  check('보관함: 알림으로 메모 만들기', fs.readdirSync(vault).some((f) => f.startsWith('회의 일정 안내')));
  await back();
  await page.waitForTimeout(300);
  await page.fill('#search', '');
  await page.waitForTimeout(300);
  await page.locator('.noti').nth(0).tap();
  await page.locator('.noti').nth(1).tap();
  check('보관함: 펼친 알림은 하나만', (await page.locator('.noti.expanded').count()) === 1);
  await page.locator('.noti').nth(1).tap(); // 다시 누르면 접힘
  check('보관함: 다시 누르면 접힘', (await page.locator('.noti.expanded').count()) === 0);
  // 이 앱 알림 그만 모으기 (카카오톡, 이미 모은 2개도 지우기)
  await page.locator('.noti', { hasText: '카카오톡' }).first().tap();
  await page.locator('.noti.expanded [aria-label="카카오톡 알림 그만 모으기"]').tap();
  await page.click('#confirm-ok'); // 그만 모으기
  await page.waitForTimeout(250);
  await page.click('#confirm-ok'); // 이미 모은 것도 지우기
  await page.waitForTimeout(300);
  check('보관함: 앱 차단 + 이미 모은 것 지움', (await page.locator('.noti', { hasText: '카카오톡' }).count()) === 0);
  await page.tap('#history-apps');
  await page.waitForTimeout(250);
  await shot('08-history-apps');
  const kakao = page.locator('.app-row', { hasText: '카카오톡' });
  check('모을 앱: 끈 앱이 꺼진 채로 보임', (await kakao.count()) === 1 && !(await kakao.locator('.switch').isChecked()));
  await kakao.locator('.switch').click();
  await page.waitForTimeout(200);
  check('모을 앱: 다시 켜기', (await devLog()).log !== undefined && Object.keys((await (await fetch(`${base}/native/sync`, { method: 'POST', body: JSON.stringify({ method: 'historyAll', args: [] }) })).json()).v.blocked).length === 0);
  await back();
  await back(); // 보관함 탭 → 메모 탭
  await page.waitForTimeout(200);

  // ---------- 0.6.0 ----------
  const newText = async () => {
    await page.tap('#fab');
    await page.tap('[data-new="text"]');
    await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  };
  const fileWith = (text) => fs.readdirSync(vault).find((f) => f.endsWith('.md') && read(f).includes(text));
  check('도구막대: H1·H2·태그·키보드·사진 버튼 없음', (await page.locator('#format-bar [data-cmd="h1"], #format-bar [data-cmd="h2"], #format-bar [data-action="tag"], #format-bar [data-action="done"], #format-bar [data-action="camera"]').count()) === 0);
  check('위 막대: 되돌리기·다시 하기', (await page.locator('#note-screen .bar #undo-btn, #note-screen .bar #redo-btn').count()) === 2);

  // 이어진 목록 하나를 바꾸면 통째로
  await newText();
  await page.keyboard.type('# 목록 바꾸기');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- 사과');
  await page.keyboard.press('Enter');
  await page.keyboard.type('배');
  await page.keyboard.press('Enter');
  await page.keyboard.type('감');
  await page.click('#format-bar [data-cmd="ordered"]');
  await page.waitForTimeout(900);
  let f = fileWith('목록 바꾸기');
  check('목록: 한 줄만 바꿔도 이어진 목록 전체가 번호 목록으로', f && /1\. 사과\n2\. 배\n3\. 감/.test(read(f)), f && read(f));
  await page.click('#format-bar [data-cmd="task"]');
  await page.waitForTimeout(900);
  check('목록: 체크리스트로도 통째로', /- \[ \] 사과\n- \[ \] 배\n- \[ \] 감/.test(read(f)), read(f));
  // 오른쪽으로 밀면 하위 항목
  const third = await page.locator('.mk-doc li').nth(2).boundingBox();
  await touch('touchStart', third.x + 30, third.y + third.height / 2);
  for (let i = 1; i <= 8; i++) await touch('touchMove', third.x + 30 + i * 12, third.y + third.height / 2);
  await page.waitForTimeout(80);
  check('밀기: 하위로 안내', (await page.textContent('.mk-drag-badge').catch(() => '')).includes('하위'));
  await shot('07-swipe');
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(900);
  check('밀기: 오른쪽 → 하위 항목', /- \[ \] 배\n\s+- \[ \] 감/.test(read(f)), read(f));
  const sub = await page.locator('.mk-doc li li').first().boundingBox();
  await touch('touchStart', sub.x + 30, sub.y + sub.height / 2);
  for (let i = 1; i <= 8; i++) await touch('touchMove', sub.x + 30 - i * 12, sub.y + sub.height / 2);
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(900);
  check('밀기: 왼쪽 → 상위 항목', /- \[ \] 배\n- \[ \] 감/.test(read(f)), read(f));
  // 커서 항목 테두리 (Enter 로 새 항목에 따라감)
  check('목록: 커서 항목 표시', (await page.locator('.mk-doc li.mk-caret-item').count()) === 1);

  // 수식
  await page.locator('.mk-doc > p').last().click();
  await page.keyboard.type('넓이 $\\pi r^2$ 끝');
  await page.waitForTimeout(1500);
  check('수식: $..$ 치면 수식으로 그려짐', (await page.locator('.mk-doc .mk-math .katex').count()) === 1);
  check('수식: 파일에는 $$..$$', read(f).includes('$$\\pi r^2$$'), read(f));
  await shot('08-math');

  // 보내기: 글은 목록 모양 그대로
  await page.tap('#menu-btn');
  await page.tap('[data-memo-action="share"]');
  await page.tap('[data-share="text"]');
  await page.waitForTimeout(300);
  const sent = (await devLog()).log.filter((l) => l.share).at(-1)?.share?.text ?? '';
  check('보내기 글: 체크 네모 그대로', sent.includes('☐ 사과') && sent.includes('☐ 감'), sent);
  await page.tap('#menu-btn');
  await page.tap('[data-memo-action="share"]');
  await page.tap('[data-share="image"]');
  await page.waitForTimeout(2500);
  const png2 = (await devLog()).log.filter((l) => l.shareFile).at(-1)?.shareFile;
  check("보내기 그림: PNG", png2?.mime === "image/png" && png2.bytes > 5000, JSON.stringify(png2));
  await page.tap('#menu-btn');
  await page.tap('[data-memo-action="share"]');
  await page.tap('[data-share="pdf"]');
  if (process.env.MK_PDF) {
    await page.pdf({ path: path.join(outDir, 'share.pdf'), format: 'A4' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.pdf({ path: path.join(outDir, 'share-dark.pdf'), format: 'A4' });
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await page.waitForTimeout(500);
  check('보내기 PDF', (await devLog()).log.some((l) => l.sharePdf));
  // 앱은 이 인쇄 전용 HTML 을 보이지 않는 WebView 에 띄워 PDF 로 쓴다 → 따로 띄워 PDF 로 찍어 글자가 들었는지
  const pdfHtml = (await devLog()).log.filter((l) => l.sharePdf).at(-1)?.sharePdf?.html ?? '';
  check('보내기 PDF: 인쇄 전용 문서 (본문·print.css)', pdfHtml.includes('print-page') && pdfHtml.includes('print.css') && pdfHtml.includes('사과'));
  {
    const pp = await ctx.newPage();
    await pp.goto(`${base}/m/index.html#print-test`).catch(() => {});
    await pp.setContent(pdfHtml, { waitUntil: 'load' });
    const pdfPath = path.join(outDir, 'share-print.pdf');
    await pp.pdf({ path: pdfPath, format: 'A4' });
    await pp.close();
    const { execFileSync } = await import('node:child_process');
    let text = '';
    try {
      text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
    } catch {
      text = '사과 (pdftotext 없음)';
    }
    check('보내기 PDF: 글자가 그대로 들어감', text.includes('사과') && text.includes('목록 바꾸기'), text.slice(0, 200));
  }
  await back();
  await page.waitForTimeout(300);

  // 추천 태그: 태그 없는 메모에 쓰는 태그(#업무) 이름이 나오면
  await newText();
  await page.keyboard.type('# 다음 주 업무 정리');
  await page.keyboard.press('Enter');
  await page.keyboard.type('업무 일정과 출시 계획을 정리해요');
  await page.waitForTimeout(2200);
  check('추천 태그: #업무', (await page.locator('#tag-suggest-chips .tag-chip', { hasText: '업무' }).count()) === 1);
  await shot('09-tag-suggest');
  await page.tap('#links-btn');
  await page.waitForTimeout(200);
  check('연결: 태그 없으면 추천 태그로 이어 주기', (await page.locator('#links-tag-suggest .tag-chip').count()) > 0);
  await page.locator('#links-tag-suggest .tag-chip', { hasText: '업무' }).tap();
  await page.waitForTimeout(400);
  check('연결: 태그로 이어진 메모', (await page.locator('#links-tags .link-item').count()) >= 1);
  await shot('10-links');
  await back();
  await page.waitForTimeout(900);
  check('추천 태그: 누르면 본문에 #업무', read(fileWith('다음 주 업무 정리')).includes('#업무'));
  await back();
  await page.waitForTimeout(300);

  // 음성 메모: + › 음성 메모 → 바로 녹음, 끝내면 소리 파일 + 받아쓴 글
  await page.tap('#fab');
  await page.tap('[data-new="voice"]');
  await page.waitForSelector('#rec-panel:not([hidden])');
  check('음성 메모: 바로 녹음 시작', (await devLog()).log.some((l) => l.recordStart));
  await page.waitForTimeout(1200);
  for (const lv of [0.2, 0.9, 0.6, 0.8, 0.3, 0.7, 0.5]) await page.evaluate((level) => window.__mk.emit('record', { type: 'level', level }), lv);
  check('녹음: 소리 크기 막대가 움직임', (await page.evaluate(() => getComputedStyle(document.querySelector('#rec-wave i:last-child')).getPropertyValue('--lv'))).trim() === '0.50');
  await shot('11-recording');
  await page.tap('#rec-stop');
  await page.waitForTimeout(1200);
  await back();
  await page.waitForTimeout(400);
  f = fileWith('오늘 회의를 시작하겠습니다');
  check('음성 메모: 소리 파일 + 받아쓴 글', f && /\]\(attachments\/[^)]+\.m4a\)/.test(read(f)) && read(f).startsWith('---') && read(f).includes('# 음성 메모'), f && read(f));
  check('음성 카드: 소리와 받아쓴 글이 한 칸(인용), 문장마다 줄 · 화자 이름표', f && /^> !\[녹음/m.test(read(f)) && read(f).includes('>\n> **화자 2:** 다음 주 출시 일정을 정리했어요.\n>\n> 표로 공유할게요.'), f && read(f));

  // Google 음성 인식을 못 쓰는 휴대폰(안드로이드 13 아래): 녹음은 그대로, 받아쓰기는 못 한다고 바로 알림 (기다리게 하지 않음)
  await post('/dev/stt', { system: false });
  await page.tap('#fab');
  await page.tap('[data-new="voice"]');
  await page.waitForSelector('#rec-panel:not([hidden])');
  await page.waitForTimeout(300);
  check('받아쓰기 못 쓰는 휴대폰: 녹음은 하면서 "녹음만 해요" 알림 (다운로드 단추 없음)', (await page.textContent('#toast-text')).includes('녹음만') && !(await page.isVisible('#toast-action')), await page.textContent('#toast-text'));
  await page.tap('#rec-stop');
  await page.waitForTimeout(1200);
  await back();
  await page.waitForTimeout(400);
  await post('/dev/stt', { system: true });

  // 소리·표·수식·글 문단도 자유롭게 옮기기 (모두 꾹 눌러 들어 올리기)
  fs.writeFileSync(path.join(vault, 'attachments/move-test.m4a'), Buffer.from('fake'));
  write('옮기기.md', '---\nid: 00000000-0000-4000-8000-0000000000aa\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: blue\n---\n# 옮기기\n\n첫 문단\n\n![녹음 테스트](attachments/move-test.m4a)\n\n| 가 | 나 |\n| --- | --- |\n| 1 | 2 |\n\n끝 문단\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000aa"]');
  await page.waitForSelector('#note-screen:not([hidden]) .mk-media-label');
  await page.waitForTimeout(400);
  // 다이얼: 옮기기 방식으로 (메모를 다시 열어도 기억한다)
  const setMode = async (m) => {
    if ((await page.getAttribute('.mode-knob', 'data-mode')) !== m) await pickMode(page, m);
    await page.waitForTimeout(250);
  };
  await setMode('move');
  const orderOf = (...keys) => { const t = read('옮기기.md'); return keys.map((k) => t.indexOf(k)); };
  const lab = await page.locator('.mk-media-label').boundingBox();
  const first = await page.locator('.mk-doc p', { hasText: '첫 문단' }).boundingBox();
  await touch('touchStart', lab.x + 40, lab.y + lab.height / 2);
  await page.waitForTimeout(550);
  check('소리 옮기기: 이름 줄을 꾹 누르면 들어 올림', (await page.locator('.mk-block-lift').count()) === 1);
  for (let i = 1; i <= 6; i++) await touch('touchMove', lab.x + 40, lab.y - ((lab.y - first.y) * i) / 6);
  await page.waitForTimeout(100);
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(900);
  let ord = orderOf('녹음 테스트', '첫 문단');
  check('소리 옮기기: 다른 줄과 맞바꿈', ord[0] > 0 && ord[0] < ord[1], read('옮기기.md'));
  // 소리 상자 어디든(재생 막대·시간·단추·빈 곳) 꾹 누르면 들어 올림 — 놓기만 하면 제자리
  {
    const missed = [];
    for (const sel of ['.mk-audio input[type=range]', '.mk-audio .plyr__time', '.mk-audio .plyr__control[data-plyr="play"]', '.mk-audio']) {
      const b = await page.locator(sel).first().boundingBox();
      if (!b) { missed.push(`${sel}(없음)`); continue; }
      const x = b.x + b.width / 2, y = sel === '.mk-audio' ? b.y + b.height - 3 : b.y + b.height / 2;
      await touch('touchStart', x, y);
      await page.waitForTimeout(550);
      if ((await page.locator('.mk-block-lift').count()) !== 1) missed.push(sel);
      await touch('touchEnd', 0, 0);
      await page.waitForTimeout(700);
      await page.evaluate(() => document.querySelector('.mk-delete-btn')?.remove());
    }
    check('소리 옮기기: 상자 어디를 꾹 눌러도 들어 올림 (재생 막대·시간·단추·빈 곳)', !missed.length, missed.join(', '));
    check('소리 옮기기: 꾹 눌렀다 놓기만 하면 순서 그대로', JSON.stringify(orderOf('녹음 테스트', '첫 문단')) === JSON.stringify(ord), read('옮기기.md'));
  }
  // 표·글 문단도 목록 항목과 같은 방식: 꾹 누르면 들어 올림 (손잡이 없음)
  check('옮기기: 따로 손잡이(⠿) 없음', (await page.locator('.mk-grip').count()) === 0);
  const cell = await page.locator('.mk-doc td', { hasText: '1' }).first().boundingBox();
  const last = await page.locator('.mk-doc p', { hasText: '끝 문단' }).boundingBox();
  await touch('touchStart', cell.x + cell.width / 2, cell.y + cell.height / 2);
  await page.waitForTimeout(150);
  check('표 옮기기: 짧게 누르면 아직 안 들어 올림', (await page.locator('.mk-block-lift').count()) === 0);
  await page.waitForTimeout(400);
  check('표 옮기기: 꾹 누르면 들어 올림 · 키보드 막기', (await page.locator('.mk-block-lift').count()) === 1 && (await page.getAttribute('.mk-doc', 'inputmode')) === 'none');
  await shot('15-hold-move');
  for (let i = 1; i <= 8; i++) await touch('touchMove', cell.x + 10, cell.y + ((last.y + last.height + 4 - cell.y) * i) / 8);
  await page.waitForTimeout(100);
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(900);
  ord = orderOf('끝 문단', '| 가 |');
  check('표 옮기기: 통째로 끝 문단 아래로', ord[0] > 0 && ord[0] < ord[1], read('옮기기.md'));
  await back();
  await page.waitForTimeout(300);

  // 그림과 그림 사이: 칸이 그림만 감싼다 (보이지 않는 줄바꿈 여백 없음)
  fs.copyFileSync(path.join(repo, 'assets/icons/icon-256.png'), path.join(vault, 'attachments/two-a.png'));
  fs.copyFileSync(path.join(repo, 'assets/icons/icon-256.png'), path.join(vault, 'attachments/two-b.png'));
  write('그림 둘.md', '---\nid: 00000000-0000-4000-8000-0000000000cc\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: blue\n---\n# 그림 둘\n\n![a](attachments/two-a.png)\n\n![b](attachments/two-b.png)\n\n끝\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000cc"]');
  await page.waitForSelector('#note-screen:not([hidden]) img.mk-image');
  await page.waitForTimeout(500);
  const fit = await page.evaluate(() => [...document.querySelectorAll('.mk-doc p.mk-image-line')].map((p) => Math.round(p.getBoundingClientRect().height - p.querySelector('img.mk-image').getBoundingClientRect().height)));
  check('그림 줄: 칸이 그림만 감쌈 (여백 없음)', fit.length === 2 && fit.every((d) => Math.abs(d) <= 1), JSON.stringify(fit));
  {
    const size = () => page.evaluate(() => ({ img: document.querySelector('img.mk-image').getBoundingClientRect().width, text: document.querySelector('.mk-doc h1').getBoundingClientRect().height }));
    const a = await size();
    await page.evaluate(() => { const ed = document.getElementById('editor'); ed.style.setProperty('--note-zoom', '1.5'); ed.classList.add('zoomed'); ed.firstElementChild.style.width = ed.style.getPropertyValue('--note-base-w'); });
    await page.waitForTimeout(200);
    const b = await size();
    await page.evaluate(() => { const ed = document.getElementById('editor'); ed.style.setProperty('--note-zoom', '1'); ed.classList.remove('zoomed'); ed.firstElementChild.style.width = ''; });
    check('페이지째 확대: 그림도 글자와 같은 비율로', Math.abs(b.img / a.img - 1.5) < 0.05 && Math.abs(b.text / a.text - 1.5) < 0.08, JSON.stringify({ a, b }));
  }
  const ib = await page.locator('img.mk-image').first().boundingBox();
  await touch('touchStart', ib.x + 40, ib.y + 40);
  await page.waitForTimeout(250);
  await shot('18-image-press');
  await page.waitForTimeout(350);
  await touch('touchEnd', ib.x + 40, ib.y + 40);
  await page.waitForTimeout(150);
  check('꾹 눌렀다 놓으면: 오른쪽 위에 지우기 단추', await page.isVisible('.mk-delete-btn'));
  await shot('18b-delete-btn');
  await page.waitForTimeout(2500);
  check('지우기 단추: 2초 뒤 사라짐', (await page.locator('.mk-delete-btn').count()) === 0);
  await touch('touchStart', ib.x + 40, ib.y + 40);
  await page.waitForTimeout(650);
  await touch('touchEnd', ib.x + 40, ib.y + 40);
  await page.waitForTimeout(150);
  await page.tap('.mk-delete-btn');
  await page.waitForTimeout(1200);
  check('지우기 단추: 누르면 그 그림만 지움', (await page.locator('img.mk-image').count()) === 1 && !read('그림 둘.md').includes('two-a.png') && read('그림 둘.md').includes('two-b.png'), read('그림 둘.md'));
  // + › 표: 커서 자리에 표 (글을 고치는 일이니 다이얼을 글 고치기로)
  await setMode('edit');
  await page.locator('.mk-doc p', { hasText: '끝' }).tap();
  await page.waitForTimeout(150);
  await page.tap('#add-btn');
  await page.waitForTimeout(300);
  await page.tap('[data-add="table"]');
  await page.waitForTimeout(400);
  check('도구막대: + › 표', (await page.locator('.mk-doc table').count()) === 1);
  check('도구막대: 평소엔 + 하나 (첨부·녹음·표 단추 없음)', (await page.locator('#format-bar [data-action="file"], #format-bar [data-action="record"], #format-bar [data-action="table"]').count()) === 0);
  if (process.env.MK_PDF) await page.pdf({ path: path.join(outDir, 'share-images.pdf'), format: 'A4' });
  await back();
  await page.waitForTimeout(300);

  // 키패드 줄바꿈 대신 쓰던 줄 아랫줄을 손가락으로 눌러 줄을 바꾸는 사람: 목록이 이어진다
  write('아랫줄.md', '---\nid: 00000000-0000-4000-8000-0000000000de\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: yellow\n---\n# 장보기\n\n위 줄\n\n- [ ] 우유\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000de"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(300);
  // 체크리스트 마지막 줄 아래 빈 곳을 손가락으로 누른다
  const tapBelow = async (sel) => {
    const box = await page.locator(sel).last().boundingBox();
    await page.touchscreen.tap(box.x + 40, box.y + box.height + 14);
    await page.waitForTimeout(150);
  };
  const lastTask = '.mk-doc ul li[data-item-type="task"]';
  await tapBelow(lastTask);
  const madeTask = await page.evaluate(() => {
    const li = getSelection().anchorNode?.parentElement?.closest('li');
    return !!li && li.dataset.itemType === 'task' && li.textContent === '';
  });
  check('아랫줄 누르기: 체크리스트 아래 빈 줄 → 새 체크 항목 (빈 네모)', madeTask);
  await page.keyboard.type('계란');
  await page.waitForTimeout(150);
  await tapBelow(lastTask);
  await page.keyboard.type('빵');
  await page.waitForTimeout(150);
  // 눌렀다가 아무것도 안 쓰고 다른 곳을 누르면 빈 항목은 사라진다
  await tapBelow(lastTask);
  await page.locator('.mk-doc p', { hasText: '위 줄' }).tap();
  await page.waitForTimeout(900);
  const tapped = read('아랫줄.md');
  check('아랫줄 누르기: 쓴 항목은 목록으로 저장', /- \[ \] 우유\n- \[ \] 계란\n- \[ \] 빵\n/.test(tapped), tapped);
  check('아랫줄 누르기: 안 쓰고 떠나면 빈 항목 없음 · 빈 줄 그대로', !/- \[ \]\s*\n/.test(tapped.replace(/- \[ \] \S.*\n/g, '')) && (await page.locator('.mk-doc li[data-item-type="task"]').count()) === 3, tapped);
  await back();
  await page.waitForTimeout(300);

  // 빈 체크리스트 항목: 나갔다 들어와도 "[ ]" 글자가 되지 않는다 (이미 "- \\[ ]" 로 저장된 것도 고침)
  write('빈 체크.md', '---\nid: 00000000-0000-4000-8000-0000000000dd\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: green\n---\n# 빈 체크\n\n- [ ] 우유\n- [ ]\n- \\[ ]\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000dd"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(300);
  check('빈 체크리스트: 빈 항목도 체크 상자로', (await page.locator('.mk-doc li[data-item-type="task"]').count()) === 3 && !(await page.locator('.mk-doc').textContent()).includes('[ ]'));
  await page.locator('.mk-doc li', { hasText: '우유' }).tap();
  await page.keyboard.press('End');
  await page.keyboard.type('와 빵');
  await page.waitForTimeout(900);
  await back();
  await page.waitForTimeout(300);
  check('빈 체크리스트: 저장해도 "\\[ ]" 없음', !read('빈 체크.md').includes('\\['), read('빈 체크.md'));
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000dd"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(300);
  check('빈 체크리스트: 다시 열어도 체크 상자 3개', (await page.locator('.mk-doc li[data-item-type="task"]').count()) === 3, read('빈 체크.md'));
  await back();
  await page.waitForTimeout(300);

  // 큰 사진이 여럿 있어도: 손가락을 조금(약 3칸 × 40px)만 움직이면 세 칸 아래로
  for (const n of ['p1', 'p2', 'p3', 'p4', 'p5']) fs.copyFileSync(path.join(repo, 'assets/icons/icon-256.png'), path.join(vault, `attachments/${n}.png`));
  write('사진 다섯.md', '---\nid: 00000000-0000-4000-8000-0000000000ee\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: blue\n---\n# 사진 다섯\n\n![p1](attachments/p1.png)\n\n![p2](attachments/p2.png)\n\n![p3](attachments/p3.png)\n\n![p4](attachments/p4.png)\n\n![p5](attachments/p5.png)\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000ee"]');
  await page.waitForSelector('#note-screen:not([hidden]) img.mk-image');
  await page.waitForTimeout(500);
  await setMode('move');
  {
    const p1 = await page.locator('img.mk-image').first().boundingBox();
    const fx = p1.x + 60;
    const fy = p1.y + 60;
    await touch('touchStart', fx, fy);
    await page.waitForTimeout(600);
    for (let i = 1; i <= 10; i++) await touch('touchMove', fx, fy + (135 * i) / 10);
    await page.waitForTimeout(150);
    await shot('20-many-photos-drag');
    await touch('touchEnd', fx, fy + 135);
    await page.waitForTimeout(900);
    const t = read('사진 다섯.md');
    const at = ['p1', 'p2', 'p3', 'p4', 'p5'].map((n) => t.indexOf(`(attachments/${n}.png)`));
    check('손가락 입력 보정: 큰 사진 5장 사이에서 손가락 135px 로 세 칸 이상 아래로', at[0] > at[3], t.split('---').pop());
  }
  await back();
  await page.waitForTimeout(300);

  // 조용한 다듬기: 쓰던 줄을 떠나면 겹친 띄어쓰기·부호 앞 띄어쓰기, 갈라진 같은 목록은 하나로
  write('다듬기.md', '---\nid: 00000000-0000-4000-8000-0000000000bb\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: blue\n---\n# 다듬기\n\n- 사과\n- 배\n\n* 감\n* 귤\n\n둘째 문단\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000bb"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(300);
  check('다듬기: 갈라진 같은 목록은 한 목록으로', (await page.locator('.mk-doc ul').count()) === 1 && (await page.locator('.mk-doc ul > li').count()) === 4);
  await page.locator('.mk-doc p', { hasText: '둘째 문단' }).tap();
  await page.keyboard.press('End');
  await page.keyboard.type('  끝이에요  정말 .');
  await page.waitForTimeout(200);
  check('다듬기: 쓰는 줄은 그대로', (await page.locator('.mk-doc p', { hasText: '둘째 문단' }).textContent()).includes('끝이에요  정말 .'));
  await page.locator('.mk-doc h1').tap();
  await page.waitForTimeout(900);
  const tidied = read('다듬기.md');
  check('다듬기: 줄을 떠나면 띄어쓰기 정리', tidied.includes('둘째 문단 끝이에요 정말.') && /- 사과\n- 배\n- 감\n- 귤/.test(tidied), tidied);
  await back();
  await page.waitForTimeout(300);

  // 화면 캡처(그림만 공유): #캡처 태그를 저절로
  await post('/dev/intent', { type: 'share', text: '', app: '스크린샷', files: [{ name: 'Screenshot_20261005.png', mime: 'image/png', base64: fs.readFileSync(path.join(repo, 'assets/icons/icon-256.png')).toString('base64') }] });
  await page.evaluate(() => window.__mk.emit('intent', null));
  await page.waitForTimeout(1500);
  f = fileWith('출처: 스크린샷');
  check('화면 캡처: #캡처 태그를 저절로', f && /#캡처/.test(read(f)), f && read(f));
  check('화면 캡처: 제목은 파일 이름 대신 "화면 캡처 · 날짜"', f && /^# 화면 캡처 · \d+월 \d+일/m.test(read(f)) && !read(f).includes('# Screenshot'), f && read(f));
  await back();
  await page.waitForTimeout(300);

  // 다른 앱에서 받은 마크다운 글은 서식대로
  await post('/dev/intent', { type: 'share', text: '## 회의록\n- 첫째\n- 둘째\n\n**결론**: 진행', app: '메모장', files: [] });
  await page.evaluate(() => window.__mk.emit('intent', null));
  await page.waitForTimeout(1200);
  f = fileWith('회의록');
  check('공유하기: 마크다운은 서식대로', f && /## 회의록\n\n- 첫째\n- 둘째/.test(read(f)) && read(f).includes('**결론**'), f && read(f));
  await back();
  await page.waitForTimeout(300);

  // 다른 앱에서 받은 소리 파일: 받아쓸지 묻는다
  await post('/dev/intent', { type: 'share', text: '', app: '녹음기', files: [{ name: '미팅.m4a', mime: 'audio/mp4', base64: Buffer.from('fake').toString('base64') }] });
  await page.evaluate(() => window.__mk.emit('intent', null));
  await page.waitForSelector('#import-sheet:not([hidden])');
  check('소리 파일 받기: 받아쓰기 체크', await page.isChecked('#import-stt'));
  await shot('12-import-audio');
  await page.tap('#import-ok');
  await page.waitForTimeout(1800);
  f = fileWith('받아쓴 글이에요');
  check('소리 파일 받기: 소리 + 받아쓴 글', f && /\.m4a\)/.test(read(f)), f && read(f));
  check('소리 파일 받기: 받아쓴 글은 그 소리의 음성 카드 안에', f && /^> !\[[^\]]*\]\([^)]+\.m4a\)\n>\n> /m.test(read(f)), f && read(f));
  await page.waitForSelector('.mk-voice .mk-voice-toggle');
  check('음성 카드: 한 칸으로 보임 (소리 + 글 + 접기 막대)', (await page.locator('.mk-voice .mk-media').count()) === 1 && (await page.locator('.mk-voice .mk-voice-line').count()) >= 1);
  await page.tap('.mk-voice-toggle');
  await page.waitForTimeout(300);
  check('음성 카드: 접으면 글이 숨고 첫 문장 미리 보기', (await page.locator('.mk-voice.folded').count()) === 1 && !(await page.locator('.mk-voice .mk-voice-line').first().isVisible()) && (await page.locator('.mk-voice-peek').textContent()).length > 0);
  await shot('16-voice-card-folded');
  await page.tap('.mk-voice-toggle');
  await page.waitForTimeout(300);
  check('음성 카드: 다시 펴기', (await page.locator('.mk-voice.folded').count()) === 0);
  {
    // 접기 막대도 꾹 누르면 카드째로 들어 올림 (놓아도 접히지 않음) — 옮기기 방식에서 (글자를 누르면 글 고치기로 넘어가므로 다시)
    await setMode('move');
    const b = await page.locator('.mk-voice-toggle').boundingBox();
    await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(550);
    const up = (await page.locator('.mk-block-lift').count()) === 1;
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(700);
    check('음성 카드: 접기 막대를 꾹 누르면 카드째로 들어 올림 (놓아도 접히지 않음)', up && (await page.locator('.mk-voice.folded').count()) === 0);
    await page.evaluate(() => document.querySelector('.mk-delete-btn')?.remove());
  }
  await shot('16-voice-card');
  if (process.env.MK_DUMP) console.log(await page.evaluate(() => { const v = document.querySelector('.mk-voice'); const p = v.querySelector('.mk-voice-body > p'); return p.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '') + '\n' + [...p.querySelectorAll('*')].slice(0, 8).map((e) => e.tagName + '.' + e.className + ' ' + e.getBoundingClientRect().height).join('\n'); }));
  await back();
  await page.waitForTimeout(300);

  // 왕복: 까다로운 서식(굵게·밑줄·색·목록·체크·표·수식·코드·링크·맨주소·그림·줄바꿈·이스케이프·태그)의 메모를
  // 열기만 하면 파일이 그대로, 끝에 글자 하나를 쳐서 저장하면 읽는 글이 한 줄도 사라지거나 바뀌지 않는다
  {
    const { plainLines, parseMemoFile } = await import('../../../app/js/core/memo-file.js');
    const sample = fs.readFileSync(path.join(here, 'roundtrip-sample.md'), 'utf8');
    fs.copyFileSync(path.join(repo, 'assets/icons/icon-256.png'), path.join(vault, 'attachments/a.png'));
    const fileText = `---\nid: 00000000-0000-4000-8000-0000000000ab\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: yellow\n---\n${sample}`;
    write('왕 테스트.md', fileText);
    await page.evaluate(() => window.__mk.emit('app', 'resume'));
    await page.waitForTimeout(400);
    await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000ab"]');
    await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
    await page.waitForTimeout(1000);
    check('왕복: 열기만 하면 파일 그대로', read('왕 테스트.md') === fileText);
    await page.locator('.mk-doc p', { hasText: '끝 문단' }).tap();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.locator('.mk-doc h1').first().tap();
    await page.waitForTimeout(1200);
    const saved = read('왕 테스트.md');
    const want = plainLines(sample.replace('말줄임 ..', '말줄임 ..!'));
    const got = plainLines(parseMemoFile(saved).body);
    const lost = want.filter((l) => !got.includes(l));
    const added = got.filter((l) => !want.includes(l));
    check('왕복: 저장해도 읽는 글이 그대로 (사라지거나 바뀐 줄 없음)', !lost.length && !added.length, JSON.stringify({ lost, added }));
    const missing = ['- [ ] 할 일', '- [x] 끝낸 일', '| 사과 |', '$x^2 + y^2$', '$$\n\\int_0^1 x\\,dx\n$$', 'const a = 1; // 코드 # 태그 아님', '<u>밑줄</u>', '<span style="color: #e5484d">빨강</span>', '언어\n\n---\n\n이메일', '![그림](attachments/a.png)'].filter((t) => !saved.includes(t));
    check('왕복: 서식·구조도 그대로 (체크·표·수식·코드·색·가로줄)', !missing.length, JSON.stringify(missing) + '\n' + saved);
    await back();
    await page.waitForTimeout(300);
  }

  // 표 칸 안에서: 사진·표·수식 넣기와 붙여넣기가 표를 쪼개거나 옆 칸을 덮어쓰지 않는다
  {
    const id = '00000000-0000-4000-8000-0000000000ad';
    const table = '| 품목 | 가격 |\n| --- | --- |\n| 사과 | 1000 |';
    write('표 칸 테스트.md', `---\nid: ${id}\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: yellow\n---\n# 표 칸 테스트\n\n${table}\n\n끝\n`);
    await page.evaluate(() => window.__mk.emit('app', 'resume'));
    await page.waitForTimeout(400);
    await page.tap(`.card[data-id="${id}"]`);
    await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
    await page.waitForTimeout(800);
    const intoCell = async (text) => {
      await page.locator('.mk-doc td', { hasText: text }).first().tap();
      await page.keyboard.press('End');
      await page.waitForTimeout(200);
    };
    const { parseMemoFile } = await import('../../../app/js/core/memo-file.js');
    const body = () => parseMemoFile(read('표 칸 테스트.md')).body;
    const paste = (text, html = '') => page.evaluate(([t, h]) => {
      const d = new DataTransfer();
      d.setData('text/plain', t);
      if (h) d.setData('text/html', h);
      document.querySelector('#note-screen .ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }));
    }, [text, html]);
    const settle = async () => {
      await page.locator('.mk-doc h1').first().tap();
      await page.waitForTimeout(1200);
    };
    await fetch(`${base}/dev/pick`, { method: 'POST', body: JSON.stringify([{ name: '칸.png', mime: 'image/png', base64: fs.readFileSync(path.join(repo, 'assets/icons/icon-256.png')).toString('base64') }]) });
    await intoCell('사과');
    await page.tap('#add-btn');
    await page.waitForTimeout(250);
    await page.tap('.add-sat[data-add="photo"]');
    await settle();
    check('표 칸: 사진은 표 바로 아래에 (표 그대로)', /\| 사과 \| 1000 \|\n\n!\[칸\]\(attachments\//.test(body()), body());
    await intoCell('사과');
    await page.tap('#add-btn');
    await page.waitForTimeout(250);
    await page.tap('.add-sat[data-add="math"]');
    await page.waitForTimeout(400);
    await page.keyboard.type('x^2');
    await page.keyboard.press('Enter');
    await settle();
    check('표 칸: 수식은 표 바로 아래에 (표 그대로)', /\| 사과 \| 1000 \|\n\n\$\$\nx\^2\n\$\$/.test(body()), body());
    await intoCell('사과');
    await paste('첫 줄\n둘째 줄');
    await settle();
    check('표 칸: 여러 줄 붙여넣기는 그 칸 안 줄바꿈으로', /\| 사과첫 줄<br>둘째 줄 \| 1000 \|/.test(body()), body());
    await intoCell('1000');
    await paste('가\t나\n다\t라');
    await settle();
    check('표 칸: 엑셀 칸 붙여넣기는 칸마다 (모자라면 늘림)', /\| 사과첫 줄<br>둘째 줄 \| 가\s+\| 나\s+\|\n\|\s+\| 다\s+\| 라\s+\|/.test(body()), body());
    await back();
    await page.waitForTimeout(300);
  }

  // 목록 항목: 꾹 눌렀다 놓으면 × (2.5초), 더 오래 누르면 목록 전체를 옮긴다
  {
    const id = '00000000-0000-4000-8000-0000000000af';
    write('목록 지우기.md', `---\nid: ${id}\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: yellow\n---\n# 목록 지우기\n\n위 문단\n\n- 사과\n- 배\n- 감\n\n아래 문단\n\n끝 문단\n`);
    await page.evaluate(() => window.__mk.emit('app', 'resume'));
    await page.waitForTimeout(400);
    await page.tap(`.card[data-id="${id}"]`);
    await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror li');
    await page.waitForTimeout(800);
    await setMode('move'); // 꾹 눌러 들어 올리기는 옮기기 방식에서
    const { parseMemoFile } = await import('../../../app/js/core/memo-file.js');
    const body = () => parseMemoFile(read('목록 지우기.md')).body;
    const liBox = (t) => page.locator('.mk-doc li', { hasText: t }).first().boundingBox();
    let b = await liBox('배');
    await touch('touchStart', b.x + 30, b.y + b.height / 2);
    await page.waitForTimeout(500);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(300);
    const shown = (await page.locator('.mk-delete-btn').count()) === 1 && (await page.locator('.mk-doc li.mk-delete-target').count()) === 1;
    await page.waitForTimeout(2000);
    const still = (await page.locator('.mk-delete-btn:not(.fading)').count()) === 1;
    await page.waitForTimeout(700);
    check('목록 항목: 꾹 눌렀다 놓으면 × (2.5초 뒤 사라짐)', shown && still && (await page.locator('.mk-delete-btn').count()) === 0);
    b = await liBox('배');
    await touch('touchStart', b.x + 30, b.y + b.height / 2);
    await page.waitForTimeout(500);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(300);
    const x = await page.locator('.mk-delete-btn').boundingBox();
    await touch('touchStart', x.x + 15, x.y + 15);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(1500);
    check('목록 항목: × 를 누르면 그 항목만 지움', /- 사과\n- 감\n/.test(body()) && !body().includes('배'), body());
    b = await liBox('사과');
    await touch('touchStart', b.x + 30, b.y + b.height / 2);
    await page.waitForTimeout(1300);
    const whole = await page.evaluate(() => document.body.classList.contains('mk-block-dragging') && document.querySelector('.mk-block-lift')?.tagName === 'UL');
    for (let i = 1; i <= 10; i++) { await touch('touchMove', b.x + 30, b.y + b.height / 2 + i * 30); await page.waitForTimeout(40); }
    await page.waitForTimeout(150);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(1500);
    check('목록: 항목을 더 오래 누르면 목록 전체를 들어 올려 옮김', whole && /끝 문단\n\n- 사과\n- 감/.test(body()), body());
    // 목록 전체를 들어 올렸다 그 자리에 놓으면 목록 전체 × (흰 바탕 빨간 ×) → 누르면 목록째로 지움
    b = await liBox('감');
    await touch('touchStart', b.x + 30, b.y + b.height / 2);
    await page.waitForTimeout(1300);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(400);
    const lab = await page.locator('.mk-delete-btn').getAttribute('aria-label').catch(() => null);
    const look = await page.evaluate(() => { const e = document.querySelector('.mk-delete-btn'); if (!e) return null; const c = getComputedStyle(e); return { w: Math.round(e.getBoundingClientRect().width), bg: c.backgroundColor, color: c.color }; });
    check('목록 전체: 놓으면 목록 전체 × (흰 바탕·빨간 ×·작게)', lab === '이 목록 지우기' && look?.bg === 'rgb(255, 255, 255)' && look?.color === 'rgb(229, 72, 77)' && look.w <= 26 && (await page.locator('.mk-doc ul.mk-delete-target').count()) === 1, JSON.stringify({ lab, look }));
    const xb = await page.locator('.mk-delete-btn').boundingBox();
    await touch('touchStart', xb.x + 12, xb.y + 12);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(150);
    const fading = await page.evaluate(() => document.querySelector('.mk-doc ul.mk-deleting') != null);
    await page.waitForTimeout(1500);
    check('목록 전체: × 를 누르면 사라지는 모습 뒤 목록째로 지움', fading && !/- 사과|- 감/.test(body()) && body().includes('끝 문단'), body());
    await back();
    await page.waitForTimeout(300);
  }

  // 넓은 화면(펼친 폴더블·태블릿): 목록과 메모를 나란히
  await page.setViewportSize({ width: 884, height: 1000 });
  await page.waitForTimeout(300);
  check('넓은 화면: 메모가 없으면 목록이 화면 가득', (await page.locator('#list-screen').boundingBox()).width > 860);
  await page.locator('.card').first().tap();
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(400);
  const full = await page.locator('#note-screen').boundingBox();
  check('넓은 화면: 메모를 열면 목록은 숨고 메모가 가득', full.x === 0 && full.width > 860 && !(await page.isVisible('#list-screen')), JSON.stringify(full));
  await page.tap('#back-btn'); // ≡ 목록 옆에
  await page.waitForTimeout(400);
  const lb = await page.locator('#list-screen').boundingBox();
  const nb = await page.locator('#note-screen').boundingBox();
  check('넓은 화면: ≡ → 목록과 메모 나란히', lb && nb && lb.width < 500 && nb.x >= lb.width - 1 && await page.isVisible('#list-screen'), JSON.stringify({ lb, nb }));
  await shot('13-two-pane');
  await back(); // 태블릿 뒤로: 옆에 꺼낸 목록 숨기기 → 메모 닫기
  await page.waitForTimeout(200);
  await back();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);

  // ---------- 손 메모: 콘텐츠로서 (+ › 손 메모) · 주석으로서 (+ › 주석) ----------
  {
    const idea = () => fs.readdirSync(vault).find((f) => f.startsWith('아이디어'));
    const waitFile = async (test, ms = 6000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const body = read(idea());
        if (test(body)) return body;
        await page.waitForTimeout(150);
      }
      return read(idea());
    };
    await page.tap('.card:has(.card-title:text-is("아이디어"))');
    await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
    await page.waitForTimeout(300);
    const draw = async (pts) => {
      await page.mouse.move(pts[0][0], pts[0][1]);
      await page.mouse.down();
      for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 4 });
      await page.mouse.up();
    };
    const wave = (x0, y0, w = 160) => Array.from({ length: 12 }, (_, i) => [x0 + (w * i) / 11, y0 + Math.sin(i / 1.6) * 18]);
    await setMode('edit'); // + 는 글 고치기에만 (옮기기·그리기에서는 숨음)
    check('다이얼: 옮기기에서 숨었던 + 가 글 고치기에서 다시', await page.isVisible('#add-btn'));
    await page.tap('#add-btn');
    await page.waitForTimeout(250);
    await page.tap('.add-sat[data-add="ink"]');
    await page.waitForSelector('.ink-sheet');
    const sheet = await page.evaluate(() => {
      const dock = document.querySelector('.ink-sheet .ink-dock').getBoundingClientRect();
      return { tools: document.querySelectorAll('.ink-sheet .ink-tools .ink-btn').length, bg: !!document.querySelector('.ink-sheet .ink-bg-btn'), head: [...document.querySelectorAll('.ink-head button')].map((b) => b.textContent.trim()).join(), fits: dock.left >= 0 && dock.right <= innerWidth, empty: !!document.querySelector('.ink-empty:not(.gone)') };
    });
    await draw(wave(60, 260));
    await draw(wave(80, 340, 120));
    await page.waitForTimeout(150);
    await shot('20-ink-editor');
    const live = await page.locator('.ink-sheet .ink-strokes path').count();
    // 검은 펜은 밝은 화면에선 검게, 다크 모드에선 밝게 보인다 (파일에는 검정 그대로)
    const penFill = await page.evaluate(() => getComputedStyle(document.querySelector('.ink-sheet .ink-strokes path')).fill);
    const wantFill = process.env.MK_DARK ? 'rgb(245, 244, 239)' : 'rgb(31, 31, 28)';
    check(`검은 펜이 ${process.env.MK_DARK ? '다크 모드에서 밝게' : '밝은 화면에서 검게'} 보임 · 버튼에 검정 바탕 없음`, penFill === wantFill && await page.evaluate(() => [...document.querySelectorAll('.ink-sheet button')].every((b) => { const c = getComputedStyle(b).backgroundColor; return c !== 'rgb(17, 17, 17)' && c !== 'rgb(0, 0, 0)'; })), penFill);
    check('손 메모: + › 손 메모 → 그리기 화면 (취소 없이 완료 하나 · 떠 있는 도구 막대가 화면 안에 · 처음 안내) · 그린 획이 보임', sheet.tools === 3 && sheet.bg && sheet.head === '완료' && sheet.fits && sheet.empty && live === 2, JSON.stringify({ sheet, live }));
    // 형광펜을 고르고 한 번 더 누르면 색·굵기 판 (형광 색 4가지)
    await page.tap('.ink-sheet .ink-tool-highlighter');
    await page.tap('.ink-sheet .ink-tool-highlighter');
    const hlPop = await page.evaluate(() => !document.querySelector('.ink-sheet .ink-pop').hidden && document.querySelectorAll('.ink-sheet .ink-pop .ink-color').length);
    await shot('20b-ink-pop');
    await page.tap('.ink-sheet .ink-tool-pen');
    const penBack = await page.evaluate(() => document.querySelectorAll('.ink-sheet .ink-pop .ink-color').length);
    check('고른 도구를 한 번 더 누르면 색·굵기 판 · 판이 열린 채 도구를 바꾸면 그 도구의 색으로', hlPop === 4 && penBack === 7, JSON.stringify({ hlPop, penBack }));
    // S펜 버튼(갤럭시 탭): 누른 채 그으면 지우개 — 웹 신호(buttons=2)로도, 앱이 알려 주는 신호로도
    const sPen = await page.evaluate(async () => {
      const svg = document.querySelector('.ink-sheet .ink-canvas');
      const r = svg.getBoundingClientRect();
      const count = () => svg.querySelectorAll('g path, :scope > path').length;
      const fire = (type, x, y, buttons, id) => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + y, buttons, button: type === 'pointermove' ? -1 : (buttons & 2 ? 2 : 0), pressure: 0.5 }));
      const line = (y, buttons, id) => { fire('pointerdown', 60, y, buttons, id); for (let x = 60; x <= 200; x += 10) fire('pointermove', x, y, buttons, id); fire('pointerup', 200, y, 0, id); };
      const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const before = count();
      line(420, 1, 91); await wait(80);
      const drawn = count();
      line(420, 3, 92); await wait(80); // 펜 끝 + 옆 버튼
      const erasedWeb = count();
      line(470, 1, 93); await wait(80);
      window.dispatchEvent(new CustomEvent('memoking:pen-button', { detail: true }));
      line(470, 1, 94); await wait(80);
      window.dispatchEvent(new CustomEvent('memoking:pen-button', { detail: false }));
      const erasedApp = count();
      line(520, 1, 95); await wait(80); // 버튼을 떼면 다시 펜
      return { before, drawn, erasedWeb, erasedApp, after: count() };
    });
    check('S펜 버튼을 누른 채 그으면 지우개 · 떼면 다시 펜', sPen.drawn === sPen.before + 1 && sPen.erasedWeb === sPen.before && sPen.erasedApp === sPen.before && sPen.after === sPen.before + 1, JSON.stringify(sPen));
    for (let i = 0; i < 5; i++) await page.evaluate(() => document.querySelector('.ink-sheet button[title^="되돌리기"]')?.click()); // 시험용 획 되돌리기
    await page.tap('.ink-sheet .ink-done');
    await page.waitForSelector('.mk-doc .mk-ink img', { state: 'attached' });
    const body1 = await waitFile((b) => /!\[손 메모\]/.test(b));
    const svgRel = body1.match(/!\[손 메모\]\((attachments\/[^)]+\.svg)\)/)?.[1];
    const svg1 = svgRel ? read(svgRel) : '';
    const vb = svg1.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/)?.slice(1).map(Number) ?? [];
    const shown = await page.locator('.mk-doc .mk-ink img.ink-light-src').evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight, ok: img.complete && img.naturalWidth > 0 }));
    check('완료 → 메모 안에 손 메모 한 칸 (SVG 파일 · 다시 고칠 수 있는 자료 포함)', svgRel && /memoking-ink/.test(svg1) && (svg1.match(/<path /g) ?? []).length === 2 && shown.ok, body1);
    check('손 메모 크기 = 그린 만큼 (화면 전체가 아니라)', vb[0] > 150 && vb[0] < 230 && vb[1] > 100 && vb[1] < 170 && shown.w === vb[0], JSON.stringify({ vb, shown }));
    const shownSrc = await page.waitForFunction((dark) => {
      const vis = [...document.querySelectorAll('.mk-doc .mk-ink img')].filter((i) => i.offsetWidth > 0);
      return vis.length === 1 && (dark ? vis[0].classList.contains('ink-dark-src') && vis[0].src.startsWith('data:') : vis[0].classList.contains('ink-light-src')) && vis[0].className;
    }, Boolean(process.env.MK_DARK), { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => null);
    check(`메모 안 투명 바탕 손 메모: ${process.env.MK_DARK ? '다크 모드는 검은 펜을 밝게 바꾼 그림' : '원래 그림'} 하나만 보임`, shownSrc, String(shownSrc));
    await shot('21-ink-in-memo');
    // 이어 그리기: 칸을 골라 "이어 그리기" → 같은 획이 보이고, 흰 바탕으로 바꿔 한 획 더
    await page.tap('.mk-doc .mk-ink img:visible');
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('.mk-doc .mk-ink-edit').click());
    await page.waitForSelector('.ink-sheet');
    await page.waitForTimeout(200);
    const again = await page.locator('.ink-sheet .ink-strokes path').count();
    await page.tap('.ink-sheet .ink-bg-btn');
    await page.tap('.ink-sheet .ink-pop .ink-bg[data-bg="white"]');
    await draw(wave(70, 300, 100));
    const popGone = await page.evaluate(() => document.querySelector('.ink-sheet .ink-pop').hidden);
    await page.keyboard.press('Escape'); // 취소가 없다: Esc(뒤로 가기)도 저장하고 닫기
    const body2 = await waitFile((b) => /!\[손 메모 · 흰 바탕\]/.test(b));
    const svgRel2 = body2.match(/!\[손 메모 · 흰 바탕\]\((attachments\/[^)]+\.svg)\)/)?.[1];
    const svg2 = svgRel2 ? read(svgRel2) : '';
    check('이어 그리기: 그린 획을 그대로 열고, 바탕 판에서 흰 바탕 · 그리기 시작하면 판이 닫힘 · Esc 도 저장', popGone && again === 2 && svgRel2 && svgRel2 !== svgRel && (svg2.match(/<path /g) ?? []).length === 3 && /<rect [^>]*#ffffff/.test(svg2), JSON.stringify({ again, svgRel2, body2 }));
    // 주석: 글 위에 그리기 (칸을 차지하지 않음)
    const docH = await page.evaluate(() => document.querySelector('.ProseMirror').getBoundingClientRect().height);
    await pickMode(page, 'draw'); // 글 위에 그리기는 다이얼에서
    await page.waitForSelector('.mk-annot.drawing');
    await page.waitForTimeout(300); // + 메뉴가 닫히는 동안
    const p = await page.evaluate(() => { const el = [...document.querySelectorAll('.ProseMirror > p')].find((x) => x.textContent.includes('머리말')); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 12 }; });
    await draw([[p.x, p.y], [p.x + 60, p.y + 4], [p.x + 120, p.y - 2], [p.x + 180, p.y + 3]]);
    await page.waitForTimeout(150);
    await shot('22-annotate');
    const annBar = await page.evaluate(() => {
      const r = document.querySelector('.mk-annot-bar .ink-dock').getBoundingClientRect();
      const k = document.querySelector('.mode-knob').getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && !document.querySelector('.mk-annot-bar .ink-done') && k.bottom <= r.top && !!document.querySelector('.mk-annot-scroller');
    });
    check('주석 모드: 도구 막대가 화면 안에 · 완료 단추 없음(다이얼로 끝냄) · 다이얼은 막대 위 · 본문 둘레 점선', annBar);
    await pickMode(page, 'edit'); // 다이얼을 돌려 끝내면 저장
    const body3 = await waitFile((b) => /^ink: /m.test(b));
    const inkRel = body3.match(/^ink: (attachments\/\S+\.json)$/m)?.[1];
    const ann = inkRel ? JSON.parse(read(inkRel)) : null;
    const docH2 = await page.evaluate(() => document.querySelector('.ProseMirror').getBoundingClientRect().height);
    check('주석: 다이얼 › 그리기 → 글 위에 그리고 완료 → 머리말 ink: 파일 (문단에 붙임) · 칸을 차지하지 않음', inkRel && ann?.strokes?.length === 1 && ann.strokes[0].anchor && Math.abs(docH2 - docH) < 1 && (await page.locator('.mk-annot path').count()) === 1, JSON.stringify({ inkRel, n: ann?.strokes?.length, ann: ann?.strokes?.[0]?.anchor, docH, docH2, paths: await page.locator('.mk-annot path').count() }));
    // 위에 줄이 생겨 문단이 밀리면 주석도 따라 내려간다
    const before = await page.evaluate(() => document.querySelector('.mk-annot path').getBoundingClientRect().top);
    await page.evaluate(() => { const h = document.querySelector('.ProseMirror > *'); h.focus?.(); });
    await page.tap('.ProseMirror > :first-child');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('위에 새 줄');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.querySelector('.mk-annot path').getBoundingClientRect().top);
    check('글이 늘어 문단이 밀리면 주석도 그 문단을 따라감', after - before > 15, JSON.stringify({ before, after }));
    await shot('23-annotate-follow');
    await back();
    await page.waitForTimeout(400);
  }

  // 튜토리얼: 설정 › 사용법 둘러보기 → 직접 해 보면 칭찬과 함께 다음 단계 (휴대폰도 PC 와 같은 말풍선)
  {
    const stepIs = (id) => page.waitForSelector(`.coach-bubble:not([hidden])[data-step="${id}"]`, { timeout: 5000 }).then(() => true).catch(() => false);
    await page.tap('#settings-btn');
    await page.waitForTimeout(300);
    await page.tap('#tutorial-btn');
    const welcome = await stepIs('welcome');
    const head = await page.evaluate(() => ({ emoji: document.querySelector('.coach-emoji')?.textContent, bar: !!document.querySelector('.coach-progress i') }));
    await shot('24-tutorial-welcome');
    await page.tap('.coach-bubble .coach-next');
    const newMemo = await stepIs('new-memo');
    const trying = await page.evaluate(() => !!document.querySelector('.coach-try') && document.querySelector('.coach-spot').classList.contains('pulse'));
    check('튜토리얼: 설정 › 사용법 둘러보기 → 이모지·진행 막대 · 직접 해 보기 단계는 누를 곳만 노란 테두리 + 해 보기 안내 (손가락 이모지 없음)', welcome && head.emoji === '👑' && head.bar && newMemo && trying, JSON.stringify({ welcome, head, newMemo, trying }));
    await page.tap('#fab');
    await page.waitForTimeout(300);
    await page.tap('#fab-menu [data-new="text"]');
    const write = await stepIs('write');
    await page.keyboard.type('튜토리얼 메모');
    const lists = await stepIs('lists');
    const praised = await page.isVisible('.coach-bubble .coach-praise');
    await page.waitForTimeout(500);
    await shot('25-tutorial-praise');
    check('새 메모 → 메모 화면에서 다음 말풍선 · 글을 쓰면 "잘했어요" 칭찬과 함께 다음', write && lists && praised, JSON.stringify({ write, lists, praised }));
    await page.evaluate(() => document.querySelector('#format-bar [data-cmd="task"]').click());
    const move = await stepIs('move');
    await page.waitForTimeout(400);
    const shotShown = await page.evaluate(() => { const i = document.querySelector('.coach-shot'); return i && i.complete && i.naturalWidth > 0; });
    await shot('26-tutorial-shot');
    check('체크리스트를 만들면 다음 단계 · 실제 화면 사진이 보임', move && shotShown, JSON.stringify({ move, shotShown }));
    await page.tap('.coach-bubble .coach-skip');
    const ended = await page.waitForSelector('.coach-bubble', { state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false);
    check('튜토리얼 그만하기 → 말풍선이 사라짐', ended && !(await page.evaluate(() => document.body.classList.contains('coaching'))));
    await back();
    await page.waitForTimeout(400);
  }

  // Google Drive 연결 (미리보기 서버의 가짜 Drive): 설정 › 연결하기 › (휴대폰 구글 계정) › 폴더 › 지금 메모 함께 올리기
  const count = await page.locator('.card').count();
  await page.tap('#settings-btn');
  await page.tap('#drive-connect'); // 휴대폰 구글 계정으로 바로 (계정 고르기·허용은 미리보기에서 생략) → 폴더는 저절로
  await page.waitForFunction(() => document.getElementById('drive-sheet').hidden, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  await shot('06-drive');
  const auto = (await devLog()).log.find((l) => l.driveAuto)?.driveAuto;
  const used = (await devLog()).log.find((l) => l.driveUse)?.driveUse;
  check('Drive: 연결하기 한 번으로 "메모킹 동기화" 폴더에 연결 (폴더 고르기 없음)', auto?.name === '메모킹 동기화' && used?.folderId === auto.folderId);
  check('Drive: 지금 휴대폰 메모를 함께 옮김', used?.importLocal === true);
  // 고급: 연결된 뒤 "폴더 변경" 은 폴더 목록 (메모킹이 만든 폴더만)
  if (!(await page.isVisible('#drive-connect'))) await page.tap('#settings-btn');
  await page.tap('#drive-connect');
  await page.waitForSelector('.folder-item.suggest');
  check('Drive: 폴더 변경은 목록에서 (메모킹 동기화가 맨 위)', (await page.locator('.folder-item').first().textContent()).includes('메모킹 동기화'));
  await page.evaluate(() => window.__mk.back());
  await page.waitForTimeout(300);
  if (await page.isVisible('#settings-sheet')) await page.evaluate(() => window.__mk.back());
  await page.waitForTimeout(300);
  check('Drive: 연결 뒤 메모 그대로 보임', (await page.locator('.card').count()) === count);
  check('Drive: 목록 위 동기화 버튼', await page.isVisible('#sync-btn'));

  // 다크 모드
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await shot('05-dark');

  check('화면 오류 없음', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(vault, { recursive: true, force: true });
}

console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
