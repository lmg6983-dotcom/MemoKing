// CalDAV 캘린더 읽기 (네이버 캘린더처럼 .ics 주소 없이 아이디 · 비밀번호로만 여는 캘린더) — PC 메인 · 휴대폰 받기가 함께 쓴다
//   계정의 캘린더를 모두 찾아(PROPFIND) 일정을 받고(REPORT) 한 .ics 글로 합친다 → 그 뒤는 .ics 구독과 똑같이 보여 준다
//   HTTP 는 기기마다 넘긴다: request(url, { method, headers, body }) → { status, text, location }
import { MAX_FEED_BYTES } from './calendar-feed-list.js';

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
const FIND = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:resourcetype/><d:current-user-principal/><c:calendar-home-set/></d:prop></d:propfind>`;
const LIST = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;
const EVENTS = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><c:calendar-data/></d:prop>`
  + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>';

const unxml = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// 접두어(d: · D: · 없음)와 상관없이 요소 하나의 속 글
const inner = (xml, name) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`).exec(xml)?.[1] ?? '';
const hrefIn = (xml) => unxml(inner(xml, 'href')).trim();
const isCalendar = (resp) => /<(?:[\w-]+:)?calendar[\s/>]/.test(inner(resp, 'resourcetype'));
const responses = (xml) => [...String(xml).matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g)].map((m) => m[1]);

/** UTF-8 아이디 · 비밀번호 → Basic 인증 (btoa 는 Node · 브라우저 모두) */
const basic = (user, pass) => `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`)))}`;

/**
 * CalDAV 계정의 일정을 모두 받아 .ics 글 하나로
 * @param {{ url: string, user: string, pass: string }} feed
 * @param {(url: string, init: { method: string, headers: Record<string, string>, body: string }) => Promise<{ status: number, text: string, location?: string }>} request
 */
export async function caldavIcs(feed, request) {
  const base = new URL(feed.url);
  if (base.protocol !== 'https:') throw new Error('CalDAV 는 https:// 주소만 돼요 (비밀번호가 그대로 보내지지 않게)');
  const auth = basic(feed.user, feed.pass);

  async function send(method, url, depth, body) {
    for (let hops = 0; ; hops++) {
      // 비밀번호는 처음 넣은 서버에만 보낸다 (서버가 알려 준 다른 곳으로는 보내지 않음)
      if (url.origin !== base.origin) throw new Error('캘린더 서버가 다른 곳으로 보냈어요');
      const res = await request(url.toString(), { method, headers: { Authorization: auth, Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body });
      if (res.status >= 300 && res.status < 400 && res.location && hops < 3) {
        url = new URL(res.location, url);
        continue;
      }
      if (res.status === 401) throw new Error('아이디나 비밀번호가 맞지 않아요. 네이버는 "애플리케이션 비밀번호" 를 넣어 주세요');
      if (res.status === 403) throw new Error('캘린더를 볼 수 없어요 (권한 없음)');
      if (res.status < 200 || res.status > 299) throw new Error(`캘린더 서버 오류 (${res.status})`);
      return { url, xml: String(res.text ?? '') };
    }
  }

  // 1. 넣은 주소가 캘린더면 그것만, 아니면 계정 → 캘린더 모음 → 캘린더들
  const first = await send('PROPFIND', base, '0', FIND);
  let urls;
  if (isCalendar(first.xml)) urls = [first.url];
  else {
    let home = hrefIn(inner(first.xml, 'calendar-home-set'));
    if (!home) {
      const principal = hrefIn(inner(first.xml, 'current-user-principal'));
      if (principal) home = hrefIn(inner((await send('PROPFIND', new URL(principal, first.url), '0', FIND)).xml, 'calendar-home-set'));
    }
    const list = await send('PROPFIND', home ? new URL(home, first.url) : first.url, '1', LIST);
    urls = responses(list.xml).filter(isCalendar).map((r) => new URL(hrefIn(r), list.url));
  }
  if (!urls.length) throw new Error('이 계정에서 캘린더를 찾지 못했어요');

  // 2. 캘린더마다 일정 → 한 .ics 로 (시간대는 겹치지 않게 한 번씩)
  const parts = [];
  const zones = new Set();
  let size = 0;
  for (const url of urls) {
    const { xml } = await send('REPORT', url, '1', EVENTS);
    for (const r of responses(xml)) {
      const ics = unxml(inner(r, 'calendar-data')).replace(/\r?\n/g, '\r\n');
      for (const [block, kind] of ics.matchAll(/^BEGIN:(VEVENT|VTIMEZONE)\r$[\s\S]*?^END:\1(?=\r?$)/gm)) {
        if (kind === 'VTIMEZONE') {
          const tz = /^TZID:(.*)\r$/m.exec(block)?.[1];
          if (zones.has(tz)) continue;
          zones.add(tz);
        }
        size += block.length;
        if (size > MAX_FEED_BYTES) throw new Error('캘린더가 너무 커요 (5MB 넘음)');
        parts.push(block);
      }
    }
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MemoKing//CalDAV//KO', ...parts, 'END:VCALENDAR', ''].join('\r\n');
}
