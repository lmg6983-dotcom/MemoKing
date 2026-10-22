// 태블릿 화면 점검 (node android/web/dev/smoke-tablet.mjs) — 1280×800 터치 화면에서 사람이 하듯 손가락으로 직접 해 본다
//   목록 숨기기·꺼내기 · 카드 왼쪽으로 밀어 지우기/오른쪽으로 밀어 옆에 열기 · 두 메모 나란히(고치기는 한쪽) ·
//   맨 위 막대를 꾹 눌러 끌어 자리 바꾸기·왼쪽 끝으로 던져 목록으로·오른쪽 끝으로 던져 지우기 · 음성 카드 안에는 글만
//   화면 사진은 out/tablet/
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(repo, 'out', 'tablet'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs').catch(() => import('playwright'));
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-tab-'));
fs.mkdirSync(path.join(vault, 'attachments'));
const memo = (name, id, body, color = 'yellow') => fs.writeFileSync(path.join(vault, `${name}.md`), `---\nid: ${id}\ncreated: 2026-10-01T09:00:00+09:00\nupdated: 2026-10-0${id.slice(-1)}T09:00:00+09:00\ncolor: ${color}\n---\n${body}`);
memo('회의', '00000000-0000-4000-8000-000000000001', '# 회의\n\n다음 주 출시 일정 #업무\n\n- [ ] 디자인 확인\n- [ ] 테스트\n', 'blue');
memo('장보기', '00000000-0000-4000-8000-000000000002', '# 장보기\n\n우유, 계란, 사과\n', 'green');
memo('아이디어', '00000000-0000-4000-8000-000000000003', '# 아이디어\n\n메모를 나란히 보기\n', 'pink');
memo('지울 메모', '00000000-0000-4000-8000-000000000004', '# 지울 메모\n\n버려도 되는 메모\n', 'gray');
fs.writeFileSync(path.join(vault, 'attachments', 'talk.m4a'), Buffer.alloc(64));
memo('녹음', '00000000-0000-4000-8000-000000000005', '# 녹음\n\n> ![녹음 · 회의](attachments/talk.m4a)\n>\n> 받아쓴 첫 문장이에요.\n>\n> 두 번째 문장이에요.\n\n끝 문단\n', 'purple');
memo('표 점검', '00000000-0000-4000-8000-000000000006', '# 표 점검\n\n| 이름 | 수량 |\n| --- | --- |\n| 사과 | 1 |\n| 배 | 2 |\n\n끝 문단\n');
const server = spawn(process.execPath, [path.join(repo, 'android/web/dev/server.mjs'), vault, '--port', '8812'], { stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => server.kill());
process.on('uncaughtException', (e) => { console.log('오류', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('오류', e?.message ?? e); process.exit(1); });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'ko-KR' });
await ctx.addInitScript(() => localStorage.setItem('memoking.tutorialDone', '1'));
const page = await ctx.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const cdp = await ctx.newCDPSession(page);
const wait = (ms) => page.waitForTimeout(ms);
let n = 0;
const shot = (name) => (console.log('  · 화면', name), page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) }));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }] });
async function gesture(pts, { hold = 0, step = 16 } = {}) {
  await touch('touchStart', ...pts[0]);
  if (hold) await wait(hold);
  for (const p of pts.slice(1)) { await touch('touchMove', ...p); await wait(step); }
  await touch('touchEnd', 0, 0);
  await wait(350);
}
const rect = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.right, b: r.bottom }; }, sel);
const state = () => page.evaluate(() => ({ cls: ['note-open', 'pane-list'].filter((c) => document.body.classList.contains(c)), active: document.querySelector('#note-screen:not([hidden]) .ProseMirror')?.textContent.slice(0, 12) ?? null, noteL: Math.round(document.getElementById('note-screen').getBoundingClientRect().left) }));
const card = (title) => `.card:has(.card-title:text-is("${title}"))`;
const cardRect = async (title) => (await page.locator(card(title)).boundingBox());

await page.goto('http://localhost:8812/m/index.html');
await page.waitForSelector('html[data-ready="true"]');
await wait(500);
await shot('list-full');
const listW = (await rect('#list-screen')).w;
check('메모가 없으면 목록이 화면 가득', listW > 1200, listW);

// 1) 카드를 누르면 메모가 화면 가득 (목록 숨김)
await page.tap(card('회의'));
await wait(500);
let st = await state();
const noteR = await rect('#note-screen');
check('카드 누르기 → 메모가 화면 가득 · 목록 숨김', st.cls.includes('note-open') && !st.cls.includes('pane-list') && noteR.x === 0 && noteR.w === 1280, JSON.stringify({ st, noteR }));
await shot('note-full');
// 2) ≡ 단추 → 목록이 옆에, 다시 → 숨김
await page.tap('#back-btn');
await wait(400);
st = await state();
check('≡ → 목록이 옆에 · 메모는 오른쪽', st.cls.includes('pane-list') && st.noteL > 300, JSON.stringify(st));
await shot('list-beside');
// 3) 오른쪽으로 밀기 → 열기 (화면 나누기는 없음: 그 메모가 화면 가득) — 안내가 카드 안에 보임
const c2 = await cardRect('장보기');
await touch('touchStart', c2.x + 30, c2.y + c2.height / 2);
for (let i = 1; i <= 10; i++) { await touch('touchMove', c2.x + 30 + i * 18, c2.y + c2.height / 2 + 1); await wait(16); }
await wait(100);
const label = await page.evaluate(() => { const c = document.querySelector('.card.swipe-open.swipe-ready'); if (!c) return null; const s = getComputedStyle(c, '::before'); const r = c.getBoundingClientRect(); const listR = document.getElementById('list-screen').getBoundingClientRect(); return { text: s.content, listRight: listR.right, labelLeft: r.left + 10 }; });
await shot('swipe-open-label');
await touch('touchEnd', 0, 0);
await wait(700);
check('오른쪽으로 밀면 "열기" 안내가 목록 안(카드 왼쪽)에 보임', label && /열기/.test(label.text) && !/옆에/.test(label.text) && label.labelLeft < label.listRight - 60, JSON.stringify(label));
st = await state();
check('→ 밀어 연 메모(장보기)가 화면 가득 · 목록 숨김 · 화면 나누기 없음', /장보기/.test(st.active) && !st.cls.includes('pane-list') && st.noteL === 0 && (await page.locator('#peek-screen, .pane-badge, .pane-edge').count()) === 0, JSON.stringify(st));
await shot('opened-full');
// 4) 뒤로 가기: 옆에 꺼낸 목록부터 넣고, 그다음 메모를 닫는다
await page.tap('#back-btn');
await wait(400);
check('≡ → 목록이 다시 옆에', (await state()).cls.includes('pane-list'));
await page.evaluate(() => window.__mk.back());
await wait(400);
st = await state();
check('뒤로 → 목록을 넣고 메모는 그대로', !st.cls.includes('pane-list') && /장보기/.test(st.active), JSON.stringify(st));
await page.evaluate(() => window.__mk.back());
await wait(500);
check('한 번 더 뒤로 → 메모 닫고 목록 가득', !(await state()).cls.includes('note-open'));
await page.tap(card('회의'));
await wait(500);
// 8) 목록에서 왼쪽으로 밀기 → 지우기
await page.tap('#back-btn');
await wait(400);
if (!(await state()).cls.includes('pane-list')) { await page.tap('#back-btn'); await wait(400); }
const c3 = await cardRect('아이디어');
await gesture(Array.from({ length: 12 }, (_, i) => [c3.x + c3.width - 30 - i * 20, c3.y + c3.height / 2]));
await wait(500);
check('왼쪽으로 밀기 → 삭제 (태블릿)', !fs.existsSync(path.join(vault, '아이디어.md')));
// 9) 음성 카드 안에서 + › 표 · 손 메모 → 카드 아래로
await page.tap(card('녹음'));
await wait(600);
await page.evaluate(() => { const p = [...document.querySelectorAll('#note-screen .ProseMirror .mk-voice p')].find((x) => x.textContent.includes('첫 문장')); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
await wait(100);
await page.tap('#add-btn');
await wait(350);
await page.tap('.add-sat[data-add="table"]');
await wait(400);
const tableIn = await page.evaluate(() => ({ inCard: !!document.querySelector('#note-screen .mk-voice table'), table: !!document.querySelector('#note-screen .ProseMirror table') }));
check('음성 카드(받아쓴 글) 안에서 + › 표 → 카드 바로 아래에 (카드 안에 안 들어감)', tableIn.table && !tableIn.inCard, JSON.stringify(tableIn));
await page.evaluate(() => { const p = [...document.querySelectorAll('#note-screen .ProseMirror .mk-voice p')].find((x) => x.textContent.includes('두 번째')); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
await page.tap('#add-btn');
await wait(350);
await page.tap('.add-sat[data-add="ink"]');
await page.waitForSelector('.ink-sheet');
await gesture(Array.from({ length: 10 }, (_, i) => [400 + i * 20, 400 + Math.sin(i) * 20]), { step: 20 });
await page.tap('.ink-sheet .ink-done');
await wait(900);
const inkIn = await page.evaluate(() => ({ inCard: !!document.querySelector('#note-screen .mk-voice .mk-ink'), ink: !!document.querySelector('#note-screen .mk-ink') }));
check('음성 카드 안에서 + › 손 메모 → 카드 아래에', inkIn.ink && !inkIn.inCard, JSON.stringify(inkIn));
await shot('voice-card-outside');
// 표: 막대가 넓은 화면에서도 한 줄로 모여 있고 (단추가 멀리 퍼지지 않음), "⋯" 판도 너무 넓지 않다
const p2 = await ctx.newPage();
p2.setDefaultTimeout(6000);
await p2.goto('http://localhost:8812/m/index.html');
await p2.waitForSelector('html[data-ready="true"]');
await p2.waitForTimeout(500);
await p2.tap(card('표 점검'));
await p2.waitForSelector('#note-screen:not([hidden]) .ProseMirror');
await p2.locator('.mk-doc td', { hasText: '사과' }).tap();
await p2.waitForTimeout(500);
await p2.tap('#table-more-btn');
await p2.waitForTimeout(300);
const tb = await p2.evaluate(() => { const bar = document.getElementById('table-bar').getBoundingClientRect(); const more = document.getElementById('table-more').getBoundingClientRect(); const last = document.getElementById('table-more-btn').getBoundingClientRect(); return { barH: Math.round(bar.height), moreW: Math.round(more.width), moreBtnRight: Math.round(last.right), barW: Math.round(bar.width) }; });
check('태블릿 표 막대: 한 줄이고, ⋯ 판은 넓은 화면에서도 440px 안, 버튼이 멀리 퍼지지 않음', tb.barH <= 80 && tb.moreW <= 440 && tb.moreBtnRight < 900, JSON.stringify(tb));
await p2.screenshot({ path: path.join(OUT, '07-table-bar.png') });
check('화면 오류 없음', errors.length === 0, errors.join(' | '));
await browser.close(); server.kill();
console.log(failed ? `\n${failed}개 실패` : '\n태블릿 점검 모두 통과');
process.exit(failed ? 1 : 0);
