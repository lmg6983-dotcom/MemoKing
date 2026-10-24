// AI 글 도우미 패널 (PC 메모 창 › 메뉴 › AI 글 도우미) — 정리해서 기록 · 지시대로 고치기(문체) · 맞춤법 검사 · 초안 쓰기.
//   모델은 이 PC 안(desktop/ai, 인터넷 없이). 고친 글은 바로 덮지 않는다:
//   맞춤법은 문단마다 바뀐 곳(지운 글 · 새 글)을 보여 주고 하나씩 또는 모두 바꾸고, 정리 · 고치기 · 초안은 다 쓴 뒤 바꾸기 · 메모 끝에 넣기를 고른다.
import { STYLES, MAX_CHARS, wordDiff, diffEdits } from './core/ai-write.js';

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 지운 글은 취소선, 새 글은 밑줄로 */
function diffView(before, after) {
  const box = h('p', 'ai-diff');
  for (const op of wordDiff(before, after)) box.append(op.type === 'same' ? op.text : h(op.type, null, op.text));
  return box;
}

/**
 * @param {{ panel: HTMLElement, api: any, editor: () => any, title: () => string, onOpen: () => void }} o
 */
export function createAiWritePanel({ panel, api, editor, title, onOpen }) {
  const $ = (sel) => panel.querySelector(sel);
  const state = $('.ai-state');
  const result = $('.ai-result');
  const stop = $('.ai-stop');
  let job = null; // 지금 묻는 작업 id
  let seq = 0;

  api.on('llm:token', ({ id, text }) => {
    if (id === job) result.querySelector('.ai-out').textContent = text;
  });
  api.on('llm:progress', ({ id, done, total }) => {
    if (id === job) state.textContent = `맞춤법을 보는 중이에요 (${done + 1}/${total} 문단)`;
  });

  function busy(on) {
    for (const b of panel.querySelectorAll('.ai-task')) b.disabled = on;
    stop.hidden = !on;
  }

  async function run(payload, waiting) {
    job = `w${++seq}`;
    const id = job;
    result.replaceChildren(h('p', 'ai-out'));
    state.textContent = waiting;
    busy(true);
    state.scrollIntoView({ block: 'start', behavior: 'smooth' }); // 좁은 창: 단추 아래 결과가 보이게
    const r = await api.llm.write({ id, ...payload });
    if (id !== job) return null; // 그사이 다른 작업 · 닫기
    job = null;
    busy(false);
    if (r.error) {
      state.textContent = r.error;
      return null;
    }
    if (r.text) result.querySelector('.ai-out').textContent = r.text; // 마지막 조각보다 답이 먼저 올 수 있다
    return r;
  }

  function actions(...buttons) {
    const row = h('div', 'dialog-actions left');
    row.append(...buttons);
    result.append(row);
  }
  const button = (label, cls, onClick) => {
    const b = h('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  // ---------- 맞춤법 ----------
  async function spell() {
    const blocks = editor().aiBlocks();
    if (!blocks.length) return (state.textContent = '고칠 글이 없어요');
    const r = await run({ task: 'spell', blocks: blocks.map((b) => b.text) }, '모델을 올리는 중이에요…');
    if (!r) return;
    const found = blocks.map((b, i) => ({ ...b, fixed: r.fixed[i] })).filter((b) => b.fixed !== b.text);
    result.replaceChildren();
    if (!found.length) return (state.textContent = '고칠 곳을 찾지 못했어요');
    state.textContent = `고칠 곳이 있는 문단 ${found.length}개. 바꿀 것만 골라 주세요`;
    const cards = found.map((b) => {
      const card = h('div', 'ai-card');
      const apply = () => {
        const ok = editor().aiApply(b.pos, b.text, diffEdits(wordDiff(b.text, b.fixed)));
        if (ok) card.remove();
        else card.querySelector('.ai-card-note').textContent = '그사이 글이 바뀌어서 넣지 못했어요';
        if (!result.querySelector('.ai-card')) state.textContent = '다 고쳤어요. 되돌리려면 Ctrl+Z';
        return ok;
      };
      const row = h('div', 'dialog-actions left');
      row.append(button('바꾸기', 'btn', apply), button('그대로 두기', 'link-btn', () => card.remove()));
      card.append(diffView(b.text, b.fixed), h('small', 'ai-card-note'), row);
      card.apply = apply;
      return card;
    });
    result.append(...cards);
    if (cards.length > 1) result.prepend(button('모두 바꾸기', 'btn ai-all', (e) => {
      for (const c of [...result.querySelectorAll('.ai-card')]) c.apply();
      e.target.remove();
    }));
  }

  // ---------- 정리 · 지시대로 고치기 · 문체: 고른 곳(없으면 메모 전체)을 바꿔 쓴 글로 ----------
  async function rewrite(payload, doing, done) {
    const range = editor().aiRange();
    if (!range) return (state.textContent = '그림, 표, 파일이 섞인 곳은 바꿀 수 없어요. 글만 골라 주세요');
    if (!range.text.trim()) return (state.textContent = '바꿀 글이 없어요');
    if (range.text.length > MAX_CHARS) return (state.textContent = `글이 길어요. ${MAX_CHARS}자 안으로 골라 주세요`);
    const r = await run({ ...payload, text: range.text }, doing);
    if (!r) return;
    state.textContent = `${done}. 마음에 들면 바꾸기를 눌러 주세요`;
    actions(
      button('바꾸기', 'btn', () => {
        if (!editor().aiReplace(range, r.text)) return (state.textContent = '그사이 글이 바뀌어서 넣지 못했어요. 다시 해 주세요');
        result.replaceChildren();
        state.textContent = '바꿨어요. 되돌리려면 Ctrl+Z';
      }),
      button('그대로 두기', 'link-btn', () => { result.replaceChildren(); state.textContent = ''; }),
    );
  }

  // ---------- 초안 ----------
  async function draft() {
    const r = await run({ task: 'draft', title: title(), text: editor().plainText(), request: $('.ai-draft-request').value }, '초안을 쓰는 중이에요…');
    if (!r) return;
    state.textContent = '초안이에요. [ ] 칸은 직접 채워 주세요';
    actions(
      button('메모 끝에 넣기', 'btn', () => {
        editor().appendMarkdown(r.text); // 커서 자리면 목록 · 인용 안에 들어가 제목까지 들여 써진다
        result.replaceChildren();
        state.textContent = '넣었어요. 되돌리려면 Ctrl+Z';
      }),
      button('버리기', 'link-btn', () => { result.replaceChildren(); state.textContent = ''; }),
    );
  }

  $('.ai-tidy').addEventListener('click', () => rewrite({ task: 'tidy' }, '정리하는 중이에요…', '정리했어요'));
  for (const style of Object.keys(STYLES)) {
    $('.ai-styles').append(button(style, 'btn ai-task', () => rewrite({ task: 'style', style }, `${style}로 바꾸는 중이에요…`, `${style}로 바꿨어요`)));
  }
  $('.ai-custom').addEventListener('click', () => {
    const instruction = $('.ai-instruction').value.trim();
    if (!instruction) return $('.ai-instruction').focus();
    rewrite({ task: 'custom', instruction }, '고치는 중이에요…', '고쳤어요');
  });
  $('.ai-spell').addEventListener('click', spell);
  $('.ai-draft').addEventListener('click', draft);
  stop.addEventListener('click', () => job && api.llm.cancel(job));

  /** 닫힐 때: 묻던 것을 멈추고 결과를 비운다 */
  function reset() {
    if (job) api.llm.cancel(job);
    job = null;
    busy(false);
    result.replaceChildren();
    state.textContent = '';
  }

  function toggle(force) {
    if (force ?? panel.hidden) {
      panel.hidden = false;
      onOpen();
      $('.ai-tidy').focus();
    } else {
      panel.hidden = true;
      editor()?.focus();
      reset();
    }
  }
  panel.querySelector('.ai-close').addEventListener('click', () => toggle(false));
  return { toggle, reset, get open() { return !panel.hidden; } };
}
