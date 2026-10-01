// 복사할 때 클립보드의 "일반 글자"(text/plain) — 메모장·카톡처럼 서식 없는 곳에 붙일 글.
// Milkdown 은 여기에 마크다운 원문을 넣어 \* · 1\. · \[ 같은 이스케이프(\)가 섞여 붙는다. 사람이 읽는 글로 바꾼다:
//   문단·제목은 한 줄씩, 칸 안 줄바꿈은 줄바꿈, 목록은 "• " · "1. " · "☐ "/"☑ ", 표는 칸 사이 탭(엑셀에 붙이면 칸이 나뉨),
//   링크 카드는 주소, 사진·소리·동영상은 빼고, 가로줄은 "———".
// 서식 있는 곳(워드·메모킹)에는 함께 들어가는 HTML 이 쓰인다.

const isBreak = (node) => node.type.name === 'hardbreak' || node.type.name === 'hard_break'
  || (node.type.name === 'html' && /^<br\s*\/?>$/i.test(String(node.attrs.value ?? '').trim()));

// 한 줄(글 덩어리) 안의 글
function inlineText(node, breakAs = '\n') {
  let s = '';
  node.forEach((child) => {
    if (child.isText) s += child.text;
    else if (isBreak(child)) s += breakAs;
    else if (child.type.name === 'html') s += ''; // 그 밖의 HTML 조각(밑줄·색 표시 등)은 글이 아니다
    else if (child.isInline && child.content.size) s += inlineText(child, breakAs);
  });
  return s;
}

/**
 * @param {import('prosemirror-model').Fragment} fragment 복사한 조각(slice.content)
 * @returns {string}
 */
export function plainTextOf(fragment) {
  const lines = [];
  let run = ''; // 문단 일부만 고른 경우처럼 글이 맨 바깥에 바로 있을 때
  const flush = () => {
    if (run) lines.push(run);
    run = '';
  };

  function block(node, indent = '') {
    const name = node.type.name;
    if (name === 'code_block') {
      lines.push(...node.textContent.split('\n').map((l) => indent + l));
      return;
    }
    if (node.isTextblock) {
      lines.push(...inlineText(node).split('\n').map((l, i) => (i === 0 ? indent : indent.replace(/\S/g, ' ')) + l));
      return;
    }
    if (name === 'bullet_list' || name === 'ordered_list') {
      let n = Number(node.attrs.order ?? 1) || 1;
      node.forEach((item) => {
        const checked = item.attrs?.checked;
        const mark = checked === true ? '☑ ' : checked === false ? '☐ ' : name === 'ordered_list' ? `${n}. ` : '• ';
        n++;
        let first = true;
        item.forEach((child) => {
          if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') block(child, `${indent}  `);
          else {
            block(child, first ? indent + mark : indent + ' '.repeat(mark.length));
            first = false;
          }
        });
      });
      return;
    }
    if (name === 'table') {
      node.forEach((row) => {
        const cells = [];
        row.forEach((cell) => {
          const parts = [];
          cell.forEach((b) => parts.push(inlineText(b, ' ')));
          cells.push(parts.join(' ').replace(/\t/g, ' ').trim());
        });
        lines.push(indent + cells.join('\t'));
      });
      return;
    }
    if (name === 'hr') {
      lines.push(`${indent}———`);
      return;
    }
    if (name === 'mk_link_card') {
      lines.push(indent + (node.attrs.href || node.attrs.title || ''));
      return;
    }
    if (node.isLeaf) return; // 사진·소리·동영상 등
    node.forEach((child) => block(child, indent)); // 인용·표 칸 등은 안의 글만
  }

  fragment.forEach((node) => {
    if (node.isInline) {
      if (node.isText) run += node.text;
      else if (isBreak(node)) {
        lines.push(run);
        run = '';
      } else if (node.content.size) run += inlineText(node);
      return;
    }
    flush();
    block(node);
  });
  flush();
  return lines.join('\n');
}
