import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../desktop/vault.js';
import {
  versionName, versionTime, shouldKeepVersion, versionsToPrune, safeVersionId, VERSION_GAP_MS, MAX_VERSIONS } from '../app/js/core/versions.js';

test('버전 이름 ↔ 시각', () => {
  const d = new Date(2026, 9, 8, 15, 30, 5);
  assert.equal(versionName(d), '20261008-153005.md');
  assert.equal(versionTime('20261008-153005.md'), d.getTime());
  assert.equal(versionTime('20261008-153005-2.md'), d.getTime());
  assert.equal(versionTime('../x.md'), null);
  assert.equal(safeVersionId('../etc'), null);
  assert.equal(safeVersionId('3f2a-b9'), '3f2a-b9');
});

test('버전을 남길 때: 처음 · 10분이 지났을 때 · 강제, 빈 내용·같은 내용은 아님', () => {
  const now = Date.now();
  assert.equal(shouldKeepVersion('# a', null, { now }), true);
  assert.equal(shouldKeepVersion('', null, { now }), false);
  assert.equal(shouldKeepVersion('# a', { at: now - 1000, body: '# b' }, { now }), false);
  assert.equal(shouldKeepVersion('# a', { at: now - VERSION_GAP_MS, body: '# b' }, { now }), true);
  assert.equal(shouldKeepVersion('# a', { at: now - 1000, body: '# b' }, { now, force: true }), true);
  assert.equal(shouldKeepVersion('# a', { at: now - VERSION_GAP_MS, body: '# a' }, { now, force: true }), false);
});

test('오래된 버전 정리: 최근 30개, 30일 지난 것은 빼되 최근 3개는 남김', () => {
  const now = new Date(2026, 9, 8).getTime();
  const day = 86_400_000;
  const old = [0, 1, 2, 3, 4].map((i) => versionName(new Date(now - (40 + i) * day)));
  assert.deepEqual(versionsToPrune(old, now), old.slice(3));
  const many = Array.from({ length: MAX_VERSIONS + 2 }, (_, i) => versionName(new Date(now - i * 60_000)));
  assert.deepEqual(versionsToPrune(many, now), many.slice(MAX_VERSIONS));
});

test('저장하면 덮어쓰기 전 내용이 버전으로 남고, 되돌리면 지금 내용도 남는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-versions-'));
  const vault = new Vault(dir);
  vault.open();
  try {
    const id = vault.import({ body: '# 회의\n\n처음' });
    vault.save(id, '# 회의\n\n두 번째');
    vault.save(id, '# 회의\n\n세 번째'); // 10분 안이라 새 버전 없음
    let versions = vault.versions(id);
    assert.equal(versions.length, 1);
    assert.match(versions[0].preview, /처음/);

    const restored = vault.restoreVersion(id, versions[0].name);
    assert.match(restored.body, /처음/);
    assert.match(fs.readFileSync(path.join(dir, vault.entries.get(id).file), 'utf8'), /처음/);
    versions = vault.versions(id);
    assert.equal(versions.length, 2);
    assert.ok(versions.some((v) => /세 번째/.test(v.preview)), '되돌리기 전 내용도 버전에');

    assert.equal(vault.version(id, '../../x.md'), null);
    assert.equal(vault.restoreVersion(id, 'nope.md'), null);
    // 버전 폴더의 .md 는 메모로 읽히지 않는다
    vault.scan({ silent: true });
    assert.equal(vault.list().length, 1);
  } finally {
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
