// 메모 본문 확대·축소 단계 — 웹 브라우저와 같은 배율 (순수 함수, 단위 테스트 대상)
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// 지금 배율에서 한 단계 크게(+1)·작게(-1). 단계 사이 값이면 가까운 다음 단계로
export function stepZoom(current, dir) {
  const z = Number(current) || 1;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_STEPS[0];
}

// 저장해 둔 값 → 쓸 수 있는 배율 (모르는 값은 1)
export function clampZoom(v) {
  const z = Number(v);
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.min(ZOOM_STEPS.at(-1), Math.max(ZOOM_STEPS[0], z));
}

export const zoomLabel = (z) => `${Math.round(z * 100)}%`;
