// 다른 캘린더 함께 보기 (읽기만 · 순수 함수, 단위 테스트 대상) — 일정 탭(list-reminders.js)이 쓴다
//   Google 캘린더 "iCal 형식의 비공개 주소" 같은 .ics 구독 → 달력에 함께 (반복 · 빠진 날 · 바뀐 회차까지, ical.js)
//   휴대폰 캘린더(삼성 캘린더 · Google 캘린더, 안드로이드 CalendarContract) 일정 → 같은 모양으로
//   다른 캘린더 일정 → 메모킹 일정 ("메모로 가져오기")
import { ICAL } from '../../vendor/ical.js';
import { toLocalIso } from './time.js';

export * from './calendar-feed-list.js';
import { occurrenceEnd, DEFAULT_ALERTS } from './reminders.js';
import { UI } from './ui-text.js';

const MAX_ITERATIONS = 100000; // 반복 일정 하나마다 — 아주 오래된 매일 반복도 멈추지 않게

const plainText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
/** 일정에 붙은 주소(URL) — 인터넷 주소만 */
const webUrl = (v) => (/^https?:\/\/\S+$/i.test(String(v ?? '').trim()) ? String(v).trim() : '');

/** 일정 설명: 줄은 살리고(HTML 줄바꿈도) 태그는 빼고 2000자까지 — 화면에는 글자로만 넣는다 */
//   태그는 HTML 태그 이름일 때만 뺀다 ("회의 <필참>" · "a < b > c" 같은 글은 그대로)
const HTML_TAG = /<\/?(?:a|b|i|u|s|em|strong|span|font|p|div|ul|ol|li|br|hr|h[1-6]|small|sup|sub|blockquote|pre|code|table|tr|td|th|tbody|thead)\b[^<>]*>/gi;
const noteText = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(HTML_TAG, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);

/**
 * .ics 글을 한 번만 풀어 둔다 (같은 캘린더를 범위마다 다시 풀지 않게) → feedEvents 에 넘긴다
 * @returns {{ masters: any[] }}
 */
export function prepareFeed(text) {
  const root = new ICAL.Component(ICAL.parse(String(text ?? '')));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      // 모르는 시간대 — 그 일정은 이 기기 시각으로
    }
  }
  const masters = [];
  const byUid = new Map();
  const exceptions = [];
  for (const v of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(v);
    if (!ev.startDate) continue;
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else {
      masters.push({ ev, moved: [] });
      if (!byUid.has(ev.uid)) byUid.set(ev.uid, masters.at(-1));
    }
  }
  for (const ex of exceptions) {
    const master = byUid.get(ex.uid);
    if (master) {
      master.ev.relateException(ex);
      master.moved.push(ex); // 다른 때로 옮긴 회차 — 원래 자리가 범위 밖이어도 옮긴 자리가 범위 안이면 보이게
    } else masters.push({ ev: ex, moved: [] }); // 본 일정이 없는 바뀐 회차 — 한 번짜리로
  }
  return { masters };
}

/** CalDAV 로 받은 .ics 속 캘린더 이름들 (X-MK-CAL, 처음 나온 순) — 캘린더별로 켜고 끄기 · 색 */
export const feedCalendars = (text) => [...new Set([...String(text ?? '').matchAll(/^X-MK-CAL:(.*?)\r?$/gm)].map((m) => m[1]))];

/** 회차 표시(RECURRENCE-ID) → "20261120" (하루 종일) · "20261120T013000Z" (UTC), 없으면 '' */
const ridText = (t) => {
  if (!t) return '';
  if (t.isDate) return `${t.year}${String(t.month).padStart(2, '0')}${String(t.day).padStart(2, '0')}`;
  return t.toJSDate().toISOString().replace(/[-:]|\.\d+/g, '');
};

/**
 * Google 캘린더 iCal 구독의 일정 → 그 일정을 여는 Google 캘린더 주소 (Google 이 아니면 '')
 *   eid = base64("<일정 ID>[_<회차>] <캘린더 ID>") — Google 캘린더 화면이 일정 주소에 쓰는 모양
 * @param {string} feedUrl 구독 주소 (https://calendar.google.com/calendar/ical/<캘린더 ID>/.../basic.ics)
 * @param {{ uid: string, recurrenceId?: string }} e feedEvents 의 일정
 */
export function googleEventUrl(feedUrl, e) {
  const cal = /^https:\/\/calendar\.google\.com\/calendar\/ical\/([^/]+)\//.exec(String(feedUrl ?? ''))?.[1];
  const id = /^([\w-]+)@google\.com$/.exec(String(e?.uid ?? ''))?.[1];
  if (!cal || !id) return '';
  const eid = btoa(`${id}${e.recurrenceId ? `_${e.recurrenceId}` : ''} ${decodeURIComponent(cal)}`).replace(/=+$/, '');
  return `https://www.google.com/calendar/event?eid=${encodeURIComponent(eid)}`;
}

/**
 * .ics 글(또는 prepareFeed 결과) → [from, to) 와 겹치는 일정 회차 [{ uid, title, start, end, allDay, location, description, url, recurrenceId }] (시작 순)
 * 반복 일정은 회차마다, 취소된 일정은 빼고, 바뀐 회차(RECURRENCE-ID)는 바뀐 대로.
 * 반복 하나마다 따로 셈을 두어(아주 오래된 매일 반복이 있어도) 뒤의 다른 일정이 빠지지 않게 하고, 다 모은 뒤 시작 순으로 limit 개
 */
export function feedEvents(source, from, to, limit = 1500) {
  const { masters } = typeof source === 'string' ? prepareFeed(source) : source;
  const out = [];
  const seen = new Set();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const push = (ev, startTime, endTime, rid) => {
    const allDay = startTime.isDate;
    const start = startTime.toJSDate();
    let end = endTime ? endTime.toJSDate() : null;
    if (!end || end <= start) end = allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) : new Date(start);
    if (end.getTime() <= fromMs && !(end.getTime() === start.getTime() && start.getTime() >= fromMs)) return;
    if (start.getTime() >= toMs) return;
    const status = String(ev.component.getFirstPropertyValue('status') ?? '').toUpperCase();
    if (status === 'CANCELLED') return;
    const key = `${ev.uid}|${start.getTime()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ uid: String(ev.uid ?? ''), title: plainText(ev.summary) || UI.untitledParen, start, end, allDay, location: plainText(ev.location), description: noteText(ev.description), url: webUrl(ev.component.getFirstPropertyValue('url')), recurrenceId: ridText(rid), cal: String(ev.component.getFirstPropertyValue('x-mk-cal') ?? '') });
  };
  for (const { ev, moved } of masters) {
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate, ev.recurrenceId);
      continue;
    }
    const it = ev.iterator();
    let budget = MAX_ITERATIONS;
    // 범위 훨씬 앞의 회차는 시각만 보고 건너뛴다 (회차마다 자세히 풀면 오래된 반복이 느려진다).
    //   일정 길이 + 하루만큼 여유 — 범위 앞에서 시작해 범위로 이어지는 회차는 놓치지 않게. 옮긴 회차는 아래에서 따로
    const span = Math.max(0, (ev.endDate?.toJSDate().getTime() ?? 0) - ev.startDate.toJSDate().getTime()) + 86_400_000;
    for (let next = it.next(); next && budget-- > 0; next = it.next()) {
      const at = next.toJSDate().getTime();
      if (at >= toMs) break;
      if (at + span <= fromMs) continue;
      const d = ev.getOccurrenceDetails(next);
      // 바뀐 회차는 그 일정의 상태(취소 등)로 본다
      push(d.item, d.startDate, d.endDate, d.recurrenceId);
    }
    for (const ex of moved) push(ex, ex.startDate, ex.endDate, ex.recurrenceId);
  }
  return out.sort((a, b) => a.start - b.start).slice(0, limit);
}

/**
 * 휴대폰 캘린더(안드로이드) 일정 → 같은 모양. 하루 종일 일정은 UTC 자정으로 오므로 그 날짜의 이 기기 자정으로
 * @param {{ id: number, title: string, start: number, end: number, allDay: boolean, location?: string, description?: string, calendar?: string, color?: string }} e
 */
export function fromDeviceEvent(e) {
  const utcDay = (ms) => {
    const d = new Date(ms);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const start = e.allDay ? utcDay(e.start) : new Date(e.start);
  let end = e.allDay ? utcDay(e.end) : new Date(e.end);
  if (!(end > start)) end = e.allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) : new Date(start);
  return {
    uid: `device-${e.id}-${e.start}`,
    deviceId: e.id,
    title: plainText(e.title) || UI.untitledParen,
    start,
    end,
    allDay: Boolean(e.allDay),
    location: plainText(e.location),
    description: noteText(e.description),
    calendar: plainText(e.calendar),
    calendarId: e.calendarId == null ? '' : String(e.calendarId),
    color: /^#[0-9a-f]{6}$/i.test(e.color ?? '') ? e.color : null,
  };
}

/** 다른 캘린더의 일정 → 메모킹 일정 (메모로 가져오기) */
export function reminderFromExternal(ev, now = new Date()) {
  const allDay = Boolean(ev.allDay);
  const start = allDay ? new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate()) : new Date(ev.start);
  const rawEnd = ev.end ? new Date(ev.end) : null;
  const end = rawEnd ? (allDay ? new Date(rawEnd.getFullYear(), rawEnd.getMonth(), rawEnd.getDate() - 1) : rawEnd) : null;
  return {
    kind: 'at',
    at: toLocalIso(start),
    ...(end && end > start ? { end: toLocalIso(end) } : {}),
    title: plainText(ev.title).slice(0, 80),
    alerts: [...(allDay ? DEFAULT_ALERTS.allDay : DEFAULT_ALERTS.timed)],
    ...(allDay ? { allDay: true } : {}),
    action: 'notify',
    enabled: occurrenceEnd(start, allDay, end) > now, // 오늘 하루 종일 일정도 켜 둔다 (당일 오전 9시 알림이 아직이면 울리게)
    created: toLocalIso(now),
  };
}

// 줄 첫머리의 마크다운 표시(# - > 1. 등)는 글자로 — 일정 설명이 제목 · 목록으로 읽히지 않게
const plainLine = (line) => line.replace(/^(\s*)([#>*+-]|\d+[.)])(\s)/, '$1\\$2$3');

/**
 * 메모로 가져온 일정의 본문: 제목 · 달력 그림(그 날짜에 동그라미) · 장소 · 설명 · 일정 주소
 * @param {{ title: string, imageRel?: string, imageAlt?: string, location?: string, description?: string, url?: string }} o
 */
export function importedEventBody({ title, imageRel = '', imageAlt = '', location = '', description = '', url = '' }) {
  const parts = [`# ${String(title ?? '').replace(/\s+/g, ' ').trim() || '새 일정'}`];
  if (imageRel) parts.push(`![${imageAlt.replace(/[[\]]/g, '')}](${encodeURI(imageRel)})`);
  const info = [];
  if (location) info.push(`장소: ${plainLine(location)}`);
  if (url && !description.includes(url)) info.push(`링크: ${url}`);
  parts.push(...info);
  // 설명의 줄은 줄대로 (메모에서 한 줄 바꿈은 이어 붙여 보이므로 문단으로), 빈 줄은 하나로
  if (description) parts.push(...description.split(/\n+/).map((l) => plainLine(l.trim())).filter(Boolean));
  return `${parts.join('\n\n')}\n`;
}
