import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEYMAP_ACTIONS, comboFromEvent, comboLabel, isValidCombo, resolveKeymap, setActionKey, keymapTable, cleanOverrides } from '../app/js/core/keymap.js';

const ev = (code, mods = {}) => ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test('단축키: 기본 키 표 · 기능마다 하는 일 설명이 있음 · 기본 키끼리 겹치지 않음', () => {
  const table = keymapTable({});
  assert.deepEqual(table['ctrl+shift+KeyP'], ['menu', 'pdf-btn']);
  assert.deepEqual(table['ctrl+KeyB'], ['cmd', 'bold']);
  assert.deepEqual(table['ctrl+shift+KeyL'], ['cmd', 'bullet'], '같은 일을 하는 둘째 키도');
  const all = KEYMAP_ACTIONS.flatMap((a) => a.keys);
  assert.equal(new Set(all).size, all.length);
  for (const a of KEYMAP_ACTIONS) {
    assert.ok(a.help.length > 8, a.id);
    for (const k of a.keys) assert.ok(isValidCombo(k), k);
  }
});

test('단축키: 누른 키 → 키 글자 (Ctrl·Alt 필요, 늘 쓰는 키는 막음, F 키는 혼자도)', () => {
  assert.deepEqual(comboFromEvent(ev('KeyP', { ctrlKey: true, shiftKey: true })), { combo: 'ctrl+shift+KeyP' });
  assert.ok(comboFromEvent(ev('ControlLeft', { ctrlKey: true })).pending);
  assert.ok(comboFromEvent(ev('KeyP', { shiftKey: true })).error);
  assert.ok(comboFromEvent(ev('KeyC', { ctrlKey: true })).error, 'Ctrl+C');
  assert.deepEqual(comboFromEvent(ev('F7')), { combo: 'F7' });
  assert.equal(comboLabel('ctrl+shift+alt+Digit5'), 'Ctrl+Shift+Alt+5');
});

test('단축키: 바꾸면 같은 키를 쓰던 기능에서는 빠지고, 기본값 · 없음 · 엉터리 설정', () => {
  let r = setActionKey({}, 'imageCopy', 'ctrl+KeyB');
  assert.deepEqual(r.moved, ['굵게']);
  let keys = resolveKeymap(r.overrides);
  assert.deepEqual(keys.imageCopy, ['ctrl+KeyB']);
  assert.deepEqual(keys.bold, []);
  r = setActionKey(r.overrides, 'bold', null); // 굵게를 기본값으로 → 그림으로 복사에서 빠짐
  keys = resolveKeymap(r.overrides);
  assert.deepEqual(keys.bold, ['ctrl+KeyB']);
  assert.deepEqual(keys.imageCopy, []);
  assert.deepEqual(r.overrides, {}, '모두 기본값이면 설정에 남기지 않음');
  r = setActionKey({}, 'pdf', '');
  assert.deepEqual(resolveKeymap(r.overrides).pdf, []);
  assert.deepEqual(cleanOverrides({ nope: ['ctrl+KeyQ'], pdf: ['ctrl+KeyC'], bold: 'x' }), { pdf: [] });
});

test('단축키: 글 옮겨 다니는 키 · 메모 불러오기 키는 못 줌, 전역 키와 겹치는 기능 찾기', async () => {
  const { comboFromAccelerator, actionUsing } = await import('../app/js/core/keymap.js');
  assert.ok(comboFromEvent(ev('ArrowLeft', { ctrlKey: true })).error);
  assert.ok(comboFromEvent(ev('End', { ctrlKey: true, shiftKey: true })).error);
  assert.ok(comboFromEvent(ev('Digit4', { ctrlKey: true, altKey: true })).error);
  assert.equal(comboFromAccelerator('Control+Shift+P'), 'ctrl+shift+KeyP');
  assert.equal(comboFromAccelerator('Super+Alt+P'), null);
  assert.equal(actionUsing({}, 'ctrl+shift+KeyP')?.id, 'pdf');
  assert.equal(actionUsing({ pdf: [] }, 'ctrl+shift+KeyP'), null);
});
