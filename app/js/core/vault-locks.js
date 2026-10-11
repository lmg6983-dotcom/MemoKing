// 잠금 메모의 메모 폴더 쪽 규칙 (PC desktop/vault.js · 휴대폰 android/web/js/vault.js 가 함께 쓴다 — 한 곳만 고치면 되게)
//   비밀번호로 만든 열쇠(세션)는 메모를 연 동안만 vault.locks 에 — 닫으면 closeLock 으로 잊는다. 열쇠 만들기(느림)는 부르는 쪽이 비동기로
//   쓰는 것: vault.entries · vault.locks · vault.lockCopies · vault.device · vault.create · vault.write · vault.changed · vault.get
//            vault.keepVersion · vault.purgeVersions · vault.versions · vault.version · vault.rescanSoon · vault.copyOf(Map)
//            vault.newEntry · vault.summary · vault.import · vault.readDiskIfChanged (플랫폼마다: 파일 읽기만)
//   저장(save)·버전 되돌리기·덮어쓰기 전 확인(keepChangedOnDisk)도 여기 — PC·휴대폰이 같은 규칙으로

import { isLockedBody, parseLocked, sealBody, unsealBody, lockRefs, lockRefKey } from './memo-lock.js';
import { isBlankBody, sameBody, conflictCopyBody, extractAttachments } from './memo-file.js';
import { toLocalIso } from './time.js';
import { versionTime } from './versions.js';

/**
 * 잠긴 메모(열지 않음)가 쓰는 첨부 파일들 — 머리말의 표로 후보(files) 중에서 고른다 (표가 없는 예전 잠금이면 알 수 없어 없음)
 * 풀린 메모면 글에서 바로
 */
export function lockedFiles(body, meta, files) {
  if (!isLockedBody(body)) return extractAttachments(body);
  const refs = meta?.extra?.lockRefs;
  const salt = parseLocked(body)?.salt;
  if (!Array.isArray(refs) || !salt) return [];
  const want = new Set(refs);
  return files().filter((src) => want.has(lockRefKey(src, salt)));
}

/** 머리말을 바꾸기 전 모습 (저장이 거절되면 되돌린다) */
export const metaSnapshot = (meta) => ({ ...meta, extra: { ...meta.extra } });
/** 이 메모를 잠글 때 고른 것 (제목도 숨기기) — 저장마다 같게 */
const sealOpts = (entry) => ({ hideTitle: entry.meta.extra?.lockHideTitle === true });

class LockMethods {
  /** 메모 저장 (잠긴 메모는 다시 잠근 글로). 저장되지 않았으면 refused(사본을 남겼으면 copied, 잠금 형식 글이면 invalid) */
  save(id, body) {
    let entry = this.entries.get(id);
    if (!entry) {
      // 쓰는 사이 파일이 지워졌다면, 화면에 남아 있는 내용으로 되살린다.
      entry = this.newEntry(id);
      this.entries.set(id, entry);
    }
    const before = metaSnapshot(entry.meta); // 쓰지 못하면 머리말을 되돌린다 (잠근 글의 첨부 표 포함)
    // 잠긴 메모: 연 동안만 저장할 수 있고, 저장은 늘 다시 잠근 글로
    const sealed = this.sealForSave(entry, body);
    if (sealed.same) return this.summary(entry);
    if (sealed.refused) {
      entry.meta = before;
      return { ...this.summary(entry), refused: true, invalid: Boolean(sealed.invalid) }; // 저장되지 않았다고 화면이 알게
    }
    body = sealed.body;
    if (entry.body === body && entry.file) return this.summary(entry);
    const known = entry.body; // 파일에 있다고 알고 있는 내용 (바꾸기 전)
    entry.body = body;
    entry.meta.updated = toLocalIso();
    entry.meta.device = this.device; // 이어 쓰기 안내: 다른 기기가 "방금 여기서 고쳤다" 를 알 수 있게
    if (!entry.file && isBlankBody(body)) return this.summary(entry);
    if (entry.file) this.keepVersion(id, known);
    // 그사이 다른 기기가 잠금: 저장하지 않음 (쓰던 글을 사본 메모로 남겼으면 copied)
    const wrote = this.write(entry, known);
    if (wrote !== true) {
      entry.meta = before; // 쓰지 않았으니 머리말도 그대로
      return { ...this.summary(entry), refused: true, copied: wrote === 'copied' };
    }
    this.changed([id]);
    return this.summary(entry);
  }

  // 지금 내용도 버전으로 남겨 두고(되돌리기를 되돌릴 수 있게) 고른 버전으로 바꾼다
  restoreVersion(id, name) {
    const body = this.version(id, name);
    const entry = this.entries.get(id);
    if (body == null || !entry) return null;
    // 잠긴 메모에 풀린 버전(또는 다른 비밀번호의 버전)을 덮어 잠금을 풀거나 비밀번호를 되돌리지 않게
    if (!this.canRestore(entry, body)) return { error: '잠긴 메모에는 잠기기 전 버전을 되돌릴 수 없어요' };
    this.keepVersion(id, entry.body, { force: true });
    const before = metaSnapshot(entry.meta);
    const known = entry.body;
    entry.body = body;
    this.refreshLockRefs(entry); // 되돌린 글의 첨부도 첨부 정리에서 지키게
    entry.meta.updated = toLocalIso();
    entry.meta.device = this.device;
    if (this.write(entry, known, { copy: false }) !== true) {
      entry.meta = before;
      return { error: '그사이 다른 기기에서 이 메모가 바뀌어 되돌리지 못했어요. 다시 해 주세요' };
    }
    this.changed([id]);
    return this.get(id);
  }

  /**
   * 마지막으로 읽은(쓴) 뒤 다른 기기(동기화)가 이 파일을 바꿨는데 아직 알아채기 전에 덮어쓰려 할 때 (write 가 부른다)
   *   undefined: 그대로 쓴다 · 'locked' / 'copied': 쓰지 않음(잠금) · 'skipped': 쓰지 않음(파일이 사라짐, 머리말만이라)
   */
  keepChangedOnDisk(entry, known, { copy = true } = {}) {
    const disk = this.readDiskIfChanged(entry); // null: 그대로(또는 못 읽음) · 'missing' · { body, meta }
    if (disk === 'missing') {
      // 글을 고친 저장이면 되살려 쓰지만, 머리말만 쓰는 것이면(다른 기기가 이름을 바꿨거나 지움) 쓰지 않고 다시 읽는다
      // — 다른 기기가 "제목도 숨기기" 로 잠그며 이름을 바꾼 메모를 풀린 글로 되살리지 않게
      if (!sameBody(entry.body, known)) return undefined;
      this.rescanSoon();
      return 'skipped';
    }
    if (!disk) return undefined;
    const theirs = disk.body;
    if (sameBody(theirs, known) || sameBody(theirs, entry.body) || isBlankBody(theirs)) return undefined;
    // 이번 쓰기는 글을 바꾸지 않는다(고정·색·알림 등 머리말만): 들어온 글을 그대로 두고 머리말만 더해 쓴다
    if (sameBody(entry.body, known)) return this.adoptTheirs(entry, theirs, disk.meta);
    // 잠근 글이 들어왔다: 같은 비밀번호로 고친 것이면 보통 고침처럼, 잠갔거나 비밀번호를 바꿨으면 덮어쓰지 않음
    if (isLockedBody(theirs)) return this.lockedOnDisk(entry, known, theirs, { copy });
    if (!copy) {
      // 잠그기·풀기·되돌리기 중: 그쪽 글을 덮어쓰지 않고 멈춘다 (부르는 쪽이 "다시 해 주세요")
      entry.body = known;
      this.rescanSoon();
      return 'locked';
    }
    this.keepVersion(entry.id, theirs, { force: true }); // 버전 기록에서도 되찾을 수 있게
    this.import({ body: conflictCopyBody(theirs), color: entry.meta.color });
    return undefined;
  }

  /** 이 메모의 본문 (잠겼으면 세션으로 푼 글, 못 풀면 null) */
  plainOf(entry) {
    if (!isLockedBody(entry.body)) return entry.body;
    const session = this.locks.get(entry.id);
    return session ? unsealBody(entry.body, session) : null;
  }

  /** 잠근 글로 바꿀 때: 머리말에 그 메모가 쓰는 첨부의 표를 (첨부 정리가 치우지 않게) */
  setLockRefs(entry, plain) {
    entry.meta.extra = { ...entry.meta.extra, lockRefs: lockRefs(plain, entry.body) };
  }

  /** 비밀번호를 넣어 연다 (세션이 이 메모를 풀 수 있어야) */
  openLock(id, session) {
    const entry = this.entries.get(id);
    if (!entry || !isLockedBody(entry.body) || unsealBody(entry.body, session) === null) return null;
    this.locks.set(id, session);
    // 첨부 표가 없는 잠긴 메모(예전 잠금·사본): 연 김에 적어 둔다 — 없으면 첨부 정리가 모두 멈추므로
    if (!Array.isArray(entry.meta.extra?.lockRefs)) {
      this.setLockRefs(entry, unsealBody(entry.body, session));
      try {
        this.write(entry, entry.body, { copy: false });
      } catch {
        // 다음에 다시
      }
      // 그사이 다른 기기가 다른 비밀번호로 다시 잠근 글을 받아들였다면 이 열쇠로는 열 수 없다 — 다시 비밀번호로
      if (unsealBody(entry.body, session) === null) {
        this.locks.delete(id);
        return null;
      }
    }
    // 이제 제 비밀번호로 연 메모 (원래 메모에 묶인 사본이 아님)
    const source = this.copyOf.get(id);
    if (source) this.lockCopies.get(source)?.delete(id);
    this.copyOf.delete(id);
    return this.get(id);
  }

  /** 메모를 닫을 때: 열쇠를 잊는다 (그 메모를 연 동안 만든 사본의 열쇠도 함께 — 사본은 원래 메모가 열려 있는 동안만 고쳐 쓴다) */
  closeLock(id) {
    this.locks.delete(id);
    for (const copy of this.lockCopies.get(id) ?? []) {
      this.locks.delete(copy);
      this.copyOf.delete(copy);
    }
    this.lockCopies.delete(id);
  }

  /** 다른 기기와 동시에 고친 내용의 사본: 원래 메모가 잠겼으면 사본도 같은 열쇠로 잠근다 (풀린 글이 사본으로 새지 않게) */
  importCopyOf(sourceId, body, { color } = {}) {
    const session = this.locks.get(sourceId);
    if (!session && this.entries.get(sourceId) && isLockedBody(this.entries.get(sourceId).body) && !isLockedBody(body)) return null;
    const id = this.create({ color });
    const entry = this.entries.get(id);
    if (session && !isLockedBody(body)) {
      const hide = this.entries.get(sourceId)?.meta.extra?.lockHideTitle === true;
      if (hide) entry.meta.extra = { ...entry.meta.extra, lockHideTitle: true };
      entry.body = sealBody(body, session, { hideTitle: hide });
      this.setLockRefs(entry, body); // 한 번에 쓴다 (첨부 표까지)
    } else {
      entry.body = body;
      const plain = session && unsealBody(body, session);
      if (typeof plain === 'string') this.setLockRefs(entry, plain);
    }
    this.write(entry);
    this.changed([id]);
    if (session) {
      // 열쇠는 원래 메모에 묶어 둔다 — 사본을 따로 누르면 비밀번호를 묻고, 원래 메모를 닫으면 함께 잊는다
      this.locks.set(id, session);
      if (!this.lockCopies.has(sourceId)) this.lockCopies.set(sourceId, new Set());
      this.lockCopies.get(sourceId).add(id);
      this.copyOf.set(id, sourceId);
    }
    return id;
  }

  /**
   * 저장할 글을 잠긴 메모에 맞게: 잠긴 메모면 들고 있는 열쇠로 다시 잠근 글로 (풀린 글이 파일에 닿지 않게)
   * @returns {{ body: string } | { refused: true } | { same: true }}
   */
  sealForSave(entry, body) {
    // 잠근 글을 바깥에서 고쳐 넘기는 일은 없다 (자동 태그 등) — 암호문이 깨지지 않게 그대로 둔다
    if (isLockedBody(body) && entry.file && isLockedBody(entry.body) && body !== entry.body) return { same: true };
    // 풀린 메모에 잠금 형식 글을 통째로(붙여 넣기 등): 아무도 열 수 없는 메모가 되므로 저장하지 않는다
    if (isLockedBody(body)) return isLockedBody(entry.body) ? { body } : { refused: true, invalid: true };
    const session = this.locks.get(entry.id);
    // 열쇠를 들고 있는 메모(연 잠긴 메모)인데 파일이 사라져 다시 만드는 중: 풀린 글이 새 파일로 나가지 않게 잠근 채로
    if (!isLockedBody(entry.body)) {
      if (!session || entry.file) return { body };
      const sealed = sealBody(body, session, sealOpts(entry));
      entry.meta.extra = { ...entry.meta.extra, lockRefs: lockRefs(body, sealed) };
      return { body: sealed };
    }
    const plain = session ? this.plainOf(entry) : null;
    if (plain === null) return { refused: true }; // 열지 않았거나, 다른 기기가 다른 비밀번호로 다시 잠금 → 덮어쓰지 않음
    if (entry.file && plain === body) return { same: true };
    const sealed = sealBody(body, session, sealOpts(entry));
    entry.meta.extra = { ...entry.meta.extra, lockRefs: lockRefs(body, sealed) }; // 첨부 정리가 이 메모의 사진을 치우지 않게
    return { body: sealed };
  }

  /**
   * 덮어쓰려는 사이 다른 기기가 파일을 잠근 글로 바꿨을 때 (keepChangedOnDisk 에서)
   *   같은 비밀번호로 고친 것(들고 있는 열쇠로 풀림): 보통 고침처럼 그쪽 글을 잠근 사본으로 남기고 저장은 계속 → undefined
   *   잠갔거나 다른 비밀번호로 다시 잠금: 파일은 그대로, 우리 글은 사본으로(copy 일 때) → 'copied' | 'locked'
   */
  lockedOnDisk(entry, known, theirs, { copy = true } = {}) {
    const session = this.locks.get(entry.id);
    const theirsPlain = session ? unsealBody(theirs, session) : null;
    if (theirsPlain !== null) {
      if (!copy) {
        // 잠그기·풀기·되돌리기 중 같은 비밀번호로 다른 기기가 고쳤다: 그쪽 글을 덮어쓰지 않고 멈춘다 (다시 하면 새 글로)
        entry.body = known;
        this.rescanSoon();
        return 'locked';
      }
      this.keepVersion(entry.id, theirs, { force: true });
      if (!isBlankBody(theirsPlain)) this.importCopyOf(entry.id, conflictCopyBody(theirsPlain), { color: entry.meta.color });
      return undefined;
    }
    const mine = entry.body;
    let copied = false;
    if (copy && !isBlankBody(mine) && !sameBody(mine, known)) {
      const copyId = this.create({ color: entry.meta.color });
      const c = this.entries.get(copyId);
      c.body = mine;
      // 잠근 글이면 첨부 표도 (들고 있는 열쇠로 풀어) — 표 없는 잠긴 메모는 첨부 정리를 멈추게 하므로
      const plain = isLockedBody(mine) && session ? unsealBody(mine, session) : null;
      if (typeof plain === 'string') this.setLockRefs(c, plain);
      this.write(c);
      this.changed([copyId]);
      copied = true;
    }
    entry.body = known; // 곧 다시 읽을 때 "바뀌었다" 로 알아채고 열린 화면에 알리게
    this.rescanSoon();
    return copied ? 'copied' : 'locked';
  }

  /** 버전 되돌리기를 해도 되는가 — 잠긴 메모에 풀린 버전·다른 비밀번호 버전을 덮어 잠금을 풀거나 비밀번호를 되돌리지 않게 */
  canRestore(entry, versionBody) {
    // 풀린 메모에는 잠긴 버전을 되돌리지 않는다 (다시 잠그려면 메뉴의 잠그기로 — 풀린 버전 기록이 남지 않게)
    if (!isLockedBody(entry.body)) return !isLockedBody(versionBody);
    if (!isLockedBody(versionBody) || !this.locks.has(entry.id)) return false; // 잠긴 메모는 비밀번호로 연 동안만
    return parseLocked(versionBody)?.salt === parseLocked(entry.body)?.salt;
  }

  /** 이 메모가 쓰는 첨부 (잠겼으면 열쇠로 풀거나, 열지 않았으면 머리말의 표로 첨부 폴더에서 찾는다) — 메모를 지울 때 */
  attachmentsOf(entry) {
    const plain = this.plainOf(entry);
    if (plain !== null) return extractAttachments(plain);
    return lockedFiles(entry.body, entry.meta, () => this.attachmentFiles());
  }

  /** 잠긴 글을 통째로 바꾼 뒤(버전 되돌리기): 첨부 표를 그 글에 맞게 — 풀 수 없으면 표를 지워 "알 수 없음"(치우지 않음)으로 */
  refreshLockRefs(entry) {
    if (!isLockedBody(entry.body)) return;
    const plain = this.plainOf(entry);
    if (plain !== null) this.setLockRefs(entry, plain);
    else {
      const { lockRefs: _refs, ...extra } = entry.meta.extra ?? {};
      entry.meta.extra = extra;
    }
  }

  /**
   * 첨부 정리가 지우면 안 되는 것: 메모들이 쓰는 첨부(연 잠긴 메모는 한 번만 풀어서) + 열지 않은 잠긴 메모가 쓸 수 있는 것
   * @param {{ body: string, meta?: object }[]} [more] 휴지통의 메모 등 함께 볼 것
   * @returns {(src: string) => boolean}
   */
  attachmentGuard(more = []) {
    const inUse = new Set();
    const sealed = []; // 열지 않은 잠긴 메모: { salt, refs } (암호문은 한 번만 읽는다) — 표가 없으면 무엇이든 쓸 수 있다고 본다
    for (const e of [...this.entries.values(), ...more]) {
      if (!isLockedBody(e.body)) {
        for (const src of extractAttachments(e.body)) inUse.add(src);
        continue;
      }
      const plain = e.id && this.entries.get(e.id) === e ? this.plainOf(e) : null;
      if (plain !== null) {
        for (const src of extractAttachments(plain)) inUse.add(src);
        continue;
      }
      const refs = e.meta?.extra?.lockRefs;
      if (!Array.isArray(refs)) {
        // 표가 없는 예전 잠금: 살아 있는 메모면 알 수 없으니 모두 남긴다(열면 표가 생김). 휴지통의 것은 열 수 없으므로 막지 않는다
        if (this.entries.get(e.id) === e) return () => true;
        continue;
      }
      sealed.push({ salt: parseLocked(e.body)?.salt, refs: new Set(refs) });
    }
    const cache = new Map(); // 같은 첨부를 여러 번 묻지 않게
    return (src) => {
      if (inUse.has(src)) return true;
      if (!sealed.length) return false;
      if (!cache.has(src)) cache.set(src, sealed.some((x) => x.refs.size && x.refs.has(lockRefKey(src, x.salt))));
      return cache.get(src);
    };
  }

  /**
   * 잠긴 메모의 버전 기록 중 지금 비밀번호로 잠긴 것이 아닌 것(잠기기 전 풀린 글·바꾸기 전 비밀번호)이 있으면 지운다
   * — 다른 기기에서 잠그거나 비밀번호를 바꿨을 때, 이 기기를 꺼 둔 사이였어도
   */
  dropUnsafeVersions(id) {
    if (this.device === 'ai') return; // AI 비서 연결 프로세스는 버전 기록을 건드리지 않는다 (켜져 있는 앱이 맡음)
    const entry = this.entries.get(id);
    const salt = entry && parseLocked(entry.body)?.salt;
    if (!salt) return;
    let names;
    try {
      names = this.versionNames(id);
    } catch {
      return;
    }
    // 버전은 시간 순: 잠기기 전(풀린)·예전 비밀번호 버전은 앞쪽에 있으므로 가장 오래된 것과 가장 새 것만 본다
    // (같은 초에 둘 이상이면 "-2" 처럼 붙으므로 이름이 아니라 시각으로 — 가장 새 시각의 것은 모두 본다)
    const timed = names.map((name) => ({ name, at: versionTime(name) ?? 0 })).sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    const newest = timed.at(-1)?.at;
    const check = [...new Set([timed[0]?.name, ...timed.filter((v) => v.at === newest).map((v) => v.name)])].filter(Boolean);
    if (check.some((name) => parseLocked(this.version(id, name) ?? '')?.salt !== salt)) this.purgeVersions(id);
  }

  /**
   * 머리말만 쓰는 사이 다른 기기가 글을 바꿨다: 그쪽 글과 잠금 정보(첨부 표·제목 숨기기)를 그대로 받아들이고 우리 머리말만 더한다
   * (잠긴 글이면 일정 이름을 빼고, 이 기기의 풀린 버전을 지우고, 열린 화면에 알린다)
   */
  adoptTheirs(entry, theirs, theirMeta) {
    entry.body = theirs;
    const { lockRefs: _r, lockHideTitle: _h, ...rest } = entry.meta.extra ?? {};
    const lockInfo = {};
    if (theirMeta?.extra?.lockRefs) lockInfo.lockRefs = theirMeta.extra.lockRefs;
    if (theirMeta?.extra?.lockHideTitle) lockInfo.lockHideTitle = true;
    entry.meta.extra = { ...rest, ...(isLockedBody(theirs) ? lockInfo : {}) };
    if (isLockedBody(theirs)) {
      entry.meta.reminders = (entry.meta.reminders ?? []).map(({ title: _t, ...r }) => r);
      setTimeout(() => this.dropUnsafeVersions(entry.id), 0);
    }
    this.notifyExternalSoon(entry.id);
  }

  /** 다른 기기에서 바뀐 글을 받아들였다고 (다시 읽은 것처럼) 알린다 — 열린 화면이 새 글·잠금을 알게 */
  notifyExternalSoon(id) {
    setTimeout(() => this.emit('changed', { ids: [id], external: [id], removed: [] }), 0);
  }

  /** 열쇠를 들고 있는 메모인가 (원래 메모가 열려 있는 사본은 제외 — 사본을 따로 열 때는 비밀번호를 묻는다) */
  isCopyLock(id) {
    return this.copyOf.has(id);
  }

  /**
   * 잠그기: 지금 본문을 잠근 글로 바꾸고, 잠그기 전 버전 기록(풀린 글)은 지운다
   * keepOpen: 그 메모가 지금 열려 있을 때만 열쇠를 들고 있는다 (목록에서 잠갔으면 바로 비밀번호로 열리게)
   */
  lock(id, session, { keepOpen = true, hideTitle = false } = {}) {
    const entry = this.entries.get(id);
    if (!entry || isLockedBody(entry.body)) return null;
    const known = entry.body;
    const before = metaSnapshot(entry.meta);
    const { lockHideTitle: _h, ...rest } = entry.meta.extra ?? {};
    entry.meta.extra = hideTitle ? { ...rest, lockHideTitle: true } : rest;
    entry.body = sealBody(known, session, { hideTitle });
    // 글에서 짐작한 일정 이름은 비밀일 수 있어 풀린 머리말에 남기지 않는다 (알림엔 메모 제목)
    entry.meta.reminders = (entry.meta.reminders ?? []).map(({ title: _t, ...r }) => r);
    this.setLockRefs(entry, known);
    entry.meta.updated = toLocalIso();
    entry.meta.device = this.device;
    if (this.write(entry, known, { copy: false }) !== true) {
      entry.meta = before; // 그사이 다른 기기가 잠금 — 아무것도 바꾸지 않음
      return null;
    }
    this.purgeVersions(id);
    if (keepOpen) this.locks.set(id, session);
    else this.locks.delete(id);
    if (hideTitle) this.finalize(id); // 파일 이름(첫 줄)도 바로 "잠긴 메모" 로
    this.changed([id]);
    return this.get(id);
  }

  /** 잠금 풀기 (연 동안만): 본문을 풀린 글로 */
  unlock(id) {
    const entry = this.entries.get(id);
    const plain = entry ? this.plainOf(entry) : null;
    if (!entry || !isLockedBody(entry.body) || plain === null) return null;
    const known = entry.body;
    const before = metaSnapshot(entry.meta);
    entry.body = plain;
    const { lockRefs: _refs, lockHideTitle: _hide, ...extra } = entry.meta.extra ?? {};
    entry.meta.extra = extra;
    entry.meta.updated = toLocalIso();
    entry.meta.device = this.device; // 이어 쓰기 안내가 엉뚱한 기기 이름을 대지 않게
    if (this.write(entry, known, { copy: false }) !== true) {
      entry.meta = before; // 그사이 다른 기기가 다시 잠금
      return null;
    }
    this.purgeVersions(id); // 잠긴 동안의 버전은 이제 열 수 없는 글이므로
    this.locks.delete(id);
    this.changed([id]);
    return this.get(id);
  }
}

/** 메모 폴더 클래스에 잠금 메모 메서드를 붙인다 */
export function installLockMethods(VaultClass) {
  for (const name of Object.getOwnPropertyNames(LockMethods.prototype)) {
    if (name !== 'constructor') Object.defineProperty(VaultClass.prototype, name, Object.getOwnPropertyDescriptor(LockMethods.prototype, name));
  }
}
