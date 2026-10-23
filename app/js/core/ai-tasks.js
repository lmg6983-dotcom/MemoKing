// AI 작업 흐름 (PC 메인 · 휴대폰 화면이 함께) — 글 도우미 · 태그 · AI 검색.
//   다른 것은 모델을 부르는 법(ai)과 메모를 읽는 법(memos · graph)뿐이다. 모델은 이 기기 안(llama-server), 인터넷 없이.
import { spellMessages, styleMessages, draftMessages, plausibleFix } from './ai-write.js';
import { aiTagRequest, aiTagResult } from './ai-tags.js';
import { retrieve, ragMessages } from './rag.js';
import { suggestTagsFor } from './tag-suggest.js';
import { isLockedBody } from './memo-lock.js';

const ready = (m) => ['ready', 'running'].includes(m?.state);

/**
 * @param {{
 *   ai: { status: () => any, chat: (messages, o) => Promise<string>, embed: (texts: string[]) => Promise<number[][]> },
 *   memos: () => { id: string, body: string }[],
 *   graph: () => { id: string, related?: { id: string, score: number }[] }[],
 *   store: { chunksFor: Function },
 * }} o
 */
export function createAiTasks({ ai, memos, graph, store }) {
  /** 글 도우미: spell → { fixed: [] } (믿을 만한 답만, 아니면 원래 글) · style · draft → { text } */
  async function write({ task, text = '', blocks = [], style, title, request }, { signal, onToken, onProgress } = {}) {
    if (task === 'spell') {
      const fixed = [];
      for (const [i, block] of blocks.entries()) {
        onProgress?.(i, blocks.length);
        const out = await ai.chat(spellMessages(block), { temperature: 0, maxTokens: block.length * 2 + 32, signal });
        fixed.push(plausibleFix(block, out) ? out : block);
      }
      return { fixed };
    }
    const messages = task === 'style' ? styleMessages(text, style) : draftMessages({ title, body: text, request });
    return { text: await ai.chat(messages, { maxTokens: 1024, signal, onToken }) };
  }

  /** AI 로 태그 고르기 → 칩 목록 */
  async function pickTags(body, id) {
    const req = aiTagRequest(body, memos(), { excludeId: id });
    return aiTagResult(await ai.chat(req.messages, { schema: req.schema, temperature: 0, maxTokens: 80 }), req.existing, body);
  }

  /** 닫은 메모에 달 태그 하나 → 이름 | null — AI 가 못 고르면 AI 없이 확실한 것 (저장은 부른 쪽) */
  async function autoTag(body, id) {
    let picked;
    try {
      picked = (await pickTags(body, id))[0];
    } catch (err) {
      console.error('AI 태그', err.message);
    }
    picked ??= suggestTagsFor(body, memos(), { excludeId: id }).find((t) => t.sure && t.existing);
    return picked?.name ?? null;
  }

  /** AI 검색: 낱말 · 뜻 · 그래프로 메모를 찾고 고른 메모만 근거로 답 → { text, sources } */
  async function ask(question, { signal, onToken, onProgress } = {}) {
    const st = await ai.status();
    const embedOn = ready(st.embed); // 검색 모델이 없으면 낱말 · 그래프만
    const embed = (texts) => {
      if (signal?.aborted) throw new Error('멈췄어요');
      return ai.embed(texts);
    };
    const chunks = await store.chunksFor(memos().filter((m) => !isLockedBody(m.body)), {
      model: embedOn ? `${st.embed.name}:${st.embed.size}` : '',
      embed,
      onProgress,
    });
    // shortcut: Qwen3-Embedding 은 질문 앞에 지시문을 붙여야 제 성능 — 파일 이름으로만 가린다
    const prefix = /qwen/i.test(st.embed?.name ?? '') ? 'Instruct: Given a search query, retrieve relevant notes\nQuery: ' : '';
    const qvec = embedOn ? (await embed([prefix + question]))[0] : undefined;
    const related = new Map(graph().map((m) => [m.id, m.related ?? []]));
    const picked = retrieve(question, chunks, { qvec, related: (id) => related.get(id) ?? [] });
    const sources = picked.map((m) => ({ id: m.id, title: m.title, via: m.via }));
    if (!picked.length) return { text: '메모에서 찾지 못했어요.', sources };
    return { text: await ai.chat(ragMessages(question, picked), { maxTokens: 400, temperature: 0.2, signal, onToken }), sources };
  }

  return { write, pickTags, autoTag, ask };
}
