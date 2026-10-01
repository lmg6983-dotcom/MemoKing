// 바뀐 기능만 확인하는 짧은 점검 (npm run smoke:new) — 전체 점검(npm run smoke)은 요청할 때만.
// 버전마다 아래 "이번 버전" 부분을 새 기능에 맞게 바꾼다. 임시 폴더(%TEMP%\memoking-smoke)만 쓴다.
// 이번 버전: v0.17.0 — 팝업 알림 모으기(UI 자동화·글자 인식) · 메모를 PDF로 · 고친 때 스탬프는 카드 사이 틈에
// (팝업은 점검 앱 자신이 띄운 가짜 알림 창만 지켜본다 — 사용자의 카카오톡 등은 건드리지 않음)
import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SMOKE_DIR = path.join(os.tmpdir(), 'memoking-smoke');
const VAULT = path.join(SMOKE_DIR, 'vault');
const OUT = app.isPackaged ? path.join(SMOKE_DIR, 'out') : path.join(import.meta.dirname, '..', 'out');

export function prepareSmoke(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(VAULT, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ vaultPath: VAULT, tutorialDone: true }));
}

// 가짜 알림 창: html = 글자(UI 자동화로 읽힘) / canvas = 그림 글자(글자 인식으로만 읽힘)
function popupHtml(lines, { canvas = false } = {}) {
  const body = canvas
    ? `<canvas id="c" width="300" height="80"></canvas><script>
        const g = document.getElementById('c').getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, 300, 80); g.fillStyle = '#111111';
        g.font = 'bold 20px "Malgun Gothic"'; g.fillText(${JSON.stringify(lines[0])}, 14, 32);
        g.font = '18px "Malgun Gothic"'; g.fillText(${JSON.stringify(lines[1])}, 14, 62);
      </script>`
    : `<div style="font:700 16px 'Malgun Gothic';padding:12px 14px 2px">${lines[0]}</div><div style="font:15px 'Malgun Gothic';padding:0 14px">${lines[1]}</div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title></title><body style="margin:0;background:#fff">${body}</body>`)}`;
}

export async function runSmoke({ noteWins, getVault, createListWindow, getList, createPopupWatcher, getHistory, smokePdf, getPdfWin }) {
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
        // 아직 준비 안 됨
      }
      await wait(100);
    }
    throw new Error(`시간 초과: ${label}`);
  }
  const ready = (win) => until(() => js(win, 'document.documentElement.dataset.ready === "true"'), '화면 준비', 12000);
  async function capture(win, name) {
    await wait(400);
    fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
  }
  const popups = [];
  let watcher = null;

  let exitCode = 1;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const vault = getVault();
    const history = getHistory();
    const png = fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', 'icons', 'icon-256.png'));
    const shot = vault.saveAttachment(png, 'png');
    const pdfMemo = vault.create();
    vault.save(pdfMemo, `# 분기 회의록\n\n**참석** 김대리, 박과장 #회의\n\n| 항목 | 담당 |\n| --- | --- |\n| 예산 | 김대리 |\n| 일정 | 박과장 |\n\n![로고](${shot})\n\n${Array.from({ length: 14 }, (_, i) => `${i + 1}. 논의한 내용을 길게 적은 문단이에요. 여러 쪽으로 넘어가는지 봐요.`).join('\n')}`);
    vault.setMeta(pdfMemo, { color: 'green' });
    const plain = vault.create();
    vault.save(plain, '# 태그 없는 메모\n\n짧은 내용');
    const list = createListWindow();
    await ready(list);
    const lj = (code) => js(getList(), code);
    await until(() => lj(`document.querySelectorAll('#cards .card').length === 2`), '카드');

    // 1) 고친 때 스탬프: 카드 밖, 카드 사이 틈에 (카드 안 아랫줄은 태그·표시가 있을 때만)
    getList().setSize(400, 680);
    await wait(400);
    const stamp = await lj(`(() => {
      const lis = [...document.querySelectorAll('#cards li')];
      return lis.map((li, i) => {
        const c = li.querySelector('.card').getBoundingClientRect();
        const s = li.querySelector('.card-stamp').getBoundingClientRect();
        const next = lis[i + 1]?.querySelector('.card').getBoundingClientRect();
        return { text: li.querySelector('.card-stamp').textContent, below: s.top >= c.bottom - 0.5, inGap: !next || s.bottom <= next.top + 0.5, right: Math.abs(s.right - (c.right - 6)) < 2, foot: !!li.querySelector('.card-foot') };
      });
    })()`);
    check('고친 때 스탬프는 카드 밖 아래, 다음 카드와의 틈 안 오른쪽 (YY.MM.DD HH:MM)', stamp.every((s) => s.below && s.inGap && s.right && /^\d\d\.\d\d\.\d\d \d\d:\d\d$/.test(s.text)), JSON.stringify(stamp));
    const plainFoot = await lj(`!!document.querySelector('.card[data-id="${plain}"]')?.closest('li').querySelector('.card-foot')`);
    check('태그·표시가 없는 카드는 아랫줄이 없어 그만큼 짧음', !plainFoot);
    // 미리보기 사진은 잘리지 않게 (사진 전체가 칸 안에)
    getList().setSize(760, 1000);
    await wait(500);
    const thumb = await until(() => lj(`(() => { const i = document.querySelector('.card-thumb'); if (!i || !i.naturalWidth) return null;
      const r = i.getBoundingClientRect(); const s = Math.min(r.width / i.naturalWidth, r.height / i.naturalHeight);
      return { fit: getComputedStyle(i).objectFit, drawnW: Math.round(i.naturalWidth * s), drawnH: Math.round(i.naturalHeight * s), boxW: Math.round(r.width), boxH: Math.round(r.height) }; })()`), '사진').catch(() => null);
    check('카드 미리보기 사진은 위아래가 잘리지 않고 전체가 보임', thumb && thumb.fit === 'contain' && thumb.drawnH <= thumb.boxH && thumb.drawnW <= thumb.boxW, JSON.stringify(thumb));
    await capture(getList(), 'smoke-new-thumb.png');
    getList().setSize(400, 680);
    await wait(300);
    await capture(getList(), 'smoke-new-stamps.png');
    const btnSizes = await lj(`(() => {
      const li = document.querySelector('#cards li');
      li.querySelector('.card-actions').style.opacity = '1';
      return [...li.querySelectorAll('.card-actions button')].map((b) => { const r = b.getBoundingClientRect(); return [b.className.split(' ').find((c) => c.startsWith('card-')), Math.round(r.width), Math.round(r.height)]; });
    })()`);
    check('카드 버튼 묶음: PDF·압정·지우기 버튼이 같은 크기', btnSizes.length === 3 && btnSizes.every((b) => b[1] === btnSizes[0][1] && b[2] === btnSizes[0][2]), JSON.stringify(btnSizes));

    // 2) 팝업 알림 지켜보기 (설정)
    await lj(`document.getElementById('settings-btn').click()`);
    await wait(200);
    const pw0 = await lj(`document.getElementById('popup-watch').disabled`);
    await lj(`document.getElementById('history-enabled').click()`);
    await until(() => lj(`document.getElementById('history-enabled').checked && !document.getElementById('popup-watch').disabled`), '알림 모으기 켬');
    await lj(`document.getElementById('popup-watch').click()`);
    await until(() => lj(`document.getElementById('popup-watch').checked`), '팝업 켬');
    await capture(getList(), 'smoke-new-settings-popup.png');
    await lj(`document.getElementById('settings-dialog').close()`);
    check('설정: 알림 모아두기를 켜야 "카카오톡 알림도 모으기"를 켤 수 있음', pw0);

    // 가짜 알림 창을 이 점검 앱이 띄우고, 이 앱의 창만 지켜본다
    watcher = createPopupWatcher({ onlyPid: process.pid, processes: [], dir: path.join(SMOKE_DIR, 'popups') });
    watcher.start();
    const area = screen.getPrimaryDisplay().workArea;
    const popup = (lines, opts) => {
      const w = new BrowserWindow({
        width: 320, height: 96, x: area.x + area.width - 340, y: area.y + area.height - 116 - popups.length * 104,
        frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      popups.push(w);
      w.loadURL(popupHtml(lines, opts));
      w.once('ready-to-show', () => w.showInactive());
      return w;
    };
    const found = (title) => until(() => history.list({ query: title }).find((e) => e.title === title), title, 20000).catch(() => null);
    const p1 = popup(['김대리', '회의 자료 보냈어요']);
    const e1 = await found('김대리');
    check('팝업 알림(글자) → UI 자동화로 읽어 보관함에 (보낸 사람·내용·알림 창 그림)', e1 && e1.body === '회의 자료 보냈어요' && e1.source === 'popup' && e1.image, JSON.stringify(e1));
    const p2 = popup(['박과장', '내일 회의 시간 바꿔요'], { canvas: true });
    const e2 = await found('박과장');
    check('팝업 알림(그림 글자) → Windows 글자 인식(한국어)으로 읽어 보관함에', e2 && /내일\s*회의\s*시간\s*바꿔요/.test(e2.body), JSON.stringify(e2));
    // 같은 창에 새 메시지 → 다시 읽음, 그대로면 한 번만
    const before = history.list({ query: '김대리' }).length;
    await wait(2500);
    const still = history.list({ query: '김대리' }).length;
    await p1.loadURL(popupHtml(['김대리', '자료 다시 보냈어요']));
    const e3 = await until(() => history.list({ query: '자료 다시' })[0], '새 메시지', 15000).catch(() => null);
    check('같은 알림 창은 한 번만 읽고, 내용이 바뀌면(새 메시지) 다시 읽음', before === 1 && still === 1 && e3?.title === '김대리', JSON.stringify({ before, still, e3 }));
    watcher.stop();
    for (const w of popups) if (!w.isDestroyed()) w.destroy();
    await lj(`document.querySelector('.tabs [data-tab="history"]').click()`);
    await until(() => lj(`document.querySelectorAll('#history-rows .noti-shot').length >= 2`), '보관함 그림').catch(() => {});
    const rows = await lj(`[...document.querySelectorAll('#history-rows .noti')].filter((r) => r.querySelector('.noti-shot')).length`);
    check('보관함에서 팝업 알림은 알림 창 그림과 함께 보임', rows >= 2, String(rows));
    await capture(getList(), 'smoke-new-popup-history.png');
    await lj(`document.querySelector('.tabs [data-tab="memos"]').click()`);

    // 3) PDF: 카드에 마우스를 올리면 PDF 버튼 → 만들기 창
    await lj(`document.querySelector('[data-pdf="${pdfMemo}"]').click()`);
    const pw = await until(() => getPdfWin(), 'PDF 창');
    await ready(pw);
    const summary = () => js(pw, `document.getElementById('summary').textContent`);
    const s1 = await until(async () => { const t = await summary(); return /쪽$/.test(t) && t; }, 'A4 미리보기', 15000).catch(summary);
    const sheet1 = await js(pw, `(() => { const r = document.getElementById('sheet').getBoundingClientRect(); return r.width / r.height; })()`);
    check('PDF 창: A4 미리보기(실제 쪽 비율)와 크기·비율·쪽 수 안내', /^210 × 297mm · 1:1\.41 · \d+쪽$/.test(s1) && Math.abs(sheet1 - 210 / 297) < 0.02, `${s1} ${sheet1}`);
    await capture(pw, 'smoke-new-pdf-a4.png');
    // 카드 비율 16:9, 긴 변 160mm, 메모 색 바탕
    await js(pw, `document.querySelector('[data-kind="ratio"]').click()`);
    await js(pw, `document.querySelector('[data-ratio="16:9"]').click()`);
    await js(pw, `(() => { const r = document.getElementById('long'); r.value = 160; r.dispatchEvent(new Event('input')); })()`);
    await js(pw, `document.getElementById('bg').click()`);
    const s2 = await until(async () => { const t = await summary(); return t.startsWith('160 × 90mm · 16:9 ·') && t; }, '16:9 미리보기', 15000).catch(summary);
    const sheet2 = await js(pw, `(() => { const r = document.getElementById('sheet').getBoundingClientRect(); return r.width / r.height; })()`);
    check('카드 비율 16:9·긴 변 160mm 를 고르면 미리보기가 바로 그 모양으로', /^160 × 90mm · 16:9 · \d+쪽$/.test(s2) && Math.abs(sheet2 - 16 / 9) < 0.03, `${s2} ${sheet2}`);
    await capture(pw, 'smoke-new-pdf-169.png');
    // 저장 → 실제 PDF (쪽 크기 = 고른 크기)
    const file = path.join(SMOKE_DIR, 'out-169.pdf');
    smokePdf.push(file);
    await js(pw, `document.getElementById('save').click()`);
    await until(() => fs.existsSync(file) && fs.statSync(file).size > 1000, 'PDF 파일', 20000).catch(() => {});
    const pdf = fs.existsSync(file) ? fs.readFileSync(file).toString('latin1') : '';
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf);
    const pages = (pdf.match(/\/Type\s*\/Page\b/g) ?? []).length;
    const mm = (pt) => (Number(pt) * 25.4) / 72;
    const previewPages = Number(/(\d+)쪽$/.exec(s2)?.[1]);
    check('PDF 파일: 쪽 크기 160 × 90mm, 여러 쪽 — 미리보기의 쪽 수와 실제 PDF 쪽 수가 같음', box && Math.abs(mm(box[1]) - 160) < 1 && Math.abs(mm(box[2]) - 90) < 1 && pages >= 2 && previewPages === pages, JSON.stringify({ box: box?.slice(1), pages, previewPages }));
    const closed = await until(() => !getPdfWin(), '저장 뒤 창 닫힘').then(() => true).catch(() => false);
    check('저장하면 "N쪽 PDF로 저장했어요" 뒤 창이 닫힘', closed);
    // A4 로도 (메모 창 메뉴에서)
    await lj(`window.memoking.memo.open(${JSON.stringify(pdfMemo)})`);
    const nw = await until(() => noteWins.get(pdfMemo), '메모 창');
    await ready(nw);
    await js(nw, `document.getElementById('menu-btn').click()`);
    await js(nw, `document.getElementById('pdf-btn').click()`);
    const pw2 = await until(() => getPdfWin(), 'PDF 창 (메뉴)');
    await ready(pw2);
    await js(pw2, `document.querySelector('[data-kind="paper"]').click()`);
    await js(pw2, `document.querySelector('[data-paper="a4"]').click()`);
    await js(pw2, `document.querySelector('[data-o="landscape"]').click()`);
    const a4file = path.join(SMOKE_DIR, 'out-a4.pdf');
    smokePdf.push(a4file);
    await wait(300);
    await js(pw2, `document.getElementById('save').click()`);
    await until(() => fs.existsSync(a4file) && fs.statSync(a4file).size > 1000, 'A4 PDF', 20000).catch(() => {});
    const a4 = fs.existsSync(a4file) ? fs.readFileSync(a4file).toString('latin1') : '';
    const box2 = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(a4);
    check('메모 창 메뉴 › PDF로 저장 → A4 가로 PDF (297 × 210mm)', box2 && Math.abs(mm(box2[1]) - 297) < 1 && Math.abs(mm(box2[2]) - 210) < 1, JSON.stringify(box2?.slice(1)));
    // 만든 PDF 를 그림으로 보고 (점검 사람이 확인)
    for (const [f, name] of [[file, 'smoke-new-pdf-169-file.png'], [a4file, 'smoke-new-pdf-a4-file.png']]) {
      if (!fs.existsSync(f)) continue;
      const v = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { plugins: true } });
      await v.loadURL(`file:///${f.replace(/\\/g, '/')}`).catch(() => {});
      await wait(2500);
      fs.writeFileSync(path.join(OUT, name), (await v.webContents.capturePage()).toPNG());
      v.destroy();
    }

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  } finally {
    watcher?.stop();
    for (const w of popups) if (!w.isDestroyed()) w.destroy();
  }

  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `바뀐 기능 점검 통과 (${checks.length}개)` : '바뀐 기능 점검 실패');
  app.exit(exitCode);
}
