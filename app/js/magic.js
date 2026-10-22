import { replayClass } from './dom.js';
import { actionsFor, actionButtons, actionKey } from './magic-actions.js';
import { opmsQueryKind } from './core/opms-search.js';
import { calcInput, calcOutput, siteUrl, sitesInOrder, looksLikeQuestion, WEB_ENGINES, AI_SITES } from './core/magic-tools.js';
import { dateCalc } from './core/date-calc.js';
import { findDates, guessTitle } from './core/date-detect.js';
import { dayLabel, koClock } from './core/time.js';
import { isChoseongQuery, choseongRange } from './core/text-match.js';
import { searchingNode } from './searching.js';
import { COLOR_DOTS } from './core/memo-file.js';
import { UI } from './core/ui-text.js';
// 매직키 창 — 입력한 글을 바로 메모로(기본), 입력하는 대로 메모·폴더·파일을 찾아 바로 연다.
//   비어 있으면 최근 메모 · 쓰면 맨 위 "새 메모로 저장" 그 아래 메모 / 폴더 / 파일 (비슷한 것부터 몇 개씩)
//   다 못 보여 준 나머지는 맨 아래 "다른 n건 더 보기" — 고르면 전체 결과 창(모두 찾기)
//   ↑↓ 고르기 · ← → 할 일 고르기(열기 · 경로 복사 · 폴더 열기 · 파일 복사, 고른 줄 오른쪽 단추) · Enter 실행
//   Ctrl+Enter 다른 실행 · Ctrl+Shift+C 경로 복사 · Ctrl+Shift+E 폴더 열기 · Esc 글 지우기 → 닫기
//   아래 캡슐 = 기능 모듈, 누르면 켜고 끈다 · 끌면 순서를 바꾼다 (결과 묶음도 그 순서, 캡슐과 같은 색 머리말)
//   계산기: 식이면 맨 위에 결과 (Enter 복사) · 웹 검색 · AI 에게 묻기: 맨 아래 줄, 사이트 단추로 골라 브라우저로 연다
const api = window.magic;
const box = document.getElementById('magic');
const input = document.getElementById('magic-input');
const clearBtn = document.getElementById('magic-clear');
const resultsEl = document.getElementById('magic-results');
const modulesEl = document.getElementById('magic-modules');
const hintEl = document.getElementById('magic-hint');


let modules = []; // { id, name, description, on }
let rows = []; // { kind: 'new' | 'note' | 'folder' | 'file', ... }
let selected = 0;
let activeAct = 0; // 고른 줄의 몇 번째 할 일 (← →)
let seq = 0;
let results = { notes: [], folders: [], files: [], more: 0, recent: false, index: null };
// OPMS 는 회사 서버에 따로 묻는다 (메모·파일 결과를 기다리게 하지 않게) — { query, loading, cases, total, error }
let opms = { query: '', loading: false, cases: [], total: 0, error: '' };

const isOn = (id) => modules.some((m) => m.id === id && m.on);

// 움직임 (Windows 에서 애니메이션 효과를 끄면 모두 없음) — 입력 · Enter 를 늦추지 않는 짧은 것만
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let shownAt = 0; // 창을 연 때: 그 뒤 잠깐 처음 나오는 줄은 차례로 나타난다
let introFresh = false; // 연 뒤 아직 결과를 그리지 않았다 (지난번과 같은 줄도 처음처럼)
let glideUntil = 0; // 캡슐을 끌거나 끄고 켠 뒤: 자리를 옮긴 줄은 미끄러지고, 새 줄은 나타난다
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'; // 빨리 출발해 부드럽게 멈춤
const SPRING = 'cubic-bezier(0.34, 1.4, 0.64, 1)'; // 살짝 지나쳤다 돌아옴 (놓을 때 · 켤 때)
const DUR = 260;
const gliding = () => !calm.matches && Date.now() < glideUntil;

// el 을 dx, dy 만큼 떨어진 곳에서 제자리로 — 이미 움직이는 중이면 지금 보이는 자리에서 이어서
function slide(el, dx, dy, easing = EASE) {
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: DUR, easing });
}
// 결과 줄이 지금 보이는 자리 (움직이는 중이면 그 중간 — 연달아 다시 그려도 튀지 않게)
function relTop(el) {
  return el.getBoundingClientRect().top - resultsEl.getBoundingClientRect().top + resultsEl.scrollTop;
}
const positions = () => new Map([...resultsEl.children]
  .filter((el) => el.dataset.key && !el.classList.contains('ghost'))
  .map((el) => [el.dataset.key, { el, top: relTop(el) }]));

let listTarget = 0; // 결과 칸 높이가 바뀌는 중이면 다 바뀐 뒤 높이 (창 크기는 그것으로)
function animateResults(before, beforeHeight) {
  const now = Date.now();
  const intro = now - shownAt < 400;
  const glide = gliding();
  if (calm.matches || (!intro && !glide)) return;
  const seen = new Set();
  let k = 0;
  for (const el of resultsEl.children) {
    const key = el.dataset.key;
    if (!key) continue;
    seen.add(key);
    const old = before.get(key);
    if (old) {
      if (glide) slide(el, 0, old.top - relTop(el));
    } else {
      el.animate([{ opacity: 0, transform: 'translateY(-6px) scale(0.985)' }, { opacity: 1, transform: 'none' }],
        { duration: DUR, delay: intro ? Math.min(k++, 8) * 22 : 40, easing: EASE, fill: 'backwards' });
    }
  }
  if (!glide) return;
  // 빠진 줄은 그 자리에서 흐려지며 사라진다 (바로 없어지지 않게)
  for (const [key, { el, top }] of before) {
    if (seen.has(key)) continue;
    el.getAnimations().forEach((a) => a.cancel());
    el.classList.add('ghost');
    el.removeAttribute('id');
    el.removeAttribute('data-index');
    el.setAttribute('aria-hidden', 'true');
    el.style.top = `${top}px`;
    resultsEl.append(el);
    el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }], { duration: 180, easing: 'ease-out', fill: 'forwards' })
      .onfinish = () => el.remove();
  }
  // 결과 칸 높이도 미끄러지듯 (창 아래 캡슐 줄이 툭 튀지 않게)
  const h = resultsEl.getBoundingClientRect().height;
  if (Math.abs(h - beforeHeight) > 1) {
    listTarget = h;
    resultsEl.style.overflow = 'hidden';
    const a = resultsEl.animate([{ height: `${beforeHeight}px` }, { height: `${h}px` }], { duration: DUR, easing: EASE });
    a.onfinish = a.oncancel = () => {
      resultsEl.style.overflow = '';
      listTarget = 0;
    };
  }
}

// 웹 검색 · AI 기본 사이트 (설정 매직키에서 고름)
let prefs = { engine: WEB_ENGINES[0].id, ai: AI_SITES[0].id };
async function loadPrefs() {
  prefs = { ...prefs, ...(await api.prefs?.().catch(() => null)) };
}

// 계산기: math.js 는 크니(0.6MB) 매직키 창이 처음 뜰 때 뒤에서 불러 둔다 (계산기를 켰을 때만)
let math = null;
let mathLoading = null;
function loadMath() {
  mathLoading ??= import('../vendor/mathjs.js').then((m) => {
    math = m;
    if (input.value.trim()) render(); // 다 불러오기 전에 쓴 식도 계산
  }).catch(() => {
    mathLoading = null;
  });
}
function calcFor(query) {
  const expr = isOn('calc') ? calcInput(query) : null;
  if (!expr) return null;
  if (!math) {
    loadMath();
    return null;
  }
  try {
    const out = calcOutput(math.evaluate(expr), math.format);
    return out && { expr, ...out };
  } catch {
    return null; // 식이 아니었다 (모르는 낱말 · 덜 쓴 식)
  }
}

const SVG = {
  web: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.6 9h16.8M3.6 15h16.8M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  ai: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  date: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 13h3v3H8z',
};
function svgIcon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', SVG[name]);
  s.append(p);
  return s;
}

// ---------- 아래 캡슐: 기능 켜고 끄기 ----------
function renderModules() {
  modulesEl.hidden = modules.length === 0; // 설정에서 모두 꺼 두면 캡슐 줄도 없음
  modulesEl.replaceChildren(...modules.map((m) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `magic-chip${m.on ? ' on' : ''}`;
    chip.dataset.mod = m.id;
    chip.setAttribute('aria-pressed', String(m.on));
    chip.title = `${m.name}: ${m.description}\n누르면 ${m.on ? '꺼요' : '켜요'}, 끌면 순서를 바꿔요`;
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    chip.append(dot, m.chip ?? m.name);
    chip.addEventListener('mousedown', (e) => e.preventDefault()); // 입력 칸 포커스 유지
    chip.addEventListener('pointerdown', (e) => dragChip(e, chip));
    // 끌 수 있다는 것을 마우스를 올렸을 때 아래 안내 자리에
    chip.addEventListener('mouseenter', () => showHint([['누르기', m.on ? '끄기' : '켜기'], ['끌기', '순서 바꾸기']]));
    chip.addEventListener('mouseleave', () => updateHint());
    chip.addEventListener('click', async () => {
      if (chip.dataset.dragged) return; // 끌어 놓은 것은 누른 것이 아님
      modules = await api.toggleModule(m.id).catch(() => modules);
      glideUntil = Date.now() + 400;
      renderModules();
      if (!calm.matches) modulesEl.querySelector(`[data-mod="${m.id}"]`)?.animate([{ transform: 'scale(0.9)' }, { transform: 'none' }], { duration: 320, easing: SPRING });
      updatePlaceholder();
      searchOpms();
      render();
      search();
    });
    return chip;
  }));
}

// 캡슐 끌기: 끄는 캡슐은 들리고, 가리킨 캡슐을 반 넘게 지나면 자리를 바꾼다 (다른 캡슐은 비켜 미끄러짐)
function dragChip(e, chip) {
  if (e.button !== 0 || modules.length < 2) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moving = false;
  let grab = null; // 캡슐 안에서 잡은 곳
  let last = { x: x0, y: y0 };
  const chips = () => [...modulesEl.children];
  // 끄는 캡슐은 손가락(마우스)을 그대로 따라온다 — 제자리(바뀐 순서의 자리)에서 얼마나 떨어졌는지로
  const follow = () => {
    chip.style.transform = '';
    const home = chip.getBoundingClientRect();
    chip.style.transform = `translate(${last.x - grab.x - home.left}px, ${last.y - grab.y - home.top}px) scale(1.06)`;
  };
  const glideChips = (mutate) => {
    const before = new Map(chips().map((c) => [c, c.getBoundingClientRect()]));
    mutate();
    for (const c of chips()) {
      if (c === chip) continue;
      c.getAnimations().forEach((a) => a.cancel());
      if (calm.matches) continue;
      const a = before.get(c);
      const b = c.getBoundingClientRect();
      slide(c, a.left - b.left, a.top - b.top);
    }
    follow();
  };
  const move = (ev) => {
    if (!moving) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moving = true;
      try {
        chip.setPointerCapture(e.pointerId); // 창 밖으로 나가도 놓을 때까지
      } catch {
        // 붙잡지 못해도 창 안에서는 window 로 받는다
      }
      const r0 = chip.getBoundingClientRect();
      grab = { x: x0 - r0.left, y: y0 - r0.top };
      chip.classList.add('dragging');
      modulesEl.classList.add('sorting');
    }
    last = { x: ev.clientX, y: ev.clientY };
    follow();
    const list = chips();
    const over = list.find((c) => {
      const r = c.getBoundingClientRect();
      return c !== chip && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 3 && ev.clientY <= r.bottom + 3;
    });
    if (!over) return;
    const r = over.getBoundingClientRect();
    const after = list.indexOf(over) > list.indexOf(chip);
    // 반을 넘어야 바꾼다 (폭이 다른 캡슐끼리 왔다 갔다 하지 않게)
    if (after ? ev.clientX > r.left + r.width / 2 : ev.clientX < r.left + r.width / 2) {
      glideChips(() => modulesEl.insertBefore(chip, after ? over.nextSibling : over));
    }
  };
  const end = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    if (!moving) return;
    // 놓으면 제자리로 쏙 (살짝 지나쳤다 돌아옴)
    const from = chip.style.transform;
    chip.style.transform = '';
    chip.classList.remove('dragging');
    modulesEl.classList.remove('sorting');
    if (!calm.matches && from) chip.animate([{ transform: from }, { transform: 'none' }], { duration: 320, easing: SPRING });
    chip.dataset.dragged = '1';
    setTimeout(() => delete chip.dataset.dragged, 0); // 놓을 때 따라오는 click 만 넘긴다
    const ids = chips().map((c) => c.dataset.mod);
    if (ids.join() === modules.map((m) => m.id).join()) return;
    modules = ids.map((id) => modules.find((m) => m.id === id));
    glideUntil = Date.now() + 400;
    render(); // 결과 묶음도 새 순서로 미끄러져 간다
    api.reorderModules?.(ids).catch(() => {});
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

function updatePlaceholder() {
  const memo = isOn('memo');
  const find = ['notes', 'files', 'opms', 'web'].some(isOn);
  // 짧게: 켜진 기능을 하나하나 늘어놓지 않는다 (무엇을 찾는지는 아래 캡슐이 보여 준다)
  const parts = [memo && '메모 쓰기', find && '찾기', isOn('calc') && '계산', isOn('ai') && 'AI 에게 묻기'].filter(Boolean);
  input.placeholder = parts.join(', ')
    || (modules.length ? '아래 캡슐을 눌러 기능을 켜 주세요' : '설정의 매직키에서 기능을 켜 주세요');
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
      // 초성(ㄱㅈㅅ)으로 찾았으면 그 글자들(견적서)을 굵게
      const r = k < 0 && isChoseongQuery(t) ? choseongRange(text.slice(i), t) : null;
      if (r && (!hit || i + r[0] < hit.k)) hit = { k: i + r[0], len: r[1] - r[0] };
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
  if (r.kind === 'calc') {
    ico.textContent = '=';
    t.textContent = r.value;
    s.textContent = r.text; // 쓴 그대로 (1,200 × 3)
  } else if (r.kind === 'date') {
    ico.append(svgIcon('date'));
    t.textContent = r.value; // 2026년 11월 12일 (목) · 64일 남음 · 오후 5:10
    s.textContent = r.detail;
    s.title = r.detail;
  } else if (r.kind === 'site') {
    ico.append(svgIcon('web'));
    t.textContent = '사이트 열기';
    s.textContent = r.url;
  } else if (r.kind === 'web' || r.kind === 'ai') {
    ico.append(svgIcon(r.kind));
    t.textContent = r.kind === 'web' ? '웹에서 찾기' : 'AI 에게 묻기';
    s.textContent = r.sites.map((x) => x.name).join(', '); // 고르면 오른쪽에 사이트 버튼
  } else if (r.kind === 'opms') {
    ico.textContent = 'O';
    t.append(highlighted([r.ourref, r.n_app].filter(Boolean).join(', ') || r.yourref || '관리번호 없음', query));
    s.append(highlighted([r.applicant, r.inventor && `발명자 ${r.inventor}`, r.title].filter(Boolean).join(', '), query)); // 이름으로 찾았으면 맞은 이름이 굵게
    side.textContent = r.div || '';
  } else if (r.kind === 'opmsMore') {
    ico.textContent = '⋯';
    t.textContent = `OPMS 다른 ${r.count.toLocaleString()}건 더 보기`;
    s.textContent = 'OPMS 창에서 정확한 것부터 모두 보여 줘요';
  } else if (r.kind === 'more') {
    ico.textContent = '⋯';
    t.textContent = `다른 ${r.count.toLocaleString()}건 더 보기`;
    s.textContent = '모두 찾기 창에서 비슷한 것부터 전부 보여 줘요 (이름, 경로, 크기, 고친 때)';
  } else if (r.kind === 'new') {
    ico.textContent = '✎';
    t.textContent = '새 메모로 저장';
    s.textContent = query.split('\n')[0];
  } else if (r.kind === 'remind') {
    ico.append(svgIcon('bell'));
    t.textContent = `${r.label} 알림 맞춰 저장`;
    s.textContent = r.title || query.split('\n')[0];
  } else if (r.kind === 'note') {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = COLOR_DOTS[r.color] ?? COLOR_DOTS.yellow;
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
  li.addEventListener('mousemove', (e) => {
    // 마우스가 정말 움직였을 때만 — 가만히 있는 마우스 아래로 목록이 다시 그려질 때도 mousemove 가 와서,
    //   치는 동안 고른 줄이 마우스 아래 줄로 바뀌면 Enter 가 엉뚱한 줄을 실행했다
    if (!e.movementX && !e.movementY) return; // 목록이 바뀌어 생긴 mousemove 는 움직인 거리가 0
    if (selected !== index) select(index);
  });
  li.addEventListener('mousedown', (e) => e.preventDefault()); // 입력 칸 포커스 유지
  li.addEventListener('click', (e) => run(index, { alt: e.ctrlKey || e.metaKey, act: index === selected ? activeAct : 0 }));
  return li;
}

function section(label, count, mod, sub) {
  const li = document.createElement('li');
  li.className = `magic-section${sub ? ' sub' : ''}`;
  li.dataset.mod = mod;
  li.dataset.key = `s:${mod}:${label}`;
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
  const before = introFresh ? new Map() : positions();
  const beforeHeight = resultsEl.getBoundingClientRect().height;
  resultsEl.getAnimations().forEach((a) => a.cancel()); // 높이가 바뀌던 중이면 지금 높이에서 다시
  rows = [];
  // 기능 id → 묶음 [{ head: [이름, 개수] } | { row } | { node }] — 계산 · 사이트 주소는 늘 맨 위 (식 · 주소면 Enter 로 바로), 나머지는 캡슐 순서
  const groups = new Map();
  const put = (mod, item) => {
    if (!groups.has(mod)) groups.set(mod, []);
    groups.get(mod).push(item);
  };
  // 날짜 계산(3주 뒤 · 12/25까지 · 9:15부터 18:30까지)이 먼저, 아니면 식 계산 — 둘 다 계산기 캡슐
  const date = query && isOn('calc') ? dateCalc(query) : null;
  const calc = date ?? (query ? calcFor(query) : null);
  if (calc) put('calc', { row: date ? { kind: 'date', ...date, text: query } : { kind: 'calc', ...calc, text: query } });
  const url = query && isOn('web') ? siteUrl(query) : null;
  if (url) put('site', { row: { kind: 'site', url } });
  if (query && isOn('memo')) {
    put('memo', { row: { kind: 'new' } });
    // 첫 줄에 날짜 · 시각이 있으면 (내일 3시 거래처 전화) 그때 알림을 맞춰 저장하는 줄도 — 날짜 계산 글은 빼고
    const line = query.split('\n')[0];
    const when = date ? null : findDates(line)[0];
    if (when) {
      const label = when.repeat ? when.text : when.hasTime ? `${dayLabel(when.at)} ${koClock(when.at)}` : dayLabel(when.at);
      put('memo', { row: { kind: 'remind', label, title: guessTitle(line, when.from, when.to), when: { at: when.at.toISOString(), hasTime: when.hasTime, repeat: when.repeat ?? null } } });
    }
  }
  // 관리번호·출원번호를 쓰면 OPMS 사건 (찾는 중 · 사내망이 아님도 이 자리에)
  // 번호로 찾을 때만 "찾는 중" · 오류를 보인다 — 이름 · 초성은 메모를 찾을 때도 같이 물으므로 찾은 것만 조용히
  const opmsByRef = opmsQueryKind(query) === 'ref';
  if (query && isOn('opms') && opms.query === query && !(calc && opms.error) && (opmsByRef || opms.cases.length)) { // 식에는 "OPMS 주소를 넣으면" 안내를 안 띄운다
    if (opms.cases.length) {
      put('opms', { head: ['OPMS', opms.total] });
      opms.cases.forEach((c) => put('opms', { row: { kind: 'opms', ...c } }));
      if (opms.total > opms.cases.length) put('opms', { row: { kind: 'opmsMore', count: opms.total - opms.cases.length } });
    } else if (opms.loading) {
      const li = note('');
      li.classList.add('loading');
      li.append(searchingNode('OPMS 에서 찾는 중', { inline: true, tag: 'span' }));
      put('opms', { node: li });
    }
    else if (opms.error) put('opms', { node: note(opms.error) });
  }
  // 캡슐로 끈 기능은 새 결과를 기다리지 않고 바로 뺀다
  const notes = isOn('notes') ? results.notes : [];
  const folders = query && isOn('files') ? results.folders : [];
  const files = query && isOn('files') ? results.files : [];
  if (notes.length) {
    put('notes', { head: [results.recent ? '최근 메모' : '메모', results.recent ? 0 : notes.length] });
    notes.forEach((n) => put('notes', { row: { kind: 'note', ...n, canAppend: Boolean(query && isOn('memo') && !results.recent) } }));
  }
  if (folders.length) {
    put('files', { head: ['폴더', folders.length] });
    folders.forEach((f) => put('files', { row: { kind: 'folder', ...f } }));
  }
  if (files.length) {
    put('files', { head: ['파일', files.length] });
    files.forEach((f) => put('files', { row: { kind: 'file', ...f } }));
  }
  if (query && results.more > 0) put(groups.has('files') || !groups.has('notes') ? 'files' : 'notes', { row: { kind: 'more', count: results.more } });
  const searched = isOn('notes') || isOn('files');
  if (query && searched && !calc && !url && !notes.length && !folders.length && !files.length && !opms.cases.length && !opms.loading) {
    put(isOn('notes') ? 'notes' : 'files', { node: note(isOn('memo') ? `'${query.slice(0, 30)}'와 맞는 메모나 파일이 없어요. Enter 로 메모를 저장할 수 있어요` : `'${query.slice(0, 30)}'와 맞는 메모나 파일이 없어요`) });
  }
  if (query && isOn('files') && results.index && !results.index.count) {
    put('files', { node: note(results.index.building ? '파일 목록을 만드는 중이에요. 처음 한 번만, 잠시 뒤 파일도 찾아져요' : UI.noFileIndex) });
  }
  // 웹 검색 · AI 에게 묻기: 고를 때만 브라우저로 연다
  if (query && isOn('web')) put('web', { row: { kind: 'web', sites: sitesInOrder(WEB_ENGINES, prefs.engine) } });
  if (query && isOn('ai')) put('ai', { row: { kind: 'ai', sites: sitesInOrder(AI_SITES, prefs.ai) } });

  const pill = document.createElement('li'); // 고른 줄 표시 (줄 사이를 미끄러져 따라간다)
  pill.className = 'magic-pill';
  pill.setAttribute('role', 'presentation');
  pill.hidden = true;
  const nodes = [pill];
  let first = true;
  // 묻는 글이면 AI 에게 묻기를 새 메모 바로 아래로 (맨 아래 화면 밖에 묻히지 않게)
  const order = ['calc', 'site', ...modules.map((m) => m.id)];
  if (groups.has('ai') && looksLikeQuestion(query)) {
    order.splice(order.indexOf('ai'), 1);
    order.splice(order.indexOf('memo') + 1 || 2, 0, 'ai');
  }
  // 머리말은 여러 줄 묶음(메모 · 폴더 · 파일 · OPMS)에만 — 한 줄 묶음은 아이콘 칸의 기능 색으로 구분
  for (const mod of order) {
    const items = groups.get(mod);
    if (!items) continue;
    let heads = 0;
    for (const it of items) {
      if (it.head) {
        const li = section(it.head[0], it.head[1], mod, heads++ > 0);
        if (!first && heads === 1) li.classList.add('gap');
        nodes.push(li);
      } else if (it.row) {
        const li = row(it.row, rows.push(it.row) - 1, query || raw);
        li.dataset.mod = mod;
        li.dataset.key = `r:${it.row.kind}:${it.row.id ?? it.row.path ?? it.row.idx ?? ''}`;
        nodes.push(li);
      } else {
        it.node.dataset.key = `n:${mod}:${it.node.textContent}`;
        nodes.push(it.node);
      }
    }
    first = false;
  }
  resultsEl.replaceChildren(...nodes);
  box.classList.toggle('has-results', nodes.length > 1);
  if (nodes.length > 1) introFresh = false;
  clearBtn.hidden = !raw;
  // 남겨 둔 지난 글로 다시 띄운 경우 첫 줄("메모로 저장")이 아니라 찾은 결과를 골라 둔다 (Enter 로 같은 메모를 또 만들지 않게)
  if (retained && selected === 0 && rows[0]?.kind === 'new' && rows.length > 1) selected = 1;
  // 초성만 쓴 글(ㄱㅈㅅ)은 찾으려는 것 — 메모로 저장하지 않고 첫 결과를 골라 둔다
  if (!retained && selected === 0 && rows[0]?.kind === 'new' && query.split(/\s+/).every(isChoseongQuery)) {
    const first = rows.findIndex((r) => r.kind === 'note' || r.kind === 'file' || r.kind === 'folder');
    if (first > 0) selected = first;
  }
  // 쓴 글이 이미 있는 메모 제목과 똑같으면 그 메모를 골라 둔다 (Enter 로 같은 이름의 메모를 또 만들지 않게 — 새로 만들려면 ↑)
  const same = (t) => String(t ?? '').trim().toLowerCase() === query.trim().toLowerCase();
  if (!retained && selected === 0 && rows[0]?.kind === 'new') {
    const hit = rows.findIndex((r) => r.kind === 'note' && same(r.title));
    if (hit > 0) selected = hit;
  }
  select(Math.min(selected, Math.max(0, rows.length - 1)), { scroll: false, glide: gliding() });
  animateResults(before, beforeHeight);
  fit();
}

// 창 크기: 커질 때는 바로, 줄어드는 움직임 중이면 다 줄어든 뒤 (창이 먼저 잘라 먹지 않게)
let winHeight = 0;
let shrinkTimer = 0;
function fit() {
  requestAnimationFrame(() => {
    const list = resultsEl.getBoundingClientRect().height;
    const h = Math.ceil(box.getBoundingClientRect().height - list + (listTarget || list)) + 16;
    clearTimeout(shrinkTimer);
    const apply = () => {
      winHeight = h;
      api.resize(h);
    };
    if (h < winHeight && gliding()) shrinkTimer = setTimeout(apply, DUR);
    else apply();
  });
}

let lastPill = null;
function select(i, { scroll = true, glide = true } = {}) {
  if (i !== selected) activeAct = 0;
  selected = i;
  for (const el of resultsEl.querySelectorAll('.magic-row')) el.setAttribute('aria-selected', String(Number(el.dataset.index) === i));
  const pill = resultsEl.querySelector('.magic-pill');
  const li = resultsEl.querySelector(`.magic-row[data-index="${i}"]`);
  if (pill) {
    // 다시 그린 새 표시는 지난 표시 자리에서 출발 (끄고 켜거나 끌어 옮길 때 고른 줄을 따라 미끄러지게)
    if (pill.hidden && glide && lastPill && li) {
      pill.hidden = false;
      pill.classList.add('instant');
      pill.style.transform = `translateY(${lastPill.y}px)`;
      pill.style.height = `${lastPill.h}px`;
      void pill.offsetWidth;
    }
    pill.hidden = !li;
    pill.classList.toggle('instant', !glide || calm.matches);
    if (li) {
      lastPill = { y: li.offsetTop, h: li.offsetHeight };
      pill.style.transform = `translateY(${lastPill.y}px)`;
      pill.style.height = `${lastPill.h}px`;
    }
  }
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

let flashUntil = 0; // 복사했어요 같은 안내를 보이는 동안은 늦게 온 찾기 결과가 덮지 않게
function updateHint() {
  if (Date.now() < flashUntil) return;
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
  showHint(parts);
}
function showHint(parts) {
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
  if (!isOn('opms') || !opmsQueryKind(query)) {
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

// 안내를 잠깐 보여 준 뒤 닫기 — 그사이 창을 다시 띄우면 취소 (새로 연 창이 닫히지 않게)
let closeTimer = 0;
const closeSoon = () => {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => api.close(), 650);
};

// 실행: act = 고른 할 일(몇 번째), alt = Ctrl+Enter (다른 실행)
async function run(i, { alt = false, act = 0 } = {}) {
  const r = rows[i];
  if (!r) return;
  const acts = actionsFor(r);
  const id = (alt && ALT_ACTION[r.kind]) || acts[act]?.id || acts[0]?.id;
  if (r.kind === 'new' || r.kind === 'remind') {
    const text = input.value;
    await api.run({ module: 'memo', text, open: id === 'saveOpen', remind: r.kind === 'remind' ? { ...r.when, title: r.title } : null }).catch(() => {});
    input.value = '';
    api.close();
    return;
  }
  if (r.kind === 'note' && id === 'append') {
    const res = await api.act({ action: 'append', id: r.id, text: input.value }).catch(() => null);
    if (res?.ok) {
      input.value = '';
      flash(true, res.message);
      closeSoon();
    } else flash(false, res?.message ?? '덧붙이지 못했어요');
    return;
  }
  if (r.kind === 'more') {
    await api.openAll(input.value.trim()).catch(() => {});
    return;
  }
  if (r.kind === 'opmsMore') {
    const res = await api.act({ action: 'opmsAll', text: input.value.trim() }).catch(() => null);
    if (res?.ok) api.close();
    return;
  }
  if (r.kind === 'calc' || r.kind === 'date' || r.kind === 'site' || r.kind === 'web' || r.kind === 'ai') {
    const req = r.kind === 'calc' || r.kind === 'date' ? { type: 'copy', text: id === 'copyExpr' ? `${r.text} = ${r.value}` : r.kind === 'date' && id === 'copy' ? r.value : r.plain }
      : r.kind === 'site' ? { type: 'site', text: r.url }
        : { type: r.kind, site: id, text: input.value };
    const res = await api.tool(req).catch(() => null);
    if (res?.message) {
      flash(res.ok, res.message);
      if (res.ok) closeSoon();
    } else if (res?.ok) api.close();
    else flash(false, '열지 못했어요');
    return;
  }
  const req = r.kind === 'note' ? { action: id, id: r.id } : r.kind === 'opms' ? { action: id, opms: r.idx } : { action: id, path: r.path };
  const res = await api.act(req).catch(() => null);
  if (res?.message) {
    flash(res.ok, res.message);
    if (res.ok) closeSoon(); // 복사했다는 표시를 잠깐 보여 주고
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
  flashUntil = Date.now() + 900;
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
  clearTimeout(closeTimer);
  flashUntil = 0; // 지난번의 "복사했어요" 안내는 다시 띄울 때 지운다
  selected = 0;
  retained = Boolean(input.value.trim());
  activeAct = 0;
  // 지난 글이 남아 있으면 그 결과도 새 결과가 올 때까지 그대로 (비었다가 다시 채워지며 깜박이지 않게)
  if (!input.value.trim()) {
    results = { notes: [], folders: [], files: [], more: 0, recent: false, index: null };
    opms = { query: '', loading: false, cases: [], total: 0, error: '' };
  }
  resizeInput();
  shownAt = Date.now();
  introFresh = true;
  [modules] = await Promise.all([api.modules().catch(() => []), loadPrefs()]);
  if (isOn('calc')) loadMath();
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
api.onModules?.(async (list) => {
  const same = JSON.stringify(list ?? []) === JSON.stringify(modules); // 이 창에서 누르거나 끌어 바꾼 것 (이미 그렸다)
  modules = list ?? [];
  await loadPrefs(); // 설정에서 기본 사이트를 바꿨을 수도
  if (same) {
    render();
    return;
  }
  renderModules();
  updatePlaceholder();
  search();
});
reset();
