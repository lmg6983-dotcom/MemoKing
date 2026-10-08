import { actionsFor, actionButtons, actionKey } from './magic-actions.js';
// 모두 찾기 창 — 매직키에서 "다른 n건 더 보기" 를 고르면 열린다 (Everything 처럼 한 줄씩 · 열 정렬)
//   기본은 비슷한 것부터, 열 머리를 누르면 이름 · 경로 · 크기 · 고친 때로 (한 번 더 누르면 거꾸로, 세 번째는 다시 비슷한 순)
//   ↑↓ PgUp PgDn Home End 고르기 · ← → 할 일(열기 · 경로 복사 · 폴더 열기 · 파일 복사) · Enter 실행 · 두 번 누르면 열기
//   많아도 가볍게: 보이는 줄만 그린다. 크기 · 고친 때는 보이는 줄만 물어 온다
const api = window.finder;
const input = document.getElementById('finder-input');
const tabsEl = document.getElementById('finder-tabs');
const head = document.querySelector('.finder-head');
const scroller = document.getElementById('finder-scroll');
const listEl = document.getElementById('finder-list');
const emptyEl = document.getElementById('finder-empty');
const countEl = document.getElementById('finder-count');
const statusEl = document.getElementById('finder-status');

const ROW_H = 34;
const COLORS = { yellow: '#ffe58a', green: '#c8ecb4', pink: '#ffc9d6', purple: '#dccbff', blue: '#bfe0ff', gray: '#e3e3e3', charcoal: '#3b3b3b' };

let all = []; // 찾은 것 (비슷한 순)
let total = 0; // 맞는 것 전체 (파일은 2000개까지만 받아 온다)
let kind = 'all';
let sort = null; // { key, dir } — null 이면 비슷한 순
let view = []; // 지금 보이는 순서
let selected = 0;
let activeAct = 0;
let query = '';
let seq = 0;
const stats = new Map(); // path → { size, mtime } | null
const asked = new Set();

// ---------- 글 ----------
function highlighted(text, q) {
  const span = document.createElement('span');
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let hit = null;
    for (const t of terms) {
      const k = lower.indexOf(t, i);
      if (k >= 0 && (!hit || k < hit.k)) hit = { k, len: t.length };
    }
    if (!hit) {
      span.append(text.slice(i));
      break;
    }
    if (hit.k > i) span.append(text.slice(i, hit.k));
    const b = document.createElement('b');
    b.textContent = text.slice(hit.k, hit.k + hit.len);
    span.append(b);
    i = hit.k + hit.len;
  }
  return span;
}

function sizeLabel(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} ${units[u]}`;
}

const pad = (n) => String(n).padStart(2, '0');
function timeLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const nameOf = (r) => (r.kind === 'note' ? r.title || '제목 없음' : r.name);
const whereOf = (r) => (r.kind === 'note' ? '메모' : r.where ?? r.path);
const timeOf = (r) => (r.kind === 'note' ? Date.parse(r.updated ?? '') || 0 : stats.get(r.path)?.mtime ?? 0);
const sizeOf = (r) => (r.kind === 'file' ? stats.get(r.path)?.size ?? -1 : -1);

// ---------- 목록 ----------
function rebuild({ keep = false } = {}) {
  const key = view[selected];
  view = all.filter((r) => kind === 'all' || r.kind === kind);
  if (sort) {
    const by = {
      name: (r) => nameOf(r).toLowerCase(),
      where: (r) => whereOf(r).toLowerCase(),
      size: sizeOf,
      time: timeOf,
    }[sort.key];
    const coll = new Intl.Collator('ko', { numeric: true });
    view = view.slice().sort((a, b) => {
      const x = by(a);
      const y = by(b);
      const c = typeof x === 'string' ? coll.compare(x, y) : x - y;
      return sort.dir * c;
    });
  }
  selected = keep && key ? Math.max(0, view.indexOf(key)) : 0;
  activeAct = keep ? activeAct : 0;
  listEl.style.height = `${view.length * ROW_H}px`;
  for (const b of head.querySelectorAll('[data-sort]')) {
    const on = sort?.key === b.dataset.sort;
    b.classList.toggle('sorted', on);
    b.dataset.dir = on ? (sort.dir > 0 ? 'asc' : 'desc') : '';
    b.setAttribute('aria-sort', on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  }
  const counts = { all: all.length, note: 0, folder: 0, file: 0 };
  for (const r of all) counts[r.kind]++;
  for (const t of tabsEl.querySelectorAll('[data-kind]')) {
    t.querySelector('.n').textContent = counts[t.dataset.kind] ? counts[t.dataset.kind].toLocaleString() : '';
    t.setAttribute('aria-selected', String(t.dataset.kind === kind));
  }
  countEl.textContent = !query.trim() ? '' : total > all.length ? `${total.toLocaleString()}건 중 비슷한 ${all.length.toLocaleString()}건` : `${all.length.toLocaleString()}건`;
  emptyEl.hidden = Boolean(view.length) || !query.trim();
  emptyEl.textContent = `'${query.trim().slice(0, 40)}'와 맞는 것이 없어요`;
  draw();
  if (!keep) scroller.scrollTop = 0;
  status();
}

function draw() {
  const top = scroller.scrollTop;
  const h = scroller.clientHeight;
  const from = Math.max(0, Math.floor(top / ROW_H) - 6);
  const to = Math.min(view.length, Math.ceil((top + h) / ROW_H) + 6);
  const nodes = [];
  const need = [];
  for (let i = from; i < to; i++) {
    nodes.push(rowEl(view[i], i));
    if (view[i].kind !== 'note' && !asked.has(view[i].path)) need.push(view[i].path);
  }
  listEl.replaceChildren(...nodes);
  if (need.length) loadStats(need);
}

function rowEl(r, i) {
  const el = document.createElement('div');
  el.className = `frow kind-${r.kind}`;
  el.setAttribute('role', 'option');
  el.id = `frow-${i}`;
  el.style.transform = `translateY(${i * ROW_H}px)`;
  el.setAttribute('aria-selected', String(i === selected));
  const name = document.createElement('span');
  name.className = 'col-name';
  const ico = document.createElement('span');
  ico.className = 'ico';
  if (r.kind === 'note') {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = COLORS[r.color] ?? COLORS.yellow;
    ico.append(dot);
  } else if (r.icon) {
    const img = document.createElement('img');
    img.src = r.icon;
    img.alt = '';
    ico.append(img);
  } else ico.textContent = r.kind === 'folder' ? '📁' : '📄';
  const label = document.createElement('span');
  label.className = 'nm';
  label.append(highlighted(nameOf(r), query));
  name.append(ico, label);
  if (i === selected) name.append(actionButtons(r, activeAct, (k) => run(i, k)));
  const where = document.createElement('span');
  where.className = 'col-where';
  where.textContent = whereOf(r);
  where.title = r.path ?? '';
  const size = document.createElement('span');
  size.className = 'col-size';
  size.textContent = r.kind === 'file' ? sizeLabel(stats.get(r.path)?.size) : '';
  const time = document.createElement('span');
  time.className = 'col-time';
  time.textContent = timeLabel(timeOf(r));
  el.append(name, where, size, time);
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.act-btn')) return;
    e.preventDefault();
    select(i, { scroll: false });
  });
  el.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.act-btn')) run(i, 0);
  });
  return el;
}

let statTimer = 0;
const pending = new Set();
function loadStats(paths) {
  for (const p of paths) {
    asked.add(p);
    pending.add(p);
  }
  clearTimeout(statTimer);
  statTimer = setTimeout(async () => {
    const list = [...pending];
    pending.clear();
    const my = seq;
    for (let k = 0; k < list.length; k += 200) {
      const res = await api.stat(list.slice(k, k + 200)).catch(() => ({}));
      if (my !== seq) return;
      for (const [p, st] of Object.entries(res)) stats.set(p, st);
    }
    if (sort && (sort.key === 'size' || sort.key === 'time')) rebuild({ keep: true });
    else draw();
  }, 40);
}

function select(i, { scroll = true } = {}) {
  if (!view.length) return;
  i = Math.max(0, Math.min(view.length - 1, i));
  if (i !== selected) activeAct = 0;
  selected = i;
  if (scroll) {
    const y = i * ROW_H;
    if (y < scroller.scrollTop) scroller.scrollTop = y;
    else if (y + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW_H - scroller.clientHeight;
  }
  input.setAttribute('aria-activedescendant', `frow-${i}`);
  draw();
  status();
}

function status(text, ok = true) {
  statusEl.classList.toggle('err', !ok);
  statusEl.classList.toggle('flash', Boolean(text));
  if (text) {
    statusEl.textContent = text;
    return;
  }
  const r = view[selected];
  const acts = r ? actionsFor(r) : [];
  statusEl.textContent = r ? `${r.path ?? nameOf(r)}    ↵ ${acts[activeAct]?.label ?? ''}${acts.length > 1 ? '    ← → 할 일' : ''}` : '';
}

let flashTimer = 0;
async function run(i, act = activeAct) {
  const r = view[i];
  if (!r) return;
  const id = actionsFor(r)[act]?.id ?? 'open';
  const res = await api.act(r.kind === 'note' ? { action: id, id: r.id } : { action: id, path: r.path }).catch(() => null);
  if (res?.message) {
    status(res.ok ? `✓ ${res.message}` : res.message, res.ok);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => status(), 1800);
  }
}

// ---------- 찾기 ----------
async function search() {
  query = input.value;
  const my = ++seq;
  const res = await api.search(query).catch(() => null);
  if (my !== seq || !res) return;
  all = res.items ?? [];
  total = res.total ?? all.length;
  stats.clear();
  asked.clear();
  if (!all.length && query.trim() && res.index && !res.index.count) {
    emptyEl.textContent = res.index.building ? '파일 목록을 만드는 중이에요 — 잠시 뒤 다시 찾아 보세요' : '파일 목록이 아직 없어요';
  }
  rebuild();
}

let timer = 0;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(search, 90);
});

input.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const r = view[selected];
  if (r) {
    const k = actionKey(e, { row: r, active: activeAct, input });
    if (k) {
      e.preventDefault();
      if (k.run) run(selected, actionsFor(r).findIndex((a) => a.id === k.run));
      else {
        activeAct = k.move;
        draw();
        status();
      }
      return;
    }
  }
  const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1);
  const move = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key];
  if (move && view.length) {
    e.preventDefault();
    select(selected + move);
    return;
  }
  if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey && view.length) {
    e.preventDefault();
    select(e.key === 'Home' ? 0 : view.length - 1);
    return;
  }
  if (e.key === 'Enter' && r) {
    e.preventDefault();
    run(selected, e.ctrlKey ? actionsFor(r).findIndex((a) => a.id === 'reveal') : activeAct);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (input.value) {
      input.value = '';
      search();
    } else window.close();
  }
});

tabsEl.addEventListener('click', (e) => {
  const t = e.target.closest('[data-kind]');
  if (!t) return;
  kind = t.dataset.kind;
  rebuild();
  input.focus();
});
// 열 머리: 오름 → 내림 → 비슷한 순
head.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  const key = b.dataset.sort;
  sort = sort?.key !== key ? { key, dir: key === 'size' || key === 'time' ? -1 : 1 } : sort.dir === (key === 'size' || key === 'time' ? -1 : 1) ? { key, dir: -sort.dir } : null;
  // 크기 · 고친 때로 줄 세우려면 모든 줄의 것이 있어야 한다
  if (sort && (key === 'size' || key === 'time')) loadStats(all.filter((r) => r.kind !== 'note' && !asked.has(r.path)).map((r) => r.path));
  rebuild({ keep: true });
  input.focus();
});
scroller.addEventListener('scroll', () => requestAnimationFrame(draw), { passive: true });
new ResizeObserver(() => draw()).observe(scroller);

api.onQuery((q) => {
  input.value = q;
  kind = 'all';
  sort = null;
  search();
  input.focus();
  input.setSelectionRange(q.length, q.length); // 커서는 끝 — → 로 바로 할 일을 고를 수 있게
});
