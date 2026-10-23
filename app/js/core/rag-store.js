// AI 검색용 조각 · 벡터 (기기마다 따로 — PC 는 앱 데이터 ai\vectors.json, 휴대폰은 앱 안 저장공간. 메모 폴더에는 넣지 않음).
//   본문이 바뀐 메모만 다시 나누고 계산한다. 검색 모델을 바꾸면 처음부터. 검색 모델이 없으면 조각(낱말 찾기용)만.
//   읽기 · 쓰기만 밖에서 받는다 (PC: 파일, 휴대폰: 네이티브) — 순수 로직은 PC · 휴대폰이 함께
import { chunkMemo } from './rag.js';
import { extractTitle } from './memo-file.js';
import { bytesBase64 } from './base64.js';
import { sha256 } from '../../vendor/noble-crypto.js';

const hashOf = (text) => bytesBase64(sha256(new TextEncoder().encode(text)));
const toB64 = (vec) => bytesBase64(new Uint8Array(new Float32Array(vec).buffer));
function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** @param {{ load: () => Promise<string | null>, save: (text: string) => Promise<void> }} io */
export function createRagStore(io) {
  let data = null; // { model, memos: { id: { hash, title, chunks: [{ text, vec?: base64 }] } } }

  async function load() {
    if (data) return data;
    try {
      data = JSON.parse((await io.load()) ?? '');
    } catch {
      data = null;
    }
    data ??= { model: '', memos: {} };
    return data;
  }

  /**
   * 지금 메모들의 조각 (모자란 벡터는 계산해서 채운다)
   * @param {{ id: string, body: string }[]} memos 잠금 메모는 빼고 줄 것
   * @param {{ model: string, embed: (texts: string[]) => Promise<number[][]>, onProgress?: (done: number, total: number) => void }} o model: 검색 모델 이름(없으면 '')
   */
  async function chunksFor(memos, { model, embed, onProgress = () => {} }) {
    const d = await load();
    if (d.model !== model) Object.assign(d, { model, memos: {} });
    const next = {};
    const todo = [];
    for (const m of memos) {
      const hash = hashOf(m.body);
      let e = d.memos[m.id];
      if (!e || e.hash !== hash) e = { hash, title: extractTitle(m.body), chunks: chunkMemo(m.body).map((text) => ({ text })) };
      if (model) todo.push(...e.chunks.filter((c) => !c.vec)); // 지난번에 멈춰 못 채운 것도
      next[m.id] = e;
    }
    const changed = todo.length > 0 || Object.keys(next).length !== Object.keys(d.memos).length || Object.keys(next).some((id) => next[id] !== d.memos[id]);
    d.memos = next;
    try {
      for (let i = 0; i < todo.length; i += 16) {
        onProgress(i, todo.length);
        const part = todo.slice(i, i + 16);
        (await embed(part.map((c) => c.text))).forEach((vec, j) => { part[j].vec = toB64(vec); });
      }
    } finally {
      if (changed) await io.save(JSON.stringify(d)); // 멈춰도 채운 데까지는 남긴다
    }
    return Object.entries(next).flatMap(([id, e]) => e.chunks.map((c) => ({ id, title: e.title, text: c.text, vec: c.vec ? fromB64(c.vec) : undefined })));
  }

  return { chunksFor };
}
