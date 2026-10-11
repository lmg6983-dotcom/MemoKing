// 휴대폰 홈 화면 위젯에 보일 줄들 — 메모 마크다운을 꾸밈 없는 글 줄로 (순수 함수, 단위 테스트 대상).
//   체크리스트 줄은 몇 번째 할 일인지(i)를 함께 — 위젯에서 체크하면 앱(Widgets.kt toggleTask)이 파일의 i 번째 할 일을 바꾼다.
//   할 일 세는 규칙은 Widgets.kt 와 같아야 한다: 코드 블록(``` ~~~) 안은 세지 않음, "- [ ]" "* [x]" "1. [ ]" 모두 할 일
//   r 은 그 할 일의 원래 글(마크다운 그대로) — 위젯이 갱신되기 전에 PC 에서 순서가 바뀌었어도 Widgets.kt 가 같은 할 일을 찾게
export const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?:\s+|$)(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
export const WIDGET_MAX_LINES = 40;

/** 한 줄의 마크다운 꾸밈을 걷어 낸 글 */
export function plainInline(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt, src) => (/\.(m4a|mp3|wav|ogg|webm|aac)(\s|"|$)/i.test(src) ? `🎙 ${alt || '녹음'}` : /\.(mp4|mov|mkv)(\s|"|$)/i.test(src) ? `🎬 ${alt || '동영상'}` : `🖼 ${alt}`.trim()))
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\s][^*_]*?)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\$\$?([^$]+)\$\$?/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~=])/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} body 머리말을 뺀 메모 본문
 * @returns {{ t: string, kind: 'h'|'task'|'bullet'|'text', done?: boolean, i?: number, r?: string }[]}
 */
export function widgetLines(body, max = WIDGET_MAX_LINES) {
  const out = [];
  let fence = false;
  let task = 0;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      if (line.trim() && out.length < max) out.push({ t: line.trim(), kind: 'text' });
      continue;
    }
    const tm = TASK_RE.exec(line);
    if (tm) {
      const i = task++;
      if (out.length < max) out.push({ t: plainInline(tm[2]), kind: 'task', done: tm[1] !== ' ', i, r: tm[2].trim() });
      continue;
    }
    if (out.length >= max) continue; // 할 일 수는 끝까지 센다 (뒤쪽 줄 번호가 맞게)
    if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) || /^\s*\|?\s*:?-{2,}/.test(line)) continue;
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: plainInline(h[1]), kind: 'h' });
      continue;
    }
    const b = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (b) {
      out.push({ t: plainInline(b[1]), kind: 'bullet' });
      continue;
    }
    let t = line.replace(/^\s*(>\s?)+/, '');
    if (/^\s*\|/.test(t)) t = t.split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
    t = plainInline(t);
    if (t) out.push({ t, kind: 'text' });
  }
  return out;
}

/** 위젯 한 개에 보낼 메모 정보 */
export function widgetMemo(memo, { color } = {}) {
  const lines = widgetLines(memo.body);
  // 첫 줄이 제목과 같으면 빼고 (위젯 머리에 제목이 있으므로)
  if (lines[0]?.kind === 'h' && lines[0].t === memo.title) lines.shift();
  return { id: memo.id, title: memo.title || '제목 없음', color: color ?? memo.color ?? 'yellow', file: memo.file, lines };
}
