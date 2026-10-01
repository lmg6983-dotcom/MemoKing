// 드래그로 선택한 내용의 화면 사각형 → 영역 캡처할 사각형 (순수 함수, 단위 테스트 대상)
// 좌표는 화면 DIP. 선택한 내용이 다 들어가게 둘레에 여백을 두고, 모니터 밖은 잘라 낸다.

export const SELECTION_PAD = 8;
export const SELECTION_MIN = 8;

/**
 * @param {{ x: number, y: number, width: number, height: number } | null} sel 선택한 내용(화면 좌표)
 * @param {{ x: number, y: number, width: number, height: number }} bounds 그 모니터(화면 좌표)
 * @returns {{ x: number, y: number, width: number, height: number } | null} 모니터 기준 좌표, 너무 작거나 모니터 밖이면 null
 */
export function selectionCaptureRect(sel, bounds, { pad = SELECTION_PAD, min = SELECTION_MIN } = {}) {
  if (!sel || ![sel.x, sel.y, sel.width, sel.height].every(Number.isFinite) || sel.width <= 0 || sel.height <= 0) return null;
  const left = Math.max(bounds.x, Math.floor(sel.x - pad));
  const top = Math.max(bounds.y, Math.floor(sel.y - pad));
  const right = Math.min(bounds.x + bounds.width, Math.ceil(sel.x + sel.width + pad));
  const bottom = Math.min(bounds.y + bounds.height, Math.ceil(sel.y + sel.height + pad));
  if (right - left < min || bottom - top < min) return null;
  return { x: left - bounds.x, y: top - bounds.y, width: right - left, height: bottom - top };
}
