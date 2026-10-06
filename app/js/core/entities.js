// HTML·XML 글자 참조(&amp; · &#39; · &#x1F600;) 풀기 — 웹페이지 미리 보기 · Windows 알림 XML 이 함께 쓴다 (순수 함수)

export const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const HTML_ENTITIES = { ...XML_ENTITIES, nbsp: '\u00a0', middot: '·', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };

export function decodeEntities(s, table = HTML_ENTITIES) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; // 틀린 번호(&#99999999;)에 멈추지 않게
    }
    return table[code.toLowerCase()] ?? m;
  });
}
