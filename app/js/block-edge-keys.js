// 줄 맨 앞 Backspace · 줄 끝 Delete 로 서식이 뜻밖에 바뀌지 않게 (편집기 플러그인, 데스크탑 · 휴대폰 함께)
//   Milkdown · ProseMirror 의 기본 동작이 "줄을 잇는다" 대신 서식을 건드리던 것들:
//     - 제목 맨 앞 Backspace · Delete: 제목2 → 제목1 처럼 한 단계씩 커졌다 (DowngradeHeading). Delete 는 글자도 지우지 않았다
//     - 목록 첫 항목 맨 앞 Backspace: 위의 다른 종류 목록에 붙어 번호가 점으로(체크가 번호로) 바뀌거나, 위 인용 안으로 목록이 통째로 들어갔다
//     - 줄 끝 Delete: 아래 목록이 다른 종류 목록 · 인용에 붙거나, 아래 인용이 풀렸다
//     - 코드 블록 경계: 코드가 보통 글로, 보통 글이 코드로 섞였다
//   원칙: 지금 줄(또는 윗줄)의 서식은 그대로, 이어 붙는 줄의 글자만 옮긴다 — 글 편집기에서 줄바꿈 하나를 지운 것과 같게.
//         코드와 보통 글은 서로 잇지 않는다 (빈 줄이면 그 줄만 없앤다). 표 · 그림 · 가로줄 경계는 기본 동작에 맡긴다.
import { Plugin, PluginKey, TextSelection, liftListItem } from '../vendor/milkdown.js';

export const blockEdgeKeysKey = new PluginKey('memoking-block-edge-keys');

const isCode = (node) => node.type.name === 'code_block' || Boolean(node.type.spec.code);
const isList = (node) => node.type.name === 'bullet_list' || node.type.name === 'ordered_list';
// 글 줄이 아닌 덩어리 (표 · 그림 · 가로줄 …): 이것을 건너 줄을 잇지 않는다
const isBarrier = (node) => node.type.name === 'table' || (node.isLeaf && !node.isText && node.isBlock) || (node.isAtom && node.isBlock && !node.isTextblock);

// 표 칸처럼 안팎으로 글이 넘나들지 않는 상자의 시작 자리 (없으면 -1) — 서로 다른 칸 · 표 안팎의 줄은 잇지 않는다
function isolatingStart(doc, pos) {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.spec.isolating) return $pos.before(d);
  return -1;
}
const sameBox = (doc, a, b) => isolatingStart(doc, a) === isolatingStart(doc, b);

/** pos 뒤의 첫 글 줄 { node, pos } — 그 앞에 표 · 그림 같은 덩어리가 있으면 null */
function nextTextblock(doc, pos) {
  let found = null;
  let blocked = false;
  doc.nodesBetween(pos, doc.content.size, (node, p) => {
    if (found || blocked) return false;
    if (p < pos) return true; // 지금 줄을 감싼 상자들
    if (isBarrier(node)) blocked = true;
    else if (node.isTextblock) found = { node, pos: p };
    return !found && !blocked;
  });
  return blocked || !found || !sameBox(doc, pos, found.pos + 1) ? null : found;
}

/** pos 앞의 마지막 글 줄 { node, pos } — 그 사이에 표 · 그림 같은 덩어리가 있으면 null */
function prevTextblock(doc, pos) {
  const sel = TextSelection.findFrom(doc.resolve(pos), -1, true);
  if (!sel) return null;
  const $p = sel.$head;
  if (!$p.parent.isTextblock) return null;
  let blocked = false;
  doc.nodesBetween($p.pos, pos, (node) => {
    if (isBarrier(node)) blocked = true;
    return !blocked;
  });
  // 줄 끝이 아니면(사이에 건너뛴 것이 있으면) 잇지 않는다
  if (blocked || $p.parentOffset !== $p.parent.content.size || !sameBox(doc, pos, $p.pos)) return null;
  return { node: $p.parent, pos: $p.before() };
}

/** 글 줄 하나를 지울 범위 — 그 줄만 든 상자(목록 항목 · 목록 · 인용)는 함께, keep 자리를 감싼 상자는 남긴다 */
function removalRange(doc, blockPos, keep) {
  const $in = doc.resolve(blockPos + 1);
  let d = $in.depth;
  while (d > 1 && $in.node(d - 1).childCount === 1 && !($in.start(d - 1) <= keep && keep <= $in.end(d - 1))) d--;
  return { from: $in.before(d), to: $in.after(d) };
}

/** from 줄을 지우고 그 글자를 into 자리에 넣은 tr (문서 규칙에 어긋나면 null) */
function moveText(state, from, into) {
  try {
    const { from: a, to: b } = removalRange(state.doc, from.pos, into);
    const tr = state.tr.delete(a, b);
    const at = tr.mapping.map(into, -1);
    if (from.node.content.size) tr.insert(at, from.node.content);
    tr.doc.check();
    return tr.setSelection(TextSelection.create(tr.doc, at)).scrollIntoView();
  } catch {
    return null;
  }
}

/**
 * 줄 맨 앞 Backspace · 줄 끝 Delete 를 어떻게 할지
 * @returns {import('../vendor/milkdown.js').Transaction | true | null} tr: 이렇게 고친다 · true: 아무 일도 하지 않는다 · null: 기본 동작에 맡긴다
 */
export function edgeKeyAction(state, key) {
  const { selection, doc } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;
  const { $from } = selection;
  const block = $from.parent;
  if (!block.isTextblock || $from.depth < 1) return null;
  const atStart = $from.parentOffset === 0;
  const atEnd = $from.parentOffset === block.content.size;
  const here = { node: block, pos: $from.before() };

  if (key === 'Backspace') {
    if (!atStart) return null;
    if (block.type.name === 'heading') {
      // 제목: 단계를 바꾸지 않고 윗줄에 잇는다 (윗줄이 없거나 표 · 그림이면 그대로 둔다)
      const prev = prevTextblock(doc, here.pos);
      if (!prev || isCode(prev.node)) return true;
      return moveText(state, here, prev.pos + 1 + prev.node.content.size) ?? true;
    }
    if (isCode(block)) {
      // 코드 블록 맨 앞: 위의 보통 글에 섞지 않는다. 빈 코드 블록이면 보통 줄로
      if (block.content.size) return true;
      const para = state.schema.nodes.paragraph;
      return para ? state.tr.setBlockType($from.pos, $from.pos, para).scrollIntoView() : true;
    }
    // 목록의 첫 항목 (다른 목록 안이 아닌): 위의 목록 · 인용에 붙지 않고 목록에서 빠져 보통 줄이 된다
    const item = $from.depth >= 2 ? $from.node(-1) : null;
    if (item?.type.name === 'list_item' && $from.index(-1) === 0 && $from.index(-2) === 0 && $from.depth >= 3 && $from.node(-3).type.name !== 'list_item') {
      let tr = null;
      liftListItem(item.type)(state, (t) => (tr = t));
      return tr ? tr.scrollIntoView() : null;
    }
    // 보통 줄 맨 앞, 윗줄이 코드 블록: 코드에 섞지 않는다 (빈 줄이면 그 줄만 없애고 코드 끝으로)
    const prev = prevTextblock(doc, here.pos);
    if (prev && isCode(prev.node)) return block.content.size ? true : moveText(state, here, prev.pos + 1 + prev.node.content.size) ?? true;
    return null;
  }

  if (key === 'Delete') {
    // 제목 맨 앞 Delete: 단계를 바꾸지 않고 다음 글자를 지운다
    if (block.type.name === 'heading' && atStart && !atEnd) {
      const after = $from.nodeAfter;
      const size = after?.isText ? (after.text.codePointAt(0) > 0xffff ? 2 : 1) : after?.nodeSize ?? 0;
      return size ? state.tr.delete($from.pos, $from.pos + size).scrollIntoView() : true;
    }
    if (!atEnd) return null;
    const next = nextTextblock(doc, $from.after());
    if (!next) return block.type.name === 'heading' && atStart ? true : null; // 빈 제목: 기본 동작(단계 바꾸기)은 막는다
    const sibling = next.pos === $from.after(); // 바로 아래 형제 줄 (같은 상자 안)
    const removeHere = () => {
      try {
        const { from, to } = removalRange(doc, here.pos, next.pos + 1);
        const tr = state.tr.delete(from, to);
        tr.doc.check();
        return tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(next.pos + 1, 1))).scrollIntoView();
      } catch {
        return true;
      }
    };
    if (isCode(block) !== isCode(next.node)) {
      // 코드와 보통 글은 잇지 않는다 — 한쪽이 빈 줄이면 그 빈 줄만 없앤다
      if (!next.node.content.size) return moveText(state, next, $from.pos) ?? true;
      return block.content.size ? true : removeHere();
    }
    if (block.type.name === 'heading' && atStart) return removeHere(); // 빈 제목: 아랫줄을 제목으로 만들지 않고 빈 제목만 없앤다
    if (sibling) return null; // 기본 동작이 글자만 잇는다
    // 다른 상자(다른 목록 · 인용 · 목록 항목)의 줄: 그 줄의 글자만 지금 줄 끝으로 가져온다
    return moveText(state, next, $from.pos) ?? true;
  }
  return null;
}

export function handleEdgeKey(view, event) {
  if (!event || (event.key !== 'Backspace' && event.key !== 'Delete')) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return false;
  const action = edgeKeyAction(view.state, event.key);
  if (action === null) return false;
  if (action !== true) view.dispatch(action);
  return true;
}

export function blockEdgeKeys() {
  return new Plugin({
    key: blockEdgeKeysKey,
    props: {
      handleKeyDown: (view, event) => handleEdgeKey(view, event),
    },
  });
}
