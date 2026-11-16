// PDF 읽기 (PC · 휴대폰): Google PDFium 의 WebAssembly 판 (@embedpdf/pdfium, MIT · PDFium Apache-2.0)
//   글꼴을 넣지 않은 한글 PDF 는 앱에 넣은 Noto Sans KR 로 그린다 (FontFallbackManager — @embedpdf/engines, MIT)
export { init } from '@embedpdf/pdfium';
export { FontFallbackManager, FontCharset } from '@embedpdf/engines/pdfium';
