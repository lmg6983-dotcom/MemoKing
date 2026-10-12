// 일정 탭 달력에서 바로 일정 만들기 (PC·휴대폰 같음) — 캘린더 앱처럼 날짜를 고르고 곧바로:
//   한 번에 한 가지만 묻는다: 무슨 일정 · 몇 시 → 미리 알림 → 어느 메모에 (일정 이름으로 새 메모 / 있는 메모 고르기)
//   마지막에 메모를 고르는 순간 저장된다.
import { pendingAlerts, fallbackAlert, alertLabel, describeAlerts } from './core/reminders.js';
import { toLocalIso, koClock, dayLabel } from './core/time.js';
import { remembered, remember } from './event-editor.js';
import { alertPicker } from './alert-picker.js';
import { timePicker } from './date-picker.js';

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

/** 고른 날의 처음 시각: 오늘이면 한 시간 뒤 정각, 다른 날이면 오전 9시 */
export function defaultStart(day, now = new Date()) {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0);
  if (d.toDateString() !== now.toDateString()) return d;
  const next = new Date(now.getTime() + 3600_000);
  next.setMinutes(0, 0, 0);
  return next.toDateString() === now.toDateString() ? next : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 55);
}

/**
 * @param {{ day: Date, search: (q: string) => Promise<Array<{ id: string, title: string, color?: string, locked?: boolean }>> }} o
 * @returns {Promise<{ memoId: string|null, newTitle: string, reminder: object } | null>}
 */
export function openQuickEvent({ day, search }) {
  return new Promise((resolve) => {
    let start = defaultStart(day);
    let allDay = false;
    const picked = { timed: new Set(remembered('timed')), allDay: new Set(remembered('allDay')) };
    const kind = () => (allDay ? 'allDay' : 'timed');
    const startAt = () => (allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : start);

    const dialog = el('dialog', { class: 'dialog event-dialog quick-event', 'aria-labelledby': 'qe-h' });
    const form = el('form', { method: 'dialog' });
    const heading = el('h2', { id: 'qe-h' }, `${dayLabel(day)}에 일정 추가`);
    const answers = el('ol', { class: 'rem-answers qe-answers' });

    // 1) 무슨 일정 · 몇 시
    const s1 = el('section', { class: 'rem-step', 'data-step': 'what' });
    const name = el('input', { type: 'text', class: 'qe-name', maxlength: '80', autocomplete: 'off', placeholder: '예: 치과, 회의', 'aria-label': '일정 이름' });
    const allDayRow = el('label', { class: 'event-allday' });
    const allDaySwitch = el('input', { type: 'checkbox', class: 'switch' });
    allDayRow.append(el('span', {}, '하루 종일'), allDaySwitch);
    const timeBox = el('div', { class: 'date-picker qe-time', 'aria-label': '시각' });
    const err1 = el('p', { class: 'event-none', role: 'status' });
    const next1 = el('button', { type: 'button', class: 'btn primary rem-next' }, '다음');
    s1.append(el('p', { class: 'rem-q' }, '어떤 일정이에요?'), name, allDayRow, timeBox, err1, next1);

    // 2) 미리 알림
    const s2 = el('section', { class: 'rem-step', 'data-step': 'alerts', hidden: '' });
    const chips = el('div', { class: 'chips event-alerts', role: 'group', 'aria-label': '미리 알림' });
    const hint = el('p', { class: 'event-none', role: 'status' });
    const next2 = el('button', { type: 'button', class: 'btn primary rem-next' }, '다음');
    const q2 = el('p', { class: 'rem-q' }, '언제 미리 알려 드릴까요?');
    q2.append(el('small', {}, '여러 개 고를 수 있어요'));
    s2.append(q2, chips, hint, next2);

    // 3) 어느 메모에
    const s3 = el('section', { class: 'rem-step', 'data-step': 'memo', hidden: '' });
    const fresh = el('button', { type: 'button', class: 'btn primary qe-new' });
    const find = el('input', { type: 'search', class: 'link-search qe-search', placeholder: '있는 메모에 넣기 — 메모 검색', 'aria-label': '일정을 넣을 메모 검색', autocomplete: 'off' });
    const results = el('ul', { class: 'qe-memos', role: 'list' });
    s3.append(el('p', { class: 'rem-q' }, '어느 메모에 넣을까요?'), fresh, find, results);

    const cancel = el('button', { type: 'button', class: 'btn' }, '취소');
    const actions = el('div', { class: 'dialog-actions' });
    actions.append(cancel);
    form.append(heading, answers, s1, s2, s3, actions);
    dialog.append(form);

    const steps = ['what', 'alerts', 'memo'];
    let step = 'what';
    const title = () => name.value.replace(/\s+/g, ' ').trim();
    const LABEL = { what: '일정', alerts: '미리 알림' };
    const answer = (s) => (s === 'what'
      ? `${title() || '이름 없음'}, ${allDay ? '하루 종일' : koClock(start)}`
      : describeAlerts({ kind: 'at', alerts: [...picked[kind()]], allDay }));

    function goto(next) {
      step = next;
      for (const sec of form.querySelectorAll('[data-step]')) sec.hidden = sec.dataset.step !== step;
      answers.replaceChildren(...steps.slice(0, steps.indexOf(step)).map((s) => {
        const li = el('li');
        const b = el('button', { type: 'button', class: 'rem-answer', 'aria-label': `${LABEL[s]}: ${answer(s)}, 바꾸기` });
        b.append(el('span', {}, LABEL[s]), el('b', {}, answer(s)), el('small', {}, '바꾸기'));
        b.addEventListener('click', () => goto(s));
        li.append(b);
        return li;
      }));
      if (step === 'alerts') {
        alerts.render();
        showHint();
      }
      if (step === 'memo') {
        fresh.textContent = `＋ 새 메모 "${title() || '새 일정'}"`;
        listMemos();
      }
      const focus = step === 'what' ? name : step === 'memo' ? fresh : form.querySelector(`[data-step="${step}"] .rem-q`);
      if (focus?.matches('.rem-q')) focus.setAttribute('tabindex', '-1');
      focus?.focus({ preventScroll: true });
    }

    timePicker(timeBox, {
      value: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      onChange: (hhmm) => {
        const [h, m] = hhmm.split(':').map(Number);
        start = new Date(start.getFullYear(), start.getMonth(), start.getDate(), h, m);
      },
    });
    allDaySwitch.addEventListener('change', () => {
      allDay = allDaySwitch.checked;
      timeBox.hidden = allDay;
    });
    const alerts = alertPicker(chips, { picked, kind, start: startAt, onChange: () => showHint(), onLimit: (t) => (hint.textContent = t) });
    function showHint() {
      const set = [...picked[kind()]];
      const live = pendingAlerts(set, startAt(), { allDay });
      const fb = pendingAlerts(set, startAt(), { fallback: fallbackAlert(allDay), allDay });
      hint.textContent = !set.length ? '알림 없이 달력에만 보여요' : live.length ? '' : fb.length ? `고른 시각이 모두 지나 ${alertLabel(fb[0], allDay)}에 알려요` : '';
    }

    next1.addEventListener('click', () => {
      if (!allDay && start <= new Date()) {
        err1.textContent = '이미 지난 시각이에요. 앞으로의 시각을 골라 주세요';
        timeBox.querySelector('select')?.focus();
        return;
      }
      err1.textContent = '';
      goto('alerts');
    });
    next2.addEventListener('click', () => goto('memo'));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        next1.click();
      }
    });

    let seq = 0;
    async function listMemos() {
      const mine = ++seq;
      const found = await search(find.value.trim()).catch(() => []);
      if (mine !== seq) return;
      const rows = found.filter((m) => !m.locked).slice(0, 30).map((m) => {
        const li = el('li');
        const b = el('button', { type: 'button', class: 'qe-memo' });
        b.dataset.color = m.color ?? '';
        b.append(el('i', { class: 'row-dot', 'aria-hidden': 'true' }), el('span', {}, m.title || '제목 없음'));
        b.addEventListener('click', () => finish(m.id));
        li.append(b);
        return li;
      });
      results.replaceChildren(...rows);
      if (!rows.length) results.append(el('li', { class: 'qe-none' }, find.value.trim() ? '찾는 메모가 없어요' : '메모가 없어요'));
    }
    find.addEventListener('input', listMemos);
    fresh.addEventListener('click', () => finish(null));

    let done = false;
    function close(value) {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    }
    function finish(memoId) {
      const s = startAt();
      const chosen = pendingAlerts([...picked[kind()]], s, { fallback: fallbackAlert(allDay), allDay });
      remember(kind(), [...picked[kind()]].sort((a, b) => b - a));
      const reminder = { kind: 'at', action: 'notify', enabled: true, created: toLocalIso(new Date()), at: toLocalIso(s), alerts: chosen };
      if (allDay) reminder.allDay = true;
      if (title()) reminder.title = title();
      close({ memoId, newTitle: title() || '새 일정', reminder });
    }
    cancel.addEventListener('click', () => close(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    form.addEventListener('submit', (e) => e.preventDefault());

    document.body.append(dialog);
    dialog.showModal();
    goto('what');
  });
}
