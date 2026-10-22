// PC 메모 창(note.js)과 휴대폰 메모 화면(android/web/js/note-view.js)이 같이 쓰는 화면 조각.
// 두 쪽의 HTML 이 같은 id · data- 속성을 쓰는 부분만 여기에 두고, 여는 방법 · 위치 · 알림처럼 기기마다 다른 것은 받아서 쓴다.
import { icon } from './icons.js';
import { tableBarState, tableCommandFor } from './core/table-bar.js';

const sameColor = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// ---------- 표 막대 ----------

function setLabel(b, label, title) {
  b.querySelector('.lbl').textContent = label;
  b.title = title;
  b.setAttribute('aria-label', `${b.closest('.tb-group')?.getAttribute('aria-label') ?? ''} ${label}`.trim());
}

/** 표 막대 버튼을 지금 표 상태에 맞춘다 (막대를 보이고 숨기는 것은 부르는 쪽이) */
export function paintTableBar(bar, table) {
  const s = tableBarState(table);
  const btn = (name) => bar.querySelector(`[data-table="${name}"]`);
  for (const name of ['delRow', 'delCol']) {
    const b = btn(name);
    b.disabled = s[name].disabled;
    b.dataset.wholeTable = s[name].whole ? '1' : '';
    setLabel(b, s[name].label, s[name].title);
  }
  const merge = btn('merge');
  merge.disabled = s.merge.disabled;
  setLabel(merge, s.merge.label, s.merge.title);
  btn('accent').setAttribute('aria-pressed', String(s.accent));
  const split = btn('splitTable');
  split.disabled = s.split.disabled;
  split.title = s.split.title;
  const join = btn('joinTable');
  join.disabled = s.join.disabled;
  join.title = s.join.title;
}

/** 표 막대 누르기: 편집기 커서가 표 안에 남게 하고, 누른 버튼의 명령을 run(명령, 버튼)으로 */
export function bindTableBar(bar, run) {
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-table]');
    if (!b || b.disabled) return;
    run(tableCommandFor(b.dataset.table, b.dataset.wholeTable === '1'), b);
  });
}

// ---------- 글자 색 · 형광펜 색판 ----------

/**
 * 색판 (#palette · #palette-title · #palette-swatches · #palette-clear · [data-bar] 색 띠)
 * palettes: { color, highlight } 마다 { title, colors, apply(색|null) } · place(판, 기준 버튼): 판을 띄울 자리 · afterApply(): 고른 뒤 할 일
 */
export function createPalette({ palette, palettes, place, afterApply = () => {} }) {
  const $ = (x) => document.getElementById(x);
  // 마지막으로 쓴 색 (이 기기에서만 기억하는 편의 설정)
  const last = { color: palettes.color.colors[0].value, highlight: palettes.highlight.colors[0].value };
  try {
    Object.assign(last, JSON.parse(localStorage.getItem('memoking.lastColor') ?? '{}'));
  } catch {
    // 저장소를 못 쓰면 기본색
  }
  // 지금 커서 · 고른 글자에 칠해진 색 (showActive 가 채움) — 판에서 같은 색을 다시 누르면 지우고, 판에 지금 색을 표시
  const applied = { color: null, highlight: null };
  let kind = null;

  const paintBars = () => {
    for (const bar of document.querySelectorAll('[data-bar]')) bar.style.background = last[bar.dataset.bar];
  };

  function open(which, anchor) {
    const def = palettes[which];
    kind = which;
    $('palette-title').textContent = def.title;
    $('palette-swatches').replaceChildren(...def.colors.map(({ name, value }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'palette-swatch';
      b.dataset.color = value;
      b.title = name;
      b.setAttribute('aria-label', `${def.title} ${name}`);
      // 글자 색: 흰 칩 위에 그 색으로 쓴 A / 형광펜: 그 색 바탕
      if (which === 'color') {
        b.textContent = 'A';
        b.classList.add('text-sample');
        b.style.color = value;
      } else b.style.background = value;
      b.setAttribute('aria-checked', String(sameColor(value, applied[which] ?? last[which])));
      if (sameColor(value, applied[which])) b.title = `${name} (다시 누르면 색을 지워요)`;
      return b;
    }));
    palette.hidden = false;
    place(palette, anchor);
  }

  /** 닫았으면 true (이미 닫혀 있었으면 false) */
  function close() {
    if (palette.hidden) return false;
    palette.hidden = true;
    kind = null;
    return true;
  }

  function choose(color) {
    const k = kind;
    if (!k) return;
    if (color && sameColor(color, applied[k])) color = null; // 지금 칠해진 색을 다시 고르면 지운다
    if (color) {
      last[k] = color;
      try {
        localStorage.setItem('memoking.lastColor', JSON.stringify(last));
      } catch {
        // 무시
      }
      paintBars();
    }
    palettes[k].apply(color);
    close();
    afterApply();
  }

  palette.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 선택 유지
  palette.addEventListener('click', (e) => {
    // 색 칩만 (판 밖의 [data-color] — 메모 창 자체의 메모 색 — 을 잡으면 "색 지우기"가 그 색으로 칠해 버린다)
    const swatch = e.target.closest('.palette-swatch[data-color]');
    if (swatch) choose(swatch.dataset.color);
    else if (e.target.closest('#palette-clear')) choose(null);
  });
  paintBars();

  return {
    open,
    close,
    /** 같은 색판이 열려 있으면 닫고, 아니면 연다 */
    toggle: (which, anchor) => (kind === which ? close() : open(which, anchor)),
    get kind() {
      return kind;
    },
    last,
    applied,
  };
}

// ---------- 연결한 메모 목록 한 줄 ----------

/** onOpen(): 메모 열기 · onAdd / onRemove: 연결하기 / 연결 끊기 (있을 때만 버튼) · score: 비슷한 정도 0~1 */
export function linkItem(target, { onOpen, onRemove, onAdd, score } = {}) {
  const li = document.createElement('li');
  li.className = 'link-item';
  const open = document.createElement('button');
  open.className = 'link-open';
  open.dataset.color = target.color;
  open.title = '메모 열기';
  const dot = document.createElement('span');
  dot.className = 'link-dot';
  const title = document.createElement('span');
  title.textContent = target.title;
  open.append(dot, title);
  open.addEventListener('click', onOpen);
  li.append(open);
  if (score != null) {
    const s = document.createElement('span');
    s.className = 'link-score';
    s.textContent = `${Math.round(score * 100)}%`;
    li.append(s);
  }
  const addBtn = (name, label, handler) => {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = label;
    b.setAttribute('aria-label', `${target.title} ${label}`);
    b.append(icon(name));
    b.addEventListener('click', handler);
    li.append(b);
  };
  if (onAdd) addBtn('plus', '연결하기', onAdd);
  if (onRemove) addBtn('close', '연결 끊기', onRemove);
  return li;
}

// ---------- 다른 기기에서 고친 내용 안내 막대 ----------

/** #banner 안의 #banner-text · #banner-load · #banner-keep 를 채워 띄운다 */
export function showNoteBanner(text, { load = null, keep }) {
  const $ = (x) => document.getElementById(x);
  $('banner-text').textContent = text;
  $('banner-load').hidden = !load;
  if (load) $('banner-load').textContent = load;
  $('banner-keep').textContent = keep;
  $('banner').hidden = false;
}
