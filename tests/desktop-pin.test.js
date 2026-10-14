import test from 'node:test';
import assert from 'node:assert/strict';
import { pinCommand, DesktopPin } from '../desktop/desktop-pin.js';

test('바탕화면 붙이기 명령: pin · unpin · bottom 과 창 번호만', () => {
  assert.equal(pinCommand('pin', 1234), 'pin 1234');
  assert.equal(pinCommand('unpin', 1234), 'unpin 1234');
  assert.equal(pinCommand('bottom', 99), 'bottom 99');
  assert.equal(pinCommand('pin', 0), null);
  assert.equal(pinCommand('pin', -5), null);
  assert.equal(pinCommand('rm', 5), null);
  assert.equal(pinCommand('pin', 1.5), null);
});

test('Windows 가 아니면 아무것도 하지 않음', () => {
  const pin = new DesktopPin({ platform: 'linux' });
  assert.equal(pin.available, false);
  assert.equal(pin.send('pin', 1234), false);
  assert.equal(pin.proc, null);
});
