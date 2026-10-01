// 밑줄·글자 색·하이라이트 — 마크다운에 없는 서식이라 표준 인라인 HTML 로 저장한다.
//   <u>글자</u>
//   <span style="color: #e03131">글자</span>
//   <mark>글자</mark>  (노랑)  /  <mark style="background: #b2f2bb">글자</mark>
// 마크다운 파서(remark)는 이 태그들을 여는 태그·닫는 태그 조각으로 따로 읽으므로,
// 짝을 찾아 하나의 서식 노드로 묶는다. 저장할 때는 다시 태그로 쓴다.

export const TEXT_COLORS = [
  { name: '빨강', value: '#e03131' },
  { name: '주황', value: '#f08c00' },
  { name: '초록', value: '#2f9e44' },
  { name: '파랑', value: '#1971c2' },
  { name: '보라', value: '#9c36b5' },
  { name: '회색', value: '#868e96' },
];

export const HIGHLIGHT_COLORS = [
  { name: '노랑', value: '#ffec99' },
  { name: '초록', value: '#b2f2bb' },
  { name: '파랑', value: '#a5d8ff' },
  { name: '분홍', value: '#fcc2d7' },
  { name: '주황', value: '#ffd8a8' },
  { name: '보라', value: '#d0bfff' },
];

// 색 없이 <mark> 만 쓰면 노랑 (Obsidian 등 다른 앱의 기본 하이라이트와 같게)
export const DEFAULT_HIGHLIGHT = HIGHLIGHT_COLORS[0].value;

// 파일에서 읽은 색 값은 이 형식만 허용한다 (스타일 주입 방지)
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.\s,%]+\))$/i;
export const safeColor = (value) => {
  const v = String(value ?? '').trim();
  return COLOR.test(v) ? v.toLowerCase() : null;
};

const OPEN_TAGS = [
  { re: /^<u\s*>$/i, type: 'mkUnderline', tag: 'u' },
  { re: /^<mark\s*>$/i, type: 'mkHighlight', tag: 'mark', color: () => DEFAULT_HIGHLIGHT },
  { re: /^<mark\s+style\s*=\s*(["'])\s*background(?:-color)?\s*:\s*([^;"']+?)\s*;?\s*\1\s*>$/i, type: 'mkHighlight', tag: 'mark', color: (m) => m[2] },
  { re: /^<span\s+style\s*=\s*(["'])\s*color\s*:\s*([^;"']+?)\s*;?\s*\1\s*>$/i, type: 'mkColor', tag: 'span', color: (m) => m[2] },
];

export function parseOpenTag(html) {
  const text = String(html).trim();
  for (const def of OPEN_TAGS) {
    const m = def.re.exec(text);
    if (!m) continue;
    if (!def.color) return { type: def.type, tag: def.tag };
    const color = safeColor(def.color(m));
    if (color) return { type: def.type, tag: def.tag, color };
  }
  return null;
}

const isCloseTag = (html, tag) => new RegExp(`^</${tag}\\s*>$`, 'i').test(String(html).trim());

function findClose(children, start, tag) {
  let depth = 0;
  for (let j = start; j < children.length; j++) {
    const c = children[j];
    if (c.type !== 'html') continue;
    if (parseOpenTag(c.value)?.tag === tag) depth++;
    else if (isCloseTag(c.value, tag)) {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

function groupChildren(children) {
  const out = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const open = child.type === 'html' ? parseOpenTag(child.value) : null;
    const close = open ? findClose(children, i + 1, open.tag) : -1;
    if (close === -1) {
      out.push(child);
      continue;
    }
    const node = { type: open.type, children: groupChildren(children.slice(i + 1, close)) };
    if (open.color) node.color = open.color;
    out.push(node);
    i = close;
  }
  return out;
}

// mdast 트리를 제자리에서 바꾼다. 짝이 없는 태그는 건드리지 않는다.
export function transformInlineHtml(tree) {
  const walk = (node) => {
    if (!Array.isArray(node.children)) return;
    node.children = groupChildren(node.children);
    node.children.forEach(walk);
  };
  walk(tree);
  return tree;
}

// remark 플러그인 형태
export function remarkInlineHtmlMarks() {
  return (tree) => {
    transformInlineHtml(tree);
  };
}

export function openTag(node) {
  if (node.type === 'mkUnderline') return '<u>';
  if (node.type === 'mkHighlight') {
    const color = safeColor(node.color);
    return !color || color === DEFAULT_HIGHLIGHT ? '<mark>' : `<mark style="background: ${color}">`;
  }
  return `<span style="color: ${safeColor(node.color) ?? 'inherit'}">`;
}

export function closeTag(node) {
  return { mkUnderline: '</u>', mkHighlight: '</mark>' }[node.type] ?? '</span>';
}

// remark-stringify(mdast-util-to-markdown) 용 저장 함수
function handler(node, _parent, state, info) {
  const tracker = state.createTracker(info);
  let value = tracker.move(openTag(node));
  value += tracker.move(state.containerPhrasing(node, { before: value, after: '<', ...tracker.current() }));
  value += tracker.move(closeTag(node));
  return value;
}

export const stringifyHandlers = { mkUnderline: handler, mkHighlight: handler, mkColor: handler };
