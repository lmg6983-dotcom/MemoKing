// "이 날의 기록으로" — 추억 달력에서 이 메모를 어느 날 칸에 둘지 (메모 파일의 day). 정하지 않으면 만든 날.
//   여행 기록을 다녀와서 정리할 때처럼 만든 날과 그날이 다를 때 쓴다. PC 메모 창 · 목록 카드 메뉴 · 휴대폰 메모 메뉴가 같이 쓴다.
import { dayKey, keyDate } from './core/memories.js';
import { icon } from './icons.js';

const WEEK = '일월화수목금토';
const label = (key) => {
  const d = keyDate(key);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
};
const short = (key) => {
  const d = keyDate(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
};

/** 메뉴에 붙이는 짧은 날짜 ("10월 3일") */
export const dayText = (key) => short(key);

function el(tag, className = '', text = '') {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/**
 * @param {{ created?: string, day?: string, title?: string }} memo
 * @returns {Promise<string|null>} 'YYYY-MM-DD' · '' (만든 날로) · null (그만둠)
 */
export function openMemoryDay({ created, day, title } = {}) {
  return new Promise((resolve) => {
    const today = dayKey(new Date());
    const made = created ? dayKey(new Date(created)) : today;
    const yesterday = dayKey(new Date(Date.now() - 86400000));
    let picked = day || made;

    const dialog = el('dialog', 'dialog memory-day');
    dialog.setAttribute('aria-labelledby', 'md-h');
    const head = el('div', 'dialog-head');
    const h = el('h2', '', '이 날의 기록으로');
    h.id = 'md-h';
    const x = el('button', 'icon-btn dialog-x');
    x.type = 'button';
    x.setAttribute('aria-label', '닫기');
    x.append(icon('close'));
    head.append(h, x);
    const lead = el('p', 'md-lead', '추억 달력의 어느 날 칸에 둘까요?\n다녀와서 정리한 여행, 데이트 기록을 그날로 옮길 때 좋아요.');
    if (title) lead.prepend(el('b', 'md-title', title));

    const chips = el('div', 'md-chips');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', '자주 고르는 날');
    const quick = [
      { key: made, text: `만든 날, ${short(made)}` },
      ...(today !== made ? [{ key: today, text: '오늘' }] : []),
      ...(yesterday !== made ? [{ key: yesterday, text: '어제' }] : []),
    ];
    for (const q of quick) {
      const b = el('button', 'md-chip', q.text);
      b.type = 'button';
      b.dataset.key = q.key;
      b.setAttribute('role', 'radio');
      chips.append(b);
    }

    // 보이는 건 날짜 글자, 누르면 기본 달력 (일정 만들기 창과 같은 모양)
    const field = el('label', 'md-date');
    const text = el('span', 'md-date-text');
    const input = el('input', 'md-date-input');
    input.type = 'date';
    input.max = today; // 지나간 날의 기록 (앞으로의 날은 일정으로)
    input.setAttribute('aria-label', '날짜 고르기');
    field.append(icon('calendar'), text, input);

    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'btn', '취소');
    cancel.type = 'button';
    const ok = el('button', 'btn primary', '이 날로 두기');
    ok.type = 'button';
    actions.append(cancel, ok);
    dialog.append(head, lead, chips, field, actions);

    const sync = () => {
      text.textContent = label(picked);
      input.value = picked;
      for (const b of chips.children) b.setAttribute('aria-checked', String(b.dataset.key === picked));
    };
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-key]');
      if (!b) return;
      picked = b.dataset.key;
      sync();
    });
    input.addEventListener('change', () => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(input.value)) picked = input.value > today ? today : input.value;
      sync();
    });
    // 기본 달력이 안 뜨는 곳(일부 PC)에서도 누르면 열리게
    field.addEventListener('click', (e) => {
      if (e.target !== input) input.showPicker?.();
    });

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    x.addEventListener('click', () => finish(null));
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(picked === made ? '' : picked)); // 만든 날이면 따로 적지 않는다
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    dialog.addEventListener('close', () => finish(null));
    sync();
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}
