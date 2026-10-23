// 문서(PDF · Word · 한글)를 장마다 그림으로 — 문서를 그림으로 넣을 때만 불러온다 (app/js/doc-pages.js)
export { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'; // legacy: 오래된 휴대폰 WebView 에서도
export { renderAsync as renderDocx } from 'docx-preview';
export { Viewer as HwpViewer } from 'hwp.js';
export { default as JSZip } from 'jszip';
