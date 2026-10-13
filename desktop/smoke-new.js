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

export async function runSmoke({ getVault, showMagic, getMagic, getFinder, useFileIndex, getOpms, getSettings, getList, noteWins, createListWindow }) {
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

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  }

  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `바뀐 기능 점검 통과 (${checks.length}개)` : '바뀐 기능 점검 실패');
  app.exit(exitCode);
}
