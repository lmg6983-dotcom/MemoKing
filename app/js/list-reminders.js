// 목록 창 "알림 예약" 탭 — 모든 메모의 알림을 한 번에 (다가오는 순 · 실행할 때 · 꺼짐/완료)
import { icon } from './icons.js';
import { describeReminder, nextLabel, nextTime, isDone } from './core/reminders.js';

const KIND_ICON = { timer: 'timer', at: 'calendar', repeat: 'repeat', startup: 'power' };

export function setupRemindersTab({ api, container, empty, countEl }) {
  let items = []; // [{ memoId, title, color, reminder }]
  let query = '';

  async function refresh() {
    items = await api.reminders.all();
    render();
  }

  // 한 메모의 알림 목록을 바꿔서 저장
  function update(item, change) {
    const list = items.filter((x) => x.memoId === item.memoId).map((x) => x.reminder);
    const next = change(list);
    return api.reminders.set(item.memoId, next).then(refresh);
  }

  function row(item) {
    const r = item.reminder;
    const div = document.createElement('div');
    div.className = `row rem-row-item${r.enabled ? '' : ' off'}`;
    div.dataset.color = item.color;
    div.dataset.memo = item.memoId;
    div.dataset.reminder = r.id;

    const main = document.createElement('button');
    main.className = 'row-main';
    main.title = '메모 열기';
    const dot = document.createElement('span');
    dot.className = 'row-dot';
    const text = document.createElement('span');
    text.className = 'row-text';
    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = item.title;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    // 굵게: 다음 알림 시각(또는 완료·꺼짐) · 보통: 설정 설명 · 알림 방식
    // 글은 한 덩어리(span)로 — 칸 사이 간격(gap)이 쉼표 앞에 빈칸을 만들지 않게, 길면 잘리지 않고 다음 줄로
    const words = document.createElement('span');
    const when = isDone(r) ? '끝났어요' : !r.enabled ? '꺼져 있어요' : r.kind === 'startup' ? '' : nextLabel(r);
    if (when) {
      const b = document.createElement('b');
      b.textContent = when;
      words.append(b, ', ');
    }
    words.append(`${describeReminder(r)}, ${r.action === 'open' ? '메모 띄우기' : '알림만 보내기'}`);
    sub.append(icon(KIND_ICON[r.kind]), words);
    text.append(title, sub);
    main.append(dot, text);
    main.addEventListener('click', () => api.memo.open(item.memoId));

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.checked = r.enabled;
    toggle.setAttribute('aria-label', `${item.title} 알림`); // 켜짐·꺼짐은 스위치가 스스로 읽어 준다
    toggle.addEventListener('change', () => update(item, (list) => list.map((x) => (x.id === r.id
      ? { ...x, enabled: toggle.checked, last: toggle.checked && isDone(x) ? null : x.last }
      : x))));

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = '알림 삭제';
    del.setAttribute('aria-label', `${item.title} 알림 지우기`);
    del.append(icon('trash'));
    del.addEventListener('click', () => update(item, (list) => list.filter((x) => x.id !== r.id)));

    div.append(main, toggle, del);
    return div;
  }

  function section(title, list) {
    if (!list.length) return [];
    const h = document.createElement('h3');
    h.className = 'rows-title';
    h.textContent = `${title} ${list.length}`;
    return [h, ...list.map(row)];
  }

  function render() {
    const now = new Date();
    const q = query.trim().toLowerCase();
    const visible = items.filter((i) => !q || `${i.title} ${describeReminder(i.reminder)}`.toLowerCase().includes(q));
    const upcoming = visible.filter((i) => i.reminder.enabled && i.reminder.kind !== 'startup')
      .sort((a, b) => nextTime(a.reminder, now) - nextTime(b.reminder, now));
    const startup = visible.filter((i) => i.reminder.enabled && i.reminder.kind === 'startup');
    const off = visible.filter((i) => !i.reminder.enabled);
    container.replaceChildren(...section('다가오는 알림', upcoming), ...section('메모킹을 켤 때', startup), ...section('꺼졌거나 끝난 알림', off));
    empty.hidden = visible.length > 0;
    if (q && !visible.length) empty.textContent = '찾는 알림이 없어요.';
    const enabled = items.filter((i) => i.reminder.enabled).length;
    countEl.textContent = enabled ? String(enabled) : '';
  }

  setInterval(render, 60_000); // "다음 알림" 문구 새로 계산

  return {
    refresh,
    setQuery(q) {
      query = q;
      render();
    },
  };
}
