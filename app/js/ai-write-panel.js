// AI 글쓰기 (메모 창 › 서식 막대 끝 ✦) — 부탁 한 줄(Enter: 초안) + 빠른 작업 칩(맞춤법 · 문체)만 든 작은 창.
//   모델은 이 PC 안(desktop/ai, 인터넷 없이). 고친 글은 바로 덮지 않는다:
//   맞춤법은 문단마다 바뀐 곳(지운 글 · 새 글)을 보여 주고 하나씩 또는 모두 바꾸고, 문체 · 초안은 다 쓴 뒤 바꾸기 · 메모 끝에 넣기를 고른다.
import { STYLES, MAX_CHARS, wordDiff, diffEdits, isEditRequest } from './core/ai-write.js';

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
 * @param {{ panel: HTMLElement, api: any, editor: () => any, title: () => string, onOpen: () => void,
 *           show: (panel) => void, hide: (panel) => void }} o  show: ✦ 위에 띄우기
 */
export function createAiWritePanel({ panel, api, editor, title, onOpen, show, hide }) {
  const $ = (sel) => panel.querySelector(sel);
  const state = $('.ai-state');
  const result = $('.ai-result');
  const stop = $('.ai-stop');
  let job = null; // 지금 묻는 작업 id
  let seq = 0;

  api.on('ai:token', ({ id, text }) => {
    if (id === job) result.querySelector('.ai-out').textContent = text;
  });
  api.on('ai:progress', ({ id, done, total }) => {
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
    const r = await api.ai.write({ id, ...payload });
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

  // ---------- 문체 ----------
  async function restyle(style) {
    const range = editor().aiRange();
    if (!range) return (state.textContent = '그림, 표, 파일이 섞인 곳은 문체를 바꿀 수 없어요. 글만 골라 주세요');
    if (!range.text.trim()) return (state.textContent = '바꿀 글이 없어요');
    if (range.text.length > MAX_CHARS) return (state.textContent = `글이 길어요. ${MAX_CHARS}자 안으로 골라 주세요`);
    const r = await run({ task: 'style', text: range.text, style }, `${style}로 바꾸는 중이에요…`);
    if (!r) return;
    state.textContent = `${style}로 바꿨어요. 마음에 들면 바꾸기를 눌러 주세요`;
    actions(
      button('바꾸기', 'btn', () => {
        if (!editor().aiReplace(range, r.text)) return (state.textContent = '그사이 글이 바뀌어서 넣지 못했어요. 다시 해 주세요');
        result.replaceChildren();
        state.textContent = '바꿨어요. 되돌리려면 Ctrl+Z';
      }),
      button('그대로 두기', 'link-btn', () => { result.replaceChildren(); state.textContent = ''; }),
    );
  }

  // ---------- 초안 · 지시 편집 ----------
  async function draft() {
    const ed = editor();
    const body = ed.plainText();
    const range = ed.aiRange?.() ?? null;
    const hasSelection = Boolean(range && range.from > 0 && range.text.trim() && range.text.trim() !== body.trim());
    const req = request.value;
    const editing = isEditRequest(req, hasSelection ? range.text : body);
    const r = await run(
      { task: 'draft', title: title(), text: body, selection: hasSelection ? range.text : '', request: req },
      editing ? '지시대로 메모를 다듬는 중이에요…' : '초안을 쓰는 중이에요…',
    );
    if (!r) return;
    state.textContent = editing ? '지시대로 정리했어요. 반영할 방식을 골라 주세요' : '초안이에요. [ ] 칸은 직접 채워 주세요';
    const btns = [];
    if (editing && range && range.text.trim()) {
      btns.push(button(hasSelection ? '선택 영역 바꾸기' : '메모 덮어쓰기', 'btn', () => {
        if (!ed.aiReplace(range, r.text)) return (state.textContent = '그사이 글이 바뀌어서 넣지 못했어요. 다시 해 주세요');
        result.replaceChildren();
        state.textContent = '반영했어요. 되돌리려면 Ctrl+Z';
      }));
    } else if (editing && body.trim() && typeof ed.setMarkdown === 'function') {
      btns.push(button('메모 덮어쓰기', 'btn', () => {
        const heading = title()?.trim();
        const nextMd = heading && !/^#\s/.test(r.text.trim()) ? `# ${heading}\n\n${r.text}` : r.text;
        ed.setMarkdown(nextMd);
        result.replaceChildren();
        state.textContent = '반영했어요. 되돌리려면 Ctrl+Z';
      }));
    }
    btns.push(
      button('메모 끝에 넣기', btns.length ? 'link-btn' : 'btn', () => {
        ed.appendMarkdown(r.text); // 커서 자리면 목록 · 인용 안에 들어가 제목까지 들여 써진다
        result.replaceChildren();
        state.textContent = '넣었어요. 되돌리려면 Ctrl+Z';
      }),
      button('버리기', 'link-btn', () => { result.replaceChildren(); state.textContent = ''; }),
    );
    actions(...btns);
  }

  const request = $('.ai-request');
  $('.ai-spell').addEventListener('click', spell);
  $('.ai-chips').append(...Object.keys(STYLES).map((style) => button(style, 'ai-chip ai-task', () => restyle(style))));
  $('.ai-ask-row').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!job) draft();
  });
  stop.addEventListener('click', () => job && api.ai.cancel(job));

  /** 닫힐 때: 묻던 것을 멈추고 결과를 비운다 (휴대폰은 시트가 뒤로 가기 · 바깥 누르기로 닫혀도) */
  function reset() {
    if (job) api.ai.cancel(job);
    job = null;
    busy(false);
    result.replaceChildren();
    state.textContent = '';
  }

  function toggle(force) {
    if (force ?? panel.hidden) {
      show(panel);
      onOpen();
      request.focus();
    } else {
      hide(panel);
      reset();
    }
  }
  return { toggle, reset, get open() { return !panel.hidden; } };
}
