// Drive 의 "바뀐 것" 고르기 — 새 폴더가 그 안의 파일보다 목록 뒤에 와도 그 파일을 빠뜨리지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickChanges } from '../desktop/drive/drive-api.js';
import { FOLDER } from '../desktop/drive/sync-engine.js';

const file = (fileId, parent, extra = {}) => ({ fileId, file: { name: `${fileId}.md`, mimeType: 'text/markdown', md5Checksum: 'x', parents: [parent], ...extra } });
const folder = (fileId, parent) => ({ fileId, file: { name: fileId, mimeType: FOLDER, parents: [parent] } });

test('새 폴더로 옮긴 메모: 폴더가 파일보다 뒤에 와도 담는다 (Drive 는 폴더에 파일이 들면 폴더를 목록 뒤로 보낸다)', () => {
  const items = pickChanges([file('a', 'work'), file('b', 'work'), folder('work', 'root')], ['root']);
  assert.deepEqual(items.map((i) => i.id), ['a', 'b', 'work']);
  assert.equal(items[2].item.folder, true);
});

test('새 폴더 안의 새 폴더도, 순서가 거꾸로여도', () => {
  const items = pickChanges([file('a', 'deep'), folder('deep', 'work'), folder('work', 'root')], ['root']);
  assert.deepEqual(items.map((i) => i.id), ['a', 'deep', 'work']);
});

test('메모 폴더 밖의 것은 담지 않고, 지운 것 · 휴지통에 간 것은 removed', () => {
  const items = pickChanges([
    file('other', 'elsewhere'), folder('theirs', 'elsewhere'), file('inside', 'theirs'),
    { fileId: 'old', removed: true }, file('gone', 'root', { trashed: true }),
  ], ['root', 'old']);
  assert.deepEqual(items.map((i) => [i.id, i.removed]), [['old', true], ['gone', true]]);
});
