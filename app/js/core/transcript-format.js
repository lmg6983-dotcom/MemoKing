// 정확하게 다시 받아쓴 결과(말한 사람 구간 + 글) → 메모에 넣을 마크다운, 그리고 그 녹음 줄 바로 아래에 넣기 (순수 함수)
//   **화자 1** (00:00) 안녕하세요 오늘 회의를 …
//   **화자 2** (00:15) 네 그럼 시작하죠

const pad = (n) => String(n).padStart(2, '0');
export function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

// 받아쓴 글이 마크다운 기호로 읽히지 않게
const escapeText = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/^([#>+-]|\d+\.)(?=\s)/, '\\$1');

/**
 * @param {{ segments: { start: number, end: number, speaker: number, text: string }[], speakers?: number, diarize?: boolean }} result
 * @param {{ perParagraph?: number, names?: Record<number, string> }} [options] 말한 사람을 구분하지 않으면 perParagraph 조각마다 문단
 */
export function formatTranscript(result, { perParagraph = 4, names = {} } = {}) {
  const segs = (result?.segments ?? []).filter((s) => String(s.text ?? '').trim());
  if (!segs.length) return '';
  const diarized = Boolean(result.diarize) && segs.some((s) => s.speaker >= 0);
  // 사람 번호를 처음 말한 순서대로 1, 2, 3 …
  const order = new Map();
  for (const s of segs) if (s.speaker >= 0 && !order.has(s.speaker)) order.set(s.speaker, order.size + 1);
  const nameOf = (sp) => names[sp] ?? `화자 ${order.get(sp)}`;
  const head = `**정확하게 다시 받아쓴 글** · Whisper${diarized ? ` · 말한 사람 ${order.size}명` : ''}`;
  const paras = [];
  if (diarized) {
    // 같은 사람이 이어 말한 조각은 한 문단으로
    let cur = null;
    for (const s of segs) {
      if (cur && cur.speaker === s.speaker) cur.text.push(s.text);
      else {
        if (cur) paras.push(cur);
        cur = { speaker: s.speaker, start: s.start, text: [s.text] };
      }
    }
    if (cur) paras.push(cur);
    return [head, ...paras.map((p) => `**${nameOf(p.speaker)}** (${clock(p.start)}) ${escapeText(p.text.join(' '))}`)].join('\n\n');
  }
  for (let i = 0; i < segs.length; i += perParagraph) {
    const group = segs.slice(i, i + perParagraph);
    paras.push(`(${clock(group[0].start)}) ${escapeText(group.map((s) => s.text).join(' '))}`);
  }
  return [head, ...paras].join('\n\n');
}

/** 본문에서 그 소리 파일(src) 줄이 든 문단 바로 아래에 md 를 넣는다 (없으면 끝에) */
export function insertAfterMedia(body, src, md) {
  const text = String(body ?? '');
  if (!md) return text;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes(`](${src})`) || l.includes(`](<${src}>)`));
  if (at < 0) return `${text.replace(/\s+$/, '')}\n\n${md}\n`;
  let end = at;
  while (end + 1 < lines.length && lines[end + 1].trim() !== '') end++;
  return [...lines.slice(0, end + 1), '', md, ...(lines.length > end + 1 ? [''] : []), ...lines.slice(end + 1).filter((l, i) => !(i === 0 && l.trim() === ''))].join('\n');
}

/** 본문에 든 소리 파일들 (![설명](attachments/…m4a 등)) */
export function audioSources(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(/!\[([^\]]*)\]\((?:<)?(attachments\/[^)\s>]+\.(?:m4a|mp3|wav|ogg|oga|aac|flac|opus|weba|3gp|amr|webm))(?:>)?\)/gi)) {
    out.push({ alt: m[1], src: m[2] });
  }
  return out;
}
