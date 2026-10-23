// 꾹 눌러 줄 들어 올리기 — 쓰는 사람 손에 맞춘 시간 (PC 마우스만, 이 PC 에만 저장)
//   규칙은 core/hold-tuning.js. 메모 창마다 같은 값을 쓰도록 localStorage (다른 창이 바꾸면 storage 알림으로 따라감)
//   설정 › 메모 보기 › 내 손에 맞추기 에서 끄거나 처음 값으로
import { HOLD_BASE, nextHold, readHold, isMisfireUndo, isLateRetry } from './core/hold-tuning.js';

const KEY = 'memoking.holdTune';
let cache = null;

function load() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  cache = readHold(raw);
  return cache;
}
function save(next) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장하지 못해도 이 창에서는 그대로 쓴다
  }
}
try {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) cache = null;
  });
} catch {
  // window 가 없는 곳 (점검)
}

/** 지금 쓸 시간 — 끄면 처음 값 */
export const holdMs = () => (load().on ? load().ms : HOLD_BASE);
export const holdTune = () => ({ ...load() });
export function setHoldTune({ on, reset } = {}) {
  const now = load();
  save({ on: on ?? now.on, ms: reset ? HOLD_BASE : now.ms });
  return holdTune();
}

/** 실수 · 늦음을 알린다 (끄면 배우지 않음) */
export function holdSignal(signal) {
  const now = load();
  if (!now.on) return;
  const ms = nextHold(now.ms, signal);
  if (ms !== now.ms) save({ ...now, ms });
  if (document.body) document.body.dataset.holdMs = String(holdMs()); // 점검용
}

// ---------- 늦음: 들리기 직전에 뗐다가 같은 줄을 곧 다시 눌러 옮김 ----------
let lastShort = null; // { key, at, heldMs }
/** 들어 올리기 전에 움직이지 않고 손을 뗐다 (block: 줄을 알아볼 값) */
export function notePressReleased(key, heldMs) {
  lastShort = { key, at: Date.now(), heldMs };
}
/** 들어 올렸다 — 바로 앞에 같은 줄을 거의 다 눌렀다 뗐으면 옮긴 뒤 늦음으로 */
export function takeLateRetry(key) {
  const s = lastShort;
  lastShort = null;
  return Boolean(s && isLateRetry({ heldMs: s.heldMs, holdMs: holdMs(), gapMs: Date.now() - s.at, sameBlock: s.key === key }));
}

// ---------- 옮긴 뒤 곧 되돌림 (Ctrl+Z · 되돌리기 단추) ----------
let lastMove = null; // { at, dragMs }
export function noteMoved(dragMs) {
  lastMove = { at: Date.now(), dragMs };
}
try {
  window.addEventListener('keydown', (e) => {
    if (!lastMove || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
    const m = lastMove;
    lastMove = null;
    if (isMisfireUndo({ dragMs: m.dragMs, sinceMs: Date.now() - m.at })) holdSignal('misfire');
  }, true);
} catch {
  // window 가 없는 곳
}
