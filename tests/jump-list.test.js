import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jumpListCategories, launchAction, pushRecent, LAUNCH } from '../desktop/jump-list.js';

test('점프 목록: 작업(메모 목록 열기 · 새 메모)과 최근에 연 메모가 따로', () => {
  const cats = jumpListCategories([{ id: 'a-1', title: '회의 메모' }, { id: 'b-2', title: '가'.repeat(60) }], { program: 'C:\\Program Files\\MemoKing\\MemoKing.exe' });
  assert.deepEqual(cats.map((c) => c.type), ['tasks', 'custom']);
  assert.deepEqual(cats[0].items.map((i) => [i.title, i.args]), [['메모 목록 열기', LAUNCH.list], ['새 메모', LAUNCH.newMemo]]);
  assert.equal(cats[1].name, '최근에 연 메모');
  assert.deepEqual(cats[1].items.map((i) => i.args), ['--open-memo=a-1', '--open-memo=b-2']);
  assert.ok(cats[1].items[1].title.length <= 40 && cats[1].items[1].title.endsWith('…'));
  // 개발 실행: electron.exe "<앱 폴더>" 인자 — 띄어쓰기가 있으면 따옴표
  const dev = jumpListCategories([], { program: 'electron.exe', prefix: ['C:\\my app'] });
  assert.equal(dev.length, 1); // 최근이 없으면 그 칸은 없음
  assert.equal(dev[0].items[0].args, '"C:\\my app" --open-list');
});

test('점프 목록: 실행 인자 읽기 · 최근 목록', () => {
  assert.deepEqual(launchAction(['MemoKing.exe', '--open-memo=0000-abc']), { kind: 'memo', id: '0000-abc' });
  assert.deepEqual(launchAction(['x', '--open-list']), { kind: 'list' });
  assert.deepEqual(launchAction(['x', '--new-memo']), { kind: 'new' });
  assert.equal(launchAction(['x', '--open-memo=../../bad']), null);
  assert.equal(launchAction(['x', '--hidden']), null);
  assert.deepEqual(launchAction(['x', '--new-memo-file=C:\\Temp\\magickey-1a2b.txt']), { kind: 'newFile', file: 'C:\\Temp\\magickey-1a2b.txt', open: false, remind: false });
  assert.deepEqual(launchAction(['x', '--new-memo-file=/tmp/magickey-9.txt', '--open-new', '--remind']), { kind: 'newFile', file: '/tmp/magickey-9.txt', open: true, remind: true });
  assert.equal(launchAction(['x', '--new-memo-file=C:\\Users\\me\\secret.txt']), null, 'MagicKey 가 쓴 임시 파일 이름만');
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.deepEqual(pushRecent(undefined, 'a'), ['a']);
  assert.equal(pushRecent(Array.from({ length: 30 }, (_, i) => String(i)), 'x').length, 20);
});
