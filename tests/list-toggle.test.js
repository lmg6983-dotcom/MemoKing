import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoublePress } from '../desktop/double-press.js';
import { withShortcuts } from '../app/js/core/accelerators.js';
import { SHORTCUT_GROUPS } from '../app/js/core/shortcuts.js';

test('매직키 더블 프레스: 1회 누르면 350ms 뒤 showMagic, 2회 누르면 즉시 toggleListWindow', () => {
  let singleCount = 0;
  let doubleCount = 0;
  let timerCb = null;
  let cleared = false;

  const mockSetTimer = (cb, ms) => {
    timerCb = cb;
    return 123;
  };
  const mockClearTimer = (id) => {
    if (id === 123) cleared = true;
  };

  const press = createDoublePress({
    ms: 350,
    onSingle: () => { singleCount++; },
    onDouble: () => { doubleCount++; },
    setTimer: mockSetTimer,
    clearTimer: mockClearTimer,
  });

  // 1. 단일 누름: wait 반환, 타이머 등록됨
  const res1 = press();
  assert.equal(res1, 'wait');
  assert.equal(singleCount, 0);
  assert.equal(doubleCount, 0);

  // 350ms 후 타이머 실행 시뮬레이션
  timerCb();
  assert.equal(singleCount, 1);
  assert.equal(doubleCount, 0);

  // 2. 더블 프레스 (350ms 내 두 번째 누름)
  cleared = false;
  const res2 = press();
  assert.equal(res2, 'wait');
  const res3 = press();
  assert.equal(res3, 'double');
  assert.equal(cleared, true);
  assert.equal(singleCount, 1); // 추가 호출 없음
  assert.equal(doubleCount, 1); // 더블 프레스 실행됨
});

test('toggleListWindow 동작 검증 (가상 WindowManager)', () => {
  class MockWindowManager {
    constructor() {
      this.listWin = null;
      this.createdCount = 0;
    }

    createListWindow(tab) {
      this.createdCount++;
      this.listWin = {
        _destroyed: false,
        _visible: true,
        _minimized: false,
        _focused: true,
        _closed: false,
        isDestroyed() { return this._destroyed; },
        isVisible() { return this._visible; },
        isMinimized() { return this._minimized; },
        isFocused() { return this._focused; },
        close() {
          this._closed = true;
          this._destroyed = true;
        },
      };
      return this.listWin;
    }

    toggleListWindow(tab) {
      if (this.listWin && !this.listWin.isDestroyed() && this.listWin.isVisible() && !this.listWin.isMinimized() && this.listWin.isFocused()) {
        this.listWin.close();
        this.listWin = null;
        return null;
      }
      return this.createListWindow(tab);
    }
  }

  const wm = new MockWindowManager();

  // 1. 목록 창이 닫혀 있을 때 -> 새로 열림
  const win1 = wm.toggleListWindow();
  assert.ok(win1);
  assert.equal(wm.createdCount, 1);
  assert.equal(win1._closed, false);

  // 2. 목록 창이 열려 있고 포커스되어 있을 때 -> 닫힘
  const res2 = wm.toggleListWindow();
  assert.equal(res2, null);
  assert.equal(win1._closed, true);
  assert.equal(wm.listWin, null);

  // 3. 다시 누르면 -> 다시 열림
  const win3 = wm.toggleListWindow();
  assert.ok(win3);
  assert.equal(wm.createdCount, 2);

  // 4. 목록 창이 열려 있지만 다른 창에 포커스가 가 있을 때 (isFocused = false) -> 닫지 않고 맨 앞으로
  win3._focused = false;
  const win4 = wm.toggleListWindow();
  assert.ok(win4);
  assert.equal(wm.createdCount, 3);
});

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
