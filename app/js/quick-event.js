// 일정 탭 달력에서 바로 일정 만들기 (PC·휴대폰 같음) — 캘린더 앱처럼 날짜를 고르고 곧바로:
//   한 번에 한 가지만 묻는다: 무슨 일정 · 몇 시 → 미리 알림 → 어느 메모에 (일정 이름으로 새 메모 / 있는 메모 고르기)
//   아래 막대는 메모 창 알림 패널과 같다: 왼쪽 취소·이전, 오른쪽 다음 → 마지막에 "새 메모로 만들기" / "○○에 넣기".
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

/** 새 일정의 처음 시각: 한 시간 뒤 정각 — 그때가 밤(오후 11시~오전 7시)이면 다음 오전 9시 (새벽 3시 일정이 기본이 되지 않게) */
export function defaultEventStart(now = new Date()) {
  const next = new Date(now.getTime() + 3600_000);
  next.setMinutes(0, 0, 0);
  if (next.getHours() >= 7 && next.getHours() < 23) return next;
  const nine = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0);
  if (now.getHours() >= 9) nine.setDate(nine.getDate() + 1);
  return nine;
}

/** 고른 날의 처음 시각: 다른 날이면 오전 9시, 오늘이면 한 시간 뒤 정각(새벽이면 오전 9시, 밤늦게면 오후 11시 55분) */
export function defaultStart(day, now = new Date()) {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0);
  if (d.toDateString() !== now.toDateString()) return d;
  const next = defaultEventStart(now);
  if (next.toDateString() === now.toDateString()) return next;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 55);
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
    s1.append(el('p', { class: 'rem-q' }, '어떤 일정이에요?'), name, allDayRow, timeBox, err1);

    // 2) 미리 알림
    const s2 = el('section', { class: 'rem-step', 'data-step': 'alerts', hidden: '' });
    const chips = el('div', { class: 'chips event-alerts', role: 'group', 'aria-label': '미리 알림' });
    const hint = el('p', { class: 'event-none', role: 'status' });
    const q2 = el('p', { class: 'rem-q' }, '언제 미리 알려 드릴까요?');
    q2.append(el('small', {}, '여러 개 고를 수 있어요'));
    s2.append(q2, chips, hint);

    // 3) 어느 메모에 — 고르고(처음엔 "새 메모") 아래 단추로 만든다
    const s3 = el('section', { class: 'rem-step', 'data-step': 'memo', hidden: '' });
    const find = el('input', { type: 'search', class: 'link-search qe-search', placeholder: '메모 검색', 'aria-label': '일정을 넣을 메모 검색', autocomplete: 'off' });
    const fresh = el('button', { type: 'button', class: 'qe-memo qe-new', role: 'radio', 'aria-checked': 'true' });
    const results = el('div', { class: 'qe-memos', role: 'radiogroup', 'aria-label': '일정을 넣을 메모' });
    s3.append(el('p', { class: 'rem-q' }, '어느 메모에 넣을까요?'), find, results);

    // 아래 막대: 왼쪽 취소·이전, 오른쪽 다음 → 마지막에 "새 메모로 만들기" / "○○에 넣기" (메모 창 알림 패널과 같은 자리)
    const progress = el('p', { class: 'flow-progress', 'aria-live': 'polite' });
    const back = el('button', { type: 'button', class: 'btn' }, '취소');
    const next = el('button', { type: 'button', class: 'btn primary' }, '다음');
    const footer = el('div', { class: 'flow-footer' });
    footer.append(back, next);
    form.append(heading, progress, answers, s1, s2, s3, footer);
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
      if (step === 'memo') listMemos();
      progress.textContent = `${steps.indexOf(step) + 1} / ${steps.length}`;
      back.textContent = step === 'what' ? '취소' : '이전';
      syncNext();
      const focus = step === 'what' ? name : step === 'memo' ? find : form.querySelector(`[data-step="${step}"] .rem-q`);
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

    let target = null; // 넣을 메모 { id, title } — null 이면 새 메모
    function syncNext() {
      next.textContent = step !== 'memo' ? '다음' : target ? `'${target.title}'에 넣기` : '새 메모로 만들기';
    }
    next.addEventListener('click', () => {
      if (step === 'what') {
        if (!allDay && start <= new Date()) {
          err1.textContent = '이미 지난 시각이에요. 앞으로의 시각을 골라 주세요';
          timeBox.querySelector('select')?.focus();
          return;
        }
        err1.textContent = '';
        goto('alerts');
      } else if (step === 'alerts') goto('memo');
      else finish(target?.id ?? null);
    });
    back.addEventListener('click', () => (step === 'what' ? close(null) : goto(steps[steps.indexOf(step) - 1])));
    form.addEventListener('keydown', (e) => {
      // Enter = 아래 오른쪽 단추 (직접 정하기 칸의 Enter 는 그 칸이 먼저 받는다)
      if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented || !e.target.matches('input[type="text"], input[type="search"]')) return;
      e.preventDefault();
      next.click();
    });

    let seq = 0;
    async function listMemos() {
      const mine = ++seq;
      const found = await search(find.value.trim()).catch(() => []);
      if (mine !== seq) return;
      const pick = (b, memo) => {
        target = memo;
        for (const x of results.querySelectorAll('[role="radio"]')) x.setAttribute('aria-checked', String(x === b));
        syncNext();
      };
      fresh.replaceChildren(el('i', { class: 'qe-plus', 'aria-hidden': 'true' }, '＋'), el('span', {}, `새 메모 "${title() || '새 일정'}"`));
      fresh.setAttribute('aria-checked', String(!target));
      fresh.onclick = () => pick(fresh, null);
      const rows = found.filter((m) => !m.locked).slice(0, 30).map((m) => {
        const b = el('button', { type: 'button', class: 'qe-memo', role: 'radio', 'aria-checked': String(target?.id === m.id) });
        b.dataset.color = m.color ?? '';
        b.append(el('i', { class: 'row-dot', 'aria-hidden': 'true' }), el('span', {}, m.title || '제목 없음'));
        b.addEventListener('click', () => pick(b, { id: m.id, title: m.title || '제목 없음' }));
        b.addEventListener('dblclick', () => finish(m.id)); // 두 번 누르면 바로
        return b;
      });
      results.replaceChildren(fresh, ...rows);
      if (!rows.length) results.append(el('p', { class: 'qe-none' }, find.value.trim() ? '찾는 메모가 없어요' : '메모가 없어요'));
    }
    find.addEventListener('input', listMemos);

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
