// 일정 탭 달력에서 바로 일정 만들기 (PC·휴대폰 같음) — 캘린더 앱처럼 한 화면에서:
//   이름 → 날짜 · 시각 → 미리 알림 › → 넣을 메모 › → [일정 저장]
//   알림 · 메모는 알맞은 값(지난번 알림 · 일정 이름으로 새 메모)이 골라져 있어 그대로면 이름만 쓰고 저장 — 바꿀 때만 그 줄을 펼친다
import { pendingAlerts, fallbackAlert, alertLabel, describeAlerts } from './core/reminders.js';
import { toLocalIso, relativeDay, koFullDate } from './core/time.js';
import { remembered, remember } from './event-editor.js';
import { alertPicker } from './alert-picker.js';
import { timePicker } from './date-picker.js';
import { icon } from './icons.js';

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
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const dialog = el('dialog', { class: 'dialog event-dialog quick-event', 'aria-labelledby': 'qe-h' });
    const form = el('form', { method: 'dialog' });
    const head = el('div', { class: 'qe-head' });
    const heading = el('h2', { id: 'qe-h' }, '새 일정');
    const x = el('button', { type: 'button', class: 'icon-btn dialog-x', 'aria-label': '닫기' });
    x.append(icon('close'));
    head.append(heading, x);

    // 이름
    const name = el('input', { type: 'text', class: 'qe-name', maxlength: '80', autocomplete: 'off', placeholder: '무슨 일정이에요? (예: 치과, 회의)', 'aria-label': '일정 이름' });

    // 날짜 (누르면 달력) · 하루 종일
    const when = el('div', { class: 'qe-when' });
    const dateWrap = el('label', { class: 'qe-date' });
    const dateText = el('span', { class: 'qe-date-text' });
    const date = el('input', { type: 'date', class: 'qe-date-input', 'aria-label': '날짜' });
    date.value = ymd(start);
    date.min = ymd(new Date());
    dateWrap.append(icon('calendar', 'qe-ico'), dateText, date);
    const allDayRow = el('label', { class: 'event-allday qe-allday' });
    const allDaySwitch = el('input', { type: 'checkbox', class: 'switch' });
    allDayRow.append(el('span', {}, '하루 종일'), allDaySwitch);
    when.append(dateWrap, allDayRow);
    const timeBox = el('div', { class: 'date-picker qe-time', 'aria-label': '시각' });
    const err = el('p', { class: 'event-none qe-err', role: 'status' });

    // 미리 알림 · 넣을 메모: 한 줄 요약 (누르면 펼침)
    const alertRow = el('button', { type: 'button', class: 'qe-row qe-alert-row', 'aria-expanded': 'false' });
    const alertPane = el('section', { class: 'qe-pane', 'data-step': 'alerts', hidden: '' });
    const chips = el('div', { class: 'chips event-alerts', role: 'group', 'aria-label': '미리 알림' });
    const hint = el('p', { class: 'event-none', role: 'status' });
    alertPane.append(el('p', { class: 'qe-pane-q' }, '언제 미리 알려 드릴까요? (여러 개 고를 수 있어요)'), chips, hint);

    const memoRow = el('button', { type: 'button', class: 'qe-row qe-memo-row', 'aria-expanded': 'false' });
    const memoPane = el('section', { class: 'qe-pane', 'data-step': 'memo', hidden: '' });
    const find = el('input', { type: 'search', class: 'link-search qe-search', placeholder: '메모 검색', 'aria-label': '일정을 넣을 메모 검색', autocomplete: 'off' });
    const fresh = el('button', { type: 'button', class: 'qe-memo qe-new', role: 'radio', 'aria-checked': 'true' });
    const results = el('div', { class: 'qe-memos', role: 'radiogroup', 'aria-label': '일정을 넣을 메모' });
    memoPane.append(el('p', { class: 'qe-pane-q' }, '일정은 메모와 함께 저장돼요. 어느 메모에 넣을까요?'), find, results);

    const cancel = el('button', { type: 'button', class: 'btn' }, '취소');
    const save = el('button', { type: 'button', class: 'btn primary qe-save' }, '일정 저장');
    const footer = el('div', { class: 'flow-footer' });
    footer.append(cancel, save);
    form.append(head, name, when, timeBox, err, alertRow, alertPane, memoRow, memoPane, footer);
    dialog.append(form);

    const title = () => name.value.replace(/\s+/g, ' ').trim();
    let target = null; // 넣을 메모 { id, title } — null 이면 새 메모

    function rowContent(row, ico, label, value) {
      row.replaceChildren(icon(ico, 'qe-ico'), el('span', { class: 'qe-row-label' }, label), el('b', { class: 'qe-row-value' }, value), el('span', { class: 'qe-chev', 'aria-hidden': 'true' }, '›'));
    }
    function draw() {
      const rel = relativeDay(start);
      dateText.textContent = rel ? `${rel}, ${koFullDate(start).replace(/ \((.)\)$/, ' $1')}` : koFullDate(start); // "오늘, 10월 17일 토" — 한 줄에
      timeBox.hidden = allDay;
      const set = [...picked[kind()]];
      rowContent(alertRow, 'bell', '미리 알림', set.length ? describeAlerts({ kind: 'at', alerts: set, allDay }) : '없음');
      rowContent(memoRow, 'note', '저장할 메모', target ? `"${target.title}"` : `새 메모 "${title() || '새 일정'}"`);
    }
    function toggle(row, pane, open = pane.hidden) {
      pane.hidden = !open;
      row.setAttribute('aria-expanded', String(open));
      if (open && pane === alertPane) {
        alerts.render();
        showHint();
      }
      if (open && pane === memoPane) listMemos();
    }
    alertRow.addEventListener('click', () => toggle(alertRow, alertPane));
    memoRow.addEventListener('click', () => toggle(memoRow, memoPane));

    timePicker(timeBox, {
      compact: true,
      value: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      onChange: (hhmm) => {
        const [h, m] = hhmm.split(':').map(Number);
        start = new Date(start.getFullYear(), start.getMonth(), start.getDate(), h, m);
        err.textContent = '';
        showHint();
      },
    });
    date.addEventListener('change', () => {
      const [y, mo, d] = date.value.split('-').map(Number);
      if (!y) return;
      start = new Date(y, mo - 1, d, start.getHours(), start.getMinutes());
      err.textContent = '';
      draw();
      showHint();
    });
    // 날짜 칸 어디를 눌러도 달력 (지원하는 곳에서)
    dateWrap.addEventListener('click', (e) => {
      if (e.target === date) return;
      try {
        date.showPicker?.();
      } catch {
        date.focus();
      }
    });
    allDaySwitch.addEventListener('change', () => {
      allDay = allDaySwitch.checked;
      err.textContent = '';
      draw();
      if (!alertPane.hidden) alerts.render();
      showHint();
    });
    name.addEventListener('input', () => {
      if (!target) draw();
      if (!memoPane.hidden) fresh.lastChild.textContent = `새 메모 "${title() || '새 일정'}"`;
    });
    const alerts = alertPicker(chips, { picked, kind, start: startAt, onChange: () => { showHint(); draw(); }, onLimit: (t) => (hint.textContent = t) });
    function showHint() {
      const set = [...picked[kind()]];
      const live = pendingAlerts(set, startAt(), { allDay });
      const fb = pendingAlerts(set, startAt(), { fallback: fallbackAlert(allDay), allDay });
      hint.textContent = !set.length ? '알림 없이 달력에만 보여요' : live.length ? '' : fb.length ? `고른 시각이 모두 지나 ${alertLabel(fb[0], allDay)}에 알려요` : '';
    }

    save.addEventListener('click', () => {
      const today = new Date();
      const past = allDay ? startAt() < new Date(today.getFullYear(), today.getMonth(), today.getDate()) : start <= today;
      if (past) {
        err.textContent = '이미 지난 때예요. 날짜나 시각을 앞으로 바꿔 주세요';
        return;
      }
      finish(target?.id ?? null);
    });
    cancel.addEventListener('click', () => close(null));
    x.addEventListener('click', () => close(null));
    form.addEventListener('keydown', (e) => {
      // 이름 칸에서 Enter = 저장 (메모 검색 칸의 Enter 는 그대로)
      if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented || e.target !== name) return;
      e.preventDefault();
      save.click();
    });

    let seq = 0;
    async function listMemos() {
      const mine = ++seq;
      const found = await search(find.value.trim()).catch(() => []);
      if (mine !== seq) return;
      const pick = (b, memo) => {
        target = memo;
        for (const r of results.querySelectorAll('[role="radio"]')) r.setAttribute('aria-checked', String(r === b));
        draw();
      };
      fresh.replaceChildren(el('i', { class: 'qe-plus', 'aria-hidden': 'true' }, '＋'), el('span', {}, `새 메모 "${title() || '새 일정'}"`));
      fresh.setAttribute('aria-checked', String(!target));
      fresh.onclick = () => pick(fresh, null);
      const rows = found.filter((m) => !m.locked).slice(0, 30).map((m) => {
        const b = el('button', { type: 'button', class: 'qe-memo', role: 'radio', 'aria-checked': String(target?.id === m.id) });
        b.dataset.color = m.color ?? '';
        b.append(el('i', { class: 'row-dot', 'aria-hidden': 'true' }), el('span', {}, m.title || '제목 없음'));
        b.addEventListener('click', () => pick(b, { id: m.id, title: m.title || '제목 없음' }));
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
    draw();
    dialog.showModal();
    name.focus({ preventScroll: true });
  });
}
