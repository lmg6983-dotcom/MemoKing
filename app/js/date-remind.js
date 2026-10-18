// 글 속 날짜로 일정 만들기 — "내일 오후 3시 치과" 같은 말에 점선 밑줄, 그 말을 누르면(또는 커서를 옮기면)
// 바로 아래에 "일정 추가: 내일 오후 3:00" 단추 (달력 아이콘). 누르면 일정 창(event-editor.js)에서 이름(치과)과
// 미리 알림(30분 전 · 하루 전 …)을 고르고 저장 — 구글 캘린더처럼 일정 시각이 아니라 "미리" 알린다.
//   치는 중에는 단추를 띄우지 않는다 (누르거나 화살표로 옮겼을 때만) · 이미 일정이 있으면 밑줄이 실선 + "일정 있어요"
//   PC·휴대폰 같은 코드. 날짜 찾기는 core/date-detect.js (한국어) + chrono (영어, MIT)
import { Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { casual as chrono } from '../vendor/chrono.js';
import { findAllDates } from './core/date-detect.js';
import { koClock, dayLabel, WEEKDAY, sameDay } from './core/time.js';
import { hintOnce } from './hints.js';
import { openEventEditor } from './event-editor.js';
import { icon } from './icons.js';

export const dateRemindKey = new PluginKey('memoking-date-remind');
const SAME_MS = 60_000; // 알림이 이 안에 있으면 "이미 맞춤"

/** "10월 11일 (일) 오후 3:00" — 오늘·내일·모레는 그렇게 */
export const dateLabel = (at, now = new Date()) => `${dayLabel(at, now)} ${koClock(at)}`;

/** 되풀이 알림 설명: "매주 월요일 오전 10:00" */
export function repeatLabel(repeat, at) {
  const clock = koClock(at);
  if (repeat.every === 'day') return `매일 ${clock}`;
  if (repeat.every === 'week') return `매주 ${repeat.weekdays.map((w) => `${WEEKDAY[w]}요일`).join(', ')} ${clock}`;
  if (repeat.every === 'month') return `매달 ${repeat.day}일 ${clock}`;
  return `매년 ${repeat.month}월 ${repeat.day}일 ${clock}`;
}
const chipLabel = (d) => (d.repeat ? repeatLabel(d.repeat, d.at) : d.hasTime ? dateLabel(d.at) : dateLabel(d.at).replace(/ (오전|오후) .*$/, ''));

/** 일정 이름 짐작: 그 줄에서 날짜 말을 빼고 남은 말 ("내일 오후 3시 치과" → "치과", "15일까지 보고서 제출" → "보고서 제출") */
export function guessTitle(line, from, to) {
  const rest = `${line.slice(0, from)} ${line.slice(to)}`
    .replace(/\uFFFC/g, ' ')
    .replace(/^\s*(?:까지|에는|에|부터|은|는|이|가|의|쯤|경)(?=\s|$)/, '')
    .replace(/(?:^|\s)(?:까지|에는|에|부터)(?=\s)/g, ' ')
    .replace(/[\s,:·\-–~]+$/, '')
    .replace(/^[\s,:·\-–~]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return rest.slice(0, 40);
}

// 빠른 거르기 — date-detect.js 가 읽는 말을 하나라도 빠뜨리면 그 줄의 날짜를 못 찾는다 ("한 달 뒤" · "엿새 후" · "삼십 분 뒤")
const DATE_HINT = /\d|내일|낼|모레|글피|요일|욜|주말|정오|자정|매일|날마다|일주일|시|뒤|후|있다가|이따|지나서|크리스마스|[A-Za-z]/;

/** 글 한 덩이(문단·제목·목록 줄)의 날짜들 — pos 는 그 덩이의 문서 위치 */
function datesInBlock(doc, node, pos, now) {
  // 끝낸 할 일·코드 블록 안은 빼고
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const anc = $pos.node(d);
    if (anc.type.name === 'list_item' && anc.attrs.checked === true) return [];
    if (anc.type.spec.code) return [];
  }
  if (node.type.spec.code) return [];
  // 그림·줄바꿈 같은 글 아닌 것도 한 글자로 세면 글자 자리 = 문서 위치
  const text = node.textBetween(0, node.content.size, null, '￼');
  if (!DATE_HINT.test(text)) return [];
  const found = [];
  for (const d of findAllDates(text, { chrono, now })) {
    // 인라인 코드·링크 안은 빼고
    const $from = doc.resolve(pos + 1 + d.from);
    if ($from.marks().some((m) => m.type.spec.code || m.type.name === 'link')) continue;
    found.push({ ...d, from: pos + 1 + d.from, to: pos + 1 + d.to, title: guessTitle(text, d.from, d.to) });
  }
  return found;
}

function findInDoc(doc, now) {
  const found = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'list_item' && node.attrs.checked === true) return false;
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    found.push(...datesInBlock(doc, node, pos, now));
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
  const isSet = (d) => Boolean(hasReminderAt?.(d));
  const deco = (d) => {
    const set = isSet(d);
    return Decoration.inline(d.from, d.to, {
      class: set ? 'mk-date mk-date-set' : 'mk-date',
      title: set ? `${chipLabel(d)} 일정이 있어요` : `누르면 ${chipLabel(d)} 일정을 만들고 미리 알림을 고를 수 있어요`,
    }, { date: d });
  };
  const build = (doc) => DecorationSet.create(doc, findInDoc(doc, new Date()).map(deco));
  // 글이 바뀌면 바뀐 덩이만 다시 찾는다 (긴 메모에서 글자마다 메모 전체를 다시 읽어 느려지지 않게)
  const update = (tr, old) => {
    const doc = tr.doc;
    let set = old.map(tr.mapping, doc);
    const blocks = new Map();
    tr.mapping.maps.forEach((map, i) => {
      const rest = tr.mapping.slice(i + 1);
      map.forEach((_a, _b, from, to) => {
        const a = Math.max(0, rest.map(from, -1) - 1);
        const b = Math.min(doc.content.size, rest.map(to, 1) + 1);
        doc.nodesBetween(a, b, (node, pos) => {
          if (!node.isTextblock) return true;
          blocks.set(pos, node);
          return false;
        });
      });
    });
    const now = new Date();
    for (const [pos, node] of blocks) {
      set = set.remove(set.find(pos, pos + node.nodeSize));
      set = set.add(doc, datesInBlock(doc, node, pos, now).map(deco));
    }
    return set;
  };

  return new Plugin({
    key: dateRemindKey,
    state: {
      init: (_, state) => build(state.doc),
      // 글이 바뀌거나, 알림 목록이 바뀌었다고 알려 오면(refresh) 다시 찾는다
      apply: (tr, old, _prev, state) => (tr.getMeta(dateRemindKey) ? build(state.doc) : tr.docChanged ? update(tr, old) : old),
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
    // 메모를 열어 둔 사이 시각이 지나면 밑줄도 거둔다 (지난 "3시 회의" 에 일정 추가 단추가 남지 않게)
    this.tick = setInterval(() => !this.view.isDestroyed && !this.suspended && refreshDateRemind(this.view), 60_000);
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
    if (this.suspended) return this.hide();
    const hit = sel.empty && view.editable && !this.typing && decos
      ? decos.find(sel.from, sel.from).find((d) => sel.from >= d.from && sel.from <= d.to)
      : null;
    if (!hit) return this.hide();
    const date = hit.spec.date;
    if (this.current && this.current.from === hit.from && this.current.at.getTime() === date.at.getTime()) return this.place();
    this.current = { from: hit.from, to: hit.to, at: date.at, text: date.text, hasTime: date.hasTime, repeat: date.repeat ?? null, title: date.title ?? '' };
    this.show();
  }

  show() {
    this.hide({ keepCurrent: true });
    const cur = this.current;
    const set = this.isSet(cur);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `mk-date-chip${set ? ' set' : ''}`;
    chip.replaceChildren(icon('calendar'), set ? `일정 있어요: ${chipLabel(cur)}` : `일정 추가: ${chipLabel(cur)}`);
    chip.disabled = set;
    chip.setAttribute('aria-label', set ? `${chipLabel(cur)} 일정이 있어요` : `${chipLabel(cur)} 일정 추가`);
    // 편집기의 커서·초점을 빼앗지 않게 (누르는 순간 편집기가 흐려지면 단추가 사라짐)
    chip.addEventListener('pointerdown', (e) => e.preventDefault());
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', async () => {
      const c = this.current;
      if (!c || chip.disabled) return;
      this.hide();
      this.suspended = true; // 일정 창이 떠 있는 동안은 단추를 다시 띄우지 않는다
      // 일정 창: 이름(줄에서 짐작) · 때 · 미리 알림 고르기
      const picked = await openEventEditor({
        title: c.title,
        start: c.at,
        allDay: !c.hasTime && !c.repeat,
        repeatLabel: c.repeat ? repeatLabel(c.repeat, c.at) : null,
      });
      this.suspended = false;
      this.typing = true; // 창을 닫은 뒤 같은 자리에 단추가 바로 다시 뜨지 않게 (커서를 옮기면 다시)
      if (!picked) return;
      const ok = await this.onAdd({ ...picked, repeat: c.repeat, text: c.text });
      if (ok !== false) refreshDateRemind(this.view);
      if (!this.view.isDestroyed) this.view.focus();
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
    clearInterval(this.tick);
    this.hide();
    this.view.dom.removeEventListener('pointerdown', this.onPointer);
    this.view.dom.removeEventListener('keydown', this.onKey);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
  }
}

/** 메모에 이 날짜의 일정(또는 예전 알림)이 이미 있는지 — 되풀이면 같은 되풀이, 날짜만이면 같은 날 */
export function reminderAt(reminders, { at, repeat = null, hasTime = true }) {
  return (reminders ?? []).some((r) => {
    if (r.enabled === false && !r.last) return false;
    if (repeat) {
      const x = r.kind === 'repeat' ? r.repeat : null;
      return Boolean(x) && x.every === repeat.every && x.time === repeat.time
        && (x.weekdays ?? []).join() === (repeat.weekdays ?? []).join() && (x.day ?? null) === (repeat.day ?? null) && (x.month ?? null) === (repeat.month ?? null);
    }
    if (!r.at || r.kind !== 'at') return false;
    // 날짜만 적었거나, 시각이 있어도 일정 창에서 하루 종일로 바꿔 만든 일정이면 같은 날이면 맞춤
    if (!hasTime || r.allDay) return sameDay(new Date(r.at), at);
    return Math.abs(Date.parse(r.at) - at.getTime()) < SAME_MS;
  });
}
