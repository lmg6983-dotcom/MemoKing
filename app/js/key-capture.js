// 단축키 칸에서 새 키 받기 — 설정 창(매직 카피 · 매직키)과 단축키 설정 창이 함께 쓴다
//   칸을 누르면 "새 키를 누르세요…", 누른 키는 onKey 가 판정. Esc 는 그만두기, 칸 밖을 누르면 그만두기.
//   전역 단축키를 바꿀 때는 pause 로 지금 키를 잠시 놓는다 (누르는 동안 매직 카피가 뜨지 않게) — 그만둘 때 꼭 되살린다
//   한 번에 한 칸만 (다른 칸을 누르면 앞의 것은 그만둠). onKey 가 처리 중이면(저장 왕복) 그동안 누른 키는 버린다

import { acceleratorFromKey, displayAccelerator } from './core/accelerators.js';

let active = null; // 지금 받는 칸 (capture 객체)

/** 이 칸(없으면 어느 칸이든)이 키를 기다리는 중인가 */
export function isCapturing(btn) {
  return btn ? active?.btn === btn : Boolean(active);
}

/**
 * 누르고 있는 조합키 글자 — 나머지 키를 기다리는 동안 칸에. 순서는 저장된 키를 보일 때와 같게
 *   'global': Ctrl+Alt+Shift+Win (전역 단축키 · displayAccelerator) · 'memo': Ctrl+Shift+Alt (메모 창 · comboLabel)
 */
export function modsLabel(e, kind = 'memo') {
  const mods = kind === 'global'
    ? [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win']
    : [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', e.metaKey && 'Win'];
  return `${mods.filter(Boolean).join('+')}+…`;
}

/**
 * 전역 단축키 바꾸기(api.settings.setShortcut)의 결과 → 안내 { text, warn }
 * @param {string} [label] 바꾸려던 키 글자 · @param {{ reset?: boolean }} [o] 기본값으로 되돌리기였으면
 */
export function globalShortcutResult(res, label = '', { reset = false } = {}) {
  if (res?.ok) return { text: reset ? '처음 키로 되돌렸어요' : `${label} 키로 바꿨어요`, warn: false };
  if (res?.reason === 'taken') return { text: reset ? `처음 키 ${res.label} 는 다른 앱이 쓰고 있어 되돌리지 못했어요` : `${res.label} 키는 다른 앱이 이미 쓰고 있어요. 다른 키를 골라 주세요`, warn: true };
  if (res?.reason === 'same') return { text: reset ? `처음 키를 ${res.other}가 쓰고 있어 되돌리지 못했어요` : `${res.other}와 같은 키예요. 다른 키를 골라 주세요`, warn: true };
  return { text: reset ? '처음 키로 되돌리지 못했어요' : '이 키는 쓸 수 없어요', warn: true };
}

async function onKeyDown(e) {
  const cap = active;
  if (!cap) return;
  e.preventDefault();
  e.stopPropagation();
  if (cap.busy) return; // 앞의 키를 저장하는 중 (누르고 있어 되풀이되는 키 · 잇따라 누른 키 · Esc 도)
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { // 조합 없는 Esc 만 그만두기
    cap.stop('cancel');
    return;
  }
  cap.busy = true;
  try {
    await cap.onKey(e, cap.btn, cap);
  } finally {
    cap.busy = false;
  }
}

function onPointerDown(e) {
  if (active && e.target !== active.btn) active.stop('away');
}

/**
 * 전역 단축키(매직 카피 · 매직키) 칸: 새 키를 받아 저장 — 설정 창과 단축키 설정 창이 함께
 *   받는 동안 지금 키를 놓아 두고(누르면 메모가 뜨지 않게), 키를 받으면 먼저 되살린 뒤 저장한다
 *   (놓인 채 저장하면 "다른 앱이 쓰는 키" 로 잘못 보임)
 * @param {{ api: object, name: string, note: (text: string, warn?: boolean) => void, done?: (res: object) => any, stopped?: (reason: string) => any }} o
 */
export function captureGlobalKey(btn, { api, name, note, done, stopped }) {
  note('Ctrl, Alt, Win 중 하나와 함께 눌러요. Esc 는 그만');
  return startKeyCapture(btn, {
    prompt: '새 키 조합을 누르세요',
    pause: (on) => api.settings.pauseShortcuts(on),
    onStop: (reason) => {
      if (reason === 'cancel' || reason === 'away') note('');
      return stopped?.(reason);
    },
    onKey: async (e, _btn, cap) => {
      const r = acceleratorFromKey(e);
      if (r.pending) {
        btn.textContent = modsLabel(e, 'global');
        return;
      }
      if (r.error) return note(r.error, true); // 계속 기다린다
      await cap.stop('commit');
      const res = await api.settings.setShortcut(name, r.acc);
      await done?.(res); // 화면을 다시 그린 뒤에 안내 (다시 그리기가 안내를 지우지 않게)
      const msg = globalShortcutResult(res, displayAccelerator(r.acc));
      note(msg.text, msg.warn);
    },
  });
}

/** 지금 받는 칸을 그만 (어느 칸이든) */
export function stopKeyCapture(reason = 'cancel') {
  return active ? active.stop(reason) : Promise.resolve();
}

/**
 * 이 칸에서 새 키를 받기 시작
 * @param {HTMLElement} btn
 * @param {{ prompt?: string, onKey: (e: KeyboardEvent, btn: HTMLElement, cap: { stop: (reason?: string) => Promise<void> }) => any,
 *           onStop?: (reason: string) => any, pause?: (on: boolean) => any }} opts
 *   onKey 안에서 다 됐으면 cap.stop() 을 부른다 (못 쓰는 키면 부르지 않고 계속 기다림).
 *   cap.stop 은 그 칸만 그만둔다 — 그사이 다른 칸을 받기 시작했으면 그 칸은 그대로
 */
export function startKeyCapture(btn, { prompt = '새 키를 누르세요', onKey, onStop, pause } = {}) {
  active?.stop('replaced');
  const label = btn.textContent;
  const cap = {
    btn,
    onKey,
    busy: false,
    stopped: null,
    // 놓기를 먼저 보낸 뒤에야 되살리기를 보낸다 (순서가 뒤바뀌어 단축키가 계속 놓여 있지 않게)
    pausing: pause ? Promise.resolve(pause(true)).catch(() => {}) : null,
    stop(reason = 'done') {
      cap.stopped ??= (async () => {
        if (active === cap) {
          active = null;
          window.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
        }
        btn.classList.remove('capturing');
        if (btn.isConnected) btn.textContent = label;
        if (pause) {
          await cap.pausing;
          // 다음 칸도 놓기를 쓰는 중이면 되살리지 않는다 (그 칸이 끝날 때 되살림). 창을 닫거나 새로 고치면 main 이 되살린다
          if (!active?.pausing) await Promise.resolve(pause(false)).catch(() => {});
        }
        // 화면 정리는 다음 칸을 받기 시작하지 않았을 때만 (늦게 끝난 앞 칸이 새 칸의 안내를 지우지 않게)
        if (!active) await onStop?.(reason);
      })();
      return cap.stopped;
    },
  };
  active = cap;
  btn.classList.add('capturing');
  btn.textContent = prompt;
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  return cap;
}
