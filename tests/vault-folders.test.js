// 메모킹 폴더 (PC 보관함) — 폴더에 만들기, 옮기기, 옮긴 사이 옛 자리가 되살아나도 하나로, 휴지통에서 그 폴더로 되살리기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../desktop/vault.js';
import { parseMemoFile } from '../app/js/core/memo-file.js';
import { newLockSession } from '../app/js/core/memo-lock.js';

function withVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-folders-'));
  const vault = new Vault(dir);
  vault.open();
  try {
    fn({ dir, vault });
  } finally {
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const memo = (vault, id) => vault.list().find((m) => m.id === id);

test('폴더: 만들기 · 그 폴더에 새 메모 · 다른 폴더로 옮기기 · 맨 위로', () => withVault(({ dir, vault }) => {
  assert.equal(vault.createFolder(' 업무 '), '업무');
  assert.throws(() => vault.createFolder('_memoking'));
  assert.deepEqual(vault.folders(), ['업무']); // _memoking · attachments 는 폴더가 아니다

  const id = vault.create({ folder: '업무' });
  vault.save(id, '# 회의\n\n내용');
  assert.equal(memo(vault, id).file, '업무/회의.md');
  assert.equal(memo(vault, id).folder, '업무');

  vault.moveToFolder(id, '집');
  assert.equal(memo(vault, id).file, '집/회의.md');
  assert.ok(!fs.existsSync(path.join(dir, '업무', '회의.md')));
  const { meta, body } = parseMemoFile(fs.readFileSync(path.join(dir, '집', '회의.md'), 'utf8'));
  assert.ok(meta.extra.moved, '옮긴 때를 머리말에');
  assert.match(body, /내용/);

  vault.moveToFolder(id, '');
  assert.equal(memo(vault, id).file, '회의.md');
  vault.scan();
  assert.equal(vault.list().length, 1);
}));

test('옮긴 사이 다른 기기가 옛 자리에서 고쳐 되살림: 옮긴 자리에 나중 내용 하나만, 옛 파일은 휴지통', () => withVault(({ dir, vault }) => {
  const id = vault.import({ body: '# 회의\n\n처음' });
  const oldText = fs.readFileSync(path.join(dir, '회의.md'), 'utf8');
  vault.moveToFolder(id, '업무');
  // 휴대폰이 옛 자리의 메모를 (옮긴 걸 모른 채) 고쳤고 동기화가 그 파일을 되살림
  const later = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(path.join(dir, '회의.md'), oldText.replace(/updated: .*/, `updated: ${later}`).replace('처음', '휴대폰에서 고침'));
  vault.scan();
  vault.scan(); // 맞춘 뒤 다시 읽기 (rescanSoon 대신)
  const list = vault.list();
  assert.equal(list.length, 1, list.map((m) => m.file).join(', '));
  assert.equal(list[0].file, '업무/회의.md');
  assert.match(vault.get(id).body, /휴대폰에서 고침/);
  assert.ok(!fs.existsSync(path.join(dir, '회의.md')));
  assert.equal(vault.trashList().length, 1, '옛 파일은 지우지 않고 휴지통에');
  // 휴지통의 그 파일을 되살리면 따로인 사본 메모로 남는다 (같은 id 라 다시 휴지통으로 가지 않게)
  const back = vault.restoreTrash(vault.trashList()[0].name);
  vault.scan();
  assert.equal(vault.list().length, 2, vault.list().map((m) => m.file).join(', '));
  assert.notEqual(back, id);
  assert.equal(vault.trashList().length, 0);
}));

test('휴지통: 폴더에 있던 메모는 그 폴더로 되살린다 (폴더가 없어졌어도)', () => withVault(({ dir, vault }) => {
  const id = vault.create({ folder: '업무' });
  vault.save(id, '# 보고서\n\n내용');
  const name = vault.trash(id);
  fs.rmSync(path.join(dir, '업무'), { recursive: true, force: true });
  const back = vault.restoreTrash(name);
  assert.equal(memo(vault, back).file, '업무/보고서.md');
  assert.equal(parseMemoFile(fs.readFileSync(path.join(dir, '업무', '보고서.md'), 'utf8')).meta.extra.trashedFrom, undefined);
}));

test('잠긴 메모를 옮겨도 파일은 잠긴 그대로 (풀린 글이 새 자리에 쓰이지 않는다)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-folders-'));
  const vault = new Vault(dir);
  vault.open();
  try {
    const id = vault.create();
    vault.save(id, '# 비밀\n\n비밀 글');
    vault.lock(id, await newLockSession('사과1234', { iterations: 1000 })); // 연 채로 (메모리에는 풀린 글)
    vault.moveToFolder(id, '업무');
    const text = fs.readFileSync(path.join(dir, '업무', '비밀.md'), 'utf8');
    assert.ok(!text.includes('비밀 글'), '옮긴 파일에 풀린 글이 없음');
    assert.equal(vault.list().find((m) => m.id === id).locked, true);
    assert.equal(vault.get(id).body, '# 비밀\n\n비밀 글', '연 동안은 그대로 읽힘');
  } finally {
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('폴더 이름 바꾸기: 안의 메모가 같은 id 로 새 폴더에, 옮긴 때를 남김 · 겹치는 이름은 거절 · 대소문자만 바꾸기', () => withVault(({ dir, vault }) => {
  const id = vault.create({ folder: '업무' });
  vault.save(id, '# 회의\n\n내용');
  vault.createFolder('집');
  assert.throws(() => vault.renameFolder('업무', '집'), /이미 있어요/);
  assert.equal(vault.renameFolder('업무', ' 회사 '), '회사');
  assert.ok(!fs.existsSync(path.join(dir, '업무')));
  assert.equal(vault.list().find((m) => m.id === id).file, '회사/회의.md');
  assert.ok(parseMemoFile(fs.readFileSync(path.join(dir, '회사', '회의.md'), 'utf8')).meta.extra.moved);
  vault.scan();
  assert.equal(vault.list().length, 1);
  vault.createFolder('work');
  assert.equal(vault.renameFolder('work', 'Work'), 'Work');
  assert.ok(vault.folders().includes('Work') && !vault.folders().includes('work'));
}));

test('폴더 지우기: 메모는 폴더 밖으로 꺼내고 빈 폴더만 지운다 (메모가 아닌 파일이 있으면 폴더는 둔다)', () => withVault(({ dir, vault }) => {
  const a = vault.create({ folder: '업무' });
  vault.save(a, '# 보고서\n\n내용');
  assert.deepEqual(vault.deleteFolder('업무'), { moved: 1, removed: true, ids: [a] });
  assert.equal(vault.list().find((m) => m.id === a).file, '보고서.md');
  assert.ok(!fs.existsSync(path.join(dir, '업무')));
  const b = vault.create({ folder: '자료' });
  vault.save(b, '# 링크\n\n내용');
  fs.writeFileSync(path.join(dir, '자료', '계약서.pdf'), 'pdf');
  assert.deepEqual(vault.deleteFolder('자료'), { moved: 1, removed: false, ids: [b] });
  assert.ok(fs.existsSync(path.join(dir, '자료', '계약서.pdf')), '사용자의 파일은 지우지 않는다');
}));
