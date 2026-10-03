// 알림 보관함 (갤럭시 NotiStar 처럼) — Windows 알림 센터에서 지워져도 기록을 남긴다.
//
// Windows 는 알림 센터의 알림을 wpndatabase.db(SQLite)에 두다가 지우면 없앤다.
// 15초마다 그 파일의 "복사본"을 읽어(원본은 건드리지 않음) 새 토스트 알림을 기록한다.
// 기록은 이 PC 에만 (%APPDATA%\MemoKing\notification-history) — 메모 폴더(Google Drive)로 동기화하지 않는다.
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileTimeToMs, parseToastXml, fallbackAppName, matchesQuery } from '../app/js/core/notifications.js';

const MAX_ENTRIES = 10_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const WINDOWS_NOTIFICATION_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications');

export class NotificationHistory extends EventEmitter {
  /**
   * @param {{ dir: string, sourceDir?: string, selfAppId?: string, interval?: number }} options
   *   sourceDir: 알림 DB 가 있는 폴더 (점검 때는 가짜 DB 폴더)
   */
  constructor({ dir, sourceDir = WINDOWS_NOTIFICATION_DIR, selfAppId = '', interval = 15_000 }) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'history.json');
    this.imageDir = path.join(dir, 'images');
    this.sourceDir = sourceDir;
    this.selfAppId = selfAppId;
    this.interval = interval;
    this.state = { lastArrival: '0', entries: [] };
    this.appNames = new Map();
    this.blocked = new Set(); // 모으지 않을 앱 id (사용자가 고름)
    this.timer = null;
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data.entries)) this.state = { lastArrival: String(data.lastArrival ?? '0'), entries: data.entries };
    } catch {
      // 처음
    }
  }

  save(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, 500);
  }

  // ---------- 기록 ----------

  add(entry) {
    const item = {
      id: entry.id ?? `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      source: entry.source ?? 'windows',
      appId: entry.appId ?? '',
      app: entry.app ?? fallbackAppName(entry.appId),
      title: entry.title ?? '',
      body: entry.body ?? '',
      time: entry.time ?? new Date().toISOString(),
      image: entry.image ?? null,
      memoId: entry.memoId ?? null,
    };
    if (this.blocked.has(item.appId) && item.source !== 'memoking') return null;
    if (this.state.entries.some((e) => e.id === item.id)) return null;
    this.state.entries.unshift(item);
    this.state.entries.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    for (const old of this.state.entries.splice(MAX_ENTRIES)) this.removeImage(old);
    this.save();
    this.emit('changed');
    return item;
  }

  list({ query = '', app = '' } = {}) {
    return this.state.entries.filter((e) => (!app || e.app === app) && matchesQuery(e, query));
  }

  /** 모으지 않을 앱 id 들 */
  setBlocked(ids) {
    this.blocked = new Set(ids);
  }

  /** 이 앱의 알림을 모두 지운다 (메모킹 자신의 알림은 남김). 지운 개수 */
  removeApp(appId) {
    const keep = [];
    let removed = 0;
    for (const e of this.state.entries) {
      if (e.appId === appId && e.source !== 'memoking') {
        this.removeImage(e);
        removed++;
      } else keep.push(e);
    }
    if (!removed) return 0;
    this.state.entries = keep;
    this.save();
    this.emit('changed');
    return removed;
  }

  /** 앱 id 별 이름·개수 (모을 앱 고르기용, 많은 순) */
  appList() {
    const apps = new Map();
    for (const e of this.state.entries) {
      if (e.source === 'memoking') continue;
      const a = apps.get(e.appId) ?? { appId: e.appId, app: e.app, count: 0 };
      a.count++;
      apps.set(e.appId, a);
    }
    return [...apps.values()].sort((a, b) => b.count - a.count);
  }

  // 앱별 개수 (거르기 단추용, 많은 순)
  apps() {
    const counts = new Map();
    for (const e of this.state.entries) counts.set(e.app, (counts.get(e.app) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }

  get(id) {
    return this.state.entries.find((e) => e.id === id) ?? null;
  }

  remove(id) {
    const i = this.state.entries.findIndex((e) => e.id === id);
    if (i === -1) return false;
    this.removeImage(this.state.entries[i]);
    this.state.entries.splice(i, 1);
    this.save();
    this.emit('changed');
    return true;
  }

  clear() {
    this.state.entries = [];
    fs.rmSync(this.imageDir, { recursive: true, force: true });
    this.save();
    this.emit('changed');
  }

  removeImage(entry) {
    if (entry?.image) fs.rmSync(path.join(this.imageDir, entry.image), { force: true });
  }

  resolveImage(name) {
    const file = path.join(this.imageDir, path.basename(String(name)));
    return fs.existsSync(file) ? file : null;
  }

  // ---------- Windows 알림 모으기 ----------

  start() {
    if (this.timer) return;
    this.loadAppNames();
    this.poll();
    this.timer = setInterval(() => this.poll(), this.interval);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return Boolean(this.timer);
  }

  // 시작 메뉴의 앱 이름 (앱 id → "카카오톡" 등). 한 번만 불러 둔다.
  loadAppNames() {
    if (process.platform !== 'win32' || this.appNamesLoaded) return;
    this.appNamesLoaded = true;
    const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | ForEach-Object { "$($_.AppID)`t$($_.Name)" }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (err, out) => {
      if (err) return;
      for (const line of out.split(/\r?\n/)) {
        const [id, name] = line.split('\t');
        if (id && name) this.appNames.set(id.trim().toLowerCase(), name.trim());
      }
      // 이미 기록된 것 중 이름을 몰랐던 것 고치기
      let fixed = false;
      for (const e of this.state.entries) {
        const name = this.appNames.get(e.appId.toLowerCase());
        if (name && e.app !== name) {
          e.app = name;
          fixed = true;
        }
      }
      if (fixed) {
        this.save();
        this.emit('changed');
      }
    });
  }

  appName(appId) {
    return this.appNames.get(String(appId).toLowerCase()) ?? fallbackAppName(appId);
  }

  // 알림 DB 복사본에서 지난번 이후 새 토스트를 읽는다
  poll() {
    let tmp = null;
    try {
      const db = path.join(this.sourceDir, 'wpndatabase.db');
      if (!fs.existsSync(db)) return 0;
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-wpn-'));
      for (const name of ['wpndatabase.db', 'wpndatabase.db-wal', 'wpndatabase.db-shm']) {
        const src = path.join(this.sourceDir, name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, name));
      }
      return this.readCopy(path.join(tmp, 'wpndatabase.db'));
    } catch (err) {
      this.emit('error', err);
      return 0;
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  readCopy(file) {
    // Electron 에 들어 있는 SQLite (Node 내장 모듈) — 설치할 것 없음
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    let added = 0;
    try {
      const stmt = db.prepare(`
        select n.Id as id, n.Type as type, n.Payload as payload, n.ArrivalTime as arrival, h.PrimaryId as appId
        from Notification n join NotificationHandler h on h.RecordId = n.HandlerId
        where n.ArrivalTime > ? and n.Type in ('toast', 'toastCondensed')
        order by n.ArrivalTime asc`);
      stmt.setReadBigInts(true);
      let last = BigInt(this.state.lastArrival);
      for (const row of stmt.all(last)) {
        if (row.arrival > last) last = row.arrival;
        if (this.selfAppId && String(row.appId).toLowerCase() === this.selfAppId.toLowerCase()) continue; // 메모킹 자신은 따로 기록
        const toast = parseToastXml(Buffer.from(row.payload ?? []).toString('utf8'));
        if (!toast) continue;
        const entry = this.add({
          id: `w${row.id}-${row.arrival}`,
          source: 'windows',
          appId: String(row.appId),
          app: this.appName(row.appId),
          title: toast.title,
          body: toast.body,
          time: new Date(fileTimeToMs(row.arrival)).toISOString(),
          image: this.keepImage(toast.image),
        });
        if (entry) added++;
      }
      this.state.lastArrival = String(last);
      this.save();
    } finally {
      db.close();
    }
    return added;
  }

  // 알림의 그림(보낸 사람 사진 등)은 임시 폴더에 있다가 사라지므로 복사해 둔다
  keepImage(src) {
    if (!src) return null;
    try {
      const file = src.replace(/^file:\/\/\/?/i, '').replace(/\//g, path.sep);
      if (!path.isAbsolute(file) || !fs.existsSync(file)) return null;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
      const data = fs.readFileSync(file);
      const ext = (path.extname(file).toLowerCase().match(/^\.(png|jpe?g|gif|bmp|webp|ico)$/)?.[0]) ?? '.png';
      const name = `${createHash('sha1').update(data).digest('hex').slice(0, 16)}${ext}`;
      fs.mkdirSync(this.imageDir, { recursive: true });
      const dest = path.join(this.imageDir, name);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, data);
      return name;
    } catch {
      return null;
    }
  }
}
