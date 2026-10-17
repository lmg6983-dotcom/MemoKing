// Google Drive 동기화 관리 (데스크탑) — 메모 폴더(이 PC)를 고른 Drive 폴더와 맞춘다.
// 언제: 켤 때, 메모를 고친 뒤 몇 초, 1분마다, 절전에서 깨어났을 때, "지금 동기화".
// 기준 기록(state)은 이 PC 에만: %APPDATA%\MemoKing\drive\<Drive 폴더 id>.json
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { SyncEngine, skipName, skipPath } from './sync-engine.js';

const INTERVAL = 60_000;
export const DOUBLE_SYNC = '메모 폴더를 Google Drive 데스크탑 앱도 동기화하고 있어서 메모킹 동기화를 멈췄어요 (같은 메모가 계속 늘어나지 않게). '
  + '설정 › Google Drive 동기화 › "다른 폴더로 바꾸기" 에서 폴더를 다시 고르면 메모를 문서\\메모킹 으로 옮겨 맞춰요';
// 진행 상황은 이만큼마다 한 번만 알린다 (파일마다 창에 보내면 목록이 바빠진다)
const PROGRESS_MS = 300;

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
    // progress: 동기화하는 중일 때만 { phase: 'scan'|'transfer', done, total, since } (since: 파일 맞추기를 시작한 때 — 남은 시간 어림)
    this.status = { state: 'off', lastSync: 0, error: '', changed: false, conflicts: [], progress: null };
    this.timer = null;
    this.pending = null;
    this.running = null;
    this.again = false;
  }

  get active() {
    return Boolean(this.config?.folderId && this.config?.root);
  }

  /** 메모 폴더를 Google Drive 데스크탑 앱도 맞추고 있어 메모킹 동기화를 멈춘 상태인가 */
  get blocked() {
    return this.active && insideDriveForDesktop(this.config.root);
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
    // 메모 폴더가 Google Drive 데스크탑 앱이 맞추는 폴더(G:\내 드라이브 …) 안이면 멈춘다 —
    //   두 동기화가 같은 파일을 서로 올리고 받으며 "(PC 충돌 …)" · "(1)" 사본이 끝없이 늘 수 있다
    if (this.blocked) {
      this.publish({ state: 'error', error: DOUBLE_SYNC });
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

  /** 지금 바로 — 이미 도는 중이면 끝난 뒤 한 번 더. full: Drive 폴더를 처음부터 훑는다 ("지금 동기화" 단추) */
  async run({ full = false } = {}) {
    if (this.running) {
      // 지금 도는 것이 끝나면 처음부터 — 그사이 여러 번 눌러도 한 번만
      if (full) {
        this.fullQueued ??= this.running.catch(() => {}).then(() => {
          this.fullQueued = null;
          return this.run({ full: true });
        });
        return this.fullQueued;
      }
      this.again = true;
      return this.running;
    }
    this.running = this.runOnce({ full }).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.request(500);
      }
    });
    return this.running;
  }

  async runOnce({ full = false } = {}) {
    if (this.blocked) {
      this.publish({ state: 'error', error: DOUBLE_SYNC });
      return this.status;
    }
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
    // 권한이 Drive 전체 → drive.file 로 줄었으면 다른 앱이 넣은 파일이 목록에서 사라져 보인다 —
    //   "Drive 에서 지움" 으로 이 PC 의 메모를 지우지 않고 메모킹 파일로 다시 올린다 (한 번 다 끝낼 때까지)
    const scope = this.auth.grantedFull ? 'full' : 'file';
    if (state.scope === 'full' && scope === 'file') state.keepMissing = true;
    state.scope = scope;
    this.publish({ state: 'syncing', changed: false, conflicts: [], progress: { phase: 'scan', done: 0, total: 0, since: Date.now() } });
    let lastSent = 0;
    const onProgress = ({ phase, done, total }) => {
      const prev = this.status.progress;
      const since = phase === 'transfer' && prev?.phase !== 'transfer' ? Date.now() : prev?.since ?? Date.now();
      this.status = { ...this.status, progress: { phase, done, total, since } };
      // 처음 · 마지막 · 단계가 바뀔 때는 바로, 그 사이는 가끔
      if (done === 0 || done === total || prev?.phase !== phase || Date.now() - lastSent >= PROGRESS_MS) {
        lastSent = Date.now();
        this.emit('status', this.status);
      }
    };
    const save = () => {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
      fs.renameSync(`${file}.tmp`, file);
    };
    try {
      fs.mkdirSync(root, { recursive: true });
      const result = await new SyncEngine({ root, remote: this.api, rootId: folderId, state, onProgress }).run({ full });
      save();
      if (!this.auth.email) this.api.about().then((email) => email && this.auth.setEmail(email)).catch(() => {});
      this.publish({ state: 'idle', lastSync: Date.now(), error: '', changed: result.localChanged, conflicts: result.conflicts, progress: null,
        moved: result.uploaded + result.downloaded + result.deletedLocal + result.deletedRemote }); // moved: 이번에 맞춘 파일 수
    } catch (err) {
      save(); // 끝낸 파일들의 기준은 남긴다 (다음 차례는 남은 것만)
      console.warn('[Google Drive 동기화]', err);
      const offline = /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET|net::/i.test(`${err?.message} ${err?.cause?.code ?? ''}`);
      this.publish({ state: 'error', progress: null, error: offline ? '인터넷에 연결되지 않아 동기화하지 못했어요' : err.message || '동기화하지 못했어요' });
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

/**
 * 메모 폴더를 다른 곳으로 옮겨 맞출 때 (Google Drive 데스크탑 앱 폴더 → 문서\메모킹): 원래 폴더의 메모·첨부를 복사한다.
 * 원래 폴더는 그대로 두고, 새 폴더에 같은 이름이 이미 있으면 건드리지 않는다 (동기화 기록·임시 파일은 빼고).
 * @returns {number} 복사한 파일 수
 */
export function copyVault(from, to) {
  let copied = 0;
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(from, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skipName(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !skipPath(r)) {
        const dest = path.join(to, r);
        if (fs.existsSync(dest)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(from, r), dest);
        const st = fs.statSync(path.join(from, r));
        fs.utimesSync(dest, st.atime, st.mtime); // 고친 시각을 그대로 (목록 순서·충돌 판정이 바뀌지 않게)
        copied++;
      }
    }
  };
  if (path.resolve(from) !== path.resolve(to)) walk('');
  return copied;
}
