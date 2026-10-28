import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceleratorFromKey, displayAccelerator, isValidAccelerator, normalizeShortcuts, withShortcuts, DEFAULT_SHORTCUTS } from '../app/js/core/accelerators.js';

const ev = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('누른 키 → 단축키', () => {
  assert.deepEqual(acceleratorFromKey(ev('KeyM', { ctrlKey: true, altKey: true })), { acc: 'Control+Alt+M' });
  assert.deepEqual(acceleratorFromKey(ev('Space', { ctrlKey: true, shiftKey: true })), { acc: 'Control+Shift+Space' });
  assert.deepEqual(acceleratorFromKey(ev('F9', { metaKey: true })), { acc: 'Super+F9' });
  assert.deepEqual(acceleratorFromKey(ev('Digit1', { altKey: true })), { acc: 'Alt+1' });
  assert.deepEqual(acceleratorFromKey(ev('ControlLeft', { ctrlKey: true })), { pending: true });
});

test('쓸 수 없는 조합은 이유와 함께', () => {
  assert.ok(acceleratorFromKey(ev('KeyM')).error, '수식 키 없음');
  assert.ok(acceleratorFromKey(ev('KeyM', { shiftKey: true })).error, 'Shift 만');
  assert.ok(acceleratorFromKey(ev('KeyC', { ctrlKey: true })).error, '복사 키');
  assert.ok(acceleratorFromKey(ev('Enter', { ctrlKey: true })).error, '지원 안 하는 키');
});

test('보이기 · 검사 · 정리', () => {
  assert.equal(displayAccelerator('Control+Alt+Space'), 'Ctrl+Alt+Space');
  assert.equal(displayAccelerator('Super+Shift+M'), 'Win+Shift+M');
  assert.equal(isValidAccelerator('Control+Alt+C'), true);
  assert.equal(isValidAccelerator('Shift+C'), false);
  assert.equal(isValidAccelerator('Control+C'), false);
  assert.equal(isValidAccelerator('Control+Bogus'), false);
  assert.deepEqual(normalizeShortcuts(undefined), DEFAULT_SHORTCUTS);
  assert.deepEqual(normalizeShortcuts({ quickMemo: 'Control+Alt+M', magic: 'nope' }), { quickMemo: 'Control+Alt+M', magic: 'Control+Alt+Space', list: 'Control+Alt+`' });
  assert.notEqual(normalizeShortcuts({ quickMemo: 'Control+Alt+M', magic: 'Control+Alt+M' }).magic, 'Control+Alt+M');
});

test('안내 글의 단축키를 지금 키로 (서로 맞바꿔도 한 번만)', () => {
  assert.equal(withShortcuts('Ctrl+Alt+C 두 번, Ctrl+Alt+Space', { quickMemo: 'Control+Alt+M', magic: 'Alt+Space' }), 'Ctrl+Alt+M 두 번, Alt+Space');
  assert.equal(withShortcuts('Ctrl+Alt+C / Ctrl+Alt+Space', { quickMemo: 'Control+Alt+Space', magic: 'Control+Alt+C' }), 'Ctrl+Alt+Space / Ctrl+Alt+C');
});
