// 메모 창의 "일정과 알림" 패널 — 목록(켜기/끄기·삭제)과 새로 만들기
//   일정 · 반복 일정: 이름 + 미리 알림(구글 캘린더처럼 여러 개, 정시에 울리는 게 아니라 미리) · 타이머 · 앱 열 때
import { icon } from './icons.js';
import { describeReminder, describeAlerts, nextLabel, isDone, isEvent, isLive, isPastEvent, reenable, pendingAlerts, fallbackAlert, ALERT_PRESETS, alertLabel } from './core/reminders.js';
import { remembered, remember } from './event-editor.js';
import { toLocalIso } from './core/time.js';
import { dateTimePicker, timePicker } from './date-picker.js';

const $ = (id) => document.getElementById(id);
const KIND_ICON = { timer: 'timer', at: 'calendar', repeat: 'repeat', startup: 'power' };

/**
 * @param {{ api: object, memoId: string, setStatus: (text: string, isError?: boolean) => void, onToggle?: (open: boolean) => void }} options
 */
export function setupReminderPanel({ api, memoId, setStatus, onToggle, onChange }) {
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
    title: $('rem-title'),
    titleRow: $('rem-title-row'),
    alertsWrap: $('rem-alerts-wrap'),
    allDay: $('rem-allday'),
    allDayRow: $('rem-allday-row'),
    alerts: $('rem-alerts'),
    submit: $('rem-submit'),
  };
  let reminders = [];
  let kind = 'at';
  // 미리 알림 고른 것 (시각 있는 일정 · 하루 종일 따로) — 처음엔 지난번에 고른 것
  const picked = { timed: new Set(remembered('timed')), allDay: new Set(remembered('allDay')) };
  const alertKind = () => (kind === 'at' && el.allDay.checked ? 'allDay' : 'timed');
  /** 지금 고른 날짜의 시작 (한 번짜리 일정만, 반복·잘못된 값이면 null) — 이미 지난 미리 알림을 가리는 데 */
  function chosenStart() {
    if (kind !== 'at') return null;
    const at = new Date(el.atInput.value);
    if (Number.isNaN(at.getTime())) return null;
    return el.allDay.checked ? new Date(at.getFullYear(), at.getMonth(), at.getDate()) : at;
  }
  function renderAlerts() {
    const k = alertKind();
    const start = chosenStart();
    const live = start ? new Set(pendingAlerts(ALERT_PRESETS[k], start, { allDay: k === 'allDay' })) : null;
    el.alerts.replaceChildren(...ALERT_PRESETS[k].map((offset) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.alert = String(offset);
      b.textContent = alertLabel(offset, k === 'allDay');
      const past = live ? !live.has(offset) : false;
      b.setAttribute('aria-pressed', String(picked[k].has(offset) && !past));
      if (past) {
        b.disabled = true;
        b.title = '이미 지난 시각이에요';
      }
      b.addEventListener('click', () => {
        if (picked[k].has(offset)) picked[k].delete(offset);
        else picked[k].add(offset);
        renderAlerts();
      });
      return b;
    }));
  }
  el.allDay.addEventListener('change', renderAlerts);
  el.atInput.addEventListener('input', renderAlerts);
  // 날짜는 달력, 시각은 칩·목록 (휴대폰 기본 다이얼 대신) — 고른 값은 위 입력칸에 그대로
  const atPicker = dateTimePicker($('at-picker'), { input: el.atInput });
  timePicker($('rep-time-picker'), { value: el.time.value, onChange: (hhmm) => (el.time.value = hhmm) });
  let atChosen = false;
  $('at-picker').addEventListener('click', () => (atChosen = true));
  $('at-picker').addEventListener('change', () => (atChosen = true));

  // ---------- 목록 ----------

  function render() {
    // 일정 탭 숫자와 같은 규칙: 앞으로 울릴 것이 있는 알림만 (알림 없는 일정·지난 일정은 세지 않음)
    const now = new Date();
    const enabled = reminders.filter((r) => isLive(r, now)).length;
    el.count.textContent = enabled ? String(enabled) : '';
    el.btn.classList.toggle('has-links', enabled > 0);
    el.btn.title = enabled ? `일정과 알림 ${enabled}개 (Ctrl+Shift+A)` : '일정과 알림 (Ctrl+Shift+A)';
    el.list.replaceChildren(...reminders.map(renderItem));
  }

  function renderItem(r) {
    const li = document.createElement('li');
    // 미리 알림을 다 보낸 한 번짜리 일정은 일정이 지날 때까지는 "끝" 이 아니다 (꺼진 것처럼 흐리게 하지 않음)
    const sentAll = r.enabled && r.kind === 'at' && Boolean(r.last) && !isPastEvent(r) && !nextLabel(r);
    li.className = `rem-item${r.enabled && !(isPastEvent(r) && !nextLabel(r)) ? '' : ' off'}`;
    li.dataset.id = r.id;
    li.append(icon(KIND_ICON[r.kind], 'rem-kind-icon'));

    const text = document.createElement('div');
    text.className = 'rem-text';
    const title = document.createElement('div');
    title.className = 'rem-title';
    title.textContent = isEvent(r) && r.title ? `${r.title}, ${describeReminder(r)}` : describeReminder(r);
    const sub = document.createElement('div');
    sub.className = 'rem-sub';
    const next = nextLabel(r);
    const state = sentAll ? '알림을 모두 보냈어요' : isDone(r) || (isPastEvent(r) && !next) ? '끝났어요' : !r.enabled ? '꺼져 있어요' : r.kind === 'startup' ? '' : next ? `다음 알림 ${next}` : '';
    const alerts = isEvent(r) ? `알림 ${describeAlerts(r)}` : '';
    sub.textContent = [alerts, state, r.action === 'open' ? '메모 바로 열기' : '알림으로 받기'].filter(Boolean).join(', ');
    text.append(title, sub);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.checked = r.enabled;
    toggle.title = r.enabled ? '끄기' : '켜기';
    toggle.setAttribute('aria-label', `${title.textContent} ${r.enabled ? '끄기' : '켜기'}`);
    toggle.addEventListener('change', () => {
      // 끝난 한 번짜리 알림을 다시 켜면 처음부터, 중간에 끈 것은 이미 울린 알림을 다시 울리지 않게
      const next = toggle.checked ? reenable(r) : { ...r, enabled: false };
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
      onChange?.(reminders);
      return true;
    } catch (err) {
      console.error(err);
      setStatus('알림을 저장하지 못했어요. 다시 시도해 주세요.', true);
      return false;
    }
  }

  // ---------- 새 알림 ----------

  function setKind(next) {
    kind = next;
    for (const b of el.kinds.querySelectorAll('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    for (const pane of el.form.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== kind;
    const event = kind === 'at' || kind === 'repeat';
    el.titleRow.hidden = !event;
    el.alertsWrap.hidden = !event;
    el.allDayRow.hidden = kind !== 'at';
    el.submit.textContent = event ? '일정 추가' : kind === 'timer' ? '타이머 추가' : '알림 추가';
    if (kind === 'at' && !atChosen) {
      // 처음엔 한 시간 뒤 정각
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(0, 0, 0);
      atPicker.set(d);
    }
    renderAlerts();
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
    const event = {};
    if (kind === 'at' || kind === 'repeat') {
      const t = el.title.value.replace(/\s+/g, ' ').trim();
      if (t) event.title = t;
      event.alerts = [...picked[alertKind()]].sort((a, b) => b - a);
    }
    if (kind === 'at') {
      let at = new Date(el.atInput.value);
      if (Number.isNaN(at.getTime())) throw new Error('날짜와 시각을 골라 주세요');
      if (el.allDay.checked) {
        at = new Date(at.getFullYear(), at.getMonth(), at.getDate());
        if (at < new Date(now.getFullYear(), now.getMonth(), now.getDate())) throw new Error('이미 지난 날이에요. 앞으로의 날을 골라 주세요');
        return withPending({ ...base, ...event, at: toLocalIso(at), allDay: true }, at, now);
      }
      if (at <= now) throw new Error('이미 지난 시각이에요. 앞으로의 시각을 골라 주세요');
      return withPending({ ...base, ...event, at: toLocalIso(at) }, at, now);
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
      return { ...base, ...event, repeat };
    }
    return { ...base, startup: el.form.querySelector('input[name="startup"]:checked').value };
  }

  // 이미 지난 미리 알림은 빼고(일정 창과 같은 규칙), 뺀 것은 저장 뒤에 알려 준다
  let dropped = [];
  let fellBack = false;
  function withPending(r, start, now) {
    const keep = pendingAlerts(r.alerts, start, { now, fallback: fallbackAlert(Boolean(r.allDay)), allDay: Boolean(r.allDay) });
    dropped = r.alerts.filter((o) => !keep.includes(o));
    fellBack = keep.length > 0 && !r.alerts.includes(keep[0]); // 고른 것이 모두 지나 정시(당일 오전 9시)로 바꿈
    return { ...r, alerts: keep };
  }
  function droppedNote(r) {
    if (!dropped.length) return '';
    const names = dropped.map((o) => alertLabel(o, Boolean(r.allDay))).join(', ');
    if (fellBack) return ` ${names} 알림은 이미 지난 시각이라 ${alertLabel(r.alerts[0], Boolean(r.allDay))}에 알려요.`;
    return r.alerts.length ? ` ${names} 알림은 이미 지난 시각이라 뺐어요.` : ` ${names} 알림은 이미 지난 시각이라, 알림 없이 달력에만 넣었어요.`;
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
    dropped = [];
    fellBack = false;
    try {
      reminder = build();
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    if (!(await save([...reminders, reminder]))) return;
    // 기본값으로는 고른 것을 그대로 기억 (이번 일정에 맞지 않아 빠진 "하루 전" 도 다음 일정엔 다시) — 만들기에 성공했을 때만
    if (isEvent(reminder)) remember(alertKind(), [...picked[alertKind()]].sort((a, b) => b - a));
    const saved = reminders.at(-1) ?? reminder;
    el.title.value = '';
    setStatus(isEvent(saved)
      ? `일정을 추가했어요: ${saved.title ? `${saved.title}, ` : ''}${describeReminder(saved)} (알림: ${describeAlerts(saved)}).${droppedNote(saved)}`
      : `알림을 추가했어요: ${describeReminder(saved)}`);
    renderAlerts();
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

  setKind('at'); // 처음엔 "일정" (한 시간 뒤 정각 · 지난번에 고른 미리 알림)

  // 목록이 1분마다 "다음 알림" 문구를 새로 계산
  setInterval(() => !el.panel.hidden && render(), 60_000);

  return {
    set(list) {
      reminders = list ?? [];
      render();
      onChange?.(reminders);
    },
    get list() {
      return reminders;
    },
    /**
     * 일정 추가 (글 속 날짜 → 일정 창에서): 이름 · 때 · 미리 알림
     * @param {{ title?: string, start: Date, allDay?: boolean, alerts: number[], repeat?: object|null }} e
     */
    async addEvent(e) {
      const now = new Date();
      const base = { action: 'notify', enabled: true, created: toLocalIso(now), alerts: pendingAlerts(e.alerts ?? [], e.start, { repeat: Boolean(e.repeat), now, fallback: fallbackAlert(Boolean(e.allDay)), allDay: Boolean(e.allDay) }) };
      if (e.title) base.title = e.title;
      let reminder;
      if (e.repeat) {
        const r = { every: e.repeat.every, time: e.repeat.time };
        if (e.repeat.every === 'week') r.weekdays = e.repeat.weekdays;
        if (e.repeat.every === 'month' || e.repeat.every === 'year') r.day = e.repeat.day;
        if (e.repeat.every === 'year') r.month = e.repeat.month;
        reminder = { ...base, kind: 'repeat', repeat: r };
      } else {
        reminder = { ...base, kind: 'at', at: toLocalIso(e.start), ...(e.allDay ? { allDay: true } : {}) };
      }
      if (!(await save([...reminders, reminder]))) return false;
      const saved = reminders.at(-1) ?? reminder;
      setStatus(`일정을 추가했어요: ${saved.title ? `${saved.title}, ` : ''}${describeReminder(saved)} (알림: ${describeAlerts(saved)})`);
      return true;
    },
    toggle,
    get open() {
      return !el.panel.hidden;
    },
  };
}
