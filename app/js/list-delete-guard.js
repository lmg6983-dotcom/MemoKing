// 목록 항목 맨 앞에서 Delete 키를 눌렀을 때 목록 서식이 깨지는 버그 방지
// Milkdown 기본 listItemKeymap에서 LiftFirstListItem 단축키로 ["Backspace", "Delete"]가 지정되어 있어,
// 목록 맨 앞(parentOffset 0)에서 Delete를 누르면 다음 글자를 지우는 대신 목록 서식이 해제되는 문제가 있음.
// - 글자가 있을 때: 다음 글자(또는 인라인 요소)만 삭제하고 목록 서식 유지
// - 빈 목록 항목일 때: Delete를 눌러도 목록 서식이 깨지지 않도록 완전 보호 (no-op)
import { Plugin, PluginKey } from '../vendor/milkdown.js';

export const listDeleteGuardKey = new PluginKey('memoking-list-delete-guard');

/**
 * 목록 항목 맨 앞 Delete 키 처리
 * @param {{ state: any, dispatch?: Function }} view
 * @param {KeyboardEvent} event
 * @returns {boolean} 이벤트를 처리했으면 true
 */
export function handleListDelete(view, event) {
  if (!event || event.key !== 'Delete') return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;

  const { state, dispatch } = view;
  const { selection } = state;
  if (!selection || !selection.empty) return false;

  const { $from } = selection;
  if ($from.parentOffset !== 0) return false;

  // 조상 중 list_item이 있는지 확인
  let inListItem = false;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d)?.type?.name;
    if (name === 'list_item') {
      inListItem = true;
      break;
    }
  }
  if (!inListItem) return false;

  const parent = $from.parent;
  // 빈 목록 항목인 경우: 목록 서식이 파괴되지 않도록 완전 보호 (no-op)
  if (!parent || parent.content.size === 0) {
    return true;
  }

  // 글자/요소가 있는 경우: 다음 글자(또는 인라인 노드) 삭제
  const nodeAfter = $from.nodeAfter;
  if (nodeAfter) {
    const step = nodeAfter.isText
      ? (nodeAfter.text && nodeAfter.text.codePointAt(0) > 0xffff ? 2 : 1)
      : nodeAfter.nodeSize;
    const tr = state.tr.delete($from.pos, $from.pos + step);
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  }

  return true;
}

export function listDeleteGuard() {
  return new Plugin({
    key: listDeleteGuardKey,
    props: {
      handleKeyDown(view, event) {
        return handleListDelete(view, event);
      },
    },
  });
}
