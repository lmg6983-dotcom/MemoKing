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

/**
 * 폴더 칩 줄 (휴대폰 · 좁은 PC 창): 전체 · 폴더마다 · ＋ — 한 번 누르면 그 폴더로, 옆으로 넘겨 본다.
 *   꾹 누르기 · 오른쪽 클릭은 폴더 메뉴(이름 바꾸기 · 지우기), ＋ 는 그 자리에서 이름 칸이 열린다.
 *   칩이 줄을 넘치면 끝에 "모두" (누르면 단추 아래에 폴더 목록)
 * @param {HTMLElement} container
 * @param {{ folders: { name: string, count: number }[], current: string, onPick: (name: string) => any,
 *           onCreate: (name: string) => any, onMenu?: (name: string, anchor: HTMLElement) => any, onAll?: (anchor: HTMLElement) => any }} o
 */
export function renderFolderChips(container, { folders, current, onPick, onCreate, onMenu, onAll }) {
  const chip = (name, label, count) => {
    const b = el('button', 'fchip');
    b.type = 'button';
    b.dataset.folder = name;
    b.setAttribute('aria-pressed', String(name === current));
    if (!name) b.append(icon('note'));
    b.append(el('span', 'fchip-name', label));
    if (count != null) b.append(el('small', 'fchip-count', String(count)));
    if (name) b.title = `${label} (꾹 누르면 이름 바꾸기, 지우기)`;
    return b;
  };
  const add = el('button', 'fchip fchip-add');
  add.type = 'button';
  add.setAttribute('aria-label', '새 폴더');
  add.title = '새 폴더';
  add.append(icon('plus'), el('span', 'fchip-name', '새 폴더'));
  const row = el('div', 'fchip-row');
  row.append(chip('', '전체'), ...folders.map((f) => chip(f.name, f.name, f.count)), add);
  const all = el('button', 'fchip fchip-all');
  all.type = 'button';
  all.append(el('span', 'fchip-name', '모두'), icon('chev-down'));
  all.setAttribute('aria-haspopup', 'dialog');
  all.hidden = true;
  container.replaceChildren(row, all);
  // 고른 칩이 보이게, 넘치면 "모두"
  // 넘칠 때만 끝을 흐리게 (끝까지 넘기면 지운다)
  const fade = () => row.classList.toggle('is-overflow', row.scrollLeft + row.clientWidth < row.scrollWidth - 2);
  row.addEventListener('scroll', fade, { passive: true });
  queueMicrotask(() => {
    // 고른 칩을 줄 가운데로 (끝의 흐린 자리 · "모두" 에 가리지 않게) — 줄만 옆으로 넘긴다
    const on = row.querySelector('[aria-pressed="true"]');
    if (on) row.scrollLeft = Math.max(0, on.offsetLeft - row.offsetLeft - (row.clientWidth - on.offsetWidth) / 2);
    all.hidden = !onAll || row.scrollWidth <= row.clientWidth + 1;
    fade();
  });
  all.addEventListener('click', () => onAll?.(all));

  // 꾹 누르기(0.5초) → 폴더 메뉴. 그 뒤의 "누름" 은 폴더를 바꾸지 않게 막는다
  let hold = null;
  let held = false;
  row.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-folder]');
    held = false;
    if (!onMenu || !b?.dataset.folder) return;
    const start = { x: e.clientX, y: e.clientY };
    clearTimeout(hold);
    hold = setTimeout(() => {
      held = true;
      onMenu(b.dataset.folder, b);
    }, 500);
    const cancel = (ev) => {
      if (ev.type === 'pointermove' && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 8) return;
      clearTimeout(hold);
      row.removeEventListener('pointermove', cancel);
    };
    row.addEventListener('pointermove', cancel);
    row.addEventListener('pointerup', cancel, { once: true });
    row.addEventListener('pointercancel', cancel, { once: true });
  });
  row.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('[data-folder]');
    e.preventDefault(); // 꾹 누르기를 위 타이머가 맡는다 (휴대폰 글자 고르기 메뉴가 뜨지 않게)
    if (!onMenu || !b?.dataset.folder || held) return;
    clearTimeout(hold);
    held = true;
    onMenu(b.dataset.folder, b);
  });
  row.addEventListener('click', (e) => {
    if (held) {
      held = false;
      return;
    }
    if (e.target.closest('.fchip-add')) return openNew();
    const b = e.target.closest('[data-folder]');
    if (b) onPick(b.dataset.folder);
  });

  // ＋ → 그 자리에서 이름 칸 (Enter · 만들기, Esc · 다른 곳을 누르면 그만)
  function openNew() {
    const form = el('form', 'fchip-new');
    const input = el('input', 'fchip-input');
    input.type = 'text';
    input.maxLength = MAX_FOLDER_NAME;
    input.placeholder = '새 폴더 이름';
    input.setAttribute('aria-label', '새 폴더 이름');
    input.autocomplete = 'off';
    const ok = el('button', 'fchip fchip-ok', '만들기');
    ok.type = 'submit';
    form.append(input, ok);
    add.replaceWith(form);
    input.focus();
    form.scrollIntoView({ block: 'nearest', inline: 'end' });
    const close = () => form.isConnected && form.replaceWith(add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = cleanFolderName(input.value);
      if (!name) {
        input.setAttribute('aria-invalid', String(Boolean(input.value.trim())));
        return input.focus();
      }
      const same = folders.find((f) => f.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
      close();
      if (same) onPick(same.name); // 같은 이름이 있으면 그 폴더로
      else onCreate(name);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    form.addEventListener('focusout', () => setTimeout(() => !form.contains(document.activeElement) && !input.value.trim() && close(), 0));
  }
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
 * 폴더 고르기 (휴대폰 · 좁은 PC 창): 누른 단추 바로 아래에 펼쳐지는 목록 — 고른 폴더 이름 ("" = 전체), 그만두면 null.
 *   새 폴더는 그 자리에서 이름 칸이 열리고 만들면 { create: 이름 } (아래 시트 · 또 다른 창으로 오가던 동선을 줄였다)
 *   ⋯ 메뉴(onMenu)를 누르면 목록을 닫고 메뉴를 연다 (이름이 바뀌면 목록 내용이 낡으므로)
 * @param {{ folders: { name: string, count: number }[], current: string, anchor: HTMLElement,
 *           onMenu?: (name: string, anchor: { getBoundingClientRect(): DOMRect }) => any }} o
 */
export function openFolderSheet({ folders, current, onMenu, anchor }) {
  let result = null;
  const dialog = el('dialog', 'folder-pop');
  dialog.setAttribute('aria-label', '폴더');
  const body = el('div', 'folder-pop-body');
  dialog.append(body);
  // 단추 바로 아래, 화면 안에 들어오게
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const top = r.bottom + 6;
    Object.assign(dialog.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${Math.max(200, window.innerHeight - top - 12)}px` });
  };
  const done = (value) => {
    result = value;
    dialog.close();
  };
  // 새 폴더: "＋ 새 폴더" 자리에 이름 칸 (만들기 · Enter, 잘못된 이름은 그 아래 한 줄)
  const newInline = () => {
    const form = el('form', 'mf-inline');
    const input = el('input', 'mf-name-input');
    input.type = 'text';
    input.maxLength = MAX_FOLDER_NAME;
    input.placeholder = '새 폴더 이름';
    input.setAttribute('aria-label', '새 폴더 이름');
    input.autocomplete = 'off';
    const ok = el('button', 'btn primary', '만들기');
    ok.type = 'submit';
    const note = el('p', 'mf-name-note');
    note.setAttribute('role', 'status');
    form.append(input, ok, note);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = cleanFolderName(input.value);
      if (!name) {
        note.textContent = input.value.trim() ? '이 이름은 폴더 이름으로 쓸 수 없어요' : '';
        return input.focus();
      }
      const same = folders.find((f) => f.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
      done(same ? same.name : { create: name }); // 같은 이름이 있으면 그 폴더로
    });
    body.querySelector('.mf-new')?.replaceWith(form);
    input.focus();
  };
  renderFolderList(body, {
    folders, current,
    onPick: (name) => done(name),
    onNew: newInline,
    onMenu: onMenu && ((name, a) => {
      const r = a.getBoundingClientRect();
      done(null);
      onMenu(name, { getBoundingClientRect: () => r });
    }),
  });
  // 바깥을 누르면 닫는다
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) done(null);
  });
  const closed = new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      window.removeEventListener('resize', place);
      dialog.remove();
      resolve(result);
    });
  });
  window.addEventListener('resize', place);
  document.body.append(dialog);
  place();
  dialog.showModal();
  body.querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
  return closed;
}
