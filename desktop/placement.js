// 끌어다 놓은 메모 창의 위치 계산 (순수 함수, 단위 테스트 대상)

// 커서가 메모 윗막대의 이 지점을 잡고 있는 것처럼 보이게 한다.
export const GRAB = { x: 48, y: 18 };
export const DEFAULT_NOTE_SIZE = { width: 340, height: 380 };

export function isInside(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));

// 커서 위치 → 메모 창 위치. 창이 작업 영역(작업표시줄 제외) 밖으로 나가지 않게 보정한다.
export function dropBounds(point, size, workArea, grab = GRAB) {
  return {
    x: Math.round(clamp(point.x - grab.x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(point.y - grab.y, workArea.y, workArea.y + workArea.height - size.height)),
    width: size.width,
    height: size.height,
  };
}

// 부드러운 이동용 중간 위치 (ease-out cubic), t: 0~1
export function tweenBounds(from, to, t) {
  const e = 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 3;
  const lerp = (a, b) => Math.round(a + (b - a) * e);
  return { x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: lerp(from.width, to.width), height: lerp(from.height, to.height) };
}
