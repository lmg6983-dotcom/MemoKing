// 예약 알림의 날짜·시각 고르기 — 휴대폰 기본 입력(돌리는 다이얼·시계판) 대신 달력 한 장과 시각 칩.
//   값은 원래 입력칸(<input id="at-input"> · <input id="rep-time">)에 그대로 써 넣어 reminder-panel.js 의 계산은 바뀌지 않는다.
//   PC 메모 창 · 휴대폰이 함께 쓴다.
import { dayLabel, sameDay, startOfDay } from './core/time.js';
import { UI } from './core/ui-text.js';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/** 오전/오후 n시 m분 */
export function timeLabel(h, m) {
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${pad(m)}`;
}

/**
 * 시각 고르기: 자주 쓰는 시각 칩 + 시·분 목록 (다이얼 없이)
 * @param {HTMLElement} box 넣을 자리
 * @param {{ value: string, onChange: (hhmm: string) => void, quick?: string[] }} o value 'HH:MM'
 */
//   compact: 처음엔 자주 쓰는 시각 칩 + "다른 시각" 만, 누르면(또는 칩에 없는 시각이면) 시 · 분 목록 (한 가지 방식으로 보이게)
export function timePicker(box, { value, onChange, quick = ['09:00', '12:00', '15:00', '18:00', '21:00'], compact = false }) {
  let [h, m] = String(value || '09:00').split(':').map(Number);
  const chips = el('div', 'chips dp-quick');
  chips.setAttribute('aria-label', '자주 쓰는 시각');
  const row = el('div', 'dp-time');
  const hour = el('select', 'dp-hour');
  hour.setAttribute('aria-label', '시');
  for (let i = 0; i < 24; i++) hour.append(new Option(`${i < 12 ? '오전' : '오후'} ${i % 12 || 12}시`, String(i)));
  const minute = el('select', 'dp-minute');
  minute.setAttribute('aria-label', '분');
  for (let i = 0; i < 60; i += 5) minute.append(new Option(`${pad(i)}분`, String(i)));
  row.append(hour, minute);
  for (const t of quick) {
    const [qh, qm] = t.split(':').map(Number);
    const b = el('button', '', timeLabel(qh, qm).replace(':00', '시'));
    b.type = 'button';
    b.dataset.time = t;
    chips.append(b);
  }
  let more = null;
  if (compact) {
    more = el('button', 'dp-more', '다른 시각');
    more.type = 'button';
    more.addEventListener('click', () => {
      row.hidden = false;
      more.hidden = true;
      hour.focus();
    });
    chips.append(more);
    row.hidden = true;
  }
  box.replaceChildren(chips, row);

  function sync() {
    const hhmm = `${pad(h)}:${pad(m)}`;
    hour.value = String(h);
    // 5분 단위가 아닌 값(예전 알림 등)은 목록에 잠깐 더해 둔다
    if (![...minute.options].some((o) => Number(o.value) === m)) minute.append(new Option(`${pad(m)}분`, String(m)));
    minute.value = String(m);
    for (const b of chips.querySelectorAll('[data-time]')) b.setAttribute('aria-pressed', String(b.dataset.time === hhmm));
    // 칩에 없는 시각이면 목록을 보여 준다 (어느 시각인지 보이게)
    if (more && !quick.includes(hhmm)) {
      row.hidden = false;
      more.hidden = true;
    }
    onChange(hhmm);
  }
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-time]');
    if (!b) return;
    [h, m] = b.dataset.time.split(':').map(Number);
    // 칩으로 골랐으면 시 · 분 목록은 다시 접는다 (칩 · 목록 두 가지가 한꺼번에 보이지 않게)
    if (more) {
      row.hidden = true;
      more.hidden = false;
    }
    sync();
  });
  hour.addEventListener('change', () => {
    h = Number(hour.value);
    sync();
  });
  minute.addEventListener('change', () => {
    m = Number(minute.value);
    sync();
  });
  sync();
  return {
    set(hhmm) {
      [h, m] = String(hhmm).split(':').map(Number);
      sync();
    },
  };
}

/**
 * 날짜·시각 고르기: 한 달 달력(지난 날은 못 고름) + 시각 고르기 + "언제 알려요" 한 줄
 * @param {HTMLElement} box 넣을 자리
 * @param {{ input: HTMLInputElement }} o input: 'YYYY-MM-DDTHH:MM' 값을 받는 칸 (reminder-panel 이 읽는다)
 */
export function dateTimePicker(box, { input }) {
  const now = () => new Date();
  let picked = input.value ? new Date(input.value) : new Date(now().getTime() + 3600_000);
  if (Number.isNaN(picked.getTime())) picked = new Date(now().getTime() + 3600_000);
  let month = new Date(picked.getFullYear(), picked.getMonth(), 1);

  const head = el('div', 'dp-head');
  const prev = el('button', 'icon-btn dp-nav', '‹');
  prev.type = 'button';
  prev.setAttribute('aria-label', '이전 달');
  const next = el('button', 'icon-btn dp-nav', '›');
  next.type = 'button';
  next.setAttribute('aria-label', '다음 달');
  const title = el('span', 'dp-title');
  title.setAttribute('aria-live', 'polite');
  head.append(prev, title, next);
  const grid = el('div', 'dp-grid');
  grid.setAttribute('role', 'grid');
  const time = el('div', 'dp-time-box');
  const summary = el('p', 'dp-summary');
  box.replaceChildren(head, grid, time, summary);

  const write = () => {
    input.value = `${picked.getFullYear()}-${pad(picked.getMonth() + 1)}-${pad(picked.getDate())}T${pad(picked.getHours())}:${pad(picked.getMinutes())}`;
    const d = picked;
    const today = now();
    summary.textContent = `${dayLabel(d, today)} ${timeLabel(d.getHours(), d.getMinutes())}에 알려요`;
    summary.classList.toggle('past', d <= today);
    if (d <= today) summary.textContent = UI.pastTime;
    input.dispatchEvent(new Event('input')); // 알림 패널이 이미 지난 미리 알림을 다시 가리게
  };

  function drawMonth() {
    title.textContent = `${month.getFullYear()}년 ${month.getMonth() + 1}월`;
    const today = startOfDay(now());
    prev.disabled = month <= new Date(today.getFullYear(), today.getMonth(), 1);
    const cells = WEEK.map((w, i) => {
      const c = el('span', `dp-wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`, w);
      c.setAttribute('aria-hidden', 'true');
      return c;
    });
    const first = month.getDay();
    for (let i = 0; i < first; i++) cells.push(el('span', 'dp-blank'));
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const date = new Date(month.getFullYear(), month.getMonth(), d);
      const b = el('button', 'dp-day', String(d));
      b.type = 'button';
      b.dataset.day = String(d);
      b.setAttribute('aria-label', `${month.getMonth() + 1}월 ${d}일 ${WEEK[date.getDay()]}요일`);
      if (date < today) b.disabled = true;
      if (sameDay(date, today)) b.classList.add('today');
      if (date.getDay() === 0) b.classList.add('sun');
      if (date.getDay() === 6) b.classList.add('sat');
      b.setAttribute('aria-pressed', String(sameDay(date, picked)));
      cells.push(b);
    }
    grid.replaceChildren(...cells);
  }

  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b || b.disabled) return;
    picked = new Date(month.getFullYear(), month.getMonth(), Number(b.dataset.day), picked.getHours(), picked.getMinutes());
    drawMonth();
    write();
  });
  prev.addEventListener('click', () => {
    month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    drawMonth();
  });
  next.addEventListener('click', () => {
    month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    drawMonth();
  });
  const clock = timePicker(time, {
    value: `${pad(picked.getHours())}:${pad(picked.getMinutes())}`,
    onChange: (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      picked = new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), h, m);
      write();
    },
  });
  drawMonth();
  write();
  return {
    /** 바깥에서 값을 정할 때 (패널을 다시 열어 기본값을 넣는 등) */
    set(date) {
      picked = date;
      month = new Date(date.getFullYear(), date.getMonth(), 1);
      drawMonth();
      clock.set(`${pad(date.getHours())}:${pad(date.getMinutes())}`);
    },
  };
}
