// 튜토리얼 직접 해 보기 점검 (npm run smoke:tutorial) — 사람이 하듯 실제 마우스·키보드로 튜토리얼을 처음부터 끝까지 따라 한다.
//   단계마다: 말풍선이 비춘 곳·직접 해 볼 곳을 가리지 않는지, 누를 곳을 눌렀을 때 정말 그게 눌리는지(다른 것에 가려지면 실패),
//   해 내면 다음 단계로 넘어가며 "잘했어요"가 뜨는지 확인하고, 단계마다 화면을 찍는다 (out/tutorial/).
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TUTORIAL_STEPS } from '../app/js/core/tutorial.js';

const SMOKE_DIR = path.join(os.tmpdir(), 'memoking-smoke-tutorial');
const VAULT = path.join(SMOKE_DIR, 'vault');
const OUT = path.join(app.isPackaged ? SMOKE_DIR : path.join(import.meta.dirname, '..'), 'out', 'tutorial');

export function prepareSmoke(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.rmSync(VAULT, { recursive: true, force: true });
  fs.rmSync(path.join(userData, 'Local Storage'), { recursive: true, force: true });
  fs.mkdirSync(VAULT, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ vaultPath: VAULT, tutorialDone: true }));
}

export async function runSmoke({ noteWins, getVault, getList, createListWindow, startTutorial, getTutorial }) {
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
  let shotNo = 0;
  async function capture(win, name) {
    await wait(450);
    fs.writeFileSync(path.join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  const mouse = (win, type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  async function clickAt(win, x, y) {
    mouse(win, 'mouseMove', x, y);
    await wait(40);
    mouse(win, 'mouseDown', x, y);
    await wait(40);
    mouse(win, 'mouseUp', x, y);
    await wait(200);
  }
  async function drag(win, pts) {
    mouse(win, 'mouseMove', pts[0][0], pts[0][1]);
    await wait(30);
    mouse(win, 'mouseDown', pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) {
      mouse(win, 'mouseMove', x, y, { modifiers: ['leftButtonDown'] });
      await wait(18);
    }
    mouse(win, 'mouseUp', pts.at(-1)[0], pts.at(-1)[1]);
    await wait(200);
  }
  // 누를 곳의 가운데가 정말 그 요소인지 (말풍선·다른 것에 가려지면 다른 요소가 잡힌다)
  const probe = (win, sel, at = 'center') => js(win, `(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length);
    if (!e) return { found: false };
    let r = e.getBoundingClientRect();
    if (${JSON.stringify(at)} === 'text') {
      const range = document.createRange();
      range.selectNodeContents(e);
      const rs = [...range.getClientRects()];
      if (rs.length) r = { left: rs[0].left, top: rs[0].top, right: rs.at(-1).right, bottom: rs.at(-1).bottom, width: rs.at(-1).right - rs[0].left, height: rs[0].height };
    }
    const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { found: true, x, y, left: r.left, right: r.right, top: r.top, bottom: r.bottom, ok: e === hit || e.contains(hit), hit: hit ? (hit.className || hit.tagName) + '' : null };
  })()`);
  async function press(win, sel, label) {
    const p = await until(async () => {
      const v = await probe(win, sel);
      return v.found && v;
    }, `${label}: ${sel}`, 5000).catch(() => ({ found: false }));
    check(`${label}: "${sel}" 가 보이고 가려지지 않아 누를 수 있음`, p.found && p.ok, JSON.stringify(p));
    if (p.found) await clickAt(win, p.x, p.y);
    return p;
  }
  // 말풍선이 비춘 곳·직접 해 볼 곳을 얼마나 가리는지
  const coverage = (win, keep = []) => js(win, `(() => {
    const keep = ${JSON.stringify(keep)};
    const b = document.querySelector('.coach-bubble');
    if (!b || b.hidden) return null;
    const br = b.getBoundingClientRect();
    const s = document.querySelector('.coach-spot').getBoundingClientRect();
    const ov = (a, c) => Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
    const center = document.querySelector('.coach-spot').classList.contains('center');
    // 직접 해 볼 곳(keep)을 얼마나 가리는지 (넓이 비율)
    let all = 0;
    let hid = 0;
    for (const sel of keep) for (const e of document.querySelectorAll(sel)) {
      if (!e.getClientRects().length) continue;
      const r = e.getBoundingClientRect();
      all += r.width * r.height;
      hid += ov(br, r);
    }
    return { step: b.dataset.step, mini: b.classList.contains('mini'), target: center ? 0 : ov(br, s), keep: all ? Math.round((hid / all) * 100) : 0, inView: br.left >= 0 && br.top >= 0 && br.right <= innerWidth && br.bottom <= innerHeight, praise: !!b.querySelector('.coach-praise') };
  })()`);
  const stepOf = (win) => js(win, `(() => { const b = document.querySelector('.coach-bubble'); return b && !b.hidden ? b.dataset.step : null; })()`).catch(() => null);
  async function arrive(win, id, { praise = false } = {}) {
    const ok = await until(async () => (await stepOf(win())) === id, `단계 ${id}`, 6000).then(() => true).catch(() => false);
    await wait(500);
    const keep = TUTORIAL_STEPS.find((x) => x.id === id)?.keep ?? [];
    const c = ok ? await coverage(win(), keep) : null;
    check(`[${id}] 말풍선이 뜸 · 화면 안 · 비춘 곳을 가리지 않음 · 해 볼 곳을 거의 안 가림(${c?.keep ?? '-'}%)${praise ? ' · 🎉 칭찬' : ''}`, ok && c?.inView && c.target === 0 && c.keep <= 15 && (!praise || c.praise), JSON.stringify({ ok, c, now: await stepOf(win()) }));
    await capture(win(), id);
    return ok;
  }
  const next = (win, id) => press(win(), '.coach-bubble .coach-next', `[${id}] 다음`);

  let exitCode = 1;
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const vault = getVault();
    const keep = vault.create();
    vault.save(keep, '# 회의 메모\n\n다음 주 일정 #업무\n');
    createListWindow();
    getList().setSize(420, 700);
    const list = () => getList();
    await until(() => js(list(), 'document.documentElement.dataset.ready === "true"'), '목록 준비', 12000);
    startTutorial();
    await arrive(list, 'welcome');
    await next(list, 'welcome');
    await arrive(list, 'new-memo');
    await press(list(), '#fab', '[new-memo] 노란 +');
    await wait(350);
    const before = new Set(noteWins.keys());
    await press(list(), '#fab-menu [data-new="text"]', '[new-memo] 글 메모');
    const memoId = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), '튜토리얼 메모 창');
    const note = () => noteWins.get(memoId);
    await until(() => js(note(), 'document.documentElement.dataset.ready === "true"'), '메모 준비', 12000);
    const size = note().getSize();
    check('튜토리얼 메모 창은 넓게 (말풍선과 함께 해 볼 수 있게)', size[0] >= 540 && size[1] >= 600, JSON.stringify(size));

    // ---------- 메모 창 ----------
    await arrive(note, 'write');
    await press(note(), '.ProseMirror', '[write] 본문');
    note().webContents.insertText('장보기 목록');
    await wait(200);
    await arrive(note, 'style', { praise: true });
    await press(note(), '.format-bar .style-btn', '[style] "본문" 단추');
    await wait(250);
    await press(note(), '#style-menu [data-style="h2"]', '[style] 제목 2');
    await arrive(note, 'lists', { praise: true });
    await press(note(), '[data-cmd="task"]', '[lists] 체크리스트');
    await arrive(note, 'move', { praise: true });
    const items = await js(note(), `[...document.querySelectorAll('.ProseMirror li')].map((li) => li.textContent.trim())`);
    check('[move] 옮겨 볼 예시 목록(우유·달걀·사과·식빵)이 저절로 들어감', ['우유', '달걀', '사과', '식빵'].every((w) => items.includes(w)), JSON.stringify(items));
    await next(note, 'move');
    await arrive(note, 'add');
    await press(note(), '#add-btn', '[add] 왼쪽 아래 +');
    await arrive(note, 'ink', { praise: true });
    await press(note(), '#add-menu [data-add="ink"]', '[ink] 손 메모');
    await until(() => js(note(), `!!document.querySelector('.ink-sheet')`), '그리기 화면');
    const hidden = await js(note(), `getComputedStyle(document.querySelector('.coach-bubble')).visibility === 'hidden'`);
    check('[ink] 그리는 동안 말풍선이 숨어 그리기를 가리지 않음', hidden);
    const [w, h] = note().getContentSize();
    await drag(note(), Array.from({ length: 12 }, (_, i) => [w * 0.2 + i * 18, h * 0.4 + Math.sin(i / 1.8) * 30]));
    await capture(note(), 'ink-drawing');
    await press(note(), '.ink-sheet .ink-done', '[ink] 완료');
    await arrive(note, 'annotate', { praise: true });
    await press(note(), '#add-btn', '[annotate] +');
    await wait(300);
    await press(note(), '#add-menu [data-add="annotate"]', '[annotate] 주석');
    await until(() => js(note(), `!!document.querySelector('.mk-annot.drawing')`), '주석 모드');
    const line = await probe(note(), '.ProseMirror > :first-child', 'text');
    await drag(note(), [[line.left, line.bottom + 2], [line.left + 60, line.bottom + 4], [line.right, line.bottom + 2]]);
    await press(note(), '.mk-annot-bar .ink-done', '[annotate] 완료');
    const annot = await until(() => {
      const m = vault.get(memoId);
      return m?.ink && JSON.parse(fs.readFileSync(path.join(VAULT, m.ink), 'utf8')).strokes.length;
    }, '주석 저장', 5000).catch(() => 0);
    check('[annotate] 글 위에 그은 주석이 저장됨', annot >= 1, JSON.stringify(vault.get(memoId)?.ink));
    await arrive(note, 'voice', { praise: true });
    await next(note, 'voice');
    await arrive(note, 'tag');
    await press(note(), '.ProseMirror > :last-child', '[tag] 마지막 줄');
    note().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
    await wait(80);
    note().webContents.insertText(' #할일 ');
    await arrive(note, 'crown', { praise: true });
    await press(note(), '#top-btn', '[crown] 왕관');
    await arrive(note, 'bell', { praise: true });
    for (const id of ['bell', 'links']) {
      await next(note, id);
      await arrive(note, id === 'bell' ? 'links' : 'bar');
    }
    await next(note, 'bar');
    await arrive(note, 'close');
    await press(note(), '#close-btn', '[close] ×');

    // ---------- 목록 ----------
    await arrive(list, 'cards', { praise: true });
    await next(list, 'cards');
    await arrive(list, 'layout');
    await press(list(), '#layout-btn', '[layout] 보기 바꾸기');
    await arrive(list, 'filters', { praise: true });
    await press(list(), '#tag-strip .tag-chip[data-tag="할일"]', '[filters] #할일');
    await arrive(list, 'tabs', { praise: true });
    for (const [id, to] of [['tabs', 'quick'], ['quick', 'capture'], ['capture', 'magic'], ['magic', 'settings'], ['settings', 'done']]) {
      await next(list, id);
      await arrive(list, to);
    }
    await next(list, 'done');
    const finished = await until(async () => !getTutorial().active && (await stepOf(list())) === null, '튜토리얼 끝').then(() => true).catch(() => false);
    check('끝까지 따라 하면 말풍선이 사라지고 끝', finished);
    const body = vault.get(memoId)?.body ?? '';
    check('따라 한 결과가 메모에 그대로 (굵게 · 체크리스트 · 손 메모 · 태그)', /\*\*/.test(body) && /\[[ x]\]/.test(body) && /!\[손 메모\]/.test(body) && /#할일/.test(body), body);

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  }
  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `튜토리얼 따라 하기 점검 통과 (${checks.length}개)` : '튜토리얼 따라 하기 점검 실패');
  app.exit(exitCode);
}
