// 꾹 눌러 줄을 들어 올리기까지의 시간을 쓰는 사람 손에 맞춘다 (PC 마우스) — 순수 함수, 단위 테스트 대상
//   글자를 고르려다 줄이 들리면(실수) 조금 늘리고, 옮기려고 기다리다 먼저 손을 뗐다가 다시 누르면(늦음) 조금 줄인다.
//   한 번에 크게 바꾸지 않고, 정한 범위 밖으로는 가지 않는다

export const HOLD_BASE = 350; // 처음 값 (list-drag HOLD_MS 와 같다)
export const HOLD_MIN = 250;
export const HOLD_MAX = 700;
const STEP_UP = 40; // 실수 한 번에 늘리는 만큼
const STEP_DOWN = 20; // 늦음 한 번에 줄이는 만큼 (실수보다 천천히 — 들리는 실수가 더 성가시다)

const clamp = (ms) => Math.round(Math.min(HOLD_MAX, Math.max(HOLD_MIN, Number.isFinite(ms) ? ms : HOLD_BASE)));

/** signal: 'misfire'(글자를 고르려다 들렸다) · 'late'(옮기려는데 기다리기 길었다) */
export function nextHold(ms, signal) {
  const now = clamp(ms);
  if (signal === 'misfire') return clamp(now + STEP_UP);
  if (signal === 'late') return clamp(now - STEP_DOWN);
  return now;
}

/** 들어 올린 뒤 거의 움직이지 않고 곧 놓았나 — 글자를 고르거나 커서를 놓으려던 것 */
export const isMisfireRelease = ({ liftedMs, movedPx }) => movedPx < 14 && liftedMs < 700;

/** 들어 올린 뒤 처음 움직임이 옆으로인가 — 글자를 고르는 손짓 (줄 옮기기는 위아래로 움직인다) */
export const isSidewaysSelect = (dx, dy) => Math.abs(dx) >= 16 && Math.abs(dx) > Math.abs(dy) * 2;

/** 옮긴 뒤 곧 되돌렸나 — 빨리 끌어 놓은 것(글자를 고르듯 쓱 끈 것)을 곧바로 되돌리면 실수 */
export const isMisfireUndo = ({ dragMs, sinceMs }) => dragMs < 1000 && sinceMs < 4000;

/**
 * 늦음: 같은 줄을 들어 올리기 직전까지 누르고 있다가(기다림의 60% 넘게) 손을 뗐고, 곧(1.5초 안) 다시 눌러 옮겼다
 * @param {{ heldMs: number, holdMs: number, gapMs: number, sameBlock: boolean }} p
 */
export const isLateRetry = ({ heldMs, holdMs, gapMs, sameBlock }) => sameBlock && heldMs >= holdMs * 0.6 && heldMs < holdMs && gapMs <= 1500;

/** 저장된 값 읽기 — 깨졌거나 없으면 처음 값, 켜짐 */
export function readHold(raw) {
  let v = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  return { on: v?.on !== false, ms: clamp(v?.ms ?? HOLD_BASE) };
}
