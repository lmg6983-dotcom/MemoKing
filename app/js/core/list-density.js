// 메모 목록 카드 모양 (순수 함수, 단위 테스트 대상)
//   roomy   넉넉: 제목 · 요약 여러 줄 · 사진 · 아랫줄(태그 | 표시 · 시각)
//   preview 보통: 제목 · 요약 몇 줄 (마지막 줄 오른쪽에 표시·시각)
//   compact 촘촘: 한 줄 (제목 … 표시 · 시각)
//
// 1) chooseDensity — 100% 일 때의 모양: 목록 창 크기에 맞춰 한 화면에 메모가 MIN_VISIBLE 개 이상 보이도록.
//    메모가 MIN_VISIBLE 개 이하면 카드들이 목록 높이를 같은 높이로 나눠 채운다 (fill) — 높이가 넉넉하면 요약 줄 수가 는다.
// 2) levelDensity — 목록 확대·축소(Ctrl+휠) = "얼마나 자세히 보기" 단계. 100% 모양에서 출발해
//    확대: 단계마다 요약 줄을 더하고(150%부터 사진·태그 줄을 요약 아래에 덧붙임 — 요약 줄을 빼앗지 않는다), 열을 줄여 카드를 넓힌다.
//          글자·여백·사진은 100% 크기 그대로라 카드가 길어지고, 한 화면의 카드 수는 그만큼 준다.
//    축소: 모두 함께 작아지고(CSS zoom), 단계마다 요약 줄을 줄이고 사진을 감추며 열을 늘린다.
//    → 단계를 하나 올릴 때 요약 줄이 줄거나 사진이 사라지는 일이 없다 (단위 테스트로 확인).
// 높이 값은 list.css 의 카드 치수와 같다.
//   넉넉: 위 여백 12 · 제목 22 · 요약 앞 4 · 요약 · 사진 · 아랫줄 앞 6 · 아랫줄 18 · 아래 여백 14
//   보통: 위 여백 10 · 제목 22 · 요약 앞 4 · 요약(마지막 줄 오른쪽에 표시·시각) · 아래 여백 10

export const MIN_VISIBLE = 8;
const GAP = 20; // 카드 사이 (그 틈에 고친 때 스탬프)
const LINE = 21; // 요약 한 줄
const BASE = 12 + 22 + 4 + 6 + 18 + 14;
const BASE_PREVIEW = 10 + 22 + 4 + 10;
const THUMB_GAP = 8;
export const THUMB = 120; // 사진 높이 — 칸이 넉넉해도, 확대해도 더 키우지 않는다
export const MAX_LINES = 14; // 100% 에서 요약 최대 줄
export const MAX_DETAIL_LINES = 30; // 확대했을 때 요약 최대 줄

// 확대 단계: 100% 의 요약 줄에 더할 줄 (그리고 최소 이만큼). 사진·태그 줄은 PHOTO_FROM 줄부터
export const MORE = [
  { zoom: 1.1, add: 1 },
  { zoom: 1.25, add: 2 },
  { zoom: 1.5, add: 4 },
  { zoom: 1.75, add: 7 },
];
const PHOTO_FROM = 4;
// 축소 단계: 100% 의 요약 줄에서 뺄 줄 (사진은 감춤)
export const LESS = [
  { zoom: 0.9, sub: 1 },
  { zoom: 0.8, sub: 2 },
  { zoom: 0.75, sub: 3 },
  { zoom: 0.67, sub: 5 },
  { zoom: 0.5, sub: Infinity },
];

// 목록 폭에 들어가는 열 수 (메모가 열보다 적으면 열을 줄인다)
export const colsFor = (width, count) => Math.max(1, Math.min(width >= 980 ? 3 : width >= 640 ? 2 : 1, Math.max(1, Math.round(count) || 1)));

/**
 * 100% 일 때의 모양
 * @param {{ width: number, height: number }} area 카드 목록의 안쪽 크기(화면 px, 여백 뺀)
 * @param {number} count 보여 줄 메모 수
 * @returns {{ mode: 'roomy'|'preview'|'compact', cols: number, previewLines: number, fullLines: number, thumbHeight: number, perCard: number, fill: boolean }}
 *   previewLines = 사진이 있는 카드의 요약 줄 수, fullLines = 사진이 없는 카드의 요약 줄 수 (사진 자리까지 글로)
 */
export function chooseDensity({ width, height }, count = MIN_VISIBLE) {
  const n = Math.max(1, Math.round(count) || 1);
  const cols = colsFor(width, n);
  const fill = n <= MIN_VISIBLE;
  const rows = Math.ceil((fill ? n : MIN_VISIBLE) / cols);
  const perCard = Math.floor((height - GAP * (rows - 1)) / rows);
  const lines = (room) => Math.max(0, Math.min(MAX_LINES, Math.floor(room / LINE)));
  // 넉넉: 요약 2줄 이상 + 사진이 들어가면. 남는 높이는 사진이 아니라 요약 줄로
  if (perCard >= BASE + 2 * LINE + THUMB_GAP + THUMB) {
    const previewLines = Math.max(2, lines(perCard - BASE - THUMB_GAP - THUMB));
    const fullLines = Math.max(previewLines, lines(perCard - BASE));
    return { mode: 'roomy', cols, previewLines, fullLines, thumbHeight: THUMB, perCard, fill };
  }
  if (perCard >= BASE_PREVIEW + LINE) {
    const previewLines = Math.max(1, lines(perCard - BASE_PREVIEW));
    return { mode: 'preview', cols, previewLines, fullLines: previewLines, thumbHeight: 0, perCard, fill };
  }
  return { mode: 'compact', cols, previewLines: 0, fullLines: 0, thumbHeight: 0, perCard, fill };
}

/**
 * 목록 확대·축소 단계의 모양 (100% 모양에서 출발)
 * @param {ReturnType<typeof chooseDensity>} base 100% 모양
 * @param {number} zoom 배율 (0.5 ~ 1.75)
 * @param {{ width?: number, count?: number }} options 축소했을 때 목록 폭(축소된 단위 = 더 넓다)·메모 수 — 열을 늘리는 데 쓴다
 */
export function levelDensity(base, zoom, { width = 0, count = 1 } = {}) {
  const z = Number(zoom) || 1;
  if (Math.abs(z - 1) < 0.001) return base;
  const photoLines = base.mode === 'compact' ? 0 : base.previewLines;
  const plainLines = base.mode === 'compact' ? 0 : Math.max(base.fullLines ?? 0, photoLines);
  if (z > 1) {
    const k = MORE.filter((s) => z >= s.zoom - 0.001).length || 1; // 1 ~ 4 단계
    const { add } = MORE[k - 1];
    const cap = (v) => Math.min(MAX_DETAIL_LINES, v);
    const lines = cap(Math.max(add, photoLines + add));
    const photo = base.mode === 'roomy' || lines >= PHOTO_FROM;
    const full = photo ? cap(Math.max(lines, plainLines + add)) : lines;
    return {
      mode: photo ? 'roomy' : 'preview',
      cols: Math.max(1, base.cols - (k >= 4 ? 2 : k >= 2 ? 1 : 0)), // 자세히 볼수록 카드를 넓게
      previewLines: lines,
      fullLines: full,
      thumbHeight: photo ? THUMB : 0,
      perCard: base.perCard,
      fill: false, // 카드마다 내용 높이대로 (목록 높이를 나눠 채우지 않음)
    };
  }
  const step = LESS.find((s) => z >= s.zoom - 0.001) ?? LESS.at(-1);
  const lines = Math.max(0, photoLines - step.sub);
  const cols = Math.max(base.cols, colsFor(width, count)); // 작아진 만큼 열을 늘린다
  if (!lines) return { mode: 'compact', cols, previewLines: 0, fullLines: 0, thumbHeight: 0, perCard: base.perCard, fill: false };
  return { mode: 'preview', cols, previewLines: lines, fullLines: lines, thumbHeight: 0, perCard: base.perCard, fill: false };
}
