// PDF 쪽 크기 — 종이 크기·카드 비율·직접 입력, 방향, 여백 (순수 함수, 단위 테스트 대상). 길이는 mm.

export const PAPERS = [
  { id: 'a4', label: 'A4', w: 210, h: 297 },
  { id: 'a5', label: 'A5', w: 148, h: 210 },
  { id: 'b5', label: 'B5', w: 182, h: 257 },
  { id: 'letter', label: '레터', w: 215.9, h: 279.4 },
];

// 카드: 비율만 정하고 긴 변 길이를 고른다
export const RATIOS = [
  { id: '1:1', label: '1:1 정사각', w: 1, h: 1 },
  { id: '3:4', label: '3:4', w: 3, h: 4 },
  { id: '4:3', label: '4:3', w: 4, h: 3 },
  { id: '9:16', label: '9:16 휴대폰', w: 9, h: 16 },
  { id: '16:9', label: '16:9 화면', w: 16, h: 9 },
];

export const MARGINS = { none: 0, narrow: 8, normal: 16, wide: 25 };
export const MIN_MM = 50;
export const MAX_MM = 1200;

const round1 = (v) => Math.round(v * 10) / 10;
export const clampMm = (v) => round1(Math.min(MAX_MM, Math.max(MIN_MM, Number(v) || MIN_MM)));

/**
 * @param {{ kind: 'paper'|'ratio'|'custom', paper?: string, ratio?: string, long?: number,
 *           width?: number, height?: number, orientation?: 'portrait'|'landscape' }} o
 * @returns {{ width: number, height: number }} mm
 */
export function pageSize(o) {
  let w;
  let h;
  if (o.kind === 'ratio') {
    const r = RATIOS.find((x) => x.id === o.ratio) ?? RATIOS[0];
    const long = clampMm(o.long ?? 150);
    // 비율은 그대로 두고 긴 변을 long 으로 (방향은 비율에 이미 들어 있다)
    if (r.w >= r.h) {
      w = long;
      h = round1((long * r.h) / r.w);
    } else {
      h = long;
      w = round1((long * r.w) / r.h);
    }
    return { width: Math.max(MIN_MM, w), height: Math.max(MIN_MM, h) };
  }
  if (o.kind === 'custom') {
    w = clampMm(o.width);
    h = clampMm(o.height);
  } else {
    const p = PAPERS.find((x) => x.id === o.paper) ?? PAPERS[0];
    w = p.w;
    h = p.h;
  }
  const landscape = o.orientation === 'landscape';
  if (o.kind !== 'custom' && landscape !== w > h) [w, h] = [h, w];
  return { width: w, height: h };
}

// 비율 고정으로 한 변을 바꿨을 때 다른 변 (직접 입력)
// 다른 변이 범위(50~1200mm)를 넘으면 바꾼 변을 줄이거나 늘려 비율을 지킨다
export function keepRatio(changed, value, { width, height }) {
  const r = changed === 'width' ? height / width : width / height; // 다른 변 = 바꾼 변 × r
  let v = clampMm(value);
  if (v * r > MAX_MM) v = clampMm(MAX_MM / r);
  if (v * r < MIN_MM) v = clampMm(MIN_MM / r);
  const other = clampMm(v * r);
  return changed === 'width' ? { width: v, height: other } : { width: other, height: v };
}

// 화면 미리보기용: mm → CSS px (96dpi)
export const mmToPx = (mm) => (mm * 96) / 25.4;

// 가장 가까운 간단한 비율 이름 ("4:3" 등, 없으면 소수)
export function ratioLabel(width, height) {
  const r = width / height;
  const known = [...RATIOS, { id: '1:1.41 (A 용지)', w: 1, h: Math.SQRT2 }, { id: '1.41:1 (A 용지)', w: Math.SQRT2, h: 1 }];
  const hit = known.find((k) => Math.abs(k.w / k.h - r) < 0.01);
  return hit ? hit.id.split(' ')[0] : `${Math.round(r * 100) / 100}:1`;
}

// 파일 이름에 쓸 수 없는 글자를 뺀 이름
export const pdfFileName = (title) => `${String(title || '메모').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '메모'}.pdf`;
