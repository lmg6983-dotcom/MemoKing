// 설정 › Work / Life (PC 설정 창 · 휴대폰 설정 시트 같이 씀) — 정리 도우미 · 업무 시간 · 퇴근 뒤 조용히 (core/work-hours.js)
import { normalizeHours, WEEKDAY_LABEL, hoursLabel } from './core/work-hours.js';
import { UI } from './core/ui-text.js';

function el(tag, className = '', text = '') {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function switchRow(id, title, note, checked) {
  const row = el('label', 'setting-row');
  const input = el('input', 'switch');
  input.type = 'checkbox';
  input.id = id;
  input.setAttribute('role', 'switch');
  input.checked = checked;
  const words = el('span', '', title);
  words.append(' ', el('small', '', note));
  row.append(input, words);
  return { row, input };
}

/**
 * @param {HTMLElement} box
 * @param {{ enabled: boolean, setEnabled: (on: boolean) => void, hours: object, save: (hours: object) => void, openHelper: () => void, quietNote: string }} o
 *   enabled: Work / Life 나누기 — 꺼져 있으면 아래 설정은 숨긴다
 */
export function renderWorkSettings(box, { enabled, setEnabled, hours, save, openHelper, quietNote }) {
  let h = normalizeHours(hours);
  const main = switchRow('work-life', 'Work / Life 나누기', '일할 때 쓰는 메모와 일상 메모를 나눠 봐요. Work 는 어두운 화면, Life 는 밝은 화면이에요. 끄면 모든 메모가 한 목록에 보여요', enabled);
  const rest = el('div', 'work-life-more');
  rest.hidden = !enabled;
  main.input.addEventListener('change', () => {
    rest.hidden = !main.input.checked;
    setEnabled(main.input.checked);
  });

  const helper = el('div', 'setting-row');
  const hw = el('span', '', UI.modeHelper);
  hw.append(' ', el('small', '', 'Life 메모 중 일 이야기 같은 메모를 골라 Work로 옮겨요'));
  const open = el('button', 'btn small', '열기');
  open.type = 'button';
  open.id = 'mode-helper-btn';
  open.addEventListener('click', openHelper);
  helper.append(hw, open);

  const auto = switchRow('work-auto', '업무 시간에는 Work로', '업무 시간이 시작되면 Work, 끝나면 Life로 저절로 바뀌어요. 그 사이 손으로 바꾼 건 그대로예요', h.auto);
  const quiet = switchRow('work-quiet', '퇴근 뒤 Work 알림은 조용히', quietNote, h.quiet);

  const wh = el('div', 'setting-sub work-hours');
  const label = el('p', 'label sub', '업무 시간 ');
  const sum = el('small', 'wh-sum');
  label.append(sum);
  const days = el('div', 'wh-days');
  days.setAttribute('role', 'group');
  days.setAttribute('aria-label', '일하는 요일');
  [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
    const b = el('button', `wh-day${d === 0 ? ' sun' : d === 6 ? ' sat' : ''}`, WEEKDAY_LABEL[d]);
    b.type = 'button';
    b.dataset.day = String(d);
    b.addEventListener('click', () => {
      const set = new Set(h.days);
      if (set.has(d)) set.delete(d);
      else set.add(d);
      update({ days: [...set] });
    });
    days.append(b);
  });
  const time = el('div', 'wh-time');
  const start = el('input');
  start.type = 'time';
  start.setAttribute('aria-label', '업무 시작');
  const end = el('input');
  end.type = 'time';
  end.setAttribute('aria-label', '업무 끝');
  time.append(start, el('span', '', '~'), end);
  start.addEventListener('change', () => update({ start: start.value }));
  end.addEventListener('change', () => update({ end: end.value }));
  wh.append(label, days, time);

  auto.input.addEventListener('change', () => update({ auto: auto.input.checked }));
  quiet.input.addEventListener('change', () => update({ quiet: quiet.input.checked }));

  function draw() {
    sum.textContent = hoursLabel(h);
    for (const b of days.children) b.setAttribute('aria-pressed', String(h.days.includes(Number(b.dataset.day))));
    start.value = h.start;
    end.value = h.end;
    auto.input.checked = h.auto;
    quiet.input.checked = h.quiet;
  }
  function update(patch) {
    h = normalizeHours({ ...h, ...patch });
    draw();
    save(h);
  }
  draw();
  rest.replaceChildren(helper, auto.row, quiet.row, wh);
  box.replaceChildren(main.row, rest);
  return { set(next) { h = normalizeHours(next); draw(); } };
}
