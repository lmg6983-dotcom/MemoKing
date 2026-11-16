// 문서(Word · 파워포인트 · 한글 HWP)를 장마다 그리는 도구 — 문서를 넣을 때만 불러온다 (app/js/doc-pages.js)
//   PDF 는 PDFium(app/vendor/pdfium.js), 한글 HWP · HWPX 는 rhwp(app/vendor/rhwp.js) 가 맡는다
export { renderAsync as renderDocx } from 'docx-preview';
export { Viewer as HwpViewer } from 'hwp.js';
export { default as JSZip } from 'jszip';
