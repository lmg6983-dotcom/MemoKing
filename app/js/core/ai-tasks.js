// AI 작업 흐름 (PC 메인 · 휴대폰 화면이 함께) — 글 도우미 · 태그 · AI 검색.
//   다른 것은 모델을 부르는 법(ai)과 메모를 읽는 법(memos · graph)뿐이다. 모델은 이 기기 안(llama-server), 인터넷 없이.
import { spellMessages, styleMessages, draftMessages, plausibleFix, titleMessages, cleanTitle, wordDiff, diffEdits, TITLE_OVER } from './ai-write.js';
import { aiTagRequest, aiTagResult } from './ai-tags.js';
import { retrieve, ragMessages } from './rag.js';
import { extractTags } from './tags.js';
import { eventCandidates, aiEventRequest, aiEventResult, nextSeen } from './ai-events.js';
import { isLockedBody } from './memo-lock.js';

export const MAX_TAGS = 3; // 한 메모의 태그 (사용자 + AI) — AI 는 이만큼까지만 채운다
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

  /**
   * 매직키로 저장한 메모 다듬기: 문단마다 맞춤법 · 띄어쓰기(믿을 만한 답만), 첫 줄이 길면 맨 위에 "# 짧은 제목"
   *   → { body, fixes: 고친 곳 수, title: 붙인 제목 | '' }
   */
  async function polish(body) {
    let fixes = 0;
    const blocks = [];
    for (const block of body.split(/(\n{2,})/)) {
      if (!block.trim() || /^\n+$/.test(block)) {
        blocks.push(block);
        continue;
      }
      const out = (await ai.chat(spellMessages(block), { temperature: 0, maxTokens: block.length * 2 + 32 })).trim();
      const ok = out !== block && plausibleFix(block, out);
      if (ok) fixes += diffEdits(wordDiff(block, out)).length;
      blocks.push(ok ? out : block);
    }
    let text = blocks.join('');
    const first = text.split('\n')[0];
    const title = first.length > TITLE_OVER && !/^#/.test(first)
      ? cleanTitle(await ai.chat(titleMessages(text.slice(0, 1500)), { temperature: 0, maxTokens: 40 }))
      : '';
    if (title) text = `# ${title}\n\n${text}`;
    return { body: text, fixes, title };
  }

  /** 메모에 더 달 태그 이름들 — 이미 단 태그와 합쳐 3개까지 (저장은 부른 쪽, 모델 오류는 그대로 던짐) */
  async function autoTags(body, id) {
    const room = MAX_TAGS - extractTags(body).length;
    return room > 0 ? (await pickTags(body, id)).slice(0, room).map((t) => t.name) : [];
  }

  /**
   * 글 속 일정: 아직 보지 않은 줄 중 앞으로의 날짜가 있는 줄을 AI 가 고르고 이름 → { events: [reminder], seen }.
   *   fresh 가 아니면(오래된 메모를 처음 볼 때 — "내일" 이 쓴 날이 아니라 오늘 기준이 되므로) 묻지 않고 본 줄로만
   */
  async function autoEvents(body, { seen = [], existing = [], fresh = true, now = new Date() } = {}) {
    const cands = eventCandidates(body, seen, now);
    if (!cands.length || !fresh) return { events: [], seen: nextSeen(seen, cands) };
    const req = aiEventRequest(cands);
    const json = await ai.chat(req.messages, { schema: req.schema, temperature: 0, maxTokens: 60 + cands.length * 40 });
    return { events: aiEventResult(json, cands, existing, now), seen: nextSeen(seen, cands) };
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

  return { write, pickTags, autoTags, autoEvents, polish, ask };
}
