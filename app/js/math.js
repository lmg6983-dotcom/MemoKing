// 수식 (KaTeX) — 파일에는 마크다운 수식 그대로: 글 가운데 $$x^2$$ · 따로 한 줄은
//   $$
//   \int_0^1 x\,dx
//   $$
// 달러 하나($5)는 돈 표시와 겹치므로 수식으로 보지 않는다(파일의 $ 가 \$ 로 바뀌지 않게). 칠 때는 $x^2$ 처럼
// 달러 하나로 감싸도 수식이 된다(앞뒤에 띄어쓰기가 없을 때만, 저장은 $$x^2$$).
// 그리기(KaTeX, 265KB)는 수식이 처음 보일 때 불러온다.
import { $nodeSchema, $remark, $prose, $view, remarkMath, InputRule, inputRules, TextSelection } from '../vendor/milkdown.js';

let katexLoad = null;
function loadKatex() {
  if (!katexLoad) {
    const href = new URL('../vendor/katex/katex.css', import.meta.url).href;
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.append(link);
    }
    katexLoad = import('../vendor/katex.js').then((m) => m.default).catch((err) => {
      console.warn('수식 그리기를 불러오지 못했어요', err);
      katexLoad = null;
      return null;
    });
  }
  return katexLoad;
}

/** 수식 하나를 그린다 (틀린 수식은 빨간 글자로, 예외 없이) */
export async function renderMath(target, value, displayMode) {
  const tex = String(value ?? '').trim();
  target.classList.toggle('empty', !tex);
  if (!tex) {
    target.textContent = displayMode ? '수식 블록 — 눌러서 쓰기' : '수식';
    return;
  }
  target.textContent = tex; // 불러오는 동안은 글자 그대로
  const katex = await loadKatex();
  if (!katex) return;
  try {
    target.innerHTML = katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
  } catch {
    target.textContent = tex;
  }
}

export const mathRemark = $remark('memoking-math', () => remarkMath, { singleDollarTextMath: false });

export const mathInlineSchema = $nodeSchema('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { value: { default: '' } },
  parseDOM: [{ tag: 'span[data-math-inline]', getAttrs: (dom) => ({ value: dom.dataset.mathInline ?? dom.textContent ?? '' }) }],
  toDOM: (node) => ['span', { 'data-math-inline': node.attrs.value, class: 'mk-math' }, node.attrs.value],
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value ?? '' });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.attrs.value);
    },
  },
}));

export const mathBlockSchema = $nodeSchema('math_block', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { value: { default: '' } },
  parseDOM: [{ tag: 'div[data-math-block]', getAttrs: (dom) => ({ value: dom.dataset.mathBlock ?? dom.textContent ?? '' }) }],
  toDOM: (node) => ['div', { 'data-math-block': node.attrs.value, class: 'mk-math-block' }, node.attrs.value],
  parseMarkdown: {
    match: (node) => node.type === 'math',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value ?? '' });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_block',
    runner: (state, node) => {
      state.addNode('math', undefined, node.attrs.value);
    },
  },
}));

// ---------- 고치기: 수식을 누르면 아래에 작은 편집 창 (쓰는 대로 미리 보기) ----------

let editorBox = null;
function closeEditor(commit = true) {
  if (!editorBox) return;
  const box = editorBox;
  editorBox = null;
  box.finish(commit);
  box.el.remove();
}

function openEditor(view, getPos, node, anchor) {
  closeEditor();
  const display = node.type.name === 'math_block';
  const el = document.createElement('div');
  el.className = 'mk-math-editor';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '수식 고치기');
  const input = document.createElement('textarea');
  input.value = node.attrs.value;
  input.rows = display ? 3 : 1;
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  input.placeholder = display ? '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}' : 'x^2 + y^2 = r^2';
  const preview = document.createElement('div');
  preview.className = 'mk-math-preview';
  const actions = document.createElement('div');
  actions.className = 'mk-math-actions';
  const hint = document.createElement('span');
  hint.textContent = 'LaTeX · Enter 완료';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '삭제';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'primary';
  done.textContent = '완료';
  actions.append(hint, remove, done);
  el.append(input, preview, actions);
  document.body.append(el);

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(360, window.innerWidth - 16);
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const below = r.bottom + 6;
    const h = el.offsetHeight;
    el.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below}px`;
  };
  const refresh = () => renderMath(preview, input.value, display).then(place);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor(false);
      view.focus();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      closeEditor(true);
    }
  });
  remove.addEventListener('mousedown', (e) => e.preventDefault());
  remove.addEventListener('click', () => {
    input.value = '';
    closeEditor(true);
  });
  done.addEventListener('mousedown', (e) => e.preventDefault());
  done.addEventListener('click', () => closeEditor(true));

  editorBox = {
    el,
    finish(commit) {
      document.removeEventListener('pointerdown', outside, true);
      if (!commit || view.isDestroyed) return;
      const pos = getPos?.();
      const at = pos == null ? null : view.state.doc.nodeAt(pos);
      if (!at || at.type !== node.type) return;
      const value = input.value.trim();
      let tr = view.state.tr;
      if (!value) tr = tr.delete(pos, pos + at.nodeSize);
      else if (value !== at.attrs.value) tr = tr.setNodeMarkup(pos, undefined, { ...at.attrs, value });
      else return view.focus();
      // 다 쓰면 수식 바로 뒤에서 이어 쓰기
      const after = Math.min(tr.mapping.map(pos + (value ? at.nodeSize : 0)), tr.doc.content.size);
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after)));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
  };
  const outside = (e) => {
    if (!el.contains(e.target)) closeEditor(true);
  };
  document.addEventListener('pointerdown', outside, true);
  refresh();
  place();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function mathView(node, view, getPos, readOnly) {
  const display = node.type.name === 'math_block';
  const dom = document.createElement(display ? 'div' : 'span');
  dom.className = display ? 'mk-math-block' : 'mk-math';
  dom.contentEditable = 'false';
  let current = node;
  const draw = () => {
    dom.title = readOnly ? '' : '눌러서 수식 고치기';
    renderMath(dom, current.attrs.value, display);
  };
  draw();
  dom.addEventListener('click', (e) => {
    if (readOnly || !view.editable) return;
    e.preventDefault();
    openEditor(view, getPos, current, dom);
  });
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      const changed = next.attrs.value !== current.attrs.value;
      current = next;
      if (changed) draw();
      return true;
    },
    selectNode: () => dom.classList.add('selected'),
    deselectNode: () => dom.classList.remove('selected'),
    // 누르기·끌기는 편집기로 보내 줄 옮기기가 받게 (그냥 누르면 click 으로 고치기 창)
    stopEvent: (e) => e.type === 'click' && !readOnly,
    ignoreMutation: () => true,
  };
}

export const mathInlineView = (readOnly) => $view(mathInlineSchema.node, () => (node, view, getPos) => mathView(node, view, getPos, readOnly));
export const mathBlockView = (readOnly) => $view(mathBlockSchema.node, () => (node, view, getPos) => mathView(node, view, getPos, readOnly));

// ---------- 치면서 만들기 ----------
//   $x^2$ 또는 $$x^2$$ (글 가운데) → 수식,  빈 줄에 $$ 치고 띄어쓰기·Enter → 수식 블록(바로 고치기 창)
const INLINE_RULE = /(?:^|[^$\\\w])(\${1,2})([^\s$](?:[^$]*[^\s$])?)\1$/;

export const mathInputRules = $prose(() => inputRules({
  rules: [
    new InputRule(INLINE_RULE, (state, match, start, end) => {
      const type = state.schema.nodes.math_inline;
      if (!type || state.selection.$from.parent.type.spec.code) return null;
      const [whole, , value] = match;
      // 마지막 $ 는 아직 문서에 없다 (막 친 글자) — 수식 시작 자리부터 바꾼다
      const from = start + whole.indexOf('$');
      if (/^\d+([.,]\d+)?$/.test(value)) return null; // $5$ 같은 돈 표시는 그대로
      return state.tr.replaceWith(from, end, type.create({ value }));
    }),
    new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
      const type = state.schema.nodes.math_block;
      const $start = state.doc.resolve(start);
      if (!type || $start.parent.type.name !== 'paragraph' || $start.parent.content.size !== end - start) return null;
      if (!blockFits($start, $start.depth, type, true)) return null; // 표 칸 안은 그대로 글자로 (표가 둘로 쪼개지지 않게)
      return state.tr.replaceRangeWith($start.before(), $start.after(), type.create({ value: '' }));
    }),
  ],
}));

/** 편집기에 붙일 플러그인들 */
export function mathPlugins({ readOnly = false } = {}) {
  return [mathRemark, mathInlineSchema, mathBlockSchema, mathInlineView(readOnly), mathBlockView(readOnly), mathInputRules].flat();
}

// depth 의 줄 자리(replace: 그 줄 대신, 아니면 그 줄 바로 뒤)에 수식 블록이 들어갈 수 있나 — 표 칸에는 글 줄만 들어간다
function blockFits($pos, depth, type, replace) {
  const parent = $pos.node(depth - 1);
  const index = $pos.index(depth - 1);
  return replace ? parent.canReplaceWith(index, index + 1, type) : parent.canReplaceWith(index + 1, index + 1, type);
}

/** 빈 수식 블록을 넣고 바로 고치기 창을 연다 (도구막대 · 스타일 메뉴) */
export function insertMathBlock(view) {
  const type = view.state.schema.nodes.math_block;
  if (!type) return;
  const { $from } = view.state.selection;
  const node = type.create({ value: '' });
  let tr;
  let pos;
  if ($from.parent.type.name === 'paragraph' && $from.parent.content.size === 0 && $from.depth > 0 && blockFits($from, $from.depth, type, true)) {
    pos = $from.before();
    tr = view.state.tr.replaceWith(pos, $from.after(), node);
  } else {
    // 지금 줄 뒤, 그 자리에 못 들어가면(표 칸 안) 들어갈 수 있는 바깥 블록 뒤 (표 바로 아래)
    let depth = $from.depth;
    while (depth > 1 && !blockFits($from, depth, type, false)) depth--;
    pos = depth > 0 ? $from.after(depth) : $from.pos;
    tr = view.state.tr.insert(pos, node);
  }
  view.dispatch(tr.scrollIntoView());
  requestAnimationFrame(() => {
    const dom = view.nodeDOM(pos);
    const at = view.state.doc.nodeAt(pos);
    if (dom && at?.type === type) openEditor(view, () => pos, at, dom);
  });
}
