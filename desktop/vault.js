// 메모 폴더(볼트) — 폴더 속 .md 파일들을 DB처럼 다룬다.
// 안드로이드에서는 이 파일만 Capacitor 파일 API 버전으로 바꾸면 된다.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  parseMemoFile, serializeMemoFile, normalizeMeta, toLocalIso, plainLines, extractTitle, extractPreview,
  extractMedia, isBlankBody, titleToFileName, COLORS, isAlbumPageTitle } from '../app/js/core/memo-file.js';
import { indexOutput, indexKey, AGENT_GUIDE } from '../app/js/core/indexer.js';
import { extractTags } from '../app/js/core/tags.js';
import { taskProgress } from '../app/js/core/tasks.js';
import { isLockedBody, parseLocked } from '../app/js/core/memo-lock.js';
import { isLiveCached } from '../app/js/core/reminders.js';
import { installLockMethods, lockedFiles, diskCopy } from '../app/js/core/vault-locks.js';
import { textMatcher } from '../app/js/core/text-match.js';
import { folderOf, cleanFolderName, isFolderName, resolveMovedTwin } from '../app/js/core/folders.js';
import {
  VERSIONS_DIR, versionName, versionTime, safeVersionId, isVersionName, shouldKeepVersion, versionsToPrune, describeVersions } from '../app/js/core/versions.js';

export const APP_DIR = '_memoking';
export const ATTACH_DIR = 'attachments';
const SCAN_INTERVAL = 4000;
const INDEX_DELAY = 1500;
// 색인(index.json)은 다른 스레드에서 만든다 — 메모가 많으면 몇백 ms 걸려, 메인 프로세스에서 하면 그동안 키 입력 · 창 끌기가 멈췄다.
//   설치본에서는 작업 스레드가 asar 안 파일을 못 읽어 밖에 둔다 (build-dist.mjs asarUnpack)
const INDEX_WORKER = path.join(import.meta.dirname, 'index-worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
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
    this.defaultMode = 'life'; // 새 메모가 들어갈 Work / Life (main.js 가 설정에서)
    this.orphanDelay = orphanDelay;
    this.orphans = new Map(); // 없어진 메모 id → 그 메모가 쓰던 첨부 (확인 대기)
    this.orphanTimer = null;
    /** @type {Map<string, {id, file: string|null, meta, body, mtimeMs, size, idSaved: boolean}>} */
    this.entries = new Map();
    this.partsCache = new WeakMap(); // 메모(entry) → 본문에서 뽑은 것 (bodyParts)
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
      this.indexKey = indexKey(this.index); // 내용이 같으면 켤 때 다시 쓰지 않게 (Drive 가 매번 올리던 것)
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
    // 아직 쓰지 않은 색인은 끄기 전에 바로 (잠근 메모의 풀린 글이 색인에 남지 않게)
    if (this.indexTimer || this.indexing) this.writeIndex({ now: true });
    this.closed = true;
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
    const twins = []; // 폴더를 옮긴 사이 다른 기기가 옛 자리를 되살린 같은 id 의 두 파일 (core/folders.js)

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
      const twin = id && next.has(id) ? resolveMovedTwin(next.get(id), { file, meta }) : null;
      if (twin) {
        twins.push(twin);
        continue;
      }
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
    if (twins.length) {
      for (const t of twins) this.settleTwin(t);
      this.rescanSoon();
    }

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

  // 본문에서 뽑는 것(제목 · 미리 보기 · 사진 · 태그 · 체크리스트 …)은 본문이 같으면 다시 뽑지 않는다
  //   (목록은 메모를 저장할 때마다 다시 만드는데, 메모 2,000개를 매번 다 읽으면 한 번에 1초 넘게 걸렸다)
  bodyParts(entry) {
    const hit = this.partsCache.get(entry);
    if (hit && hit.body === entry.body) return hit;
    const body = entry.body;
    const media = extractMedia(body);
    const has = (kind) => media.some((m) => m.kind === kind);
    const parts = {
      body,
      title: extractTitle(body),
      preview: extractPreview(body, 1200), // 목록을 확대하면 카드에 요약을 여러 줄 보여 주므로 넉넉히
      thumb: media.find((m) => m.kind === 'image')?.src ?? null,
      video: media.find((m) => m.kind === 'video')?.src ?? null, // 사진이 없으면 목록 카드에 이 영상의 첫 장면 (video-poster.js)
      images: media.filter((m) => m.kind === 'image' && !isAlbumPageTitle(m.title)).slice(0, 24).map((m) => m.src), // 회상 달력 (그날의 사진 — 문서를 넣은 장은 빼고)
      tags: extractTags(body),
      hasImage: has('image'),
      hasWebLink: /\]\(https?:\/\/|<https?:\/\//i.test(body),
      hasAudio: has('audio'),
      hasVideo: has('video'),
      hasFile: has('file'),
      tasks: taskProgress(body), // 체크리스트 진행 (모두 끝나면 카드에 CLEAR 도장)
      locked: isLockedBody(body),
    };
    this.partsCache.set(entry, parts);
    return parts;
  }

  summary(entry) {
    const p = this.bodyParts(entry);
    return {
      id: entry.id,
      file: entry.file,
      title: p.title,
      preview: p.preview,
      color: entry.meta.color,
      pinned: entry.meta.pinned,
      created: entry.meta.created,
      updated: entry.meta.updated,
      thumb: p.thumb,
      video: p.video,
      images: [...p.images], // 받는 쪽이 고쳐도 기억해 둔 것은 그대로
      day: entry.meta.day || '', // 회상 달력: "이 날의 기록으로" 정한 날
      mode: entry.meta.mode ?? 'life', // Work / Life
      folder: entry.file ? folderOf(entry.file) : entry.folder ?? '', // 메모킹 폴더 (core/folders.js)
      tags: [...p.tags],
      hasImage: p.hasImage,
      hasWebLink: p.hasWebLink,
      hasAudio: p.hasAudio,
      hasVideo: p.hasVideo,
      hasFile: p.hasFile,
      reminderCount: entry.meta.reminders.filter((r) => isLiveCached(r)).length, // 종 버튼·일정 탭과 같은 규칙 (앞으로 울릴 것만)
      linkCount: entry.meta.links.filter((id) => this.entries.has(id)).length,
      tasks: p.tasks && typeof p.tasks === 'object' ? { ...p.tasks } : p.tasks,
      locked: p.locked,
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
    return [...this.entries.values()].filter((e) => e.file).map((e) => ({ id: e.id, body: e.body, updated: e.meta?.updated }));
  }

  // 매직키 메모 검색용: 메모마다 제목·본문 글 — 다듬은 글(서식 뺀 줄)은 본문이 같으면 다시 만들지 않는다
  //   (매직키는 글자마다 찾으므로, 메모 2,000개를 매번 다듬으면 키 한 번에 0.9초 걸렸다)
  searchable() {
    const prev = this.searchCache ?? new Map();
    const next = new Map();
    const out = [];
    for (const e of this.entries.values()) {
      if (!e.file) continue;
      let c = prev.get(e.id);
      if (!c || c.body !== e.body) c = { body: e.body, title: extractTitle(e.body), text: plainLines(e.body).join('\n') };
      next.set(e.id, c);
      out.push({ id: e.id, title: c.title, text: c.text, updated: e.meta.updated, color: e.meta.color });
    }
    this.searchCache = next; // 지운 메모는 여기서 빠진다
    return out;
  }

  search(query, excludeId = null) {
    const matches = textMatcher(query);
    const texts = new Map(this.searchable().map((m) => [m.id, m.text])); // 매직키와 같이 기억해 둔 찾기용 글
    return this.list().filter((m) => m.id !== excludeId && matches(m.title, texts.get(m.id) ?? ''));
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
      day: entry.meta.day || '',
      mode: entry.meta.mode ?? 'life',
      aiTags: Array.isArray(entry.meta.extra?.aiTags) ? entry.meta.extra.aiTags : null, // AI 가 단 태그 (null = 아직 안 봄)
      aiEvents: Array.isArray(entry.meta.extra?.aiEvents) ? entry.meta.extra.aiEvents : null, // 일정을 찾아 본 줄 (null = 아직 안 봄)
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
  // mode: Work / Life (없으면 지금 고른 모드 — defaultMode)
  //   folder: 넣을 메모킹 폴더 (없으면 맨 위)
  create({ color, mode, folder } = {}) {
    const id = randomUUID();
    this.entries.set(id, this.newEntry(id, color, mode ?? this.defaultMode, folder));
    return id;
  }

  newEntry(id, color, mode, folder = '') {
    const now = toLocalIso();
    const meta = normalizeMeta({ id, created: now, updated: now, color: COLORS.includes(color) ? color : undefined, mode });
    return { id, file: null, folder: cleanFolderName(folder), meta, body: '', mtimeMs: 0, size: 0, idSaved: true };
  }

  import({ body, created, updated, pinned = false, color, mode }) {
    if (isLockedBody(body)) return null; // 잠금 형식 글은 아무도 열 수 없는 메모가 되므로 새 메모로 만들지 않는다
    const id = this.create({ color, mode });
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
    if (!entry.file) entry.file = this.uniqueFile(titleToFileName(extractTitle(entry.body)), entry.folder ?? '');
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

  // ---------- 메모킹 폴더 (core/folders.js) ----------

  /** 메모 폴더 맨 위의 하위 폴더 중 메모킹 폴더 (빈 폴더도) */
  folders() {
    try {
      return fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory() && isFolderName(d.name)).map((d) => d.name);
    } catch {
      return [];
    }
  }

  /** 새 폴더 → 만든 이름 (이미 있으면 그대로) */
  createFolder(name) {
    const dir = cleanFolderName(name);
    if (!dir) throw new Error('폴더 이름으로 쓸 수 없어요');
    fs.mkdirSync(path.join(this.root, dir), { recursive: true });
    return dir;
  }

  /**
   * 메모를 다른 폴더로 ("" = 맨 위). 파일을 옮긴 뒤 머리말에 옮긴 때(moved)를 남긴다 — 그사이 다른 기기가 옛 자리를
   *   되살려도 이 자리로 맞추게 (settleTwin). 파일은 디스크의 것 그대로 옮긴다 (잠긴 메모가 풀린 채 쓰이지 않게)
   */
  moveToFolder(id, folder) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const dir = folder ? cleanFolderName(folder) : '';
    if (folder && !dir) throw new Error('폴더 이름으로 쓸 수 없어요');
    if (!entry.file) {
      entry.folder = dir; // 아직 파일이 없는 새 메모 — 처음 저장할 때 이 폴더에
      return true;
    }
    if (folderOf(entry.file) === dir) return true;
    const target = this.uniqueFile(path.posix.basename(entry.file, '.md'), dir);
    fs.mkdirSync(path.dirname(this.abs(target)), { recursive: true });
    fs.renameSync(this.abs(entry.file), this.abs(target));
    entry.file = target;
    try {
      const { meta, body } = parseMemoFile(fs.readFileSync(this.abs(target), 'utf8'));
      meta.extra = { ...meta.extra, moved: toLocalIso() };
      writeAtomic(this.abs(target), serializeMemoFile(meta, body));
      entry.meta.extra = { ...entry.meta.extra, moved: meta.extra.moved };
      const stat = fs.statSync(this.abs(target));
      entry.mtimeMs = stat.mtimeMs;
      entry.size = stat.size;
      entry.diskMeta = diskCopy(entry.meta);
    } catch (err) {
      this.emit('error', err); // 옮기기는 됐다 — 옮긴 때만 못 남김
    }
    this.changed([id]);
    return true;
  }

  // 같은 id 의 두 파일을 하나로: 남길 자리에 남길 내용을 두고, 다른 파일은 휴지통으로 (지우지 않는다)
  settleTwin({ target, source, drop }) {
    try {
      if (source !== target) writeAtomic(this.abs(target), fs.readFileSync(this.abs(source), 'utf8'));
      fs.renameSync(this.abs(drop), path.join(this.trashDir, `${path.posix.basename(drop, '.md')} (${stamp()}).md`));
    } catch (err) {
      this.emit('error', err);
    }
  }

  // 휴지통 파일의 머리말에 있던 폴더를 남기거나(folder) 지운다(null) — 되살릴 때 그 폴더로
  markTrashedFrom(file, folder) {
    try {
      const { meta, body } = parseMemoFile(fs.readFileSync(file, 'utf8'));
      const { trashedFrom, ...rest } = meta.extra ?? {};
      meta.extra = folder ? { ...rest, trashedFrom: folder } : rest;
      writeAtomic(file, serializeMemoFile(meta, body));
    } catch (err) {
      this.emit('error', err);
    }
  }

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
      if (trashed && folderOf(entry.file)) this.markTrashedFrom(dest, folderOf(entry.file));
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
    // 폴더에 있던 메모는 그 폴더로 (폴더가 없어졌으면 다시 만든다)
    const dir = cleanFolderName(meta.extra?.trashedFrom);
    const target = this.uniqueFile(titleToFileName(extractTitle(body)), dir);
    fs.mkdirSync(path.dirname(this.abs(target)), { recursive: true });
    fs.renameSync(file, this.abs(target));
    if (meta.extra?.trashedFrom !== undefined) this.markTrashedFrom(this.abs(target), null);
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

  /** 색인을 다시 만들어 바뀌었으면 쓴다. 보통은 작업 스레드에서 (만드는 중에 또 부르면 끝난 뒤 한 번 더), now 면 여기서 바로 */
  writeIndex({ now = false } = {}) {
    clearTimeout(this.indexTimer);
    this.indexTimer = null;
    if (this.closed) return;
    if (this.indexing && !now) {
      this.indexAgain = true;
      return;
    }
    const memos = [...this.entries.values()].filter((e) => e.file).map(({ id, file, meta, body }) => ({ id, file, meta, body }));
    if (now) {
      this.indexing = null; // 만들던 것은 버린다 (이것이 더 새 글)
      this.putIndex(indexOutput(memos));
      return;
    }
    const job = indexOffThread(memos).catch(() => indexOutput(memos)); // 작업 스레드를 못 띄우면 여기서라도
    this.indexing = job;
    job.then((out) => {
      if (this.indexing !== job || this.closed) return;
      this.indexing = null;
      this.putIndex(out);
      if (this.indexAgain) {
        this.indexAgain = false;
        this.writeIndex();
      }
    });
  }

  putIndex({ index, key, text }) {
    if (key === this.indexKey) return; // generatedAt 만 다르면 같은 색인 (불필요한 동기화 없게)
    try {
      writeAtomic(this.indexFile, text);
      this.index = index;
      this.indexKey = key;
      this.emit('indexed', index);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

function indexOffThread(memos) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(INDEX_WORKER, { workerData: memos });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`색인 작업이 끝났어요 (${code})`))); // message 뒤의 exit 는 무시된다
  });
}

installLockMethods(Vault);
