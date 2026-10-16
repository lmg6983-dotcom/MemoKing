import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateErrorText, isSnoozed, notesText, SNOOZE_MS } from '../desktop/updater.js';

test('업데이트: 오류 안내 (네트워크 · 서명 · latest.yml 없음) — 지금 버전은 그대로', () => {
  assert.match(updateErrorText(new Error('net::ERR_INTERNET_DISCONNECTED')), /인터넷/);
  assert.match(updateErrorText(new Error('New version is not signed by the application owner: publisherNames: X')), /서명/);
  assert.match(updateErrorText(new Error('Cannot find latest.yml in the latest release artifacts (HttpError: 404)')), /찾지 못했어요/);
  assert.match(updateErrorText(new Error('뭔가')), /그대로 쓸 수 있어요/);
});

test('업데이트: "나중에" 고른 버전은 24시간만 숨김 · 다른 버전은 바로', () => {
  const now = 1_000_000;
  const snooze = { version: '0.39.0', until: now + SNOOZE_MS };
  assert.equal(isSnoozed(snooze, '0.39.0', now + 1000), true);
  assert.equal(isSnoozed(snooze, '0.39.0', now + SNOOZE_MS + 1), false);
  assert.equal(isSnoozed(snooze, '0.40.0', now), false);
  assert.equal(isSnoozed(null, '0.39.0', now), false);
});

test('업데이트: 바뀐 점 글 — HTML 은 벗기고 여러 버전은 이어 붙임', () => {
  assert.equal(notesText('<p>공유 되살림</p>\n<ul><li>스택 빨라짐</li></ul>'), '공유 되살림\n스택 빨라짐');
  assert.equal(notesText([{ version: '1', note: 'A' }, { version: '2', note: 'B' }]), 'A\nB');
  assert.equal(notesText(null), '');
  assert.equal(notesText('<p>표 &amp; 공유 &quot;메일&quot;</p>'), '표 & 공유 "메일"');
});

test('업데이트: 흐름 — 확인 → 새 버전 알림 → 받기 진행률 → 다 받음 → 재시작 전에 저장', async () => {
  const { EventEmitter } = await import('node:events');
  const { Updater } = await import('../desktop/updater.js');
  const fake = new EventEmitter();
  let installed = null;
  fake.checkForUpdates = async () => { fake.emit('checking-for-update'); fake.emit('update-available', { version: '0.39.0', releaseNotes: '<p>새 기능</p>' }); };
  fake.downloadUpdate = async () => { fake.emit('download-progress', { percent: 42.4 }); fake.emit('update-downloaded', { version: '0.39.0' }); };
  fake.quitAndInstall = (silent, run) => { installed = [silent, run]; };
  const sent = [];
  const settings = {};
  let saved = false;
  const u = new Updater({ packaged: true, settings, saveSettings: () => {}, send: (c, p) => { sent.push([c, { ...p }]); return true; }, beforeInstall: () => { saved = true; }, loadUpdater: async () => fake });
  const dev = new Updater({ packaged: false, settings: {}, send: () => true });
  assert.equal((await dev.check()).status, 'dev', '개발 중에는 확인하지 않음');
  await u.start();
  u.stop();
  assert.equal(fake.autoDownload, false);
  assert.equal(fake.autoInstallOnAppQuit, true);
  await u.check({ manual: true });
  assert.ok(sent.some(([c, p]) => c === 'update:available' && p.version === '0.39.0' && p.notes === '새 기능'));
  await u.download();
  assert.ok(sent.some(([c, p]) => c === 'update:state' && p.status === 'downloading' && p.percent === 42));
  assert.ok(sent.some(([c, p]) => c === 'update:ready' && p.version === '0.39.0' && p.notes === '새 기능'));
  assert.equal(await u.installNow(), true);
  assert.equal(saved, true, '재시작 전에 메모 저장');
  assert.deepEqual(installed, [true, true]);
  // "나중에": 그 버전을 24시간 숨김
  u.later();
  assert.equal(settings.updateSnooze.version, '0.39.0');
});
