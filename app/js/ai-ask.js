// AI 검색 (목록 › 검색창 안 오른쪽 ✦) — 검색어로 내 메모에서 찾아 출처 번호를 단 답을 검색창 바로 아래에.
//   찾기 · 답하기는 desktop (core/rag.js, 이 PC 안의 모델, 인터넷 없이). 글 모델을 넣은 PC 에서만 보인다.

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** @param {{ btn: HTMLButtonElement, box: HTMLElement, api: any }} o */
export function setupAiAsk({ btn, box, api }) {
  const state = h('p', 'ai-ask-state');
  state.setAttribute('role', 'status');
  const out = h('p', 'ai-ask-out');
  const label = h('p', 'ai-sources-label');
  const sources = h('ol', 'ai-sources');
  const stop = h('button', 'link-btn', '멈추기');
  stop.type = 'button';
  const close = h('button', 'icon-btn ai-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'AI 답 닫기');
  box.append(close, state, out, label, sources, stop);
  const view = box.closest('.view');

  let query = '';
  let job = null;
  let seq = 0;

  api.on('ai:token', ({ id, text }) => {
    if (id === job) {
      out.textContent = text;
      state.textContent = '';
    }
  });

  function show(on) {
    box.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    view?.classList.toggle('ai-open', on); // 답이 떠 있으면 "검색 결과가 없어요" 는 겹쳐 말하지 않는다
  }
  function reset() {
    if (job) api.ai.cancel(job);
    job = null;
    show(false);
  }

  btn.addEventListener('click', async () => {
    reset();
    job = `q${++seq}`;
    const id = job;
    show(true);
    stop.hidden = false;
    out.textContent = '';
    label.textContent = '';
    sources.replaceChildren();
    state.textContent = '내 메모에서 찾는 중이에요…';
    const r = await api.ai.ask({ id, question: query });
    if (id !== job) return;
    job = null;
    stop.hidden = true;
    if (r.error) return (state.textContent = r.error);
    state.textContent = '';
    out.textContent = r.text; // 마지막 조각보다 답이 먼저 올 수 있다
    // 답이 [번호]로 든 메모만 출처로. 든 게 없으면(못 찾음) 번호 없이 "관련 있어 보이는 메모" — 직접 열어 보게
    const cited = new Set([...r.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1));
    const shown = cited.size ? r.sources.filter((_, i) => cited.has(i)) : r.sources;
    label.textContent = shown.length ? (cited.size ? '출처' : '관련 있어 보이는 메모') : '';
    sources.classList.toggle('plain', !cited.size);
    sources.start = cited.size ? Math.min(...cited) + 1 : 1;
    sources.replaceChildren(...shown.map((s) => {
      const li = h('li');
      const b = h('button', 'ai-source', s.title || '제목 없음');
      b.type = 'button';
      if (s.via === 'graph') b.append(h('small', null, ' 연결된 메모'));
      b.addEventListener('click', () => api.memo.open(s.id));
      li.append(b);
      return li;
    }));
  });
  stop.addEventListener('click', () => job && api.ai.cancel(job));
  close.addEventListener('click', reset);

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
