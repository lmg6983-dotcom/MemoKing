// 잠금 메모의 메모 폴더 쪽 규칙 (PC desktop/vault.js · 휴대폰 android/web/js/vault.js 가 함께 쓴다 — 한 곳만 고치면 되게)
//   비밀번호로 만든 열쇠(세션)는 메모를 연 동안만 vault.locks 에 — 닫으면 closeLock 으로 잊는다. 열쇠 만들기(느림)는 부르는 쪽이 비동기로
//   쓰는 것: vault.entries · vault.locks · vault.lockCopies · vault.device · vault.create · vault.write · vault.changed · vault.get
//            vault.keepVersion · vault.purgeVersions · vault.rescanSoon
import { isLockedBody, parseLocked, sealBody, unsealBody, lockRefs } from './memo-lock.js';
import { isBlankBody, sameBody, conflictCopyBody } from './memo-file.js';
import { toLocalIso } from './time.js';

class LockMethods {
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
    for (const set of this.lockCopies.values()) set.delete(id); // 이제 제 비밀번호로 연 메모
    return this.get(id);
  }

  /** 메모를 닫을 때: 열쇠를 잊는다 (그 메모를 연 동안 만든 사본의 열쇠도 함께 — 사본은 원래 메모가 열려 있는 동안만 고쳐 쓴다) */
  closeLock(id) {
    this.locks.delete(id);
    for (const copy of this.lockCopies.get(id) ?? []) this.locks.delete(copy);
    this.lockCopies.delete(id);
  }

  /** 다른 기기와 동시에 고친 내용의 사본: 원래 메모가 잠겼으면 사본도 같은 열쇠로 잠근다 (풀린 글이 사본으로 새지 않게) */
  importCopyOf(sourceId, body, { color } = {}) {
    const session = this.locks.get(sourceId);
    if (!session && this.entries.get(sourceId) && isLockedBody(this.entries.get(sourceId).body) && !isLockedBody(body)) return null;
    const id = this.create({ color });
    const entry = this.entries.get(id);
    if (session && !isLockedBody(body)) {
      entry.body = sealBody(body, session);
      this.setLockRefs(entry, body); // 한 번에 쓴다 (첨부 표까지)
    } else entry.body = body;
    this.write(entry);
    this.changed([id]);
    if (session) {
      // 열쇠는 원래 메모에 묶어 둔다 — 사본을 따로 누르면 비밀번호를 묻고, 원래 메모를 닫으면 함께 잊는다
      this.locks.set(id, session);
      if (!this.lockCopies.has(sourceId)) this.lockCopies.set(sourceId, new Set());
      this.lockCopies.get(sourceId).add(id);
    }
    return id;
  }

  /**
   * 저장할 글을 잠긴 메모에 맞게: 잠긴 메모면 들고 있는 열쇠로 다시 잠근 글로 (풀린 글이 파일에 닿지 않게)
   * @returns {{ body: string } | { refused: true } | { same: true }}
   */
  sealForSave(entry, body) {
    // 잠근 글을 바깥에서 고쳐 넘기는 일은 없다 (자동 태그 등) — 암호문이 깨지지 않게 그대로 둔다
    if (isLockedBody(body) && entry.file && body !== entry.body) return { same: true };
    if (!isLockedBody(entry.body) || isLockedBody(body)) return { body };
    const session = this.locks.get(entry.id);
    const plain = session ? this.plainOf(entry) : null;
    if (plain === null) return { refused: true }; // 열지 않았거나, 다른 기기가 다른 비밀번호로 다시 잠금 → 덮어쓰지 않음
    if (entry.file && plain === body) return { same: true };
    const sealed = sealBody(body, session);
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
      this.keepVersion(entry.id, theirs, { force: true });
      if (!isBlankBody(theirsPlain)) this.importCopyOf(entry.id, conflictCopyBody(theirsPlain), { color: entry.meta.color });
      return undefined;
    }
    const mine = entry.body;
    const copied = copy && !isBlankBody(mine) && !sameBody(mine, known) && Boolean(this.import({ body: mine, color: entry.meta.color }));
    entry.body = known; // 곧 다시 읽을 때 "바뀌었다" 로 알아채고 열린 화면에 알리게
    this.rescanSoon();
    return copied ? 'copied' : 'locked';
  }

  /** 버전 되돌리기를 해도 되는가 — 잠긴 메모에 풀린 버전·다른 비밀번호 버전을 덮어 잠금을 풀거나 비밀번호를 되돌리지 않게 */
  canRestore(entry, versionBody) {
    if (!isLockedBody(entry.body)) return !isLockedBody(versionBody) || this.locks.has(entry.id);
    if (!isLockedBody(versionBody)) return false;
    return parseLocked(versionBody)?.salt === parseLocked(entry.body)?.salt;
  }

  /** 열지 않은(풀 수 없는) 잠긴 메모들 — 첨부 정리가 그 메모의 사진을 치우지 않게 */
  sealedEntries() {
    return [...this.entries.values()].filter((e) => isLockedBody(e.body) && this.plainOf(e) === null);
  }

  /** 열쇠를 들고 있는 메모인가 (원래 메모가 열려 있는 사본은 제외 — 사본을 따로 열 때는 비밀번호를 묻는다) */
  isCopyLock(id) {
    return [...this.lockCopies.values()].some((set) => set.has(id));
  }

  /**
   * 잠그기: 지금 본문을 잠근 글로 바꾸고, 잠그기 전 버전 기록(풀린 글)은 지운다
   * keepOpen: 그 메모가 지금 열려 있을 때만 열쇠를 들고 있는다 (목록에서 잠갔으면 바로 비밀번호로 열리게)
   */
  lock(id, session, { keepOpen = true } = {}) {
    const entry = this.entries.get(id);
    if (!entry || isLockedBody(entry.body)) return null;
    const known = entry.body;
    entry.body = sealBody(known, session);
    this.setLockRefs(entry, known);
    entry.meta.updated = toLocalIso();
    entry.meta.device = this.device;
    if (this.write(entry, known, { copy: false }) !== true) return null; // 그사이 다른 기기가 잠금 — 아무것도 바꾸지 않음
    this.purgeVersions(id);
    if (keepOpen) this.locks.set(id, session);
    else this.locks.delete(id);
    this.changed([id]);
    return this.get(id);
  }

  /** 잠금 풀기 (연 동안만): 본문을 풀린 글로 */
  unlock(id) {
    const entry = this.entries.get(id);
    const plain = entry ? this.plainOf(entry) : null;
    if (!entry || !isLockedBody(entry.body) || plain === null) return null;
    const known = entry.body;
    entry.body = plain;
    const { lockRefs: _refs, ...extra } = entry.meta.extra ?? {};
    entry.meta.extra = extra;
    entry.meta.updated = toLocalIso();
    entry.meta.device = this.device; // 이어 쓰기 안내가 엉뚱한 기기 이름을 대지 않게
    if (this.write(entry, known, { copy: false }) !== true) return null; // 그사이 다른 기기가 다시 잠금
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
