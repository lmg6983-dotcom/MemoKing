// 휴대폰 메모 폴더의 비밀 폴더 쪽 (규칙 · 암호는 app/js/core/secret-folders.js — PC 와 같음)
//   비밀 메모는 vault.entries 안에 "파일이 없는 항목" 으로만 든다 (file: null, secret: 폴더 id)
//     → 목록(전체) · 검색 · 색인 · 위젯 · AI 비서 · 일정 탭은 파일이 있는 항목만 보므로 저절로 빠진다
//     → 저장(write)은 늘 잠가서 _memoking/secret 으로, 버전 기록은 id(secret:…)가 버전 폴더 이름이 될 수 없어 남지 않는다
//   열쇠는 연 동안만 — 앱을 벗어나면 lockSecrets() 로 잊고 항목도 치운다
import { fs, toBase64 } from './native.js';
import {
  SecretFolders, SECRET_DIR, SECRET_FILE_PREFIX, secretMemoId, parseSecretId, sealMemoInto, openMemoOut, secretFiles,
  sealBytes, randomId } from '../../app/js/core/secret-folders.js';
import { normalizeMeta, toLocalIso, COLORS, extractAttachments } from '../../app/js/core/memo-file.js';
import { cleanFolderName, folderOf } from '../../app/js/core/folders.js';

/** 목록에서 비밀 폴더를 가리키는 폴더 이름 ("secret:<폴더 id>") — 진짜 폴더 이름으로 쓸 수 없는 글자(:)라 겹치지 않는다 */
export const SECRET_FOLDER = 'secret:';
export const isSecretFolder = (name) => String(name ?? '').startsWith(SECRET_FOLDER) && !String(name).includes('/');
export const secretFolderId = (name) => (isSecretFolder(name) ? String(name).slice(SECRET_FOLDER.length) : null);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf', txt: 'text/plain',
};
const mimeOf = (src) => MIME[String(src).split('.').pop().toLowerCase()] ?? 'application/octet-stream';

// 파일 읽기 · 쓰기 (휴대폰 앱은 바로 답한다 — 잠근 글은 부른 그 자리에서 쓰인다)
const secretFs = {
  list: async (rel) => fs.list(rel) ?? [],
  readText: async (rel) => {
    const t = fs.readText(rel);
    if (t == null) throw new Error('없음');
    return t;
  },
  writeText: async (rel, text) => fs.writeText(rel, text),
  // 바이트는 앱의 메모 폴더 주소로 받는다 (Bridge 에 바이트 읽기가 없다)
  readBytes: async (rel) => {
    const res = await fetch(`${globalThis.memoking?.vaultBase ?? ''}${rel.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('없음');
    return new Uint8Array(await res.arrayBuffer());
  },
  writeBytes: async (rel, bytes) => fs.writeBase64(rel, toBase64(bytes)),
  remove: async (rel) => fs.remove(rel),
};

// 화면이 쓰는 잠근 첨부의 주소: 연 동안 풀어 둔 blob 주소 (media.js vaultUrl 이 secret-file/ 을 물으면)
const blobs = new Map(); // src → blob 주소
globalThis.memoking ??= {};
globalThis.memoking.secretUrl = (src) => blobs.get(src) ?? '';
const forgetBlobs = () => {
  for (const url of blobs.values()) URL.revokeObjectURL(url);
  blobs.clear();
};

/** 비밀 메모 알림의 이름 (Rust reminders.rs SECRET_ALARM 과 같은 글) */
export const SECRET_ALARM = '비밀 메모의 일정';
const HEX = /^[0-9a-f]{6,64}$/;

/** 비밀 메모 하나의 알림 파일 (때만 — 이름 없음) */
function secretAlarmList(fid, mid) {
  try {
    const list = JSON.parse(fs.readText(`${SECRET_DIR}/${fid}/${mid}.alarms.json`) ?? 'null')?.reminders;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function installSecretMethods(Vault) {
  // defineProperties: Object.assign 은 get secret() 을 한 번 불러 값만 베낀다 (그러면 vault 마다 열쇠가 따로 남지 않는다)
  Object.defineProperties(Vault.prototype, Object.getOwnPropertyDescriptors({
    get secret() {
      this._secret ??= new SecretFolders(secretFs);
      return this._secret;
    },

    /** 비밀번호로 비밀 폴더를 연다 → 연 [{ fid, name }] */
    /** 비밀 폴더 목록을 다음에 다시 읽게 (이름 바꾸기 · 지우기 뒤) */
    refreshSecretFolders() {
      this._secretSeen = 0;
    },

    /** 잠긴 비밀 폴더 하나를 비밀번호로 연다 (다르면 예외 '비밀번호가 달라요') */
    async unlockSecret(fid, password) {
      const opened = await this.secret.unlock(fid, password);
      this._secretSeen = 0;
      await this.loadSecret(fid);
      return opened;
    },

    /**
     * 폴더 메뉴 › 비밀 폴더로 만들기: 같은 이름의 비밀 폴더를 만들어 안의 메모(첨부까지)를 모두 잠가 옮기고 빈 폴더는 치운다
     *   잠긴 메모는 열지 못하니 남긴다 (그 폴더도) → { fid, left }
     */
    async makeSecretFolder(folder, password) {
      const made = await this.secret.create(folder, password);
      this._secretSeen = 0;
      await this.loadSecret(made.fid);
      let left = 0;
      for (const e of [...this.entries.values()]) {
        if (!e.file || folderOf(e.file) !== folder) continue;
        try {
          await this.moveToSecret(e.id, made.fid);
        } catch {
          left++;
        }
      }
      if (!left) this.deleteFolder(folder); // 메모가 아닌 파일이 있으면 폴더는 남는다
      return { fid: made.fid, left };
    },

    /** 비밀 폴더 메뉴 › 보통 폴더로 되돌리기: 같은 이름의 보통 폴더로 모두 풀어 꺼내고 비밀 폴더를 치운다 → 폴더 이름 */
    async makePlainFolder(fid) {
      const name = this.secret.opened().find((f) => f.fid === fid)?.name;
      if (!name) throw new Error('비밀 폴더가 잠겨 있어요. 비밀번호를 넣고 다시 해 주세요');
      const dir = this.createFolder(name);
      for (const e of [...this.entries.values()]) {
        if (e.secret !== fid) continue;
        if (!e.body) this.entries.delete(e.id);
        else await this.moveOutOfSecret(e.id, dir);
      }
      await this.secret.removeFolder(fid);
      this.lockSecrets(fid);
      this._secretSeen = 0;
      return dir;
    },

    /** 연 폴더의 메모를 항목으로 (다시 읽기) */
    async loadSecret(fid) {
      for (const [id, e] of this.entries) if (e.secret === fid) this.entries.delete(id);
      for (const m of await this.secret.memos(fid)) {
        // 잠긴 동안 울린 알림의 울림 표시(last · 꺼짐)는 알림 파일에만 — 메모로 옮겨 온다 (다음 저장에서 다시 울리지 않게, Rust secret_load 와 같음)
        const fired = secretAlarmList(fid, m.mid);
        for (const r of m.meta.reminders ?? []) {
          const a = fired.find((x) => x.id === r.id);
          if (a && 'last' in a) r.last = a.last;
          if (a && 'enabled' in a) r.enabled = a.enabled;
        }
        this.entries.set(m.id, { id: m.id, file: null, secret: fid, mid: m.mid, meta: m.meta, body: m.body, mtimeMs: 0, size: 0, idSaved: true });
      }
      this.changed([]);
      void this.prepareThumbs(fid); // 카드의 사진은 뒤에서 풀어 둔다 (다 풀면 목록을 다시 그린다)
    },

    /** 비밀 폴더를 잠근다 (fid 없으면 모두) — 항목 · 풀어 둔 첨부를 치운다 */
    lockSecrets(fid = null) {
      if (!this._secret?.keys.size) return false;
      if (fid) this.secret.lock(fid);
      else this.secret.lockAll();
      const ids = [];
      for (const [id, e] of this.entries) {
        if (e.secret && (!fid || e.secret === fid)) {
          this.entries.delete(id);
          ids.push(id);
        }
      }
      if (!this.secret.keys.size) forgetBlobs();
      this.secretTarget = null;
      this.changed(ids);
      return true;
    },

    /** 알림 실행기가 울릴 비밀 메모의 알림 [{ memoId, title, reminder }] — 잠겨 있어도 (이름 없이) */
    secretAlarmItems() {
      const out = [];
      for (const d of fs.list(SECRET_DIR) ?? []) {
        if (!d.dir || !HEX.test(d.name)) continue;
        for (const f of fs.list(`${SECRET_DIR}/${d.name}`) ?? []) {
          const mid = /^([0-9a-f]{6,64})\.alarms\.json$/.exec(f.name)?.[1];
          if (!mid) continue;
          for (const reminder of secretAlarmList(d.name, mid)) out.push({ memoId: secretMemoId(d.name, mid), title: SECRET_ALARM, reminder });
        }
      }
      return out;
    },

    /** 울림 표시를 적는다 — 알림 파일에, 연 폴더면 메모에도 (잠가서) → 적었나 */
    setSecretAlarm(id, reminder) {
      const p = parseSecretId(id);
      if (!p) return false;
      const entry = this.entries.get(id);
      if (entry) {
        // 알림 파일의 알림에는 이름이 없다 — 메모의 이름은 그대로
        this.setReminders(id, entry.meta.reminders.map((r) => (r.id === reminder.id ? { ...reminder, ...(r.title ? { title: r.title } : {}) } : r)));
      }
      const list = secretAlarmList(p.fid, p.mid);
      const i = list.findIndex((r) => r.id === reminder.id);
      if (i < 0) return Boolean(entry);
      const { title: _t, ...rest } = reminder;
      list[i] = rest;
      fs.writeText(`${SECRET_DIR}/${p.fid}/${p.mid}.alarms.json`, JSON.stringify({ reminders: list }));
      return true;
    },

    /** 연 비밀 폴더 [{ name: "secret:<id>", label, count, fid }] — 폴더 목록에 */
    //   잠긴 것도 이름은 보인다 (folder.json 의 title) — 폴더 목록이 자주 그리므로 1초 동안은 읽은 것을 쓴다
    secretFolders() {
      const now = Date.now();
      if (!this._secretSeen || now - this._secretSeen > 1000) {
        this._secretSeen = now;
        this._secretRecords = [];
        for (const d of fs.list(SECRET_DIR) ?? []) {
          if (!d.dir || !HEX.test(d.name)) continue;
          try {
            const record = JSON.parse(fs.readText(`${SECRET_DIR}/${d.name}/folder.json`) ?? 'null');
            if (record) this._secretRecords.push({ fid: d.name, title: cleanFolderName(record.title ?? '') || '비밀 폴더' });
          } catch {
            // 망가진 · 아직 다 받지 않은 폴더
          }
        }
      }
      const open = new Map((this._secret?.opened() ?? []).map((f) => [f.fid, f.name]));
      return this._secretRecords
        .map(({ fid, title }) => ({
          name: `${SECRET_FOLDER}${fid}`, label: open.get(fid) ?? title, fid, locked: !open.has(fid),
          count: open.has(fid) ? [...this.entries.values()].filter((e) => e.secret === fid && e.body).length : 0,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ko'));
    },

    /** 비밀 폴더의 메모 카드들 */
    secretList(fid) {
      return [...this.entries.values()]
        .filter((e) => e.secret === fid && e.body)
        .map((e) => ({ ...this.summary(e), folder: `${SECRET_FOLDER}${fid}`, secret: fid }))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0));
    },

    /** 비밀 폴더에 새 메모 (빈 채 — 쓰면 잠가 저장) */
    createSecretMemo(fid, { color, mode } = {}) {
      this.secret.key(fid); // 잠겼으면 예외
      const mid = randomId();
      const id = secretMemoId(fid, mid);
      const now = toLocalIso();
      const meta = normalizeMeta({ id, created: now, updated: now, color: COLORS.includes(color) ? color : undefined, mode: mode ?? this.defaultMode });
      this.entries.set(id, { id, file: null, secret: fid, mid, meta, body: '', mtimeMs: 0, size: 0, idSaved: true });
      return id;
    },

    /** 비밀 메모 저장 — 늘 잠가서 (vault.write 가 부른다) */
    writeSecret(entry) {
      const fid = entry.secret;
      this.secret.key(fid); // 잠겼으면 예외 (풀린 글을 다른 곳에 쓰지 않는다)
      entry.meta.id = entry.id;
      // 휴대폰 fs 는 바로 쓰므로 부른 자리에서 파일에 들어간다 (Promise 는 실패만 알린다)
      this.secret.write(fid, entry.mid, entry.meta, entry.body).catch((err) => console.error('[비밀 메모 저장]', err));
      entry.idSaved = true;
      return true;
    },

    /** 비밀 메모 지우기 — 휴지통(잠기지 않는 곳)에 두지 않고 바로 */
    removeSecret(id) {
      const entry = this.entries.get(id);
      if (!entry?.secret) return false;
      this.entries.delete(id);
      this.secret.remove(entry.secret, entry.mid).catch((err) => console.error('[비밀 메모 지우기]', err));
      this.changed([id]);
      return true;
    },

    /** 지금 연 메모가 비밀 메모면 그 폴더 — 새 첨부를 잠가 그 폴더에 둔다 */
    setSecretTarget(id) {
      this.secretTarget = this.entries.get(id)?.secret ?? null;
    },

    /** 비밀 메모에 넣을 첨부: 잠가 쓰고, 화면이 바로 보이게 blob 주소도 */
    saveSecretAttachment(bytes, ext) {
      const fid = this.secretTarget;
      const key = this.secret.key(fid);
      const e = String(ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
      const name = `${randomId(12)}${e ? `.${e}` : ''}`;
      fs.writeBase64(`${SECRET_DIR}/${fid}/files/${name}.mks`, toBase64(sealBytes(bytes, key)));
      const src = `${SECRET_FILE_PREFIX}${name}`;
      blobs.set(src, URL.createObjectURL(new Blob([bytes], { type: mimeOf(src) })));
      return src;
    },

    /** 첨부 폴더에 막 들어온 파일(rel)을 잠가 비밀 폴더로 — 주소는 바로 주고, 잠가 옮기기 · 평문 지우기는 곧이어 */
    sealCommitted(rel, ext) {
      const fid = this.secretTarget;
      const key = this.secret.key(fid);
      const e = String(ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
      const name = `${randomId(12)}${e ? `.${e}` : ''}`;
      const src = `${SECRET_FILE_PREFIX}${name}`;
      blobs.set(src, `${globalThis.memoking?.vaultBase ?? ''}${rel.split('/').map(encodeURIComponent).join('/')}`); // 잠그는 동안은 원래 파일로 보인다
      secretFs.readBytes(rel).then((bytes) => {
        fs.writeBase64(`${SECRET_DIR}/${fid}/files/${name}.mks`, toBase64(sealBytes(bytes, key)));
        blobs.set(src, URL.createObjectURL(new Blob([bytes], { type: mimeOf(src) })));
        fs.remove(rel);
      }).catch((err) => console.error('[비밀 첨부 잠그기]', err));
      return src;
    },

    /** 비밀 메모를 열기 전에: 본문의 잠근 첨부를 풀어 blob 주소로 (화면 · 미리보기가 바로 쓰게) */
    async prepareThumbs(fid) {
      const ids = [];
      for (const e of this.entries.values()) {
        const src = e.secret === fid ? this.summary(e).thumb : null;
        if (!src?.startsWith(SECRET_FILE_PREFIX) || blobs.has(src)) continue;
        await this.unsealBlob(fid, src);
        ids.push(e.id);
      }
      if (ids.length && this.secret.opened().some((o) => o.fid === fid)) this.changed(ids); // 그사이 잠갔으면 그만
    },

    async unsealBlob(fid, src) {
      try {
        const bytes = await this.secret.fileBytes(fid, src);
        blobs.set(src, URL.createObjectURL(new Blob([bytes], { type: mimeOf(src) })));
      } catch (err) {
        console.warn('[비밀 첨부]', src, err);
      }
    },

    async prepareSecret(id) {
      const entry = this.entries.get(id);
      if (!entry?.secret) return;
      for (const src of secretFiles(entry.body)) {
        if (!blobs.has(src)) await this.unsealBlob(entry.secret, src);
      }
    },

    /** 잠근 첨부의 바이트 (공유 · 저장 · 다른 앱으로) */
    async secretFileBytes(id, src) {
      const entry = this.entries.get(id);
      return this.secret.fileBytes(entry.secret, src);
    },

    /**
     * 보통 메모 → 비밀 폴더 (첨부까지 잠그고, 원래 메모 · 그 버전 기록 · 첨부는 휴지통에 두지 않고 지운다)
     * @returns {Promise<string>} 비밀 메모 id
     */
    async moveToSecret(id, fid) {
      const entry = this.entries.get(id);
      if (!entry || entry.secret) throw new Error('옮길 메모를 찾지 못했어요');
      const plain = this.plainOf(entry);
      if (plain == null) throw new Error('잠긴 메모는 먼저 열어서 잠금을 푼 뒤 옮겨 주세요');
      const { mid, moved } = await sealMemoInto(this.secret, fid, { ...entry.meta, extra: { ...entry.meta.extra } }, plain, (src) => secretFs.readBytes(src));
      const inUseElsewhere = new Set();
      for (const e of this.entries.values()) if (e.id !== id && e.file) for (const src of extractAttachments(e.body)) inUseElsewhere.add(src);
      if (entry.file) fs.remove(entry.file);
      this.entries.delete(id);
      this.purgeVersions(id);
      for (const src of moved) if (!inUseElsewhere.has(src)) fs.remove(src);
      this.closeLock?.(id);
      await this.loadSecret(fid);
      this.changed([id]);
      return secretMemoId(fid, mid);
    },

    /** 비밀 메모 → 보통 메모 (folder: 넣을 보통 폴더). 첨부는 풀어 attachments/ 로 */
    async moveOutOfSecret(id, folder = '') {
      const p = parseSecretId(id);
      if (!p) throw new Error('비밀 메모가 아니에요');
      const target = this.secretTarget;
      this.secretTarget = null; // 꺼낸 첨부는 보통 첨부로 (잠그지 않고)
      let out;
      try {
        out = await openMemoOut(this.secret, p.fid, p.mid, async (bytes, ext) => this.saveAttachment(bytes, ext));
      } finally {
        this.secretTarget = target;
      }
      const { meta, body } = out;
      const newId = this.create({ color: meta.color, mode: meta.mode, folder });
      const entry = this.entries.get(newId);
      Object.assign(entry.meta, { ...meta, id: newId });
      entry.body = body;
      this.write(entry);
      await this.secret.remove(p.fid, p.mid);
      this.entries.delete(id);
      this.changed([id, newId]);
      return newId;
    },
  }));
}
