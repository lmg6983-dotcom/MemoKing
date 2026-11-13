// 메모킹 폴더 화면 조각 (PC 목록 창 · 휴대폰 목록 같음) — 저장 규칙은 core/folders.js
//   폴더 목록: 전체 · 폴더마다 (메모 수) · ＋ 새 폴더  (PC 는 왼쪽 막대, 휴대폰은 아래에서 올라오는 시트)
//   폴더 고르기 창: 메모를 옮길 폴더 (폴더 없음 · 폴더들 · ＋ 새 폴더)
import { icon } from './icons.js';
import { cleanFolderName, MAX_FOLDER_NAME } from './core/folders.js';

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
  b.title = label; // 긴 이름은 잘려 보이므로 전체 이름
  if (current) b.setAttribute('aria-current', 'true');
  b.append(icon(iconName), el('span', 'mf-name', label));
  if (count != null) b.append(el('small', 'mf-count', String(count)));
  return b;
}

/**
 * 폴더 목록을 그린다 (누르면 onPick(폴더 이름, "" = 전체))
 *   onMenu 가 있으면 폴더마다 ⋯ 단추(와 오른쪽 클릭) — 이름 바꾸기 · 지우기
 *   "전체" 에는 수를 적지 않는다 (위 메모 탭에 이미 있다)
 * @param {HTMLElement} container
 * @param {{ folders: { name: string, count: number }[], current: string,
 *           onPick: (name: string) => any, onNew: () => any, onMenu?: (name: string, anchor: HTMLElement) => any }} o
 */
export function renderFolderList(container, { folders, current, onPick, onNew, onMenu }) {
  const list = el('ul', 'mf-list');
  list.setAttribute('aria-label', '폴더');
  const item = (b, name) => {
    const li = el('li', 'mf-row');
    li.append(b);
    if (onMenu && name) {
      const more = el('button', 'icon-btn mf-more');
      more.type = 'button';
      more.dataset.folderMenu = name;
      more.title = '이름 바꾸기, 지우기';
      more.setAttribute('aria-label', `${name} 폴더 메뉴`);
      more.append(icon('more'));
      li.append(more);
    }
    return li;
  };
  list.append(item(folderButton({ name: '', label: '전체', current: !current, iconName: 'note' }), ''));
  for (const f of folders) list.append(item(folderButton({ name: f.name, label: f.name, count: f.count, current: f.name === current, iconName: 'folder' }), f.name));
  list.addEventListener('click', (e) => {
    const m = e.target.closest('[data-folder-menu]');
    if (m) return onMenu?.(m.dataset.folderMenu, m);
    const b = e.target.closest('[data-folder]');
    if (b) onPick(b.dataset.folder);
  });
  list.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('[data-folder]');
    if (!onMenu || !b?.dataset.folder) return;
    e.preventDefault();
    onMenu(b.dataset.folder, b);
  });
  const add = el('button', 'link-btn mf-new', '＋ 새 폴더');
  add.type = 'button';
  add.addEventListener('click', () => onNew());
  container.replaceChildren(list, add);
}

/** 작은 창 하나 (머리 · 닫기 · 몸통) → { dialog, body, done(값) } — 닫으면 값으로 끝난다 */
function sheet(title, className) {
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
  for (const f of folders) add(f, f, 'folder');
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

/**
 * 폴더 시트 (휴대폰 · 좁은 PC 창): 고른 폴더 이름 ("" = 전체), 그만두면 null. 새 폴더는 { create: 이름 }
 *   ⋯ 메뉴(onMenu)를 누르면 시트를 닫고 메뉴를 연다 (이름이 바뀌면 시트 내용이 낡으므로)
 * @param {{ folders: { name: string, count: number }[], current: string, onMenu?: (name: string, anchor: HTMLElement) => any }} o
 */
export function openFolderSheet({ folders, current, onMenu }) {
  const { body, closed, done } = sheet('폴더', 'folder-sheet');
  renderFolderList(body, {
    folders, current,
    onPick: (name) => done(name),
    onNew: async () => {
      const name = await askFolderName({ existing: folders.map((f) => f.name) });
      if (name) done({ create: name });
    },
    onMenu: onMenu && ((name, anchor) => {
      const r = anchor.getBoundingClientRect();
      done(null);
      onMenu(name, { getBoundingClientRect: () => r });
    }),
  });
  return closed;
}
