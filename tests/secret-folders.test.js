import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SecretFolders, sealText, openText, sealBytes, openBytes, newFolderRecord, unlockRecord, parseSecretId, secretMemoId,
  sealMemoInto, openMemoOut, secretFiles, SECRET_DIR,
} from '../app/js/core/secret-folders.js';
import { extractAttachments } from '../app/js/core/memo-file.js';

// 메모리 속 파일들 (플랫폼 fs 자리)
function memFs() {
  const files = new Map();
  const norm = (p) => String(p).replace(/\/+$/, '');
  return {
    files,
    async list(dir) {
      const d = `${norm(dir)}/`;
      const names = new Map();
      for (const k of files.keys()) {
        if (!k.startsWith(d)) continue;
        const rest = k.slice(d.length);
        const i = rest.indexOf('/');
        names.set(i < 0 ? rest : rest.slice(0, i), i >= 0);
      }
      return [...names].map(([name, dir]) => ({ name, dir }));
    },
    async readText(p) {
      if (!files.has(p)) throw new Error('없음');
      return new TextDecoder().decode(files.get(p));
    },
    async writeText(p, t) { files.set(p, new TextEncoder().encode(t)); },
    async readBytes(p) {
      if (!files.has(p)) throw new Error('없음');
      return files.get(p);
    },
    async writeBytes(p, b) { files.set(p, new Uint8Array(b)); },
    async remove(p) { files.delete(p); },
  };
}

const FAST = { iterations: 1000 };

test('비밀 폴더: 글 · 바이트 잠그고 풀기 (열쇠가 다르면 null)', async () => {
  const { key } = await newFolderRecord('일기', '비밀번호1', FAST);
  const { key: other } = await newFolderRecord('일기', '비밀번호1', FAST); // 소금이 달라 다른 열쇠
  const s = sealText('안녕 비밀', key);
  assert.match(s, /^mks1\./);
  assert.ok(!s.includes('안녕'));
  assert.equal(openText(s, key), '안녕 비밀');
  assert.equal(openText(s, other), null);
  assert.notEqual(sealText('같은 글', key), sealText('같은 글', key)); // 저장마다 새 IV
  const b = sealBytes(new Uint8Array([1, 2, 3, 250]), key);
  assert.deepEqual([...openBytes(b, key)], [1, 2, 3, 250]);
  assert.equal(openBytes(b, other), null);
  assert.equal(openBytes(new Uint8Array([1, 2, 3]), key), null);
});

test('비밀 폴더: 비밀번호가 다르면 열리지 않고, 이름도 파일에 드러나지 않는다', async () => {
  const { record } = await newFolderRecord('가족 사진', 'abcd1234', FAST);
  assert.ok(!JSON.stringify(record).includes('가족'));
  await assert.rejects(unlockRecord(record, 'nope1234'), /비밀번호가 달라요/);
  const { name } = await unlockRecord(record, 'abcd1234');
  assert.equal(name, '가족 사진');
  await assert.rejects(unlockRecord({ ...record, n: 10 ** 9 }, 'abcd1234'), /망가졌어요/); // 반복 횟수를 믿지 않는다
  await assert.rejects(newFolderRecord('x', '123', FAST), /4자 이상/);
  await assert.rejects(newFolderRecord('_memoking', 'abcd1234', FAST), /폴더 이름/);
});

test('비밀 폴더: 폴더마다 비밀번호가 따로 — 맞는 폴더만 열린다', async () => {
  const fs = memFs();
  const store = new SecretFolders(fs);
  const a = await store.create('일기', 'aaaa1111', FAST);
  const b = await store.create('계좌', 'bbbb2222', FAST);
  store.lockAll();
  assert.deepEqual(store.opened(), []);
  const opened = await store.unlockWith('bbbb2222');
  assert.deepEqual(opened.map((o) => o.name), ['계좌']);
  assert.deepEqual(store.opened().map((o) => o.fid), [b.fid]);
  await assert.rejects(store.unlockWith('zzzz9999'), /비밀번호가 달라요/);
  await store.unlockWith('aaaa1111');
  assert.deepEqual(store.opened().map((o) => o.name), ['계좌', '일기']);
  store.lock(a.fid);
  await assert.rejects(store.memos(a.fid), /잠겨 있어요/);
  // 파일 이름 · 내용 어디에도 폴더 이름이 없다
  for (const [p, v] of fs.files) assert.ok(!p.includes('일기') && !new TextDecoder().decode(v).includes('일기'), p);
});

test('비밀 메모: 저장 · 목록 · 읽기 — 파일에는 제목 · 본문 · 태그가 없다', async () => {
  const fs = memFs();
  const store = new SecretFolders(fs);
  const { fid } = await store.create('일기', 'aaaa1111', FAST);
  const meta = { id: 'm1', created: '2026-11-22T10:00:00', updated: '2026-11-22T10:00:00', color: 'pink', tags: [], reminders: [] };
  const mid = await store.write(fid, null, meta, '# 첫 고백\n\n오늘 일기 #비밀\n');
  const list = await store.memos(fid);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '첫 고백');
  assert.equal(list[0].color, 'pink');
  assert.equal(list[0].id, secretMemoId(fid, mid));
  assert.deepEqual(parseSecretId(list[0].id), { fid, mid });
  assert.equal(parseSecretId('abc'), null);
  for (const [p, v] of fs.files) {
    const t = new TextDecoder().decode(v);
    assert.ok(!/고백|일기|비밀|pink/.test(t), `${p} 에 드러남`);
    assert.ok(p.startsWith(`${SECRET_DIR}/`));
  }
  const doc = await store.read(fid, mid);
  assert.match(doc.body, /오늘 일기/);
});

test('비밀 메모: 일정은 때만 잠기지 않는 파일에 (이름 없이) — 잠겨 있어도 알릴 수 있게', async () => {
  const fs = memFs();
  const store = new SecretFolders(fs);
  const { fid } = await store.create('일정', 'aaaa1111', FAST);
  const reminders = [
    { id: 'r1', kind: 'at', at: '2026-12-01T09:00:00', title: '병원 예약', enabled: true },
    { id: 'r2', kind: 'at', at: '2026-12-02T09:00:00', title: '꺼 둔 것', enabled: false },
  ];
  const mid = await store.write(fid, null, { id: 'x', reminders }, '# 병원\n');
  store.lockAll();
  const alarms = await store.alarms();
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].id, secretMemoId(fid, mid));
  assert.deepEqual(alarms[0].reminders.map((r) => r.at), ['2026-12-01T09:00:00']);
  assert.ok(!JSON.stringify(alarms).includes('병원'));
  // 일정을 지우면 알림 파일도 사라진다
  await store.unlockWith('aaaa1111');
  await store.write(fid, mid, { id: 'x', reminders: [] }, '# 병원\n');
  assert.deepEqual(await store.alarms(), []);
});

test('비밀 메모: 첨부도 잠근다 — 옮겨 넣기 · 꺼내기 · 지우기', async () => {
  const fs = memFs();
  const store = new SecretFolders(fs);
  const { fid } = await store.create('사진', 'aaaa1111', FAST);
  const photo = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const body = '# 여권\n\n![](attachments/20261122-passport.png)\n\n[스캔.pdf](attachments/scan.pdf)\n';
  const disk = { 'attachments/20261122-passport.png': photo, 'attachments/scan.pdf': new Uint8Array([37, 80, 68, 70]) };
  const { mid, body: sealedBody, moved } = await sealMemoInto(store, fid, { id: 'a' }, body, async (src) => disk[src] ?? null);
  assert.deepEqual(moved.sort(), Object.keys(disk).sort());
  assert.equal(secretFiles(sealedBody).length, 2);
  assert.ok(!sealedBody.includes('attachments/'));
  assert.deepEqual(extractAttachments(sealedBody), secretFiles(sealedBody)); // 파일 칩(링크)도 첨부로
  const img = secretFiles(sealedBody).find((s) => s.endsWith('.png'));
  assert.deepEqual([...await store.fileBytes(fid, img)], [...photo]);
  // 디스크의 잠근 첨부에는 원래 바이트가 없다
  const raw = [...fs.files].find(([p]) => p.includes('/files/') && p.includes('.png'))[1];
  assert.ok(!Buffer.from(raw).includes(Buffer.from(photo)));
  // 꺼내기: 풀어서 attachments/ 로
  const written = {};
  const out = await openMemoOut(store, fid, mid, async (bytes, ext) => {
    const src = `attachments/out-${Object.keys(written).length}.${ext}`;
    written[src] = bytes;
    return src;
  });
  assert.match(out.body, /attachments\/out-\d\.png/);
  assert.deepEqual([...Object.values(written).find((b) => b[0] === 137)], [...photo]);
  // 지우면 그 메모만 쓰던 잠근 첨부도 함께
  await store.remove(fid, mid);
  assert.equal([...fs.files.keys()].filter((p) => p.includes('/files/')).length, 0);
  assert.deepEqual(await store.memos(fid), []);
});

test('비밀 폴더: 이름 바꾸기 · 통째로 지우기', async () => {
  const fs = memFs();
  const store = new SecretFolders(fs);
  const { fid } = await store.create('옛 이름', 'aaaa1111', FAST);
  await store.write(fid, null, { id: 'q' }, '# a\n');
  await store.rename(fid, '새 이름');
  store.lockAll();
  const [o] = await store.unlockWith('aaaa1111');
  assert.equal(o.name, '새 이름');
  await store.removeFolder(fid);
  assert.equal(fs.files.size, 0);
  assert.deepEqual(store.opened(), []);
});
