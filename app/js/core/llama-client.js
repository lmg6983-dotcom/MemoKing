// llama-server(OpenAI 모양) 와 말하는 법 — 순수 함수. PC 는 Rust(desktop-rs core/src/ai.rs)가 같은 규칙으로 하고, 이 파일은 그 기준(parity/gen.mjs)

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
  if (arch) return `이 엔진이 모르는 모델 구조예요 (${arch}). 같은 모델을 엔진이 아는 구조로 바꾼 GGUF를 넣어 주세요`;
  if (/out of memory|failed to allocate|bad_alloc/i.test(log)) return '메모리가 모자라요. 더 작은 모델을 넣거나 다른 앱을 닫아 주세요';
  return `모델이 멈췄어요 (${code})`;
}
