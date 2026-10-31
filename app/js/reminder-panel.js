// 메모 창의 일정 (📅) 과 알림 (🔔) — 한 자리(패널)를 둘이 나눠 쓰되 내용은 따로
//   일정: 이 메모의 일정 목록 + "새 일정" → 일정 탭과 같은 창(quick-event.js) 으로 이 메모에 넣는다
//   알림: 구글 리마인더처럼 "무엇을 + 언제(+ 반복)" 하나의 할 일. 끝나면 동그라미를 눌러 완료.
//         언제는 빨리 고르기(1시간 뒤 · 오늘 저녁 · 내일 아침 · 월요일 아침) 또는 날짜 · 시각 고르기,
//         시간 대신 "메모킹을 열 때" 도 (킵의 시간 | 장소 처럼)
import { icon } from './icons.js';
import {
  describeReminder, describeAlerts, nextLabel, isDone, isEvent, isPastEvent, reenable, pendingAlerts, fallbackAlert,
  taskPresets, taskRepeatChoices, buildTask,
} from './core/reminders.js';
import { openQuickEvent } from './quick-event.js';
import { dayLabel, koClock, toLocalIso } from './core/time.js';
import { dateTimePicker } from './date-picker.js';
import { UI } from './core/ui-text.js';

const $ = (id) => document.getElementById(id);
const KIND_ICON = { timer: 'timer', at: 'calendar', repeat: 'repeat', startup: 'power' };
const STARTUP = [
  { id: 'every', label: '열 때마다' },
  { id: 'daily', label: '하루 한 번', sub: '그날 처음 열 때' },
  { id: 'once', label: '다음에 열 때 한 번만' },
];

function h(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** 이 메모에서 앞으로 남은 일정 (지난 한 번짜리 · 끈 것은 빼고) */
const upcomingEvent = (r) => isEvent(r) && r.enabled && !isPastEvent(r);
/** 아직 할 알림 (완료 · 끝난 것은 빼고) */
const openTask = (r) => !isEvent(r) && r.enabled && !isDone(r);
const whenText = (d, now = new Date()) => `${dayLabel(d, now)} ${koClock(d)}`;

/**
 * @param {{ api: object, memoId: string|null, memoTitle?: () => string, setStatus: (text: string, isError?: boolean) => void,
 *   onToggle?: (open: boolean) => void, onChange?: (list: object[]) => void }} options
 */
export function setupReminderPanel({ api, memoId, memoTitle = () => '', setStatus, onToggle, onChange }) {
  const el = {
    panel: $('reminder-panel'),
    head: $('rem-dialog-title'),
    list: $('reminder-list'),
    body: $('reminder-body'),
    bell: $('bell-btn'),
    bellCount: $('bell-count'),
    event: $('event-btn'),
    eventCount: $('event-count'),
    backdrop: $('reminder-backdrop'),
  };
  let reminders = [];
  let mode = 'task'; // 'task' 알림 | 'event' 일정

  // ---------- 저장 ----------

  async function save(next) {
    try {
      reminders = (await api.reminders.set(memoId, next)) ?? next;
      render();
      onChange?.(reminders);
      return true;
    } catch (err) {
      console.error(err);
      setStatus('저장하지 못했어요. 다시 해 주세요.', true);
      return false;
    }
  }
  const replace = (r, next) => save(reminders.map((x) => (x.id === r.id ? next : x)));
  const remove = (r) => save(reminders.filter((x) => x.id !== r.id));

  // ---------- 단추 숫자 ----------

  function counts() {
    const tasks = reminders.filter(openTask).length;
    const events = reminders.filter(upcomingEvent).length;
    el.bellCount.textContent = tasks ? String(tasks) : '';
    el.bell.classList.toggle('has-links', tasks > 0);
    el.bell.title = tasks ? `알림 ${tasks}개 (Ctrl+Shift+A)` : '알림 (Ctrl+Shift+A)';
    el.bell.setAttribute('aria-label', tasks ? `알림 ${tasks}개` : '알림');
    if (!el.event) return;
    el.eventCount.textContent = events ? String(events) : '';
    el.event.classList.toggle('has-links', events > 0);
    el.event.title = events ? `일정 ${events}개` : '일정';
    el.event.setAttribute('aria-label', events ? `일정 ${events}개` : '일정');
  }

  // ---------- 목록 ----------

  function eventItem(r) {
    const li = h('li', 'rem-item');
    const over = isPastEvent(r) && !nextLabel(r);
    li.classList.toggle('off', !r.enabled || over);
    li.append(icon(KIND_ICON[r.kind], 'rem-kind-icon'));
    const text = h('div', 'rem-text');
    const title = h('div', 'rem-title', r.title ? `${r.title}, ${describeReminder(r)}` : describeReminder(r));
    text.append(title, h('div', 'rem-sub', over ? '지난 일정' : `알림 ${describeAlerts(r)}`));
    const del = iconButton('trash', `${title.textContent} 삭제`, () => remove(r));
    li.append(text, del);
    return li;
  }

  function taskItem(r) {
    const li = h('li', 'rem-item task-item');
    const done = isDone(r);
    li.classList.toggle('done', done);
    li.classList.toggle('off', !r.enabled && !done);
    const name = r.title || memoTitle() || '이 메모';
    const text = h('div', 'rem-text');
    text.append(h('div', 'rem-title', name), h('div', 'rem-sub', taskWhen(r)));
    if (r.task) {
      // 구글 리마인더처럼: 동그라미를 누르면 완료 (다시 누르면 되살림)
      const check = h('button', 'task-check');
      check.type = 'button';
      check.setAttribute('aria-pressed', String(done));
      check.setAttribute('aria-label', done ? `${name} 완료 취소` : `${name} 완료`);
      check.title = done ? '완료 취소' : '완료';
      check.append(icon('check'));
      check.addEventListener('click', () => replace(r, done ? reenable(r) : { ...r, enabled: false, done: true }));
      li.append(check, text);
    } else {
      // 예전 타이머 · 앱 열 때: 켜고 끄기
      li.append(icon(KIND_ICON[r.kind], 'rem-kind-icon'), text);
      const sw = h('input', 'switch');
      sw.type = 'checkbox';
      sw.checked = r.enabled;
      sw.setAttribute('aria-label', `${name} ${r.enabled ? '끄기' : '켜기'}`);
      sw.addEventListener('change', () => replace(r, sw.checked ? reenable(r) : { ...r, enabled: false }));
      li.append(sw);
    }
    li.append(iconButton('trash', `${name} 삭제`, () => remove(r)));
    return li;
  }

  function taskWhen(r) {
    if (isDone(r)) return r.done ? '완료' : '알렸어요';
    if (r.kind === 'startup') return describeReminder(r);
    const next = nextLabel(r);
    const repeat = r.kind === 'repeat' ? describeReminder(r).replace(/\s\d{2}:\d{2}$/, '') : '';
    if (!next) return [repeat, !r.enabled ? UI.off : ''].filter(Boolean).join(', ');
    return repeat ? `${repeat}, 다음 ${next}` : next;
  }

  function iconButton(name, label, onClick) {
    const b = h('button', 'icon-btn');
    b.type = 'button';
    b.title = label.endsWith('삭제') ? '삭제' : label;
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    counts();
    if (el.panel.hidden) return;
    const mine = reminders.filter((r) => (mode === 'event' ? isEvent(r) : !isEvent(r)));
    // 할 것 먼저, 완료한 것은 아래로
    mine.sort((a, b) => Number(isDone(a)) - Number(isDone(b)));
    el.list.replaceChildren(...mine.map(mode === 'event' ? eventItem : taskItem));
    el.list.hidden = !mine.length;
  }

  // ---------- 일정: 일정 탭과 같은 "새 일정" 창 ----------

  async function newEvent() {
    const out = await openQuickEvent({ day: new Date(), memo: { id: memoId, title: memoTitle() } });
    if (!out) return;
    if (await save([...reminders, out.reminder])) {
      const r = reminders.at(-1) ?? out.reminder;
      setStatus(`일정을 추가했어요: ${r.title ? `${r.title}, ` : ''}${describeReminder(r)} (알림: ${describeAlerts(r)})`);
    }
  }

  function eventBody() {
    const add = h('button', 'btn rem-start');
    add.type = 'button';
    add.append(icon('plus'), h('span', '', '새 일정'));
    add.addEventListener('click', () => {
      toggle(false);
      newEvent();
    });
    return [add];
  }

  // ---------- 알림: 새로 만들기 ----------

  function taskBody() {
    const form = h('form', 'task-form');
    form.noValidate = true;

    const what = h('input', 'task-title');
    what.type = 'text';
    what.maxLength = 80;
    what.autocomplete = 'off';
    what.placeholder = '무엇을 알려 드릴까요?';
    what.setAttribute('aria-label', '알림 내용');
    const whatHint = h('p', 'task-hint', `비우면 "${memoTitle() || '이 메모'}"로 알려요`);

    // 시간 | 메모킹을 열 때
    const trigger = h('div', 'seg task-trigger');
    trigger.setAttribute('role', 'radiogroup');
    trigger.setAttribute('aria-label', '언제');
    const segBtn = (id, label, ic) => {
      const b = h('button');
      b.type = 'button';
      b.dataset.trigger = id;
      b.setAttribute('role', 'radio');
      b.append(icon(ic), h('span', '', label));
      trigger.append(b);
      return b;
    };
    segBtn('time', '시간', 'calendar');
    segBtn('open', '메모킹을 열 때', 'power');

    // 시간: 빨리 고르기 줄들 + 직접 고르기
    const timePane = h('div', 'task-pane');
    const presets = h('div', 'task-presets');
    presets.setAttribute('role', 'radiogroup');
    presets.setAttribute('aria-label', '언제 알릴까요');
    const pickerInput = h('input');
    pickerInput.type = 'hidden';
    const picker = h('div', 'date-picker task-picker');
    picker.setAttribute('aria-label', '날짜와 시각');
    picker.hidden = true;
    const repeatRow = h('label', 'task-repeat');
    const repeatSel = h('select');
    repeatSel.setAttribute('aria-label', '반복');
    repeatRow.append(icon('repeat'), repeatSel);
    timePane.append(presets, picker, repeatRow);

    // 메모킹을 열 때
    const openPane = h('div', 'task-pane task-open');
    openPane.setAttribute('role', 'radiogroup');
    openPane.setAttribute('aria-label', '메모킹을 열 때');
    for (const o of STARTUP) {
      const b = h('button', 'task-row');
      b.type = 'button';
      b.dataset.startup = o.id;
      b.setAttribute('role', 'radio');
      b.append(h('span', 'task-row-label', o.label));
      if (o.sub) b.append(h('span', 'task-row-when', o.sub));
      openPane.append(b);
    }

    const summary = h('p', 'task-summary');
    summary.setAttribute('role', 'status');
    const add = h('button', 'btn primary task-add', '알림 추가');
    add.type = 'submit';
    const footer = h('div', 'flow-footer');
    footer.append(add);
    form.append(what, whatHint, trigger, timePane, openPane, summary, footer);

    // ----- 고른 것 -----
    const state = { trigger: 'time', preset: null, at: null, every: 'none', startup: 'every' };
    let presetList = [];
    const radio = (box, attr, value) => {
      for (const b of box.querySelectorAll(`[${attr}]`)) {
        const on = b.getAttribute(attr) === value;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    };

    function drawPresets() {
      presetList = taskPresets(new Date());
      const rows = presetList.map((p) => {
        const b = h('button', 'task-row');
        b.type = 'button';
        b.dataset.preset = p.id;
        b.setAttribute('role', 'radio');
        b.append(h('span', 'task-row-label', p.label), h('span', 'task-row-when', whenText(p.at)));
        return b;
      });
      const custom = h('button', 'task-row task-row-custom');
      custom.type = 'button';
      custom.dataset.preset = 'custom';
      custom.setAttribute('role', 'radio');
      custom.append(h('span', 'task-row-label', '날짜와 시각 고르기'), icon('chev-right', 'task-row-chev'));
      presets.replaceChildren(...rows, custom);
    }

    function chosenAt() {
      if (state.preset === 'custom') {
        const d = new Date(pickerInput.value);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return presetList.find((p) => p.id === state.preset)?.at ?? null;
    }

    function drawRepeat() {
      const at = chosenAt() ?? new Date();
      const keep = state.every;
      repeatSel.replaceChildren(...taskRepeatChoices(at).map((c) => {
        const o = h('option', '', c.label);
        o.value = c.id;
        return o;
      }));
      repeatSel.value = keep;
      repeatRow.classList.toggle('on', state.every !== 'none');
    }

    function sync() {
      radio(trigger, 'data-trigger', state.trigger);
      timePane.hidden = state.trigger !== 'time';
      openPane.hidden = state.trigger !== 'open';
      radio(presets, 'data-preset', state.preset ?? '');
      radio(openPane, 'data-startup', state.startup);
      picker.hidden = state.preset !== 'custom';
      drawRepeat();
      // 한 줄 요약: 무엇을 고르면 언제 울리는지 바로
      summary.classList.remove('error');
      if (state.trigger === 'open') {
        summary.textContent = `${{ every: '메모킹을 열 때마다', daily: '하루에 한 번, 메모킹을 처음 열 때', once: '다음에 메모킹을 열 때 한 번' }[state.startup]} 알려 드려요`;
      } else {
        const at = chosenAt();
        if (!at) summary.textContent = '언제 알릴지 골라 주세요';
        else if (state.every === 'none') summary.textContent = at <= new Date() ? UI.pastTime : `${whenText(at)}에 알려 드려요`;
        else summary.textContent = `${repeatSel.selectedOptions[0]?.textContent ?? ''} ${koClock(at)}에 알려 드려요`;
      }
      add.disabled = state.trigger === 'time' && !chosenAt();
    }

    trigger.addEventListener('click', (e) => {
      const b = e.target.closest('[data-trigger]');
      if (!b) return;
      state.trigger = b.dataset.trigger;
      sync();
    });
    presets.addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      state.preset = b.dataset.preset;
      sync();
      if (state.preset === 'custom') picker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    openPane.addEventListener('click', (e) => {
      const b = e.target.closest('[data-startup]');
      if (!b) return;
      state.startup = b.dataset.startup;
      sync();
    });
    repeatSel.addEventListener('change', () => {
      state.every = repeatSel.value;
      sync();
    });
    pickerInput.addEventListener('input', () => state.preset === 'custom' && sync());
    // 라디오 묶음은 화살표로 옮겨 다닌다
    for (const box of [trigger, presets, openPane]) {
      box.addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        const items = [...box.querySelectorAll('[role="radio"]')];
        const i = items.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        const next = items[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
        next.focus();
        next.click();
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let r;
      try {
        if (state.trigger === 'open') {
          r = { kind: 'startup', startup: state.startup, action: 'notify', enabled: true, created: toLocalIso(new Date()) };
          const t = what.value.replace(/\s+/g, ' ').trim();
          if (t) r.title = t;
        } else {
          r = buildTask({ title: what.value, at: chosenAt(), every: state.every });
        }
      } catch (err) {
        summary.textContent = err.message;
        summary.classList.add('error');
        return;
      }
      if (!(await save([...reminders, r]))) return;
      setStatus(`알림을 추가했어요: ${r.title ?? (memoTitle() || '이 메모')}, ${summary.textContent.replace(/ 알려 드려요$/, '')}`);
      showBody(); // 목록에 생긴 것을 보이고, 새로 만들기는 접는다
    });

    const flip = () => {
      drawPresets();
      state.preset = presetList[0]?.id ?? 'custom';
      sync();
    };
    dateTimePicker(picker, { input: pickerInput });
    flip();
    return { form, focus: () => what.focus() };
  }

  // ---------- 패널 ----------

  let creating = false;
  function showBody({ create = false } = {}) {
    const mine = reminders.filter((r) => (mode === 'event' ? isEvent(r) : !isEvent(r)));
    el.head.textContent = mode === 'event' ? '일정' : '알림';
    el.panel.dataset.mode = mode;
    render();
    if (mode === 'event') {
      creating = false;
      el.body.replaceChildren(...eventBody());
      return;
    }
    // 알림이 없으면 바로 새로 만들기, 있으면 목록 + "새 알림"
    creating = create || !mine.length;
    if (creating) {
      const t = taskBody();
      el.body.replaceChildren(t.form);
      requestAnimationFrame(t.focus);
    } else {
      const add = h('button', 'btn rem-start');
      add.type = 'button';
      add.append(icon('plus'), h('span', '', '새 알림'));
      add.addEventListener('click', () => showBody({ create: true }));
      el.body.replaceChildren(add);
    }
    el.panel.classList.toggle('creating', creating);
  }

  function toggle(force, which = 'task') {
    const open = force ?? (el.panel.hidden || mode !== which);
    if (open) mode = which;
    el.panel.hidden = !open;
    if (el.backdrop) el.backdrop.hidden = !open;
    onToggle?.(open);
    if (open) {
      showBody();
      el.body.querySelector('button, input')?.focus({ preventScroll: true });
    }
  }

  el.bell.addEventListener('click', () => toggle(undefined, 'task'));
  // 일정이 없으면 바로 새 일정 창, 있으면 이 메모의 일정 목록
  el.event?.addEventListener('click', () => {
    if (!reminders.some(isEvent)) {
      toggle(false);
      newEvent();
    } else toggle(undefined, 'event');
  });
  $('reminder-close').addEventListener('click', () => toggle(false));
  el.backdrop?.addEventListener('click', () => toggle(false));
  // 알림이 있는데 새로 만드는 중에 Esc: 목록으로
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el.panel.hidden || !creating || mode !== 'task' || !reminders.some((r) => !isEvent(r))) return;
    e.stopPropagation();
    showBody();
  }, true);

  // 1분마다 "다음 …" 문구를 새로
  setInterval(() => !el.panel.hidden && render(), 60_000);

  return {
    set(list) {
      reminders = list ?? [];
      if (!el.panel.hidden && !creating) showBody(); // 다른 메모로 바뀌면(휴대폰은 패널 하나를 같이 씀) 목록부터 — 만드는 중이면 그대로
      else render();
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
    /** 알림 패널 열고 닫기 (Ctrl+Shift+A) */
    toggle,
    get open() {
      return !el.panel.hidden;
    },
  };
}
