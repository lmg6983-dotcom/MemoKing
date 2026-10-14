// 메모 단축키 창 (PC 메모 창 › 메뉴 › 단축키 정하기) — Ctrl+Alt+1~9 중 하나를 이 메모에 정하고,
//   누르면 무엇을 할지 셋 중 하나로 고른다: 내용 복사 · 메모 띄우기 · 둘 다 (둘 다 끈 상태는 아예 없다)
//   다른 메모가 쓰는 숫자는 그 메모 제목이 보이고, 고르면 이 메모로 옮겨진다는 것을 알려 준다
import { hotkeyLabel } from './core/memo-hotkeys.js';
import { attachSlider } from './seg-slider.js';

const MODES = [
  { key: 'copy', name: '내용 복사', copy: true, show: false, does: '내용을 복사해요', desc: '제목 줄은 빼고 본문만 복사해요. 붙여 넣을 곳에서 Ctrl+V' },
  { key: 'show', name: '메모 띄우기', copy: false, show: true, does: '메모를 띄워요', desc: '이 메모 창을 화면 앞으로 가져와요' },
  { key: 'both', name: '둘 다', copy: true, show: true, does: '내용을 복사하고 메모를 띄워요', desc: '복사하고 띄워요. 쓰던 앱에서 바로 Ctrl+V' },
];
// 잠긴 메모는 비밀번호를 넣어야 하니 복사 대신 창을 띄운다 (main.js memoHotkeyPressed)
const LOCKED_DESC = '잠긴 메모라 누르면 복사 대신 창을 띄워요. 비밀번호를 넣고 열어 주세요';

/**
 * @param {{ state: object, locked?: boolean, onSave: (slot: string|null, o: { copy: boolean, show: boolean }) => Promise<{ ok: boolean, error?: string, state?: object }> }} o
 * @returns {Promise<object|null>} 저장한 뒤의 상태 (취소하면 null)
 */
export function hotkeyDialog({ state, locked = false, onSave }) {
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
    let mode = MODES.find((m) => m.copy === Boolean(state.copy) && m.show === Boolean(state.show)) ?? MODES[0];
    // 이 창에서 저장해 보다가 다른 앱이 쓰고 있다고 나온 숫자 (등록을 되돌려 상태에는 남지 않으므로 여기서 기억)
    const failedHere = new Set();
    const slotInfo = (n) => {
      const s = current.slots.find((x) => x.slot === n);
      return s && failedHere.has(n) && !s.reserved ? { ...s, failed: true } : s;
    };
    const otherTitle = (s) => (s?.title && !s.mine ? s.title : null);

    const keysLabel = make('div', { class: 'label', id: 'hk-keys-label' }, 'Ctrl + Alt +');
    const keys = make('div', { class: 'hk-keys', role: 'radiogroup', 'aria-label': 'Ctrl + Alt 와 함께 누를 숫자' });
    const keyButtons = new Map();
    const legend = make('p', { class: 'hk-legend', 'aria-hidden': 'true' });
    const legendTaken = make('span', {}, '다른 메모가 써요');
    legendTaken.prepend(make('i'));
    const legendBlocked = make('span', {}, '쓸 수 없어요');
    legendBlocked.prepend(make('i', { class: 'dash' }));
    legend.append(legendTaken, legendBlocked);
    const paintKeys = () => {
      for (const { slot: n } of current.slots) {
        const s = slotInfo(n);
        const btn = keyButtons.get(n);
        btn.setAttribute('aria-checked', String(slot === n));
        btn.classList.toggle('taken', Boolean(otherTitle(s)));
        btn.classList.toggle('blocked', Boolean(s.reserved));
        btn.classList.toggle('failed', Boolean(s.failed) && !s.reserved);
        btn.disabled = Boolean(s.reserved);
        btn.title = s.reserved ? `${s.label}: ${s.reserved} 단축키라 쓸 수 없어요` : s.failed ? `${s.label}: 다른 앱이 쓰고 있어요` : otherTitle(s) ? `${s.label}: “${s.title}” 메모가 써요` : s.label;
        btn.setAttribute('aria-label', btn.title);
      }
      // 표시 뜻은 그 표시가 붙은 숫자가 있을 때만
      const all = current.slots.map((x) => slotInfo(x.slot));
      legendTaken.hidden = !all.some(otherTitle);
      legendBlocked.hidden = !all.some((s) => s.reserved || s.failed);
      legend.hidden = legendTaken.hidden && legendBlocked.hidden;
    };
    for (const s of state.slots) {
      const btn = make('button', { type: 'button', class: 'hk-key', role: 'radio', 'aria-checked': 'false', 'data-slot': s.slot });
      btn.append(make('b', {}, s.slot), make('i', { 'aria-hidden': 'true' })); // i: 다른 메모가 쓰는 칸 표시 점
      btn.addEventListener('click', () => {
        slot = s.slot;
        error.textContent = '';
        paintKeys();
        paintNote();
      });
      // 다른 메모가 쓰는 숫자는 마우스를 올리거나 키보드로 옮겨 가기만 해도 누가 쓰는지 알려 준다
      btn.addEventListener('focus', () => paintNote(s.slot));
      btn.addEventListener('mouseenter', () => paintNote(s.slot));
      btn.addEventListener('mouseleave', () => paintNote(keys.contains(document.activeElement) ? document.activeElement.dataset.slot : slot));
      keyButtons.set(s.slot, btn);
      keys.append(btn);
    }

    // 누르면: 셋 중 하나 (← → 로 고르기는 dom.js radioGroups)
    const whatLabel = make('div', { class: 'label', id: 'hk-what-label' }, '누르면');
    const seg = make('div', { class: 'seg hk-mode', role: 'radiogroup', 'aria-labelledby': 'hk-what-label', 'aria-describedby': 'hk-mode-desc' });
    const modeDesc = make('p', { class: locked ? 'hk-mode-desc locked' : 'hk-mode-desc', id: 'hk-mode-desc' });
    const modeButtons = MODES.map((m) => {
      const btn = make('button', { type: 'button', role: 'radio', 'aria-checked': 'false' }, m.name);
      btn.addEventListener('click', () => {
        mode = m;
        paintMode();
        paintNote();
      });
      seg.append(btn);
      return btn;
    });
    const paintMode = () => {
      MODES.forEach((m, i) => modeButtons[i].setAttribute('aria-checked', String(m === mode)));
      modeDesc.textContent = locked && mode.copy ? LOCKED_DESC : mode.desc;
    };

    const hint = make('p', { class: 'hk-hint' });
    const error = make('p', { class: 'lock-error', role: 'alert' });
    // 안내 한 줄 (look: 마우스·키보드가 머문 숫자 — 고르기 전에도 누가 쓰는지). 숫자 뒤 조사는 읽는 법(일 · 삼…)에 따라 달라 쓰지 않는다
    const paintNote = (look = slot) => {
      const s = look ? slotInfo(look) : null;
      const label = look ? hotkeyLabel(look) : '';
      hint.textContent = !look ? '숫자를 하나 골라 주세요'
        : s?.reserved ? `${label}: ${s.reserved} 단축키라 쓸 수 없어요`
        : s?.failed ? `${label}: 다른 앱이 쓰고 있어 눌러도 안 돼요. 다른 숫자를 골라 주세요`
        : otherTitle(s) ? `${label}: 지금 “${s.title}” 메모가 써요. 저장하면 그 메모에서는 풀려요`
          : `${label}: 어느 앱에서든 누르면 ${mode.does}`;
      const chosen = slot ? slotInfo(slot) : null;
      save.disabled = busy || !slot || Boolean(chosen?.failed) || Boolean(chosen?.reserved);
    };
    keys.addEventListener('focusout', (e) => !keys.contains(e.relatedTarget) && paintNote());
    // 숫자 키 1~9 를 누르면 바로 그 숫자 (키보드 숫자 줄과 같게) — 창 어디에 있든
    form.addEventListener('keydown', (e) => {
      const btn = /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey ? keyButtons.get(e.key) : null;
      if (!btn || btn.disabled) return;
      e.preventDefault();
      btn.focus();
      btn.click();
    });

    const actions = make('div', { class: 'dialog-actions' });
    const clear = make('button', { type: 'button', class: 'btn hk-clear' }, '단축키 풀기');
    clear.hidden = !state.slot;
    const cancel = make('button', { type: 'button', class: 'btn' }, '취소');
    const save = make('button', { type: 'submit', class: 'btn primary' }, '저장');
    actions.append(clear, cancel, save);
    let busy = false;

    form.append(
      make('h2', { id: 'hk-title' }, '단축키 정하기'),
      keysLabel, keys, legend, whatLabel, seg, modeDesc, hint, error, actions,
    );
    dialog.append(form);
    document.body.append(dialog);
    paintKeys();
    paintMode();
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
      busy = true;
      save.disabled = true;
      clear.disabled = true;
      let r;
      try {
        r = await onSave(target, { copy: mode.copy, show: mode.show });
      } catch {
        r = { ok: false };
      }
      busy = false;
      clear.disabled = false;
      if (r?.ok) return finish(r.state ?? null);
      if (r?.state) current = r.state;
      // 다른 앱이 쓰고 있어 못 잡은 숫자는 이 창에서 계속 "쓸 수 없어요"로
      if (target && r?.error?.includes('다른 앱')) failedHere.add(target);
      paintKeys();
      paintNote();
      error.textContent = r?.error || '저장하지 못했어요. 다시 해 보세요';
    };
    cancel.addEventListener('click', () => finish(null));
    clear.addEventListener('click', () => submit(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (slot && !save.disabled) submit(slot);
    });
    dialog.showModal();
    attachSlider(seg); // 선택 표시가 미끄러진다 (보이고 나서 붙여야 자리를 잰다)
    // 처음에는 고른 숫자, 없으면 아무도 안 쓰는 첫 숫자에 (남이 쓰는 숫자 안내가 고르기도 전에 뜨지 않게)
    (keyButtons.get(slot) ?? keys.querySelector('.hk-key:not(:disabled, .taken, .failed)') ?? keys.querySelector('.hk-key:not(:disabled)'))?.focus();
  });
}
