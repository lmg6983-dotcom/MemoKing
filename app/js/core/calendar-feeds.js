// 다른 캘린더와 잇기 (순수 함수, 단위 테스트 대상) — 일정 탭(list-reminders.js)이 쓴다
//   읽기: Google 캘린더 "iCal 형식의 비공개 주소" 같은 .ics 구독 → 달력에 함께 (반복 · 빠진 날 · 바뀐 회차까지, ical.js)
//         휴대폰 캘린더(삼성 캘린더 · Google 캘린더, 안드로이드 CalendarContract) 일정 → 같은 모양으로
//   보내기: 메모킹 일정 → .ics 파일(삼성 캘린더 · Google 캘린더 · Outlook 가져오기) · Google 캘린더 "새 일정" 주소 · 휴대폰 캘린더 앱 새 일정
import { ICAL } from '../../vendor/ical.js';
import { toLocalIso, pad2 } from './time.js';

export * from './calendar-feed-list.js';
export { rruleOf, eventSpan } from './calendar-events.js';
import { ymd, rruleOf, eventSpan } from './calendar-events.js';
import { alertsOf, occurrenceEnd, DEFAULT_ALERTS } from './reminders.js';

const MAX_ITERATIONS = 100000; // 반복 일정 하나마다 — 아주 오래된 매일 반복도 멈추지 않게

const plainText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
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

/**
 * .ics 글(또는 prepareFeed 결과) → [from, to) 와 겹치는 일정 회차 [{ uid, title, start, end, allDay, location, description }] (시작 순)
 * 반복 일정은 회차마다, 취소된 일정은 빼고, 바뀐 회차(RECURRENCE-ID)는 바뀐 대로.
 * 반복 하나마다 따로 셈을 두어(아주 오래된 매일 반복이 있어도) 뒤의 다른 일정이 빠지지 않게 하고, 다 모은 뒤 시작 순으로 limit 개
 */
export function feedEvents(source, from, to, limit = 1500) {
  const { masters } = typeof source === 'string' ? prepareFeed(source) : source;
  const out = [];
  const seen = new Set();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const push = (ev, startTime, endTime) => {
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
    out.push({ uid: String(ev.uid ?? ''), title: plainText(ev.summary) || '(제목 없음)', start, end, allDay, location: plainText(ev.location), description: noteText(ev.description) });
  };
  for (const { ev, moved } of masters) {
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate);
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
      push(d.item, d.startDate, d.endDate);
    }
    for (const ex of moved) push(ex, ex.startDate, ex.endDate);
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
    title: plainText(e.title) || '(제목 없음)',
    start,
    end,
    allDay: Boolean(e.allDay),
    location: plainText(e.location),
    description: noteText(e.description),
    calendar: plainText(e.calendar),
    color: /^#[0-9a-f]{6}$/i.test(e.color ?? '') ? e.color : null,
  };
}

/** 다른 캘린더의 일정 → 메모킹 일정 (메모로 가져오기) */
export function reminderFromExternal(ev, now = new Date()) {
  const allDay = Boolean(ev.allDay);
  const start = allDay ? new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate()) : new Date(ev.start);
  return {
    kind: 'at',
    at: toLocalIso(start),
    title: plainText(ev.title).slice(0, 80),
    alerts: [...(allDay ? DEFAULT_ALERTS.allDay : DEFAULT_ALERTS.timed)],
    ...(allDay ? { allDay: true } : {}),
    action: 'notify',
    enabled: occurrenceEnd(start, allDay) > now, // 오늘 하루 종일 일정도 켜 둔다 (당일 오전 9시 알림이 아직이면 울리게)
    created: toLocalIso(now),
  };
}

// ---------- 메모킹 일정 → 다른 캘린더 ----------

const localStamp = (d) => `${ymd(d)}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// 75바이트마다 접기 (RFC 5545) — 한글이 잘리지 않게 글자 단위로
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

/** 미리 알림(분 전) → TRIGGER 값 */
const trigger = (offset) => (offset >= 0 ? `-PT${offset}M` : `PT${-offset}M`);

/**
 * 메모킹 일정들 → .ics 글 (삼성 캘린더 · Google 캘린더 · Outlook 에서 가져오기)
 * @param {{ memoId: string, title: string, reminder: any }[]} items  api.reminders.all() 결과
 */
export function buildIcs(items, { now = new Date(), name = '메모킹 일정' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MemoKing//MemoKing//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`];
  for (const item of items) {
    const r = item.reminder;
    const span = eventSpan(r, now);
    if (!span) continue;
    const repeat = r.kind === 'repeat';
    lines.push('BEGIN:VEVENT', `UID:${item.memoId}-${r.id}@memoking`, `DTSTAMP:${utcStamp(now)}`);
    if (span.allDay) lines.push(`DTSTART;VALUE=DATE:${ymd(span.start)}`, `DTEND;VALUE=DATE:${ymd(span.end)}`);
    // 반복은 이 기기 시각 그대로(시간대 없음 — 받는 캘린더의 시간대로 매번 같은 시각), 한 번짜리는 정확한 순간(UTC)
    else if (repeat) lines.push(`DTSTART:${localStamp(span.start)}`, `DTEND:${localStamp(span.end)}`);
    else lines.push(`DTSTART:${utcStamp(span.start)}`, `DTEND:${utcStamp(span.end)}`);
    const rrule = rruleOf(r);
    if (rrule) lines.push(`RRULE:${rrule}`);
    lines.push(`SUMMARY:${escapeText(r.title || item.title || '일정')}`);
    if (item.title && item.title !== r.title) lines.push(`DESCRIPTION:${escapeText(`메모킹 메모: ${item.title}`)}`);
    if (r.enabled) {
      for (const offset of alertsOf(r)) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(r.title || item.title || '일정')}`, `TRIGGER:${trigger(offset)}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Google 캘린더 "새 일정" 화면 주소 (PC 는 브라우저, 휴대폰은 Google 캘린더 앱이 받음) */
export function googleCalendarUrl(item, now = new Date()) {
  const r = item.reminder;
  const span = eventSpan(r, now);
  if (!span) return null;
  const dates = span.allDay ? `${ymd(span.start)}/${ymd(span.end)}`
    : r.kind === 'repeat' ? `${localStamp(span.start)}/${localStamp(span.end)}`
    : `${utcStamp(span.start)}/${utcStamp(span.end)}`;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: r.title || item.title || '일정', dates });
  if (item.title && item.title !== r.title) q.set('details', `메모킹 메모: ${item.title}`);
  const rrule = rruleOf(r);
  if (rrule) q.set('recur', `RRULE:${rrule}`);
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** 휴대폰 캘린더 앱(삼성 캘린더 등)의 새 일정 화면에 넘길 값 */
export function deviceInsertArgs(item, now = new Date()) {
  const r = item.reminder;
  const span = eventSpan(r, now);
  if (!span) return null;
  // 캘린더 앱의 새 일정 화면은 시각을 이 기기 시각으로 읽는다 — 하루 종일도 이 기기 자정 (UTC 자정이면 서쪽 나라에서 하루 앞당겨짐)
  return {
    title: r.title || item.title || '일정',
    start: span.start.getTime(),
    end: span.end.getTime(),
    allDay: span.allDay,
    description: item.title && item.title !== r.title ? `메모킹 메모: ${item.title}` : '',
    rrule: rruleOf(r),
  };
}
