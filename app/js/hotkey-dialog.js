// 메모 단축키 창 (PC 메모 창 › 메뉴 › 단축키 정하기) — Ctrl+Alt+1~9 중 하나를 이 메모에 정하고,
//   누르면 무엇을 할지 미리 고른다: 내용 복사 · 메모 띄우기 (둘 다도 됨, 하나는 꼭)
//   다른 메모가 쓰는 숫자는 그 메모 제목이 보이고, 고르면 이 메모로 옮겨진다는 것을 알려 준다
import { hotkeyLabel } from './core/memo-hotkeys.js';

const ACTION_TEXT = { truetrue: '내용을 복사하고 메모를 띄워요', truefalse: '내용을 복사해요', falsetrue: '메모를 띄워요', falsefalse: '…' };

/**
 * @param {{ state: object, onSave: (slot: string|null, o: { copy: boolean, show: boolean }) => Promise<{ ok: boolean, error?: string, state?: object }> }} o
 * @returns {Promise<object|null>} 저장한 뒤의 상태 (취소하면 null)
 */
export function hotkeyDialog({ state, onSave }) {
  return new Promise((resolve) => {
    const make = (tag, attrs = {}, text = '') => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text) n.textContent = text;
      return n;
    };
    const dialog = make('dialog', { class: 'dialog hotkey-dialog', 'aria-labelledby': 'hk-title' });
    const form = make('form', { method: 'dialog' });
    let slot = state.slot;
    let current = state;

    const keys = make('div', { class: 'hk-keys', role: 'radiogroup', 'aria-label': '단축키 숫자' });
    const keyButtons = new Map();
    const paintKeys = () => {
      for (const s of current.slots) {
        const btn = keyButtons.get(s.slot);
        btn.setAttribute('aria-checked', String(slot === s.slot));
        btn.classList.toggle('taken', Boolean(s.title));
        btn.classList.toggle('blocked', Boolean(s.reserved));
        btn.classList.toggle('failed', Boolean(s.failed) && !s.reserved);
        btn.disabled = Boolean(s.reserved);
        btn.title = s.reserved ? `${s.label}: ${s.reserved} 단축키라 쓸 수 없어요` : s.failed ? `${s.label}: 다른 앱이 쓰고 있어요` : s.title && !s.mine ? `${s.label}: “${s.title}” 메모가 써요` : s.label;
        btn.setAttribute('aria-label', btn.title);
      }
    };
    for (const s of state.slots) {
      const btn = make('button', { type: 'button', class: 'hk-key', role: 'radio', 'aria-checked': 'false' });
      btn.append(make('b', {}, s.slot), make('i', { 'aria-hidden': 'true' })); // i: 다른 메모가 쓰는 칸 표시 점
      btn.addEventListener('click', () => {
        slot = s.slot;
        error.textContent = '';
        paintKeys();
        paintNote();
      });
      // 다른 메모가 쓰는 숫자는 키보드로 옮겨 가기만 해도 누가 쓰는지 알려 준다
      btn.addEventListener('focus', () => paintNote(s.slot));
      keyButtons.set(s.slot, btn);
      keys.append(btn);
    }
    // 숫자 키 1~9 를 누르면 바로 그 숫자 (키보드 숫자 줄과 같게)
    keys.addEventListener('keydown', (e) => {
      const btn = /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey ? keyButtons.get(e.key) : null;
      if (!btn || btn.disabled) return;
      e.preventDefault();
      btn.focus();
      btn.click();
    });
    // 숫자 아래 표시 뜻 (늘 보이게)
    const legend = make('p', { class: 'hk-legend', 'aria-hidden': 'true' });
    legend.innerHTML = '<span><i></i>다른 메모가 써요</span><span><i class="dash"></i>쓸 수 없어요</span>';
    const option = (name, desc, checked) => {
      const row = make('label', { class: 'hk-opt' });
      const text = make('span');
      text.append(make('b', {}, name), make('small', {}, desc));
      const input = make('input', { type: 'checkbox', class: 'switch' });
      input.checked = checked;
      row.append(text, input);
      return { row, input };
    };
    const copy = option('내용 복사', '제목 줄 빼고 본문만, 바로 Ctrl+V', state.copy);
    const show = option('메모 띄우기', '이 메모 창을 화면 앞으로', state.show);
    const what = make('div', { class: 'hk-what', role: 'group', 'aria-labelledby': 'hk-what-label' });
    what.append(make('div', { class: 'label', id: 'hk-what-label' }, '누르면'), copy.row, show.row);

    const hint = make('p', { class: 'hk-hint' });
    const error = make('p', { class: 'lock-error', role: 'alert' });
    // 안내 한 줄 (look: 키보드로 옮겨 간 숫자 — 고르기 전에도 누가 쓰는지). 숫자 뒤 조사는 읽는 법(일 · 삼…)에 따라 달라 쓰지 않는다
    const paintNote = (look = slot) => {
      const s = current.slots.find((x) => x.slot === look);
      const label = look ? hotkeyLabel(look) : '';
      hint.textContent = !look ? '숫자를 하나 골라 주세요'
        : s?.reserved ? `${label}: ${s.reserved} 단축키라 쓸 수 없어요`
        : s?.failed ? `${label}: 다른 앱이 쓰고 있어 눌러도 안 돼요. 다른 숫자를 골라 주세요`
        : s?.title && !s.mine ? `${label}: 지금 “${s.title}” 메모가 써요. 저장하면 이 메모로 바뀌어요`
          : `${label}: 어느 앱에서든 누르면 ${ACTION_TEXT[`${copy.input.checked}${show.input.checked}`]}`;
      const none = !copy.input.checked && !show.input.checked;
      if (none) error.textContent = '내용 복사와 메모 띄우기 중 하나는 켜 주세요';
      else if (error.textContent.startsWith('내용 복사와')) error.textContent = '';
      const chosen = current.slots.find((x) => x.slot === slot);
      save.disabled = none || !slot || Boolean(chosen?.failed) || Boolean(chosen?.reserved);
    };
    copy.input.addEventListener('change', () => paintNote());
    show.input.addEventListener('change', () => paintNote());
    keys.addEventListener('focusout', (e) => !keys.contains(e.relatedTarget) && paintNote());

    const actions = make('div', { class: 'dialog-actions' });
    const clear = make('button', { type: 'button', class: 'btn hk-clear' }, '단축키 풀기');
    clear.hidden = !state.slot;
    const cancel = make('button', { type: 'button', class: 'btn' }, '취소');
    const save = make('button', { type: 'submit', class: 'btn primary' }, '저장');
    actions.append(clear, cancel, save);

    form.append(
      make('h2', { id: 'hk-title' }, '단축키 정하기 · Ctrl+Alt+숫자'),
      keys, legend, what, hint, error, actions,
    );
    dialog.append(form);
    document.body.append(dialog);
    paintKeys();
    paintNote();

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const submit = async (target) => {
      save.disabled = true;
      clear.disabled = true;
      let r;
      try {
        r = await onSave(target, { copy: copy.input.checked, show: show.input.checked });
      } catch (err) {
        r = { ok: false, error: err?.message || '저장하지 못했어요' };
      }
      clear.disabled = false;
      if (r?.ok) return finish(r.state ?? null);
      if (r?.state) {
        current = r.state;
        paintKeys();
      }
      error.textContent = r?.error || '저장하지 못했어요';
      save.disabled = false;
    };
    cancel.addEventListener('click', () => finish(null));
    clear.addEventListener('click', () => submit(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (slot) submit(slot);
    });
    dialog.showModal();
    (keyButtons.get(slot) ?? keys.querySelector('.hk-key:not(:disabled)'))?.focus();
  });
}
