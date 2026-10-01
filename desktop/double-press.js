// 단축키 한 번·두 번 누르기 가르기 — 두 번째가 ms 안에 오면 onDouble, 아니면 ms 뒤 onSingle.
// (Ctrl+Alt+C 한 번 = 빠른 메모, 두 번 = 화면 영역 캡처)
export function createDoublePress({ ms = 350, onSingle, onDouble, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  return function press() {
    if (timer) {
      clearTimer(timer);
      timer = null;
      onDouble();
      return 'double';
    }
    timer = setTimer(() => {
      timer = null;
      onSingle();
    }, ms);
    return 'wait';
  };
}
