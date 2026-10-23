// llama-server(OpenAI 모양) 와 말하는 법 (PC desktop/ai · 휴대폰 android/web/js/local-ai.js 가 함께) — 순수 함수
//   주고받는 길(HTTP · 네이티브)만 기기마다 다르다

/** 다 오기 전의 생각 블록도 뗀다 (Qwen3 계열) */
export const noThink = (text) => String(text ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/** /v1/chat/completions 에 보낼 것. schema: 그 JSON 모양으로만 답 */
export function chatBody(messages, { maxTokens = 512, temperature = 0.3, schema, stream = false } = {}) {
  return {
    messages,
    max_tokens: maxTokens,
    temperature,
    chat_template_kwargs: { enable_thinking: false }, // Qwen3 계열의 생각 모드 끄기 (다른 모델은 무시)
    ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'out', schema } } } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** 스트리밍 답의 한 줄("data: {…}") → 새 글 조각 | '' */
export function sseText(line) {
  const data = line.startsWith('data: ') ? line.slice(6).trim() : '';
  if (!data || data === '[DONE]') return '';
  return JSON.parse(data).choices?.[0]?.delta?.content ?? '';
}

/** 엔진(llama-server)이 꺼질 때의 로그 → 사람이 알아듣는 까닭 (PC ai-service.js · 휴대폰 LocalAi.kt 가 같은 말로) */
export function engineError(log, code) {
  const arch = /unknown model architecture: '([^']+)'/.exec(log)?.[1];
  if (arch) return `이 엔진이 모르는 모델 구조예요 (${arch}). 같은 모델을 엔진이 아는 구조로 바꾼 GGUF 를 넣어 주세요`;
  if (/out of memory|failed to allocate|bad_alloc/i.test(log)) return '메모리가 모자라요. 더 작은 모델을 넣거나 다른 앱을 닫아 주세요';
  return `모델이 멈췄어요 (${code})`;
}

/** 한 번에 받은 답 → 글 */
export const replyText = (data) => noThink(data.choices?.[0]?.message?.content);

/**
 * 주고받는 길만 받아 chat · embed 를 만든다
 * @param {(role: 'chat' | 'embed', route: string, body: object, o: { signal?: AbortSignal, onLine?: (line: string) => void }) => Promise<any>} request
 *   onLine 을 주면 스트리밍 답을 줄마다 넘기고, 아니면 답 JSON 을 돌려준다
 */
export function llamaClient(request) {
  return {
    /** 글 모델에 묻기 → 답 글. schema: 그 JSON 모양으로만 답 · onToken: 지금까지 온 글을 조각마다 · signal: 멈추기 */
    async chat(messages, { onToken, signal, ...o } = {}) {
      if (!onToken) return replyText(await request('chat', '/v1/chat/completions', chatBody(messages, o), { signal }));
      let text = '';
      await request('chat', '/v1/chat/completions', chatBody(messages, { ...o, stream: true }), {
        signal,
        onLine: (line) => {
          const piece = sseText(line);
          if (piece) onToken(noThink((text += piece)));
        },
      });
      return noThink(text);
    },
    /** 검색 모델로 글들의 벡터 */
    async embed(texts) {
      const data = await request('embed', '/v1/embeddings', { input: texts });
      return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
