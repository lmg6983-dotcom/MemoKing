// 링크 미리보기 — 웹페이지를 한 번 읽어 제목·설명·대표 사진·아이콘을 메모 폴더에 모아 둔다.
//   <메모 폴더>/_memoking/link-previews.json   주소별 정보
//   <메모 폴더>/_memoking/link-previews/        사진·아이콘 파일
// 메모 폴더와 함께 동기화되므로 다른 PC·인터넷 없는 곳에서도 카드가 그대로 보인다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseLinkPreview, detectCharset, hostOf, youtubeOEmbedUrl, parseYoutubeOEmbed, staleYoutubeEntry } from '../app/js/core/link-preview.js';
import { imageExtFromType, imageExtFromUrl } from '../app/js/core/remote-images.js';

const FILE = 'link-previews.json';
const DIR = 'link-previews';
const MAX_HTML = 2 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_ICON = 300 * 1024;
const RETRY_FAILED_MS = 6 * 60 * 60 * 1000; // 받지 못한 주소는 6시간 뒤 다시 시도

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export class LinkPreviews {
  /**
   * @param {{ fetch: typeof fetch, userAgent?: string, timeout?: number }} options
   *   fetch: 메인 프로세스의 net.fetch (크롬과 같은 네트워크·프록시 설정)
   */
  constructor({ fetch, userAgent = '', timeout = 10_000 }) {
    this.fetch = fetch;
    this.userAgent = userAgent;
    this.timeout = timeout;
    this.cacheRoot = null;
    this.cache = {};
    this.inflight = new Map();
    this.failed = new Map(); // 이번 실행에서 받지 못한 주소 → 시각 (파일에는 남기지 않음)
  }

  #load(appDir) {
    if (this.cacheRoot === appDir) return;
    this.cacheRoot = appDir;
    this.cache = {};
    try {
      this.cache = JSON.parse(fs.readFileSync(path.join(appDir, FILE), 'utf8'));
    } catch {
      // 처음이거나 깨진 파일 → 새로
    }
  }

  // 다른 PC 가 먼저 받아 둔 정보가 동기화돼 들어왔을 수 있으므로 없을 때만 파일을 다시 읽는다
  #reloadIfMissing(appDir, url) {
    if (this.cache[url]) return;
    try {
      const disk = JSON.parse(fs.readFileSync(path.join(appDir, FILE), 'utf8'));
      if (disk[url]) this.cache = { ...disk, ...this.cache };
    } catch {
      // 파일 없음
    }
  }

  #save(appDir) {
    fs.mkdirSync(appDir, { recursive: true });
    const file = path.join(appDir, FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 1));
    fs.renameSync(tmp, file);
  }

  /**
   * 화면에 보여줄 미리보기. 사진은 메모 폴더 기준 상대 경로(image) — 파일이 아직 동기화되지 않았으면 인터넷 주소(imageUrl).
   * @param {{ root: string, appDir: string }} vault
   */
  async get(vault, url, { refresh = false } = {}) {
    const { appDir } = vault;
    this.#load(appDir);
    this.#reloadIfMissing(appDir, url);
    const cached = this.cache[url];
    const failedAt = this.failed.get(url);
    if (!refresh && ((cached && !staleYoutubeEntry(url, cached)) || (failedAt && Date.now() - failedAt < RETRY_FAILED_MS))) {
      return this.#view(vault, url, cached);
    }
    if (!this.inflight.has(url)) {
      const job = this.#fetchPreview(vault, url)
        .then((entry) => {
          this.cache[url] = entry;
          this.failed.delete(url);
          this.#save(appDir);
          return entry;
        })
        .catch((err) => {
          console.warn('[링크 미리보기]', url, err?.message);
          this.failed.set(url, Date.now());
          return cached ?? null;
        })
        .finally(() => this.inflight.delete(url));
      this.inflight.set(url, job);
    }
    return this.#view(vault, url, await this.inflight.get(url));
  }

  #view(vault, url, entry) {
    const exists = (rel) => Boolean(rel) && fs.existsSync(path.join(vault.root, rel));
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

  async #request(url, accept, limit, stopAtHeadEnd = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await this.fetch(url, {
        signal: controller.signal,
        headers: { Accept: accept, 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8', ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Number(res.headers.get('content-length') ?? 0) > limit && !stopAtHeadEnd) throw new Error('너무 큰 파일');
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        chunks.push(Buffer.from(chunk));
        total += chunk.byteLength;
        if (total > limit) {
          if (!stopAtHeadEnd) throw new Error('너무 큰 파일');
          break;
        }
        // 미리보기 정보는 <head> 안에 있으므로 </head> 를 보면 그만 받는다
        if (stopAtHeadEnd && total > 2048 && /<\/head>/i.test(Buffer.from(chunk).toString('latin1'))) break;
      }
      controller.abort();
      return { res, body: Buffer.concat(chunks), finalUrl: res.url || url };
    } finally {
      clearTimeout(timer);
    }
  }

  async #fetchPreview(vault, url) {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error('인터넷 주소가 아니에요');
    const youtube = await this.#fetchYoutube(vault, url).catch(() => null);
    if (youtube) return youtube;
    const { res, body, finalUrl } = await this.#request(target.href, 'text/html,application/xhtml+xml,*/*;q=0.8', MAX_HTML, true);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    const entry = { title: '', description: '', site: '', image: '', imageUrl: '', icon: '', fetchedAt: new Date().toISOString() };
    const fileName = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '');

    if (type.startsWith('image/')) {
      // 사진 주소를 붙여넣은 경우: 그 사진이 곧 미리보기
      entry.title = fileName || hostOf(url);
      entry.imageUrl = finalUrl;
      entry.image = await this.#saveImage(vault, finalUrl, MAX_IMAGE).catch(() => '');
      return entry;
    }
    if (!type.includes('html') && !type.includes('xml') && type) {
      entry.title = fileName || hostOf(url); // PDF 등 파일 주소
      return entry;
    }
    let html;
    const charset = detectCharset(type, body.subarray(0, 4096).toString('latin1'));
    try {
      html = new TextDecoder(charset).decode(body);
    } catch {
      html = new TextDecoder('utf-8').decode(body);
    }
    const p = parseLinkPreview(html, finalUrl);
    Object.assign(entry, { title: p.title, description: p.description, site: p.site, imageUrl: p.image });
    const [image, icon] = await Promise.all([
      p.image ? this.#saveImage(vault, p.image, MAX_IMAGE).catch(() => '') : '',
      p.icon ? this.#saveImage(vault, p.icon, MAX_ICON).catch(() => '') : '',
    ]);
    entry.image = image;
    entry.icon = icon;
    return entry;
  }

  // 유튜브 동영상: oEmbed(제목·채널) + 정해진 썸네일 — 언제 받아도 같은 카드 (동영상 주소가 아니면 null)
  async #fetchYoutube(vault, url) {
    const oembed = youtubeOEmbedUrl(url);
    if (!oembed) return null;
    const { body } = await this.#request(oembed, 'application/json', MAX_ICON);
    const p = parseYoutubeOEmbed(body.toString('utf8'), url);
    if (!p.title) return null; // 비공개·삭제된 동영상 → 페이지를 읽어 본다
    const [image, icon] = await Promise.all([
      this.#saveImage(vault, p.image, MAX_IMAGE).catch(() => ''),
      this.#saveImage(vault, p.icon, MAX_ICON).catch(() => ''),
    ]);
    return { kind: 'youtube', title: p.title, description: p.description, site: p.site, image, imageUrl: p.image, icon, fetchedAt: new Date().toISOString() };
  }

  // 사진을 _memoking/link-previews/<주소 해시>.<확장자> 로 저장하고 메모 폴더 기준 상대 경로를 돌려준다
  async #saveImage(vault, url, limit) {
    const { res, body: bytes } = await this.#request(url, 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', limit);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!bytes.length) throw new Error('빈 파일');
    const ext = imageExtFromType(contentType) ?? (/icon/.test(contentType) || /\.ico(\?|$)/i.test(url) ? 'ico' : imageExtFromUrl(url));
    if (!ext) throw new Error('그림이 아니에요');
    const dir = path.join(vault.appDir, DIR);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${hash(url)}.${ext}`;
    fs.writeFileSync(path.join(dir, name), bytes);
    return `_memoking/${DIR}/${name}`;
  }
}
