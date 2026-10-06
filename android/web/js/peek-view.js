// 태블릿 나란히 보기의 "옆 메모" — 보기만 하는 두 번째 칸 (고치기·녹음은 한 번에 한 메모만)
//   - 누르면 그 메모가 고치는 칸이 되고, 지금 고치던 메모가 이쪽(보기)으로 온다 (자리는 그대로)
//   - 다른 곳(동기화 등)에서 그 메모가 바뀌면 다시 그린다
import { createNoteEditor } from '../../app/js/editor.js';
import { vaultUrl } from '../../app/js/media.js';
import { extractTitle } from '../../app/js/core/memo-file.js';
import { app } from './state.js';

const $ = (id) => document.getElementById(id);
const el = {
  screen: $('peek-screen'),
  title: document.querySelector('#peek-screen .peek-title'),
  root: $('peek-editor'),
};
let id = null;
let editor = null;
let shown = '';
let drawing = null;

export const peekId = () => id;

/** 보기 칸에 이 메모를 (null 이면 닫기) */
export async function showPeek(memoId) {
  if (!memoId) return hidePeek();
  const memo = app.vault.get(memoId);
  if (!memo) return hidePeek();
  id = memoId;
  el.screen.hidden = false;
  el.screen.dataset.color = memo.color;
  el.title.textContent = memo.title || extractTitle(memo.body) || '제목 없음';
  if (shown === memo.body && editor) return;
  await render(memo);
}

async function render(memo) {
  const mine = Symbol('peek');
  drawing = mine;
  const keepTop = el.root.scrollTop;
  editor?.destroy();
  editor = null;
  el.root.replaceChildren();
  const next = await createNoteEditor(el.root, {
    markdown: memo.body,
    readOnly: true,
    onChange: () => {}, // 보기만 — 바뀌지 않는다
    onState: () => {},
    onEmpty: () => {},
    onTasks: () => {},
    tables: memo.tables ?? [],
    readAttachment: async (src) => (await fetch(vaultUrl(src))).text(),
  });
  if (drawing !== mine || id !== memo.id) return next.destroy();
  editor = next;
  shown = memo.body;
  el.root.scrollTop = keepTop;
}

export function hidePeek() {
  id = null;
  shown = '';
  drawing = null;
  editor?.destroy();
  editor = null;
  el.root.replaceChildren();
  el.screen.hidden = true;
}

/** 메모 폴더가 바뀌면 (동기화 · 고치는 칸에서 저장) 보기 칸도 새로 */
export function peekChanged(ids) {
  if (!id) return;
  if (ids && !ids.includes(id)) return;
  const memo = app.vault.get(id);
  if (!memo) return hidePeek();
  showPeek(id);
}
