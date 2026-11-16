// PDF 읽기 · 만들기 엔진 (PC · 휴대폰 함께)
//   읽기: Google PDFium 의 WebAssembly 판 (app/vendor/pdfium.js · pdfium.wasm.gz)
//   만들기: 쪽 그림(JPEG)들을 담은 PDF (makeImagePdf) — 한글 · Word · 파워포인트 문서를 PDF 로 바꿀 때
//   처음 쓸 때만 불러온다 — wasm 은 gzip 으로 넣어 두고(앱 용량) 열 때 브라우저 기본 기능(DecompressionStream)으로 푼다
//   한글 대체 글꼴: PC 는 Windows 의 맑은 고딕을 빌려 쓰고(앱에 넣지 않음), 휴대폰은 앱에 든 Noto Sans KR

/** 앱에 든 파일 주소: PC 메모 창(file://)은 앱 파일을 내주는 memoking://ocr/ 로 (file:// 는 fetch 가 막힌다), 휴대폰은 그대로 */
export function appAsset(rel) {
  if (location.protocol === 'file:') return `memoking://ocr/${rel}`;
  return new URL(`../${rel}`, import.meta.url).href;
}
/** 앱에 든 파일 → 바이트 (.gz 는 풀어서) */
export async function assetBytes(rel, url = appAsset(rel)) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${rel} 을(를) 읽지 못했어요`);
  const body = rel.endsWith('.gz') ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

// 한글 대체 글꼴 — PC: Windows 맑은 고딕 (memoking://font/kr, 없으면 앱에 든 것 — 개발 중) · 휴대폰: 앱에 든 Noto Sans KR. 못 읽으면 null (대체 없이)
async function koreanFont() {
  const bundled = () => assetBytes('vendor/fonts/NotoSansKR-Regular.otf');
  try {
    return location.protocol === 'file:' ? await assetBytes('kr', 'memoking://font/kr').catch(bundled) : await bundled();
  } catch (err) {
    console.warn('[PDF] 한글 대체 글꼴 없음', err);
    return null;
  }
}

let ready = null;
/** PDFium 을 한 번만 올린다 → 감싼 모듈 */
function pdfium() {
  ready ??= (async () => {
    const [lib, wasm, font] = await Promise.all([import('../vendor/pdfium.js'), assetBytes('vendor/pdfium.wasm.gz'), koreanFont()]);
    const m = await lib.init({ wasmBinary: wasm.buffer });
    m.PDFiumExt_Init();
    // 글꼴을 넣지 않은 PDF 의 한글 · 그 밖의 글자 → 한글 대체 글꼴 (PDFium 은 wasm 안에서 기기 글꼴을 못 본다)
    if (font) new lib.FontFallbackManager({ fonts: { [lib.FontCharset.HANGEUL]: 'kr' }, defaultFont: 'kr', fontLoader: () => font }).initialize(m);
    return m;
  })().catch((err) => {
    ready = null; // 다음에 다시 해 본다
    throw err;
  });
  return ready;
}

/**
 * PDF 열기 → { pageCount, size(i) → { width, height } (pt), render(i, width) → canvas, close() }
 *   render: 쪽을 폭 width(px)로 그린 캔버스 (흰 바탕)
 */
export async function openPdf(bytes) {
  const m = await pdfium();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ptr = m.pdfium.wasmExports.malloc(data.length);
  m.pdfium.HEAPU8.set(data, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, data.length, '');
  if (!doc) {
    m.pdfium.wasmExports.free(ptr);
    const code = m.FPDF_GetLastError();
    throw new Error(code === 4 ? '암호가 걸린 PDF 라 열 수 없어요' : 'PDF 를 읽지 못했어요. 파일이 깨졌는지 확인해 주세요');
  }
  const pageCount = m.FPDF_GetPageCount(doc);
  let closed = false;
  const size = (i) => {
    const page = m.FPDF_LoadPage(doc, i);
    try {
      return { width: m.FPDF_GetPageWidthF(page), height: m.FPDF_GetPageHeightF(page) };
    } finally {
      m.FPDF_ClosePage(page);
    }
  };
  const render = (i, width) => {
    if (closed) throw new Error('닫힌 PDF 예요');
    const page = m.FPDF_LoadPage(doc, i);
    const pw = m.FPDF_GetPageWidthF(page);
    const ph = m.FPDF_GetPageHeightF(page);
    const W = Math.max(1, Math.round(width));
    const H = Math.max(1, Math.round((width * ph) / pw));
    const bmp = m.FPDFBitmap_Create(W, H, 1);
    try {
      m.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xffffffff);
      m.FPDF_RenderPageBitmap(bmp, page, 0, 0, W, H, 0, 0x01 | 0x10); // 주석도 · 글자를 또렷하게 (FPDF_ANNOT | FPDF_LCD_TEXT)
      const buf = m.FPDFBitmap_GetBuffer(bmp);
      const stride = m.FPDFBitmap_GetStride(bmp);
      const img = new ImageData(W, H);
      // PDFium 은 BGRA — 캔버스는 RGBA: 4바이트씩 한 번에 R · B 를 바꾼다 (little-endian, 버퍼는 4바이트 정렬)
      const src = new Uint32Array(m.pdfium.HEAPU8.buffer, buf, (stride * H) >> 2);
      const out = new Uint32Array(img.data.buffer);
      const row = stride >> 2;
      for (let y = 0; y < H; y++) {
        for (let x = 0, s = y * row, d = y * W; x < W; x++) {
          const v = src[s + x];
          out[d + x] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      canvas.getContext('2d').putImageData(img, 0, 0);
      return canvas;
    } finally {
      m.FPDFBitmap_Destroy(bmp);
      m.FPDF_ClosePage(page);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    m.FPDF_CloseDocument(doc);
    m.pdfium.wasmExports.free(ptr);
  };
  return { pageCount, size, render, close };
}

/** 첫 쪽 썸네일 (PNG Blob, 폭 width px) */
export async function pdfThumbnail(bytes, width = 480) {
  const pdf = await openPdf(bytes);
  try {
    const canvas = pdf.render(0, width);
    return await new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('썸네일을 만들지 못했어요'))), 'image/png'));
  } finally {
    pdf.close();
  }
}

/** 쪽 캔버스 → PDF 에 담을 JPEG { bytes, w, h } */
export async function pageJpeg(canvas) {
  const blob = await new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('쪽 그림을 만들지 못했어요'))), 'image/jpeg', 0.88));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
}

/**
 * 쪽 그림(JPEG, pageJpeg)들 → PDF (Uint8Array). 쪽 크기는 그림 비율대로 폭 595pt(A4 폭)에 맞춘다
 *   JPEG(DCTDecode)로 담는다 — 글자를 고를 수는 없지만 어느 기기에서나 똑같이 보인다
 * @param {{ bytes: Uint8Array, w: number, h: number }[]} jpegs
 */
export function makeImagePdf(jpegs) {
  const enc = new TextEncoder();
  const parts = [];
  let size = 0;
  const offsets = [];
  const push = (chunk) => {
    const b = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(b);
    size += b.length;
  };
  const n = jpegs.length;
  // 1: 목록, 2: 쪽들, 그 뒤 쪽마다 (쪽 · 그림 · 내용) 세 개
  const pageId = (i) => 3 + i * 3;
  const obj = (id, body) => {
    offsets[id] = size;
    push(`${id} 0 obj\n`);
    for (const b of [].concat(body)) push(b);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${jpegs.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);
  jpegs.forEach((j, i) => {
    const W = 595;
    const H = Math.round((W * j.h) / j.w);
    const id = pageId(i);
    const draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
    obj(id + 1, [`<< /Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>\nstream\n`, j.bytes, '\nendstream']);
    obj(id + 2, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  });
  const total = 3 + n * 3;
  const xref = size;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
