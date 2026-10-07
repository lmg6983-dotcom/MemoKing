// 바뀐 기능만 확인하는 짧은 점검 (npm run smoke:new) — 전체 점검(npm run smoke)은 요청할 때만.
// 버전마다 아래 "이번 버전" 부분을 새 기능에 맞게 바꾼다. 임시 폴더(%TEMP%\memoking-smoke)만 쓴다.
// 이번 버전: v0.25.0 — 매직키 검색: 비슷한 것부터 몇 개 + "다른 n건 더 보기" → 모두 찾기 창(Everything 처럼),
//            줄마다 할 일(PowerToys Run 처럼 ← → · 단추): 열기 · 경로 복사 · 폴더 열기 · 파일 복사
import { app, clipboard } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileIndex } from './file-index.js';

const SMOKE_DIR = path.join(os.tmpdir(), 'memoking-smoke');
const VAULT = path.join(SMOKE_DIR, 'vault');
const FILES = path.join(SMOKE_DIR, 'files');
const OUT = app.isPackaged ? path.join(SMOKE_DIR, 'out') : path.join(import.meta.dirname, '..', 'out');

export function prepareSmoke(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.rmSync(VAULT, { recursive: true, force: true });
  fs.rmSync(FILES, { recursive: true, force: true });
  fs.mkdirSync(VAULT, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ vaultPath: VAULT, tutorialDone: true }));
  // 찾을 파일: '견적서' 가 30개 + 폴더 1개 (매직키 창에는 몇 개만, 나머지는 "다른 n건")
  fs.mkdirSync(path.join(FILES, '견적서 모음'), { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(FILES, `견적서 ${String(i).padStart(2, '0')}.txt`), 'x'.repeat(i * 100));
}

export async function runSmoke({ getVault, showMagic, getMagic, getFinder, useFileIndex }) {
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
  async function capture(win, name) {
    await wait(400);
    try {
      fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      console.warn(`화면을 찍지 못했어요 (${name}): ${err.message}`); // 화면 없는 점검 환경 — 점검은 이어서
    }
  }
  const key = (win, keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };

  let exitCode = 1;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const vault = getVault();
    for (let i = 0; i < 7; i++) vault.save(vault.create(), `# 견적서 메모 ${i + 1}\n\n거래처 견적 정리`);
    const idx = new FileIndex({ roots: () => [{ dir: FILES }] });
    idx.stopped = false;
    await idx.rebuild();
    useFileIndex(idx);

    // 1) 매직키: 비슷한 것부터 몇 개 + 맨 아래 "다른 n건 더 보기"
    showMagic();
    const magic = await until(() => getMagic(), '매직키 창');
    await until(() => js(magic, `!!document.getElementById('magic-input')`), '매직키 화면');
    await js(magic, `(() => { const i = document.getElementById('magic-input'); i.value = '견적서'; i.dispatchEvent(new Event('input')); })()`);
    const rows = await until(() => js(magic, `(() => { const r = [...document.querySelectorAll('.magic-row')].map((e) => e.className.split('kind-')[1] + ':' + e.querySelector('.t').textContent); return r.some((x) => x.startsWith('more')) && r; })()`), '검색 결과');
    const more = rows.find((r) => r.startsWith('more'));
    // 메모 7개 중 5 + 폴더 1 + 파일 30개 중 6 → 다른 2 + 24 = 26건
    check('매직키: 비슷한 것부터 몇 개씩, 나머지는 맨 아래 "다른 n건 더 보기"', rows.filter((r) => r.startsWith('file')).length === 6 && more === 'more:다른 26건 더 보기', JSON.stringify(rows));

    // 2) 파일 줄 → → 경로 복사 (Enter) — 클립보드에 그 경로
    const fileRow = rows.findIndex((r) => r.startsWith('file'));
    const firstNew = rows[0].startsWith('new') ? 0 : -1;
    for (let i = 0; i < fileRow - Math.max(0, firstNew); i++) key(magic, 'Down');
    await wait(150);
    key(magic, 'Right');
    await wait(150);
    const sel = await js(magic, `(() => { const r = document.querySelector('.magic-row[aria-selected="true"]'); return { kind: r.className, act: r.querySelector('.act-btn.on')?.dataset.action, path: r.querySelector('.s').title }; })()`);
    clipboard.writeText('');
    key(magic, 'Return');
    const copied = await until(() => clipboard.readText(), '경로 복사').catch(() => '');
    await capture(magic, 'smoke-new-magic.png');
    check('→ 로 "경로 복사" 를 고르고 Enter → 그 파일 경로가 클립보드에', sel.act === 'copyPath' && copied.endsWith('.txt') && copied.includes('견적서'), JSON.stringify({ sel, copied }));

    // 3) "다른 n건" → 모두 찾기 창: 전부(31 + 메모 7), 열 · 탭 · 크기
    showMagic();
    await wait(300);
    await js(magic, `(() => { const i = document.getElementById('magic-input'); i.value = '견적서'; i.dispatchEvent(new Event('input')); })()`);
    await until(() => js(magic, `!!document.querySelector('.magic-row.kind-more')`), '다른 n건 줄');
    await js(magic, `document.querySelector('.magic-row.kind-more').click()`);
    const finder = await until(() => getFinder(), '모두 찾기 창');
    await until(() => js(finder, `document.querySelectorAll('.frow').length > 0`), '모두 찾기 결과', 10000);
    const f = await until(() => js(finder, `(() => {
      const tabs = Object.fromEntries([...document.querySelectorAll('.finder-tabs [data-kind]')].map((b) => [b.dataset.kind, b.querySelector('.n').textContent]));
      const sizes = [...document.querySelectorAll('.frow .col-size')].map((e) => e.textContent).filter(Boolean);
      return sizes.length && { tabs, q: document.getElementById('finder-input').value, sizes: sizes.length, count: document.getElementById('finder-count').textContent };
    })()`), '크기 채우기');
    check('모두 찾기 창: 찾던 말 그대로 · 메모 7 / 폴더 1 / 파일 30 모두 · 크기 열', f.q === '견적서' && f.tabs.all === '38' && f.tabs.note === '7' && f.tabs.folder === '1' && f.tabs.file === '30' && f.sizes > 0, JSON.stringify(f));
    // 크기 열로 줄 세우기 (큰 것부터)
    await js(finder, `document.querySelector('.finder-head [data-sort="size"]').click()`);
    const top = await until(() => js(finder, `(() => { const n = document.querySelector('.frow .nm')?.textContent; return n === '견적서 29.txt' && n; })()`), '크기 순').catch(() => null);
    check('열 머리(크기)를 누르면 큰 것부터', top === '견적서 29.txt', top);
    // 할 일: → → 폴더 열기 단추가 고른 줄에
    await js(finder, `document.querySelector('.finder-tabs [data-kind="file"]').click()`);
    finder.focus();
    key(finder, 'Right');
    key(finder, 'Right');
    await wait(200);
    const fact = await js(finder, `document.querySelector('.frow[aria-selected="true"] .act-btn.on')?.dataset.action`);
    clipboard.writeText('');
    await js(finder, `document.querySelector('.frow[aria-selected="true"] [data-action="copyPath"]').click()`);
    const fcopied = await until(() => clipboard.readText(), '모두 찾기 경로 복사').catch(() => '');
    const status = await js(finder, `document.getElementById('finder-status').textContent`);
    await capture(finder, 'smoke-new-finder.png');
    check('모두 찾기: ← → 로 할 일(폴더 열기)을 고르고, 단추로 경로 복사 → "복사했어요"', fact === 'reveal' && fcopied.includes('견적서') && /복사했어요/.test(status), JSON.stringify({ fact, fcopied, status }));
    finder.close();

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  }

  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `바뀐 기능 점검 통과 (${checks.length}개)` : '바뀐 기능 점검 실패');
  app.exit(exitCode);
}
