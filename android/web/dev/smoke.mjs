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
  const emptyMid = await page.evaluate(() => {
    const v = document.getElementById('view-memos').getBoundingClientRect();
    const b = document.querySelector('#empty .btn.primary').getBoundingClientRect();
    return { at: (b.top - v.top) / v.height };
  });
  check('빈 결과: 안내가 목록 칸 가운데쯤 (위 · 아래로 치우치지 않음)', emptyMid.at > 0.35 && emptyMid.at < 0.7, JSON.stringify(emptyMid));
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
  // 형광펜 단추를 짧게 누르면 켜고 끄기: 칠해진 글자를 고르고 누르면 지워지고, 다시 누르면 칠해진다
  await page.locator('.mk-doc mark').tap();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const t = document.querySelector('.mk-doc mark').firstChild;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, t.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.waitForTimeout(300);
  await page.tap('#format-bar [data-action="highlight"]');
  await page.waitForTimeout(300);
  const hlOff = (await page.locator('.mk-doc mark').count()) === 0;
  await page.tap('#format-bar [data-action="highlight"]');
  await page.waitForTimeout(300);
  check('형광펜 단추: 다시 누르면 지워짐 · 또 누르면 다시', hlOff && (await page.locator('.mk-doc mark').count()) === 1, String(hlOff));
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

  // 이전 버전: 고치기 전 내용으로 되돌리고, 다시 되돌려 방금 내용으로
  await page.tap('#menu-btn');
  await page.tap('[data-memo-action="versions"]');
  await page.waitForTimeout(300);
  const versionCount = await page.locator('#versions-list .version-item').count();
  check('메뉴 › 이전 버전: 고치기 전 내용이 보임', versionCount > 0, String(versionCount));
  if (versionCount) {
    await page.tap('#versions-list .version-restore');
    await page.waitForTimeout(400);
    const docText = () => page.locator('.mk-doc').innerText();
    check('되돌리기 → 파일과 화면이 그 버전으로', !read('회의 메모.md').includes('휴대폰에서 추가') && !(await docText()).includes('휴대폰에서 추가'));
    await shot('05b-versions');
    await page.tap('#versions-list .version-restore'); // 맨 위 = 되돌리기 직전 내용
    await page.waitForTimeout(400);
    check('되돌리기를 되돌림 → 방금 내용 그대로', read('회의 메모.md').includes('휴대폰에서 추가') && (await docText()).includes('휴대폰에서 추가'));
  }
  await back();

  // 홈 화면 위젯: 메뉴 › 홈 화면에 놓기 → 앱에 놓기 요청 + 보일 줄(체크 줄 번호 포함)을 보냄, 고치면 다시 보냄
  {
    const memoId = /^id: (\S+)/m.exec(read('회의 메모.md'))?.[1];
    await page.tap('#menu-btn');
    await page.tap('[data-memo-action="widget"]');
    await page.waitForTimeout(300);
    const wlog = await devLog();
    const sent = wlog.widgetData?.[memoId];
    check('메뉴 › 홈 화면에 놓기: 위젯 놓기 요청 + 제목·줄을 보냄',
      wlog.log.some((l) => l.widgetPin === memoId) && sent?.title === '회의 메모' && sent.file === '회의 메모.md' && sent.lines.length > 0,
      JSON.stringify(sent)?.slice(0, 300));
    await page.locator('.mk-doc p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 위젯');
    await page.waitForTimeout(1500);
    const resent = (await devLog()).widgetData?.[memoId];
    check('위젯: 메모를 고치면 위젯 내용도 다시', JSON.stringify(resent?.lines ?? []).includes('위젯'), JSON.stringify(resent?.lines ?? []).slice(-200));
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(900);
  }

  // 알림 추가
  await page.tap('#bell-btn');
  check('일정과 알림 패널: 처음엔 "무엇을 만들까요?" 한 가지만 · 아래 막대 "취소 | 다음"', await page.isVisible('#rem-kind [data-kind="at"]') && await page.isHidden('#rem-title') && (await page.textContent('#rem-back')) === '취소' && (await page.textContent('#rem-next')) === '다음');
  await shot('05a-rem-kind');
  await page.tap('#rem-kind [data-kind="at"]');
  await shot('05b-rem-when');
  await page.tap('#rem-next');
  await page.tap('.alert-more');
  await shot('05c-rem-alerts');
  check('일정: 언제 → 미리 알림 (지난 시각은 빼고 칩 + 직접 정하기)', (await page.locator('#rem-alerts button').count()) >= 1 && (await page.locator('#rem-alerts button:disabled').count()) === 0 && await page.isVisible('.alert-more') && (await page.locator('.rem-answer').count()) === 2);
  await page.tap('.rem-answer[data-goto="kind"]');
  await page.tap('#rem-kind [data-kind="timer"]');
  await page.tap('#rem-next');
  check('타이머: 언제 → 바로 확인 (미리 알림 단계 없음) · 아래 막대 "이전 | 타이머 추가"', (await page.textContent('#rem-next')) === '타이머 추가' && (await page.textContent('#rem-back')) === '이전' && await page.isHidden('#rem-title'));
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

  // 글 속 날짜 → 알림: 점선 밑줄, 누르면 아래에 "알림 맞추기" 단추 (치는 중에는 뜨지 않음)
  // 뒤로 가기 첫 번은 키보드(초점)를 닫는다 — 메모 화면이 남아 있으면 한 번 더
  for (let i = 0; i < 3 && await page.isVisible('#note-screen'); i++) {
    await back();
    await page.waitForTimeout(400);
  }
  await page.tap('#fab');
  await page.tap('[data-new="text"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.keyboard.type('# 날짜 알림');
  await page.keyboard.press('Enter');
  await page.keyboard.type('내일 오후 3시 치과');
  await page.waitForTimeout(300);
  const dateUnderline = await page.locator('.mk-doc .mk-date').first().textContent().catch(() => '');
  check('날짜 알림: "내일 오후 3시" 에 점선 밑줄', dateUnderline === '내일 오후 3시', dateUnderline);
  check('날짜 알림: 치는 중에는 단추가 뜨지 않음', (await page.locator('.mk-date-chip').count()) === 0);
  {
    const box = await page.locator('.mk-doc .mk-date').first().boundingBox();
    const bar = await page.locator('#format-bar').boundingBox().catch(() => null);
    if (box) await page.touchscreen.tap(box.x + 12, box.y + box.height / 2);
    if (!box) console.log('no date box', JSON.stringify(bar));
  }
  await page.waitForTimeout(300);
  const chipText = await page.textContent('.mk-date-chip').catch(() => '');
  check('날짜 알림: 날짜를 누르면 "📅 일정 추가: 내일 오후 3:00" 단추', /일정 추가: 내일 오후 3:00/.test(chipText), chipText);
  await shot('02c-date-chip');
  await page.tap('.mk-date-chip');
  await page.waitForSelector('.event-dialog[open]', { timeout: 5000 }).catch(() => {});
  const evName = await page.inputValue('#event-name').catch(() => '');
  check('일정 창: 이름을 줄에서 짐작 ("치과")', evName === '치과', evName);
  // 미리 알림: 기본(10분 전)은 빼고 30분 전 · 2시간 전 ("하루 전" 은 오후 3시가 지나면 이미 지난 시각이라 숨겨짐)
  const chipBtn = (label) => page.locator('.event-alerts button', { hasText: label }).first();
  if ((await chipBtn('10분 전').getAttribute('aria-pressed')) === 'true') await chipBtn('10분 전').tap();
  await chipBtn('30분 전').tap();
  await chipBtn('2시간 전').tap();
  await shot('02c2-event-dialog');
  await page.tap('#event-save');
  await page.waitForTimeout(800);
  const dateMemo = fs.existsSync(path.join(vault, '날짜 알림.md')) ? read('날짜 알림.md') : '';
  const tomorrow3 = new Date();
  tomorrow3.setDate(tomorrow3.getDate() + 1);
  tomorrow3.setHours(15, 0, 0, 0);
  const atLine = /\n\s+at: "?([^"\n]+)"?/.exec(dateMemo)?.[1];
  check('일정 저장: 내일 15:00 · 이름 치과 · 미리 알림 2시간 전과 30분 전', Boolean(atLine) && Math.abs(Date.parse(atLine) - tomorrow3.getTime()) < 60_000
    && /title: 치과/.test(dateMemo) && /alerts:\s*\n\s*- 120\s*\n\s*- 30/.test(dateMemo), dateMemo.slice(0, 400));
  {
    const sched = (await devLog()).scheduled.filter((x) => x.memoId && /치과/.test(x.title ?? ''));
    const times = sched.map((x) => x.at).sort();
    check('휴대폰 시스템 알람: 일정 시각이 아니라 2시간 전·30분 전에 (제목 치과)',
      times.length === 2 && Math.abs(times[0] - (tomorrow3.getTime() - 120 * 60_000)) < 60_000 && Math.abs(times[1] - (tomorrow3.getTime() - 30 * 60_000)) < 60_000,
      JSON.stringify(sched.map((x) => [new Date(x.at).toString().slice(4, 21), x.title, x.label])));
  }
  check('날짜 알림: 맞춘 날짜는 실선 밑줄', (await page.locator('.mk-doc .mk-date-set').count()) === 1);
  // 되풀이: "매주 수요일 저녁 7시" → 반복 일정 (줄 끝을 눌러 커서를 옮긴 뒤 새 줄에)
  {
    const line = await page.locator('.mk-doc p').last().boundingBox();
    await page.touchscreen.tap(line.x + line.width - 4, line.y + line.height / 2);
    await page.waitForTimeout(200);
  }
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('매주 수요일 저녁 7시 운동');
  await page.waitForTimeout(300);
  {
    const boxes = await page.locator('.mk-doc .mk-date').all();
    const box = await boxes.at(-1)?.boundingBox();
    if (box) await page.touchscreen.tap(box.x + 12, box.y + box.height / 2);
  }
  await page.waitForTimeout(300);
  const repChip = await page.textContent('.mk-date-chip').catch(() => '');
  check('날짜 알림: "매주 수요일 저녁 7시" → 반복 일정 단추', /일정 추가: 매주 수요일 오후 7:00/.test(repChip ?? ''), repChip);
  if (repChip) await page.tap('.mk-date-chip');
  await page.waitForSelector('.event-dialog[open]', { timeout: 5000 }).catch(() => {});
  check('일정 창(반복): 🔁 매주 수요일 표시 · 이름 "운동"', /매주 수요일/.test(await page.textContent('.event-dialog .event-repeat').catch(() => '')) && (await page.inputValue('#event-name').catch(() => '')) === '운동');
  await page.tap('#event-save');
  await page.waitForTimeout(800);
  const repMd = fs.existsSync(path.join(vault, '날짜 알림.md')) ? read('날짜 알림.md') : '';
  check('날짜 알림: 반복 알림으로 저장 (매주 수 19:00)', /kind: repeat[\s\S]*every: week[\s\S]*weekdays:\s*\n?\s*-?\s*\[?3/.test(repMd) && /time: "?19:00/.test(repMd), repMd.slice(0, 500));
  // 목록 › 일정 탭: 한 달 달력 + 고른 날·다가오는 일정 (치과는 내일, 미리 알림 함께)
  for (let k = 0; k < 3 && await page.isVisible('#note-screen'); k++) {
    await back();
    await page.waitForTimeout(400);
  }
  await page.tap('[data-tab="reminders"]');
  await page.waitForTimeout(500);
  const cal = await page.evaluate(() => ({
    days: document.querySelectorAll('#reminder-groups [role="gridcell"][data-date]').length,
    rows: [...document.querySelectorAll('#reminder-groups .ev-row')].map((r) => r.textContent),
  }));
  check('일정 탭: 달력 42칸 · 다가오는 일정에 "치과 · 알림 30분 전, 2시간 전"', cal.days === 42 && cal.rows.some((t) => /치과/.test(t) && /알림 30분 전, 2시간 전/.test(t)), JSON.stringify(cal));
  await shot('02g-calendar');
  check('일정 탭: + 버튼 없음 (보관함처럼)', await page.isHidden('#fab'));
  // 달력 크기가 가만히 있는가 (예전: 휴대폰에서 달력 높이 ↔ 남은 자리가 서로 맞물려 끝없이 깜빡임)
  const calHeights = () => page.evaluate(() => new Promise((done) => {
    const seen = new Set();
    let n = 0;
    const tick = () => {
      seen.add(Math.round(document.querySelector('#reminder-groups .cal').getBoundingClientRect().height));
      if (++n < 30) requestAnimationFrame(tick);
      else done([...seen]);
    };
    tick();
  }));
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now0 = new Date();
  const otherDay = ymd(new Date(now0.getFullYear(), now0.getMonth(), now0.getDate() === 10 ? 11 : 10));
  const steady = [];
  for (const size of [{ width: 412, height: 922 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    const before = await calHeights();
    const tapped = await page.tap(`#reminder-groups [role="gridcell"][data-date="${otherDay}"]`, { timeout: 3000, position: { x: 6, y: 6 } }).then(() => true, () => false);
    await page.waitForTimeout(300);
    steady.push({ size: `${size.width}x${size.height}`, before, tapped, after: await calHeights() });
  }
  check('일정 탭: 달력이 깜빡이지 않음 (날을 눌러도 높이 그대로)', steady.every((s) => s.before.length === 1 && s.tapped && s.after.length === 1), JSON.stringify(steady));
  await page.tap(`#reminder-groups [role="gridcell"][data-date="${ymd(now0)}"]`, { timeout: 3000, position: { x: 6, y: 6 } }).catch(() => {}); // 다시 오늘
  await page.waitForTimeout(300);
  // 달력에서 바로 일정 만들기: 고른 날 › ＋ 일정 추가 → 이름·시각 → 미리 알림 → 새 메모 / 있는 메모
  await page.tap('.ev-add');
  await page.waitForSelector('.quick-event[open]');
  check('바로 일정 추가: 처음엔 이름·시각만 (미리 알림·메모 고르기는 숨김)', await page.isVisible('.qe-name') && await page.isHidden('.quick-event [data-step="alerts"]') && await page.isHidden('.qe-new'));
  await page.fill('.qe-name', '팀 점심');
  const qeNext = '.quick-event .flow-footer .btn.primary';
  await page.tap(qeNext);
  await page.tap(qeNext);
  await shot('02h-quick-event-memo');
  check('바로 일정 추가: 마지막엔 "새 메모"(처음 골라 둠) · 메모 목록 · 아래 단추 "새 메모로 만들기"', /팀 점심/.test(await page.textContent('.qe-new')) && (await page.getAttribute('.qe-new', 'aria-checked')) === 'true' && (await page.locator('.qe-memo').count()) > 1 && (await page.textContent(qeNext)) === '새 메모로 만들기');
  await page.tap(qeNext);
  await page.waitForTimeout(600);
  const lunch = fs.existsSync(path.join(vault, '팀 점심.md')) ? read('팀 점심.md') : '';
  check('바로 일정 추가: 일정 이름으로 새 메모 + 일정', /^# 팀 점심/m.test(lunch) && /kind: at/.test(lunch), lunch.slice(0, 300));
  await page.tap('.ev-add');
  await page.waitForSelector('.quick-event[open]');
  await page.fill('.qe-name', '주간 보고');
  await page.tap(qeNext);
  await page.tap(qeNext);
  await page.fill('.qe-search', '회의');
  await page.waitForTimeout(200);
  await page.tap('.qe-memo:not(.qe-new)');
  check('바로 일정 추가: 메모를 고르면 아래 단추가 "\'회의 메모\'에 넣기"', (await page.textContent(qeNext)) === "'회의 메모'에 넣기", await page.textContent(qeNext));
  await page.tap(qeNext);
  await page.waitForTimeout(600);
  check('바로 일정 추가: 있는 메모를 고르면 그 메모에 일정', /title: 주간 보고/.test(read('회의 메모.md')), read('회의 메모.md').slice(0, 400));
  // 다른 캘린더: 휴대폰 캘린더(삼성 캘린더) 켜기 → 달력 · 다가오는 일정에 함께, 일정 줄의 보내기 → 캘린더 앱 새 일정
  await page.tap('.cal-link');
  await page.waitForSelector('.cal-links[open]');
  check('다른 캘린더: 주소 칸은 접혀 있다가 "＋ iCal 주소로" 를 누르면 열림', await page.isHidden('.feed-add') && await page.isVisible('.feed-open-add'));
  await page.tap('.feed-open-add');
  check('다른 캘린더: 주소 칸이 비면 "추가" 를 누를 수 없음 (빨간 꾸중 없음)', await page.isVisible('.feed-add') && await page.isDisabled('.feed-add .btn') && !(await page.textContent('.feed-add + .feed-note')));
  // 뒤로 가기: 창만 닫고 일정 탭 그대로 (예전: 창은 떠 있고 뒤 화면만 메모 탭으로)
  await back();
  await page.waitForTimeout(300);
  check('다른 캘린더: 뒤로 가기는 창을 닫고 일정 탭 그대로', !(await page.isVisible('.cal-links[open]')) && await page.isVisible('#reminder-groups .cal'));
  await page.tap('.cal-link');
  await page.waitForSelector('.cal-links[open]');
  check('다른 캘린더 창: 읽기 · 쓰기 꼬리표 (주고받기 읽기 + 쓰기 · 함께 보기 읽기만 · 보내기 쓰기만)',
    JSON.stringify(await page.$$eval('.cal-links .cal-perm', (n) => n.map((x) => x.textContent))) === JSON.stringify(['읽기 + 쓰기', '읽기만', '쓰기만']));
  await page.tap('.feed-device .switch');
  await page.waitForTimeout(300);
  check('다른 캘린더: 휴대폰 캘린더 켜기 (권한 허용)', await page.isChecked('.feed-device .switch'));
  await shot('02i-calendar-links');
  await page.tap('.cal-links .dialog-actions .btn');
  await page.waitForTimeout(800);
  const ext = await page.evaluate(() => ({
    bars: [...document.querySelectorAll('#reminder-groups .mk-ext')].map((e) => e.title),
    rows: [...document.querySelectorAll('#reminder-groups .ev-ext .row-title')].map((e) => e.textContent),
  }));
  check('다른 캘린더: 삼성 캘린더 일정이 달력(점선) · 다가오는 일정에 함께', ext.bars.some((t) => /삼성 캘린더/.test(t)) && ext.rows.includes('가족 저녁'), JSON.stringify(ext));
  await shot('02j-calendar-device');
  // 일정을 누르면 다른 캘린더 앱으로 나가지 않고 메모킹 안에서 자세히 보기 (예전: 캘린더 앱 → "일정을 찾을 수 없습니다")
  const viewsBefore = (await devLog()).log.filter((l) => l.calendarView).length;
  await page.tap('.ev-ext .row-main >> nth=0');
  await page.waitForSelector('.event-detail[open]');
  const detail = await page.evaluate(() => ({
    title: document.querySelector('.event-detail h2')?.textContent,
    badge: document.querySelector('.event-detail .ed-badge')?.textContent,
    note: document.querySelector('.event-detail .ed-note')?.textContent ?? '',
    buttons: [...document.querySelectorAll('.event-detail .ed-actions .btn')].map((b) => b.textContent),
  }));
  await page.waitForTimeout(400);
  await shot('02j2-event-detail');
  const viewsAfter = (await devLog()).log.filter((l) => l.calendarView).length;
  check('일정 누르기: 다른 캘린더 일정 → 메모킹 안의 자세히 보기 (보기만 · 메모로 가져오기), 캘린더 앱은 안 열림',
    Boolean(detail.title) && detail.badge === '보기만' && detail.buttons.includes('메모로 가져오기') && viewsAfter === viewsBefore, JSON.stringify(detail));
  if (detail.title === '가족 저녁') check('자세히 보기: 일정 설명을 줄 그대로 (HTML 줄바꿈)', detail.note === '엄마 아빠랑\n7시까지 도착', JSON.stringify(detail.note));
  await back();
  await page.waitForTimeout(200);
  await page.tap('.ev-row:not(.ev-ext) .row-main >> nth=0');
  await page.waitForSelector('.event-detail[open]');
  const memoDetail = await page.evaluate(() => [...document.querySelectorAll('.event-detail .ed-actions .btn')].map((b) => b.textContent));
  check('일정 누르기: 메모킹 일정 → 자세히 보기 (메모 열기 · 일정 지우기)', memoDetail.includes('메모 열기') && memoDetail.includes('일정 지우기'), JSON.stringify(memoDetail));
  await page.tap('.event-detail .dialog-x');
  await page.waitForTimeout(200);
  await page.tap('.ev-row:not(.ev-ext) .ev-send');
  await page.waitForTimeout(300);
  const inserted = (await devLog()).log.find((l) => l.calendarInsert)?.calendarInsert;
  check('보내기: 일정 줄의 단추 → 휴대폰 캘린더 앱 새 일정 (이름 · 시각)', Boolean(inserted?.title) && inserted.start > 0, JSON.stringify(inserted));
  // Google 캘린더 상호 동기화: 연결 → 메모킹 일정이 "메모킹" 캘린더로, 그 캘린더에서 만든 일정 → 새 메모
  await page.tap('.cal-link');
  await page.waitForSelector('.cal-links[open]');
  await page.tap('.gsync .btn.primary');
  await page.waitForFunction(() => /맞췄어요|맞추고 있어요/.test(document.querySelector('.gsync')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
  const gcal = await (await fetch(`${base}/dev/gcal`)).json();
  const pushedTitles = gcal.events.filter((e) => e.status !== 'cancelled').map((e) => e.summary);
  check('Google 캘린더 동기화: 연결하면 "메모킹" 캘린더를 만들고 메모킹 일정을 넣음', gcal.calendars.length === 1 && pushedTitles.includes('치과'), JSON.stringify(pushedTitles));
  await shot('02l-google-sync');
  await fetch(`${base}/dev/gcal`, { method: 'POST', body: JSON.stringify({ summary: '삼성 캘린더 회의', start: { dateTime: new Date(Date.now() + 3 * 86_400_000).toISOString() }, end: { dateTime: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString() } }) });
  await page.tap('.gsync .btn:not(.primary)');
  await page.waitForTimeout(1500);
  check('Google 캘린더 동기화: 그 캘린더에서 만든 일정 → 새 메모 (일정 포함)', fs.existsSync(path.join(vault, '삼성 캘린더 회의.md')) && /kind: at/.test(read('삼성 캘린더 회의.md')));
  check('Google 캘린더 동기화: 상태 파일은 메모 폴더(_memoking, Drive 로 PC 와 함께)', fs.existsSync(path.join(vault, '_memoking', 'google-calendar.json')));
  await page.tap('.cal-links .dialog-actions .btn');
  await page.waitForTimeout(400);
  check('Google 캘린더 동기화: 일정 탭 단추에 "Google 캘린더와 맞춤"', /Google 캘린더와 맞춤/.test(await page.textContent('.cal-link')));
  for (const [view, name] of [['timeGridWeek', '주'], ['listMonth', '목록']]) {
    await page.tap(`[data-view="${view}"]`);
    await page.waitForTimeout(500);
    const shown = await page.evaluate(() => ({ h: document.querySelector('.cal-body').getBoundingClientRect().height, n: document.querySelectorAll('#reminder-groups .mk-ev').length }));
    check(`달력 보기: ${name} (일정이 보임)`, shown.h > 200 && shown.n > 0, JSON.stringify(shown));
    await shot(`02k-calendar-${view}`);
  }
  await page.tap('[data-view="dayGridMonth"]');
  await page.waitForTimeout(300);
  await page.tap('[data-tab="memos"]');
  await page.waitForTimeout(300);

  await back();
  await page.waitForTimeout(300);
  for (let i = 0; i < 3 && await page.isVisible('#note-screen'); i++) {
    await back();
    await page.waitForTimeout(400);
  }

  // 위젯 고르기 목록에서 놓은 위젯을 누름 → 앱이 열리고 안내, 누르는 메모가 그 위젯에 (메모는 열지 않음)
  await post('/dev/intent', { type: 'widget-pick', widgetId: 7 });
  await page.evaluate(() => window.__mk.emit('intent', null));
  await page.waitForTimeout(400);
  const pickToast = await page.textContent('#toast').catch(() => '');
  await page.tap('.card[data-id="00000000-0000-4000-8000-000000000001"]');
  await page.waitForTimeout(400);
  const picked = (await devLog()).log.find((l) => l.widgetAssign)?.widgetAssign;
  check('위젯 고르기: 안내 후 누른 메모를 그 위젯에 (메모는 열지 않음)',
    /위젯에 보일 메모/.test(pickToast ?? '') && picked?.[0] === 7 && picked?.[1] === '00000000-0000-4000-8000-000000000001' && await page.isHidden('#note-screen'),
    JSON.stringify({ pickToast, picked }));

  // 위젯 고르기를 시작하고 그냥 + 새 메모를 누르면: 고르기는 끝나고 새 메모가 열린다 (위젯에 놓이지 않음)
  {
    const assignsBefore = (await devLog()).log.filter((l) => l.widgetAssign).length;
    await post('/dev/intent', { type: 'widget-pick', widgetId: 8 });
    await page.evaluate(() => window.__mk.emit('intent', null));
    await page.waitForTimeout(400);
    await page.tap('#fab');
    await page.tap('[data-new="text"]');
    await page.waitForTimeout(500);
    const assignsAfter = (await devLog()).log.filter((l) => l.widgetAssign).length;
    check('위젯 고르기 중 + 새 메모: 메모가 열리고 위젯에 놓이지 않음', assignsAfter === assignsBefore && await page.isVisible('#note-screen'),
      JSON.stringify({ assignsBefore, assignsAfter }));
    for (let i = 0; i < 3 && await page.isVisible('#note-screen'); i++) {
      await back();
      await page.waitForTimeout(400);
    }
  }

  // 잠금 메모: 메뉴 › 잠그기 → 파일에 풀린 글 없음, 쓰는 동안도 잠근 채 저장, 닫았다 열면 비밀번호 → 잠금 풀기
  {
    await page.tap('#fab');
    await page.tap('[data-new="text"]');
    await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
    await page.keyboard.type('# 휴대폰 비밀');
    await page.keyboard.press('Enter');
    await page.keyboard.type('현관 비번 4321');
    await page.waitForTimeout(900);
    const lockMd = () => (fs.existsSync(path.join(vault, '휴대폰 비밀.md')) ? read('휴대폰 비밀.md') : '');
    await page.tap('#menu-btn');
    await page.tap('[data-memo-action="lock"]');
    await page.waitForSelector('.lock-dialog[open]');
    await page.fill('#lock-pass-1', 'abcd1234');
    await page.fill('#lock-pass-2', 'abcd1234');
    await shot('02e-lock-dialog');
    await page.tap('.lock-dialog .btn.primary');
    await page.waitForSelector('.lock-dialog', { state: 'detached', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    const allVault = () => fs.readdirSync(vault, { recursive: true }).map((f) => path.join(vault, f)).filter((f) => fs.statSync(f).isFile() && /\.(md|json)$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    check('휴대폰 잠그기: 파일·버전에 풀린 글 없음, 제목만', /memoking-lock v1/.test(lockMd()) && /# 휴대폰 비밀/.test(lockMd()) && !allVault().includes('현관 비번'), lockMd().slice(0, 200));
    await page.locator('.mk-doc p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 바꿈');
    await page.waitForTimeout(1500);
    check('휴대폰 잠긴 메모: 쓰는 동안도 잠근 글로 저장', !allVault().includes('바꿈') && /memoking-lock/.test(lockMd()));
    for (let k = 0; k < 3 && await page.isVisible('#note-screen'); k++) {
      await back();
      await page.waitForTimeout(400);
    }
    const lockedId = /^id: (\S+)/m.exec(lockMd())?.[1];
    await page.tap(`.card[data-id="${lockedId}"]`);
    await page.waitForSelector('.lock-screen');
    await page.waitForTimeout(400); // 메모 화면이 다 나타난 뒤
    await shot('02f-lock-screen');
    await page.fill('#lock-open-pass', 'nope1234');
    await page.tap('.lock-screen .btn.primary');
    await page.waitForFunction(() => /비밀번호가 달라요/.test(document.querySelector('.lock-screen .lock-error')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
    const wrongMsg = await page.textContent('.lock-screen .lock-error').catch(() => '');
    await page.fill('#lock-open-pass', 'abcd1234');
    await page.tap('.lock-screen .btn.primary');
    await page.waitForSelector('#note-screen .ProseMirror', { timeout: 15000 }).catch(() => {});
    const openedText = await page.locator('.mk-doc').innerText().catch(() => '');
    check('휴대폰 잠긴 메모: 틀리면 안내, 맞으면 열림', /비밀번호가 달라요/.test(wrongMsg ?? '') && openedText.includes('바꿈'), JSON.stringify({ wrongMsg, openedText: openedText.slice(0, 80) }));
    await page.tap('#menu-btn');
    const unlockLabel = await page.textContent('[data-memo-action="lock"] span');
    await page.tap('[data-memo-action="lock"]');
    await page.waitForSelector('#confirm-dialog[open]');
    await page.tap('#confirm-ok');
    await page.waitForTimeout(600);
    check('휴대폰 잠금 풀기: 메뉴 "잠금 풀기" · 풀면 파일에 원래 글', unlockLabel === '잠금 풀기' && lockMd().includes('현관 비번') && !/memoking-lock/.test(lockMd()), unlockLabel);
    for (let k = 0; k < 3 && await page.isVisible('#note-screen'); k++) {
      await back();
      await page.waitForTimeout(400);
    }
  }

  // 이어 쓰기: PC 에서 방금 고친 메모가 들어오면 "PC에서 방금 고친 메모: … [열기]"
  {
    const nowIso = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
    write('PC에서 쓴 메모.md', `---\nid: 00000000-0000-4000-8000-0000000000pc\ncreated: ${nowIso}\nupdated: ${nowIso}\ncolor: blue\ndevice: pc\n---\n# PC에서 쓴 메모\n\n회의 정리\n`);
    await page.evaluate(() => window.__mk.emit('app', 'resume'));
    await page.waitForTimeout(800);
    const handoffToast = await page.textContent('#toast-text').catch(() => '');
    const hasOpen = await page.isVisible('#toast-action');
    check('이어 쓰기: PC에서 방금 고친 메모를 알리고 [열기]', /PC에서 방금 고친 메모: PC에서 쓴 메모/.test(handoffToast ?? '') && hasOpen, handoffToast);
    await shot('02d-handoff');
    if (hasOpen) await page.tap('#toast-action');
    await page.waitForTimeout(600);
    check('이어 쓰기: [열기] 를 누르면 그 메모', (await page.locator('.mk-doc h1').first().textContent().catch(() => '')) === 'PC에서 쓴 메모');
    for (let k = 0; k < 3 && await page.isVisible('#note-screen'); k++) {
      await back();
      await page.waitForTimeout(400);
    }
  }

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
  check('공유하기: 출처 한 줄', /> 출처: Chrome, /.test(sharedText));
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
  // 목록 카드를 누른 채 좌우로 흔들기: 카드만 손가락을 따라가고 화면은 옆으로 끌리지 않음 · 메뉴 안 뜸 · 제자리에서 놓으면 그대로
  {
    for (let k = 0; k < 3 && await page.isVisible('#note-screen'); k++) {
      await back();
      await page.waitForTimeout(400);
    }
    const cardSel = '.card[data-id="00000000-0000-4000-8000-000000000001"]';
    const box = await page.locator(cardSel).boundingBox();
    const cy = box.y + box.height / 2;
    const cx = box.x + box.width / 2;
    await touch('touchStart', cx, cy);
    const seen = [];
    for (const dx of [20, 50, 80, 30, -20, -60, -90, -30, 20, 60, 10]) {
      await touch('touchMove', cx + dx, cy);
      await page.waitForTimeout(20);
      seen.push(await page.evaluate((sel) => ({ t: document.querySelector(sel).style.transform, sl: document.querySelector('#list-screen .view:not([hidden])')?.scrollLeft ?? 0 }), cardSel));
    }
    await touch('touchMove', cx + 2, cy);
    await page.waitForTimeout(40);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(350);
    const follows = seen.some((x) => /translate3d\(-\d/.test(x.t)) && seen.some((x) => /translate3d\(\d/.test(x.t));
    check('목록 카드 좌우로 흔들기: 카드만 따라오고 화면은 그대로 · 놓으면 제자리', follows && seen.every((x) => x.sl === 0)
      && await page.isVisible(cardSel) && await page.isHidden('#memo-sheet') && !(await page.$eval(cardSel, (c) => c.style.transform)), JSON.stringify(seen.slice(0, 4)));
    const cardX = () => page.$eval(cardSel, (c) => c.style.transform);
    // 처음에 위아래로 조금 흔들리며(비스듬히) 밀어도 밀린다
    await touch('touchStart', cx, cy);
    for (const [mx, my] of [[3, 5], [8, 8], [20, 11], [45, 13], [70, 14]]) await touch('touchMove', cx + mx, cy + my);
    await page.waitForTimeout(40);
    const diag = await cardX();
    await touch('touchMove', cx + 2, cy + 14);
    await page.waitForTimeout(40);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(300);
    check('목록 카드: 비스듬히 밀어도(처음에 위아래로 조금 흔들려도) 밀림', /translate3d\(\d/.test(diag), diag);
    // 꾹 눌렀다가(메뉴가 뜰 때쯤) 그대로 옆으로 밀면 메뉴 대신 밀기
    await touch('touchStart', cx, cy);
    await page.waitForTimeout(30);
    await page.dispatchEvent(cardSel, 'contextmenu');
    for (const mx of [-12, -30, -60]) await touch('touchMove', cx + mx, cy);
    await page.waitForTimeout(40);
    const held = await cardX();
    await touch('touchMove', cx - 2, cy);
    await page.waitForTimeout(40);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(350);
    check('목록 카드: 꾹 눌렀다가 밀면 메뉴 대신 밀기', /translate3d\(-\d/.test(held) && await page.isHidden('#memo-sheet'), held);
    // 꾹 누르고 밀지 않고 떼면 메뉴 (실제 길게 누르기처럼 오래 누른 뒤 떼야 "눌림" 이 따라오지 않는다)
    await touch('touchStart', cx, cy);
    await page.waitForTimeout(30);
    await page.dispatchEvent(cardSel, 'contextmenu');
    await page.waitForTimeout(700);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(400);
    check('목록 카드: 꾹 누르고 떼면 메뉴', await page.isVisible('#memo-sheet'), JSON.stringify(await page.evaluate(() => ({
      note: !document.getElementById('note-screen').hidden, sheet: document.getElementById('memo-sheet').className, hidden: document.getElementById('memo-sheet').hidden,
    }))));
    await back();
    await page.waitForTimeout(400);
  }
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
  const moveHintDbg = await page.evaluate(() => ({ mode: document.querySelector('.mode-knob')?.dataset.mode, hint: document.querySelector('.mk-move-hint')?.textContent ?? null,
    seen: localStorage.getItem('memoking.hint.blockMove'), sel: document.querySelector('.ProseMirror-selectednode')?.className ?? null }));
  check('그림 줄 옮기기: 처음 한 번 옮기는 방법 안내 (옮기기 방식: 짧게 눌러)', (moveHintDbg.hint ?? '').includes('짧게 눌러'), JSON.stringify(moveHintDbg));
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
  check('다이얼: 한 번 본 방식의 안내는 다시 뜨지 않음 (메모를 가리지 않게)', nextMove === 'move' && await page.isHidden('#mode-guide'));
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
  // 둘 중 하나(켜고 끄기)는 모두 같은 스위치 — 말한 사람 나누기·S펜 손글씨도 (예전엔 단추·목록 상자)
  check('설정: 켜고 끄기는 모두 스위치 (단추·목록 상자 없음)', (await page.locator('#spk-btn, select#pen-writing').count()) === 0
    && (await page.locator('#spk-switch.switch, #pen-writing.switch').count()) === 2);
  check('설정: 말한 사람 나누기 (처음엔 꺼짐, 켜면 데이터를 받는다고 안내)', await page.isVisible('#spk-row') && !(await page.isChecked('#spk-switch')) && (await page.textContent('#spk-note')).includes('켜면 데이터'));
  await page.tap('#spk-row');
  await page.waitForTimeout(400);
  check('설정: 말한 사람 나누기 켜기 → 받고 켜짐', await page.isChecked('#spk-switch'));
  await page.tap('#spk-row');
  await page.waitForTimeout(400);
  check('설정: 말한 사람 나누기 끄기', !(await page.isChecked('#spk-switch')));
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

  // 끌어서 고른 줄만 목록으로: 앞 줄 맨 끝에서 시작한 선택은 그 줄을 빼고, 고른 줄마다 항목 하나
  await newText();
  await page.keyboard.type('# 고른 줄 목록');
  for (const t of ['머리 줄', '하나', '둘', '셋']) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(t);
  }
  const selectLines = (startText, endText) => page.evaluate(([a, b]) => {
    const ps = [...document.querySelectorAll('#note-screen .mk-doc p')];
    const pa = ps.find((p) => p.textContent === a);
    const pb = ps.find((p) => p.textContent === b);
    const r = document.createRange();
    r.setStart(pa.firstChild, pa.textContent.length); // 앞 줄의 맨 끝에서
    r.setEnd(pb.firstChild, pb.textContent.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  }, [startText, endText]);
  await selectLines('머리 줄', '셋');
  await page.waitForTimeout(150);
  await page.click('#format-bar [data-cmd="bullet"]');
  await page.waitForTimeout(900);
  let g = fileWith('고른 줄 목록');
  check('끌어 고른 줄 목록: 앞 줄 끝에서 시작해도 그 줄은 그대로 · 고른 줄마다 항목 하나', g && /\n머리 줄\n\n- 하나\n- 둘\n- 셋/.test(read(g)), g && read(g));
  // 목록과 그 아래 글 줄을 함께 고르면 모두 한 목록으로 (줄마다 항목)
  await page.evaluate(() => { // 커서를 "셋" 끝에 (고른 범위를 풀고)
    const p = [...document.querySelectorAll('#note-screen .mk-doc li p')].find((x) => x.textContent === '셋');
    getSelection().collapse(p.firstChild, p.textContent.length);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // 빈 항목에서 Enter → 목록 밖 글 줄로
  await page.keyboard.type('넷');
  await page.keyboard.press('Enter');
  await page.keyboard.type('다섯');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('#note-screen .mk-doc li p')];
    const ps = [...document.querySelectorAll('#note-screen .mk-doc > p')];
    const first = items.find((p) => p.textContent === '둘');
    const last = ps.find((p) => p.textContent === '다섯');
    const r = document.createRange();
    r.setStart(first.firstChild, 0);
    r.setEnd(last.firstChild, last.textContent.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForTimeout(150);
  await page.click('#format-bar [data-cmd="ordered"]');
  await page.waitForTimeout(900);
  check('목록 + 아래 글 줄을 함께 고르면 줄마다 항목인 한 목록으로', /1\. 하나\n2\. 둘\n3\. 셋\n4\. 넷\n5\. 다섯/.test(read(g)), read(g));
  await back();
  await page.waitForTimeout(300);

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
  // 끌지 않고 순서 바꾸기: 도구막대의 한 줄 위로 · 아래로 (커서는 "감")
  check('한 줄 아래로: 마지막 항목이면 흐리게', await page.isDisabled('#format-bar [data-cmd="moveDown"]'));
  await page.click('#format-bar [data-cmd="moveUp"]');
  await page.waitForTimeout(900);
  check('한 줄 위로 → 항목 하나가 위로', /- \[ \] 사과\n- \[ \] 감\n- \[ \] 배/.test(read(f)), read(f));
  await page.click('#format-bar [data-cmd="moveDown"]');
  await page.waitForTimeout(900);
  check('한 줄 아래로 → 제자리', /- \[ \] 사과\n- \[ \] 배\n- \[ \] 감/.test(read(f)), read(f));
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
  await page.waitForSelector('#print-sheet:not([hidden])');
  check('PDF: 먼저 내용 크기 고르기 (작게·보통·크게·아주 크게 + 직접)', (await page.locator('#print-size-seg [data-scale]').count()) === 4 && await page.isVisible('#print-scale'));
  await page.tap('#print-size-seg [data-scale="1.2"]');
  await page.waitForTimeout(400);
  check('PDF: 크기를 고르면 미리보기도 그 크기로', /zoom: 1\.2/.test(await page.$eval('#print-frame', (f) => f.srcdoc)) && (await page.textContent('#print-scale-out')) === '120%');
  await shot('09b-print-size');
  await page.tap('#print-go');
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
  check('보내기 PDF: 고른 크기(120%)로', /\.print-doc \{ zoom: 1\.2; \}/.test(pdfHtml));
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
  const overlap = await page.evaluate(() => {
    const stop = document.getElementById('rec-stop').getBoundingClientRect();
    return [...document.querySelectorAll('.mk-dial, #add-btn')].some((f) => {
      const r = f.getBoundingClientRect();
      return r.width && r.left < stop.right && r.right > stop.left && r.top < stop.bottom && r.bottom > stop.top;
    });
  });
  check('녹음: 다이얼 · + 단추가 끝내기 단추를 가리지 않음', !overlap);
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
  check('꾹 눌렀다 놓으면: 오른쪽 위에 지우기 단추 · 그 왼쪽에 복사 단추', await page.isVisible('.mk-delete-btn') && await page.isVisible('.mk-copy-btn'));
  await shot('18b-delete-btn');
  // 복사 단추: 그림은 그림 자체(PNG)로 휴대폰 클립보드에 · 누르면 ✓
  const copiedBefore = (await devLog()).log.filter((x) => x.copyImage).length;
  await page.tap('.mk-copy-btn');
  await page.waitForTimeout(600);
  const logNow = await devLog();
  const copies = logNow.log.filter((x) => x.copyImage);
  check('복사 단추: 그림을 그림 그대로 클립보드에 · ✓ 표시', copies.length > copiedBefore && copies.at(-1).copyImage.bytes > 50 && await page.isVisible('.mk-copy-btn.done'), JSON.stringify(copies.at(-1)));
  await page.waitForTimeout(2500);
  check('지우기 단추: 2초 뒤 사라짐', (await page.locator('.mk-delete-btn').count()) === 0);
  await touch('touchStart', ib.x + 40, ib.y + 40);
  await page.waitForTimeout(650);
  await touch('touchEnd', ib.x + 40, ib.y + 40);
  await page.waitForTimeout(150);
  await page.tap('.mk-delete-btn');
  await page.waitForTimeout(1200);
  check('지우기 단추: 누르면 그 그림만 지움', (await page.locator('img.mk-image').count()) === 1 && !read('그림 둘.md').includes('two-a.png') && read('그림 둘.md').includes('two-b.png'), read('그림 둘.md'));
  // 글 고치기 방식에서도 그림을 짧게 누르면(탭): 저장 · 복사 · 지우기 단추
  await setMode('edit');
  {
    const ib2 = await page.locator('img.mk-image').first().boundingBox();
    await touch('touchStart', ib2.x + 40, ib2.y + 40);
    await page.waitForTimeout(80);
    await touch('touchEnd', ib2.x + 40, ib2.y + 40);
    await page.waitForTimeout(250);
    const shown = await page.isVisible('.mk-delete-btn') && await page.isVisible('.mk-copy-btn') && await page.isVisible('.mk-save-btn');
    const order = await page.evaluate(() => ['.mk-save-btn', '.mk-copy-btn', '.mk-delete-btn'].map((s) => Math.round(document.querySelector(s)?.getBoundingClientRect().left ?? -1)));
    check('글 고치기 방식: 그림을 짧게 누르면 저장 · 복사 · × 단추 (왼쪽부터)', shown && order[0] < order[1] && order[1] < order[2], JSON.stringify({ shown, order }));
    await shot('18c-tap-buttons');
    // 저장 단추: 메모 폴더의 사진은 원본 파일 그대로 안드로이드 저장 창으로
    await page.tap('.mk-save-btn');
    await page.waitForTimeout(500);
    const saves = (await devLog()).log.filter((x) => x.saveAs);
    check('저장 단추: 사진은 원본 파일 그대로 저장 · ✓', saves.at(-1)?.saveAs.rel === 'attachments/two-b.png' && saves.at(-1).saveAs.name === 'two-b.png' && await page.isVisible('.mk-save-btn.done'), JSON.stringify(saves.at(-1)));
    // 복사한 그림을 메모에 붙여 넣기 (WebView 는 클립보드의 그림을 주지 않고 주소 글만 — 앱이 클립보드에서 읽어 넣음)
    await page.tap('.mk-copy-btn');
    await page.waitForTimeout(500);
    const before = await page.locator('img.mk-image').count();
    await page.locator('.mk-doc p', { hasText: '끝' }).tap();
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'content://com.memoking.app.files/share/%EB%A9%94%EB%AA%A8%ED%82%B9%20%EA%B7%B8%EB%A6%BC.png');
      document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(800);
    const after = await page.locator('img.mk-image').count();
    await page.waitForTimeout(800);
    check('복사한 그림 붙여 넣기: 클립보드의 그림이 첨부로 메모에 (주소 글이 아니라)', after === before + 1 && !read('그림 둘.md').includes('content://') && (read('그림 둘.md').match(/!\[[^\]]*\]\(attachments\//g) ?? []).length === 2, JSON.stringify({ before, after, file: read('그림 둘.md').split('---').pop() }));
  }
  // 음성 카드 · 소리 이름 줄을 짧게 누르면, 파일 칩은 꾹 누르면(글 고치기 방식): 공유 · 저장 · 복사 · × 단추
  {
    fs.writeFileSync(path.join(vault, 'attachments/voice-btn.m4a'), Buffer.from('fake audio'));
    fs.writeFileSync(path.join(vault, 'attachments/안내서.pdf'), Buffer.from('%PDF-1.4 fake'));
    write('콘텐츠 단추.md', '---\nid: 00000000-0000-4000-8000-0000000000dd\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: purple\n---\n# 콘텐츠 단추\n\n> ![녹음 10월 14일](attachments/voice-btn.m4a)\n>\n> 도레미파솔라시도\n\n[안내서.pdf](attachments/안내서.pdf)\n\n$$\nx^2\n$$\n\n끝\n');
    await back();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__mk.emit('app', 'resume'));
    await page.waitForTimeout(400);
    await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000dd"]');
    await page.waitForSelector('#note-screen:not([hidden]) .mk-media-label');
    await page.waitForTimeout(400);
    await setMode('edit');
    const lab = await page.locator('.mk-media-label').first().boundingBox();
    await touch('touchStart', lab.x + 20, lab.y + lab.height / 2);
    await page.waitForTimeout(80);
    await touch('touchEnd', lab.x + 20, lab.y + lab.height / 2);
    await page.waitForTimeout(250);
    const four = await page.evaluate(() => ['.mk-share-btn', '.mk-save-btn', '.mk-copy-btn', '.mk-delete-btn'].map((s) => { const e = document.querySelector(s); return e && e.style.visibility !== 'hidden' ? Math.round(e.getBoundingClientRect().left) : -1; }));
    const voiceLabel = await page.getAttribute('.mk-delete-btn', 'aria-label').catch(() => null);
    check('음성 카드: 이름 줄을 짧게 누르면 공유 · 저장 · 복사 · × (왼쪽부터)', four.every((x) => x >= 0) && four[0] < four[1] && four[1] < four[2] && four[2] < four[3] && voiceLabel === '이 음성 지우기', JSON.stringify({ four, voiceLabel }));
    await shot('18d-voice-buttons');
    await page.tap('.mk-share-btn');
    await page.waitForTimeout(500);
    const shared = (await devLog()).log.filter((x) => x.shareContent).at(-1);
    check('공유 단추: 음성은 소리 파일 그대로 공유 창으로', shared?.shareContent.rel === 'attachments/voice-btn.m4a' && await page.isVisible('.mk-share-btn.done'), JSON.stringify(shared));
    await page.waitForTimeout(300);
    // 파일 칩: 짧게 누르면 열기 그대로, 꾹 누르면 단추 (열지 않음)
    const opensBefore = (await devLog()).log.filter((x) => x.openFile).length;
    const chip = await page.locator('.mk-doc a[data-file]').boundingBox();
    await touch('touchStart', chip.x + 10, chip.y + chip.height / 2);
    await page.waitForTimeout(650);
    await touch('touchEnd', chip.x + 10, chip.y + chip.height / 2);
    await page.waitForTimeout(300);
    const chipLabel = await page.getAttribute('.mk-delete-btn', 'aria-label').catch(() => null);
    const opensAfter = (await devLog()).log.filter((x) => x.openFile).length;
    check('파일 칩: 꾹 누르면 공유 · 저장 · 복사 · × (파일을 열지 않음)', chipLabel === '이 파일 지우기' && await page.isVisible('.mk-share-btn') && opensAfter === opensBefore, JSON.stringify({ chipLabel, opensBefore, opensAfter }));
    await page.tap('.mk-save-btn');
    await page.waitForTimeout(500);
    const saved = (await devLog()).log.filter((x) => x.saveAs).at(-1);
    check('저장 단추: PDF 는 파일 그대로', saved?.saveAs.rel === 'attachments/안내서.pdf' && saved.saveAs.name === '안내서.pdf', JSON.stringify(saved));
    await page.waitForTimeout(1900);
    // 파일 칩을 짧게 눌러도 바로 열지 않고 단추 + 노란 "열기" (맨 왼쪽) → "열기"를 누르면 그때 연다
    const tapAt = async (sel) => {
      const b = await page.locator(sel).first().boundingBox();
      await touch('touchStart', b.x + 10, b.y + b.height / 2);
      await page.waitForTimeout(80);
      await touch('touchEnd', b.x + 10, b.y + b.height / 2);
      await page.waitForTimeout(400);
    };
    const opens0 = (await devLog()).log.filter((x) => x.openFile).length;
    await tapAt('.mk-doc a[data-file]');
    const row = await page.evaluate(() => ['.mk-open-btn', '.mk-share-btn', '.mk-save-btn', '.mk-copy-btn', '.mk-delete-btn'].map((s) => Math.round(document.querySelector(s)?.getBoundingClientRect().left ?? -1)));
    const openLabel = await page.getAttribute('.mk-open-btn', 'aria-label').catch(() => null);
    const opens1 = (await devLog()).log.filter((x) => x.openFile).length;
    check('파일 칩: 짧게 눌러도 바로 열지 않고 열기 · 공유 · 저장 · 복사 · × (왼쪽부터)', opens1 === opens0 && row.every((x) => x >= 0) && row.every((x, i) => i === 0 || row[i - 1] < x) && openLabel === '이 파일 열기', JSON.stringify({ row, openLabel, opens0, opens1 }));
    await shot('18e-file-open-button');
    await page.tap('.mk-open-btn');
    await page.waitForTimeout(500);
    const opened = (await devLog()).log.filter((x) => x.openFile);
    check('열기 단추: 누르면 그 파일을 연다 (단추는 거둠)', opened.length === opens0 + 1 && opened.at(-1).openFile === 'attachments/안내서.pdf' && !(await page.locator('.mk-open-btn').count()), JSON.stringify(opened.at(-1)));
    // 수식: 눌러도 고치기 창이 바로 뜨지 않고 단추 + "고치기"
    await tapAt('.mk-doc .mk-math-block');
    const mathRow = { editor: await page.locator('.mk-math-editor').count(), label: await page.getAttribute('.mk-open-btn', 'aria-label').catch(() => null) };
    check('수식: 눌러도 바로 고치기 창이 뜨지 않고 단추 + "이 수식 고치기"', mathRow.editor === 0 && mathRow.label === '이 수식 고치기', JSON.stringify(mathRow));
    await page.tap('.mk-open-btn');
    await page.waitForTimeout(400);
    check('고치기 단추: 누르면 수식 고치기 창', (await page.locator('.mk-math-editor').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    // 파일 칩 이름은 고칠 수 없다: 칩 글자 가운데에 커서를 두고 쳐도 · 지워도 그대로
    const chipBefore = read('콘텐츠 단추.md');
    await page.evaluate(() => {
      const t = document.querySelector('.mk-doc a[data-file]').firstChild;
      document.querySelector('#note-screen .ProseMirror').focus();
      window.getSelection().collapse(t, 2);
    });
    await page.waitForTimeout(150);
    await page.keyboard.type('XY');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(1500);
    const chipText = await page.textContent('.mk-doc a[data-file]');
    check('파일 칩: 이름 가운데에 쳐도 · 지워도 바뀌지 않음', chipText === '안내서.pdf' && read('콘텐츠 단추.md').includes('[안내서.pdf](attachments/안내서.pdf)') && !read('콘텐츠 단추.md').includes('XY'), JSON.stringify({ chipText, same: chipBefore === read('콘텐츠 단추.md') }));
    // 다음 점검을 위해 '그림 둘' 로 돌아감
    await back();
    await page.waitForTimeout(300);
    await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000cc"]');
    await page.waitForSelector('#note-screen:not([hidden]) img.mk-image');
    await page.waitForTimeout(400);
  }
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

  // 표 나누기 · 아래 표와 합치기 (열 수가 같을 때)
  write('표 나누기.md', '---\nid: 00000000-0000-4000-8000-0000000000df\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: blue\n---\n# 표 나누기\n\n| 이름 | 수량 |\n| --- | --- |\n| 사과 | 1 |\n| 배 | 2 |\n| 감 | 3 |\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000df"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await setMode('edit');
  await page.locator('.mk-doc td', { hasText: '배' }).tap();
  await page.waitForTimeout(300);
  check('표 막대: 두 번째 본문 행이면 "표 나누기" · 아래에 표가 없으면 "아래 표와 합치기" 없음', await page.isVisible('#table-bar [data-table="splitTable"]') && await page.isHidden('#table-bar [data-table="joinTable"]'));
  await page.tap('#table-bar [data-table="splitTable"]');
  await page.waitForTimeout(900);
  const split = read('표 나누기.md');
  check('표 나누기: 이 행부터 새 표 (머리글 행도 함께)', /\| 이름 \| 수량 \|\n\| -+ \| -+ \|\n\| 사과 \| 1 +\|\n\n+\| 이름 \| 수량 \|\n\| -+ \| -+ \|\n\| 배 +\| 2 +\|\n\| 감 +\| 3 +\|/.test(split), split);
  await page.locator('.mk-doc td', { hasText: '사과' }).tap();
  await page.waitForTimeout(300);
  check('표 막대: 아래에 열 수가 같은 표가 있으면 "아래 표와 합치기"', await page.isVisible('#table-bar [data-table="joinTable"]'));
  await page.tap('#table-bar [data-table="joinTable"]');
  await page.waitForTimeout(900);
  const joined = read('표 나누기.md');
  check('아래 표와 합치기: 머리글이 같으면 한 번만 · 한 표로', (await page.locator('.mk-doc table').count()) === 1 && /\| 사과 \| 1 +\|\n\| 배 +\| 2 +\|\n\| 감 +\| 3 +\|/.test(joined), joined);
  // 머리글 없는 표도 있으니 첫 행을 따로 꾸미지 않는다 (원하면 "첫 행 강조")
  const thWeight = await page.locator('.mk-doc th').first().evaluate((e) => getComputedStyle(e).fontWeight);
  check('표 첫 행: 다른 행과 같은 글자 굵기', Number(thWeight) < 600, thWeight);
  // 표 → 목록
  await page.locator('.mk-doc td', { hasText: '배' }).tap();
  await page.waitForTimeout(300);
  await page.tap('#table-bar [data-table="toList"]');
  await page.waitForTimeout(900);
  const listed = read('표 나누기.md');
  check('표 → 목록: 행마다 한 항목 (칸은 · 로 이음)', (await page.locator('.mk-doc table').count()) === 0
    && /- 이름 · 수량\n- 사과 · 1\n- 배 · 2\n- 감 · 3/.test(listed), listed);
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

  // 링크 미리보기 설정: 끄면 카드 대신 누르면 열리는 링크 글자 · 파일은 그대로 · 다시 켜면 열린 메모에서 바로 카드
  write('링크 모음.md', '---\nid: 00000000-0000-4000-8000-0000000000a9\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: blue\n---\n# 링크 모음\n\n[예제 페이지](https://example.com/page "미리보기")\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('#settings-btn');
  await page.locator('#link-previews').scrollIntoViewIfNeeded();
  check('설정: 링크 미리보기 (처음엔 켜짐)', await page.isChecked('#link-previews'));
  await page.locator('label', { has: page.locator('#link-previews') }).tap();
  await page.waitForTimeout(200);
  check('설정: 링크 미리보기 끄기', !(await page.isChecked('#link-previews')));
  await back();
  await page.waitForTimeout(300);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000a9"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(300);
  const plainLink = await page.evaluate(() => {
    const a = document.querySelector('.mk-doc .mk-link-card.plain-link a.lc-plain');
    return a && { text: a.textContent, href: a.getAttribute('href'), card: Boolean(document.querySelector('.mk-doc .lc-main')) };
  });
  check('링크 미리보기 끔: 카드 대신 링크 글자 (제목 · 주소)', plainLink?.text === '예제 페이지' && plainLink?.href === 'https://example.com/page' && !plainLink.card, JSON.stringify(plainLink));
  // 설정 화면의 스위치와 같은 함수 (메모를 연 채로 — 같은 모듈이라 열린 편집기에 바로)
  await page.evaluate(async () => (await import('/m/js/note-view.js')).setLinkPreviews(true));
  await page.waitForTimeout(300);
  check('다시 켜면 열린 메모에서 바로 카드', (await page.locator('.mk-doc .mk-link-card:not(.plain-link) .lc-main').count()) === 1);
  check('링크 미리보기 설정은 파일을 바꾸지 않음', read('링크 모음.md').includes('[예제 페이지](https://example.com/page "미리보기")'), read('링크 모음.md'));
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

  // 조용한 다듬기: 쓰던 줄을 떠나면 부호 앞 띄어쓰기, 갈라진 같은 목록은 하나로 (겹친 띄어쓰기 · 줄 앞 들여쓰기는 일부러 쓴 것이라 그대로)
  write('다듬기.md', '---\nid: 00000000-0000-4000-8000-0000000000bb\ncreated: 2026-10-01T00:00:00+00:00\nupdated: 2026-10-01T00:00:00+00:00\ncolor: blue\n---\n# 다듬기\n\n- 사과\n- 배\n\n* 감\n* 귤\n\n둘째 문단\n');
  await page.evaluate(() => window.__mk.emit('app', 'resume'));
  await page.waitForTimeout(400);
  await page.tap('.card[data-id="00000000-0000-4000-8000-0000000000bb"]');
  await page.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
  await page.waitForTimeout(300);
  check('다듬기: 갈라진 같은 목록은 한 목록으로', (await page.locator('.mk-doc ul').count()) === 1 && (await page.locator('.mk-doc ul > li').count()) === 4);
  await page.locator('.mk-doc p', { hasText: '둘째 문단' }).tap();
  await page.waitForTimeout(300);
  await page.keyboard.press('End');
  await page.keyboard.type('  끝이에요  정말 .');
  await page.waitForTimeout(200);
  check('다듬기: 쓰는 줄은 그대로', (await page.locator('.mk-doc p', { hasText: '둘째 문단' }).textContent()).includes('끝이에요  정말 .'));
  await page.locator('.mk-doc h1').tap();
  await page.waitForTimeout(900);
  const tidied = read('다듬기.md');
  check('다듬기: 줄을 떠나면 부호 앞 띄어쓰기만 정리 (겹친 띄어쓰기는 그대로)', tidied.includes('둘째 문단  끝이에요  정말.') && /- 사과\n- 배\n- 감\n- 귤/.test(tidied), tidied);
  await back();
  await page.waitForTimeout(300);

  // 화면 캡처(그림만 공유): #캡처 태그를 저절로
  await post('/dev/intent', { type: 'share', text: '', app: '스크린샷', files: [{ name: 'Screenshot_20261005.png', mime: 'image/png', base64: fs.readFileSync(path.join(repo, 'assets/icons/icon-256.png')).toString('base64') }] });
  await page.evaluate(() => window.__mk.emit('intent', null));
  await page.waitForTimeout(1500);
  f = fileWith('출처: 스크린샷');
  check('화면 캡처: #캡처 태그를 저절로', f && /#캡처/.test(read(f)), f && read(f));
  check('화면 캡처: 제목은 파일 이름 대신 "화면 캡처 날짜"', f && /^# 화면 캡처 \d+월 \d+일/m.test(read(f)) && !read(f).includes('# Screenshot'), f && read(f));
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
    await page.waitForTimeout(300);
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
    await page.waitForTimeout(300);
    {
      const bar = await page.locator('#table-bar').boundingBox();
      const add = await page.locator('#add-btn').boundingBox();
      const dial = await page.locator('.mode-knob').boundingBox();
      check('표 막대: + · 다이얼이 표 막대를 가리지 않음 (그 위로)', bar && add.y + add.height <= bar.y + 1 && dial.y + dial.height <= bar.y + 1, JSON.stringify({ bar, add, dial }));
    }
    await page.tap('#add-btn');
    await page.waitForTimeout(250);
    await page.tap('.add-sat[data-add="math"]');
    await page.waitForTimeout(400);
    // 키보드가 올라와 보이는 칸이 줄어도 수식 창은 보이는 칸 안에 (예전에는 키보드 뒤로 숨어 '바로 닫힌' 것처럼 보였다)
    await page.setViewportSize({ width: 390, height: 420 });
    await page.waitForTimeout(300);
    const mathBox = await page.locator('.mk-math-editor').boundingBox();
    check('+ → 수식: 키보드가 올라와도 수식 창이 보이는 칸 안에', mathBox && mathBox.y >= 0 && mathBox.y + mathBox.height <= 420, JSON.stringify(mathBox));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
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
    // 글 고치기: 손 메모를 톡 누르면 먼저 복사·저장·지우기 단추와 "이어 그리기" (바로 넘어가지 않음) → "이어 그리기"로 이어 그리기
    await page.tap('.mk-doc .mk-ink img:visible');
    await page.waitForTimeout(500);
    const armed = await page.evaluate(() => {
      const edit = document.querySelector('.mk-doc .mk-ink.mk-ink-armed .mk-ink-edit');
      const r = edit?.getBoundingClientRect();
      const del = document.querySelector('.mk-delete-btn')?.getBoundingClientRect();
      return { sheet: !!document.querySelector('.ink-sheet'), copy: !!document.querySelector('.mk-copy-btn'), save: !!document.querySelector('.mk-save-btn'), del: !!del, edit: !!edit && getComputedStyle(edit).opacity === '1', apart: !!r && !!del && (r.top >= del.bottom || r.bottom <= del.top) };
    });
    check('손 메모 톡: 바로 넘어가지 않고 복사·저장·× 단추 + 아래 "이어 그리기" (겹치지 않음)', !armed.sheet && armed.copy && armed.save && armed.del && armed.edit && armed.apart, JSON.stringify(armed));
    await page.tap('.mk-doc .mk-ink.mk-ink-armed .mk-ink-edit');
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
    // 주석이 붙은 문단(ann 의 anchor)의 맨 앞에 커서를 두고 Enter 두 번 → 그 위에 빈 줄이 생겨 문단이 밀린다
    //   (예전에는 제목을 누르고 쳤는데, 이 환경에서는 그 누르기가 커서를 옮기지 않아 앞 단계에서 골라 둔 그림 아래에 줄이 생겨 우연히 통과했다)
    const anchored = page.locator('.ProseMirror > p', { hasText: ann?.strokes?.[0]?.anchor?.f?.slice(0, 8) ?? '' }).first();
    await anchored.tap({ position: { x: 3, y: 8 } });
    await page.waitForTimeout(300);
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
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
  // 외부 앱 메모 연동 (전체 드라이브 권한): 연결된 뒤에만 보이고 기본은 꺼짐 → 켜면 다시 허용받고 폴더를 처음부터 · 취소하면 꺼진 채 · 끄기
  if (!(await page.isVisible('#drive-full-row'))) await page.tap('#settings-btn');
  await page.waitForTimeout(200);
  check('외부 앱 메모 연동: 연결된 뒤 설정에 보이고 기본은 꺼짐', await page.isVisible('#drive-full-row') && !(await page.isChecked('#drive-full')));
  const fullLog = async () => (await devLog()).log.filter((l) => l.driveFullScope).map((l) => l.driveFullScope.on);
  await post('/dev/drive-deny', {});
  await page.tap('#drive-full-row .switch');
  await page.waitForTimeout(700);
  check('외부 앱 메모 연동: 허용 화면에서 취소하면 다시 꺼짐 (지금 연결 그대로)', !(await page.isChecked('#drive-full')) && (await fullLog()).at(-1) === true && await page.isVisible('#drive-disconnect'));
  await page.tap('#drive-full-row .switch');
  await page.waitForTimeout(900);
  check('외부 앱 메모 연동: 허용하면 켜짐', await page.isChecked('#drive-full') && (await page.evaluate(() => window.memoking?.driveStatus ? true : true)));
  await page.tap('#drive-full-row .switch');
  await page.waitForTimeout(700);
  check('외부 앱 메모 연동: 끄면 drive.file 로 (꺼짐)', !(await page.isChecked('#drive-full')) && (await fullLog()).at(-1) === false);
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
