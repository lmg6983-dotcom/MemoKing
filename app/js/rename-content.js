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
      if (e.key === 'Tab') {
        // 창 안에서만 포커스가 돈다 (뒤의 메모로 빠져나가지 않게)
        const stops = [input, cancel, ok];
        const i = stops.indexOf(document.activeElement);
        e.preventDefault();
        stops[(i + (e.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
        return;
      }
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

// "앞으로 이렇게" 로 기억한 고르기 (이 기기에만 — 설정의 "넣을 때 다시 묻기" 로 지운다)
const CHOICE_KEY = 'memoking.choices';
const loadChoices = () => {
  try {
    return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
};
/** 기억한 고르기가 있나 (설정에서 "다시 묻기" 단추를 보일지) */
export const hasRememberedChoices = () => Object.keys(loadChoices()).length > 0;
export function forgetChoices() {
  try {
    localStorage.removeItem(CHOICE_KEY);
  } catch {
    // 지우지 못해도 이번엔 그대로
  }
}

/**
 * 고르기 창 (PC·휴대폰 함께 — promptName 과 같은 모양): 단추 하나를 고르면 그 id, Esc · 바깥 누르기는 null
 *   remember: 이 이름으로 "앞으로 이렇게" 칸을 보이고, 기억해 둔 것이 있으면 묻지 않고 그것을 돌려준다
 * @param {{ title: string, message?: string, choices: { id: string, label: string, primary?: boolean }[], remember?: string }} o
 * @returns {Promise<string|null>}
 */
export function promptChoice({ title, message = '', choices, remember = '' }) {
  const kept = remember ? loadChoices()[remember] : null;
  if (kept && choices.some((c) => c.id === kept)) return Promise.resolve(kept);
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'mk-prompt-back';
    const box = document.createElement('div');
    box.className = 'mk-prompt';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    const h = document.createElement('b');
    h.textContent = title;
    box.append(h);
    if (message) {
      const p = document.createElement('p');
      p.className = 'mk-prompt-msg';
      p.textContent = message;
      box.append(p);
    }
    const row = document.createElement('div');
    row.className = 'mk-prompt-actions';
    const buttons = choices.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      if (c.primary) b.className = 'primary';
      b.textContent = c.label;
      b.addEventListener('click', () => done(c.id));
      return b;
    });
    row.append(...buttons);
    let keep = null;
    if (remember) {
      const label = document.createElement('label');
      label.className = 'mk-prompt-keep';
      keep = document.createElement('input');
      keep.type = 'checkbox';
      label.append(keep, document.createTextNode('앞으로 묻지 않고 이렇게 (설정에서 다시 묻게 할 수 있어요)'));
      box.append(label);
    }
    box.append(row);
    wrap.append(box);
    const restore = document.activeElement;
    let closed = false;
    const done = (result) => {
      if (closed) return;
      closed = true;
      if (keep?.checked && result) {
        try {
          localStorage.setItem(CHOICE_KEY, JSON.stringify({ ...loadChoices(), [remember]: result }));
        } catch {
          // 기억하지 못해도 이번 고르기는 그대로
        }
      }
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus({ preventScroll: true });
      resolve(result);
    };
    const stops = keep ? [keep, ...buttons] : buttons;
    const onKey = (e) => {
      if (e.key === 'Tab') {
        const i = stops.indexOf(document.activeElement);
        e.preventDefault();
        stops[(i + (e.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length].focus();
        return;
      }
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      done(null);
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', (e) => e.target === wrap && done(null));
    document.body.append(wrap);
    (buttons.find((b) => b.className === 'primary') ?? buttons[0])?.focus();
  });
}
