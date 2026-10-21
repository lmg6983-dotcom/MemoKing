// 메모 안 찾기 · 바꾸기 (편집기 쪽) — 찾은 자리를 노랗게, 지금 자리는 진하게 보이고, 하나씩 · 모두 바꾼다
//   찾기 규칙은 core/find.js. 찾기 막대(find-bar.js)가 이 함수들을 부른다. PC 메모 창 · 휴대폰이 함께 쓴다.
//   문단(글 줄 칸)마다 찾는다 — 찾을 말이 문단을 넘어가지는 않는다. 그림 · 파일 같은 칸은 한 글자(￼)로 쳐서 그 너머로 잇지 않는다
//   서식 찾기: 찾은 글자가 모두 그 서식이어야 (찾을 말 없이 서식만이면 그 서식이 붙은 글자 덩어리를 찾는다)
//   서식 바꾸기: 바꾼 글에 서식을 붙인다 (바꿀 말이 비어 있으면 글은 그대로 두고 서식만 — 워드처럼)
import { Plugin, PluginKey, TextSelection, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { findInText, stepMatch, hasFormat, rangeMatches, formatRuns, snippet, FORMAT_FLAGS, FORMAT_COLORS } from './core/find.js';

export const findKey = new PluginKey('mk-find');

/** 문서에서 찾은 자리들 [{ from, to }] (문서 순서) */
export function findMatches(doc, query, opts = {}) {
  const out = [];
  const format = hasFormat(opts.format) ? opts.format : null;
  if (!query && !format) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const segs = []; // 글자 조각마다 서식 (서식 찾기)
    node.forEach((child) => {
      const start = text.length;
      text += child.isText ? child.text : '￼'.repeat(child.nodeSize);
      segs.push({ start, end: text.length, text: child.isText, marks: child.marks.map((m) => ({ name: m.type.name, color: m.attrs.color })) });
    });
    const start = pos + 1;
    const found = query ? findInText(text, query, opts).filter(([a, b]) => rangeMatches(segs, a, b, format)) : formatRuns(segs, format);
    for (const [a, b] of found) out.push({ from: start + a, to: start + b });
    return false;
  });
  return out;
}

/** 바꾼 자리 [from, to) 에 바꿀 서식을 붙인다 (clear 면 원래 서식을 먼저 지운다) */
function applyFormat(tr, from, to, f, schema) {
  if (!hasFormat(f) || to <= from) return tr;
  if (f.clear) tr.removeMark(from, to);
  for (const k of FORMAT_FLAGS) {
    const type = schema.marks[k.mark];
    if (f[k.key] && type) tr.addMark(from, to, type.create());
  }
  for (const k of FORMAT_COLORS) {
    const type = schema.marks[k.mark];
    const v = f[k.key];
    if (v && v !== 'any' && type) tr.addMark(from, to, type.create({ color: v }));
  }
  return tr;
}

/** 바꾸기 한 번: 바꿀 말로 (서식을 붙여) · 바꿀 말이 비면 서식만 · 둘 다 없으면 지우기 → 바꾼 뒤 끝 자리 */
function replaceAt(tr, m, text, f, schema) {
  if (text) {
    tr.insertText(text, m.from, m.to);
    applyFormat(tr, m.from, m.from + text.length, f, schema);
    return m.from + text.length;
  }
  if (hasFormat(f)) {
    applyFormat(tr, m.from, m.to, f, schema);
    return m.to;
  }
  tr.delete(m.from, m.to);
  return m.from;
}

/** 찾기 표시 플러그인: 상태 { query, opts, matches, current } — 글이 바뀌면 다시 찾고, 지금 자리는 가장 가까운 것으로 */
export function createFindPlugin() {
  return new Plugin({
    key: findKey,
    state: {
      init: () => ({ query: '', opts: {}, matches: [], current: -1 }),
      apply(tr, prev) {
        const meta = tr.getMeta(findKey);
        if (meta) {
          const query = meta.query ?? prev.query;
          const opts = meta.opts ?? prev.opts;
          const matches = findMatches(tr.doc, query, opts);
          const current = meta.current ?? (matches.length ? Math.max(0, stepMatch(matches, tr.selection.from, 1)) : -1);
          return { query, opts, matches, current: Math.min(current, matches.length - 1) };
        }
        if (!tr.docChanged || !(prev.query || hasFormat(prev.opts.format))) return prev;
        const matches = findMatches(tr.doc, prev.query, prev.opts);
        const at = prev.current >= 0 ? tr.mapping.map(prev.matches[prev.current]?.from ?? 0) : tr.selection.from;
        return { ...prev, matches, current: matches.length ? stepMatch(matches, at, 1) : -1 };
      },
    },
    props: {
      decorations(state) {
        const f = findKey.getState(state);
        if (!f?.matches.length) return null;
        return DecorationSet.create(state.doc, f.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === f.current ? 'mk-find-hit mk-find-current' : 'mk-find-hit' })));
      },
    },
  });
}

/** 편집기(view)로 찾기 · 바꾸기 — find-bar.js 가 쓴다 */
export function findController(view) {
  const state = () => findKey.getState(view().state) ?? { query: '', matches: [], current: -1 };
  let lastAll = null; // 마지막 모두 바꾸기 (되돌리기 단추)
  // 지금 자리를 보이게: 고른 글로 두고(편집기에 포커스를 주지 않아도) 화면을 그곳으로
  const reveal = (tr, m) => {
    if (m) tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
    return tr;
  };
  return {
    state,
    /** 찾을 말 · 방법을 바꾼다 (지금 커서 다음의 첫 자리로) */
    set(query, opts) {
      const v = view();
      const tr = v.state.tr.setMeta(findKey, { query, opts });
      v.dispatch(tr);
      const f = state();
      if (f.current >= 0) v.dispatch(reveal(v.state.tr, f.matches[f.current]));
      return state();
    },
    /** 다음(1) · 이전(-1) 자리로 — 끝에서는 처음으로 */
    step(dir) {
      const v = view();
      const f = state();
      if (!f.matches.length) return f;
      const cur = f.matches[f.current];
      const pos = cur ? (dir > 0 ? cur.from + 1 : cur.from) : v.state.selection.from;
      const i = stepMatch(f.matches, pos, dir);
      v.dispatch(reveal(v.state.tr.setMeta(findKey, { current: i }), f.matches[i]));
      return state();
    },
    /** 지금 자리 하나를 바꾸고(fmt: 바꿀 서식) 다음으로 → 바꿨으면 true */
    replace(text, fmt) {
      const v = view();
      const f = state();
      const m = f.matches[f.current];
      if (!m || !v.editable) return false;
      const tr = v.state.tr;
      const end = replaceAt(tr, m, text, fmt, v.state.schema);
      v.dispatch(tr);
      // 바꾼 글 바로 뒤에서 다음 자리 (바꾼 글 안에서 다시 찾지 않게)
      const after = end;
      const next = state();
      const i = next.matches.length ? stepMatch(next.matches, after, 1) : -1;
      v.dispatch(reveal(v.state.tr.setMeta(findKey, { current: i }), next.matches[i]));
      return true;
    },
    /** 모두 바꾸기 → 바꾼 개수 (한 번에 되돌릴 수 있게 한 번의 고침으로) */
    replaceAll(text, fmt) {
      const v = view();
      const f = state();
      if (!f.matches.length || !v.editable) return 0;
      const tr = v.state.tr;
      for (const m of [...f.matches].reverse()) replaceAt(tr, m, text, fmt, v.state.schema); // 뒤에서부터 (앞 자리가 밀리지 않게)
      v.dispatch(tr);
      lastAll = tr;
      return f.matches.length;
    },
    /** 방금 한 모두 바꾸기 되돌리기 (휴대폰 알림의 되돌리기 단추 — Ctrl+Z 가 없으니) → 되돌렸으면 true
     *  그 뒤로 글을 고쳤으면 되돌리지 않는다 (고친 것까지 엉키지 않게) */
    undoAll() {
      const v = view();
      const done = lastAll;
      lastAll = null;
      if (!done || !v.state.doc.eq(done.doc)) return false;
      const tr = v.state.tr;
      for (let i = done.steps.length - 1; i >= 0; i--) tr.step(done.steps[i].invert(done.docs[i]));
      v.dispatch(tr);
      return true;
    },
    /** i 번째 찾은 곳으로 (모두 찾기 목록에서 고름) */
    go(i) {
      const v = view();
      const f = state();
      const m = f.matches[i];
      if (!m) return f;
      v.dispatch(reveal(v.state.tr.setMeta(findKey, { current: i }), m));
      return state();
    },
    /** 모두 찾기 목록: 찾은 곳마다 그 줄의 앞뒤 글 */
    results() {
      const { doc } = view().state;
      return state().matches.map((m, i) => {
        const $from = doc.resolve(m.from);
        const start = $from.start();
        const line = doc.textBetween(start, $from.end(), '\n', '￼');
        return { i, ...snippet(line, m.from - start, m.to - start) };
      });
    },
    /** 찾기를 끝낸다: 표시를 지우고, 지금 자리를 고른 채 편집기로 (focus 면) */
    clear({ focus = false } = {}) {
      const v = view();
      const f = state();
      const m = f.matches[f.current];
      v.dispatch(v.state.tr.setMeta(findKey, { query: '', opts: {}, current: -1 }));
      if (focus) {
        if (m) v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, Math.min(m.from, v.state.doc.content.size), Math.min(m.to, v.state.doc.content.size))));
        v.focus();
      }
    },
    /** 고른 글 (찾기 막대를 열 때 찾을 말로 — 한 줄 · 짧을 때만) */
    selectedText() {
      const { from, to, empty } = view().state.selection;
      if (empty) return '';
      const t = view().state.doc.textBetween(from, to, '\n');
      return t.includes('\n') || t.length > 80 ? '' : t;
    },
    get editable() {
      return view().editable;
    },
  };
}
