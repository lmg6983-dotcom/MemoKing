// PDF 로 보내기용 문서: 지금 그려진 메모 본문을 복사해 인쇄 전용 페이지(PC 의 print.css 와 같은 모양)로
//   화면 그대로 인쇄하면 앱 화면 틀(고정 높이·안쪽 스크롤·열린 시트)이 끼어 휴대폰에서 빈 쪽이 나올 수 있다 →
//   앱이 이 HTML 을 보이지 않는 WebView 에 따로 띄워 PDF 로 쓴다 (글자는 글자 그대로, 고를 수 있게)

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 화면에서만 쓰는 표시(고른 줄·누르는 중·목록 커서 등)는 지운다
const SCREEN_ONLY = /^(ProseMirror-selectednode|ProseMirror-hideselection|mk-block-|mk-list-|mk-swap|mk-drop|mk-cursor|mk-item-)/;

/**
 * @param {Element} dom 편집기 본문 (.mk-doc)
 * @param {{ title: string, color?: string }} memo
 */
export function printHtml(dom, { title, color = 'yellow' }) {
  const doc = dom.cloneNode(true);
  doc.removeAttribute('contenteditable');
  doc.removeAttribute('inputmode');
  for (const el of [doc, ...doc.querySelectorAll('[class]')]) {
    for (const c of [...el.classList]) if (SCREEN_ONLY.test(c)) el.classList.remove(c);
  }
  // 음성 카드는 펼친 채로, 접기 막대·지우기 단추 같은 조작은 빼고
  for (const v of doc.querySelectorAll('.mk-voice.folded')) v.classList.remove('folded');
  for (const el of doc.querySelectorAll('.mk-voice-bar, .lc-remove, .mk-delete-btn, .ProseMirror-separator, .ProseMirror-trailingBreak, audio, video')) el.remove();
  // 그림 주소는 절대 주소로 (따로 띄운 페이지에서도 보이게)
  for (const img of doc.querySelectorAll('img')) if (img.src) img.setAttribute('src', img.src);
  for (const el of doc.querySelectorAll('[contenteditable]')) el.removeAttribute('contenteditable');

  const app = new URL('../app/', location.href);
  const sheets = [
    ...[...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href).filter((h) => !/\/styles\/mobile\.css$/.test(h)),
    new URL('styles/print.css', app).href,
  ];
  const links = [...new Set(sheets)].map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('\n');
  return `<!doctype html>
<html lang="ko" class="print-page">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
${links}
<style>
.print-doc .mk-voice { box-shadow: inset 0 0 0 1px rgba(17, 17, 17, 0.12); break-inside: auto; }
.print-doc .mk-voice-body > p:first-child { line-height: normal; font-size: 11pt; }
.print-doc p.mk-image-line { line-height: normal; font-size: inherit; }
.print-doc .mk-doc li::after { border-color: transparent !important; }
</style>
</head>
<body data-color="${esc(color)}">
<main class="editor print-doc">${doc.outerHTML}</main>
</body>
</html>`;
}
