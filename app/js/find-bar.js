// 메모 안 찾기 · 바꾸기 막대 (엑셀 · 워드의 "찾기 및 바꾸기"를 한 막대로) — PC 메모 창 · 휴대폰 메모 화면 공용
//   찾기만(Ctrl+F): 한 줄 — 찾을 말(대소문자 구분 · 몇 번째/모두) · 서식 · 바꾸기 펼치기 · 닫기
//   바꾸기(Ctrl+H): 엑셀처럼 찾을 말 · 바꿀 말 칸이 같은 폭으로 위아래, 칸마다 서식 단추
//     위 줄 끝은 닫기, 아래 줄 끝은 접기 · 그 아래: 모두 찾기 · 다음 찾기 · 모두 바꾸기 · 바꾸기 (모두 같은 모양)
//   서식: 찾을 서식(그 서식인 글만 · 찾을 말 없이 서식만도) · 바꿀 서식(바꾼 글에 붙임 · 바꿀 말이 비면 서식만 바꿈)
//   키: Enter 다음 · Shift+Enter 이전 (F3 · Shift+F3 도) · Alt+Enter 모두 찾기 · 바꿀 말에서 Enter 바꾸기 · Ctrl+Enter 모두 바꾸기
//       Esc 닫기(서식 칸 · 목록이 열려 있으면 그것부터) — 닫으면 찾은 곳을 고른 채 글로
//   편집기 쪽 일은 find-replace.js (editor.find)
import { icon } from './icons.js';
import { findCountText, hasFormat, formatSummary, FORMAT_FLAGS, FORMAT_COLORS } from './core/find.js';

const el = (tag, className = '', text = '') => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};
const btn = (className, text = '', title = '') => {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
};
function iconBtn(name, label, className = '') {
  const b = btn(`icon-btn mk-find-btn ${className}`.trim(), '', label);
  b.setAttribute('aria-label', label.replace(/ \(.*\)$/, ''));
  b.append(icon(name));
  return b;
}
function toggle(label, title) {
  const b = btn('mk-find-opt', label, title);
  b.setAttribute('aria-pressed', 'false');
  return b;
}
const pressed = (b) => b.getAttribute('aria-pressed') === 'true';

/** 서식 단추 안의 "가" 미리 보기 — 고른 서식을 그대로 입혀 보인다 (엑셀의 미리 보기 칸처럼) */
function paintPreview(glyph, f) {
  const s = glyph.style;
  s.fontWeight = f.bold ? '800' : '';
  s.fontStyle = f.italic ? 'italic' : '';
  s.textDecoration = [f.underline && 'underline', f.strike && 'line-through'].filter(Boolean).join(' ');
  s.fontFamily = f.code ? 'var(--font-mono, ui-monospace, monospace)' : '';
  s.color = f.color && f.color !== 'any' ? f.color : '';
  s.background = f.highlight && f.highlight !== 'any' ? f.highlight : f.highlight === 'any' ? 'var(--mk-find-any-hl)' : '';
}

/**
 * @param {{ host: HTMLElement, after?: HTMLElement|null, find: () => any, notify?: (text: string, o?: { undo?: () => void }) => void, onToggle?: (open: boolean) => void, onReplace?: () => void }} o
 *   host · after: 막대를 둘 곳 — 화면 위 막대(after) 바로 아래에 끼워 글을 아래로 밀어낸다 (글을 가리지 않게)
 *   find: 지금 편집기의 editor.find (메모를 바꿔 열면 새 편집기) · notify: "3곳을 바꿨어요" 같은 알림
 *   onReplace: 바꾸기를 펼칠 때 (휴대폰: 다이얼이 옮기기 · 그리기여도 글 고치기로 — 바꿀 수 있게)
 */
export function createFindBar({ host, after = null, find, notify = () => {}, onToggle = () => {}, onReplace = () => {} }) {
  const bar = el('div', 'mk-find-bar');
  bar.setAttribute('role', 'search');
  bar.setAttribute('aria-label', '메모 안 찾기, 바꾸기');
  bar.dataset.mode = 'find';
  bar.hidden = true;

  // ---------- 칸: 찾을 말 · 바꿀 말 (같은 폭 — 한 격자에 위아래로) ----------
  const grid = el('div', 'mk-find-grid');
  const field = (iconName, placeholder, area) => {
    const f = el('label', 'mk-find-field');
    f.style.gridArea = area;
    f.append(icon(iconName));
    const input = el('input', 'mk-find-input');
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    f.append(input);
    return { f, input };
  };
  const q = field('search', '찾을 말', 'q');
  const query = q.input;
  query.type = 'search';
  query.enterKeyHint = 'search';
  // 대소문자 구분: 칸 안의 아이콘 (켜면 노랗게)
  const caseOpt = iconBtn('case', '대소문자 구분: 영어 대문자와 소문자를 다르게 찾기', 'mk-find-case');
  caseOpt.setAttribute('aria-pressed', 'false');
  // 몇 번째/모두 — 누르면 모두 찾기 목록
  const count = btn('mk-find-count', '', '모두 찾기: 찾은 곳을 목록으로 (Alt+Enter)');
  count.setAttribute('aria-live', 'polite');
  q.f.append(count, caseOpt);
  const r = field('pen', '바꿀 말', 'r');
  const rep = r.input;
  rep.type = 'text';
  r.f.classList.add('mk-find-rep');

  // 서식 단추: "가" 미리 보기 + 서식 (고르면 그 모양으로)
  const fmtBtn = (area, label) => {
    const b = btn('mk-find-fmt', '', label);
    b.style.gridArea = area;
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    const glyph = el('span', 'mk-find-glyph', '가');
    b.append(glyph, el('span', 'mk-find-fmt-label', '서식'));
    b.glyph = glyph;
    return b;
  };
  const qFmtBtn = fmtBtn('qf', '찾을 서식: 이 서식인 글만 찾기');
  const rFmtBtn = fmtBtn('rf', '바꿀 서식: 바꾼 글에 붙일 서식');
  rFmtBtn.classList.add('mk-find-rfmt');

  // 바꾸기 펼치기 · 접기: 아래 · 위 꺾쇠 (펼치면 바꿀 말 줄 끝으로 내려간다) — 이전 · 다음은 Enter · Shift+Enter, 다음 찾기 단추
  const more = iconBtn('chev-right', '바꾸기 펼치기 (Ctrl+H)', 'mk-find-more');
  more.style.gridArea = 'more';
  more.setAttribute('aria-expanded', 'false');
  const close = iconBtn('close', '닫기 (Esc)', 'mk-find-close');
  close.style.gridArea = 'close';
  grid.append(q.f, qFmtBtn, more, close, r.f, rFmtBtn);

  // ---------- 바꾸기 펼쳤을 때 아래: 찾는 방법 · 할 일 ----------
  const foot = el('div', 'mk-find-foot');
  const acts = el('div', 'mk-find-acts');
  // 찾기 둘(왼쪽) · 바꾸기 둘(오른쪽) — 넷 다 같은 모양 (하나만 튀지 않게)
  const findAll = btn('btn mk-find-act', '모두 찾기', '찾은 곳을 모두 목록으로 (Alt+Enter)');
  const findNext = btn('btn mk-find-act', '다음 찾기', '다음 찾은 곳으로 (Enter)');
  const all = btn('btn mk-find-act mk-find-all', '모두 바꾸기', '찾은 곳을 모두 한 번에 바꾸기 (Ctrl+Enter), 되돌리기는 Ctrl+Z 한 번');
  const one = btn('btn mk-find-act', '바꾸기', '지금 찾은 곳 하나를 바꾸고 다음으로 (Enter)');
  const findPair = el('div', 'mk-find-pair');
  findPair.append(findAll, findNext);
  const repPair = el('div', 'mk-find-pair');
  repPair.append(all, one);
  acts.append(findPair, repPair);
  foot.append(acts);

  // ---------- 모두 찾기 목록 ----------
  const results = el('div', 'mk-find-results');
  results.hidden = true;
  const resultsHead = el('div', 'mk-find-results-head');
  const list = el('ol', 'mk-find-list');
  results.append(resultsHead, list);

  // ---------- 서식 고르기 (찾을 서식 · 바꿀 서식이 같은 칸을 쓴다) ----------
  const pop = el('div', 'mk-find-pop');
  pop.setAttribute('role', 'dialog');
  pop.tabIndex = -1;
  pop.hidden = true;
  const popTitle = el('div', 'mk-find-pop-title');
  const flagRow = el('div', 'mk-find-pop-flags');
  const flagBtns = FORMAT_FLAGS.map((k) => {
    const b = toggle('', k.label);
    b.classList.add('mk-find-flag', `is-${k.key}`);
    b.dataset.key = k.key;
    b.append(el(k.key === 'code' ? 'code' : 'span', '', k.label));
    flagRow.append(b);
    return b;
  });
  const rowsByKey = {}; // 글자 색 · 형광펜 줄 (상관없음 · 아무 색 단추)
  const colorRows = FORMAT_COLORS.map((k) => {
    const row = el('div', 'mk-find-pop-colors');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', k.label);
    row.append(el('span', 'mk-find-pop-label', k.label));
    const choice = (value, label, swatch) => {
      const b = btn(swatch ? 'mk-find-swatch' : 'mk-find-opt mk-find-choice', swatch ? '' : label, label);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', label);
      b.dataset.value = value ?? '';
      if (swatch) b.style.setProperty('--sw', value);
      if (swatch && k.key === 'color') b.classList.add('ink');
      row.append(b);
      return b;
    };
    const none = choice(null, '상관없음');
    const any = choice('any', '아무 색');
    for (const c of k.colors) choice(c.value, c.name, true);
    rowsByKey[k.key] = { row, none, any };
    return row;
  });
  const clearOpt = toggle('원래 서식 지우고 붙이기', '바꾼 글의 원래 서식(굵게 · 색 등)을 모두 지우고 고른 서식만 남기기');
  clearOpt.classList.add('mk-find-clear');
  const popFoot = el('div', 'mk-find-pop-foot');
  const popReset = btn('btn mk-find-act', '서식 없음', '고른 서식을 모두 풀기');
  const popDone = btn('btn primary mk-find-act', '확인');
  popFoot.append(popReset, popDone);
  pop.append(popTitle, flagRow, ...colorRows, clearOpt, popFoot);

  bar.append(grid, foot, results, pop);
  if (after?.parentElement === host) after.after(bar);
  else host.append(bar);

  // ---------- 상태 ----------
  const formats = { find: {}, rep: {} }; // 찾을 서식 · 바꿀 서식
  let popFor = null; // 'find' | 'rep'
  const findOpts = () => ({ caseSensitive: pressed(caseOpt), format: formats.find });
  const searching = () => Boolean(query.value) || hasFormat(formats.find);

  function paintFmtBtn(b, f, empty) {
    const on = hasFormat(f);
    b.classList.toggle('set', on);
    paintPreview(b.glyph, f);
    const summary = formatSummary(f);
    b.querySelector('.mk-find-fmt-label').textContent = '서식';
    b.title = on ? `${b === qFmtBtn ? '찾을' : '바꿀'} 서식: ${summary}` : empty;
    b.setAttribute('aria-label', on ? `${b === qFmtBtn ? '찾을' : '바꿀'} 서식, ${summary}` : empty);
  }
  function paint(f = find()?.state()) {
    const n = f?.matches.length ?? 0;
    const label = query.value || (hasFormat(formats.find) ? '서식' : '');
    count.textContent = findCountText(f?.current ?? -1, n, label);
    count.disabled = n === 0;
    bar.classList.toggle('none', searching() && !n);
    findNext.disabled = findAll.disabled = n === 0;
    const editable = find()?.editable !== false;
    one.disabled = all.disabled = n === 0 || !editable;
    all.textContent = n > 1 ? `모두 바꾸기 (${n})` : '모두 바꾸기';
    rep.disabled = rFmtBtn.disabled = !editable;
    rep.placeholder = editable ? (hasFormat(formats.rep) ? '비우면 서식만 바꿔요' : '바꿀 말') : '읽기 전용이라 바꿀 수 없어요';
    paintFmtBtn(qFmtBtn, formats.find, '찾을 서식: 이 서식인 글만 찾기');
    paintFmtBtn(rFmtBtn, formats.rep, '바꿀 서식: 바꾼 글에 붙일 서식');
    if (!results.hidden) paintResults(f);
  }

  function paintResults(f = find()?.state()) {
    const items = find()?.results() ?? [];
    resultsHead.textContent = items.length ? `${items.length}곳 찾음` : '찾은 곳이 없어요';
    list.replaceChildren(...items.map((it) => {
      const li = el('li');
      const b = btn('mk-find-item');
      b.dataset.i = String(it.i);
      if (it.i === f?.current) b.setAttribute('aria-current', 'true');
      const num = el('span', 'mk-find-num', String(it.i + 1));
      const line = el('span', 'mk-find-line');
      line.append(
        el('span', 'mk-find-ctx', it.before),
        el('mark', 'mk-find-mark', it.hit || ' '),
        el('span', 'mk-find-ctx', it.after),
      );
      line.classList.toggle('cut-start', it.cutStart);
      b.append(num, line);
      li.append(b);
      return li;
    }));
    list.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
  }
  function setResults(on) {
    results.hidden = !on;
    count.setAttribute('aria-expanded', String(on));
    findAll.classList.toggle('active', on);
    if (on) paintResults();
  }

  let timer = 0;
  const search = () => {
    clearTimeout(timer);
    const f = find();
    if (!f) return;
    paint(f.set(query.value, findOpts()));
  };
  query.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 90);
  });
  rep.addEventListener('input', () => paint());
  caseOpt.addEventListener('click', () => {
    caseOpt.setAttribute('aria-pressed', String(!pressed(caseOpt)));
    search();
  });
  const ensure = (f) => {
    if (!f.state().query && searching()) search();
  };
  const step = (dir) => {
    const f = find();
    if (!f) return;
    ensure(f);
    paint(f.step(dir));
  };
  findNext.addEventListener('click', () => step(1));
  const replaceOne = () => {
    const f = find();
    if (!f) return;
    ensure(f);
    if (f.replace(rep.value, formats.rep)) paint();
  };
  const replaceAll = () => {
    const f = find();
    if (!f) return;
    ensure(f);
    const n = f.replaceAll(rep.value, formats.rep);
    paint();
    // 되돌리기: PC 는 Ctrl+Z, 휴대폰은 알림의 되돌리기 단추 (undo)
    if (n) notify(`${n}곳을 바꿨어요`, { undo: () => f.undoAll() && (f.set(query.value, findOpts()), paint()) });
  };
  const toggleResults = () => {
    const f = find();
    if (f) ensure(f);
    setResults(results.hidden);
  };
  one.addEventListener('click', replaceOne);
  all.addEventListener('click', replaceAll);
  findAll.addEventListener('click', toggleResults);
  count.addEventListener('click', toggleResults);
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.mk-find-item');
    if (b) paint(find()?.go(Number(b.dataset.i)));
  });
  more.addEventListener('click', () => setReplace(bar.dataset.mode !== 'replace'));
  close.addEventListener('click', () => hide({ focus: true }));

  // ---------- 서식 고르기 ----------
  function paintPop() {
    const f = formats[popFor];
    const isFind = popFor === 'find';
    popTitle.textContent = isFind ? '찾을 서식' : '바꿀 서식';
    pop.setAttribute('aria-label', popTitle.textContent);
    for (const b of flagBtns) b.setAttribute('aria-pressed', String(Boolean(f[b.dataset.key])));
    for (const k of FORMAT_COLORS) {
      const { row, none, any } = rowsByKey[k.key];
      none.textContent = isFind ? '상관없음' : '그대로';
      none.setAttribute('aria-label', none.textContent);
      none.title = isFind ? '색은 따지지 않기' : '색은 바꾸지 않기';
      any.hidden = !isFind; // 아무 색이든은 찾을 때만 (붙일 때는 색을 골라야)
      const v = f[k.key] ?? '';
      for (const b of row.querySelectorAll('[role="radio"]')) b.setAttribute('aria-checked', String(b.dataset.value === v));
    }
    clearOpt.hidden = isFind;
    clearOpt.setAttribute('aria-pressed', String(Boolean(f.clear)));
  }
  function openPop(which, anchor) {
    popFor = which;
    paintPop();
    pop.hidden = false;
    for (const b of [qFmtBtn, rFmtBtn]) b.setAttribute('aria-expanded', String(b === anchor));
    // 누른 서식 단추 바로 아래, 오른쪽 끝을 단추에 맞추되 막대 밖으로 나가지 않게
    const br = bar.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.top = `${ar.bottom - br.top + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(ar.right - br.left - w, br.width - w - 8))}px`;
    pop.focus({ preventScroll: true }); // 칸 자체로 (Tab 으로 안의 단추를 고른다 · 누른 단추에 테두리가 남지 않게)
  }
  function closePop({ focus = true } = {}) {
    if (pop.hidden) return false;
    pop.hidden = true;
    const anchor = popFor === 'find' ? qFmtBtn : rFmtBtn;
    for (const b of [qFmtBtn, rFmtBtn]) b.setAttribute('aria-expanded', 'false');
    if (focus) anchor.focus({ preventScroll: true });
    popFor = null;
    return true;
  }
  const changed = () => {
    paintPop();
    if (popFor === 'find') search();
    else paint();
  };
  qFmtBtn.addEventListener('click', () => (popFor === 'find' ? closePop() : openPop('find', qFmtBtn)));
  rFmtBtn.addEventListener('click', () => (popFor === 'rep' ? closePop() : openPop('rep', rFmtBtn)));
  for (const b of flagBtns) {
    b.addEventListener('click', () => {
      const f = formats[popFor];
      f[b.dataset.key] = !f[b.dataset.key];
      if (!f[b.dataset.key]) delete f[b.dataset.key];
      changed();
    });
  }
  for (const k of FORMAT_COLORS) {
    rowsByKey[k.key].row.addEventListener('click', (e) => {
      const b = e.target.closest('[role="radio"]');
      if (!b) return;
      const f = formats[popFor];
      if (b.dataset.value) f[k.key] = b.dataset.value;
      else delete f[k.key];
      changed();
    });
  }
  clearOpt.addEventListener('click', () => {
    const f = formats[popFor];
    if (f.clear) delete f.clear;
    else f.clear = true;
    changed();
  });
  popReset.addEventListener('click', () => {
    formats[popFor] = {};
    changed();
  });
  popDone.addEventListener('click', () => closePop());
  // 서식 칸 밖을 누르면 닫힌다
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.('.mk-find-fmt')) closePop({ focus: false });
  }, true);

  // 막대를 눌러도 편집기의 고른 글(찾은 곳)이 풀리지 않게 — 입력 칸은 그대로 누를 수 있게
  bar.addEventListener('mousedown', (e) => {
    if (!e.target.closest('input')) e.preventDefault();
  });

  bar.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (closePop()) return;
      if (!results.hidden) return setResults(false);
      return hide({ focus: true });
    }
    if (e.key === 'F3') {
      e.preventDefault();
      return step(e.shiftKey ? -1 : 1);
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyH' || e.code === 'KeyF')) {
      e.preventDefault();
      e.stopPropagation();
      closePop({ focus: false });
      if (e.code === 'KeyH') setReplace(bar.dataset.mode !== 'replace');
      else query.select();
      return;
    }
    if (e.key !== 'Enter' || (e.target !== query && e.target !== rep)) return;
    e.preventDefault();
    if (e.altKey) return toggleResults();
    if (e.target === rep) return (e.ctrlKey || e.metaKey) ? replaceAll() : replaceOne();
    step(e.shiftKey ? -1 : 1);
  });

  function setReplace(on) {
    bar.dataset.mode = on ? 'replace' : 'find';
    more.setAttribute('aria-expanded', String(on));
    more.title = on ? '바꾸기 접기 (Ctrl+H)' : '바꾸기 펼치기 (Ctrl+H)';
    more.setAttribute('aria-label', on ? '바꾸기 접기' : '바꾸기 펼치기');
    if (!on) closePop({ focus: false });
    if (on) {
      onReplace();
      paint(); // 글 고치기로 바뀌었으면 바꿀 말 칸 · 바꾸기 단추가 바로 눌리게
      (query.value || hasFormat(formats.find) ? rep : query).focus();
    }
  }
  function hide({ focus = false } = {}) {
    if (bar.hidden) return false;
    closePop({ focus: false });
    setResults(false);
    bar.hidden = true;
    find()?.clear({ focus });
    onToggle(false);
    return true;
  }
  return {
    /** 연다: replace 면 바꾸기까지. 고른 글이 있으면 그 글을 찾을 말로 */
    open({ replace = false } = {}) {
      const f = find();
      const picked = f?.selectedText() ?? '';
      if (picked) query.value = picked;
      const wasHidden = bar.hidden;
      bar.hidden = false;
      if (wasHidden) onToggle(true);
      setReplace(replace || (bar.dataset.mode === 'replace' && !wasHidden));
      if (!replace || !query.value) {
        query.focus();
        query.select();
      }
      if (searching()) search();
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
      if (!bar.hidden && searching()) search();
    },
    el: bar,
  };
}
