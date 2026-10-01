// 메모 목록 카드 모양 — 목록 창 크기에 맞춰 한 화면에 메모가 MIN_VISIBLE 개 이상 보이도록 고른다 (순수 함수, 단위 테스트 대상)
//   roomy   넉넉: 제목 · 요약 여러 줄 · 사진 · 아랫줄
//   preview 보통: 제목 · 요약 몇 줄 (마지막 줄 오른쪽에 표시·시각)
//   compact 촘촘: 한 줄 (제목 … 표시 · 시각)
// 메모가 MIN_VISIBLE 개 이하면 카드들이 목록 높이를 같은 높이로 나눠 채운다 (fill) — 높이가 넉넉하면 요약 줄 수가 는다 (사진은 같은 크기).
// 높이 값은 list.css 의 카드 치수와 같다.
//   넉넉: 위 여백 12 · 제목 22 · 요약 앞 4 · 요약 · 사진 · 아랫줄 앞 6 · 아랫줄 18 · 아래 여백 14
//   보통: 위 여백 10 · 제목 22 · 요약 앞 4 · 요약(마지막 줄 오른쪽에 표시·시각) · 아래 여백 10

export const MIN_VISIBLE = 8;
const GAP = 20; // 카드 사이 (그 틈에 고친 때 스탬프)
const LINE = 21; // 요약 한 줄
const BASE = 12 + 22 + 4 + 6 + 18 + 14;
const BASE_PREVIEW = 10 + 22 + 4 + 10;
const THUMB_GAP = 8;
const THUMB_MIN = 48;
const THUMB_VIEW = 120; // 사진 높이 (화면에 보이는 px) — 목록을 확대해도, 칸이 넉넉해도 더 키우지 않는다
export const MAX_LINES = 14; // 요약은 최대 이만큼 (칸이 넉넉할수록·확대할수록 더 많이)

/**
 * @param {{ width: number, height: number }} area 카드 목록의 안쪽 크기(px, 여백 뺀) — 목록을 확대했으면 확대된 단위
 * @param {number} count 보여 줄 메모 수
 * @param {number} minVisible 한 화면에 보일 메모 수 (목록 확대·축소: 확대하면 적게 → 카드마다 내용을 더, 축소하면 많이)
 * @param {{ zoom?: number }} options zoom = 목록 확대 배율 (사진이 화면에서 같은 크기로 보이게)
 * @returns {{ mode: 'roomy'|'preview'|'compact', cols: number, previewLines: number, fullLines: number, thumbHeight: number, perCard: number, fill: boolean }}
 *   previewLines = 사진이 있는 카드의 요약 줄 수, fullLines = 사진이 없는 카드의 요약 줄 수 (사진 자리까지 글로)
 */
export function chooseDensity({ width, height }, count = MIN_VISIBLE, minVisible = MIN_VISIBLE, { zoom = 1 } = {}) {
  const visible = Math.max(1, Math.round(minVisible) || 1);
  const n = Math.max(1, Math.round(count) || 1);
  const cols = Math.min(width >= 980 ? 3 : width >= 640 ? 2 : 1, n); // 메모가 열보다 적으면 열을 줄인다
  const fill = n <= visible;
  const rows = Math.ceil((fill ? n : visible) / cols);
  const perCard = Math.floor((height - GAP * (rows - 1)) / rows);
  const thumb = Math.max(THUMB_MIN, Math.round(THUMB_VIEW / (Number(zoom) > 0 ? Number(zoom) : 1)));
  const lines = (room) => Math.max(0, Math.min(MAX_LINES, Math.floor(room / LINE)));
  // 넉넉: 요약 2줄 이상 + 사진이 들어가면. 남는 높이는 사진이 아니라 요약 줄로
  if (perCard >= BASE + 2 * LINE + THUMB_GAP + thumb) {
    const previewLines = Math.max(2, lines(perCard - BASE - THUMB_GAP - thumb));
    const fullLines = Math.max(previewLines, lines(perCard - BASE));
    return { mode: 'roomy', cols, previewLines, fullLines, thumbHeight: thumb, perCard, fill };
  }
  if (perCard >= BASE_PREVIEW + LINE) {
    const previewLines = Math.max(1, lines(perCard - BASE_PREVIEW));
    return { mode: 'preview', cols, previewLines, fullLines: previewLines, thumbHeight: 0, perCard, fill };
  }
  return { mode: 'compact', cols, previewLines: 0, fullLines: 0, thumbHeight: 0, perCard, fill };
}
