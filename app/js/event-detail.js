// 일정 탭 › 일정 하나 자세히 보기 (PC·휴대폰 같음) — 일정을 누르면 다른 앱으로 나가지 않고 여기서 본다
//   메모킹 일정: 메모 열기 · (한 번짜리는) 지우기 / 다른 캘린더 일정: 메모로 가져오기
import { icon } from './icons.js';
import { koClock, koFullDate, relativeDay, sameDay, addDays } from './core/time.js';
import { UI } from './core/ui-text.js';

let seq = 0; // 창마다 다른 id (빨리 다시 열어도 겹치지 않게)

// 글 속 인터넷 주소 (끝의 문장 부호는 빼고)
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAIL = /[).,;:!?\]}'"]+$/;

/** 글 → 글자 + 누를 수 있는 링크 (누르면 그 주소만 연다 — 다른 캘린더 앱이 아니라). openUrl 이 없으면 글자 그대로 */
export function linkify(text, openUrl) {
  const out = [];
  let at = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(TRAIL)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    if (!openUrl || url.length < 10) continue;
    if (m.index > at) out.push(document.createTextNode(text.slice(at, m.index)));
    const a = document.createElement('a');
    a.className = 'ed-link';
    a.href = url;
    a.textContent = url;
    a.rel = 'noopener noreferrer';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      Promise.resolve().then(() => openUrl(url)).catch((err) => console.error('[event-detail] 링크', err));
    });
    out.push(a);
    at = m.index + url.length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const dayText = (d, relative = true) => {
  const rel = relative ? relativeDay(d) : null;
  return rel ? `${rel}, ${koFullDate(d)}` : koFullDate(d);
};

/** "오늘, 10월 17일 (토) · 오후 3:00~4:00" · "10월 17일 (토) ~ 10월 19일 (월) · 하루 종일" */
export function whenText({ start, end, allDay }, { relative = true } = {}) {  // relative: false 면 "내일" 없이 (그림 · 메모에 남길 글)
  if (allDay) {
    const last = end && end > start ? addDays(end, -1) : start; // 하루 종일의 끝은 다음 날 0시
    return sameDay(start, last) ? `${dayText(start, relative)}, 하루 종일` : `${dayText(start, relative)} ~ ${koFullDate(last)}, 하루 종일`;
  }
  if (!end || end <= start) return `${dayText(start, relative)} · ${koClock(start)}`;
  return sameDay(start, end) ? `${dayText(start, relative)} · ${koClock(start)}~${koClock(end)}` : `${dayText(start, relative)} ${koClock(start)} ~ ${koFullDate(end)} ${koClock(end)}`;
}

/**
 * @param {{ title: string, start: Date, end?: Date|null, allDay?: boolean, color?: string, memoColor?: string, source: string, readOnly?: boolean,
 *           lines?: { icon: string, text: string }[], note?: string, url?: string, openUrl?: (url: string) => any,
 *           actions: { label: string, primary?: boolean, danger?: boolean, run: () => any }[] }} o
 *   color: 다른 캘린더 색(#rrggbb), memoColor: 메모 색 이름(yellow 등) — 출처 줄의 점
 *   lines: 반복 · 알림 · 장소 같은 한 줄씩, note: 일정 설명(여러 줄), url: 일정에 붙은 주소 — 글 속 주소도 openUrl 로 여는 링크
 *   actions: 아래 단추 (누르면 창을 닫고 run)
 * @returns {Promise<void>} 창을 닫으면
 */
export function openEventDetail({ title, start, end = null, allDay = false, color, memoColor, source, readOnly = false, lines = [], note = '', url = '', openUrl = null, actions }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'dialog event-detail');
    const hid = `event-detail-h-${++seq}`;
    dialog.setAttribute('aria-labelledby', hid);
    if (color) dialog.style.setProperty('--ev-color', color);
    if (memoColor) dialog.dataset.color = memoColor;

    const head = el('div', 'dialog-head');
    const h = el('h2', '', title || UI.untitledParen);
    h.id = hid;
    const close = el('button', 'icon-btn dialog-x');
    close.type = 'button';
    close.setAttribute('aria-label', '닫기');
    close.append(icon('close'));
    close.addEventListener('click', () => dialog.close());
    head.append(h, close);

    const info = el('ul', 'ed-lines');
    const line = (name, text, cls = '') => {
      const li = el('li', cls);
      li.append(icon(name), el('span', '', text));
      info.append(li);
      return li;
    };
    line('calendar', whenText({ start, end, allDay }), 'ed-when');
    const src = line('cal-out', source, 'ed-source');
    src.firstChild.replaceWith(el('span', 'ed-dot'));
    if (readOnly) src.append(el('span', 'ed-badge', '보기만'));
    for (const l of lines) if (l.text) line(l.icon, l.text).lastChild.replaceChildren(...linkify(l.text, openUrl));
    if (url && openUrl && !note.includes(url)) line('link', url, 'ed-url').lastChild.replaceChildren(...linkify(url, openUrl));

    const body = [head, info];
    if (note) {
      const p = el('p', 'ed-note');
      p.append(...linkify(note, openUrl));
      body.push(p);
    }

    const bar = el('div', 'dialog-actions ed-actions');
    bar.hidden = !actions.length;
    for (const a of actions) {
      const b = el('button', `btn${a.primary ? ' primary' : ''}${a.danger ? ' ed-danger' : ''}`, a.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        dialog.close();
        Promise.resolve().then(a.run).catch((err) => console.error('[event-detail]', a.label, err)); // 단추마다 알림은 run 이
      });
      bar.append(b);
    }
    body.push(bar);

    dialog.append(...body);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
    bar.querySelector('.primary')?.focus();
  });
}
