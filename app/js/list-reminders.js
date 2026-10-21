// 목록 창 "일정" 탭 (PC·휴대폰 같음) — 위에 달력(FullCalendar: 월 · 주 · 목록 보기), 아래에 고른 날의 일정과
// 다가오는 일정. 일정마다 언제 미리 알리는지(30분 전, 하루 전 …)를 함께 보인다. 타이머·앱 열 때 알림은 맨 아래 따로.
// 고른 날(오늘·앞으로)에는 "＋ 일정 추가" — 이름·시각 → 미리 알림 → 넣을 메모(새 메모 / 있는 메모)로 바로 만든다.
// 이미 고른 날을 한 번 더 눌러도 같다. 한 번짜리 일정은 달력에서 끌어 다른 날·시각으로 옮긴다.
// 다른 캘린더: Google 캘린더 등 .ics 구독 · 휴대폰 캘린더(삼성 캘린더) 일정도 함께 보인다 — 읽기만 ("메모로 가져오기"는 메모킹 안에서)
//   (calendar-links.js · core/calendar-feeds.js)
import { Calendar, dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, themePlugin, koLocale } from '../vendor/fullcalendar.js';
import { icon } from './icons.js';
import { attachSlider } from './seg-slider.js';
import { describeReminder, describeAlerts, nextLabel, nextTime, isDone, isEvent, isLive, reenable, occurrencesBetween, occurrenceEnd, DEFAULT_ALERTS } from './core/reminders.js';
import { koClock, koFullDate, relativeDay, startOfDay, addDays, sameDay, toLocalIso } from './core/time.js';
import { feedEvents, prepareFeed, fromDeviceEvent, reminderFromExternal, importedEventBody } from './core/calendar-feeds.js';
import { openQuickEvent } from './quick-event.js';
import { openCalendarLinks } from './calendar-links.js';
import { openEventDetail, whenText } from './event-detail.js';
import { monthSketchPng } from './month-sketch.js';
import { setupMemoriesView } from './memories-view.js';

const KIND_ICON = { timer: 'timer', at: 'calendar', repeat: 'repeat', startup: 'power' };
const UPCOMING_DAYS = 30;
// 보기는 둘: 캘린더(달 달력) · 회상(사진 달력). 예전의 주 · 목록 보기는 없앴다 (저장된 값이면 캘린더로)
const VIEWS = [
  { id: 'dayGridMonth', label: '캘린더' },
  { id: 'memories', label: '회상' }, // 사진 달력 (memories-view.js) — 달력은 월 보기로 둔 채 가리고 넘기기만 함께
];
const MEMORIES = 'memories';
/** FullCalendar 가 쓰는 보기 (회상은 월 보기 위에 따로 그린다) */
const fcView = (id) => (id === MEMORIES ? 'dayGridMonth' : id);
const VIEW_KEY = 'memoking.calendarView';

const dayStart = startOfDay;

/** "오늘 · 10월 12일 (월)" 같은 날 이름 */
export function dayHeading(d, now = new Date()) {
  const rel = relativeDay(d, now);
  return rel ? `${rel}, ${koFullDate(d, now)}` : koFullDate(d, now);
}


const storedView = (views) => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return views.some((x) => x.id === v) ? v : VIEWS[0].id;
  } catch {
    return VIEWS[0].id;
  }
};

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * @param {{ api: any, container: HTMLElement, countEl: HTMLElement, notify?: (text: string, isError?: boolean) => void,
 *           calendars?: { feeds, setFeeds, fetch, openUrl, exportIcs, device? } }} options
 *   calendars: 다른 캘린더 (없으면 그 기능은 숨김)
 *   memories: 회상 보기를 켠다 — { onOverlay?, collage?, mode?: () => 'life'|'work'|null, on?: () => boolean } (mode: 그 모드의 메모로 · on: 지금 보여도 되는가)
 *   visible: 이 일정을 보일까 (Work / Life — 지금 모드의 메모 것만)
 */
export function setupRemindersTab({ api, container, countEl, notify = (text, isError) => isError && window.alert(text), calendars = api.calendars, memories = null, visible = null }) {
  let allItems = []; // 모든 모드
  let items = []; // [{ memoId, title, color, reminder }] — 지금 모드의 것
  const memoriesOn = () => memories?.on?.() ?? true;
  let query = '';
  const today = () => dayStart(new Date());
  let selected = today();
  let shownToday = today();
  const viewList = VIEWS.filter((v) => v.id !== MEMORIES || (memories && api.memos?.list));
  let viewId = storedView(viewList);
  if (viewId === MEMORIES && !memoriesOn()) viewId = VIEWS[0].id;
  let compact = false; // 낮은 창: 월 보기 칸에 일정 막대 대신 색 점 (fitSize)
  let lastFit = '';
  let maxEvents = 2; // 월 보기 한 칸에 보이는 일정 수 (fitSize)
  let lastCellKey = 0; // 날 칸을 마지막으로 그린 때의 고른 날

  // ---------- 다른 캘린더 (읽기만) ----------
  let feeds = []; // [{ id, name, url, color, on }]
  const feedTexts = new Map(); // id → { text, at, error }
  const prepared = new Map(); // id → { at, data } — 받은 .ics 를 한 번만 풀어 둔다
  const parsed = new Map(); // `${id}|${at}|${from}|${to}` → 일정 (같은 범위를 다시 펼치지 않게)
  let device = { on: false, from: 0, to: 0, events: [], loading: null };

  /** [from, to) 사이의 다른 캘린더 일정 [{ ext: true, source, title, start, end, allDay, color, ... }] */
  function externalBetween(from, to) {
    const out = [];
    for (const f of feeds) {
      if (!f.on) continue;
      const got = feedTexts.get(f.id);
      if (!got?.text) continue;
      const key = `${f.id}|${got.at}|${from.getTime()}|${to.getTime()}`;
      let list = parsed.get(key);
      if (!list) {
        try {
          let prep = prepared.get(f.id);
          if (prep?.at !== got.at) {
            prep = { at: got.at, data: prepareFeed(got.text) };
            prepared.set(f.id, prep);
          }
          list = feedEvents(prep.data, from, to);
        } catch (err) {
          console.warn('[calendar] .ics', f.name, err);
          list = [];
          got.error ||= '캘린더 내용을 읽지 못했어요';
        }
        if (parsed.size > 48) parsed.delete(parsed.keys().next().value);
        parsed.set(key, list);
      }
      for (const e of list) out.push({ ...e, ext: true, source: f.name, color: f.color, feedId: f.id });
    }
    if (device.on) {
      // "메모킹" 캘린더는 예전(v0.41) 상호 동기화가 Google 에 만든 메모킹 일정의 사본이라 빼고 (두 번 · 낡은 채로 보이지 않게)
      for (const e of device.events) if (e.end > from && e.start < to && e.calendar !== '메모킹') out.push({ ...e, ext: true, source: e.calendar || '휴대폰 캘린더', device: true });
    }
    return query.trim() ? out.filter((e) => `${e.title} ${e.location ?? ''} ${e.source}`.toLowerCase().includes(query.trim().toLowerCase())) : out;
  }

  /** 찾는 말과 맞는 다른 캘린더 일정이 하나라도 있는가 (기간 없이 — 범위를 펼치면 바쁜 캘린더는 잘린다) */
  function externalMatches() {
    const q = query.trim().toLowerCase();
    const hit = (...texts) => texts.some((x) => String(x ?? '').toLowerCase().includes(q));
    for (const f of feeds) {
      if (!f.on) continue;
      if (hit(f.name) && feedTexts.get(f.id)?.text) return true;
      const prep = prepared.get(f.id)?.data;
      if (prep?.masters.some(({ ev }) => hit(ev.summary, ev.location))) return true;
    }
    return device.on && device.events.some((e) => hit(e.title, e.location, e.calendar));
  }

  async function loadFeeds({ force = false } = {}) {
    if (!calendars?.feeds) return;
    try {
      feeds = await calendars.feeds();
    } catch {
      feeds = [];
    }
    device.on = Boolean(calendars.device?.enabled());
    device.loading = null; // 껐다 켰으면 받는 중이던 것은 버린다
    await Promise.all(feeds.filter((f) => f.on).map(async (f) => {
      try {
        const got = await calendars.fetch(f.id, force);
        feedTexts.set(f.id, got);
      } catch (err) {
        feedTexts.set(f.id, { text: feedTexts.get(f.id)?.text ?? '', at: feedTexts.get(f.id)?.at ?? 0, error: err.message });
      }
    }));
    for (const id of [...feedTexts.keys()]) {
      if (feeds.some((f) => f.id === id)) continue;
      feedTexts.delete(id);
      prepared.delete(id);
    }
    device = { ...device, from: 0, to: 0 }; // 휴대폰 캘린더도 새로
    render();
  }

  // 휴대폰 캘린더는 보는 범위 + 다가오는 30일을 한 번에 받아 둔다
  function ensureDevice(from, to) {
    if (!device.on || !calendars?.device) return;
    if (device.from <= from.getTime() && device.to >= to.getTime()) return;
    const range = { from: Math.min(from.getTime(), today().getTime()), to: Math.max(to.getTime(), addDays(today(), UPCOMING_DAYS + 1).getTime()) };
    if (device.loading && device.loading.from <= range.from && device.loading.to >= range.to) return;
    device.loading = range;
    calendars.device.events(new Date(range.from), new Date(range.to)).then((res) => {
      if (device.loading !== range) return;
      if (!res.granted || !calendars.device.enabled()) {
        // 권한을 거둬 갔거나 그사이 껐다 — 끈 것으로
        device = { on: false, from: 0, to: 0, events: [], loading: null };
        render();
        return;
      }
      device = { on: true, from: range.from, to: range.to, events: (res.events ?? []).map(fromDeviceEvent), loading: null };
      render();
    }).catch((err) => {
      console.warn('[calendar] device', err);
      if (device.loading === range) device.loading = null;
    });
  }

  /** @param {{ quiet?: boolean }} [o] quiet: 탭이 안 보일 때 — 탭 숫자만 (달력은 다음에 보일 때 그린다. 메모를 지울 때마다 안 보이는 달력을 다시 그려 목록이 끊겼다) */
  // ifChanged: 탭으로 돌아올 때 — 일정 · 검색어 · 날짜가 지난번 그린 것과 같으면 달력을 다시 그리지 않는다 (달력 그리기가 탭 전환을 붙잡았다)
  let drawnKey = '';
  async function refresh({ quiet = false, ifChanged = false } = {}) {
    allItems = await api.reminders.all();
    items = visible ? allItems.filter(visible) : allItems;
    if (quiet) return updateCount(new Date());
    const key = `${JSON.stringify(items)}|${query}|${today().getTime()}`;
    if (!(ifChanged && key === drawnKey)) {
      drawnKey = key;
      render();
    }
    if (memView && viewId === MEMORIES) memView.refresh({ ifChanged }); // 탭으로 올 때도 여기로 — 새 사진 · 메모를 다시 모은다 (바뀐 것이 있을 때만)
  }

  // 탭 숫자: 앞으로 울릴 알림이 있는 것 (메모 창의 종 버튼과 같은 규칙)
  function updateCount(now) {
    const live = items.filter((i) => isLive(i.reminder, now)).length;
    countEl.textContent = live ? String(live) : '';
  }

  // 한 메모의 알림 목록을 바꿔서 저장
  function update(item, change) {
    const list = items.filter((x) => x.memoId === item.memoId).map((x) => x.reminder);
    return api.reminders.set(item.memoId, change(list)).then(refresh);
  }

  const matches = (i) => {
    const q = query.trim().toLowerCase();
    return !q || `${i.title} ${i.reminder.title ?? ''} ${describeReminder(i.reminder)}`.toLowerCase().includes(q);
  };

  /** [from, to) 사이의 일정 회차들: [{ item, start }] (시작 순, 하루 종일 먼저) */
  function occurrences(from, to) {
    const out = [];
    for (const item of items) {
      if (!isEvent(item.reminder) || !matches(item)) continue;
      for (const start of occurrencesBetween(item.reminder, from, to, 400)) out.push({ item, start });
    }
    return out.sort((a, b) => a.start - b.start || Number(Boolean(b.item.reminder.allDay)) - Number(Boolean(a.item.reminder.allDay)));
  }

  /** 메모킹 일정 + 다른 캘린더 일정을 한 줄로 (시작 순, 하루 종일 먼저) */
  function allBetween(from, to) {
    const mine = occurrences(from, to).map((o) => ({ ...o, allDay: Boolean(o.item.reminder.allDay) }));
    const ext = externalBetween(from, to).map((e) => ({ ext: e, start: e.start, allDay: e.allDay }));
    // 날짜 순 → 그날 안에서는 하루 종일 먼저 → 시각 순
    return [...mine, ...ext].sort((a, b) => dayStart(a.start) - dayStart(b.start) || Number(b.allDay) - Number(a.allDay) || a.start - b.start);
  }

  // ---------- 달력 (FullCalendar) ----------

  const card = el('section', 'cal');
  card.setAttribute('aria-label', '달력');
  const head = el('div', 'cal-head');
  const navButton = (name, label, onClick) => {
    const b = el('button', 'icon-btn cal-nav');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
  };
  const prev = navButton('chev-right', '이전', () => calendar.prev());
  prev.classList.add('cal-prev');
  const next = navButton('chev-right', '다음', () => calendar.next());
  const title = el('b', 'cal-title');
  title.setAttribute('aria-live', 'polite');
  const todayBtn = el('button', 'link-btn cal-today', '오늘');
  todayBtn.type = 'button';
  todayBtn.addEventListener('click', () => {
    selected = today();
    calendar.today();
    render();
  });
  head.append(prev, title, next, todayBtn);

  const bar = el('div', 'cal-bar');
  const views = el('div', 'cal-views');
  views.setAttribute('role', 'radiogroup');
  views.setAttribute('aria-label', '보기');
  for (const v of viewList) {
    const b = el('button', '', v.label);
    b.type = 'button';
    b.dataset.view = v.id;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => setView(v.id));
    views.append(b);
  }
  const linkBtn = el('button', 'link-btn cal-link');
  linkBtn.type = 'button';
  linkBtn.append(icon('link'), el('span', '', '다른 캘린더'));
  linkBtn.title = 'Google 캘린더, 삼성 캘린더 함께 보기';
  linkBtn.addEventListener('click', () => openLinks());
  linkBtn.hidden = !calendars?.feeds;
  bar.append(views, linkBtn);

  const calEl = el('div', 'cal-body');
  card.append(head, bar, calEl);
  const memView = viewList.some((v) => v.id === MEMORIES) ? setupMemoriesView({ api, notify, ...memories }) : null;
  if (memView) card.append(memView.el);
  const rowsEl = el('div', 'ev-rows');
  container.replaceChildren(card, rowsEl);
  attachSlider(views);
  // 보기 고르기의 ← → 는 목록 창 공통 라디오 묶음 규칙(radioGroups)이 맡는다

  const isMonth = () => viewId === 'dayGridMonth';
  // 낮은 창의 색 점: 보이는 6주를 한 번에 날짜별로 (칸마다 따로 찾지 않게) — 그릴 때마다 새로
  let dayIndexCache = null;
  function dayIndex() {
    if (dayIndexCache) return dayIndexCache;
    const map = new Map();
    const view = calendar?.view;
    if (view) {
      for (const o of allBetween(view.activeStart, view.activeEnd)) {
        // 여러 날 일정은 걸친 날마다 (끝은 그 순간 직전까지)
        const lastMs = o.ext ? Math.max(o.ext.end.getTime() - 1, o.start.getTime()) : o.start.getTime();
        for (let d = dayStart(o.start); d.getTime() <= lastMs && d < view.activeEnd; d = addDays(d, 1)) {
          const k = d.getTime();
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(o);
        }
      }
    }
    dayIndexCache = map;
    return map;
  }

  // 월 보기 날 칸의 위: 날짜 (낮은 창이면 그 아래 일정 색 점 세 개까지 — 일정 막대 대신)
  function dayTop(date) {
    if (!compact) return String(date.getDate());
    const wrap = el('span', 'cal-daytop');
    wrap.append(el('span', 'cal-num', String(date.getDate())));
    const list = (dayIndex().get(dayStart(date).getTime()) ?? []).slice(0, 3);
    if (list.length) {
      const dots = el('span', 'cal-dots');
      for (const o of list) {
        const dot = el('i');
        if (o.ext) dot.style.background = o.ext.color || '#4285f4';
        else dot.dataset.color = o.item.color;
        dots.append(dot);
      }
      wrap.append(dots);
    }
    return { domNodes: [wrap] };
  }
  // 날 칸: 고른 날 · 지나간 날 · 일요일(빨강) · 토요일
  const dayClass = (arg) => [sameDay(arg.date, selected) && 'mk-selected', arg.date.getDay() === 0 && 'mk-sun', arg.date.getDay() === 6 && 'mk-sat'].filter(Boolean).join(' ');

  /** 달력에 줄 일정들 (FullCalendar 의 일정 모양) */
  function calendarEvents(from, to) {
    ensureDevice(from, to);
    const now = new Date();
    const out = [];
    for (const { item, start } of occurrences(from, to)) {
      const r = item.reminder;
      const past = occurrenceEnd(start, r.allDay) < now;
      out.push({
        id: `${item.memoId}|${r.id}|${start.getTime()}`,
        title: r.title || item.title,
        start,
        allDay: Boolean(r.allDay),
        editable: r.kind === 'at', // 한 번짜리만 끌어 옮긴다 (반복은 메모 창에서)
        className: `mk-ev${r.enabled && !past ? '' : ' off'}`,
        color: 'var(--note-chip)', // eventDidMount 의 data-color 로 메모 색 (어두운 화면도 그 색대로)
        extendedProps: { item },
      });
    }
    for (const e of externalBetween(from, to)) {
      out.push({
        id: `ext|${e.uid}|${e.start.getTime()}`,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        editable: false,
        className: 'mk-ev mk-ext',
        color: e.color || '#4285f4',
        extendedProps: { ext: e },
      });
    }
    return out;
  }

  // 달 보기 칩 모양(base.css)을 바꾼 뒤로 FullCalendar 가 일정을 다시 그릴 때 칩 높이를 한 번 더 재며
  //   "ResizeObserver loop completed with undelivered notifications" 를 남긴다 — 다음 화면에서 맞춰지는 무해한 경고라 이것만 콘솔에 남기지 않는다
  if (!window.mkRoLoopQuiet) {
    window.mkRoLoopQuiet = true;
    window.addEventListener('error', (e) => {
      if (e.message === 'ResizeObserver loop completed with undelivered notifications.') {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }
  const calendar = new Calendar(calEl, {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, themePlugin],
    locale: koLocale,
    initialView: fcView(viewId),
    headerToolbar: false,
    height: 'auto',
    fixedWeekCount: true,
    dayMaxEvents: maxEvents, // 칸 높이에 들어가는 만큼(fitSize 가 다시 정함), 나머지는 +n (낮은 창은 막대 대신 색 점)
    moreLinkClass: 'mk-more',
    moreLinkText: (n) => `+${n}`,
    nowIndicator: true,
    scrollTime: '08:00:00',
    eventTimeFormat: { hour: 'numeric', minute: '2-digit', omitZeroMinute: true, meridiem: 'short' },
    longPressDelay: 350,
    eventLongPressDelay: 350,
    editable: true,
    eventDurationEditable: false,
    defaultTimedEventDuration: '01:00',
    noEventsContent: () => (query.trim() ? '찾는 일정이 없어요' : '이 달에는 일정이 없어요'),
    dayCellTopContent: (arg) => (isMonth() ? dayTop(arg.date) : undefined),
    dayCellClass: dayClass,
    dayHeaderClass: (arg) => (arg.dow === 0 ? 'mk-sun' : arg.dow === 6 ? 'mk-sat' : ''),
    events: (info, ok) => ok(calendarEvents(info.start, info.end)),
    eventDidMount: (arg) => {
      const { item, ext } = arg.event.extendedProps;
      if (item) arg.el.dataset.color = item.color;
      if (ext) arg.el.style.setProperty('--ext-color', ext.color || '#4285f4');
      arg.el.title = ext ? `${arg.event.title}\n${ext.source}${ext.location ? `, ${ext.location}` : ''}` : arg.event.title;
    },
    datesSet: (arg) => {
      title.textContent = arg.view.title;
      dayIndexCache = null; // 보이는 날이 바뀜 — 낮은 창의 색 점도 새로
      let again = compact;
      // 달이 바뀌면 고른 날도 그 달로 (월 보기에서 옆 달로 넘겼을 때 아래 목록이 엉뚱한 달을 보이지 않게)
      const start = arg.view.currentStart;
      const end = arg.view.currentEnd;
      if (selected < start || selected >= end) {
        const t = today();
        selected = t >= start && t < end ? t : dayStart(start);
        again = true;
      }
      if (again) queueMicrotask(() => render()); // 한 번만 · 그리는 중에 옵션을 바꾸지 않게
      if (viewId === MEMORIES) showMemories();
    },
    dateClick: (arg) => pickDay(arg.date),
    // 일정을 누르면 다른 앱으로 나가지 않고 자세히 보기 (월 보기는 그날도 골라 아래 목록을 맞춘다)
    eventClick: (arg) => {
      arg.jsEvent.preventDefault();
      const { item, ext } = arg.event.extendedProps;
      if (isMonth() && !sameDay(arg.event.start, selected)) pickDay(arg.event.start, { add: false });
      if (item) showMemoEvent(item, arg.event.start);
      else if (ext) showExternal(ext);
    },
    eventDrop: (arg) => moveEvent(arg),
    views: {
      // 달 · 주 보기의 일정 막대는 이름만 — 칸이 좁아 "오전 9:3…" 처럼 시각부터 잘렸다 (주 보기는 자리가 곧 시각, 시각은 누르면 · 아래 목록에)
      // 달 보기 칩: 제목만 (글자 크기 · 잘림 표시는 base.css .mk-mt)
      dayGridMonth: {
        dayHeaderFormat: { weekday: 'short' }, // 넓은 창에서도 "일" (일요일 X)
        displayEventTime: false,
        eventContent: (arg) => {
          const t = document.createElement('span');
          t.className = 'mk-mt';
          t.textContent = arg.event.title;
          return { domNodes: [t] };
        },
      },
    },
  });
  calendar.render();
  markView();

  // 창 높이에 맞춰: 월 보기는 한 달이 다 보이게 칸 높이를(낮은 창은 납작하게), 주 보기는 정한 높이 안에서 위아래로 밀기
  //   넓은 창(달력이 왼쪽에 붙음)은 보이는 높이만큼, 좁은 창(휴대폰)도 Google 캘린더처럼 달력이 화면을 채우고
  //   아래 고른 날 목록은 제목 한 줄만 살짝 보이게 (밀어서 보기)
  function fitSize() {
    // 보이는 높이: PC 는 목록 칸(스스로 밀리는 칸)의 높이, 휴대폰은 화면 전체가 밀리므로 창 높이에서 목록 칸 위를 뺀 것.
    //   휴대폰의 목록 칸 높이는 달력 + 아래 목록이라 그걸 재면 달력을 줄일수록 자리가 줄어 끝없이 커졌다 작아졌다 깜빡였다
    const scrolls = /auto|scroll/.test(getComputedStyle(container).overflowY);
    const h = scrolls ? container.clientHeight : window.innerHeight - Math.max(0, container.getBoundingClientRect().top + window.scrollY);
    const w = calEl.clientWidth;
    if (!h || !w) return;
    card.style.setProperty('--cal-col', `${w / 7}px`); // 달 보기 칩 글자 크기 (base.css — 칸 폭에 맞춰 한글 8자쯤)
    const side = container.clientWidth >= 640;
    // 달력 몸통 위(제목 · 보기 줄 · 여백)와 아래(카드 여백)를 실제로 재서 뺀다
    const boxR = container.getBoundingClientRect();
    const bodyR = calEl.getBoundingClientRect();
    const above = bodyR.top - boxR.top + container.scrollTop;
    const below = card.getBoundingClientRect().bottom - bodyR.bottom + parseFloat(getComputedStyle(card).marginBottom || '0') + 2;
    const full = h - above - below;
    const PEEK = 56; // 좁은 창: 아래 "오늘, 10월 17일" 줄이 보일 만큼
    const room = Math.max(120, side ? full : full - PEEK);
    const key = `${viewId}|${Math.round(room / 8)}|${Math.round(w / 8)}`;
    if (key === lastFit) return;
    lastFit = key;
    {
      calendar.setOption('height', 'auto');
      // 6주 + 요일 줄. 칸이 일정 한 줄도 못 담을 만큼 낮으면 예전처럼 날짜 + 색 점만 (compact)
      const nextCompact = viewId === 'dayGridMonth' && room / 7 < 40;
      if (nextCompact !== compact) {
        compact = nextCompact;
        card.classList.toggle('compact', compact);
        calendar.setOption('eventDisplay', compact ? 'none' : 'auto');
      }
      // 비율은 요일 줄을 뺀 날 칸들의 것
      const weekdays = calEl.querySelector('[role="columnheader"]')?.getBoundingClientRect().height || 26;
      if (viewId === 'dayGridMonth') {
        // 칸 높이: 보이는 높이에 맞추되 칩이 4개 이상 들어가게는 (휴대폰은 달력이 화면보다 길어져 밀어서 봄) —
        //   높이는 지금 그려진 칩 · 날짜 줄 · "+n" 을 잰다 (칸보다 많이 넣으면 칸이 늘어나며 달력이 크기를 다시 재는 고리를 돌았다)
        const chip = calEl.querySelector('.mk-ev');
        const chipH = Math.max(12, chip ? chip.offsetHeight + (parseFloat(getComputedStyle(chip).marginBottom) || 0) : 14); // 아직 일정이 없으면 base.css 의 칩 높이쯤
        const topH = calEl.querySelector('[role="gridcell"] > :first-child')?.offsetHeight || 24;
        const moreH = calEl.querySelector('.mk-more')?.offsetHeight || 13;
        const rowH = compact ? (room - weekdays) / 6 : Math.max((room - weekdays) / 6, topH + 4 * chipH + moreH + 2); // 낮은 창(색 점)은 한 달이 다 보이게
        calendar.setOption('aspectRatio', Math.min(8, Math.max(0.5, w / Math.max(100, rowH * 6))));
        const fit = Math.max(1, Math.floor((rowH - topH - moreH - 1) / chipH));
        if (fit !== maxEvents) {
          maxEvents = fit;
          calendar.setOption('dayMaxEvents', fit);
        }
      }
    }
  }
  new ResizeObserver(() => requestAnimationFrame(fitSize)).observe(container); // 다음 화면에서 (달력 크기를 바꾸며 생기는 고리 경고 없이 — 오늘 날짜에 따라 칩 수가 달라져 나던 오류)

  function markView() {
    for (const b of views.querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.view === viewId));
      b.tabIndex = b.dataset.view === viewId ? 0 : -1;
    }
    card.dataset.view = viewId;
    container.dataset.view = viewId;
    const mem = viewId === MEMORIES;
    const memBtn = views.querySelector(`[data-view="${MEMORIES}"]`);
    if (memBtn) memBtn.hidden = !memoriesOn();
    calEl.hidden = mem;
    rowsEl.hidden = mem;
    if (memView) memView.el.hidden = !mem;
  }

  function showMemories() {
    memView.show(calendar.view.currentStart);
  }

  function setView(id, { remember = true } = {}) {
    if (id === viewId) return;
    const was = viewId;
    viewId = id;
    try {
      if (remember) localStorage.setItem(VIEW_KEY, id);
    } catch {
      // 저장 못 함 — 이번만
    }
    markView();
    if (id === MEMORIES) {
      if (was !== 'dayGridMonth') calendar.changeView('dayGridMonth', selected);
      memView.closeDay();
      showMemories();
      return;
    }
    if (fcView(was) !== id) calendar.changeView(id, selected); // 회상 → 월 은 같은 보기를 다시 보이기만 (크기는 달력이 스스로 다시 잰다)
    fitSize();
    render();
  }

  /** 그날 보이는 일정이 있는가 (메모킹 일정 · 다른 캘린더) */
  function busyOn(d) {
    const end = addDays(d, 1);
    return occurrences(d, end).length > 0 || externalBetween(d, end).length > 0;
  }

  // 날 누르기: 일정이 없는 앞으로의 날이면 바로 새 일정 (캘린더 앱처럼), 일정이 있으면 골라 아래 목록에 — 고른 날을 다시 누르면 새 일정
  function pickDay(date, { add = true } = {}) {
    const d = dayStart(date);
    const again = sameDay(d, selected);
    selected = d;
    if (isMonth() && (d < calendar.view.currentStart || d >= calendar.view.currentEnd)) calendar.gotoDate(d);
    render();
    if (add && d >= today() && (again || !busyOn(d))) return quickAdd(d);
    if (!add) rowsEl.querySelector('.ev-day-title')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // 한 번짜리 일정을 다른 날·시각으로 끌어 옮김 → 그 메모의 알림을 고쳐 저장 (못 하면 제자리로)
  async function moveEvent(arg) {
    const item = arg.event.extendedProps.item;
    if (!item || item.reminder.kind !== 'at') return arg.revert();
    const r = item.reminder;
    const allDay = arg.event.allDay;
    const start = allDay ? dayStart(arg.event.start) : arg.event.start;
    const now = new Date();
    const moved = {
      ...r,
      at: toLocalIso(start),
      allDay: allDay || undefined,
      // 하루 종일 ↔ 시각 있는 일정이 바뀌면 미리 알림 뜻이 달라진다 (당일 오전 9시 ↔ 10분 전) — 기본값으로
      alerts: Boolean(r.allDay) === allDay ? r.alerts : [...(allDay ? DEFAULT_ALERTS.allDay : DEFAULT_ALERTS.timed)],
      // 앞으로 옮기면 새 시각의 알림이 다시 울리게, 지난 때로 옮기면 "놓친 알림" 이 울리지 않게 울린 것으로.
      // 꺼 둔 알림은 꺼진 채 (끌어 옮긴다고 켜지지 않게)
      last: occurrenceEnd(start, allDay) > now ? null : toLocalIso(now),
      // 다 울려 저절로 꺼진 일정을 앞으로 옮기면 다시 켠다 (사용자가 끈 것은 꺼진 채)
      enabled: r.enabled || (isDone(r) && occurrenceEnd(start, allDay) > now),
    };
    if (!moved.allDay) delete moved.allDay;
    try {
      await update(item, (list) => list.map((x) => (x.id === r.id ? moved : x)));
      selected = dayStart(start);
      render();
      notify(`"${r.title || item.title}" 일정을 ${dayHeading(start)}${allDay ? '' : ` ${koClock(start)}`}로 옮겼어요`);
    } catch (err) {
      arg.revert();
      notify(err.message || '일정을 옮기지 못했어요', true);
    }
  }

  // ---------- 일정 한 줄 ----------

  /** 일정의 반복 · 알림 설명 (목록 줄과 자세히 보기 같은 글) */
  const repeatText = (r) => (r.kind === 'repeat' ? describeReminder(r) : '');
  const alertText = (r) => (r.enabled ? `알림 ${describeAlerts(r)}` : '알림 꺼짐');

  function eventRow({ item, start }) {
    const r = item.reminder;
    const past = occurrenceEnd(start, r.allDay) < new Date(); // core 의 "지난 일정" 규칙과 같게
    const div = el('div', `row ev-row${r.enabled && !past ? '' : ' off'}`);
    div.dataset.color = item.color;
    div.dataset.memo = item.memoId;
    div.dataset.reminder = r.id;

    const main = el('button', 'row-main');
    main.title = '자세히 보기';
    const time = el('span', 'ev-time', r.allDay ? '하루 종일' : koClock(start));
    const dot = el('span', 'row-dot');
    const text = el('span', 'row-text');
    const rowTitle = el('span', 'row-title', r.title || item.title);
    const sub = el('span', 'row-sub');
    const parts = [];
    if (r.title && r.title !== item.title) parts.push(`메모: ${item.title}`);
    if (repeatText(r)) parts.push(repeatText(r));
    parts.push(alertText(r));
    sub.append(icon(KIND_ICON[r.kind]), el('span', '', parts.join(', ')));
    text.append(rowTitle, sub);
    main.append(time, dot, text);
    main.addEventListener('click', () => showMemoEvent(item, start));

    const del = el('button', 'icon-btn');
    del.title = '일정 삭제';
    del.setAttribute('aria-label', `${rowTitle.textContent} 일정 지우기`);
    del.append(icon('trash'));
    del.addEventListener('click', () => update(item, (list) => list.filter((x) => x.id !== r.id)));

    div.append(main, del);
    return div;
  }

  // 다른 캘린더의 일정 한 줄: 그 캘린더 색 · 이름, "메모로 가져오기" (휴대폰 캘린더는 누르면 캘린더 앱에서 열기)
  function externalRow(e) {
    const past = e.end < new Date();
    const div = el('div', `row ev-row ev-ext${past ? ' off' : ''}`);
    div.style.setProperty('--ext-color', e.color || '#4285f4');
    const main = el('button', 'row-main');
    const time = el('span', 'ev-time', e.allDay ? '하루 종일' : koClock(e.start));
    const dot = el('span', 'row-dot');
    const text = el('span', 'row-text');
    text.append(el('span', 'row-title', e.title));
    const sub = el('span', 'row-sub');
    sub.append(icon('calendar'), el('span', '', [e.source, e.location].filter(Boolean).join(', ')));
    text.append(sub);
    main.append(time, dot, text);
    main.title = '자세히 보기';
    main.addEventListener('click', () => showExternal(e));
    const take = el('button', 'icon-btn ev-import');
    take.type = 'button';
    take.title = '메모로 가져오기';
    take.setAttribute('aria-label', `${e.title} 메모로 가져오기`);
    take.append(icon('note'));
    take.addEventListener('click', () => importExternal(e));
    div.append(main, take);
    return div;
  }

  // ---------- 일정 자세히 보기 (누르면 다른 캘린더 앱으로 나가지 않고 여기서) ----------

  function showMemoEvent(item, start) {
    const r = item.reminder;
    const span = occurrenceEnd(start, r.allDay);
    openEventDetail({
      title: r.title || item.title,
      start,
      end: r.allDay ? span : null, // 메모킹 일정은 끝나는 시각이 없다 — 하루 종일만 그날까지
      allDay: Boolean(r.allDay),
      memoColor: item.color,
      source: r.title && r.title !== item.title ? `메모킹 메모 "${item.title}"` : '메모킹',
      lines: [
        { icon: 'repeat', text: repeatText(r) },
        { icon: 'bell', text: alertText(r) },
      ],
      // 반복 일정은 한 회차만 지울 수 없어(지우면 모든 회차가 사라짐) 여기서는 지우지 않는다 — 메모에서 고치기
      actions: [
        ...(r.kind === 'repeat' ? [] : [{ label: '일정 지우기', danger: true, run: () => update(item, (list) => list.filter((x) => x.id !== r.id))
          .then(() => notify(`"${r.title || item.title}" 일정을 지웠어요`))
          .catch((err) => notify(err.message || '일정을 지우지 못했어요', true)) }]),
        { label: '메모 열기', primary: true, run: () => api.memo.open(item.memoId) },
      ],
    });
  }

  function showExternal(e) {
    openEventDetail({
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      color: e.color || '#4285f4',
      source: e.source,
      readOnly: true,
      lines: [{ icon: 'pin', text: e.location }],
      note: e.description,
      url: e.url,
      openUrl: calendars?.openUrl, // 회의 주소 등 — 다른 캘린더 앱이 아니라 그 주소만 연다
      actions: api.reminders.add ? [{ label: '메모로 가져오기', primary: true, run: () => importExternal(e) }] : [],
    });
  }

  // 가져온 일정의 메모 본문: 그 달 달력 그림(그 날짜에 색연필 동그라미) · 장소 · 설명 · 주소
  //   그림을 못 만들면(첨부를 못 쓰는 곳 등) 글만
  async function importBody(e) {
    let imageRel = '';
    const when = whenText(e, { relative: false }); // 그림에 남으니 "내일" 대신 날짜
    try {
      if (api.attachments?.save) {
        const png = await monthSketchPng({ start: e.start, end: e.end, allDay: e.allDay, title: e.title, when, color: e.color });
        imageRel = (await api.attachments.save(png, 'png')) || '';
      }
    } catch (err) {
      console.warn('[calendar] 달력 그림', err);
    }
    const alt = `${e.start.getFullYear()}년 ${e.start.getMonth() + 1}월 달력, ${when}`;
    return importedEventBody({ title: e.title, imageRel, imageAlt: alt, location: e.location, description: e.description, url: e.url });
  }

  let importing = false;
  async function importExternal(e) {
    if (importing || !api.reminders.add) return;
    // 이미 가져온 일정(같은 이름 · 같은 날 · 같은 시각)이면 또 만들지 않고 그 메모를 연다
    const r0 = reminderFromExternal(e);
    const same = items.find((i) => i.reminder.kind === 'at' && (i.reminder.title || i.title) === r0.title
      && new Date(i.reminder.at).getTime() === new Date(r0.at).getTime());
    if (same) {
      notify(`"${e.title}" 은(는) 이미 메모킹 일정에 있어요`);
      api.memo.open(same.memoId);
      return;
    }
    importing = true;
    try {
      const id = await api.reminders.add(null, r0, e.title, await importBody(e));
      await refresh();
      notify(`"${e.title}" 을(를) 메모킹 일정으로 가져왔어요`);
      if (id) api.memo.open(id);
    } catch (err) {
      notify(err.message || '가져오지 못했어요', true);
    } finally {
      importing = false;
    }
  }

  function row(item) {
    const r = item.reminder;
    const div = el('div', `row rem-row-item${r.enabled ? '' : ' off'}`);
    div.dataset.color = item.color;
    div.dataset.memo = item.memoId;
    div.dataset.reminder = r.id;

    const main = el('button', 'row-main');
    main.title = '메모 열기';
    const dot = el('span', 'row-dot');
    const text = el('span', 'row-text');
    const rowTitle = el('span', 'row-title', item.title);
    const sub = el('span', 'row-sub');
    const words = el('span');
    const when = isDone(r) ? '끝났어요' : !r.enabled ? '꺼져 있어요' : r.kind === 'startup' ? '' : nextLabel(r);
    if (when) words.append(el('b', '', when), ', ');
    words.append(`${describeReminder(r)}, ${r.action === 'open' ? '메모 띄우기' : '알림만 보내기'}`);
    sub.append(icon(KIND_ICON[r.kind]), words);
    text.append(rowTitle, sub);
    main.append(dot, text);
    main.addEventListener('click', () => api.memo.open(item.memoId));

    const toggle = el('input', 'switch');
    toggle.type = 'checkbox';
    toggle.checked = r.enabled;
    toggle.setAttribute('aria-label', `${item.title} 알림`);
    toggle.addEventListener('change', () => update(item, (list) => list.map((x) => (x.id === r.id
      ? (toggle.checked ? reenable(x) : { ...x, enabled: false })
      : x))));

    const del = el('button', 'icon-btn');
    del.title = '알림 삭제';
    del.setAttribute('aria-label', `${item.title} 알림 지우기`);
    del.append(icon('trash'));
    del.addEventListener('click', () => update(item, (list) => list.filter((x) => x.id !== r.id)));

    div.append(main, toggle, del);
    return div;
  }

  function heading(text, cls = '') {
    return el('h3', `rows-title ${cls}`.trim(), text);
  }

  const oneRow = (o) => (o.ext ? externalRow(o.ext) : eventRow(o));

  function renderRows() {
    const now = new Date();
    const t = today();
    const out = [];

    // 목록 보기에는 달력이 곧 일정 목록 — 고른 날 · 다가오는 일정은 월 · 주 보기에서만
    if (viewId !== 'listMonth') {
      const dayList = allBetween(selected, addDays(selected, 1));
      const dayTitle = heading(dayHeading(selected, now), 'ev-day-title');
      if (selected >= t) {
        const add = el('button', 'link-btn ev-add');
        add.type = 'button';
        add.append(icon('plus'), '일정 추가');
        add.setAttribute('aria-label', `${dayHeading(selected, now)}에 일정 추가`);
        const day = selected;
        add.addEventListener('click', () => quickAdd(day));
        dayTitle.append(add);
      }
      out.push(dayTitle);
      if (dayList.length) out.push(...dayList.map(oneRow));
      else out.push(el('p', 'ev-none', '일정이 없어요'));

      // 다가오는 일정 (오늘을 고른 동안 · 앞으로 30일, 날짜별)
      if (sameDay(selected, t)) {
        // 오늘 전에 시작해 이어지는 여러 날 일정은 위(오늘)에 이미 있다 — 내일부터 시작하는 것만
        const upcoming = allBetween(addDays(t, 1), addDays(t, UPCOMING_DAYS + 1)).filter((o) => o.start >= addDays(t, 1));
        if (upcoming.length) {
          out.push(heading('다가오는 일정', 'ev-upcoming-title'));
          let lastDay = null;
          for (const o of upcoming) {
            if (!lastDay || !sameDay(lastDay, o.start)) {
              lastDay = o.start;
              out.push(heading(dayHeading(o.start, now), 'ev-sub-title'));
            }
            out.push(oneRow(o));
          }
        }
      }
    }

    // 일정이 아닌 알림
    const others = items.filter((i) => !isEvent(i.reminder) && matches(i));
    const active = others.filter((i) => i.reminder.enabled).sort((a, b) => nextTime(a.reminder, now) - nextTime(b.reminder, now));
    const off = others.filter((i) => !i.reminder.enabled);
    if (active.length) out.push(heading(`타이머와 알림 ${active.length}`), ...active.map(row));
    if (off.length) out.push(heading(`꺼졌거나 끝난 알림 ${off.length}`), ...off.map(row));

    // 다른 캘린더를 받지 못했으면 한 줄로 (받아 둔 것은 그대로 보임)
    const failed = feeds.filter((f) => f.on && feedTexts.get(f.id)?.error);
    if (failed.length) {
      const p = el('p', 'ev-hint ev-feed-error');
      p.append(icon('cloud'), ` ${failed.map((f) => `${f.name}: ${feedTexts.get(f.id).error}`).join(', ')}`);
      out.push(p);
    }

    // 일정이 하나도 없거나 찾는 일정이 없으면: 달력 아래에 짧은 한 줄로 (따로 큰 칸을 두면 달력이 그만큼 잘린다)
    const searching = Boolean(query.trim());
    const found = searching && (items.some(matches) || externalMatches());
    if (searching ? !found : !items.length && !feeds.some((f) => f.on) && !device.on) {
      out.push(el('p', 'ev-hint', searching ? '찾는 일정이 없어요.'
        : '날짜를 고르고 "＋ 일정 추가"를 누르거나, 메모에 "내일 오후 3시 치과"처럼 쓰면 일정이 돼요. "다른 캘린더"로 Google 캘린더, 삼성 캘린더 일정도 함께 볼 수 있어요.'));
    }
    const top = container.scrollTop; // 다시 그려도 보던 자리 그대로 (1분마다 새로 그릴 때·켜고 끌 때)
    rowsEl.replaceChildren(...out);
    if (top) container.scrollTop = top;
  }

  function render() {
    const now = new Date();
    const t = today();
    // 창을 켜 둔 채 자정이 지나면: "오늘" 을 보고 있었다면 새 오늘로 (다가오는 일정이 사라지지 않게)
    if (!sameDay(t, shownToday)) {
      if (sameDay(selected, shownToday)) {
        selected = t;
        calendar.gotoDate(t);
      }
      shownToday = t;
    }
    dayIndexCache = null;
    // 고른 날이 바뀌었거나 낮은 창(날 칸에 색 점)일 때만 날 칸을 다시 그린다 — 새 함수를 주면 다시 그린다
    if (compact || selected.getTime() !== lastCellKey) {
      lastCellKey = selected.getTime();
      calendar.setOption('dayCellClass', (arg) => dayClass(arg));
    }
    calendar.refetchEvents();
    renderRows();
    updateCount(now);
  }

  let adding = false;
  async function quickAdd(day) {
    if (adding || !api.reminders.add) return;
    adding = true;
    try {
      const out = await openQuickEvent({ day, search: (q) => api.memos.search(q) });
      if (!out) return;
      await api.reminders.add(out.memoId, out.reminder, out.newTitle);
      selected = dayStart(new Date(out.reminder.at)); // 일정 창에서 날짜를 바꿨으면 그날로
      if (isMonth() && (selected < calendar.view.currentStart || selected >= calendar.view.currentEnd)) calendar.gotoDate(selected);
      await refresh();
      notify(out.memoId ? '메모에 일정을 넣었어요' : `새 메모 "${out.newTitle}"에 일정을 만들었어요`);
    } catch (err) {
      console.error(err);
      notify(err.message || '일정을 만들지 못했어요', true);
    } finally {
      adding = false;
    }
  }

  // 다른 캘린더 잇기 창 — 닫으면 바뀐 것을 다시 받아 그린다
  async function openLinks() {
    await openCalendarLinks({ calendars, notify, feedTexts });
    await loadFeeds();
  }

  setInterval(render, 60_000); // "다음 알림" · 지난 일정 흐리게 새로 계산
  setInterval(() => loadFeeds(), 15 * 60_000); // 다른 캘린더 (받은 지 15분이 지난 것만 새로)
  loadFeeds();

  return {
    refresh,
    /** Work / Life 를 바꿨다: 그 모드의 일정만 다시 · 회상도 그 모드의 메모로 다시 */
    modeChanged() {
      items = visible ? allItems.filter(visible) : allItems;
      if (viewId === MEMORIES && !memoriesOn()) setView(VIEWS[0].id, { remember: false });
      else if (memoriesOn() && storedView(viewList) === MEMORIES && viewId !== MEMORIES) setView(MEMORIES, { remember: false });
      else if (viewId === MEMORIES) memView.refresh();
      else render();
      markView();
      updateCount(new Date()); // 탭 숫자도 그 모드의 것으로 (회상 보기로 가면 render 를 거치지 않는다)
    },
    // + 단추 (휴대폰 일정 탭): 고른 날에 새 일정 — 지난 날을 골라 두었으면 오늘
    addEvent: () => quickAdd(selected >= today() ? selected : today()),
    /** @param {{ quiet?: boolean }} [o] quiet: 그리지 않고 검색어만 (곧 refresh 가 그릴 때 — 달력을 두 번 그리지 않게) */
    setQuery(q, { quiet = false } = {}) {
      query = q;
      if (!quiet) render();
    },
  };
}
