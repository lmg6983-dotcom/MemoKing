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

// 실제 Drive 처럼 "바뀐 것" 목록(items)을 주는 가짜 — 동기화가 폴더를 다 훑지 않고 바뀐 것만 반영하는지 본다
class ChangesDrive extends FakeDrive {
  constructor() {
    super();
    this.log = [];
    this.lists = 0;
  }

  note(id) {
    this.log.push(id);
  }

  put(rel, text) {
    super.put(rel, text);
    let cur = 'ROOT';
    for (const p of rel.split('/')) {
      cur = this.find(cur, p).id;
      this.note(cur);
    }
  }

  async listChildren(folderId) {
    this.lists++;
    return super.listChildren(folderId);
  }

  async upload(...args) {
    const r = await super.upload(...args);
    this.note(r.id);
    return r;
  }

  async createFolder(...args) {
    const r = await super.createFolder(...args);
    this.note(r.id);
    return r;
  }

  async trash(id) {
    await super.trash(id);
    this.note(id);
  }

  async changesSince(token) {
    if (!token) return { changed: true, token: 't', items: null };
    const ids = [...new Set(this.log.splice(0))];
    const items = ids.map((id) => {
      const f = this.files.get(id);
      return { id, removed: f.trashed, parents: [f.parent], item: this.item(f) };
    });
    return { changed: items.length > 0, token: 't', items };
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

test('삭제한 것 반영 (이 PC → Drive 휴지통, 다른 기기 → 이 PC)', async () => {
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

test('메모 폴더가 통째로 비면(못 읽음) 적은 수라도 Drive 에서 지우지 않는다', async () => {
  await startFromPhone();
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  await assert.rejects(sync(), SafetyStop);
  assert.ok([...drive.files.values()].every((f) => !f.trashed));
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

test('여러 파일을 한꺼번에 올려도 새 폴더는 하나만 만들고, 진행(살펴보기 → n/총)을 알린다', async () => {
  for (let i = 0; i < 9; i++) await lw(`attachments/새폴더/${i}.png`, `P${i}`);
  // 폴더 만들기가 느려 여러 파일이 같은 폴더를 함께 기다리게
  const make = drive.createFolder.bind(drive);
  let made = 0;
  drive.createFolder = async (p, n) => {
    made++;
    await new Promise((r) => setTimeout(r, 20));
    return make(p, n);
  };
  let inFlight = 0;
  let peak = 0;
  const up = drive.upload.bind(drive);
  drive.upload = async (...a) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return up(...a);
  };
  const seen = [];
  const r = await new SyncEngine({ root: dir, remote: drive, rootId: 'ROOT', state, onProgress: (p) => seen.push(p) }).run();
  assert.equal(r.uploaded, 9);
  assert.equal(made, 2, 'attachments · 새폴더 한 번씩');
  assert.equal([...drive.files.values()].filter((f) => f.folder && f.name === '새폴더').length, 1);
  assert.ok(peak > 1 && peak <= 4, `한꺼번에 4개까지 (${peak})`);
  assert.equal(seen[0].phase, 'scan');
  assert.deepEqual(seen.at(-1), { phase: 'transfer', done: 9, total: 9 });
  for (let i = 0; i < 9; i++) assert.equal(drive.text(`attachments/새폴더/${i}.png`), `P${i}`);
});

test('한 파일이 실패하면 나머지 줄은 하던 것만 끝내고 멈추고, 끝낸 파일의 기준은 남는다', async () => {
  for (let i = 0; i < 6; i++) await lw(`${i}.md`, `m${i}`);
  const up = drive.upload.bind(drive);
  drive.upload = async (p, name, ...a) => {
    if (name === '3.md') throw new Error('Drive 오류');
    return up(p, name, ...a);
  };
  await assert.rejects(sync(), /Drive 오류/);
  assert.ok(!state.files['3.md']);
  assert.ok(Object.keys(state.files).length >= 1);
  drive.upload = up;
  const before = Object.keys(state.files).length;
  const r = await sync();
  assert.equal(r.uploaded, 6 - before, '남은 것만 올린다');
  for (let i = 0; i < 6; i++) assert.equal(drive.text(`${i}.md`), `m${i}`);
});

test('DriveSync: 진행 상황을 상태로 알리고(맞춘 수 moved), 끝나면 지운다', async () => {
  const { DriveSync } = await import('../desktop/drive/drive-sync.js');
  for (let i = 0; i < 3; i++) await lw(`${i}.md`, `m${i}`);
  const auth = { connected: true, grantedFull: false, email: 'a@b.c' };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-drive-state-'));
  const s = new DriveSync({ api: drive, auth, stateDir });
  s.config = { folderId: 'ROOT', folderName: '메모킹 동기화', root: dir };
  const events = [];
  s.on('status', (st) => events.push(structuredClone(st)));
  const st = await s.runOnce();
  fs.rmSync(stateDir, { recursive: true, force: true });
  assert.equal(st.state, 'idle');
  assert.equal(st.progress, null);
  assert.equal(st.moved, 3);
  const prog = events.filter((e) => e.progress).map((e) => e.progress);
  assert.equal(prog[0].phase, 'scan');
  assert.equal(prog.at(-1).done, 3);
  assert.equal(prog.at(-1).total, 3);
  assert.ok(prog.at(-1).since > 0);
});

test('평소 동기화는 Drive 폴더를 다 훑지 않고 바뀐 것만 (이 기기에서 고친 것 · 다른 기기에서 고친 것 · 새 폴더 · 지움)', async () => {
  drive = new ChangesDrive();
  drive.put('회의.md', '# 회의');
  drive.put('_memoking/versions/m1/1.md', 'v1');
  await sync(); // 처음은 다 훑는다
  drive.log.length = 0;
  drive.lists = 0;
  // 이 기기에서만 고침 → Drive 에 물을 것 없이 올리기만
  await lw('회의.md', '# 회의\nPC');
  assert.equal((await sync()).uploaded, 1);
  assert.equal(drive.text('회의.md'), '# 회의\nPC');
  // 다른 기기에서 고치고 새 메모의 이전 버전 폴더(새 폴더 안 새 파일)도 생김
  drive.put('회의.md', '# 회의\n휴대폰');
  drive.put('_memoking/versions/m2/1.md', 'v2');
  const r = await sync();
  assert.equal(r.downloaded, 2);
  assert.equal(lt('회의.md'), '# 회의\n휴대폰');
  assert.equal(lt('_memoking/versions/m2/1.md'), 'v2');
  // 다른 기기에서 지움 → 이 기기에서도
  await drive.trash(drive.path('회의.md').id);
  assert.equal((await sync()).deletedLocal, 1);
  assert.equal(lt('회의.md'), null);
  assert.equal(drive.lists, 0, '폴더 목록을 한 번도 묻지 않음');
  // 다시 올린 것도 다음 차례에 그대로 (자기가 올린 것은 할 일 없음)
  assert.equal((await sync()).skipped, true);
});

test('이름 바꾸기 · 옮기기처럼 기준만으로 모르는 것은 폴더를 다 훑어 맞춘다', async () => {
  drive = new ChangesDrive();
  drive.put('메모.md', '# 메모');
  await sync();
  drive.log.length = 0;
  drive.lists = 0;
  const f = drive.path('메모.md');
  f.name = '새 이름.md';
  drive.note(f.id);
  await sync();
  assert.ok(drive.lists > 0);
  assert.equal(lt('새 이름.md'), '# 메모');
  assert.equal(lt('메모.md'), null);
});

test('동기화 주기: 쉬는 중 1분 · 창을 쓰는 중 10초 · 파일이 오간 뒤 2분은 5초, 창을 다시 볼 때는 5초에 한 번만', async () => {
  const { DriveSync, POLL, pollDelay } = await import('../desktop/drive/drive-sync.js');
  const now = 1_000_000;
  assert.equal(pollDelay({ now, active: false, burstUntil: 0 }), POLL.idle);
  assert.equal(pollDelay({ now, active: true, burstUntil: 0 }), POLL.active);
  assert.equal(pollDelay({ now, active: false, burstUntil: now + 1 }), POLL.burst);
  const sync = new DriveSync({ api: {}, auth: { connected: false }, stateDir: os.tmpdir() });
  let asked = 0;
  sync.request = () => asked++;
  sync.focused();
  sync.focused();
  assert.equal(asked, 1);
  sync.lastFocus -= POLL.focusGap;
  sync.focused();
  assert.equal(asked, 2);
  sync.stop();
});

test('훑는 사이 사라진 파일(메모 창을 닫으며 제목에 맞춰 이름 바꾸기)은 건너뛰고, 동기화는 멈추지 않는다', async () => {
  await startFromPhone();
  await lw('옛 이름.md', '# 새 이름');
  const orig = fs.statSync;
  // 목록에는 있었는데 크기를 재려는 순간 사라짐
  fs.statSync = (p, o) => (String(p).endsWith('옛 이름.md') ? (o?.throwIfNoEntry === false ? undefined : orig(path.join(dir, '없음'), o)) : orig(p, o));
  try {
    const r = await sync();
    assert.equal(r.uploaded, 0, '사라진 파일은 이번 차례에 올리지 않는다');
  } finally {
    fs.statSync = orig;
  }
  assert.equal((await sync()).uploaded, 1, '다음 차례에 맞춰진다');
});

test('메모 폴더가 그대로인 것을 알면(localClean) 폴더를 훑지 않고 Drive 에 바뀐 것만 묻는다', async () => {
  drive = new ChangesDrive();
  await lw('가.md', '하나');
  await sync();
  await sync(); // 방금 올린 것이 Drive 의 바뀐 목록으로 한 번 돌아온다
  const run = (opts) => {
    const engine = new SyncEngine({ root: dir, remote: drive, rootId: 'ROOT', state });
    let walks = 0;
    const walk = engine.walkLocal.bind(engine);
    engine.walkLocal = () => (walks++, walk());
    return engine.run(opts).then((r) => ({ ...r, walks }));
  };
  // 양쪽 다 그대로: 훑지 않는다
  let r = await run({ localClean: true });
  assert.equal(r.skipped, true);
  assert.equal(r.walks, 0);
  // Drive 에서 바뀌면: 훑고 내려받는다 (미리 물은 바뀐 목록을 그대로 쓴다)
  drive.put('나.md', '둘');
  r = await run({ localClean: true });
  assert.equal(r.walks, 1);
  assert.equal(r.downloaded, 1);
  assert.equal(lt('나.md'), '둘');
  await sync();
  // 이 PC 에서 고쳤는데 그대로라고 잘못 알려도, 다 훑는 때(15분)가 되면 올린다
  await lw('가.md', '고침');
  r = await run({ localClean: true });
  assert.equal(r.walks, 0);
  state.lastFullScan = 0;
  r = await run({ localClean: true });
  assert.equal(r.uploaded, 1);
});
