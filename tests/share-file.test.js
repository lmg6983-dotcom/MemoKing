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

test('공유: Google Drive 링크 — 기억한 공유 폴더가 살아 있으면 그대로, 휴지통이면 같은 이름 폴더를 찾고, 없으면 새로', async () => {
  const log = [];
  let saved = null;
  const folders = { F1: { trashed: false }, OLD: { trashed: true } };
  let existing = null;
  const api = {
    alive: async (id) => Boolean(folders[id]) && !folders[id].trashed,
    findFolder: async () => existing,
    createFolder: async (parent, name) => { log.push(`new ${parent} ${name}`); folders.N = { trashed: false }; return { id: 'N' }; },
    upload: async (folder, name) => { log.push(`up ${folder} ${name}`); return { id: 'X' }; },
    shareLink: async (id) => `https://drive.google.com/file/d/${id}/view`,
  };
  const store = (folderId) => ({ folderId, saveFolderId: (id) => { saved = id; } });
  assert.equal(await driveShareLink(api, store('F1'), '/tmp/a.csv', 'a.csv'), 'https://drive.google.com/file/d/X/view');
  assert.deepEqual(log, ['up F1 a.csv']);
  log.length = 0;
  existing = { id: 'F1' }; // 휴지통 폴더 대신 같은 이름의 다른 폴더
  await driveShareLink(api, store('OLD'), '/tmp/a.csv', 'a.csv');
  assert.deepEqual(log, ['up F1 a.csv']);
  assert.equal(saved, 'F1');
  log.length = 0;
  existing = null;
  await driveShareLink(api, store(''), '/tmp/a.csv', 'a.csv');
  assert.deepEqual(log, ['new root 메모킹 공유', 'up N a.csv']);
  assert.equal(saved, 'N');
});
