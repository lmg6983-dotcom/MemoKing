// 매직키 창 — 입력한 글을 바로 메모로(기본), 입력하는 대로 메모·파일을 찾아 바로 연다.
// 결과 맨 위는 "새 메모로 저장", 그 아래 메모 검색·파일 검색 결과. ↑↓ 로 고르고 Enter.
const api = window.magic;
const input = document.getElementById('magic-input');
const resultsEl = document.getElementById('magic-results');
const modulesEl = document.getElementById('magic-modules');
const hintEl = document.getElementById('magic-hint');

const COLORS = { yellow: '#ffe58a', green: '#c8ecb4', pink: '#ffc9d6', purple: '#dccbff', blue: '#bfe0ff', gray: '#e3e3e3', charcoal: '#3b3b3b' };

let modules = [];
let rows = []; // { kind: 'new' | 'note' | 'file', ... }
let selected = 0;
let seq = 0;
let lastResults = { notes: [], files: [], index: null };

const has = (id) => modules.some((m) => m.id === id);

async function loadModules() {
  modules = await api.modules().catch(() => []);
  modulesEl.replaceChildren(...modules.map((m) => {
    const chip = document.createElement('span');
    chip.className = 'magic-chip';
    chip.textContent = m.name;
    chip.title = m.description;
    return chip;
  }));
  input.placeholder = has('memo') && (has('notes') || has('files')) ? '메모를 쓰거나 메모·파일을 찾아요'
    : has('memo') ? '메모를 입력하고 Enter' : has('notes') || has('files') ? '메모·파일 찾기' : '켜진 기능이 없어요 (설정에서 켜 주세요)';
}

// 찾은 낱말을 굵게 (글은 textContent 로만 넣는다)
function highlighted(text, query) {
  const span = document.createElement('span');
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
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

function row(r, index, query) {
  const li = document.createElement('li');
  li.className = 'magic-row';
  li.setAttribute('role', 'option');
  li.dataset.index = String(index);
  const ico = document.createElement('span');
  ico.className = 'ico';
  const txt = document.createElement('div');
  txt.className = 'txt';
  const t = document.createElement('div');
  t.className = 't';
  const s = document.createElement('div');
  s.className = 's';
  txt.append(t, s);
  li.append(ico, txt);
  if (r.kind === 'new') {
    ico.textContent = '✎';
    t.textContent = '새 메모로 저장';
    s.textContent = query.split('\n')[0];
  } else if (r.kind === 'note') {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = COLORS[r.color] ?? COLORS.yellow;
    ico.append(dot);
    t.append(highlighted(r.title || '제목 없음', query));
    s.append(highlighted(r.snippet || '', query));
  } else {
    if (r.icon) {
      const img = document.createElement('img');
      img.src = r.icon;
      img.alt = '';
      ico.append(img);
    } else ico.textContent = r.isDir ? '📁' : '📄';
    t.append(highlighted(r.name, query));
    s.textContent = r.path;
    s.title = r.path;
    if (r.app || r.isDir) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = r.app ? '프로그램' : '폴더';
      li.append(tag);
    }
  }
  li.addEventListener('mousemove', () => select(index));
  li.addEventListener('click', (e) => run(index, { ctrl: e.ctrlKey }));
  return li;
}

function section(label) {
  const li = document.createElement('li');
  li.className = 'magic-section';
  li.textContent = label;
  li.setAttribute('role', 'presentation');
  return li;
}

function render() {
  const query = input.value.trim();
  rows = [];
  const nodes = [];
  if (query && has('memo')) rows.push({ kind: 'new' });
  const notes = query ? lastResults.notes : [];
  const files = query ? lastResults.files : [];
  if (rows.length) nodes.push(row(rows[0], 0, input.value));
  if (notes.length) {
    nodes.push(section('메모'));
    for (const n of notes) nodes.push(row({ kind: 'note', ...n }, rows.push({ kind: 'note', ...n }) - 1, query));
  }
  if (files.length) {
    nodes.push(section('파일'));
    for (const f of files) nodes.push(row({ kind: 'file', ...f }, rows.push({ kind: 'file', ...f }) - 1, query));
  }
  if (query && has('files') && !files.length && lastResults.index && !lastResults.index.count) {
    const note = document.createElement('li');
    note.className = 'magic-note';
    note.textContent = lastResults.index.building ? '파일 목록을 만드는 중이에요… (처음 한 번, 잠시만)' : '파일 목록이 아직 없어요';
    nodes.push(note);
  }
  resultsEl.replaceChildren(...nodes);
  selected = Math.min(selected, Math.max(0, rows.length - 1));
  select(selected);
  updateHint();
  requestAnimationFrame(() => api.resize(document.querySelector('.magic').getBoundingClientRect().height + 16));
}

function select(i) {
  selected = i;
  for (const el of resultsEl.querySelectorAll('.magic-row')) el.setAttribute('aria-selected', String(Number(el.dataset.index) === i));
  resultsEl.querySelector(`.magic-row[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  updateHint();
}

function updateHint() {
  const r = rows[selected];
  hintEl.textContent = !r ? (has('memo') ? 'Enter 저장 · Esc 닫기' : 'Esc 닫기')
    : r.kind === 'new' ? '↑↓ 고르기 · Enter 저장 · Ctrl+Enter 저장하고 열기'
      : r.kind === 'note' ? '↑↓ 고르기 · Enter 메모 열기'
        : '↑↓ 고르기 · Enter 열기 · Ctrl+Enter 폴더에서 보기';
}

async function search() {
  const query = input.value;
  const my = ++seq;
  if (!query.trim() || (!has('notes') && !has('files'))) {
    lastResults = { notes: [], files: [], index: null };
    render();
    return;
  }
  const res = await api.search(query).catch(() => null);
  if (my !== seq || !res) return; // 더 새 입력이 있으면 버린다
  lastResults = res;
  render();
}
let searchTimer = 0;
input.addEventListener('input', () => {
  resizeInput();
  selected = 0;
  render(); // "새 메모로 저장" 줄은 바로
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 70);
});

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

async function run(i, { ctrl = false } = {}) {
  const r = rows[i];
  const text = input.value;
  if (!r) {
    if (!text.trim()) api.close();
    return;
  }
  if (r.kind === 'new') {
    try {
      await api.run({ module: 'memo', text, open: ctrl });
    } finally {
      input.value = '';
      api.close();
    }
    return;
  }
  if (r.kind === 'note') await api.openMemo(r.id);
  else await api.openFile(r.path, ctrl);
  input.value = '';
}

input.addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 한글 조합 중
  if (e.key === 'Escape') {
    e.preventDefault();
    api.close();
    return;
  }
  const oneLine = !input.value.includes('\n');
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && oneLine && rows.length) {
    e.preventDefault();
    select((selected + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    return;
  }
  if (e.key === 'Enter') {
    if (e.shiftKey) return; // 줄바꿈
    e.preventDefault();
    run(selected, { ctrl: e.ctrlKey || e.metaKey });
  }
});

// 창이 다시 떠오를 때마다 비우고 포커스 (늘 떠 있다가 보였다 숨었다 한다)
async function reset() {
  input.value = '';
  selected = 0;
  lastResults = { notes: [], files: [], index: null };
  resizeInput();
  await loadModules();
  render();
  setTimeout(() => input.focus(), 0);
}
api.onShow(reset);
reset();
