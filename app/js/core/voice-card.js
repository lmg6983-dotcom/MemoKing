// 음성 카드: 소리 파일과 받아쓴 글을 한 칸에 (순수 함수 — 마크다운 만들기·고치기)
//   파일에는 평범한 마크다운 인용으로 저장한다 → 다른 앱에서도 "소리 + 받아쓴 글" 로 읽힌다
//     > ![녹음 10월 4일 오후 3:12 · 02:31](attachments/녹음.m4a)
//     >
//     > **화자 1:** 안녕하세요.
//     >
//     > 오늘 안건입니다.
//   첫 줄이 소리 하나뿐인 인용 = 음성 카드 (편집기가 접을 수 있는 카드로 보여 준다)
//   받아쓴 글은 문장마다 한 줄, 말한 사람이 바뀌는 줄 앞에 **화자 N:**

export const SPEAKER_LINE = /^화자\s*(\d+)\s*[:：]\s*/;

// 마크다운으로 읽히는 글자 막기 (받아쓴 글은 그냥 글)
export function escapeLine(text) {
  return String(text ?? '')
    .replace(/[\\`*_[\]<>|~$]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#>+-])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2')
    .replace(/(^|\s)#(?=[^\s#])/g, '$1\\#'); // 받아쓴 글 속 # 이 태그가 되지 않게
}

/** 받아쓴 글(줄마다 한 문장, "화자 N: ") → 카드 안의 마크다운 줄들 */
export function transcriptLines(transcript) {
  return String(transcript ?? '')
    .split(/\n+/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(SPEAKER_LINE);
      if (!m) return escapeLine(l);
      return `**화자 ${m[1]}:** ${escapeLine(l.slice(m[0].length))}`;
    });
}

const quote = (lines) => lines.map((l) => (l ? `> ${l}` : '>')).join('\n');
const between = (lines) => lines.flatMap((l, i) => (i ? ['', l] : [l]));

/** 소리 + 받아쓴 글 → 음성 카드 마크다운 */
export function voiceCardMarkdown({ alt, src }, transcript = '') {
  const link = /[\s()<>]/.test(src) ? `<${src}>` : src;
  const media = `![${String(alt ?? '').replace(/[[\]]/g, '')}](${link})`;
  return quote(between([media, ...transcriptLines(transcript)]));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 메모 본문(마크다운)에서 이 소리 파일 줄을 찾아 받아쓴 글을 붙인다
 *   - 이미 음성 카드면 카드 끝에 이어서, 그냥 소리 줄이면 그 줄을 음성 카드로
 *   - 소리 줄이 없으면 null
 */
export function attachTranscript(body, src, transcript) {
  const lines = String(body ?? '').split('\n');
  const re = new RegExp(`!\\[[^\\]]*\\]\\(<?${escapeRe(src)}>?\\)`);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return null;
  const add = transcriptLines(transcript);
  if (!add.length) return body;
  if (/^>\s?/.test(lines[at])) {
    let end = at;
    while (end + 1 < lines.length && /^>/.test(lines[end + 1])) end++;
    lines.splice(end + 1, 0, ...add.flatMap((l) => ['>', `> ${l}`]));
    return lines.join('\n');
  }
  const m = lines[at].match(re);
  // 소리 줄에 다른 글이 같이 있으면 소리만 카드로 빼고 나머지는 남긴다
  const rest = lines[at].replace(re, '').trim();
  const card = quote(between([m[0], ...add])).split('\n');
  lines.splice(at, 1, ...(rest ? [rest, '', ...card] : card));
  return lines.join('\n');
}
