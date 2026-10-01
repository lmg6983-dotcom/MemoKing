// 표 더하기 기능 (편집기 플러그인) — 열 너비·행 높이를 끌어서 바꾸고, 머리글 행 바탕은 고를 때만 칠한다.
//   열 너비: Milkdown(prosemirror-tables)의 열 크기 조절(칸 오른쪽 테두리를 끌기) → 칸의 colwidth.
//            한 열을 처음 바꾸면 나머지 열도 지금 너비로 고정해 표가 정한 대로 보이게 한다.
//   행 높이: 칸 아래 테두리를 끌기 (두 번 누르면 내용에 맞춤) → 행 표시(decoration)의 높이.
//   머리글 강조: 표 표시(decoration)의 class.
// 셋 다 마크다운 표에는 적을 곳이 없어 메모 머리말(tables)에 표 순서대로 저장한다 (core/table-sizes.js).
import { Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/milkdown.js';
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
    out.push(t);
    return false;
  });
  return normalizeTables(out);
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
