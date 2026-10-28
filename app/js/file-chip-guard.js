// 파일 칩(첨부 파일 링크 — PDF 등)의 이름은 고칠 수 없게 (데스크탑·휴대폰 함께)
//   칩 글자는 파일을 가리키는 이름이라, 몇 글자만 지우거나 끼워 넣으면 칩 이름과 실제 파일이 어긋난다
//   - 칩 글자 일부만 바꾸는 편집(치기 · 지우기 · 붙여넣기)은 받지 않는다. 칩을 통째로 지우거나 옮기는 것은 된다
//   - 칩 바로 뒤에서 Backspace · 바로 앞에서 Delete 는 칩을 통째로 지운다 (한 글자씩 지워지지 않으니)
//   - 커서는 칩 앞 · 뒤에만 (칩 하나가 캡슐 하나): 가운데를 누르면 가까운 끝으로, 화살표는 칩을 한 번에 건너뛰고,
//     Shift 로 고르면 칩을 통째로 고른다 (칩 뒤에서 친 글이 칩 이름에 붙지 않는 것은 editor.js 링크 inclusive: false)
import { Plugin, PluginKey, TextSelection, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { isProgramFile } from './core/file-kinds.js';

const isFileHref = (href) => typeof href === 'string' && href.startsWith('attachments/');
const fileMarkOf = (node) => node.marks.find((m) => m.type.name === 'link' && isFileHref(m.attrs.href));

/** 글 줄(textblock) 안의 파일 칩 자리들 [{ from, to }] — 같은 파일 링크가 이어진 글자들이 한 칩 */
export function chipRanges(block, start) {
  const out = [];
  let last = null;
  block.forEach((child, offset) => {
    const mark = child.isText ? fileMarkOf(child) : null;
    const from = start + offset;
    const to = from + child.nodeSize;
    if (mark && last && last.href === mark.attrs.href && last.to === from) last.to = to;
    else if (mark) out.push((last = { from, to, href: mark.attrs.href }));
    else last = null;
  });
  return out;
}

/** [from, to) 를 바꾸면 칩을 일부만 건드리는가 (통째로 덮으면 괜찮다 · 칩 앞뒤 경계에 끼워 넣기도 괜찮다) */
export function cutsChip(chips, from, to) {
  return chips.some((c) => (from === to ? from > c.from && from < c.to : from < c.to && to > c.from && !(from <= c.from && to >= c.to)));
}

function chipsAround(doc, from, to) {
  const chips = [];
  const a = Math.max(0, Math.min(from, doc.content.size));
  const b = Math.max(a, Math.min(to, doc.content.size));
  doc.nodesBetween(a, b, (node, pos) => {
    if (!node.isTextblock) return true;
    chips.push(...chipRanges(node, pos + 1));
    return false;
  });
  return chips;
}

function chipNextTo(state, dir) {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;
  const at = $from.pos;
  return chipRanges($from.parent, $from.start()).find((c) => (dir < 0 ? c.to === at : c.from === at)) ?? null;
}

/**
 * 칩 안에 든 자리를 칩 끝으로: 칩 끝에서 들어왔으면 건너편으로, 아니면 가까운 끝으로
 * @param {{ from: number, to: number }[]} chips @param {number} pos @param {number|null} came 바로 전 자리 (±Infinity: 그 방향으로 가는 중)
 */
export function snapOutOfChip(chips, pos, came) {
  const c = chips.find((x) => pos > x.from && pos < x.to);
  if (!c) return pos;
  // 칩 끝에서 들어왔으면(화살표 — came 은 화살표일 때만) 건너편으로, 아니면 가까운 끝으로
  if (came === c.from || came === -Infinity) return c.to;
  if (came === c.to || came === Infinity) return c.from;
  return pos - c.from <= c.to - pos ? c.from : c.to;
}

const chipsAt = ($pos) => ($pos.parent.isTextblock ? chipRanges($pos.parent, $pos.start()) : []);

// 화살표로 움직였나 (그때만 칩을 건너뛴다 — 누르기 · 오른쪽 클릭은 가까운 끝: 칩 앞에 있다가 칩을 오른쪽 클릭했는데
//   건너편으로 가면 커서가 바뀌어 막 뜬 메뉴가 닫혔다)
let arrowAt = 0;
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export const fileChipGuard = () => new Plugin({
  key: new PluginKey('memoking-file-chip-guard'),
  filterTransaction(tr) {
    if (!tr.docChanged || tr.getMeta('memoking-allow-chip-edit')) return true;
    for (let i = 0; i < tr.steps.length; i++) {
      const doc = tr.docs[i];
      let bad = false;
      tr.steps[i].getMap().forEach((from, to) => {
        if (!bad && cutsChip(chipsAround(doc, from, to), from, to)) bad = true;
      });
      if (bad) return false;
    }
    return true;
  },
  // 커서 · 고른 범위의 끝이 칩 가운데면 칩 끝으로 (누르기 · 화살표 · 위아래 줄 이동 · 끌어 고르기 모두)
  appendTransaction(trs, oldState, state) {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !trs.some((t) => t.selectionSet || t.docChanged)) return null;
    const { doc } = state;
    let oldHead = oldState.selection.head;
    for (const t of trs) oldHead = t.mapping.map(oldHead);
    const forward = sel.head > sel.anchor;
    let { head, anchor } = sel;
    const byArrow = Date.now() - arrowAt < 500;
    if (sel.empty) head = anchor = snapOutOfChip(chipsAt(sel.$head), sel.head, byArrow ? oldHead : null);
    else {
      // 늘리는 쪽 끝은 가는 방향으로 칩을 넘고, 붙박이 끝은 칩을 감싸도록 바깥으로
      head = snapOutOfChip(chipsAt(sel.$head), head, forward ? -Infinity : Infinity);
      anchor = snapOutOfChip(chipsAt(sel.$anchor), anchor, forward ? Infinity : -Infinity);
    }
    if (head === sel.head && anchor === sel.anchor) return null;
    return state.tr.setSelection(TextSelection.create(doc, anchor, head));
  },
  props: {
    decorations(state) {
      const decos = [];
      state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        const chips = chipRanges(node, pos + 1);
        if (!chips.length) return false;
        if (chips.length === 1 && chips[0].from === pos + 1 && chips[0].to === pos + 1 + node.content.size) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mk-file-line' }));
        }
        for (const c of chips) {
          decos.push(Decoration.widget(c.to, () => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mk-file-open';
            btn.dataset.fileOpen = c.href;
            btn.contentEditable = 'false';
            btn.tabIndex = -1;
            const run = isProgramFile(c.href);
            btn.textContent = run ? '실행' : '열기';
            btn.title = run ? '이 프로그램 실행' : '파일 열기';
            return btn;
          }, { side: 1, key: `open:${c.href}`, stopEvent: () => true }));
        }
        return false;
      });
      return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
    },
    handleDOMEvents: {
      mousedown(view, e) {
        if (!(e.target instanceof Element)) return false;
        if (e.target.closest('.mk-file-open')) {
          e.preventDefault();
          return true;
        }
        const capsule = e.target.closest('a[data-file], a[href^="attachments/"], .mk-tag');
        if (capsule && view.dom.contains(capsule)) {
          e.preventDefault();
        }
        return false;
      },
    },
    handleKeyDown(view, e) {
      if (ARROWS.has(e.key)) arrowAt = Date.now();
      if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return false;
      const chip = chipNextTo(view.state, e.key === 'Backspace' ? -1 : 1);
      if (!chip) return false;
      view.dispatch(view.state.tr.delete(chip.from, chip.to).scrollIntoView());
      return true;
    },
  },
});
