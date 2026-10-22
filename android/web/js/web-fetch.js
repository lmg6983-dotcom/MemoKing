// 인터넷에서 받아 오는 것 — desktop/link-previews.js 와 같은 규칙, 같은 저장 위치:
//   <메모 폴더>/_memoking/link-previews.json   주소별 미리보기 정보
//   <메모 폴더>/_memoking/link-previews/        사진·아이콘 (주소 SHA-1 앞 16자리 이름)
// PC 에서 먼저 받아 둔 카드는 휴대폰에서 다시 받지 않고, 그 반대도 마찬가지.
import { parseLinkPreview, detectCharset, hostOf, youtubeOEmbedUrl, parseYoutubeOEmbed, staleYoutubeEntry } from '../../app/js/core/link-preview.js';
import { imageExtFromType, imageExtFromUrl, MAX_REMOTE_IMAGE_BYTES } from '../../app/js/core/remote-images.js';
import { fs, call } from './native.js';
import { UI } from '../../app/js/core/ui-text.js';

const FILE = '_memoking/link-previews.json';
const DIR = '_memoking/link-previews';
const MAX_HTML = 2 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_ICON = 300 * 1024;
const RETRY_FAILED_MS = 6 * 60 * 60 * 1000;
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

async function hash(s) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const latin1Bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// 사진 하나를 받아 임시 파일로 → 확장자를 정해 메모 폴더의 rel(확장자 제외) 에 저장. 저장한 경로를 돌려준다.
async function downloadImage(url, limit, relWithoutExt) {
  const res = await call('http', { url, accept: IMAGE_ACCEPT, limit, save: true });
  if (res.status < 200 || res.status > 299 || !res.temp) throw new Error(`HTTP ${res.status}`);
  const type = res.type ?? '';
  const ext = imageExtFromType(type) ?? (/icon/.test(type) || /\.ico(\?|$)/i.test(url) ? 'ico' : imageExtFromUrl(url));
  if (!ext || !res.size) {
    fs.dropTemp(res.temp);
    throw new Error('그림이 아니에요. 그림 주소(PNG, JPG, GIF, WebP)를 넣어 주세요');
  }
  const rel = typeof relWithoutExt === 'function' ? relWithoutExt(ext) : `${relWithoutExt}.${ext}`;
  fs.commitTemp(res.temp, rel);
  return rel;
}

/** 붙여넣은 인터넷 사진을 메모 폴더 attachments/ 로 (데스크탑 attachment:fetch) */
export function fetchRemoteImage(vault, url) {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('인터넷 주소가 아니에요'));
  return downloadImage(url, MAX_REMOTE_IMAGE_BYTES, (ext) => vault.newAttachmentPath(ext));
}

export class LinkPreviews {
  constructor() {
    this.cache = null;
    this.inflight = new Map();
    this.failed = new Map();
  }

  // 메모 폴더를 바꾸면 처음부터
  reset() {
    this.cache = null;
    this.inflight.clear();
    this.failed.clear();
  }

  #readDisk() {
    try {
      return JSON.parse(fs.readText(FILE) ?? '{}') ?? {};
    } catch {
      return {};
    }
  }

  #load() {
    this.cache ??= this.#readDisk();
  }

  // 다른 기기가 먼저 받아 둔 정보가 동기화돼 들어왔을 수 있으므로 없을 때만 파일을 다시 읽는다
  #reloadIfMissing(url) {
    if (this.cache[url]) return;
    const disk = this.#readDisk();
    if (disk[url]) this.cache = { ...disk, ...this.cache };
  }

  #save() {
    fs.mkdirs('_memoking');
    fs.writeText(FILE, JSON.stringify(this.cache, null, 1));
  }

  async get(url, { refresh = false } = {}) {
    this.#load();
    this.#reloadIfMissing(url);
    const cached = this.cache[url];
    const failedAt = this.failed.get(url);
    if (!refresh && ((cached && !staleYoutubeEntry(url, cached)) || (failedAt && Date.now() - failedAt < RETRY_FAILED_MS))) return this.#view(url, cached);
    if (!this.inflight.has(url)) {
      const job = this.#fetchPreview(url)
        .then((entry) => {
          this.cache[url] = entry;
          this.failed.delete(url);
          this.#save();
          return entry;
        })
        .catch((err) => {
          console.warn(UI.linkPreviewMark, url, err?.message);
          this.failed.set(url, Date.now());
          return cached ?? null;
        })
        .finally(() => this.inflight.delete(url));
      this.inflight.set(url, job);
    }
    return this.#view(url, await this.inflight.get(url));
  }

  #view(url, entry) {
    const exists = (rel) => Boolean(rel) && Boolean(fs.stat(rel));
    return {
      url,
      ok: Boolean(entry),
      title: entry?.title ?? '',
      description: entry?.description ?? '',
      site: entry?.site || hostOf(url),
      host: hostOf(url),
      image: exists(entry?.image) ? entry.image : '',
      imageUrl: entry?.imageUrl ?? '',
      icon: exists(entry?.icon) ? entry.icon : '',
    };
  }

  async #fetchPreview(url) {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error(UI.notUrl);
    const youtube = await this.#fetchYoutube(url).catch(() => null);
    if (youtube) return youtube;
    const res = await call('http', { url: target.href, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', limit: MAX_HTML, headOnly: true });
    if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
    const type = (res.type ?? '').toLowerCase();
    const finalUrl = res.url || target.href;
    const entry = { kind: 'page', title: '', description: '', site: '', image: '', imageUrl: '', icon: '', fetchedAt: new Date().toISOString() };
    let fileName = '';
    try {
      fileName = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '');
    } catch {
      // 이상한 주소
    }

    if (type.startsWith('image/')) {
      entry.title = fileName || hostOf(url);
      entry.imageUrl = finalUrl;
      entry.image = await this.#saveImage(finalUrl, MAX_IMAGE).catch(() => '');
      return entry;
    }
    if (!type.includes('html') && !type.includes('xml') && type) {
      entry.title = fileName || hostOf(url); // PDF 등 파일 주소
      return entry;
    }
    const raw = res.latin1 ?? '';
    const charset = detectCharset(type, raw.slice(0, 4096));
    let html;
    try {
      html = new TextDecoder(charset).decode(latin1Bytes(raw));
    } catch {
      html = new TextDecoder('utf-8').decode(latin1Bytes(raw));
    }
    const p = parseLinkPreview(html, finalUrl);
    Object.assign(entry, { title: p.title, description: p.description, site: p.site, imageUrl: p.image });
    const [image, icon] = await Promise.all([
      p.image ? this.#saveImage(p.image, MAX_IMAGE).catch(() => '') : '',
      p.icon ? this.#saveImage(p.icon, MAX_ICON).catch(() => '') : '',
    ]);
    entry.image = image;
    entry.icon = icon;
    return entry;
  }

  // 유튜브 동영상: oEmbed(제목·채널) + 정해진 썸네일 — PC 와 같은 카드 (동영상 주소가 아니면 null)
  async #fetchYoutube(url) {
    const oembed = youtubeOEmbedUrl(url);
    if (!oembed) return null;
    const res = await call('http', { url: oembed, accept: 'application/json', limit: MAX_ICON });
    if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
    const p = parseYoutubeOEmbed(new TextDecoder('utf-8').decode(latin1Bytes(res.latin1 ?? '')), url);
    if (!p.title) return null; // 비공개·삭제된 동영상 → 페이지를 읽어 본다
    const [image, icon] = await Promise.all([
      this.#saveImage(p.image, MAX_IMAGE).catch(() => ''),
      this.#saveImage(p.icon, MAX_ICON).catch(() => ''),
    ]);
    return { kind: 'youtube', title: p.title, description: p.description, site: p.site, image, imageUrl: p.image, icon, fetchedAt: new Date().toISOString() };
  }

  async #saveImage(url, limit) {
    fs.mkdirs(DIR);
    return downloadImage(url, limit, `${DIR}/${await hash(url)}`);
  }
}
