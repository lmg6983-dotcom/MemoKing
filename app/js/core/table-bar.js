// 표 막대의 단추 상태 — PC 메모 창(note.js)과 휴대폰 메모 화면(note-view.js)이 같이 쓴다 (순수 함수, 단위 테스트 대상)
import { UI } from './ui-text.js';

// 머리글 아래 행은 마지막 하나까지 삭제할 수 있다 (머리글 행만 남은 1행 표도 된다).
// 머리글 행만 남았을 때 머리글에서 누르면, 열이 하나뿐일 때 누르면 표 전체를 삭제한다 (표 막대에 "표 삭제"가 따로 없음)
export function tableBarState(table) {
  const lastRow = Boolean(table.header && table.rows <= 1);
  const lastCol = table.cols <= 1;
  return {
    delRow: {
      disabled: Boolean(table.header && !lastRow),
      whole: lastRow,
      label: lastRow ? '표 삭제' : '삭제',
      title: lastRow ? '머리글 행만 남았어요. 누르면 표를 삭제해요' : table.header ? '머리글 행은 삭제할 수 없어요 (아래 행을 모두 삭제하면 표를 삭제할 수 있어요)' : UI.rowDelete,
    },
    delCol: {
      disabled: false,
      whole: lastCol,
      label: lastCol ? '표 삭제' : '삭제',
      title: lastCol ? '열이 하나뿐이에요. 누르면 표를 삭제해요' : UI.colDelete,
    },
    // 셀 병합: 여러 칸을 골랐으면 "병합", 병합한 칸 안이면 "병합 풀기"
    merge: {
      disabled: !table.canMerge && !table.merged,
      label: table.merged ? '병합 풀기' : '병합',
      title: table.merged ? '합친 칸을 다시 나누기' : table.canMerge ? '고른 칸들을 하나로 합치기' : UI.mergePick,
    },
    accent: Boolean(table.accent),
    // 표 나누기 · 아래 표와 합치기: 할 수 있을 때만 (숨기지 않고 흐리게 — 커서를 옮길 때마다 버튼이 생겼다 사라지지 않게)
    split: { disabled: !table.canSplit, title: table.canSplit ? UI.splitHere : UI.splitWhere },
    join: { disabled: !table.canJoin, title: table.canJoin ? UI.joinBelow : UI.joinWhen },
  };
}

// 표 막대 버튼 → 편집기 명령. 마지막 남은 머리글 행 · 열을 삭제하면 표 전체를 삭제한다
export const tableCommandFor = (action, whole) => (whole && (action === 'delRow' || action === 'delCol') ? 'delTable' : action);
