// 조용한 다듬기 (편집기 플러그인, 데스크탑·휴대폰 함께) — 타자 실수를 불쾌하지 않게 고친다
//   원칙 (자동 고침이 거슬리지 않게):
//     1) 쓰고 있는 줄은 건드리지 않는다 — 커서가 그 줄을 떠날 때 고친다 (쓰는 중에 글자가 움직이지 않게)
//     2) 뜻이 바뀌지 않는 것만: 띄어쓰기·빈 줄·보이지 않는 글자. 낱말·맞춤법은 고치지 않는다
//     3) 코드(코드 블록·인라인 코드)는 그대로, 한글 조합(IME) 중에는 아무것도 하지 않는다
//     4) 되돌리기 기록에 남기지 않는다 (되돌리기를 누르면 내가 쓴 것이 돌아온다)
//   고치는 것:
//     - 겹친 띄어쓰기 "가  나" → "가 나", 줄 앞뒤의 띄어쓰기
//     - 한글 뒤 문장부호 앞 띄어쓰기 "합니다 ." → "합니다."
//     - 겹친 쉼표 ",," → ","
//     - 붙여넣기에 묻어 온 보이지 않는 글자(폭 없는 공백·BOM)와 줄바꿈 없는 공백(NBSP)
//     - 의미 없는 빈 줄: 빈 줄이 둘 이상 이어지면 하나로, 문서 맨 앞의 빈 줄
//     - 같은 종류인데 갈라진 목록: 바로 붙어 있는 같은 목록(점·번호·체크리스트)은 하나로 합친다
//       (한 항목만 다른 목록으로 바꿨다 되돌리면 겉보기엔 한 목록인데 따로 노는 문제)
import { Plugin, PluginKey } from '../vendor/milkdown.js';
import { tidyText, INVISIBLE } from './tidy-text.js';

export const tidyKey = new PluginKey('memoking-tidy');
const LISTS = new Set(['bullet_list', 'ordered_list']);
const ODD_SPACE = /[\u200B\uFEFF\u2060\u00A0]/;
const EMPTY_OK = new Set(['doc', 'blockquote']); // 빈 줄을 줄여도 되는 상자 (목록 항목·표 칸은 빈 줄이 있어야 함)

const isCodeBlock = (node) => node.type.name === 'code_block' || node.type.spec.code;
const hasCode = (node) => node.marks.some((m) => m.type.name === 'inlineCode' || m.type.spec.code);
const isTaskList = (list) => list.firstChild?.attrs?.checked != null;

/** 글 블록 하나를 다듬는 고침들 (뒤에서부터 적용할 수 있게 위치 큰 것부터) */
function blockEdits(block, pos) {
  if (!block.isTextblock || isCodeBlock(block)) return [];
  const edits = [];
  const kids = [];
  block.forEach((child, offset) => kids.push({ child, at: pos + 1 + offset }));
  kids.forEach(({ child, at }, i) => {
    if (!child.isText || hasCode(child)) return;
    const prev = kids[i - 1]?.child;
    const next = kids[i + 1]?.child;
    let text = child.text;
    const atStart = i === 0 || Boolean(prev && !prev.isText && prev.type.name.includes('break'));
    const atEnd = i === kids.length - 1 || Boolean(next && !next.isText && next.type.name.includes('break'));
    // 앞 글 조각이 띄어쓰기로 끝나면 이 조각 앞의 띄어쓰기는 겹친 것
    let lead = 0;
    if (prev?.isText && !hasCode(prev) && /[ \u00A0]$/.test(prev.text)) lead = text.match(/^[ \u00A0]+/)?.[0].length ?? 0;
    text = text.slice(lead);
    const fixed = tidyText(text, { atStart, atEnd });
    if (lead || fixed !== text) edits.push({ from: at, to: at + child.nodeSize, text: fixed, marks: child.marks });
  });
  return edits.reverse();
}

function applyBlock(tr, pos) {
  const block = tr.doc.nodeAt(pos);
  if (!block) return;
  for (const e of blockEdits(block, pos)) {
    if (e.text) tr.replaceWith(e.from, e.to, tr.doc.type.schema.text(e.text, e.marks));
    else tr.delete(e.from, e.to);
  }
}

// 바로 붙은 같은 목록 합치기 · 겹친 빈 줄 줄이기 (커서가 든 곳은 빼고)
function structureFixes(tr, cursor) {
  const joins = [];
  const drops = [];
  const visit = (node, inner) => {
    let prev = null;
    let empties = [];
    const canDrop = EMPTY_OK.has(node.type.name);
    const flush = () => {
      // 빈 줄이 둘 이상이면 첫 하나만 남긴다 (커서가 든 빈 줄이 있으면 그 무리는 그대로)
      if (empties.length >= 2 && !empties.some((e) => cursor >= e.pos && cursor <= e.pos + e.size)) drops.push(...empties.slice(1));
      empties = [];
    };
    node.forEach((child, offset) => {
      const at = inner + offset;
      if (prev && LISTS.has(child.type.name) && child.type === prev.type && isTaskList(child) === isTaskList(prev)) joins.push(at);
      if (canDrop && child.type.name === 'paragraph' && child.content.size === 0) empties.push({ pos: at, size: child.nodeSize });
      else flush();
      prev = child;
      if (!child.isTextblock && !child.isAtom && child.childCount) visit(child, at + 1);
    });
    flush();
  };
  visit(tr.doc, 0);
  // 문서 맨 앞 빈 줄 (뒤에 내용이 있고 커서가 거기 없으면)
  const first = tr.doc.firstChild;
  if (first?.type.name === 'paragraph' && first.content.size === 0 && tr.doc.childCount > 1 && cursor > first.nodeSize && !drops.some((d) => d.pos === 0)) drops.push({ pos: 0, size: first.nodeSize });
  // 뒤에서부터 (위치가 어긋나지 않게)
  const ops = [...joins.map((at) => ({ at, kind: 'join' })), ...drops.map((d) => ({ at: d.pos, size: d.size, kind: 'drop' }))].sort((x, y) => y.at - x.at);
  for (const op of ops) {
    try {
      if (op.kind === 'join') tr.join(op.at);
      else tr.delete(op.at, op.at + op.size);
    } catch {
      // 합칠 수 없는 자리
    }
  }
}

export function createTidy({ readOnly = false } = {}) {
  let composing = false;
  return new Plugin({
    key: tidyKey,
    props: {
      handleDOMEvents: {
        compositionstart: () => {
          composing = true;
          return false;
        },
        compositionend: () => {
          composing = false;
          return false;
        },
      },
    },
    appendTransaction(trs, oldState, state) {
      if (readOnly || composing) return null;
      try {
        return tidyAfter(trs, oldState, state);
      } catch (err) {
        console.warn('다듬기 건너뜀', err); // 다듬기가 잘못돼도 글쓰기는 막지 않는다
        return null;
      }
    },
  });
}

/** 커서가 떠난 글 블록의 지금 위치 (없으면 null) */
function leftBlock(trs, oldState, state) {
  const $old = oldState.selection.$from;
  const $now = state.selection.$from;
  if (!$old.parent.isTextblock || $old.depth < 1) return null;
  let p = $old.before();
  for (const t of trs) {
    const r = t.mapping.mapResult(p, 1);
    if (r.deleted) return null;
    p = r.pos;
  }
  const nowBlock = $now.parent.isTextblock && $now.depth >= 1 ? $now.before() : -1;
  return p !== nowBlock && state.doc.nodeAt(p)?.isTextblock ? p : null;
}

export function tidyAfter(trs, oldState, state) {
  if (trs.some((t) => t.getMeta(tidyKey))) return null;
  const docChanged = trs.some((t) => t.docChanged);
  const left = leftBlock(trs, oldState, state);
  if (left == null && !docChanged) return null;
  const tr = state.tr;
  if (left != null) applyBlock(tr, left);
  if (trs.some((t) => t.getMeta('uiEvent') === 'paste')) {
    // 붙여넣은 글의 보이지 않는 글자·NBSP (커서 줄 빼고 모두)
    const $now = tr.selection.$from;
    const cursorBlock = $now.depth >= 1 ? $now.before() : -1;
    const blocks = [];
    tr.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (pos !== cursorBlock && ODD_SPACE.test(node.textContent)) blocks.push(pos);
      return false;
    });
    for (const pos of blocks.reverse()) applyBlock(tr, pos);
  }
  structureFixes(tr, tr.selection.from);
  if (!tr.docChanged) return null;
  return tr.setMeta(tidyKey, true).setMeta('addToHistory', false);
}
