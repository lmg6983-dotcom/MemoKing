import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRagStore } from '../desktop/ai/rag-store.js';

test('AI 검색 저장: 바뀐 메모만 다시 계산, 모델을 바꾸면 처음부터, 멈춘 곳은 다음에 채움', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-rag-'));
  const file = path.join(dir, 'vectors.json');
  let calls = 0;
  const embed = async (texts) => {
    calls += texts.length;
    return texts.map((t) => [t.length, 1]);
  };
  const memos = [{ id: 'a', body: '# 회의\n\n출시일 정하기' }, { id: 'b', body: '# 장보기\n\n우유' }];
  try {
    const chunks = await createRagStore({ file }).chunksFor(memos, { model: 'kure', embed });
    assert.equal(calls, 2);
    assert.deepEqual([...chunks[0].vec], ['회의\n출시일 정하기'.length, 1]);
    assert.equal(chunks[0].title, '회의');

    // 다시 켜도 (파일에서) 같은 것은 계산하지 않고, 바뀐 b 만
    calls = 0;
    await createRagStore({ file }).chunksFor([memos[0], { id: 'b', body: '# 장보기\n\n우유 계란' }], { model: 'kure', embed });
    assert.equal(calls, 1);

    // 모델을 바꾸면 처음부터
    calls = 0;
    await createRagStore({ file }).chunksFor(memos, { model: 'qwen', embed });
    assert.equal(calls, 2);

    // 중간에 멈추면 다음에 모자란 것만
    const store = createRagStore({ file });
    await assert.rejects(store.chunksFor(memos, { model: 'other', embed: async () => { throw new Error('멈췄어요'); } }), /멈췄어요/);
    calls = 0;
    await store.chunksFor(memos, { model: 'other', embed });
    assert.equal(calls, 2);

    // 검색 모델이 없으면 조각만 (계산 없음)
    calls = 0;
    const plain = await createRagStore({ file }).chunksFor(memos, { model: '', embed });
    assert.equal(calls, 0);
    assert.equal(plain[0].vec, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
