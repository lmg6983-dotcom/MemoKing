import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withShortcuts } from '../app/js/core/accelerators.js';
import { SHORTCUT_GROUPS } from '../app/js/core/shortcuts.js';

test('단축키 목록에 메모 목록 열기/닫기 안내가 포함되고 맞춤 치환됨', () => {
  const everywhere = SHORTCUT_GROUPS.find((g) => g.title === '어디서든');
  assert.ok(everywhere);
  const listToggle = everywhere.items.find(([label]) => label === '메모 목록 열기/닫기');
  assert.ok(listToggle);
  assert.equal(listToggle[1], 'Ctrl+Alt+`');

  // 단축키 변경 시 치환 테스트
  const customized = withShortcuts(listToggle[1], { list: 'Control+Alt+L' });
  assert.equal(customized, 'Ctrl+Alt+L');
});
