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

test('도우미가 다시 뜨면 붙여 둔 창을 다시 붙이고, 뗀 창은 빼고', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const runs = [];
  const fake = () => {
    const proc = new EventEmitter();
    const lines = [];
    proc.stdin = { write: (l) => lines.push(l.trim()), on: () => {} };
    proc.stdout = new PassThrough();
    proc.kill = () => {};
    runs.push({ proc, lines });
    return proc;
  };
  const pin = new DesktopPin({ platform: 'win32', spawnHelper: fake });
  pin.send('pin', 11);
  pin.send('pin', 22);
  pin.send('unpin', 11);
  assert.deepEqual(runs[0].lines, ['pin 11', 'pin 22', 'unpin 11']);
  runs[0].proc.emit('exit'); // 도우미가 죽음 (오래 돌다가)
  pin.send('bottom', 22);
  assert.deepEqual(runs[1].lines, ['pin 22', 'bottom 22']);
  assert.deepEqual([...pin.pinned], [22]);
});
