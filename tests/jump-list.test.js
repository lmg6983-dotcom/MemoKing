import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jumpListCategories, launchAction, pushRecent, readMagicKeyFile, runningMagicKey, LAUNCH } from '../desktop/jump-list.js';

test('runningMagicKey: 실행 파일이 있고 그 프로세스가 살아 있을 때만 (꺼 두면 메모킹이 매직키를 다시 잡게)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-run-'));
  try {
    const note = path.join(dir, 'magickey.json');
    const exe = path.join(dir, 'MagicKey.exe');
    fs.writeFileSync(exe, '');
    const write = (v) => fs.writeFileSync(note, JSON.stringify(v));
    write({ exe, pid: process.pid });
    assert.equal(runningMagicKey(note), exe, '켜져 있음');
    write({ exe, pid: 2 ** 22 + 12345 });
    assert.equal(runningMagicKey(note), null, '꺼진 MagicKey (프로세스 없음)');
    write({ exe });
    assert.equal(runningMagicKey(note), null, 'pid 를 적지 않은 예전 MagicKey');
    write({ exe: path.join(dir, '없음.exe'), pid: process.pid });
    assert.equal(runningMagicKey(note), null, '지운 MagicKey');
    assert.equal(runningMagicKey(path.join(dir, 'none.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readMagicKeyFile: 임시 폴더 바로 아래의 작은 파일만 읽고, 지우지는 않는다', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-tmp-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-other-'));
  try {
    const ok = path.join(tmp, 'magickey-1.txt');
    fs.writeFileSync(ok, '내일 3시 치과');
    assert.deepEqual(readMagicKeyFile(ok, tmp), { text: '내일 3시 치과', file: fs.realpathSync(ok) });
    assert.ok(fs.existsSync(ok), '저장에 성공한 뒤에 부르는 쪽이 지운다');

    const outside = path.join(other, 'magickey-2.txt');
    fs.writeFileSync(outside, '비밀');
    assert.equal(readMagicKeyFile(outside, tmp), null, '다른 폴더');
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'sub', 'magickey-3.txt'), '안쪽');
    assert.equal(readMagicKeyFile(path.join(tmp, 'sub', 'magickey-3.txt'), tmp), null, '임시 폴더 안쪽 폴더도 아님');
    try {
      fs.symlinkSync(outside, path.join(tmp, 'magickey-4.txt'));
      assert.equal(readMagicKeyFile(path.join(tmp, 'magickey-4.txt'), tmp), null, '다른 폴더를 가리키는 링크');
    } catch (err) {
      if (err.code !== 'EPERM') throw err; // Windows 는 링크를 만들 권한이 없을 수 있다
    }
    const big = path.join(tmp, 'magickey-5.txt');
    fs.writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
    assert.equal(readMagicKeyFile(big, tmp), null, '1MB 보다 큼');
    assert.equal(readMagicKeyFile(path.join(tmp, 'magickey-없음.txt'), tmp), null, '없는 파일');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

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
