// 다른 캘린더 구독 목록 · 받은 글 확인 (ical.js 없이 — PC 메인 프로세스 · 휴대폰 받기가 함께 쓴다)
//   주소 정리, 구독 목록 정리, 받은 응답이 iCal 인지와 알기 쉬운 오류 문구, 다시 받을 때
import { UI } from './ui-text.js';
export const MAX_FEED_BYTES = 5 * 1024 * 1024;
export const MAX_FEEDS = 10;
// 구독 캘린더 색 (메모 색과 겹치지 않는 진한 색 — 달력에서 "다른 캘린더" 로 보이게)
export const FEED_COLORS = ['#4285f4', '#0b8043', '#8e24aa', '#f4511e', '#039be5', '#616161'];

/**
 * 붙여 넣은 캘린더 주소 → 받을 수 있는 주소 (webcal:// 은 https:// 로). 아니면 null
 * @param {string} raw
 */
export function normalizeFeedUrl(raw) {
  const text = String(raw ?? '').trim().replace(/^webcals?:\/\//i, 'https://');
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.toString();
}

/** 주소로 짐작한 캘린더 이름 — 이름을 비워 두면 */
export function feedLabel(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)google\.com$/.test(u.hostname)) return UI.googleCalendar;
    if (/(^|\.)(icloud|me)\.com$/.test(u.hostname)) return 'iCloud 캘린더';
    if (/outlook|office|live\.com/.test(u.hostname)) return 'Outlook 캘린더';
    if (/(^|\.)naver\.com$/.test(u.hostname)) return '네이버 캘린더';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '캘린더';
  }
}

/**
 * 캘린더별 설정 { 이름 또는 ID: { on, color? } } 을 안전한 모양으로 (네이버 캘린더 · 휴대폰 캘린더). 비었으면 null
 * @param {any} o
 */
export function normalizeCals(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 100)) {
    if (!k || k.length > 80) continue;
    out[k] = { on: v?.on !== false, ...(/^#[0-9a-f]{6}$/i.test(v?.color ?? '') ? { color: v.color } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/** 저장해 둔 구독 목록을 안전한 모양으로 [{ id, name, url, color, on, user?, pass? }] (user · pass 는 CalDAV 계정) */
export function normalizeFeeds(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const url = normalizeFeedUrl(f?.url);
    const user = typeof f.user === 'string' ? f.user.trim().slice(0, 200) : '';
    const key = `${user}@${url}`; // 같은 CalDAV 서버의 다른 계정은 따로
    if (!url || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: typeof f.id === 'string' && /^[\w-]{1,40}$/.test(f.id) ? f.id : `c${Math.random().toString(36).slice(2, 8)}`,
      name: String(f.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || feedLabel(url),
      url,
      color: /^#[0-9a-f]{6}$/i.test(f.color ?? '') ? f.color : FEED_COLORS[out.length % FEED_COLORS.length],
      on: f.on !== false,
      ...(user ? { user, pass: String(f.pass ?? '').slice(0, 200) } : {}),
      ...(normalizeCals(f.cals) ? { cals: normalizeCals(f.cals) } : {}),
    });
    if (out.length >= MAX_FEEDS) break;
  }
  return out;
}

/** .ics 글의 캘린더 이름 (X-WR-CALNAME) */
export function icsName(text) {
  const m = /^X-WR-CALNAME:(.*)$/m.exec(String(text ?? '').replace(/\r?\n[ \t]/g, ''));
  return m ? m[1].replace(/\\([,;\\])/g, '$1').trim().slice(0, 40) : '';
}

/** 받은 글이 iCal 인가 (로그인 화면 HTML 같은 것을 거르게) */
export const looksLikeIcs = (text) => /BEGIN:VCALENDAR/i.test(String(text ?? '').slice(0, 2000));

export const FEED_FRESH_MS = 15 * 60 * 1000; // 받은 지 이보다 오래되면 다시 받는다

/** 응답 상태가 실패면 알기 쉬운 오류 (본문을 받기 전에 먼저 볼 때) */
export function checkFeedStatus(status) {
  if (status === 401 || status === 403 || status === 404) throw new Error('캘린더를 볼 수 없어요. 주소가 바뀌었거나 비공개 주소를 다시 만들었는지 확인해 주세요');
  if (status < 200 || status > 299) throw new Error(`캘린더 서버 오류 (${status})`);
}

/**
 * 받은 응답 → .ics 글, 아니면 알기 쉬운 오류 (PC · 휴대폰 같은 문구)
 * @param {number} status HTTP 상태
 * @param {string} text 본문
 */
export function feedResponseText(status, text) {
  checkFeedStatus(status);
  if (!looksLikeIcs(text)) throw new Error('캘린더(iCal) 주소가 아니에요. Google 캘린더는 "iCal 형식의 비공개 주소" 를 넣어 주세요');
  return text;
}

/**
 * 구독 캘린더 받기 · 받아 둔 것 (PC 메인 · 휴대폰 같은 규칙): 15분 안이면 받아 둔 것, 아니면 새로 받고, 받지 못하면 받아 둔 것 + 오류.
 * 같은 캘린더를 겹쳐 받지 않고, 받는 사이 연결을 끊었거나 주소를 바꿨으면 받은 것을 남기지 않는다.
 * 어디에 두는지(파일 · localStorage)와 어떻게 받는지는 기기마다 넘긴다.
 */
export class FeedStore {
  /**
   * @param {{ getList: () => any[], setList: (list: any[]) => void, download: (url: string) => Promise<string>,
   *           cache: { read: (feed: any) => ({ url: string, text: string, at: number } | null), write: (feed: any, entry: any) => (void | Promise<void>), remove: (id: string) => void },
   *           now?: () => number }} options
   */
  constructor({ getList, setList, download, cache, now = Date.now }) { // download(url, feed): CalDAV 면 feed.user · feed.pass 도
    this.getList = getList;
    this.setList = setList;
    this.download = download;
    this.cache = cache;
    this.now = now;
    this.inflight = new Map(); // id → Promise
  }

  list() {
    return normalizeFeeds(this.getList());
  }

  /** 구독 목록 저장 — 빠졌거나 주소가 바뀐 캘린더의 받아 둔 것은 지운다 */
  save(list) {
    const next = normalizeFeeds(list);
    for (const f of this.list()) {
      if (next.some((n) => n.id === f.id && n.url === f.url && n.user === f.user && n.pass === f.pass)) continue;
      this.cache.remove(f.id);
    }
    this.setList(next);
    return next;
  }

  cached(feed) {
    const c = this.cache.read(feed);
    return c?.url === feed.url ? c : null;
  }

  /** @returns {Promise<{ text: string, at: number, error?: string }>} */
  async get(id, { force = false } = {}) {
    const feed = this.list().find((f) => f.id === id);
    if (!feed) return { text: '', at: 0, error: '없는 캘린더예요' };
    const old = this.cached(feed);
    if (!force && old && this.now() - old.at < FEED_FRESH_MS) return { text: old.text, at: old.at };
    if (!this.inflight.has(id)) this.inflight.set(id, this.fetchFeed(feed).finally(() => this.inflight.delete(id)));
    try {
      return await this.inflight.get(id);
    } catch (err) {
      return { text: old?.text ?? '', at: old?.at ?? 0, error: err?.message || '캘린더를 받지 못했어요' };
    }
  }

  async fetchFeed(feed) {
    const text = await this.download(feed.url, feed);
    const entry = { url: feed.url, text, at: this.now() };
    // 받는 사이 연결을 끊었거나 주소를 바꿨으면 남기지 않는다 (비공개 캘린더가 남지 않게)
    if (this.list().some((f) => f.id === feed.id && f.url === feed.url && f.user === feed.user)) await this.cache.write(feed, entry);
    return { text, at: entry.at };
  }
}
