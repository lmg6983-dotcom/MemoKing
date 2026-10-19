// 파일 · 소리 · 그림 이름 바꾸기 (PC 오른쪽 클릭 메뉴 › 이름 변경…)
//   파일 칩의 이름 = 칩 글자, 그림 · 소리 · 음성 카드의 이름 = 설명(alt). 메모 폴더의 실제 파일은 그대로 (이름은 보이는 이름)
//   — 저장 · 공유 · 끌어내기에서 이 이름으로 나간다
import { isVoiceCard } from './voice-card-view.js';
import { chipRanges } from './file-chip-guard.js';
import { mediaKindOf } from './core/memo-file.js';

const BAD = /[\\/:*?"<>|\u0000-\u001f]+/g;
const extOf = (name) => /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';

/** 이름을 바꿀 수 있는 것 { kind: 'chip' | 'image', from, to, name, pos? } | null — 줄(문단 · 음성 카드)에서 첫 파일 칩, 없으면 첫 그림 · 소리 */
export function renameTarget(doc, pos, node) {
  const voice = isVoiceCard(node);
  const para = voice ? node.firstChild : node?.type.name === 'paragraph' ? node : null;
  if (!para) return null;
  const start = pos + (voice ? 2 : 1);
  const chip = chipRanges(para, start)[0];
  if (chip) return { kind: 'chip', from: chip.from, to: chip.to, name: doc.textBetween(chip.from, chip.to) };
  let found = null;
  para.forEach((child, off) => {
    if (!found && child.type.name === 'image') found = { kind: 'image', pos: start + off, name: child.attrs.alt ?? '' };
  });
  return found;
}

/** 입력한 이름을 다듬는다: 쓸 수 없는 글자 빼기, 확장자가 없으면 원래 확장자 붙이기(파일 칩) → 빈 이름이면 '' */
export function cleanName(input, old, keepExt) {
  let name = String(input ?? '').replace(BAD, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120);
  if (!name) return '';
  if (keepExt && !extOf(name)) name += extOf(old);
  return name;
}

/** 이름을 바꾸는 트랜잭션을 보낸다 → true(바뀜) | false(바꾸지 않음) | 'kind'(.webm 은 설명에 동영상 · 영상 · video 가 있느냐로 영상/소리를 가르므로 그 구분이 바뀌는 이름은 받지 않는다) */
export function renameContent(view, target, newName) {
  if (!target || !newName || newName === target.name) return false;
  const { state } = view;
  let tr = state.tr;
  if (target.kind === 'chip') {
    const marks = state.doc.nodeAt(target.from)?.marks ?? [];
    tr = tr.replaceWith(target.from, target.to, state.schema.text(newName, marks)).setMeta('memoking-allow-chip-edit', true);
  } else {
    const node = state.doc.nodeAt(target.pos);
    if (node?.type.name !== 'image') return false;
    if (mediaKindOf(node.attrs.src, node.attrs.alt ?? '') !== mediaKindOf(node.attrs.src, newName)) return 'kind';
    tr = tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, alt: newName });
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** 이름 입력 창 → 새 이름 | null (Enter 확인 · Esc 취소 · 이름 부분만 미리 골라 둠) */
export function promptName({ title = '이름 변경', value = '', label = '새 이름' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'mk-prompt-back';
    const box = document.createElement('form');
    box.className = 'mk-prompt';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    const h = document.createElement('b');
    h.textContent = title;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.maxLength = 120;
    input.setAttribute('aria-label', label);
    input.autocomplete = 'off';
    input.spellcheck = false;
    const row = document.createElement('div');
    row.className = 'mk-prompt-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '취소';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'primary';
    ok.textContent = '바꾸기';
    row.append(cancel, ok);
    box.append(h, input, row);
    wrap.append(box);
    const restore = document.activeElement;
    let closed = false;
    const done = (result) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus({ preventScroll: true });
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      done(null);
    };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => done(null));
    wrap.addEventListener('mousedown', (e) => e.target === wrap && done(null));
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      done(input.value);
    });
    document.body.append(wrap);
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length); // 확장자는 그대로 두고 이름만 바꾸기 쉽게
  });
}
