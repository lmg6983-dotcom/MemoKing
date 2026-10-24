// 단축키 한 번·두 번 누르기 가르기 — 두 번째가 ms 안에 오면 onDouble, 아니면 ms 뒤 onSingle.
// (Ctrl+Alt+C 한 번 = 매직 카피, 두 번 = 화면 영역 캡처)
export function createDoublePress({ ms = 350, onSingle, onDouble, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let inCooldown = false;

  return function press() {
    if (inCooldown) {
      return 'ignore';
    }
    if (timer) {
      clearTimer(timer);
      timer = null;
      inCooldown = true;
      setTimer(() => {
        inCooldown = false;
      }, ms);
      try {
        onDouble?.();
      } catch (err) {
        console.error('[double-press] onDouble 오류:', err);
      }
      return 'double';
    }
    timer = setTimer(() => {
      timer = null;
      try {
        onSingle?.();
      } catch (err) {
        console.error('[double-press] onSingle 오류:', err);
      }
    }, ms);
    return 'wait';
  };
}

