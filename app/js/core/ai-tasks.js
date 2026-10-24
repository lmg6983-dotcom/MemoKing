// AI 작업 흐름 (PC 메인 · 휴대폰 화면이 함께) — 글 도우미 · 태그 · AI 검색.
//   다른 것은 모델을 부르는 법(ai)과 메모를 읽는 법(memos · graph)뿐이다. 모델은 이 기기 안(llama-server), 인터넷 없이.
import { spellMessages, styleMessages, draftMessages, plausibleFix, titleMessages, cleanTitle, wordDiff, diffEdits, TITLE_OVER } from './ai-write.js';
import { aiTagRequest, aiTagResult, MIN_AI_TEXT } from './ai-tags.js';
import { chunkMemo, retrieve, ragMessages, expandMessages, expandResult } from './rag.js';
import { extractTitle, plainLines } from './memo-file.js';
import { extractTags } from './tags.js';
import { eventCandidates, aiEventRequest, aiEventResult, nextSeen } from './ai-events.js';
import { isLockedBody } from './memo-lock.js';

export const MAX_TAGS = 3; // 한 메모의 태그 (사용자 + AI) — AI 는 이만큼까지만 채운다

/**
 * @param {{
 *   ai: { status: () => any, chat: (messages, o) => Promise<string> },
 *   memos: () => { id: string, body: string }[],
 *   graph: () => { id: string, related?: { id: string, score: number }[] }[],
 * }} o
 */
export function createAiTasks({ ai, memos, graph }) {
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
    return aiTagResult(await ai.chat(req.messages, { schema: req.schema, temperature: 0, maxTokens: 80 }), req.existing, body, req.grounded);
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
    // 짧은 메모(인사 · 한 줄 대답)에는 저절로 달지 않는다 — 고를 주제가 없는데 억지로 채우던 것
    if (room <= 0 || plainLines(body).join('').replace(/\s/g, '').length < MIN_AI_TEXT) return [];
    return (await pickTags(body, id)).slice(0, room).map((t) => t.name);
  }

  /**
   * 글 속 일정: 아직 보지 않은 줄 중 앞으로의 날짜가 있는 줄을 AI 가 고르고 이름 → { events: [reminder], seen }.
   *   fresh 가 아니면(오래된 메모를 처음 볼 때 — "내일" 이 쓴 날이 아니라 오늘 기준이 되므로) 묻지 않고 본 줄로만.
   *   written: 글을 쓴 때 — "내일" 은 이때 기준 (휴대폰에서 밤 11시 반에 쓴 메모를 PC 가 자정 넘어 봐도 하루 밀리지 않게)
   */
  async function autoEvents(body, { seen = [], existing = [], fresh = true, now = new Date(), written = now } = {}) {
    const cands = eventCandidates(body, seen, written);
    if (!cands.length || !fresh) return { events: [], seen: nextSeen(seen, cands) };
    const req = aiEventRequest(cands);
    const json = await ai.chat(req.messages, { schema: req.schema, temperature: 0, maxTokens: 60 + cands.length * 40 });
    return { events: aiEventResult(json, cands, existing, now), seen: nextSeen(seen, cands) };
  }

  /** AI 검색: 글 모델(카나나2)이 질문을 넓히고, 낱말 · 그래프로 메모를 찾아 고른 메모만 근거로 답 → { text, sources } */
  async function ask(question, { signal, onToken } = {}) {
    const chunks = memos().filter((m) => !isLockedBody(m.body)).flatMap((m) => {
      const title = extractTitle(m.body);
      return chunkMemo(m.body).map((text) => ({ id: m.id, title, text }));
    });
    const ex = expandMessages(question);
    // 넓히지 못해도(모델 오류 · 엉뚱한 답) 질문 낱말만으로 찾는다
    const words = await ai.chat(ex.messages, { schema: ex.schema, temperature: 0, maxTokens: 120, signal }).then(expandResult, () => []);
    if (signal?.aborted) throw new Error('멈췄어요');
    const related = new Map(graph().map((m) => [m.id, m.related ?? []]));
    const picked = retrieve(question, chunks, { words, related: (id) => related.get(id) ?? [] });
    const sources = picked.map((m) => ({ id: m.id, title: m.title, via: m.via }));
    if (!picked.length) return { text: '메모에서 찾지 못했어요.', sources };
    return { text: await ai.chat(ragMessages(question, picked), { maxTokens: 400, temperature: 0.2, signal, onToken }), sources };
  }

  return { write, pickTags, autoTags, autoEvents, polish, ask };
}
