// 매직키 창 — 입력한 글을 바로 메모로(기본), 입력하는 대로 메모·폴더·파일을 찾아 바로 연다.
//   비어 있으면 최근 메모 · 쓰면 맨 위 "새 메모로 저장" 그 아래 메모 / 폴더 / 파일
//   ↑↓ 고르기 · Enter 실행(고른 줄 오른쪽에 무엇을 하는지 표시) · Ctrl+Enter 다른 실행 · Esc 글 지우기 → 닫기
//   아래 캡슐 = 기능 모듈, 누르면 켜고 끈다
const api = window.magic;
const box = document.getElementById('magic');
const input = document.getElementById('magic-input');
const clearBtn = document.getElementById('magic-clear');
const resultsEl = document.getElementById('magic-results');
const modulesEl = document.getElementById('magic-modules');
const hintEl = document.getElementById('magic-hint');

const COLORS = { yellow: '#ffe58a', green: '#c8ecb4', pink: '#ffc9d6', purple: '#dccbff', blue: '#bfe0ff', gray: '#e3e3e3', charcoal: '#3b3b3b' };

let modules = []; // { id, name, description, on }
let rows = []; // { kind: 'new' | 'note' | 'folder' | 'file', ... }
let selected = 0;
let seq = 0;
let results = { notes: [], folders: [], files: [], recent: false, index: null };

const isOn = (id) => modules.some((m) => m.id === id && m.on);

// ---------- 아래 캡슐: 기능 켜고 끄기 ----------
function renderModules() {
  modulesEl.replaceChildren(...modules.map((m) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `magic-chip${m.on ? ' on' : ''}`;
    chip.setAttribute('aria-pressed', String(m.on));
    chip.title = `${m.description}\n누르면 ${m.on ? '꺼요' : '켜요'}`;
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    chip.append(dot, m.name);
    chip.addEventListener('mousedown', (e) => e.preventDefault()); // 입력 칸 포커스 유지
    chip.addEventListener('click', async () => {
      modules = await api.toggleModule(m.id).catch(() => modules);
      renderModules();
      updatePlaceholder();
      search();
    });
    return chip;
  }));
}

function updatePlaceholder() {
  const memo = isOn('memo');
  const find = isOn('notes') || isOn('files');
  input.placeholder = memo && find ? '메모를 쓰거나, 메모·파일을 찾아요' : memo ? '메모를 쓰고 Enter' : find ? '메모·파일 찾기' : '아래에서 기능을 켜 주세요';
}

// ---------- 결과 ----------
// 찾은 낱말을 굵게 (글은 textContent 로만)
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

// "방금 · 5분 전 · 3시간 전 · 어제 · 3일 전 · 9월 2일"
function ago(iso) {
  const t = Date.parse(iso ?? '');
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.round(h / 24);
  if (d === 1) return '어제';
  if (d < 7) return `${d}일 전`;
  const date = new Date(t);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

const ACTION = { new: ['저장', '저장하고 열기'], note: ['열기', ''], folder: ['열기', '폴더에서 보기'], file: ['열기', '폴더에서 보기'] };
const actionOf = (r) => (r.kind === 'file' && r.app ? ['실행', '폴더에서 보기'] : ACTION[r.kind]);

function row(r, index, query) {
  const li = document.createElement('li');
  li.className = `magic-row kind-${r.kind}`;
  li.setAttribute('role', 'option');
  li.id = `magic-row-${index}`;
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
  const side = document.createElement('span');
  side.className = 'side';
  const act = document.createElement('span');
  act.className = 'act';
  act.innerHTML = '<kbd>↵</kbd> ';
  act.append(actionOf(r)[0]);
  li.append(ico, txt, side, act);
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
    side.textContent = ago(r.updated);
  } else {
    if (r.icon) {
      const img = document.createElement('img');
      img.src = r.icon;
      img.alt = '';
      ico.append(img);
    } else ico.textContent = r.kind === 'folder' ? '📁' : '📄';
    t.append(highlighted(r.name, query));
    s.textContent = r.where ?? r.path;
    s.title = r.path;
    if (r.app) side.textContent = '프로그램';
  }
  li.addEventListener('mousemove', () => {
    if (selected !== index) select(index);
  });
  li.addEventListener('mousedown', (e) => e.preventDefault()); // 입력 칸 포커스 유지
  li.addEventListener('click', (e) => run(index, { alt: e.ctrlKey || e.metaKey }));
  return li;
}

function section(label, count) {
  const li = document.createElement('li');
  li.className = 'magic-section';
  li.setAttribute('role', 'presentation');
  li.textContent = label;
  if (count) {
    const n = document.createElement('span');
    n.className = 'count';
    n.textContent = String(count);
    li.append(n);
  }
  return li;
}

function note(text) {
  const li = document.createElement('li');
  li.className = 'magic-note';
  li.setAttribute('role', 'presentation');
  li.textContent = text;
  return li;
}

function render() {
  const raw = input.value;
  const query = raw.trim();
  rows = [];
  const nodes = [];
  const add = (r) => nodes.push(row(r, rows.push(r) - 1, query || raw));
  if (query && isOn('memo')) add({ kind: 'new' });
  if (results.notes.length) {
    nodes.push(section(results.recent ? '최근 메모' : '메모', results.recent ? 0 : results.notes.length));
    results.notes.forEach((n) => add({ kind: 'note', ...n }));
  }
  if (query && results.folders.length) {
    nodes.push(section('폴더', results.folders.length));
    results.folders.forEach((f) => add({ kind: 'folder', ...f }));
  }
  if (query && results.files.length) {
    nodes.push(section('파일', results.files.length));
    results.files.forEach((f) => add({ kind: 'file', ...f }));
  }
  const searched = isOn('notes') || isOn('files');
  if (query && searched && !results.notes.length && !results.folders.length && !results.files.length) {
    nodes.push(note(isOn('memo') ? `'${query.slice(0, 30)}'와 맞는 메모·파일이 없어요 — Enter 로 메모를 저장할 수 있어요` : `'${query.slice(0, 30)}'와 맞는 메모·파일이 없어요`));
  }
  if (query && isOn('files') && results.index && !results.index.count) {
    nodes.push(note(results.index.building ? '파일 목록을 만드는 중이에요 — 처음 한 번만, 잠시 뒤 파일도 찾아져요' : '파일 목록이 아직 없어요'));
  }
  resultsEl.replaceChildren(...nodes);
  box.classList.toggle('has-results', nodes.length > 0);
  clearBtn.hidden = !raw;
  select(Math.min(selected, Math.max(0, rows.length - 1)), { scroll: false });
  fit();
}

function fit() {
  requestAnimationFrame(() => api.resize(Math.ceil(box.getBoundingClientRect().height) + 16));
}

function select(i, { scroll = true } = {}) {
  selected = i;
  for (const el of resultsEl.querySelectorAll('.magic-row')) el.setAttribute('aria-selected', String(Number(el.dataset.index) === i));
  input.setAttribute('aria-activedescendant', rows[i] ? `magic-row-${i}` : '');
  if (scroll) resultsEl.querySelector(`.magic-row[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  updateHint();
}

function updateHint() {
  const r = rows[selected];
  // 중요한 것부터 (자리가 모자라면 뒤의 것이 가려진다)
  const parts = [];
  if (r) {
    const [main, alt] = actionOf(r);
    parts.push(['↵', main]);
    if (alt) parts.push(['Ctrl ↵', alt]);
  }
  parts.push(['Esc', input.value ? '지우기' : '닫기']);
  if (rows.length > 1) parts.push(['↑↓', '고르기']);
  if (r?.kind === 'new') parts.push(['Shift ↵', '줄바꿈']);
  hintEl.replaceChildren(...parts.map(([k, label]) => {
    const span = document.createElement('span');
    const kbd = document.createElement('kbd');
    kbd.textContent = k;
    span.append(kbd, ` ${label}`);
    return span;
  }));
}

async function search() {
  const query = input.value;
  const my = ++seq;
  if (!isOn('notes') && !isOn('files')) {
    results = { notes: [], folders: [], files: [], recent: false, index: null };
    render();
    return;
  }
  const res = await api.search(query).catch(() => null);
  if (my !== seq || !res) return; // 더 새 입력이 있으면 버린다
  results = { notes: [], folders: [], files: [], recent: false, ...res };
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
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function clearText() {
  input.value = '';
  selected = 0;
  resizeInput();
  render();
  search();
  input.focus();
}
clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
clearBtn.addEventListener('click', clearText);

async function run(i, { alt = false } = {}) {
  const r = rows[i];
  if (!r) return;
  if (r.kind === 'new') {
    const text = input.value;
    await api.run({ module: 'memo', text, open: alt }).catch(() => {});
    input.value = '';
    api.close();
    return;
  }
  if (r.kind === 'note') await api.openMemo(r.id);
  else await api.openFile(r.path, alt);
  input.value = '';
}

input.addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 한글 조합 중
  if (e.key === 'Escape') {
    e.preventDefault();
    if (input.value) clearText(); // 먼저 글을 지우고, 비어 있으면 닫는다
    else api.close();
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
    if (rows.length) run(selected, { alt: e.ctrlKey || e.metaKey });
  }
});

// 창이 다시 떠오를 때마다 비우고 포커스 (늘 떠 있다가 보였다 숨었다 한다)
async function reset() {
  input.value = '';
  selected = 0;
  results = { notes: [], folders: [], files: [], recent: false, index: null };
  resizeInput();
  modules = await api.modules().catch(() => []);
  renderModules();
  updatePlaceholder();
  render();
  search(); // 최근 메모
  box.classList.remove('enter');
  void box.offsetWidth;
  box.classList.add('enter');
  setTimeout(() => input.focus(), 0);
}
api.onShow(reset);
reset();
