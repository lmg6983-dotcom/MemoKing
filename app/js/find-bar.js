// 메모 안 찾기 · 바꾸기 막대 (워드의 "찾기 및 바꾸기"를 한 막대로) — PC 메모 창 · 휴대폰 메모 화면 공용
//   윗줄: 찾을 말 · 몇 번째/모두 · 이전 · 다음 · 바꾸기 펼치기 · 닫기
//   바꾸기 줄(펼치면): 바꿀 말 · 바꾸기 · 모두 바꾸기
//   아랫줄: 대소문자 구분 · 낱말 단위
//   키: Enter 다음 · Shift+Enter 이전 (F3 · Shift+F3 도) · 바꿀 말에서 Enter 바꾸기 · Ctrl+Enter 모두 바꾸기 · Esc 닫기(찾은 곳을 고른 채 글로)
//   편집기 쪽 일은 find-replace.js (editor.find)
import { icon } from './icons.js';
import { findCountText } from './core/find.js';

const el = (tag, className = '', text = '') => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};
function iconBtn(name, label, className = '') {
  const b = el('button', `icon-btn mk-find-btn ${className}`.trim());
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label.replace(/ \(.*\)$/, ''));
  b.append(icon(name));
  return b;
}
function toggle(label, title) {
  const b = el('button', 'mk-find-opt', label);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-pressed', 'false');
  return b;
}

/**
 * @param {{ host: HTMLElement, after?: HTMLElement|null, find: () => any, notify?: (text: string, isError?: boolean) => void, onToggle?: (open: boolean) => void }} o
 *   host · after: 막대를 둘 곳 — 화면 위 막대(after) 바로 아래에 끼워 글을 아래로 밀어낸다 (글을 가리지 않게)
 *   find: 지금 편집기의 editor.find (메모를 바꿔 열면 새 편집기) · notify: "3개 바꿨어요" 같은 알림
 */
export function createFindBar({ host, after = null, find, notify = () => {}, onToggle = () => {} }) {
  const bar = el('div', 'mk-find-bar');
  bar.setAttribute('role', 'search');
  bar.setAttribute('aria-label', '메모 안 찾기, 바꾸기');
  bar.hidden = true;

  const row1 = el('div', 'mk-find-row');
  const field = el('label', 'mk-find-field');
  field.append(icon('search'));
  const query = el('input', 'mk-find-input');
  query.type = 'search';
  query.placeholder = '찾을 말';
  query.setAttribute('aria-label', '찾을 말');
  query.enterKeyHint = 'search';
  const count = el('span', 'mk-find-count');
  count.setAttribute('aria-live', 'polite');
  field.append(query, count);
  const prev = iconBtn('chev-right', '이전 (Shift+Enter)', 'mk-find-prev');
  const next = iconBtn('chev-right', '다음 (Enter)', 'mk-find-next');
  const more = iconBtn('swap', '바꾸기 (Ctrl+H)', 'mk-find-more');
  more.setAttribute('aria-expanded', 'false');
  const close = iconBtn('close', '닫기 (Esc)');
  row1.append(field, prev, next, more, close);

  const row2 = el('div', 'mk-find-row mk-find-replace');
  row2.hidden = true;
  const repField = el('label', 'mk-find-field');
  const rep = el('input', 'mk-find-input');
  rep.type = 'text';
  rep.placeholder = '바꿀 말';
  rep.setAttribute('aria-label', '바꿀 말');
  repField.append(rep);
  const one = el('button', 'btn mk-find-act', '바꾸기');
  one.type = 'button';
  one.title = '지금 찾은 곳 하나를 바꾸고 다음으로 (Enter)';
  const all = el('button', 'btn primary mk-find-act', '모두 바꾸기');
  all.type = 'button';
  all.title = '찾은 곳을 모두 한 번에 바꾸기 (Ctrl+Enter) · 되돌리기 Ctrl+Z 한 번';
  row2.append(repField, one, all);

  const row3 = el('div', 'mk-find-row mk-find-opts');
  const caseOpt = toggle('Aa 대소문자 구분', '영어 대문자와 소문자를 다르게 찾기');
  const wordOpt = toggle('낱말 단위', '낱말 전체가 같을 때만 (예: "메모"를 찾을 때 "메모킹"은 빼고)');
  row3.append(caseOpt, wordOpt);

  bar.append(row1, row2, row3);
  if (after?.parentElement === host) after.after(bar);
  else host.append(bar);

  const opts = () => ({ caseSensitive: caseOpt.getAttribute('aria-pressed') === 'true', wholeWord: wordOpt.getAttribute('aria-pressed') === 'true' });
  function paint(f = find()?.state()) {
    const n = f?.matches.length ?? 0;
    count.textContent = findCountText(f?.current ?? -1, n, query.value);
    bar.classList.toggle('none', Boolean(query.value) && !n);
    prev.disabled = next.disabled = n === 0;
    const editable = find()?.editable !== false;
    one.disabled = all.disabled = n === 0 || !editable;
    rep.disabled = !editable;
    if (!editable) rep.placeholder = '읽기 전용이라 바꿀 수 없어요';
  }
  let timer = 0;
  const search = () => {
    clearTimeout(timer);
    const f = find();
    if (!f) return;
    paint(f.set(query.value, opts()));
  };
  query.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 90);
  });
  for (const b of [caseOpt, wordOpt]) {
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      search();
    });
  }
  const step = (dir) => {
    const f = find();
    if (!f) return;
    if (!f.state().query && query.value) search();
    paint(f.step(dir));
  };
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  const replaceOne = () => {
    const f = find();
    if (!f) return;
    if (!f.state().query && query.value) search();
    if (f.replace(rep.value)) paint();
  };
  const replaceAll = () => {
    const f = find();
    if (!f) return;
    if (!f.state().query && query.value) search();
    const n = f.replaceAll(rep.value);
    paint();
    if (n) notify(`${n}개를 바꿨어요. 되돌리려면 Ctrl+Z`);
  };
  one.addEventListener('click', replaceOne);
  all.addEventListener('click', replaceAll);
  more.addEventListener('click', () => setReplace(row2.hidden));
  close.addEventListener('click', () => hide({ focus: true }));
  // 막대를 눌러도 편집기의 고른 글(찾은 곳)이 풀리지 않게 — 입력 칸은 그대로 누를 수 있게
  bar.addEventListener('mousedown', (e) => {
    if (!e.target.closest('input')) e.preventDefault();
  });

  bar.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return hide({ focus: true });
    }
    if (e.key === 'F3') {
      e.preventDefault();
      return step(e.shiftKey ? -1 : 1);
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyH' || e.code === 'KeyF')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'KeyH') setReplace(row2.hidden);
      else query.select();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.target === rep) return (e.ctrlKey || e.metaKey) ? replaceAll() : replaceOne();
    step(e.shiftKey ? -1 : 1);
  });

  function setReplace(on) {
    row2.hidden = !on;
    more.setAttribute('aria-expanded', String(on));
    more.classList.toggle('active', on);
    if (on) (query.value ? rep : query).focus();
  }
  function hide({ focus = false } = {}) {
    if (bar.hidden) return false;
    bar.hidden = true;
    find()?.clear({ focus });
    onToggle(false);
    return true;
  }
  return {
    /** 연다: replace 면 바꾸기 줄까지. 고른 글이 있으면 그 글을 찾을 말로 */
    open({ replace = false } = {}) {
      const f = find();
      const picked = f?.selectedText() ?? '';
      if (picked) query.value = picked;
      const wasHidden = bar.hidden;
      bar.hidden = false;
      if (wasHidden) onToggle(true);
      setReplace(replace || !row2.hidden && !wasHidden);
      if (!replace || !query.value) {
        query.focus();
        query.select();
      }
      if (query.value) search();
      else paint();
    },
    close: hide,
    /** 다음(1) · 이전(-1) 찾은 곳 (글을 고치는 중 F3) */
    step,
    get isOpen() {
      return !bar.hidden;
    },
    /** 메모를 바꿔 열었을 때 (휴대폰): 열려 있으면 새 메모에서 같은 말을 다시 찾는다 */
    refresh() {
      if (!bar.hidden && query.value) search();
    },
    el: bar,
  };
}
