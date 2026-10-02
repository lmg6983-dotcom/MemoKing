// 매직키 파일 검색 — 따로 설치할 것 없이 메모킹이 파일·폴더 이름 목록을 직접 만들어 두고(이 PC 안에서만),
// 오픈소스 fuzzysort(MIT)로 타자를 칠 때마다 바로 찾는다 (Everything 처럼, 철자가 조금 달라도).
//   - 찾는 곳: 시작 메뉴 프로그램(바로 가기) → 사용자 폴더 → 다른 드라이브. 시스템·프로그램 폴더, 숨김(. $), node_modules 등은 뺀다
//   - 처음 한 번 목록을 만들고(뒤에서 조용히), 그 뒤로는 저장해 둔 목록으로 바로 찾으며 주기적으로 새로 고친다
//   - 파일 이름만 모은다 (내용은 읽지 않음). 목록은 설정 폴더의 file-index.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fuzzysort from '../app/vendor/fuzzysort.js';

export const MAX_ENTRIES = 400_000;
const SKIP = new Set([
  'node_modules', '__pycache__', 'appdata', 'application data', 'local settings', 'temp', 'tmp', 'cache', 'caches',
  'windows', 'program files', 'program files (x86)', 'programdata', 'users', 'recovery', 'perflogs', 'msocache',
  'system volume information', 'config.msi', 'onedrivetemp', 'site-packages', 'venv', '.venv',
]);

// 이 이름의 폴더는 들어가지 않는다 (숨김 . $ 로 시작하는 것도)
export const skipDir = (name) => name.startsWith('.') || name.startsWith('$') || name.startsWith('~') || SKIP.has(name.toLowerCase());

/**
 * 찾을 곳 (앞의 것부터 — 목록이 MAX_ENTRIES 에 차면 뒤의 것은 덜 들어간다)
 * @returns {{ dir: string, app?: boolean, top?: boolean }[]} app = 프로그램 바로 가기, top = 드라이브 맨 위
 */
export function defaultRoots({ platform = process.platform, home = os.homedir(), env = process.env, exists = fs.existsSync } = {}) {
  const roots = [];
  const join = platform === 'win32' ? path.win32.join : path.join;
  if (platform === 'win32') {
    if (env.APPDATA) roots.push({ dir: join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), app: true });
    if (env.ProgramData) roots.push({ dir: join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), app: true });
  }
  roots.push({ dir: home });
  if (platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`;
      if (exists(root)) roots.push({ dir: root, top: true });
    }
  }
  return roots.filter((r) => exists(r.dir));
}

const pause = () => new Promise((r) => setImmediate(r));

export class FileIndex {
  /** @param {{ cacheFile?: string, roots?: () => ReturnType<typeof defaultRoots>, maxEntries?: number, refreshMs?: number }} options */
  constructor({ cacheFile = '', roots = defaultRoots, maxEntries = MAX_ENTRIES, refreshMs = 30 * 60_000 } = {}) {
    Object.assign(this, { cacheFile, rootsFn: roots, maxEntries, refreshMs });
    this.entries = []; // { n: 이름, p: 전체 경로, d: 폴더인가, a: 프로그램 바로 가기, depth }
    this.snapshot = null;
    this.builtAt = 0;
    this.building = null;
    this.timer = null;
    this.stopped = true;
  }

  get count() {
    return this.entries.length;
  }

  status() {
    return { count: this.entries.length, builtAt: this.builtAt, building: Boolean(this.building) };
  }

  // 저장해 둔 목록 불러오기 → 바로 찾을 수 있게. 오래됐으면 뒤에서 새로 만든다
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.entries.length) this.load();
    if (Date.now() - this.builtAt > 10 * 60_000) this.rebuild();
    this.timer = setInterval(() => this.rebuild(), this.refreshMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  // 매직키를 열 때: 10분 넘게 지났으면 새로 고친다
  touch() {
    if (!this.stopped && !this.building && Date.now() - this.builtAt > 10 * 60_000) this.rebuild();
  }

  load() {
    if (!this.cacheFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (!Array.isArray(data.dirs) || !Array.isArray(data.files)) return;
      const entries = [];
      for (const [n, di, flags] of data.files) {
        const dir = data.dirs[di];
        if (dir == null) continue;
        entries.push({ n, p: path.join(dir, n), d: Boolean(flags & 1), a: Boolean(flags & 2), depth: data.depths?.[di] ?? 0 });
      }
      this.use(entries, data.at ?? 0);
    } catch {
      // 처음이거나 망가졌으면 새로 만든다
    }
  }

  save() {
    if (!this.cacheFile) return;
    const dirs = [];
    const depths = [];
    const dirIndex = new Map();
    const files = this.entries.map((e) => {
      const dir = path.dirname(e.p);
      let i = dirIndex.get(dir);
      if (i == null) {
        i = dirs.push(dir) - 1;
        depths.push(e.depth);
        dirIndex.set(dir, i);
      }
      return [e.n, i, (e.d ? 1 : 0) | (e.a ? 2 : 0)];
    });
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: this.builtAt, dirs, depths, files }));
      fs.renameSync(tmp, this.cacheFile);
    } catch {
      // 저장 못 해도 지금은 쓸 수 있다
    }
  }

  // 찾기용으로 이름을 소문자로만 따로 들고 있는다 (300k 개를 미리 다듬어 두면 메모리를 많이 써서, 후보만 다듬는다)
  use(entries, at) {
    this.entries = entries;
    this.lower = entries.map((e) => e.n.toLowerCase());
    this.snapshot = entries.length ? true : null;
    this.builtAt = at;
  }

  rebuild() {
    this.building ??= this.crawl()
      .then((entries) => {
        if (entries) {
          this.use(entries, Date.now());
          this.save();
        }
      })
      .catch(() => {})
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  // 넓이 우선으로 (얕은 곳부터) 훑는다. 폴더 200개마다 쉬어 앱이 멈추지 않게
  async crawl() {
    const entries = [];
    const seen = new Set();
    let dirsRead = 0;
    for (const root of this.rootsFn()) {
      const queue = [{ dir: root.dir, depth: 0 }];
      while (queue.length) {
        if (this.stopped || entries.length >= this.maxEntries) return entries;
        const { dir, depth } = queue.shift();
        const key = dir.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        let list;
        try {
          list = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          continue; // 권한 없음 등
        }
        for (const ent of list) {
          if (entries.length >= this.maxEntries) break;
          const isDir = ent.isDirectory();
          if (ent.isSymbolicLink()) continue;
          if (!isDir && !ent.isFile()) continue;
          // 드라이브 맨 위·홈의 숨김·시스템 파일은 빼고, 폴더는 들어갈 곳만
          if (isDir && skipDir(ent.name)) continue;
          if (!isDir && (ent.name.startsWith('~$') || /^(desktop\.ini|thumbs\.db|ntuser\..*)$/i.test(ent.name))) continue;
          const full = path.join(dir, ent.name);
          entries.push({ n: ent.name, p: full, d: isDir, a: Boolean(root.app) && !isDir, depth });
          if (isDir) queue.push({ dir: full, depth: depth + 1 });
        }
        if (++dirsRead % 200 === 0) await pause();
      }
    }
    return entries;
  }

  /**
   * 이름으로 찾기 (철자가 조금 달라도, 띄어 쓴 낱말은 모두 들어간 것). 프로그램 바로 가기·얕은 곳을 조금 앞으로
   * @returns {{ name: string, path: string, isDir: boolean, app: boolean }[]}
   */
  search(query, limit = 8) {
    const q = String(query ?? '').trim();
    if (!q || !this.snapshot) return [];
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    // 1) 빠른 거르기: 낱말마다 글자들이 이름에 순서대로 들어 있는가 (붙어 있으면 더 앞으로)
    const contiguous = [];
    const loose = [];
    const { lower } = this;
    for (let i = 0; i < lower.length; i++) {
      const name = lower[i];
      let all = true;
      let whole = true;
      for (const t of terms) {
        if (name.includes(t)) continue;
        whole = false;
        let at = 0;
        for (let k = 0; k < t.length; k++) {
          const j = name.indexOf(t[k], at);
          if (j < 0) {
            at = -1;
            break;
          }
          at = j + 1;
        }
        if (at < 0) {
          all = false;
          break;
        }
      }
      if (!all) continue;
      if (whole) contiguous.push(i);
      else if (loose.length < 4000) loose.push(i);
      if (contiguous.length >= 4000) break;
    }
    // 2) 후보만 fuzzysort 로 점수 (프로그램 바로 가기·이름이 찾는 말로 시작·얕은 곳을 조금 앞으로)
    const ql = q.toLowerCase();
    const scored = [];
    for (const i of [...contiguous, ...loose].slice(0, 6000)) {
      const e = this.entries[i];
      const r = fuzzysort.single(q, e.n);
      if (!r) continue;
      const bonus = (e.a ? 0.12 : 0) + (this.lower[i].startsWith(ql) ? 0.08 : 0) - Math.min(0.15, (e.depth ?? 0) * 0.012);
      scored.push({ e, score: r.score * (1 + bonus) });
    }
    scored.sort((a, b) => b.score - a.score);
    const out = [];
    const seenPath = new Set();
    for (const { e } of scored) {
      const p = e.p.toLowerCase();
      if (seenPath.has(p)) continue;
      seenPath.add(p);
      out.push({ name: e.a ? e.n.replace(/\.(lnk|url)$/i, '') : e.n, path: e.p, isDir: e.d, app: e.a });
      if (out.length >= limit) break;
    }
    return out;
  }
}
