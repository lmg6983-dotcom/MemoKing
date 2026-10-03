// 휴대폰 화면 미리보기 서버 — 안드로이드 기기 없이 PC 브라우저에서 화면을 확인·자동 점검할 때 쓴다.
//   node android/web/dev/server.mjs [메모 폴더] [--port 8790]
//   → http://localhost:8790/m/index.html  (크롬 개발자 도구의 휴대폰 보기로 열면 좋다)
// 앱(Kotlin Bridge.kt)이 하는 일을 이 서버가 대신한다: 메모 폴더 읽기·쓰기, 인터넷 받기, 임시 파일.
// 개발용이라 APK 에는 들어가지 않는다 (app/build.gradle.kts 의 exclude("dev/**")).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const appRoot = path.resolve(here, '../../../app');
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8790;
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
let vaultRoot = positional[0] ? path.resolve(positional[0]) : null; // 없으면 처음 화면(폴더 고르기)부터
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-dev-temp-'));
const log = [];

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', md: 'text/markdown; charset=utf-8',
};
const typeOf = (p) => TYPES[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream';

function inside(root, rel) {
  const parts = String(rel ?? '').split('/').filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new Error(`메모 폴더 밖 경로: ${rel}`);
  return path.join(root, ...parts);
}
const vaultPath = (rel) => {
  if (!vaultRoot) throw new Error('메모 폴더가 연결돼 있지 않아요');
  return inside(vaultRoot, rel);
};
const entry = (name, st) => ({ name, dir: st.isDirectory(), mtime: Math.floor(st.mtimeMs), size: st.isFile() ? st.size : 0 });

// ---------- Bridge.kt 의 바로 답하는 함수들 ----------

const sync = {
  info: () => ({
    version: '0.1.0-dev',
    sdk: 35,
    vault: vaultRoot ? { internal: false, drive: fakeDrive.active, label: fakeDrive.active ? `Google Drive › ${fakeDrive.folderName}` : vaultRoot, ok: true } : null,
    exactAlarms: true,
  }),
  useInternalVault: () => {
    vaultRoot = path.join(os.tmpdir(), 'memoking-dev-internal');
    fs.mkdirSync(vaultRoot, { recursive: true });
    return { internal: true, label: '이 휴대폰 안 (메모킹 앱)', ok: true };
  },
  scan: () => {
    const out = [];
    const walk = (dir, rel) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith('.') || d.name.startsWith('~$')) continue;
        if (!rel && (d.name === '_memoking' || d.name === 'attachments')) continue;
        const r = rel ? `${rel}/${d.name}` : d.name;
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) walk(abs, r);
        else if (d.name.toLowerCase().endsWith('.md')) {
          const st = fs.statSync(abs);
          out.push({ file: r, mtime: Math.floor(st.mtimeMs), size: st.size });
        }
      }
    };
    walk(vaultPath(''), '');
    return out;
  },
  list: (rel) => {
    const dir = vaultPath(rel);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((name) => entry(name, fs.statSync(path.join(dir, name))));
  },
  stat: (rel) => {
    const st = fs.statSync(vaultPath(rel), { throwIfNoEntry: false });
    return st ? entry(path.basename(rel), st) : null;
  },
  readText: (rel) => {
    const p = vaultPath(rel);
    const st = fs.statSync(p, { throwIfNoEntry: false });
    return st?.isFile() ? fs.readFileSync(p, 'utf8') : null;
  },
  writeText: (rel, text) => {
    const p = vaultPath(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return entry(path.basename(p), fs.statSync(p));
  },
  writeBase64: (rel, data) => {
    const p = vaultPath(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(data, 'base64'));
    return entry(path.basename(p), fs.statSync(p));
  },
  mkdirs: (rel) => {
    fs.mkdirSync(vaultPath(rel), { recursive: true });
    return null;
  },
  move: (from, to) => {
    const a = vaultPath(from);
    const b = vaultPath(to);
    if (!fs.existsSync(a) || fs.existsSync(b)) return false;
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return true;
  },
  remove: (rel) => {
    const p = vaultPath(rel);
    if (!fs.existsSync(p)) return false;
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  },
  commitTemp: (id, rel) => {
    const src = inside(tempDir, id);
    const p = vaultPath(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(src, p);
    fs.rmSync(src, { force: true });
    return entry(path.basename(p), fs.statSync(p));
  },
  readTempText: (id) => fs.readFileSync(inside(tempDir, id), 'utf8'),
  dropTemp: (id) => {
    fs.rmSync(inside(tempDir, id), { force: true });
    return true;
  },
  copyText: (text) => {
    log.push({ copyText: text });
    return true;
  },
  setChrome: (color, dark) => {
    log.push({ setChrome: [color, dark] });
    return null;
  },
  takeIntent: () => {
    const p = pendingIntent;
    pendingIntent = null;
    return p;
  },
  ready: () => null,
  scheduleAlarms: (json) => {
    scheduled = JSON.parse(json);
    log.push({ scheduleAlarms: scheduled.length });
    return null;
  },
  wasFired: () => false,
  driveStatus: () => driveInfo(),
  driveSetClient: (id, secret) => {
    fakeDrive.configured = Boolean(id && secret);
    return driveInfo();
  },
  driveDisconnect: () => {
    Object.assign(fakeDrive, { connected: false, email: '' });
    fakeDrive.status = { ...fakeDrive.status, state: 'off' };
    return driveInfo();
  },
  driveCancelLogin: () => null,
  driveSyncSoon: () => null,
  notify: (json) => {
    log.push({ notify: JSON.parse(json) });
    return true;
  },
};

// 가짜 Google Drive (화면 점검용) — 진짜 동기화는 앱(DriveSync.kt)이 한다
const fakeDrive = {
  configured: false, connected: false, email: '', active: false, folderId: '', folderName: '',
  status: { state: 'off', lastSync: 0, error: '', changed: false, conflicts: [] },
  folders: { root: [{ id: 'f-memo', name: '메모킹' }, { id: 'f-work', name: '업무' }, { id: 'f-photo', name: '사진' }], 'f-work': [{ id: 'f-work-2026', name: '2026' }] },
};
const driveInfo = () => ({ ...fakeDrive, builtIn: false, folders: undefined });
let pendingIntent = null;
let scheduled = [];
let pickQueue = []; // 점검용: 다음 pickFiles 가 돌려줄 파일들 [{ name, mime, base64 }]

function makeTemp(name, mime, bytes) {
  const id = randomUUID();
  fs.writeFileSync(path.join(tempDir, id), bytes);
  return { temp: id, name, mime, size: bytes.length };
}

// ---------- 오래 걸리는 일 ----------

const calls = {
  pickFolder: async () => {
    vaultRoot = path.join(os.tmpdir(), 'memoking-dev-vault');
    fs.mkdirSync(vaultRoot, { recursive: true });
    return { internal: false, label: vaultRoot, ok: true };
  },
  pickFiles: async () => {
    const files = pickQueue.map((f) => makeTemp(f.name, f.mime, Buffer.from(f.base64, 'base64')));
    pickQueue = [];
    return files;
  },
  openFile: async ({ rel }) => {
    log.push({ openFile: rel });
    return fs.existsSync(vaultPath(rel)) ? null : '이 휴대폰의 메모 폴더에 파일이 아직 없어요';
  },
  openUrl: async ({ url }) => {
    log.push({ openUrl: url });
    return true;
  },
  share: async (a) => {
    log.push({ share: a });
    return true;
  },
  print: async (a) => {
    log.push({ print: a });
    return true;
  },
  notifyPermission: async () => true,
  driveLogin: async () => {
    await new Promise((r) => setTimeout(r, 300));
    Object.assign(fakeDrive, { connected: true, email: 'me@gmail.com' });
    return { email: fakeDrive.email };
  },
  driveFolders: async ({ parent }) => fakeDrive.folders[parent] ?? [],
  driveCreateFolder: async ({ parent, name }) => {
    const f = { id: `f-${randomUUID().slice(0, 6)}`, name };
    (fakeDrive.folders[parent] ??= []).push(f);
    return f;
  },
  driveUse: async ({ folderId, name, import: importLocal }) => {
    const dir = path.join(os.tmpdir(), `memoking-dev-drive-${folderId}`);
    fs.mkdirSync(dir, { recursive: true });
    if (importLocal && vaultRoot) fs.cpSync(vaultRoot, dir, { recursive: true, force: false, errorOnExist: false });
    vaultRoot = dir;
    Object.assign(fakeDrive, { active: true, folderId, folderName: name });
    fakeDrive.status = { state: 'idle', lastSync: Date.now(), error: '', changed: false, conflicts: [] };
    log.push({ driveUse: { folderId, name, importLocal } });
    return { vault: { internal: false, drive: true, label: `Google Drive › ${name}`, ok: true }, status: fakeDrive.status };
  },
  driveSync: async () => {
    fakeDrive.status = { ...fakeDrive.status, state: 'idle', lastSync: Date.now() };
    return fakeDrive.status;
  },
  exactAlarmSettings: async () => true,
  http: async ({ url, accept = '*/*', limit = 5 * 1024 * 1024, save = false }) => {
    const res = await fetch(url, { headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) MemoKing-dev' }, redirect: 'follow' });
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    const result = { status: res.status, url: res.url || url, type };
    if (!res.ok) return result;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > limit && save) throw new Error('너무 큰 파일');
    if (save) return { ...result, ...makeTemp('download', type, bytes) };
    const cut = bytes.subarray(0, limit);
    return { ...result, latin1: cut.toString('latin1'), size: cut.length };
  },
};

// ---------- 서버 ----------

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

function serveFile(res, file, req) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { 'Content-Type': typeOf(file), 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': typeOf(file), 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'POST' && p === '/native/sync') {
      const { method, args: a } = JSON.parse(await readBody(req));
      let out;
      try {
        out = JSON.stringify({ v: sync[method](...a) ?? null });
      } catch (err) {
        out = JSON.stringify({ err: err.message });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(out);
      return;
    }
    if (req.method === 'POST' && p === '/native/call') {
      const { method, args: a } = JSON.parse(await readBody(req));
      let out;
      try {
        if (!calls[method]) throw new Error(`알 수 없는 기능: ${method}`);
        out = JSON.stringify({ v: (await calls[method](a)) ?? null });
      } catch (err) {
        out = JSON.stringify({ err: err.message });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(out);
      return;
    }
    // 점검 도구용: 공유하기 흉내, 고를 파일 미리 넣기, 기록 보기, 알림 이벤트
    if (req.method === 'POST' && p === '/dev/intent') {
      const payload = JSON.parse(await readBody(req));
      payload.files = (payload.files ?? []).map((f) => makeTemp(f.name, f.mime, Buffer.from(f.base64, 'base64')));
      pendingIntent = payload;
      res.writeHead(200).end('{}');
      return;
    }
    if (req.method === 'POST' && p === '/dev/pick') {
      pickQueue = JSON.parse(await readBody(req));
      res.writeHead(200).end('{}');
      return;
    }
    if (p === '/dev/log') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ log, scheduled, vaultRoot }));
      return;
    }
    if (p.startsWith('/vault/')) return serveFile(res, vaultPath(p.slice('/vault/'.length)), req);
    if (p.startsWith('/app/')) return serveFile(res, inside(appRoot, p.slice('/app/'.length)), req);
    if (p === '/m/index.html' || p === '/m/' || p === '/') {
      // 앱 대신 window.MemoKingNative 를 흉내 내는 스크립트를 먼저 넣는다
      const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8')
        .replace('<script type="module"', '<script src="dev/mock-native.js"></script>\n  <script type="module"');
      res.writeHead(200, { 'Content-Type': TYPES.html, 'Cache-Control': 'no-cache' }).end(html);
      return;
    }
    if (p.startsWith('/m/')) return serveFile(res, inside(webRoot, p.slice('/m/'.length)), req);
    res.writeHead(404).end();
  } catch (err) {
    res.writeHead(500).end(String(err?.message ?? err));
  }
});

server.listen(port, () => {
  console.log(`메모킹 휴대폰 화면 미리보기: http://localhost:${port}/m/index.html`);
  console.log(`메모 폴더: ${vaultRoot ?? '(처음 화면에서 고르기)'}`);
});
