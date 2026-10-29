// 골라 붙여넣기 (메모 창 Ctrl+Alt+V) — 클립보드의 글자를 목록 · 표 마크다운으로 (순수 함수, 단위 테스트 대상)

const BULLET = /^\s*(?:[-*+•·▪◦‣]|\d{1,3}[.)]|[가-하][.)]|\[[ xX]?\])\s+/; // 이미 붙은 글머리 · 번호 · 체크 상자는 떼고 새로
const lines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

/** 줄마다 글머리 목록 ("- ") — 빈 줄은 빼고, 앞에 붙어 있던 글머리 · 번호는 뗀다 */
export function textToListMd(text) {
  const strip = (l) => (BULLET.test(l) ? strip(l.replace(BULLET, '')) : l); // "- [ ] 할 일" 처럼 겹쳐 붙은 것도
  const items = lines(text).map((l) => strip(l).trim()).filter(Boolean);
  return items.map((l) => `- ${l}`).join('\n');
}

/** 한 줄을 칸으로: 탭 > 쉼표(따옴표 안 쉼표는 그대로) > 두 칸 이상 띄어쓰기 — 칸 나눔 기준은 표 전체에 하나 */
function splitter(rows) {
  if (rows.some((r) => r.includes('\t'))) return (r) => r.split('\t');
  if (rows.filter((r) => r.includes(',')).length >= rows.length * 0.6) return splitCsv; // 대부분의 줄에 쉼표
  if (rows.some((r) => / {2,}/.test(r.trim()))) return (r) => r.trim().split(/ {2,}/);
  return (r) => [r];
}
function splitCsv(row) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && !cur.trim()) quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** 탭 · 쉼표 · 넓은 띄어쓰기로 나뉜 글 → 표 (첫 줄이 머리글, 칸 수는 가장 많은 줄에 맞춤) | '' (표로 만들 줄이 없음) */
export function textToTableMd(text) {
  const rows = lines(text).filter((l) => l.trim());
  if (!rows.length) return '';
  const split = splitter(rows);
  const cells = rows.map((r) => split(r).map((c) => c.trim().replace(/\|/g, '\\|').replace(/\s+/g, ' ')));
  const n = Math.max(...cells.map((c) => c.length));
  const pad = (r) => [...r, ...Array(n - r.length).fill('')];
  const line = (r) => `| ${pad(r).map((c) => c || ' ').join(' | ')} |`;
  return [line(cells[0]), `| ${Array(n).fill('---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}
