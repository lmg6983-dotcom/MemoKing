// 바뀐 기능만 확인하는 짧은 점검 (npm run smoke:new) — 전체 점검(npm run smoke)은 요청할 때만.
// 버전마다 아래 "이번 버전" 부분을 새 기능에 맞게 바꾼다. 임시 폴더(%TEMP%\memoking-smoke)만 쓴다.
// 이번 버전: v0.26.0 — OPMS 조회: 매직키에 관리번호·출원번호 → OPMS 사건 → OPMS 창(정보 · 전자포대 받기 · 청구서 · 해외출원)
//            회사 서버 대신 이 점검이 띄우는 가짜 서버(/servlet/Jbori · /OPMS/…)로 한다
//   v0.25.0 — 매직키 검색: 비슷한 것부터 몇 개 + "다른 n건 더 보기" → 모두 찾기 창(Everything 처럼),
//            줄마다 할 일(PowerToys Run 처럼 ← → · 단추): 열기 · 경로 복사 · 폴더 열기 · 파일 복사
import * as electronApi from 'electron';
import { app, clipboard, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FileIndex } from './file-index.js';
import { smokeOpened } from './utils.js';

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

// 가짜 OPMS 서버: 받은 SELECT 글을 보고 표를 돌려준다 (1줄 열 이름 · 2~4줄 정보 · 5줄부터 자료, \x01 로 나눔)
function fakeOpms() {
  const table = (cols, rows) => [cols.join('\x01'), 'm', 'm', 'm', ...rows.map((r) => r.join('\x01'))].join('\n');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url.startsWith('/OPMS/')) return res.end(`FILE ${decodeURIComponent(req.url)}`);
      const sql = new URLSearchParams(body).get('sql') ?? '';
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (/FROM opms_app/.test(sql)) {
        return res.end(table(['idx', 'div', 'ourref', 'yourref', 'n_app', 'd_app', 'applicant', 'inventor', 'title_kor', 'd_accept', 'ck_out'], [
          ['101', '특허', 'FPD/2026-0271/E', 'Y-77', '10-2026-0012345', '2026-02-03 00:00:00.0', '메모킹 주식회사', '홍길동', '메모를 쉽게 쓰는 장치', '2026-01-10 00:00:00.0', 'N'],
          ['102', '특허', 'FPD/2026-0271/D', 'Y-78', '10-2026-0099999', '', '메모킹 주식회사', '', '두 번째 사건', '2026-01-09 00:00:00.0', 'N'],
        ]));
      }
      if (/FROM opms_attach/.test(sql)) {
        // 회사 서버와 같은 열: 요약은 MEMO, 올린 사람은 MUNAME (로그인 ID MUID 는 보이지 않아야)
        return res.end(table(['IDX', 'DOC_NAME', 'FILE_NAME_ORI', 'FILE_NAME_UPLOAD', 'FILE_SIZE', 'registered_at', 'MEMO', 'MUID', 'MUNAME'], [
          ['1', '출원서', '출원서.pdf', 'up/a1.pdf', '2048', '2026-02-03 10:00:00', '최초 출원 서류', 'kim01', '김변리'],
          ['2', '명세서', '명세서.docx', 'up/a2.docx', '4096', '2026-02-04 10:00:00', '', 'lee02', '이사무'],
        ]));
      }
      if (/view_opms_mywork/.test(sql)) return res.end(table(['div_job', 'per_name', 'per_gubun', 'd_rec', 'd_due', 'd_end', 'detail', 'memo'], [['명세서 작성', '김변리', '담당', '2026-01-11', '2026-02-01', '', '초안', '']]));
      if (/view_opms_dem_kor/.test(sql)) return res.end(table(['d_demand', 'n_demand', 'div', 'div_sub', 'dem_memo', 'amount', 'amount_off_fee', 'memo'], [['2026-02-05 00:00:00.0', 'D-1', '청구', '출원', '출원 비용', '1,200,000', '900,000', '']]));
      if (/view_opms_family_link/.test(sql)) return res.end(table(['ourref', 'yourref', 'app_ncode', 'n_app', 'status', 'attorney_out', '_div'], [['FPD/2026-0271/US', 'Y-77-US', 'US', '18/123,456', '출원', 'Smith LLP', '해외']]));
      return res.end(table(['idx'], []));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, host: `http://127.0.0.1:${server.address().port}` })));
}

export async function runSmoke({ getVault, showMagic, getMagic, getFinder, useFileIndex, getOpms, getSettings, getList, noteWins, createListWindow, memoHotkeys, smokeHud, windowManager }) {
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
      const img = await Promise.race([win.webContents.capturePage(), wait(3000).then(() => { throw new Error('시간 초과'); })]);
      fs.writeFileSync(path.join(OUT, name), img.toPNG());
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

    // 4) OPMS: 매직키에 관리번호 → OPMS 사건 두 건이 맨 위 → Enter → OPMS 창
    const fake = await fakeOpms();
    process.env.MEMOKING_OPMS_HOST = fake.host;
    const wrapperDir = path.join(SMOKE_DIR, 'wrapper');
    getSettings().opms = { wrapperDir };
    showMagic();
    await wait(300);
    await js(magic, `(() => { const i = document.getElementById('magic-input'); i.value = 'FPD/2026-0271'; i.dispatchEvent(new Event('input')); })()`);
    const opmsRows = await until(() => js(magic, `(() => { const r = [...document.querySelectorAll('.magic-row.kind-opms')].map((e) => e.querySelector('.t').textContent + ' | ' + e.querySelector('.s').textContent); return r.length && r; })()`), 'OPMS 결과', 8000);
    const firstKind = await js(magic, `[...document.querySelectorAll('.magic-row')].map((e) => e.className.split('kind-')[1])[1]`);
    check('매직키: 관리번호를 쓰면 OPMS 사건이 맨 위에 (관리번호 · 출원번호 / 출원인 · 명칭)', opmsRows.length === 2 && firstKind === 'opms' && opmsRows[0].includes('FPD/2026-0271/E, 10-2026-0012345') && opmsRows[0].includes('메모킹 주식회사'), JSON.stringify(opmsRows));
    // 관리번호 복사 (→ → → 세 번째 할 일은 관리번호 복사)
    await js(magic, `(() => { const rows = [...document.querySelectorAll('.magic-row')]; const i = rows.findIndex((e) => e.classList.contains('kind-opms')); rows[i].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); })()`);
    await wait(100);
    key(magic, 'Right');
    key(magic, 'Right');
    await wait(150);
    const opAct = await js(magic, `document.querySelector('.magic-row[aria-selected="true"] .act-btn.on')?.dataset.action`);
    clipboard.writeText('');
    key(magic, 'Return');
    const ourCopied = await until(() => clipboard.readText(), '관리번호 복사').catch(() => '');
    check('OPMS 줄: → 로 "관리번호 복사" → 클립보드에 사무소관리번호', opAct === 'copyOur' && ourCopied === 'FPD/2026-0271/E', JSON.stringify({ opAct, ourCopied }));
    // 사건 보기 — 다시 띄우면 지난번에 친 글이 남아 있고 통째로 골라져 있다 (바로 치면 바뀜)
    showMagic();
    await wait(300);
    const kept = await js(magic, `(() => { const i = document.getElementById('magic-input'); return { v: i.value, s: i.selectionStart, e: i.selectionEnd, focus: document.activeElement === i }; })()`);
    check('매직키: 다시 띄우면 지난번 글이 남아 있고 통째로 골라짐', kept.v === 'FPD/2026-0271' && kept.s === 0 && kept.e === kept.v.length && kept.focus, JSON.stringify(kept));
    // 남겨 둔 글을 손대지 않았으면 Esc 한 번에 닫힌다 · 첫 줄("메모로 저장")이 아니라 찾은 결과가 골라져 있다
    const firstPick = await until(() => js(magic, `document.querySelector('.magic-row[aria-selected="true"]')?.className.match(/kind-(\\w+)/)?.[1]`), '골라진 줄', 4000).catch(() => '');
    magic.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    magic.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    const closedOnce = await until(() => !magic.isVisible(), 'Esc 로 닫힘', 3000).catch(() => false);
    check('매직키: 남겨 둔 글이면 Esc 한 번에 닫힘 · 골라진 줄은 "메모로 저장" 이 아님', closedOnce && firstPick && firstPick !== 'new', JSON.stringify({ closedOnce, firstPick }));
    showMagic();
    await wait(300);
    await js(magic, `(() => { const i = document.getElementById('magic-input'); i.value = 'FPD/2026-0271'; i.dispatchEvent(new Event('input')); })()`);
    await until(() => js(magic, `!!document.querySelector('.magic-row.kind-opms')`), 'OPMS 줄');
    await js(magic, `document.querySelector('.magic-row.kind-opms').click()`);
    const ow = await until(() => getOpms(), 'OPMS 창');
    const info = await until(() => js(ow, `(() => {
      const t = document.querySelector('.op-table');
      return t && { our: document.getElementById('op-our').textContent, badge: document.getElementById('op-badge').textContent,
        app: [...document.querySelectorAll('.op-info dd')].map((d) => d.textContent).join('|'), work: t.querySelector('tbody td')?.textContent };
    })()`), 'OPMS 정보', 10000);
    check('OPMS 창 정보: 서지 · 업무배분 · 해외출원 배지', info.our === 'FPD/2026-0271/E' && info.app.includes('10-2026-0012345') && info.app.includes('2026-02-03') && info.work === '명세서 작성' && /해외 1건 \(US\)/.test(info.badge), JSON.stringify(info));
    // 청구서 · 해외출원
    await js(ow, `document.querySelector('[data-tab="bills"]').click()`);
    const bill = await until(() => js(ow, `document.querySelector('.op-table tbody tr')?.textContent`), '청구서');
    await js(ow, `document.querySelector('[data-tab="foreign"]').click()`);
    const foreign = await until(() => js(ow, `document.querySelector('.op-table tbody tr')?.textContent`), '해외출원');
    check('청구서 · 해외출원 탭', bill.includes('D-1') && bill.includes('1,200,000') && foreign.includes('US') && foreign.includes('Smith LLP'), JSON.stringify({ bill, foreign }));
    // 전자포대: 전체 받기 → 관리번호 폴더에 파일 + 사건정보.txt
    await js(ow, `document.querySelector('[data-tab="wrapper"]').click()`);
    await until(() => js(ow, `document.querySelectorAll('.op-table tbody tr').length === 2`), '전자포대 목록');
    const wrapCols = await js(ow, `({ head: [...document.querySelectorAll('.op-table thead th')].map((t) => t.textContent), rows: [...document.querySelectorAll('.op-table tbody tr')].map((r) => r.textContent) })`);
    check('전자포대: 요약(MEMO) · 등록자(MUNAME) 열 — 로그인 ID 는 안 보임', wrapCols.head.includes('요약') && wrapCols.head.includes('등록자')
      && wrapCols.rows.some((t) => t.includes('최초 출원 서류') && t.includes('김변리')) && !wrapCols.rows.some((t) => t.includes('kim01')), JSON.stringify(wrapCols));
    await js(ow, `[...document.querySelectorAll('#op-foot .op-btn')].find((b) => b.textContent.startsWith('전체 받기')).click()`);
    const st = await until(() => js(ow, `(() => { const s = document.querySelector('#op-foot .op-status'); return s && /저장/.test(s.textContent) && s.textContent; })()`), '전자포대 받기', 10000).catch(() => '');
    const folder = path.join(wrapperDir, 'FPD20260271E_Y77');
    const saved = fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
    await capture(ow, 'smoke-new-opms.png');
    check('전자포대 전체 받기 → 관리번호 폴더에 파일들 + 사건정보.txt', saved.join(',') === '명세서.docx,사건정보.txt,출원서.pdf' && fs.readFileSync(path.join(folder, '출원서.pdf'), 'utf8') === 'FILE /OPMS/up/a1.pdf' && /2개 저장/.test(st), JSON.stringify({ st, saved }));
    ow.close();
    fake.server.close();

    // 표 막대 (v0.32): 묶음(행 · 열 · 칸 · 표 · 바꾸기) · 아래 서식 도구막대가 숨었다 나타나도 표 막대는 제자리
    {
      const list = getList() ?? createListWindow();
      await until(() => js(list, `document.documentElement.dataset.ready === 'true'`), '목록 준비');
      const before = new Set(noteWins.keys());
      await js(list, `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`);
      const id = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), '새 메모 창');
      const w = noteWins.get(id);
      await until(() => js(w, `document.documentElement.dataset.ready === 'true'`), '메모 준비');
      w.focus();
      w.webContents.focus();
      await js(w, `document.querySelector('.ProseMirror').focus()`);
      w.webContents.insertText('표 점검');
      await wait(150);
      await js(w, `document.querySelector('[data-add="table"]').click()`);
      await wait(150);
      // 첫 칸을 실제로 눌러 커서를 표 안에 (표 막대는 커서가 표에 있을 때)
      const cell = await js(w, `(() => { const r = document.querySelector('.mk-doc td, .mk-doc th').getBoundingClientRect(); return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) }; })()`);
      for (const type of ['mouseDown', 'mouseUp']) w.webContents.sendInputEvent({ type, x: cell.x, y: cell.y, button: 'left', clickCount: 1 });
      const shownBar = await until(() => js(w, `!document.getElementById('table-bar').hidden`), '표 막대', 4000).catch(() => false);
      const groups = await js(w, `[...document.querySelectorAll('#table-bar .tb-group')].map((g) => g.getAttribute('aria-label') + ':' + [...g.querySelectorAll('button:not([hidden])')].map((b) => b.querySelector('.lbl').textContent).join('/'))`);
      const barTop = (hidden) => js(w, `(() => { document.body.classList.toggle('bar-hidden', ${hidden}); return document.getElementById('table-bar').getBoundingClientRect().top; })()`);
      const shown = await barTop(false);
      const hiddenTop = await barTop(true);
      await barTop(false);
      await capture(w, 'smoke-new-table-bar.png');
      check('표 막대: 행 · 열 · 칸 · 표 · 바꾸기 묶음 (아이콘 + 짧은 이름)', shownBar && groups.length === 5 && groups[0].startsWith('행:추가/삭제') && groups.every((g) => g.split(':')[1]),
        JSON.stringify({ shownBar, groups, doc: await js(w, `document.querySelector('.ProseMirror').innerHTML.slice(0, 200)`) }));
      check('표 막대: 아래 서식 도구막대가 숨어도 제자리 (단추가 커서를 피하지 않음)', Math.abs(shown - hiddenTop) < 1, JSON.stringify({ shown, hiddenTop }));

      // 그림 복사: 그림이 든 메모를 열어 그림에 마우스를 올리면 × 옆에 복사 단추 → 누르면 시스템 클립보드에 그림 그대로
      const iconPng = nativeImage.createFromPath(path.join(import.meta.dirname, '..', 'assets', 'icons', 'icon-256.png')).toPNG();
      // Electron 44 클립보드: write([ClipboardItem]) · read() (옛 writeImage · readImage 없음)
      const pngInClipboard = async () => {
        for (const item of await clipboard.read()) {
          if (item.types.includes('image/png')) return (await item.getType('image/png')).size;
        }
        return 0;
      };
      const vault = getVault();
      fs.mkdirSync(path.join(vault.root, 'attachments'), { recursive: true });
      fs.writeFileSync(path.join(vault.root, 'attachments', 'smoke-copy.png'), iconPng);
      const picId = vault.import({ body: '# 그림 복사\n\n![그림](attachments/smoke-copy.png)\n' });
      const beforePic = new Set(noteWins.keys());
      await until(() => js(list, `!!document.querySelector('.card[data-id="${picId}"], [data-id="${picId}"]')`), '그림 메모 카드');
      await js(list, `document.querySelector('[data-id="${picId}"]').click()`);
      const pid = await until(() => [...noteWins.keys()].find((k) => !beforePic.has(k)), '그림 메모 창');
      const pw = noteWins.get(pid);
      await until(() => js(pw, `document.documentElement.dataset.ready === 'true'`), '그림 메모 준비');
      const img = await until(() => js(pw, `(() => { const i = document.querySelector('.mk-doc img.mk-image'); if (!i || !i.complete || !i.naturalWidth) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`), '메모 속 그림', 6000).catch(() => null);
      let copied = false;
      let copyShown = false;
      let still = false;
      if (img) {
        pw.webContents.sendInputEvent({ type: 'mouseMove', x: img.x, y: img.y });
        copyShown = await until(() => js(pw, `!!document.querySelector('.mk-copy-btn')`), '복사 단추', 3000).catch(() => false);
        clipboard.writeText('비움');
        if (copyShown) {
          const b = await js(pw, `(() => { const r = document.querySelector('.mk-copy-btn').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
          pw.webContents.sendInputEvent({ type: 'mouseMove', x: b.x, y: b.y });
          await wait(400); // × · 복사 단추로 옮겨 가는 사이에도 단추는 그대로여야
          still = await js(pw, `!!document.querySelector('.mk-copy-btn')`);
          pw.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          await wait(300);
          pw.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          copied = await until(async () => (await pngInClipboard()) > 1000, '그림 복사', 4000).catch(async () => `${await js(pw, `(() => { const b = document.querySelector('.mk-copy-btn'); return b ? b.className + ' | ' + b.title : '단추 없음'; })()`)} | ${JSON.stringify((await clipboard.read()).map((i) => i.types))}`);
          await capture(pw, 'smoke-new-copy-btn.png');
        }
      }
      // 그림을 눌러 골라 둔 채 Ctrl+C → 그림 그대로 (주소가 아니라)
      let ctrlC = false;
      if (img) {
        clipboard.writeText('비움');
        for (const type of ['mouseDown', 'mouseUp']) pw.webContents.sendInputEvent({ type, x: img.x, y: img.y, button: 'left', clickCount: 1 });
        await wait(200);
        const picked = await js(pw, `document.querySelector('.mk-doc img.mk-image.ProseMirror-selectednode, .mk-doc .ProseMirror-selectednode img.mk-image') ? true : false`);
        pw.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
        pw.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
        ctrlC = await until(async () => (await pngInClipboard()) > 1000, 'Ctrl+C 그림', 4000).catch(async () => `picked=${picked} ${JSON.stringify((await clipboard.read()).map((i) => i.types))}`);
      }
      check('그림 복사: 그림을 눌러 골라 Ctrl+C → 그림 그대로', ctrlC === true, String(ctrlC));
      check('그림 복사: 마우스를 올리면 × 옆에 복사 단추 · 누르면 클립보드에 그림 그대로', Boolean(img) && copyShown && still && copied === true, JSON.stringify({ img, copyShown, copied, file: vault.get(picId)?.file, doc: img ? '' : await js(pw, `document.querySelector('.mk-doc')?.innerHTML.slice(0, 300)`) }));
      pw.close();
      w.close();
    }

    // ---------- v0.33 — 메모 창 바로 뜨기(예비 창) · PDF · 표 · 수식 등에 마우스를 올려 복사 · 지우기 ----------
    {
      const list = getList() ?? createListWindow();
      await until(() => js(list, `document.readyState === 'complete'`), '목록 창');
      const vault = getVault();
      fs.mkdirSync(path.join(vault.root, 'attachments'), { recursive: true });
      fs.writeFileSync(path.join(vault.root, 'attachments', '안내 자료.pdf'), '%PDF-1.4\n% smoke\n');
      const body = '# 콘텐츠 복사\n\n[안내 자료.pdf](attachments/안내%20자료.pdf)\n\n| 이름 | 값 |\n| --- | --- |\n| 가 | 1 |\n\n$$\nx^2\n$$\n\n끝 문단\n';
      const cid = vault.import({ body });
      // 예비 창이 준비될 때까지 (목록이 뜨고 조금 뒤 만들어 둔다)
      await wait(2500);
      await until(() => js(list, `!!document.querySelector('[data-id="${cid}"]')`), '콘텐츠 메모 카드');
      const before = new Set(noteWins.keys());
      const winsBefore = new Set(electronApi.BrowserWindow.getAllWindows().map((x) => x.id)); // 예비 창은 누르기 전부터 있다
      const t0 = Date.now();
      await js(list, `document.querySelector('[data-id="${cid}"]').click()`);
      const nid = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), '콘텐츠 메모 창');
      const nw = noteWins.get(nid);
      await until(() => nw.isVisible(), '메모 창 보임');
      const openMs = Date.now() - t0;
      const fromSpare = winsBefore.has(nw.id);
      await until(() => js(nw, `document.documentElement.dataset.ready === 'true'`), '콘텐츠 메모 준비');
      const shownRight = await js(nw, `new URLSearchParams(location.search).get('id') === ${JSON.stringify(nid)} && document.querySelector('.mk-doc h1')?.textContent === '콘텐츠 복사'`);
      check('메모 창 바로 뜨기: 미리 불러 둔 예비 창으로 (300ms 안), 그 메모 내용 그대로', fromSpare && openMs < 300 && shownRight, JSON.stringify({ fromSpare, openMs, shownRight }));

      const hover = async (sel) => {
        const r = await js(nw, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + Math.min(10, r.height / 2)) }; })()`);
        if (!r) return null;
        nw.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
        return until(() => js(nw, `(() => { const b = document.querySelector('.mk-delete-btn.hover'); return b && b.getAttribute('aria-label'); })()`), `${sel} 단추`, 3000).catch(() => null);
      };
      const pressCopy = async () => {
        const b = await js(nw, `(() => { const r = document.querySelector('.mk-copy-btn').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        nw.webContents.sendInputEvent({ type: 'mouseMove', x: b.x, y: b.y });
        await wait(100);
        nw.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'left', clickCount: 1 });
        nw.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
        return until(() => js(nw, `document.querySelector('.mk-copy-btn.done')?.title`), '복사 ✓', 3000).catch(() => js(nw, `document.querySelector('.mk-copy-btn')?.title ?? '단추 없음'`));
      };
      const leave = async () => {
        nw.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
        await until(() => js(nw, `!document.querySelector('.mk-delete-btn')`), '단추 거둠', 2000).catch(() => {});
      };
      // PDF 파일 칩: 마우스를 올리면 "이 파일 복사 · 지우기", 복사는 파일 그대로
      const fileLabel = await hover('.mk-doc a[data-file]');
      const copiesBefore = smokeOpened.filter((o) => o.kind === 'copy-file').length;
      const fileDone = fileLabel ? await pressCopy() : '';
      const fileCopy = smokeOpened.filter((o) => o.kind === 'copy-file').at(-1);
      check('PDF 파일: 마우스를 올리면 복사 · 지우기, 복사하면 파일 그대로 클립보드에',
        fileLabel === '이 파일 지우기' && /파일을 복사했어요/.test(fileDone) && smokeOpened.filter((o) => o.kind === 'copy-file').length === copiesBefore + 1 && /안내 자료\.pdf$/.test(fileCopy?.target ?? ''),
        JSON.stringify({ fileLabel, fileDone, fileCopy }));
      await leave();
      // 표: 표째로 복사 (엑셀에 붙도록 칸 사이 탭 · 서식은 표 그대로)
      const tableLabel = await hover('.mk-doc .tableWrapper td');
      clipboard.writeText('비움');
      const tableDone = tableLabel ? await pressCopy() : '';
      const clip = async (type) => {
        for (const item of await clipboard.read()) if (item.types.includes(type)) return (await item.getType(type)).text();
        return '';
      };
      const tableText = await clip('text/plain');
      const tableHtml = await clip('text/html');
      check('표: 마우스를 올리면 "이 표 복사 · 지우기", 복사하면 칸 사이 탭 + 표 서식',
        tableLabel === '이 표 지우기' && /내용을 복사했어요/.test(tableDone) && /이름\t값\n가\t1/.test(tableText) && /<table/.test(tableHtml) && !/column-resize-handle|contenteditable/.test(tableHtml),
        JSON.stringify({ tableLabel, tableDone, tableText, html: tableHtml.slice(0, 200) }));
      await leave();
      // 수식: 마우스를 올리면 단추, 지우면 수식만 사라짐
      const mathLabel = await hover('.mk-doc .mk-math-block');
      if (mathLabel) {
        await js(nw, `document.querySelector('.mk-delete-btn').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
      }
      const mathGone = await until(() => js(nw, `!document.querySelector('.mk-doc .mk-math-block') && document.querySelector('.mk-doc').textContent.includes('끝 문단')`), '수식 지움', 3000).catch(() => false);
      check('수식: 마우스를 올리면 "이 수식 지우기", 누르면 수식만 지워짐', mathLabel === '이 수식 지우기' && mathGone, JSON.stringify({ mathLabel, mathGone }));
      nw.close();
    }

    // ---------- v0.33 — 줄 앞 띄어쓰기 지키기 (붙여넣기 · 치기 · 저장 · 복사) ----------
    {
      const list = getList() ?? createListWindow();
      const vault = getVault();
      const sid = vault.import({ body: '# 띄어쓰기\n\n끝\n' });
      await until(() => js(list, `!!document.querySelector('[data-id="${sid}"]')`), '띄어쓰기 메모 카드');
      const before = new Set(noteWins.keys());
      await js(list, `document.querySelector('[data-id="${sid}"]').click()`);
      const nid = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), '띄어쓰기 메모 창');
      let nw = noteWins.get(nid);
      await until(() => js(nw, `document.documentElement.dataset.ready === 'true'`), '띄어쓰기 메모 준비');
      const caretAtEnd = `(() => { const p = [...document.querySelectorAll('.mk-doc p')].at(-1); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`;
      await js(nw, caretAtEnd);
      key(nw, 'Enter');
      await wait(100);
      // 메모장에서 복사한 글 (HTML 없음)
      const pasted = '  국내사업부 대표 안내\n    네 칸 들여쓴 줄\n\t탭 줄\n\n- 목록은 목록\n\n마지막 줄';
      await js(nw, `(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(pasted)}); document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
      await wait(300);
      // 직접 친 줄 앞 띄어쓰기
      await js(nw, caretAtEnd);
      key(nw, 'Enter');
      await wait(100);
      for (const ch of ['  ', '직접 친 줄']) nw.webContents.insertText(ch);
      await wait(300);
      const shown = await js(nw, `[...document.querySelectorAll('.mk-doc p, .mk-doc li, .mk-doc pre')].map((e) => e.tagName + ':' + e.textContent)`);
      const N = ' ';
      const want = [`P:${N}${N}국내사업부 대표 안내`, `${N.repeat(4)}네 칸 들여쓴 줄`, `${N.repeat(4)}탭 줄`];
      const lines = await js(nw, `(() => { const p = [...document.querySelectorAll('.mk-doc p')].find((e) => e.textContent.includes('국내사업부')); return p ? p.querySelectorAll('br:not(.ProseMirror-trailingBreak)').length : -1; })()`);
      const inDoc = want.every((w) => shown.some((x) => x.includes(w))) && !shown.some((x) => x.startsWith('PRE:')) && shown.some((x) => x === 'LI:목록은 목록')
        && shown.some((x) => x === `P:${N}${N}직접 친 줄`) && lines === 2;
      check('줄 앞 띄어쓰기 · 줄바꿈: 메모장 글을 붙여도 · 직접 쳐도 그대로 (네 칸도 코드 블록이 되지 않음, 줄이 합쳐지지 않음)', inDoc, JSON.stringify({ shown, lines }));
      // 워드 · 메모킹에서 복사한 서식 글(HTML)의 들여쓰기도 그대로
      await js(nw, caretAtEnd);
      key(nw, 'Enter');
      await wait(80);
      await js(nw, `(() => { const dt = new DataTransfer(); dt.setData('text/html', '<p>&nbsp;&nbsp;워드에서 들여 쓴 줄&nbsp;&nbsp;끝</p>'); dt.setData('text/plain', '  워드에서 들여 쓴 줄  끝'); document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
      await wait(300);
      const htmlLine = await js(nw, `[...document.querySelectorAll('.mk-doc p')].map((p) => p.textContent).find((t) => t.includes('워드에서')) ?? ''`);
      check('서식 글(HTML)을 붙여도 줄 앞 들여쓰기 그대로 (글 속 겹친 빈칸은 보통 띄어쓰기)', htmlLine === `${N}${N}워드에서 들여 쓴 줄  끝`, JSON.stringify(htmlLine));
      // 줄을 나누다 앞에 남은 띄어쓰기는 일부러 넣은 것이 아니므로 다듬기가 지운다 ("앞말| 뒷말" 에서 Enter)
      await js(nw, caretAtEnd);
      key(nw, 'Enter');
      await wait(80);
      nw.webContents.insertText('앞말 뒷말');
      await wait(150);
      await js(nw, `(() => { const p = [...document.querySelectorAll('.mk-doc p')].at(-1); const t = p.firstChild; const r = document.createRange(); r.setStart(t, 2); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
      await wait(80);
      key(nw, 'Enter');
      await wait(80);
      await js(nw, `(() => { const h = document.querySelector('.mk-doc h1'); const r = document.createRange(); r.selectNodeContents(h); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
      await wait(300);
      const split = await js(nw, `[...document.querySelectorAll('.mk-doc p')].slice(-2).map((p) => p.textContent)`);
      check('줄을 나누다 남은 앞 띄어쓰기는 지움 (일부러 넣은 들여쓰기만 지킴)', split[0] === '앞말' && split[1] === '뒷말', JSON.stringify(split));
      // 복사: 일반 글자는 보통 띄어쓰기로, 서식은 줄지 않게
      await js(nw, `(() => { const s = getSelection(); s.selectAllChildren(document.querySelector('.mk-doc')); })()`);
      clipboard.writeText('비움');
      key(nw, 'C', ['control']);
      await wait(300);
      const clipOf = async (type) => {
        for (const item of await clipboard.read()) if (item.types.includes(type)) return (await item.getType(type)).text();
        return '';
      };
      const copiedText = await clipOf('text/plain');
      const copiedHtml = await clipOf('text/html');
      check('줄 앞 띄어쓰기: 복사해 붙이면 메모장에는 보통 띄어쓰기 · 워드에는 빈칸 그대로',
        /\n  국내사업부 대표 안내\n {4}네 칸 들여쓴 줄\n {4}탭 줄\n/.test(copiedText) && !copiedText.includes(N) && /(&nbsp;| ){2}국내사업부/.test(copiedHtml),
        JSON.stringify({ copiedText, html: copiedHtml.replace(/ style="[^"]*"/g, '').slice(0, 600) }));
      // 저장 → 다시 열기
      nw.close();
      await until(() => !noteWins.has(nid), '띄어쓰기 메모 닫힘');
      const file = fs.readFileSync(path.join(vault.root, vault.get(sid).file), 'utf8');
      const before2 = new Set(noteWins.keys());
      await js(list, `document.querySelector('[data-id="${sid}"]').click()`);
      const nid2 = await until(() => [...noteWins.keys()].find((k) => !before2.has(k)), '띄어쓰기 메모 다시');
      nw = noteWins.get(nid2);
      await until(() => js(nw, `document.documentElement.dataset.ready === 'true'`), '다시 연 메모 준비');
      const again = await js(nw, `[...document.querySelectorAll('.mk-doc p')].map((e) => e.textContent)`);
      check('줄 앞 띄어쓰기: 저장했다 다시 열어도 그대로 (파일에도 빈칸으로)',
        again.includes(`${N}${N}국내사업부 대표 안내${N.repeat(4)}네 칸 들여쓴 줄${N.repeat(4)}탭 줄`) && again.includes(`${N}${N}직접 친 줄`) && file.includes(`${N}${N}국내사업부`) && !/&#|&nbsp;/.test(file),
        JSON.stringify({ again: again.map((x) => [...x.slice(0, 3)].map((c) => c.codePointAt(0).toString(16)).join(' ') + ' ' + x), file: file.replace(/\u00a0/g, '⍽') }));
      nw.close();
    }

    // ---------- v0.33 — 메모 단축키 Ctrl+Alt+1~9 (복사 · 띄우기를 미리 골라 둠) ----------
    {
      const list = getList() ?? createListWindow();
      const vault = getVault();
      const N = ' ';
      const hid = vault.import({ body: `# 배송 안내\n\n안녕하세요, **고객님**.\n${N}${N}국내사업부 대표 번호로 연락 주세요\n` });
      await until(() => js(list, `!!document.querySelector('[data-id="${hid}"]')`), '단축키 메모 카드');
      const before = new Set(noteWins.keys());
      await js(list, `document.querySelector('[data-id="${hid}"]').click()`);
      const nid = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), '단축키 메모 창');
      const nw = noteWins.get(nid);
      await until(() => js(nw, `document.documentElement.dataset.ready === 'true'`), '단축키 메모 준비');
      // 메뉴 › 단축키로 불러오기 → 3 · 내용 복사만
      await js(nw, `document.getElementById('menu-btn').click(); document.getElementById('hotkey-btn').click()`);
      await until(() => js(nw, `!!document.querySelector('.hotkey-dialog[open] .hk-key')`), '단축키 창');
      const dlg = await js(nw, `(() => {
        const d = document.querySelector('.hotkey-dialog');
        const keys = d.querySelectorAll('.hk-key').length;
        const [copy, show] = d.querySelectorAll('.hk-opt .switch');
        const saveBtn = d.querySelector('button[type="submit"]');
        const before = saveBtn.disabled; // 숫자를 고르기 전
        d.querySelectorAll('.hk-key')[2].click();
        copy.checked = false; copy.dispatchEvent(new Event('change'));
        show.checked = false; show.dispatchEvent(new Event('change'));
        const none = { disabled: saveBtn.disabled, error: d.querySelector('.lock-error').textContent };
        copy.checked = true; copy.dispatchEvent(new Event('change'));
        const hint = d.querySelector('.hk-hint').textContent;
        const after = saveBtn.disabled;
        return { keys, before, none, hint, after, fits: d.scrollHeight <= d.clientHeight + 1, size: [d.scrollHeight, d.clientHeight, innerHeight] };
      })()`);
      await capture(nw, 'smoke-new-hotkey-dialog.png');
      await js(nw, `document.querySelector('.hotkey-dialog button[type="submit"]').click()`);
      await until(() => js(nw, `!document.querySelector('.hotkey-dialog')`), '단축키 창 닫힘');
      const saved = getSettings().memoHotkeys?.['3'];
      const label = await js(nw, `document.getElementById('hotkey-label').textContent`);
      check('메모 단축키 창: 1~9 · 복사/띄우기 중 하나는 꼭 · 저장하면 Ctrl+Alt+3 에 이 메모 (메뉴에 표시)',
        dlg.keys === 9 && dlg.before && dlg.none.disabled && /하나는/.test(dlg.none.error) && !dlg.after && /Ctrl\+Alt\+3 를 누르면 내용을 복사해요/.test(dlg.hint) && dlg.fits
          && saved?.id === hid && saved.copy && !saved.show && label === 'Ctrl+Alt+3' && memoHotkeys.held.has('3'),
        JSON.stringify({ dlg, saved, label, held: [...memoHotkeys.held.keys()] }));
      const badge = await until(() => js(list, `document.querySelector('[data-id="${hid}"] .card-badge.hotkey')?.textContent`), '목록 카드 단축키 표시', 3000).catch(() => '');
      check('목록 카드: 단축키 숫자 표시', badge === '3', badge);
      // 누르면: 제목 줄은 빼고 본문만, 줄 앞 띄어쓰기 그대로 클립보드에 + 마우스 가까이 "복사했어요"
      nw.close();
      await until(() => !noteWins.has(nid), '메모 창 닫힘');
      clipboard.writeText('비움');
      const hudBefore = smokeHud.length;
      await memoHotkeys.onPress('3');
      const text = await clipboard.readText();
      const hud = smokeHud.slice(hudBefore);
      check('Ctrl+Alt+3 → 본문만 복사 (줄 앞 띄어쓰기 그대로) · 창은 띄우지 않고 "복사했어요" 잠깐',
        text === '안녕하세요, 고객님.\n  국내사업부 대표 번호로 연락 주세요' && !noteWins.has(hid) && /배송 안내.*복사했어요/.test(hud[0]?.title ?? '') && /Ctrl\+V/.test(hud[0]?.body ?? ''),
        JSON.stringify({ text, hud }));
      // 띄우기만으로 바꾸면: 누르면 메모 창이 뜬다
      const r = memoHotkeys.set(hid, '3', { copy: false, show: true });
      clipboard.writeText('비움');
      await memoHotkeys.onPress('3');
      const shownWin = await until(() => noteWins.get(hid)?.isVisible() && noteWins.get(hid), '단축키로 메모 띄우기', 4000).catch(() => null);
      check('띄우기로 바꾸면 Ctrl+Alt+3 → 메모 창이 뜸 (클립보드는 그대로)', r.ok && Boolean(shownWin) && (await clipboard.readText()) === '비움', JSON.stringify({ r: r.ok, shown: Boolean(shownWin) }));
      shownWin?.close();
      // 풀기
      const off = memoHotkeys.set(hid, null);
      check('단축키 풀기 → 키를 놓아 다른 앱이 쓸 수 있게', off.ok && !memoHotkeys.held.has('3') && !getSettings().memoHotkeys?.['3'], JSON.stringify(getSettings().memoHotkeys));
    }

    // ---------- v0.33 — 바탕화면 위젯 (메모 창 › 바탕화면에 붙이기) ----------
    {
      const list = getList() ?? createListWindow();
      const vault = getVault();
      // 빈 메모는 붙이지 않는다 (창을 닫으면 저절로 정리되므로)
      const blank = vault.create();
      const blankR = await (async () => {
        const b0 = new Set(noteWins.keys());
        windowManager.openNote(blank);
        const bid = await until(() => [...noteWins.keys()].find((k) => !b0.has(k)), '빈 메모 창');
        const bw = noteWins.get(bid);
        await until(() => js(bw, `document.documentElement.dataset.ready === 'true'`), '빈 메모 준비');
        await js(bw, `document.getElementById('menu-btn').click(); document.getElementById('widget-btn').click()`);
        const status = await until(() => js(bw, `document.getElementById('status')?.textContent`), '빈 메모 안내', 3000).catch(() => '');
        const r = { status, widget: windowManager.widgets.has(blank), open: !bw.isDestroyed() };
        bw.close();
        return r;
      })();
      check('빈 메모는 바탕화면에 붙이지 않고 알려 줌', /빈 메모/.test(blankR.status) && !blankR.widget && blankR.open, JSON.stringify(blankR));
      const wid = vault.import({ body: '# 자주 쓰는 안내\n\n전화 상담: 평일 9시~6시\n\n- 주소: 서울시 어딘가\n' });
      await until(() => js(list, `!!document.querySelector('[data-id="${wid}"]')`), '위젯 메모 카드');
      const before = new Set(noteWins.keys());
      await js(list, `document.querySelector('[data-id="${wid}"]').click()`);
      const nid = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), '위젯 메모 창');
      const nw = noteWins.get(nid);
      await until(() => js(nw, `document.documentElement.dataset.ready === 'true'`), '위젯 메모 준비');
      const noteBounds = nw.getBounds();
      await js(nw, `document.getElementById('menu-btn').click(); document.getElementById('widget-btn').click()`);
      const ww = await until(() => windowManager.widgets.get(wid), '위젯 창', 4000).catch(() => null);
      await until(() => ww && js(ww, `document.documentElement.dataset.ready === 'true'`), '위젯 준비', 6000).catch(() => {});
      const noteClosed = await until(() => !noteWins.has(nid), '메모 창 닫힘', 3000).catch(() => false);
      const look = ww ? await js(ww, `({ text: document.querySelector('.mk-doc')?.textContent ?? '', editable: document.querySelector('.mk-doc')?.getAttribute('contenteditable'), color: document.body.dataset.color, actions: document.querySelectorAll('.wg-actions button').length })`) : null;
      const wb = ww?.getBounds();
      check('바탕화면에 붙이기: 메모 창 자리에 위젯이 뜨고 메모 창은 닫힘 (읽기 전용 · 같은 색 · 복사/열기/떼기)',
        Boolean(ww) && noteClosed && /전화 상담: 평일 9시~6시/.test(look?.text ?? '') && look?.editable === 'false' && look?.actions === 3
          && wb && Math.abs(wb.x - noteBounds.x) <= 2 && Math.abs(wb.y - noteBounds.y) <= 2 && Boolean(getSettings().widgets?.[wid]),
        JSON.stringify({ ww: Boolean(ww), noteClosed, look, wb, noteBounds }));
      if (ww) await capture(ww, 'smoke-new-widget.png');
      // 메모가 바뀌면 위젯도 바로
      vault.save(wid, '# 자주 쓰는 안내\n\n전화 상담: 평일 10시~7시로 바뀜\n');
      const updated = ww ? await until(() => js(ww, `document.querySelector('.mk-doc')?.textContent.includes('10시~7시')`), '위젯 다시 그림', 4000).catch(() => false) : false;
      check('메모를 고치면 위젯도 바로 바뀜', updated);
      // 본문 복사 단추: 제목 줄 빼고
      clipboard.writeText('비움');
      if (ww) await js(ww, `document.getElementById('wg-copy').click()`);
      const copied = await until(async () => (await clipboard.readText()) === '전화 상담: 평일 10시~7시로 바뀜', '위젯 복사', 3000).catch(async () => clipboard.readText());
      check('위젯 복사 단추: 본문만 클립보드에', copied === true, String(copied));
      // 메모킹을 다시 켜면 그 자리에 (끌 때 닫힌 위젯은 기억)
      windowManager.closeWidgetWindow(ww);
      await until(() => !windowManager.widgets.has(wid), '위젯 창 닫힘', 3000).catch(() => {});
      windowManager.restoreWidgets();
      const again = await until(() => windowManager.widgets.get(wid), '위젯 다시', 3000).catch(() => null);
      const againBounds = again?.getBounds();
      check('다시 켜면 놓아 둔 자리에 위젯', Boolean(again) && Math.abs(againBounds.x - wb.x) <= 2 && Math.abs(againBounds.y - wb.y) <= 2, JSON.stringify({ againBounds, wb }));
      // 떼기
      if (again) {
        await until(() => js(again, `document.documentElement.dataset.ready === 'true'`), '위젯 준비 2', 6000).catch(() => {});
        await js(again, `document.getElementById('wg-remove').click()`);
      }
      const gone = await until(() => !windowManager.widgets.has(wid) && !getSettings().widgets?.[wid], '위젯 떼기', 3000).catch(() => false);
      check('떼기 → 위젯이 사라지고 다시 켜도 안 뜸 (메모는 그대로)', gone && Boolean(vault.get(wid)));
      // Alt+F4 로 닫아도 떼기와 같게
      const w2 = windowManager.openWidget(wid);
      await until(() => getSettings().widgets?.[wid], '위젯 다시 놓기', 2000).catch(() => {});
      w2?.close();
      const closedByUser = await until(() => !windowManager.widgets.has(wid) && !getSettings().widgets?.[wid], 'Alt+F4', 3000).catch(() => false);
      check('위젯을 Alt+F4 로 닫으면 떼기와 같게 (다시 켜도 안 뜸)', closedByUser);
    }

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  }

  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `바뀐 기능 점검 통과 (${checks.length}개)` : '바뀐 기능 점검 실패');
  app.exit(exitCode);
}
