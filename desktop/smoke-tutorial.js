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
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ vaultPath: VAULT, tutorialDone: true, workLife: true })); // Work / Life 단계도 직접 해 보게
}

export async function runSmoke({ noteWins, getVault, getList, createListWindow, startTutorial, getTutorial, openNote, getSettings }) {
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
    // 연습 공간: 열어 둔 실제 메모 창은 튜토리얼 동안 닫히고, 화면은 예시 메모가 든 다른 폴더를 쓴다
    openNote(keep);
    await until(() => noteWins.get(keep)?.isVisible(), '실제 메모 창', 6000);
    await startTutorial();
    const box = getVault();
    const boxTitles = box.list().map((m) => m.title);
    check('연습 공간: 실제 메모 폴더가 아닌 다른 폴더에 예시 메모 · 내 메모는 안 보임 · 내 메모 창은 닫힘',
      box !== vault && box.root !== vault.root && boxTitles.includes('연습 공간이에요') && !boxTitles.includes('회의 메모') && !noteWins.has(keep), `${box.root} ${JSON.stringify(boxTitles)}`);
    await arrive(list, 'welcome');
    await next(list, 'welcome');
    // 메모킹만의 기능 (0.68.0~ 목록 창에서만): 매직 카피 · 화면 자르기는 Windows 단축키라 "다음에 해 볼게요" 로
    for (const [id, to] of [['quick', 'capture'], ['capture', 'list-crown']]) {
      await arrive(list, id);
      await next(list, id);
    }
    await arrive(list, 'list-crown');
    await press(list(), '#list-top-btn', '[list-crown] 왕관');
    await arrive(list, 'history', { praise: true });
    await next(list, 'history');
    // Work 로 바꿔 보고 다시 Life 로
    await arrive(list, 'mode');
    await press(list(), '#mode-switch [data-mode="work"]', '[mode] Work');
    await wait(700);
    await press(list(), '#mode-switch [data-mode="life"]', '[mode] Life');
    await arrive(list, 'done', { praise: true });
    check('메모를 만들지 않음 (목록 창에서만)', box.list().length === boxTitles.length, JSON.stringify(box.list().map((m) => m.title)));
    await next(list, 'done');
    const finished = await until(async () => !getTutorial().active && (await stepOf(list())) === null, '튜토리얼 끝').then(() => true).catch(() => false);
    check('끝까지 따라 하면 말풍선이 사라지고 끝', finished);
    // 뒷정리: 연습하며 바꾼 목록 늘 위에 · Work / Life 는 처음대로
    const after = await until(() => js(list(), `(() => {
      const r = { layout: document.getElementById('cards').dataset.layout, zoom: document.body.dataset.listZoom, tags: [...document.querySelectorAll('#tag-strip .tag-chip[aria-pressed="true"]')].length, top: document.getElementById('list-top-btn').getAttribute('aria-pressed'), mode: document.documentElement.dataset.mode, panel: document.getElementById('filter-panel').hidden };
      return r.layout === 'grid' && r.tags === 0 && r.top === 'false' && r.panel ? r : null;
    })()`), '뒷정리', 3000).catch(() => null);
    check('끝나면 연습으로 바꾼 것은 처음대로 (격자 · 태그 고르기 없음 · 늘 위 아님 · Life)', after && after.zoom === '1' && after.mode === 'life' && !list().isAlwaysOnTop(), JSON.stringify(after));
    // 끝나면 실제 메모 폴더로: 연습 메모는 남지 않고, 닫아 두었던 내 메모 창은 다시 열린다
    const back = await until(() => getVault() === vault && noteWins.get(keep)?.isVisible(), '내 메모로 돌아옴', 6000).then(() => true).catch(() => false);
    const s = getSettings();
    check('끝나면 내 메모로: 실제 폴더에는 내 메모 하나뿐 · 연습 폴더는 지워짐 · 내 메모 창이 다시 열림',
      back && vault.list().length === 1 && vault.list()[0].id === keep && !fs.existsSync(box.root),
      JSON.stringify({ back, list: vault.list().map((m) => m.title), boxLeft: fs.existsSync(box.root), open: s.openNotes }));

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  }
  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `튜토리얼 따라 하기 점검 통과 (${checks.length}개)` : '튜토리얼 따라 하기 점검 실패');
  app.exit(exitCode);
}
