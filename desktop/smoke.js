// 자동 점검 (npm run smoke) — 실제 앱을 띄워 사용자처럼 조작하고 결과 파일을 확인한다.
// 실제 설정·메모는 건드리지 않고 임시 폴더(%TEMP%\memoking-smoke)만 쓴다.
import { app, BrowserWindow, globalShortcut, nativeTheme, screen } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { dropBounds, DEFAULT_NOTE_SIZE } from './placement.js';
import { TUTORIAL_STEPS } from '../app/js/core/tutorial.js';
import { lockBody } from '../app/js/core/memo-lock.js';

const ICON_PNG = path.join(import.meta.dirname, '..', 'assets', 'icons', 'icon-256.png');

// 인터넷 없이 "웹 사진 붙여넣기"를 확인하기 위한 작은 웹 서버 (127.0.0.1 에서만)
function startImageServer() {
  const png = fs.readFileSync(ICON_PNG);
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/cat.png' || url === '/lazy.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
    } else if (url === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>그림이 아닌 페이지</h1>');
    } else if (url === '/article.html') {
      // 링크 미리보기 카드용 페이지 (v0.10.0)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>그냥 제목</title>
        <meta property="og:title" content="메모킹 기사 제목">
        <meta property="og:description" content="링크를 붙여넣으면 이렇게 미리 보여요">
        <meta property="og:image" content="/cat.png">
        <meta property="og:site_name" content="메모킹 뉴스">
        <link rel="icon" href="/cat.png" sizes="32x32"></head><body>본문</body></html>`);
    } else if (url === '/euckr.html') {
      // 한글 옛 인코딩(EUC-KR) 페이지: 제목 "한글"
      res.writeHead(200, { 'Content-Type': 'text/html; charset=euc-kr' });
      res.end(Buffer.concat([Buffer.from('<html><head><title>'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('</title></head></html>')]));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const SMOKE_DIR = path.join(os.tmpdir(), 'memoking-smoke');
const VAULT = path.join(SMOKE_DIR, 'vault');
// 설치판(asar 안)에서는 프로젝트 폴더에 쓸 수 없으므로 임시 폴더에 캡처
const OUT = app.isPackaged ? path.join(SMOKE_DIR, 'out') : path.join(import.meta.dirname, '..', 'out');
const WPN = path.join(SMOKE_DIR, 'wpn');

// Windows 알림 DB(wpndatabase.db) 와 같은 구조의 가짜 DB — 알림 보관함 점검용
const fileTime = (date) => (BigInt(date.getTime()) + 11644473600000n) * 10000n;
let wpnSeq = 0;
export function addFakeNotification(appId, title, body, date = new Date(), image = '') {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(path.join(WPN, 'wpndatabase.db'));
  try {
    let handler = db.prepare('select RecordId from NotificationHandler where PrimaryId = ?').get(appId)?.RecordId;
    if (!handler) handler = Number(db.prepare('insert into NotificationHandler (PrimaryId) values (?)').run(appId).lastInsertRowid);
    const xml = `<toast><visual><binding template="ToastGeneric">${image ? `<image src="${image}"/>` : ''}<text>${title}</text><text>${body}</text></binding></visual></toast>`;
    db.prepare('insert into Notification (Id, HandlerId, Type, Payload, ArrivalTime) values (?, ?, ?, ?, ?)')
      .run(++wpnSeq, handler, 'toast', Buffer.from(xml), fileTime(date));
  } finally {
    db.close();
  }
}

function prepareFakeNotifications() {
  fs.mkdirSync(WPN, { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(path.join(WPN, 'wpndatabase.db'));
  db.exec(`create table NotificationHandler (RecordId integer primary key, PrimaryId text);
           create table Notification ("Order" integer primary key, Id integer, HandlerId integer, Type text, Payload blob, ArrivalTime integer)`);
  db.close();
  const avatar = path.join(WPN, 'avatar.png');
  fs.copyFileSync(ICON_PNG, avatar);
  addFakeNotification('com.example.chat', '김대리', '회의 자료 보냈어요', new Date(Date.now() - 60 * 60 * 1000), avatar);
  addFakeNotification('com.example.mail', '분기 보고서', '마감이 내일입니다', new Date(Date.now() - 30 * 60 * 1000));
}

export function prepareSmoke(userData) {
  fs.mkdirSync(userData, { recursive: true });
  prepareFakeNotifications();
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ vaultPath: VAULT }));
  // v0.1.0 데이터 옮기기 확인용
  fs.writeFileSync(path.join(userData, 'memos.json'), JSON.stringify({
    version: 1,
    memos: [{ id: 'old', title: '옛 메모', body: 'v0.1.0 에서 쓴 메모', pinned: true, createdAt: 1790000000000, updatedAt: 1790000000000 }],
  }));
}

// 캔버스로 그림 파일, 사인파로 음성 파일을 만들어 편집기에 "붙여넣기" 한다.
const PASTE_IMAGE = `(async () => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 150;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 320, 150);
  grad.addColorStop(0, '#f6c343'); grad.addColorStop(1, '#e2559b');
  g.fillStyle = grad; g.fillRect(0, 0, 320, 150);
  g.fillStyle = '#fff'; g.font = 'bold 26px sans-serif'; g.fillText('메모킹 사진', 90, 85);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], '장바구니.png', { type: 'image/png' }));
  document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`;

const PASTE_AUDIO = `(() => {
  const rate = 8000, n = rate / 2, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 440) * 8000, true);
  const dt = new DataTransfer();
  dt.items.add(new File([buf], '음성 메모.wav', { type: 'audio/wav' }));
  document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`;

// 캔버스를 1초 녹화해 동영상(webm) 파일을 만들어 붙여넣는다.
const PASTE_VIDEO = `(async () => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  // 문서에 붙어 있어야 프레임이 그려져 녹화된다 (화면 밖에 둠)
  Object.assign(c.style, { position: 'fixed', left: '-400px', top: '0' });
  document.body.append(c);
  const g = c.getContext('2d');
  let t = 0;
  const draw = () => {
    g.fillStyle = 'hsl(' + (t * 25) + ', 70%, 55%)'; g.fillRect(0, 0, 320, 180);
    g.fillStyle = '#fff'; g.font = 'bold 26px sans-serif'; g.fillText('메모킹 영상 ' + t, 70, 100); t++;
  };
  // 창이 가려져 있으면 프레임이 안 그려져 빈 영상이 나올 수 있어, 충분한 크기가 나올 때까지 다시 녹화
  let blob = null;
  for (let attempt = 0; attempt < 4 && !(blob && blob.size > 5000); attempt++) {
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    draw();
    const timer = setInterval(draw, 60);
    rec.start(100);
    await new Promise((r) => setTimeout(r, 1200));
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.stop();
    await stopped;
    clearInterval(timer);
    blob = new Blob(chunks, { type: 'video/webm' });
  }
  c.remove();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], '데모 영상.webm', { type: 'video/webm' }));
  document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`;

const PASTE_FILE = `(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['회의 안건\\n1. 예산'], '회의자료.txt', { type: 'text/plain' }));
  document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`;

export async function runSmoke({
  getList, noteWins, getVault, createListWindow, getGhost, getTray, getTrayMenu, alarms, smokeToasts, getHistory, appSettings,
  quickMemo, registerQuickMemoKey, getCapturePoint, smokeOpened = [], smokeConfirmAnswers = [],
  getStacks, trackWindowDrag, endWindowDrag, startTutorial, getTutorial, stickers, getSettings,
}) {
  const errors = [];
  let imageServer = null;
  const checks = [];
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
        const value = await fn();
        if (value) return value;
      } catch {
        // 아직 준비 안 됨
      }
      await wait(100);
    }
    throw new Error(`시간 초과: ${label}`);
  }
  const ready = (win) => until(() => js(win, 'document.documentElement.dataset.ready === "true"'), '화면 준비');
  async function key(win, keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(80);
  }
  async function type(win, text) {
    win.webContents.insertText(text);
    await wait(80);
  }
  async function newNote(action) {
    const before = new Set(noteWins.keys());
    await action();
    const id = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), '새 메모 창');
    const win = noteWins.get(id);
    await ready(win);
    win.focus();
    win.webContents.focus();
    return { id, win };
  }
  async function closeNote(id) {
    const win = noteWins.get(id);
    await js(win, `document.getElementById('close-btn').click()`);
    await until(() => !noteWins.has(id), '메모 창 닫힘');
  }
  async function capture(win, name) {
    await wait(500);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), image.toPNG());
  }
  const readMemo = (id) => fs.readFileSync(path.join(VAULT, getVault().get(id).file), 'utf8');

  let exitCode = 1;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const list = createListWindow();
    await ready(list);
    const vault = getVault();

    // 1) v0.1.0 데이터 옮기기
    const old = vault.list().find((m) => m.title === '옛 메모');
    check('v0.1.0 메모를 md 파일로 옮김', old && old.pinned, old?.file);

    // 2) 새 메모: 제목·굵게·체크리스트를 단축키로
    const n1 = await newNote(() => js(list, `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
    await type(n1.win, '장보기 목록');
    await key(n1.win, '1', ['control']);
    await key(n1.win, 'Enter');
    await type(n1.win, '우유와 ');
    await key(n1.win, 'B', ['control']);
    await type(n1.win, '계란');
    await key(n1.win, 'B', ['control']);
    await type(n1.win, ' 한 판');
    await key(n1.win, 'Enter');
    // 밑줄(Ctrl+U) · 글자 색(색판에서 빨강) · 하이라이트(Ctrl+Shift+H) — 글자를 쓰고 두 글자씩 선택해 적용 (v0.6.0)
    await type(n1.win, '밑줄 빨강 형광');
    const select2 = async () => {
      await key(n1.win, 'Right', ['shift']);
      await key(n1.win, 'Right', ['shift']);
    };
    await key(n1.win, 'Home');
    await select2();
    await key(n1.win, 'U', ['control']);
    await key(n1.win, 'Right');
    await key(n1.win, 'Right');
    await select2();
    await js(n1.win, `document.querySelector('[data-action="color"]').click()`);
    await until(() => js(n1.win, `!document.getElementById('palette').hidden`), '색판 열림');
    await capture(n1.win, 'smoke-palette.png');
    const swatchFit = await js(n1.win, `(() => {
      const box = document.getElementById('palette').getBoundingClientRect();
      return [...document.querySelectorAll('#palette .palette-swatch')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5; });
    })()`);
    check('글자 색 판: 색 칩이 판 밖으로 넘치지 않음', swatchFit);
    await js(n1.win, `document.querySelector('#palette [data-color="#e03131"]').click()`);
    // 판에서 지금 칠해진 색을 다시 고르면 지워지고, 한 번 더 고르면 다시 칠해진다
    const redNow = () => js(n1.win, `[...document.querySelectorAll('.mk-doc span[data-mk-color]')].some((s) => s.textContent.includes('빨강'))`);
    const redOn = await redNow();
    await js(n1.win, `document.querySelector('[data-action="color"]').click()`);
    await until(() => js(n1.win, `!document.getElementById('palette').hidden`), '색판 열림');
    const marked = await js(n1.win, `document.querySelector('#palette [data-color="#e03131"]').getAttribute('aria-checked')`);
    await js(n1.win, `document.querySelector('#palette [data-color="#e03131"]').click()`);
    const redOff = !(await redNow());
    await js(n1.win, `document.querySelector('[data-action="color"]').click()`);
    await until(() => js(n1.win, `!document.getElementById('palette').hidden`), '색판 열림');
    await js(n1.win, `document.querySelector('#palette [data-color="#e03131"]').click()`);
    check('글자 색: 판에 지금 색 표시 · 같은 색을 다시 고르면 지워짐 · 또 고르면 다시', redOn && marked === 'true' && redOff && (await redNow()), JSON.stringify({ redOn, marked, redOff }));
    await key(n1.win, 'Right');
    await key(n1.win, 'Right');
    await select2();
    await key(n1.win, 'H', ['control', 'shift']);
    const markNow = () => js(n1.win, `[...document.querySelectorAll('.mk-doc mark')].some((m) => m.textContent.includes('형광'))`);
    const hlOn = await markNow();
    await key(n1.win, 'H', ['control', 'shift']);
    const hlOff = !(await markNow());
    await key(n1.win, 'H', ['control', 'shift']);
    check('형광펜: 다시 누르면 지워짐 · 또 누르면 다시', hlOn && hlOff && (await markNow()), JSON.stringify({ hlOn, hlOff }));
    await key(n1.win, 'End');
    await key(n1.win, 'Enter');
    await key(n1.win, '9', ['control', 'shift']);
    await type(n1.win, '사과 사기');
    await key(n1.win, 'Enter');
    await key(n1.win, 'Enter');

    // 3) 파일 넣기: 이미지·소리·동영상·기타 파일 붙여넣기 (커서 자리에 들어가야 함)
    await js(n1.win, PASTE_IMAGE);
    await until(() => js(n1.win, `document.querySelector('.mk-image')?.naturalWidth > 0`), '이미지 표시');
    await js(n1.win, PASTE_AUDIO);
    const audioLoaded = await until(
      () => js(n1.win, `(() => { const a = document.querySelector('.mk-audio audio'); return a && a.readyState >= 1 && a.duration > 0 && !!a.closest('.plyr--audio'); })()`),
      '소리 불러오기',
    ).catch(() => false);
    check('소리 파일 → Plyr 오디오 플레이어로 표시·로드', audioLoaded);
    await js(n1.win, PASTE_VIDEO);
    const videoLoaded = await until(
      () => js(n1.win, `(() => { const v = document.querySelector('.mk-video video'); return v && v.readyState >= 1 && !!v.closest('.plyr--video'); })()`),
      '동영상 불러오기',
      12000,
    ).catch(() => false);
    const videoState = await js(n1.win, `(() => { const v = document.querySelector('.mk-video video'); return v ? { ready: v.readyState, net: v.networkState, err: v.error?.code, msg: v.error?.message, src: v.currentSrc, plyr: !!v.closest('.plyr--video'), w: v.videoWidth } : 'no video element'; })()`);
    check('동영상 파일 → Plyr 비디오 플레이어로 표시·로드', videoLoaded, JSON.stringify(videoState));
    const plyrIcons = await js(n1.win, `(() => { const u = document.querySelector('.plyr use'); const id = (u?.getAttribute('href') ?? '').replace(/^#/, ''); return !!id && !!document.getElementById(id); })()`);
    check('플레이어 아이콘이 인터넷 없이 표시 (문서 안 아이콘 사용)', plyrIcons);
    await js(n1.win, PASTE_FILE);
    const chip = await until(() => js(n1.win, `document.querySelector('.mk-doc a[href^="attachments/"]')?.textContent`), '파일 칩').catch(() => null);
    check('그 밖의 파일 → 파일 칩', chip === '회의자료.txt', chip);
    await capture(n1.win, 'smoke-note.png');

    // 4) 닫으면 저장 + 파일명 = 제목
    await closeNote(n1.id);
    const file1 = vault.get(n1.id)?.file;
    check('닫을 때 저장, 파일명 = 제목', file1 === '장보기 목록.md', file1);
    const md1 = readMemo(n1.id);
    check('제목(Ctrl+1) → "# "', md1.includes('# 장보기 목록'), md1);
    check('굵게(Ctrl+B) → "**"', md1.includes('**계란**'));
    check('체크리스트(Ctrl+Shift+9) → "- [ ]"', md1.includes('- [ ] 사과 사기'), md1);
    check('밑줄(Ctrl+U) → "<u>"', md1.includes('<u>밑줄</u>'));
    check('글자 색(색판) → <span style="color">', md1.includes('<span style="color: #e03131">빨강</span>'));
    check('하이라이트(Ctrl+Shift+H) → "<mark>"', md1.includes('<mark>형광</mark>'));
    const attachments = [...md1.matchAll(/!?\[[^\]]*\]\((attachments\/[^)]+)\)/g)].map((m) => m[1]);
    check('이미지·소리·동영상·파일이 attachments 폴더에 저장되고 md 로 참조됨',
      attachments.length === 4 && attachments.every((a) => fs.existsSync(path.join(VAULT, a)))
        && md1.includes('![동영상 데모 영상](attachments/') && md1.includes('[회의자료.txt](attachments/'),
      attachments.join(', '));

    // 5) 두 번째 메모 + 연결 패널에서 검색해 연결
    const n2 = await newNote(() => js(list, `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
    await type(n2.win, '마트 영수증');
    await key(n2.win, 'Enter');
    await type(n2.win, '우유와 계란을 샀다');
    await key(n2.win, 'K', ['control']);
    await until(() => js(n2.win, `!document.getElementById('links-panel').hidden`), '연결 패널');
    await type(n2.win, '장보기');
    await until(() => js(n2.win, `document.querySelectorAll('#link-results .link-item').length > 0`), '연결 검색 결과');
    await js(n2.win, `document.querySelector('#link-results .link-item .icon-btn').click()`);
    await until(() => vault.get(n2.id)?.links.includes(n1.id), '연결 저장');
    check('연결 패널에서 검색해 연결', true);
    await capture(n2.win, 'smoke-links.png');

    // 6) 입력 직후 바로 닫아도 저장
    await key(n2.win, 'Escape');
    await key(n2.win, 'Enter');
    await type(n2.win, '닫기 직전 입력');
    await closeNote(n2.id);
    check('입력 직후 닫아도 저장', readMemo(n2.id).includes('닫기 직전 입력'));

    // 7) LLM 용 index.json
    const indexFile = path.join(VAULT, '_memoking', 'index.json');
    const index = await until(() => {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const e2 = data.memos.find((m) => m.id === n2.id);
      return data.memoCount === 3 && e2?.links.includes(n1.id) ? data : null;
    }, 'index.json 갱신');
    const e1 = index.memos.find((m) => m.id === n1.id);
    check('index.json: 요약·키워드·역연결·관련도', e1.summary.includes('우유') && e1.backlinks.includes(n2.id) && e1.related[0]?.id === n2.id,
      JSON.stringify({ summary: e1.summary, keywords: e1.keywords, related: e1.related[0] }));
    check('에이전트 안내서(_memoking/README.md)', fs.existsSync(path.join(VAULT, '_memoking', 'README.md')));

    // 8) 다른 PC 에서 동기화돼 들어온 파일이 목록에 나타남
    fs.writeFileSync(path.join(VAULT, '다른 PC.md'), '# 다른 PC에서 추가\n동기화 테스트');
    await until(() => js(list, `[...document.querySelectorAll('.card-title')].some((t) => t.textContent === '다른 PC에서 추가')`), '외부 파일 반영');
    check('폴더에 새로 생긴 파일이 목록에 반영', true);

    // 9) 다시 열면 서식이 렌더링되고, 체크박스 클릭이 동작
    const reopened = await newNote(() => js(list, `document.querySelector('.card[data-id="${n1.id}"]').click()`));
    const rendered = await js(reopened.win, `(() => ({
      h1: !!document.querySelector('.mk-doc h1'),
      strong: !!document.querySelector('.mk-doc strong'),
      task: !!document.querySelector('.mk-doc li[data-item-type="task"]'),
      noMarkdownSymbols: !document.querySelector('.mk-doc').textContent.includes('**'),
      img: document.querySelector('.mk-image')?.complete,
      audio: !!document.querySelector('.mk-audio .plyr--audio'),
      video: !!document.querySelector('.mk-video .plyr--video'),
      fileChip: !!document.querySelector('.mk-doc a[href^="attachments/"]'),
      underline: document.querySelector('.mk-doc u')?.textContent === '밑줄',
      color: document.querySelector('.mk-doc span[data-mk-color]')?.style.color === 'rgb(224, 49, 49)',
      highlight: document.querySelector('.mk-doc mark')?.textContent === '형광',
      noHtmlTags: !/<(u|mark|span)/.test(document.querySelector('.mk-doc').textContent),
    }))()`);
    check('다시 열면 서식 렌더링 (기호 안 보임)', Object.values(rendered).every(Boolean), JSON.stringify(rendered));
    const box = await js(reopened.win, `(() => { const r = document.querySelector('.mk-doc li[data-item-type="task"]').getBoundingClientRect(); return { x: Math.round(r.left - 12), y: Math.round(r.top + 11) }; })()`);
    reopened.win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    reopened.win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await until(() => js(reopened.win, `document.querySelector('.mk-doc li[data-item-type="task"]').dataset.checked === 'true'`), '체크 표시').catch(() => {});
    await capture(reopened.win, 'smoke-note-formats.png');

    // 좁은 창에서도 모든 서식 버튼에 접근 가능 (넘치면 » 더보기) (v0.6.0)
    const toolbar = () => js(reopened.win, `(() => {
      const items = document.getElementById('format-items');
      const more = document.getElementById('more-btn');
      const r = more.getBoundingClientRect();
      return {
        fits: items.scrollWidth <= items.clientWidth,
        moreShown: !more.hidden && r.right <= innerWidth && r.width > 0,
        inBar: items.querySelectorAll('button').length,
        inPanel: document.querySelectorAll('#more-panel button').length,
      };
    })()`);
    const wideBounds = reopened.win.getBounds();
    reopened.win.setSize(250, 320);
    await wait(500);
    const narrow = await toolbar();
    await js(reopened.win, `document.getElementById('more-btn').click()`);
    await wait(200);
    const panelShown = await js(reopened.win, `(() => { const p = document.getElementById('more-panel'); const r = p.getBoundingClientRect(); return !p.hidden && r.left >= 0 && r.right <= innerWidth; })()`);
    await capture(reopened.win, 'smoke-toolbar-narrow.png');
    await key(reopened.win, 'Escape');
    // 서식 버튼 11개 (v0.21.0 첨부·표·녹음은 + 콘텐츠 추가 안으로 — 휴대폰과 같음)
    check('좁은 창: 넘친 버튼은 » 더보기로 (11개 모두 접근 가능 — + 콘텐츠 추가 포함)',
      narrow.fits && narrow.moreShown && narrow.inPanel > 0 && narrow.inBar + narrow.inPanel === 11 && panelShown, JSON.stringify({ ...narrow, panelShown }));
    reopened.win.setSize(760, 520);
    await wait(500);
    const wide = await toolbar();
    check('넓은 창: 모든 버튼이 막대에 (더보기 없음)', wide.fits && !wide.moreShown && wide.inBar === 11, JSON.stringify(wide));
    await capture(reopened.win, 'smoke-toolbar-wide.png');
    reopened.win.setBounds(wideBounds);
    await wait(300);

    await capture(list, 'smoke-list.png');
    nativeTheme.themeSource = 'dark';
    await capture(list, 'smoke-list-dark.png');
    await capture(reopened.win, 'smoke-note-dark.png');
    nativeTheme.themeSource = 'system';

    await closeNote(reopened.id);
    check('체크박스 클릭 → "- [x]" 저장', readMemo(n1.id).includes('- [x] 사과 사기'));

    // 10) 항상 위 고정 토글 (v0.3.0)
    const openN1 = () => newNote(() => js(getList(), `document.querySelector('.card[data-id="${n1.id}"]').click()`));
    const pressed = (win) => js(win, `document.getElementById('top-btn').getAttribute('aria-pressed')`);
    const t1 = await openN1();
    check('처음에는 항상 위 꺼짐', !t1.win.isAlwaysOnTop() && (await pressed(t1.win)) === 'false');
    await js(t1.win, `document.getElementById('top-btn').click()`);
    const clickedOn = await until(async () => t1.win.isAlwaysOnTop() && (await pressed(t1.win)) === 'true', '버튼으로 켜기').catch(() => false);
    check('고정 버튼 → 창이 항상 위 + 버튼 켜짐 표시', clickedOn);
    await capture(t1.win, 'smoke-on-top.png');
    // 왕관 스티커가 붙어 있어도 Ctrl+Shift+T 로 뗄 수 있다 (스티커도 함께 사라짐)
    const stuckBefore = !stickers || Boolean(stickers.get(t1.win.id));
    await key(t1.win, 'T', ['control', 'shift']);
    const keyOff = await until(async () => !t1.win.isAlwaysOnTop() && (await pressed(t1.win)) === 'false'
      && (!stickers || !stickers.get(t1.win.id)), '단축키로 끄기').catch(() => false);
    await key(t1.win, 'T', ['control', 'shift']);
    const keyOn = await until(async () => t1.win.isAlwaysOnTop() && (await pressed(t1.win)) === 'true'
      && (!stickers || Boolean(stickers.get(t1.win.id))), '단축키로 켜기').catch(() => false);
    check('Ctrl+Shift+T 로 끄고 켜기 (붙은 왕관 스티커도 떼고 다시 붙음)', stuckBefore && keyOff && keyOn, JSON.stringify({ stuckBefore, keyOff, keyOn }));
    await closeNote(t1.id);
    const t2 = await openN1();
    check('다시 열어도 항상 위 유지 (창·버튼 모두)', t2.win.isAlwaysOnTop() && (await pressed(t2.win)) === 'true');
    await closeNote(t2.id);

    // 10-1) 압정·"고정" 은 목록 맨 위에 고정에만 · 이전 버전 · 단축키 보기 (v0.27)
    const v1 = await openN1();
    check('메뉴: "목록 맨 위에 고정" (늘 위에 두기와 다른 이름)', /목록 (맨 위에 고정|고정 풀기)/.test(await js(v1.win, `document.querySelector('#pin-toggle span').textContent`)));
    await js(v1.win, `document.getElementById('versions-btn').click()`);
    const versionCount = () => js(v1.win, `document.querySelectorAll('#versions-list .version-item').length`);
    const hasVersions = await until(async () => !(await js(v1.win, `document.getElementById('versions-panel').hidden`)) && (await versionCount()) > 0, '이전 버전 패널').catch(() => false);
    check('메뉴 › 이전 버전 → 고치기 전 내용이 버전으로 보임', hasVersions);
    if (hasVersions) {
      const before = readMemo(v1.id);
      const n = await versionCount();
      await js(v1.win, `document.querySelector('#versions-list .version-restore').click()`);
      const restored = await until(async () => readMemo(v1.id) !== before && (await versionCount()) > n, '되돌리기').catch(() => false);
      check('되돌리기 → 파일이 그 버전으로 · 방금 내용도 버전에 남음', restored);
      await capture(v1.win, 'smoke-versions.png');
    }
    await key(v1.win, 'Escape');
    await key(v1.win, '/', ['control']);
    const sheetOpen = await until(() => js(v1.win, `Boolean(document.querySelector('dialog.shortcut-sheet')?.open)`), '단축키 보기').catch(() => false);
    check('Ctrl+/ → 단축키 한눈에 보기', sheetOpen);
    if (sheetOpen) await capture(v1.win, 'smoke-shortcuts.png');
    await js(v1.win, `document.querySelector('dialog.shortcut-sheet')?.close()`);
    check('메뉴: 다른 메모 창과 합치기 (끌지 않고 스택으로)', await js(v1.win, `Boolean(document.getElementById('join-btn'))`));
    // 키보드로 메뉴: Enter 로 열면 첫 항목에, ↓ 로 다음, Esc 로 닫으면 ⋯ 단추로 돌아옴
    const press = async (win, keyCode, char) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await wait(150);
    };
    await js(v1.win, `document.getElementById('menu-btn').focus()`);
    await press(v1.win, 'Enter', '\r');
    const firstFocused = await js(v1.win, `document.activeElement?.id === 'pin-toggle' && document.getElementById('menu-btn').getAttribute('aria-expanded') === 'true'`);
    await press(v1.win, 'Down');
    const secondFocused = await js(v1.win, `document.activeElement?.id === 'show-list'`);
    await press(v1.win, 'Escape');
    const backToBtn = await js(v1.win, `document.getElementById('menu').hidden && document.activeElement?.id === 'menu-btn'`);
    check('메뉴: 키보드로 열기(첫 항목) · ↓ 다음 · Esc 닫고 ⋯ 로', firstFocused && secondFocused && backToBtn, JSON.stringify([firstFocused, secondFocused, backToBtn]));
    check('알림 종류 칸: 칸마다 radio (화면 읽기에 "4개 중 1번째, 선택됨")', await js(v1.win, `document.querySelectorAll('#rem-kind [role="radio"]').length === 4 && document.querySelectorAll('#rem-kind [tabindex="0"]').length === 1`));
    await closeNote(v1.id);

    // 11) 목록 카드를 끌어 화면에 놓기 (v0.4.0)
    //     실제 마우스 대신 화면 좌표가 담긴 포인터 이벤트를 카드에 보낸다.
    const lb = list.getBounds();
    const area = screen.getDisplayMatching(lb).workArea;
    const pointer = (id, type, sx, sy) => js(list, `(() => {
      const card = document.querySelector('.card[data-id="${id}"]');
      card.dispatchEvent(new PointerEvent('${type}', {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: ${type === 'pointerup' ? 0 : 1},
        clientX: ${sx - lb.x}, clientY: ${sy - lb.y}, screenX: ${sx}, screenY: ${sy},
      }));
    })()`);
    const cardPoint = async (id) => {
      const r = await js(list, `(() => { const r = document.querySelector('.card[data-id="${id}"]').getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + 24) }; })()`);
      return { x: lb.x + r.x, y: lb.y + r.y };
    };
    // 목록 창 오른쪽(자리가 없으면 왼쪽)의 빈 곳
    const dropPoint = (dy = 0) => {
      const right = lb.x + lb.width + 150;
      const x = right + DEFAULT_NOTE_SIZE.width < area.x + area.width ? right : lb.x - 250;
      return { x, y: lb.y + 120 + dy };
    };
    async function dragTo(id, target, { beforeDrop } = {}) {
      const s = await cardPoint(id);
      await pointer(id, 'pointerdown', s.x, s.y);
      await pointer(id, 'pointermove', s.x + 20, s.y + 15);
      await wait(60);
      const inside = await js(list, `({ dragging: document.body.classList.contains('is-dragging'), clone: !!document.querySelector('.drag-clone'), hint: document.getElementById('drag-hint').textContent })`);
      for (let i = 1; i <= 5; i++) {
        await pointer(id, 'pointermove', Math.round(s.x + ((target.x - s.x) * i) / 5), Math.round(s.y + ((target.y - s.y) * i) / 5));
        await wait(50);
      }
      await wait(250);
      const outside = await js(list, `document.body.classList.contains('drag-outside')`);
      if (beforeDrop) await beforeDrop();
      await pointer(id, 'pointerup', target.x, target.y);
      return { inside, outside };
    }

    const drop1 = dropPoint();
    const expected1 = dropBounds(drop1, DEFAULT_NOTE_SIZE, screen.getDisplayNearestPoint(drop1).workArea);
    let ghostShown = false;
    const d1 = await dragTo(n2.id, drop1, {
      beforeDrop: async () => {
        const ghost = getGhost();
        ghostShown = Boolean(ghost?.isVisible());
        await capture(list, 'smoke-drag-list.png');
        if (ghost) await capture(ghost, 'smoke-drag-ghost.png');
      },
    });
    check('끌기 시작: 카드가 들리고 안내 표시', d1.inside.dragging && d1.inside.clone && d1.inside.hint.includes('목록 밖'), JSON.stringify(d1.inside));
    check('목록 밖: 미리보기 창 표시', d1.outside && ghostShown);
    const dropped = await until(() => noteWins.get(n2.id), '놓은 자리에 메모 열림').catch(() => null);
    await wait(300);
    const b1 = dropped?.getBounds();
    check('놓은 자리에 메모 창이 열림', b1 && Math.abs(b1.x - expected1.x) <= 2 && Math.abs(b1.y - expected1.y) <= 2,
      `기대 ${JSON.stringify(expected1)} / 실제 ${JSON.stringify(b1)}`);
    const ghostHidden = await until(() => !getGhost()?.isVisible(), '미리보기 사라짐', 3000).catch(() => false);
    check('열린 뒤 미리보기 창은 사라짐', ghostHidden);
    await until(() => js(list, `!document.querySelector('.drag-clone')`), '복제본 정리').catch(() => {});

    // 목록 안에 다시 놓으면 취소
    const before = noteWins.size;
    const s1 = await cardPoint(n1.id);
    await pointer(n1.id, 'pointerdown', s1.x, s1.y);
    await pointer(n1.id, 'pointermove', s1.x + 40, s1.y + 60);
    await pointer(n1.id, 'pointerup', s1.x + 40, s1.y + 60);
    await wait(500);
    check('목록 안에 놓으면 취소 (창 안 열림)', noteWins.size === before && !noteWins.has(n1.id));

    // 창 밖에서 Esc 로 취소
    const s2 = await cardPoint(n1.id);
    await pointer(n1.id, 'pointerdown', s2.x, s2.y);
    const far = dropPoint(40);
    await pointer(n1.id, 'pointermove', s2.x + 20, s2.y + 10);
    await pointer(n1.id, 'pointermove', far.x, far.y);
    await wait(250);
    list.focus();
    list.webContents.focus();
    await key(list, 'Escape');
    await wait(400);
    check('Esc 로 취소 (창 안 열림, 미리보기 사라짐)', !noteWins.has(n1.id) && !getGhost()?.isVisible());

    // 이미 열린 메모를 끌면 그 창이 새 자리로 이동
    const drop2 = dropPoint(160);
    const expected2 = dropBounds(drop2, DEFAULT_NOTE_SIZE, screen.getDisplayNearestPoint(drop2).workArea);
    await dragTo(n2.id, drop2);
    await wait(500);
    const b2 = noteWins.get(n2.id)?.getBounds();
    check('열린 메모를 끌면 새 자리로 이동', noteWins.size === before && b2 && Math.abs(b2.x - expected2.x) <= 2 && Math.abs(b2.y - expected2.y) <= 2,
      `기대 ${JSON.stringify(expected2)} / 실제 ${JSON.stringify(b2)}`);
    await closeNote(n2.id);

    // 12) 알림 영역(트레이) 아이콘 (v0.5.0)
    const labels = () => getTrayMenu().map((item) => item.label?.trim()).filter(Boolean);
    await wait(300);
    const menu = labels();
    check('트레이 아이콘·메뉴 (목록 열기, 새 메모, 최근 메모, 종료)',
      getTray() && !getTray().isDestroyed() && ['메모 목록 열기', '새 메모', '메모킹 종료'].every((l) => menu.includes(l)) && menu.includes('장보기 목록'),
      menu.join(' | '));

    list.close();
    await until(() => !getList(), '목록 창 닫힘');
    await wait(800); // 예전에는 여기서 앱이 종료됐다
    check('모든 창을 닫아도 앱은 알림 영역에 남음', BrowserWindow.getAllWindows().length === 0 && !getTray().isDestroyed());

    getTray().emit('click');
    const reopenedList = await until(() => getList(), '트레이 클릭 → 목록 창').catch(() => null);
    if (reopenedList) await ready(reopenedList);
    check('트레이 아이콘 클릭 → 목록 창 다시 열림', Boolean(reopenedList));
    if (reopenedList) await capture(reopenedList, 'smoke-list-logo.png');

    const trayNew = await newNote(() => getTrayMenu().find((item) => item.label === '새 메모').click());
    check('트레이 메뉴 "새 메모" → 새 메모 창', Boolean(trayNew.win));
    await closeNote(trayNew.id);

    // 13) 붙여넣은 인터넷 사진을 메모 폴더에 저장 (v0.7.0)
    const { server, base } = await startImageServer();
    imageServer = server;
    const png = fs.readFileSync(ICON_PNG);
    const webNote = await newNote(() => js(getList(), `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
    // 상태 표시는 곧 "저장됨" 으로 바뀌므로 변화 기록에서 안내 문구를 찾는다
    await js(webNote.win, `new MutationObserver(() => (window.__statusLog ??= []).push(document.getElementById('status').textContent))
      .observe(document.getElementById('status'), { childList: true, characterData: true, subtree: true })`);
    webNote.win.webContents.insertText('웹에서 가져온 글');
    // 글이 들어간 뒤에 Enter (먼저 오면 Enter 가 글 넣기에 묻혀 사라질 때가 있다)
    await until(() => js(webNote.win, `document.querySelector('.mk-doc').textContent.includes('웹에서 가져온 글')`), '첫 줄').catch(() => {});
    await key(webNote.win, 'Enter');
    // 키 입력은 비동기라, 새 줄이 생긴 뒤에 붙여넣는다 (안 그러면 붙인 제목이 첫 줄에 합쳐짐)
    await until(() => js(webNote.win, `document.querySelectorAll('.mk-doc > *').length >= 2`), '새 줄').catch(() => {});
    const GIF_1X1 = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    const webHtml = `<h2>웹 기사 제목</h2><p>기사 본문 첫 문단</p>
      <p><img src="${base}/cat.png" alt="고양이" title="고양이"></p>
      <p><img src="${GIF_1X1}" data-src="${base}/lazy.jpg" alt="지연 로딩"></p>
      <p><img src="data:image/png;base64,${png.toString('base64')}" alt="박힌 그림"></p>
      <p><img src="${base}/missing.png" alt="없는 사진"></p>
      <p><img src="${base}/page.html" alt="그림 아님"></p>`;
    await js(webNote.win, `(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', ${JSON.stringify(webHtml)});
      dt.setData('text/plain', '웹 기사 제목 기사 본문 첫 문단');
      document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    const webStatus = await until(async () => {
      const log = await js(webNote.win, 'window.__statusLog ?? []');
      return log.find((t) => /받지 못해|저장했어요/.test(t)) ?? null;
    }, '웹 사진 받기 완료', 15000).catch(async () => `(완료 안내 없음) ${JSON.stringify(await js(webNote.win, 'window.__statusLog ?? []'))}`);
    // 저장은 입력이 멈춘 뒤에 되므로 파일에 글이 들어올 때까지 기다린다 (빌드 앱은 더 느릴 수 있음)
    await until(() => readMemo(webNote.id).includes('기사 본문 첫 문단'), '웹 글 저장', 8000).catch(() => {});
    await wait(900);
    const webMd = readMemo(webNote.id);
    const localOf = (alt) => new RegExp(`!\\[${alt}\\]\\((attachments/[^)\\s]+)\\)`).exec(webMd)?.[1];
    const catFile = localOf('고양이');
    check('웹 글+사진 붙여넣기 → 글은 서식대로', webMd.includes('## 웹 기사 제목') && webMd.includes('기사 본문 첫 문단'),
      JSON.stringify(webMd.slice(0, 400)));
    check('인터넷 사진 → attachments 에 저장 (원본과 같은 파일)',
      Boolean(catFile) && fs.readFileSync(path.join(VAULT, catFile)).equals(png) && !webMd.includes(`${base}/cat.png`), catFile);
    check('지연 로딩 사진 → 진짜 주소(data-src)에서 받아 저장', Boolean(localOf('지연 로딩')), webMd.match(/!\[지연 로딩\][^\n]*/)?.[0]);
    check('글 안에 박힌 data: 사진 → 파일로 풀어서 저장 (메모에 data: 없음)', Boolean(localOf('박힌 그림')) && !webMd.includes('data:image'));
    check('받지 못한 사진(404·그림 아님) → 인터넷 주소 그대로 + 안내',
      webMd.includes(`${base}/missing.png`) && webMd.includes(`${base}/page.html`) && /3개를 저장했어요\. 2개는 받지 못해/.test(webStatus), webStatus);
    check('저장한 사진의 제목(title) 중복 제거', !/!\[고양이\]\([^)]*"고양이"\)/.test(webMd));
    await capture(webNote.win, 'smoke-web-images.png');

    // 마크다운 글 ![](https://…) 붙여넣기도 받아 둔다 → Ctrl+Z 한 번이면 붙여넣기 전체가 취소
    await key(webNote.win, 'End', ['control']);
    await key(webNote.win, 'Enter');
    await js(webNote.win, `(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '![마크다운 사진](${base}/cat.png?from=markdown)');
      document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    const mdLocal = await until(() => /!\[마크다운 사진\]\(attachments\//.test(readMemo(webNote.id)), '마크다운 사진 저장').catch(() => false);
    check('마크다운 글의 인터넷 사진도 저장', mdLocal);
    await key(webNote.win, 'Z', ['control']);
    const undone = await until(() => !readMemo(webNote.id).includes('마크다운 사진'), 'Ctrl+Z').catch(() => false);
    check('Ctrl+Z 한 번 → 붙여넣기 전체 취소 (사진 주소 교체는 따로 남지 않음)', undone && readMemo(webNote.id).includes('기사 본문 첫 문단'));
    // PC: 그림에 마우스를 올리면 지우기 단추(×), 떠나면 거둠 — 누르면 그 그림 줄이 지워진다
    const hoverDel = await js(webNote.win, `(async () => {
      const img = document.querySelector('.mk-doc img.mk-image');
      if (!img) return 'no image';
      const r = img.getBoundingClientRect();
      img.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
      await new Promise((ok) => setTimeout(ok, 50));
      const shown = Boolean(document.querySelector('.mk-delete-btn.hover'));
      document.querySelector('.mk-doc').dispatchEvent(new MouseEvent('mouseleave'));
      await new Promise((ok) => setTimeout(ok, 600));
      return { shown, gone: !document.querySelector('.mk-delete-btn') };
    })()`);
    check('PC: 그림에 마우스를 올리면 지우기 단추 · 마우스가 떠나면 사라짐', hoverDel?.shown && hoverDel?.gone, JSON.stringify(hoverDel));
    const imgCount = () => js(webNote.win, `document.querySelectorAll('.mk-doc img.mk-image').length`);
    const beforeDel = await imgCount();
    await js(webNote.win, `(() => {
      const img = document.querySelector('.mk-doc img.mk-image');
      const r = img.getBoundingClientRect();
      img.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
      document.querySelector('.mk-delete-btn').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    })()`);
    const deleted = await until(async () => (await imgCount()) === beforeDel - 1, '그림 지우기').catch(() => false);
    check('PC: 마우스를 올려 뜬 × 를 누르면 그 그림이 지워짐', deleted, `${beforeDel} → ${await imgCount()}`);
    await closeNote(webNote.id);

    // 13-0) 목록 창에 파일을 끌어다 놓으면 메모로 (.md 는 글 그대로, 그림은 메모 안에)
    {
      const before = new Set(getVault().list().map((m) => m.id));
      await js(getList(), `(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['# 끌어온 회의록\\n\\n- 안건 하나\\n- 안건 둘\\n'], '회의록.md', { type: 'text/markdown' }));
        dt.items.add(new File([Uint8Array.from(atob('${png.toString('base64')}'), (c) => c.charCodeAt(0))], '끌어온 그림.png', { type: 'image/png' }));
        for (const type of ['dragenter', 'dragover']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
        const shade = !document.querySelector('.file-drop').hidden;
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return shade;
      })()`);
      const made = await until(() => {
        const fresh = getVault().list().filter((m) => !before.has(m.id) && m.file);
        return fresh.length >= 2 ? fresh : null;
      }, '끌어다 놓은 파일 → 메모').catch(() => []);
      const bodies = made.map((m) => readMemo(m.id));
      check('목록 창에 파일을 끌어다 놓으면 메모로 (.md 는 글 그대로 · 그림은 파일 이름 제목 + 그림)',
        bodies.some((b) => /# 끌어온 회의록\n\n- 안건 하나\n- 안건 둘/.test(b)) && bodies.some((b) => /# 끌어온 그림\n\n!\[끌어온 그림\.png\]\(attachments\/[^)]+\.png\)/.test(b)),
        JSON.stringify(bodies.map((b) => b.slice(-160))));
      for (const m of made) getVault().trash(m.id); // 뒤 점검의 메모 수에 섞이지 않게
    }

    // 13-1) 링크 미리보기 카드 · 한 번 눌러 열기 (v0.10.0) — 실제 브라우저·프로그램은 띄우지 않고 기록만
    const pasteText = (win, text) => js(win, `(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(text)});
      document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    // CLEAR 도장: 아래 도구막대가 숨었다 나타나도 제자리 (본문 높이가 바뀌어도 움직이지 않음)
    {
      const stampNote = await newNote(() => js(getList(), `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
      await pasteText(stampNote.win, '# 도장\n\n- [x] 하나\n- [x] 둘\n');
      await until(() => js(stampNote.win, `!document.querySelector('.clear-stamp').hidden`), 'CLEAR 도장').catch(() => {});
      const tops = await js(stampNote.win, `(async () => {
        const top = () => Math.round(document.querySelector('.clear-stamp').getBoundingClientRect().top + document.querySelector('.clear-stamp').getBoundingClientRect().height / 2);
        await new Promise((r) => setTimeout(r, 500));
        const shown = top();
        document.body.classList.add('bar-hidden');
        await new Promise((r) => setTimeout(r, 500));
        const hidden = top();
        document.body.classList.remove('bar-hidden');
        await new Promise((r) => setTimeout(r, 500));
        return { visible: !document.querySelector('.clear-stamp').hidden, shown, hidden, back: top() };
      })()`);
      check('CLEAR 도장: 도구막대가 숨었다 나타나도 움직이지 않음', tops.visible && Math.abs(tops.shown - tops.hidden) <= 1 && Math.abs(tops.shown - tops.back) <= 1, JSON.stringify(tops));
      await closeNote(stampNote.id);
    }
    const articleUrl = `${base}/article.html`;
    const linkNote = await newNote(() => js(getList(), `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
    await pasteText(linkNote.win, articleUrl);
    const cardTitle = await until(() => js(linkNote.win, `(() => { const c = document.querySelector('.mk-link-card[data-state="ok"]'); return c && c.querySelector('.lc-title').textContent; })()`), '링크 카드').catch(() => null);
    check('빈 줄에 주소 붙여넣기 → 링크 카드 (사이트 제목)', cardTitle === '메모킹 기사 제목', cardTitle);
    const cardInfo = await js(linkNote.win, `(() => { const c = document.querySelector('.mk-link-card'); return c && { site: c.querySelector('.lc-site-name').textContent, desc: c.querySelector('.lc-desc').textContent, thumb: c.querySelector('.lc-thumb')?.naturalWidth ?? 0, thumbSrc: c.querySelector('.lc-thumb')?.getAttribute('src') ?? '', icon: c.querySelector('.lc-icon')?.naturalWidth ?? 0 }; })()`);
    await until(() => js(linkNote.win, `document.querySelector('.lc-thumb')?.naturalWidth > 0`), '카드 사진').catch(() => {});
    const thumbShown = await js(linkNote.win, `document.querySelector('.lc-thumb')?.naturalWidth > 0`);
    check('카드: 사이트 이름·설명·대표 사진(메모 폴더에 저장한 파일)', cardInfo?.site === '메모킹 뉴스' && cardInfo.desc === '링크를 붙여넣으면 이렇게 미리 보여요' && thumbShown && cardInfo.thumbSrc.startsWith('memoking://vault/_memoking/link-previews/'), JSON.stringify(cardInfo));
    const cardMd = await until(() => readMemo(linkNote.id).includes(`[메모킹 기사 제목](${articleUrl} "미리보기")`), '카드 저장').catch(() => false);
    check('카드는 파일에 [제목](주소 "미리보기") 한 줄로 저장', cardMd, readMemo(linkNote.id).split('---').slice(2).join('---').slice(0, 200));
    const previewsFile = path.join(VAULT, '_memoking', 'link-previews.json');
    const previews = fs.existsSync(previewsFile) ? JSON.parse(fs.readFileSync(previewsFile, 'utf8')) : {};
    const savedImage = previews[articleUrl]?.image;
    check('미리보기 정보·사진을 메모 폴더(_memoking)에 보관', previews[articleUrl]?.title === '메모킹 기사 제목' && Boolean(savedImage) && fs.readFileSync(path.join(VAULT, savedImage)).equals(png), JSON.stringify(previews[articleUrl]));
    const euc = await js(linkNote.win, `window.memoking.links.preview(${JSON.stringify(`${base}/euckr.html`)})`);
    check('한글 옛 인코딩(EUC-KR) 페이지 제목도 읽음', euc?.title === '한글', JSON.stringify(euc));

    // 글이 있는 줄 가운데에 붙여넣으면 카드가 아니라 링크 글자
    await type(linkNote.win, '관련 글 ');
    await pasteText(linkNote.win, `${base}/euckr.html`);
    await type(linkNote.win, ' 참고');
    const inline = await until(() => js(linkNote.win, `(() => { const a = document.querySelector('.mk-doc p a[href="${base}/euckr.html"]'); return a && { text: a.textContent, cards: document.querySelectorAll('.mk-link-card').length, line: a.closest('p').textContent }; })()`), '링크 글자').catch(() => null);
    check('글 가운데 주소 붙여넣기 → 링크 글자 (뒤에 친 글자는 링크 아님)', inline?.cards === 1 && inline.text === `${base}/euckr.html` && inline.line === `관련 글 ${base}/euckr.html 참고`, JSON.stringify(inline));

    const openedBefore = smokeOpened.length;
    await js(linkNote.win, `document.querySelector('.mk-link-card .lc-main').click()`);
    await js(linkNote.win, `document.querySelector('.mk-doc p a[href="${base}/euckr.html"]').click()`);
    await wait(300);
    const openedWeb = smokeOpened.slice(openedBefore).filter((o) => o.kind === 'web').map((o) => o.target);
    check('카드·링크를 한 번 누르면 브라우저로 열기', openedWeb.includes(articleUrl) && openedWeb.includes(`${base}/euckr.html`), JSON.stringify(openedWeb));

    // 엣지 주소창 복사: <a href="주소">페이지 제목</a> → 그 제목으로 카드
    const edgeUrl = `${base}/article.html?edge=1`;
    await key(linkNote.win, 'End', ['control']);
    await key(linkNote.win, 'Enter');
    await js(linkNote.win, `(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', ${JSON.stringify(`<html><body><!--StartFragment--><a href="${edgeUrl}">엣지 제목</a><!--EndFragment--></body></html>`)});
      dt.setData('text/plain', ${JSON.stringify(edgeUrl)});
      document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    const edgeSaved = await until(() => readMemo(linkNote.id).includes(`[엣지 제목](${edgeUrl} "미리보기")`), '엣지 카드').catch(() => false);
    check('제목과 함께 복사한 링크(엣지) → 그 제목으로 카드', edgeSaved && (await js(linkNote.win, "document.querySelectorAll('.mk-link-card').length")) === 2);

    // 파일: 한 번 누르면 메모 폴더의 복사본을 열고, 프로그램 파일은 먼저 묻는다
    await key(linkNote.win, 'End', ['control']);
    await js(linkNote.win, `(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['메모킹 회의록'], '회의록.txt', { type: 'text/plain' }));
      dt.items.add(new File(['@echo off'], '설치.bat', { type: 'application/x-bat' }));
      document.querySelector('.mk-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    const chips = await until(() => js(linkNote.win, `(() => { const a = [...document.querySelectorAll('.mk-doc a[data-file]')]; return a.length === 2 && a.map((x) => ({ name: x.textContent, kind: x.dataset.file, ext: x.dataset.ext, href: x.getAttribute('href') })); })()`), '파일 칩 2개').catch(() => null);
    check('파일 칩: 종류·확장자 표시 (프로그램 파일 구분)', chips?.[0]?.kind === 'doc' && chips[0].ext === 'TXT' && chips[1]?.kind === 'program' && chips[1].ext === 'BAT', JSON.stringify(chips));
    const clickChip = (i) => js(linkNote.win, `document.querySelectorAll('.mk-doc a[data-file]')[${i}].click()`);
    let mark = smokeOpened.length;
    await clickChip(0);
    const txtOpened = await until(() => smokeOpened.slice(mark).find((o) => o.kind === 'file'), '파일 열기').catch(() => null);
    check('파일 칩 한 번 누르기 → 메모 폴더의 복사본을 기본 앱으로', Boolean(txtOpened) && txtOpened.target.startsWith(path.join(VAULT, 'attachments')) && fs.readFileSync(txtOpened.target, 'utf8') === '메모킹 회의록', JSON.stringify(txtOpened));
    mark = smokeOpened.length;
    await clickChip(1); // 답: 취소
    await wait(400);
    const cancelled = smokeOpened.slice(mark);
    smokeConfirmAnswers.push(true);
    mark = smokeOpened.length;
    await clickChip(1); // 답: 실행하기
    const ran = await until(() => smokeOpened.slice(mark).find((o) => o.kind === 'file'), '프로그램 실행').catch(() => null);
    check('프로그램 파일(.bat) → 먼저 묻고, 취소하면 실행 안 함', cancelled.length === 1 && cancelled[0].kind === 'confirm' && Boolean(ran) && ran.target.endsWith('.bat'), JSON.stringify({ cancelled, ran }));
    const hintText = await js(linkNote.win, `(() => { const a = document.querySelector('.mk-doc a[data-file]'); a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return new Promise((r) => setTimeout(() => r(document.querySelector('.hover-hint')?.textContent ?? ''), 300)); })()`);
    check('파일 칩에 마우스를 올리면 이름·크기 안내', /회의록\.txt \(\d+B\)\. 누르면 열려요/.test(hintText), hintText);

    // 사진은 두 번 누르면 기본 사진 앱으로
    await key(linkNote.win, 'End', ['control']);
    await js(linkNote.win, PASTE_IMAGE);
    await until(() => js(linkNote.win, `document.querySelector('.mk-image')?.naturalWidth > 0`), '사진').catch(() => {});
    mark = smokeOpened.length;
    await js(linkNote.win, `document.querySelector('.mk-image').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const imgOpened = await until(() => smokeOpened.slice(mark).find((o) => o.kind === 'file'), '사진 열기').catch(() => null);
    check('사진 두 번 누르기 → 기본 사진 앱으로', Boolean(imgOpened) && /\.png$/.test(imgOpened.target), JSON.stringify(imgOpened));
    await capture(linkNote.win, 'smoke-link-card.png');

    // 다시 열면 파일의 마크다운에서 카드로 되살아나고, 보관한 미리보기를 쓴다
    await closeNote(linkNote.id);
    const reopenedLink = await newNote(() => js(getList(), `window.memoking.memo.open(${JSON.stringify(linkNote.id)})`));
    const again = await until(() => js(reopenedLink.win, `(() => { const c = document.querySelector('.mk-link-card[data-state="ok"]'); return c && c.querySelector('.lc-title').textContent; })()`), '다시 연 카드').catch(() => null);
    check('다시 열면 카드로 표시 (저장한 미리보기 사용)', again === '메모킹 기사 제목', again);
    // 카드에 마우스를 올리면 다른 내용과 같은 복사 · × 단추 한 벌만 (카드에 따로 × 가 겹치지 않음)
    const cardButtons = await js(reopenedLink.win, `(async () => {
      const card = document.querySelector('.mk-link-card');
      const r = card.getBoundingClientRect();
      card.querySelector('.lc-main').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
      await new Promise((ok) => setTimeout(ok, 50));
      return { x: document.querySelectorAll('.mk-delete-btn').length + card.querySelectorAll('button').length, copy: document.querySelector('.mk-copy-btn')?.title ?? '' };
    })()`);
    check('링크 카드: 마우스를 올리면 × 하나 · "링크 주소 복사"', cardButtons?.x === 1 && cardButtons?.copy === '링크 주소 복사', JSON.stringify(cardButtons));
    await js(reopenedLink.win, `document.querySelector('.mk-delete-btn').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
    const removed = await until(() => readMemo(reopenedLink.id).split('"미리보기"').length === 2, '카드 지우기').catch(() => false);
    check('카드의 × → 카드 지우기', removed && readMemo(reopenedLink.id).includes('관련 글'));
    await closeNote(reopenedLink.id);

    // 13-2) 태그 · # 자동완성 · 목록 필터 (v0.11.0)
    const lj = (code) => js(getList(), code);
    const tagNote1 = await newNote(() => lj(`(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
    await type(tagNote1.win, '주간 회의');
    await key(tagNote1.win, 'Enter');
    await type(tagNote1.win, '#업무 안건 정리 #회의');
    await key(tagNote1.win, 'Enter');
    await type(tagNote1.win, '다음 주 준비');
    const tagMarks = await until(() => js(tagNote1.win, `(() => { const t = [...document.querySelectorAll('.mk-doc .mk-tag')].map((x) => x.textContent); return t.length === 2 && t; })()`), '태그 표시').catch(() => null);
    check('본문의 #태그 → 알약 모양으로 표시', JSON.stringify(tagMarks) === JSON.stringify(['#업무', '#회의']), JSON.stringify(tagMarks));
    await closeNote(tagNote1.id);
    const tagMd1 = readMemo(tagNote1.id);
    check('줄 맨 앞 #태그 도 파일에 #태그 그대로 (\\# 아님)', /\n#업무 안건 정리 #회의\n/.test(tagMd1) && !tagMd1.includes('\\#'), tagMd1.split('---').slice(2).join('---'));

    const tagNote2 = await newNote(() => lj(`(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
    await type(tagNote2.win, '출장 준비물 ');
    await type(tagNote2.win, '#');
    const allSuggest = await until(() => js(tagNote2.win, `(() => { const b = document.querySelector('.tag-suggest'); return b && !b.hidden && [...b.querySelectorAll('.tag-suggest-item span')].map((s) => s.textContent); })()`), '자동완성 목록').catch(() => null);
    check('# 입력 → 지금까지 쓴 태그 목록', Array.isArray(allSuggest) && allSuggest.includes('#업무') && allSuggest.includes('#회의'), JSON.stringify(allSuggest));
    await type(tagNote2.win, '업');
    const narrowed = await until(() => js(tagNote2.win, `(() => { const s = [...document.querySelectorAll('.tag-suggest:not([hidden]) .tag-suggest-item span')].map((x) => x.textContent); return s.length === 2 && s; })()`), '좁혀진 목록').catch(() => null);
    const typedFirst = await js(tagNote2.win, `document.querySelector('.tag-suggest .tag-suggest-item')?.getAttribute('aria-selected') === 'true'`);
    check('자동완성 맨 위는 쓴 그대로, 처음엔 그것이 골라짐 (#업 → [#업, #업무])', JSON.stringify(narrowed) === JSON.stringify(['#업', '#업무']) && typedFirst, JSON.stringify(narrowed));
    await key(tagNote2.win, 'Down');
    await key(tagNote2.win, 'Enter');
    const afterPick = await until(() => js(tagNote2.win, `(() => { const p = document.querySelector('.mk-doc p'); return p && p.textContent.includes('#업무') && { text: p.textContent, open: !document.querySelector('.tag-suggest')?.hidden, paras: document.querySelectorAll('.mk-doc > p').length }; })()`), 'Enter 로 넣기').catch(() => null);
    check('↓ 로 고른 뒤 Enter → 그 태그를 넣고 목록 닫기 (줄바꿈 안 함)', afterPick?.text === '출장 준비물 #업무 ' && !afterPick.open && afterPick.paras === 1, JSON.stringify(afterPick));
    await type(tagNote2.win, '#');
    await until(() => js(tagNote2.win, `!document.querySelector('.tag-suggest')?.hidden`), '다시 열림').catch(() => {});
    await key(tagNote2.win, 'Escape');
    const escClosed = await js(tagNote2.win, `document.querySelector('.tag-suggest')?.hidden !== false`);
    await type(tagNote2.win, '여행');
    check('Esc → 목록 닫고 새 태그는 그냥 계속 쓰기', escClosed && (await js(tagNote2.win, `document.querySelector('.mk-doc p').textContent`)) === '출장 준비물 #업무 #여행');
    // 쓴 그대로 Enter: 비슷한 태그가 있어도(#업 → #업무) 바뀌지 않고 줄만 바뀜
    await type(tagNote2.win, ' #업');
    await until(() => js(tagNote2.win, `!document.querySelector('.tag-suggest')?.hidden`), '목록 열림').catch(() => {});
    await key(tagNote2.win, 'Enter');
    const kept = await until(() => js(tagNote2.win, `(() => { const ps = [...document.querySelectorAll('.mk-doc > p')].map((p) => p.textContent); return ps.length === 2 && ps; })()`), '줄 바뀜').catch(() => null);
    check('쓴 그대로 Enter → 다른 태그로 바뀌지 않고 줄 바꿈', kept?.[0] === '출장 준비물 #업무 #여행 #업', JSON.stringify(kept));
    // 뒤의 점검(카드 태그·AI 요약)이 세는 태그가 달라지지 않게 방금 쓴 " #업" 과 줄 바꿈을 되돌린다
    await js(tagNote2.win, `(() => { const p = document.querySelector('.mk-doc p'); const sel = getSelection(); sel.selectAllChildren(document.querySelector('.mk-doc')); sel.collapseToEnd(); })()`);
    for (let i = 0; i < 4; i++) await key(tagNote2.win, 'Backspace');
    await until(() => js(tagNote2.win, `document.querySelectorAll('.mk-doc > p').length === 1 && document.querySelector('.mk-doc p').textContent === '출장 준비물 #업무 #여행'`), '되돌리기').catch(() => {});
    await closeNote(tagNote2.id);

    // 목록: 카드의 태그, 태그 줄, 필터
    const cardTagsOf = (id) => lj(`[...document.querySelectorAll('.card[data-id="${id}"] .card-tag')].map((t) => t.textContent)`);
    const shownIds = () => lj(`[...document.querySelectorAll('#cards .card')].map((c) => c.dataset.id)`);
    const cardTags = await until(async () => {
      const t = await cardTagsOf(tagNote2.id);
      return t.length === 2 && t;
    }, '카드 태그').catch(() => null);
    check('카드 요약 아래에 태그 표시', JSON.stringify(cardTags) === JSON.stringify(['#업무', '#여행']), JSON.stringify(cardTags));
    const strip = await lj(`[...document.querySelectorAll('#tag-strip .tag-chip')].map((b) => b.textContent)`);
    check('태그 줄: 지금 있는 태그를 많이 쓴 순으로 (개수 포함)', strip[0] === '#업무2' && strip.includes('#회의1') && strip.includes('#여행1'), JSON.stringify(strip));
    await lj(`document.querySelector('#tag-strip [data-tag="업무"]').click()`);
    const byTag = await shownIds();
    const countText = await lj(`document.getElementById('count').textContent`);
    check('태그 누르기 → 그 태그의 메모만', byTag.length === 2 && byTag.includes(tagNote1.id) && byTag.includes(tagNote2.id) && /중 2개/.test(countText), `${JSON.stringify(byTag)} ${countText}`);
    await lj(`document.querySelector('#tag-strip [data-tag="회의"]').click()`);
    const byTwo = await shownIds();
    const summary = await lj(`document.getElementById('filter-summary').hidden ? '' : document.getElementById('filter-summary-text').textContent`);
    check('태그 두 개 → 모두 가진 메모 + "필터 2개" 안내', byTwo.length === 1 && byTwo[0] === tagNote1.id && /필터 2개/.test(summary), `${JSON.stringify(byTwo)} ${summary}`);
    await capture(getList(), 'smoke-tag-filter.png');
    await lj(`document.getElementById('filter-clear').click()`);
    const total = vault.list().length;
    check('필터 풀기 → 전체 목록', (await shownIds()).length === total);

    await lj(`document.getElementById('filter-btn').click()`);
    await lj(`document.querySelector('#color-filter [data-filter-color="yellow"]').click()`);
    const yellowIds = vault.list().filter((m) => m.color === 'yellow').map((m) => m.id).sort();
    check('색 필터 (노랑)', JSON.stringify((await shownIds()).sort()) === JSON.stringify(yellowIds), `${(await shownIds()).length}/${yellowIds.length}`);
    await lj(`document.querySelector('#color-filter [data-filter-color="yellow"]').click()`);
    await lj(`document.querySelector('#kind-filter [data-kind="image"]').click()`);
    const imageIds = vault.list().filter((m) => m.hasImage).map((m) => m.id).sort();
    check('담긴 것 필터 (사진)', imageIds.length > 0 && JSON.stringify((await shownIds()).sort()) === JSON.stringify(imageIds), `${(await shownIds()).length}/${imageIds.length}`);
    await capture(getList(), 'smoke-filter-panel.png');
    await lj(`document.getElementById('filter-clear').click()`);
    await lj(`document.getElementById('filter-btn').click()`);

    await lj(`(() => { const s = document.getElementById('search'); s.value = '#여행'; s.dispatchEvent(new Event('input')); })()`);
    const bySearch = await until(async () => {
      const ids = await shownIds();
      return ids.length === 1 && ids;
    }, '#검색').catch(() => null);
    check('검색창에 #태그 → 태그로 거르기', bySearch?.[0] === tagNote2.id, JSON.stringify(bySearch));
    await lj(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await until(async () => (await shownIds()).length === total, '검색 지움').catch(() => {});
    await lj(`document.querySelector('.card[data-id="${tagNote1.id}"] [data-card-tag="회의"]').click()`);
    await wait(200);
    const byCardTag = await shownIds();
    check('카드의 태그 누르기 → 그 태그로 거르기 (메모는 열지 않음)', byCardTag.length === 1 && byCardTag[0] === tagNote1.id && !noteWins.has(tagNote1.id), JSON.stringify(byCardTag));
    await lj(`document.getElementById('filter-clear').click()`);
    const indexTags = await until(() => {
      const idx = JSON.parse(fs.readFileSync(path.join(VAULT, '_memoking', 'index.json'), 'utf8'));
      const m = idx.memos.find((x) => x.id === tagNote2.id);
      return m?.tags?.length === 2 && m.tags;
    }, 'index.json 태그', 10000).catch(() => null);
    check('AI 요약 파일(index.json)에 태그', JSON.stringify(indexTags) === JSON.stringify(['업무', '여행']), JSON.stringify(indexTags));

    // 13-3) 메모 스택 — 한 창의 탭 (v0.12.0)
    const stacks = getStacks();
    const tabShown = (id) => Boolean(noteWins.get(id)?.isVisible());
    const tabsIn = (id) => js(noteWins.get(id), `[...document.querySelectorAll('#stack-tabs .stack-tab')].map((t) => ({ id: t.dataset.tabId, title: t.querySelector('.stack-title').textContent, on: t.getAttribute('aria-selected') === 'true' }))`);
    async function titledNote(title) {
      const n = await newNote(() => lj(`(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
      await type(n.win, title);
      await until(() => vault.get(n.id)?.title === title, `${title} 저장`).catch(() => {});
      return n;
    }
    const sA = await titledNote('스택 A');
    // 목록 창과 겹치지 않는 곳 (목록 오른쪽, 자리가 없으면 왼쪽)
    const lbNow = getList().getBounds();
    const freeX = lbNow.x + lbNow.width + 20 + 660 < area.x + area.width ? lbNow.x + lbNow.width + 20 : Math.max(area.x, lbNow.x - 680);
    sA.win.setBounds({ x: freeX, y: area.y + 60, width: 320, height: 300 });
    const sB = await titledNote('스택 B');
    sB.win.setBounds({ x: freeX + 340, y: area.y + 80, width: 300, height: 280 });
    const sC = await titledNote('스택 C');
    await closeNote(sC.id);
    await until(() => js(getList(), `!!document.querySelector('.card[data-id="${sC.id}"]')`), 'C 카드').catch(() => {});
    const aBounds = sA.win.getBounds();
    const overA = { x: aBounds.x + 150, y: aBounds.y + 160 };

    // 목록 창은 앞의 점검(트레이)에서 다시 열렸으므로 지금 목록 창으로 끈다
    async function dragCardTo(id, target, beforeDrop) {
      const lw2 = getList();
      const b = lw2.getBounds();
      const send = (type, sx, sy) => js(lw2, `(() => {
        const card = document.querySelector('.card[data-id="${id}"]');
        card.dispatchEvent(new PointerEvent('${type}', {
          bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
          button: 0, buttons: ${type === 'pointerup' ? 0 : 1},
          clientX: ${sx - b.x}, clientY: ${sy - b.y}, screenX: ${sx}, screenY: ${sy},
        }));
      })()`);
      const r = await js(lw2, `(() => { const r = document.querySelector('.card[data-id="${id}"]').getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + 24) }; })()`);
      const st = { x: b.x + r.x, y: b.y + r.y };
      await send('pointerdown', st.x, st.y);
      await send('pointermove', st.x + 20, st.y + 15);
      await wait(60);
      for (let i = 1; i <= 5; i++) {
        await send('pointermove', Math.round(st.x + ((target.x - st.x) * i) / 5), Math.round(st.y + ((target.y - st.y) * i) / 5));
        await wait(50);
      }
      await beforeDrop();
      await send('pointerup', target.x, target.y);
    }
    // 목록 카드를 떠 있는 메모 위로 끌어 잠깐 머물렀다 놓기
    let ghostLabel = '';
    let dropShown = false;
    await dragCardTo(sC.id, overA, async () => {
      {
        await wait(500);
        ghostLabel = await js(getGhost(), `document.getElementById('ghost-label').textContent`).catch(() => '');
        dropShown = await js(sA.win, `!document.getElementById('stack-drop').hidden`);
      }
    });
    check('카드를 메모 위에 머물면 "놓으면 탭으로 합쳐요" (미리보기·받는 창)', ghostLabel === '놓으면 탭으로 합쳐요' && dropShown, `${ghostLabel} / ${dropShown}`);
    const stackC = await until(() => tabShown(sC.id) && !tabShown(sA.id) && stacks.stackOf(sA.id), '카드로 합치기').catch(() => null);
    check('카드를 놓으면 탭으로 합쳐지고 놓은 메모가 보이는 탭', JSON.stringify(stackC?.memos) === JSON.stringify([sA.id, sC.id]) && stackC.active === sC.id);
    await until(async () => (await tabsIn(sC.id)).length === 2, '탭 줄').catch(() => {});
    const tabs1 = await tabsIn(sC.id);
    check('탭 줄: 메모 제목, 보이는 탭 표시', tabs1.map((t) => t.title).join(',') === '스택 A,스택 C' && tabs1[1].on, JSON.stringify(tabs1));
    const cb = noteWins.get(sC.id).getBounds();
    check('합친 탭은 받는 창과 같은 자리·크기', cb.x === aBounds.x && cb.y === aBounds.y && cb.width === aBounds.width && cb.height === aBounds.height, JSON.stringify({ cb, aBounds }));
    const stacksFile = JSON.parse(fs.readFileSync(path.join(VAULT, '_memoking', 'stacks.json'), 'utf8'));
    check('스택은 메모 폴더 _memoking/stacks.json 에 저장', stacksFile.stacks?.[0]?.memos?.join() === [sA.id, sC.id].join(), JSON.stringify(stacksFile));
    await capture(noteWins.get(sC.id), 'smoke-stack-tabs.png');

    // 탭 누르기 → 즉시 전환 (창을 미리 만들어 둠)
    await js(noteWins.get(sC.id), `document.querySelector('.stack-tab[data-tab-id="${sA.id}"]').click()`);
    const switched = await until(() => tabShown(sA.id) && !tabShown(sC.id), '탭 전환').catch(() => false);
    check('탭 누르기 → 그 메모로 전환', switched && stacks.stackOf(sA.id).active === sA.id);
    const listOpen = await until(() => lj(`(() => { const a = document.querySelector('.card[data-id="${sA.id}"]'); const c = document.querySelector('.card[data-id="${sC.id}"]'); return a.classList.contains('open') && !c.classList.contains('open') && a.querySelector('.card-badge.stack')?.textContent; })()`), '목록 표시').catch(() => null);
    check('목록: 보이는 탭만 "열림", 카드에 스택 표시(탭 수)', listOpen === '2', listOpen);

    // 창을 끌어 다른 메모 위에: 머물면 합쳐지고, 스치기만 하면 안 합쳐짐
    trackWindowDrag(sB.id, overA);
    await wait(80);
    endWindowDrag(sB.id);
    await wait(300);
    check('창을 스치듯 지나가면 합치지 않음', !stacks.stackOf(sB.id) && tabShown(sB.id));
    trackWindowDrag(sB.id, overA);
    await wait(500);
    const hoverShown = await js(sA.win, `!document.getElementById('stack-drop').hidden`);
    endWindowDrag(sB.id);
    const merged = await until(() => stacks.stackOf(sB.id)?.memos.length === 3 && tabShown(sB.id) && !tabShown(sA.id), '창 합치기').catch(() => false);
    check('창을 끌어 메모 위에 머물렀다 놓기 → 탭으로 (받는 탭 바로 뒤)', hoverShown && merged && stacks.stackOf(sB.id).memos.join() === [sA.id, sB.id, sC.id].join(), JSON.stringify(stacks.stackOf(sB.id)));

    // + 새 탭
    await js(noteWins.get(sB.id), `document.querySelector('.stack-add').click()`);
    const newTab = await until(() => stacks.stackOf(sA.id)?.memos.find((m) => ![sA.id, sB.id, sC.id].includes(m) && tabShown(m)), '+ 새 탭').catch(() => null);
    check('+ → 새 메모가 보이는 탭 바로 뒤에 새 탭으로', Boolean(newTab) && stacks.stackOf(sA.id).memos.join() === [sA.id, sB.id, newTab, sC.id].join());
    if (newTab) {
      await ready(noteWins.get(newTab));
      noteWins.get(newTab).webContents.focus();
      await type(noteWins.get(newTab), '새 탭 메모');
      await wait(300);
      // Ctrl+Tab → 다음 탭 (C)
      await key(noteWins.get(newTab), 'Tab', ['control']);
      const cycled = await until(() => tabShown(sC.id) && !tabShown(newTab), 'Ctrl+Tab').catch(() => false);
      await key(noteWins.get(sC.id), 'Tab', ['control', 'shift']);
      const back = await until(() => tabShown(newTab) && !tabShown(sC.id), 'Ctrl+Shift+Tab').catch(() => false);
      check('Ctrl+Tab / Ctrl+Shift+Tab → 다음·이전 탭', cycled && back);
      // 늘 위에 둔 스택에서 탭을 바꿔도 왕관 스티커가 사라졌다 나타나지(번쩍이지) 않고 같은 스티커가 새 탭으로 옮겨 간다
      if (stickers) {
        const stickerOf = (id) => stickers.get(noteWins.get(id)?.id)?.win;
        await js(noteWins.get(newTab), `document.getElementById('top-btn').click()`);
        const stuck = await until(() => stickerOf(newTab)?.isVisible(), '왕관 스티커').catch(() => false);
        const first = stickerOf(newTab);
        let gaps = 0;
        const sampler = setInterval(() => {
          const shown = [newTab, sC.id].some((m) => stickerOf(m)?.isVisible?.());
          if (!shown) gaps++;
        }, 10);
        await key(noteWins.get(newTab), 'Tab', ['control']);
        await until(() => tabShown(sC.id) && !tabShown(newTab), 'Ctrl+Tab (늘 위)').catch(() => {});
        await wait(400);
        clearInterval(sampler);
        const same = stickerOf(sC.id) === first && !stickerOf(newTab);
        check('늘 위 스택: 탭을 바꿔도 왕관이 사라지지 않고 같은 스티커가 옮겨 감', stuck && gaps === 0 && same, JSON.stringify({ stuck: Boolean(stuck), gaps, same }));
        await key(noteWins.get(sC.id), 'Tab', ['control', 'shift']);
        await until(() => tabShown(newTab), '되돌아가기').catch(() => {});
        // 뒤 점검을 위해 늘 위에 두기를 끈다 (스티커 누르기)
        await stickerOf(newTab)?.webContents.executeJavaScript(`window.memoking.sticker.peel()`).catch(() => {});
        await until(() => !noteWins.get(newTab).isAlwaysOnTop(), '늘 위 끄기').catch(() => {});
        // 테이프(바탕화면에 붙이기)도 스택의 탭 모두에 — 탭을 바꾸면 같은 테이프가 새 탭으로 옮겨 간다
        await until(() => !stickerOf(newTab), '왕관 떼어짐').catch(() => {});
        await js(noteWins.get(newTab), `document.getElementById('tape-btn').click()`);
        const tapedAll = await until(() => stickerOf(newTab)?.isVisible() && stacks.stackOf(newTab).memos.every((m) => getSettings().onBottom?.[m] === true), '스택 테이프').catch(() => false);
        const tape1 = stickerOf(newTab);
        await key(noteWins.get(newTab), 'Tab', ['control']);
        await until(() => tabShown(sC.id) && !tabShown(newTab), 'Ctrl+Tab (테이프)').catch(() => {});
        await wait(400);
        const moved = stickerOf(sC.id) === tape1 && stickers.get(noteWins.get(sC.id).id)?.kind === 'tape' && !noteWins.get(sC.id).isAlwaysOnTop();
        check('테이프 붙인 스택: 탭 모두 바탕화면에, 탭을 바꿔도 같은 테이프가 옮겨 감', tapedAll && moved, JSON.stringify({ tapedAll: Boolean(tapedAll), moved }));
        await stickerOf(sC.id)?.webContents.executeJavaScript(`window.memoking.sticker.peel()`).catch(() => {});
        await until(() => stacks.stackOf(sC.id).memos.every((m) => !getSettings().onBottom?.[m]), '테이프 떼기').catch(() => {});
        await key(noteWins.get(sC.id), 'Tab', ['control', 'shift']);
        await until(() => tabShown(newTab), '되돌아가기 2').catch(() => {});
      }
      // 창을 옮기면 숨은 탭도 같은 자리
      const moved = { x: aBounds.x + 30, y: aBounds.y + 20, width: 340, height: 320 };
      noteWins.get(newTab).setBounds(moved);
      noteWins.get(newTab).emit('moved');
      await wait(100);
      const same = stacks.stackOf(sA.id).memos.every((m) => { const b = noteWins.get(m)?.getBounds(); return !b || (b.x === moved.x && b.y === moved.y && b.width === moved.width); });
      check('창을 옮기면 모든 탭이 같은 자리·크기', same);
      // 탭의 × → 스택에서 빼고 닫기
      await js(noteWins.get(newTab), `document.querySelector('.stack-close[data-close-tab="${newTab}"]').click()`);
      const closedTab = await until(() => !noteWins.has(newTab) && !stacks.stackOf(newTab), '× 빼기').catch(() => false);
      const nextShown = [sA.id, sB.id, sC.id].filter(tabShown);
      check('탭의 × → 그 메모는 스택에서 빠져 닫히고, 옆 탭이 보임', closedTab && nextShown.length === 1 && vault.get(newTab)?.title === '새 탭 메모', JSON.stringify(nextShown));
    }

    // 따로 떼어 보기
    const visibleId = [sA.id, sB.id, sC.id].find(tabShown);
    await js(noteWins.get(visibleId), `window.memoking.stack.detach(${JSON.stringify(sB.id)})`);
    const detached = await until(() => !stacks.stackOf(sB.id) && tabShown(sB.id) && [sA.id, sC.id].some(tabShown), '떼어 보기').catch(() => false);
    const bTabs = detached ? await until(async () => (await tabsIn(sB.id)).length === 0 && 'none', 'B 탭 줄 숨김').catch(() => 'still') : 'x';
    check('따로 떼어 보기 → 자기 창으로 (탭 줄 없음), 스택은 그대로', detached && bTabs === 'none' && stacks.stackOf(sA.id)?.memos.length === 2);
    await closeNote(sB.id);

    // 스택 창 닫기 → 탭 모두 닫힘, 목록에서 열면 그 탭이 보이는 스택으로
    const vis = [sA.id, sC.id].find(tabShown);
    await js(noteWins.get(vis), `document.getElementById('close-btn').click()`);
    const allClosed = await until(() => !noteWins.has(sA.id) && !noteWins.has(sC.id), '스택 닫기').catch(() => false);
    check('스택 창 닫기 → 숨은 탭까지 모두 닫힘', allClosed);
    await lj(`document.querySelector('.card[data-id="${sC.id}"]').click()`);
    const stackReopened = await until(() => tabShown(sC.id) && !tabShown(sA.id), '스택 다시 열기').catch(() => false);
    await until(async () => (await tabsIn(sC.id)).length === 2, '다시 연 탭 줄').catch(() => {});
    check('목록에서 스택의 메모 열기 → 그 탭이 보이는 스택 창', stackReopened && (await tabsIn(sC.id)).length === 2);
    // 하나만 남으면 스택이 풀림
    await js(noteWins.get(sC.id), `window.memoking.stack.remove(${JSON.stringify(sA.id)})`);
    const dissolved = await until(() => !stacks.stackOf(sC.id) && tabShown(sC.id), '스택 풀림').catch(() => false);
    await until(async () => (await tabsIn(sC.id)).length === 0, '탭 줄 숨김').catch(() => {});
    check('탭이 하나만 남으면 스택이 풀리고 보통 메모 창', dissolved && (await tabsIn(sC.id)).length === 0 && !JSON.parse(fs.readFileSync(path.join(VAULT, '_memoking', 'stacks.json'), 'utf8')).stacks.length);
    await closeNote(sC.id);

    // 13-4) 처음 실행 튜토리얼 (v0.12.0) — 말풍선을 따라 실제로 눌러 보며 끝까지
    const bubbleStep = (win) => js(win, `(() => { const b = document.querySelector('.coach-bubble'); return b && !b.hidden ? b.dataset.step : null; })()`).catch(() => null);
    const waitStep = (getWin, stepId) => until(async () => (await bubbleStep(getWin())) === stepId, `튜토리얼 ${stepId}`, 6000).then(() => true).catch(() => false);
    const coachNext = (win) => js(win, `document.querySelector('.coach-bubble .coach-next').click()`);
    startTutorial();
    const welcome = await waitStep(getList, 'welcome');
    await capture(getList(), 'smoke-tutorial-welcome.png');
    check('튜토리얼 시작 → 목록 창에 환영 말풍선', welcome);
    await coachNext(getList());
    const newStep = await waitStep(getList, 'new-memo');
    await wait(350); // 비추는 테두리가 옮겨 가는 움직임(0.2초)이 끝난 뒤
    const spotOnBtn = await js(getList(), `(() => { const s = document.querySelector('.coach-spot').getBoundingClientRect(); const b = document.getElementById('fab').getBoundingClientRect(); return s.left <= b.left && s.right >= b.right && s.top <= b.top && s.bottom >= b.bottom && s.width < b.width + 20; })()`);
    const noNext = await js(getList(), `!document.querySelector('.coach-bubble .coach-next') && !!document.querySelector('.coach-try')`);
    check('따라 하기 단계: + 버튼만 밝게 비추고 "직접 해 보세요" (다음 버튼 없음)', newStep && spotOnBtn && noNext);
    const notesBeforeTutorial = new Set(noteWins.keys());
    await js(getList(), `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`);
    const tutMemo = await until(() => [...noteWins.keys()].find((k) => !notesBeforeTutorial.has(k)), '튜토리얼 메모').catch(() => null);
    const tutWin = () => noteWins.get(tutMemo);
    const writeStep = tutMemo && (await ready(tutWin()).then(() => waitStep(tutWin, 'write')));
    check('+ 를 누르면 → 새 메모 창에서 다음 말풍선 (목록 말풍선은 사라짐)', writeStep && (await bubbleStep(getList())) === null);
    if (writeStep) {
      tutWin().webContents.focus();
      await js(tutWin(), `document.querySelector('.mk-doc').focus()`);
      await type(tutWin(), '튜토리얼 메모');
      const styleStep = await waitStep(tutWin, 'style');
      const barShown = styleStep && (await js(tutWin(), `!document.body.classList.contains('bar-hidden')`));
      check('글을 쓰면 → 저절로 다음 단계 (튜토리얼 동안 서식 도구막대는 보임)', styleStep && barShown);
      // 안내만 하는 단계는 "다음"으로, 직접 해 보는 단계(태그·닫기)는 실제로 해서 넘어간다
      const stepIds = TUTORIAL_STEPS.map((x) => x.id);
      const walk = async (win, from, to) => {
        for (const id of stepIds.slice(stepIds.indexOf(from) + 1, stepIds.indexOf(to) + 1)) {
          await coachNext(win());
          await waitStep(win, id);
        }
      };
      await walk(tutWin, 'style', 'tag');
      await type(tutWin(), ' #할일 ');
      const crownStep = await waitStep(tutWin, 'crown');
      check('#태그를 쓰면 → 저절로 다음 단계', crownStep);
      await walk(tutWin, 'crown', 'bar');
      await capture(tutWin(), 'smoke-tutorial-note.png');
      await coachNext(tutWin());
      await waitStep(tutWin, 'close');
      await js(tutWin(), `document.getElementById('close-btn').click()`);
      const cardsStep = await waitStep(getList, 'cards');
      check('메모를 닫으면 → 목록 창으로 돌아와 다음 단계', cardsStep && !noteWins.has(tutMemo) && vault.get(tutMemo)?.title.startsWith('튜토리얼 메모'), JSON.stringify({ cardsStep, open: noteWins.has(tutMemo), title: vault.get(tutMemo)?.title }));
      await walk(getList, 'cards', 'done');
      await coachNext(getList());
      const finished = await until(async () => !getTutorial().active && (await bubbleStep(getList())) === null, '튜토리얼 끝').catch(() => false);
      check('마지막 단계까지 → 말풍선이 사라지고 끝', finished);
    }
    // 설정에서 언제든 다시, 건너뛰기
    await lj(`document.getElementById('settings-btn').click()`);
    await wait(200);
    await lj(`document.getElementById('tutorial-btn').click()`);
    const tutorialAgain = await waitStep(getList, 'welcome');
    const settingsClosed = await lj(`!document.getElementById('settings-dialog').open`);
    await lj(`document.querySelector('.coach-bubble .coach-skip').click()`);
    const skipped = await until(async () => !getTutorial().active && (await bubbleStep(getList())) === null, '건너뛰기').catch(() => false);
    check('설정 › 사용법 둘러보기 → 처음부터 다시, "다음에 할게요" → 끝', tutorialAgain && settingsClosed && skipped);


    // 14) 예약 알림 (v0.8.0)
    const lw = getList();
    const listJs = (code) => js(getList(), code);
    const remindersOf = (id) => getVault().get(id)?.reminders ?? [];
    // 14-00) 글 속 날짜 → 알림: 점선 밑줄, 커서를 옮기면(치는 중 말고) 단추, 누르면 그 시각 알림
    {
      const dn = await newNote(() => js(getList(), `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
      await type(dn.win, '다음 주 화요일 오후 2시 반 발표');
      await wait(300);
      const under = await js(dn.win, `document.querySelector('.mk-doc .mk-date')?.textContent ?? ''`);
      const typingChip = await js(dn.win, `Boolean(document.querySelector('.mk-date-chip'))`);
      await key(dn.win, 'Home');
      const chip = await until(() => js(dn.win, `document.querySelector('.mk-date-chip')?.textContent ?? null`), '날짜 단추').catch(() => '');
      check('글 속 날짜: 밑줄 · 치는 중에는 단추 없음 · 커서를 옮기면 "📅 일정 추가" 단추',
        under === '다음 주 화요일 오후 2시 반' && !typingChip && /일정 추가: .*오후 2:30/.test(chip), JSON.stringify({ under, typingChip, chip }));
      await capture(dn.win, 'smoke-date-chip.png');
      // 단추 → 일정 창: 이름은 줄에서 짐작(발표), 미리 알림은 고른다 (구글 캘린더처럼 시각이 아니라 미리)
      await js(dn.win, `document.querySelector('.mk-date-chip').click()`);
      const dlg = await until(() => js(dn.win, `document.querySelector('.event-dialog[open]') ? {
        name: document.getElementById('event-name').value,
        when: document.getElementById('event-when').textContent,
        pressed: [...document.querySelectorAll('.event-alerts [aria-pressed="true"]')].map((b) => b.textContent),
        chips: [...document.querySelectorAll('.event-alerts button')].map((b) => b.textContent),
      } : null`), '일정 창').catch(() => null);
      check('일정 창: 이름 짐작(발표) · 때 · 미리 알림 고르기 (기본 10분 전)',
        dlg?.name === '발표' && /오후 2:30/.test(dlg.when) && dlg.pressed.length === 1 && /10분 전/.test(dlg.pressed[0]),
        JSON.stringify(dlg));
      await capture(dn.win, 'smoke-event-dialog.png');
      await js(dn.win, `(() => { [...document.querySelectorAll('.event-alerts button')].find((b) => b.textContent.includes('하루 전')).click(); document.getElementById('event-save').click(); })()`);
      const set = await until(() => remindersOf(dn.id).find((r) => r.kind === 'at'), '일정 저장').catch(() => null);
      const at = set ? new Date(set.at) : null;
      check('일정 저장: 화요일 14:30 · 이름 "발표" · 미리 알림 하루 전과 10분 전 · 밑줄이 실선으로',
        Boolean(at) && at.getDay() === 2 && at.getHours() === 14 && at.getMinutes() === 30 && at > new Date()
        && set.title === '발표' && JSON.stringify(set.alerts) === '[1440,10]'
        && await until(() => js(dn.win, `Boolean(document.querySelector('.mk-doc .mk-date-set'))`), '실선').catch(() => false), JSON.stringify(set));
      // 메모를 그림 카드로 저장 (점검에서는 저장 창 없이 임시 폴더에) — 복사는 클립보드를 바꾸므로 smoke:clipboard 에서만
      await js(dn.win, `document.getElementById('image-save-btn').click()`);
      const savedMsg = await until(() => js(dn.win, `/그림으로 저장했어요/.test(document.getElementById('status').textContent) ? document.getElementById('status').textContent : null`), '그림 저장', 15000).catch(() => '');
      const pngName = /저장했어요: (.+\.png)/.exec(savedMsg ?? '')?.[1];
      const pngFile = pngName ? path.join(app.getPath('temp'), pngName) : '';
      const pngOk = Boolean(pngFile) && fs.existsSync(pngFile) && fs.readFileSync(pngFile).subarray(1, 4).toString() === 'PNG' && fs.statSync(pngFile).size > 5000;
      check('메뉴 › 그림으로 저장: 메모 색 종이의 PNG 그림', pngOk, savedMsg);
      if (pngOk) fs.copyFileSync(pngFile, path.join(OUT, 'smoke-memo-card.png'));
      if (process.argv.includes('--clipboard')) {
        const { clipboard } = await import('electron');
        clipboard.clear();
        await js(dn.win, `document.getElementById('image-copy-btn').click()`);
        const copied = await until(() => !clipboard.readImage().isEmpty(), '그림 복사', 15000).catch(() => false);
        check('메뉴 › 그림으로 복사: 클립보드에 그림', copied);
      }
      // 뒤의 알림 예약 탭 점검이 세는 알림 수에 섞이지 않게 지운다
      await js(dn.win, `document.querySelector('#reminder-list .rem-item .icon-btn')?.click()`);
      await until(() => remindersOf(dn.id).length === 0, '날짜 알림 지우기').catch(() => {});
      await closeNote(dn.id);
    }
    // 14-01) 이어 쓰기: 휴대폰에서 방금 고친 메모가 들어오면 목록 위에 "휴대폰에서 방금 고친 메모: … [열기]"
    {
      const nowIso = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
      fs.writeFileSync(path.join(VAULT, '휴대폰에서 쓴 메모.md'), `---\nid: 00000000-0000-4000-8000-00000000f0e1\ncreated: ${nowIso}\nupdated: ${nowIso}\ncolor: green\ndevice: phone\n---\n# 휴대폰에서 쓴 메모\n\n지하철에서 적음\n`);
      getVault().scan();
      const bar = await until(() => listJs(`(() => { const b = document.getElementById('handoff-bar'); return b && !b.hidden ? b.textContent : null; })()`), '이어 쓰기 막대').catch(() => '');
      await capture(getList(), 'smoke-handoff.png');
      check('이어 쓰기: 휴대폰에서 방금 고친 메모를 목록 위에 [열기]', /휴대폰에서 방금 고친 메모\s*휴대폰에서 쓴 메모/.test(bar ?? '') && /열기/.test(bar ?? ''), bar);
      const hn = await newNote(() => listJs(`document.querySelector('#handoff-bar button').click()`)).catch(() => null);
      check('이어 쓰기: [열기] → 그 메모 창', hn?.id === '00000000-0000-4000-8000-00000000f0e1');
      if (hn) await closeNote(hn.id);
      getVault().trash('00000000-0000-4000-8000-00000000f0e1'); // 뒤 점검의 메모 수에 섞이지 않게
    }
    // 14-02) 잠금 메모: 비밀번호로 잠그면 파일·버전에 풀린 글이 없고, 쓰는 동안도 잠근 채 저장, 닫았다 열면 비밀번호
    {
      const ln = await newNote(() => js(getList(), `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
      await type(ln.win, '은행 메모');
      await key(ln.win, 'Enter');
      await type(ln.win, '계좌 비밀 1234');
      await until(() => getVault().get(ln.id)?.file && readMemo(ln.id).includes('계좌 비밀'), '잠그기 전 저장').catch(() => {});
      const lockFile = () => readMemo(ln.id);
      const vaultText = () => fs.readdirSync(VAULT, { recursive: true }).map((f) => path.join(VAULT, f)).filter((f) => fs.statSync(f).isFile() && /\.(md|json)$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      await js(ln.win, `document.getElementById('menu-btn').click()`);
      await js(ln.win, `document.getElementById('lock-btn').click()`);
      await until(() => js(ln.win, `Boolean(document.querySelector('.lock-dialog[open]'))`), '잠그기 창');
      await capture(ln.win, 'smoke-lock-dialog.png');
      await js(ln.win, `(() => { document.getElementById('lock-pass-1').value = 'abcd1234'; document.getElementById('lock-pass-2').value = 'abcd1234'; document.querySelector('.lock-dialog form').requestSubmit(); })()`);
      const sealed = await until(() => /memoking-lock v1/.test(lockFile()), '잠근 파일', 15000).catch(() => false);
      const clean = await until(() => !vaultText().includes('계좌 비밀'), '색인도 다시', 8000).catch(() => false); // 색인(index.json)은 잠시 뒤 다시 쓴다
      const leak = clean ? '' : fs.readdirSync(VAULT, { recursive: true }).filter((f) => { try { return fs.readFileSync(path.join(VAULT, f), 'utf8').includes('계좌 비밀'); } catch { return false; } }).join(', ');
      check('잠그기: 파일·버전·색인 어디에도 풀린 글이 없고 제목만', sealed && clean && /# 은행 메모/.test(lockFile()), leak || lockFile().slice(0, 200));
      await key(ln.win, 'End', ['control']);
      await type(ln.win, ' 추가함');
      await until(() => getVault().get(ln.id)?.body.includes('추가함'), '잠긴 채 저장', 8000).catch(() => {});
      await wait(2000); // 색인까지
      check('잠긴 메모: 쓰는 동안 저장도 잠근 글로', getVault().get(ln.id)?.body.includes('추가함') && !vaultText().includes('추가함') && /memoking-lock/.test(lockFile()));
      await closeNote(ln.id);
      check('잠긴 메모: 창을 닫으면 다시 잠김', getVault().get(ln.id)?.needsPassword === true);
      await js(getList(), `document.querySelector('.card[data-id="${ln.id}"]').click()`);
      const lo = { id: ln.id, win: await until(() => noteWins.get(ln.id), '잠긴 메모 창') };
      await until(() => js(lo.win, `Boolean(document.querySelector('.lock-screen'))`), '비밀번호 화면');
      await capture(lo.win, 'smoke-lock-screen.png');
      await js(lo.win, `(() => { document.getElementById('lock-open-pass').value = 'wrong123'; document.querySelector('.lock-screen').requestSubmit(); })()`);
      const wrong = await until(() => js(lo.win, `document.querySelector('.lock-screen .lock-error')?.textContent || null`), '틀린 비밀번호', 10000).catch(() => '');
      await js(lo.win, `(() => { document.getElementById('lock-open-pass').value = 'abcd1234'; document.querySelector('.lock-screen').requestSubmit(); })()`);
      const opened = await until(() => js(lo.win, `!document.querySelector('.lock-screen') && (document.querySelector('.mk-doc')?.textContent ?? '').includes('추가함')`), '비밀번호로 열기', 10000).catch(() => false);
      check('잠긴 메모: 틀린 비밀번호는 안내, 맞으면 열림', /비밀번호가 달라요/.test(wrong) && opened, wrong);
      await js(lo.win, `document.getElementById('menu-btn').click()`);
      const unlockLabel = await js(lo.win, `document.querySelector('#lock-btn span').textContent`);
      await js(lo.win, `document.getElementById('lock-btn').click()`);
      await until(() => js(lo.win, `document.getElementById('confirm-dialog').open`), '잠금 풀기 확인');
      await js(lo.win, `document.getElementById('confirm-ok').click()`);
      const plainAgain = await until(() => !/memoking-lock/.test(lockFile()) && lockFile().includes('계좌 비밀'), '잠금 풀기', 8000).catch(() => false);
      check('잠금 풀기: 메뉴가 "잠금 풀기" · 풀면 파일에 원래 글', unlockLabel === '잠금 풀기' && plainAgain, unlockLabel);
      await closeNote(lo.id);
      getVault().trash(ln.id);
    }
    // 14-03) 쓰는 중에 다른 기기(휴대폰)가 이 메모를 잠그면: 저장 못 한 글은 사본 메모로 남기고, "잠갔어요" 라고 알린 뒤 닫힘
    {
      const wn = await newNote(() => js(getList(), `(document.getElementById('fab').click(), document.querySelector('#fab-menu [data-new="text"]').click())`));
      await type(wn.win, '여행 계획');
      await key(wn.win, 'Enter');
      await type(wn.win, '첫 줄');
      await until(() => getVault().get(wn.id)?.file && readMemo(wn.id).includes('첫 줄'), '잠그기 전 저장').catch(() => {});
      const file = path.join(VAULT, getVault().get(wn.id).file);
      const text = fs.readFileSync(file, 'utf8');
      const head = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0] ?? '';
      const sealed = await lockBody(text.slice(head.length), 'phone999', { iterations: 1000 });
      const before = new Set(getVault().list().map((m) => m.id));
      await type(wn.win, ' 아직 저장 안 한 글'); // 자동 저장 전에
      fs.writeFileSync(file, head + sealed); // 휴대폰이 잠금
      getVault().scan();
      const status = await until(() => js(wn.win, `/잠갔어요/.test(document.getElementById('status').textContent) ? document.getElementById('status').textContent : null`), '잠금 안내', 8000).catch(() => '');
      const copy = await until(() => getVault().list().find((m) => !before.has(m.id) && getVault().get(m.id)?.body.includes('아직 저장 안 한 글')), '사본 메모', 8000).catch(() => null);
      check('쓰는 중에 휴대폰이 잠그면: 쓰던 글은 사본 메모로 남고 "잠갔어요" 안내 (비밀번호를 바꿨다고 하지 않음)',
        Boolean(copy) && /사본 메모/.test(status ?? '') && !/비밀번호를 바꿨/.test(status ?? '') && /memoking-lock/.test(fs.readFileSync(file, 'utf8')), status);
      await until(() => !noteWins.has(wn.id), '창 닫힘', 8000).catch(() => {});
      if (copy) getVault().trash(copy.id);
      getVault().trash(wn.id);
    }
    // 14-0) 알림 보관함 탭: 처음에는 동의 안내부터
    await listJs(`document.querySelector('[data-tab="history"]').click()`);
    await wait(300);
    check('알림 보관함 탭: 처음엔 설명·동의 화면 (기본 꺼짐)', await listJs(`!document.getElementById('history-consent').hidden`));
    await capture(lw, 'smoke-history-consent.png');
    await listJs(`document.querySelector('[data-tab="memos"]').click()`);

    // 14-1) 메모 창 알림 패널에서 "반복 매주 월 09:30, 메모 띄우기" 와 "5분 타이머, 알림만" 추가
    const rn = await openN1();
    await key(rn.win, 'A', ['control', 'shift']);
    const panelOpen = await until(() => js(rn.win, `!document.getElementById('reminder-panel').hidden`), '알림 패널').catch(() => false);
    check('종 버튼(Ctrl+Shift+A) → 예약 알림 패널', panelOpen);
    await js(rn.win, `(() => {
      document.querySelector('[data-kind="repeat"]').click();
      const every = document.getElementById('rep-every');
      every.value = 'week';
      every.dispatchEvent(new Event('change'));
      const mon = document.querySelector('[data-wd="1"]');
      if (mon.getAttribute('aria-pressed') !== 'true') mon.click();
      document.getElementById('rep-time').value = '09:30';
      document.querySelector('input[name="action"][value="open"]').click();
      document.getElementById('reminder-form').requestSubmit();
    })()`);
    await until(() => remindersOf(n1.id).length === 1, '반복 알림 저장').catch(() => {});
    await js(rn.win, `(() => {
      document.querySelector('[data-kind="timer"]').click();
      document.querySelector('[data-min="5"]').click();
      document.querySelector('input[name="action"][value="notify"]').click();
      document.getElementById('reminder-form').requestSubmit();
    })()`);
    await until(() => remindersOf(n1.id).length === 2, '타이머 저장').catch(() => {});
    const saved = remindersOf(n1.id);
    const weekly = saved.find((r) => r.kind === 'repeat');
    const timer = saved.find((r) => r.kind === 'timer');
    const md = readMemo(n1.id);
    check('반복 알림 → 메모 파일 머리말에 저장 (매주 월 09:30, 메모 띄우기)',
      weekly?.repeat.every === 'week' && weekly.repeat.weekdays.includes(1) && weekly.repeat.time === '09:30' && weekly.action === 'open' && /reminders:/.test(md),
      JSON.stringify(weekly));
    check('타이머 5분 → 약 5분 뒤 시각으로 저장',
      timer && Math.abs(Date.parse(timer.at) - Date.now() - 5 * 60_000) < 60_000 && timer.action === 'notify', JSON.stringify(timer));
    check('메모 창 종 버튼 개수 표시', (await js(rn.win, `document.getElementById('bell-count').textContent`)) === '2');
    await capture(rn.win, 'smoke-reminder-panel.png');

    // 14-2) 알림 예약 탭: 다가오는 순으로 한 번에
    await listJs(`document.querySelector('[data-tab="reminders"]').click()`);
    await wait(400);
    const tab = await listJs(`({
      days: document.querySelectorAll('#reminder-groups .cal-day').length,
      today: document.querySelector('#reminder-groups .cal-day.today[aria-pressed="true"]') !== null,
      dots: document.querySelectorAll('#reminder-groups .cal-dots i').length,
      events: [...document.querySelectorAll('#reminder-groups .ev-row')].map((r) => r.textContent),
      timer: document.querySelector('#reminder-groups .rem-row-item .row-sub')?.textContent,
      count: document.getElementById('count-reminders').textContent,
    })`);
    check('일정 탭: 한 달 달력(오늘 선택) · 매주 월 일정이 날짜별로 점·목록 (미리 알림 표시) · 타이머는 따로',
      tab.days === 42 && tab.today && tab.dots >= 4 && tab.events.some((t) => /09:30|9:30/.test(t) && /알림 10분 전/.test(t)) && /5분 타이머/.test(tab.timer) && tab.count === '2', JSON.stringify(tab));
    await capture(lw, 'smoke-reminders-tab.png');
    // 창을 줄이거나 넓혀도 달력이 잘리지 않는다 (가장 작은 창 300×380 · 낮고 넓은 창 · 넓은 창은 달력 왼쪽·목록 오른쪽)
    {
      const keep = lw.getBounds();
      const fits = [];
      for (const [w, h] of [[300, 380], [420, 520], [900, 420], [900, 700]]) {
        lw.setBounds({ ...keep, width: w, height: h });
        await wait(250);
        fits.push(await js(lw, `(() => {
          const box = document.getElementById('reminder-groups');
          box.scrollTop = 0;
          const cal = box.querySelector('.cal').getBoundingClientRect();
          const view = box.getBoundingClientRect();
          const list = box.querySelector('.ev-day-title').getBoundingClientRect();
          return { size: '${w}x${h}', fits: cal.bottom <= view.bottom + 1 && cal.right <= view.right + 1, side: list.left >= cal.right };
        })()`));
      }
      await capture(lw, 'smoke-reminders-wide.png');
      lw.setBounds(keep);
      await wait(200);
      check('일정 탭: 창을 줄여도 달력 한 달이 다 보임 · 넓은 창은 달력 옆에 일정 목록',
        fits.every((f) => f.fits) && fits.at(-1).side && fits.at(-2).side, JSON.stringify(fits));
    }

    // 14-3) 알림만: 시각이 되면 Windows 알림 (점검 때는 기록만) → 한 번짜리는 "완료"
    const past = (ms) => new Date(Date.now() - ms).toISOString();
    await js(rn.win, `window.memoking.reminders.set(${JSON.stringify(n1.id)}, [
      ...${JSON.stringify(saved)}, { kind: 'at', at: ${JSON.stringify(past(20_000))}, action: 'notify' }])`);
    const toast = await until(() => smokeToasts.find((t) => t.memoId === n1.id), 'Windows 알림').catch(() => null);
    check('시각이 된 알림 → Windows 알림 (제목·때)', toast && toast.title === '장보기 목록' && /오늘 \d{2}:\d{2}/.test(toast.body), JSON.stringify(toast));
    const done = remindersOf(n1.id).find((r) => r.kind === 'at');
    check('한 번짜리 알림은 울린 뒤 꺼짐(완료)', done && !done.enabled && done.last);
    await closeNote(rn.id);

    // 14-4) 메모 띄우기 + 놓친 알림: 꺼져 있던 동안의 알림은 한 번만, 메모 창이 "⏰" 띠와 함께 뜬다
    await listJs(`window.memoking.reminders.set(${JSON.stringify(n1.id)}, [
      ...${JSON.stringify(remindersOf(n1.id))}, { kind: 'at', at: ${JSON.stringify(past(5 * 3600_000))}, action: 'open' }])`);
    const opened = await until(() => noteWins.get(n1.id), '알림으로 메모 열림').catch(() => null);
    if (opened) await ready(opened);
    const banner = opened ? await js(opened, `document.getElementById('alarm-banner').hidden ? '' : document.getElementById('alarm-text').textContent`) : '';
    check('메모 띄우기 알림 → 메모 창이 열리고 "놓친 알림" 띠', /놓친 알림/.test(banner), banner);
    if (opened) await capture(opened, 'smoke-alarm-open.png');
    if (opened) await closeNote(n1.id);

    // 14-5) 실행할 때 알림 + 반복 알림은 한 번 울린 뒤 다음 회차까지 조용
    const toastsBefore = smokeToasts.length;
    await listJs(`window.memoking.reminders.set(${JSON.stringify(n1.id)}, [
      ...${JSON.stringify(remindersOf(n1.id))}, { kind: 'startup', startup: 'daily', action: 'notify' }])`);
    alarms.startup();
    const startupToast = smokeToasts.slice(toastsBefore).find((t) => /켤 때 알림/.test(t.body));
    alarms.startup();
    check('실행할 때 알림(하루 첫 실행) → 한 번만', Boolean(startupToast) && smokeToasts.slice(toastsBefore).filter((t) => /켤 때 알림/.test(t.body)).length === 1);
    const tickAgain = alarms.tick();
    check('이미 울린 알림은 다시 울리지 않음', tickAgain === 0, `다시 울린 개수 ${tickAgain}`);

    // 14-6) 탭에서 끄기
    await listJs(`document.querySelector('[data-tab="reminders"]').click()`);
    await wait(300);
    const enabledBefore = remindersOf(n1.id).filter((r) => r.enabled).length;
    await listJs(`document.querySelector('#reminder-groups .row .switch').click()`);
    await until(() => remindersOf(n1.id).filter((r) => r.enabled).length === enabledBefore - 1, '탭에서 끄기').catch(() => {});
    const fileAfter = fs.readFileSync(path.join(VAULT, getVault().get(n1.id).file), 'utf8');
    check('알림 예약 탭에서 켜기/끄기 → 메모 파일에 반영',
      remindersOf(n1.id).filter((r) => r.enabled).length === enabledBefore - 1 && /enabled: false/.test(fileAfter),
      JSON.stringify(remindersOf(n1.id).map((r) => [r.kind, r.enabled])));

    // 15) 알림 보관함 (v0.8.0) — 가짜 Windows 알림 DB 로 확인
    const history = getHistory();
    check('메모킹 알림도 보관함에 기록', history.list().filter((e) => e.source === 'memoking').length >= 3);
    await listJs(`document.querySelector('[data-tab="history"]').click()`);
    await wait(300);
    await listJs(`document.getElementById('history-enable').click()`); // 설명·동의 화면의 "보관 시작하기"
    const collected = await until(() => history.list().filter((e) => e.source === 'windows').length === 2, '알림 수집').catch(() => false);
    await wait(400);
    const shown = await listJs(`[...document.querySelectorAll('#history-rows .noti-title')].map((t) => t.textContent)`);
    check('보관 켜기 → 알림 센터의 알림을 모아 보관함에 표시', collected && shown.includes('김대리') && shown.includes('분기 보고서'), JSON.stringify(shown));
    check('보낸 사람 그림도 보관', await listJs(`!!document.querySelector('#history-rows img.avatar')`));
    // 새 알림이 오고, 사용자가 알림 센터에서 지워도 보관함에는 남는다
    addFakeNotification('com.example.chat', '박과장', '점심 같이 해요');
    history.poll();
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const wpn = new DatabaseSync(path.join(WPN, 'wpndatabase.db'));
    wpn.exec('delete from Notification');
    wpn.close();
    history.poll();
    check('알림 센터에서 지워진 알림도 보관함에 남음', history.list({ query: '박과장' }).length === 1);
    await capture(lw, 'smoke-history-tab.png');
    await listJs(`(() => { const s = document.getElementById('search'); s.value = '회의'; s.dispatchEvent(new Event('input')); })()`);
    const titlesNow = () => listJs(`[...document.querySelectorAll('#history-rows .noti-title')].map((t) => t.textContent)`);
    await until(async () => (await titlesNow()).length === 1, '보관함 검색 반영').catch(() => {});
    const searched = await titlesNow();
    check('보관함 검색', JSON.stringify(searched) === JSON.stringify(['김대리']), JSON.stringify(searched));
    // 키보드로: 알림 글 부분은 단추 (Enter 로 펼치기), 탭은 ←→ 로 옮겨 다님
    await listJs(`document.querySelector('#history-rows .noti .noti-text').focus()`);
    // 단추는 Enter 의 글자(char) 이벤트로 눌린다 — key() 는 keyDown·keyUp 만 보내므로 char 를 더한다
    getList().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    getList().webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    getList().webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await wait(150);
    check('보관함: 키보드(Enter)로 알림 펼치기', await listJs(`(() => { const b = document.querySelector('#history-rows .noti .noti-text'); return b.getAttribute('aria-expanded') === 'true' && b.closest('.noti').classList.contains('expanded'); })()`));
    const memoFromNoti = await newNote(() => listJs(`document.querySelector('#history-rows .noti [aria-label="메모로 만들기"]').click()`));
    const notiMd = readMemo(memoFromNoti.id);
    check('보관한 알림 → 메모로 만들기', notiMd.includes('# 김대리') && notiMd.includes('회의 자료 보냈어요') && /알림, /.test(notiMd));
    await closeNote(memoFromNoti.id);
    // 알림 하나 지우기: 그 자리에 되돌리기 5초 → 되돌리면 그대로, 기다리면 지워짐
    await listJs(`document.querySelector('#history-rows .noti [aria-label="삭제"]').click()`);
    await wait(300);
    const undoShown = await listJs(`!!document.querySelector('#history-rows .noti-undo')`) && history.list({ query: '회의' }).length === 1;
    await listJs(`document.querySelector('#history-rows .noti-undo button').click()`);
    await wait(200);
    const undone = await listJs(`!document.querySelector('#history-rows .noti-undo') && !!document.querySelector('#history-rows .noti')`);
    await listJs(`document.querySelector('#history-rows .noti [aria-label="삭제"]').click()`);
    const removed = await until(() => history.list({ query: '회의' }).length === 0, '알림 지움', 7000).then(() => true).catch(() => false);
    check('보관한 알림 지우기 (그 자리에 되돌리기 5초, 되돌리면 그대로)', undoShown && undone && removed, JSON.stringify({ undoShown, undone, removed }));
    await listJs(`document.querySelector('.tabs [aria-selected="true"]').focus()`);
    await key(getList(), 'Left');
    const tabAfter = await listJs(`document.querySelector('.tabs [aria-selected="true"]').dataset.tab`);
    await key(getList(), 'Right');
    check('탭: ← → 로 옆 탭', tabAfter === 'reminders' && (await listJs(`document.querySelector('.tabs [aria-selected="true"]').dataset.tab`)) === 'history', tabAfter);
    await listJs(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);

    // 16) 설정: 자동 실행 (개발 실행에서는 끄기 상태로 안내, 설치판은 켜기 가능)
    await listJs(`document.getElementById('settings-btn').click()`);
    await wait(300);
    const auto = await listJs(`({ disabled: document.getElementById('auto-start').disabled, note: document.getElementById('auto-start-note').textContent })`);
    const expected = appSettings().autoStart.available;
    check('설정: Windows 시작 시 자동 실행 (설치판에서만 켤 수 있음)', auto.disabled === !expected && (expected || /설치한 메모킹/.test(auto.note)), JSON.stringify(auto));
    await capture(lw, 'smoke-settings.png');
    // 전역 단축키 바꾸기: 키 단추 → 새 조합을 누르면 저장(다른 앱이 쓰는 키면 그대로 두고 알림) · 같은 키는 거절 · 기본값으로
    {
      const press = async (keyCode, modifiers = []) => {
        lw.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        lw.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        await wait(250);
      };
      const label0 = await js(lw, `document.getElementById('sc-magic').textContent`);
      await js(lw, `document.getElementById('sc-magic').click()`);
      await wait(250);
      const asking = await js(lw, `document.getElementById('sc-magic').classList.contains('capturing')`);
      await press('M', ['control', 'alt']);
      const after = await js(lw, `({ label: document.getElementById('sc-magic').textContent, note: document.getElementById('sc-magic-note').textContent })`);
      const saved = appSettings().shortcuts.magic;
      // 이 점검 환경은 전역 단축키를 잡을 수 없어(위 "전역 등록" 점검) "다른 앱이 쓰는 중" 으로 남을 수 있다 — 둘 다 맞는 결과
      const changed = saved.key === 'Control+Alt+M' && after.label === 'Ctrl+Alt+M' && /키로 바꿨어요/.test(after.note);
      const refused = saved.key === 'Control+Alt+Space' && /다른 앱이 이미 쓰고/.test(after.note);
      check('단축키 바꾸기: 키 단추 → 새 조합 → 바뀜(또는 다른 앱이 쓰면 그대로 두고 알림)', label0 === 'Ctrl+Alt+Space' && asking && (changed || refused), JSON.stringify({ label0, asking, after, saved: saved.key }));
      await js(lw, `document.getElementById('sc-magic').click()`);
      await wait(250);
      await press('C', ['control', 'alt']);
      const sameNote = await js(lw, `document.getElementById('sc-magic-note').textContent`);
      check('단축키 바꾸기: 빠른 메모와 같은 키는 거절', /빠른 메모와 같은 키/.test(sameNote), sameNote);
      await js(lw, `document.getElementById('sc-magic').click()`);
      await wait(250);
      await press('C', ['control']);
      const reservedNote = await js(lw, `document.getElementById('sc-magic-note').textContent`);
      await press('Escape');
      check('단축키 바꾸기: 복사(Ctrl+C) 같은 흔한 키는 거절 · Esc 로 그만', /늘 쓰는 키/.test(reservedNote) && !(await js(lw, `document.getElementById('sc-magic').classList.contains('capturing')`)), reservedNote);
      if (changed) {
        await js(lw, `document.getElementById('sc-magic-reset').click()`);
        await until(() => appSettings().shortcuts.magic.key === 'Control+Alt+Space', '기본값으로').catch(() => {});
      }
      check('단축키: 기본값으로 되돌리기', appSettings().shortcuts.magic.key === 'Control+Alt+Space');
      // 다른 앱이 이미 잡고 있는 키 (점검에서는 먼저 잡아 두어 흉내) → 바꾸지 않고 "다른 앱이 이미 쓰고 있어요"
      if (globalShortcut.register('Control+Alt+J', () => {})) {
        await js(lw, `document.getElementById('sc-magic').click()`);
        await wait(250);
        await press('J', ['control', 'alt']);
        const takenNote = await js(lw, `document.getElementById('sc-magic-note').textContent`);
        globalShortcut.unregister('Control+Alt+J');
        check('단축키 바꾸기: 다른 앱이 쓰는 키면 바꾸지 않고 알림', appSettings().shortcuts.magic.key === 'Control+Alt+Space' && /다른 앱이 이미 쓰고/.test(takenNote), takenNote);
      }
    }
    // AI 비서 연결 (MCP): 연결 → Claude 설정 파일에 메모킹이 적힘(다른 서버는 그대로) → 적힌 명령으로 띄우면 도구가 보임 → 끊기
    {
      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-claude-'));
      const cfg = path.join(cfgDir, 'claude_desktop_config.json');
      fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
      process.env.MEMOKING_CLAUDE_CONFIG = cfg;
      await listJs(`document.getElementById('settings-dialog').close()`);
      await listJs(`document.getElementById('settings-btn').click()`);
      await wait(300);
      await listJs(`document.getElementById('mcp-connect').click()`);
      const written = await until(() => {
        try {
          return JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers?.memoking ?? null;
        } catch {
          return null;
        }
      }, 'MCP 연결').catch(() => null);
      const kept = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      const title = await listJs(`document.getElementById('mcp-title').textContent`);
      check('AI 비서 연결: Claude 설정 파일에 메모킹 (다른 서버·설정은 그대로) · 연결됨 표시',
        Boolean(written) && kept.mcpServers.other?.command === 'x' && kept.theme === 'dark' && written.env?.ELECTRON_RUN_AS_NODE === '1' && /연결됨/.test(title), JSON.stringify({ written, title }));
      // 적힌 명령 그대로 띄워 MCP 로 묻기 (initialize → tools/list)
      const { spawn } = await import('node:child_process');
      const tools = await new Promise((resolve) => {
        const child = spawn(written.command, written.args, { env: { ...process.env, ...written.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill(); resolve(`시간 초과: ${out}`); }, 15000);
        child.stdout.on('data', (d) => {
          out += d;
          const line = out.split('\n').find((l) => l.includes('"id":2'));
          if (line) {
            clearTimeout(timer);
            child.kill();
            resolve(JSON.parse(line).result?.tools?.map((t) => t.name) ?? line);
          }
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      });
      check('AI 비서 연결: 적힌 명령으로 띄우면 메모킹 도구 (찾기·읽기·남기기·덧붙이기)',
        Array.isArray(tools) && ['search_memos', 'read_memo', 'create_memo', 'append_to_memo'].every((t) => tools.includes(t)), JSON.stringify(tools).slice(0, 300));
      await listJs(`document.getElementById('mcp-box').scrollIntoView({ block: 'center' })`);
      await capture(lw, 'smoke-settings-mcp.png');
      await listJs(`document.getElementById('mcp-disconnect').click()`);
      const removed = await until(() => !JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers?.memoking, 'MCP 끊기').catch(() => false);
      check('AI 비서 연결: 끊으면 메모킹만 빠짐', removed && JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers.other?.command === 'x');
      delete process.env.MEMOKING_CLAUDE_CONFIG;
    }
    await js(lw, `(() => { const d = document.getElementById('settings-dialog'); d.scrollTop = d.scrollHeight / 2 - 120; })()`);
    await capture(lw, 'smoke-settings-2.png');
    await js(lw, `(() => { const d = document.getElementById('settings-dialog'); d.scrollTop = d.scrollHeight; })()`);
    await capture(lw, 'smoke-settings-3.png');
    await js(lw, `document.getElementById('settings-dialog').scrollTop = 0`);
    await listJs(`document.getElementById('settings-dialog').close()`);
    await listJs(`document.querySelector('[data-tab="memos"]').click()`);

    // 17) 빠른 메모 단축키 등록 확인 — 점검 중 사용자의 Ctrl+Alt+C 를 붙잡지 않도록 바로 해제
    const registered = registerQuickMemoKey();
    // 설치된 메모킹이 켜져 있으면 그쪽이 단축키를 쓰고 있으므로 등록 확인은 건너뛴다
    const otherRunning = !registered && process.platform === 'win32' && execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='MemoKing.exe'\" | ForEach-Object { $_.ExecutablePath }"], { encoding: 'utf8' })
      .split(/\r?\n/).map((p) => p.trim().toLowerCase()).filter(Boolean)
      .some((p) => p !== process.execPath.toLowerCase());
    if (process.platform === 'win32') {
      check(otherRunning ? '빠른 메모 단축키 등록 — 건너뜀: 설치된 메모킹이 실행 중이라 이미 사용 중' : '빠른 메모 단축키 Ctrl+Alt+C 전역 등록',
        otherRunning || (registered && appSettings().quickMemo.registered));
    } else {
      // 빠른 메모(화면 글 가져오기)는 Windows 전용 — 다른 운영체제에서는 키를 잡지 않아야 다른 앱의 Ctrl+Alt+C 를 빼앗지 않는다
      check('빠른 메모 단축키: Windows 가 아니면 등록하지 않음 (다른 앱 키를 빼앗지 않음)',
        !registered && !appSettings().quickMemo.registered && !globalShortcut.isRegistered('Control+Alt+C'));
    }
    globalShortcut.unregister('Control+Alt+C');

    // 13) 실제 시스템 클립보드 붙여넣기 — 클립보드를 바꾸므로 npm run smoke:clipboard 에서만
    if (process.argv.includes('--clipboard')) {
      const { runClipboardChecks } = await import('./smoke-clipboard.js');
      const md = await runClipboardChecks({
        list: getList(), newNote, closeNote, js, until, wait, key, readMemo, check, capture,
        vaultDir: VAULT, workDir: path.join(SMOKE_DIR, 'clipboard-files'), iconPng: ICON_PNG, imageBase: base, quickMemo, noteWins,
        smokeToasts, ready, getCapturePoint,
      });
      fs.writeFileSync(path.join(OUT, 'smoke-clipboard.md'), md);
    }

    // 점검용 웹 서버의 "없는 사진"을 화면이 불러오다 생기는 네트워크 오류는 예상된 것
    const unexpected = errors.filter((m) => !/^Failed to load resource: the server responded with a status of 404/.test(m));
    check('콘솔 오류 없음', unexpected.length === 0, unexpected.join(' / '));
    exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } catch (err) {
    check('점검 실행', false, err.stack);
  }

  for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name}${c.detail && !c.ok ? `\n    ${c.detail}` : ''}`);
  console.log(exitCode === 0 ? `자동 점검 통과 (${checks.length}개)` : '자동 점검 실패');
  imageServer?.close();
  app.exit(exitCode);
}
