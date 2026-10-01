// Windows 클립보드의 "HTML Format"(CF_HTML) 해석 — 빠른 메모(Ctrl+Alt+C)용 (순수 함수, 단위 테스트 대상)
//
//   Version:0.9
//   StartHTML:0000000105
//   EndHTML:0000000262
//   StartFragment:0000000141
//   EndFragment:0000000226
//   SourceURL:https://news.example.com/article/1      ← 브라우저가 넣어 주는 원본 주소
//   <html><body><!--StartFragment-->…선택한 부분…<!--EndFragment--></body></html>
// 위치 값은 UTF-8 바이트 기준이다.
import { wrapOrphanRows } from './tables.js';

/** @param {Uint8Array|string} data @returns {{ html: string, sourceUrl: string|null }} */
export function parseCfHtml(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const text = new TextDecoder().decode(bytes);
  const header = (name) => new RegExp(`^${name}:(.*)$`, 'mi').exec(text.slice(0, 2000))?.[1]?.trim() ?? null;
  const sourceUrl = header('SourceURL');
  const start = Number(header('StartFragment'));
  const end = Number(header('EndFragment'));
  let html = null;
  if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= bytes.length) {
    html = new TextDecoder().decode(bytes.slice(start, end));
  }
  if (!html) {
    // 위치 값이 틀린 앱도 있어 주석 표시로 한 번 더 찾는다
    const m = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(text);
    html = m ? m[1] : text.replace(/^[\s\S]*?(?=<)/, '');
  }
  // 엑셀은 조각 표시가 <table> 안쪽이라 줄(<tr>)만 떼어진다 → 표로 다시 감싼다.
  // 굵게 같은 칸 모양은 조각 밖의 <style>(.xl65 {font-weight:700}) 에 있으므로 함께 붙인다.
  html = html.trim();
  if (/<t[rdh][\s>]/i.test(html) && !/<style/i.test(html)) {
    const styles = (text.match(/<style[\s\S]*?<\/style>/gi) ?? []).join('');
    html = styles + wrapOrphanRows(html);
  }
  return { html: wrapOrphanRows(html), sourceUrl: sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : null };
}

// HTML 안에 글자가 있는지 (그림만 있는 HTML 이면 그림 파일을 쓰는 게 낫다)
export const htmlHasText = (html) => String(html ?? '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;/g, ' ')
  .trim().length > 0;
