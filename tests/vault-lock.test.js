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

test('목록에서 잠그면 열쇠를 들고 있지 않아 바로 눌러도 비밀번호를 묻는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 비밀\n\n목록에서 잠근 글');
  const memo = v.lock(id, await newLockSession('사과1234', FAST), { keepOpen: false });
  assert.equal(memo.needsPassword, true);
  assert.ok(!memo.body.includes('목록에서 잠근 글'));
  assert.ok(!v.get(id).body.includes('목록에서 잠근 글'));
  v.close();
});

test('잠긴 메모의 사본: 원래 메모를 연 동안만 같은 열쇠, 사본을 따로 열면 비밀번호를 묻고, 원래 메모를 닫으면 잊는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 비밀\n\n원래 글');
  v.lock(id, await newLockSession('사과1234', FAST));
  const copy = v.importCopyOf(id, '# 비밀 (사본)\n\n다른 기기 글');
  assert.ok(copy);
  assert.ok(!allText(root).includes('다른 기기 글'));
  assert.equal(v.get(copy).needsPassword, true, '사본을 바로 누르면 비밀번호');
  assert.ok(!v.get(copy).body.includes('다른 기기 글'));
  v.save(copy, '# 비밀 (사본)\n\n다시 들어온 글'); // 원래 메모가 열린 동안은 사본을 고쳐 쓸 수 있음
  v.closeLock(id);
  const { session } = await openLock(v.entries.get(copy).body, '사과1234');
  assert.equal(v.openLock(copy, session).body, '# 비밀 (사본)\n\n다시 들어온 글');
  v.close();
});

test('잠긴 메모만 쓰는 사진은 다른 메모를 지워도 치우지 않음', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  fs.writeFileSync(path.join(root, 'attachments', 'x.png'), 'png');
  const a = v.create();
  v.save(a, '# 보통\n\n![](attachments/x.png)');
  const b = v.create();
  v.save(b, '# 비밀\n\n![](attachments/x.png)');
  v.lock(b, await newLockSession('사과1234', FAST), { keepOpen: false });
  v.trash(a);
  assert.ok(fs.existsSync(path.join(root, 'attachments', 'x.png')), '잠긴 메모의 사진이 남아 있어야');
  v.close();
});

test('자동 저장이 동기화와 겹쳐도 다른 기기의 잠금을 풀지 않음 (쓰던 글은 사본으로)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 여행\n\n첫 줄');
  const file = path.join(root, v.get(id).file);
  const text = fs.readFileSync(file, 'utf8');
  const head = /^---\n[\s\S]*?\n---\n/.exec(text)[0];
  const { lockBody } = await import('../app/js/core/memo-lock.js');
  await new Promise((r) => setTimeout(r, 20)); // 파일 시각이 달라지게
  fs.writeFileSync(file, head + await lockBody('# 여행\n\n첫 줄', 'phone999', FAST)); // 휴대폰이 잠금 (아직 다시 읽기 전)
  const r = v.save(id, '# 여행\n\n첫 줄 그리고 PC 에서 쓴 글');
  assert.equal(r.refused, true);
  assert.equal(r.copied, true);
  assert.match(fs.readFileSync(file, 'utf8'), /memoking-lock/, '파일은 잠긴 그대로');
  assert.ok(v.list().some((m) => m.id !== id && v.get(m.id).body.includes('PC 에서 쓴 글')), '쓰던 글은 사본 메모로');
  v.close();
});

test('잠긴 메모가 있어도 다른 메모만 쓰던 사진은 치우고, 잠긴 메모의 사진은 남김 (경로는 파일에 드러나지 않음)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  for (const f of ['mine.png', 'other.png']) fs.writeFileSync(path.join(root, 'attachments', f), 'png');
  const locked = v.create();
  v.save(locked, '# 비밀\n\n![](attachments/mine.png)');
  v.lock(locked, await newLockSession('사과1234', FAST), { keepOpen: false });
  assert.ok(!fs.readFileSync(path.join(root, v.get(locked).file), 'utf8').includes('mine.png'), '경로는 숨김');
  const a = v.create();
  v.save(a, '# 보통\n\n![](attachments/other.png)\n![](attachments/mine.png)');
  v.trash(a);
  assert.ok(fs.existsSync(path.join(root, 'attachments', 'mine.png')), '잠긴 메모의 사진은 남음');
  assert.ok(!fs.existsSync(path.join(root, 'attachments', 'other.png')), '다른 사진은 휴지통으로');
  v.close();
});

test('같은 비밀번호로 다른 기기가 고친 것은 "잠갔다" 가 아니라 보통 동시 고침 (그쪽 글은 잠근 사본, 내 글은 저장)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 일기\n\n처음');
  const session = await newLockSession('사과1234', FAST);
  v.lock(id, session);
  const file = path.join(root, v.get(id).file);
  const text = fs.readFileSync(file, 'utf8');
  const head = /^---\n[\s\S]*?\n---\n/.exec(text)[0];
  const { sealBody } = await import('../app/js/core/memo-lock.js');
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(file, head + sealBody('# 일기\n\n처음\n휴대폰에서 씀', session)); // 같은 비밀번호로 휴대폰이 고침
  const r = v.save(id, '# 일기\n\n처음\nPC 에서 씀');
  assert.ok(!r.refused, '저장됨');
  assert.equal(v.get(id).body, '# 일기\n\n처음\nPC 에서 씀');
  const copy = v.list().find((m) => m.id !== id);
  assert.ok(copy && v.entries.get(copy.id).body.includes('memoking-lock'), '그쪽 글은 잠근 사본으로');
  v.close();
});

test('잠긴 메모에 잠기기 전(풀린) 버전은 되돌리지 않음', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 메모\n\n예전 글');
  v.keepVersion(id, '# 메모\n\n예전 글', { force: true });
  const name = v.versions(id)[0]?.name;
  const file = path.join(root, v.get(id).file);
  const text = fs.readFileSync(file, 'utf8');
  const head = /^---\n[\s\S]*?\n---\n/.exec(text)[0];
  const { lockBody } = await import('../app/js/core/memo-lock.js');
  fs.writeFileSync(file, head + await lockBody('# 메모\n\n예전 글', 'phone999', FAST)); // 다른 기기가 잠금
  v.scan();
  assert.equal(v.versions(id).length, 0, '이 기기에 남은 풀린 버전은 지움');
  if (name) assert.ok(v.restoreVersion(id, name) === null || v.restoreVersion(id, name)?.error);
  assert.match(fs.readFileSync(file, 'utf8'), /memoking-lock/);
  v.close();
});

test('연 잠긴 메모의 파일이 지워진 뒤 계속 쓰면 다시 만드는 파일도 잠근 채로', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 금고\n\n비밀 글');
  v.lock(id, await newLockSession('사과1234', FAST));
  fs.rmSync(path.join(root, v.get(id).file)); // 다른 기기가 지움
  v.scan();
  v.save(id, '# 금고\n\n비밀 글 이어 씀');
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 1);
  for (const f of files) assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('비밀 글'), `${f} 에 풀린 글 없음`);
  v.close();
});

test('꺼 둔 사이 다른 기기에서 잠근 메모: 켤 때 이 기기의 풀린 버전 기록을 지움', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 일기\n\n오늘 일');
  v.keepVersion(id, '# 일기\n\n어제 일', { force: true });
  assert.ok(v.versions(id).length > 0);
  const file = path.join(root, v.get(id).file);
  v.close();
  const text = fs.readFileSync(file, 'utf8');
  const head = /^---\n[\s\S]*?\n---\n/.exec(text)[0];
  const { lockBody } = await import('../app/js/core/memo-lock.js');
  fs.writeFileSync(file, head + await lockBody('# 일기\n\n오늘 일', 'pc12345', FAST)); // 꺼 둔 사이 PC 가 잠금
  const v2 = new Vault(root);
  v2.open();
  assert.equal(v2.versions(id).length, 0);
  v2.close();
});

test('열지 않은 잠긴 메모를 지우면 그 메모만 쓰던 첨부도 휴지통으로 (머리말의 표로 찾음)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  for (const f of ['secret.png', 'keep.png']) fs.writeFileSync(path.join(root, 'attachments', f), 'png');
  const keep = v.create();
  v.save(keep, '# 다른 메모\n\n![](attachments/keep.png)');
  const id = v.create();
  v.save(id, '# 비밀\n\n![](attachments/secret.png)\n![](attachments/keep.png)');
  v.lock(id, await newLockSession('사과1234', FAST), { keepOpen: false });
  v.trash(id);
  assert.ok(!fs.existsSync(path.join(root, 'attachments', 'secret.png')), '그 메모만 쓰던 첨부는 휴지통으로');
  assert.ok(fs.existsSync(path.join(root, 'attachments', 'keep.png')), '다른 메모도 쓰는 첨부는 남음');
  v.close();
});
