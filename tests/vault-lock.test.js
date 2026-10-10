import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../desktop/vault.js';
import { newLockSession, openLock } from '../app/js/core/memo-lock.js';

const FAST = { iterations: 1000 };
const allText = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('잠그면 파일·버전 어디에도 풀린 글이 남지 않고, 연 동안만 고칠 수 있다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 비밀\n\n첫 비밀 글');
  v.keepVersion(id, '# 비밀\n\n예전 비밀 글', { force: true }); // 잠그기 전 버전 기록
  const session = await newLockSession('사과1234', FAST);
  const locked = v.lock(id, session);
  assert.equal(locked.locked, true);
  assert.equal(locked.body, '# 비밀\n\n첫 비밀 글', '연 동안은 풀린 글');
  assert.ok(!allText(root).includes('비밀 글'), '파일·버전·색인 어디에도 풀린 글 없음');
  assert.equal(v.list().find((m) => m.id === id).title, '비밀');
  assert.equal(v.list().find((m) => m.id === id).locked, true);

  v.save(id, '# 비밀\n\n고친 비밀 글'); // 자동 저장
  assert.ok(!allText(root).includes('고친 비밀 글'));
  assert.equal(v.get(id).body, '# 비밀\n\n고친 비밀 글');

  v.closeLock(id);
  assert.equal(v.get(id).needsPassword, true);
  v.save(id, '# 비밀\n\n잠긴 뒤 들어온 풀린 글'); // 닫은 뒤의 저장(늦은 자동 저장 등)은 무시
  assert.ok(!allText(root).includes('잠긴 뒤 들어온'));

  // 다시 열기: 파일만 다시 읽은 다른 앱(새 Vault)에서 비밀번호로
  const v2 = new Vault(root);
  v2.open();
  const sealed = v2.get(id).body;
  await assert.rejects(() => openLock(sealed, '틀림1234'), /비밀번호가 달라요/);
  const { session: s2 } = await openLock(sealed, '사과1234');
  assert.equal(v2.openLock(id, s2).body, '# 비밀\n\n고친 비밀 글');

  // 잠금 풀기
  const plain = v2.unlock(id);
  assert.equal(plain.locked, false);
  assert.ok(allText(root).includes('고친 비밀 글'));
  v.close();
  v2.close();
});
