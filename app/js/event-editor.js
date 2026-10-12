// 일정 추가·고치기 창 (PC·휴대폰 같음) — 구글 캘린더처럼: 일정 이름과 때를 보여 주고, "언제 미리 알릴지"는 사용자가 고른다.
//   미리 알림은 여러 개 (정시 · 10분 전 · 30분 전 · 1시간 전 · 하루 전 · 일주일 전 / 하루 종일이면 당일·전날·일주일 전 오전 9시)
//   아무것도 고르지 않으면 "알림 없음" — 달력에만 보인다. 고른 알림은 다음 일정의 기본값으로 기억한다.
import { DEFAULT_ALERTS, MAX_ALERTS, alertLabel, pendingAlerts, fallbackAlert, validAlert } from './core/reminders.js';
import { alertPicker } from './alert-picker.js';
import { koClock, dayLabel } from './core/time.js';

const KEY = 'memoking.eventAlerts';

export function remembered(kind) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')[kind];
    if (Array.isArray(v)) return v.filter((x) => validAlert(x, kind === 'allDay')).slice(0, MAX_ALERTS); // 직접 정한 시각도 기억
  } catch {
    // 기본값
  }
  return DEFAULT_ALERTS[kind];
}
export function remember(kind, alerts) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    all[kind] = alerts;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 이번만
  }
}

/** "10월 12일 (월) 오후 3:00" · 하루 종일이면 "10월 12일 (월) 하루 종일" */
export function eventWhen(start, allDay, now = new Date()) {
  return `${dayLabel(start, now)} ${allDay ? '하루 종일' : koClock(start)}`;
}

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

/**
 * @param {{ title: string, start: Date, allDay?: boolean, repeatLabel?: string|null, alerts?: number[]|null, heading?: string, saveLabel?: string }} o
 * @returns {Promise<{ title: string, allDay: boolean, start: Date, alerts: number[] } | null>}
 */
export function openEventEditor({ title = '', start, allDay = false, repeatLabel = null, alerts = null, heading = '일정 추가', saveLabel = '저장' }) {
  return new Promise((resolve) => {
    let isAllDay = Boolean(allDay);
    // 하루 종일로 바꾸면 그날 00:00, 되돌리면 원래 시각
    const timed = new Date(start);
    const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const picked = { timed: new Set(isAllDay ? remembered('timed') : alerts ?? remembered('timed')), allDay: new Set(isAllDay ? alerts ?? remembered('allDay') : remembered('allDay')) };

    const dialog = el('dialog', { class: 'dialog event-dialog', 'aria-labelledby': 'event-title-h' });
    const form = el('form', { method: 'dialog' });
    const nameWrap = el('label', { class: 'event-field' });
    const name = el('input', { type: 'text', id: 'event-name', maxlength: '80', autocomplete: 'off', placeholder: '일정 이름' });
    name.value = title;
    nameWrap.append(el('span', {}, '일정'), name);

    const when = el('p', { class: 'event-when', id: 'event-when' });
    const allDayRow = el('label', { class: 'event-allday' });
    const allDaySwitch = el('input', { type: 'checkbox', class: 'switch', id: 'event-allday' });
    allDaySwitch.checked = isAllDay;
    allDayRow.append(el('span', {}, '하루 종일'), allDaySwitch);

    const alertsLabel = el('p', { class: 'event-label', id: 'event-alerts-label' }, '알림');
    const chips = el('div', { class: 'chips event-alerts', role: 'group', 'aria-labelledby': 'event-alerts-label' });
    const none = el('p', { class: 'event-none', role: 'status' });

    const cancel = el('button', { type: 'button', class: 'btn' }, '취소');
    const save = el('button', { type: 'submit', class: 'btn primary', id: 'event-save' }, saveLabel);
    const actions = el('div', { class: 'dialog-actions' });
    actions.append(cancel, save);

    form.append(el('h2', { id: 'event-title-h' }, heading), nameWrap, when);
    if (repeatLabel) form.append(el('p', { class: 'event-repeat' }, `🔁 ${repeatLabel}`));
    else form.append(allDayRow);
    form.append(alertsLabel, chips, none, actions);
    dialog.append(form);

    const kind = () => (isAllDay ? 'allDay' : 'timed');
    const startAt = () => (isAllDay ? dayStart : timed);
    const alertBox = alertPicker(chips, {
      picked,
      kind,
      start: startAt,
      repeat: () => Boolean(repeatLabel),
      onChange: () => render(),
      onLimit: (text) => (none.textContent = text),
    });
    function render() {
      when.textContent = `📅 ${eventWhen(startAt(), isAllDay)}`;
      const set = picked[kind()];
      const active = pendingAlerts([...set], startAt(), { repeat: Boolean(repeatLabel), allDay: isAllDay });
      const fb = pendingAlerts([...set], startAt(), { repeat: Boolean(repeatLabel), fallback: fallbackAlert(isAllDay), allDay: isAllDay });
      none.textContent = active.length ? '' : fb.length ? `고른 알림 시각이 지나 ${alertLabel(fb[0], isAllDay)}에 알려요` : '알림 없이 달력에만 보여요';
    }
    allDaySwitch.addEventListener('change', () => {
      isAllDay = allDaySwitch.checked;
      alertBox.render();
      render();
    });

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const chosen = pendingAlerts([...picked[kind()]], startAt(), { repeat: Boolean(repeatLabel), fallback: fallbackAlert(isAllDay), allDay: isAllDay });
      // 기본값으로는 고른 것을 그대로 (이번 일정엔 이미 지나 빠진 "하루 전" 도 다음 일정엔 다시 고른 채로)
      remember(kind(), [...picked[kind()]].sort((a, b) => b - a));
      finish({ title: name.value.replace(/\s+/g, ' ').trim(), allDay: isAllDay, start: startAt(), alerts: chosen });
    });

    render();
    document.body.append(dialog);
    dialog.showModal();
    save.focus();
  });
}
