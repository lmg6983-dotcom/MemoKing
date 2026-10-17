// 메모 폴더(볼트) — desktop/vault.js 를 휴대폰으로 옮긴 것.
// 규칙(파일 이름·머리말·휴지통·첨부 정리·LLM 인덱스)은 데스크탑과 똑같고, 파일 읽기·쓰기만 앱(fs)에 맡긴다.
// 그래서 PC 와 휴대폰이 같은 폴더를 동기화해 써도 서로의 메모를 그대로 읽는다.
import {
  parseMemoFile, serializeMemoFile, normalizeMeta, toLocalIso, plainLines, extractTitle, extractPreview,
  extractMedia, extractAttachments, isBlankBody, titleToFileName, COLORS } from '../../app/js/core/memo-file.js';
import { buildIndex, sameIndex, AGENT_GUIDE } from '../../app/js/core/indexer.js';
import { extractTags } from '../../app/js/core/tags.js';
import { taskProgress } from '../../app/js/core/tasks.js';
import { fs, toBase64 } from './native.js';
import { isLockedBody, parseLocked } from '../../app/js/core/memo-lock.js';
import { isLiveCached } from '../../app/js/core/reminders.js';
import { installLockMethods, lockedFiles, diskCopy } from '../../app/js/core/vault-locks.js';
import { textMatcher } from '../../app/js/core/text-match.js';
import {
  VERSIONS_DIR, VERSION_GAP_MS, versionName, versionTime, safeVersionId, isVersionName, shouldKeepVersion, versionsToPrune,
  describeVersions } from '../../app/js/core/versions.js';

export const APP_DIR = '_memoking';
export const ATTACH_DIR = 'attachments';
const TRASH_DIR = `${APP_DIR}/trash`;
const INDEX_FILE = `${APP_DIR}/index.json`;
const SCAN_INTERVAL = 4000;
const INDEX_DELAY = 1500;
// 다른 기기에서 메모 파일이 없어졌을 때 첨부를 치우기 전에 기다리는 시간 (이름 바꾸기가 "지움 → 새로 만듦" 으로 늦게 오기도 함)
const ORPHAN_DELAY = 30_000;
const MAX_EXTERNAL_REMOVALS = 3;

const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
const baseName = (file) => file.slice(file.lastIndexOf('/') + 1);
const dirName = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
const stripMd = (name) => name.replace(/\.md$/i, '');

export function stamp(date = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${randomHex(4)}-${randomHex(2)}-4${randomHex(2).slice(1)}-${randomHex(2)}-${randomHex(6)}`);

export const safeExt = (ext) => String(ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';

export class Vault extends EventTarget {
  constructor({ orphanDelay = ORPHAN_DELAY } = {}) {
    super();
    this.orphanDelay = orphanDelay;
    this.orphans = new Map();
    this.orphanTimer = null;
    /** @type {Map<string, {id, file: string|null, meta, body, mtimeMs, size, idSaved: boolean}>} */
    this.entries = new Map();
    this.locks = new Map(); // 연 잠금 메모: id → 세션 (메모를 닫으면 잊는다)
    this.device = 'phone'; // 내용을 고친 곳으로 머리말에 남김
    this.lockCopies = new Map(); // 잠긴 메모 id → 그 메모를 연 동안 만든 사본 id 들 (같은 열쇠)
    this.copyOf = new Map(); // 사본 id → 원래 메모 id
    this.index = null;
    this.indexTimer = null;
    this.pollTimer = null;
    this.latestVersion = new Map(); // 메모 id → 가장 최근 버전 {at, body} (저장할 때마다 폴더를 읽지 않게)
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    const handler = (e) => fn(e.detail);
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  open() {
    for (const dir of [APP_DIR, TRASH_DIR, ATTACH_DIR]) fs.mkdirs(dir);
    try {
      this.index = JSON.parse(fs.readText(INDEX_FILE) ?? 'null');
    } catch {
      this.index = null;
    }
    this.scan({ silent: true });
    // 꺼 둔 사이 다른 기기에서 잠근 메모의 풀린 버전이 이 기기에 남지 않게
    for (const e of this.entries.values()) if (isLockedBody(e.body)) this.dropUnsafeVersions(e.id);
    const guide = `${APP_DIR}/README.md`;
    if (fs.readText(guide) !== AGENT_GUIDE) fs.writeText(guide, AGENT_GUIDE);
    this.writeIndex();
    this.resume();
  }

  // 화면이 보이는 동안만 폴더를 살핀다 (배터리)
  resume() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.scan(), SCAN_INTERVAL);
  }

  pause() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.indexTimer) this.writeIndex();
  }

  close() {
    this.pause();
    clearTimeout(this.orphanTimer);
  }

  // ---------- 폴더 읽기 ----------

  // 바뀐 파일만 다시 읽는다. 다른 기기에서 동기화돼 들어온 변경은 external 로 알린다.
  scan({ silent = false } = {}) {
    let files;
    try {
      files = fs.scan();
    } catch (err) {
      this.emit('error', err);
      return;
    }
    const prevByFile = new Map([...this.entries.values()].filter((e) => e.file).map((e) => [e.file, e]));
    const next = new Map([...this.entries].filter(([, e]) => !e.file)); // 아직 파일이 없는 새 메모
    const changed = new Set();
    const external = [];
    const lockedNow = [];

    for (const { file, mtime, size } of files) {
      const prev = prevByFile.get(file);
      if (prev && prev.mtimeMs === mtime && prev.size === size && !next.has(prev.id)) {
        next.set(prev.id, prev);
        continue;
      }
      let text;
      try {
        text = fs.readText(file);
      } catch {
        continue;
      }
      if (text == null) continue;
      const { meta, body } = parseMemoFile(text);
      // id 가 없는 파일(직접 만든 파일)이나 복사본처럼 id 가 겹치는 파일은 임시 id 를 준다.
      let id = meta.id;
      let idSaved = Boolean(id);
      if (!id || next.has(id)) {
        id = prev && !prev.idSaved ? prev.id : uuid();
        idSaved = false;
      }
      meta.id = id;
      meta.updated ??= toLocalIso(new Date(mtime || Date.now()));
      meta.created ??= meta.updated;
      const old = this.entries.get(id);
      next.set(id, { id, file, meta, body, mtimeMs: mtime, size, idSaved, diskMeta: diskCopy(meta) });
      changed.add(id);
      if ((!old || old.body !== body) && !this.ownFiles?.has(file)) external.push(id); // 밖에서 새로 들어온 메모도 (이 기기가 되살린 것은 빼고)
      // 다른 기기에서 잠갔거나 비밀번호를 바꾼 메모: 이 기기에 남은 풀린 버전·예전 비밀번호 버전을 지운다 (아래에서)
      if (isLockedBody(body) && old && parseLocked(old.body)?.salt !== parseLocked(body).salt) lockedNow.push(id);
    }

    const removed = [...this.entries.keys()].filter((id) => !next.has(id));
    for (const id of removed) changed.add(id);
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

  // ---------- 조회 ----------

  summary(entry) {
    const media = extractMedia(entry.body);
    const has = (kind) => media.some((m) => m.kind === kind);
    return {
      id: entry.id,
      file: entry.file,
      title: extractTitle(entry.body),
      preview: extractPreview(entry.body),
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

  search(query, excludeId = null) {
    const matches = textMatcher(query);
    return this.list().filter((m) => {
      if (m.id === excludeId) return false;
      const entry = this.entries.get(m.id);
      return matches(m.title, plainLines(entry.body).join('\n'));
    });
  }

  /** 태그 추천용: 파일이 있는 메모의 본문 (최근 고친 순, 많으면 앞의 limit 개) */
  bodies(limit = 400) {
    return [...this.entries.values()]
      .filter((e) => e.file)
      .sort((a, b) => (Date.parse(b.meta.updated) || 0) - (Date.parse(a.meta.updated) || 0))
      .slice(0, limit)
      .map((e) => ({ id: e.id, body: e.body }));
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

  // 알림은 내용 수정이 아니므로 updated 는 그대로
  setReminders(id, reminders) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    // 잠긴 메모의 일정 이름은 머리말(풀린 글)에 남기지 않는다 — 글에서 짐작한 이름이 비밀일 수 있음 (알림엔 메모 제목)
    const prev = entry.meta.reminders;
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
    const id = uuid();
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
    if (!dir) return;
    try {
      for (const name of this.versionNames(id)) fs.remove(`${dir}/${name}`);
    } catch {
      // 다음에 다시
    }
    this.latestVersion?.delete(id);
  }

  // ---------- 버전 기록 (_memoking/versions/<id>/<시각>.md) — 데스크탑과 같은 규칙 ----------

  versionDir(id) {
    const safe = safeVersionId(id);
    return safe ? `${VERSIONS_DIR}/${safe}` : null;
  }

  versionNames(id) {
    const dir = this.versionDir(id);
    try {
      return dir ? fs.list(dir).filter((e) => !e.dir && isVersionName(e.name)).map((e) => e.name) : [];
    } catch {
      return [];
    }
  }

  keepVersion(id, before, { force = false } = {}) {
    const dir = this.versionDir(id);
    if (!dir) return null;
    const cached = this.latestVersion.get(id);
    if (!force && cached && Date.now() - cached.at < VERSION_GAP_MS) return null;
    try {
      const names = this.versionNames(id);
      const newest = names.map((name) => ({ name, at: versionTime(name) })).sort((a, b) => b.at - a.at)[0];
      const latest = newest ? { at: newest.at, body: fs.readText(`${dir}/${newest.name}`) ?? '' } : null;
      if (latest) this.latestVersion.set(id, latest);
      if (!shouldKeepVersion(before, latest, { force })) return null;
      fs.mkdirs(dir);
      let name = versionName();
      for (let n = 2; names.includes(name); n++) name = versionName().replace(/\.md$/, `-${n}.md`);
      fs.writeText(`${dir}/${name}`, before);
      this.latestVersion.set(id, { at: versionTime(name), body: before });
      for (const old of versionsToPrune([...names, name])) fs.remove(`${dir}/${old}`);
      return name;
    } catch (err) {
      console.error('버전을 남기지 못했어요', err);
      return null;
    }
  }

  versions(id) {
    const dir = this.versionDir(id);
    if (!dir) return [];
    return describeVersions(this.versionNames(id).map((name) => {
      try {
        return { name, at: versionTime(name), body: fs.readText(`${dir}/${name}`) ?? '' };
      } catch {
        return { name, at: null };
      }
    }));
  }

  version(id, name) {
    const dir = this.versionDir(id);
    if (!dir || !isVersionName(name)) return null;
    try {
      return fs.readText(`${dir}/${name}`);
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
    entry.meta.id = entry.id;
    const stat = fs.writeText(entry.file, serializeMemoFile(entry.meta, entry.body));
    entry.mtimeMs = stat?.mtime ?? Date.now();
    entry.size = stat?.size ?? 0;
    entry.idSaved = true;
    entry.diskMeta = diskCopy(entry.meta); // 지금 파일에 있는 머리말
    return true;
  }

  rescanSoon() {
    clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => this.scan(), 50);
  }

  /** 덮어쓰기 전 확인용: 마지막으로 읽은(쓴) 뒤 파일이 바뀌었으면 { body, meta }, 사라졌으면 'missing', 그대로면 null */
  readDiskIfChanged(entry) {
    try {
      const st = fs.stat(entry.file);
      if (!st) return 'missing';
      if (st.mtime === entry.mtimeMs && st.size === entry.size) return null;
      return parseMemoFile(fs.readText(entry.file) ?? '');
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
      return (fs.list(rel) ?? []).filter((e) => !e.dir).map((e) => e.name);
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
      if (!taken && !fs.stat(file)) return file;
    }
  }

  // 메모를 닫을 때: 빈 메모는 치우고, 제목이 바뀌었으면 파일명을 맞춘다.
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
    const dir = dirName(entry.file);
    const current = stripMd(baseName(entry.file));
    if (current === base || current.startsWith(`${base} (`)) return;
    const target = this.uniqueFile(base, dir, entry.file);
    if (target === entry.file) return;
    try {
      if (!fs.move(entry.file, target)) return;
      entry.file = target;
      const stat = fs.stat(target);
      if (stat) Object.assign(entry, { mtimeMs: stat.mtime, size: stat.size });
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
    if (entry.file && fs.stat(entry.file)) {
      const dest = `${TRASH_DIR}/${stripMd(baseName(entry.file))} (${stamp()}).md`;
      trashed = baseName(dest);
      if (!fs.move(entry.file, dest)) {
        this.entries.set(id, entry);
        throw new Error('메모를 휴지통으로 옮기지 못했어요');
      }
    }
    this.orphans.delete(id);
    this.trashAttachments(this.attachmentsOf(entry)); // 열지 않은 잠긴 메모도 머리말의 표로
    this.closeLock(id); // 지운 잠긴 메모의 열쇠를 남기지 않는다 (되살리면 다시 비밀번호로)
    this.changed([id]);
    return trashed ?? true; // 휴지통 파일 이름 (되돌리기에 씀)
  }

  flushOrphans() {
    this.orphanTimer = null;
    this.scan();
    const srcs = [];
    for (const [id, list] of this.orphans) if (!this.entries.has(id)) srcs.push(...list);
    this.orphans.clear();
    return this.trashAttachments(srcs);
  }

  // 지운 메모가 쓰던 첨부 중 남은 메모가 쓰지 않는 것만 _memoking/trash/attachments/ 로 옮긴다.
  trashAttachments(srcs) {
    // 남은 메모(열지 않은 잠긴 메모 포함)가 쓰는 첨부는 남긴다 (core/vault-locks.js)
    const used = this.attachmentGuard();
    const moved = [];
    for (const src of new Set(srcs)) {
      if (!src.startsWith(`${ATTACH_DIR}/`) || used(src)) continue;
      const from = this.resolve(src);
      if (!from || fs.stat(from)?.dir !== false) continue;
      const dir = `${TRASH_DIR}/${ATTACH_DIR}`;
      let dest = `${dir}/${baseName(from)}`;
      try {
        fs.mkdirs(dir);
        if (fs.stat(dest)) dest = `${dir}/${stamp()}-${baseName(from)}`;
        if (fs.move(from, dest)) moved.push(src);
      } catch (err) {
        this.emit('error', err);
      }
    }
    return moved;
  }

  // ---------- 휴지통 ----------

  trashFile(name) {
    const base = baseName(String(name ?? ''));
    if (!base || base !== name || !base.toLowerCase().endsWith('.md')) return null;
    const file = `${TRASH_DIR}/${base}`;
    return fs.stat(file)?.dir === false ? file : null;
  }

  // 지운 때: 휴지통 파일 이름 "제목 (20260930-153000).md" 의 시각, 없으면 파일 시각
  static trashedAt(name, mtime) {
    const m = /\((\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\)\.md$/i.exec(name);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return mtime || Date.now();
  }

  trashEntries() {
    let items = [];
    try {
      items = fs.list(TRASH_DIR).filter((e) => !e.dir && e.name.toLowerCase().endsWith('.md'));
    } catch {
      return [];
    }
    return items.map(({ name, mtime }) => {
      const file = `${TRASH_DIR}/${name}`;
      try {
        return { name, file, at: Vault.trashedAt(name, mtime), ...parseMemoFile(fs.readText(file) ?? '') };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /** 휴지통에 있는 메모 id 들 (캘린더 동기화: 지운 메모인지, 아직 이 휴대폰에 오지 않은 메모인지 가린다) */
  trashedIds() {
    return new Set(this.trashEntries().map((t) => t?.meta?.id).filter(Boolean));
  }

  trashList() {
    return this.trashEntries()
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
    const { body, meta } = parseMemoFile(fs.readText(file) ?? '');
    // 잠긴 메모는 머리말의 표로 휴지통의 첨부에서 찾아 함께 되살린다 (core/vault-locks.js)
    for (const src of lockedFiles(body, meta, () => this.trashAttachmentFiles())) {
      if (!src.startsWith(`${ATTACH_DIR}/`)) continue;
      const live = this.resolve(src);
      const held = `${TRASH_DIR}/${src}`;
      if (!live || fs.stat(live) || !fs.stat(held)) continue;
      try {
        fs.move(held, live);
      } catch (err) {
        this.emit('error', err);
      }
    }
    const target = this.uniqueFile(titleToFileName(extractTitle(body)));
    if (!fs.move(file, target)) return null;
    // 이 기기에서 되살린 메모는 "다른 기기에서 방금 고친 메모" 로 알리지 않는다
    this.ownFiles = new Set([target]);
    try {
      this.scan();
    } finally {
      this.ownFiles = null;
    }
    return [...this.entries.values()].find((e) => e.file === target)?.id ?? null;
  }

  purgeTrashAttachments(srcs, olderThan = Infinity) {
    // 살아 있는 메모·휴지통의 메모(열지 않은 잠긴 메모 포함)가 쓰는 첨부는 지우지 않는다 (core/vault-locks.js)
    const used = this.attachmentGuard([...this.trashEntries()]);
    let removed = 0;
    for (const src of new Set(srcs)) {
      if (!src.startsWith(`${ATTACH_DIR}/`) || used(src)) continue;
      const held = `${TRASH_DIR}/${src}`;
      const stat = fs.stat(held);
      if (!stat || stat.dir || stat.mtime > olderThan) continue;
      if (fs.remove(held)) removed++;
    }
    return removed;
  }

  deleteTrash(name) {
    const file = this.trashFile(name);
    if (!file) return false;
    const { body, meta } = parseMemoFile(fs.readText(file) ?? '');
    fs.remove(file);
    this.purgeTrashAttachments(lockedFiles(body, meta, () => this.trashAttachmentFiles()));
    return true;
  }

  emptyTrash({ olderThanDays = null } = {}) {
    const cutoff = olderThanDays == null ? Infinity : Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let memos = 0;
    for (const t of this.trashEntries()) {
      if (t.at > cutoff) continue;
      fs.remove(t.file);
      memos++;
    }
    let held = [];
    try {
      held = fs.list(`${TRASH_DIR}/${ATTACH_DIR}`).filter((e) => !e.dir).map((e) => `${ATTACH_DIR}/${e.name}`);
    } catch {
      // 휴지통에 첨부 없음
    }
    const files = this.purgeTrashAttachments(held, cutoff);
    return { memos, files };
  }

  // ---------- 첨부 ----------

  newAttachmentPath(ext) {
    return `${ATTACH_DIR}/${stamp()}-${randomHex(2)}.${safeExt(ext)}`;
  }

  saveAttachment(bytes, ext) {
    const rel = this.newAttachmentPath(ext);
    fs.writeBase64(rel, toBase64(bytes));
    return rel;
  }

  // 앱이 받아 둔 임시 파일(공유받은 파일·고른 파일·인터넷 사진)을 첨부로
  commitAttachment(tempId, ext) {
    const rel = this.newAttachmentPath(ext);
    fs.commitTemp(tempId, rel);
    return rel;
  }

  // 폴더 밖으로 벗어나는 경로(../)는 거부한다.
  resolve(rel) {
    const parts = String(rel ?? '').split('/').filter((p) => p && p !== '.');
    if (!parts.length || parts.includes('..')) return null;
    return parts.join('/');
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
      fs.writeText(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
      this.index = index;
      this.emit('indexed', index);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

installLockMethods(Vault);
