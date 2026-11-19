import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// 좁은 메모 창의 상태 말풍선: 글자를 치는 동안(한글 조합 중 · 마지막 키 뒤 1.2초)은 말풍선 창을 띄우지도 거두지도 않는다
//   (조합 사이 다른 창이 뜨거나 숨으면 입력기가 조합 자리를 잃고 화면 왼쪽 위에 따로 된 조합 창을 띄웠다)
test('글자를 치는 동안은 말풍선 창을 건드리지 않고, 손을 멈추면 띄우고 거둔다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const calls = [];
  const on = {};
  Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true });
  globalThis.window = { memoking: { win: { statusBubble: (b) => (calls.push(b?.text ?? null), Promise.resolve(true)) }, on() {} }, addEventListener() {} };
  globalThis.document = { hasFocus: () => true, addEventListener: (type, fn) => (on[type] = fn) };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.getComputedStyle = () => ({ paddingLeft: '0' });
  const classes = new Set();
  const el = {
    textContent: '', title: '', scrollWidth: 500, clientWidth: 100, // 늘 잘린 (좁은 창)
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    removeAttribute() {}, getBoundingClientRect: () => ({ left: 0 }),
  };
  const { attachStatusBubble, statusChanged } = await import('../app/js/status-bubble.js');
  attachStatusBubble(el);
  const set = (text) => { el.textContent = text; statusChanged(); mock.timers.tick(0); };
  const wait = async (ms) => { clock += ms; mock.timers.tick(ms); await Promise.resolve(); };

  // 한글 조합 중에 안내가 와도 띄우지 않는다 — 오래 조합해도
  on.compositionstart();
  set('날짜를 누르면 일정으로 넣을 수 있어요');
  await wait(3000);
  assert.deepEqual(calls, [], '조합 중에는 창을 띄우지 않는다');
  // 조합이 끝나고 1.2초 손을 멈추면 띄운다
  on.compositionend();
  await wait(600);
  assert.deepEqual(calls, [], '마지막 키 뒤 1.2초 안');
  await wait(700);
  assert.deepEqual(calls, ['날짜를 누르면 일정으로 넣을 수 있어요']);

  // 떠 있는 말풍선도 치는 동안은 숨기지 않고, 손을 멈추면 거둔다
  on.keydown();
  set('');
  await wait(500);
  assert.equal(calls.length, 1, '치는 중에는 숨기지도 않는다');
  await wait(800);
  assert.deepEqual(calls.at(-1), null, '손을 멈추면 거둔다');
  mock.timers.reset();
});
