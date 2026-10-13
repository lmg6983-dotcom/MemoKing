// 복사할 때 클립보드의 "일반 글자"(text/plain) — 메모장·카톡처럼 서식 없는 곳에 붙일 글.
// Milkdown 은 여기에 마크다운 원문을 넣어 \* · 1\. · \[ 같은 이스케이프(\)가 섞여 붙는다. 사람이 읽는 글로 바꾼다:
//   문단·제목은 한 줄씩, 칸 안 줄바꿈은 줄바꿈, 목록은 "• " · "1. " · "☐ "/"☑ ", 표는 칸 사이 탭(엑셀에 붙이면 칸이 나뉨),
//   링크 카드는 주소, 사진·소리·동영상은 빼고, 가로줄은 "———".
//   목록 항목을 일부만 끌어 골라 복사하면 체크 네모·글머리 없이 글만.
//   줄 앞 띄어쓰기(편집기에서는 U+00A0 로 지킨다 — core/indent-spaces.js)는 보통 띄어쓰기로.
// 서식 있는 곳(워드·메모킹)에는 함께 들어가는 HTML 이 쓰인다.
import { plainSpaces, htmlSpaces } from './core/indent-spaces.js';

const isBreak = (node) => node.type.name === 'hardbreak' || node.type.name === 'hard_break'
  || (node.type.name === 'html' && /^<br\s*\/?>$/i.test(String(node.attrs.value ?? '').trim()));

// 한 줄(글 덩어리) 안의 글
function inlineText(node, breakAs = '\n') {
  let s = '';
  node.forEach((child) => {
    if (child.isText) s += child.text;
    else if (isBreak(child)) s += breakAs;
    else if (child.type.name === 'math_inline') s += `$${child.attrs.value}$`;
    else if (child.type.name === 'html') s += ''; // 그 밖의 HTML 조각(밑줄·색 표시 등)은 글이 아니다
    else if (child.isInline && child.content.size) s += inlineText(child, breakAs);
  });
  return s;
}

// 고른 범위가 목록 항목의 중간에서 시작하거나 끝나는가 (slice 의 열린 가장자리에 항목이 있는가)
function cutsIntoItem(fragment, open, side) {
  let node = side === 'start' ? fragment.firstChild : fragment.lastChild;
  for (let d = 0; d < open && node; d++) {
    if (node.type.name === 'list_item') return true;
    node = side === 'start' ? node.firstChild : node.lastChild;
  }
  return false;
}

/**
 * @param {import('prosemirror-model').Fragment} fragment 복사한 조각(slice.content)
 * @param {{ openStart?: number, openEnd?: number }} [open] slice 의 열린 깊이 — 목록 항목을 일부만 골랐으면
 *   체크 네모(☐/☑)·글머리(• 1.) 없이 글만 (Ctrl+A 처럼 통째로 복사할 때만 목록 모양을 붙인다)
 * @returns {string}
 */
export function plainTextOf(fragment, { openStart = 0, openEnd = 0 } = {}) {
  const partial = cutsIntoItem(fragment, openStart, 'start') || cutsIntoItem(fragment, openEnd, 'end');
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
        const mark = partial ? '' : checked === true ? '☑ ' : checked === false ? '☐ ' : name === 'ordered_list' ? `${n}. ` : '• ';
        n++;
        let first = true;
        item.forEach((child) => {
          if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') block(child, partial ? indent : `${indent}  `);
          else {
            block(child, first ? indent + mark : indent + ' '.repeat(mark.length));
            first = false;
          }
        });
      });
      return;
    }
    // 표 · 칸 몇 개만 고른 것(행들): 행마다 한 줄, 칸 사이는 탭
    const row = (r) => {
      const cells = [];
      r.forEach((cell) => {
        const parts = [];
        cell.forEach((b) => parts.push(inlineText(b, ' ')));
        cells.push(parts.join(' ').replace(/\t/g, ' ').trim());
      });
      lines.push(indent + cells.join('\t'));
    };
    if (name === 'table') {
      node.forEach(row);
      return;
    }
    if (name === 'table_row' || name === 'table_header_row') {
      row(node);
      return;
    }
    if (name === 'hr') {
      lines.push(`${indent}———`);
      return;
    }
    if (name === 'math_block') {
      lines.push(...String(node.attrs.value ?? '').split('\n').map((l) => indent + l));
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
  return plainSpaces(lines.join('\n'));
}

/** 복사한 HTML: 글 속 겹친 빈칸을 U+00A0 로 (코드는 그대로) — 워드 · 메일이 빈칸을 하나로 줄이지 않게 */
export function spacedHtml(html) {
  const box = document.createElement('template');
  box.innerHTML = html;
  const walk = document.createTreeWalker(box.content, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (/ {2}/.test(t.data) && !t.parentElement?.closest('pre, code')) t.data = htmlSpaces(t.data);
  }
  return box.innerHTML;
}
