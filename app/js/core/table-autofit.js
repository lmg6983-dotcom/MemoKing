// 붙여넣은 표의 열 너비·정렬 자동 맞춤 (순수 함수, 단위 테스트 대상)
//   - 열마다 종류를 본다: 번호(순번)·숫자·날짜는 좁게 한 줄로, 긴 설명 글 열에 남는 공간을 준다
//   - 표가 본문 폭 안에 들어가면 내용에 맞춘 너비(줄바꿈 없음), 넘치면 본문 폭에 맞춘다
//   - 본문 폭에 맞출 때는 칸마다 몇 줄이 되는지 세어, 표 전체 줄 수(행마다 가장 긴 칸)가 가장 많이 줄어드는 열에 공간을 준다
//   - 칸 안의 의도적인 줄바꿈("\n")은 그대로 두고 줄마다 따로 잰다
//   - 정렬: 숫자는 오른쪽, 번호·날짜는 가운데, 글은 왼쪽

export const CELL_PAD = 17; // 칸 안쪽 여백 좌우 8px + 테두리 1px (note.css 의 th·td 와 같다)
export const MIN_COL = 44;
const WORD_CAP = 180; // 띄어쓰기 없는 긴 낱말이라도 이보다 넓게 잡지는 않는다

const NUMBER = /^[-+(]?\s?[₩$€¥£]?\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?(?:%|원|천원|만원|억|억원|개|명|건|회|점|시간|분|kg|g|km|m|cm|mm|KRW|USD|EUR)?\)?$|^[-+]?\d+(?:\.\d+)?\s?(?:%|원|개|명|건|회|점)?$/i;
const DATE = [
  /^\d{2,4}\s?[-./]\s?\d{1,2}\s?[-./]\s?\d{1,2}\.?(?:\s?\([월화수목금토일]\))?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/,
  /^\d{4}년\s?\d{1,2}월(?:\s?\d{1,2}일)?(?:\s?\([월화수목금토일]\))?$/,
  /^\d{1,2}월\s?\d{1,2}일(?:\s?\([월화수목금토일]\))?$/,
  /^\d{1,2}\s?[./]\s?\d{1,2}\.?(?:\s?\([월화수목금토일]\))?$/,
  /^(?:오전|오후)?\s?\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:AM|PM))?$/i,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
];
const INDEX_HEAD = /^(?:no\.?|#|번호|순번|순서|연번|순위|번|seq|idx|index)$/i;

const clean = (s) => String(s ?? '').trim();
const isNumber = (s) => NUMBER.test(clean(s));
const isDate = (s) => DATE.some((re) => re.test(clean(s)));

/**
 * 열 종류: index(번호) · number · date · text
 * @param {string} head 머리글
 * @param {string[]} values 아래 칸들 (빈 칸은 빼고 본다)
 */
export function columnKind(head, values) {
  const vals = values.map(clean).filter(Boolean);
  if (!vals.length) return 'text';
  const share = (fn) => vals.filter(fn).length / vals.length;
  const ints = vals.map((v) => (/^\d+$/.test(v) ? Number(v) : NaN));
  const consecutive = ints.every((n) => Number.isInteger(n)) && ints.every((n, i) => i === 0 || n === ints[i - 1] + 1);
  if (INDEX_HEAD.test(clean(head)) && share((v) => /^\d+\.?$/.test(v)) >= 0.8) return 'index';
  if (consecutive && vals.length >= 2 && ints[0] <= 1) return 'index';
  if (share(isDate) >= 0.8) return 'date';
  if (share(isNumber) >= 0.8) return 'number';
  return 'text';
}

export const ALIGN = { index: 'center', number: 'right', date: 'center', text: 'left' };

// 칸 하나가 너비 w 에서 몇 줄이 되는지 (의도적 줄바꿈마다 따로)
function cellLines(lineWidths, w) {
  const inner = Math.max(1, w - CELL_PAD);
  let n = 0;
  for (const x of lineWidths) n += Math.max(1, Math.ceil((x - 0.5) / inner));
  return n;
}

/**
 * @param {string[][]} grid 첫 행이 머리글. 칸 글의 "\n" 은 의도적인 줄바꿈
 * @param {{ available: number, measure: (text: string, bold: boolean) => number }} options available = 본문 폭(px)
 * @returns {{ widths: number[], align: string[], kinds: string[], fits: boolean }}
 */
export function autoFitTable(grid, { available, measure }) {
  const cols = Math.max(0, ...grid.map((r) => r.length));
  const rows = grid.map((r) => Array.from({ length: cols }, (_, c) => String(r[c] ?? '')));
  // 칸마다 줄별 너비, 가장 긴 낱말
  const lw = rows.map((r, ri) => r.map((v) => v.split('\n').map((line) => measure(line.trim(), ri === 0))));
  const word = rows.map((r, ri) => r.map((v) => Math.max(0, ...v.split(/\s+/).filter(Boolean).map((t) => Math.min(WORD_CAP, measure(t, ri === 0))))));
  const kinds = [];
  const nat = [];
  const min = [];
  for (let c = 0; c < cols; c++) {
    kinds.push(columnKind(rows[0]?.[c] ?? '', rows.slice(1).map((r) => r[c])));
    nat.push(Math.max(MIN_COL, Math.ceil(Math.max(0, ...lw.map((r) => Math.max(0, ...r[c]))) + CELL_PAD)));
    min.push(Math.max(MIN_COL, Math.ceil(Math.max(0, ...word.map((r) => r[c])) + CELL_PAD)));
  }
  const align = kinds.map((k) => ALIGN[k]);
  const total = nat.reduce((a, b) => a + b, 0);
  // 1) 본문 폭 안에 들어가면 내용에 맞춘 너비 (줄바꿈 없음)
  if (total <= available) return { widths: nat, align, kinds, fits: true };

  // 2) 넘치면: 번호·숫자·날짜 열은 한 줄 너비(본문의 40% 까지), 글 열은 가장 긴 낱말 너비에서 시작
  const narrow = (c) => kinds[c] !== 'text';
  const w = nat.map((n, c) => (narrow(c) ? Math.min(n, Math.max(MIN_COL, Math.round(available * 0.4))) : Math.min(n, min[c])));
  let left = available - w.reduce((a, b) => a + b, 0);
  const totalLines = (ws) => rows.reduce((sum, _r, ri) => sum + Math.max(1, ...ws.map((x, c) => cellLines(lw[ri][c], x))), 0);
  // 3) 남는 공간: 표 전체 줄 수를 가장 많이 줄이는 열에 (1px 당 줄어드는 줄 수가 큰 쪽부터)
  let current = totalLines(w);
  while (left > 0) {
    let best = null;
    for (let c = 0; c < cols; c++) {
      if (w[c] >= nat[c]) continue;
      // 이 열에서 어느 칸이든 한 줄 줄어드는 다음 너비들
      const steps = new Set();
      for (let ri = 0; ri < rows.length; ri++) {
        for (const x of lw[ri][c]) {
          const k = Math.ceil((x - 0.5) / Math.max(1, w[c] - CELL_PAD));
          if (k > 1) steps.add(Math.ceil(x / (k - 1)) + CELL_PAD);
        }
      }
      for (const target of steps) {
        const next = Math.min(nat[c], target);
        const add = next - w[c];
        if (add <= 0 || add > left) continue;
        const trial = w.slice();
        trial[c] = next;
        const gain = (current - totalLines(trial)) / add;
        if (gain > 0 && (!best || gain > best.gain)) best = { c, next, gain };
      }
    }
    if (!best) break;
    left -= best.next - w[best.c];
    w[best.c] = best.next;
    current = totalLines(w);
  }
  // 4) 그래도 남으면 글 열에 모자란 만큼 나눠 준다 (표가 본문 폭에 맞게)
  if (left > 0) {
    const want = w.map((x, c) => (narrow(c) ? 0 : Math.max(0, nat[c] - x)));
    const sum = want.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      const share = Math.min(1, left / sum);
      for (let c = 0; c < cols; c++) w[c] += Math.floor(want[c] * share);
    }
  }
  return { widths: w.map((x) => Math.round(x)), align, kinds, fits: false };
}

/**
 * 붙여넣은 표 중 따로 살펴봐야 하는 것: 병합된 칸·표 안의 표·그림·수식
 * @param {Element} table 붙여넣은 HTML 의 <table>
 * @returns {string[]} 이유 (없으면 [])
 */
export function tableReviewReasons(table) {
  const reasons = [];
  const cells = [...table.querySelectorAll('td, th')];
  if (cells.some((c) => c.colSpan > 1 || c.rowSpan > 1)) reasons.push('병합된 칸');
  if (table.querySelector('table')) reasons.push('표 안의 표');
  if (table.querySelector('img, picture, svg, canvas, object')) reasons.push('그림');
  if (table.querySelector('math, .MathJax, .katex, [data-formula]') || cells.some((c) => /^\s*=[A-Z가-힣_(]/i.test(c.textContent) || /\$[^$]+\$/.test(c.textContent))) reasons.push('수식');
  return reasons;
}
