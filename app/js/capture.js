// 영역 캡처 오버레이 — 메인 프로세스가 찍어 준 화면 위에서 끌어 사각형을 고른다.
// 좌표는 이 모니터 기준 화면 좌표(창 = 모니터 전체). 자르기는 메인이 원래 해상도로 한다.
// 자동(드래그로 선택한 내용이 있을 때): 고르지 않고 그 사각형에 테두리 → 반짝 + 찰칵 → 바로 캡처.
const api = window.memoking;
const $ = (id) => document.getElementById(id);
const sel = $('sel');
const size = $('size');
let start = null;
let done = false;
let auto = false;
const AUTO_MS = 650; // 테두리가 자리 잡고 반짝인 뒤 캡처

api.on('capture:image', ({ src, auto: rect }) => {
  auto = Boolean(rect);
  if (auto) document.body.classList.add('auto', 'selecting');
  $('shot').onload = () => {
    document.documentElement.dataset.ready = 'true';
    if (rect) autoCapture(rect);
  };
  $('shot').src = src;
});

// 찰칵: 짧은 잡음 두 번 (셔터가 열리고 닫히는 소리) — 소리 파일 없이 만든다
function shutter() {
  try {
    const ctx = new AudioContext();
    const burst = (at, dur, freq, gain) => {
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = 0.9;
      const level = ctx.createGain();
      level.gain.value = gain;
      src.connect(filter).connect(level).connect(ctx.destination);
      src.start(ctx.currentTime + at);
    };
    burst(0, 0.045, 2600, 0.9); // 찰
    burst(0.08, 0.06, 1500, 0.7); // 칵
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch {
    // 소리를 못 내도 캡처는 그대로
  }
}

function autoCapture(rect) {
  $('hint').textContent = '선택한 내용을 캡처해요';
  draw(rect);
  sel.classList.add('auto');
  // 테두리가 자리 잡으면 반짝 + 찰칵
  setTimeout(() => {
    if (done) return;
    sel.classList.add('flash');
    shutter();
  }, 260);
  setTimeout(() => {
    if (done) return;
    done = true;
    api.capture.done(rect);
  }, AUTO_MS);
}

function rectOf(e) {
  const x = Math.min(start.x, e.clientX);
  const y = Math.min(start.y, e.clientY);
  return { x, y, width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) };
}

function draw(r) {
  sel.hidden = false;
  Object.assign(sel.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  size.textContent = `${Math.round(r.width * devicePixelRatio)} × ${Math.round(r.height * devicePixelRatio)}`;
  sel.classList.toggle('near-top', r.y < 32);
}

function cancel() {
  if (done) return;
  done = true;
  api.capture.cancel();
}

window.addEventListener('mousedown', (e) => {
  if (done || auto) return;
  if (e.button !== 0) return cancel(); // 오른쪽 클릭 = 취소
  start = { x: e.clientX, y: e.clientY };
  document.body.classList.add('selecting');
  draw({ x: start.x, y: start.y, width: 0, height: 0 });
});
window.addEventListener('mousemove', (e) => {
  if (start && !done && !auto) draw(rectOf(e));
});
window.addEventListener('mouseup', (e) => {
  if (!start || done) return;
  const r = rectOf(e);
  start = null;
  // 너무 작으면(그냥 누름) 다시 고르게
  if (r.width < 4 || r.height < 4) {
    sel.hidden = true;
    document.body.classList.remove('selecting');
    return;
  }
  done = true;
  api.capture.done(r);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
});
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  cancel();
});
