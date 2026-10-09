// 단축키 한눈에 보기 (Ctrl+/ · 메뉴 › 단축키 보기)
import { SHORTCUT_GROUPS } from './core/shortcuts.js';

let dialog = null;

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'dialog shortcut-sheet';
  dialog.setAttribute('aria-labelledby', 'shortcut-sheet-title');
  dialog.tabIndex = -1;
  const head = document.createElement('header');
  const h = document.createElement('h3');
  h.id = 'shortcut-sheet-title';
  h.textContent = '단축키';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = '닫기';
  close.addEventListener('click', () => dialog.close());
  head.append(h, close);
  dialog.append(head);
  for (const g of SHORTCUT_GROUPS) {
    const sec = document.createElement('section');
    const t = document.createElement('h4');
    t.textContent = g.title;
    const dl = document.createElement('dl');
    for (const [what, keys] of g.items) {
      const dt = document.createElement('dt');
      dt.textContent = what;
      const dd = document.createElement('dd');
      for (const [i, part] of keys.split(' / ').entries()) {
        if (i) dd.append(' / ');
        const k = document.createElement('kbd');
        k.textContent = part;
        dd.append(k);
      }
      dl.append(dt, dd);
    }
    sec.append(t, dl);
    dialog.append(sec);
  }
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close(); // 바깥(배경)을 누르면 닫힘
  });
  document.body.append(dialog);
}

export function toggleShortcutSheet() {
  if (!dialog) build();
  if (dialog.open) dialog.close();
  else {
    dialog.showModal();
    dialog.focus(); // 닫기 단추에 굵은 포커스 테두리가 먼저 가지 않게 (Esc 로 닫힘)
  }
}
