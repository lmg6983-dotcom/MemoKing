// 다른 앱 메모 가져오기 (app/js/core/drive-import.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importPicked, importMessage, freeName, isMemoFile } from '../app/js/core/drive-import.js';

// 가짜 Drive: files[id] = { name, folder, parents }
function fakeDrive(files) {
  const copies = [];
  return {
    copies,
    api: {
      meta: async (id) => ({ id, ...files[id] }),
      children: async (parent) => Object.entries(files).filter(([, f]) => f.parents.includes(parent) && !f.hidden).map(([id, f]) => ({ id, name: f.name, folder: Boolean(f.folder) })),
      copy: async (id, parent, name) => copies.push({ id, parent, name }),
    },
  };
}

test('메모 폴더 안에서 고른 것은 그대로, 다른 곳의 것은 메모 폴더로 사본 (같은 이름은 (2))', async () => {
  const d = fakeDrive({
    a: { name: '회의.md', parents: ['memo'] },
    b: { name: '회의.md', parents: ['gemini'] },
    c: { name: '장보기.md', parents: ['gemini'] },
    x: { name: '사진.png', parents: ['gemini'] },
  });
  const r = await importPicked(['a', 'b', 'c', 'x', 'c'], 'memo', d.api);
  assert.deepEqual(r, { kept: 1, copied: 2, skipped: 1, closedFolders: 0 });
  assert.deepEqual(d.copies, [{ id: 'b', parent: 'memo', name: '회의 (2).md' }, { id: 'c', parent: 'memo', name: '장보기.md' }]);
});

test('고른 폴더: 안의 메모가 보이면 사본, 안 보이면 폴더를 열 수 없다고', async () => {
  const open = fakeDrive({ g: { name: 'Gemini', folder: true, parents: ['root'] }, n: { name: '메모.md', parents: ['g'] } });
  assert.deepEqual(await importPicked(['g'], 'memo', open.api), { kept: 0, copied: 1, skipped: 0, closedFolders: 0 });
  const closed = fakeDrive({ g: { name: 'Gemini', folder: true, parents: ['root'] }, n: { name: '메모.md', parents: ['g'], hidden: true } });
  assert.deepEqual(await importPicked(['g'], 'memo', closed.api), { kept: 0, copied: 0, skipped: 0, closedFolders: 1 });
});

test('메모 폴더 자체를 고르면 고르기 전에 안 보이던 메모만 센다 (사본 없이)', async () => {
  const d = fakeDrive({ memo: { name: '메모킹', folder: true, parents: ['root'] }, old: { name: '예전.md', parents: ['memo'] }, ai: { name: 'AI.md', parents: ['memo'] } });
  assert.deepEqual(await importPicked(['memo'], 'memo', d.api, ['old']), { kept: 1, copied: 0, skipped: 0, closedFolders: 0 });
  assert.deepEqual(await importPicked(['memo'], 'memo', d.api, ['old', 'ai']), { kept: 0, copied: 0, skipped: 0, closedFolders: 1 });
  assert.equal(d.copies.length, 0);
});

test('이름 · 알림 말', () => {
  assert.equal(freeName('a.md', new Set(['a.md', 'a (2).md'])), 'a (3).md');
  assert.equal(isMemoFile({ name: 'x.MD' }), true);
  assert.equal(isMemoFile({ name: 'x.md', folder: true }), false);
  assert.equal(importMessage({ kept: 1, copied: 2 }), '다른 앱 메모 3개를 가져왔어요');
  assert.equal(importMessage({ skipped: 2 }), '메모(.md)가 아닌 파일 2개는 건너뛰었어요');
  assert.match(importMessage({ closedFolders: 1 }), /폴더 안의 메모는 열 수 없었어요/);
  assert.equal(importMessage({}), '고른 파일이 없어요');
});
