// 비밀 폴더 — 폴더 비밀번호로 메모 · 첨부 · 폴더 이름까지 암호화해 메모 폴더 안 _memoking/secret/ 에 둔다 (PC · 휴대폰 같은 규칙)
//   _memoking 은 메모 목록 · 검색 · 위젯 · AI 비서가 보지 않는 곳이라 비밀 폴더는 이름까지 드러나지 않고, Drive 동기화는 그대로 된다.
//   _memoking/secret/<폴더 id>/
//     folder.json          { v, n, s, check, name } — 소금 · 반복 횟수와, 폴더 열쇠로 잠근 확인 글 · 폴더 이름
//     <메모 id>.mks         메모 파일 전체(머리말 + 본문)를 잠근 글 — 파일 이름은 무작위라 무엇인지 알 수 없다
//     <메모 id>.alarms.json 일정 · 알림의 때만 (잠기지 않음 — 잠긴 동안에도 "비밀 메모의 일정" 으로 알리려고. 이름 · 내용은 없음)
//     files/<무작위>.<확장자>.mks  첨부(사진 · 파일)를 잠근 바이트
//   열쇠: PBKDF2-SHA256(비밀번호 NFC, 소금 16바이트, n 번) → 32바이트 → AES-256-GCM (잠금 메모 memo-lock.js 와 같은 암호)
//   비밀번호는 어디에도 저장하지 않는다 — 잊으면 아무도(메모킹도) 열 수 없다.
//   파일 읽기 · 쓰기는 플랫폼이 준 fs 로만 (PC Rust · 휴대폰 Kotlin — _memoking/secret 아래만 허락)
import { bytesBase64 } from './base64.js';
import { gcm, pbkdf2Async, sha256 } from '../../vendor/noble-crypto.js';
import { parseMemoFile, serializeMemoFile, extractTitle, extractPreview, extractAttachments } from './memo-file.js';
import { cleanFolderName } from './folders.js';

export const SECRET_DIR = '_memoking/secret';
export const SECRET_ITERATIONS = 310_000;
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 2_000_000;
const VERSION = 1;
const CHECK = 'memoking-secret-folder';
const TEXT_TAG = 'mks1';
const BYTES_TAG = new Uint8Array([0x4d, 0x4b, 0x53, 0x31]); // "MKS1"
/** 비밀 메모 본문에서 잠근 첨부를 가리키는 앞머리 (보통 메모의 attachments/ 자리) */
export const SECRET_FILE_PREFIX = 'secret-file/';
/** 목록 · 화면에서 비밀 메모를 가리키는 id — 보통 메모 id 와 겹치지 않게 */
export const SECRET_ID_PREFIX = 'secret:';

const b64 = bytesBase64;
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
/** 파일 이름 · 폴더 id 로 쓸 무작위 글자 (무엇인지 드러나지 않게) */
export const randomId = (bytes = 9) => hex(random(bytes));

export function secretPasswordProblem(password) {
  if (String(password ?? '').length < 4) return '비밀번호는 4자 이상으로 정해 주세요';
  return null;
}

async function deriveKey(password, salt, iterations) {
  return pbkdf2Async(sha256, new TextEncoder().encode(String(password).normalize('NFC')), salt, { c: iterations, dkLen: 32 });
}

/** 글 → "mks1.<IV>.<암호문>" (저장마다 새 IV) */
export function sealText(text, key) {
  const iv = random(12);
  return `${TEXT_TAG}.${b64(iv)}.${b64(gcm(key, iv).encrypt(new TextEncoder().encode(String(text))))}`;
}

/** 잠근 글 → 글, 열쇠가 다르거나 망가졌으면 null */
export function openText(sealed, key) {
  const [tag, iv, data] = String(sealed ?? '').trim().split('.');
  if (tag !== TEXT_TAG || !iv || !data) return null;
  try {
    return new TextDecoder().decode(gcm(key, unb64(iv)).decrypt(unb64(data)));
  } catch {
    return null;
  }
}

/** 바이트 → "MKS1" + IV(12) + 암호문 */
export function sealBytes(bytes, key) {
  const iv = random(12);
  const data = gcm(key, iv).encrypt(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const out = new Uint8Array(4 + 12 + data.length);
  out.set(BYTES_TAG, 0);
  out.set(iv, 4);
  out.set(data, 16);
  return out;
}

/** 잠근 바이트 → 바이트, 열쇠가 다르거나 망가졌으면 null */
export function openBytes(bytes, key) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (b.length < 16 + 16 || BYTES_TAG.some((v, i) => b[i] !== v)) return null;
  try {
    return gcm(key, b.subarray(4, 16)).decrypt(b.subarray(16));
  } catch {
    return null;
  }
}

/** 새 비밀 폴더의 기록과 열쇠 */
export async function newFolderRecord(name, password, { iterations = SECRET_ITERATIONS } = {}) {
  const clean = cleanFolderName(name);
  if (!clean) throw new Error('폴더 이름으로 쓸 수 없어요');
  const problem = secretPasswordProblem(password);
  if (problem) throw new Error(problem);
  const salt = random(16);
  const key = await deriveKey(password, salt, iterations);
  return { record: { v: VERSION, n: iterations, s: b64(salt), check: sealText(CHECK, key), name: sealText(clean, key) }, key, name: clean };
}

/** 폴더 기록을 비밀번호로 연다 → { key, name } (다르면 예외) */
export async function unlockRecord(record, password) {
  if (!record || typeof record !== 'object') throw new Error('비밀 폴더 정보가 망가졌어요');
  if (record.v !== VERSION) throw new Error('이 메모킹보다 새 버전에서 만든 비밀 폴더예요. 메모킹을 업데이트해 주세요');
  // 파일에 적힌 반복 횟수를 그대로 믿지 않는다 (몇 시간씩 멈추거나 영영 못 열지 않게)
  if (!(record.n >= MIN_ITERATIONS && record.n <= MAX_ITERATIONS) || typeof record.s !== 'string') throw new Error('비밀 폴더 정보가 망가졌어요');
  const key = await deriveKey(password, unb64(record.s), record.n);
  if (openText(record.check, key) !== CHECK) throw new Error('비밀번호가 달라요');
  return { key, name: openText(record.name, key) ?? '비밀 폴더' };
}

/** 이름만 바꾼 기록 */
export function renamedRecord(record, key, name) {
  const clean = cleanFolderName(name);
  if (!clean) throw new Error('폴더 이름으로 쓸 수 없어요');
  return { ...record, name: sealText(clean, key) };
}

const folderDir = (fid) => `${SECRET_DIR}/${fid}`;
const recordPath = (fid) => `${folderDir(fid)}/folder.json`;
const memoPath = (fid, mid) => `${folderDir(fid)}/${mid}.mks`;
const alarmsPath = (fid, mid) => `${folderDir(fid)}/${mid}.alarms.json`;
const filePath = (fid, name) => `${folderDir(fid)}/files/${name}.mks`;
const SAFE = /^[0-9a-f]{6,64}$/;
const SAFE_FILE = /^[0-9a-f]{6,64}(\.[a-z0-9]{1,8})?$/;

export const secretMemoId = (fid, mid) => `${SECRET_ID_PREFIX}${fid}/${mid}`;
/** "secret:<폴더>/<메모>" → { fid, mid } (아니면 null) */
export function parseSecretId(id) {
  const m = /^secret:([0-9a-f]{6,64})\/([0-9a-f]{6,64})$/.exec(String(id ?? ''));
  return m ? { fid: m[1], mid: m[2] } : null;
}
export const isSecretId = (id) => Boolean(parseSecretId(id));

/** 메모의 일정 · 알림에서 때만 남긴 것 (이름을 빼서 잠기지 않는 파일에 둔다) — 꺼 둔 것 · 끝낸 할 일은 빼고 */
export function alarmReminders(meta) {
  return (meta?.reminders ?? [])
    .filter((r) => r && r.enabled !== false && !r.done)
    .map(({ title: _t, ...rest }) => rest);
}

/**
 * 비밀 폴더 저장소 — fs: { list(dir) → [{ name, dir }], readText(rel), writeText(rel, text), readBytes(rel), writeBytes(rel, bytes), remove(rel) }
 *   열쇠는 연 동안만 이 안(keys)에 — lock · lockAll 로 잊는다
 */
export class SecretFolders {
  constructor(fs) {
    this.fs = fs;
    this.keys = new Map(); // fid → { key, name }
  }

  /** 메모 폴더 안의 비밀 폴더 id 들 (잠겼든 열렸든 — 이름은 열어야 안다) */
  async ids() {
    const list = (await this.fs.list(SECRET_DIR).catch(() => null)) ?? [];
    return list.filter((e) => e.dir && SAFE.test(e.name)).map((e) => e.name);
  }

  async record(fid) {
    const text = await this.fs.readText(recordPath(fid)).catch(() => null);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** 새 비밀 폴더 → { fid, name } (만들면 바로 열린 채) */
  async create(name, password, o) {
    const { record, key, name: clean } = await newFolderRecord(name, password, o);
    for (const [, v] of this.keys) if (v.name === clean) throw new Error('같은 이름의 비밀 폴더가 이미 열려 있어요');
    const fid = randomId();
    await this.fs.writeText(recordPath(fid), JSON.stringify(record));
    this.keys.set(fid, { key, name: clean });
    return { fid, name: clean };
  }

  /** 비밀번호에 맞는 비밀 폴더를 모두 연다 → 연 [{ fid, name }] (하나도 없으면 예외 '비밀번호가 달라요') — 폴더마다 비밀번호가 따로 */
  async unlockWith(password) {
    const opened = [];
    let broken = null;
    for (const fid of await this.ids()) {
      if (this.keys.has(fid)) continue;
      const record = await this.record(fid);
      try {
        const { key, name } = await unlockRecord(record, password);
        this.keys.set(fid, { key, name });
        opened.push({ fid, name });
      } catch (err) {
        if (err.message !== '비밀번호가 달라요') broken ??= err;
      }
    }
    if (!opened.length) throw broken ?? new Error('비밀번호가 달라요');
    return opened;
  }

  lock(fid) {
    this.keys.delete(fid);
  }

  lockAll() {
    this.keys.clear();
  }

  /** 지금 열린 비밀 폴더 [{ fid, name }] (이름순) */
  opened() {
    return [...this.keys].map(([fid, v]) => ({ fid, name: v.name })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  key(fid) {
    const k = this.keys.get(fid)?.key;
    if (!k) throw new Error('비밀 폴더가 잠겨 있어요. 비밀번호를 넣고 다시 해 주세요');
    return k;
  }

  async rename(fid, name) {
    const record = await this.record(fid);
    const next = renamedRecord(record, this.key(fid), name);
    await this.fs.writeText(recordPath(fid), JSON.stringify(next));
    this.keys.get(fid).name = openText(next.name, this.key(fid));
  }

  /** 열린 폴더의 메모 목록 (목록 카드에 쓸 것만) */
  async memos(fid) {
    const key = this.key(fid);
    const list = (await this.fs.list(folderDir(fid)).catch(() => null)) ?? [];
    const out = [];
    for (const e of list) {
      const m = /^([0-9a-f]{6,64})\.mks$/.exec(e.name);
      if (e.dir || !m) continue;
      const plain = openText(await this.fs.readText(memoPath(fid, m[1])).catch(() => ''), key);
      if (plain == null) continue; // 다른 열쇠로 잠긴 것 · 망가진 것은 건너뛴다
      const { meta, body } = parseMemoFile(plain);
      out.push({
        id: secretMemoId(fid, m[1]), mid: m[1], secret: fid,
        title: extractTitle(body), preview: extractPreview(body, 160),
        color: meta.color, created: meta.created, updated: meta.updated, pinned: Boolean(meta.pinned), tags: meta.tags ?? [],
        meta, body,
      });
    }
    return out.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
  }

  /** 메모 하나 → { meta, body } (없으면 null) */
  async read(fid, mid) {
    const text = await this.fs.readText(memoPath(fid, mid)).catch(() => null);
    if (text == null) return null;
    const plain = openText(text, this.key(fid));
    if (plain == null) throw new Error('비밀 메모를 열지 못했어요. 다른 기기에서 비밀번호를 바꿨다면 다시 열어 주세요');
    return parseMemoFile(plain);
  }

  /** 메모 저장 (새 메모면 mid 없이 → 새 mid). 알림 시각은 따로 잠기지 않는 파일에 */
  async write(fid, mid, meta, body) {
    const key = this.key(fid);
    const id = mid && SAFE.test(mid) ? mid : randomId();
    await this.fs.writeText(memoPath(fid, id), sealText(serializeMemoFile({ ...meta }, body), key));
    const reminders = alarmReminders(meta);
    if (reminders.length) await this.fs.writeText(alarmsPath(fid, id), JSON.stringify({ reminders }));
    else await this.fs.remove(alarmsPath(fid, id)).catch(() => {});
    return id;
  }

  /** 메모 지우기 — 그 메모만 쓰던 잠근 첨부도 (휴지통에 두지 않는다: 휴지통은 잠기지 않는 곳이라) */
  async remove(fid, mid) {
    const doc = await this.read(fid, mid).catch(() => null);
    await this.fs.remove(memoPath(fid, mid));
    await this.fs.remove(alarmsPath(fid, mid)).catch(() => {});
    if (!doc) return;
    const others = new Set();
    for (const m of await this.memos(fid)) for (const src of secretFiles(m.body)) others.add(src);
    for (const src of secretFiles(doc.body)) if (!others.has(src)) await this.fs.remove(filePath(fid, src.slice(SECRET_FILE_PREFIX.length))).catch(() => {});
  }

  /** 첨부를 잠가 둔다 → 본문에 쓸 주소 "secret-file/<무작위>.<확장자>" */
  async addFile(fid, bytes, ext = '') {
    const e = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const name = `${randomId(12)}${e ? `.${e}` : ''}`;
    await this.fs.writeBytes(filePath(fid, name), sealBytes(bytes, this.key(fid)));
    return `${SECRET_FILE_PREFIX}${name}`;
  }

  /** 잠근 첨부의 바이트 (src 는 본문의 "secret-file/…") */
  async fileBytes(fid, src) {
    const name = String(src).slice(SECRET_FILE_PREFIX.length);
    if (!String(src).startsWith(SECRET_FILE_PREFIX) || !SAFE_FILE.test(name)) throw new Error('비밀 첨부 주소가 아니에요');
    const plain = openBytes(await this.fs.readBytes(filePath(fid, name)), this.key(fid));
    if (!plain) throw new Error('비밀 첨부를 열지 못했어요');
    return plain;
  }

  /** 비밀 폴더 통째로 지우기 (열린 폴더만 — 이름을 확인한 사람만) */
  async removeFolder(fid) {
    this.key(fid);
    const list = (await this.fs.list(folderDir(fid)).catch(() => null)) ?? [];
    for (const e of list) {
      if (e.dir) {
        for (const f of (await this.fs.list(`${folderDir(fid)}/${e.name}`).catch(() => null)) ?? []) await this.fs.remove(`${folderDir(fid)}/${e.name}/${f.name}`);
        await this.fs.remove(`${folderDir(fid)}/${e.name}`).catch(() => {});
      } else await this.fs.remove(`${folderDir(fid)}/${e.name}`);
    }
    await this.fs.remove(folderDir(fid)).catch(() => {});
    this.keys.delete(fid);
  }

  /** 모든 비밀 폴더의 일정 · 알림 (잠겨 있어도) → [{ id, reminders }] — 이름 없이 "비밀 메모의 일정" 으로만 알린다 */
  async alarms() {
    const out = [];
    for (const fid of await this.ids()) {
      for (const e of (await this.fs.list(folderDir(fid)).catch(() => null)) ?? []) {
        const m = /^([0-9a-f]{6,64})\.alarms\.json$/.exec(e.name);
        if (!m) continue;
        try {
          const reminders = JSON.parse(await this.fs.readText(`${folderDir(fid)}/${e.name}`)).reminders;
          if (Array.isArray(reminders) && reminders.length) out.push({ id: secretMemoId(fid, m[1]), reminders });
        } catch {
          // 망가진 알림 파일은 건너뛴다
        }
      }
    }
    return out;
  }
}

/** 본문에서 잠근 첨부 주소들 */
export const secretFiles = (body) => extractAttachments(body).filter((src) => src.startsWith(SECRET_FILE_PREFIX));

/**
 * 보통 메모를 비밀 폴더로 옮길 글 — 본문의 attachments/… 를 잠근 첨부로 바꾼다
 *   readAttachment(src) → 바이트 (없으면 null — 그 주소는 그대로 둔다)
 * @returns {Promise<{ meta, body, moved: string[] }>} moved: 잠가 옮긴 원래 첨부 주소 (부르는 쪽이 원래 파일을 치운다)
 */
export async function sealMemoInto(store, fid, meta, body, readAttachment) {
  let next = String(body);
  const moved = [];
  for (const src of [...new Set(extractAttachments(body))]) {
    if (!src.startsWith('attachments/')) continue;
    const bytes = await readAttachment(src).catch(() => null);
    if (!bytes) continue;
    const ref = await store.addFile(fid, bytes, src.split('.').pop());
    next = next.split(src).join(ref);
    moved.push(src);
  }
  const id = await store.write(fid, null, { ...meta, folder: undefined }, next);
  return { mid: id, meta, body: next, moved };
}

/**
 * 비밀 메모를 보통 메모로 꺼낼 글 — 잠근 첨부를 풀어 attachments/ 에 쓴다
 *   writeAttachment(bytes, ext) → 새 "attachments/…" 주소
 */
export async function openMemoOut(store, fid, mid, writeAttachment) {
  const doc = await store.read(fid, mid);
  if (!doc) throw new Error('비밀 메모를 찾지 못했어요');
  let body = doc.body;
  for (const src of [...new Set(secretFiles(body))]) {
    const bytes = await store.fileBytes(fid, src);
    const ref = await writeAttachment(bytes, src.split('.').pop());
    body = body.split(src).join(ref);
  }
  return { meta: doc.meta, body };
}
