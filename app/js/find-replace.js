// 메모 안 찾기 · 바꾸기 (편집기 쪽) — 찾은 자리를 노랗게, 지금 자리는 진하게 보이고, 하나씩 · 모두 바꾼다
//   찾기 규칙은 core/find.js. 찾기 막대(find-bar.js)가 이 함수들을 부른다. PC 메모 창 · 휴대폰이 함께 쓴다.
//   문단(글 줄 칸)마다 찾는다 — 찾을 말이 문단을 넘어가지는 않는다. 그림 · 파일 같은 칸은 한 글자(￼)로 쳐서 그 너머로 잇지 않는다
import { Plugin, PluginKey, TextSelection, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { findInText, stepMatch } from './core/find.js';

export const findKey = new PluginKey('mk-find');

/** 문서에서 찾은 자리들 [{ from, to }] (문서 순서) */
export function findMatches(doc, query, opts) {
  const out = [];
  if (!query) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach((child) => {
      text += child.isText ? child.text : '￼'.repeat(child.nodeSize);
    });
    const start = pos + 1;
    for (const [a, b] of findInText(text, query, opts)) out.push({ from: start + a, to: start + b });
    return false;
  });
  return out;
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
        if (!tr.docChanged || !prev.query) return prev;
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
    /** 지금 자리 하나를 바꾸고 다음으로 → 바꿨으면 true */
    replace(text) {
      const v = view();
      const f = state();
      const m = f.matches[f.current];
      if (!m || !v.editable) return false;
      const tr = text ? v.state.tr.insertText(text, m.from, m.to) : v.state.tr.delete(m.from, m.to);
      v.dispatch(tr);
      // 바꾼 글 바로 뒤에서 다음 자리 (바꾼 글 안에서 다시 찾지 않게)
      const after = tr.mapping.map(m.to);
      const next = state();
      const i = next.matches.length ? stepMatch(next.matches, after, 1) : -1;
      v.dispatch(reveal(v.state.tr.setMeta(findKey, { current: i }), next.matches[i]));
      return true;
    },
    /** 모두 바꾸기 → 바꾼 개수 (한 번에 되돌릴 수 있게 한 번의 고침으로) */
    replaceAll(text) {
      const v = view();
      const f = state();
      if (!f.matches.length || !v.editable) return 0;
      let tr = v.state.tr;
      for (const m of [...f.matches].reverse()) tr = text ? tr.insertText(text, m.from, m.to) : tr.delete(m.from, m.to);
      v.dispatch(tr);
      return f.matches.length;
    },
    /** 찾기를 끝낸다: 표시를 지우고, 지금 자리를 고른 채 편집기로 (focus 면) */
    clear({ focus = false } = {}) {
      const v = view();
      const f = state();
      const m = f.matches[f.current];
      v.dispatch(v.state.tr.setMeta(findKey, { query: '', current: -1 }));
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
