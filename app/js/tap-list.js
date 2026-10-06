// 목록 아래 줄을 눌러 이어 쓰기 (휴대폰) — 키패드의 줄바꿈 대신 쓰던 줄 아랫줄을 손가락으로 눌러 줄을 바꾸는 사람을 위해
//   - 체크리스트·글머리·번호 목록 바로 아래의 빈 줄을 누르면 그 줄이 목록의 새 항목이 된다 (체크리스트면 빈 네모까지)
//   - 아무것도 안 쓰고 다른 곳을 누르면 새 항목은 없어지고 원래 빈 줄로 돌아간다
//   - 목록에서 빠져나오려면 지금처럼 빈 항목에서 줄바꿈(Enter)
import { Plugin, PluginKey, TextSelection } from '../vendor/milkdown.js';

const key = new PluginKey('memoking-tap-list');
const LISTS = new Set(['bullet_list', 'ordered_list']);
const TAP_MS = 900; // 손가락을 댄 뒤 이 안에 커서가 옮겨 오면 "눌러서" 온 것

const isEmptyItem = (node) => node?.type.name === 'list_item'
  && node.childCount === 1 && node.firstChild.type.name === 'paragraph' && node.firstChild.content.size === 0;

export function createTapList() {
  let tapAt = 0;
  return new Plugin({
    key,
    // 눌러서 만든 빈 항목의 자리 (없으면 null)
    state: {
      init: () => null,
      apply(tr, pos) {
        const meta = tr.getMeta(key);
        if (meta !== undefined) return meta;
        return pos == null ? null : tr.mapping.map(pos);
      },
    },
    props: {
      handleDOMEvents: {
        touchstart: () => {
          tapAt = Date.now();
          return false;
        },
        pointerdown: (_view, e) => {
          if (e.pointerType !== 'mouse') tapAt = Date.now();
          return false;
        },
      },
    },
    appendTransaction(trs, _old, state) {
      const { selection, doc, schema } = state;
      const made = key.getState(state);
      if (made != null) {
        const item = doc.nodeAt(made);
        if (!isEmptyItem(item)) return state.tr.setMeta(key, null); // 썼거나(이제 보통 항목) 없어짐
        const inside = selection.from > made && selection.to < made + item.nodeSize;
        if (inside) return null;
        // 비운 채 떠났으면: 항목을 거두고 목록 아래에 빈 줄을 돌려놓는다
        const $item = doc.resolve(made);
        const listEnd = $item.after();
        const tr = state.tr;
        const after = doc.resolve(listEnd).nodeAfter;
        const blankAfter = after?.type.name === 'paragraph' && after.content.size === 0; // 맨 끝 빈 줄이 이미 있음
        if ($item.parent.childCount === 1) tr.replaceWith($item.before(), listEnd, schema.nodes.paragraph.create());
        else {
          tr.delete(made, made + item.nodeSize);
          if (!blankAfter) tr.insert(tr.mapping.map(listEnd), schema.nodes.paragraph.create());
        }
        return tr.setMeta(key, null).setMeta('addToHistory', false);
      }
      if (Date.now() - tapAt > TAP_MS) return null;
      if (!trs.some((t) => t.selectionSet) || trs.some((t) => t.docChanged)) return null;
      if (!selection.empty) return null;
      const { $from } = selection;
      const para = $from.parent;
      if (para.type.name !== 'paragraph' || para.content.size !== 0) return null;
      // 목록 바로 다음의 빈 줄 (문서 맨 위 단계 · 인용 안 · 목록 항목 안의 목록 아래 모두)
      const depth = $from.depth;
      const index = $from.index(depth - 1);
      if (index === 0) return null;
      const box = $from.node(depth - 1);
      const list = box.child(index - 1);
      if (!LISTS.has(list.type.name)) return null;
      const last = list.lastChild;
      if (!last || last.type.name !== 'list_item') return null;
      tapAt = 0;
      const paraStart = $from.before(depth);
      const item = schema.nodes.list_item.create({
        listType: last.attrs.listType,
        spread: last.attrs.spread,
        checked: last.attrs.checked == null ? null : false,
      }, schema.nodes.paragraph.create());
      const at = paraStart - 1; // 목록이 닫히기 바로 앞
      const tr = state.tr.delete(paraStart, paraStart + para.nodeSize).insert(at, item);
      tr.setSelection(TextSelection.create(tr.doc, at + 2));
      return tr.setMeta(key, at).setMeta('addToHistory', false);
    },
  });
}
