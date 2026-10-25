// 매직 에이전트 화면 (목록 검색창 ✦ 의 답 칸 · 매직키 창이 함께 쓴다)
//   답: 글 + 출처(답이 [번호]로 든 메모, 없으면 "관련 있어 보이는 메모")
//   요약: 글 + 출처 + "새 메모로 저장"
//   할 일(일정 · 새 메모 · 덧붙이기): 확인 카드 — 고칠 수 있고, 넣기를 눌러야(Enter) 실행한다
import { eventFromDate, describeReminder } from './core/reminders.js';

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const btn = (label, cls, onClick) => {
  const b = h('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

const CARD = {
  event: { head: '일정 넣기', run: '넣기' },
  memo: { head: '새 메모 만들기', run: '만들기' },
  append: { head: '메모에 덧붙이기', run: '덧붙이기' },
};

/**
 * @param {{ box: HTMLElement, api: {
 *   agent: (req: { id: string, text: string }) => Promise<any>, run: (action) => Promise<{ ok: boolean, id?: string, message?: string }>,
 *   cancel: (id: string) => void, onToken: (cb: (d: { id: string, text: string }) => void) => void, openMemo: (id: string) => void },
 *   onChange?: () => void, onDone?: (r) => void }} o  onChange: 내용 크기가 바뀔 때 (매직키 창 높이) · onDone: 실행을 마쳤을 때
 */
export function createAgentView({ box, api, onChange = () => {}, onDone = () => {} }) {
  box.classList.add('agent');
  const state = h('p', 'agent-state');
  state.setAttribute('role', 'status');
  const out = h('p', 'agent-out');
  const card = h('div', 'agent-card');
  const label = h('p', 'agent-sources-label');
  const sources = h('ol', 'agent-sources');
  const foot = h('div', 'agent-foot');
  box.append(state, out, card, label, sources, foot);

  let job = null;
  let seq = 0;
  let confirm = null; // 지금 확인 카드의 실행 (Enter)

  api.onToken(({ id, text }) => {
    if (id !== job) return;
    out.textContent = text;
    state.textContent = '';
    onChange();
  });

  function clear() {
    for (const n of [out, card, sources, foot]) n.replaceChildren();
    out.textContent = '';
    label.textContent = '';
    confirm = null;
  }

  function cancel() {
    if (job) api.cancel(job);
    job = null;
  }

  function showSources(list, text) {
    // 답이 [번호]로 든 메모만 출처로. 든 게 없으면 번호 없이 "관련 있어 보이는 메모"
    const cited = new Set([...String(text).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1));
    const shown = cited.size ? list.map((s, i) => ({ ...s, n: i + 1 })).filter((s) => cited.has(s.n - 1)) : list.map((s, i) => ({ ...s, n: i + 1 }));
    label.textContent = shown.length ? (cited.size ? '출처' : '관련 있어 보이는 메모') : '';
    sources.classList.toggle('plain', !cited.size);
    sources.replaceChildren(...shown.map((s) => {
      const li = h('li');
      if (cited.size) li.value = s.n;
      const b = btn(s.title || '제목 없음', 'agent-source', () => api.openMemo(s.id));
      if (s.via === 'graph') b.append(h('small', null, ' 연결된 메모'));
      li.append(b);
      return li;
    }));
  }

  function done(res) {
    if (!res?.ok) {
      state.textContent = res?.message ?? '하지 못했어요';
      return;
    }
    clear();
    state.textContent = res.message ?? '했어요';
    if (res.id) foot.append(btn('열기', 'link-btn', () => api.openMemo(res.id)));
    onDone(res);
    onChange();
  }

  function field(labelText, input) {
    const wrap = h('label', 'agent-field');
    wrap.append(h('span', null, labelText), input);
    return wrap;
  }

  function showConfirm(r) {
    const a = { ...r.action };
    const kind = CARD[a.type];
    if (!kind) return;
    const head = h('p', 'agent-card-head', kind.head);
    const body = [];
    let read = () => a;
    if (a.type === 'event') {
      const title = h('input', 'agent-input');
      title.value = a.title;
      const rem = eventFromDate({ ...a.when, title: a.title });
      body.push(field('이름', title), h('p', 'agent-when', rem ? `${describeReminder(rem)} · 미리 알림 ${rem.allDay ? '그날 오전 9시' : '10분 전'}` : a.when?.text ?? ''));
      read = () => ({ ...a, title: title.value.trim() || a.title });
    } else if (a.type === 'memo') {
      const text = h('textarea', 'agent-input');
      text.rows = Math.min(10, Math.max(3, a.body.split('\n').length));
      text.value = a.body.trimEnd();
      body.push(text);
      if (r.drafted) body.push(h('p', 'agent-note', 'AI가 지은 초안이에요. 고친 뒤 만들어 주세요'));
      read = () => ({ ...a, body: `${text.value.trimEnd()}\n` });
    } else if (a.type === 'append') {
      const pick = h('select', 'agent-input');
      for (const t of r.targets ?? []) {
        const o = h('option', null, t.title);
        o.value = t.id;
        pick.append(o);
      }
      pick.value = a.id;
      const text = h('textarea', 'agent-input');
      text.rows = Math.min(8, Math.max(2, a.text.split('\n').length));
      text.value = a.text;
      body.push(field('메모', pick), text);
      read = () => ({ ...a, id: pick.value, text: text.value.trim() });
    }
    const go = async () => {
      if (runBtn.disabled) return; // 하는 중에 Enter · 누르기를 또 해도 한 번만 (일정 · 메모가 두 개 생기지 않게)
      const action = read();
      runBtn.disabled = true;
      state.textContent = '하는 중이에요…';
      const res = await api.run(action).catch((err) => ({ ok: false, message: err.message }));
      runBtn.disabled = false;
      done(res);
    };
    const runBtn = btn(kind.run, 'btn primary agent-run', go);
    confirm = go;
    // 카드마다 새 칸에 — 같은 칸에 키 처리를 붙이면 쌓여서, 지난 카드의 일까지 다시 실행됐다
    const form = h('div', 'agent-form');
    form.append(head, ...body);
    card.append(form);
    foot.append(runBtn, btn('취소', 'link-btn', () => {
      clear();
      state.textContent = '그만뒀어요';
      onChange();
    }));
    // 카드 안 입력칸: Enter(글 칸은 Ctrl+Enter)로 바로 실행
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && (e.ctrlKey || e.target.tagName !== 'TEXTAREA')) {
        e.preventDefault();
        go();
      }
    });
    state.textContent = '이렇게 할까요? 고칠 곳이 있으면 고친 뒤 눌러 주세요';
    requestAnimationFrame(() => runBtn.focus({ preventScroll: true }));
  }

  /** 묻기 · 시키기 */
  async function start(text) {
    cancel();
    clear();
    const q = String(text ?? '').trim();
    if (!q) return;
    job = `g${++seq}`;
    const id = job;
    state.textContent = '생각하는 중이에요…';
    const stop = btn('멈추기', 'link-btn', () => {
      cancel();
      state.textContent = '멈췄어요';
      stop.remove();
      onChange();
    });
    foot.append(stop);
    onChange();
    const r = await api.agent({ id, text: q }).catch((err) => ({ error: err.message }));
    if (id !== job) return;
    job = null;
    stop.remove();
    if (r?.error) {
      state.textContent = r.error;
      onChange();
      return;
    }
    state.textContent = '';
    if (r.kind === 'confirm') showConfirm(r);
    else {
      out.textContent = r.text; // 마지막 조각보다 답이 먼저 올 수 있다
      showSources(r.sources ?? [], r.text);
      if (r.kind === 'summary' && r.sources?.length) {
        foot.append(btn('새 메모로 저장', 'btn', async () => done(await api.run({ type: 'summary', topic: r.topic, text: r.text, sources: r.sources }).catch((err) => ({ ok: false, message: err.message })))));
      }
    }
    onChange();
  }

  return {
    start,
    /** 닫을 때 · 검색어가 바뀔 때 */
    reset() {
      cancel();
      clear();
      state.textContent = '';
    },
    /** 확인 카드가 떠 있으면 실행 (매직키 Enter) → 실행했는가 */
    confirm() {
      if (!confirm) return false;
      confirm();
      return true;
    },
    get busy() {
      return Boolean(job);
    },
  };
}
