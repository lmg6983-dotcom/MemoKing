import { test } from 'node:test';
import assert from 'node:assert/strict';


test('friendlyTime: 사람이 말하듯', async () => {
  const { friendlyTime } = await import('../app/js/core/format.js');
  const now = new Date(2026, 9, 4, 15, 30).getTime(); // 일요일
  assert.equal(friendlyTime(now - 10_000, now), '방금');
  assert.equal(friendlyTime(now - 5 * 60_000, now), '5분 전');
  assert.equal(friendlyTime(new Date(2026, 9, 4, 9, 5), now), '오전 9:05');
  assert.equal(friendlyTime(new Date(2026, 9, 3, 21, 0), now), '어제 오후 9:00');
  assert.equal(friendlyTime(new Date(2026, 9, 1, 12, 0), now), '목요일');
  assert.equal(friendlyTime(new Date(2026, 1, 2), now), '2월 2일');
  assert.equal(friendlyTime(new Date(2025, 11, 31), now), '25.12.31');
});
