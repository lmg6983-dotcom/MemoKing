// 회상 › 한 장으로: 만든 그림을 먼저 크게 보여 주고 무엇을 할지 고른다 — 공유 · 복사 · 저장 · 메모로 만들기 (PC 목록 창 · 휴대폰 공용)
//   할 일(actions)은 기기마다 다르다 (PC: 공유 방법 메뉴 · 클립보드 · 저장 창, 휴대폰: 안드로이드 공유 창 · 저장 창).
//   run 은 끝나고 보일 안내 글을 돌려준다 (그만두면 ''). close: true 면 끝난 뒤 미리보기를 닫는다 (메모로 만들기 — 메모가 열린다)
import { icon } from './icons.js';

const el = (tag, className = '', text = '') => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

/** PNG(base64) → 바이트 (메모로 만들 때 첨부로 저장) */
export function base64Bytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 메모로 만들기: 제목 + 그림 한 장 (rel: 첨부 자리 attachments/…) */
export const collageMemoBody = (title, rel) => `# ${title}\n\n![${title}](${encodeURI(rel)})\n`;

/**
 * @param {{ title: string, base64: string, actions: { id: string, label: string, icon: string, run: (button: HTMLElement) => Promise<string|void>, close?: boolean }[],
 *           notify?: (text: string, isError?: boolean) => void, onOverlay?: (el: HTMLElement, close: () => void) => (() => void) }} o
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openCollagePreview({ title, base64, actions, notify = () => {}, onOverlay = null }) {
  const overlay = el('div', 'mem-preview');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${title} 미리보기`);
  const card = el('div', 'mem-preview-card');
  const top = el('div', 'mem-preview-top');
  top.append(el('h2', 'mem-preview-title', title));
  const closeBtn = el('button', 'icon-btn mem-preview-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.append(icon('close'));
  top.append(closeBtn);
  const frame = el('div', 'mem-preview-frame');
  const img = el('img', 'mem-preview-img');
  img.src = `data:image/png;base64,${base64}`;
  img.alt = `${title} 한 장 그림`;
  img.draggable = false;
  frame.append(img);
  const row = el('div', 'mem-preview-actions');
  for (const a of actions) {
    const b = el('button', `btn mem-preview-act${a.id === actions[0]?.id ? ' primary' : ''}`);
    b.type = 'button';
    b.dataset.act = a.id;
    b.append(icon(a.icon), el('span', '', a.label));
    b.addEventListener('click', async () => {
      if (b.getAttribute('aria-busy') === 'true') return;
      b.setAttribute('aria-busy', 'true');
      try {
        const msg = await a.run(b);
        if (msg) notify(msg);
        if (a.close && msg) close();
      } catch (err) {
        console.error(err);
        notify(err?.message || '하지 못했어요. 잠시 뒤 다시 해 주세요', true);
      } finally {
        b.removeAttribute('aria-busy');
      }
    });
    row.append(b);
  }
  card.append(top, frame, row);
  overlay.append(card);

  let release = null;
  const back = document.activeElement; // 닫으면 누른 단추(한 장으로)로 돌아간다
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('.mk-share-menu')) return; // 공유 방법 메뉴가 떠 있으면 그것부터 닫힌다
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  function close() {
    if (!overlay.isConnected || overlay.classList.contains('closing')) return;
    document.removeEventListener('keydown', onKey, true);
    release?.();
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 160);
    if (back?.isConnected) back.focus({ preventScroll: true });
  }
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  release = onOverlay?.(overlay, close) ?? null;
  row.querySelector('button')?.focus({ preventScroll: true });
  return { el: overlay, close };
}
