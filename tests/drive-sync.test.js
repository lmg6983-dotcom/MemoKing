// 데스크탑 Google Drive 동기화 엔진 — 가짜 Drive + 실제 임시 폴더로 PC·휴대폰·다른 PC 사이 상황을 확인한다
// (안드로이드 SyncEngineTest.kt 와 같은 시나리오)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SyncEngine, SafetyStop } from '../desktop/drive/sync-engine.js';

class FakeDrive {
  constructor() {
    this.files = new Map([['ROOT', { id: 'ROOT', name: '메모킹', parent: '', folder: true, data: Buffer.alloc(0), modified: 0, trashed: false }]]);
    this.seq = 0;
    this.changed = true;
  }

  md5(b) {
    return createHash('md5').update(b).digest('hex');
  }

  item(f) {
    return { id: f.id, name: f.name, folder: f.folder, md5: f.folder ? null : this.md5(f.data), modified: f.modified, size: f.data.length };
  }

  find(parent, name) {
    return [...this.files.values()].find((f) => f.parent === parent && f.name === name && !f.trashed);
  }

  path(rel) {
    let cur = 'ROOT';
    for (const p of rel.split('/')) {
      const f = this.find(cur, p);
      if (!f) return null;
      cur = f.id;
    }
    return this.files.get(cur);
  }

  put(rel, text) {
    const parts = rel.split('/');
    let cur = 'ROOT';
    for (const p of parts.slice(0, -1)) {
      let f = this.find(cur, p);
      if (!f) {
        f = { id: `d${++this.seq}`, name: p, parent: cur, folder: true, data: Buffer.alloc(0), modified: Date.now(), trashed: false };
        this.files.set(f.id, f);
      }
      cur = f.id;
    }
    let f = this.find(cur, parts.at(-1));
    if (!f) {
      f = { id: `f${++this.seq}`, name: parts.at(-1), parent: cur, folder: false, trashed: false };
      this.files.set(f.id, f);
    }
    f.data = Buffer.from(text);
    f.modified = Date.now();
    this.changed = true;
  }

  text(rel) {
    return this.path(rel)?.data.toString('utf8') ?? null;
  }

  async listChildren(folderId) {
    return [...this.files.values()].filter((f) => f.parent === folderId && !f.trashed).map((f) => this.item(f));
  }

  async download(id, file) {
    fs.writeFileSync(file, this.files.get(id).data);
  }

  async upload(parentId, name, existingId, file) {
    let f = existingId ? this.files.get(existingId) : null;
    if (!f) {
      f = { id: `f${++this.seq}`, name, parent: parentId, folder: false, trashed: false };
      this.files.set(f.id, f);
    }
    f.data = fs.readFileSync(file);
    f.modified = Date.now();
    return this.item(f);
  }

  async createFolder(parentId, name) {
    const f = { id: `d${++this.seq}`, name, parent: parentId, folder: true, data: Buffer.alloc(0), modified: Date.now(), trashed: false };
    this.files.set(f.id, f);
    return this.item(f);
  }

  async trash(id) {
    this.files.get(id).trashed = true;
  }

  async changesSince(token) {
    const changed = this.changed || !token;
    this.changed = false;
    return { changed, token: 't' };
  }
}

let dir;
let drive;
let state;
const sync = () => new SyncEngine({ root: dir, remote: drive, rootId: 'ROOT', state }).run();
const lt = (rel) => {
  const f = path.join(dir, ...rel.split('/'));
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
// 파일 시각이 달라지게 조금 기다렸다가 쓴다
const lw = async (rel, text) => {
  await new Promise((r) => setTimeout(r, 15));
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-drive-test-'));
  drive = new FakeDrive();
  state = {};
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function startFromPhone() {
  drive.put('회의.md', '# 회의\n내용');
  drive.put('attachments/a.png', 'PNG');
  drive.put('_memoking/index.json', '{phone}');
  drive.put('_memoking/README.md', 'guide');
  const r = await sync();
  assert.equal(r.downloaded, 3);
}

test('처음: 모두 내려받기 (index.json 은 기기마다 따로)', async () => {
  await startFromPhone();
  assert.equal(lt('회의.md'), '# 회의\n내용');
  assert.equal(lt('attachments/a.png'), 'PNG');
  assert.equal(lt('_memoking/index.json'), null);
  assert.equal((await sync()).skipped, true);
});

test('"바뀐 것" 목록이 파일을 빠뜨려도: "지금 동기화" · 15분마다 폴더를 처음부터 훑어 내려받기', async () => {
  let now = Date.parse('2026-10-14T09:00:00Z');
  const engine = (opts) => new SyncEngine({ root: dir, remote: drive, rootId: 'ROOT', state, now: () => now }).run(opts);
  drive.put('회의.md', '# 회의');
  await engine();
  drive.put('제미나이 메모.md', '# 제미나이가 쓴 메모');
  drive.changed = false; // Drive 가 바뀐 것 목록에 넣지 않음
  now += 60_000;
  assert.equal((await engine()).skipped, true, '목록만 보면 놓친다');
  assert.equal(lt('제미나이 메모.md'), null);
  const r = await engine({ full: true });
  assert.equal(r.downloaded, 1, '"지금 동기화" 는 폴더를 처음부터');
  assert.equal(lt('제미나이 메모.md'), '# 제미나이가 쓴 메모');
  // 단추를 누르지 않아도 15분이 지나면
  drive.put('또 다른 메모.md', '# 또');
  drive.changed = false;
  now += 60_000;
  assert.equal((await engine()).skipped, true);
  now += 15 * 60_000;
  assert.equal((await engine()).downloaded, 1);
  assert.equal(lt('또 다른 메모.md'), '# 또');
});

test('이 PC 에서 고친 것·새 메모·새 폴더 올리기', async () => {
  await startFromPhone();
  await lw('PC.md', '# PC');
  await lw('회의.md', '# 회의\nPC에서 고침');
  await lw('_memoking/index.json', '{pc}');
  const r = await sync();
  assert.equal(r.uploaded, 2);
  assert.equal(drive.text('PC.md'), '# PC');
  assert.equal(drive.text('회의.md'), '# 회의\nPC에서 고침');
  assert.equal(drive.text('_memoking/index.json'), '{phone}');
  await lw('업무/계획.md', 'plan');
  await sync();
  assert.equal(drive.text('업무/계획.md'), 'plan');
});

test('다른 기기에서 고친 것 내려받기', async () => {
  await startFromPhone();
  drive.put('회의.md', '# 회의\n휴대폰에서 고침');
  const r = await sync();
  assert.equal(r.localChanged, true);
  assert.equal(lt('회의.md'), '# 회의\n휴대폰에서 고침');
});

test('양쪽에서 고치면 Drive 것을 남기고 이 PC 것은 사본으로', async () => {
  await startFromPhone();
  drive.put('회의.md', '# 회의\n휴대폰 버전');
  await lw('회의.md', '# 회의\nPC 버전');
  const r = await sync();
  assert.equal(lt('회의.md'), '# 회의\n휴대폰 버전');
  const copy = fs.readdirSync(dir).find((f) => f.startsWith('회의 (PC 충돌'));
  assert.ok(copy);
  assert.equal(lt(copy), '# 회의\nPC 버전');
  assert.equal(drive.text(copy), '# 회의\nPC 버전');
  assert.equal(r.conflicts.length, 1);
  drive.put('같음.md', 'same');
  await lw('같음.md', 'same');
  assert.equal((await sync()).conflicts.length, 0);
});

test('지운 것 반영 (이 PC → Drive 휴지통, 다른 기기 → 이 PC)', async () => {
  await startFromPhone();
  await lw('PC.md', '# PC');
  await sync();
  fs.rmSync(path.join(dir, 'PC.md'));
  assert.equal((await sync()).deletedRemote, 1);
  assert.equal(drive.path('PC.md'), null);
  drive.path('회의.md').trashed = true;
  drive.put('_memoking/trash/회의 (20261003-120000).md', '# 회의\n내용');
  await sync();
  assert.equal(lt('회의.md'), null);
  assert.equal(lt('_memoking/trash/회의 (20261003-120000).md'), '# 회의\n내용');
});

test('링크 미리보기 모음은 합친다', async () => {
  await startFromPhone();
  drive.put('_memoking/link-previews.json', '{"a":1}');
  await sync();
  drive.put('_memoking/link-previews.json', '{"a":1,"phone":2}');
  await lw('_memoking/link-previews.json', '{"a":1,"pc":3}');
  await sync();
  const merged = JSON.parse(lt('_memoking/link-previews.json'));
  assert.ok(merged.phone && merged.pc);
  assert.ok(JSON.parse(drive.text('_memoking/link-previews.json')).pc);
});

test('외부 앱 연동을 꺼 권한이 줄면(keepMissing): 목록에서 안 보이게 된 다른 앱 메모를 지우지 않고 다시 올린다', async () => {
  await startFromPhone();
  for (let i = 1; i <= 12; i++) drive.put(`제미나이/${i}.md`, `g${i}`); // 다른 앱(Gemini)이 넣은 메모
  drive.changed = true;
  await sync();
  assert.equal(lt('제미나이/1.md'), 'g1');
  // drive.file 권한에는 다른 앱이 만든 파일이 보이지 않는다
  for (const [id, f] of drive.files) if (/^\d+\.md$/.test(f.name)) drive.files.delete(id);
  drive.changed = true;
  state.keepMissing = true; // drive-sync.js 가 권한이 Drive 전체 → drive.file 로 준 것을 보고 켬
  const r = await sync();
  assert.equal(r.deletedLocal, 0);
  assert.equal(lt('제미나이/12.md'), 'g12');
  assert.equal(drive.text('제미나이/12.md'), 'g12'); // 메모킹 파일로 다시 올림
  assert.equal(state.keepMissing, undefined); // 한 번 다 끝내면 보통대로
});

test('Drive 에서 한꺼번에 사라지면 멈추고 이 PC 파일은 그대로', async () => {
  await startFromPhone();
  for (let i = 1; i <= 30; i++) await lw(`많은/${i}.md`, `x${i}`);
  await sync();
  for (const f of drive.files.values()) if (!f.folder) f.trashed = true;
  drive.changed = true;
  await assert.rejects(sync(), SafetyStop);
  assert.equal(lt('많은/1.md'), 'x1');
});

test('PC 메모 폴더 옮기기: Google Drive 앱 폴더의 메모·첨부를 문서\\메모킹 으로 복사 (원래 폴더는 그대로, 있는 파일은 두기)', async () => {
  const { copyVault } = await import('../desktop/drive/drive-sync.js');
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-from-'));
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-to-'));
  fs.mkdirSync(path.join(from, 'attachments'));
  fs.mkdirSync(path.join(from, '업무'));
  fs.mkdirSync(path.join(from, '.hidden'));
  fs.writeFileSync(path.join(from, '회의.md'), '# 회의');
  fs.writeFileSync(path.join(from, '업무', '보고.md'), '# 보고');
  fs.writeFileSync(path.join(from, 'attachments', 'a.png'), 'png');
  fs.writeFileSync(path.join(from, '.hidden', 'x.md'), 'x');
  fs.writeFileSync(path.join(from, '~$임시.md'), 'tmp');
  const old = new Date('2026-01-02T03:04:05Z');
  fs.utimesSync(path.join(from, '회의.md'), old, old);
  fs.writeFileSync(path.join(to, '보존.md'), '# 이미 있던 것');
  fs.mkdirSync(path.join(to, '업무'));
  fs.writeFileSync(path.join(to, '업무', '보고.md'), '# 새쪽 것');
  const n = copyVault(from, to);
  assert.equal(n, 2);
  assert.equal(fs.readFileSync(path.join(to, '회의.md'), 'utf8'), '# 회의');
  assert.equal(fs.readFileSync(path.join(to, 'attachments', 'a.png'), 'utf8'), 'png');
  assert.equal(fs.readFileSync(path.join(to, '업무', '보고.md'), 'utf8'), '# 새쪽 것');
  assert.ok(!fs.existsSync(path.join(to, '.hidden')) && !fs.existsSync(path.join(to, '~$임시.md')));
  assert.equal(fs.statSync(path.join(to, '회의.md')).mtimeMs, old.getTime()); // 고친 시각 그대로
  assert.ok(fs.existsSync(path.join(from, '회의.md'))); // 원래 폴더는 그대로
  assert.equal(copyVault(from, from), 0);
});

test('메모 폴더가 Google Drive 데스크탑 앱 폴더면 메모킹 동기화를 멈춘다 (두 동기화가 메모를 끝없이 늘리지 않게)', async () => {
  const { DriveSync, DOUBLE_SYNC } = await import('../desktop/drive/drive-sync.js');
  let calls = 0;
  const api = new Proxy({}, { get: () => async () => { calls++; return { changed: true, token: 't' }; } });
  const sync = new DriveSync({ api, auth: { connected: true }, stateDir: dir });
  sync.configure({ folderId: 'F', folderName: '메모킹 동기화', root: 'G:\\내 드라이브\\메모킹 동기화' });
  assert.equal(sync.blocked, true);
  assert.equal(sync.status.state, 'error');
  assert.equal(sync.status.error, DOUBLE_SYNC);
  await sync.run({ full: true });
  assert.equal(calls, 0, 'Drive 에 아무것도 묻지 않음');
  sync.configure({ folderId: 'F', folderName: '메모킹 동기화', root: path.join(dir, 'vault') });
  assert.equal(sync.blocked, false);
  sync.stop();
});

test('양쪽에서 엇갈린 메모가 한 번에 너무 많으면 사본을 더 만들지 않고 멈춘다', async () => {
  for (let i = 0; i < 25; i++) drive.put(`m${i}.md`, 'a');
  await sync();
  await new Promise((r) => setTimeout(r, 15));
  for (let i = 0; i < 25; i++) {
    drive.put(`m${i}.md`, 'drive');
    fs.writeFileSync(path.join(dir, `m${i}.md`), 'pc');
  }
  await assert.rejects(sync(), SafetyStop);
  const copies = fs.readdirSync(dir).filter((n) => n.includes('PC 충돌'));
  assert.equal(copies.length, 0); // 건드리기 전에 멈춘다 (도중에 멈추면 다음 차례마다 20개씩 또 생긴다)
});
