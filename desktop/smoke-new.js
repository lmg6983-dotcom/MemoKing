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
  const gate = { held: null, release: () => {} }; // gate.hold() 동안 파일 받기는 기다린다 (받는 중에 다른 사건을 보는 점검)
  gate.hold = () => { gate.held = new Promise((r) => { gate.release = r; }); };
  const table = (cols, rows) => [cols.join('\x01'), 'm', 'm', 'm', ...rows.map((r) => r.join('\x01'))].join('\n');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url.startsWith('/OPMS/')) return Promise.resolve(gate.held).then(() => res.end(`FILE ${decodeURIComponent(req.url)}`));
      const sql = new URLSearchParams(body).get('sql') ?? '';
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      // 우선권 · 메모 먼저 (메모 SQL 안의 "FROM opms_applicant" 가 아래 사건 표 줄에 걸리지 않게)
      if (/FROM opms_pri/.test(sql)) return res.end(table(['pri_order', 'pri_nation', 'd_pri', 'n_pri', 'n_pri_acc', 'd_pri_rec', 'd_pri_due', 'd_pri_pre', 'memo'], [['1', 'KR', '2026-09-23 00:00:00.0', '10-2026-0182644', '', '', '', '', '']]));
      if (/FROM opms_memo M/.test(sql)) return res.end(table(['div', 'ck_popup', 'cust', 'd_memo', 'header', 'memo'], [['고객', 'Y', '메모킹 주식회사', '2026-03-11 00:00:00.0', '', '1. 비용 산정은 발명신고일 기준\\r\\n2. 청구서에 상세 내역 적기']]));
      if (/FROM opms_app/.test(sql)) {
        const one = sql.match(/\bidx = '(\d+)'/)?.[1]; // 사건 하나 (idx 로) — 회사 서버처럼 그 사건만
        return res.end(table(['idx', 'div', 'ourref', 'yourref', 'n_app', 'd_app', 'applicant', 'inventor', 'title_kor', 'd_accept', 'ck_out'], [
          ['101', '특허', 'FPD/2026-0271/E', 'Y-77', '10-2026-0012345', '2026-02-03 00:00:00.0', '메모킹 주식회사', '홍길동', '메모를 쉽게 쓰는 장치', '2026-01-10 00:00:00.0', 'N'],
          ['102', '특허', 'FPD/2026-0271/D', 'Y-78', '10-2026-0099999', '', '메모킹 주식회사', '', '두 번째 사건', '2026-01-09 00:00:00.0', 'N'],
        ].filter((r) => !one || r[0] === one)));
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, gate, host: `http://127.0.0.1:${server.address().port}` })));
}

export async function runSmoke({ getVault, showMagic, getMagic, getFinder, useFileIndex, getOpms, getSettings, getList, noteWins, createListWindow, memoHotkeys, smokeHud, windowManager }) {
  const checks = [];
  const errors = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    if (process.env.MK_SMOKE_TRACE) console.log(`… ${ok ? '✔' : '✖'} ${name}`); // 어디서 멈췄는지 보려고 (점검 도중 바로)
  };
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
    if (process.env.MK_SMOKE_TRACE) console.log(`… 기다림: ${label}`);
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

    // 2-1) 계산기 · 웹 검색 · AI 에게 묻기
    const typeMagic = (text) => js(magic, `(() => { const i = document.getElementById('magic-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
    showMagic();
    await wait(300);
    await typeMagic('1,200 × 3');
    const calcRow = await until(() => js(magic, `(() => { const r = document.querySelector('.magic-row'); return r?.classList.contains('kind-calc') && { t: r.querySelector('.t').textContent, s: r.querySelector('.s').textContent, sel: r.getAttribute('aria-selected') }; })()`), '계산 결과', 8000).catch(() => null);
    await capture(magic, 'smoke-new-magic-calc.png');
    await wait(300); // 메모 · 파일 찾기 결과가 다 온 뒤에 (늦게 온 결과가 아래 안내를 다시 그리지 않게)
    key(magic, 'Return');
    const calcFlash = await until(() => js(magic, `document.querySelector('.magic-flash')?.textContent`), '계산 결과 복사').catch(() => '');
    check('매직키 계산기: 식을 쓰면 맨 위에 결과(골라져 있음) · Enter 로 결과 복사', calcRow?.t === '3,600' && calcRow.s === '1,200 × 3' && calcRow.sel === 'true' && /계산 결과를 복사/.test(calcFlash), JSON.stringify({ calcRow, calcFlash }));
    showMagic();
    await wait(300);
    await typeMagic('서울 날씨');
    const tail = await until(() => js(magic, `(() => {
      const rows = [...document.querySelectorAll('.magic-row')];
      const kinds = rows.map((e) => e.className.match(/kind-(\\w+)/)[1]);
      const sites = (k) => [...(rows.find((e) => e.classList.contains('kind-' + k))?.querySelectorAll('.act-btn') ?? [])].map((b) => b.dataset.action);
      return kinds.includes('ai') && { kinds, web: sites('web'), ai: sites('ai') };
    })()`), '웹 검색 · AI 줄').catch(() => null);
    await capture(magic, 'smoke-new-magic-tools.png');
    const before = smokeOpened.length;
    await js(magic, `(() => { const r = document.querySelector('.magic-row.kind-web'); r.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); r.querySelector('[data-action="google"]').click(); })()`);
    await wait(300);
    showMagic();
    await wait(300);
    await typeMagic('서울 날씨');
    await until(() => js(magic, `!!document.querySelector('.magic-row.kind-ai')`), 'AI 줄');
    await js(magic, `(() => { const r = document.querySelector('.magic-row.kind-ai'); r.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); })()`);
    await wait(100);
    await capture(magic, 'smoke-new-magic-ai.png');
    key(magic, 'Return');
    await wait(300);
    const webOpened = smokeOpened.slice(before).map((o) => o.target);
    check('매직키 웹 검색 · AI: 맨 아래 두 줄 (기본 네이버 · ChatGPT 가 첫 단추) · 고른 사이트로 열기',
      tail?.kinds.at(-2) === 'web' && tail.kinds.at(-1) === 'ai' && tail.web[0] === 'naver' && tail.ai[0] === 'chatgpt'
      && webOpened[0] === 'https://www.google.com/search?q=%EC%84%9C%EC%9A%B8%20%EB%82%A0%EC%94%A8' && webOpened[1] === 'https://chatgpt.com/?q=%EC%84%9C%EC%9A%B8%20%EB%82%A0%EC%94%A8',
      JSON.stringify({ tail, webOpened }));

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
    check('모두 찾기: ← → 로 할 일(폴더 열기)을 고르고, 버튼으로 경로 복사 → "복사했어요"', fact === 'reveal' && fcopied.includes('견적서') && /복사했어요/.test(status), JSON.stringify({ fact, fcopied, status }));
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
    const extra = await until(() => js(ow, `(() => {
      const hs = [...document.querySelectorAll('.op-h')].map((h) => h.textContent);
      if (!hs.includes('우선권') || !hs.includes('메모')) return null;
      const tableAfter = (name) => { const h = [...document.querySelectorAll('.op-h')].find((x) => x.textContent === name); let t = h.nextElementSibling; return t && t.matches('table') ? { head: [...t.querySelectorAll('th')].map((x) => x.textContent), row: [...t.querySelectorAll('tbody td')].map((x) => x.textContent) } : null; };
      return { pri: tableAfter('우선권'), memo: tableAfter('메모'), lines: [...document.querySelectorAll('.op-table td.long')].some((td) => td.textContent.includes('\\n')) };
    })()`), '우선권 · 메모', 8000).catch(() => null);
    check('OPMS 정보: 우선권(우선국 · 우선권주장일 · 우선권번호 …) · 메모(구분 · 필독 · 고객명 · 작성일 · 말머리 · 메모, 줄바꿈 그대로)',
      extra?.pri?.head.join() === '우선국,우선권주장일,우선권번호,접근코드,접수일,제출마감일,제출일,비고' && extra.pri.row.slice(0, 3).join() === 'KR,2026-09-23,10-2026-0182644'
      && extra.memo?.head.join() === '구분,필독,고객명,작성일,말머리,메모' && extra.memo.row.slice(0, 4).join() === '고객,필독,메모킹 주식회사,2026-03-11' && extra.lines,
      JSON.stringify(extra));
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
    const footLinks = await js(ow, `[...document.querySelectorAll('#op-foot .op-link')].map((b) => b.textContent).join(',')`);
    check('전자포대 저장 위치: 폴더 바꾸기 옆에 폴더 열기', footLinks.startsWith('폴더 바꾸기,폴더 열기'), footLinks);
    // 받는 중에 다른 사건(102)을 열어도 그 사건의 전자포대는 막히지 않는다 (예전: 받는 중 하나가 모든 사건의 받기 단추를 막음)
    fake.gate.hold();
    await js(ow, `[...document.querySelectorAll('#op-foot .op-btn')].find((b) => b.textContent.startsWith('전체 받기')).click()`);
    await until(() => js(ow, `/받는 중/.test(document.querySelector('#op-foot .op-status')?.textContent ?? '')`), '받는 중');
    ow.webContents.send('opms:show', { idx: '102', tab: 'wrapper' });
    const other = await until(() => js(ow, `(() => {
      if (document.getElementById('op-our').textContent !== 'FPD/2026-0271/D' || document.querySelectorAll('.op-table tbody tr').length !== 2) return null;
      const all = [...document.querySelectorAll('#op-foot .op-btn')].find((b) => b.textContent.startsWith('전체 받기'));
      return { allOn: !all.disabled, status: document.querySelector('#op-foot .op-status').textContent };
    })()`), '다른 사건 전자포대').catch(() => null);
    check('전자포대: 한 사건을 받는 동안 다른 사건을 열면 그 사건은 받을 수 있고 "받는 중" 도 아님', other?.allOn && !/받는 중/.test(other.status), JSON.stringify(other));
    fake.gate.release();
    fake.gate.held = null;
    ow.webContents.send('opms:show', { idx: '101', tab: 'wrapper' });
    const st = await until(() => js(ow, `(() => { const s = document.querySelector('#op-foot .op-status'); return s && /저장/.test(s.textContent) && s.textContent; })()`), '전자포대 받기', 10000).catch(() => '');
    const folder = path.join(wrapperDir, 'FPD20260271E_Y77');
    const saved = fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
    await capture(ow, 'smoke-new-opms.png');
    const opened = await js(ow, `Promise.all([opms.openFolder(${JSON.stringify(folder)}), opms.openFolder('C:/Windows'), opms.openFolder()])`);
    const gotLabel = await js(ow, `document.querySelector('#op-foot .op-open')?.textContent`);
    check('폴더 열기: 받은 사건 폴더는 그 폴더, 그 밖의 경로는 전자포대 저장 폴더로', opened[0] === folder && opened[1] === wrapperDir && opened[2] === wrapperDir && gotLabel === '받은 폴더 열기', JSON.stringify({ opened, gotLabel }));
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
      check('표 막대: 아래 서식 도구막대가 숨어도 제자리 (버튼이 커서를 피하지 않음)', Math.abs(shown - hiddenTop) < 1, JSON.stringify({ shown, hiddenTop }));

      // 메모 안 찾기 · 바꾸기 (워드처럼 한 막대): Ctrl+F → 찾은 곳 · 개수, Enter 다음, Ctrl+H 바꾸기 줄, Ctrl+Enter 모두 바꾸기, Esc 닫기
      {
        const v0 = getVault();
        const fid = v0.import({ body: '# 찾기 점검\n\n사과 하나, 사과 둘, 사과즙\n\n배 하나\n' });
        const beforeF = new Set(noteWins.keys());
        await until(() => js(list, `!!document.querySelector('[data-id="${fid}"]')`), '찾기 메모 카드');
        await js(list, `document.querySelector('[data-id="${fid}"]').click()`);
        const fkey = await until(() => [...noteWins.keys()].find((k) => !beforeF.has(k)), '찾기 메모 창');
        const fw = noteWins.get(fkey);
        await until(() => js(fw, `document.documentElement.dataset.ready === 'true'`), '찾기 메모 준비');
        fw.focus();
        fw.webContents.focus();
        await js(fw, `document.querySelector('.ProseMirror').focus()`);
        key(fw, 'F', ['control']);
        const opened = await until(() => js(fw, `!document.querySelector('.mk-find-bar').hidden && document.activeElement?.classList.contains('mk-find-input')`), 'Ctrl+F 찾기 막대', 3000).catch(() => false);
        fw.webContents.insertText('사과');
        const fs1 = await until(() => js(fw, `(() => { const c = document.querySelector('.mk-find-count').textContent; return c === '1/3' && { c, hits: document.querySelectorAll('.mk-find-hit').length }; })()`), '찾은 곳', 3000).catch(() => null);
        key(fw, 'Return');
        const fs2 = await until(() => js(fw, `document.querySelector('.mk-find-count').textContent === '2/3'`), 'Enter 다음', 2000).catch(() => false);
        // 찾기 막대는 글을 가리지 않고 위 막대 아래에 끼워져 글을 민다
        const noCover = await js(fw, `(() => { const b = document.querySelector('.mk-find-bar').getBoundingClientRect(); const d = document.querySelector('.ProseMirror').getBoundingClientRect(); return d.top >= b.bottom - 1; })()`);
        await capture(fw, 'smoke-new-find.png');
        check('찾기(Ctrl+F): 막대가 뜨고 찾을 말로 바로 · 찾은 곳 3곳 · Enter 로 다음(2/3) · 글을 가리지 않음', opened && fs1?.hits === 3 && fs2 && noCover, JSON.stringify({ opened, fs1, fs2, noCover }));
        key(fw, 'H', ['control']);
        const repFocus = await until(() => js(fw, `(() => { const f = [...document.querySelectorAll('.mk-find-grid .mk-find-field')].map((x) => Math.round(x.getBoundingClientRect().width)); return document.querySelector('.mk-find-bar').dataset.mode === 'replace' && document.activeElement === document.querySelector('.mk-find-rep .mk-find-input') && f[0] === f[1]; })()`), 'Ctrl+H 바꾸기 줄', 2000).catch(() => false);
        // 할 일 버튼 넷: 같은 폭 · 같은 높이(28) · 같은 간격 / 모두 찾기 목록에서 고르면 메모에서 그 글이 골라짐 (편집기로)
        await js(fw, `[...document.querySelectorAll('.mk-find-act')].find((b) => b.textContent === '모두 찾기').click()`);
        await wait(150);
        const acts = await js(fw, `[...document.querySelectorAll('.mk-find-acts .mk-find-act')].map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) }; })`);
        const gaps = acts.slice(1).map((a, i) => a.x - (acts[i].x + acts[i].w));
        await capture(fw, 'smoke-new-find-all.png');
        await js(fw, `document.querySelectorAll('.mk-find-list .mk-find-item')[1].click()`);
        await wait(150);
        const picked = await js(fw, `({ text: getSelection().toString(), inEditor: !!document.activeElement?.closest('.ProseMirror'), count: document.querySelector('.mk-find-count').textContent })`);
        check('찾기 막대: 할 일 버튼 넷이 같은 폭 · 높이 28 · 같은 간격 / 모두 찾기 목록에서 고르면 메모에서 그 글이 골라짐',
          acts.length === 4 && new Set(acts.map((a) => a.y)).size === 1 && Math.max(...acts.map((a) => a.w)) - Math.min(...acts.map((a) => a.w)) <= 1 && acts.every((a) => a.h === 28) && Math.max(...gaps) - Math.min(...gaps) <= 1
            && picked.text === '사과' && picked.inEditor && picked.count === '2/3', JSON.stringify({ acts, gaps, picked }));
        await js(fw, `[...document.querySelectorAll('.mk-find-act')].find((b) => b.textContent === '모두 찾기').click(); document.querySelector('.mk-find-rep .mk-find-input').focus()`);
        await wait(100);
        fw.webContents.insertText('포도');
        // Ctrl+Enter: sendInputEvent 로는 Ctrl 을 붙인 Enter 가 실제 키보드처럼 오지 않아, 크롬 개발 도구 입력(실제 키보드와 같은 길)으로
        {
          const dbg = fw.webContents.debugger;
          if (!dbg.isAttached()) dbg.attach('1.3');
          for (const type of ['keyDown', 'keyUp']) await dbg.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
          dbg.detach();
        }
        const replaced = await until(() => { const b = v0.get(fid)?.body ?? ''; return /포도 하나, 포도 둘, 포도즙/.test(b) && b; }, '모두 바꾸기 저장', 8000).catch(() => '');
        if (process.env.MK_SMOKE_TRACE) console.log(`… 바꾸기 상태: ${JSON.stringify(await js(fw, `({ rep: document.querySelector('.mk-find-rep input').value, q: document.querySelector('.mk-find-grid input').value, count: document.querySelector('.mk-find-count').textContent, mode: document.querySelector('.mk-find-bar').dataset.mode, active: document.activeElement?.placeholder, doc: document.querySelector('.ProseMirror').textContent })`))}`);
        key(fw, 'Escape');
        const closedF = await until(() => js(fw, `document.querySelector('.mk-find-bar').hidden && !document.querySelector('.mk-find-hit')`), 'Esc 닫기', 2000).catch(() => false);
        await js(fw, `document.querySelector('.ProseMirror').focus()`);
        key(fw, 'Z', ['control']);
        const undone = await until(() => /사과 하나, 사과 둘, 사과즙/.test(v0.get(fid)?.body ?? ''), '되돌리기', 4000).catch(() => false);
        check('바꾸기(Ctrl+H): 찾을 말과 같은 폭의 바꿀 말 칸으로 · Ctrl+Enter 모두 바꾸기 · Esc 로 닫기 · Ctrl+Z 한 번에 되돌림', repFocus && replaced && closedF && undone, JSON.stringify({ repFocus, replaced: Boolean(replaced), closedF, undone, body: v0.get(fid)?.body }));
        fw.close();
      }

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
      let noHoverBtns = false;
      if (img) {
        // 마우스를 올려도 단추가 뜨지 않는다 (예전에는 오른쪽 위에 복사 · 지우기 단추가 떠서 표 칸을 가렸다)
        pw.webContents.sendInputEvent({ type: 'mouseMove', x: img.x, y: img.y });
        await wait(600);
        noHoverBtns = await js(pw, `document.querySelectorAll('.mk-delete-btn, .mk-copy-btn, .mk-save-btn, .mk-share-btn').length === 0`);
        // 오른쪽 클릭 → 메뉴 맨 위 아이콘 줄의 복사 → 시스템 클립보드에 그림 그대로
        clipboard.writeText('비움');
        for (const type of ['mouseDown', 'mouseUp']) pw.webContents.sendInputEvent({ type, x: img.x, y: img.y, button: 'right', clickCount: 1 });
        copyShown = await until(() => js(pw, `!!document.querySelector('.mk-ctx .mk-ctx-ic[data-id="copy"]')`), '메뉴의 복사 아이콘', 3000).catch(() => false);
        if (copyShown) {
          const b = await js(pw, `(() => { const r = document.querySelector('.mk-ctx-ic[data-id="copy"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
          pw.webContents.sendInputEvent({ type: 'mouseMove', x: b.x, y: b.y });
          await wait(100);
          pw.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          pw.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          copied = await until(async () => (await pngInClipboard()) > 1000, '그림 복사', 4000).catch(async () => `${JSON.stringify((await clipboard.read()).map((i) => i.types))}`);
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
      check('그림 복사: 마우스를 올려도 버튼은 없고, 오른쪽 클릭 메뉴 맨 위의 복사 아이콘을 누르면 클립보드에 그림 그대로', Boolean(img) && noHoverBtns && copyShown && copied === true, JSON.stringify({ img, noHoverBtns, copyShown, copied, file: vault.get(picId)?.file, doc: img ? '' : await js(pw, `document.querySelector('.mk-doc')?.innerHTML.slice(0, 300)`) }));
      pw.close();
      w.close();
    }

    // ---------- v0.33 — 메모 창 바로 뜨기(예비 창) · PDF · 표 · 수식 등을 오른쪽 클릭해 복사 · 저장 · 공유 · 지우기 ----------
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
      // 카드 키보드: 카드마다 Tab 한 번 (단추 셋은 Tab 으로 가지 않음), 카드에 포커스가 오면 단추 묶음이 보임
      const cardKeys = await js(list, `(() => { const item = document.querySelector('[data-id="${cid}"]').closest('li, .item') ?? document.querySelector('[data-id="${cid}"]').parentElement; const card = item.querySelector('.card') ?? document.querySelector('[data-id="${cid}"]'); const bs = [...item.querySelectorAll('.card-actions button')]; card.focus(); return new Promise((r) => setTimeout(() => r({ n: bs.length, skip: bs.every((b) => b.tabIndex === -1), focused: document.activeElement === card, visible: card.matches(':focus-visible'), shown: getComputedStyle(item.querySelector('.card-actions')).opacity }), 300)); })()`);
      check('목록 카드 키보드: 버튼 셋은 Tab 으로 가지 않고(카드마다 Tab 한 번) · 카드에 포커스가 오면 버튼 묶음이 보임',
        cardKeys.n === 3 && cardKeys.skip && cardKeys.focused && (!cardKeys.visible || cardKeys.shown === '1'), JSON.stringify(cardKeys));
      // 목록 카드 오른쪽 클릭 → Windows 11 식 HTML 메뉴 (list-card-menu.js): 맨 위 아이콘 줄 + 열기 · 고정 · 색 · 잠그기 · 이전 버전
      {
        const at = await js(list, `(() => { const c = document.querySelector('.card[data-id="${cid}"]'); c.scrollIntoView({ block: 'nearest' }); const r = c.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 20) }; })()`);
        list.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
        list.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 });
        list.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 });
        const shape = await until(() => js(list, `(() => { const m = document.querySelector('.mk-ctx'); return m && { icons: [...m.querySelectorAll('.mk-ctx-ic')].map((b) => b.dataset.id), items: [...m.querySelectorAll('.mk-ctx-item')].map((b) => b.dataset.id), dots: m.querySelectorAll('.mk-ctx-sw').length, native: false }; })()`), '목록 카드 메뉴').catch(() => null);
        check('목록 카드 오른쪽 클릭: 맨 위 아이콘 줄(복사 · 공유 · PDF · 휴지통) + 열기 · 고정 · 색 점 7개 · 이 날의 기록 · 잠그기 · 이전 버전',
          shape && shape.icons.join() === 'cut,copy,share,pdf,trash' && shape.items.join() === 'open,pin,day,lock,versions' && shape.dots === 7, JSON.stringify(shape));
        await capture(list, 'list-card-menu.png');
        const pickList = async (selector) => {
          const b = await js(list, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(${JSON.stringify(selector)}) !== null }; })()`);
          if (!b) return false;
          list.webContents.sendInputEvent({ type: 'mouseMove', x: b.x, y: b.y });
          await wait(80);
          list.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          list.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          return b.hit;
        };
        // 색 점을 진짜 마우스로 → 그 색으로 바뀌고 메뉴가 닫힌다
        const hitDot = await pickList('.mk-ctx-sw[data-id="color:blue"]');
        const recolored = await until(() => getVault().get(cid)?.color === 'blue', '메모 색 바뀜', 3000).catch(() => false);
        const closed = await until(() => js(list, `!document.querySelector('.mk-ctx')`), '색을 고르면 메뉴 닫힘', 2000).catch(() => false); // 닫히는 움직임을 기다림
        check('목록 카드 메뉴 › 색 점을 누르면 바로 그 색으로 바뀌고 메뉴가 닫힘 (가려지지 않음)', hitDot && recolored && closed, JSON.stringify({ hitDot, recolored, closed }));
        // 고정: 눌러 켜고, 다시 열면 체크 표시, 한 번 더 눌러 푼다
        const reopen = async () => {
          list.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 });
          list.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 });
          await until(() => js(list, `!!document.querySelector('.mk-ctx')`), '목록 카드 메뉴 다시');
        };
        await reopen();
        await pickList('.mk-ctx-item[data-id="pin"]');
        const pinned = await until(() => getVault().get(cid)?.pinned === true, '고정', 3000).catch(() => false);
        await reopen();
        const checked = await until(async () => (await js(list, `document.querySelector('.mk-ctx-item[data-id="pin"]')?.getAttribute('aria-checked')`)) === 'true' && 'true', '고정 체크 표시', 2000).catch(() => 'false');
        await pickList('.mk-ctx-item[data-id="pin"]');
        const unpinned = await until(() => getVault().get(cid)?.pinned !== true, '고정 풀림', 3000).catch(() => false);
        check('목록 카드 메뉴 › 고정: 누르면 고정, 다시 열면 체크 표시, 한 번 더 누르면 풀림', pinned && checked === 'true' && unpinned, JSON.stringify({ pinned, checked, unpinned }));
        // 공유: 아이콘 → 방법 메뉴 → (점검에서는 만들어 둔 .txt 를 smokeOpened 에 둔다)
        await reopen();
        await pickList('.mk-ctx-ic[data-id="share"]');
        const hasMenu = await until(() => js(list, `!!document.querySelector('.mk-share-menu [data-via="mail"]')`), '공유 방법 메뉴', 3000).catch(() => false);
        await js(list, `document.querySelector('.mk-share-menu [data-via="mail"]')?.click()`);
        const shared = await until(() => smokeOpened.find((o) => o.kind === 'share' && o.via === 'mail' && /콘텐츠 복사\.txt$/.test(o.target)), '메모 공유', 3000).catch(() => null);
        check('목록 카드 메뉴 › 공유: 방법(Drive · LocalSend · 메일)을 고르면 메모 글을 "제목.txt" 로 보냄', hasMenu && Boolean(shared), JSON.stringify({ hasMenu, shared }));
        // 키보드: 메뉴 키 흉내(Shift+F10 → contextmenu button 0) → 화살표로 아이콘 줄 · 항목 · 색 줄을 오가고 Esc 로 닫기
        await js(list, `document.querySelector('.card[data-id="${cid}"]').focus(); document.querySelector('.card[data-id="${cid}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }))`);
        await until(() => js(list, `!!document.querySelector('.mk-ctx')`), '키보드로 연 목록 카드 메뉴');
        key(list, 'Down');
        key(list, 'Down');
        key(list, 'Down');
        key(list, 'Down');
        const onColors = await until(() => js(list, `document.activeElement?.classList.contains('mk-ctx-sw')`), '색 줄로 옮김', 2000).catch(() => false);
        key(list, 'Right');
        key(list, 'Escape');
        const gone = await until(() => js(list, `!document.querySelector('.mk-ctx')`), '메뉴 닫힘', 2000).catch(() => false);
        check('목록 카드 메뉴 키보드: ↓ 로 아이콘 줄 › 열기 › 고정 › 색 줄, Esc 로 닫기', onColors === true && gone, JSON.stringify({ onColors, gone }));
        // 제목 줄 오른쪽 위: 왕관 · 동기화 · 설정이 검색 줄이 아니라 맨 위에, 창 버튼 영역을 침범하지 않음
        const bar = await js(list, `(() => { const q = (s) => document.querySelector(s)?.getBoundingClientRect(); const c = q('#list-top-btn'), g = q('#settings-btn'), t = q('.titlebar'), s = q('#search'); return { crown: c && [c.left, c.top], gearInTitle: g.top >= t.top && g.bottom <= t.bottom, gearRight: g.right <= (navigator.windowControlsOverlay?.visible ? navigator.windowControlsOverlay.getTitlebarAreaRect().right : innerWidth - 142) + 1, order: c.left < g.left, searchBelow: s.top >= t.bottom - 1, inToolbar: !!document.querySelector('.toolbar #settings-btn, .toolbar #sync-btn') }; })()`);
        check('목록 제목 줄: 왕관 · 동기화 · 설정이 맨 위(창 버튼 왼쪽)에 있고 검색 줄에는 없음', bar.gearInTitle && bar.gearRight && bar.order && bar.searchBelow && !bar.inToolbar, JSON.stringify(bar));
        // 왕관 스티커: 넓은 창에서는 제목 줄 가운데 빈 곳에 (단추를 가리지 않게), 좁거나 화면 위 끝이라 잘리면 왕관 단추 자리의 작은 왕관으로
        const sizeBefore = list.getBounds();
        const wa = electronApi.screen.getDisplayMatching(sizeBefore).workArea;
        const place = (width, y = wa.y + 80) => list.setBounds({ x: wa.x + 40, y, width, height: sizeBefore.height });
        const stickerWin = () => { const w = windowManager.stickers.get(list.id)?.win; return w && !w.isDestroyed() && w.isVisible() ? w : null; };
        const btnState = () => js(list, `(() => { const b = document.getElementById('list-top-btn'); return { docked: b.classList.contains('docked'), peeled: b.classList.contains('peeled'), mini: getComputedStyle(b.querySelector('.crown-mini')).display !== 'none', pressed: b.getAttribute('aria-pressed') }; })()`);
        const dockedNow = async () => windowManager.listCrownDocked() && !stickerWin() && (await btnState()).docked;
        const stuckNow = async () => { const w = stickerWin(); return w && !windowManager.listCrownDocked() && (await btnState()).peeled && w.getBounds(); };
        const hitRects = async () => js(list, `['#mode-switch button', '#sync-btn:not([hidden])', '#settings-btn'].flatMap((s) => [...document.querySelectorAll(s)]).map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })`);
        const covers = (sb, lb, rects) => rects.some((r) => sb.x - lb.x < r.right - 6 && sb.x + sb.width - lb.x > r.left + 6 && sb.y + sb.height - lb.y > r.top + 2);
        // 좁은 창(440)에서 붙이면: 스티커 창 없이 작은 왕관
        place(440);
        await wait(150);
        await js(list, `document.getElementById('list-top-btn').click()`);
        const narrow = await until(dockedNow, '작은 왕관', 4000).catch(() => false);
        const nb = await btnState();
        await capture(list, 'list-crown-docked.png');
        check('왕관: 좁은 창(440px)에서 붙이면 스티커 대신 동기화 왼쪽 버튼 자리에 작은 왕관 (늘 위에 두기는 켜짐)', narrow && nb.mini && nb.pressed === 'true' && list.isAlwaysOnTop(), JSON.stringify({ nb, docked: windowManager.listCrownDocked() }));
        // 넓히면 작은 왕관이 나가고 가운데 빈 곳에 스티커
        place(900);
        const wide = await until(stuckNow, '넓은 창 스티커', 4000).catch(() => null);
        const wideOverlap = wide ? covers(wide, list.getBounds(), await hitRects()) : null;
        check('왕관: 넓히면 다시 창 위 가운데 빈 곳의 스티커 (버튼을 가리지 않음)', Boolean(wide) && wideOverlap === false && wide.x - list.getBounds().x > 300, JSON.stringify({ wide, lb: list.getBounds() }));
        // 다시 좁히면 바로 작은 왕관, 조금만 넓혀서는 스티커로 돌아가지 않는다 (깜빡이지 않게)
        place(500);
        const back = await until(dockedNow, '다시 작은 왕관', 3000).catch(() => false);
        place(520);
        await wait(500);
        const held = await dockedNow();
        check('왕관: 다시 좁히면 작은 왕관, 경계 근처(520px)에서는 그대로 (스티커와 작은 왕관을 오가며 깜빡이지 않게)', back && held, JSON.stringify({ back, held }));
        // 화면 맨 위에 붙이면(스티커가 화면 밖으로 잘림) 작은 왕관, 내리면 스티커
        place(900, wa.y);
        const top = await until(dockedNow, '화면 위 끝 작은 왕관', 3000).catch(() => false);
        place(900);
        const down = await until(stuckNow, '내리면 스티커', 4000).catch(() => null);
        check('왕관: 창을 화면 맨 위에 붙이면 작은 왕관, 내리면 다시 스티커', top && Boolean(down), JSON.stringify({ top, down }));
        // 작은 왕관을 누르면 떼어진다 (늘 위에 두기 꺼짐, 줄 그림 왕관으로)
        place(440);
        await until(dockedNow, '작은 왕관', 3000).catch(() => false);
        await js(list, `document.getElementById('list-top-btn').click()`);
        const off = await until(async () => !list.isAlwaysOnTop() && !windowManager.stickers.get(list.id) && (await btnState()).pressed === 'false' && !(await btnState()).mini, '작은 왕관 떼기', 3000).catch(() => false);
        const ob = await btnState();
        check('왕관: 작은 왕관을 누르면 늘 위에 두기가 꺼지고 버튼은 원래 왕관으로', off && !ob.docked && !ob.peeled && !ob.mini, JSON.stringify(ob));
        await windowManager.setListOnTop(false);
        list.setBounds(sizeBefore);
      }
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
      check('메모 창 바로 뜨기: 미리 불러 둔 예비 창으로 (확인 간격 포함 450ms 안), 그 메모 내용 그대로', fromSpare && openMs < 450 && shownRight, JSON.stringify({ fromSpare, openMs, shownRight }));

      // 내용을 오른쪽 클릭 → 맨 위 아이콘 줄이 있는 메뉴 (ctx-menu.js). 메뉴의 모양을 돌려준다
      const openMenu = async (sel) => {
        const r = await js(nw, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + Math.min(10, r.height / 2)) }; })()`);
        if (!r) return null;
        nw.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
        nw.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'right', clickCount: 1 });
        nw.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'right', clickCount: 1 });
        return until(() => js(nw, `(() => { const m = document.querySelector('.mk-ctx'); return m && { icons: [...m.querySelectorAll('.mk-ctx-ic')].map((b) => b.dataset.id + ':' + b.getAttribute('aria-label')), items: [...m.querySelectorAll('.mk-ctx-item')].map((b) => b.querySelector('.mk-ctx-text').textContent), rect: m.getBoundingClientRect().toJSON() }; })()`), `${sel} 오른쪽 클릭 메뉴`, 3000).catch(() => null);
      };
      // 메뉴의 아이콘 · 항목을 진짜 마우스로 누른다 (자리 · 가려짐까지 함께 확인)
      const clickMenu = async (selector) => {
        const b = await js(nw, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(${JSON.stringify(selector)}) === e }; })()`);
        if (!b) return false;
        nw.webContents.sendInputEvent({ type: 'mouseMove', x: b.x, y: b.y });
        await wait(80);
        nw.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'left', clickCount: 1 });
        nw.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
        return b.hit;
      };
      const pressCopy = async () => {
        await clickMenu('.mk-ctx-ic[data-id="copy"]');
        return until(() => js(nw, `/복사했어요/.test(document.getElementById('status')?.textContent ?? '') && document.getElementById('status').textContent`), '복사 알림', 3000).catch(() => '');
      };
      const leave = async () => {
        await js(nw, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
        await until(() => js(nw, `!document.querySelector('.mk-ctx')`), '메뉴 닫힘', 2000).catch(() => {});
        await js(nw, `document.getElementById('status').textContent = ''`);
      };
      // 마우스를 올려도 단추가 뜨지 않는다 (예전에는 오른쪽 위에 단추 네 개가 떠서 표 칸을 가렸다)
      const hoverBtns = async (sel) => {
        const r = await js(nw, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + 10) }; })()`);
        nw.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
        await wait(600);
        return js(nw, `document.querySelectorAll('.mk-delete-btn, .mk-copy-btn, .mk-save-btn, .mk-share-btn').length`);
      };
      const hoverCounts = [await hoverBtns('.mk-doc a[data-file]'), await hoverBtns('.mk-doc .tableWrapper td'), await hoverBtns('.mk-doc .mk-math-block')];
      check('마우스를 올려도 복사 · 저장 · 공유 · 삭제 버튼이 뜨지 않음 (파일 · 표 · 수식)', hoverCounts.every((n) => n === 0), JSON.stringify(hoverCounts));
      // PDF 파일 칩: 오른쪽 클릭 → 맨 위 아이콘 줄 (복사 · 저장 · 공유 · 지우기) + "열기", 복사는 파일 그대로
      const fileMenu0 = await openMenu('.mk-doc a[data-file]');
      const copiesBefore = smokeOpened.filter((o) => o.kind === 'copy-file').length;
      const fileDone = fileMenu0 ? await pressCopy() : '';
      const fileCopy = smokeOpened.filter((o) => o.kind === 'copy-file').at(-1);
      check('PDF 파일: 오른쪽 클릭 → 메뉴 맨 위에 복사 · 저장 · 공유 · 삭제 아이콘 + "이 파일 열기", 복사 아이콘은 파일 그대로 클립보드에',
        fileMenu0?.icons.join('|') === 'cut:이 파일 잘라내기|copy:이 파일 복사|save:이 파일 저장|share:이 파일 공유|delete:이 파일 삭제' && fileMenu0.items.join('|') === '이 파일 열기|이름 변경' && /파일을 복사했어요/.test(fileDone)
          && smokeOpened.filter((o) => o.kind === 'copy-file').length === copiesBefore + 1 && /안내 자료\.pdf$/.test(fileCopy?.target ?? ''),
        JSON.stringify({ fileMenu0, fileDone, fileCopy }));
      // 파일 이름 변경: 메뉴 › 이름 변경… → 입력 창 → 칩 글자가 바뀜 (확장자는 지키고 · 쓸 수 없는 글자는 뺌) → 되돌려 둔다
      {
        const renameVia = async (typed) => {
          if (!(await openMenu('.mk-doc a[data-file]'))) return false;
          await clickMenu('.mk-ctx-item[data-id="rename"]');
          await until(() => js(nw, `!!document.querySelector('.mk-prompt input')`), '이름 입력 창', 3000);
          await js(nw, `(() => { const i = document.querySelector('.mk-prompt input'); i.value = ${JSON.stringify(typed)}; i.form.requestSubmit(); })()`);
          return true;
        };
        const ok = await renameVia('새:안내*자료').catch(() => false);
        const renamed = await until(() => js(nw, `document.querySelector('.mk-doc a[data-file]')?.textContent`).then((t) => t === '새 안내 자료.pdf' && t), '바뀐 칩 이름', 3000).catch(() => null);
        const dialogGone = await js(nw, `!document.querySelector('.mk-prompt')`);
        check('파일 이름 변경: 오른쪽 클릭 › 이름 변경… → 칩 이름이 바뀜 (확장자 유지 · 쓸 수 없는 글자는 공백으로)', ok && renamed === '새 안내 자료.pdf' && dialogGone, JSON.stringify({ ok, renamed, dialogGone }));
        await renameVia('안내 자료.pdf').catch(() => {});
        await until(() => js(nw, `document.querySelector('.mk-doc a[data-file]')?.textContent === '안내 자료.pdf'`), '칩 이름 되돌림', 3000).catch(() => {});
      }
      // 서식 막대: 파일 칩에 커서가 있으면 글 서식 단추는 쓸 수 없다 (content-fixed)
      {
        await js(nw, `(() => { const a = document.querySelector('.mk-doc a[data-file]'); const r = document.createRange(); r.setStart(a.firstChild, 1); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); })()`);
        const fixed = await until(() => js(nw, `document.body.classList.contains('content-fixed') && getComputedStyle(document.querySelector('[data-cmd="bold"]')).pointerEvents === 'none'`), '서식 막대 비활성', 3000).catch(() => false);
        check('파일 칩을 고르면 글 서식 막대(굵게 · 기울임 …)는 쓸 수 없음', fixed);
      }
      // 잘라내기 아이콘: 복사한 뒤 지움 → Ctrl+Z 로 되돌림
      {
        const before = await js(nw, `document.querySelectorAll('.mk-doc a[data-file]').length`);
        await openMenu('.mk-doc a[data-file]');
        const copiesBefore = smokeOpened.filter((o) => o.kind === 'copy-file').length;
        await clickMenu('.mk-ctx-ic[data-id="cut"]');
        const gone = await until(() => js(nw, `document.querySelectorAll('.mk-doc a[data-file]').length === ${before - 1}`), '잘라낸 칩 사라짐', 3000).catch(() => false);
        const copied = smokeOpened.filter((o) => o.kind === 'copy-file').length === copiesBefore + 1;
        await js(nw, `document.querySelector('.mk-doc').focus()`);
        key(nw, 'Z', ['control']);
        const back = await until(() => js(nw, `document.querySelectorAll('.mk-doc a[data-file]').length === ${before}`), 'Ctrl+Z 로 되살림', 3000).catch(() => false);
        check('잘라내기 아이콘: 파일을 복사한 뒤 지우고, Ctrl+Z 로 되돌아옴', gone && copied && back, JSON.stringify({ before, gone, copied, back }));
      }
      // PDF 저장: 파일 그대로
      await openMenu('.mk-doc a[data-file]');
      await clickMenu('.mk-ctx-ic[data-id="save"]');
      const savedPdf = await until(() => smokeOpened.filter((o) => o.kind === 'save').find((o) => /안내 자료\.pdf$/.test(o.target)), 'PDF 저장', 3000).catch(() => null);
      check('PDF 파일: 저장 버튼 → 그 파일 그대로', Boolean(savedPdf) && fs.readFileSync(savedPdf.target, 'utf8').startsWith('%PDF'), JSON.stringify(savedPdf));
      // 공유 아이콘 → 방법 고르기 → 메일에 첨부 (메모 폴더의 파일 그대로). 방법 고르기가 뜨면 오른쪽 클릭 메뉴는 닫힌다
      await openMenu('.mk-doc a[data-file]');
      const shareShown = await clickMenu('.mk-ctx-ic[data-id="share"]');
      const menu = await until(() => js(nw, `(() => { const m = document.querySelector('.mk-share-menu'); return m && [...m.querySelectorAll('button')].map((b) => b.dataset.via + (b.disabled ? '-' : '')).join(','); })()`), '공유 방법 메뉴', 3000).catch(() => '');
      const buttonsLeft = await js(nw, `document.querySelectorAll('.mk-ctx, .mk-delete-btn, .mk-copy-btn, .mk-save-btn, .mk-share-btn').length`);
      await js(nw, `document.querySelector('.mk-share-menu [data-via="mail"]')?.click()`);
      const sharedPdf = await until(() => smokeOpened.filter((o) => o.kind === 'share').find((o) => o.via === 'mail' && /안내 자료\.pdf$/.test(o.target)), 'PDF 공유', 3000).catch(() => null);
      check('공유 아이콘 → 방법 고르기(Drive 링크 · LocalSend · 메일, Windows 공유는 없음, Drive 는 연결 전이면 흐리게 — 눌러서 연결하러 감) · 그때 오른쪽 클릭 메뉴는 닫혀 남지 않음 → 그 파일',
        shareShown && !/sheet/.test(menu) && /drive(,|$)/.test(menu) && /localsend/.test(menu) && /mail/.test(menu) && buttonsLeft === 0 && Boolean(sharedPdf), JSON.stringify({ shareShown, menu, buttonsLeft, sharedPdf }));
      // Drive 링크를 복사하면 가운데 알림 + 폭죽
      const popped = await js(nw, `import('./js/share-menu.js').then(async (m) => { m.showSharePop({ title: '링크를 복사했어요', sub: '메신저나 메일에 Ctrl+V 로 붙여 넣으세요' }); await new Promise((r) => setTimeout(r, 300)); const p = document.querySelector('.mk-share-pop'); return { text: p?.innerText ?? '', confetti: Boolean(document.querySelector('canvas.mk-confetti')), z: p ? getComputedStyle(p).zIndex : '' }; })`);
      await capture(nw, 'smoke-new-share-pop.png');
      await js(nw, `document.querySelector('.mk-share-pop')?.click()`);
      await wait(300); // 사라지는 0.2초 (그 사이에는 아래 내용을 가린다)
      check('Drive 링크 복사 알림: "링크를 복사했어요 · Ctrl+V 로 붙여 넣으세요" + 폭죽 (주소는 보이지 않음)', /링크를 복사했어요/.test(popped.text) && /붙여 넣으세요/.test(popped.text) && !/https?:/.test(popped.text) && popped.confetti, JSON.stringify(popped));
      // 상태 줄이 잘리면 메모 창 바깥에 말풍선으로 전문 (내용을 가리지 않게) — 좁은 창
      const wide = nw.getBounds();
      const bubbleWin = () => windowManager.statusBubbles.byOwner.get(nw.id)?.win;
      const notice = (text, error = false) => js(nw, `window.dispatchEvent(new CustomEvent('mk:notice', { detail: { text: ${JSON.stringify(text)}, error: ${error} } }))`);
      const readBubble = async () => {
        const bw = bubbleWin();
        if (!bw || bw.isDestroyed() || !bw.isVisible()) return null;
        const r = await js(bw, `(() => { const b = document.getElementById('bubble'); if (b.hidden) return null; const r = b.getBoundingClientRect(); return { text: b.textContent, place: [...document.body.classList].find((c) => c.startsWith('p-')), left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
        if (!r) return null;
        const o = bw.getBounds();
        return { ...r, screen: { left: o.x + r.left, top: o.y + r.top, right: o.x + r.right, bottom: o.y + r.bottom } };
      };
      const longText = '공유 창을 열지 못했어요. 설정에서 Google Drive 를 먼저 연결하거나 메일 · LocalSend 를 골라 주세요';
      nw.setBounds({ ...wide, x: 400, y: 320, width: 300 });
      nw.focus();
      await wait(250);
      await notice(longText);
      const bub = await until(readBubble, '상태 말풍선', 3000).catch(() => null);
      const statusHidden = await js(nw, `getComputedStyle(document.getElementById('status')).color === 'rgba(0, 0, 0, 0)'`);
      const bubbledNoTitle = await js(nw, `!document.getElementById('status').hasAttribute('title')`); // 말풍선이 떠 있는 동안은 같은 말을 또 띄우지 않음
      const noMoreButton = await js(nw, `!document.getElementById('status-more')`);
      if (bubbleWin()) await capture(bubbleWin(), 'smoke-new-status-bubble.png');
      nw.setBounds({ ...wide, x: 400, y: 320, width: 310 }); // 크기를 바꾸면 거두고 상태 줄 글은 다시 보임
      await wait(250);
      const movedAway = !bubbleWin()?.isVisible() && !(await js(nw, `document.getElementById('status').classList.contains('bubbled')`));
      nw.setBounds({ ...wide, x: 400, y: 320, width: 460 }); // 짧은 말이 다 보이는 폭
      await wait(250);
      await notice('저장했어요');
      await wait(200);
      const shortNone = { bubble: Boolean(bubbleWin()?.isVisible()), state: await js(nw, `({ title: document.getElementById('status').getAttribute('title'), clipped: document.getElementById('status').classList.contains('clipped'), sw: document.getElementById('status').scrollWidth, cw: document.getElementById('status').clientWidth, t: document.getElementById('status').textContent })`) };
      check('상태 줄이 잘리면 메모 창 위 바깥에 말풍선으로 전문 (상태 줄은 감춰 중복 없음) · 끝까지 보기 버튼은 없음 · 크기를 바꾸면 거두고 글은 다시 · 다 보이면 없음',
        bub?.text === longText && bub.place === 'p-above' && bub.screen.bottom <= nw.getBounds().y && statusHidden && bubbledNoTitle && noMoreButton && movedAway && !shortNone.bubble && !shortNone.state.clipped && shortNone.state.title === null,
        JSON.stringify({ bub, statusHidden, bubbledNoTitle, noMoreButton, movedAway, shortNone }));
      // 진행 안내("…중")는 말풍선 없이 — 잘려도 상태 줄은 그대로 창을 끄는 자리 (글자 위를 잡고 창을 옮길 수 있게)
      nw.setBounds({ ...wide, x: 400, y: 320, width: 300 });
      await wait(250);
      await notice('그림을 만드는 중… 메모가 길면 조금 걸려요. 잠시만 기다려 주세요');
      await wait(400);
      const progressNone = !bubbleWin()?.isVisible();
      const progressTip = await js(nw, `(() => { const s = document.getElementById('status'); return { title: s.title, drag: getComputedStyle(s).getPropertyValue('-webkit-app-region') }; })()`);
      check('진행 안내("…중")는 말풍선 없이, 잘린 상태 줄도 창을 끄는 자리 (전문은 title)', progressNone && /메모가 길면 조금 걸려요/.test(progressTip.title) && progressTip.drag.trim() === 'drag', JSON.stringify({ progressNone, progressTip }));
      // 오류는 저절로 사라지지 않는다 (9초 뒤에도)
      await notice(longText, true);
      await until(readBubble, '오류 말풍선', 2000).catch(() => null);
      await wait(9000);
      const errorStays = Boolean(await readBubble());
      await notice('');
      check('오류 말풍선은 저절로 사라지지 않음 (놓치지 않게)', errorStays);
      // 화면 맨 위에 붙은 창: 위에 자리가 없으면 옆에 (본문을 가리지 않게)
      const area = electronApi.screen.getDisplayMatching(nw.getBounds()).workArea;
      nw.setBounds({ x: area.x + 400, y: area.y, width: 300, height: wide.height });
      nw.focus();
      await wait(250);
      await notice(longText);
      const side = await until(readBubble, '옆 말풍선', 3000).catch(() => null);
      const nb2 = nw.getBounds();
      if (bubbleWin()) await capture(bubbleWin(), 'smoke-new-status-bubble-side.png');
      check('화면 맨 위 창: 말풍선은 창 옆 바깥에 (본문을 가리지 않음)', Boolean(side) && ['p-right', 'p-left'].includes(side.place) && (side.screen.left >= nb2.x + nb2.width || side.screen.right <= nb2.x), JSON.stringify({ side, nb2 }));
      // 왕관을 붙인 창: 말풍선이 왕관 스티커와 겹치지 않음
      nw.setBounds({ ...wide, x: 400, y: 320, width: 300 });
      await wait(200);
      await js(nw, `document.getElementById('top-btn').click()`);
      await until(() => windowManager.stickers.get(nw.id)?.win?.isVisible(), '왕관', 3000).catch(() => {});
      await wait(400);
      nw.focus();
      await notice(longText);
      const crowned = await until(readBubble, '왕관 창 말풍선', 3000).catch(() => null);
      const sb = windowManager.stickers.get(nw.id)?.win?.getBounds();
      const overlap = crowned && sb && crowned.screen.left < sb.x + sb.width && crowned.screen.right > sb.x && crowned.screen.top < sb.y + sb.height && crowned.screen.bottom > sb.y;
      check('왕관을 붙인 창: 말풍선이 왕관 스티커와 겹치지 않음', Boolean(crowned) && Boolean(sb) && !overlap, JSON.stringify({ crowned, sb }));
      await key(nw, 'T', ['control', 'shift']); // 왕관 떼기
      await until(() => !windowManager.stickers.get(nw.id), '왕관 떼기', 3000).catch(() => {});
      nw.setBounds(wide);
      await wait(200);
      // 표 공유: 임시 CSV 를 만들어 보낸다 (Esc 로 메뉴를 닫으면 아무것도 안 함)
      await leave();
      await openMenu('.mk-doc .tableWrapper td');
      const sharesBefore = smokeOpened.filter((o) => o.kind === 'share').length;
      await clickMenu('.mk-ctx-ic[data-id="share"]');
      await until(() => js(nw, `!!document.querySelector('.mk-share-menu')`), '표 공유 메뉴', 3000).catch(() => {});
      const hasCancel = await js(nw, `document.querySelector('.mk-share-menu .mk-share-cancel')?.textContent === '취소'`);
      check('공유 방법 메뉴에 "취소" 버튼', hasCancel);
      await js(nw, `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); // 실제 키처럼 요소에서
      await wait(200);
      const escClosed = await js(nw, `!document.querySelector('.mk-share-menu')`) && smokeOpened.filter((o) => o.kind === 'share').length === sharesBefore;
      await leave();
      await openMenu('.mk-doc .tableWrapper td');
      await clickMenu('.mk-ctx-ic[data-id="share"]');
      await until(() => js(nw, `!!document.querySelector('.mk-share-menu [data-via="mail"]')`), '표 공유 메뉴 2', 3000).catch(() => {});
      await js(nw, `document.querySelector('.mk-share-menu [data-via="mail"]')?.click()`);
      const sharedCsv = await until(() => smokeOpened.filter((o) => o.kind === 'share').find((o) => o.via === 'mail' && /\.csv$/.test(o.target)), '표 공유', 3000).catch(() => null);
      check('표 공유: Esc 는 그만두기, 메일에 첨부를 고르면 임시 CSV 파일로', escClosed && Boolean(sharedCsv) && fs.readFileSync(sharedCsv.target, 'utf8').includes('이름'), JSON.stringify({ escClosed, sharedCsv }));
      await leave();
      // 표: 표째로 복사 (엑셀에 붙도록 칸 사이 탭 · 서식은 표 그대로)
      const tableMenu = await openMenu('.mk-doc .tableWrapper td');
      clipboard.writeText('비움');
      const tableDone = tableMenu ? await pressCopy() : '';
      const clip = async (type) => {
        for (const item of await clipboard.read()) if (item.types.includes(type)) return (await item.getType(type)).text();
        return '';
      };
      const tableText = await clip('text/plain');
      const tableHtml = await clip('text/html');
      check('표: 오른쪽 클릭 → 맨 위 아이콘 줄 + 칸의 글 항목(잘라내기 · 복사 · 붙여넣기 …) + 표 바꾸기, 복사 아이콘은 칸 사이 탭 + 표 서식',
        tableMenu?.icons.join('|') === 'cut:이 표 잘라내기|copy:이 표 복사|save:이 표 저장|share:이 표 공유|delete:이 표 삭제' && /내용을 복사했어요/.test(tableDone) && /이름\t값\n가\t1/.test(tableText) && /<table/.test(tableHtml) && !/column-resize-handle|contenteditable/.test(tableHtml)
          && ['잘라내기', '복사', '붙여넣기', '서식 없이 붙여넣기', '표를 목록으로', '표를 체크리스트로', '표를 글로', '열 너비 맞춤'].every((t) => tableMenu.items.includes(t)),
        JSON.stringify({ tableMenu, tableDone, tableText, html: tableHtml.slice(0, 200) }));
      // 표 저장: 엑셀에서 바로 열리는 CSV (한글이 깨지지 않게 BOM)
      await leave();
      await openMenu('.mk-doc .tableWrapper td');
      const savesBefore = smokeOpened.filter((o) => o.kind === 'save').length;
      await clickMenu('.mk-ctx-ic[data-id="save"]');
      const savedTable = await until(() => smokeOpened.filter((o) => o.kind === 'save').length > savesBefore && smokeOpened.filter((o) => o.kind === 'save').at(-1), '표 저장', 3000).catch(() => null);
      const csv = savedTable ? fs.readFileSync(savedTable.target, 'utf8') : '';
      check('표: 저장 아이콘 → CSV 파일 (머리 줄 · 칸 · BOM)', /\.csv$/.test(savedTable?.target ?? '') && csv === '\ufeff이름,값\r\n가,1', JSON.stringify({ target: savedTable?.target, csv }));
      await leave();
      // 수식: 오른쪽 클릭 → "수식 고치기" + 아이콘 줄, 지우기 아이콘을 누르면 수식만 사라지고 되돌리기 안내
      await leave();
      const mathMenu = await openMenu('.mk-doc .mk-math-block');
      const mathHit = await clickMenu('.mk-ctx-ic[data-id="delete"]');
      const mathGone = await until(() => js(nw, `!document.querySelector('.mk-doc .mk-math-block') && document.querySelector('.mk-doc').textContent.includes('끝 문단')`), '수식 지움', 3000).catch(() => false);
      const undoTip = await until(() => js(nw, `document.getElementById('mk-undo-hint')?.textContent`), '되돌리기 안내', 2000).catch(() => '');
      check('수식: 오른쪽 클릭 → "이 수식 고치기" + 삭제 아이콘 (눌리는 자리에 있음), 누르면 수식만 지워지고 그 자리에 "수식을 삭제했어요 [되돌리기] Ctrl+Z"',
        mathMenu?.items.join('|') === '이 수식 고치기' && mathMenu.icons.at(-1) === 'delete:이 수식 삭제' && mathHit && mathGone && /^수식을 삭제했어요 되돌리기 Ctrl\+Z$/.test(undoTip.replace(/\s+/g, ' ').trim()), JSON.stringify({ mathMenu, mathHit, mathGone, undoTip }));
      // 안내의 되돌리기 단추(마우스)로 되살리기 — Ctrl 만 눌러도 안내가 사라지지 않음
      nw.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
      nw.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
      await wait(150);
      const tipAfterCtrl = await js(nw, `Boolean(document.getElementById('mk-undo-hint'))`);
      await js(nw, `document.querySelector('#mk-undo-hint .mk-undo-btn')?.click()`);
      const mathBack = await until(() => js(nw, `Boolean(document.querySelector('.mk-doc .mk-math-block'))`), '되돌리기 버튼', 3000).catch(() => false);
      check('삭제한 내용: 안내의 되돌리기 버튼으로 되살림 (Ctrl 만 눌러서는 안내가 사라지지 않음)', tipAfterCtrl && mathBack, JSON.stringify({ tipAfterCtrl, mathBack }));
      // 키보드: 메뉴가 뜬 뒤 ← → ↑ ↓ Enter Esc (손만으로)
      await leave();
      await openMenu('.mk-doc a[data-file]');
      const focusId = () => js(nw, `document.activeElement?.dataset?.id ?? ''`);
      await key(nw, 'Right');
      await key(nw, 'Right');
      await wait(60);
      const afterRight = await focusId();
      await key(nw, 'Down');
      await wait(60);
      const afterDown = await focusId();
      await key(nw, 'Escape');
      await wait(200);
      const closedByEsc = await js(nw, `!document.querySelector('.mk-ctx')`);
      check('오른쪽 클릭 메뉴: 키보드로 오가고(→ → ↓) Esc 로 닫힘', afterRight.length > 0 && afterDown.length > 0 && afterRight !== afterDown && closedByEsc, JSON.stringify({ afterRight, afterDown, closedByEsc }));
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
      // 마지막 문단 끝에 커서 — 편집기가 고른 자리를 받아들일 때까지(selectionchange) 기다린다 (바로 붙여 넣으면 맨 앞에 들어가는 일이 있어)
      const caretAtEnd = `(() => { document.querySelector('.ProseMirror').focus(); const p = [...document.querySelectorAll('.mk-doc p')].at(-1); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`;
      await js(nw, caretAtEnd);
      await wait(150);
      key(nw, 'Enter');
      await wait(100);
      // 메모장에서 복사한 글 (HTML 없음)
      const pasted = '  국내사업부 대표 안내\n    네 칸 들여쓴 줄\n\t탭 줄\n\n- 목록은 목록\n\n마지막 줄';
      await js(nw, `(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(pasted)}); document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
      await wait(300);
      // 직접 친 줄 앞 띄어쓰기
      await js(nw, caretAtEnd);
      await wait(150);
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
      await wait(150);
      key(nw, 'Enter');
      await wait(80);
      await js(nw, `(() => { const dt = new DataTransfer(); dt.setData('text/html', '<p>&nbsp;&nbsp;워드에서 들여 쓴 줄&nbsp;&nbsp;끝</p>'); dt.setData('text/plain', '  워드에서 들여 쓴 줄  끝'); document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
      await wait(300);
      const htmlLine = await js(nw, `[...document.querySelectorAll('.mk-doc p')].map((p) => p.textContent).find((t) => t.includes('워드에서')) ?? ''`);
      check('서식 글(HTML)을 붙여도 줄 앞 들여쓰기 그대로 (글 속 겹친 빈칸은 보통 띄어쓰기)', htmlLine === `${N}${N}워드에서 들여 쓴 줄  끝`, JSON.stringify(htmlLine));
      // 줄을 나누다 앞에 남은 띄어쓰기는 일부러 넣은 것이 아니므로 다듬기가 지운다 ("앞말| 뒷말" 에서 Enter)
      await js(nw, caretAtEnd);
      await wait(150);
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
      // 윗막대 번개 단추(불러오기 키) → 3 · 내용 복사만. 정하기 전에는 사선 · 메뉴에는 메모 연결이 있고 소리 받아쓰기는 없다
      const barBefore = await js(nw, `(() => { const b = document.getElementById('hotkey-btn'); return { inBar: Boolean(b.closest('.bar')), off: b.classList.contains('off'), slash: getComputedStyle(b, '::after').content !== 'none', links: Boolean(document.querySelector('#menu #links-btn')), linksInBar: Boolean(document.querySelector('.bar #links-btn')), transcribe: Boolean(document.getElementById('transcribe-btn')) }; })()`);
      await js(nw, `document.getElementById('hotkey-btn').click()`);
      await until(() => js(nw, `!!document.querySelector('.hotkey-dialog[open] .hk-key')`), '단축키 창');
      const dlg = await js(nw, `(() => {
        const d = document.querySelector('.hotkey-dialog');
        const keys = d.querySelectorAll('.hk-key').length;
        // 누르면 할 일은 세 칸 중 하나 (v0.33.1 — 둘 다 끈 상태가 없다)
        const modes = [...d.querySelectorAll('.hk-mode [role="radio"]')];
        const saveBtn = d.querySelector('button[type="submit"]');
        const before = saveBtn.disabled; // 숫자를 고르기 전
        d.querySelectorAll('.hk-key')[2].click();
        modes[0].click(); // 내용 복사
        const none = { modes: modes.map((m) => m.textContent), picked: modes.filter((m) => m.getAttribute('aria-checked') === 'true').length };
        const hint = d.querySelector('.hk-hint').textContent;
        const after = saveBtn.disabled;
        const legend = Boolean(d.querySelector('.hk-legend')?.textContent.includes('다른 메모가 써요'));
        return { keys, before, none, hint, legend, after, fits: d.scrollHeight <= d.clientHeight + 1, size: [d.scrollHeight, d.clientHeight, innerHeight] };
      })()`);
      await capture(nw, 'smoke-new-hotkey-dialog.png');
      await js(nw, `document.querySelector('.hotkey-dialog button[type="submit"]').click()`);
      await until(() => js(nw, `!document.querySelector('.hotkey-dialog')`), '단축키 창 닫힘');
      const saved = getSettings().memoHotkeys?.['3'];
      const barAfter = await js(nw, `(() => { const b = document.getElementById('hotkey-btn'); return { num: document.getElementById('hotkey-num').textContent, off: b.classList.contains('off'), numShown: getComputedStyle(document.getElementById('hotkey-num')).display !== 'none', title: b.title }; })()`);
      const label = barAfter.num === '3' && /Ctrl\+Alt\+3/.test(barAfter.title) ? 'Ctrl+Alt+3' : '';
      await capture(nw, 'smoke-new-hotkey-bar.png');
      check('윗막대: 메모 연결 대신 불러오기 키 버튼 (없으면 사선, 정하면 숫자 3) · 메모 연결은 ⋯ 메뉴로 · 소리 받아쓰기 메뉴 없음',
        barBefore.inBar && barBefore.off && barBefore.slash && barBefore.links && !barBefore.linksInBar && !barBefore.transcribe && !barAfter.off && barAfter.numShown,
        JSON.stringify({ barBefore, barAfter }));
      check('메모 단축키 창: 1~9 · 할 일 세 칸 중 하나 · 저장하면 Ctrl+Alt+3 에 이 메모 (번개 버튼에 표시)',
        dlg.keys === 9 && dlg.before && dlg.none.modes.length === 3 && dlg.none.picked === 1 && !dlg.after && /^Ctrl\+Alt\+3: 어느 앱에서든 누르면 내용을 복사해요$/.test(dlg.hint) && dlg.legend && dlg.fits
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
      // 왕관(늘 위)이 붙은 메모를 단축키로 부르면: 왕관을 떼고 보통 창으로 (테이프도 같은 길 — 붙은 채로는 층이 엉켜 오류)
      windowManager.setNoteLayer(hid, 'top');
      shownWin?.close();
      await until(() => !noteWins.has(hid), '메모 창 닫힘 (왕관)');
      await memoHotkeys.onPress('3');
      const crownWin = await until(() => noteWins.get(hid)?.isVisible() && noteWins.get(hid), '왕관 메모 단축키로 띄우기', 4000).catch(() => null);
      check('왕관이 붙은 메모를 단축키로 부르면 왕관을 떼고 띄움', Boolean(crownWin) && windowManager.layerOf(hid) === null && !crownWin.isAlwaysOnTop(),
        JSON.stringify({ shown: Boolean(crownWin), layer: windowManager.layerOf(hid), onTop: crownWin?.isAlwaysOnTop() }));
      crownWin?.close();
      // 풀기
      const off = memoHotkeys.set(hid, null);
      check('단축키 풀기 → 키를 놓아 다른 앱이 쓸 수 있게', off.ok && !memoHotkeys.held.has('3') && !getSettings().memoHotkeys?.['3'], JSON.stringify(getSettings().memoHotkeys));
    }

    // ---------- v0.35 — 테이프 (바탕화면에 붙이기 = 왕관의 반대, 메모 창 그대로) ----------
    {
      const list = getList() ?? createListWindow();
      const vault = getVault();
      const stickers = windowManager.stickers;
      const tid = vault.import({ body: '# 자주 쓰는 안내\n\n전화 상담: 평일 9시~6시\n' });
      await until(() => js(list, `!!document.querySelector('[data-id="${tid}"]')`), '테이프 메모 카드');
      const openTaped = async () => {
        const b0 = new Set(noteWins.keys());
        windowManager.openNote(tid); // 다시 켤 때처럼 (목록에서 고르면 테이프가 떨어진다 — 아래에서 따로 본다)
        const nid = await until(() => noteWins.get(tid)?.isVisible() && tid, '테이프 메모 창').catch(() => [...noteWins.keys()].find((k) => !b0.has(k)));
        const w = noteWins.get(nid);
        await until(() => js(w, `document.documentElement.dataset.ready === 'true' && !!document.querySelector('.mk-doc')`), '테이프 메모 준비');
        return w;
      };
      const buttons = (w) => js(w, `(() => {
        const st = (b) => b.hidden ? 'hidden' : b.classList.contains('folded') ? 'folded' : b.classList.contains('peeled') ? 'peeled' : 'shown';
        return { top: st(document.getElementById('top-btn')), tape: st(document.getElementById('tape-btn')), status: document.getElementById('status').textContent, menu: Boolean(document.getElementById('widget-btn')) };
      })()`);
      const kindOf = (w) => stickers.get(w.id)?.kind ?? null;
      let nw = await openTaped();
      const b0 = await buttons(nw);
      check('메모 창 윗막대: 왕관 옆에 테이프 버튼, ⋯ 메뉴에는 바탕화면에 붙이기 없음', b0.top === 'shown' && b0.tape === 'shown' && !b0.menu, JSON.stringify(b0));
      const nb = nw.getBounds();
      await js(nw, `document.getElementById('tape-btn').click()`);
      const taped = await until(() => kindOf(nw) === 'tape' && stickers.get(nw.id)?.win?.isVisible() && getSettings().onBottom?.[tid] === true, '테이프 붙이기', 4000).catch(() => false);
      const b1 = await buttons(nw);
      const sb = stickers.get(nw.id)?.win?.getBounds();
      check('테이프 버튼 → 메모 창 위 가장자리 가운데에 테이프 (절반은 메모 밖), 창은 그대로 · 늘 위 아님',
        taped && !nw.isDestroyed() && !nw.isAlwaysOnTop() && sb && Math.abs(sb.y + sb.height / 2 - nb.y) <= 1 && Math.abs(sb.x + sb.width / 2 - (nb.x + nb.width / 2)) <= 1,
        JSON.stringify({ taped, sb, nb }));
      check('붙이면 두 버튼 모두 사라짐 (테이프 자리는 비고 왕관은 접힘) · 상태 줄 안내', b1.tape === 'peeled' && b1.top === 'folded' && /바탕화면에 붙였어요/.test(b1.status), JSON.stringify(b1));
      await capture(nw, 'smoke-new-taped.png');
      // 스티커 창 안에 실제로 그려진 것이 테이프인지 (왕관이 아니라)
      const sw = stickers.get(nw.id)?.win;
      await until(() => sw && js(sw, `document.documentElement.dataset.ready === 'true'`), '테이프 창 준비', 4000).catch(() => {});
      const drawn = sw ? await js(sw, `({ tape: getComputedStyle(document.getElementById('tape')).display, crown: getComputedStyle(document.getElementById('crown')).display, url: location.href })`) : null;
      if (sw) await capture(sw, 'smoke-new-tape-sticker.png');
      check('스티커 창에 그려진 것은 테이프 (왕관은 숨김)', drawn?.tape !== 'none' && drawn?.crown === 'none', JSON.stringify(drawn));
      const badge = await until(() => js(list, `!!document.querySelector('[data-id="${tid}"] .taped')`), '목록 테이프 표시', 3000).catch(() => false);
      check('목록 카드에 바탕화면 표시', badge);
      // 스티커에 마우스를 올리면 메모 창 상태 줄에 "누르면 떼어져요"
      windowManager.stickerHover(stickers.get(nw.id).win.webContents, true);
      const hint = await until(async () => /테이프를 누르면/.test((await buttons(nw)).status), '스티커 안내', 2000).catch(() => false);
      windowManager.stickerHover(stickers.get(nw.id).win.webContents, false);
      // 한 번 본 안내는 다시 띄우지 않는다
      await js(nw, `window.dispatchEvent(new CustomEvent('mk:notice', { detail: { text: '' } }))`);
      windowManager.stickerHover(stickers.get(nw.id).win.webContents, true);
      await wait(300);
      const again = /테이프를 누르면/.test((await buttons(nw)).status);
      windowManager.stickerHover(stickers.get(nw.id).win.webContents, false);
      check('테이프에 마우스를 올리면 상태 줄에 "누르면 떼어져요" — 처음 한 번만', hint && !again, JSON.stringify({ hint, again }));
      // 왕관과 함께 붙지 않는다: 단축키로 바꿔 붙임
      await key(nw, 'T', ['control', 'shift']);
      const crowned = await until(() => nw.isAlwaysOnTop() && kindOf(nw) === 'crown' && !getSettings().onBottom?.[tid] && getSettings().onTop?.[tid] === true, 'Ctrl+Shift+T 로 바꿈', 3000).catch(() => false);
      await key(nw, 'G', ['control', 'shift']);
      const backTaped = await until(() => !nw.isAlwaysOnTop() && kindOf(nw) === 'tape' && getSettings().onBottom?.[tid] === true && !getSettings().onTop?.[tid], 'Ctrl+Shift+G 로 바꿈', 3000).catch(() => false);
      check('왕관 · 테이프는 함께 붙지 않음 (Ctrl+Shift+T / G 로 바꿔 붙음)', crowned && backTaped, JSON.stringify({ crowned, backTaped }));
      // 닫았다 다시 열어도 테이프
      nw.close();
      await until(() => !noteWins.has(tid), '테이프 메모 닫힘', 3000).catch(() => {});
      nw = await openTaped();
      const kept = await until(() => kindOf(nw) === 'tape', '다시 열어도 테이프', 3000).catch(() => false);
      const b2 = await buttons(nw);
      check('다시 열어도 테이프 (버튼도 숨은 채 · 다시 열 때는 안내 없음)', kept && b2.tape === 'peeled' && b2.top === 'folded' && !/붙였어요/.test(b2.status), JSON.stringify(b2));
      // 목록에서 테이프 메모를 고르면 테이프를 떼고 앞으로 (붙인 채로는 다른 창 뒤에 숨어 고를 수 없었다)
      await js(list, `window.memoking.memo.open(${JSON.stringify(tid)})`);
      const fell = await until(async () => !getSettings().onBottom?.[tid] && !stickers.get(nw.id) && /테이프가 떨어졌어요/.test((await buttons(nw)).status), '목록에서 고르면 테이프 떼기', 3000).catch(() => false);
      const b4 = await buttons(nw);
      check('목록에서 테이프 메모를 고르면 테이프가 떨어지고(상태 줄 안내) 창이 앞으로', fell && b4.tape === 'shown' && b4.top === 'shown' && nw.isVisible(), JSON.stringify(b4));
      await js(nw, `document.getElementById('tape-btn').click()`); // 아래 "테이프를 누르면 떼어짐" 을 위해 다시 붙인다
      await until(() => kindOf(nw) === 'tape' && getSettings().onBottom?.[tid] === true, '다시 테이프', 4000).catch(() => {});
      // 테이프를 누르면 떼어져 보통 창 (메모 창은 그대로, 버튼 둘 다 돌아옴)
      await until(() => js(stickers.get(nw.id).win, `document.documentElement.dataset.ready === 'true'`), '테이프 준비', 4000).catch(() => {});
      // 보이는 모양을 누른다: 창 가운데에 있는 것이 테이프여야 한다
      // 테이프 창이 아직 안 떴으면 기다리다 멈추지 않게 (멈추면 뒤의 점검이 모두 안 돈다)
      const tapeWin = stickers.get(nw.id)?.win;
      if (process.env.MK_SMOKE_TRACE) console.log(`… 테이프 창: ${JSON.stringify({ kind: kindOf(nw), onBottom: getSettings().onBottom?.[tid], has: Boolean(tapeWin), loading: tapeWin?.webContents.isLoading(), url: tapeWin?.webContents.getURL() })}`);
      const hitTape = tapeWin ? await Promise.race([
        js(tapeWin, `(() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); const ok = Boolean(el?.closest('#tape .hit')); el?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return ok; })()`),
        wait(4000).then(() => false),
      ]) : false;
      const peeled = await until(() => !stickers.get(nw.id) && !getSettings().onBottom?.[tid], '테이프 떼기', 3000).catch(() => false);
      const b3 = await buttons(nw);
      // 목록에서 지우면 그 카드가 제자리에서 흐려지며 사라진다 (옆으로 날아가지 않게)
      const did = vault.import({ body: '# 지울 메모\n\n흐려지며 사라져요\n' });
      await until(() => js(list, `!!document.querySelector('[data-delete="${did}"]')`), '지울 메모 카드');
      const ghostAnim = await js(list, `(() => { document.querySelector('[data-delete="${did}"]').click(); const g = document.querySelector('.card-ghost'); return g ? getComputedStyle(g).animationName : 'reduce'; })()`);
      check('목록에서 삭제: 옆으로 날아가지 않고 제자리에서 흐려짐', ghostAnim === 'card-fade' || ghostAnim === 'reduce', ghostAnim);
      check('테이프를 누르면 떼어짐 → 메모 창은 그대로, 왕관 · 테이프 버튼이 돌아옴', hitTape && peeled && !nw.isDestroyed() && nw.isVisible() && b3.top === 'shown' && b3.tape === 'shown' && /뗐어요/.test(b3.status), JSON.stringify(b3));
      nw.close();
      await until(() => !noteWins.has(tid), '메모 닫힘 2', 3000).catch(() => {});
      // 예전 바탕화면 위젯 → 테이프 붙인 메모 창 (그 자리에)
      const at = { x: nb.x + 30, y: nb.y + 20, width: 200, height: 150 };
      getSettings().widgets = { [tid]: { ...at, taped: true }, 'other-folder-memo': { x: 1, y: 1, width: 300, height: 300 } };
      windowManager.migrateWidgets();
      const mw = await until(() => noteWins.get(tid)?.isVisible() && noteWins.get(tid), '옮긴 위젯', 4000).catch(() => null);
      const mb = mw?.getBounds();
      check('예전 바탕화면 위젯 → 그 자리의 테이프 메모 창 (작으면 메모 창 최소 크기로, 다른 폴더의 위젯 기억은 남김)',
        Boolean(mw) && getSettings().onBottom?.[tid] === true && mb && Math.abs(mb.x - at.x) <= 2 && Math.abs(mb.y - at.y) <= 2 && mb.width >= 240 && mb.height >= 200
          && !getSettings().widgets?.[tid] && Boolean(getSettings().widgets?.['other-folder-memo']),
        JSON.stringify({ mb, at, widgets: getSettings().widgets }));
      delete getSettings().widgets;
      if (mw) windowManager.setNoteLayer(tid, null);
      mw?.close();
      await until(() => !noteWins.has(tid), '메모 닫힘 3', 3000).catch(() => {});

      // 테이프 메모끼리: 끌어 다른 테이프 메모 위에 머물렀다 놓으면 탭으로 합쳐지고 둘 다 테이프 그대로
      const ta = vault.import({ body: '# 테이프 가\n\n가' });
      const tb = vault.import({ body: '# 테이프 나\n\n나' });
      const wa = windowManager.openNote(ta);
      const wb2 = windowManager.openNote(tb);
      await until(() => wa.isVisible() && wb2.isVisible(), '테이프 두 창', 6000).catch(() => {});
      windowManager.setNoteLayer(ta, 'bottom');
      windowManager.setNoteLayer(tb, 'bottom');
      const ab = wa.getBounds();
      const overA = { x: ab.x + Math.round(ab.width / 2), y: ab.y + Math.round(ab.height / 2) };
      windowManager.trackWindowDrag(tb, overA);
      await wait(500);
      windowManager.endWindowDrag(tb);
      const stackedTaped = await until(() => {
        const st = windowManager.stacks?.stackOf(tb);
        return st && st.memos.includes(ta) && st.memos.every((m) => getSettings().onBottom?.[m] === true) && st;
      }, '테이프 메모 합치기', 4000).catch(() => null);
      check('테이프 메모끼리 끌어 놓으면 스택(탭)으로 합쳐지고 둘 다 테이프 그대로', Boolean(stackedTaped), JSON.stringify(stackedTaped));
      windowManager.setNoteLayer(tb, null);
      noteWins.get(tb)?.close();
      await until(() => !noteWins.has(ta) && !noteWins.has(tb), '테이프 스택 닫힘', 3000).catch(() => {});
    }

    // ---------- PDF로 저장 창: 작은 창에서도 취소 · 저장이 보이고, 글자 크기 · 단축키 ----------
    {
      const lines = Array.from({ length: 60 }, (_, i) => `줄 ${i + 1} 이 메모는 여러 쪽이 되도록 길게 적은 글이에요`).join('\n\n');
      const pid = vault.import({ body: `# PDF 점검\n\n${lines}` });
      const pw = windowManager.openNote(pid);
      await until(() => pw.isVisible() && js(pw, 'document.documentElement.dataset.ready === "true"'), 'PDF 점검 메모', 8000);
      await js(pw, `document.getElementById('menu-btn').click()`);
      await capture(pw, 'note-menu.png');
      await js(pw, `document.getElementById('menu-btn').click()`);
      // 메모 창에서 Ctrl+Shift+P → PDF 창
      pw.focus();
      key(pw, 'P', ['control', 'shift']);
      const pdfWin = await until(() => windowManager.pdfWin?.isVisible() && windowManager.pdfWin, 'Ctrl+Shift+P → PDF 창', 6000).catch(() => null);
      check('메모 창에서 Ctrl+Shift+P → PDF로 저장 창', Boolean(pdfWin));
      if (pdfWin) {
        await until(() => js(pdfWin, 'document.documentElement.dataset.ready === "true"'), 'PDF 창 준비');
        pdfWin.setSize(640, 480); // 가장 작은 창
        await wait(300);
        await capture(pdfWin, 'pdf-small.png');
        const layout = await js(pdfWin, `(() => {
          const vis = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 0.5; };
          return { save: vis('save'), cancel: vis('cancel'), openInActions: Boolean(document.querySelector('.actions #open-after')), zoom: Boolean(document.getElementById('zoom-range')) };
        })()`);
        check('PDF 창이 작아도 취소 · PDF로 저장 버튼이 보이고, 저장한 뒤 열기는 버튼 줄과 떨어짐 · 글자 크기 조절 있음', layout.save && layout.cancel && !layout.openInActions && layout.zoom, JSON.stringify(layout));
        const pagesAt = async (z) => {
          await js(pdfWin, `(() => { const r = document.getElementById('zoom-range'); r.value = '${z}'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
          return until(async () => {
            const src = await js(pdfWin, `document.getElementById('frame').getAttribute('src')`);
            const n = await js(pdfWin, 'document.body.dataset.pages');
            return src?.includes(`z=${z / 100}`) && Number(n) > 0 && Number(n);
          }, `글자 크기 ${z}%`, 15000).catch(() => 0); // 미리보기를 다시 그리는 데 느린 점검 환경에서 몇 초
        };
        const small = await pagesAt(50);
        const big = await pagesAt(200);
        const pv = await js(pdfWin, `({ src: document.getElementById('frame').getAttribute('src'), pages: document.body.dataset.pages, sum: document.getElementById('summary').textContent, inner: (() => { try { const d = document.getElementById('frame').contentDocument; return d && { ready: d.documentElement.dataset.ready, pages: d.documentElement.dataset.pages, href: d.location.href.slice(-60) }; } catch (err) { return String(err); } })() })`);
        check('PDF 글자 크기를 키우면 미리보기 쪽 수가 늘어남', small > 0 && big > small, JSON.stringify({ small, big, pv }));
        await pagesAt(100);
        pdfWin.close();
      }
      // 단축키 설정 창: 설정의 단추로 열리고, PDF 키를 바꾸면 메모 창에 바로
      const listWin = getList() ?? createListWindow('memos');
      await until(() => js(listWin, 'document.documentElement.dataset.ready === "true"'), '목록 준비');
      await js(listWin, `document.getElementById('settings-btn').click()`);
      await wait(300);
      await js(listWin, `document.getElementById('keymap-open').scrollIntoView({ block: 'center' })`);
      await capture(listWin, 'settings-keymap.png');
      await js(listWin, `document.getElementById('keymap-open').click()`);
      const kw = await until(() => windowManager.keymapWin?.isVisible() && windowManager.keymapWin, '단축키 설정 창', 6000).catch(() => null);
      check('설정 › 단축키 설정하기 → 단축키 설정 창', Boolean(kw));
      if (kw) {
        await until(() => js(kw, 'document.documentElement.dataset.ready === "true"'), '단축키 창 준비');
        const rows = await js(kw, `document.querySelectorAll('.row').length`);
        const keyRight = await js(kw, `(() => { const row = document.querySelector('.row'); const k = row.lastElementChild; const pad = parseFloat(getComputedStyle(row).paddingRight); return { last: k.className, gap: Math.round(row.getBoundingClientRect().right - pad - k.getBoundingClientRect().right) }; })()`);
        check('단축키 설정: 키 칸이 줄 오른쪽 끝에 붙음 (기본값 버튼은 키 칸 왼쪽)', /^key/.test(keyRight.last) && Math.abs(keyRight.gap) <= 1, JSON.stringify(keyRight));
        await capture(kw, 'keymap.png');
        // PDF로 저장 줄의 키 칸을 누르고 Ctrl+Alt+P
        await js(kw, `[...document.querySelectorAll('.row')].find((r) => r.querySelector('.name').dataset.label === 'PDF로 저장').querySelector('.key').click()`);
        kw.focus();
        key(kw, 'P', ['control', 'alt']);
        const changed = await until(() => js(kw, `[...document.querySelectorAll('.row')].find((r) => r.querySelector('.name').dataset.label === 'PDF로 저장').querySelector('.key').textContent === 'Ctrl+Alt+P'`), 'PDF 키 바뀜', 4000).catch(() => false);
        // 마우스를 올리면 설명
        await js(kw, `document.querySelector('.row .name').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
        await wait(450); // 머물러야 뜬다
        const tip = await js(kw, `!document.getElementById('tip').hidden && document.getElementById('tip').textContent`);
        await capture(kw, 'keymap-tip.png');
        check('단축키 창: 기능 목록 · 키 바꾸기 · 마우스를 올리면 하는 일 설명', rows > 25 && changed && /메모/.test(tip || ''), JSON.stringify({ rows, changed, tip }));
        pw.focus();
        key(pw, 'P', ['control', 'alt']);
        const viaNew = await until(() => windowManager.pdfWin?.isVisible(), '바꾼 키로 PDF', 5000).catch(() => false);
        windowManager.pdfWin?.close();
        await wait(200);
        key(pw, 'P', ['control', 'shift']);
        await wait(700);
        const oldKeyGone = !windowManager.pdfWin;
        check('바꾼 키(Ctrl+Alt+P)로 PDF 창이 열리고, 예전 키는 더 이상 안 열림', viaNew && oldKeyGone, JSON.stringify({ viaNew, oldKeyGone }));
        // 모두 초기화 (두 번 눌러야)
        await js(kw, `document.getElementById('reset-all').click()`);
        const once = getSettings().keymap?.pdf;
        await js(kw, `document.getElementById('reset-all').click()`);
        const reset = await until(() => !getSettings().keymap?.pdf, '초기화', 4000).then(() => true).catch(() => false);
        check('모두 초기화: 한 번 더 눌러야 되고, 누르면 처음 키로', Boolean(once) && reset, JSON.stringify({ once, keymap: getSettings().keymap }));
        kw.close();
      }
      pw.close();
    }

    // ---------- 붙여넣기 · 빠른 메모: 메신저에서 복사한 글은 메모장처럼 (빈 줄 · 문장부호 앞 띄어쓰기 그대로) ----------
    {
      const plain = '시스템상에 출원지시 요청된 상태인가요?\r\n오전 09:52\r\n\r\n윤형선 (HS)\r\n이미 출원지시는 온 상태이군요.\r\n오전 09:53\r\n지재팀에서 컨펌 메일을 보내주길 기다리고 있었습니다 시스템 확인해보겠습니다 !\r\n앗\r\n\r\n윤형선 (HS)\r\n넵 ! 감사합니다 !';
      // 메신저 HTML: 말풍선마다 div, 글자 사이에 폭 없는 공백이 섞여 있다 (서식은 없음)
      const html = '<div class="chat"><div class="msg"><span style="color:#555">시스템상에 출원지시 요청된 상태인가요?</span></div><div class="time">오전 09:52</div></div>'
        + '<div class="chat"><div class="name">윤형선 (HS)</div><div class="msg"><span>이미 출원지시는 온 상태이군요.\u200b</span></div><div class="time">오전 09:53</div>'
        + '<div class="msg mine">지재팀에서 컨펌 메일을 보내주길 기다리고 있었습니다 시스템 확인해보겠습니다 !</div><div class="msg mine">앗</div></div>'
        + '<div class="chat"><div class="name">윤형선 (HS)</div><div class="msg">넵 ! 감사합니다 !</div></div>';
      const pid = vault.import({ body: '' });
      const pw = windowManager.openNote(pid);
      await until(() => pw.isVisible() && js(pw, 'document.documentElement.dataset.ready === "true"'), '붙여넣기 메모', 8000);
      await js(pw, `(() => { document.querySelector('.ProseMirror').focus(); const d = new DataTransfer(); d.setData('text/html', ${JSON.stringify(html)}); d.setData('text/plain', ${JSON.stringify(plain)}); document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); })()`);
      await wait(400);
      await js(pw, `document.querySelector('.ProseMirror').blur()`); // 다듬기는 커서가 떠날 때
      await wait(1500); // 저장
      const lines = await js(pw, `[...document.querySelector('.ProseMirror').children].map((p) => p.textContent)`);
      const want = plain.split('\r\n');
      check('메신저 글 붙여넣기: 줄 · 빈 줄 · "확인해보겠습니다 !" 띄어쓰기가 메모장과 같게', JSON.stringify(lines) === JSON.stringify(want), JSON.stringify(lines));
      // 직접 친 줄은 여전히 다듬는다 ("합니다 ." → "합니다."), 붙여 넣은 줄은 커서가 지나가도 그대로
      pw.focus();
      await js(pw, `(() => { const pm = document.querySelector('.ProseMirror'); pm.focus(); const sel = getSelection(); sel.selectAllChildren(pm.lastElementChild); sel.collapseToEnd(); })()`);
      key(pw, 'Enter');
      await wait(100);
      pw.webContents.insertText('직접 친 줄입니다 .');
      await wait(100);
      key(pw, 'Enter');
      await wait(400);
      const after = await js(pw, `[...document.querySelector('.ProseMirror').children].map((p) => p.textContent)`);
      check('다듬기: 직접 친 줄은 "입니다 ." → "입니다.", 붙여 넣은 "감사합니다 !" 는 그대로', after.includes('직접 친 줄입니다.') && after.includes('넵 ! 감사합니다 !'), JSON.stringify(after));
      pw.close();
    }

    // ---------- 설정: OPMS 서버 주소는 사용자가 넣고(코드에 없음), 업데이트 칸 ----------
    {
      const lw = getList() ?? createListWindow('memos');
      await until(() => js(lw, 'document.documentElement.dataset.ready === "true"'), '목록 준비');
      await js(lw, `document.getElementById('settings-btn').click()`);
      const setupShown = await until(() => js(lw, `!document.getElementById('opms-setup').hidden`), 'OPMS 연결 칸', 4000).then(() => true).catch(() => false);
      const bad = await js(lw, `(async () => { document.getElementById('opms-host').value = 'ftp://x'; document.getElementById('opms-host-form').requestSubmit(); await new Promise((r) => setTimeout(r, 300)); return document.getElementById('opms-host-note').textContent; })()`);
      const keep = getSettings().opms?.host;
      const good = await js(lw, `(async () => { document.getElementById('opms-host').value = '10.0.0.7:8181'; document.getElementById('opms-host-form').requestSubmit(); await new Promise((r) => setTimeout(r, 300)); return document.getElementById('opms-host-note').textContent; })()`);
      const savedHost = getSettings().opms?.host;
      getSettings().opms = { ...getSettings().opms, host: keep }; // 점검의 가짜 OPMS 주소로 되돌림
      const update = await js(lw, `({ cur: document.getElementById('update-current').textContent, note: document.getElementById('update-note').textContent })`);
      check('설정: OPMS 서버 주소를 넣어 저장(잘못된 주소는 안내) · 업데이트 칸(지금 버전, 개발 중에는 확인 안 함)', setupShown && /알아보지 못했어요/.test(bad) && savedHost === 'http://10.0.0.7:8181' && /저장했어요/.test(good) && /^v\d/.test(update.cur), JSON.stringify({ setupShown, bad, good, savedHost, update }));
      // 업데이트 단추: 최신이면 초록 "최신 버전", 새 버전이면 노랑 "업데이트 v…" (누르면 바뀐 점 대화 상자)
      const btnAt = async (st) => {
        lw.webContents.send('update:state', { current: '0.39.3', ...st });
        await wait(350); // 색이 바뀌는 0.2초가 끝난 뒤
        return js(lw, `(() => { const b = document.getElementById('update-check'); return { state: b.dataset.state, text: b.textContent, bg: getComputedStyle(b).backgroundColor }; })()`);
      };
      const latest = await btnAt({ status: 'latest' });
      const avail = await btnAt({ status: 'available', version: '0.40.0', notes: '새 기능' });
      // 노랑 단추를 누르면 먼저 다시 확인한다 (점검은 개발 실행이라 "개발 중" 으로 — 실제 앱은 새 버전이면 바뀐 점 대화 상자)
      await js(lw, `document.getElementById('update-check').click()`);
      await wait(400);
      const rechecked = await js(lw, `({ state: document.getElementById('update-check').dataset.state, note: document.getElementById('update-note').textContent })`);
      // 바뀐 점 대화 상자: 새 버전 알림이 오면 v지금 → v새것
      lw.webContents.send('update:available', { current: '0.39.3', status: 'available', version: '0.40.0', notes: '새 기능' });
      await wait(200);
      const dialogOpen = await js(lw, `document.getElementById('update-dialog').open && [...document.querySelectorAll('#update-version span')].map((e) => e.textContent).join(' ')`);
      await js(lw, `document.getElementById('update-dialog').close()`);
      lw.webContents.send('update:state', { current: '0.39.3', status: 'idle' }); // 가짜 상태를 거둔다
      check('설정 › 업데이트: 최신이면 초록 "최신 버전", 새 버전이면 노랑 "업데이트 v0.40.0"(누르면 다시 확인) · 새 버전 알림은 바뀐 점', latest.state === 'latest' && /최신 버전/.test(latest.text) && (([r, g, b]) => g > r && g > b)(latest.bg.match(/\d+/g).map(Number))
        && avail.state === 'available' && avail.text === '업데이트 v0.40.0' && /개발 중/.test(rechecked.note) && /v0\.39\.3 → v0\.40\.0/.test(dialogOpen || ''), JSON.stringify({ latest, avail, rechecked, dialogOpen }));
      await js(lw, `document.getElementById('settings-dialog').close()`);
    }

    // ---------- 스택 탭 전환 속도: 다른 탭 창을 미리 만들어 두고, 저장을 기다리지 않고 바로 ----------
    //   앱을 다시 켠 뒤처럼 탭 창이 하나도 없는 스택(가 · 나 · 다)에서 시작
    {
      const [ta, tb, tc] = ['가', '나', '다'].map((t) => vault.import({ body: `# 탭 ${t}\n\n${t.repeat(40)}` }));
      windowManager.stacks.merge(ta, [tb, tc], { activate: ta });
      const wa = windowManager.showTab(ta);
      await until(() => wa.isVisible() && js(wa, 'document.documentElement.dataset.ready === "true"'), '탭 가 창', 8000);
      const warmed = await until(() => [tb, tc].every((m) => noteWins.get(m)), '다른 탭 미리 만들기', 8000).then(() => true).catch(() => false);
      await until(async () => (await Promise.all([tb, tc].map((m) => js(noteWins.get(m), 'document.documentElement.dataset.ready === "true"').catch(() => false)))).every(Boolean), '탭 창 준비', 8000).catch(() => {});
      const shown = () => [ta, tb, tc].filter((m) => noteWins.get(m)?.isVisible());
      const switchTo = async (from, to) => {
        const w = noteWins.get(from);
        await js(w, `document.querySelector('.ProseMirror')?.focus(); document.execCommand('insertText', false, ' 고침')`); // 저장할 것이 있게
        const t0 = Date.now();
        await js(w, `document.querySelector('[data-tab-id="${to}"]').click()`);
        while (Date.now() - t0 < 5000 && !(shown().length === 1 && shown()[0] === to)) await wait(5); // 5ms 간격으로 잰다
        return Date.now() - t0;
      };
      const times = [await switchTo(ta, tb), await switchTo(tb, tc), await switchTo(tc, ta)];
      console.log(`스택 탭 전환 시간(ms): ${times.join(', ')} · 미리 만든 탭 창: ${warmed}`);
      const barShown = await js(noteWins.get(ta), `!document.body.classList.contains('bar-hidden')`);
      await wait(900); // 저장(함께 진행)이 끝나게
      const savedAll = [ta, tb, tc].every((m) => vault.get(m)?.body.includes('고침'));
      check('스택 탭: 다른 탭 창을 미리 만들어 두고, 바꾸면 바로 보이며 서식 막대가 펴진 채 · 쓰던 글은 그대로 저장', warmed && times.every((t) => t < 600) && barShown && savedAll, JSON.stringify({ warmed, times, barShown, savedAll }));
      noteWins.get(ta)?.close();
      await until(() => ![ta, tb, tc].some((m) => noteWins.get(m)?.isVisible()), '스택 닫힘', 4000).catch(() => {});
    }

    // ---------- v0.46 — 편집기: 체크리스트 Enter · 서식 없이 붙여넣기 · 서식 지우기 · 표→체크리스트 · 여러 파일 놓기 · 끌어내기 · 비활성 테두리 ----------
    {
      const list = getList() ?? createListWindow();
      await until(() => js(list, `document.readyState === 'complete'`), '목록 창');
      const openMemo = async (body, label) => {
        const id = vault.import({ body });
        await until(() => js(list, `!!document.querySelector('[data-id="${id}"]')`), `${label} 카드`);
        const before = new Set(noteWins.keys());
        await js(list, `document.querySelector('[data-id="${id}"]').click()`);
        const nid = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), `${label} 창`);
        const win = noteWins.get(nid);
        await until(() => js(win, `document.documentElement.dataset.ready === 'true'`), `${label} 준비`);
        win.focus();
        await wait(200);
        return { id: nid, win };
      };
      // 글 줄 끝에 커서 (n 번째 일치하는 요소)
      const caretIn = (sel, at = 'end', n = 0) => `(() => { document.querySelector('.ProseMirror').focus(); const e = [...document.querySelectorAll(${JSON.stringify(sel)})][${n}]; const r = document.createRange(); r.selectNodeContents(e); r.collapse(${at === 'start'}); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`;
      const listWin = list;

      // 1) 체크한 항목에서 Enter → 새 항목은 체크 해제
      {
        const { win } = await openMemo('# 할 일\n\n- [x] 끝낸 일\n- [ ] 남은 일\n', '체크리스트');
        await js(win, caretIn('.mk-doc li p', 'end', 0));
        await wait(150);
        key(win, 'Enter');
        await wait(250);
        {
          const states = await js(win, `[...document.querySelectorAll('.mk-doc li')].map((li) => li.getAttribute('data-checked') + ':' + li.textContent.trim())`);
          check('체크한 항목에서 Enter: 새 항목은 체크가 풀린 채 (위 항목은 체크 그대로)', states.length === 3 && states[0] === 'true:끝낸 일' && states[1] === 'false:' && states[2] === 'false:남은 일', JSON.stringify(states));
        }
        // 체크 안 한 빈 항목에서 Enter 는 평소처럼
        key(win, 'Enter');
        await wait(250);
        const after = await js(win, `[...document.querySelectorAll('.mk-doc li')].map((li) => li.getAttribute('data-checked') + ':' + li.textContent.trim())`);
        check('체크 안 한 빈 항목에서 Enter: 평소처럼 (가운데 빈 항목은 사라지고) 다른 항목의 체크는 그대로', after.join('|') === 'true:끝낸 일|false:남은 일', JSON.stringify(after));
        win.close();
      }

      // 2) Ctrl+Shift+V 서식 없이 붙여넣기 · 오른쪽 클릭 메뉴의 같은 기능
      {
        const { win } = await openMemo('# 붙여넣기\n\n**굵은 글** [링크](https://example.com)\n\n끝\n', '붙여넣기');
        // 서식 있는 글을 복사해 두고 (편집기에서 Ctrl+C — 굵게 · 링크가 클립보드 HTML 에 든다)
        await js(win, `(() => { document.querySelector('.ProseMirror').focus(); const p = document.querySelectorAll('.mk-doc p')[0]; const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
        await wait(150);
        key(win, 'C', ['control']);
        await wait(300);
        await js(win, caretIn('.mk-doc p', 'end', 1));
        await wait(150);
        key(win, 'V', ['control', 'shift']);
        await wait(400);
        const plain1 = await js(win, `(() => { const p = document.querySelectorAll('.mk-doc p')[1]; return { text: p.textContent, strong: p.querySelectorAll('strong, b').length, a: p.querySelectorAll('a').length }; })()`);
        check('Ctrl+Shift+V: 서식 없이 글자만 (굵게 · 링크 없음)', plain1.text.includes('굵은 글') && plain1.strong === 0 && plain1.a === 0, JSON.stringify(plain1));
        // 일반 Ctrl+V 는 서식 그대로
        await js(win, caretIn('.mk-doc p', 'end', 1));
        key(win, 'Enter');
        await wait(100);
        key(win, 'V', ['control']);
        await wait(400);
        const rich = await js(win, `(() => { const p = [...document.querySelectorAll('.mk-doc p')].at(-1); return { strong: p.querySelectorAll('strong, b').length, text: p.textContent }; })()`);
        check('Ctrl+V 는 서식 그대로 (Ctrl+Shift+V 와 다름)', rich.strong >= 1, JSON.stringify(rich));
        // 메인이 보내는 '서식 없이 붙여넣기'(오른쪽 클릭 메뉴) 도 같은 일
        await js(win, caretIn('.mk-doc p', 'end', 0));
        await wait(100);
        win.webContents.send('edit:paste-plain', '메뉴로 붙인\n두 줄');
        await wait(300);
        const viaMenu = await js(win, `[...document.querySelectorAll('.mk-doc p')].map((p) => p.textContent)`);
        check('오른쪽 클릭 › 서식 없이 붙여넣기: 글자만, 줄마다 문단', viaMenu.some((t) => t.includes('메뉴로 붙인')) && viaMenu.includes('두 줄'), JSON.stringify(viaMenu));
        win.close();
      }

      // 3) 서식 지우기 (오른쪽 클릭 › 서식 지우기 = edit:clear-format) · 표 → 체크리스트
      {
        const body = '# 큰 제목\n\n**굵게** 보통 *기울임* [링크](https://example.com)\n\n- 목록 하나\n- 목록 **둘**\n\n> 인용 글\n\n| 이름 | 값 |\n| --- | --- |\n| 가 | 1 |\n| 나 | 2 |\n';
        const { win } = await openMemo(body, '서식 지우기');
        const clear = async () => {
          win.webContents.send('edit:clear-format');
          await wait(300);
          return js(win, `document.getElementById('status').textContent`);
        };
        // 고른 글: 그 부분만
        await js(win, `(() => { document.querySelector('.ProseMirror').focus(); const p = [...document.querySelectorAll('.mk-doc p')][0]; const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
        await wait(150);
        await clear();
        const sel1 = await js(win, `(() => { const p = document.querySelector('.mk-doc p'); return { strong: p.querySelectorAll('strong,b').length, em: p.querySelectorAll('em,i').length, a: p.querySelectorAll('a').length, h1: document.querySelectorAll('.mk-doc h1').length, text: p.textContent }; })()`);
        check('서식 지우기(글을 고름): 고른 글자 모양만 지움 (굵게 · 기울임 없음, 링크와 제목은 그대로)', sel1.strong === 0 && sel1.em === 0 && sel1.a === 1 && sel1.h1 === 1 && sel1.text.startsWith('굵게 보통'), JSON.stringify(sel1));
        // 커서만: 제목 → 본문
        await js(win, caretIn('.mk-doc h1', 'end'));
        await wait(120);
        await clear();
        const head = await js(win, `({ h1: document.querySelectorAll('.mk-doc h1').length, first: document.querySelector('.mk-doc').firstElementChild?.tagName })`);
        check('서식 지우기(커서만): 제목은 본문이 됨', head.h1 === 0 && head.first === 'P', JSON.stringify(head));
        // 커서만: 목록 → 문단 (글자 모양도)
        await js(win, caretIn('.mk-doc li p', 'end', 1));
        await wait(120);
        const lstMsg = await clear();
        const lst = await js(win, `({ li: document.querySelectorAll('.mk-doc li').length, ul: document.querySelectorAll('.mk-doc ul, .mk-doc ol').length, strong: document.querySelectorAll('.mk-doc li strong, .mk-doc p strong').length, texts: [...document.querySelectorAll('.mk-doc p')].map((p) => p.textContent) })`);
        check('서식 지우기(커서만): 목록은 풀려 문단이 되고 글자 모양도 없음', lst.li === 0 && lst.ul === 0 && lst.strong === 0 && lst.texts.includes('목록 하나') && lst.texts.includes('목록 둘'), JSON.stringify({ lst, lstMsg }));
        // 커서만: 인용 벗기기
        await js(win, caretIn('.mk-doc blockquote p', 'end'));
        await wait(120);
        await clear();
        const quote = await js(win, `({ bq: document.querySelectorAll('.mk-doc blockquote').length, has: [...document.querySelectorAll('.mk-doc p')].some((p) => p.textContent === '인용 글') })`);
        check('서식 지우기(커서만): 인용은 벗겨짐', quote.bq === 0 && quote.has, JSON.stringify(quote));
        // 표 → 체크리스트 (표 막대의 체크리스트로)
        await js(win, caretIn('.mk-doc td p', 'end', 0));
        await wait(300);
        const toTaskBtn = await js(win, `(() => { const b = document.querySelector('#table-bar [data-table="toTask"]'); return b ? { lbl: b.textContent.trim(), disabled: b.disabled, shown: b.offsetParent !== null } : null; })()`);
        await js(win, `document.querySelector('#table-bar [data-table="toTask"]')?.click()`);
        await wait(300);
        const task = await js(win, `({ table: document.querySelectorAll('.mk-doc table').length, items: [...document.querySelectorAll('.mk-doc li')].map((li) => li.getAttribute('data-checked') + ':' + li.textContent.trim()) })`);
        check('표 → 체크리스트: 행마다 체크 안 한 항목 (칸은 · 로 이어서)', toTaskBtn && /체크리스트/.test(toTaskBtn.lbl) && task.table === 0 && task.items.join('|') === 'false:이름 · 값|false:가 · 1|false:나 · 2', JSON.stringify({ toTaskBtn, task }));
        // 되돌리기 한 번에 표로
        key(win, 'Z', ['control']);
        await wait(300);
        const undone = await js(win, `document.querySelectorAll('.mk-doc table').length`);
        check('표 → 체크리스트도 Ctrl+Z 한 번에 표로 돌아옴', undone === 1, String(undone));
        // 커서만: 표 → 글 줄
        await js(win, caretIn('.mk-doc td p', 'end', 0));
        await wait(150);
        await clear();
        const tbl = await js(win, `({ table: document.querySelectorAll('.mk-doc table').length, texts: [...document.querySelectorAll('.mk-doc p')].map((p) => p.textContent) })`);
        check('서식 지우기(커서만): 표는 글 줄이 됨', tbl.table === 0 && tbl.texts.includes('이름 · 값') && tbl.texts.includes('나 · 2'), JSON.stringify(tbl));
        win.close();
      }

      // 4) 여러 파일을 한꺼번에 끌어다 놓기 · 메모 밖으로 끌어내기 · 다른 창에 가 있으면 고른 테두리 해제
      {
        const { win } = await openMemo('# 파일 놓기\n\n끝\n', '파일 놓기');
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        await js(win, `(async () => {
          const bin = Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0));
          const files = [new File(['첫째 파일'], '가.txt', { type: 'text/plain' }), new File([bin], '나.png', { type: 'image/png' }), new File(['%PDF-1.4 smoke'], '다.pdf', { type: 'application/pdf' }), new File(['넷째'], '라.txt', { type: 'text/plain' })];
          const broken = new File([''], '읽을 수 없는 폴더', { type: '' }); // 읽다가 실패하는 파일 (폴더를 놓은 것처럼)
          broken.arrayBuffer = () => Promise.reject(new Error('NotFoundError'));
          files.splice(2, 0, broken);
          const dt = new DataTransfer();
          for (const f of files) dt.items.add(f);
          const r = document.querySelector('.mk-doc p').getBoundingClientRect();
          document.querySelector('.ProseMirror').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 }));
        })()`);
        const dropped = await until(() => js(win, `(() => { const chips = [...document.querySelectorAll('.mk-doc a[data-file]')].map((a) => a.textContent.trim()); const imgs = document.querySelectorAll('.mk-doc img.mk-image').length; return chips.length >= 3 && { chips, imgs }; })()`), '여러 파일 놓기', 4000).catch(() => null);
        const fallback = dropped || await js(win, `({ chips: [...document.querySelectorAll('.mk-doc a[data-file]')].map((a) => a.textContent.trim()), imgs: document.querySelectorAll('.mk-doc img.mk-image').length })`);
        const dropNote = await js(win, `document.getElementById('status').textContent`);
        check('여러 파일 놓기: 4개 (글 파일 2 · PDF · 사진)가 한 번에 모두 들어감, 읽지 못한 하나(폴더)는 알리고 나머지는 그대로', fallback.chips.length === 3 && fallback.imgs === 1 && ['가.txt', '다.pdf', '라.txt'].every((n) => fallback.chips.includes(n)) && /4개를 넣었어요.*1개.*읽지 못해/.test(dropNote.replace('파일 ', '')), JSON.stringify({ fallback, dropNote }));
        await wait(600);
        // 끌어내기: 파일 칩 · 사진을 메모 밖으로 → 보이는 이름의 임시 파일이 간다
        const dragBefore = smokeOpened.filter((o) => o.kind === 'drag-out').length;
        const prevented = await js(win, `(() => { const a = document.querySelector('.mk-doc a[data-file]'); const dt = new DataTransfer(); const e = new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }); a.dispatchEvent(e); return e.defaultPrevented; })()`);
        const out = await until(() => smokeOpened.filter((o) => o.kind === 'drag-out').length > dragBefore && smokeOpened.filter((o) => o.kind === 'drag-out').at(-1), '끌어내기', 3000).catch(() => null);
        const outOk = out && /가\.txt$/.test(out.target) && fs.readFileSync(out.target, 'utf8') === '첫째 파일' && /memoking-drag/.test(out.target);
        check('파일 칩을 메모 밖으로 끌어내면 (탐색기 · 카카오톡) 보이는 이름의 복사본 파일이 감 — 메모의 첨부는 그대로', prevented && Boolean(outOk) && fs.readdirSync(path.join(vault.root, 'attachments')).length >= 4, JSON.stringify({ prevented, out }));
        const dragBefore2 = smokeOpened.filter((o) => o.kind === 'drag-out').length;
        await js(win, `(() => { const a = document.querySelector('.mk-doc img.mk-image'); a.dispatchEvent(new DragEvent('dragstart', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true })); })()`);
        const outImg = await until(() => smokeOpened.filter((o) => o.kind === 'drag-out').length > dragBefore2 && smokeOpened.filter((o) => o.kind === 'drag-out').at(-1), '사진 끌어내기', 3000).catch(() => null);
        check('사진도 끌어내면 그림 파일 (확장자 유지)', Boolean(outImg) && /\.png$/i.test(outImg.target) && fs.statSync(outImg.target).size > 50, JSON.stringify(outImg));
        // 끌어낸 파일이 도로 이 메모에 떨어지면 무시 (메모킹이 끌어낸 임시 파일 경로면)
        win.close();
      }
      {
        // 다른 창으로 가면 고른 그림의 노란 테두리는 거둔다 (돌아오면 다시)
        const { win } = await openMemo('# 선택 테두리\n\n끝\n', '선택 테두리');
        await js(win, `(() => { const wrap = document.createElement('div'); wrap.className = 'mk-doc'; wrap.style.cssText = 'position: fixed; left: 0; top: 0'; const probe = document.createElement('div'); probe.id = 'probe'; probe.className = 'ProseMirror-selectednode'; probe.style.cssText = 'width: 10px; height: 10px'; wrap.append(probe); document.body.append(wrap); })()`); // 편집기 밖에 둔 "고른 내용" 모양의 상자 (편집기가 지워 버리지 않게)
        listWin.focus();
        await wait(500);
        const away = await js(win, `({ inactive: document.body.classList.contains('win-inactive'), outline: getComputedStyle(document.getElementById('probe')).outlineStyle })`);
        win.focus();
        await wait(500);
        const back = await js(win, `({ inactive: document.body.classList.contains('win-inactive'), outline: getComputedStyle(document.getElementById('probe')).outlineStyle })`);
        check('다른 창으로 가면 고른 내용의 노란 테두리가 사라지고, 돌아오면 다시 보임', away.inactive && away.outline === 'none' && !back.inactive && back.outline === 'solid', JSON.stringify({ away, back }));
        win.close();
      }
    }

    // 음성 카드 · 소리: 오른쪽 클릭 메뉴(잘라내기 · 복사 · 저장 · 공유 · 지우기 + 이름 변경), 소리 줄을 골라도 글 서식 막대는 쓸 수 없음, 이름 변경이 설명(alt)에 반영
    {
      const vault2 = getVault();
      fs.writeFileSync(path.join(vault2.root, 'attachments', 'voice-smoke.m4a'), 'smoke');
      const vid = vault2.import({ body: '# 음성 점검\n\n> ![녹음 · 00:12](attachments/voice-smoke.m4a)\n>\n> **화자 1:** 안녕하세요.\n\n끝\n' });
      windowManager.openNote(vid);
      const vw = await until(() => noteWins.get(vid), '음성 메모 창', 6000).catch(() => null);
      if (vw) await until(() => js(vw, `document.documentElement.dataset.ready === 'true' && !!document.querySelector('.mk-voice')`), '음성 카드 보임', 8000).catch(() => {});
      const rc = async (sel) => {
        const r = await js(vw, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + Math.min(14, r.height / 2)) }; })()`);
        if (!r) return null;
        vw.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
        vw.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'right', clickCount: 1 });
        vw.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'right', clickCount: 1 });
        return until(() => js(vw, `(() => { const m = document.querySelector('.mk-ctx'); return m && { icons: [...m.querySelectorAll('.mk-ctx-ic')].map((b) => b.dataset.id), items: [...m.querySelectorAll('.mk-ctx-item')].map((b) => b.dataset.id) }; })()`), '음성 카드 메뉴', 3000).catch(() => null);
      };
      const menu = vw ? await rc('.mk-voice') : null;
      check('음성 카드: 오른쪽 클릭 → 잘라내기 · 복사 · 저장 · 공유 · 삭제 아이콘 + 이름 변경', menu?.icons.join() === 'cut,copy,save,share,delete' && menu.items.includes('rename'), JSON.stringify(menu));
      if (menu) {
        const pos = await js(vw, `(() => { const e = document.querySelector('.mk-ctx-item[data-id="rename"]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        vw.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
        await wait(80);
        vw.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
        vw.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
        await until(() => js(vw, `!!document.querySelector('.mk-prompt input')`), '이름 입력 창', 3000);
        await js(vw, `(() => { const i = document.querySelector('.mk-prompt input'); i.value = '회의 녹음'; i.form.requestSubmit(); })()`);
        const saved = await until(() => /!\[회의 녹음\]\(attachments\/voice-smoke\.m4a\)/.test(vault2.get(vid)?.body ?? ''), '바뀐 이름 저장', 5000).catch(() => false);
        check('음성 카드 이름 변경: 소리의 설명(alt)이 새 이름으로 저장됨', saved, vault2.get(vid)?.body);
      }
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
