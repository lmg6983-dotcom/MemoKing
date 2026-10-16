// 메모 폴더(볼트) — 폴더 속 .md 파일들을 DB처럼 다룬다.
// 안드로이드에서는 이 파일만 Capacitor 파일 API 버전으로 바꾸면 된다.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  parseMemoFile, serializeMemoFile, normalizeMeta, toLocalIso, plainLines, extractTitle, extractPreview,
  extractMedia, extractAttachments, isBlankBody, titleToFileName, COLORS } from '../app/js/core/memo-file.js';
import { buildIndex, sameIndex, AGENT_GUIDE } from '../app/js/core/indexer.js';
import { extractTags } from '../app/js/core/tags.js';
import { taskProgress } from '../app/js/core/tasks.js';
import { isLockedBody, parseLocked } from '../app/js/core/memo-lock.js';
import { isLiveCached, stampChanged } from '../app/js/core/reminders.js';
import { installLockMethods, lockedFiles, diskCopy } from '../app/js/core/vault-locks.js';
import { textMatcher } from '../app/js/core/text-match.js';
import {
  VERSIONS_DIR, versionName, versionTime, safeVersionId, isVersionName, shouldKeepVersion, versionsToPrune, describeVersions } from '../app/js/core/versions.js';

export const APP_DIR = '_memoking';
export const ATTACH_DIR = 'attachments';
const SCAN_INTERVAL = 4000;
const INDEX_DELAY = 1500;
// 탐색기·다른 PC 에서 메모 파일이 없어졌을 때 첨부를 치우기 전에 기다리는 시간.
// Google Drive 는 다른 PC 의 이름 바꾸기를 "지움 → 새로 만듦" 으로 늦게 전하기도 하므로 바로 치우지 않는다.
const ORPHAN_DELAY = 30_000;
// 한 번에 이보다 많이 없어지면(드라이브 연결 끊김 등) 첨부는 건드리지 않는다
const MAX_EXTERNAL_REMOVALS = 3;

// 임시 파일에 쓰고 바꿔치기 — 저장 도중 꺼져도 원본이 깨지지 않는다.
function writeAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(3).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // 동기화 프로그램이 파일을 잡고 있으면 바꿔치기가 실패할 수 있어 직접 쓴다.
    fs.rmSync(tmp, { force: true });
    if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
    fs.writeFileSync(file, data);
  }
}

const toPosix = (p) => p.split(path.sep).join('/');
const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

function stamp(date = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class Vault extends EventEmitter {
  constructor(root, { orphanDelay = ORPHAN_DELAY, device = 'pc' } = {}) {
    super();
    this.root = path.resolve(root);
    this.device = device; // 내용을 고친 곳으로 머리말에 남김 (pc · ai)
    this.orphanDelay = orphanDelay;
    this.orphans = new Map(); // 없어진 메모 id → 그 메모가 쓰던 첨부 (확인 대기)
    this.orphanTimer = null;
    /** @type {Map<string, {id, file: string|null, meta, body, mtimeMs, size, idSaved: boolean}>} */
    this.entries = new Map();
    this.locks = new Map(); // 연 잠금 메모: id → 세션 (메모를 닫으면 잊는다)
    this.lockCopies = new Map(); // 잠긴 메모 id → 그 메모를 연 동안 만든 사본 id 들 (같은 열쇠)
    this.copyOf = new Map(); // 사본 id → 원래 메모 id
    this.index = null;
    this.indexTimer = null;
    this.scanTimer = null;
    this.pollTimer = null;
    this.watcher = null;
  }

  get appDir() { return path.join(this.root, APP_DIR); }
  get trashDir() { return path.join(this.appDir, 'trash'); }
  get indexFile() { return path.join(this.appDir, 'index.json'); }
  abs(file) { return path.join(this.root, ...file.split('/')); }

  open() {
    for (const dir of [this.root, this.appDir, this.trashDir, path.join(this.root, ATTACH_DIR)]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch {
      this.index = null;
    }
    this.scan({ silent: true });
    // 꺼 둔 사이 다른 기기에서 잠근 메모의 풀린 버전이 이 기기에 남지 않게
    for (const e of this.entries.values()) if (isLockedBody(e.body)) this.dropUnsafeVersions(e.id);
    const guide = path.join(this.appDir, 'README.md');
    // 안내·색인 파일은 켜져 있는 메모킹 앱이 쓴다 (AI 비서 연결 프로세스는 쓰지 않음 — 두 프로세스가 같은 파일을 쓰지 않게)
    if (this.device !== 'ai' && (!fs.existsSync(guide) || fs.readFileSync(guide, 'utf8') !== AGENT_GUIDE)) writeAtomic(guide, AGENT_GUIDE);
    this.writeIndex();
    this.watch();
  }

  close() {
    this.watcher?.close();
    clearInterval(this.pollTimer);
    clearTimeout(this.scanTimer);
    clearTimeout(this.orphanTimer);
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.writeIndex();
    }
    this.removeAllListeners();
  }

  // ---------- 폴더 읽기 ----------

  listFiles(dir = this.root, rel = '') {
    const files = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = item.name;
      if (name.startsWith('.') || name.startsWith('~$')) continue;
      if (!rel && (name === APP_DIR || name === ATTACH_DIR)) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      if (item.isDirectory()) files.push(...this.listFiles(path.join(dir, name), relPath));
      else if (item.isFile() && name.toLowerCase().endsWith('.md')) files.push(relPath);
    }
    return files;
  }

  // 바뀐 파일만 다시 읽는다. 다른 기기에서 동기화돼 들어온 변경은 external 로 알린다.
  scan({ silent = false } = {}) {
    let files;
    try {
      files = this.listFiles();
    } catch (err) {
      this.emit('error', err);
      return;
    }
    const prevByFile = new Map([...this.entries.values()].filter((e) => e.file).map((e) => [e.file, e]));
    const next = new Map([...this.entries].filter(([, e]) => !e.file)); // 아직 파일이 없는 새 메모
    const changed = new Set();
    const external = [];
    const lockedNow = [];

    for (const file of files) {
      let stat;
      try {
        stat = fs.statSync(this.abs(file));
      } catch {
        continue;
      }
      const prev = prevByFile.get(file);
      if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size && !next.has(prev.id)) {
        next.set(prev.id, prev);
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(this.abs(file), 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseMemoFile(text);
      // id 가 없는 파일(직접 만든 파일)이나 복사본처럼 id 가 겹치는 파일은 임시 id 를 준다.
      let id = meta.id;
      let idSaved = Boolean(id);
      if (!id || next.has(id)) {
        id = prev && !prev.idSaved ? prev.id : randomUUID();
        idSaved = false;
      }
      meta.id = id;
      // 머리말 없이 만든 파일은 파일 시각을 쓴다 (파일에는 앱에서 고칠 때 기록).
      meta.updated ??= toLocalIso(new Date(stat.mtimeMs));
      meta.created ??= toLocalIso(new Date(stat.birthtimeMs || stat.mtimeMs));
      const old = this.entries.get(id);
      next.set(id, { id, file, meta, body, mtimeMs: stat.mtimeMs, size: stat.size, idSaved, diskMeta: diskCopy(meta) });
      changed.add(id);
      if ((!old || old.body !== body) && !this.ownFiles?.has(file)) external.push(id); // 밖에서 새로 들어온 메모도 (이 기기가 되살린 것은 빼고)
      // 다른 기기에서 잠갔거나 비밀번호를 바꾼 메모: 이 기기에 남은 풀린 버전·예전 비밀번호 버전을 지운다 (아래에서)
      if (isLockedBody(body) && old && parseLocked(old.body)?.salt !== parseLocked(body).salt) lockedNow.push(id);
    }

    const removed = [...this.entries.keys()].filter((id) => !next.has(id));
    for (const id of removed) changed.add(id);
    // 밖에서 지워진 메모의 첨부는 잠시 뒤 다시 확인하고 치운다
    let attachList = null;
    const listFiles = () => (attachList ??= this.attachmentFiles());
    if (removed.length <= MAX_EXTERNAL_REMOVALS) {
      for (const id of removed) {
        const gone = this.entries.get(id);
        const srcs = gone ? this.attachmentsOf(gone, listFiles) : []; // 잠긴 메모도 머리말의 표로 (첨부 폴더는 한 번만 읽음)
        if (srcs.length) this.orphans.set(id, srcs);
      }
      if (this.orphans.size) {
        clearTimeout(this.orphanTimer);
        this.orphanTimer = setTimeout(() => this.flushOrphans(), this.orphanDelay);
      }
    }
    this.rememberRemoved(removed); // 파일이 잠깐 없던 메모를 곧 다시 저장할 때 머리말(알림·잠금 설정)을 잃지 않게
    this.entries = next;
    for (const id of lockedNow) this.dropUnsafeVersions(id);

    if (changed.size && !silent) {
      this.emit('changed', { ids: [...changed], external, removed });
      this.scheduleIndex();
    }
  }

  watch() {
    const rescan = () => {
      clearTimeout(this.scanTimer);
      this.scanTimer = setTimeout(() => this.scan(), 300);
    };
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, name) => {
        if (name && (name.startsWith(APP_DIR) || !name.toLowerCase().endsWith('.md'))) return;
        rescan();
      });
      this.watcher.on('error', () => {});
    } catch {
      this.watcher = null;
    }
    // 네트워크·클라우드 드라이브는 감시 알림이 늦거나 빠질 수 있어 주기적으로도 확인한다.
    this.pollTimer = setInterval(() => this.scan(), SCAN_INTERVAL);
  }

  // ---------- 조회 ----------

  summary(entry) {
    const media = extractMedia(entry.body);
    const has = (kind) => media.some((m) => m.kind === kind);
    return {
      id: entry.id,
      file: entry.file,
      title: extractTitle(entry.body),
      preview: extractPreview(entry.body, 1200), // 목록을 확대하면 카드에 요약을 여러 줄 보여 주므로 넉넉히
      color: entry.meta.color,
      pinned: entry.meta.pinned,
      created: entry.meta.created,
      updated: entry.meta.updated,
      thumb: media.find((m) => m.kind === 'image')?.src ?? null,
      tags: extractTags(entry.body),
      hasImage: has('image'),
      hasWebLink: /\]\(https?:\/\/|<https?:\/\//i.test(entry.body),
      hasAudio: has('audio'),
      hasVideo: has('video'),
      hasFile: has('file'),
      reminderCount: entry.meta.reminders.filter((r) => isLiveCached(r)).length, // 종 버튼·일정 탭과 같은 규칙 (앞으로 울릴 것만)
      linkCount: entry.meta.links.filter((id) => this.entries.has(id)).length,
      tasks: taskProgress(entry.body), // 체크리스트 진행 (모두 끝나면 카드에 CLEAR 도장)
      locked: isLockedBody(entry.body),
    };
  }

  list() {
    return [...this.entries.values()]
      .filter((e) => e.file)
      .map((e) => this.summary(e))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0));
  }

  // 태그 추천용: 메모마다 본문
  bodies() {
    return [...this.entries.values()].filter((e) => e.file).map((e) => ({ id: e.id, body: e.body }));
  }

  // 매직키 메모 검색용: 메모마다 제목·본문 글
  searchable() {
    return [...this.entries.values()]
      .filter((e) => e.file)
      .map((e) => ({ id: e.id, title: extractTitle(e.body), text: plainLines(e.body).join('\n'), updated: e.meta.updated, color: e.meta.color }));
  }

  search(query, excludeId = null) {
    const matches = textMatcher(query);
    return this.list().filter((m) => {
      if (m.id === excludeId) return false;
      const entry = this.entries.get(m.id);
      return matches(m.title, plainLines(entry.body).join('\n'));
    });
  }

  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    // 다른 메모를 연 동안 만든 잠긴 사본은 따로 열 때 비밀번호를 묻는다
    const plain = this.isCopyLock(id) ? null : this.plainOf(entry);
    const locked = isLockedBody(entry.body);
    return {
      id,
      file: entry.file,
      body: plain ?? entry.body, // 잠긴 메모는 연(비밀번호를 넣은) 동안만 푼 글
      locked,
      needsPassword: locked && plain === null,
      title: extractTitle(entry.body),
      color: entry.meta.color,
      pinned: entry.meta.pinned,
      links: entry.meta.links,
      reminders: entry.meta.reminders,
      tables: entry.meta.tables ?? [],
      ink: entry.meta.ink ?? '',
      created: entry.meta.created,
      updated: entry.meta.updated,
      device: entry.meta.device ?? null,
    };
  }

  // ---------- 예약 알림 ----------

  // 모든 메모의 알림: [{ memoId, title, color, reminder }]
  allReminders() {
    const out = [];
    for (const e of this.entries.values()) {
      if (!e.file) continue;
      for (const reminder of e.meta.reminders) out.push({ memoId: e.id, title: extractTitle(e.body), color: e.meta.color, updated: e.meta.updated, locked: isLockedBody(e.body), stable: e.idSaved !== false, reminder });
    }
    return out;
  }

  /** 이 메모 파일을 마지막으로 쓴(받은) 때 ms — 캘린더 동기화: 이 기기의 메모가 지난번 맞춘 뒤 바뀌었는가 */
  editedAt(id) {
    const e = this.entries.get(id);
    return e ? Math.max(Date.parse(e.meta.updated ?? '') || 0, e.mtimeMs || 0) : 0;
  }

  // 알림 목록 통째로 바꾸기 (추가·삭제·켜기/끄기). 알림은 내용 수정이 아니므로 updated 는 그대로.
  setReminders(id, reminders) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    // 잠긴 메모의 일정 이름은 머리말(풀린 글)에 남기지 않는다 — 글에서 짐작한 이름이 비밀일 수 있음 (알림엔 메모 제목)
    const prev = entry.meta.reminders;
    reminders = stampChanged(prev, reminders); // 일정이 바뀐 때 (캘린더 동기화의 "나중에 고친 쪽")
    entry.meta.reminders = isLockedBody(entry.body) ? reminders.map(({ title: _t, ...r }) => r) : reminders;
    const wrote = entry.file || !isBlankBody(entry.body) ? this.write(entry) : true;
    if (wrote !== true) {
      entry.meta.reminders = prev; // 쓰지 못했다(그사이 파일이 사라지는 등) — 저장된 것처럼 보이지 않게 null
      return null;
    }
    this.changed([id]);
    return entry.meta.reminders;
  }

  updateReminder(id, reminder) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return this.setReminders(id, entry.meta.reminders.map((r) => (r.id === reminder.id ? reminder : r)));
  }

  links(id) {
    const entry = this.entries.get(id);
    if (!entry) return { links: [], backlinks: [], suggestions: [] };
    const brief = (e) => ({ id: e.id, title: extractTitle(e.body), color: e.meta.color });
    const links = entry.meta.links.map((to) => this.entries.get(to)).filter(Boolean).map(brief);
    const backlinks = [...this.entries.values()].filter((e) => e.id !== id && e.meta.links.includes(id)).map(brief);
    const linked = new Set([...entry.meta.links, ...backlinks.map((b) => b.id)]);
    const indexed = this.index?.memos?.find((m) => m.id === id);
    const suggestions = (indexed?.related ?? [])
      .filter((r) => r.reasons.includes('similar') && !linked.has(r.id) && this.entries.has(r.id))
      .slice(0, 5)
      .map((r) => ({ ...brief(this.entries.get(r.id)), score: r.similarity }));
    return { links, backlinks, suggestions };
  }

  // ---------- 쓰기 ----------

  // 새 메모는 내용이 생길 때 파일로 만든다 (빈 파일이 쌓이지 않도록).
  create({ color } = {}) {
    const id = randomUUID();
    this.entries.set(id, this.newEntry(id, color));
    return id;
  }

  newEntry(id, color) {
    const now = toLocalIso();
    const meta = normalizeMeta({ id, created: now, updated: now, color: COLORS.includes(color) ? color : undefined });
    return { id, file: null, meta, body: '', mtimeMs: 0, size: 0, idSaved: true };
  }

  import({ body, created, updated, pinned = false, color }) {
    if (isLockedBody(body)) return null; // 잠금 형식 글은 아무도 열 수 없는 메모가 되므로 새 메모로 만들지 않는다
    const id = this.create({ color });
    const entry = this.entries.get(id);
    Object.assign(entry.meta, { created: created ?? entry.meta.created, updated: updated ?? entry.meta.updated, pinned });
    entry.body = body;
    this.write(entry);
    this.changed([id]);
    return id;
  }

  // ---------- 잠금 메모: plainOf · openLock · closeLock · lock · unlock 등은 core/vault-locks.js (PC·휴대폰 같음) ----------

  purgeVersions(id) {
    const dir = this.versionDir(id);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- 버전 기록 (_memoking/versions/<id>/<시각>.md) ----------

  versionDir(id) {
    const safe = safeVersionId(id);
    return safe ? path.join(this.root, ...VERSIONS_DIR.split('/'), safe) : null;
  }

  versionNames(id) {
    return this.#versionNames(id);
  }

  #versionNames(id) {
    const dir = this.versionDir(id);
    try {
      return dir ? fs.readdirSync(dir).filter(isVersionName) : [];
    } catch {
      return [];
    }
  }

  // 덮어쓰기 전 내용(before)을 남긴다. 계속 쓰는 동안은 10분에 하나, force 면 바로 (되돌리기 직전·다른 기기 내용)
  keepVersion(id, before, { force = false } = {}) {
    const dir = this.versionDir(id);
    if (!dir) return null;
    try {
      const names = this.#versionNames(id);
      const newest = names.map((name) => ({ name, at: versionTime(name) })).sort((a, b) => b.at - a.at)[0];
      const latest = newest ? { at: newest.at, body: fs.readFileSync(path.join(dir, newest.name), 'utf8') } : null;
      if (!shouldKeepVersion(before, latest, { force })) return null;
      fs.mkdirSync(dir, { recursive: true });
      let name = versionName();
      for (let n = 2; names.includes(name); n++) name = versionName().replace(/\.md$/, `-${n}.md`);
      writeAtomic(path.join(dir, name), before);
      for (const old of versionsToPrune([...names, name])) fs.rmSync(path.join(dir, old), { force: true });
      return name;
    } catch (err) {
      this.emit('error', err);
      return null;
    }
  }

  versions(id) {
    const dir = this.versionDir(id);
    if (!dir) return [];
    return describeVersions(this.#versionNames(id).map((name) => {
      try {
        return { name, at: versionTime(name), body: fs.readFileSync(path.join(dir, name), 'utf8') };
      } catch {
        return { name, at: null };
      }
    }));
  }

  version(id, name) {
    const dir = this.versionDir(id);
    if (!dir || !isVersionName(name)) return null;
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return null;
    }
  }

  // known: 파일에 있다고 알고 있는 본문 (save 가 바꾸기 전 것을 넘긴다)
  write(entry, known = entry.body, { copy = true } = {}) {
    // 그사이 다른 기기가 이 메모를 잠갔다면 덮어쓰지 않는다 (잠금이 풀리거나 비밀번호가 되돌아가지 않게)
    if (entry.file) {
      const kept = this.keepChangedOnDisk(entry, known, { copy });
      if (kept === 'locked' || kept === 'copied' || kept === 'skipped') return kept;
    }
    if (!entry.file) entry.file = this.uniqueFile(titleToFileName(extractTitle(entry.body)));
    const file = this.abs(entry.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    entry.meta.id = entry.id;
    writeAtomic(file, serializeMemoFile(entry.meta, entry.body));
    const stat = fs.statSync(file);
    entry.mtimeMs = stat.mtimeMs;
    entry.size = stat.size;
    entry.idSaved = true;
    entry.diskMeta = diskCopy(entry.meta); // 지금 파일에 있는 머리말
    return true;
  }

  rescanSoon() {
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => this.scan(), 50);
  }

  /** 덮어쓰기 전 확인용: 마지막으로 읽은(쓴) 뒤 파일이 바뀌었으면 { body, meta }, 사라졌으면 'missing', 그대로면 null */
  readDiskIfChanged(entry) {
    let st;
    try {
      st = fs.statSync(this.abs(entry.file));
    } catch (err) {
      // 정말 없을 때만 'missing' — 백신·OneDrive 가 잠깐 붙잡은 것(EBUSY·EPERM)은 그대로 써 본다 (안 되면 쓰기가 오류를 낸다)
      return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : null;
    }
    if (st.mtimeMs === entry.mtimeMs && st.size === entry.size) return null;
    try {
      return parseMemoFile(fs.readFileSync(this.abs(entry.file), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 첨부 폴더 · 휴지통의 첨부 폴더 (메모 폴더 기준) — core/vault-locks.js 가 잠긴 메모의 첨부를 찾을 때 */
  get attachDirRel() { return ATTACH_DIR; }
  get trashAttachDirRel() { return `${APP_DIR}/trash/${ATTACH_DIR}`; }

  /** 폴더 안의 파일 이름들 (rel: 메모 폴더 기준 "attachments" 등, 없으면 []) */
  listDir(rel) {
    try {
      return fs.readdirSync(path.join(this.root, ...rel.split('/')), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  // 같은 폴더에서 겹치지 않는 파일명: "제목.md", "제목 (2).md", ...
  uniqueFile(base, dir = '', current = null) {
    for (let n = 1; ; n++) {
      const name = n === 1 ? `${base}.md` : `${base} (${n}).md`;
      const file = dir ? `${dir}/${name}` : name;
      if (current && sameName(file, current)) return current;
      const taken = [...this.entries.values()].some((e) => e.file && sameName(e.file, file));
      if (!taken && !fs.existsSync(this.abs(file))) return file;
    }
  }

  // 창을 닫을 때: 빈 메모는 치우고, 제목이 바뀌었으면 파일명을 맞춘다.
  finalize(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (isBlankBody(entry.body)) {
      if (entry.file) this.trash(id);
      else this.entries.delete(id);
      return;
    }
    if (!entry.file) return;
    const base = titleToFileName(extractTitle(entry.body));
    const dir = entry.file.includes('/') ? entry.file.slice(0, entry.file.lastIndexOf('/')) : '';
    const current = path.posix.basename(entry.file, '.md');
    if (current === base || current.startsWith(`${base} (`)) return;
    const target = this.uniqueFile(base, dir, entry.file);
    if (target === entry.file) return;
    try {
      fs.renameSync(this.abs(entry.file), this.abs(target));
      entry.file = target;
      this.changed([id]);
    } catch (err) {
      this.emit('error', err);
    }
  }

  // setMeta · link 는 core/vault-locks.js (PC·휴대폰 같음 — 쓰지 못하면 되돌리고 null)

  trash(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    let trashed = null;
    if (entry.file) {
      const base = path.posix.basename(entry.file, '.md');
      const dest = path.join(this.trashDir, `${base} (${stamp()}).md`);
      try {
        fs.renameSync(this.abs(entry.file), dest);
        trashed = path.basename(dest);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          this.entries.set(id, entry);
          throw err;
        }
      }
    }
    this.orphans.delete(id);
    this.trashAttachments(this.attachmentsOf(entry)); // 열지 않은 잠긴 메모도 머리말의 표로
    this.closeLock(id); // 지운 잠긴 메모의 열쇠를 남기지 않는다 (되살리면 다시 비밀번호로)
    this.changed([id]);
    this.emit('trashed', id); // 이 PC 에서 지움 (빈 메모 정리 포함) — 바탕화면 위젯 · 단축키도 거둔다
    return trashed ?? true; // 휴지통 파일 이름 (되돌리기에 씀)
  }

  // 밖에서 없어진 메모가 그동안 돌아오지 않았으면(이름만 바뀐 경우는 같은 id 로 돌아옴) 첨부를 치운다
  flushOrphans() {
    this.orphanTimer = null;
    this.scan();
    const srcs = [];
    for (const [id, list] of this.orphans) if (!this.entries.has(id)) srcs.push(...list);
    this.orphans.clear();
    return this.trashAttachments(srcs);
  }

  // 지운 메모가 쓰던 첨부 중 남은 메모가 쓰지 않는 것만 _memoking/trash/attachments/ 로 옮긴다.
  // (메모도 휴지통으로 가므로 함께 두어 되살릴 수 있게. 같은 사진을 두 메모가 쓰면 남긴다.)
  trashAttachments(srcs) {
    // 남은 메모(열지 않은 잠긴 메모 포함)가 쓰는 첨부는 남긴다 (core/vault-locks.js)
    const used = this.attachmentGuard();
    const moved = [];
    for (const src of new Set(srcs)) {
      if (!src.startsWith(`${ATTACH_DIR}/`) || used(src)) continue;
      const from = this.resolve(src);
      if (!from || !fs.statSync(from, { throwIfNoEntry: false })?.isFile()) continue;
      const dir = path.join(this.trashDir, ATTACH_DIR);
      let dest = path.join(dir, path.basename(from));
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(dest)) dest = path.join(dir, `${stamp()}-${path.basename(from)}`);
        fs.renameSync(from, dest);
        // 휴지통에 들어온 때를 파일 시각으로 (자동 영구 삭제 기간을 이때부터 센다)
        const now = new Date();
        fs.utimesSync(dest, now, now);
        moved.push(src);
      } catch (err) {
        this.emit('error', err);
      }
    }
    return moved;
  }

  // ---------- 휴지통 (_memoking/trash) — 되살리기·영구 삭제·오래된 것 비우기 ----------

  // 휴지통의 메모 파일 (이름만 받는다 — 휴지통 밖 경로는 거부)
  trashFile(name) {
    const base = path.basename(String(name ?? ''));
    if (!base || base !== name || !base.toLowerCase().endsWith('.md')) return null;
    const file = path.join(this.trashDir, base);
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
  }

  // 지운 때: 휴지통 파일 이름 "제목 (20260930-153000).md" 의 시각, 없으면 파일 시각
  static trashedAt(name, stat) {
    const m = /\((\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\)\.md$/i.exec(name);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return stat?.mtimeMs ?? Date.now();
  }

  #trashEntries() {
    let names = [];
    try {
      names = fs.readdirSync(this.trashDir).filter((n) => n.toLowerCase().endsWith('.md'));
    } catch {
      return [];
    }
    return names.map((name) => {
      const file = path.join(this.trashDir, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return null;
        return { name, file, at: Vault.trashedAt(name, stat), ...parseMemoFile(fs.readFileSync(file, 'utf8')) };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /** 휴지통의 메모 (최근에 지운 것부터) */
  /** 휴지통에 있는 메모 id 들 (캘린더 동기화: 지운 메모인지, 아직 이 기기에 오지 않은 메모인지 가린다) */
  trashedIds() {
    return new Set(this.#trashEntries().map((t) => t?.meta?.id).filter(Boolean));
  }

  trashList() {
    return this.#trashEntries()
      .sort((a, b) => b.at - a.at)
      .map((t) => ({
        name: t.name,
        title: extractTitle(t.body),
        preview: extractPreview(t.body, 100),
        color: COLORS.includes(t.meta.color) ? t.meta.color : 'yellow',
        deletedAt: new Date(t.at).toISOString(),
        attachments: lockedFiles(t.body, t.meta, () => this.trashAttachmentFiles()).length, // 잠긴 메모는 머리말의 표로
      }));
  }

  /** 메모 폴더로 되돌린다 (이름이 겹치면 "(2)"). 함께 휴지통에 간 첨부도 돌려놓는다. 되살린 메모 id */
  restoreTrash(name) {
    const file = this.trashFile(name);
    if (!file) return null;
    const { body, meta } = parseMemoFile(fs.readFileSync(file, 'utf8'));
    // 잠긴 메모는 머리말의 표로 휴지통의 첨부에서 찾아 함께 되살린다 (core/vault-locks.js)
    for (const src of lockedFiles(body, meta, () => this.trashAttachmentFiles())) {
      if (!src.startsWith(`${ATTACH_DIR}/`)) continue;
      const live = this.resolve(src);
      const held = path.join(this.trashDir, ...src.split('/'));
      if (!live || fs.existsSync(live) || !fs.existsSync(held)) continue;
      try {
        fs.renameSync(held, live);
      } catch (err) {
        this.emit('error', err);
      }
    }
    const target = this.uniqueFile(titleToFileName(extractTitle(body)));
    fs.renameSync(file, this.abs(target));
    // 이 기기에서 되살린 메모는 "다른 기기에서 방금 고친 메모" 로 알리지 않는다
    this.ownFiles = new Set([target]);
    try {
      this.scan();
    } finally {
      this.ownFiles = null;
    }
    return [...this.entries.values()].find((e) => e.file === target)?.id ?? null;
  }

  // 휴지통의 첨부 중 살아 있는 메모·휴지통에 남은 메모가 쓰지 않는 것을 지운다 (olderThan: 이 시각보다 먼저 들어온 것만)
  #purgeTrashAttachments(srcs, olderThan = Infinity) {
    // 살아 있는 메모·휴지통의 메모(열지 않은 잠긴 메모 포함)가 쓰는 첨부는 지우지 않는다 (core/vault-locks.js)
    const used = this.attachmentGuard([...this.#trashEntries()]);
    let removed = 0;
    for (const src of new Set(srcs)) {
      if (!src.startsWith(`${ATTACH_DIR}/`) || used(src)) continue;
      const held = path.join(this.trashDir, ...src.split('/'));
      const stat = fs.statSync(held, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.mtimeMs > olderThan) continue;
      fs.rmSync(held, { force: true });
      removed++;
    }
    return removed;
  }

  /** 휴지통의 메모 하나를 영구 삭제 (그 메모만 쓰던 첨부도) */
  deleteTrash(name) {
    const file = this.trashFile(name);
    if (!file) return false;
    const { body, meta } = parseMemoFile(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    this.#purgeTrashAttachments(lockedFiles(body, meta, () => this.trashAttachmentFiles()));
    return true;
  }

  /**
   * 휴지통 비우기. olderThanDays 를 주면 그보다 오래 있던 것만 (자동 영구 삭제).
   * @returns {{ memos: number, files: number }}
   */
  emptyTrash({ olderThanDays = null } = {}) {
    const cutoff = olderThanDays == null ? Infinity : Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let memos = 0;
    for (const t of this.#trashEntries()) {
      if (t.at > cutoff) continue;
      fs.rmSync(t.file, { force: true });
      memos++;
    }
    let held = [];
    try {
      held = fs.readdirSync(path.join(this.trashDir, ATTACH_DIR)).map((n) => `${ATTACH_DIR}/${n}`);
    } catch {
      // 휴지통에 첨부 없음
    }
    const files = this.#purgeTrashAttachments(held, cutoff);
    return { memos, files };
  }

  saveAttachment(bytes, ext) {
    const safeExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const name = `${stamp()}-${randomBytes(2).toString('hex')}.${safeExt}`;
    writeAtomic(path.join(this.root, ATTACH_DIR, name), Buffer.from(bytes));
    return `${ATTACH_DIR}/${name}`;
  }

  // 디스크의 파일을 그대로 복사 (큰 동영상도 메모리에 올리지 않음)
  copyAttachment(sourceFile) {
    const ext = path.extname(sourceFile).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const name = `${stamp()}-${randomBytes(2).toString('hex')}.${ext}`;
    fs.copyFileSync(sourceFile, path.join(this.root, ATTACH_DIR, name));
    return `${ATTACH_DIR}/${name}`;
  }

  // 폴더 밖으로 벗어나는 경로(../)는 거부한다.
  resolve(rel) {
    const abs = path.resolve(this.root, rel);
    const inside = path.relative(this.root, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
    return abs;
  }

  // ---------- 인덱스 ----------

  changed(ids) {
    this.emit('changed', { ids, external: [], removed: ids.filter((id) => !this.entries.has(id)) });
    this.scheduleIndex();
  }

  scheduleIndex() {
    clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => this.writeIndex(), INDEX_DELAY);
  }

  writeIndex() {
    clearTimeout(this.indexTimer);
    this.indexTimer = null;
    const memos = [...this.entries.values()].filter((e) => e.file).map(({ id, file, meta, body }) => ({ id, file, meta, body }));
    const index = buildIndex(memos);
    if (sameIndex(index, this.index)) return;
    try {
      writeAtomic(this.indexFile, `${JSON.stringify(index, null, 2)}\n`);
      this.index = index;
      this.emit('indexed', index);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

installLockMethods(Vault);
