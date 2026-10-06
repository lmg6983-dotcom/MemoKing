// 빈 체크리스트 항목 지키기 (remark 플러그인)
//   마크다운 규칙(GFM)상 내용 없는 "- [ ]" 는 체크리스트가 아니라 글자 "[ ]" 인 점 목록으로 읽힌다 → 저장하면 "- \[ ]",
//   다시 열면 "[ ]" 글자가 보이는 문제. 항목 글이 "[ ]" · "[x]" 뿐이면 빈 체크리스트 항목으로 되돌린다
//   (이미 "- \[ ]" 로 저장된 파일도 같은 글자로 읽히므로 함께 고쳐진다)
const MARK = /^\[([ xX])\]$/;

export function remarkEmptyTasks() {
  return (tree) => {
    const walk = (node) => {
      if (node.type === 'listItem' && node.checked == null && node.children?.length === 1) {
        const p = node.children[0];
        const only = p.type === 'paragraph' && p.children?.length === 1 && p.children[0].type === 'text' ? p.children[0].value.trim() : null;
        const m = only != null && only.match(MARK);
        if (m) {
          node.checked = m[1] !== ' ';
          p.children = [];
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
