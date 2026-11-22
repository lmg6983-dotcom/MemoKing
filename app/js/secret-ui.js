// 비밀 폴더 창 (PC 목록 창 · 휴대폰 설정 같음) — 저장 · 암호 규칙은 core/secret-folders.js
//   열기: 비밀번호 하나 → 그 비밀번호로 잠근 폴더가 모두 열린다 (폴더마다 비밀번호가 따로)
//   만들기: 이름 + 비밀번호 두 번. 비밀번호는 어디에도 두지 않아 잊으면 되찾을 수 없다고 먼저 알린다
//   열린 폴더: 하나씩 · 모두 잠그기
import { sheet } from './folder-ui.js';
import { icon } from './icons.js';
import { MAX_FOLDER_NAME, cleanFolderName } from './core/folders.js';
import { secretPasswordProblem } from './core/secret-folders.js';

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function input(type, label, { placeholder = label, autocomplete = 'off', max = 0 } = {}) {
  const i = el('input', 'mf-name-input');
  i.type = type;
  i.placeholder = placeholder;
  i.setAttribute('aria-label', label);
  i.autocomplete = autocomplete;
  i.spellcheck = false;
  if (max) i.maxLength = max;
  return i;
}

/**
 * @param {{ opened: { fid: string, name: string }[],
 *           onOpen: (password: string) => Promise<string|null>,   실패 이유 또는 null (열림)
 *           onCreate: (name: string, password: string) => Promise<string|null>,
 *           onLock: (fid: string|null) => void }} o
 * @returns {Promise<void>} 창을 닫으면
 */
export function openSecretSheet({ opened, onOpen, onCreate, onLock }) {
  const { body, closed, done } = sheet('비밀 폴더', 'secret-dialog');
  const note = el('p', 'secret-note', '폴더마다 비밀번호가 따로예요. 비밀번호를 넣으면 그 비밀번호의 비밀 폴더가 폴더 목록에 나타나고, 앱을 나가면 다시 잠겨요.');
  const list = el('ul', 'secret-open');
  const renderOpened = (items) => {
    list.replaceChildren();
    list.hidden = !items.length;
    for (const f of items) {
      const li = el('li', 'secret-row');
      const name = el('span', 'secret-name');
      name.append(icon('lock'), el('span', '', f.name));
      const lock = el('button', 'btn small', '잠그기');
      lock.type = 'button';
      lock.addEventListener('click', () => {
        onLock(f.fid);
        renderOpened(items.filter((x) => x.fid !== f.fid));
      });
      li.append(name, lock);
      list.append(li);
    }
  };
  renderOpened(opened);

  // 열기
  const openForm = el('form', 'mf-name-form secret-form');
  const pw = input('password', '비밀번호', { autocomplete: 'current-password' });
  const openNote = el('p', 'mf-name-note');
  openNote.setAttribute('role', 'alert');
  const openBtn = el('button', 'btn primary', '열기');
  openBtn.type = 'submit';
  openForm.append(pw, openNote, openBtn);
  openForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pw.value) return pw.focus();
    openBtn.disabled = true;
    openBtn.textContent = '여는 중';
    const fail = await onOpen(pw.value).catch((err) => err?.message || '열지 못했어요');
    openBtn.disabled = false;
    openBtn.textContent = '열기';
    if (fail) {
      openNote.textContent = fail;
      pw.select();
      return;
    }
    done(true);
  });

  // 만들기
  const makeBtn = el('button', 'link-btn secret-make', '＋ 새 비밀 폴더');
  makeBtn.type = 'button';
  const makeForm = el('form', 'mf-name-form secret-form');
  makeForm.hidden = true;
  const name = input('text', '비밀 폴더 이름', { placeholder: '이름 (예: 일기)', max: MAX_FOLDER_NAME });
  const p1 = input('password', '비밀번호 (4자 이상)', { autocomplete: 'new-password' });
  const p2 = input('password', '비밀번호 한 번 더', { autocomplete: 'new-password' });
  const warn = el('p', 'secret-warn', '비밀번호를 잊으면 메모킹도 되찾아 드릴 수 없어요. 그 안의 메모와 사진 · 파일도 함께 잃어요.');
  const makeNote = el('p', 'mf-name-note');
  makeNote.setAttribute('role', 'alert');
  const make = el('button', 'btn primary', '만들기');
  make.type = 'submit';
  makeForm.append(name, p1, p2, warn, makeNote, make);
  makeBtn.addEventListener('click', () => {
    makeBtn.hidden = true;
    openForm.hidden = true;
    makeForm.hidden = false;
    name.focus();
  });
  makeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clean = cleanFolderName(name.value);
    const problem = !clean ? '이 이름은 폴더 이름으로 쓸 수 없어요' : secretPasswordProblem(p1.value) ?? (p1.value !== p2.value ? '두 비밀번호가 달라요' : null);
    if (problem) {
      makeNote.textContent = problem;
      return;
    }
    make.disabled = true;
    make.textContent = '만드는 중';
    const fail = await onCreate(clean, p1.value).catch((err) => err?.message || '만들지 못했어요');
    make.disabled = false;
    make.textContent = '만들기';
    if (fail) {
      makeNote.textContent = fail;
      return;
    }
    done(true);
  });

  body.append(note, list, openForm, makeForm, makeBtn);
  pw.focus();
  return closed;
}

/** 메모를 옮길 비밀 폴더 고르기 → fid, 그만두면 null */
export function pickSecretFolder(opened) {
  const { body, closed, done } = sheet('비밀 폴더로 옮기기', 'folder-pick-dialog');
  const note = el('p', 'secret-note', '옮기면 내용 · 제목 · 사진 · 파일까지 그 폴더의 비밀번호로 잠겨요.');
  const ul = el('ul', 'secret-open');
  for (const f of opened) {
    const b = el('button', 'mf-item');
    b.type = 'button';
    b.append(icon('lock'), el('span', 'mf-name', f.name));
    b.addEventListener('click', () => done(f.fid));
    const li = el('li', 'mf-row');
    li.append(b);
    ul.append(li);
  }
  body.append(note, ul);
  return closed;
}
