// 파일을 메모 창에 끌어다 놓기 — 창 어디에 놓아도(글 밖 여백 · 도구막대 위도) 놓은 자리에 들어간다
//   예전에는 ProseMirror 의 놓기가 받았는데, 놓은 좌표로 글 자리를 못 찾으면(posAtCoords 가 null) preventDefault 도 없이
//   말없이 끝났다 — 창은 "+" 커서로 받아 놓고 아무 일이 없었다. 그래서 파일 놓기는 창(capture)에서 먼저 받아 편집기에 바로 넘긴다
//   끄는 동안: 편집기 둘레에 흐르는 점선 틀 + 들어갈 자리에 노란 줄(빈 줄이면 그 줄 칸) + "여기에 넣기" 캡슐 (block-move 의 넣을 자리와 같은 모양)
import { isOwnDragOut } from './copy-content.js';

const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
const THEME_VARS = ['--note-text', '--note-bg', '--brand-yellow'];
const LINGER_MS = 350; // dragover 는 가만히 있어도 계속 온다 — 이만큼 안 오면 창 밖으로 나간 것 (dragleave 가 빠지는 웹뷰도)

/**
 * @param {HTMLElement} box 편집기를 담은 스크롤 칸 (#editor)
 * @param {() => { dropFiles: Function, dropTarget: Function } | null} getEditor
 * @param {(err: unknown) => void} onError
 * @param {() => void} onFolders 폴더만 놓았을 때 (폴더는 넣지 않는다 — 탐색기 · 매직키에서 끌어 온 폴더)
 */
export function setupFileDrop(box, getEditor, onError, onFolders) {
  const zone = document.createElement('div');
  zone.className = 'mk-file-drop';
  zone.hidden = true;
  zone.innerHTML = '<svg aria-hidden="true"><rect/></svg><div class="mk-file-drop-slot"></div><div class="mk-drag-badge" data-kind="insert"></div>';
  const slot = zone.querySelector('.mk-file-drop-slot');
  const badge = zone.querySelector('.mk-drag-badge');
  document.body.append(zone);
  let timer = 0;

  const hide = () => {
    clearTimeout(timer);
    zone.hidden = true;
  };

  const show = (x, y) => {
    const target = getEditor()?.dropTarget(x, y);
    if (!target) return false;
    const b = box.getBoundingClientRect();
    Object.assign(zone.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    const first = zone.hidden;
    zone.hidden = false;
    const r = target.rect;
    // 폭은 줄마다 다르지 않게 글 칸 전체에 (사진 · 칩 · 목록 줄 폭을 따르면 들쭉날쭉해 창과 안 맞아 보였다) — 둘레 점선 틀 안쪽으로
    const left = Math.max(target.doc.left - 6, b.left + 8) - b.left;
    const width = Math.min(target.doc.right + 6, b.right - 8) - b.left - left;
    // 빈 줄은 그 줄 칸이 바뀌고, 그 밖은 줄 사이 얇은 막대 — 줄이 화면 밖이면 보이는 끝에 붙인다
    const top = target.replace ? r.top : (target.above ? r.top : r.bottom) - 3;
    const height = target.replace ? Math.max(r.height, 24) : 6;
    slot.classList.toggle('line', !target.replace);
    if (first) slot.style.transition = 'none';
    Object.assign(slot.style, {
      left: `${left}px`,
      width: `${Math.max(24, width)}px`,
      top: `${Math.min(Math.max(top - b.top, 2), b.height - height - 2)}px`,
      height: `${height}px`,
    });
    if (first) {
      requestAnimationFrame(() => (slot.style.transition = ''));
      // 메모 색(글자 · 바탕)은 편집기 쪽에 정해져 있다 — 메모마다 색이 달라 보일 때마다 (drag-frames.js 와 같게)
      const cs = getComputedStyle(box);
      for (const v of THEME_VARS) zone.style.setProperty(v, cs.getPropertyValue(v).trim());
    }
    badge.textContent = target.replace ? '↳ 이 줄에 넣기' : '↳ 여기에 넣기';
    badge.style.top = `${parseFloat(slot.style.top) + height / 2}px`;
    return true;
  };

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // 놓을 수 있게 — 글 밖 여백 · 도구막대 위에서도
    const ok = show(e.clientX, e.clientY);
    e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
    if (!ok) hide();
    clearTimeout(timer);
    timer = setTimeout(hide, LINGER_MS);
  }, true);
  window.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && !e.relatedTarget) hide(); // 창 밖으로
  }, true);
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation(); // 편집기(ProseMirror · 업로드 플러그인)가 또 넣지 않게
    hide();
    // 폴더는 빼고 (폴더는 webkitGetAsEntry 로만 알 수 있다 — 목록 창 list.js 와 같게). 폴더만이면 알린다
    const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry?.());
    const files = [...e.dataTransfer.files].filter((_f, i) => !entries[i]?.isDirectory);
    const editor = getEditor();
    if (!files.length && entries.some((x) => x?.isDirectory)) return onFolders?.();
    if (!files.length || !editor || isOwnDragOut(e.dataTransfer)) return; // 메모에서 끌어낸 것이 도로 떨어짐 (block-move.js)
    editor.dropFiles(files, e.clientX, e.clientY).catch(onError);
  }, true);
}
