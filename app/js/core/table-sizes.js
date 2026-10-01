// 표 크기·모양 — 메모 파일 머리말(tables)에 표 순서대로 적는다 (순수 함수, 단위 테스트 대상)
// 마크다운 표에는 열 너비·행 높이를 적을 곳이 없어서 머리말에 따로 둔다.
//   tables:
//     - cols: [120, 0, 200]   열 너비 px (0 = 내용에 맞춤)
//       rows: [0, 48]          행 높이 px (0 = 내용에 맞춤), 첫 행이 머리글
//       accent: true           머리글 행 바탕을 칠함 (없으면 머리글도 다른 칸과 같은 바탕)

export const COL_MIN = 24;
export const COL_MAX = 2000;
export const ROW_MIN = 20;
export const ROW_MAX = 2000;

const sizeList = (list, min, max, limit) => {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, limit).map((v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : 0;
  });
  return out.some((v) => v > 0) ? out : null;
};

// 표 하나 → 쓸 수 있는 값만 (기본 모양이면 빈 객체)
export function normalizeTable(raw) {
  const t = {};
  if (!raw || typeof raw !== 'object') return t;
  const cols = sizeList(raw.cols, COL_MIN, COL_MAX, 100);
  const rows = sizeList(raw.rows, ROW_MIN, ROW_MAX, 1000);
  if (cols) t.cols = cols;
  if (rows) t.rows = rows;
  if (raw.accent === true) t.accent = true;
  return t;
}

const isPlain = (t) => !t.cols && !t.rows && !t.accent;

// 머리말 값 → 표 목록. 모든 표가 기본 모양이면 [] (머리말에 쓰지 않음). 끝의 기본 모양 표는 뺀다.
export function normalizeTables(raw) {
  if (!Array.isArray(raw)) return [];
  const list = raw.slice(0, 200).map(normalizeTable);
  while (list.length && isPlain(list.at(-1))) list.pop();
  return list;
}

export const sameTables = (a, b) => JSON.stringify(normalizeTables(a)) === JSON.stringify(normalizeTables(b));
