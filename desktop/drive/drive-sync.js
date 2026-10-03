// Google Drive 동기화 관리 (데스크탑) — 메모 폴더(이 PC)를 고른 Drive 폴더와 맞춘다.
// 언제: 켤 때, 메모를 고친 뒤 몇 초, 1분마다, 절전에서 깨어났을 때, "지금 동기화".
// 기준 기록(state)은 이 PC 에만: %APPDATA%\MemoKing\drive\<Drive 폴더 id>.json
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { SyncEngine } from './sync-engine.js';

const INTERVAL = 60_000;

export class DriveSync extends EventEmitter {
  /**
   * @param {{ api: import('./drive-api.js').DriveApi, auth: import('./google-auth.js').GoogleAuth, stateDir: string }} options
   */
  constructor({ api, auth, stateDir }) {
    super();
    this.api = api;
    this.auth = auth;
    this.stateDir = stateDir;
    this.config = null; // { folderId, folderName, root }
    this.status = { state: 'off', lastSync: 0, error: '', changed: false, conflicts: [] };
    this.timer = null;
    this.pending = null;
    this.running = null;
    this.again = false;
  }

  get active() {
    return Boolean(this.config?.folderId && this.config?.root);
  }

  stateFile(folderId, root) {
    // 같은 Drive 폴더라도 이 PC 의 다른 폴더와 맞추면 기준이 달라진다
    const key = Buffer.from(path.resolve(root)).toString('base64url').slice(-40);
    return path.join(this.stateDir, `${folderId}.${key}.json`);
  }

  /** 맞출 Drive 폴더와 이 PC 의 메모 폴더 (null 이면 끔) */
  configure(config) {
    this.config = config?.folderId && config?.root ? config : null;
    clearInterval(this.timer);
    this.timer = null;
    if (!this.active) {
      this.publish({ state: 'off', error: '' });
      return;
    }
    this.timer = setInterval(() => this.request(), INTERVAL);
    this.timer.unref?.();
  }

  publish(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  /** 동기화를 부탁한다 (delayMs 안에 또 부탁하면 한 번으로) */
  request(delayMs = 0) {
    if (!this.active || !this.auth.connected) return;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.run().catch(() => {});
    }, delayMs);
  }

  /** 지금 바로 — 이미 도는 중이면 끝난 뒤 한 번 더 */
  async run() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.request(500);
      }
    });
    return this.running;
  }

  async runOnce() {
    if (!this.active) return this.status;
    if (!this.auth.connected) {
      this.publish({ state: 'error', error: 'Google Drive에 로그인해 주세요' });
      return this.status;
    }
    const { folderId, root } = this.config;
    const file = this.stateFile(folderId, root);
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // 처음
    }
    this.publish({ state: 'syncing', changed: false, conflicts: [] });
    const save = () => {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
      fs.renameSync(`${file}.tmp`, file);
    };
    try {
      fs.mkdirSync(root, { recursive: true });
      const result = await new SyncEngine({ root, remote: this.api, rootId: folderId, state }).run();
      save();
      if (!this.auth.email) this.api.about().then((email) => email && this.auth.setEmail(email)).catch(() => {});
      this.publish({ state: 'idle', lastSync: Date.now(), error: '', changed: result.localChanged, conflicts: result.conflicts });
    } catch (err) {
      save(); // 끝낸 파일들의 기준은 남긴다 (다음 차례는 남은 것만)
      console.warn('[Google Drive 동기화]', err);
      const offline = /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET|net::/i.test(`${err?.message} ${err?.cause?.code ?? ''}`);
      this.publish({ state: 'error', error: offline ? '인터넷에 연결되지 않아 동기화하지 못했어요' : err.message || '동기화하지 못했어요' });
    }
    return this.status;
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.pending);
    this.timer = null;
  }
}

// Google Drive 데스크탑 앱이 맞추는 폴더(G:\내 드라이브 …) 안이면, 앱으로 또 맞추면 두 번 동기화가 된다
export function insideDriveForDesktop(dir) {
  return /(^|[\\/])(내 드라이브|My Drive|Google Drive|공유 드라이브|Shared drives)([\\/]|$)/i.test(String(dir ?? ''));
}
