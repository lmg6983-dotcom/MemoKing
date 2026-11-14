// Google Drive REST API v3 — 동기화에 필요한 만큼만 (안드로이드 DriveApi.kt 와 같은 일)
import fs from 'node:fs';
import { FOLDER } from './sync-engine.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,mimeType,md5Checksum,modifiedTime,createdTime,size';

export class DriveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const item = (o) => ({
  id: o.id,
  name: o.name ?? '',
  folder: o.mimeType === FOLDER,
  md5: o.md5Checksum ?? null,
  modified: Date.parse(o.modifiedTime ?? '') || 0,
  created: Date.parse(o.createdTime ?? '') || 0,
  size: Number(o.size ?? 0),
});

/**
 * Drive 의 "바뀐 것" 가운데 이 메모 폴더 안의 것만 (알고 있는 파일, 또는 알고 있는 폴더에 든 것).
 *   새로 생긴 폴더는 아는 것으로 쳐서 그 안의 새 파일도 담는다 — 목록의 순서와 상관없이.
 *   (Drive 는 폴더에 파일이 들 때마다 그 폴더를 목록 뒤로 보내, 새 폴더가 그 안의 파일보다 뒤에 올 수 있다.
 *    차례대로만 보면 그 파일을 빠뜨려, 다 훑는 15분 뒤에야 내려왔다: 메모를 새 폴더로 옮겼을 때)
 * @param {{ fileId: string, removed?: boolean, file?: any }[]} changes
 * @param {Iterable<string>} knownIds
 */
export function pickChanges(changes, knownIds) {
  const known = new Set(knownIds);
  const folders = changes.filter((c) => c.file?.mimeType === FOLDER);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of folders) {
      if (known.has(c.fileId) || !(c.file.parents ?? []).some((p) => known.has(p))) continue;
      known.add(c.fileId);
      grew = true;
    }
  }
  const items = [];
  for (const c of changes) {
    const parents = c.file?.parents ?? [];
    if (!known.has(c.fileId) && !parents.some((p) => known.has(p))) continue;
    items.push({ id: c.fileId, removed: Boolean(c.removed || c.file?.trashed), parents, item: c.file ? item({ ...c.file, id: c.fileId }) : null });
  }
  return items;
}

const quote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function describe(status, text) {
  let msg = text;
  try {
    msg = JSON.parse(text)?.error?.message ?? text;
  } catch {
    // 글자 응답
  }
  if (status === 401) return 'Google Drive 로그인이 끊겼어요. 설정에서 다시 연결해 주세요';
  if (status === 403 && /has not been used|disabled/.test(msg)) return 'Google Cloud 프로젝트에서 Google Drive API를 켜 주세요';
  if (status === 403) return `Google Drive가 허락하지 않았어요: ${msg}`;
  if (status === 404) return 'Google Drive에서 폴더나 파일을 찾지 못했어요';
  return `Google Drive 오류 (${status}): ${msg}`;
}

export class DriveApi {
  /** @param {{ auth: import('./google-auth.js').GoogleAuth, fetch?: typeof fetch }} options */
  constructor({ auth, fetch: fetchImpl = fetch }) {
    this.auth = auth;
    this.fetch = fetchImpl;
  }

  // 요청 하나: 토큰 만료(401)면 한 번 새 토큰으로, 429·5xx 는 잠깐 쉬었다 다시 (최대 3번)
  async request(method, url, { body, headers = {}, raw = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await this.auth.token()}`, ...headers },
        body,
      });
      if (res.ok) return raw ? res : (res.status === 204 ? {} : res.json());
      const text = await res.text().catch(() => '');
      if (res.status === 401 && attempt === 0) {
        this.auth.invalidate();
        continue;
      }
      if ((res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit/i.test(text))) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new DriveError(res.status, describe(res.status, text));
    }
  }

  json(method, url, data) {
    return this.request(method, url, { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
  }

  /** 구글 계정 이메일 */
  async about() {
    return (await this.request('GET', `${API}/about?fields=user`)).user?.emailAddress ?? '';
  }

  async query(q, orderBy) {
    const out = [];
    let page = null;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000', spaces: 'drive' });
      if (orderBy) params.set('orderBy', orderBy);
      if (page) params.set('pageToken', page);
      const res = await this.request('GET', `${API}/files?${params}`);
      out.push(...(res.files ?? []));
      page = res.nextPageToken ?? null;
    } while (page);
    return out;
  }

  async listChildren(folderId) {
    return (await this.query(`'${quote(folderId)}' in parents and trashed = false`)).map(item);
  }

  /** 폴더 고르기 화면용: parent("root" = 내 드라이브) 안의 폴더들 */
  async folders(parent = 'root') {
    return (await this.query(`'${quote(parent)}' in parents and mimeType = '${FOLDER}' and trashed = false`, 'name,createdTime')).map(item); // 같은 이름이면 먼저 만든 것부터
  }

  async download(id, file) {
    const res = await this.request('GET', `${API}/files/${encodeURIComponent(id)}?alt=media`, { raw: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }

  // "이어 올리기(resumable)": 올릴 주소를 받고 → 내용을 보낸다
  async upload(parentId, name, existingId, file) {
    const data = fs.readFileSync(file);
    const start = existingId
      ? `${UPLOAD}/files/${encodeURIComponent(existingId)}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`
      : `${UPLOAD}/files?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`;
    const meta = existingId ? {} : { name, parents: [parentId] };
    const res = await this.request(existingId ? 'PATCH' : 'POST', start, {
      body: JSON.stringify(meta),
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(data.length) },
      raw: true,
    });
    const location = res.headers.get('location');
    if (!location) throw new Error('Google Drive가 올릴 주소를 주지 않았어요. 잠시 뒤 다시 해 주세요');
    for (let attempt = 0; ; attempt++) {
      const put = await this.fetch(location, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
      if (put.ok) return item(await put.json());
      const text = await put.text().catch(() => '');
      if (put.status >= 500 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new DriveError(put.status, describe(put.status, text));
    }
  }

  async createFolder(parentId, name) {
    return item(await this.json('POST', `${API}/files?fields=${encodeURIComponent(FIELDS)}`, { name, mimeType: FOLDER, parents: [parentId] }));
  }

  /** 이 폴더 · 파일을 아직 쓸 수 있는가 (지워졌거나 휴지통이면 false) */
  async alive(id) {
    try {
      return !(await this.request('GET', `${API}/files/${encodeURIComponent(id)}?fields=id,trashed`)).trashed;
    } catch (err) {
      if (err?.status === 404) return false;
      throw err;
    }
  }

  /** parent 안의 이 이름 폴더들, 먼저 만든 것부터 (메모킹이 만든 것 중 — 휴지통 제외). Drive 는 같은 이름 폴더를 여럿 둘 수 있다 */
  async findFolders(name, parent = 'root') {
    const q = `'${quote(parent)}' in parents and name = '${quote(name)}' and mimeType = '${FOLDER}' and trashed = false`;
    return (await this.query(q)).map(item).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  }

  /** 내 드라이브 맨 위의 이 이름 폴더 — 여럿이면 늘 같은 것(가장 먼저 만든 것) */
  async findFolder(name) {
    return (await this.findFolders(name))[0] ?? null;
  }

  /** 링크가 있는 사람은 볼 수 있게 열고 그 링크 (공유) — 조직 설정이 막으면 DriveError 403 */
  async shareLink(id) {
    await this.json('POST', `${API}/files/${encodeURIComponent(id)}/permissions?fields=id`, { type: 'anyone', role: 'reader' });
    return (await this.request('GET', `${API}/files/${encodeURIComponent(id)}?fields=webViewLink`)).webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
  }

  async trash(id) {
    await this.json('PATCH', `${API}/files/${encodeURIComponent(id)}?fields=id`, { trashed: true });
  }

  /**
   * 지난 토큰 이후 이 메모 폴더 안에서 바뀐 것 — items: 바뀐 파일 · 폴더 (동기화가 Drive 폴더를 다 훑지 않고 이것만 반영)
   *   새로 생긴 폴더 안의 것도 담기게, 알고 있는 폴더에 새로 든 폴더는 바로 아는 것으로 친다
   */
  async changesSince(token, knownIds) {
    if (!token) return { changed: true, token: (await this.request('GET', `${API}/changes/startPageToken`)).startPageToken, items: null };
    const raw = [];
    let page = token;
    for (;;) {
      const params = new URLSearchParams({
        pageToken: page, pageSize: '1000', spaces: 'drive', includeRemoved: 'true', restrictToMyDrive: 'true',
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS},parents,trashed))`,
      });
      const res = await this.request('GET', `${API}/changes?${params}`);
      raw.push(...(res.changes ?? []));
      if (res.nextPageToken) {
        page = res.nextPageToken;
        continue;
      }
      const items = pickChanges(raw, knownIds);
      return { changed: items.length > 0, token: res.newStartPageToken ?? page, items };
    }
  }
}
