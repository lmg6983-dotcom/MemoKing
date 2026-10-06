// 메모 창의 예약 알림 패널 — 알림 목록(켜기/끄기·삭제)과 새 알림 만들기
import { icon } from './icons.js';
import { describeReminder, nextLabel, isDone } from './core/reminders.js';
import { toLocalIso } from './core/time.js';

const $ = (id) => document.getElementById(id);
const KIND_ICON = { timer: 'timer', at: 'calendar', repeat: 'repeat', startup: 'power' };
const pad = (v) => String(v).padStart(2, '0');
// <input type="datetime-local"> 값: 2026-09-30T14:00
const localInputValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * @param {{ api: object, memoId: string, setStatus: (text: string, isError?: boolean) => void, onToggle?: (open: boolean) => void }} options
 */
export function setupReminderPanel({ api, memoId, setStatus, onToggle }) {
  const el = {
    panel: $('reminder-panel'),
    list: $('reminder-list'),
    form: $('reminder-form'),
    kinds: $('rem-kind'),
    btn: $('bell-btn'),
    count: $('bell-count'),
    timerMin: $('timer-min'),
    presets: $('timer-presets'),
    atInput: $('at-input'),
    every: $('rep-every'),
    weekdays: $('rep-weekdays'),
    monthWrap: $('rep-month-wrap'),
    dayWrap: $('rep-day-wrap'),
    month: $('rep-month'),
    day: $('rep-day'),
    time: $('rep-time'),
  };
  let reminders = [];
  let kind = 'timer';

  // ---------- 목록 ----------

  function render() {
    const enabled = reminders.filter((r) => r.enabled).length;
    el.count.textContent = enabled ? String(enabled) : '';
    el.btn.classList.toggle('has-links', enabled > 0);
    el.btn.title = enabled ? `알림 ${enabled}개 예약됨 (Ctrl+Shift+A)` : '알림 예약 (Ctrl+Shift+A)';
    el.list.replaceChildren(...reminders.map(renderItem));
  }

  function renderItem(r) {
    const li = document.createElement('li');
    li.className = `rem-item${r.enabled ? '' : ' off'}`;
    li.dataset.id = r.id;
    li.append(icon(KIND_ICON[r.kind], 'rem-kind-icon'));

    const text = document.createElement('div');
    text.className = 'rem-text';
    const title = document.createElement('div');
    title.className = 'rem-title';
    title.textContent = describeReminder(r);
    const sub = document.createElement('div');
    sub.className = 'rem-sub';
    const next = nextLabel(r);
    const state = isDone(r) ? '끝났어요' : !r.enabled ? '꺼져 있어요' : r.kind === 'startup' ? '' : next ? `다음 ${next}` : '';
    sub.textContent = [state, r.action === 'open' ? '메모 바로 열기' : '알림으로 받기'].filter(Boolean).join(' · ');
    text.append(title, sub);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.checked = r.enabled;
    toggle.title = r.enabled ? '끄기' : '켜기';
    toggle.setAttribute('aria-label', `${title.textContent} ${r.enabled ? '끄기' : '켜기'}`);
    toggle.addEventListener('change', () => {
      // 완료된 한 번짜리 알림을 다시 켜면 처음부터 (울린 기록 지움)
      const next = { ...r, enabled: toggle.checked, last: toggle.checked && isDone(r) ? null : r.last };
      save(reminders.map((x) => (x.id === r.id ? next : x)));
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.title = '삭제';
    del.setAttribute('aria-label', `${title.textContent} 지우기`);
    del.append(icon('trash'));
    del.addEventListener('click', () => save(reminders.filter((x) => x.id !== r.id)));

    li.append(text, toggle, del);
    return li;
  }

  async function save(next) {
    try {
      reminders = (await api.reminders.set(memoId, next)) ?? next;
      render();
    } catch (err) {
      console.error(err);
      setStatus('알림을 저장하지 못했어요. 다시 시도해 주세요.', true);
    }
  }

  // ---------- 새 알림 ----------

  function setKind(next) {
    kind = next;
    for (const b of el.kinds.querySelectorAll('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    for (const pane of el.form.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== kind;
    if (kind === 'at' && !el.atInput.value) {
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(0, 0, 0);
      el.atInput.value = localInputValue(d);
    }
    if (kind === 'repeat') syncRepeat();
  }

  function syncRepeat() {
    const every = el.every.value;
    el.weekdays.hidden = every !== 'week';
    el.dayWrap.hidden = every !== 'month' && every !== 'year';
    el.monthWrap.hidden = every !== 'year';
    if (every === 'week' && !el.weekdays.querySelector('[aria-pressed="true"]')) {
      el.weekdays.querySelector(`[data-wd="${new Date().getDay()}"]`)?.setAttribute('aria-pressed', 'true');
    }
    const now = new Date();
    if (every === 'year' && !el.month.dataset.touched) el.month.value = String(now.getMonth() + 1);
    if ((every === 'month' || every === 'year') && !el.day.dataset.touched) el.day.value = String(now.getDate());
  }

  function build() {
    const now = new Date();
    const action = el.form.querySelector('input[name="action"]:checked').value;
    const base = { kind, action, enabled: true, created: toLocalIso(now) };
    if (kind === 'timer') {
      const minutes = Math.round(Number(el.timerMin.value));
      if (!(minutes >= 1)) throw new Error('몇 분 뒤인지 적어 주세요');
      return { ...base, minutes, at: toLocalIso(new Date(now.getTime() + minutes * 60_000)) };
    }
    if (kind === 'at') {
      const at = new Date(el.atInput.value);
      if (Number.isNaN(at.getTime())) throw new Error('날짜와 시각을 골라 주세요');
      if (at <= now) throw new Error('이미 지난 시각이에요. 앞으로의 시각을 골라 주세요');
      return { ...base, at: toLocalIso(at) };
    }
    if (kind === 'repeat') {
      const every = el.every.value;
      const repeat = { every, time: el.time.value || '09:00' };
      if (every === 'week') {
        repeat.weekdays = [...el.weekdays.querySelectorAll('[aria-pressed="true"]')].map((b) => Number(b.dataset.wd));
        if (!repeat.weekdays.length) throw new Error('요일을 하나 이상 골라 주세요');
      }
      if (every === 'month' || every === 'year') repeat.day = Number(el.day.value);
      if (every === 'year') repeat.month = Number(el.month.value);
      return { ...base, repeat };
    }
    return { ...base, startup: el.form.querySelector('input[name="startup"]:checked').value };
  }

  el.kinds.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (b) setKind(b.dataset.kind);
  });
  el.presets.addEventListener('click', (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    el.timerMin.value = b.dataset.min;
    for (const x of el.presets.children) x.setAttribute('aria-pressed', String(x === b));
  });
  el.timerMin.addEventListener('input', () => {
    for (const x of el.presets.children) x.setAttribute('aria-pressed', String(x.dataset.min === el.timerMin.value));
  });
  el.every.addEventListener('change', syncRepeat);
  el.weekdays.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wd]');
    if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });
  for (const input of [el.month, el.day]) input.addEventListener('input', () => (input.dataset.touched = '1'));

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let reminder;
    try {
      reminder = build();
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    await save([...reminders, reminder]);
    setStatus(`알림을 추가했어요 · ${describeReminder(reminders.at(-1) ?? reminder)}`);
  });

  // ---------- 패널 열고 닫기 ----------

  function toggle(force) {
    const open = force ?? el.panel.hidden;
    el.panel.hidden = !open;
    onToggle?.(open);
    if (open) {
      render();
      el.panel.querySelector('[aria-checked="true"]')?.focus();
    }
  }
  el.btn.addEventListener('click', () => toggle());
  $('reminder-close').addEventListener('click', () => toggle(false));

  // 목록이 1분마다 "다음 알림" 문구를 새로 계산
  setInterval(() => !el.panel.hidden && render(), 60_000);

  return {
    set(list) {
      reminders = list ?? [];
      render();
    },
    toggle,
    get open() {
      return !el.panel.hidden;
    },
  };
}
