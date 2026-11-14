// 오른쪽 클릭 메뉴 (PC, 메모 창의 내용 — 그림 · 파일 · 표 · 소리 …) — Windows 11 탐색기 메뉴처럼
//   맨 위 한 줄에 아이콘 단추들(복사 · 저장 · 공유 · 지우기), 그 아래에 글 항목들 (열기 · 표 바꾸기 …).
//   Electron 의 기본(네이티브) 메뉴는 아이콘 줄을 못 그려서 화면(HTML)에서 직접 그린다 — 글 칸의 메뉴(잘라내기 · 붙여넣기 …)는 그대로 네이티브.
//   키보드: ←→(아이콘 줄) · ↑↓ · Home · End · Tab · Enter · Space · Esc. 바깥을 누르거나 창이 바뀌거나 스크롤하면 닫힌다.
//   메뉴가 뜬 동안 편집기의 고른 자리는 그대로, 닫으면 편집기로 포커스를 돌려준다 (onClose).
import { clearOfSticker } from './sticker-zone.js';

let current = null; // { el, done, cleanup }

/** 메뉴가 떠 있는가 (다른 곳에서 단추 · 호버를 띄우지 않게) */
export const isContextMenuOpen = () => Boolean(current);

export function closeContextMenu(result = null) {
  if (!current) return;
  const { el, done, cleanup } = current;
  current = null;
  cleanup();
  el.classList.add('closing');
  setTimeout(() => el.remove(), 90);
  done(result);
}

/**
 * @param {{ x: number, y: number, icons?: { id: string, label: string, short?: string, icon: string, danger?: boolean, disabled?: boolean }[],
 *           items?: ({ id: string, label: string, hint?: string, disabled?: boolean, checked?: boolean }
 *                    | { type: 'colors', label: string, colors: { id: string, label: string, color: string, checked?: boolean }[] }
 *                    | { type: 'separator' })[],
 *           label?: string }} o  icon: 16×16 svg 글 (content-icons.js)
 * @returns {Promise<string | null>} 고른 id (닫으면 null)
 */
// clamp: 단추 아래에 붙이는 메뉴 — 오른쪽 자리가 모자라면 커서 왼쪽으로 뒤집지 않고 화면 안으로 민다
export function openContextMenu({ x, y, icons = [], items = [], label = '메뉴', clamp = false }) {
  closeContextMenu();
  const el = document.createElement('div');
  el.className = 'mk-ctx';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', label);
  el.tabIndex = -1;
  const focusables = []; // 키보드로 오가는 단추들 (아이콘 줄 → 항목들)
  let done;
  const result = new Promise((resolve) => (done = resolve));
  const make = (spec, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('role', 'menuitem');
    b.disabled = Boolean(spec.disabled);
    b.dataset.id = spec.id;
    if (spec.danger) b.classList.add('danger');
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기 커서를 빼앗지 않게
    b.addEventListener('click', () => {
      if (cls === 'mk-ctx-ic' && spec.id === 'copy') {
        b.classList.add('done');
        b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
        setTimeout(() => closeContextMenu(spec.id), 180);
        return;
      }
      closeContextMenu(spec.id);
    });
    focusables.push(b);
    return b;
  };
  if (icons.length) {
    const row = document.createElement('div');
    row.className = 'mk-ctx-icons';
    row.setAttribute('role', 'group');
    for (const spec of icons) {
      const b = make(spec, 'mk-ctx-ic');
      b.title = spec.label; // 마우스를 올리면 이름 (Windows 메뉴의 아이콘처럼)
      b.setAttribute('aria-label', spec.label);
      if (spec.short) b.dataset.label = spec.short; // 아이콘 아래 짧은 이름 (ctx-menu.css)
      b.innerHTML = spec.icon;
      row.append(b);
    }
    el.append(row);
  }
  // 맨 앞 · 맨 뒤 · 연이은 구분선은 그리지 않는다 (호출하는 쪽이 항목을 이어 붙여도 어색하지 않게)
  const tidy = items.filter((it, i, all) => !(it.type === 'separator' && (i === 0 || i === all.length - 1 || all[i - 1].type === 'separator')));
  if (tidy.length) {
    const list = document.createElement('div');
    list.className = 'mk-ctx-list';
    for (const spec of tidy) {
      if (spec.type === 'separator') {
        const hr = document.createElement('div');
        hr.className = 'mk-ctx-sep';
        hr.setAttribute('role', 'separator');
        list.append(hr);
        continue;
      }
      if (spec.type === 'colors') {
        const row = document.createElement('div');
        row.className = 'mk-ctx-colors';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', spec.label);
        const name = document.createElement('span');
        name.className = 'mk-ctx-text';
        name.textContent = spec.label;
        const dots = document.createElement('div');
        dots.className = 'mk-ctx-swatches';
        for (const c of spec.colors) {
          const b = make(c, 'mk-ctx-sw');
          b.setAttribute('role', 'menuitemradio');
          b.setAttribute('aria-checked', String(c.checked === true));
          b.setAttribute('aria-label', `${spec.label} ${c.label}`);
          b.dataset.color = c.color;
          b.title = c.label;
          dots.append(b);
        }
        row.append(name, dots);
        list.append(row);
        continue;
      }
      const b = make(spec, 'mk-ctx-item');
      if (spec.checked !== undefined) {
        b.setAttribute('role', 'menuitemcheckbox');
        b.setAttribute('aria-checked', String(spec.checked === true));
      }
      const text = document.createElement('span');
      text.className = 'mk-ctx-text';
      text.textContent = spec.label;
      b.append(text);
      if (spec.hint) {
        const hint = document.createElement('span');
        hint.className = 'mk-ctx-hint';
        hint.textContent = spec.hint;
        b.append(hint);
      }
      list.append(b);
    }
    el.append(list);
  }
  document.body.append(el);
  // 화면 안으로 (오른쪽 · 아래가 모자라면 마우스 왼쪽 · 위로)
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = clamp ? Math.max(6, Math.min(x, window.innerWidth - w - 6)) : x + w + 6 > window.innerWidth ? Math.max(6, x - w) : x;
  const below = y + h + 6 > window.innerHeight ? Math.max(6, y - h) : y;
  const top = clearOfSticker({ left, top: below, width: w }); // 왕관 · 테이프 스티커 아래로
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  // 메뉴는 마우스가 누른 모서리에서 펼쳐진다 (화면 끝이라 왼쪽 · 위로 뒤집혀 떴으면 그쪽 모서리에서)
  el.style.transformOrigin = `${left < x ? 'right' : 'left'} ${top < y ? 'bottom' : 'top'}`;

  const enabled = () => focusables.filter((b) => !b.disabled);
  const step = (dir) => {
    const list = enabled();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    list[(i + dir + list.length) % list.length].focus({ preventScroll: true });
  };
  // 위 · 아래는 "줄" 단위 (아이콘 줄 · 색 줄은 한 줄), 좌 · 우는 그 줄 안에서
  const rowsOf = () => {
    const rows = [];
    for (const b of enabled()) {
      const group = b.classList.contains('mk-ctx-ic') ? 'ic' : b.classList.contains('mk-ctx-sw') ? 'sw' : null;
      const last = rows.at(-1);
      if (group && last?.group === group) last.buttons.push(b);
      else rows.push({ group, buttons: [b] });
    }
    return rows;
  };
  const stepRow = (dir) => {
    const rows = rowsOf();
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.buttons.includes(document.activeElement));
    const next = rows[(at < 0 ? (dir > 0 ? 0 : rows.length - 1) : (at + dir + rows.length) % rows.length)];
    (next.buttons.find((b) => b.getAttribute('aria-checked') === 'true') ?? next.buttons[0]).focus({ preventScroll: true });
  };
  const onKey = (e) => {
    const k = e.key;
    const active = document.activeElement;
    const row = rowsOf().find((r) => r.group && r.buttons.includes(active));
    if (k === 'Escape') closeContextMenu();
    else if (k === 'ArrowDown') stepRow(1);
    else if (k === 'ArrowUp') stepRow(-1);
    else if (k === 'Tab') step(e.shiftKey ? -1 : 1);
    else if ((k === 'ArrowRight' || k === 'ArrowLeft') && (row || rowsOf().some((r) => r.group === 'ic'))) {
      const buttons = row ? row.buttons : rowsOf().find((r) => r.group === 'ic').buttons;
      const i = buttons.indexOf(active);
      const n = i < 0 ? (k === 'ArrowRight' ? 0 : buttons.length - 1) : (i + (k === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[n].focus({ preventScroll: true });
    } else if (k === 'Home') enabled()[0]?.focus({ preventScroll: true });
    else if (k === 'End') enabled().at(-1)?.focus({ preventScroll: true });
    else if (k === 'Enter' || k === ' ') {
      if (!el.contains(active) || active === el) return closeContextMenu(); // 고른 것이 없으면 그냥 닫기
      return; // 단추의 기본 동작(click)
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e) => {
    if (!el.contains(e.target)) closeContextMenu();
  };
  // 꾹 눌러 연 메뉴: 손가락을 아직 대고 있을 때 안드로이드가 뒤늦게 보내는 contextmenu 는 "밖을 눌렀다" 가 아니다
  //   (폴더 칩은 500ms 타이머로 먼저 열고, 안드로이드의 꾹 누르기 신호가 그 직후에 와서 메뉴가 뜨자마자 닫혔다)
  const openedAt = performance.now();
  const onMenu = (e) => {
    if (el.contains(e.target) || performance.now() - openedAt < 1000) e.preventDefault(); // 메뉴 위의 오른쪽 클릭은 아무 일 없이
    else closeContextMenu();
  };
  const close = () => closeContextMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('contextmenu', onMenu, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  window.addEventListener('wheel', close, { passive: true, capture: true });
  const cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('contextmenu', onMenu, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    window.removeEventListener('wheel', close, { capture: true });
  };
  current = { el, done, cleanup };
  el.focus({ preventScroll: true });
  return result;
}
