// 바뀐 기능만 확인하는 짧은 점검 (npm run smoke:new) — 전체 점검(npm run smoke)은 요청할 때만.
// 버전마다 아래 "이번 버전" 부분을 새 기능에 맞게 바꾼다. 임시 폴더(%TEMP%\memoking-smoke)만 쓴다.
// 이번 버전: v0.17.0 — 팝업 알림 모으기(UI 자동화·글자 인식) · 메모를 PDF로 · 고친 때 스탬프는 카드 사이 틈에
//            v0.17.1 — 창이 작아도 스탬프가 카드(요약)와 겹치지 않음 · 카카오톡 알림은 설정 없이 늘 · 선택한 내용 자동 영역 캡처
//            v0.17.2 — 화면 밖까지 선택하면 스크롤하며 캡처해 이어 붙이기 · 표 머리글 강조는 고를 때만, 열 너비·행 높이 끌기 · Ctrl+휠 본문 확대
// (팝업은 점검 앱 자신이 띄운 가짜 알림 창만 지켜본다 — 사용자의 카카오톡 등은 건드리지 않음)
import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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

// PDF 의 글자 확인: 들어 있는 글꼴 이름, 글자 표(ToUnicode)로 고를 수 있는 글자들
// (글꼴 정보·글자 표가 압축된 스트림에 있을 수 있어 풀어서 함께 본다. 가변 글꼴(Pretendard)은 Type3 글자 모양으로 들어가 /FontFile 이 없을 수 있다)
function pdfText(buf) {
  const raw = buf.toString('latin1');
  const parts = [raw];
  for (const m of raw.matchAll(/(?<!end)stream\r?\n/g)) {
    const from = m.index + m[0].length;
    const to = raw.indexOf('endstream', from);
    if (to < 0) continue;
    try {
      parts.push(zlib.inflateSync(buf.subarray(from, to)).toString('latin1'));
    } catch {
      // 압축되지 않았거나 그림 등
    }
  }
  const all = parts.join('\n');
  const fonts = [...all.matchAll(/\/(?:BaseFont|FontName)\s*\/([^\s/<>\[\]()]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, ''));
  const chars = new Set();
  const hex = (h) => parseInt(h, 16);
  const unit = (h) => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map(hex));
  for (const [, body] of all.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, , dst] of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) chars.add(unit(dst));
  }
  for (const [, body] of all.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst, list] of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      if (list) for (const [, d] of list.matchAll(/<([0-9a-fA-F]+)>/g)) chars.add(unit(d));
      else for (let i = 0; i <= hex(hi) - hex(lo); i++) chars.add(String.fromCodePoint(hex(dst) + i));
    }
  }
  return { fonts, chars };
}

// PNG 파일의 가로·세로 (IHDR)
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export async function runSmoke({ noteWins, getVault, createListWindow, getList, createPopupWatcher, getHistory, smokePdf, getPdfWin, startAreaCapture, getAreaCapture, findSelectionRect, smokeToastsList, smokeClipboard, scrollingCapture }) {
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

    // 2) 팝업 알림 지켜보기 — 따로 켜는 설정 없이 알림 모아두기와 함께 늘
    await lj(`document.getElementById('settings-btn').click()`);
    await wait(200);
    await lj(`document.getElementById('history-enabled').click()`);
    await until(() => lj(`document.getElementById('history-enabled').checked`), '알림 모으기 켬');
    const noSwitch = await lj(`!document.getElementById('popup-watch') && /카카오톡/.test(document.getElementById('history-enabled').closest('label').textContent)`);
    await capture(getList(), 'smoke-new-settings-popup.png');
    await lj(`document.getElementById('settings-dialog').close()`);
    check('설정: "카카오톡 알림도 모으기" 스위치 없이, 알림 모아두기 설명에 카카오톡도 함께 모은다고', noSwitch);

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
    // 글자: 한글 글꼴이 PDF 에 들어 있고, 그림이 아니라 고를 수 있는 글자(글자 표에 제목·본문·표의 한글이 모두 있음)
    const text = fs.existsSync(file) ? pdfText(fs.readFileSync(file)) : { fonts: [], chars: new Set() };
    const want = [...'분기회의록참석김대리박과장항목담당예산일정논의한내용'];
    const missing = want.filter((c) => !text.chars.has(c));
    check('PDF 글자: 한글 글꼴(Pretendard)로, 제목·본문·표의 한글을 글자로 고를 수 있음', text.fonts.some((f) => /pretendard/i.test(f)) && missing.length === 0, JSON.stringify({ fonts: [...new Set(text.fonts)], missing: missing.join('') }));
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

    // 4) v0.17.1: 목록 창을 가장 작게 줄여도 고친 때 스탬프가 카드(요약)와 겹치지 않음 — 메모가 8개 이하라 칸을 나눠 채울 때
    for (let i = 0; i < 5; i++) {
      const m = vault.create();
      vault.save(m, `# 겹침 점검 ${i + 1}\n\n요약 글이 여러 줄로 길게 이어지는 메모예요. 창을 작게 줄였을 때 스탬프가 이 글 위에 겹치지 않는지 봐요. 한 줄 더 이어지는 글이에요.`);
    }
    await until(() => lj(`document.querySelectorAll('#cards .card').length >= 7`), '카드 7개', 10000);
    const overlapAt = async (w, h) => {
      getList().setSize(w, h);
      await wait(600);
      return lj(`(() => {
        const cards = [...document.querySelectorAll('#cards .card')].map((c) => c.getBoundingClientRect());
        const hits = [];
        for (const s of document.querySelectorAll('#cards .card-stamp')) {
          const r = s.getBoundingClientRect();
          cards.forEach((c, i) => { if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) hits.push([s.textContent, i]); });
        }
        const ul = document.getElementById('cards');
        return { hits, density: ul.dataset.density, scroll: ul.scrollHeight > ul.clientHeight };
      })()`);
    };
    const small = await overlapAt(300, 380); // 목록 창의 가장 작은 크기
    await capture(getList(), 'smoke-new-stamps-small.png');
    const mid = await overlapAt(340, 520);
    check('목록 창을 가장 작게(300×380) 줄여도 스탬프가 카드·요약과 겹치지 않음 (대신 목록이 스크롤)', small.hits.length === 0 && mid.hits.length === 0, JSON.stringify({ small, mid }));
    getList().setSize(400, 680);

    // 5) v0.17.1: 드래그로 선택한 내용 → 그 영역을 자동으로 캡처 (테두리·반짝·찰칵 뒤 새 메모)
    const sample = new BrowserWindow({ width: 640, height: 420, x: 120, y: 120, show: true, title: '선택 캡처 점검', webPreferences: { sandbox: true } });
    await sample.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>선택 캡처 점검</title><body style="margin:0;padding:40px;font:18px/1.6 'Malgun Gothic';background:#fff">
      <p>선택하지 않은 첫 문단이에요.</p><p id="pick">이 문단을 드래그로 선택했어요. 선택한 글이 모두 캡처에 들어가야 해요. 두 번째 줄까지 이어지는 긴 문장이에요.</p><p>선택하지 않은 마지막 문단이에요.</p></body>`)}`);
    sample.focus();
    await wait(400);
    const pick = await js(sample, `(() => { const el = document.getElementById('pick'); const r = document.createRange(); r.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
    const cb = sample.getContentBounds();
    const expected = { x: cb.x + pick.x, y: cb.y + pick.y, width: pick.width, height: pick.height };
    // (가) UI 자동화로 앞 창의 선택 위치 읽기 (실제 Windows · 점검 앱 자신의 창)
    const selFound = await findSelectionRect();
    const near = selFound && Math.abs(selFound.x - expected.x) < 16 && Math.abs(selFound.y - expected.y) < 16
      && Math.abs(selFound.x + selFound.width - (expected.x + expected.width)) < 16 && Math.abs(selFound.y + selFound.height - (expected.y + expected.height)) < 16;
    check('Ctrl+Alt+C 두 번: 앞 창에서 드래그로 선택한 글의 화면 위치를 UI 자동화로 읽음', near, JSON.stringify({ found: selFound, expected }));
    // (나) 그 사각형으로 자동 캡처 → 오버레이에 테두리·반짝 → 클립보드·새 메모 (UI 자동화 결과와 상관없이 정해진 사각형으로)
    const toasts0 = smokeToastsList.length;
    const clips0 = smokeClipboard.length;
    await startAreaCapture({ show: false, auto: { ...expected, window: '선택 캡처 점검', process: 'electron' } });
    const overlay = getAreaCapture()?.wins[0];
    const autoLook = overlay ? await until(() => js(overlay, `document.body.classList.contains('auto') && document.getElementById('sel').classList.contains('auto') && !document.getElementById('sel').hidden && document.getElementById('hint').textContent`), '자동 테두리', 8000).catch(() => null) : null;
    const flashed = overlay ? await until(() => !overlay.isDestroyed() && js(overlay, `document.getElementById('sel').classList.contains('flash')`), '반짝', 4000).catch(() => false) : false;
    const t = await until(() => smokeToastsList.slice(toasts0).find((x) => /선택한 내용을 캡처/.test(x.title)), '자동 캡처 메모', 10000).catch(() => null);
    const clip = smokeClipboard[clips0];
    const size = clip && fs.existsSync(clip) ? pngSize(clip) : null;
    const scale = screen.getDisplayMatching(expected).scaleFactor;
    const wantW = Math.round((expected.width + 16) * scale);
    const wantH = Math.round((expected.height + 16) * scale);
    check('선택한 내용 자동 캡처: 고르지 않고 테두리 → 반짝 뒤 바로 캡처, "선택한 내용을 캡처해 메모를 만들었어요"', autoLook && flashed && t, JSON.stringify({ autoLook, flashed, toast: t?.title }));
    check('자동 캡처 그림 = 선택한 내용 + 둘레 여백 8px (원래 해상도)', size && Math.abs(size.width - wantW) <= 3 * scale && Math.abs(size.height - wantH) <= 3 * scale, JSON.stringify({ size, want: [wantW, wantH] }));
    sample.destroy();

    // 6) v0.17.2: 화면 밖까지 이어지는 선택 → 스크롤하며 여러 장 찍어 이어 붙이기
    const longWin = new BrowserWindow({ width: 560, height: 420, x: 140, y: 100, show: true, title: '스크롤 캡처 점검', webPreferences: { sandbox: true } });
    const paras = Array.from({ length: 40 }, (_, i) => `<p id="p${i}">${i + 1}번째 문단이에요. 스크롤 캡처로 이어 붙인 그림에 이 문단이 빠짐없이 들어가야 해요.</p>`).join('');
    await longWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>스크롤 캡처 점검</title><body style="margin:0;padding:24px 32px;font:17px/1.7 'Malgun Gothic';background:#fff">${paras}</body>`)}`);
    longWin.focus();
    await wait(400);
    const span = await js(longWin, `(() => { const a = document.getElementById('p3'), b = document.getElementById('p30'); const r = document.createRange(); r.setStartBefore(a.firstChild); r.setEndAfter(b.firstChild);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); window.scrollTo(0, 0);
      return { top: a.getBoundingClientRect().top + scrollY, bottom: b.getBoundingClientRect().bottom + scrollY, view: innerHeight }; })()`);
    const longSel = await findSelectionRect();
    check('화면 밖(아래)까지 이어진 선택을 알아챔 (보이는 영역도)', longSel?.more && longSel.viewPx?.height > 100, JSON.stringify(longSel));
    const tScroll = smokeToastsList.length;
    const cScroll = smokeClipboard.length;
    if (longSel?.more) await scrollingCapture(longSel);
    const scrollToast = smokeToastsList.slice(tScroll).find((x) => /선택한 내용을 캡처/.test(x.title));
    const scrollClip = smokeClipboard[cScroll];
    const scrollSize = scrollClip && fs.existsSync(scrollClip) ? pngSize(scrollClip) : null;
    const lScale = screen.getDisplayMatching(longWin.getBounds()).scaleFactor;
    const wantScrollH = Math.round((span.bottom - span.top + 16) * lScale);
    const scrolledBack = await js(longWin, 'scrollY');
    check('스크롤하며 여러 장을 찍어 이어 붙임 → 선택한 4~31번째 문단이 모두 든 한 장 (+여백), "N장을 이어 붙인"', scrollToast && /장을 이어 붙인/.test(scrollToast.body) && scrollSize && Math.abs(scrollSize.height - wantScrollH) <= 30 * lScale && scrollSize.height > span.view * lScale * 1.5,
      JSON.stringify({ toast: scrollToast?.body, size: scrollSize, want: wantScrollH, view: span.view }));
    check('스크롤 캡처가 끝나면 원래 스크롤 자리로 (맨 위)', scrolledBack < 5, String(scrolledBack));
    if (scrollClip && fs.existsSync(scrollClip)) fs.copyFileSync(scrollClip, path.join(OUT, 'smoke-new-scroll-capture.png'));
    longWin.destroy();

    // 7) v0.17.2: 표 — 머리글 바탕은 "머리글 강조"를 켰을 때만, 열 너비·행 높이를 끌어서 바꾸고 다시 열어도 그대로
    const tableMemo = vault.create();
    vault.save(tableMemo, '# 표 크기 점검\n\n| 항목 | 담당 | 메모 |\n| --- | --- | --- |\n| 예산 | 김대리 | 첫째 |\n| 일정 | 박과장 | 둘째 |\n');
    await lj(`window.memoking.memo.open(${JSON.stringify(tableMemo)})`);
    let tw = await until(() => noteWins.get(tableMemo), '표 메모 창');
    await ready(tw);
    tw.focus();
    const tj = (code) => js(tw, code);
    const send = (type, x, y) => tw.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    async function dragBy(x, y, dx, dy) {
      send('mouseMove', x - 12, y - 12);
      await wait(60);
      send('mouseMove', x, y);
      await wait(120);
      send('mouseDown', x, y);
      for (let i = 1; i <= 6; i++) {
        send('mouseMove', x + (dx * i) / 6, y + (dy * i) / 6);
        await wait(40);
      }
      send('mouseUp', x + dx, y + dy);
      await wait(300);
    }
    const look = () => tj(`(() => ({
      cols: [...document.querySelectorAll('.mk-doc tr:first-child > *')].map((c) => Math.round(c.getBoundingClientRect().width)),
      rows: [...document.querySelectorAll('.mk-doc tr')].map((r) => Math.round(r.getBoundingClientRect().height)),
      thBg: getComputedStyle(document.querySelector('.mk-doc th')).backgroundColor,
    }))()`);
    const t0 = await look();
    check('표 머리글 행은 기본으로 다른 칸과 같은 바탕 (색을 따로 칠하지 않음)', /rgba\(0, 0, 0, 0\)|transparent/.test(t0.thBg), t0.thBg);
    const colEdge = await tj(`(() => { const r = document.querySelector('.mk-doc th').getBoundingClientRect(); return { x: r.right - 1, y: r.top + r.height / 2 }; })()`);
    await dragBy(colEdge.x, colEdge.y, 70, 0);
    const rowEdge = await tj(`(() => { const r = document.querySelectorAll('.mk-doc tr')[1].children[1].getBoundingClientRect(); return { x: r.left + 20, y: r.bottom - 2 }; })()`);
    await dragBy(rowEdge.x, rowEdge.y, 0, 40);
    await tj(`(() => { document.querySelector('.mk-doc').focus(); const td = document.querySelector('.mk-doc td'); const r = document.createRange(); r.setStart(td.querySelector('p')?.firstChild ?? td, 1); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await wait(200);
    await until(() => tj(`!document.getElementById('table-bar').hidden`), '표 막대');
    await tj(`document.querySelector('[data-table="accent"]').click()`);
    await wait(900); // 머리말 저장 (0.4초 모아서)
    const t1 = await look();
    const savedTables = vault.get(tableMemo)?.tables;
    check('표: 첫 열 오른쪽 테두리를 끌면 넓어지고, 둘째 행 아래 테두리를 끌면 높아지고, "머리글 강조"를 켜면 머리글 바탕이 칠해짐',
      t1.cols[0] >= t0.cols[0] + 50 && t1.rows[1] >= t0.rows[1] + 30 && !/rgba\(0, 0, 0, 0\)/.test(t1.thBg), JSON.stringify({ t0, t1 }));
    check('표 크기·머리글 강조는 메모 머리말(tables)에 저장', savedTables?.[0]?.cols?.length === 3 && savedTables[0].rows?.[1] > 0 && savedTables[0].accent === true, JSON.stringify(savedTables));
    await capture(tw, 'smoke-new-table-sized.png');
    tw.close();
    await until(() => !noteWins.get(tableMemo), '표 메모 닫힘');
    await lj(`window.memoking.memo.open(${JSON.stringify(tableMemo)})`);
    tw = await until(() => noteWins.get(tableMemo), '표 메모 다시 열기');
    await ready(tw);
    await wait(300);
    const t2 = await look();
    check('표 메모를 닫았다 다시 열어도 열 너비·행 높이·머리글 강조가 그대로', Math.abs(t2.cols[0] - t1.cols[0]) <= 2 && Math.abs(t2.rows[1] - t1.rows[1]) <= 2 && t2.thBg === t1.thBg, JSON.stringify({ t1, t2 }));
    const mdAfter = vault.get(tableMemo)?.body ?? '';
    check('표 본문(마크다운)은 그대로 (크기는 머리말에만)', /\| 예산 \| 김대리 \| 첫째 \|/.test(mdAfter.replace(/ +/g, ' ')), mdAfter);

    // 8) v0.17.2: 메모 안에서 Ctrl+마우스 휠 → 본문만 확대·축소 (창 전체 확대는 아님), 배율은 메모마다 기억
    const docBox = await tj(`(() => { const r = document.querySelector('.mk-doc').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 30, h: document.querySelector('.mk-doc h1').getBoundingClientRect().height }; })()`);
    for (let i = 0; i < 2; i++) {
      tw.webContents.sendInputEvent({ type: 'mouseWheel', x: docBox.x, y: docBox.y, deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true, modifiers: ['control'] });
      await wait(150);
    }
    const z1 = await tj(`({ zoom: Number(getComputedStyle(document.getElementById('editor')).getPropertyValue('--note-zoom')), h: document.querySelector('.mk-doc h1').getBoundingClientRect().height, bar: document.querySelector('.bar').getBoundingClientRect().height, badge: document.querySelector('.zoom-badge')?.textContent })`);
    const pageZoom = tw.webContents.getZoomFactor();
    check('Ctrl+휠 두 칸 → 본문 글·표가 함께 확대(또는 축소)되고 위 막대 크기는 그대로, 창 전체(Chromium) 확대는 안 됨',
      z1.zoom && z1.zoom !== 1 && Math.abs(z1.h / docBox.h - z1.zoom) < 0.08 && pageZoom === 1 && /확대 \d+%/.test(z1.badge ?? ''), JSON.stringify({ z1, docH: docBox.h, pageZoom }));
    tw.close();
    await until(() => !noteWins.get(tableMemo), '닫힘');
    await lj(`window.memoking.memo.open(${JSON.stringify(tableMemo)})`);
    tw = await until(() => noteWins.get(tableMemo), '다시 열기');
    await ready(tw);
    const z2 = await js(tw, `Number(getComputedStyle(document.getElementById('editor')).getPropertyValue('--note-zoom'))`);
    check('메모를 다시 열어도 그 메모의 확대 배율 그대로', z2 === z1.zoom, JSON.stringify({ z1: z1.zoom, z2 }));
    await js(tw, `document.querySelector('.zoom-badge button').click()`).catch(() => {});
    tw.close();
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
