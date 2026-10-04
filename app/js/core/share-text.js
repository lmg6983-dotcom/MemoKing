// 메모를 다른 앱(카톡·메일·문자)으로 보낼 때의 글 — 마크다운 기호 대신 보이는 모양 그대로.
//   목록은 "• " · "1. " · "☐ "/"☑ " (하위 항목은 들여쓰기), 제목은 글만, 굵게·밑줄·색 표시는 빼고,
//   링크는 "글 (주소)", 링크 카드는 주소, 표는 칸 사이 " | ", 사진·소리·동영상은 [사진 이름] 같은 표시.
//   편집기 없이(목록 화면에서 보낼 때도) 파일의 마크다운만으로 만든다. 일부 글을 골라 복사할 때(clipboard-text.js)와는 따로.

import { CARD_TITLE } from './link-preview.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;
const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|aac|flac|opus|weba|3gp|amr)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

function mediaLabel(alt, src) {
  const name = alt || decodeURIComponent(String(src).split('/').pop() ?? '');
  if (AUDIO_EXT.test(src)) return `[녹음 ${name}]`.replace(/\s+\]$/, ']');
  if (VIDEO_EXT.test(src)) return `[동영상 ${name}]`.replace(/\s+\]$/, ']');
  if (IMAGE_EXT.test(src) || !/\.[a-z0-9]{1,5}$/i.test(src)) return `[사진${alt ? ` ${alt}` : ''}]`;
  return `[파일 ${name}]`;
}

// 한 줄 안의 서식 기호를 빼고 읽는 글로
export function inlineToText(line) {
  return line
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, src) => mediaLabel(alt, src))
    .replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, text, href, title) => {
      if (title === CARD_TITLE) return href;
      if (href.startsWith('attachments/')) return `[파일 ${text}]`;
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(u|mark|span|b|i|strong|em|s|del|sub|sup|small|kbd)\b[^>]*>/gi, '')
    .replace(/\$\$([^$]+)\$\$/g, '$$$1$$')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~$<])/g, '$1');
}

/** 마크다운 본문 → 보내기용 글 */
export function shareText(markdown) {
  const out = [];
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const counters = []; // 들여쓰기 단계마다 번호
  let fence = false;
  let mathBlock = false;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(raw);
      continue;
    }
    if (/^\s*\$\$\s*$/.test(raw)) {
      mathBlock = !mathBlock;
      continue;
    }
    if (mathBlock) {
      out.push(raw.trim());
      continue;
    }
    // 표: 구분 줄은 빼고 칸 사이 " | "
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw)) continue;
      const cells = raw.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inlineToText(c.trim()).replace(/\n/g, ' '));
      out.push(cells.join(' | '));
      counters.length = 0;
      continue;
    }
    const list = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(\[([ xX])\]\s+)?(.*)$/.exec(raw);
    if (list) {
      const [, space, , num, task, mark, rest] = list;
      const depth = Math.floor(space.replace(/\t/g, '    ').length / 2);
      counters.length = depth + 1;
      let bullet;
      if (task) bullet = mark.trim() ? '☑' : '☐';
      else if (num) {
        counters[depth] = counters[depth] == null ? Number(num) : counters[depth] + 1;
        bullet = `${counters[depth]}.`;
      } else bullet = '•';
      if (!num) counters[depth] = undefined;
      out.push(`${'  '.repeat(depth)}${bullet} ${inlineToText(rest)}`);
      continue;
    }
    if (raw.trim() && !/^\s/.test(raw)) counters.length = 0;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      out.push(inlineToText(heading[1]));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push('———');
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push(`│ ${inlineToText(quote[1])}`);
      continue;
    }
    // 목록 항목 아래로 이어지는 줄(들여쓴 문단)은 들여쓰기 그대로
    const lead = /^(\s*)/.exec(raw)[1];
    out.push(lead.length >= 2 ? `${'  '.repeat(Math.floor(lead.length / 2))}${inlineToText(raw.trim())}` : inlineToText(raw.trim()));
  }
  // 빈 줄은 두 개 이상 겹치지 않게, 같은 목록 항목 사이 빈 줄(느슨한 목록)은 붙인다
  const rows = out.join('\n').replace(/\n{3,}/g, '\n\n').split('\n');
  const kind = (line) => {
    const m = /^((?: {2})*)([•]|[☐☑]|\d+\.) /.exec(line ?? '');
    return m ? `${m[1].length}:${m[2] === '•' ? 'b' : /\d/.test(m[2]) ? 'n' : 't'}` : null;
  };
  return rows.filter((line, i) => line !== '' || !kind(rows[i - 1]) || kind(rows[i - 1]) !== kind(rows[i + 1])).join('\n').trim();
}
