// AI 검색 (목록 › 검색창에 쓰면 결과 위에 "AI에게 묻기") — 내 메모에서 찾아 출처 번호를 단 답.
//   찾기 · 답하기는 desktop (core/rag.js, 이 PC 안의 모델, 인터넷 없이). 글 모델을 넣은 PC 에서만 보인다.

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** @param {{ box: HTMLElement, api: any }} o */
export function setupAiAsk({ box, api }) {
  const ask = h('button', 'ai-ask-btn');
  ask.type = 'button';
  const answer = h('div', 'ai-answer');
  answer.hidden = true;
  const state = h('p', 'ai-ask-state');
  state.setAttribute('role', 'status');
  const out = h('p', 'ai-ask-out');
  const sources = h('ol', 'ai-sources');
  const stop = h('button', 'link-btn', '멈추기');
  stop.type = 'button';
  answer.append(state, out, sources, stop);
  box.append(ask, answer);

  let query = '';
  let job = null;
  let seq = 0;

  api.on('ai:token', ({ id, text }) => {
    if (id === job) {
      out.textContent = text;
      state.textContent = '';
    }
  });

  function reset() {
    if (job) api.ai.cancel(job);
    job = null;
    answer.hidden = true;
  }

  ask.addEventListener('click', async () => {
    reset();
    job = `q${++seq}`;
    const id = job;
    answer.hidden = false;
    stop.hidden = false;
    out.textContent = '';
    sources.replaceChildren();
    state.textContent = '내 메모에서 찾는 중이에요…';
    const r = await api.ai.ask({ id, question: query });
    if (id !== job) return;
    job = null;
    stop.hidden = true;
    if (r.error) return (state.textContent = r.error);
    state.textContent = '';
    out.textContent = r.text; // 마지막 조각보다 답이 먼저 올 수 있다
    // 답이 [번호]로 든 메모만 출처로 (못 찾았으면 가까운 메모 모두 — 직접 열어 보게)
    const cited = new Set([...r.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1));
    const shown = cited.size ? r.sources.filter((_, i) => cited.has(i)) : r.sources;
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

  return {
    /** 검색어가 바뀔 때 (AI 모델이 없거나 다른 탭이면 숨김) */
    async update(text) {
      const st = text ? await api.ai.status().catch(() => null) : null;
      const on = ['ready', 'running'].includes(st?.chat.state);
      if (text !== query) reset();
      query = text;
      box.hidden = !on;
      if (!on) return;
      ask.replaceChildren(h('span', 'ai-ask-mark', '✦'), ` AI에게 묻기: `, h('b', null, `“${text}”`), h('small', null, ' 내 메모에서 찾아 답해요'));
    },
  };
}
