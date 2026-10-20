// 단축키 설정 창 — 기능마다 지금 키를 보이고, 키 칸을 눌러 새 키를 받아 바꾼다
//   메모 창 기능: core/keymap.js (바꾼 것만 설정에) · 어디서든(빠른 메모 · 매직키): 전역 단축키 (설정의 같은 칸과 같은 값)
import { keymapGroups, comboFromEvent, comboLabel, comboFromAccelerator } from './core/keymap.js';
import { displayAccelerator, DEFAULT_SHORTCUTS } from './core/accelerators.js';
import { startKeyCapture, stopKeyCapture, isCapturing, modsLabel, globalShortcutResult, captureGlobalKey } from './key-capture.js';

const api = window.memoking;
const $ = (id) => document.getElementById(id);

const GLOBAL = [
  { id: 'quickMemo', label: '빠른 메모, 화면 캡처', help: '어느 앱에서든 고른 글, 파일, 그림을 바로 메모로 만들어요. 빠르게 두 번 누르면 화면의 원하는 부분을 잘라 담아요.' },
  { id: 'magic', label: '매직키', help: '어디서든 입력창을 띄워 메모와 파일을 몇 글자로 찾고, 찾는 게 없으면 바로 메모해요.' },
];

let state = { overrides: {}, shortcuts: {} };


function setStatus(text, warn = false) {
  $('status').textContent = text;
  $('status').classList.toggle('warn', warn);
}

function nameCell(label, help, changed) {
  const name = document.createElement('span');
  name.className = 'name';
  name.dataset.help = help;
  name.dataset.label = label;
  if (changed) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.title = '기본 키에서 바꿨어요';
    name.append(dot);
  }
  name.append(label);
  const q = document.createElement('span');
  q.className = 'q';
  q.setAttribute('aria-hidden', 'true');
  q.textContent = '?';
  name.append(q);
  return name;
}

function keyButton(text, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `key${text ? '' : ' none'}`;
  b.textContent = text || '없음';
  b.setAttribute('aria-label', `${label} 단축키: ${text || '없음'}. 눌러서 바꾸기`);
  return b;
}

function resetButton(changed, label) {
  const r = document.createElement('button');
  r.type = 'button';
  r.className = 'row-reset';
  r.textContent = '기본값';
  r.disabled = !changed;
  r.title = `${label} 단축키를 처음 키로 되돌려요`;
  return r;
}

/** 한 줄: 이름(설명 말풍선) · 기본값 · 키 칸 — 키 칸이 늘 줄 오른쪽 끝에 (기본값은 바꾼 줄에만 보인다). onCapture(키 칸), onReset(기본값) */
function keyRow({ label, help, keys, changed, onCapture, onReset }) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.find = `${label} ${keys} ${help}`.toLowerCase();
  const btn = keyButton(keys, label);
  btn.setAttribute('aria-description', help);
  btn.addEventListener('click', () => onCapture(btn));
  const reset = resetButton(changed, label);
  reset.addEventListener('click', onReset);
  row.append(nameCell(label, help, changed), reset, btn);
  return row;
}

function render() {
  // 어디서든 (빠른 메모 · 매직키)
  const sections = [section('어디서든', GLOBAL.map((g) => {
    const st = state.shortcuts?.[g.id];
    return keyRow({
      label: g.label,
      help: g.help,
      keys: st?.label ?? displayAccelerator(DEFAULT_SHORTCUTS[g.id]),
      changed: st ? !st.isDefault : false,
      onCapture: (btn) => captureGlobal(btn, g),
      onReset: async () => {
        const res = await api.settings.setShortcut(g.id, null);
        const msg = globalShortcutResult(res, '', { reset: true });
        setStatus(`${g.label}: ${msg.text}`, msg.warn);
        await load();
        if (res?.ok) flashRows([g.label]);
      },
    });
  }))];
  // 메모 창 기능
  for (const group of keymapGroups(state.overrides)) {
    sections.push(section(group.title, group.items.map((a) => keyRow({
      label: a.label,
      help: a.help,
      keys: a.current.map(comboLabel).join(' / '),
      changed: a.changed,
      onCapture: (btn) => captureAction(btn, a),
      onReset: async () => {
        state = await api.keymap.set(a.id, null);
        setStatus(`${a.label} 키를 처음대로 되돌렸어요${state.moved?.length ? ` (${state.moved.join(', ')}에서는 그 키를 뺐어요)` : ''}`);
        render();
        flashRows([a.label, ...(state.moved ?? [])]);
      },
    }))));
  }
  $('groups').replaceChildren(...sections);
  applyFind();
}

function section(title, rows) {
  const s = document.createElement('section');
  s.className = 'group';
  const h = document.createElement('h2');
  h.textContent = title;
  const box = document.createElement('div');
  box.className = 'rows';
  box.append(...rows);
  s.append(h, box);
  return s;
}

function applyFind() {
  const q = $('find').value.trim().toLowerCase();
  let any = false;
  for (const s of document.querySelectorAll('.group')) {
    let shown = 0;
    for (const row of s.querySelectorAll('.row')) {
      row.hidden = Boolean(q) && !row.dataset.find.includes(q);
      if (!row.hidden) shown++;
    }
    s.hidden = !shown;
    any ||= shown > 0;
  }
  document.querySelector('.empty-find')?.remove();
  if (!any) {
    const p = document.createElement('p');
    p.className = 'empty-find';
    p.textContent = `'${$('find').value.trim()}'에 맞는 기능이 없어요`;
    $('groups').append(p);
  }
}

const HELP = 'Esc 는 그만두기, Backspace 는 이 기능의 키 없애기예요';

// 메모 창 기능의 키 칸 (key-capture.js — 설정 창의 빠른 메모 · 매직키 칸과 같은 동작)
function captureAction(btn, a) {
  if (isCapturing(btn)) return stopKeyCapture('cancel');
  setStatus(HELP);
  startKeyCapture(btn, {
    onStop: (reason) => (reason === 'cancel' || reason === 'away') && setStatus(''), // 다음 칸을 받기 시작했으면 불리지 않는다
    onKey: async (e, _btn, cap) => {
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey) {
        await cap.stop();
        state = await api.keymap.set(a.id, '');
        setStatus(`${a.label}의 키를 없앴어요. 메뉴나 단추로는 그대로 쓸 수 있어요`);
        render();
        return flashRows([a.label]);
      }
      const r = comboFromEvent(e);
      if (r.pending) {
        btn.textContent = modsLabel(e);
        return;
      }
      if (r.error) return setStatus(r.error, true); // 계속 기다린다
      const label = comboLabel(r.combo);
      // 전역 키와 같은 키는 안 됨 (전역이 먼저 가져가 메모 창에 닿지 않는다) — 거꾸로는 main 의 setShortcut 이 막는다
      const global = GLOBAL.find((g) => comboFromAccelerator(state.shortcuts?.[g.id]?.key ?? DEFAULT_SHORTCUTS[g.id]) === r.combo);
      if (global) return setStatus(`${label} 은(는) '${global.label}'(어디서든)에 쓰는 키예요. 다른 키를 눌러 주세요`, true);
      await cap.stop();
      const res = await api.keymap.set(a.id, r.combo);
      state = res;
      setStatus(`${a.label}: ${label} 로 바꿨어요${res.moved?.length ? `. 같은 키를 쓰던 '${res.moved.join(', ')}'에서는 그 키를 뺐어요` : ''}`);
      render();
      flashRows([a.label, ...(res.moved ?? [])]);
    },
  });
}

// 빠른 메모 · 매직키 칸
function captureGlobal(btn, g) {
  if (isCapturing(btn)) return stopKeyCapture('cancel');
  captureGlobalKey(btn, {
    api,
    name: g.id,
    note: (text, warn) => setStatus(text && !warn && /바꿨어요$/.test(text) ? `${g.label}: ${text}` : text, warn),
    done: async (res) => {
      await load();
      if (res?.ok) flashRows([g.label]);
    },
  });
}

/** 키를 바꾼 줄 · 키를 빼앗긴 줄을 잠깐 칠해 어디가 바뀌었는지 보이게 */
function flashRows(labels) {
  for (const row of document.querySelectorAll('.row')) {
    if (!labels.includes(row.querySelector('.name')?.dataset.label)) continue;
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }
}

// 기능 설명 말풍선 — 이름 오른쪽 빈 곳에 (아래 줄을 가리지 않게), 자리가 모자라면 아래에.
//   목록을 훑으며 지나갈 때마다 깜빡이지 않게 마우스는 잠깐 머물러야 뜬다
const tip = $('tip');
let tipTimer = 0;
function showTip(name) {
  clearTimeout(tipTimer);
  tip.replaceChildren();
  const b = document.createElement('b');
  b.textContent = name.dataset.label;
  tip.append(b, name.dataset.help);
  const row = name.closest('.row');
  const q = name.querySelector('.q') ?? name;
  const key = row.querySelector('.key');
  const qr = q.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  const room = key.getBoundingClientRect().left - qr.right - 20;
  tip.style.maxWidth = room >= 190 ? `${Math.min(320, room)}px` : '';
  tip.hidden = false;
  const t = tip.getBoundingClientRect();
  if (room >= 190) {
    tip.style.left = `${qr.right + 10}px`;
    tip.style.top = `${Math.max(8, Math.min(rr.top + rr.height / 2 - t.height / 2, window.innerHeight - t.height - 8))}px`;
  } else {
    const below = rr.bottom + 4 + t.height < window.innerHeight - 8;
    tip.style.left = `${Math.max(8, Math.min(rr.left + 12, window.innerWidth - t.width - 8))}px`;
    tip.style.top = `${below ? rr.bottom + 4 : rr.top - t.height - 4}px`;
  }
}
const hideTip = () => {
  clearTimeout(tipTimer);
  tip.hidden = true;
};
$('groups').addEventListener('mouseover', (e) => {
  const name = e.target.closest?.('.name');
  if (!name) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTip(name), tip.hidden ? 280 : 0); // 하나가 떠 있으면 옆 줄로는 바로
});
$('groups').addEventListener('mouseout', (e) => {
  if (e.target.closest?.('.name') && !e.relatedTarget?.closest?.('.name')) hideTip();
});
// 키보드: 키 칸으로 옮겨 오면 그 기능의 설명
$('groups').addEventListener('focusin', (e) => {
  const name = e.target.closest?.('.key') && e.target.closest('.row')?.querySelector('.name');
  if (name) showTip(name);
});
$('groups').addEventListener('focusout', hideTip);
$('groups').addEventListener('scroll', hideTip);

$('find').addEventListener('input', applyFind);

// 모두 초기화: 한 번 더 눌러야 (실수로 누르지 않게)
let confirmTimer = 0;
$('reset-all').addEventListener('click', async () => {
  const b = $('reset-all');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm');
    b.textContent = '한 번 더 누르면 초기화';
    setStatus('메모 창 단축키와 빠른 메모, 매직키 키를 모두 처음대로 되돌려요');
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      b.classList.remove('confirm');
      b.textContent = '모두 초기화';
    }, 4000);
    return;
  }
  clearTimeout(confirmTimer);
  b.classList.remove('confirm');
  b.textContent = '모두 초기화';
  await stopKeyCapture('cancel');
  state = await api.keymap.reset();
  // 빠른 메모 · 매직키를 서로 바꿔 두었으면 한쪽을 먼저 되돌려야 다른 쪽이 된다 → 안 된 것은 한 번 더
  let failed = [];
  for (let round = 0; round < 2; round++) {
    failed = [];
    for (const g of GLOBAL) {
      const res = await api.settings.setShortcut(g.id, null).catch(() => null);
      if (!res?.ok) failed.push(g.label);
    }
    if (!failed.length) break;
  }
  await load();
  if (failed.length) setStatus(`메모 창 단축키는 처음대로 되돌렸어요. ${failed.join(', ')}의 처음 키는 다른 앱이 쓰고 있어 되돌리지 못했어요`, true);
  else setStatus('모든 단축키를 처음대로 되돌렸어요');
});
$('done').addEventListener('click', () => window.close());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !isCapturing()) window.close();
});

async function load() {
  state = await api.keymap.get();
  render();
}
// 다른 곳(다른 창)에서 바뀌었을 때만 다시 그린다 — 여기서 방금 바꾼 것이면 칠해 둔 줄을 지우지 않게
api.on('keymap:changed', (o) => !isCapturing() && JSON.stringify(o ?? {}) !== JSON.stringify(state.overrides ?? {}) && load());
api.on('shortcuts:changed', () => !isCapturing() && load());

await load();
document.documentElement.dataset.ready = 'true';
