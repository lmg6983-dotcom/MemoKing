// 메모 창의 "일정과 알림" 패널 — 목록(켜기/끄기·삭제)과 새로 만들기
//   새로 만들기는 토스처럼 한 번에 한 가지만 묻는다: 무엇을 → 언제 → (일정이면) 미리 알림 → 이름·확인.
//   답한 단계는 위에 한 줄로 접히고, 그 줄을 누르면 그 단계로 돌아가 고친다.
//   일정 · 반복 일정: 이름 + 미리 알림(구글 캘린더처럼 여러 개, 직접 정한 시각도) · 타이머 · 앱 열 때
import { icon } from './icons.js';
import { describeReminder, describeAlerts, nextLabel, isDone, isEvent, isLive, isPastEvent, reenable, pendingAlerts, fallbackAlert, alertLabel } from './core/reminders.js';
import { remembered, remember, eventWhen } from './event-editor.js';
import { alertPicker } from './alert-picker.js';
import { defaultEventStart } from './quick-event.js';
import { toLocalIso } from './core/time.js';
import { dateTimePicker, timePicker } from './date-picker.js';
import { UI } from './core/ui-text.js';

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
    allDay: $('rem-allday'),
    allDayRow: $('rem-allday-row'),
    alerts: $('rem-alerts'),
    submit: $('rem-next'), // 아래 막대 오른쪽: 다음 → 마지막에 "일정 추가"
    start: $('rem-start'),
    steps: $('rem-steps'),
    answers: $('rem-answers'),
    whenQ: $('rem-when-q'),
    hint: $('rem-alerts-hint'),
    back: $('rem-back'), // 아래 막대 왼쪽: 첫 질문에서는 취소, 그다음은 이전
    progress: $('rem-progress'),
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
  const alertBox = alertPicker(el.alerts, {
    picked,
    kind: alertKind,
    start: chosenStart,
    repeat: () => kind === 'repeat',
    onChange: () => (el.hint.textContent = alertHint()),
    onLimit: (text) => (el.hint.textContent = text),
  });
  /** 고른 미리 알림이 이번 일정엔 모두 지났을 때 안내 */
  function alertHint() {
    const start = chosenStart();
    const set = [...picked[alertKind()]];
    if (!set.length) return UI.calendarOnly;
    if (!start) return '';
    const allDay = alertKind() === 'allDay';
    if (pendingAlerts(set, start, { allDay }).length) return '';
    const fb = pendingAlerts(set, start, { fallback: fallbackAlert(allDay), allDay });
    return fb.length ? `고른 시각이 모두 지나 ${alertLabel(fb[0], allDay)}에 알려요` : '';
  }
  function renderAlerts() {
    alertBox.render();
    el.hint.textContent = alertHint();
  }
  el.allDay.addEventListener('change', () => {
    $('at-picker').classList.toggle('all-day', el.allDay.checked); // 하루 종일이면 시각 고르기는 접는다
    renderAlerts();
  });
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
    const next = nextLabel(r);
    const over = isPastEvent(r) && !next; // 지난 한 번짜리 일정 (켜져 있어도 끝)
    const sentAll = r.enabled && r.kind === 'at' && Boolean(r.last) && !isPastEvent(r) && !next;
    li.className = `rem-item${r.enabled && !over ? '' : ' off'}`;
    li.dataset.id = r.id;
    li.append(icon(KIND_ICON[r.kind], 'rem-kind-icon'));

    const text = document.createElement('div');
    text.className = 'rem-text';
    const title = document.createElement('div');
    title.className = 'rem-title';
    title.textContent = isEvent(r) && r.title ? `${r.title}, ${describeReminder(r)}` : describeReminder(r);
    const sub = document.createElement('div');
    sub.className = 'rem-sub';
    const state = sentAll ? '알림을 모두 보냈어요' : isDone(r) || over ? '끝났어요' : !r.enabled ? UI.off : r.kind === 'startup' ? '' : next ? `다음 알림 ${next}` : '';
    const alerts = isEvent(r) ? `알림 ${describeAlerts(r)}` : '';
    sub.textContent = [alerts, state, r.action === 'open' ? '메모 바로 열기' : '알림으로 받기'].filter(Boolean).join(', ');
    text.append(title, sub);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.checked = r.enabled && !over;
    toggle.title = r.enabled ? '끄기' : '켜기';
    toggle.setAttribute('aria-label', `${title.textContent} ${r.enabled ? '끄기' : '켜기'}`);
    if (over) {
      // 지난 한 번짜리 일정은 다시 켤 수 없다 (켜도 울릴 때가 없음) — 눌러도 아무 일 없는 스위치로 두지 않게
      toggle.disabled = true;
      toggle.title = '지난 일정이에요';
      toggle.setAttribute('aria-label', `${title.textContent} 지난 일정`);
    }
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

  // ---------- 단계 ----------
  const KIND_NAME = { at: '일정', repeat: '반복 일정', timer: '타이머', startup: '앱 열 때' };
  const WHEN_Q = { at: '언제예요?', repeat: '얼마나 자주, 몇 시에요?', timer: '몇 분 뒤에 알려 드릴까요?', startup: '언제 알려 드릴까요?' };
  const STARTUP_NAME = { every: '열 때마다', daily: '하루 한 번', once: '다음에 열 때 한 번' };
  let step = 'kind';
  let submitLabel = '일정 추가';
  const stepsOf = () => (kind === 'at' || kind === 'repeat' ? ['kind', 'when', 'alerts', 'finish'] : ['kind', 'when', 'finish']);

  /** 답한 단계 한 줄: "일정" · "10월 13일 (화) 오후 3:00" · "10분 전, 하루 전" */
  function answerOf(s) {
    if (s === 'kind') return KIND_NAME[kind];
    if (s === 'when') {
      if (kind === 'at') {
        const start = chosenStart();
        return start ? eventWhen(start, el.allDay.checked) : '';
      }
      if (kind === 'timer') return `${Math.round(Number(el.timerMin.value)) || 0}분 뒤`;
      if (kind === 'startup') return STARTUP_NAME[el.form.querySelector('input[name="startup"]:checked').value];
      try {
        return describeReminder(buildReminder());
      } catch {
        return '';
      }
    }
    if (s === 'alerts') return describeAlerts({ kind: 'at', alerts: [...picked[alertKind()]], allDay: alertKind() === 'allDay' });
    return '';
  }
  const STEP_LABEL = { kind: '만들 것', when: '언제', alerts: '미리 알림' };

  function goto(next, { focus = true } = {}) {
    step = next;
    const order = stepsOf();
    const at = order.indexOf(step);
    for (const sec of el.form.querySelectorAll('[data-step]')) sec.hidden = sec.dataset.step !== step;
    el.answers.replaceChildren(...order.slice(0, at).map((s) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rem-answer';
      b.dataset.goto = s;
      b.setAttribute('aria-label', `${STEP_LABEL[s]}: ${answerOf(s)}, 바꾸기`);
      const label = document.createElement('span');
      label.textContent = STEP_LABEL[s];
      const value = document.createElement('b');
      value.textContent = answerOf(s);
      const edit = document.createElement('small');
      edit.textContent = '바꾸기';
      b.append(label, value, edit);
      li.append(b);
      return li;
    }));
    if (step === 'alerts') renderAlerts();
    el.progress.textContent = `${at + 1} / ${order.length}`;
    el.back.textContent = at === 0 ? '취소' : '이전';
    el.submit.textContent = step === 'finish' ? submitLabel : '다음';
    el.panel.classList.toggle('creating', !el.steps.hidden);
    if (focus) {
      const sec = el.form.querySelector(`[data-step="${step}"]`);
      const target = step === 'kind' ? el.kinds.querySelector('[aria-checked="true"]')
        : step === 'finish' && !el.titleRow.hidden ? el.title
          : sec?.querySelector('.rem-q');
      if (target && !target.hasAttribute('tabindex') && target.matches('.rem-q')) target.setAttribute('tabindex', '-1');
      target?.focus({ preventScroll: true });
      sec?.scrollIntoView({ block: 'nearest' });
    }
  }

  function nextStep() {
    const order = stepsOf();
    if (step === 'when') {
      // 다음으로 가기 전에 지금 단계 값이 맞는지 (지난 시각 · 요일 없음 · 분 없음)
      try {
        buildReminder();
      } catch (err) {
        setStatus(err.message, true);
        return;
      }
    }
    goto(order[Math.min(order.length - 1, order.indexOf(step) + 1)]);
  }

  /** 처음으로 (목록에 알림이 있으면 "새로 만들기" 단추만, 없으면 바로 첫 질문) */
  function resetFlow() {
    const open = reminders.length === 0;
    el.start.hidden = open;
    el.steps.hidden = !open;
    el.title.value = '';
    goto('kind', { focus: false });
  }

  function setKind(next) {
    kind = next;
    for (const b of el.kinds.querySelectorAll('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    for (const pane of el.form.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== kind;
    const event = kind === 'at' || kind === 'repeat';
    el.titleRow.hidden = !event;
    el.allDayRow.hidden = kind !== 'at';
    el.whenQ.textContent = WHEN_Q[kind];
    submitLabel = event ? '일정 추가' : kind === 'timer' ? '타이머 추가' : '알림 추가';
    if (step === 'finish') el.submit.textContent = submitLabel;
    if (kind === 'at' && !atChosen) {
      atPicker.set(defaultEventStart());
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

  /** 새 알림과 (이미 지나 뺀 미리 알림이 있으면) 그 안내 — { reminder, note } */
  function build() {
    const out = buildReminder();
    return out.reminder ? out : { reminder: out, note: '' };
  }
  function buildReminder() {
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
      if (at <= now) throw new Error(UI.pastTime);
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
  function withPending(r, start, now) {
    const allDay = Boolean(r.allDay);
    const keep = pendingAlerts(r.alerts, start, { now, fallback: fallbackAlert(allDay), allDay });
    const dropped = r.alerts.filter((o) => !keep.includes(o));
    const fellBack = keep.length > 0 && !r.alerts.includes(keep[0]); // 고른 것이 모두 지나 정시(당일 오전 9시)로 바꿈
    let note = '';
    if (dropped.length) {
      const names = dropped.map((o) => alertLabel(o, allDay)).join(', ');
      if (fellBack) note = ` ${names} 알림은 이미 지난 시각이라 ${alertLabel(keep[0], allDay)}에 알려요.`;
      else note = keep.length ? ` ${names} 알림은 이미 지난 시각이라 뺐어요.` : ` ${names} 알림은 이미 지난 시각이라, 알림 없이 달력에만 넣었어요.`;
    }
    return { reminder: { ...r, alerts: keep }, note };
  }

  el.kinds.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    setKind(b.dataset.kind);
    // 마우스·손가락으로 고르면 바로 다음 질문 (화살표 키로 고를 때는 그 자리에)
    if (e.detail > 0) goto('when');
  });
  el.submit.addEventListener('click', () => (step === 'finish' ? el.form.requestSubmit() : nextStep()));
  el.form.addEventListener('click', (e) => {
    const back = e.target.closest('[data-goto]');
    if (back) goto(back.dataset.goto);
  });
  el.start.addEventListener('click', () => {
    el.start.hidden = true;
    el.steps.hidden = false;
    goto('kind'); // (만드는 동안 "아직 알림이 없어요" 는 숨김 — goto 가 creating 표시)
  });
  el.back.addEventListener('click', () => {
    const order = stepsOf();
    const at = order.indexOf(step);
    if (at > 0) return goto(order[at - 1]);
    resetFlow(); // 첫 질문에서는 그만두기
    el.panel.classList.toggle('creating', !el.steps.hidden);
    if (!el.start.hidden) el.start.focus();
  });
  // 이름 칸에서 Enter = 추가 (다른 단계 칸의 Enter 는 다음 단계로)
  el.kinds.addEventListener('keydown', (e) => {
    // 키보드: 화살표로 고르고 Enter(또는 Space)로 다음 질문
    const b = e.target.closest('[data-kind]');
    if (!b || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    setKind(b.dataset.kind);
    goto('when');
  });
  el.form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return;
    if (e.target.matches('input[type="number"], input[type="text"]')) {
      e.preventDefault();
      if (step === 'finish') el.form.requestSubmit();
      else nextStep();
    }
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
    let note = '';
    try {
      ({ reminder, note } = build());
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    if (!(await save([...reminders, reminder]))) return;
    // 기본값으로는 고른 것을 그대로 기억 (이번 일정에 맞지 않아 빠진 "하루 전" 도 다음 일정엔 다시) — 만들기에 성공했을 때만
    if (isEvent(reminder)) remember(alertKind(), [...picked[alertKind()]].sort((a, b) => b - a));
    const saved = reminders.at(-1) ?? reminder;
    resetFlow();
    setStatus(isEvent(saved)
      ? `일정을 추가했어요: ${saved.title ? `${saved.title}, ` : ''}${describeReminder(saved)} (알림: ${describeAlerts(saved)}).${note}`
      : `알림을 추가했어요: ${describeReminder(saved)}`);
  });

  // ---------- 패널 열고 닫기 ----------

  function toggle(force) {
    const open = force ?? el.panel.hidden;
    el.panel.hidden = !open;
    onToggle?.(open);
    if (open) {
      render();
      resetFlow();
      (el.start.hidden ? el.kinds.querySelector('[aria-checked="true"]') : el.start).focus();
    }
  }
  el.btn.addEventListener('click', () => toggle());
  $('reminder-close').addEventListener('click', () => toggle(false));

  setKind('at'); // 처음엔 "일정" (한 시간 뒤 정각 · 지난번에 고른 미리 알림)
  resetFlow();

  // 목록이 1분마다 "다음 알림" 문구를 새로 계산
  setInterval(() => !el.panel.hidden && render(), 60_000);

  return {
    set(list) {
      reminders = list ?? [];
      render();
      if (el.panel.hidden) resetFlow(); // 다른 메모로 바뀌면(휴대폰은 패널 하나를 같이 씀) 처음 질문부터 — 만드는 중이면 그대로
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
