// 목록 창에 끌어다 놓은 파일 → 메모 본문 (순수 함수, 단위 테스트 대상)
//   .md · .txt: 글 그대로 메모로 (머리말은 빼고, 마크다운이면 서식대로). 첫 줄이 제목(# )이 아니면 파일 이름을 제목으로
//   그림: 파일 이름을 제목으로, 그림 한 장 / 그 밖의 파일: 파일 칩(누르면 기본 앱으로 열림)
import { importText, stripFrontMatter } from './markdown-import.js';

const baseName = (name) => String(name ?? '').replace(/\.[^.]+$/, '').replace(/\s+/g, ' ').trim();
/** 제목·링크 글자에서 마크다운으로 읽힐 기호를 글자로 */
const esc = (s) => s.replace(/([\\[\]*_`#<>|])/g, '\\$1');

/**
 * @param {{ name: string, kind: 'text'|'image'|'file', text?: string, rel?: string }} f
 *   text: .md · .txt 내용 / rel: 메모 폴더에 저장한 첨부 ("attachments/…")
 */
export function memoBodyFromFile({ name, kind, text = '', rel = '' }) {
  const title = baseName(name) || '가져온 파일';
  if (kind === 'text') {
    const body = importText(stripFrontMatter(text)).markdown.trim();
    if (/^#\s+\S/.test(body)) return `${body}\n`;
    return `# ${esc(title)}\n\n${body}${body ? '\n' : ''}`;
  }
  const label = esc(String(name ?? '').trim() || title);
  const link = encodeURI(rel);
  return kind === 'image' ? `# ${esc(title)}\n\n![${label}](${link})\n` : `# ${esc(title)}\n\n[${label}](${link})\n`;
}
