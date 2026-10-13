import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHotkeys, assignHotkey, slotOf, hotkeyCopyText, hotkeyAccelerator, hotkeyLabel } from '../app/js/core/memo-hotkeys.js';

test('설정 값 정리: 잘못된 칸 · 둘 다 끈 칸은 버림, 복사가 기본', () => {
  assert.deepEqual(normalizeHotkeys({ 1: { id: 'a' }, 0: { id: 'b' }, 10: { id: 'c' }, 3: { id: 'd', copy: false }, 4: { id: '' }, 5: null, 6: { id: 'e', copy: false, show: true } }),
    { 1: { id: 'a', copy: true, show: false }, 6: { id: 'e', copy: false, show: true } });
  assert.deepEqual(normalizeHotkeys(null), {});
});

test('칸 정하기: 메모의 예전 칸은 비우고, 그 칸의 다른 메모는 빠짐', () => {
  let { hotkeys, replaced } = assignHotkey({}, 'a', '1', { copy: true, show: true });
  assert.deepEqual(hotkeys, { 1: { id: 'a', copy: true, show: true } });
  assert.equal(replaced, null);
  ({ hotkeys, replaced } = assignHotkey(hotkeys, 'a', '2'));
  assert.deepEqual(hotkeys, { 2: { id: 'a', copy: true, show: false } });
  ({ hotkeys, replaced } = assignHotkey(hotkeys, 'b', '2', { copy: false, show: true }));
  assert.equal(replaced, 'a');
  assert.equal(slotOf(hotkeys, 'b'), '2');
  assert.equal(slotOf(hotkeys, 'a'), null);
  ({ hotkeys } = assignHotkey(hotkeys, 'b', null));
  assert.deepEqual(hotkeys, {});
  assert.throws(() => assignHotkey({}, 'a', '1', { copy: false, show: false }), /하나는/);
  assert.throws(() => assignHotkey({}, 'a', '0'), /1~9/);
});

test('단축키 이름', () => {
  assert.equal(hotkeyAccelerator('3'), 'Control+Alt+3');
  assert.equal(hotkeyLabel('3'), 'Ctrl+Alt+3');
});

test('복사할 글: 제목 줄은 빼고 본문만, 줄 앞 띄어쓰기 그대로', () => {
  const N = ' ';
  assert.equal(hotkeyCopyText(`# 배송 안내\n\n안녕하세요 **고객님**.\n${N}${N}국내사업부 대표\\\n${N}${N}- 담당: 홍길동\n`), `안녕하세요 고객님.\n  국내사업부 대표\n  - 담당: 홍길동`);
  assert.equal(hotkeyCopyText('첫 줄이 제목\n둘째 줄'), '첫 줄이 제목\n둘째 줄');
  assert.equal(hotkeyCopyText('# 제목만'), '제목만');
  assert.equal(hotkeyCopyText('- [ ] 할 일'), '☐ 할 일');
});
