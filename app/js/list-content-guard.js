// 목록에는 글만 — 그림 · 손 메모 · 소리 · 동영상 · 음성 카드 · 파일 칩 · 링크 카드 · 표 · 수식 블록은 목록 항목 안에 둘 수 없다.
//   어떤 길로 들어오든(붙여넣기 · 끌어 놓기 · + 메뉴 · 옮기기 · 예전 메모 파일) 맨 바깥 목록이 끝난 바로 뒤로 빼낸다.
//   항목에 그 내용뿐이면 항목째 지우고(목록이 비면 목록도), 항목의 첫 줄이었으면 빈 글 줄을 남긴다 (항목은 글 줄로 시작해야 한다)
import { Plugin, PluginKey } from '../vendor/milkdown.js';
import { isVoiceCard } from './voice-card-view.js';

export const listContentGuardKey = new PluginKey('memoking-list-content-guard');

const BLOCKS = new Set(['table', 'math_block', 'mk_link_card']);
const isAttachmentLink = (child) => child.isText && child.marks.some((m) => m.type.name === 'link' && /^attachments\//.test(m.attrs.href ?? ''));
const isBlank = (child) => (child.isText && !child.text.trim()) || /^hard_?break$/.test(child.type.name);

/** 목록에 둘 수 없는 줄인가: 그림 · 파일 칩만 든 글 줄, 표 · 수식 · 링크 카드, 음성 카드 (글 사이 링크 · 인터넷 주소 줄은 글이라 그대로) */
export function isBlockedInList(node) {
  if (BLOCKS.has(node.type.name) || isVoiceCard(node)) return true;
  if (node.type.name !== 'paragraph' || !node.childCount) return false;
  let content = false;
  let other = false;
  node.forEach((child) => {
    if (child.type.name === 'image' || isAttachmentLink(child)) content = true;
    else if (!isBlank(child)) other = true;
  });
  return content && !other;
}

/** 목록 항목 안의 막힌 줄들 [{ pos, node }] (문서 순서) */
function blockedInLists(doc) {
  const found = [];
  const walk = (node, start, inItem) => {
    node.forEach((child, offset) => {
      const at = start + offset;
      if (inItem && isBlockedInList(child)) found.push({ pos: at, node: child });
      else if (child.isBlock && !child.isTextblock && !child.isAtom) walk(child, at + 1, inItem || child.type.name === 'list_item');
    });
  };
  walk(doc, 0, false);
  return found;
}

/** 목록 안 막힌 줄을 모두 맨 바깥 목록 뒤로 옮기는 거래 (없으면 null) — 순서는 그대로 */
export function moveOutOfLists(state) {
  const found = blockedInLists(state.doc);
  if (!found.length) return null;
  const tr = state.tr;
  for (const { pos, node } of found) {
    const after = state.doc.resolve(pos).after(1); // 맨 바깥 줄(목록)이 끝난 자리 (원래 문서에서)
    const from = tr.mapping.map(pos);
    const $from = tr.doc.resolve(from);
    const item = $from.parent;
    if (item.type.name === 'list_item' && item.childCount === 1) {
      const list = $from.node($from.depth - 1);
      if (list.childCount === 1) tr.delete($from.before($from.depth - 1), $from.after($from.depth - 1));
      else tr.delete($from.before(), $from.after());
    } else if (item.type.name === 'list_item' && $from.index() === 0) {
      tr.replaceWith(from, from + node.nodeSize, state.schema.nodes.paragraph.create());
    } else tr.delete(from, from + node.nodeSize);
    tr.insert(tr.mapping.map(after), node); // 앞서 뺀 것 뒤에 (같은 자리면 그 다음으로 이어진다)
  }
  return tr;
}

/** 이 편집기에서 목록 정리를 한 번이라도 했는가 — 예전 메모를 열며 고쳤으면 메모 창이 기준을 잡은 뒤 한 번 저장한다 */
export const listsFixed = (state) => Boolean(listContentGuardKey.getState(state));

export function listContentGuard() {
  return new Plugin({
    key: listContentGuardKey,
    state: { init: () => false, apply: (tr, fixed) => fixed || Boolean(tr.getMeta(listContentGuardKey)) },
    appendTransaction(trs, _old, state) {
      return trs.some((t) => t.docChanged) ? moveOutOfLists(state)?.setMeta(listContentGuardKey, true) ?? null : null;
    },
  });
}
