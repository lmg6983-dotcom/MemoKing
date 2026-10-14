// 메모 폴더(이 PC) ↔ Google Drive 폴더 양방향 동기화 — 안드로이드 SyncEngine.kt 와 같은 규칙.
//
// 지난번 동기화 때의 모습(기준)을 기억해 두고, 파일마다 양쪽이 기준에서 바뀌었는지 보고 정한다:
//   한쪽만 바뀜 → 그쪽 것을 다른 쪽에 반영 (올리기·내려받기·지우기)
//   양쪽 다 바뀜 → 내용이 같으면 그대로, 다르면 Drive 것을 남기고 이 PC 것은 "(PC 충돌 …)" 사본으로
// Drive 에서 지울 때는 휴지통으로 보낸다. 한쪽에서 한꺼번에 많이 사라지면 아무것도 지우지 않고 멈춘다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const FOLDER = 'application/vnd.google-apps.folder';
// 기기마다 따로 만드는 파일 — 서로 덮어쓰며 충돌하지 않게 동기화하지 않는다
const LOCAL_ONLY = new Set(['_memoking/index.json']);
const MERGE_JSON = '_memoking/link-previews.json';
const MASS_DELETE_MIN = 20;
// 한 번에 이만큼 넘게 양쪽에서 엇갈리면 무언가 같은 폴더를 함께 맞추는 것 — 사본을 더 만들지 않고 멈춘다
const MASS_CONFLICT_MAX = 20;
// Drive 의 "바뀐 것" 목록만 믿으면 거기서 빠진 파일은 이 PC 에서 고칠 때까지 영영 내려오지 않으므로, 이만큼마다 폴더를 처음부터 훑는다
export const FULL_SCAN_MS = 15 * 60_000;

export class SafetyStop extends Error {}

export const skipName = (name) => name.startsWith('.') || name.startsWith('~$') || name.endsWith('.tmp') || name === 'desktop.ini' || name === 'Thumbs.db';
export const skipPath = (rel) => LOCAL_ONLY.has(rel) || rel.split('/').some(skipName);

export function md5File(file) {
  const hash = createHash('md5');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * @typedef {{ id: string, name: string, folder: boolean, md5: string|null, modified: number, size: number }} RemoteItem
 * @typedef {{
 *   listChildren(folderId: string): Promise<RemoteItem[]>,
 *   download(id: string, file: string): Promise<void>,
 *   upload(parentId: string, name: string, existingId: string|null, file: string): Promise<RemoteItem>,
 *   createFolder(parentId: string, name: string): Promise<RemoteItem>,
 *   trash(id: string): Promise<void>,
 *   changesSince(token: string|null, knownIds: Set<string>): Promise<{ changed: boolean, token: string }>,
 * }} Remote
 */
export class SyncEngine {
  /**
   * @param {{ root: string, remote: Remote, rootId: string, state: object, conflictTag?: string, now?: () => number }} options
   *   state: { pageToken, files: { 경로: { id, md5, lmtime, lsize } }, folders } — 동기화가 끝나면 바뀐 채로 저장한다
   */
  constructor({ root, remote, rootId, state, conflictTag = 'PC 충돌', now = Date.now }) {
    this.root = root;
    this.remote = remote;
    this.rootId = rootId;
    this.state = state;
    this.state.files ??= {};
    this.conflictTag = conflictTag;
    this.now = now;
    this.folderIds = new Map();
  }

  abs(rel) {
    return path.join(this.root, ...rel.split('/'));
  }

  stat(rel) {
    const st = fs.statSync(this.abs(rel), { throwIfNoEntry: false });
    return st?.isFile() ? { mtime: Math.floor(st.mtimeMs), size: st.size } : null;
  }

  record(rel, id, md5, l) {
    this.state.files[rel] = { id, md5, lmtime: l.mtime, lsize: l.size };
  }

  // ---------- 양쪽 둘러보기 ----------

  walkLocal() {
    const out = new Map();
    const walk = (dir, rel) => {
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of items) {
        if (skipName(d.name)) continue;
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(path.join(dir, d.name), r);
        else if (d.isFile() && !skipPath(r)) {
          const st = fs.statSync(path.join(dir, d.name));
          out.set(r, { mtime: Math.floor(st.mtimeMs), size: st.size });
        }
      }
    };
    walk(this.root, '');
    return out;
  }

  async walkRemote() {
    const out = new Map();
    this.folderIds.set('', this.rootId);
    const walk = async (folderId, dir) => {
      // Drive 는 한 폴더에 같은 이름을 여러 개 둘 수 있다 — 가장 최근 것만 쓴다
      const byName = new Map();
      for (const item of await this.remote.listChildren(folderId)) {
        const prev = byName.get(item.name);
        if (!prev || item.modified > prev.modified) byName.set(item.name, item);
      }
      for (const item of byName.values()) {
        if (skipName(item.name)) continue;
        const rel = dir ? `${dir}/${item.name}` : item.name;
        if (item.folder) {
          this.folderIds.set(rel, item.id);
          await walk(item.id, rel);
        } else if (item.md5 && !skipPath(rel)) out.set(rel, item); // md5 가 없는 것은 구글 문서 같은 Drive 전용 파일
      }
    };
    await walk(this.rootId, '');
    return out;
  }

  async ensureRemoteFolder(dir) {
    if (this.folderIds.has(dir)) return this.folderIds.get(dir);
    const parent = await this.ensureRemoteFolder(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
    const created = await this.remote.createFolder(parent, dir.slice(dir.lastIndexOf('/') + 1));
    this.folderIds.set(dir, created.id);
    return created.id;
  }

  // ---------- 동기화 ----------

  /** @param {{ full?: boolean }} [opts] full: "바뀐 것" 목록과 상관없이 Drive 폴더를 처음부터 훑는다 ("지금 동기화") */
  async run({ full = false } = {}) {
    const files = this.state.files;
    const local = this.walkLocal();
    const known = Object.keys(files);
    const localDirty = local.size !== known.length || [...local].some(([rel, l]) => {
      const b = files[rel];
      return !b || b.lmtime !== l.mtime || b.lsize !== l.size;
    });
    const knownIds = new Set([...known.map((k) => files[k].id), ...Object.values(this.state.folders ?? {}), this.rootId]);
    const { changed: remoteDirty, token } = await this.remote.changesSince(this.state.pageToken || null, knownIds);
    const scanDue = full || this.now() - (this.state.lastFullScan ?? 0) >= FULL_SCAN_MS;
    if (!localDirty && !remoteDirty && !scanDue) {
      this.state.pageToken = token;
      return { skipped: true, uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], localChanged: false };
    }

    const remote = await this.walkRemote();
    const paths = [...new Set([...local.keys(), ...remote.keys(), ...known])].sort();

    const goneRemote = paths.filter((p) => files[p] && !remote.has(p) && local.has(p)).length;
    const goneLocal = paths.filter((p) => files[p] && !local.has(p) && remote.has(p)).length;
    const keepMissing = this.state.keepMissing === true; // 권한이 줄어 안 보이게 된 파일: 지우지 않고 다시 올린다 (drive-sync.js)
    if (!keepMissing && goneRemote >= MASS_DELETE_MIN && goneRemote * 2 > known.length) {
      throw new SafetyStop(`Google Drive 폴더에서 파일 ${goneRemote}개가 한꺼번에 사라져서 동기화를 멈췄어요. 고른 폴더가 맞는지 확인해 주세요.`);
    }
    if (goneLocal >= MASS_DELETE_MIN && goneLocal * 2 > known.length) {
      throw new SafetyStop(`이 PC 메모 폴더에서 파일 ${goneLocal}개가 한꺼번에 사라져서 동기화를 멈췄어요.`);
    }

    // 양쪽에서 엇갈린 파일이 너무 많으면 아무것도 건드리기 전에 멈춘다 (도중에 멈추면 다음 차례마다 사본이 또 생긴다)
    const clashes = paths.filter((p) => {
      const l = local.get(p);
      const r = remote.get(p);
      const b = files[p];
      return p !== MERGE_JSON && l && r && (!b || b.lmtime !== l.mtime || b.lsize !== l.size) && (!b || b.md5 !== r.md5);
    });
    if (clashes.length > MASS_CONFLICT_MAX && clashes.filter((p) => md5File(this.abs(p)) !== remote.get(p).md5).length > MASS_CONFLICT_MAX) {
      throw new SafetyStop(`양쪽에서 엇갈린 메모가 ${MASS_CONFLICT_MAX}개를 넘어 동기화를 멈췄어요 (사본이 계속 늘어나지 않게). 메모 폴더를 Google Drive 데스크탑 앱 등 다른 동기화도 맞추고 있는지 확인해 주세요.`);
    }

    const result = { skipped: false, uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [] };

    const upload = async (rel, existingId) => {
      const before = this.stat(rel);
      if (!before) return;
      const parent = await this.ensureRemoteFolder(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
      const item = await this.remote.upload(parent, rel.slice(rel.lastIndexOf('/') + 1), existingId, this.abs(rel));
      this.record(rel, item.id, item.md5 ?? '', before);
      result.uploaded++;
    };

    // 내려받기는 임시 파일에 받아 바꿔치기. 둘러본 뒤 이 PC 에서 또 고쳤으면 이번에는 건드리지 않는다
    const download = async (rel, item, expect) => {
      const untouched = () => {
        const now = this.stat(rel);
        return expect ? Boolean(now) && now.mtime === expect.mtime && now.size === expect.size : !now;
      };
      if (!untouched()) return;
      const dest = this.abs(rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomBytes(3).toString('hex')}.tmp`);
      try {
        await this.remote.download(item.id, tmp);
        if (!untouched()) return; // 받는 사이 이 PC 에서 고쳤다 — 덮어쓰지 않고 다음 차례에
        fs.renameSync(tmp, dest);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      this.record(rel, item.id, item.md5 ?? '', this.stat(rel));
      result.downloaded++;
    };

    const conflictName = (rel) => {
      const d = new Date(this.now());
      const pad = (v) => String(v).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      const dot = name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
      for (let n = 1; ; n++) {
        const tag = n === 1 ? `${this.conflictTag} ${stamp}` : `${this.conflictTag} ${stamp} ${n}`;
        const candidate = `${name.slice(0, dot)} (${tag})${name.slice(dot)}`;
        const p = dir ? `${dir}/${candidate}` : candidate;
        if (!this.stat(p)) return p;
      }
    };

    // 양쪽에서 다르게 바뀐 파일: 링크 미리보기 모음은 합치고, 나머지는 Drive 것을 남기고 이 PC 것은 사본으로
    const conflict = async (rel, item) => {
      if (rel === MERGE_JSON) {
        let mine = {};
        let theirs = {};
        try {
          mine = JSON.parse(fs.readFileSync(this.abs(rel), 'utf8'));
        } catch {
          // 깨진 파일
        }
        const tmp = `${this.abs(rel)}.${randomBytes(3).toString('hex')}.tmp`;
        try {
          await this.remote.download(item.id, tmp);
          theirs = JSON.parse(fs.readFileSync(tmp, 'utf8'));
        } catch {
          // 받지 못함
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        fs.writeFileSync(this.abs(rel), JSON.stringify({ ...mine, ...theirs }, null, 1));
        await upload(rel, item.id);
        return;
      }
      const copy = conflictName(rel);
      fs.renameSync(this.abs(rel), this.abs(copy));
      result.conflicts.push(copy);
      await download(rel, item, null);
      await upload(copy, null);
    };

    for (const rel of paths) {
      const l = local.get(rel);
      const r = remote.get(rel);
      const b = files[rel];
      const localChanged = Boolean(l) && (!b || b.lmtime !== l.mtime || b.lsize !== l.size);
      const remoteChanged = Boolean(r) && (!b || b.md5 !== r.md5);
      try {
        if (l && r) {
          if (!localChanged && !remoteChanged) continue;
          if (localChanged && !remoteChanged) await upload(rel, r.id);
          else if (!localChanged && remoteChanged) await download(rel, r, l);
          else if (md5File(this.abs(rel)) === r.md5) this.record(rel, r.id, r.md5, this.stat(rel)); // 양쪽 같은 내용
          else await conflict(rel, r);
        } else if (l && !r) {
          if (!b || localChanged || keepMissing) await upload(rel, null); // 새 파일, 또는 Drive 에서 지웠지만 이 PC 에서 고침 → 되살림
          else {
            fs.rmSync(this.abs(rel), { force: true }); // 다른 기기에서 지움 → 이 PC 에서도
            result.deletedLocal++;
            delete files[rel];
          }
        } else if (!l && r) {
          if (!b || remoteChanged) await download(rel, r, null); // 새 파일, 또는 이 PC 에서 지웠지만 다른 기기에서 고침 → 되살림
          else {
            await this.remote.trash(r.id);
            result.deletedRemote++;
            delete files[rel];
          }
        } else delete files[rel]; // 양쪽 다 지움
      } catch (err) {
        if (err.code !== 'ENOENT') throw err; // 둘러보는 사이 없어진 파일은 다음 차례에
      }
    }

    this.state.pageToken = token;
    delete this.state.keepMissing; // 다 올렸으면 다음부터는 보통대로
    this.state.lastFullScan = this.now();
    this.state.folders = Object.fromEntries(this.folderIds);
    result.localChanged = result.downloaded > 0 || result.deletedLocal > 0 || result.conflicts.length > 0;
    return result;
  }
}
