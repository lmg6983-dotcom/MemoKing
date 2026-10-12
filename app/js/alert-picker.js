// 미리 알림 고르기 (PC·휴대폰, 메모 창의 일정 만들기 · 일정 창 · 일정 탭에서 바로 만들기가 함께 씀)
//   자주 쓰는 시각 칩 + "직접 정하기" (몇 분·시간·일·주 전 / 하루 종일이면 며칠 전 몇 시) — 정한 시각은 칩으로 더해진다.
//   이미 지난 시각은 고를 수 없게 흐리게, 한 일정에 MAX_ALERTS 개까지.
import { ALERT_PRESETS, MAX_ALERTS, MAX_ALERT_MIN, alertLabel, pendingAlerts, validAlert } from './core/reminders.js';

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

const UNITS = [
  { value: 1, label: '분 전' },
  { value: 60, label: '시간 전' },
  { value: 1440, label: '일 전' },
  { value: 10080, label: '주 전' },
];
const DAYS_BEFORE = [0, 1, 2, 3, 4, 5, 6, 7, 14, 21, 28];

/**
 * @param {HTMLElement} box 칩을 넣을 자리 (class="chips" 권장)
 * @param {{
 *   picked: { timed: Set<number>, allDay: Set<number> },
 *   kind: () => 'timed'|'allDay',
 *   start?: () => Date|null,   이미 지난 미리 알림을 가리는 기준 (없으면 가리지 않음)
 *   repeat?: () => boolean,    반복 일정이면 지난 것도 다음 회차에 울리므로 가리지 않음
 *   onChange?: () => void,
 *   onLimit?: (text: string) => void,
 * }} o
 */
export function alertPicker(box, { picked, kind, start = () => null, repeat = () => false, onChange = () => {}, onLimit = () => {} }) {
  const custom = el('div', { class: 'alert-custom', hidden: '' });
  box.after(custom);
  let customOpen = false;

  function render() {
    const k = kind();
    const allDay = k === 'allDay';
    const set = picked[k];
    const s = start();
    const offsets = [...new Set([...ALERT_PRESETS[k], ...set])].sort((a, b) => a - b);
    const live = s && !repeat() ? new Set(pendingAlerts(offsets, s, { allDay })) : null;
    const chips = offsets.map((offset) => {
      const b = el('button', { type: 'button', 'data-alert': String(offset) }, alertLabel(offset, allDay));
      const past = live ? !live.has(offset) : false;
      b.setAttribute('aria-pressed', String(set.has(offset) && !past));
      if (!ALERT_PRESETS[k].includes(offset)) b.classList.add('custom');
      if (past) {
        b.disabled = true;
        b.title = '이미 지난 시각이에요';
      }
      b.addEventListener('click', () => {
        if (set.has(offset)) set.delete(offset);
        else if (set.size >= MAX_ALERTS) {
          onLimit(`미리 알림은 ${MAX_ALERTS}개까지 고를 수 있어요`);
          return;
        } else set.add(offset);
        render();
        onChange();
      });
      return b;
    });
    const more = el('button', { type: 'button', class: 'alert-more', 'aria-expanded': String(customOpen) }, customOpen ? '닫기' : '+ 직접 정하기');
    more.addEventListener('click', () => {
      customOpen = !customOpen;
      render();
      if (customOpen) custom.querySelector('input, select')?.focus();
    });
    box.replaceChildren(...chips, more);
    custom.hidden = !customOpen;
    if (customOpen && custom.dataset.kind !== k) drawCustom(k);
  }

  function drawCustom(k) {
    custom.dataset.kind = k;
    const add = el('button', { type: 'button', class: 'btn alert-add' }, '넣기');
    if (k === 'timed') {
      const n = el('input', { type: 'number', min: '1', max: '999', value: '15', inputmode: 'numeric', 'aria-label': '얼마나 전' });
      const unit = el('select', { 'aria-label': '단위' });
      for (const u of UNITS) unit.append(new Option(u.label, String(u.value)));
      custom.replaceChildren(n, unit, add);
      add.addEventListener('click', () => {
        const v = Math.round(Number(n.value)) * Number(unit.value);
        if (!(v >= 1)) return onLimit('몇 분 전인지 적어 주세요');
        if (v > MAX_ALERT_MIN) return onLimit('미리 알림은 4주 전까지 정할 수 있어요');
        pick(v, k);
      });
      n.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          add.click();
        }
      });
    } else {
      const days = el('select', { 'aria-label': '며칠 전' });
      for (const d of DAYS_BEFORE) days.append(new Option(d === 0 ? '당일' : `${d}일 전`, String(d)));
      days.value = '1';
      const hour = el('select', { 'aria-label': '시' });
      for (let i = 0; i < 24; i++) hour.append(new Option(`${i < 12 ? '오전' : '오후'} ${i % 12 || 12}시`, String(i)));
      hour.value = '9';
      const minute = el('select', { 'aria-label': '분' });
      for (let i = 0; i < 60; i += 10) minute.append(new Option(`${String(i).padStart(2, '0')}분`, String(i)));
      custom.replaceChildren(days, hour, minute, add);
      add.addEventListener('click', () => {
        const v = Number(days.value) * 1440 - (Number(hour.value) * 60 + Number(minute.value));
        if (!validAlert(v, true)) return onLimit('미리 알림은 4주 전까지 정할 수 있어요');
        pick(v, k);
      });
    }
  }

  function pick(v, k) {
    const set = picked[k];
    if (!set.has(v) && set.size >= MAX_ALERTS) return onLimit(`미리 알림은 ${MAX_ALERTS}개까지 고를 수 있어요`);
    set.add(v);
    customOpen = false;
    render();
    onChange();
    box.querySelector(`[data-alert="${v}"]`)?.focus();
  }

  render();
  return { render };
}
