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
function fillColumnWidths(view) {
  const { state } = view;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const first = node.firstChild;
    if (!first) return false;
    const widths = [];
    let any = false;
    let missing = false;
    let c = pos + 2;
    first.forEach((cell) => {
      const w = cell.attrs.colwidth?.[0];
      if (w) any = true;
      else missing = true;
      const dom = view.nodeDOM(c);
      widths.push(w || Math.round(dom?.offsetWidth ?? 0));
      c += cell.nodeSize;
    });
    if (!any || !missing || widths.some((w) => !w)) return false;
    let p = pos + 1;
    node.forEach((row) => {
      let cp = p + 1;
      row.forEach((cell, _o, ci) => {
        if (!cell.attrs.colwidth?.[0] && widths[ci]) tr.setNodeMarkup(cp, null, { ...cell.attrs, colwidth: [widths[ci]] });
        cp += cell.nodeSize;
      });
      p += row.nodeSize;
    });
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
    if (node.firstChild && [...Array(node.firstChild.childCount).keys()].some((i) => node.firstChild.child(i).attrs.colwidth?.[0])) {
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
