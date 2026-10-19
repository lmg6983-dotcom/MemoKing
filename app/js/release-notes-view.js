// "바뀐 점" 을 화면에: 제목 줄 + 항목 목록 (core/release-notes.js). 글을 HTML 로 넣지 않고 요소로 만든다 (PC · 휴대폰 새 버전 안내가 함께 씀)
import { parseReleaseNotes, boldParts } from './core/release-notes.js';

/** @param {HTMLElement} box 비워서 다시 채운다 · @param {string} notes 릴리스 노트 글 · @param {string} empty 적힌 것이 없을 때 */
export function renderReleaseNotes(box, notes, empty = '바뀐 점이 적혀 있지 않아요') {
  box.replaceChildren();
  const blocks = parseReleaseNotes(notes);
  if (!blocks.length) {
    const p = document.createElement('p');
    p.className = 'notes-empty';
    p.textContent = empty;
    box.append(p);
    return;
  }
  const inline = (el, text) => {
    for (const part of boldParts(text)) {
      if (part.bold) {
        const b = document.createElement('strong');
        b.textContent = part.text;
        el.append(b);
      } else el.append(part.text);
    }
  };
  let ul = null;
  for (const block of blocks) {
    if (block.type === 'head') {
      ul = null;
      const h = document.createElement('p');
      h.className = 'notes-head';
      inline(h, block.text);
      box.append(h);
    } else {
      if (!ul) {
        ul = document.createElement('ul');
        ul.className = 'notes-list';
        box.append(ul);
      }
      const li = document.createElement('li');
      inline(li, block.text);
      ul.append(li);
    }
  }
}
