// 일정 탭 달력에서 바로 일정 만들기 (PC·휴대폰 같음) — 삼성 캘린더처럼 한 화면에서:
//   이름 → 하루 종일 토글 · 시작 날짜/시각 → 종료 날짜/시각 → 미리 알림 토글(켜면 칩 펼침) → 넣을 메모 › → [일정 저장]
import { DEFAULT_ALERTS, pendingAlerts, fallbackAlert, alertLabel, describeAlerts } from './core/reminders.js';
import { toLocalIso, relativeDay, koFullDate, koClock, startOfDay } from './core/time.js';
import { remembered, remember } from './event-editor.js';
import { alertPicker } from './alert-picker.js';
import { timePicker } from './date-picker.js';
import { icon } from './icons.js';
import { UI } from './core/ui-text.js';

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
 * 메모 창의 📅 도 같은 창 — memo 를 주면 그 메모에 넣는다 (넣을 메모 고르기는 숨김)
 * @param {{ day: Date, start?: Date|null, allDay?: boolean, title?: string, memo?: { id: string, title: string }|null, search?: (q: string) => Promise<Array<{ id: string, title: string, color?: string, locked?: boolean }>> }} o
 * @returns {Promise<{ memoId: string|null, newTitle: string, reminder: object } | null>}
 */
export function openQuickEvent({ day, start: initStart = null, allDay: initAllDay = false, title: initTitle = '', memo = null, search = async () => [] }) {
  return new Promise((resolve) => {
    let start = initStart ? new Date(initStart) : defaultStart(day);
    let end = new Date(start.getTime() + 3600_000);
    let allDay = Boolean(initAllDay);
    let activeSide = 'start'; // 'start' | 'end' — 시각 칩·선택기가 바꾸는 쪽
    let alerts = null;
    let initializing = true;
    const picked = { timed: new Set(remembered('timed')), allDay: new Set(remembered('allDay')) };
    const kind = () => (allDay ? 'allDay' : 'timed');
    const startAt = () => (allDay ? startOfDay(start) : start);
    const endAt = () => (allDay ? startOfDay(end) : end);
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hhmmOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const dialog = el('dialog', { class: 'dialog event-dialog quick-event', 'aria-labelledby': 'qe-h' });
    const form = el('form', { method: 'dialog' });
    const head = el('div', { class: 'qe-head' });
    const heading = el('h2', { id: 'qe-h' }, '새 일정');
    const x = el('button', { type: 'button', class: 'icon-btn dialog-x', 'aria-label': '닫기' });
    x.append(icon('close'));
    head.append(heading, x);

    // 이름
    const name = el('input', { type: 'text', class: 'qe-name', maxlength: '80', autocomplete: 'off', placeholder: '무슨 일정이에요? (예: 치과, 회의)', 'aria-label': '일정 이름' });
    name.value = initTitle;
    if (memo) name.placeholder = `비우면 메모 제목 (${memo.title || '제목 없음'})`;

    // 하루 종일 토글 줄 + 시작 → 종료 (삼성 캘린더 방식)
    const allDayRow = el('label', { class: 'event-allday qe-allday' });
    const allDayLabel = el('span', { class: 'qe-allday-label' });
    allDayLabel.append(icon('calendar', 'qe-ico'), el('span', {}, '하루 종일'));
    const allDaySwitch = el('input', { type: 'checkbox', class: 'switch' });
    allDaySwitch.checked = allDay;
    allDayRow.append(allDayLabel, allDaySwitch);

    const range = el('div', { class: 'qe-range', role: 'group', 'aria-label': '기간' });
    const startSide = el('div', { class: 'qe-side qe-side-start' });
    const startTag = el('span', { class: 'qe-side-tag' }, '시작');
    const startDateWrap = el('label', { class: 'qe-date' });
    const startDateText = el('span', { class: 'qe-date-text' });
    const startDate = el('input', { type: 'date', class: 'qe-date-input', 'aria-label': '시작 날짜' });
    startDateWrap.append(startDateText, startDate);
    const startClock = el('button', { type: 'button', class: 'qe-clock', 'aria-label': '시작 시각', 'aria-pressed': 'true' });
    startSide.append(startTag, startDateWrap, startClock);

    const arrow = el('span', { class: 'qe-arrow', 'aria-hidden': 'true' }, '↓');

    const endSide = el('div', { class: 'qe-side qe-side-end' });
    const endTag = el('span', { class: 'qe-side-tag' }, '종료');
    const endDateWrap = el('label', { class: 'qe-date' });
    const endDateText = el('span', { class: 'qe-date-text' });
    const endDate = el('input', { type: 'date', class: 'qe-date-input', 'aria-label': '종료 날짜' });
    endDateWrap.append(endDateText, endDate);
    const endClock = el('button', { type: 'button', class: 'qe-clock', 'aria-label': '종료 시각', 'aria-pressed': 'false' });
    endSide.append(endTag, endDateWrap, endClock);

    range.append(startSide, arrow, endSide);

    const timeBox = el('div', { class: 'date-picker qe-time', 'aria-label': '시각' });
    const err = el('p', { class: 'event-none qe-err', role: 'status' });

    // 미리 알림: 오른쪽에 토글 스위치 — 켜면 알림 칩이 펼쳐지고, 끄면 접히며 '없음'
    const alertRow = el('label', { class: 'qe-row qe-alert-row' });
    const alertVal = el('b', { class: 'qe-row-value' });
    const alertSwitch = el('input', { type: 'checkbox', class: 'switch qe-alert-switch', 'aria-label': '미리 알림 켜기' });
    alertRow.append(icon('bell', 'qe-ico'), el('span', { class: 'qe-row-label' }, '미리 알림'), alertVal, alertSwitch);
    const alertPane = el('section', { class: 'qe-pane', 'data-step': 'alerts', hidden: '' });
    const chips = el('div', { class: 'chips event-alerts', role: 'group', 'aria-label': '미리 알림' });
    const hint = el('p', { class: 'event-none', role: 'status' });
    alertPane.append(el('p', { class: 'qe-pane-q' }, '언제 미리 알려 드릴까요? (여러 개 고를 수 있어요)'), chips, hint);

    const memoRow = el('button', { type: 'button', class: 'qe-row qe-memo-row', 'aria-expanded': 'false' });
    const memoPane = el('section', { class: 'qe-pane', 'data-step': 'memo', hidden: '' });
    const freshBox = el('div', { class: 'qe-fresh-box' });
    const fresh = el('button', { type: 'button', class: 'qe-memo qe-new', role: 'radio', 'aria-checked': 'true' });
    const freshBodyWrap = el('div', { class: 'qe-fresh-body-wrap' });
    const freshBody = el('textarea', {
      class: 'qe-fresh-body',
      placeholder: '새 메모에 넣을 본문 내용 (비워두면 제목만 저장돼요)',
      rows: '2',
      'aria-label': '새 메모 본문',
    });
    freshBodyWrap.append(freshBody);
    freshBox.append(fresh, freshBodyWrap);

    const find = el('input', { type: 'search', class: 'link-search qe-search', placeholder: '기존 메모 검색', 'aria-label': '일정을 넣을 메모 검색', autocomplete: 'off' });
    const results = el('div', { class: 'qe-memos', role: 'radiogroup', 'aria-label': '일정을 넣을 메모' });
    memoPane.append(el('p', { class: 'qe-pane-q' }, '일정은 메모와 함께 저장돼요. 어느 메모에 넣을까요?'), freshBox, find, results);

    const cancel = el('button', { type: 'button', class: 'btn' }, '취소');
    const save = el('button', { type: 'button', class: 'btn primary qe-save' }, '일정 저장');
    const footer = el('div', { class: 'flow-footer' });
    footer.append(cancel, save);
    const body = el('div', { class: 'qe-body' });
    body.append(name, allDayRow, range, timeBox, err, alertRow, alertPane, memoRow, memoPane);
    form.append(head, body, footer);
    dialog.append(form);

    const title = () => name.value.replace(/\s+/g, ' ').trim();
    let target = memo; // 넣을 메모 { id, title } — null 이면 새 메모
    memoRow.hidden = Boolean(memo);
    // 좁은 칸에도 다 보이게: "오늘 · 10/31 (토)" · "11월 3일 (화)" (해가 다르면 연도도).
    //   기본 메모 창처럼 더 좁으면 짧은 것("오늘 (토)" · "11/3 (화)")으로 바꿔 끝이 "…" 로 잘리지 않게 (base.css)
    const dayLabelText = (d) => {
      const rel = relativeDay(d);
      const wd = `(${'일월화수목금토'[d.getDay()]})`;
      const long = rel ? `${rel} · ${d.getMonth() + 1}/${d.getDate()} ${wd}` : koFullDate(d);
      const short = rel ? `${rel} ${wd}` : `${d.getMonth() + 1}/${d.getDate()} ${wd}`;
      const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
      return [span('qe-long', long), span('qe-short', short)];
    };

    function syncDates() {
      startDate.value = ymd(start);
      endDate.value = ymd(end);
      endDate.min = ymd(start);
    }

    function draw() {
      syncDates();
      startDateText.replaceChildren(...dayLabelText(start));
      endDateText.replaceChildren(...dayLabelText(end));
      startClock.textContent = koClock(start);
      endClock.textContent = koClock(end);
      startClock.hidden = allDay;
      endClock.hidden = allDay;
      startClock.setAttribute('aria-pressed', String(activeSide === 'start'));
      endClock.setAttribute('aria-pressed', String(activeSide === 'end'));
      timeBox.hidden = allDay;
      const set = [...picked[kind()]];
      const on = set.length > 0;
      alertSwitch.checked = on;
      alertPane.hidden = !on;
      alertVal.textContent = on ? describeAlerts({ kind: 'at', alerts: set, allDay }) : '없음';
      memoRow.replaceChildren(
        icon('note', 'qe-ico'),
        el('span', { class: 'qe-row-label' }, '저장할 메모'),
        el('b', { class: 'qe-row-value' }, target ? `"${target.title}"` : `새 메모 "${title() || '새 일정'}"`),
        el('span', { class: 'qe-chev', 'aria-hidden': 'true' }, '›'),
      );
    }

    let updatingClock = false;
    const clock = timePicker(timeBox, {
      compact: true,
      value: hhmmOf(start),
      onChange: (hhmm) => {
        if (initializing || updatingClock) return;
        const [h, m] = hhmm.split(':').map(Number);
        if (activeSide === 'start') {
          const span = Math.max(3600_000, end.getTime() - start.getTime());
          start = new Date(start.getFullYear(), start.getMonth(), start.getDate(), h, m);
          end = new Date(start.getTime() + span);
        } else {
          end = new Date(end.getFullYear(), end.getMonth(), end.getDate(), h, m);
          if (end <= start) end = new Date(start.getTime() + 3600_000);
        }
        err.textContent = '';
        draw();
        if (!alertPane.hidden) alerts?.render();
        showHint();
      },
    });

    function selectSide(side) {
      activeSide = side;
      updatingClock = true;
      clock.set(hhmmOf(side === 'start' ? start : end));
      updatingClock = false;
      draw();
    }
    startClock.addEventListener('click', () => selectSide('start'));
    endClock.addEventListener('click', () => selectSide('end'));

    startDate.addEventListener('change', () => {
      const [y, mo, d] = startDate.value.split('-').map(Number);
      if (!y) return;
      const span = Math.max(allDay ? 0 : 3600_000, end.getTime() - start.getTime());
      start = new Date(y, mo - 1, d, start.getHours(), start.getMinutes());
      if (end < start) end = new Date(start.getTime() + span);
      err.textContent = '';
      draw();
      if (!alertPane.hidden) alerts?.render();
      showHint();
    });
    endDate.addEventListener('change', () => {
      const [y, mo, d] = endDate.value.split('-').map(Number);
      if (!y) return;
      end = new Date(y, mo - 1, d, end.getHours(), end.getMinutes());
      if (allDay ? startOfDay(end) < startOfDay(start) : end <= start) {
        end = allDay ? new Date(start) : new Date(start.getTime() + 3600_000);
      }
      err.textContent = '';
      draw();
    });
    for (const [wrap, input] of [[startDateWrap, startDate], [endDateWrap, endDate]]) {
      const open = () => {
        try {
          input.showPicker?.();
        } catch {
          input.focus();
        }
      };
      wrap.addEventListener('click', open);
    }

    allDaySwitch.addEventListener('change', () => {
      allDay = allDaySwitch.checked;
      if (!allDay && end <= start) end = new Date(start.getTime() + 3600_000);
      err.textContent = '';
      draw();
      if (!alertPane.hidden) alerts?.render();
      showHint();
    });

    alertSwitch.addEventListener('change', () => {
      const set = picked[kind()];
      if (alertSwitch.checked) {
        if (!set.size) {
          const rem = remembered(kind());
          for (const v of rem.length ? rem : DEFAULT_ALERTS[kind()]) set.add(v);
        }
        alerts?.render();
      } else {
        set.clear();
      }
      showHint();
      draw();
    });

    memoRow.addEventListener('click', () => {
      const open = memoPane.hidden;
      memoPane.hidden = !open;
      memoRow.setAttribute('aria-expanded', String(open));
      if (open) listMemos();
    });

    name.addEventListener('input', () => {
      if (!target) draw();
      if (!memoPane.hidden && fresh.lastChild) fresh.lastChild.textContent = `새 메모 "${title() || '새 일정'}"`;
    });

    alerts = alertPicker(chips, {
      picked,
      kind,
      start: startAt,
      onChange: () => {
        showHint();
        draw();
      },
      onLimit: (t) => (hint.textContent = t),
    });

    function showHint() {
      const set = [...picked[kind()]];
      const live = pendingAlerts(set, startAt(), { allDay });
      const fb = pendingAlerts(set, startAt(), { fallback: fallbackAlert(allDay), allDay });
      hint.textContent = !set.length ? UI.calendarOnly : live.length ? '' : fb.length ? `고른 시각이 모두 지나 ${alertLabel(fb[0], allDay)}에 알려요` : '';
    }

    save.addEventListener('click', () => {
      const today = new Date();
      const s = startAt();
      const e = endAt();
      const lastMoment = allDay ? new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1) : e;
      if (lastMoment <= today) {
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
        fresh.setAttribute('aria-checked', String(!target));
        freshBodyWrap.hidden = Boolean(target);
        for (const r of results.querySelectorAll('[role="radio"]')) r.setAttribute('aria-checked', String(r === b));
        draw();
      };
      fresh.replaceChildren(el('i', { class: 'qe-plus', 'aria-hidden': 'true' }, '＋'), el('span', {}, `새 메모 "${title() || '새 일정'}"`));
      fresh.setAttribute('aria-checked', String(!target));
      freshBodyWrap.hidden = Boolean(target);
      fresh.onclick = () => pick(fresh, null);
      const rows = found.filter((m) => !m.locked).slice(0, 30).map((m) => {
        const b = el('button', { type: 'button', class: 'qe-memo', role: 'radio', 'aria-checked': String(target?.id === m.id) });
        b.dataset.color = m.color ?? '';
        b.append(el('i', { class: 'row-dot', 'aria-hidden': 'true' }), el('span', {}, m.title || '제목 없음'));
        b.addEventListener('click', () => pick(b, { id: m.id, title: m.title || '제목 없음' }));
        return b;
      });
      results.replaceChildren(...rows);
      if (!rows.length) results.append(el('p', { class: 'qe-none' }, find.value.trim() ? '찾는 메모가 없어요' : ''));
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
      const e = endAt();
      const chosen = pendingAlerts([...picked[kind()]], s, { fallback: fallbackAlert(allDay), allDay });
      remember(kind(), [...picked[kind()]].sort((a, b) => b - a));
      const reminder = { kind: 'at', action: 'notify', enabled: true, created: toLocalIso(new Date()), at: toLocalIso(s), alerts: chosen };
      if (e > s) reminder.end = toLocalIso(e);
      if (allDay) reminder.allDay = true;
      if (title()) reminder.title = title();
      const memoBodyText = !memoId && freshBody.value.trim() ? `# ${title() || '새 일정'}\n\n${freshBody.value.trim()}\n` : null;
      close({ memoId, newTitle: title() || '새 일정', reminder, memoBody: memoBodyText });
    }
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    form.addEventListener('submit', (e) => e.preventDefault());

    document.body.append(dialog);
    initializing = false;
    draw();
    if (!alertPane.hidden) {
      alerts?.render();
      showHint();
    }
    dialog.showModal();
    name.focus({ preventScroll: true }); // 이름 칸부터 보이게 (예전에는 미리 알림 '추가' 로 내려 가 낮은 창에서 이름 · 날짜가 가려졌다)
  });
}
