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
const state = () => page.evaluate(() => ({ cls: ['note-open', 'pane-list', 'pane-split', 'active-right'].filter((c) => document.body.classList.contains(c)), active: document.querySelector('#note-screen:not([hidden]) .ProseMirror')?.textContent.slice(0, 12) ?? null, peek: document.querySelector('#peek-screen:not([hidden]) .peek-title')?.textContent ?? null, noteL: Math.round(document.getElementById('note-screen').getBoundingClientRect().left), peekL: Math.round(document.getElementById('peek-screen').getBoundingClientRect().left) }));
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
// 3) 오른쪽으로 밀기 → 옆에 열기 (안내가 카드 안에 보임)
const c2 = await cardRect('장보기');
await touch('touchStart', c2.x + 30, c2.y + c2.height / 2);
for (let i = 1; i <= 10; i++) { await touch('touchMove', c2.x + 30 + i * 18, c2.y + c2.height / 2 + 1); await wait(16); }
await wait(100);
const label = await page.evaluate(() => { const c = document.querySelector('.card.swipe-open.swipe-ready'); if (!c) return null; const s = getComputedStyle(c, '::before'); const r = c.getBoundingClientRect(); const listR = document.getElementById('list-screen').getBoundingClientRect(); return { text: s.content, cardRight: r.right, listRight: listR.right, labelLeft: r.left + 10 }; });
await shot('swipe-open-label');
await touch('touchEnd', 0, 0);
await wait(700);
check('오른쪽으로 밀면 "옆에 열기" 안내가 목록 안(카드 왼쪽)에 보임', label && /옆에 열기/.test(label.text) && label.labelLeft < label.listRight - 60, JSON.stringify(label));
st = await state();
check('→ 두 메모 나란히: 새 메모(장보기)는 오른쪽 고치는 칸 · 회의는 왼쪽 보기 칸 · 목록 숨김', st.cls.includes('pane-split') && st.cls.includes('active-right') && /장보기/.test(st.active) && st.peek === '회의' && !st.cls.includes('pane-list'), JSON.stringify(st));
await shot('split');
// 4) 옆 메모를 누르면 그쪽이 고치는 칸
const pk = await rect('#peek-screen .peek-editor');
await page.touchscreen.tap(pk.cx, pk.cy);
await wait(700);
st = await state();
check('옆 메모 누르기 → 회의가 고치는 칸(왼쪽 그대로) · 장보기는 보기 칸(오른쪽)', /회의/.test(st.active) && st.peek === '장보기' && !st.cls.includes('active-right') && st.noteL === 0, JSON.stringify(st));
const editable = await page.evaluate(() => document.querySelector('#note-screen .ProseMirror').getAttribute('contenteditable'));
check('고치는 칸만 고칠 수 있음 · 보기 칸은 보기만', editable === 'true' && (await page.evaluate(() => document.querySelector('#peek-screen .ProseMirror').getAttribute('contenteditable'))) === 'false');
await shot('split-swapped-roles');
// 5) 맨 위 막대를 꾹 눌러 다른 메모 위에 놓기 → 자리 바꾸기
let bar = await rect('#note-screen .bar');
const pr = await rect('#peek-screen');
const hold = async (from, path, opts = {}) => {
  await touch('touchStart', ...from);
  await wait(450);
  for (const p of path) { await touch('touchMove', ...p); await wait(opts.step ?? 24); }
};
await hold([bar.x + 200, bar.cy], [[bar.x + 300, bar.cy + 20], [pr.x + 200, pr.y + 200], [pr.cx, pr.cy]]);
await wait(150);
const midSwap = await page.evaluate(() => ({ lifted: !!document.querySelector('.pane-lifted'), target: !!document.querySelector('.pane-swap-target'), badge: document.getElementById('pane-badge').textContent, shown: !document.getElementById('pane-badge').hidden }));
await shot('drag-swap');
await touch('touchEnd', 0, 0);
await wait(500);
st = await state();
check('막대를 꾹 눌러 들기 → 다른 메모 위: 보라 점선 + "⇅ 자리 바꾸기"', midSwap.lifted && midSwap.target && midSwap.shown && /자리 바꾸기/.test(midSwap.badge), JSON.stringify(midSwap));
check('놓으면 자리 바꿈: 회의(고치는 칸)가 오른쪽으로', st.cls.includes('active-right') && /회의/.test(st.active) && st.noteL > 600, JSON.stringify(st));
await shot('swapped');
// 6) 왼쪽 끝으로 던지기 → 목록으로 (그 칸만 닫힘, 목록이 옆에)
const pbar = await rect('#peek-screen .bar');
await hold([pbar.x + 200, pbar.cy], [[pbar.x + 150, pbar.cy], [pbar.x + 60, pbar.cy], [20, pbar.cy]], { step: 12 });
const midClose = await page.evaluate(() => ({ peekText: document.querySelector('#peek-screen .ProseMirror')?.textContent ?? 'none', zone: document.body.dataset.paneZone, badge: document.getElementById('pane-badge').textContent }));
await shot('drag-close');
await touch('touchEnd', 0, 0);
await wait(700);
st = await state();
check('왼쪽 끝으로 던지기 → "↩ 목록으로" → 그 메모만 닫히고 목록이 옆에', midClose.zone === 'close' && /목록으로/.test(midClose.badge) && !st.cls.includes('pane-split') && st.cls.includes('pane-list') && /회의/.test(st.active), JSON.stringify({ midClose, st }));
await shot('closed-to-list');
// 7) 다시 옆에 열고 오른쪽 끝으로 던지기 → 지우기
const c4 = await cardRect('지울 메모');
await gesture(Array.from({ length: 12 }, (_, i) => [c4.x + 30 + i * 18, c4.y + c4.height / 2]));
await wait(600);
st = await state();
check('목록에서 "지울 메모"를 옆에 열기', st.cls.includes('pane-split') && /지울 메모/.test(st.active), JSON.stringify(st));
bar = await rect('#note-screen .bar');
await hold([bar.x + 200, bar.cy], [[bar.x + 300, bar.cy], [1100, bar.cy], [1262, bar.cy]], { step: 12 });
const midDel = await page.evaluate(() => ({ zone: document.body.dataset.paneZone, badge: document.getElementById('pane-badge').textContent }));
await shot('drag-delete');
await touch('touchEnd', 0, 0);
await wait(900);
st = await state();
const gone = !fs.existsSync(path.join(vault, '지울 메모.md'));
check('오른쪽 끝으로 던지기 → "🗑 지우기" → 휴지통 · 남은 메모(회의)가 가득', midDel.zone === 'delete' && gone && !st.cls.includes('pane-split') && /회의/.test(st.active), JSON.stringify({ midDel, st, gone }));
check('지운 뒤 되돌리기 알림', await page.isVisible('.toast.has-action'));
await shot('deleted');
// 8) 목록에서 왼쪽으로 밀기 → 지우기
await page.tap('#back-btn');
await wait(400);
if (!(await state()).cls.includes('pane-list')) { await page.tap('#back-btn'); await wait(400); }
const c3 = await cardRect('아이디어');
await gesture(Array.from({ length: 12 }, (_, i) => [c3.x + c3.width - 30 - i * 20, c3.y + c3.height / 2]));
await wait(500);
check('왼쪽으로 밀기 → 지우기 (태블릿)', !fs.existsSync(path.join(vault, '아이디어.md')));
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
check('화면 오류 없음', errors.length === 0, errors.join(' | '));
await browser.close(); server.kill();
console.log(failed ? `\n${failed}개 실패` : '\n태블릿 점검 모두 통과');
process.exit(failed ? 1 : 0);
