// 찰칵 소리 — 영역 캡처 오버레이·스크롤 캡처 테두리가 함께 쓴다
// 찰칵: 짧은 잡음 두 번 (셔터가 열리고 닫히는 소리) — 소리 파일 없이 만든다
export function shutter() {
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
