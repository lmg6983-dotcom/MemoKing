// 표 더하기 기능 (편집기 플러그인) — 열 너비·행 높이를 끌어서 바꾸고, 머리글 행 바탕은 고를 때만 칠한다.
//   열 너비: Milkdown(prosemirror-tables)의 열 크기 조절(칸 오른쪽 테두리를 끌기) → 칸의 colwidth.
//            한 열을 처음 바꾸면 나머지 열도 지금 너비로 고정해 표가 정한 대로 보이게 한다.
//   행 높이: 칸 아래 테두리를 끌기 (두 번 누르면 내용에 맞춤) → 행 표시(decoration)의 높이.
//   머리글 강조: 표 표시(decoration)의 class.
//   셀 병합: 칸의 colspan·rowspan. 마크다운 표에는 병합이 없어 본문에는 풀어 둔 표(내용은 첫 칸)로 저장하고, 병합은 머리말에.
// 셋 다 마크다운 표에는 적을 곳이 없어 메모 머리말(tables)에 표 순서대로 저장한다 (core/table-sizes.js).
import { Plugin, PluginKey, Decoration, DecorationSet, TableMap, CellSelection, TextSelection, selectedRect } from '../vendor/milkdown.js';
import { normalizeTables, sameTables, ROW_MIN, ROW_MAX } from './core/table-sizes.js';

export const tableExtrasKey = new PluginKey('memoking-table-extras');
const EDGE = 5; // 테두리에서 이만큼 안쪽까지 잡을 수 있다 (px)

const isRow = (node) => node.type.name === 'table_row' || node.type.name === 'table_header_row';

function rowDeco(pos, node, height) {
  return Decoration.node(pos, pos + node.nodeSize, { style: `height: ${height}px` }, { mkRow: height });
}
function accentDeco(pos, node) {
  return Decoration.node(pos, pos + node.nodeSize, { class: 'mk-head-accent' }, { mkAccent: true });
}

// pos 에서 시작하는 노드에 붙은 그 종류의 표시
const decoAt = (set, pos, end, key) => set.find(pos, end, (spec) => spec[key] != null).filter((d) => d.from === pos);

// 문서의 표들 → 머리말에 적을 모양 (표 순서대로)
export function collectTables(state) {
  const set = tableExtrasKey.getState(state)?.decos ?? DecorationSet.empty;
  const out = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const t = {};
    const cols = [];
    node.firstChild?.forEach((cell) => {
      const span = cell.attrs.colspan ?? 1;
      for (let i = 0; i < span; i++) cols.push(Math.round(cell.attrs.colwidth?.[i] ?? 0) || 0);
    });
    if (cols.some((w) => w > 0)) t.cols = cols;
    const rows = [];
    let p = pos + 1;
    node.forEach((row) => {
      rows.push(decoAt(set, p, p + row.nodeSize, 'mkRow')[0]?.spec.mkRow ?? 0);
      p += row.nodeSize;
    });
    if (rows.some((h) => h > 0)) t.rows = rows;
    if (decoAt(set, pos, pos + node.nodeSize, 'mkAccent').length) t.accent = true;
    const merges = tableMerges(node);
    if (merges.length) t.merges = merges;
    out.push(t);
    return false;
  });
  return normalizeTables(out);
}

// 표의 병합한 칸들: [행, 열, 행 수, 열 수]
export function tableMerges(node) {
  const map = TableMap.get(node);
  const out = [];
  const seen = new Set();
  for (const pos of map.map) {
    if (seen.has(pos)) continue;
    seen.add(pos);
    const cell = node.nodeAt(pos);
    const rs = cell?.attrs.rowspan ?? 1;
    const cs = cell?.attrs.colspan ?? 1;
    if (rs > 1 || cs > 1) {
      const r = map.findCell(pos);
      out.push([r.top, r.left, rs, cs]);
    }
  }
  return out;
}

// n 번째 표
function nthTable(doc, n) {
  let i = 0;
  let found = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name !== 'table') return true;
    if (i++ === n) found = { node, pos };
    return false;
  });
  return found;
}

// 머리글 행과 본문 행을 걸치는 병합은 하지 않는다 (마크다운 표의 머리글은 한 줄)
export function mergeAllowed(top, rowspan) {
  return top === 0 ? rowspan === 1 : true;
}

/**
 * 고른 칸들(CellSelection)을 하나로 합친다. Milkdown 의 표 칸은 문단 하나만 담으므로
 * (prosemirror-tables 의 mergeCells 는 문단을 여러 개 이어 붙여 표가 깨진다) 칸들의 글을 한 문단으로, 사이는 줄바꿈(<br>).
 * 머리글 행과 본문 행을 걸치거나, 이미 합친 칸을 일부만 고르면 하지 않는다.
 * @returns {boolean|string} true = 합침, 문자열 = 못 합친 이유
 */
export function mergeSelectedCells(state, dispatch) {
  if (!(state.selection instanceof CellSelection)) return '합칠 칸들을 끌어서 골라 주세요';
  const rect = selectedRect(state);
  const { map, tableStart, table } = rect;
  if (rect.right - rect.left < 1 || rect.bottom - rect.top < 1 || (rect.right - rect.left === 1 && rect.bottom - rect.top === 1)) return '두 칸 이상 골라 주세요';
  if (!mergeAllowed(rect.top, rect.bottom - rect.top)) return '머리글 행과 아래 행은 합칠 수 없어요';
  const cells = [];
  const seen = new Set();
  for (let r = rect.top; r < rect.bottom; r++) {
    for (let c = rect.left; c < rect.right; c++) {
      const pos = map.map[r * map.width + c];
      if (seen.has(pos)) continue;
      seen.add(pos);
      const at = map.findCell(pos);
      if (at.left < rect.left || at.right > rect.right || at.top < rect.top || at.bottom > rect.bottom) return '이미 합친 칸은 통째로 골라 주세요';
      cells.push({ pos, node: table.nodeAt(pos), at });
    }
  }
  if (!dispatch) return true;
  const schema = state.schema;
  const br = schema.nodes.html.create({ value: '<br>' });
  const inline = [];
  for (const { node } of cells) {
    const parts = [];
    node.forEach((block) => block.content.forEach((n) => parts.push(n)));
    if (!parts.length) continue;
    if (inline.length) inline.push(br);
    inline.push(...parts);
  }
  // 합친 칸의 열 너비 = 맨 윗줄 칸들의 너비 (모두 있을 때만)
  const widths = [];
  for (const { node, at } of cells.filter((x) => x.at.top === rect.top)) {
    for (let i = 0; i < at.right - at.left; i++) widths.push(node.attrs.colwidth?.[i] ?? 0);
  }
  const origin = cells[0];
  const tr = state.tr;
  for (const { pos, node } of [...cells.slice(1)].sort((a, b) => b.pos - a.pos)) tr.delete(tableStart + pos, tableStart + pos + node.nodeSize);
  const merged = origin.node.type.create(
    { ...origin.node.attrs, colspan: rect.right - rect.left, rowspan: rect.bottom - rect.top, colwidth: widths.every((w) => w > 0) ? widths : null },
    schema.nodes.paragraph.create(null, inline),
  );
  tr.replaceWith(tableStart + origin.pos, tableStart + origin.pos + origin.node.nodeSize, merged);
  tr.setSelection(CellSelection.create(tr.doc, tableStart + origin.pos));
  dispatch(tr);
  return true;
}

// 병합 한 칸 (applyTables·불러오기)
function applyMerge(view, tableIndex, [r, c, rs, cs]) {
  const t = nthTable(view.state.doc, tableIndex);
  if (!t || !mergeAllowed(r, rs)) return;
  const map = TableMap.get(t.node);
  if (r + rs > map.height || c + cs > map.width) return;
  const start = t.pos + 1;
  const anchor = start + map.map[r * map.width + c];
  const head = start + map.map[(r + rs - 1) * map.width + (c + cs - 1)];
  const sel = view.state.tr.setSelection(CellSelection.create(view.state.doc, anchor, head));
  view.dispatch(sel.setMeta('addToHistory', false));
  mergeSelectedCells(view.state, (tr) => view.dispatch(tr.setMeta('addToHistory', false)));
}

// 머리말의 모양을 문서의 표에 입힌다 (열 수가 다른 표는 너비를 건너뛴다 — 파일을 밖에서 고친 경우)
export function applyTables(view, tables) {
  const list = normalizeTables(tables);
  const { state } = view;
  const tr = state.tr;
  const marks = [];
  let index = 0;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const t = list[index++] ?? {};
    const colCount = node.firstChild?.childCount ?? 0;
    let p = pos + 1;
    node.forEach((row, _o, r) => {
      let c = p + 1;
      row.forEach((cell, _co, ci) => {
        const w = t.cols && t.cols.length === colCount ? t.cols[ci] : 0;
        const colwidth = w > 0 ? [w] : null;
        if (JSON.stringify(cell.attrs.colwidth ?? null) !== JSON.stringify(colwidth)) tr.setNodeMarkup(c, null, { ...cell.attrs, colwidth });
        c += cell.nodeSize;
      });
      marks.push({ kind: 'row', pos: p, value: t.rows?.[r] ?? 0 });
      p += row.nodeSize;
    });
    marks.push({ kind: 'accent', pos, value: Boolean(t.accent) });
    return false;
  });
  tr.setMeta(tableExtrasKey, { set: marks, load: true });
  tr.setMeta('addToHistory', false);
  view.dispatch(tr);
  // 병합은 너비를 입힌 뒤에 (병합한 칸이 너비를 합쳐 갖는다)
  const anyMerge = list.some((t) => t.merges?.length);
  if (!anyMerge) return;
  const keep = view.state.selection.from;
  list.forEach((t, i) => {
    for (const m of [...(t.merges ?? [])].sort((a, b) => b[0] - a[0] || b[1] - a[1])) applyMerge(view, i, m);
  });
  const doc = view.state.doc;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(Math.min(keep, doc.content.size)))).setMeta('addToHistory', false));
}

function setMarks(set, doc, marks) {
  let next = set;
  for (const m of marks) {
    const node = doc.nodeAt(m.pos);
    if (!node) continue;
    const key = m.kind === 'row' ? 'mkRow' : 'mkAccent';
    const old = decoAt(next, m.pos, m.pos + node.nodeSize, key);
    if (old.length) next = next.remove(old);
    if (m.kind === 'row' && m.value > 0 && isRow(node)) next = next.add(doc, [rowDeco(m.pos, node, m.value)]);
    if (m.kind === 'accent' && m.value && node.type.name === 'table') next = next.add(doc, [accentDeco(m.pos, node)]);
  }
  return next;
}

// 열 너비가 일부만 정해진 표: 나머지 열도 지금 보이는 너비로 정한다 (표가 끈 대로 정확히 보이게)
// 열 단위로 본다 — 합친 칸(colspan)은 colwidth 에 열마다 너비를 갖고, 행마다 칸 순서와 열 번호가 다를 수 있다.
function fillColumnWidths(view) {
  const { state } = view;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const map = TableMap.get(node);
    const cells = [...new Set(map.map)].map((rel) => ({ rel, cell: node.nodeAt(rel), at: map.findCell(rel) }));
    const widths = Array(map.width).fill(0);
    for (const { cell, at } of cells) {
      for (let c = at.left; c < at.right; c++) widths[c] ||= cell.attrs.colwidth?.[c - at.left] || 0;
    }
    if (!widths.some((w) => w > 0) || widths.every((w) => w > 0)) return false;
    // 정해지지 않은 열은 그 열 하나만 차지하는 칸의 지금 너비로
    for (let c = 0; c < map.width; c++) {
      if (widths[c]) continue;
      const one = cells.find(({ at }) => at.left === c && at.right === c + 1);
      widths[c] = Math.round(one ? view.nodeDOM(pos + 1 + one.rel)?.offsetWidth ?? 0 : 0);
    }
    if (widths.some((w) => !w)) return false;
    for (const { rel, cell, at } of cells) {
      const want = widths.slice(at.left, at.right);
      if (JSON.stringify(cell.attrs.colwidth ?? null) !== JSON.stringify(want)) tr.setNodeMarkup(pos + 1 + rel, null, { ...cell.attrs, colwidth: want });
    }
    return false;
  });
  if (tr.docChanged) {
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
  }
}

// 표에 정해진 너비가 있으면 class (CSS 에서 table-layout: fixed — 끈 대로 좁게도 넓게도)
function sizedDecos(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    if (node.firstChild && [...Array(node.firstChild.childCount).keys()].some((i) => node.firstChild.child(i).attrs.colwidth?.some((w) => w > 0))) {
      out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mk-sized' }));
    }
    return false;
  });
  return out;
}

/**
 * @param {{ onChange?: (tables: object[]) => void, readOnly?: boolean }} options
 * @returns {{ plugin: Plugin, setLoading: (on: boolean) => void }}
 */
export function createTableExtras({ onChange, readOnly = false } = {}) {
  let drag = null; // 행 높이 끌기 { rowPos, tr(DOM), startY, startH, zoom }
  let loading = true; // 처음 입히는 동안은 저장하지 않는다
  let last = [];

  // 마우스가 칸 아래 테두리 위에 있으면 그 칸
  function rowEdge(view, event) {
    const cell = event.target instanceof Element ? event.target.closest('td, th') : null;
    if (!cell || !view.dom.contains(cell)) return null;
    const r = cell.getBoundingClientRect();
    if (r.bottom - event.clientY > EDGE || event.clientY - r.bottom > 1) return null;
    if (r.right - event.clientX <= EDGE + 1) return null; // 오른쪽 아래 모서리는 열 너비 조절에 양보
    return cell;
  }

  function rowPosOf(view, cell) {
    const $pos = view.state.doc.resolve(view.posAtDOM(cell, 0));
    for (let d = $pos.depth; d > 0; d--) if (isRow($pos.node(d))) return $pos.before(d);
    return null;
  }

  function endDrag(view, commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    document.body.classList.remove('mk-row-resizing');
    window.removeEventListener('mousemove', d.move);
    window.removeEventListener('mouseup', d.up);
    if (!commit) return;
    view.dispatch(view.state.tr.setMeta(tableExtrasKey, { set: [{ kind: 'row', pos: d.rowPos, value: d.height }] }));
  }

  const plugin = new Plugin({
    key: tableExtrasKey,
    state: {
      init: () => ({ decos: DecorationSet.empty }),
      apply(tr, value) {
        let decos = value.decos.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(tableExtrasKey);
        if (meta?.set) decos = setMarks(decos, tr.doc, meta.set);
        return { decos };
      },
    },
    props: {
      decorations(state) {
        const { decos } = tableExtrasKey.getState(state);
        const sized = sizedDecos(state.doc);
        return sized.length ? decos.add(state.doc, sized) : decos;
      },
      handleDOMEvents: readOnly ? {} : {
        mousemove(view, event) {
          if (drag) return false;
          view.dom.classList.toggle('row-resize-cursor', Boolean(rowEdge(view, event)));
          return false;
        },
        mouseleave(view) {
          if (!drag) view.dom.classList.remove('row-resize-cursor');
          return false;
        },
        mousedown(view, event) {
          if (event.button !== 0) return false;
          const cell = rowEdge(view, event);
          if (!cell) return false;
          const rowPos = rowPosOf(view, cell);
          const trEl = cell.parentElement;
          if (rowPos == null || !trEl) return false;
          event.preventDefault();
          // 두 번 누르면 행 높이를 내용에 맞춤
          if (event.detail >= 2) {
            view.dispatch(view.state.tr.setMeta(tableExtrasKey, { set: [{ kind: 'row', pos: rowPos, value: 0 }] }));
            return true;
          }
          const rect = trEl.getBoundingClientRect();
          const zoom = trEl.offsetHeight ? rect.height / trEl.offsetHeight : 1; // 본문 확대(Ctrl+휠) 중이면 끈 거리를 배율로 나눈다
          drag = { rowPos, el: trEl, startY: event.clientY, startH: trEl.offsetHeight, zoom: zoom || 1, height: trEl.offsetHeight };
          drag.move = (e) => {
            if (!drag) return;
            drag.height = Math.round(Math.min(ROW_MAX, Math.max(ROW_MIN, drag.startH + (e.clientY - drag.startY) / drag.zoom)));
            drag.el.style.height = `${drag.height}px`; // 끄는 동안은 바로 보이게
          };
          drag.up = () => endDrag(view, true);
          window.addEventListener('mousemove', drag.move);
          window.addEventListener('mouseup', drag.up);
          document.body.classList.add('mk-row-resizing');
          return true;
        },
      },
    },
    view(view) {
      last = collectTables(view.state);
      return {
        update(v, prev) {
          if (prev.doc !== v.state.doc && !readOnly) setTimeout(() => !v.isDestroyed && fillColumnWidths(v), 0);
          const now = collectTables(v.state);
          if (sameTables(now, last)) return;
          last = now;
          if (!loading && !readOnly) onChange?.(now);
        },
        destroy() {
          endDrag(view, false);
        },
      };
    },
  });
  return {
    plugin,
    setLoading(on) {
      loading = on;
    },
  };
}

// 표 막대의 명령: 머리글 강조 켜기·끄기, 크기 원래대로 (커서가 있는 표)
export function tableAt(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return { node: $from.node(d), pos: $from.before(d) };
  return null;
}

export function isAccent(state, table) {
  const set = tableExtrasKey.getState(state)?.decos ?? DecorationSet.empty;
  return decoAt(set, table.pos, table.pos + table.node.nodeSize, 'mkAccent').length > 0;
}

export function toggleAccent(view) {
  const table = tableAt(view.state);
  if (!table) return false;
  view.dispatch(view.state.tr.setMeta(tableExtrasKey, { set: [{ kind: 'accent', pos: table.pos, value: !isAccent(view.state, table) }] }));
  return true;
}

export function resetTableSize(view) {
  const table = tableAt(view.state);
  if (!table) return false;
  const tr = view.state.tr;
  const marks = [];
  let p = table.pos + 1;
  table.node.forEach((row) => {
    let c = p + 1;
    row.forEach((cell) => {
      if (cell.attrs.colwidth) tr.setNodeMarkup(c, null, { ...cell.attrs, colwidth: null });
      c += cell.nodeSize;
    });
    marks.push({ kind: 'row', pos: p, value: 0 });
    p += row.nodeSize;
  });
  tr.setMeta(tableExtrasKey, { set: marks });
  view.dispatch(tr);
  return true;
}

// ---------- 표 나누기 · 아래 표와 합치기 ----------
// 마크다운 표에는 머리글 행이 꼭 있어야 해서: 나누면 아래 표 맨 위에 머리글 행을 한 번 더 둔다.
// 합칠 때 아래 표의 머리글이 위 표와 같으면 버리고, 다르면 보통 행으로 이어 붙인다.

/** 커서가 든 표와 그 행 번호 — { node, pos, depth, row } | null */
function tableAndRow(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') return { node: $from.node(d), pos: $from.before(d), depth: d, row: $from.index(d) };
  }
  return null;
}

/**
 * 커서가 있는 행부터 아래를 새 표로 떼어 낸다
 * @returns {true|string} true = 나눔(또는 나눌 수 있음), 문자열 = 못 나누는 이유
 */
export function splitTableAt(state, dispatch) {
  const t = tableAndRow(state);
  if (!t) return '표 안에 커서를 두세요';
  if (t.row < 2) return '나눌 행(머리글 아래 두 번째 행부터)에 커서를 두세요';
  // 합친 칸이 나누는 줄을 걸치면 나눌 수 없다
  const map = TableMap.get(t.node);
  for (const cellPos of new Set(map.map)) {
    const at = map.findCell(cellPos);
    if (at.top < t.row && at.bottom > t.row) return '나누는 줄에 걸친 합친 칸을 먼저 풀어 주세요';
  }
  if (!dispatch) return true;
  const rows = [];
  t.node.forEach((r) => rows.push(r));
  const upper = t.node.type.create(t.node.attrs, rows.slice(0, t.row));
  const lower = t.node.type.create(t.node.attrs, [rows[0], ...rows.slice(t.row)]);
  // 두 표는 바로 이어 둔다 (사이에 빈 줄을 두면 마크다운에 "<br />" 이 남는다 — 저장할 때 표 둘로 나뉨)
  const tr = state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, [upper, lower]);
  // 커서: 아래 표의 첫 본문 행 첫 칸
  const lowerPos = t.pos + upper.nodeSize;
  const firstBody = lowerPos + 1 + lower.child(0).nodeSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(firstBody + 2)));
  dispatch(tr.scrollIntoView());
  return true;
}

/** 표 바로 아래(빈 줄은 건너뜀)의 표 — { node, pos, from } | null (from = 지울 범위의 시작) */
function nextTable(doc, t) {
  const end = t.pos + t.node.nodeSize;
  const $end = doc.resolve(end);
  const parent = $end.parent;
  let i = $end.index();
  let pos = end;
  while (i < parent.childCount) {
    const n = parent.child(i);
    if (n.type.name === 'table') return { node: n, pos };
    if (n.type.name !== 'paragraph' || n.content.size > 0) return null;
    pos += n.nodeSize;
    i++;
  }
  return null;
}

const rowText = (row) => {
  const out = [];
  row.forEach((cell) => out.push(cell.textContent.trim()));
  return out.join('\u0001');
};

/**
 * 커서가 있는 표에 바로 아래 표를 이어 붙인다 (열 수가 같을 때만)
 * @returns {true|string}
 */
export function joinNextTable(state, dispatch) {
  const t = tableAndRow(state);
  if (!t) return '표 안에 커서를 두세요';
  const next = nextTable(state.doc, t);
  if (!next) return '바로 아래에 이어 붙일 표가 없어요';
  if (TableMap.get(t.node).width !== TableMap.get(next.node).width) return '열 수가 같은 표끼리만 합칠 수 있어요';
  if (!dispatch) return true;
  const { schema } = state;
  const rows = [];
  t.node.forEach((r) => rows.push(r));
  next.node.forEach((r, _o, i) => {
    if (i > 0) return rows.push(r);
    if (rowText(r) === rowText(t.node.child(0))) return undefined; // 머리글이 같으면 한 번만
    // 머리글이 다르면 보통 행으로
    const cells = [];
    r.forEach((cell) => cells.push(schema.nodes.table_cell.create(cell.attrs, cell.content)));
    return rows.push(schema.nodes.table_row.create(null, cells));
  });
  const joined = t.node.type.create(t.node.attrs, rows);
  const tr = state.tr.replaceWith(t.pos, next.pos + next.node.nodeSize, joined);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(state.selection.from, t.pos + joined.nodeSize - 2))));
  dispatch(tr.scrollIntoView());
  return true;
}

// ---------- 표 → 목록 · 글 ----------
// 행마다 한 줄: 칸의 글을 " · " 로 이어서 (빈 칸은 건너뜀, 합친 칸 안의 줄바꿈은 띄어쓰기). 첫 행(머리글)도 첫 줄로.

/** 표 한 행 → 한 줄의 글 조각들 (굵게·링크 등 글자 서식 · 그림 · 파일 칩은 그대로) */
function rowInline(row, schema) {
  const isBreak = (n) => n.type.name === 'hardbreak' || n.type.name === 'hard_break' || (n.type.name === 'html' && /^<br\s*\/?>$/i.test(String(n.attrs.value ?? '').trim()));
  const parts = [];
  row.forEach((cell) => {
    const inline = [];
    const space = () => {
      const last = inline[inline.length - 1];
      if (last && !(last.isText && last.text.endsWith(' '))) inline.push(schema.text(' '));
    };
    // 칸 안의 줄바꿈 · 여러 문단 · 목록 항목은 띄어쓰기 하나로
    cell.descendants((n) => {
      if (!n.isInline) {
        if (n.isTextblock) space();
        return true;
      }
      if (isBreak(n)) space();
      else inline.push(n);
      return false;
    });
    // 칸 앞뒤 띄어쓰기는 걷어낸다 (" · " 앞뒤에 띄어쓰기가 겹치지 않게)
    const trimEdge = (at, cut) => {
      while (inline.length) {
        const i = at === 'end' ? inline.length - 1 : 0;
        const n = inline[i];
        if (!n.isText) return;
        const text = cut(n.text);
        if (text) {
          inline[i] = n.text === text ? n : schema.text(text, n.marks);
          return;
        }
        inline.splice(i, 1);
      }
    };
    trimEdge('start', (t) => t.replace(/^\s+/, ''));
    trimEdge('end', (t) => t.replace(/\s+$/, ''));
    // 띄어쓰기만 있는 칸은 건너뛴다 (그림 · 파일 칩처럼 글자가 없는 것만 든 칸은 남긴다)
    if (!inline.some((n) => !n.isText || n.text.trim())) return;
    if (parts.length) parts.push(schema.text(' · '));
    parts.push(...inline);
  });
  return parts;
}

/**
 * 커서가 든 표를 점 목록(kind 'list') 또는 글 줄(kind 'text')로 바꾼다 — 행마다 한 줄
 * @returns {true|string}
 */
export function tableToBlocks(state, dispatch, kind) {
  const t = tableAndRow(state);
  if (!t) return '표 안에 커서를 두세요';
  if (!dispatch) return true;
  const { schema } = state;
  const lines = [];
  t.node.forEach((row) => {
    const inline = rowInline(row, schema);
    if (inline.length) lines.push(schema.nodes.paragraph.create(null, inline));
  });
  if (!lines.length) lines.push(schema.nodes.paragraph.create());
  const blocks = kind === 'list'
    ? [schema.nodes.bullet_list.create(null, lines.map((p) => schema.nodes.list_item.create({ listType: 'bullet' }, p)))]
    : lines;
  const tr = state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, blocks);
  tr.setSelection(TextSelection.near(tr.doc.resolve(t.pos + 1)));
  dispatch(tr.scrollIntoView());
  return true;
}
