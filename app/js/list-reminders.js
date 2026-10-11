// 목록 창 "일정" 탭 (PC·휴대폰 같음) — 구글 캘린더처럼: 위에 한 달 달력(일정 있는 날에 점), 아래에 고른 날의 일정과
// 다가오는 일정. 일정마다 언제 미리 알리는지(30분 전, 하루 전 …)를 함께 보인다. 타이머·앱 열 때 알림은 맨 아래 따로.
import { icon } from './icons.js';
import { describeReminder, describeAlerts, nextLabel, nextTime, isDone, isEvent, occurrencesBetween } from './core/reminders.js';
import { koClock } from './core/time.js';

const KIND_ICON = { timer: 'timer', at: 'calendar', repeat: 'repeat', startup: 'power' };
const WEEKDAY = '일월화수목금토';
const DAY_MS = 86_400_000;
const UPCOMING_DAYS = 30;

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** "오늘 · 10월 12일 (월)" 같은 날 이름 */
export function dayHeading(d, now = new Date()) {
  const diff = Math.round((dayStart(d) - dayStart(now)) / DAY_MS);
  const name = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})`;
  return diff === 0 ? `오늘, ${name}` : diff === 1 ? `내일, ${name}` : name;
}

export function setupRemindersTab({ api, container, empty, countEl }) {
  let items = []; // [{ memoId, title, color, reminder }]
  let query = '';
  const today = () => dayStart(new Date());
  let month = new Date(today().getFullYear(), today().getMonth(), 1);
  let selected = today();

  async function refresh() {
    items = await api.reminders.all();
    render();
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

  // ---------- 달력 ----------

  function calendar() {
    const wrap = document.createElement('section');
    wrap.className = 'cal';
    wrap.setAttribute('aria-label', '달력');
    const head = document.createElement('div');
    head.className = 'cal-head';
    const prev = navButton('chev-right', '지난달', () => {
      month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
      render();
    });
    prev.classList.add('cal-prev');
    const next = navButton('chev-right', '다음 달', () => {
      month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
      render();
    });
    const title = document.createElement('b');
    title.className = 'cal-title';
    title.textContent = `${month.getFullYear()}년 ${month.getMonth() + 1}월`;
    title.setAttribute('aria-live', 'polite');
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.className = 'link-btn cal-today';
    todayBtn.textContent = '오늘';
    todayBtn.addEventListener('click', () => {
      selected = today();
      month = new Date(selected.getFullYear(), selected.getMonth(), 1);
      render();
    });
    head.append(prev, title, next, todayBtn);

    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    grid.setAttribute('role', 'grid');
    for (const w of WEEKDAY) {
      const h = document.createElement('span');
      h.className = 'cal-wd';
      h.textContent = w;
      grid.append(h);
    }
    // 6주 칸: 이 달 1일이 든 주의 일요일부터
    const first = addDays(month, -month.getDay());
    const last = addDays(first, 42);
    const byDay = new Map();
    for (const o of occurrences(first, last)) {
      const k = dayKey(o.start);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(o);
    }
    const t = today();
    for (let i = 0; i < 42; i++) {
      const d = addDays(first, i);
      const list = byDay.get(dayKey(d)) ?? [];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-day';
      if (d.getMonth() !== month.getMonth()) cell.classList.add('other');
      if (sameDay(d, t)) cell.classList.add('today');
      if (sameDay(d, selected)) cell.setAttribute('aria-pressed', 'true');
      cell.setAttribute('aria-label', `${dayHeading(d)}${list.length ? `, 일정 ${list.length}개` : ''}`);
      const num = document.createElement('span');
      num.className = 'cal-num';
      num.textContent = String(d.getDate());
      const dots = document.createElement('span');
      dots.className = 'cal-dots';
      for (const o of list.slice(0, 3)) {
        const dot = document.createElement('i');
        dot.dataset.color = o.item.color;
        dots.append(dot);
      }
      cell.append(num, dots);
      cell.addEventListener('click', () => {
        selected = d;
        if (d.getMonth() !== month.getMonth()) month = new Date(d.getFullYear(), d.getMonth(), 1);
        render();
      });
      grid.append(cell);
    }
    wrap.append(head, grid);
    return wrap;
  }

  function navButton(name, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn cal-nav';
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- 일정 한 줄 ----------

  function eventRow({ item, start }) {
    const r = item.reminder;
    const past = (r.allDay ? addDays(dayStart(start), 1) : start) < new Date();
    const div = document.createElement('div');
    div.className = `row ev-row${r.enabled && !past ? '' : ' off'}`;
    div.dataset.color = item.color;
    div.dataset.memo = item.memoId;
    div.dataset.reminder = r.id;

    const main = document.createElement('button');
    main.className = 'row-main';
    main.title = '메모 열기';
    const time = document.createElement('span');
    time.className = 'ev-time';
    time.textContent = r.allDay ? '하루 종일' : koClock(start);
    const dot = document.createElement('span');
    dot.className = 'row-dot';
    const text = document.createElement('span');
    text.className = 'row-text';
    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = r.title || item.title;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    const words = document.createElement('span');
    const parts = [];
    if (r.title && r.title !== item.title) parts.push(`메모: ${item.title}`);
    if (r.kind === 'repeat') parts.push(describeReminder(r));
    parts.push(r.enabled ? `알림 ${describeAlerts(r)}` : '알림 꺼짐');
    words.textContent = parts.join(', ');
    sub.append(icon(KIND_ICON[r.kind]), words);
    text.append(title, sub);
    main.append(time, dot, text);
    main.addEventListener('click', () => api.memo.open(item.memoId));

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = '일정 삭제';
    del.setAttribute('aria-label', `${title.textContent} 일정 지우기`);
    del.append(icon('trash'));
    del.addEventListener('click', () => update(item, (list) => list.filter((x) => x.id !== r.id)));

    div.append(main, del);
    return div;
  }

  // ---------- 타이머 · 앱 열 때 (일정이 아닌 알림) ----------

  function row(item) {
    const r = item.reminder;
    const div = document.createElement('div');
    div.className = `row rem-row-item${r.enabled ? '' : ' off'}`;
    div.dataset.color = item.color;
    div.dataset.memo = item.memoId;
    div.dataset.reminder = r.id;

    const main = document.createElement('button');
    main.className = 'row-main';
    main.title = '메모 열기';
    const dot = document.createElement('span');
    dot.className = 'row-dot';
    const text = document.createElement('span');
    text.className = 'row-text';
    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = item.title;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    const words = document.createElement('span');
    const when = isDone(r) ? '끝났어요' : !r.enabled ? '꺼져 있어요' : r.kind === 'startup' ? '' : nextLabel(r);
    if (when) {
      const b = document.createElement('b');
      b.textContent = when;
      words.append(b, ', ');
    }
    words.append(`${describeReminder(r)}, ${r.action === 'open' ? '메모 띄우기' : '알림만 보내기'}`);
    sub.append(icon(KIND_ICON[r.kind]), words);
    text.append(title, sub);
    main.append(dot, text);
    main.addEventListener('click', () => api.memo.open(item.memoId));

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.checked = r.enabled;
    toggle.setAttribute('aria-label', `${item.title} 알림`);
    toggle.addEventListener('change', () => update(item, (list) => list.map((x) => (x.id === r.id
      ? { ...x, enabled: toggle.checked, last: toggle.checked && isDone(x) ? null : x.last }
      : x))));

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = '알림 삭제';
    del.setAttribute('aria-label', `${item.title} 알림 지우기`);
    del.append(icon('trash'));
    del.addEventListener('click', () => update(item, (list) => list.filter((x) => x.id !== r.id)));

    div.append(main, toggle, del);
    return div;
  }

  function heading(text, cls = '') {
    const h = document.createElement('h3');
    h.className = `rows-title ${cls}`.trim();
    h.textContent = text;
    return h;
  }

  function render() {
    const now = new Date();
    const t = today();
    const out = [calendar()];

    // 고른 날
    const dayList = occurrences(selected, addDays(selected, 1));
    out.push(heading(dayHeading(selected, now), 'ev-day-title'));
    if (dayList.length) out.push(...dayList.map(eventRow));
    else {
      const p = document.createElement('p');
      p.className = 'ev-none';
      p.textContent = '일정이 없어요';
      out.push(p);
    }

    // 다가오는 일정 (오늘을 고른 동안 · 앞으로 30일, 날짜별)
    if (sameDay(selected, t)) {
      const upcoming = occurrences(addDays(t, 1), addDays(t, UPCOMING_DAYS + 1));
      if (upcoming.length) {
        out.push(heading('다가오는 일정', 'ev-upcoming-title'));
        let lastDay = null;
        for (const o of upcoming) {
          if (!lastDay || !sameDay(lastDay, o.start)) {
            lastDay = o.start;
            out.push(heading(dayHeading(o.start, now), 'ev-sub-title'));
          }
          out.push(eventRow(o));
        }
      }
    }

    // 일정이 아닌 알림
    const others = items.filter((i) => !isEvent(i.reminder) && matches(i));
    const active = others.filter((i) => i.reminder.enabled).sort((a, b) => nextTime(a.reminder, now) - nextTime(b.reminder, now));
    const off = others.filter((i) => !i.reminder.enabled);
    if (active.length) out.push(heading(`타이머와 알림 ${active.length}`), ...active.map(row));
    if (off.length) out.push(heading(`꺼졌거나 끝난 알림 ${off.length}`), ...off.map(row));

    container.replaceChildren(...out);
    empty.hidden = items.length > 0;
    // 탭 숫자: 앞으로 울릴 알림이 있는 것
    const live = items.filter((i) => i.reminder.enabled && nextTime(i.reminder, now) < Infinity).length;
    countEl.textContent = live ? String(live) : '';
  }

  setInterval(render, 60_000); // "다음 알림" · 지난 일정 흐리게 새로 계산

  return {
    refresh,
    setQuery(q) {
      query = q;
      render();
    },
  };
}
