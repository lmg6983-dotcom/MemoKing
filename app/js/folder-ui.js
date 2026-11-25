// 메모킹 폴더 화면 조각 (PC 목록 창 · 휴대폰 목록 같음) — 저장 규칙은 core/folders.js
//   폴더 목록: 전체 · 폴더마다 (메모 수) · ＋ 새 폴더  (PC 는 왼쪽 막대, 휴대폰은 아래에서 올라오는 시트)
//   폴더 고르기 창: 메모를 옮길 폴더 (폴더 없음 · 폴더들 · ＋ 새 폴더)
import { icon } from './icons.js';
import { cleanFolderName, MAX_FOLDER_NAME, UNFILED } from './core/folders.js';

// 메뉴(이름 바꾸기 · 지우기)가 있는 진짜 폴더인가 — 전체("") · 미분류는 아니다
const isReal = (name) => Boolean(name) && name !== UNFILED;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function folderButton({ name, label, count, current, iconName }) {
  const b = el('button', 'mf-item');
  b.type = 'button';
  b.dataset.folder = name;
  b.title = name === UNFILED ? '어느 폴더에도 넣지 않은 메모' : label; // 긴 이름은 잘려 보이므로 전체 이름
  if (current) b.setAttribute('aria-current', 'true');
  // 그림은 전체 · 미분류(폴더 없음)에만 — 보통 폴더는 그 자리를 이름에 준다
  if (iconName) b.append(icon(iconName));
  const nameEl = el('span', 'mf-name');
  const text = el('span', 'mf-text');
  // "업무_템플릿_정리" 처럼 띄어쓰기 없는 긴 이름은 _ · - 뒤에서 줄을 바꾼다 (낱말 가운데서 끊기지 않게)
  for (const part of String(label).split(/(?<=[_\-.])/)) {
    if (text.childNodes.length) text.append(document.createElement('wbr'));
    text.append(part);
  }
  nameEl.append(text);
  b.append(nameEl);
  if (count) b.append(el('small', 'mf-count', String(count))); // 0 은 적지 않는다 (빈 폴더가 많아도 목록이 조용하게 — 칩 줄과 같게)
  return b;
}

/**
 * 폴더 목록을 그린다 (누르면 onPick(폴더 이름, "" = 전체))
 *   onMenu 가 있으면 폴더마다 ⋯ 단추(와 오른쪽 클릭) — 이름 바꾸기 · 지우기
 *   두 묶음: 위에 전체 · 미분류, 가는 선과 "폴더" 머리글 아래에 만든 폴더들 (Apple 메모 · Things 처럼)
 * @param {HTMLElement} container
 * @param {{ folders: { name: string, count: number }[], current: string, total?: number,
 *           onPick: (name: string) => any, onNew: () => any, onMenu?: (name: string, anchor: HTMLElement) => any }} o
 *   total: 전체 메모 수
 */
/** 폴더 메뉴의 고정 항목 (PC · 휴대폰 같게) */
export const pinItem = (pinned, name) => ({ id: 'pin', label: pinned?.includes(name) ? '상단 고정 풀기' : '상단 고정' });

export function renderFolderList(container, { folders, current, total = 0, onPick, onNew, onMenu }) {
  // 폴더 · 수가 그대로면 목록을 다시 만들지 않고 고른 줄만 바꾼다 (폴더를 누를 때마다 목록을 통째로 새로 만들고 이름 길이를 다시 재 멈칫했다)
  const key = JSON.stringify([folders.map((f) => [f.name, f.label ?? '', f.count, Boolean(f.pinned), Boolean(f.secret), Boolean(f.locked)]), total, Boolean(onMenu)]);
  if (container.mfKey === key && container.querySelector('.mf-list')) {
    markCurrentFolder(container, current);
    return;
  }
  container.mfKey = key;
  const list = el('ul', 'mf-list');
  list.setAttribute('aria-label', '폴더');
  const item = (b, name) => {
    const li = el('li', 'mf-row');
    li.append(b);
    if (onMenu && isReal(name)) {
      const more = el('button', 'icon-btn mf-more');
      more.type = 'button';
      more.tabIndex = -1; // 키보드는 F2 · 메뉴 키로 (줄마다 Tab 이 서지 않게)
      more.dataset.folderMenu = name;
      more.title = '상단 고정, 이름 바꾸기, 삭제';
      more.setAttribute('aria-label', `${name} 폴더 메뉴`);
      more.append(icon('more'));
      li.append(more);
    }
    return li;
  };
  list.append(item(folderButton({ name: '', label: '전체', count: total, current: !current, iconName: 'note' }), ''));
  const make = (f) => item(folderButton({ name: f.name, label: f.label ?? f.name, count: f.count, current: f.name === current, iconName: f.secret ? (f.locked ? 'lock' : 'lock-open') : isReal(f.name) ? '' : 'inbox' }), f.name);
  for (const f of folders) if (!isReal(f.name)) list.append(make(f));
  // 전체 · 미분류 | 상단 고정 | 폴더 — 묶음마다 선과 이름으로 나눈다 (상단 고정한 폴더가 없으면 그 묶음도 없음)
  const section = (title, items) => {
    if (!items.length) return;
    const head = el('li', 'mf-sep', title);
    head.setAttribute('aria-hidden', 'true');
    list.append(head, ...items.map(make));
  };
  const real = folders.filter((f) => isReal(f.name));
  section('상단 고정', real.filter((f) => f.pinned && !f.secret));
  // 비밀 폴더도 보통 폴더 사이에 이름순 — 이름 앞 자물쇠로만 다르다 (잠긴 것은 누르면 비밀번호, core/secret-folders.js)
  section('폴더', real.filter((f) => !f.pinned || f.secret).sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name, 'ko')));
  list.addEventListener('click', (e) => {
    const m = e.target.closest('[data-folder-menu]');
    if (m) return onMenu?.(m.dataset.folderMenu, m);
    const b = e.target.closest('[data-folder]');
    if (b) onPick(b.dataset.folder);
  });
  // 키보드: 목록은 Tab 한 번에 들어오고(고른 폴더), 그 안에서는 ↑ ↓ Home End 로 옮겨 다닌다 (폴더가 많아도 Tab 을 여러 번 누르지 않게)
  const rows = () => [...list.querySelectorAll('[data-folder]')];
  for (const b of rows()) b.tabIndex = b.hasAttribute('aria-current') ? 0 : -1;
  if (!list.querySelector('[data-folder][tabindex="0"]')) rows()[0].tabIndex = 0;
  list.addEventListener('keydown', (e) => {
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    const all = rows();
    const i = all.indexOf(b);
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -2;
    if (to !== -2) {
      e.preventDefault();
      const next = all[Math.max(0, Math.min(all.length - 1, to))];
      for (const x of all) x.tabIndex = x === next ? 0 : -1;
      next.focus();
    } else if (e.key === 'F2' && onMenu && isReal(b.dataset.folder)) {
      e.preventDefault();
      onMenu(b.dataset.folder, b);
    }
  });
  list.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('[data-folder]');
    if (!onMenu || !isReal(b?.dataset.folder)) return;
    e.preventDefault();
    onMenu(b.dataset.folder, b);
  });
  const add = el('button', 'link-btn mf-new', '＋ 새 폴더');
  add.type = 'button';
  add.addEventListener('click', () => onNew());
  container.replaceChildren(list, add);
  markLongNames(container);
  nameWatch.observe(container); // 접혀 있다 보이거나 폭이 바뀌면 다시 잰다
}

/** 고른 폴더 줄 표시만 바꾼다 (목록은 그대로) — 누르자마자 손가락 아래에서 바뀌게 */
export function markCurrentFolder(container, current) {
  for (const b of container.querySelectorAll('.mf-list [data-folder]')) {
    const on = b.dataset.folder === (current ?? '');
    if (on) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
    b.tabIndex = on ? 0 : -1;
  }
}

// 한 줄에 다 안 들어가는 이름에 .long — 고른 폴더 · 끌어 올려놓은 폴더에서는 한 줄로 천천히 흘러 끝까지 보인다 (base.css)
//   --mf-w: 이름 칸의 폭 (흐를 거리), --mf-dur: 글자 수에 맞춘 흐르는 시간
function markLongNames(container) {
  for (const name of container.querySelectorAll('.mf-name')) {
    if (!name.clientWidth) continue; // 접혀 있으면 보일 때 (nameWatch)
    const long = name.scrollHeight > name.clientHeight + 1;
    name.classList.toggle('long', long);
    if (!long) continue;
    name.style.setProperty('--mf-w', `${name.clientWidth}px`);
    name.style.setProperty('--mf-dur', `${Math.max(2.5, name.textContent.length * 0.18)}s`);
  }
}
const nameWatch = new ResizeObserver((entries) => {
  for (const e of entries) markLongNames(e.target);
});

/** 작은 창 하나 (머리 · 닫기 · 몸통) → { dialog, body, done(값) } — 닫으면 값으로 끝난다 */
export function sheet(title, className) {
  let result = null;
  const dialog = el('dialog', `dialog folder-dialog ${className}`);
  const head = el('div', 'dialog-head');
  const h = el('h2', '', title);
  h.id = `folder-dialog-${Math.random().toString(36).slice(2, 8)}`;
  dialog.setAttribute('aria-labelledby', h.id);
  const close = el('button', 'icon-btn dialog-x');
  close.type = 'button';
  close.setAttribute('aria-label', '닫기');
  close.append(icon('close'));
  close.addEventListener('click', () => dialog.close());
  head.append(h, close);
  const body = el('div', 'folder-dialog-body');
  dialog.append(head, body);
  // 바깥(어두운 곳)을 누르면 닫는다
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  const closed = new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, closed, done: (value) => { result = value; dialog.close(); } };
}

/**
 * 새 폴더 이름 묻기 → 정리한 이름, 그만두면 null
 * @param {{ existing?: string[] }} [o] 이미 있는 폴더 (같은 이름이면 그 폴더를 고른 것으로)
 */
export function askFolderName({ existing = [], title = '새 폴더', value = '', okLabel = '만들기' } = {}) {
  const { body, closed, done } = sheet(title, 'mf-name-dialog');
  const form = el('form', 'mf-name-form');
  const input = el('input', 'mf-name-input');
  input.type = 'text';
  input.maxLength = MAX_FOLDER_NAME;
  input.placeholder = '폴더 이름 (예: 업무)';
  input.setAttribute('aria-label', '폴더 이름');
  input.autocomplete = 'off';
  input.value = value;
  const note = el('p', 'mf-name-note');
  note.setAttribute('role', 'status');
  const ok = el('button', 'btn primary', okLabel);
  ok.type = 'submit';
  form.append(input, note, ok);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = cleanFolderName(input.value);
    if (!name) {
      note.textContent = input.value.trim() ? '이 이름은 폴더 이름으로 쓸 수 없어요' : '';
      input.focus();
      return;
    }
    done(existing.find((f) => f.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0) ?? name);
  });
  body.append(form);
  input.focus();
  input.select();
  return closed;
}

/**
 * 메모를 옮길 폴더 고르기 → 폴더 이름 ("" = 폴더 없음), 그만두면 null
 * @param {{ folders: string[], current: string, count?: number }} o count: 옮길 메모 수 (제목에)
 */
export function pickFolder({ folders, current, count = 1 }) {
  const { body, closed, done } = sheet(count > 1 ? `메모 ${count}개를 폴더로 옮기기` : '폴더로 옮기기', 'folder-pick-dialog');
  const list = el('ul', 'mf-list');
  list.setAttribute('aria-label', '옮길 폴더');
  const add = (name, label, iconName) => {
    const li = el('li');
    const b = folderButton({ name, label, current: name === current, iconName });
    if (name === current) b.disabled = true; // 지금 있는 곳
    b.addEventListener('click', () => done(name));
    li.append(b);
    list.append(li);
  };
  add('', '폴더 없음', 'inbox'); // "전체" 와 다른 뜻이라 다른 그림
  for (const f of folders) add(f, f, '');
  const create = el('button', 'link-btn mf-new', '＋ 새 폴더로 옮기기');
  create.type = 'button';
  create.addEventListener('click', async () => {
    const name = await askFolderName({ existing: folders });
    if (name) done(name);
  });
  body.append(list, create);
  return closed;
}

/**
 * 여러 장 고르기 막대 (화면 아래 가운데): "N개 골랐어요 · 폴더로 옮기기 · 그만"
 * @param {{ onMove: () => any, onCancel: () => any }} o
 * @returns {{ show: (count: number, visible: boolean) => void }}
 */
export function createPickBar({ onMove, onCancel }) {
  const bar = el('div', 'pick-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '고른 메모');
  bar.hidden = true;
  const text = el('span');
  const move = el('button', 'btn primary', '폴더로 옮기기');
  move.type = 'button';
  move.addEventListener('click', () => onMove());
  const cancel = el('button', 'btn', '그만 고르기');
  cancel.type = 'button';
  cancel.addEventListener('click', () => onCancel());
  bar.append(text, move, cancel);
  document.body.append(bar);
  return {
    show(count, visible) {
      text.textContent = `${count}개 골랐어요`;
      move.disabled = count === 0;
      bar.hidden = !visible;
    },
  };
}

