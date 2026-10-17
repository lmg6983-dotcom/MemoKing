// 다른 캘린더 일정 → 메모로 가져올 때 넣는 한 달 달력 그림 (PC·휴대폰 같음, 화면의 canvas 로 그린다)
//   종이 같은 바탕에 그 달 달력, 일정 날짜에는 색연필로 그린 듯한 동그라미 (손으로 두 바퀴 돌린 것처럼 · 결이 있는 선)
//   같은 일정은 늘 같은 그림 (흔들림은 날짜로 정한 씨앗의 난수)

const W = 1080; // 2배로 그려 휴대폰 · 큰 화면에서도 또렷하게
const PAD = 56;
const HEAD = 150;
const WEEK_H = 120;
const FOOT = 96;
const DAY = 86_400_000;

const INK = '#2b2a26';
const MUTED = '#a8a397';
const SUN = '#d4483b';
const SAT = '#3b6fd4';
const PAPER = '#fffdf6';
const LINE = '#ebe6d9';
const PENCIL = '#e0473a'; // 빨간 색연필 (일정 캘린더 색이 너무 옅으면 이것)

/** 날짜로 정한 씨앗의 난수 (0~1) — 같은 일정이면 같은 동그라미 */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** 너무 옅은 색(노랑 등)이면 색연필 빨강으로 — 종이 위에서 보이게 */
function pencilColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return PENCIL;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.72 ? PENCIL : hex;
}

/**
 * 색연필 동그라미: 조금 기울고 찌그러진 타원을 한 바퀴 반 — 시작과 끝이 겹치게, 선은 가는 획 여러 줄로 결을 낸다
 * @param {CanvasRenderingContext2D} ctx
 */
function pencilCircle(ctx, cx, cy, rx, ry, color, rand) {
  const tilt = (rand() - 0.5) * 0.35;
  const start = -Math.PI * (0.55 + rand() * 0.2);
  const turns = 1.18 + rand() * 0.12; // 한 바퀴 조금 넘게 — 손으로 그린 동그라미처럼 끝이 지나간다
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 색연필 결: 가는 획을 조금씩 어긋나게 여러 번 긋고, 획마다 진하기 · 굵기가 들쭉날쭉, 군데군데 종이가 비친다(끊김)
  const steps = 120;
  for (let pass = 0; pass < 9; pass++) {
    const jx = (rand() - 0.5) * 4;
    const jy = (rand() - 0.5) * 4;
    const alpha = 0.32 + rand() * 0.38;
    const width = 2.6 + rand() * 2.8;
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const t = start + (i / steps) * Math.PI * 2 * turns;
      // 반지름이 조금씩 출렁이고, 끝으로 갈수록 바깥으로 비껴 나간다
      const wob = 1 + Math.sin(t * 3 + pass) * 0.03 + (i / steps) * 0.08;
      const pt = [Math.cos(t) * rx * wob + jx, Math.sin(t) * ry * wob + jy];
      if (prev && rand() > 0.07) {
        // 시작 · 끝은 연하게 (손에 힘이 덜 들어간 곳)
        const edge = Math.min(1, i / 10, (steps - i) / 10 + 0.4);
        ctx.globalAlpha = alpha * (0.55 + 0.45 * edge) * (0.8 + rand() * 0.2);
        ctx.lineWidth = width * (0.85 + rand() * 0.3);
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(pt[0], pt[1]);
        ctx.stroke();
      }
      prev = pt;
    }
  }
  // 종이결 알갱이: 선 둘레에 아주 작은 점
  ctx.fillStyle = color;
  for (let k = 0; k < 160; k++) {
    const t = start + rand() * Math.PI * 2 * turns;
    const r = 1 + (rand() - 0.5) * 0.12;
    ctx.globalAlpha = 0.18 + rand() * 0.3;
    ctx.fillRect(Math.cos(t) * rx * r - 1, Math.sin(t) * ry * r - 1, 1.6, 1.6);
  }
  ctx.restore();
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * 한 달 달력 그림 (PNG 바이트)
 * @param {{ start: Date, end?: Date|null, allDay?: boolean, title?: string, when?: string, color?: string, fontFamily?: string }} o
 *   start ~ end: 일정 (하루 종일의 end 는 다음 날 0시) — 그 달 안의 날마다 동그라미 (7일까지)
 *   when: 아래 줄에 쓸 때 ("10월 18일 (일) 오후 7:00")
 * @returns {Promise<Uint8Array>}
 */
export async function monthSketchPng({ start, end = null, allDay = false, title = '', when = '', color, fontFamily }) {
  const font = fontFamily || getComputedStyle(document.body).fontFamily || 'sans-serif';
  const y0 = start.getFullYear();
  const m0 = start.getMonth();
  const first = new Date(y0, m0, 1);
  const lead = first.getDay();
  const days = new Date(y0, m0 + 1, 0).getDate();
  const weeks = Math.ceil((lead + days) / 7);
  const H = HEAD + weeks * WEEK_H + FOOT;
  const cellW = (W - PAD * 2) / 7;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'middle';

  // 종이
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // 제목: 2026년 10월
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.font = `800 52px ${font}`;
  ctx.fillText(`${y0}년 ${m0 + 1}월`, PAD, 64);

  // 요일
  ctx.font = `700 26px ${font}`;
  ctx.textAlign = 'center';
  ['일', '월', '화', '수', '목', '금', '토'].forEach((w, i) => {
    ctx.fillStyle = i === 0 ? SUN : i === 6 ? SAT : MUTED;
    ctx.fillText(w, PAD + cellW * (i + 0.5), HEAD - 26);
  });
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, HEAD - 2);
  ctx.lineTo(W - PAD, HEAD - 2);
  ctx.stroke();

  // 날짜
  const marked = new Set();
  const s0 = dayStart(start);
  const last = end && end > start ? dayStart(allDay ? new Date(end.getTime() - 1) : end) : s0;
  for (let t = s0.getTime(), n = 0; t <= last.getTime() && n < 7; t += DAY, n++) {
    const d = new Date(t);
    if (d.getFullYear() === y0 && d.getMonth() === m0) marked.add(d.getDate());
  }
  const centers = [];
  ctx.font = `600 34px ${font}`;
  for (let day = 1; day <= days; day++) {
    const idx = lead + day - 1;
    const col = idx % 7;
    const row = Math.floor(idx / 7);
    const cx = PAD + cellW * (col + 0.5);
    const cy = HEAD + WEEK_H * (row + 0.5);
    ctx.fillStyle = col === 0 ? SUN : col === 6 ? SAT : INK;
    if (marked.has(day)) ctx.font = `800 36px ${font}`;
    ctx.fillText(String(day), cx, cy);
    if (marked.has(day)) {
      ctx.font = `600 34px ${font}`;
      centers.push({ cx, cy, day });
    }
  }
  // 주 사이 가는 줄
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.5;
  for (let r = 1; r < weeks; r++) {
    ctx.beginPath();
    ctx.moveTo(PAD, HEAD + WEEK_H * r);
    ctx.lineTo(W - PAD, HEAD + WEEK_H * r);
    ctx.stroke();
  }

  // 색연필 동그라미
  const ink = pencilColor(color);
  for (const { cx, cy, day } of centers) {
    const rand = rng(y0 * 10000 + (m0 + 1) * 100 + day);
    pencilCircle(ctx, cx, cy, cellW * 0.36, WEEK_H * 0.36, ink, rand);
  }

  // 아래 줄: 때 · 이름
  const foot = [when, title].filter(Boolean).join('  ·  ');
  if (foot) {
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `700 30px ${font}`;
    let text = foot;
    while (text.length > 4 && ctx.measureText(text).width > W - PAD * 2 - 40) text = text.slice(0, -2);
    if (text !== foot) text = `${text.trimEnd()}…`;
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(PAD + 10, H - FOOT / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.fillText(text, PAD + 34, H - FOOT / 2);
  }

  const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
  if (!blob) throw new Error('달력 그림을 만들지 못했어요');
  return new Uint8Array(await blob.arrayBuffer());
}
