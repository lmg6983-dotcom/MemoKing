// 일정 탭이 구독하는 다른 캘린더(.ics 주소, 예: Google 캘린더 "iCal 형식의 비공개 주소") 받기 — PC 메인 프로세스
//   화면(목록 창)에서 바로 받으면 CORS 에 막히므로 메인이 받는다. 주소는 비밀(누구나 그 캘린더를 볼 수 있음)이라
//   메모 폴더(동기화 · AI 인덱스)가 아니라 이 PC 설정(%APPDATA%\MemoKing)에만 둔다.
//   받은 글은 %APPDATA%\MemoKing\calendars\<id>.ics 에 두어 인터넷이 없을 때·다시 켰을 때 그대로 보인다.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeFeeds, checkFeedStatus, feedResponseText, MAX_FEED_BYTES, FEED_FRESH_MS } from '../app/js/core/calendar-feed-list.js';

export const FRESH_MS = FEED_FRESH_MS;
const TIMEOUT_MS = 20_000;

/** 응답 본문을 limit 바이트까지만 */
async function readLimited(res, limit) {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error('캘린더가 너무 커요 (5MB 넘음)');
  if (!res.body?.getReader) {
    const text = await res.text();
    if (Buffer.byteLength(text) > limit) throw new Error('캘린더가 너무 커요 (5MB 넘음)');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new Error('캘린더가 너무 커요 (5MB 넘음)');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class CalendarFeeds {
  /**
   * @param {{ dir: string, fetch: typeof fetch, getList: () => any[], setList: (list: any[]) => void, now?: () => number }} options
   */
  constructor({ dir, fetch: fetchImpl, getList, setList, now = Date.now }) {
    this.dir = dir;
    this.fetch = fetchImpl;
    this.getList = getList;
    this.setList = setList;
    this.now = now;
    this.cache = new Map(); // id → { url, text, at }
    this.inflight = new Map(); // id → Promise
  }

  list() {
    return normalizeFeeds(this.getList());
  }

  /** 구독 목록 저장 — 빠진 캘린더의 받아 둔 글은 지운다 */
  save(list) {
    const next = normalizeFeeds(list);
    const keep = new Set(next.map((f) => f.id));
    for (const f of this.list()) {
      if (keep.has(f.id) && next.find((n) => n.id === f.id)?.url === f.url) continue;
      this.cache.delete(f.id);
      fs.rm(this.file(f.id), { force: true }, () => {});
    }
    this.setList(next);
    return next;
  }

  file(id) {
    return path.join(this.dir, `${id}.ics`);
  }

  // 받아 둔 글 (메모리 → 파일). 주소가 바뀌었으면 없는 것으로
  cached(feed) {
    const mem = this.cache.get(feed.id);
    if (mem) return mem.url === feed.url ? mem : null;
    try {
      const raw = fs.readFileSync(this.file(feed.id), 'utf8');
      const nl = raw.indexOf('\n');
      const meta = JSON.parse(raw.slice(0, nl));
      if (meta.url !== feed.url) return null;
      const entry = { url: feed.url, text: raw.slice(nl + 1), at: meta.at };
      this.cache.set(feed.id, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * 한 캘린더의 .ics 글 — 받아 둔 지 15분 안이면 그것, 아니면 새로 받는다. 받지 못하면 받아 둔 것과 오류를 함께
   * @returns {Promise<{ text: string, at: number, error?: string }>}
   */
  async get(id, { force = false } = {}) {
    const feed = this.list().find((f) => f.id === id);
    if (!feed) return { text: '', at: 0, error: '없는 캘린더예요' };
    const old = this.cached(feed);
    if (!force && old && this.now() - old.at < FRESH_MS) return { text: old.text, at: old.at };
    if (!this.inflight.has(id)) {
      this.inflight.set(id, this.download(feed).finally(() => this.inflight.delete(id)));
    }
    try {
      return await this.inflight.get(id);
    } catch (err) {
      return { text: old?.text ?? '', at: old?.at ?? 0, error: err.message || '캘린더를 받지 못했어요' };
    }
  }

  async download(feed) {
    let res;
    try {
      res = await this.fetch(feed.url, { headers: { Accept: 'text/calendar, */*;q=0.5' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new Error('캘린더 주소에 연결하지 못했어요 (인터넷 확인)');
    }
    checkFeedStatus(res.status); // 본문을 받기 전에
    const text = feedResponseText(res.status, await readLimited(res, MAX_FEED_BYTES));
    const entry = { url: feed.url, text, at: this.now() };
    // 받는 사이 연결을 끊었거나 주소를 바꿨으면 남기지 않는다 (비공개 주소가 든 파일이 남지 않게)
    if (!this.list().some((f) => f.id === feed.id && f.url === feed.url)) return { text, at: entry.at };
    this.cache.set(feed.id, entry);
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(this.file(feed.id), `${JSON.stringify({ url: feed.url, at: entry.at })}\n${text}`);
    } catch {
      // 다음에 다시 받으면 됨
    }
    return { text, at: entry.at };
  }
}
