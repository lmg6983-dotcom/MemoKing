// 비밀 폴더 창 (PC 목록 창 · 휴대폰 같음) — 저장 · 암호 규칙은 core/secret-folders.js
//   폴더 메뉴(꾹 누르기 · 오른쪽 클릭) › 비밀 폴더로 만들기: 비밀번호 두 번 + 잊으면 되찾을 수 없다는 안내
//   잠긴 비밀 폴더를 누르면: 그 폴더의 비밀번호 (폴더마다 비밀번호가 따로)
import { sheet } from './folder-ui.js';
import { icon } from './icons.js';
import { secretPasswordProblem } from './core/secret-folders.js';

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function input(label, autocomplete) {
  const i = el('input', 'mf-name-input');
  i.type = 'password';
  i.placeholder = label;
  i.setAttribute('aria-label', label);
  i.autocomplete = autocomplete;
  i.spellcheck = false;
  return i;
}

/** 비밀번호 칸 + 알림 줄 + 단추를 담은 양식 — onSubmit 이 실패 까닭을 주면 보이고, null 이면 닫는다 */
function passwordSheet({ title, note, warn, fields, okLabel, busyLabel, onSubmit }) {
  const { body, closed, done } = sheet(title, 'secret-dialog');
  const form = el('form', 'mf-name-form secret-form');
  const why = el('p', 'mf-name-note');
  why.setAttribute('role', 'alert');
  const ok = el('button', 'btn primary', okLabel);
  ok.type = 'submit';
  form.append(...fields, ...(warn ? [el('p', 'secret-warn', warn)] : []), why, ok);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!fields[0].value) return fields[0].focus();
    ok.disabled = true;
    ok.textContent = busyLabel; // 열쇠 만들기는 일부러 느리다 (0.3초쯤)
    const fail = await onSubmit(fields.map((f) => f.value)).catch((err) => err?.message || '하지 못했어요');
    ok.disabled = false;
    ok.textContent = okLabel;
    if (!fail) return done(true);
    why.textContent = fail;
    fields[0].select();
  });
  body.append(...(note ? [el('p', 'secret-note', note)] : []), form);
  fields[0].focus();
  return closed;
}

/**
 * 잠긴 비밀 폴더 열기 → 열었으면 true
 * @param {{ name: string, onTry: (password: string) => Promise<string|null> }} o onTry: 실패 까닭 또는 null
 */
export function askSecretPassword({ name, onTry }) {
  return passwordSheet({
    title: `${name} 비밀 폴더`,
    note: '비밀번호를 넣으면 메모가 보여요. 다 보고 나면 저절로 다시 잠겨요.',
    fields: [input('비밀번호', 'current-password')],
    okLabel: '열기',
    busyLabel: '여는 중',
    onSubmit: ([pw]) => onTry(pw),
  }).then(Boolean);
}

/**
 * 보통 폴더를 비밀 폴더로 만들 비밀번호 → 만들었으면 true
 * @param {{ name: string, count: number, onMake: (password: string) => Promise<string|null> }} o
 */
export function askNewSecretPassword({ name, count, onMake }) {
  return passwordSheet({
    title: `${name} 폴더를 비밀 폴더로`,
    note: `${count ? `안의 메모 ${count}개와 사진 · 파일을 ` : '이 폴더를 '}비밀번호로 잠가요. 폴더 이름은 자물쇠와 함께 보이고, 누르면 비밀번호를 물어요.`,
    warn: '비밀번호를 잊으면 메모킹도 되찾아 드릴 수 없어요. 그 안의 메모와 사진 · 파일도 함께 잃어요.',
    fields: [input('비밀번호 (4자 이상)', 'new-password'), input('비밀번호 한 번 더', 'new-password')],
    okLabel: '비밀 폴더로 만들기',
    busyLabel: '잠그는 중',
    onSubmit: ([p1, p2]) => {
      const problem = secretPasswordProblem(p1) ?? (p1 !== p2 ? '두 비밀번호가 달라요' : null);
      return problem ? Promise.resolve(problem) : onMake(p1);
    },
  }).then(Boolean);
}

/** 메모를 옮길 비밀 폴더 고르기 (연 폴더만) → fid, 그만두면 null */
export function pickSecretFolder(opened) {
  const { body, closed, done } = sheet('비밀 폴더로 옮기기', 'folder-pick-dialog');
  const note = el('p', 'secret-note', '옮기면 내용 · 제목 · 사진 · 파일까지 그 폴더의 비밀번호로 잠겨요.');
  const ul = el('ul', 'secret-open');
  for (const f of opened) {
    const b = el('button', 'mf-item');
    b.type = 'button';
    b.append(icon('lock-open'), el('span', 'mf-name', f.name));
    b.addEventListener('click', () => done(f.fid));
    const li = el('li', 'mf-row');
    li.append(b);
    ul.append(li);
  }
  body.append(note, ul);
  return closed;
}
