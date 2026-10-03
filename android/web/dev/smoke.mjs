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
const outDir = path.join(repo, 'out', 'android');
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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
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

  // 새 메모 → 제목이 파일 이름
  await page.tap('#fab');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.keyboard.type('# 휴대폰 첫 메모');
  await page.keyboard.press('Enter');
  await page.keyboard.type('장보기 #생활');
  // 제목·점 목록·번호 목록·체크리스트는 한 줄에 하나만 (버튼도 하나만 눌려 보임)
  const lineStyle = () => page.$$eval('#format-bar [data-cmd].active', (bs) => bs.map((b) => b.dataset.cmd).filter((c) => ['h1', 'h2', 'bullet', 'ordered', 'task'].includes(c)).join(','));
  const steps = [['bullet', 'bullet'], ['ordered', 'ordered'], ['task', 'task'], ['h1', 'h1'], ['ordered', 'ordered'], ['h2', 'h2'], ['task', 'task'], ['task', '']];
  let exclusive = true;
  for (const [cmd, want] of steps) {
    await page.click(`#format-bar [data-cmd="${cmd}"]`);
    await page.waitForTimeout(120);
    if ((await lineStyle()) !== want) exclusive = false;
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

  // 파일 넣기 (키보드를 내린 상태 → 메모 끝에)
  await post('/dev/pick', [{ name: '보고서.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64') }]);
  await page.tap('[data-action="file"]');
  await page.waitForTimeout(800);
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
  // 둘째 항목을 꾹 눌러 첫째 항목 가운데로 → 맞바꾸기
  const items = page.locator('.mk-doc li[data-item-type="task"]');
  const a = await items.nth(0).boundingBox();
  const b = await items.nth(1).boundingBox();
  await touch('touchStart', b.x + 40, b.y + b.height / 2);
  await page.waitForTimeout(550);
  check('줄 바꾸기: 꾹 누르면 들어 올림', (await page.locator('.mk-doc li.mk-lift').count()) === 1);
  for (let i = 1; i <= 6; i++) await touch('touchMove', b.x + 40, b.y + b.height / 2 - ((b.y - a.y) * i) / 6);
  await page.waitForTimeout(100);
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
  await page.evaluate(() => {
    localStorage.removeItem('memoking.noteZoom');
    document.getElementById('editor').style.setProperty('--note-zoom', '1');
  });
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
  check('그림 줄 옮기기: 처음 한 번 옮기는 방법 안내', (await page.textContent('.mk-move-hint').catch(() => '')).includes('꾹 눌러'));
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
  await page.waitForTimeout(200);
  check('그림 줄 옮기기: 누르는 동안 테두리', (await page.locator('.mk-block-pressing').count()) === 1);
  await page.waitForTimeout(350);
  check('그림 줄 옮기기: 꾹 누르면 들어 올림', (await page.locator('.mk-block-lift').count()) === 1);
  const to = textLine.y + textLine.height / 2;
  for (let i = 1; i <= 8; i++) await touch('touchMove', img.x + 60, img.y + 60 + ((to - img.y - 60) * i) / 8);
  await page.waitForTimeout(120);
  check('그림 줄 옮기기: 맞바꾸기 안내', (await page.textContent('.mk-drag-badge')).includes('맞바꾸기'));
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
  const to2 = text2.y + 3;
  for (let i = 1; i <= 8; i++) await touch('touchMove', img2.x + 60, img2.y + 60 + ((to2 - img2.y - 60) * i) / 8);
  await page.waitForTimeout(120);
  check('그림 줄 옮기기: 끼우기 안내', (await page.textContent('.mk-drag-badge')).includes('넣기'));
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(900);
  logo = read('로고 사진.md');
  const order = ['# 로고 사진', '![로고]', '새 아이콘 시안'].map((t) => logo.indexOf(t));
  check('그림 줄 옮기기: 제목 바로 아래로 끼움', order[0] < order[1] && order[1] < order[2], logo);
  await back();
  await page.waitForTimeout(300);

  await page.dispatchEvent('.card[data-id="00000000-0000-4000-8000-000000000002"]', 'contextmenu');
  await page.tap('[data-memo-action="delete"]');
  await page.click('#confirm-ok');
  await page.waitForTimeout(300);
  check('지우기: 휴지통으로', !fs.existsSync(path.join(vault, '로고 사진.md')) && fs.readdirSync(path.join(vault, '_memoking/trash')).some((f) => f.startsWith('로고 사진 (')));
  check('지우기: 그 메모만 쓰던 첨부도 휴지통으로', fs.existsSync(path.join(vault, '_memoking/trash/attachments/20261001-090000-ab12.png')));
  await page.tap('#settings-btn');
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
  await back();

  // LLM 인덱스
  const index = JSON.parse(read('_memoking/index.json'));
  check('LLM 인덱스: 모든 메모', index.memos.length === fs.readdirSync(vault).filter((f) => f.endsWith('.md')).length);
  check('LLM 인덱스: 안내서', fs.existsSync(path.join(vault, '_memoking/README.md')));

  // 알림 보관함: 탭 → 보관 시작하기 → (설정에서 알림 접근 허용) → 모은 알림
  await page.tap('[data-tab="history"]');
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

  // Google Drive 연결 (미리보기 서버의 가짜 Drive): 설정 › 연결하기 › (휴대폰 구글 계정) › 폴더 › 지금 메모 함께 올리기
  const count = await page.locator('.card').count();
  await page.tap('#settings-btn');
  await page.tap('#drive-connect'); // 휴대폰 구글 계정으로 바로 (계정 고르기·허용은 미리보기에서 생략)
  await page.waitForSelector('.folder-item.suggest');
  check('Drive: 로그인 뒤 폴더 목록 (메모킹이 맨 위)', (await page.locator('.folder-item').first().textContent()).includes('메모킹'));
  check('Drive: 내 드라이브 맨 위는 고를 수 없음', await page.isDisabled('#folder-use'));
  await page.tap('.folder-item.suggest');
  await page.waitForTimeout(200);
  check('Drive: 지금 메모 함께 올리기 보임', await page.isVisible('#import-row'));
  await page.tap('#folder-use');
  await page.waitForTimeout(1000);
  await shot('06-drive');
  const used = (await devLog()).log.find((l) => l.driveUse)?.driveUse;
  check('Drive: 폴더 연결 (지금 메모 함께)', used?.name === '메모킹' && used?.importLocal === true);
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
