// 메모 폴더 — 폴더 이름 정리, 목록, 옮긴 사이 다른 기기에서 고쳐 생긴 같은 id 의 두 파일 맞추기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderOf, cleanFolderName, isFolderName, folderList, resolveMovedTwin } from '../app/js/core/folders.js';

test('메모 파일 → 폴더: 맨 위 하위 폴더 하나, 더 깊으면 맨 위 것', () => {
  assert.equal(folderOf('회의.md'), '');
  assert.equal(folderOf('업무/회의.md'), '업무');
  assert.equal(folderOf('업무/2026/회의.md'), '업무');
  assert.equal(folderOf(null), '');
});

test('폴더 이름: 못 쓰는 글자 · 메모킹이 쓰는 폴더 · 장치 이름은 거른다', () => {
  assert.equal(cleanFolderName('  업무  일  '), '업무 일');
  assert.equal(cleanFolderName('a/b:c'), 'a b c');
  assert.equal(cleanFolderName('끝에 점...'), '끝에 점');
  for (const bad of ['', '   ', '.숨김', '_memoking', 'Attachments', 'CON', 'nul', '~$임시']) assert.equal(cleanFolderName(bad), '', bad);
  assert.equal(cleanFolderName('가'.repeat(60)).length, 40);
  // 목록에 둘 폴더: 이름 그대로 쓸 수 있는 것만 ("" 은 폴더 없음, Drive 웹에서 만든 "회의:2026" 은 아님)
  assert.deepEqual(['업무', '', '회의:2026', '.git'].map(isFolderName), [true, false, false, false]);
});

test('폴더 목록: 디스크의 빈 폴더도, 메모 수는 넘긴 메모로, 이름순', () => {
  const list = folderList(['집', '_memoking', '업무', '.git'], [{ folder: '업무' }, { folder: '업무' }, { folder: '' }, { folder: '공부' }]);
  assert.deepEqual(list, [{ name: '공부', count: 1 }, { name: '업무', count: 2 }, { name: '집', count: 0 }]);
});

test('옮긴 사이 옛 자리에서 고침: 자리는 옮긴 쪽, 내용은 나중에 고친 쪽, 나머지는 휴지통', () => {
  const moved = { file: '업무/회의.md', meta: { updated: '2026-11-13T10:00:00+09:00', extra: { moved: '2026-11-13T10:05:00+09:00' } } };
  const editedOld = { file: '회의.md', meta: { updated: '2026-11-13T10:07:00+09:00', extra: {} } };
  assert.deepEqual(resolveMovedTwin(moved, editedOld), { target: '업무/회의.md', source: '회의.md', drop: '회의.md' });
  // 옛 자리가 더 예전 것이면 옮긴 것 그대로
  const staleOld = { ...editedOld, meta: { updated: '2026-11-13T09:00:00+09:00', extra: {} } };
  assert.deepEqual(resolveMovedTwin(staleOld, moved), { target: '업무/회의.md', source: '업무/회의.md', drop: '회의.md' });
  // 옮긴 기록이 같으면(탐색기에서 복사) 손대지 않는다
  assert.equal(resolveMovedTwin(moved, { ...moved, file: '업무/회의 - 복사본.md' }), null);
  assert.equal(resolveMovedTwin({ file: 'a.md', meta: {} }, { file: 'b.md', meta: {} }), null);
});
