// Laya 다국어 모델을 부르는 법 (PC desktop/ai/laya-service.js · 휴대폰 android/web/js/local-ai.js · scripts/laya-bench.mjs).
//   글을 나누고(토크나이저) 질문을 붙이는 것은 laya-ts(app/vendor/laya.js), 계산은 기기마다 다른 provider 가 한다
//   provider: { runEncoder(batch) → { lastHidden }, runHead(lastHidden, batch) → { logits, act } }
import { Agent, parseTokenizerJson, encodeWithData } from '../../vendor/laya.js';

/** tokenizer.json · rl_agent_config.json(을 읽은 것)과 provider → Agent (predict(state, questions)) */
export function layaAgent({ tokenizerJson, cfg, provider }) {
  const data = parseTokenizerJson(tokenizerJson);
  if (!data) throw new Error('AI 태그 모델 파일이 맞지 않아요 (tokenizer.json). 다시 받아 주세요');
  const tok = { clsId: data.ids.cls, sepId: data.ids.sep, maskId: data.ids.mask, padId: data.ids.pad, maskToken: data.maskToken, encode: (text) => encodeWithData(data, text) };
  return new Agent({ provider, tok, cfg });
}

const rows = (t) => Array.from({ length: t.dims[0] }, (_, i) => Array.from(t.data.subarray(i * t.dims[1], (i + 1) * t.dims[1]), Number));
const i64 = (ort, table, cols) => new ort.Tensor('int64', BigInt64Array.from(table.flatMap((r) => Array.from({ length: cols }, (_, j) => BigInt(r[j] ?? 0)))), [table.length, cols]);

/** onnxruntime(-node · -web) 세션 둘로 provider — 가운데 결과(lastHidden)는 텐서 그대로 넘긴다 (JS 배열로 바꾸지 않게) */
export function ortProvider(ort, encoder, head) {
  return {
    async runEncoder(b) {
      const L = Math.max(1, ...b.inputIds.map((r) => r.length));
      const out = await encoder.run({ input_ids: i64(ort, b.inputIds, L), attention_mask: i64(ort, b.attentionMask, L) });
      return { lastHidden: out.last_hidden_state ?? Object.values(out)[0] };
    },
    async runHead(hidden, b) {
      const k = Math.max(2, ...b.markerPos.map((r) => r.length)); // 보기가 하나여도 둘 칸 (laya onnx_agent 와 같게)
      const out = await head.run({
        hidden_states: hidden,
        marker_pos: i64(ort, b.markerPos, k),
        marker_mask: new ort.Tensor('bool', Uint8Array.from(b.markerMask.flatMap((r) => Array.from({ length: k }, (_, j) => (r[j] ? 1 : 0)))), [b.markerMask.length, k]),
        qtype: i64(ort, b.qtype.map((q) => [q]), 1),
        attention_mask: i64(ort, b.attentionMask, hidden.dims[1]),
      });
      return { logits: rows(out.logits), act: rows(out.act_logits ?? out.act) };
    },
  };
}
