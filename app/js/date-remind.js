// 글 속 날짜에 알림 맞추기 — "내일 오후 3시" 같은 말에 점선 밑줄, 그 말을 누르면(또는 커서를 옮기면)
// 바로 아래에 "🔔 10월 11일 (일) 오후 3:00 알림" 단추가 뜨고, 누르면 그 시각에 이 메모 알림을 맞춘다.
//   치는 중에는 단추를 띄우지 않는다 (누르거나 화살표로 옮겼을 때만) · 이미 맞춘 시각이면 밑줄이 실선 + "맞춤" 표시
//   PC·휴대폰 같은 코드. 날짜 찾기는 core/date-detect.js (한국어) + chrono (영어, MIT)
import { Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { casual as chrono } from '../vendor/chrono.js';
import { findAllDates } from './core/date-detect.js';
import { koClock, koMonthDay } from './core/time.js';
import { hintOnce } from './hints.js';

export const dateRemindKey = new PluginKey('memoking-date-remind');
const WEEKDAY = '일월화수목금토';
const SAME_MS = 60_000; // 알림이 이 안에 있으면 "이미 맞춤"

/** "10월 11일 (일) 오후 3:00" — 오늘·내일은 그렇게 */
export function dateLabel(at, now = new Date()) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  const date = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === 2 ? '모레' : `${koMonthDay(at)} (${WEEKDAY[at.getDay()]})`;
  return `${date} ${koClock(at)}`;
}

/** 되풀이 알림 설명: "매주 월요일 오전 10:00" */
export function repeatLabel(repeat, at) {
  const clock = koClock(at);
  if (repeat.every === 'day') return `매일 ${clock}`;
  if (repeat.every === 'week') return `매주 ${repeat.weekdays.map((w) => `${WEEKDAY[w]}요일`).join(', ')} ${clock}`;
  if (repeat.every === 'month') return `매달 ${repeat.day}일 ${clock}`;
  return `매년 ${repeat.month}월 ${repeat.day}일 ${clock}`;
}
const chipLabel = (d) => (d.repeat ? repeatLabel(d.repeat, d.at) : dateLabel(d.at));

function findInDoc(doc, now) {
  const found = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'list_item' && node.attrs.checked === true) return false; // 끝낸 할 일은 빼고
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    // 그림·줄바꿈 같은 글 아닌 것도 한 글자로 세면 글자 자리 = 문서 위치
    const text = node.textBetween(0, node.content.size, null, '￼');
    if (!/\d|내일|낼|모레|글피|요일|욜|주말|정오|자정|매일|날마다|하루|이틀|사흘|나흘|닷새|열흘|일주일|시|크리스마스|[A-Za-z]/.test(text)) return false;
    for (const d of findAllDates(text, { chrono, now })) {
      // 인라인 코드·링크 안은 빼고
      const $from = doc.resolve(pos + 1 + d.from);
      if ($from.marks().some((m) => m.type.spec.code || m.type.name === 'link')) continue;
      found.push({ ...d, from: pos + 1 + d.from, to: pos + 1 + d.to });
    }
    return false;
  });
  return found;
}

/**
 * @param {{ readOnly?: boolean, onAdd?: (d: {at: Date, text: string, hasTime: boolean}) => Promise<boolean>|boolean,
 *   hasReminderAt?: (at: Date) => boolean }} options
 */
export function createDateRemind({ readOnly = false, onAdd, hasReminderAt } = {}) {
  if (readOnly || !onAdd) return new Plugin({ key: dateRemindKey });
  const isSet = (d) => Boolean(hasReminderAt?.(d.at, d.repeat));
  const build = (doc) => {
    const dates = findInDoc(doc, new Date());
    const decos = dates.map((d) => Decoration.inline(d.from, d.to, {
      class: isSet(d) ? 'mk-date mk-date-set' : 'mk-date',
      title: isSet(d) ? `${chipLabel(d)} 알림이 맞춰져 있어요` : `누르면 ${chipLabel(d)} 알림을 맞출 수 있어요`,
    }, { date: d }));
    return DecorationSet.create(doc, decos);
  };

  return new Plugin({
    key: dateRemindKey,
    state: {
      init: (_, state) => build(state.doc),
      // 글이 바뀌거나, 알림 목록이 바뀌었다고 알려 오면(refresh) 다시 찾는다
      apply: (tr, old, _prev, state) => (tr.docChanged || tr.getMeta(dateRemindKey) ? build(state.doc) : old),
    },
    props: {
      decorations: (state) => dateRemindKey.getState(state),
    },
    view: (view) => new DateChip(view, { onAdd, isSet }),
  });
}

/** 알림 목록이 바뀌었을 때 밑줄(맞춤 표시)을 다시 */
export function refreshDateRemind(view) {
  if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(dateRemindKey, true).setMeta('addToHistory', false));
}

class DateChip {
  constructor(view, { onAdd, isSet }) {
    this.view = view;
    this.onAdd = onAdd;
    this.isSet = isSet;
    this.chip = null;
    this.current = null;
    this.typing = false;
    // 누르기·화살표로 커서를 옮겼을 때만 단추 — 치는 중(글이 바뀐 직후)에는 띄우지 않는다
    this.onPointer = () => (this.typing = false);
    this.onKey = (e) => {
      if (/^(Arrow|Home|End|Page)/.test(e.key)) this.typing = false;
      else if (e.key === 'Escape' && this.chip) this.hide();
    };
    view.dom.addEventListener('pointerdown', this.onPointer);
    view.dom.addEventListener('keydown', this.onKey);
    this.onScroll = () => this.place();
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onScroll);
  }

  update(view, prev) {
    this.view = view;
    if (prev && !prev.doc.eq(view.state.doc)) this.typing = true;
    const sel = view.state.selection;
    const decos = dateRemindKey.getState(view.state);
    // 처음 밑줄이 생긴 때 한 번만: 무슨 뜻인지
    if (!this.hinted && view.editable && decos && decos.find().length) {
      this.hinted = true;
      // 화면 아래 가운데에 (날짜 바로 아래는 알림 단추가 뜨는 자리) · 단추가 이미 떠 있으면 그것이 설명이므로 띄우지 않는다
      setTimeout(() => {
        if (!this.chip && view.dom.querySelector('.mk-date')) hintOnce('date-remind', '밑줄 친 날짜를 누르면 그 시각에 알림을 맞출 수 있어요');
      }, 900);
    }
    const hit = sel.empty && view.editable && !this.typing && decos
      ? decos.find(sel.from, sel.from).find((d) => sel.from >= d.from && sel.from <= d.to)
      : null;
    if (!hit) return this.hide();
    const date = hit.spec.date;
    if (this.current && this.current.from === hit.from && this.current.at.getTime() === date.at.getTime()) return this.place();
    this.current = { from: hit.from, to: hit.to, at: date.at, text: date.text, hasTime: date.hasTime, repeat: date.repeat ?? null };
    this.show();
  }

  show() {
    this.hide({ keepCurrent: true });
    const cur = this.current;
    const set = this.isSet(cur);
    const icon = cur.repeat ? '🔁' : '🔔';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `mk-date-chip${set ? ' set' : ''}`;
    chip.textContent = set ? `${icon} ${chipLabel(cur)} 알림 맞춤` : `${icon} ${chipLabel(cur)} 알림 맞추기`;
    chip.disabled = set;
    chip.setAttribute('aria-label', chip.textContent.replace(/^\S+ /, ''));
    // 편집기의 커서·초점을 빼앗지 않게 (누르는 순간 편집기가 흐려지면 단추가 사라짐)
    chip.addEventListener('pointerdown', (e) => e.preventDefault());
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', async () => {
      const cur = this.current;
      if (!cur || chip.disabled) return;
      chip.disabled = true;
      const ok = await this.onAdd({ at: cur.at, text: cur.text, hasTime: cur.hasTime, repeat: cur.repeat });
      if (ok === false) {
        chip.disabled = false;
        return;
      }
      chip.classList.add('set');
      chip.textContent = `${cur.repeat ? '🔁' : '🔔'} ${chipLabel(cur)} 알림 맞춤`;
      refreshDateRemind(this.view);
      setTimeout(() => this.hide(), 1400);
    });
    document.body.append(chip);
    this.chip = chip;
    this.place();
  }

  place() {
    if (!this.chip || !this.current || this.view.isDestroyed) return;
    let a;
    let b;
    try {
      a = this.view.coordsAtPos(this.current.from);
      b = this.view.coordsAtPos(this.current.to);
    } catch {
      return this.hide();
    }
    const w = this.chip.offsetWidth;
    const h = this.chip.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, (a.top === b.top ? (a.left + b.left) / 2 : a.left) - w / 2));
    // 글 바로 아래 — 화면 아래 끝이면 글 위로
    let top = Math.max(a.bottom, b.bottom) + 6;
    if (top + h > window.innerHeight - 8) top = Math.min(a.top, b.top) - h - 6;
    this.chip.style.left = `${Math.round(left)}px`;
    this.chip.style.top = `${Math.round(top)}px`;
  }

  hide({ keepCurrent = false } = {}) {
    this.chip?.remove();
    this.chip = null;
    if (!keepCurrent) this.current = null;
  }

  destroy() {
    this.hide();
    this.view.dom.removeEventListener('pointerdown', this.onPointer);
    this.view.dom.removeEventListener('keydown', this.onKey);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
  }
}

/** 메모의 알림 중 그 시각(1분 안)에 울리는 것이 있는지 — 되풀이면 같은 되풀이 알림이 있는지 */
export function reminderAt(reminders, at, repeat = null) {
  return (reminders ?? []).some((r) => {
    if (r.enabled === false) return false;
    if (repeat) {
      const x = r.kind === 'repeat' ? r.repeat : null;
      return Boolean(x) && x.every === repeat.every && x.time === repeat.time
        && (x.weekdays ?? []).join() === (repeat.weekdays ?? []).join() && (x.day ?? null) === (repeat.day ?? null) && (x.month ?? null) === (repeat.month ?? null);
    }
    return r.at && r.kind !== 'repeat' && Math.abs(Date.parse(r.at) - at.getTime()) < SAME_MS;
  });
}
