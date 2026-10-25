// 매직 에이전트 (목록 › 검색창 안 오른쪽 ✦, 또는 검색창에서 Ctrl+Enter) — 검색창의 글로 묻거나 시키면 검색창 바로 아래에
//   답(내 메모에서 찾아 출처를 단) · 요약 · 일정 / 메모 / 덧붙이기 확인 카드 (agent-view.js — 매직키와 같은 화면).
//   찾기 · 답하기는 desktop (core/ai-tasks.js agent, 이 PC 안의 모델, 인터넷 없이). 글 모델을 넣은 PC 에서만 보인다.
import { createAgentView } from './agent-view.js';

/** @param {{ btn: HTMLButtonElement, box: HTMLElement, input: HTMLInputElement, api: any }} o */
export function setupAiAsk({ btn, box, input, api }) {
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn ai-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '매직 에이전트 닫기');
  const inner = document.createElement('div');
  box.append(close, inner);
  const view = box.closest('.view');
  const agent = createAgentView({
    box: inner,
    api: {
      agent: (req) => api.ai.agent(req),
      run: (action) => api.ai.agentRun(action),
      cancel: (id) => api.ai.cancel(id),
      onToken: (cb) => api.on('ai:token', cb),
      openMemo: (id) => api.memo.open(id),
    },
  });

  let query = '';

  function show(on) {
    box.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    view?.classList.toggle('ai-open', on); // 답이 떠 있으면 "검색 결과가 없어요" 는 겹쳐 말하지 않는다
  }
  function reset() {
    agent.reset();
    show(false);
  }
  function start() {
    if (btn.hidden || !query) return;
    show(true);
    agent.start(input.value.trim());
  }

  btn.addEventListener('click', start);
  close.addEventListener('click', reset);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      start();
    }
  });

  return {
    /** 검색어가 바뀔 때 — 글자가 있고 글 모델이 준비됐을 때만 ✦ 를 보인다 */
    async update(text) {
      const st = text ? await api.ai.status().catch(() => null) : null;
      const on = ['ready', 'running'].includes(st?.chat.state);
      if (text !== query) reset();
      query = text;
      btn.hidden = !on;
      btn.parentElement.classList.toggle('has-ai', on);
    },
  };
}
