import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueForCheck, isSnoozed, progressLabel, normalizeInfo, CHECK_EVERY_MS, SNOOZE_MS } from '../app/js/core/app-update.js';

test('앱 업데이트: 6시간 안에는 조용히 다시 확인하지 않음', () => {
  const now = 1_000_000_000_000;
  assert.equal(dueForCheck(0, now), true);
  assert.equal(dueForCheck(undefined, now), true);
  assert.equal(dueForCheck(now - 1000, now), false);
  assert.equal(dueForCheck(now - CHECK_EVERY_MS, now), true);
  assert.equal(dueForCheck(now + 5000, now), true); // 시계가 뒤로 갔으면 다시
});

test('앱 업데이트: "나중에" 고른 버전은 24시간 숨김, 새 버전은 바로', () => {
  const now = 1_000_000_000_000;
  const snooze = { version: '0.32.0', until: now + SNOOZE_MS };
  assert.equal(isSnoozed(snooze, '0.32.0', now + 1000), true);
  assert.equal(isSnoozed(snooze, '0.32.0', now + SNOOZE_MS + 1), false);
  assert.equal(isSnoozed(snooze, '0.33.0', now), false);
  assert.equal(isSnoozed(null, '0.32.0', now), false);
});

test('앱 업데이트: 받는 중 글', () => {
  assert.equal(progressLabel(25 * 1048576, 50 * 1048576), '50% · 25MB / 50MB');
  assert.equal(progressLabel(3 * 1048576, 0), '3MB');
  assert.equal(progressLabel(0, 0), '');
  assert.match(progressLabel(60 * 1048576, 50 * 1048576), /^100%/);
});

test('앱 업데이트: 확인 결과는 모르는 값이 와도 안전하게', () => {
  assert.deepEqual(normalizeInfo(null), { available: false, current: '', version: '', notes: '', size: 0, sha256: '', apk: '' });
  assert.equal(normalizeInfo({ available: 'yes' }).available, false); // true 일 때만
  assert.equal(normalizeInfo({ available: true, version: '0.32.0', size: '123' }).size, 123);
});
