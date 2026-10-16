// 다른 캘린더 구독 목록 · 받은 글 확인 (ical.js 없이 — PC 메인 프로세스 · 휴대폰 받기가 함께 쓴다)
//   주소 정리, 구독 목록 정리, 받은 응답이 iCal 인지와 알기 쉬운 오류 문구, 다시 받을 때
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
    if (/(^|\.)google\.com$/.test(u.hostname)) return 'Google 캘린더';
    if (/(^|\.)(icloud|me)\.com$/.test(u.hostname)) return 'iCloud 캘린더';
    if (/outlook|office|live\.com/.test(u.hostname)) return 'Outlook 캘린더';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '캘린더';
  }
}

/** 저장해 둔 구독 목록을 안전한 모양으로 [{ id, name, url, color, on }] */
export function normalizeFeeds(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const url = normalizeFeedUrl(f?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: typeof f.id === 'string' && /^[\w-]{1,40}$/.test(f.id) ? f.id : `c${Math.random().toString(36).slice(2, 8)}`,
      name: String(f.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || feedLabel(url),
      url,
      color: /^#[0-9a-f]{6}$/i.test(f.color ?? '') ? f.color : FEED_COLORS[out.length % FEED_COLORS.length],
      on: f.on !== false,
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
