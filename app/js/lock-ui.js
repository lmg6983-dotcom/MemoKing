// 잠금 메모 화면 (PC 메모 창·휴대폰 같음): 잠글 때 비밀번호 정하기 창, 잠긴 메모를 열 때 비밀번호 화면
//   잊으면 아무도(메모킹도) 열 수 없다는 것과, 제목은 목록에 보이고 사진·파일은 잠기지 않는다는 것을 미리 알린다
import { passwordProblem } from './core/memo-lock.js';

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

function passwordField(label, id) {
  const wrap = el('label', { class: 'lock-field' });
  const input = el('input', { type: 'password', id, autocomplete: 'new-password', spellcheck: 'false', 'aria-label': label });
  wrap.append(el('span', {}, label), input);
  return { wrap, input };
}

/**
 * 잠글 때: 비밀번호 두 번 → 맞으면 onLock(비밀번호) (실패하면 그 이유를 창에 보여 줌)
 * @param {{ onLock: (password: string) => Promise<string|null> }} o onLock 은 실패 이유 또는 null
 * @returns {Promise<boolean>} 잠갔는지
 */
export function lockDialog({ onLock }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'dialog lock-dialog', 'aria-labelledby': 'lock-dialog-title' });
    const form = el('form', { method: 'dialog' });
    const first = passwordField('비밀번호 (4자 이상)', 'lock-pass-1');
    const second = passwordField('한 번 더', 'lock-pass-2');
    const error = el('p', { class: 'lock-error', role: 'alert' });
    const cancel = el('button', { type: 'button', class: 'btn' }, '취소');
    const ok = el('button', { type: 'submit', class: 'btn primary' }, '잠그기');
    const actions = el('div', { class: 'dialog-actions' });
    actions.append(cancel, ok);
    form.append(
      el('h2', { id: 'lock-dialog-title' }, '메모 잠그기'),
      el('p', { class: 'lock-note' }, '비밀번호를 잊으면 아무도 열 수 없어요. 메모킹도 되찾아 드릴 수 없어요.\n제목은 목록에 보이고, 넣은 사진과 파일은 잠기지 않아요.'),
      first.wrap, second.wrap, error, actions,
    );
    dialog.append(form);
    document.body.append(dialog);
    let done = false;
    let busy = false; // 잠그는 중에는 취소할 수 없다 (창만 닫히고 메모는 잠기는 일이 없게 — 끝나면 결과대로 닫힘)
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => !busy && finish(false));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (!busy) finish(false);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = first.input.value;
      const problem = passwordProblem(pw) ?? (pw !== second.input.value ? '두 비밀번호가 달라요' : null);
      if (problem) {
        error.textContent = problem;
        return;
      }
      busy = true;
      ok.disabled = true;
      cancel.disabled = true;
      ok.textContent = '잠그는 중…';
      let fail;
      try {
        fail = await onLock(pw);
      } catch (err) {
        fail = err?.message || '잠그지 못했어요';
      }
      busy = false;
      cancel.disabled = false;
      if (fail) {
        error.textContent = fail;
        ok.disabled = false;
        ok.textContent = '잠그기';
        return;
      }
      finish(true);
    });
    dialog.showModal();
    first.input.focus();
  });
}

/**
 * 잠긴 메모를 열 때: 메모 자리에 비밀번호 화면. onTry 가 null 을 주면(맞음) 화면을 치우고 true
 * @param {HTMLElement} container 메모 화면
 * @param {{ title: string, onTry: (password: string) => Promise<string|null>, onCancel?: () => void }} o
 * @returns {Promise<boolean>}
 */
export function lockScreen(container, { title, onTry, onCancel }) {
  return new Promise((resolve) => {
    const screen = el('form', { class: 'lock-screen', role: 'dialog', 'aria-labelledby': 'lock-screen-title' });
    const field = passwordField('비밀번호', 'lock-open-pass');
    field.input.setAttribute('autocomplete', 'current-password');
    const error = el('p', { class: 'lock-error', role: 'alert' });
    const open = el('button', { type: 'submit', class: 'btn primary' }, '열기');
    const actions = el('div', { class: 'dialog-actions' });
    if (onCancel) {
      const cancel = el('button', { type: 'button', class: 'btn', 'data-lock-cancel': '' }, '닫기');
      cancel.addEventListener('click', () => {
        screen.remove();
        onCancel();
        resolve(false);
      });
      actions.append(cancel);
    }
    actions.append(open);
    screen.append(
      el('div', { class: 'lock-icon', 'aria-hidden': 'true' }, '🔒'),
      el('h2', { id: 'lock-screen-title' }, title || '잠긴 메모'),
      el('p', { class: 'lock-note' }, '비밀번호를 넣으면 열려요'),
      field.wrap, error, actions,
    );
    screen.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!field.input.value) return field.input.focus();
      open.disabled = true;
      open.textContent = '여는 중…';
      const fail = await onTry(field.input.value);
      if (fail) {
        error.textContent = fail;
        open.disabled = false;
        open.textContent = '열기';
        field.input.select();
        return;
      }
      screen.remove();
      resolve(true);
    });
    container.append(screen);
    field.input.focus();
  });
}
