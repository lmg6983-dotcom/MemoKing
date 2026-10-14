// 파일 칩(첨부 파일 링크 — PDF 등)의 이름은 고칠 수 없게 (데스크탑·휴대폰 함께)
//   칩 글자는 파일을 가리키는 이름이라, 몇 글자만 지우거나 끼워 넣으면 칩 이름과 실제 파일이 어긋난다
//   - 칩 글자 일부만 바꾸는 편집(치기 · 지우기 · 붙여넣기)은 받지 않는다. 칩을 통째로 지우거나 옮기는 것은 된다
//   - 칩 바로 뒤에서 Backspace · 바로 앞에서 Delete 는 칩을 통째로 지운다 (한 글자씩 지워지지 않으니)
import { Plugin, PluginKey } from '../vendor/milkdown.js';

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
  props: {
    handleKeyDown(view, e) {
      if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return false;
      const chip = chipNextTo(view.state, e.key === 'Backspace' ? -1 : 1);
      if (!chip) return false;
      view.dispatch(view.state.tr.delete(chip.from, chip.to).scrollIntoView());
      return true;
    },
  },
});
