import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, LEAVE_ON_TOP } from '../desktop/foreground-watch.js';

test('늘 위 지키기: 도우미가 알린 줄 읽기', () => {
  assert.deepEqual(parseLine('fg 1312420 1 chrome'), { type: 'fg', hwnd: 1312420, topmost: true, name: 'chrome' });
  assert.deepEqual(parseLine('fg 987 0 Whale'), { type: 'fg', hwnd: 987, topmost: false, name: 'whale' });
  assert.deepEqual(parseLine('fg 55 0 '), { type: 'fg', hwnd: 55, topmost: false, name: '' });
  assert.deepEqual(parseLine('lost 4242'), { type: 'lost', hwnd: 4242 });
  assert.equal(parseLine('fg 0 1 x'), null);
  assert.equal(parseLine('경고: 무언가'), null);
  assert.equal(parseLine(''), null);
});

test('캡처 도구·시작 메뉴·작업 관리자가 앞으로 와도 메모킹 창을 올리지 않음', () => {
  for (const name of ['screenclippinghost', 'snippingtool', 'startmenuexperiencehost', 'searchhost', 'taskmgr', 'explorer', 'memoking']) assert.ok(LEAVE_ON_TOP.has(name), name);
  for (const name of ['chrome', 'msedge', 'whale', 'firefox']) assert.ok(!LEAVE_ON_TOP.has(name), name);
});
