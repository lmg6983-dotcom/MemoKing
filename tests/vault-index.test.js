import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../desktop/vault.js';

const readIndex = (v) => (fs.existsSync(v.indexFile) ? JSON.parse(fs.readFileSync(v.indexFile, 'utf8')) : { memos: [] });

test('색인: 작업 스레드에서 만들어 쓰고, 끌 때 남은 것은 바로 (잠근 글이 색인에 남지 않게)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-index-'));
  const v = new Vault(dir);
  v.watch = () => {};
  v.open();
  const id = v.create().id;
  v.save(id, '# 장보기\n\n우유 사기');
  v.writeIndex(); // 기다리지 않고 지금 (작업 스레드 — 열 때 만들던 것이 끝나면 한 번 더)
  const summary = () => readIndex(v).memos.find((m) => m.id === id)?.summary;
  while (summary() !== '우유 사기') await new Promise((resolve) => v.once('indexed', resolve));
  assert.equal(summary(), '우유 사기');
  v.save(id, '# 장보기\n\n계란 사기'); // 1.5초 뒤 색인 예정 — 그 전에 끈다
  v.close();
  assert.equal(summary(), '계란 사기');
  fs.rmSync(dir, { recursive: true, force: true });
});
