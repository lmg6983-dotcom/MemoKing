// 휴대폰 튜토리얼 직접 따라 하기 점검 (node android/web/dev/smoke-tutorial.mjs) — 390×844 터치 화면에서 처음 쓰는 사람처럼
//   말풍선이 시키는 대로 손가락으로 누르고, 키보드가 올라오면 화면이 줄어든 채로(휴대폰과 같게) 글자를 한 자씩 친다.
//   단계마다: 눌러야 할 곳이 보이고 말풍선에 가리지 않는지(elementFromPoint) · 직접 해 볼 곳을 얼마나 가리는지 ·
//   글자를 다 치기 전에 넘어가지 않는지 · 그림이 휴대폰 화면인지. 화면 사진은 out/tutorial-phone/
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { MOBILE_TUTORIAL_STEPS as STEPS } from '../../../app/js/core/tutorial.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(repo, 'out', 'tutorial-phone'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs').catch(() => import('playwright'));
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-tut-'));
fs.mkdirSync(path.join(vault, 'attachments'));
const memo = (name, id, body, color = 'yellow') => fs.writeFileSync(path.join(vault, `${name}.md`), `---\nid: ${id}\ncreated: 2026-10-01T09:00:00+09:00\nupdated: 2026-10-01T09:00:00+09:00\ncolor: ${color}\n---\n${body}`);
memo('회의', '00000000-0000-4000-8000-000000000001', '# 회의\n\n다음 주 출시 일정 #업무\n', 'blue');
memo('장보기', '00000000-0000-4000-8000-000000000002', '# 장보기\n\n우유, 계란\n', 'green');
const PORT = 8813;
const server = spawn(process.execPath, [path.join(repo, 'android/web/dev/server.mjs'), vault, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => server.kill());
process.on('uncaughtException', (e) => { console.log('오류', e.stack); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('오류', e?.stack ?? e); process.exit(1); });
await new Promise((r) => server.stdout.once('data', r));

const W = 390, H = 844, KB = 320; // 키보드가 올라오면 화면이 이만큼 줄어든다 (안드로이드 앱이 웹 화면을 줄임)
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' });
const page = await ctx.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const cdp = await ctx.newCDPSession(page);
const wait = (ms) => page.waitForTimeout(ms);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };
let n = 0;
const shot = (name) => page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) });
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }] });

// 키보드: 글 쓰는 곳에 손가락이 닿으면 올라오고(화면이 줄어듦), 목록으로 가면 내려간다
let kbOpen = false;
async function keyboard(open) {
  if (kbOpen === open) return;
  kbOpen = open;
  await page.setViewportSize({ width: W, height: open ? H - KB : H });
  await page.evaluate((o) => window.__mk.emit('keyboard', { open: o }), open);
  await wait(250);
}
const stepId = () => page.evaluate(() => { const b = document.querySelector('.coach-bubble'); return b && !b.hidden ? b.dataset.step : null; });

// 지금 말풍선 상태: 비춘 곳·직접 해 볼 곳을 얼마나 가리는지, 그림
const bubbleInfo = (keep) => page.evaluate((keep) => {
  const b = document.querySelector('.coach-bubble');
  if (!b || b.hidden) return null;
  const br = b.getBoundingClientRect();
  const ov = (a, c) => Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
  let all = 0, hid = 0;
  for (const sel of keep ?? []) for (const e of document.querySelectorAll(sel)) {
    if (!e.getClientRects().length) continue;
    const r = e.getBoundingClientRect();
    all += r.width * r.height; hid += ov(br, r);
  }
  const spot = document.querySelector('.coach-spot');
  const s = spot.getBoundingClientRect();
  const img = b.querySelector('.coach-shot');
  return {
    mini: b.classList.contains('mini'),
    box: { top: Math.round(br.top), bottom: Math.round(br.bottom), h: Math.round(br.height) },
    vh: innerHeight,
    target: spot.classList.contains('center') ? 0 : ov(br, s) / Math.max(1, s.width * s.height),
    keep: all ? hid / all : 0,
    image: img ? img.getAttribute('src').split('/').pop() : null,
    inView: br.top >= 0 && br.bottom <= innerHeight + 1,
  };
}, keep);

// 말풍선이 글자 커서가 있는 줄을 가리는지 (넓이)
const coversCaret = () => page.evaluate(() => {
  const b = document.querySelector('.coach-bubble');
  const sel = getSelection();
  if (!b || b.hidden || !sel.rangeCount) return { hit: 0, mini: b?.classList.contains('mini') };
  const rs = sel.getRangeAt(0).getClientRects();
  const r = rs.length ? rs[rs.length - 1] : sel.anchorNode.parentElement.getBoundingClientRect();
  const br = b.getBoundingClientRect();
  const hit = Math.max(0, Math.min(br.bottom, r.bottom) - Math.max(br.top, r.top)) * Math.max(0, Math.min(br.right, innerWidth) - Math.max(br.left, 0));
  return { hit, mini: b.classList.contains('mini'), line: [Math.round(r.top), Math.round(r.bottom)], bubble: [Math.round(br.top), Math.round(br.bottom)] };
});

// 말풍선이 시키는 곳을 손가락으로 (보이고 가려지지 않았는지 먼저)
async function tapOn(sel, label) {
  const p = await page.evaluate((sel) => {
    const e = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length);
    if (!e) return { found: false };
    const r = e.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { found: true, x, y, ok: e === hit || e.contains(hit), hit: hit ? `${hit.tagName}.${hit.className}` : null, inView: r.top >= 0 && r.bottom <= innerHeight };
  }, sel);
  check(`${label}: "${sel}" 가 화면에 보이고 말풍선에 안 가려 누를 수 있음`, p.found && p.ok && p.inView, JSON.stringify(p));
  if (p.found) await page.touchscreen.tap(p.x, p.y);
  await wait(350);
  return p;
}
async function typeSlowly(text) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await wait(140);
  }
}
async function nextBtn() {
  await tapOn('.coach-bubble .coach-next', '다음 단추');
  await wait(400);
}
async function atStep(id) {
  for (let i = 0; i < 30 && (await stepId()) !== id; i++) await wait(150);
  const now = await stepId();
  const step = STEPS.find((s) => s.id === id);
  await wait(450);
  const info = await bubbleInfo(step.keep);
  await shot(id);
  console.log(`  · ${id}`, JSON.stringify(info));
  check(`[${id}] 단계가 뜸`, now === id, now);
  if (info) {
    check(`[${id}] 말풍선이 화면 안`, info.inView, JSON.stringify(info.box));
    check(`[${id}] 비춘 곳을 가리지 않음`, info.target < 0.05, info.target.toFixed(2));
    check(`[${id}] 직접 해 볼 곳을 거의 안 가림`, info.keep <= 0.15, info.keep.toFixed(2));
    if (info.image) check(`[${id}] 그림은 휴대폰 화면 사진`, info.image.startsWith('m-'), info.image);
  }
  return info;
}

await page.goto(`http://localhost:${PORT}/m/index.html`);
await page.waitForSelector('html[data-ready="true"]');
await wait(700);

// 1) 처음 열면 저절로
await atStep('welcome');
await tapOn('.coach-bubble .coach-next', '시작');

// 2) + › 글 메모
await atStep('new-memo');
await tapOn('#fab', '+');
await wait(300);
await bubbleInfo(STEPS[1].keep).then((i) => check('[new-memo] 펼친 메뉴를 말풍선이 거의 안 가림', i && i.keep <= 0.15, JSON.stringify(i)));
await shot('new-memo-open');
await tapOn('#fab-menu:not([hidden]) [data-new="text"]', '글 메모');
await keyboard(true); // 새 메모는 바로 쓸 수 있게 키보드가 올라온다

// 3) 한 줄 쓰기 — 다 치기 전에 넘어가면 안 된다
await atStep('write');
await typeSlowly('주말 장보');
check('[write] 글자를 치는 도중에는 넘어가지 않음', (await stepId()) === 'write' || (await page.evaluate(() => document.querySelector('.coach-bubble')?.classList.contains('mini'))), await stepId());
await typeSlowly('기 목록');
await wait(300);
check('[write] 아직 치는 중(잠깐 쉼)에도 그대로', (await stepId()) === 'write', await stepId());
check('[write] 치기 시작하면 말풍선은 작은 알약 · 쓰는 줄을 안 가림', await coversCaret().then((c) => c.mini && c.hit === 0), JSON.stringify(await coversCaret()));
await shot('write-typing');
await wait(2000); // 손을 멈추면 다음으로

// 4) 꾸미기: B 를 누르고 쓰기
await atStep('format');
await page.keyboard.press('Enter');
await tapOn('#format-bar [data-cmd="bold"]', 'B');
await typeSlowly('우유 사기');
check('[format] 치는 동안 쓰는 줄을 안 가림', await coversCaret().then((c) => c.hit === 0), JSON.stringify(await coversCaret()));
await shot('format-typed');

// 5) 체크리스트
await atStep('lists');
await tapOn('#format-bar [data-cmd="task"]', '체크리스트');

// 6) 옮기기 (안내)
await atStep('move');
await nextBtn();

// 7) + 펼치기
await atStep('add');
await tapOn('#add-btn', '도구막대 +');

// 8) 손 메모
await atStep('ink');
await tapOn('#add-menu:not([hidden]) [data-add="ink"]', '손 메모');
await page.waitForSelector('.ink-sheet');
await keyboard(false);
const sheet = await page.locator('.ink-canvas, .ink-sheet canvas, .ink-sheet svg').first().boundingBox();
await touch('touchStart', sheet.x + 60, sheet.y + 80);
for (let i = 1; i <= 12; i++) { await touch('touchMove', sheet.x + 60 + i * 12, sheet.y + 80 + Math.sin(i) * 20); await wait(16); }
await touch('touchEnd', 0, 0);
await wait(200);
await tapOn('.ink-done', '손 메모 완료');
await wait(500);

// 9) 주석
await atStep('annotate');
await tapOn('#add-btn', '도구막대 +');
await tapOn('#add-menu:not([hidden]) [data-add="annotate"]', '주석');
await wait(500);
const area = await page.locator('.mk-annot-scroller, .ink-annot, .mk-annot').first().boundingBox().catch(() => null);
if (area) {
  await touch('touchStart', area.x + 40, area.y + 40);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', area.x + 40 + i * 15, area.y + 40); await wait(16); }
  await touch('touchEnd', 0, 0);
}
await wait(200);
await tapOn('.ink-done', '주석 완료');
await wait(500);

// 10) 음성 (안내)
await atStep('voice');
await nextBtn();

// 11) 태그: 끝 줄을 누르고 #할일 — "#할" 에서 넘어가면 안 된다
await atStep('tag');
const last = await page.locator('.ProseMirror > *').last().boundingBox();
await page.touchscreen.tap(last.x + last.width - 4, last.y + last.height / 2);
await keyboard(true);
await page.keyboard.press('End');
await typeSlowly(' #할');
check('[tag] "#할" 까지 쳤을 때 아직 넘어가지 않음', (await stepId()) === 'tag' || (await page.evaluate(() => document.querySelector('.coach-bubble')?.classList.contains('mini'))), await stepId());
await wait(300);
check('[tag] "#할" 에서 잠깐 쉬어도 아직', (await stepId()) === 'tag', await stepId());
await typeSlowly('일');

for (const id of STEPS.slice(STEPS.findIndex((s) => s.id === 'tag') + 1).filter((s) => s.win === 'note' && !s.advance).map((s) => s.id)) {
  await atStep(id);
  await nextBtn();
}

// 뒤로
await atStep('back');
await keyboard(false);
await tapOn('#back-btn', '뒤로');

for (const s of STEPS.filter((s) => s.win === 'list' && STEPS.indexOf(s) > STEPS.findIndex((x) => x.id === 'back'))) {
  await atStep(s.id);
  if (s.id === 'layout') await tapOn('#layout-btn', '보기 바꾸기');
  else if (s.id === 'filters') await tapOn('#tag-strip .tag-chip[data-tag="할일"]', '#할일 태그');
  else await nextBtn();
}
await wait(400);
check('튜토리얼 끝: 말풍선이 사라짐', !(await stepId()));
const saved = fs.readdirSync(vault).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(vault, f), 'utf8')).find((t) => t.includes('주말 장보기 목록'));
check('따라 하며 쓴 메모가 그대로 저장 (제목 · 굵게 · 체크리스트 · 태그)', saved && /\*\*우유 사기\*\*/.test(saved) && /- \[ \]/.test(saved) && saved.includes('#할일'), saved);
check('화면 오류 없음', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `튜토리얼 점검 실패 ${failed}개` : '휴대폰 튜토리얼 점검 모두 통과');
process.exit(failed ? 1 : 0);
