// 표 — 엑셀·구글 시트에서 붙여넣은 표를 마크다운 표로 옮기기 좋은 모양으로 정리한다 (순수 함수, 단위 테스트 대상)
// 마크다운 표는 셀 병합이 없고 첫 행이 머리글이므로: 병합된 셀은 풀어 빈 셀로, 첫 행은 머리글(<th>)로.

// 칸 안의 의도적인 줄바꿈: 마크다운 표 칸에는 <br> 로 저장 (편집기에서는 html 노드 → 줄바꿈으로 보임)
export const CELL_BREAK_HTML = '<span data-type="html" data-value="&lt;br&gt;"></span>';

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 엑셀의 클립보드 HTML 은 "선택 부분" 표시가 <table> 안쪽에 있어, 조각만 떼면 <tr>·<td> 만 남는다.
 * 그대로 붙이면 표가 풀려 글자만 남으므로 <table> 로 다시 감싼다.
 */
export function wrapOrphanRows(html) {
  const s = String(html ?? '');
  if (!/<t[rdh][\s>]/i.test(s) || /<table[\s>]/i.test(s)) return s;
  return `<table>${s}</table>`;
}

/**
 * 셀 목록 → 네모난 격자. 병합된 셀(colspan·rowspan)은 첫 셀에만 내용을 두고 나머지는 빈 셀.
 * @param {{ html: string, colspan?: number, rowspan?: number }[][]} rows
 * @returns {string[][]} 행마다 같은 열 수, 끝의 빈 행·빈 열은 뺌
 */
export function cellsToGrid(rows) {
  const grid = [];
  rows.forEach((cells, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of cells) {
      while (grid[r][c] !== undefined) c++;
      const colspan = Math.max(1, Math.min(50, Number(cell.colspan) || 1));
      const rowspan = Math.max(1, Math.min(500, Number(cell.rowspan) || 1));
      for (let dr = 0; dr < rowspan && r + dr < rows.length; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < colspan; dc++) grid[r + dr][c + dc] = dr === 0 && dc === 0 ? cell.html : '';
      }
      c += colspan;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  const filled = grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  const blank = (html) => !String(html).replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim();
  // 끝의 빈 행·빈 열 (엑셀에서 넉넉히 고른 경우)
  while (filled.length && filled.at(-1).every(blank)) filled.pop();
  let cols = width;
  while (cols > 0 && filled.every((row) => blank(row[cols - 1]))) cols--;
  return filled.map((row) => row.slice(0, cols));
}

/** 격자 → 붙여넣기용 HTML 표 (첫 행은 머리글, 행이 하나면 머리글만). cellHtml 이 true 면 셀 내용은 이미 HTML. */
export function gridToHtml(grid, { cellHtml = false } = {}) {
  if (!grid.length || !grid[0].length) return '';
  // 마크다운 표의 셀은 한 줄 — 셀 안 줄바꿈(엑셀의 Alt+Enter)은 <br> 로 지킨다
  const cell = (v) => (cellHtml ? v : escapeHtml(String(v).trim()).replace(/[ \t]*\n[ \t]*/g, CELL_BREAK_HTML));
  const [head, ...body] = grid;
  // 머리글 행만 있는 1행 표도 된다
  const tbody = body.length ? `<tbody>${body.map((row) => `<tr>${row.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`).join('')}</tbody>` : '';
  return `<table><thead><tr>${head.map((v) => `<th>${cell(v)}</th>`).join('')}</tr></thead>${tbody}</table>`;
}

/**
 * 탭으로 나뉜 글(엑셀·시트의 글자 복사) → 격자. 표로 보기 어려우면 null.
 * 엑셀은 칸 안의 줄바꿈·탭이 있으면 "..." 로 감싸고 " 는 "" 로 쓴다.
 */
export function parseTsv(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!src.includes('\t')) return null;
  const rows = [];
  let row = [];
  let cellText = '';
  let i = 0;
  let quoted = false;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cellText += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i++;
        continue;
      }
      cellText += ch;
      i++;
      continue;
    }
    if (ch === '"' && cellText === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === '\t') {
      row.push(cellText);
      cellText = '';
    } else if (ch === '\n') {
      row.push(cellText);
      rows.push(row);
      row = [];
      cellText = '';
    } else cellText += ch;
    i++;
  }
  row.push(cellText);
  rows.push(row);
  // 줄이 둘 이상이고, 거의 모든 줄이 같은 칸 수(2칸 이상)여야 표로 본다
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2 || rows.filter((r) => r.length === width).length < rows.length * 0.8) return null;
  return cellsToGrid(rows.map((r) => r.map((v) => ({ html: v }))));
}

/** 표 한 줄(마크다운)을 읽는 글자로: "| 품목 | 가격 |" → "품목 · 가격". 표 줄이 아니면 null, 구분선이면 '' */
export function tableLineText(line) {
  if (!/^\s*\|.*\|\s*$/.test(line)) return null;
  if (/^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$/.test(line)) return '';
  return line.trim().slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim())
    .filter(Boolean)
    .join(', ');
}
