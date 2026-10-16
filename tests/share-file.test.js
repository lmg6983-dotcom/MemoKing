import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLocalSend, openLocalSend, runHelper } from '../desktop/share-file.js';
import { driveShareLink } from '../desktop/share-drive.js';

test('공유: LocalSend 찾기 (설치판 · 사용자 설치), 없으면 missing', async () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  const at = 'C:\\Users\\me\\AppData\\Local\\Programs\\LocalSend\\localsend_app.exe';
  assert.equal(findLocalSend({ env, platform: 'win32', exists: (p) => p === at }), at);
  assert.equal(findLocalSend({ env, platform: 'win32', exists: () => false }), null);
  assert.equal(findLocalSend({ env, platform: 'linux', exists: () => true }), null);
  assert.equal(await openLocalSend('a.pdf', { exe: null }), 'missing');
  const calls = [];
  const fake = (exe, args) => { calls.push([exe, args]); return { on() {}, unref() {} }; };
  assert.equal(await openLocalSend('C:\\a.pdf', { exe: at, spawnApp: fake }), 'ok');
  assert.deepEqual(calls, [[at, ['C:\\a.pdf']]]);
});

test('공유: Windows 가 아니면 도우미를 띄우지 않음 · 도우미 첫 줄로 판정', async () => {
  assert.equal(await runHelper('', {}, { platform: 'linux' }), 'err unavailable');
  const { EventEmitter } = await import('node:events');
  const fake = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    setTimeout(() => p.stdout.emit('data', 'err COMException: 막힘\r\n'), 5);
    return p;
  };
  assert.equal(await runHelper('x', {}, { platform: 'win32', spawnHelper: fake }), 'err COMException: 막힘');
});

test('공유: Google Drive 링크 — 공유 폴더를 한 번 만들어 기억, 지워졌으면 다시', async () => {
  const log = [];
  let saved = null;
  let gone = true;
  const api = {
    createFolder: async (parent, name) => { log.push(`folder ${parent} ${name}`); return { id: `F${log.length}` }; },
    upload: async (folder, name) => {
      log.push(`up ${folder} ${name}`);
      if (folder === 'OLD' && gone) { gone = false; const e = new Error('없음'); e.status = 404; throw e; }
      return { id: 'X' };
    },
    shareLink: async (id) => `https://drive.google.com/file/d/${id}/view`,
  };
  const link = await driveShareLink(api, { folderId: '', saveFolderId: (id) => { saved = id; } }, '/tmp/a.csv', 'a.csv');
  assert.equal(link, 'https://drive.google.com/file/d/X/view');
  assert.equal(saved, 'F1');
  log.length = 0;
  await driveShareLink(api, { folderId: 'OLD', saveFolderId: (id) => { saved = id; } }, '/tmp/a.csv', 'a.csv');
  assert.deepEqual(log, ['up OLD a.csv', 'folder root 메모킹 공유', 'up F2 a.csv']);
  assert.equal(saved, 'F2');
});
