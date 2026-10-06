// 받아쓴 조각 → 읽기 좋은 글 (순수 함수 — PC 받아쓰기, 휴대폰 Stt.kt 의 Transcript·SpeechConditioner 와 같은 규칙)
//   - 조각(한 문장)마다 줄을 바꾸고, 끝에 문장부호가 없으면 붙인다 (묻는 말은 ?, 맺는 말은 .)
//   - 말한 사람이 둘 이상이면 사람이 바뀌는 줄 앞에 "화자 N: " (같은 사람이 이어 말하면 줄만 바꿈)
//   - 화자 나누기 결과(시간 구간마다 사람)를 받아쓴 줄에 붙이기
//   - 받아쓰기 전에 소리 다듬기 (낮은 웅웅 소리 빼기 · 작은 목소리 키우기 · 큰 소리 부드럽게 누르기)

const QUESTION = /(까|까요|나요|가요|는지|는지요|냐|래요|대요|할래|했니|하니|있니|없니|어때|어때요)$/;
const STATEMENT = /(다|요|죠|네|군|자|세요|니다|지|야|어|아|해|래)$/;

export function punctuate(part) {
  const t = String(part ?? '').trim();
  if (!t || /[.?!,…~。？！]$/.test(t)) return t;
  if (QUESTION.test(t)) return `${t}?`;
  if (STATEMENT.test(t)) return `${t}.`;
  return t;
}

/** 받아쓰기 엔진의 낱말 조각 → 글: ▁ 가 낱말 경계 (sherpa-onnx WebAssembly 판의 text 는 띄어쓰기가 빠진다) */
export function tokensToText(tokens, fallback = '') {
  if (!tokens?.length) return String(fallback ?? '').trim();
  return tokens.join('').replace(/▁/g, ' ').replace(/\s+([.?!,])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** @param {{ text: string, speaker?: number }[]} lines → "화자 1: …\n…" */
export function joinTranscript(lines) {
  const list = (lines ?? []).filter((l) => String(l?.text ?? '').trim());
  const many = new Set(list.map((l) => l.speaker ?? 0).filter((s) => s > 0)).size >= 2;
  const out = [];
  let who = -1;
  for (const l of list) {
    const spk = (l.speaker ?? 0) > 0 ? l.speaker : who; // 모르는(0) 조각은 앞사람으로
    const text = punctuate(l.text);
    out.push(many && spk > 0 && spk !== who ? `화자 ${spk}: ${text}` : text);
    if (spk > 0) who = spk;
  }
  return out.join('\n');
}

/**
 * 화자 나누기 결과를 받아쓴 줄에 붙인다 — 줄의 시간과 가장 많이 겹친 사람.
 * 사람 번호는 처음 말한 순서대로 1, 2, … (나누기 결과의 번호는 0부터 아무렇게나)
 * @param {{ text: string, start: number, end: number }[]} lines  초 단위
 * @param {{ start: number, end: number, speaker: number }[]} segments
 */
export function labelSpeakers(lines, segments) {
  const order = new Map();
  let prev = 0;
  return (lines ?? []).map((l) => {
    const overlap = new Map();
    for (const s of segments ?? []) {
      const o = Math.min(l.end, s.end) - Math.max(l.start, s.start);
      if (o > 0) overlap.set(s.speaker, (overlap.get(s.speaker) ?? 0) + o);
    }
    let best = null;
    let most = 0;
    for (const [spk, o] of overlap) {
      if (o > most) {
        most = o;
        best = spk;
      }
    }
    if (best == null) return { ...l, speaker: prev };
    if (!order.has(best)) order.set(best, order.size + 1);
    prev = order.get(best);
    return { ...l, speaker: prev };
  });
}

/** 받아쓰기 전에 소리를 가볍게 다듬는다 (Float32 -1~1, 덩어리마다 그 자리에서 고침) — 녹음 파일은 원래 소리 그대로 */
export class SpeechConditioner {
  constructor(rate = 16000) {
    this.alpha = 1 / (1 + (2 * Math.PI * 100) / rate); // 고역 통과 (약 100Hz 아래 빼기)
    this.prevIn = 0;
    this.prevOut = 0;
    this.level = 0.02; // 지금 말소리 크기 (느리게 따라감)
    this.noise = 0.005; // 배경 소음 크기 (아주 느리게 따라감)
    this.gain = 1;
    this.target = 0.12; // 맞추려는 말소리 크기 (-18dBFS 쯤)
  }

  process(x) {
    const n = x.length;
    if (!n) return x;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const y = this.alpha * (this.prevOut + v - this.prevIn);
      this.prevIn = v;
      this.prevOut = y;
      x[i] = y;
      sum += y * y;
    }
    const rms = Math.sqrt(sum / n);
    // 배경 소음은 조용한 쪽으로 빨리, 큰 쪽으로는 아주 느리게
    this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.999 + rms * 0.001;
    const speaking = rms > this.noise * 2.5 && rms > 0.004;
    if (speaking) this.level = this.level * 0.9 + rms * 0.1;
    const want = speaking
      ? Math.min(8, Math.max(1, this.target / Math.max(this.level, 1e-4)))
      : Math.min(this.gain, Math.max(1, this.gain * 0.98));
    this.gain += (want - this.gain) * 0.2;
    for (let i = 0; i < n; i++) {
      let y = x[i] * this.gain;
      if (y > 0.8) y = 0.8 + (y - 0.8) * 0.2; // 부드럽게 누르기
      else if (y < -0.8) y = -0.8 + (y + 0.8) * 0.2;
      x[i] = Math.max(-1, Math.min(1, y));
    }
    return x;
  }
}
