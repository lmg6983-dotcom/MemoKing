// 일정 탭 › 일정 하나 자세히 보기 (PC·휴대폰 같음) — 일정을 누르면 다른 앱으로 나가지 않고 여기서 본다
//   메모킹 일정: 메모 열기 · 지우기 / 다른 캘린더 일정: 메모로 가져오기 · (휴대폰 캘린더는) 캘린더 앱에서 열기
import { icon } from './icons.js';
import { koClock, koFullDate, relativeDay, sameDay, addDays } from './core/time.js';

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const dayText = (d) => {
  const rel = relativeDay(d);
  return rel ? `${rel}, ${koFullDate(d)}` : koFullDate(d);
};

/** "오늘, 10월 17일 (토) · 오후 3:00~4:00" · "10월 17일 (토) ~ 10월 19일 (월) · 하루 종일" */
export function whenText({ start, end, allDay }) {
  if (allDay) {
    const last = end && end > start ? addDays(end, -1) : start; // 하루 종일의 끝은 다음 날 0시
    return sameDay(start, last) ? `${dayText(start)} · 하루 종일` : `${dayText(start)} ~ ${koFullDate(last)} · 하루 종일`;
  }
  if (!end || end <= start) return `${dayText(start)} · ${koClock(start)}`;
  return sameDay(start, end) ? `${dayText(start)} · ${koClock(start)}~${koClock(end)}` : `${dayText(start)} ${koClock(start)} ~ ${koFullDate(end)} ${koClock(end)}`;
}

/**
 * @param {{ title: string, start: Date, end?: Date|null, allDay?: boolean, color?: string, memoColor?: string, source: string, readOnly?: boolean,
 *           lines?: { icon: string, text: string }[], note?: string,
 *           actions: { label: string, primary?: boolean, danger?: boolean, run: () => any }[] }} o
 *   color: 다른 캘린더 색(#rrggbb), memoColor: 메모 색 이름(yellow 등) — 출처 줄의 점
 *   lines: 반복 · 알림 · 장소 같은 한 줄씩, note: 일정 설명(여러 줄), actions: 아래 단추 (누르면 창을 닫고 run)
 * @returns {Promise<void>} 창을 닫으면
 */
export function openEventDetail({ title, start, end = null, allDay = false, color, memoColor, source, readOnly = false, lines = [], note = '', actions }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'dialog event-detail');
    dialog.setAttribute('aria-labelledby', 'event-detail-h');
    if (color) dialog.style.setProperty('--ev-color', color);
    if (memoColor) dialog.dataset.color = memoColor;

    const head = el('div', 'dialog-head');
    const h = el('h2', '', title || '(제목 없음)');
    h.id = 'event-detail-h';
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
    for (const l of lines) if (l.text) line(l.icon, l.text);

    const body = [head, info];
    if (note) body.push(el('p', 'ed-note', note));

    const bar = el('div', 'dialog-actions ed-actions');
    for (const a of actions) {
      const b = el('button', `btn${a.primary ? ' primary' : ''}${a.danger ? ' ed-danger' : ''}`, a.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        dialog.close();
        Promise.resolve().then(a.run).catch(() => {});
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
