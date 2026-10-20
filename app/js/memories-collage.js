// 회상 "한 장으로" — 그날(또는 그 달)의 사진 · 메모를 스크랩북 한 쪽 그림(PNG)으로 (PC 복사·저장 · 휴대폰 공유)
//   화면의 그날의 기록과 같은 모양: 줄 노트 종이 위에 테이프 붙인 폴라로이드 · 메모지 조각, 맨 아래 날짜와 "메모킹".
//   사진은 fetch 로 받아 그린다 (img 를 바로 그리면 다른 출처 그림이라 캔버스를 내보낼 수 없다)
import { vaultUrl } from './media.js';

const W = 1080;
const PAD = 64;
const FONT = '"Pretendard Variable", Pretendard, "Malgun Gothic", system-ui, sans-serif';
const NOTE_BG = { yellow: '#fff4b8', green: '#ddf5df', pink: '#ffe0ec', purple: '#ede3ff', blue: '#ddeeff', gray: '#f1f0ec', charcoal: '#1c1c1b' };
const INK = '#3b352a';

const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const tilt = (s, max) => {
  const t = (Math.abs(hash(s)) % (max * 20 + 1)) / 10 - max;
  return ((t < 0 ? Math.min(t, -max * 0.3) : Math.max(t, max * 0.3)) * Math.PI) / 180;
};

async function loadImage(src) {
  try {
    const res = await fetch(vaultUrl(src));
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

// 글을 폭에 맞춰 줄로 (한글은 글자 단위로 끊어도 자연스럽다)
function wrap(ctx, text, width, maxLines) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > width && line) {
        lines.push(line);
        line = ch.trimStart();
        if (lines.length >= maxLines) break;
      } else line += ch;
    }
    if (lines.length >= maxLines) break;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  const out = lines.slice(0, maxLines);
  const full = String(text ?? '').replace(/\s+/g, '');
  if (out.join('').replace(/\s+/g, '').length < full.length && out.length) out[out.length - 1] = `${out[out.length - 1].replace(/.$/, '')}…`;
  return out;
}

function cover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function shadow(ctx, blur = 18, y = 6, a = 0.16) {
  ctx.shadowColor = `rgba(60, 45, 20, ${a})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = y;
}

/**
 * @param {{ title: string, sub?: string, photos: { src: string, title?: string, day?: string }[], memos: { title?: string, preview?: string, color?: string, day?: string }[], kind: 'day'|'month' }} o
 * @returns {Promise<string>} PNG base64
 */
export async function renderCollage({ title, sub = '', photos = [], memos = [], kind = 'day' }) {
  const month = kind === 'month';
  const cols = month ? 3 : photos.length + memos.length <= 2 ? 2 : 3;
  const gap = 34;
  const cell = (W - PAD * 2 - gap * (cols - 1)) / cols;
  const shown = photos.slice(0, month ? 15 : 12);
  const notes = memos.slice(0, month ? 6 : 6);
  const imgs = await Promise.all(shown.map((p) => loadImage(p.src)));
  // 그날: 메모마다 쓴 글 다음에 사진 (이름은 첫 장에만) · 그 달: 날짜 순
  const seen = new Set();
  const pics = shown.map((p, i) => ({ photo: p, img: imgs[i], day: p.day, memo: p.memoId })).filter((x) => x.img);
  for (const x of pics) {
    x.named = !seen.has(x.memo);
    seen.add(x.memo);
  }
  const items = month
    ? [...notes.map((m) => ({ note: m, day: m.day })), ...pics].sort((a, b) => String(a.day).localeCompare(String(b.day)))
    : [...notes.map((m) => ({ note: m, memo: m.id })), ...pics].sort((a, b) => order(a) - order(b));
  function order(x) {
    const i = notes.findIndex((m) => m.id === x.memo);
    return (i < 0 ? notes.length : i) * 2 + (x.note ? 0 : 1);
  }
  if (!items.length) throw new Error('그림으로 담을 사진이나 메모가 없어요');

  const polH = cell + 70; // 사진 + 아래 이름 칸
  const rows = Math.ceil(items.length / cols);
  const headH = 210;
  const footH = 110;
  const H = Math.round(headH + rows * (polH + gap + 10) + footH);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  await document.fonts?.ready;

  // 종이 · 옅은 줄
  ctx.fillStyle = '#fbf8f1';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(59, 53, 42, 0.06)';
  ctx.lineWidth = 2;
  for (let y = 120; y < H; y += 52) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // 제목
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 60px ${FONT}`;
  ctx.fillText(title, PAD, 120);
  if (sub) {
    ctx.font = `500 30px ${FONT}`;
    ctx.fillStyle = 'rgba(59, 53, 42, 0.62)';
    ctx.fillText(wrap(ctx, sub, W - PAD * 2, 1)[0] ?? '', PAD, 170);
  }

  items.forEach((it, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PAD + col * (cell + gap);
    const y = headH + row * (polH + gap + 10);
    const key = it.photo?.src ?? `${it.note?.title}${i}`;
    ctx.save();
    ctx.translate(x + cell / 2, y + polH / 2);
    ctx.rotate(tilt(key, it.note ? 2.5 : 3.5));
    ctx.translate(-cell / 2, -polH / 2);
    if (it.photo) {
      // 폴라로이드
      ctx.save();
      shadow(ctx);
      ctx.fillStyle = '#fffefb';
      ctx.fillRect(0, 0, cell, polH);
      ctx.restore();
      const m = 14;
      cover(ctx, it.img, m, m, cell - m * 2, cell - m * 2);
      const cap = month ? dayLabel(it.photo.day) : it.named ? it.photo.title ?? '' : '';
      if (cap) {
        ctx.fillStyle = INK;
        ctx.font = `500 26px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(wrap(ctx, cap, cell - 30, 1)[0] ?? '', cell / 2, cell + 32);
        ctx.textAlign = 'start';
      }
      // 테이프
      ctx.save();
      ctx.translate(cell / 2, 0);
      ctx.rotate(tilt(`${key}t`, 8));
      ctx.fillStyle = 'rgba(255, 230, 128, 0.78)';
      ctx.fillRect(-58, -16, 116, 34);
      ctx.restore();
    } else {
      // 메모지 조각
      const n = it.note;
      const h = Math.min(polH, cell * 0.95);
      ctx.save();
      shadow(ctx, 12, 4, 0.14);
      ctx.fillStyle = NOTE_BG[n.color] ?? NOTE_BG.yellow;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(0, 0, cell, h, [3, 3, 26, 3]);
      else ctx.rect(0, 0, cell, h);
      ctx.fill();
      ctx.restore();
      const fg = n.color === 'charcoal' ? '#f5f4ef' : '#1f1f1c';
      ctx.fillStyle = fg;
      let ty = 52;
      if (month && n.day) {
        ctx.font = `700 22px ${FONT}`;
        ctx.globalAlpha = 0.6;
        ctx.fillText(dayLabel(n.day), 26, ty - 8);
        ctx.globalAlpha = 1;
        ty += 30;
      }
      ctx.font = `800 30px ${FONT}`;
      for (const line of wrap(ctx, n.title || '메모', cell - 52, 2)) {
        ctx.fillText(line, 26, ty);
        ty += 40;
      }
      ctx.font = `400 25px ${FONT}`;
      ctx.globalAlpha = 0.85;
      const left = Math.max(0, Math.floor((h - ty - 16) / 36));
      for (const line of wrap(ctx, n.preview ?? '', cell - 52, left)) {
        ctx.fillText(line, 26, ty + 6);
        ty += 36;
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  });

  // 맨 아래: 메모킹 표시
  ctx.font = `700 26px ${FONT}`;
  ctx.fillStyle = 'rgba(59, 53, 42, 0.5)';
  ctx.textAlign = 'right';
  ctx.fillText('메모킹', W - PAD, H - 48);
  ctx.textAlign = 'start';
  for (const img of imgs) img?.close?.();

  const base64 = canvas.toDataURL('image/png').split(',')[1];
  if (!base64) throw new Error('그림을 만들지 못했어요');
  return base64;
}

function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  return m ? `${Number(m[2])}월 ${Number(m[3])}일` : '';
}

/** 저장할 파일 이름 (예: "회상 2026-10-08.png") */
export function collageName({ kind, photos = [], memos = [], title = '' }) {
  const key = photos[0]?.day ?? memos[0]?.day ?? '';
  const stamp = kind === 'month' ? key.slice(0, 7) : key;
  return `회상 ${stamp || title}.png`.replace(/[\\/:*?"<>|]/g, '');
}
