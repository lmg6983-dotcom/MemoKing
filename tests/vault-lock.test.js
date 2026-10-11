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

test('비밀번호가 바뀐 사이 저장해 생긴 잠긴 사본도 첨부 표를 가져 첨부 정리가 멈추지 않음', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  fs.writeFileSync(path.join(root, 'attachments', 'gone.png'), 'png');
  const id = v.create();
  v.save(id, '# 금고\n\n글');
  v.lock(id, await newLockSession('사과1234', FAST));
  const file = path.join(root, v.get(id).file);
  const text = fs.readFileSync(file, 'utf8');
  const head = /^---\n[\s\S]*?\n---\n/.exec(text)[0];
  const { lockBody } = await import('../app/js/core/memo-lock.js');
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(file, head + await lockBody('# 금고\n\n글', 'newpass9', FAST)); // 다른 기기가 비밀번호를 바꿈
  const r = v.save(id, '# 금고\n\n글 더');
  assert.equal(r.copied, true);
  const copy = [...v.entries.values()].find((e) => e.id !== id);
  assert.ok(Array.isArray(copy.meta.extra?.lockRefs), '사본에 첨부 표');
  // 다른 메모가 쓰던 사진을 지우면 정리됨 (모든 첨부를 붙잡지 않음)
  const a = v.create();
  v.save(a, '# 보통\n\n![](attachments/gone.png)');
  v.trash(a);
  assert.ok(!fs.existsSync(path.join(root, 'attachments', 'gone.png')));
  v.close();
});

test('잠긴 메모는 비밀번호로 연 동안만 버전을 되돌림', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 금고\n\n하나');
  v.lock(id, await newLockSession('사과1234', FAST));
  v.save(id, '# 금고\n\n둘');
  v.keepVersion(id, v.entries.get(id).body, { force: true });
  v.save(id, '# 금고\n\n셋');
  const name = v.versionNames(id)[0];
  v.closeLock(id);
  assert.ok(v.restoreVersion(id, name)?.error, '닫힌 잠긴 메모는 되돌리지 않음');
  v.close();
});

test('고정·알림처럼 머리말만 쓰는 사이 다른 기기가 잠갔으면: 잠금을 되돌리지 않고 머리말만 더함', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '# 약속\n\n내일');
  const file = path.join(root, v.get(id).file);
  const text = fs.readFileSync(file, 'utf8');
  const head = /^---\n[\s\S]*?\n---\n/.exec(text)[0];
  const { lockBody } = await import('../app/js/core/memo-lock.js');
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(file, head + await lockBody('# 약속\n\n내일', 'phone999', FAST));
  v.setReminders(id, [{ id: 'r1', kind: 'at', at: new Date(Date.now() + 86_400_000).toISOString(), title: '비밀 이름', alerts: [10], action: 'notify', enabled: true, created: new Date().toISOString(), last: null }]);
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /memoking-lock/, '잠금은 그대로');
  assert.match(after, /reminders:/, '알림은 더해짐');
  assert.equal(v.list().length, 1, '사본을 만들지 않음');
  v.close();
});

test('제목도 숨겨 잠근 메모는 이후 저장에도 제목을 숨김', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  v.open();
  const id = v.create();
  v.save(id, '카드 비번 1234\n\n메모');
  v.lock(id, await newLockSession('사과1234', FAST), { hideTitle: true });
  v.save(id, '카드 비번 1234\n\n메모 더');
  v.finalize(id);
  const file = v.get(id).file;
  assert.ok(!file.includes('1234') && !fs.readFileSync(path.join(root, file), 'utf8').includes('1234'));
  assert.equal(v.list().find((m) => m.id === id).title, '잠긴 메모');
  v.close();
});

test('머리말만 쓰는 사이 들어온 잠금: 그쪽 첨부 표를 받아들이고 일정 이름은 빼고 풀린 버전은 지움', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  const other = new Vault(root, { device: 'phone' });
  try {
    v.open();
    const id = v.create();
    v.save(id, '# 상담\n\n내일 3시');
    v.keepVersion(id, '# 상담\n\n예전', { force: true });
    v.setReminders(id, [{ id: 'r1', kind: 'at', at: new Date(Date.now() + 86_400_000).toISOString(), title: '정신과 상담', alerts: [10], action: 'notify', enabled: true, created: new Date().toISOString(), last: null }]);
    other.open(); // 다른 기기 (같은 폴더)
    await new Promise((r) => setTimeout(r, 20));
    other.lock(id, await newLockSession('phone999', FAST), { keepOpen: false });
    v.setMeta(id, { pinned: true }); // 다시 읽기 전에 고정
    await new Promise((r) => setTimeout(r, 30));
    const text = fs.readFileSync(path.join(root, '상담.md'), 'utf8');
    assert.match(text, /memoking-lock/);
    assert.match(text, /lockRefs:/);
    assert.match(text, /pinned: true/);
    assert.ok(!text.includes('정신과 상담'), '일정 이름 빠짐');
    assert.equal(v.versionNames(id).length, 0, '풀린 버전 지움');
  } finally {
    other.close();
    v.close();
  }
});

test('다른 기기가 제목을 숨겨 잠그며 파일 이름을 바꾼 사이 머리말만 써도 풀린 글로 되살리지 않음', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  const other = new Vault(root, { device: 'phone' });
  try {
    v.open();
    const id = v.create();
    v.save(id, '# 상담\n\n비밀 내용');
    other.open();
    await new Promise((r) => setTimeout(r, 20));
    other.lock(id, await newLockSession('phone999', FAST), { hideTitle: true, keepOpen: false });
    v.setMeta(id, { pinned: true });
    await new Promise((r) => setTimeout(r, 30));
    for (const f of fs.readdirSync(root).filter((n) => n.endsWith('.md'))) {
      assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('비밀 내용'), `${f} 에 풀린 글 없음`);
    }
  } finally {
    other.close();
    v.close();
  }
});

test('휴지통에서 되살린 잠긴 메모는 그 첨부도 함께 돌아옴', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  try {
    v.open();
    fs.writeFileSync(path.join(root, 'attachments', 'a.png'), 'png');
    const id = v.create();
    v.save(id, '# 금고\n\n![](attachments/a.png)');
    v.lock(id, await newLockSession('사과1234', FAST), { keepOpen: false });
    const name = v.trash(id);
    assert.ok(!fs.existsSync(path.join(root, 'attachments', 'a.png')), '지우면 휴지통으로');
    v.restoreTrash(typeof name === 'string' ? name : v.trashList()[0].name);
    assert.ok(fs.existsSync(path.join(root, 'attachments', 'a.png')), '되살리면 돌아옴');
  } finally {
    v.close();
  }
});

test('잠금 풀기 직전 같은 비밀번호로 다른 기기가 고쳤으면: 덮어쓰지 않고 멈춤 (그쪽 글이 사라지지 않게)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  try {
    v.open();
    const id = v.create();
    v.save(id, '# 일기\n\n처음');
    const session = await newLockSession('사과1234', FAST);
    v.lock(id, session);
    const file = path.join(root, v.get(id).file);
    const head = /^---\n[\s\S]*?\n---\n/.exec(fs.readFileSync(file, 'utf8'))[0];
    const { sealBody } = await import('../app/js/core/memo-lock.js');
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, head + sealBody('# 일기\n\n휴대폰에서 고친 글', session));
    assert.equal(v.unlock(id), null);
    const { unsealBody } = await import('../app/js/core/memo-lock.js');
    const body = fs.readFileSync(file, 'utf8').slice(head.length);
    assert.equal(unsealBody(body, session), '# 일기\n\n휴대폰에서 고친 글');
  } finally {
    v.close();
  }
});

test('잠긴 메모를 휴지통에서 영구 삭제하면 그 메모의 첨부도 지움 · 휴지통 목록에 첨부 수', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  try {
    v.open();
    fs.writeFileSync(path.join(root, 'attachments', 's.png'), 'png');
    const id = v.create();
    v.save(id, '# 금고\n\n![](attachments/s.png)');
    v.lock(id, await newLockSession('사과1234', FAST), { keepOpen: false });
    v.trash(id);
    const item = v.trashList()[0];
    assert.equal(item.attachments, 1);
    v.deleteTrash(item.name);
    assert.ok(!fs.existsSync(path.join(root, '_memoking', 'trash', 'attachments', 's.png')));
  } finally {
    v.close();
  }
});

test('파일이 사라진 사이 글을 저장하면 바로 되살리지 않고 다시 읽은 뒤 (이름이 바뀐 잠긴 메모를 풀린 글로 되살리지 않게)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  const other = new Vault(root, { device: 'phone' });
  try {
    v.open();
    const id = v.create();
    v.save(id, '# 장보기\n\n비밀 목록');
    other.open();
    await new Promise((r) => setTimeout(r, 20));
    other.lock(id, await newLockSession('phone999', FAST), { hideTitle: true, keepOpen: false });
    const r = v.save(id, '# 장보기\n\n비밀 목록 더');
    assert.equal(r.retry, true);
    await new Promise((res) => setTimeout(res, 500)); // 다시 읽음 (파일 감시가 0.3초 모았다가 읽음)
    const again = v.save(id, '# 장보기\n\n비밀 목록 더');
    assert.equal(again.refused, true, '다시 읽으니 잠긴 메모 — 저장 거절');
    for (const f of fs.readdirSync(root).filter((n) => n.endsWith('.md'))) {
      assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('비밀 목록'), `${f} 에 풀린 글 없음`);
    }
  } finally {
    other.close();
    v.close();
  }
});

test('머리말만 쓰는 사이 다른 기기가 지운 알림은 되살아나지 않음', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lock-'));
  const v = new Vault(root);
  const other = new Vault(root, { device: 'phone' });
  try {
    v.open();
    const id = v.create();
    v.save(id, '# 약\n\n아침');
    const rem = { id: 'r1', kind: 'at', at: new Date(Date.now() + 86_400_000).toISOString(), alerts: [10], action: 'notify', enabled: true, created: new Date().toISOString(), last: null };
    v.setReminders(id, [rem]);
    other.open();
    await new Promise((r) => setTimeout(r, 20));
    other.save(id, '# 약\n\n아침 저녁');
    other.setReminders(id, []); // 휴대폰이 알림을 지움
    v.setMeta(id, { pinned: true }); // PC 는 아직 모르고 고정만
    const text = fs.readFileSync(path.join(root, v.get(id).file), 'utf8');
    assert.ok(!/reminders:/.test(text), '지운 알림이 되살아나지 않음');
    assert.match(text, /pinned: true/);
    assert.match(text, /아침 저녁/);
  } finally {
    other.close();
    v.close();
  }
});
