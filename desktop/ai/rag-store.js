// AI 검색용 조각 · 벡터 (이 PC 에만: 앱 데이터 ai\vectors.json, 메모 폴더에는 넣지 않음 — 기기마다 모델이 다를 수 있어서).
//   본문이 바뀐 메모만 다시 나누고 계산한다. 검색 모델을 바꾸면 처음부터. 검색 모델이 없으면 조각(낱말 찾기용)만.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chunkMemo } from '../../app/js/core/rag.js';
import { extractTitle } from '../../app/js/core/memo-file.js';

const toB64 = (vec) => Buffer.from(new Float32Array(vec).buffer).toString('base64');
const fromB64 = (b64) => new Float32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer); // Buffer 풀의 어긋난 위치를 피해 복사

export function createRagStore({ file }) {
  let data = null; // { model, memos: { id: { hash, title, chunks: [{ text, vec?: base64 }] } } }

  function load() {
    if (data) return data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      data = { model: '', memos: {} };
    }
    return data;
  }

  /**
   * 지금 메모들의 조각 (모자란 벡터는 계산해서 채운다)
   * @param {{ id: string, body: string }[]} memos 잠금 메모는 빼고 줄 것
   * @param {{ model: string, embed: (texts: string[]) => Promise<number[][]>, onProgress?: (done: number, total: number) => void }} o model: 검색 모델 이름(없으면 '')
   */
  async function chunksFor(memos, { model, embed, onProgress = () => {} }) {
    const d = load();
    if (d.model !== model) Object.assign(d, { model, memos: {} });
    const next = {};
    const todo = [];
    for (const m of memos) {
      const hash = createHash('sha1').update(m.body).digest('hex');
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
      if (changed) fs.writeFileSync(file, JSON.stringify(d)); // 멈춰도 채운 데까지는 남긴다
    }
    return Object.entries(next).flatMap(([id, e]) => e.chunks.map((c) => ({ id, title: e.title, text: c.text, vec: c.vec ? fromB64(c.vec) : undefined })));
  }

  return { chunksFor };
}
