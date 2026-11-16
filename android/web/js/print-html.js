// PDF 로 보내기용 문서: 지금 그려진 메모 본문을 복사해 인쇄 전용 페이지(PC 의 print.css 와 같은 모양)로
//   화면 그대로 인쇄하면 앱 화면 틀(고정 높이·안쪽 스크롤·열린 시트)이 끼어 휴대폰에서 빈 쪽이 나올 수 있다 →
//   앱이 이 HTML 을 보이지 않는 WebView 에 따로 띄워 PDF 로 쓴다 (글자는 글자 그대로, 고를 수 있게)
import { clampPrintScale, clampMarginMm } from '../../app/js/core/pdf-page.js';

// 휴대폰 PDF 쪽: PC PDF 만들기(print.js)와 같은 방식 — 쪽 크기는 고른 종이 · 카드 · 직접 입력, 여백은 쪽마다 되풀이되는
//   표 머리 · 꼬리(위아래)와 칸 안쪽 여백(좌우)으로. 그래서 앱은 여백 없는 쪽으로 만든다 (MainActivity pdfAttributes) —
//   메모 색 바탕이 여백까지 칠해진다 (안드로이드 · 크로미움은 쪽 여백을 칠하지 않는다)
const MM = 96 / 25.4;
const A4 = { width: 210, height: 297 };
/** 쪽(mm)에서 여백(mm)을 뺀 내용 크기 (96dpi px) */
export const pagePx = (page = A4, marginMm) => {
  const m = clampMarginMm(marginMm);
  return { width: Math.round((page.width - 2 * m) * MM), height: Math.round((page.height - 2 * m) * MM) };
};
/** 쪽 전체 크기 (96dpi px) — 미리보기 틀 */
export const pageFullPx = (page = A4) => ({ width: Math.round(page.width * MM), height: Math.round(page.height * MM) });

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 화면에서만 쓰는 표시(고른 줄·누르는 중·목록 커서 등)는 지운다
const SCREEN_ONLY = /^(ProseMirror-selectednode|ProseMirror-hideselection|mk-block-|mk-list-|mk-swap|mk-drop|mk-cursor|mk-item-|mk-delete-target|mk-resize-on)/; // 지우기 대상 붉은 표시 · 크기 손잡이 테두리도

/**
 * @param {Element} dom 편집기 본문 (.mk-doc)
 * @param {{ title: string, color?: string, scale?: number, preview?: boolean, fit?: boolean, margin?: number,
 *           page?: { width: number, height: number }, bg?: boolean, pageBg?: string, date?: string }} memo
 *   pageBg: 메모 색 바탕일 때 쪽 색 (화면의 메모 색 — 없으면 print.css 의 색)
 *   page: 쪽 크기 (mm) · margin: 쪽 여백 (mm) · bg: 메모 색 바탕 (쪽 전체) · date: 아래에 적을 날짜 줄 ('' 이면 없음)
 *   scale: 글자 크기 (1 = 보통, 글·그림·표가 함께 커지고 작아진다)
 *   fit: 쪽보다 긴 그림은 한 쪽 안에 들게 줄인다 (print.css html.fit-images)
 *   preview: 첫 쪽 미리보기용 (쪽 한 장 크기, 여백 포함)
 */
export function printHtml(dom, { title, color = 'yellow', scale = 1, preview = false, fit = true, margin, page = A4, bg = false, pageBg = '', date = '' }) {
  const zoom = clampPrintScale(scale);
  const m = clampMarginMm(margin);
  const W = Number(page.width) || A4.width;
  const H = Number(page.height) || A4.height;
  const doc = dom.cloneNode(true);
  doc.removeAttribute('contenteditable');
  doc.removeAttribute('inputmode');
  for (const el of [doc, ...doc.querySelectorAll('[class]')]) {
    for (const c of [...el.classList]) if (SCREEN_ONLY.test(c)) el.classList.remove(c);
  }
  // 음성 카드는 펼친 채로, 접기 막대·지우기 단추 같은 조작은 빼고
  for (const v of doc.querySelectorAll('.mk-voice.folded')) v.classList.remove('folded');
  for (const el of doc.querySelectorAll('.mk-voice-bar, .mk-delete-btn, .ProseMirror-separator, .ProseMirror-trailingBreak, audio, video')) el.remove();
  // 그림 주소는 절대 주소로 (따로 띄운 페이지에서도 보이게)
  for (const img of doc.querySelectorAll('img')) if (img.src) img.setAttribute('src', img.src);
  for (const el of doc.querySelectorAll('[contenteditable]')) el.removeAttribute('contenteditable');

  const app = new URL('../app/', location.href);
  const sheets = [
    ...[...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href).filter((h) => !/\/styles\/mobile\.css$/.test(h)),
    new URL('styles/print.css', app).href,
  ];
  const links = [...new Set(sheets)].map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('\n');
  const body = `<main class="editor print-doc">${doc.outerHTML}</main>${date ? `<footer class="print-date">${esc(date)}</footer>` : ''}`;
  // PDF: 위아래 여백은 @page 여백으로, 좌우 여백은 안쪽 여백으로 — 여백을 표 한 칸에 담으면 안드로이드 WebView 가
  //   긴 칸을 쪽으로 나누지 못하고 한 쪽에서 잘라 버린다. 메모 색 바탕은 @page 바탕으로 여백까지 칠한다
  const cls = ['print-page', fit ? 'fit-images' : '', bg ? 'with-bg' : '', preview ? 'preview' : ''].filter(Boolean).join(' ');
  return `<!doctype html>
<html lang="ko" class="${cls}">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
${links}
<style>
@page { size: ${W}mm ${H}mm; margin: ${preview ? 0 : m}mm 0; ${bg && pageBg ? `background: ${esc(pageBg)};` : ''} }
${preview ? '' : `html.print-page body { padding: 0 ${m}mm; box-sizing: border-box; }`}
:root { --page-w: ${W}mm; --page-h: ${H}mm; --page-m: ${m}mm; --fit-h: ${(Math.max(20, H - 2 * m - 12) / zoom).toFixed(1)}mm; --page-bg: ${bg ? esc(pageBg) || `var(--${esc(color)}-bg, #ffffff)` : '#ffffff'}; }
.print-doc .mk-voice { box-shadow: inset 0 0 0 1px rgba(17, 17, 17, 0.12); break-inside: auto; }
.print-doc .mk-voice-body > p:first-child { line-height: normal; font-size: 11pt; }
.print-doc p.mk-image-line { line-height: normal; font-size: inherit; }
.print-doc .mk-doc li::after { border-color: transparent !important; }
${zoom !== 1 ? `.print-doc { zoom: ${zoom}; }` : ''}
</style>
</head>
<body data-color="${esc(color)}">
${body}
</body>
</html>`;
}
