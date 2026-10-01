// 메모 목록 카드 모양 — 목록 창 크기에 맞춰 한 화면에 메모가 MIN_VISIBLE 개 이상 보이도록 고른다 (순수 함수, 단위 테스트 대상)
//   roomy   넉넉: 제목 · 요약 여러 줄 · 사진 · 아랫줄
//   preview 보통: 제목 · 요약 1~2줄 (마지막 줄 오른쪽에 표시·시각)
//   compact 촘촘: 한 줄 (제목 … 표시 · 시각)
// 메모가 MIN_VISIBLE 개 이하면 카드들이 목록 높이를 같은 높이로 나눠 채운다 (fill) — 높이가 넉넉하면 요약 줄 수·사진도 커진다.
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

/**
 * @param {{ width: number, height: number }} area 카드 목록의 안쪽 크기(px, 여백 뺀)
 * @param {number} count 보여 줄 메모 수
 * @returns {{ mode: 'roomy'|'preview'|'compact', cols: number, previewLines: number, thumbHeight: number, perCard: number, fill: boolean }}
 */
export function chooseDensity({ width, height }, count = MIN_VISIBLE) {
  const n = Math.max(1, Math.round(count) || 1);
  const cols = Math.min(width >= 980 ? 3 : width >= 640 ? 2 : 1, n); // 메모가 열보다 적으면 열을 줄인다
  const fill = n <= MIN_VISIBLE;
  const rows = Math.ceil((fill ? n : MIN_VISIBLE) / cols);
  const perCard = Math.floor((height - GAP * (rows - 1)) / rows);
  const thumbMax = fill ? 260 : 140;
  if (perCard >= BASE + 2 * LINE + THUMB_GAP + THUMB_MIN) {
    const previewLines = perCard >= 360 ? 6 : perCard >= 280 ? 4 : perCard >= BASE + 3 * LINE + THUMB_GAP + THUMB_MIN ? 3 : 2;
    const thumbHeight = Math.max(THUMB_MIN, Math.min(thumbMax, perCard - BASE - previewLines * LINE - THUMB_GAP));
    return { mode: 'roomy', cols, previewLines, thumbHeight, perCard, fill };
  }
  if (perCard >= BASE_PREVIEW + LINE) return { mode: 'preview', cols, previewLines: perCard >= BASE_PREVIEW + 2 * LINE ? 2 : 1, thumbHeight: 0, perCard, fill };
  return { mode: 'compact', cols, previewLines: 0, thumbHeight: 0, perCard, fill };
}
