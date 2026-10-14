import { replayClass } from './dom.js';
import { actionsFor, actionButtons, actionKey } from './magic-actions.js';
import { looksLikeRef } from './core/magic-modules.js';
// 매직키 창 — 입력한 글을 바로 메모로(기본), 입력하는 대로 메모·폴더·파일을 찾아 바로 연다.
//   비어 있으면 최근 메모 · 쓰면 맨 위 "새 메모로 저장" 그 아래 메모 / 폴더 / 파일 (비슷한 것부터 몇 개씩)
//   다 못 보여 준 나머지는 맨 아래 "다른 n건 더 보기" — 고르면 전체 결과 창(모두 찾기)
//   ↑↓ 고르기 · ← → 할 일 고르기(열기 · 경로 복사 · 폴더 열기 · 파일 복사, 고른 줄 오른쪽 단추) · Enter 실행
//   Ctrl+Enter 다른 실행 · Ctrl+Shift+C 경로 복사 · Ctrl+Shift+E 폴더 열기 · Esc 글 지우기 → 닫기
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
let activeAct = 0; // 고른 줄의 몇 번째 할 일 (← →)
let seq = 0;
let results = { notes: [], folders: [], files: [], more: 0, recent: false, index: null };
// OPMS 는 회사 서버에 따로 묻는다 (메모·파일 결과를 기다리게 하지 않게) — { query, loading, cases, total, error }
let opms = { query: '', loading: false, cases: [], total: 0, error: '' };

const isOn = (id) => modules.some((m) => m.id === id && m.on);

// ---------- 아래 캡슐: 기능 켜고 끄기 ----------
function renderModules() {
  modulesEl.hidden = modules.length === 0; // 설정에서 모두 꺼 두면 캡슐 줄도 없음
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
      searchOpms();
      search();
    });
    return chip;
  }));
}

function updatePlaceholder() {
  const memo = isOn('memo');
  // 찾는 것: 켜진 기능만 이름에 (파일 검색을 껐으면 "파일" 이라고 하지 않게)
  const what = [isOn('notes') && '메모', isOn('files') && '파일', isOn('opms') && 'OPMS'].filter(Boolean).join('·');
  input.placeholder = memo && what ? `메모를 쓰거나, ${what} 찾기` : memo ? '메모를 쓰고 Enter' : what ? `${what} 찾기`
    : modules.length ? '아래 캡슐을 눌러 기능을 켜 주세요' : '설정 › 매직키에서 기능을 켜 주세요';
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

// Ctrl+Enter 로 하는 다른 실행
const ALT_ACTION = { new: 'saveOpen', folder: 'reveal', file: 'reveal' };

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
  li.append(ico, txt, side, actionButtons(r, 0, (k) => run(index, { act: k })));
  if (r.kind === 'opms') {
    ico.textContent = 'O';
    t.append(highlighted([r.ourref, r.n_app].filter(Boolean).join(', ') || r.yourref || '관리번호 없음', query));
    s.textContent = [r.applicant, r.title].filter(Boolean).join(', ');
    side.textContent = r.div || '';
  } else if (r.kind === 'more') {
    ico.textContent = '⋯';
    t.textContent = `다른 ${r.count.toLocaleString()}건 더 보기`;
    s.textContent = '모두 찾기 창에서 비슷한 것부터 전부 보여 줘요 (이름, 경로, 크기, 고친 때)';
  } else if (r.kind === 'new') {
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
  li.addEventListener('click', (e) => run(index, { alt: e.ctrlKey || e.metaKey, act: index === selected ? activeAct : 0 }));
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
  // 관리번호·출원번호를 쓰면 OPMS 사건이 맨 위 (찾는 중 · 사내망이 아님도 이 자리에)
  if (query && isOn('opms') && opms.query === query) {
    if (opms.cases.length) {
      nodes.push(section('OPMS', opms.total));
      opms.cases.forEach((c) => add({ kind: 'opms', ...c }));
    } else if (opms.loading) nodes.push(note('OPMS 에서 찾는 중…'));
    else if (opms.error) nodes.push(note(opms.error));
  }
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
  if (query && results.more > 0) add({ kind: 'more', count: results.more });
  const searched = isOn('notes') || isOn('files');
  if (query && searched && !results.notes.length && !results.folders.length && !results.files.length && !opms.cases.length && !opms.loading) {
    nodes.push(note(isOn('memo') ? `'${query.slice(0, 30)}'와 맞는 메모나 파일이 없어요. Enter 로 메모를 저장할 수 있어요` : `'${query.slice(0, 30)}'와 맞는 메모나 파일이 없어요`));
  }
  if (query && isOn('files') && results.index && !results.index.count) {
    nodes.push(note(results.index.building ? '파일 목록을 만드는 중이에요 — 처음 한 번만, 잠시 뒤 파일도 찾아져요' : '파일 목록이 아직 없어요'));
  }
  resultsEl.replaceChildren(...nodes);
  box.classList.toggle('has-results', nodes.length > 0);
  clearBtn.hidden = !raw;
  // 남겨 둔 지난 글로 다시 띄운 경우 첫 줄("메모로 저장")이 아니라 찾은 결과를 골라 둔다 (Enter 로 같은 메모를 또 만들지 않게)
  if (retained && selected === 0 && rows[0]?.kind === 'new' && rows.length > 1) selected = 1;
  // 쓴 글이 이미 있는 메모 제목과 똑같으면 그 메모를 골라 둔다 (Enter 로 같은 이름의 메모를 또 만들지 않게 — 새로 만들려면 ↑)
  const same = (t) => String(t ?? '').trim().toLowerCase() === query.trim().toLowerCase();
  if (!retained && selected === 0 && rows[0]?.kind === 'new') {
    const hit = rows.findIndex((r) => r.kind === 'note' && same(r.title));
    if (hit > 0) selected = hit;
  }
  select(Math.min(selected, Math.max(0, rows.length - 1)), { scroll: false });
  fit();
}

function fit() {
  requestAnimationFrame(() => api.resize(Math.ceil(box.getBoundingClientRect().height) + 16));
}

function select(i, { scroll = true } = {}) {
  if (i !== selected) activeAct = 0;
  selected = i;
  for (const el of resultsEl.querySelectorAll('.magic-row')) el.setAttribute('aria-selected', String(Number(el.dataset.index) === i));
  markAct();
  input.setAttribute('aria-activedescendant', rows[i] ? `magic-row-${i}` : '');
  if (scroll) resultsEl.querySelector(`.magic-row[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  updateHint();
}

// 고른 줄의 할 일 단추 중 지금 것 표시
function markAct() {
  const li = resultsEl.querySelector(`.magic-row[data-index="${selected}"]`);
  li?.querySelectorAll('.act-btn').forEach((b, k) => {
    b.classList.toggle('on', k === activeAct);
    b.setAttribute('aria-pressed', String(k === activeAct));
  });
}

function updateHint() {
  const r = rows[selected];
  // 중요한 것부터 (자리가 모자라면 뒤의 것이 가려진다)
  const parts = [];
  if (r) {
    const acts = actionsFor(r);
    parts.push(['↵', acts[activeAct]?.label ?? '']);
    if (acts.length > 1) parts.push(['← →', '할 일']);
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
    results = { notes: [], folders: [], files: [], more: 0, recent: false, index: null };
    render();
    return;
  }
  const res = await api.search(query).catch(() => null);
  if (my !== seq || !res) return; // 더 새 입력이 있으면 버린다
  results = { notes: [], folders: [], files: [], more: 0, recent: false, ...res };
  render();
}

// OPMS: 치는 동안은 기다렸다가(0.35초) 한 번만 — 관리번호·출원번호처럼 보일 때만
let opmsTimer = 0;
let opmsSeq = 0;
function searchOpms() {
  const query = input.value.trim();
  clearTimeout(opmsTimer);
  if (!isOn('opms') || !looksLikeRef(query)) {
    opms = { query: '', loading: false, cases: [], total: 0, error: '' };
    return;
  }
  if (opms.query === query && !opms.loading) return;
  opms = { query, loading: true, cases: [], total: 0, error: '' };
  const my = ++opmsSeq;
  opmsTimer = setTimeout(async () => {
    const res = await api.opmsSearch(query).catch((err) => ({ cases: [], total: 0, error: err.message }));
    if (my !== opmsSeq) return;
    opms = { query, loading: false, cases: res.cases ?? [], total: res.total ?? 0, error: res.error ?? '' };
    render();
  }, 350);
}

let searchTimer = 0;
input.addEventListener('input', () => {
  resizeInput();
  selected = 0;
  searchOpms();
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

// 실행: act = 고른 할 일(몇 번째), alt = Ctrl+Enter (다른 실행)
async function run(i, { alt = false, act = 0 } = {}) {
  const r = rows[i];
  if (!r) return;
  const acts = actionsFor(r);
  const id = (alt && ALT_ACTION[r.kind]) || acts[act]?.id || acts[0]?.id;
  if (r.kind === 'new') {
    const text = input.value;
    await api.run({ module: 'memo', text, open: id === 'saveOpen' }).catch(() => {});
    input.value = '';
    api.close();
    return;
  }
  if (r.kind === 'more') {
    await api.openAll(input.value.trim()).catch(() => {});
    return;
  }
  const req = r.kind === 'note' ? { action: id, id: r.id } : r.kind === 'opms' ? { action: id, opms: r.idx } : { action: id, path: r.path };
  const res = await api.act(req).catch(() => null);
  if (res?.message) {
    flash(res.ok, res.message);
    if (res.ok) setTimeout(() => api.close(), 650); // 복사했다는 표시를 잠깐 보여 주고
    return;
  }
  if (res?.ok) api.close();
}

// 아래 안내 자리에 잠깐 (복사했어요 · 찾을 수 없어요)
function flash(ok, text) {
  const span = document.createElement('span');
  span.className = `magic-flash${ok ? '' : ' err'}`;
  span.textContent = `${ok ? '✓ ' : ''}${text}`;
  hintEl.replaceChildren(span);
}

input.addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 한글 조합 중
  if (e.key === 'Escape') {
    e.preventDefault();
    // 먼저 글을 지우고, 비어 있으면 닫는다 — 남겨 둔 지난 글을 그대로 둔 채면 한 번에 닫는다 (글은 다음에도 남음)
    if (input.value && !retained) clearText();
    else api.close();
    return;
  }
  if (e.key !== 'Enter' && e.key !== 'Tab') retained = false; // 고르거나 고치기 시작하면 이제 이번 글
  const oneLine = !input.value.includes('\n');
  if (oneLine && rows[selected]) {
    const k = actionKey(e, { row: rows[selected], active: activeAct, input });
    if (k) {
      e.preventDefault();
      if (k.run) run(selected, { act: actionsFor(rows[selected]).findIndex((a) => a.id === k.run) });
      else {
        activeAct = k.move;
        markAct();
        updateHint();
      }
      return;
    }
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && oneLine && rows.length) {
    e.preventDefault();
    select((selected + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    return;
  }
  if (e.key === 'Enter') {
    if (e.shiftKey) return; // 줄바꿈
    e.preventDefault();
    if (rows.length) run(selected, { alt: e.ctrlKey || e.metaKey, act: activeAct });
  }
});

// 창이 다시 떠오를 때마다 포커스 (늘 떠 있다가 보였다 숨었다 한다) — 지난번에 친 글은 남겨 두고 통째로 골라 둔다:
//   이어서 찾으려면 그대로 Enter · 방향키, 새로 찾으려면 바로 치면 바뀐다 (메모로 저장한 글은 그때 비움)
let retained = false; // 다시 띄웠을 때 남겨 둔 지난 글 (아직 손대지 않음)
async function reset() {
  selected = 0;
  retained = Boolean(input.value.trim());
  activeAct = 0;
  // 지난 글이 남아 있으면 그 결과도 새 결과가 올 때까지 그대로 (비었다가 다시 채워지며 깜박이지 않게)
  if (!input.value.trim()) {
    results = { notes: [], folders: [], files: [], more: 0, recent: false, index: null };
    opms = { query: '', loading: false, cases: [], total: 0, error: '' };
  }
  resizeInput();
  modules = await api.modules().catch(() => []);
  renderModules();
  updatePlaceholder();
  render();
  search(); // 지난 글로 다시 찾기 (비어 있으면 최근 메모)
  replayClass(box, 'enter');
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}
api.onShow(reset);
api.onModules?.((list) => {
  modules = list ?? [];
  renderModules();
  updatePlaceholder();
  search();
});
reset();
