// PDF 읽기 · 만들기 엔진 (PC · 휴대폰 함께)
//   읽기: Google PDFium 의 WebAssembly 판 (app/vendor/pdfium.js · pdfium.wasm.gz)
//   만들기: 쪽 그림(JPEG)들을 담은 PDF (makeImagePdf) — 한글 · Word · 파워포인트 문서를 PDF 로 바꿀 때
//   처음 쓸 때만 불러온다 — wasm 은 gzip 으로 넣어 두고(앱 용량) 열 때 브라우저 기본 기능(DecompressionStream)으로 푼다
//   주석(손으로 그린 펜 · 형광펜): PDF 안에 표준 잉크 주석(/Ink)으로 저장한다 — 다른 PDF 앱에서도 보인다.
//     메모킹 획 자료(MKStroke)도 함께 넣어, 다시 열면 주석을 꺼내 화면 층에서 이어 고친다 (takeInk · save)
//   한글 대체 글꼴: PC 는 Windows 의 맑은 고딕을 빌려 쓰고(앱에 넣지 않음), 휴대폰은 앱에 든 Noto Sans KR

import { getStroke } from '../vendor/perfect-freehand.js';
import { strokeOptions } from './core/ink.js';

/** 앱에 든 파일 주소: PC 메모 창(file://)은 앱 파일을 내주는 memoking://ocr/ 로 (file:// 는 fetch 가 막힌다), 휴대폰은 그대로 */
export function appAsset(rel) {
  if (location.protocol === 'file:') return `memoking://ocr/${rel}`;
  return new URL(`../${rel}`, import.meta.url).href;
}
/** 앱에 든 파일 → 바이트 (.gz 는 풀어서) */
export async function assetBytes(rel, url = appAsset(rel)) {
  const res = await fetch(url);
  // 안드로이드 빌드(AGP)는 assets 의 .gz 를 미리 풀고 이름에서 .gz 를 뗀다 → 푼 파일을 그대로 읽는다
  if (res.status === 404 && rel.endsWith('.gz')) return assetBytes(rel.slice(0, -3));
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

/** 쉬는 틈에 PDFium 을 미리 올려 둔다 (메모에 PDF 썸네일이 보일 때) — 눌렀을 때 wasm 풀기 · 컴파일을 기다리지 않게 */
let warmed = false;
export function warmPdf() {
  if (warmed) return;
  warmed = true;
  // 숨은 창(미리 만든 탭 · 예비 창)은 보일 때까지 미룬다 — PDF 엔진은 창마다 수 MB 를 차지해, 숨은 창마다 올리면 메모리만 쌓였다
  if (globalThis.document?.visibilityState === 'hidden') {
    document.addEventListener('visibilitychange', () => {
      warmed = false;
      warmPdf();
    }, { once: true });
    return;
  }
  (globalThis.requestIdleCallback ?? ((f) => setTimeout(f, 1500)))(() => pdfium().catch(() => (warmed = false)), { timeout: 4000 });
}
/** 지금 바로 올리기 시작 (못 올려도 조용히 — 실제로 쓸 때 다시 해 보고 알린다) */
export const preloadPdf = () => void pdfium().catch(() => {});

/** 캔버스 → 폭 width 이하로 줄인 PNG Blob (썸네일) */
export async function thumbBlob(canvas, width) {
  let c = canvas;
  if (canvas.width > width) {
    c = document.createElement('canvas');
    c.width = width;
    c.height = Math.max(1, Math.round((canvas.height * width) / canvas.width));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, c.width, c.height);
  }
  return new Promise((done, fail) => c.toBlob((b) => (b ? done(b) : fail(new Error('썸네일을 만들지 못했어요'))), 'image/png'));
}

const INK_KEY = 'MKStroke'; // 잉크 주석에 남기는 메모킹 획 자료 (JSON)
const ANNOT_INK = 15;
const hexRgb = (hex) => {
  const n = Number.parseInt(String(hex).replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * PDF 열기 → { pageCount, size(i) → { width, height } (pt), render(i, width) → canvas, takeInk(i), save(inkByPage), close() }
 *   render: 쪽을 폭 width(px)로 그린 캔버스 (흰 바탕)
 *   takeInk(i): 그 쪽의 메모킹 주석 획들 (쪽 왼쪽 위 기준 pt, 아래로 +) — 꺼낸 주석은 이 문서에서 빼서 render 에 그려지지 않는다 (화면 층이 그린다)
 *   text(i): 그 쪽의 글자 — { count, charAt(x, y) → 글자 번호 | -1, rects(a, b) → [{ x, y, w, h }], text(a, b), word(k) → [a, b], textIn({ x, y, w, h }) } (pt, 왼쪽 위 기준)
 *   save(Map 쪽 → 획들): 꺼낸 쪽마다 획들을 잉크 주석으로 다시 넣은 PDF 바이트. 저장한 뒤 이 문서는 닫고 그 바이트로 다시 연다
 * @param {{ keepInk?: boolean }} [opts] keepInk: 주석을 꺼내지 않고 그대로 그린다 (썸네일)
 */
export async function openPdf(bytes, { keepInk = false } = {}) {
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
  const taken = new Map(); // 쪽 → 꺼낸 획들
  const heap = () => m.pdfium;
  const takeInk = (i) => {
    if (keepInk) return [];
    if (taken.has(i)) return taken.get(i);
    const page = m.FPDF_LoadPage(doc, i);
    const strokes = [];
    try {
      for (let k = m.FPDFPage_GetAnnotCount(page) - 1; k >= 0; k--) {
        const annot = m.FPDFPage_GetAnnot(page, k);
        if (!annot) continue;
        let stroke = null;
        try {
          if (m.FPDFAnnot_GetSubtype(annot) === ANNOT_INK) {
            const len = m.FPDFAnnot_GetStringValue(annot, INK_KEY, 0, 0);
            if (len > 2) {
              const buf = heap().wasmExports.malloc(len);
              try {
                m.FPDFAnnot_GetStringValue(annot, INK_KEY, buf, len);
                const text = new TextDecoder('utf-16le').decode(heap().HEAPU8.slice(buf, buf + len - 2));
                const s = JSON.parse(text);
                if (s?.v === 1 && Array.isArray(s.pts) && s.pts.length) stroke = { tool: s.tool === 'highlighter' ? 'highlighter' : 'pen', color: String(s.color), size: Number(s.size) || 4, pen: Boolean(s.pen), pts: s.pts };
              } catch {
                stroke = null; // 깨진 자료 — 그 주석은 PDF 에 그대로 둔다
              } finally {
                heap().wasmExports.free(buf);
              }
            }
          }
        } finally {
          m.FPDFPage_CloseAnnot(annot);
        }
        if (stroke) {
          strokes.unshift(stroke);
          m.FPDFPage_RemoveAnnot(page, k);
        }
      }
    } finally {
      m.FPDF_ClosePage(page);
    }
    taken.set(i, strokes);
    return strokes;
  };
  // 획 하나 → 잉크 주석 (모양: perfect-freehand 테두리를 칠한 경로 · 뜻: 가운데 선 InkList · 메모킹 자료)
  const addInk = (page, ph, s) => {
    const outline = getStroke(s.pts.length === 1 ? [s.pts[0], [s.pts[0][0] + 0.1, s.pts[0][1] + 0.1, s.pts[0][2]]] : s.pts, strokeOptions(s));
    if (outline.length < 3) return;
    const H = heap();
    const [r, g, b] = hexRgb(s.color);
    const alpha = s.tool === 'highlighter' ? 102 : 255;
    const annot = m.FPDFPage_CreateAnnot(page, ANNOT_INK);
    if (!annot) return;
    const tmp = H.wasmExports.malloc(Math.max(16, s.pts.length * 8, (JSON.stringify(s).length + 64) * 2));
    try {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of outline) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      H.HEAPF32.set([x0 - 1, ph - y0 + 1, x1 + 1, ph - y1 - 1], tmp >> 2); // FS_RECTF { left, top, right, bottom }
      m.FPDFAnnot_SetRect(annot, tmp);
      m.FPDFAnnot_SetColor(annot, 0, r, g, b, alpha);
      m.FPDFAnnot_SetBorder(annot, 0, 0, s.size);
      m.FPDFAnnot_SetFlags(annot, 4); // 인쇄에도
      const path = m.FPDFPageObj_CreateNewPath(outline[0][0], ph - outline[0][1]);
      for (let k = 1; k < outline.length; k++) m.FPDFPath_LineTo(path, outline[k][0], ph - outline[k][1]);
      m.FPDFPath_Close(path);
      m.FPDFPath_SetDrawMode(path, 2, false); // 칠하기 (winding)
      m.FPDFPageObj_SetFillColor(path, r, g, b, alpha);
      m.FPDFAnnot_AppendObject(annot, path);
      H.HEAPF32.set(s.pts.flatMap(([x, y]) => [x, ph - y]), tmp >> 2);
      m.FPDFAnnot_AddInkStroke(annot, tmp, s.pts.length);
      const json = JSON.stringify({ v: 1, tool: s.tool, color: s.color, size: s.size, pen: Boolean(s.pen), pts: s.pts });
      const u16 = new Uint16Array(json.length + 1);
      for (let k = 0; k < json.length; k++) u16[k] = json.charCodeAt(k);
      H.HEAPU8.set(new Uint8Array(u16.buffer), tmp);
      m.FPDFAnnot_SetStringValue(annot, INK_KEY, tmp);
    } finally {
      H.wasmExports.free(tmp);
      m.FPDFPage_CloseAnnot(annot);
    }
  };
  // ---------- 글자 (끌어서 고르기 · 복사 · 형광펜) ----------
  const texts = new Map(); // 쪽 → { page, tp, ph, n } — 문서를 닫을 때 함께 닫는다
  const text = (i) => {
    if (closed) throw new Error('닫힌 PDF 예요');
    let t = texts.get(i);
    if (!t) {
      const page = m.FPDF_LoadPage(doc, i);
      const tp = m.FPDFText_LoadPage(page);
      t = { page, tp, ph: m.FPDF_GetPageHeightF(page), n: tp ? m.FPDFText_CountChars(tp) : 0 };
      texts.set(i, t);
    }
    const { tp, ph, n } = t;
    const uni = (k) => (k >= 0 && k < n ? String.fromCodePoint(m.FPDFText_GetUnicode(tp, k) || 32) : ' ');
    return {
      count: n,
      charAt: (x, y, tol = 4) => (n ? m.FPDFText_GetCharIndexAtPos(tp, x, ph - y, tol, tol) : -1),
      rects(a, b) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        if (!n || lo < 0) return [];
        const out = [];
        const H = heap();
        const buf = H.wasmExports.malloc(32);
        try {
          const cnt = m.FPDFText_CountRects(tp, lo, hi - lo + 1);
          for (let k = 0; k < cnt; k++) {
            if (!m.FPDFText_GetRect(tp, k, buf, buf + 8, buf + 16, buf + 24)) continue;
            const [l, t2, r, b2] = H.HEAPF64.subarray(buf >> 3, (buf >> 3) + 4);
            if (r - l > 0.5 && t2 - b2 > 0.5) out.push({ x: l, y: ph - t2, w: r - l, h: t2 - b2 });
          }
        } finally {
          H.wasmExports.free(buf);
        }
        return out;
      },
      text(a, b) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        if (!n || lo < 0) return '';
        const cnt = hi - lo + 1;
        const H = heap();
        const buf = H.wasmExports.malloc((cnt + 1) * 2);
        try {
          const got = m.FPDFText_GetText(tp, lo, cnt, buf);
          return new TextDecoder('utf-16le').decode(H.HEAPU8.slice(buf, buf + Math.max(0, got - 1) * 2)).replace(/\r\n/g, '\n');
        } finally {
          H.wasmExports.free(buf);
        }
      },
      /** 네모 안의 글 */
      textIn({ x, y, w, h }) {
        if (!n) return '';
        const args = [x, ph - y, x + w, ph - y - h];
        const need = m.FPDFText_GetBoundedText(tp, ...args, 0, 0);
        if (need <= 0) return '';
        const H = heap();
        const buf = H.wasmExports.malloc((need + 1) * 2);
        try {
          const got = m.FPDFText_GetBoundedText(tp, ...args, buf, need);
          return new TextDecoder('utf-16le').decode(H.HEAPU8.slice(buf, buf + got * 2)).replace(/\0+$/, '').replace(/\r\n/g, '\n');
        } finally {
          H.wasmExports.free(buf);
        }
      },
      word(k) {
        const isWord = (c) => /[\p{L}\p{N}_]/u.test(c);
        if (!isWord(uni(k))) return [k, k];
        let a = k;
        let b = k;
        while (a > 0 && isWord(uni(a - 1))) a--;
        while (b < n - 1 && isWord(uni(b + 1))) b++;
        return [a, b];
      },
    };
  };

  const save = (inkByPage) => {
    if (closed) throw new Error('닫힌 PDF 예요');
    for (const [i, strokes] of inkByPage) {
      takeInk(i); // 아직 꺼내지 않은 쪽이면 먼저 꺼낸다 (두 번 들어가지 않게)
      if (!strokes.length) continue;
      const page = m.FPDF_LoadPage(doc, i);
      try {
        const ph = m.FPDF_GetPageHeightF(page);
        for (const s of strokes) addInk(page, ph, s);
      } finally {
        m.FPDF_ClosePage(page);
      }
    }
    const H = heap();
    const writer = m.PDFiumExt_OpenFileWriter();
    try {
      if (!m.PDFiumExt_SaveAsCopy(doc, writer)) throw new Error('주석을 넣은 PDF 를 만들지 못했어요');
      const n = m.PDFiumExt_GetFileWriterSize(writer);
      const buf = H.wasmExports.malloc(n);
      try {
        m.PDFiumExt_GetFileWriterData(writer, buf, n);
        return H.HEAPU8.slice(buf, buf + n);
      } finally {
        H.wasmExports.free(buf);
      }
    } finally {
      m.PDFiumExt_CloseFileWriter(writer);
    }
  };
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
    takeInk(i);
    const page = m.FPDF_LoadPage(doc, i);
    const pw = m.FPDF_GetPageWidthF(page);
    const ph = m.FPDF_GetPageHeightF(page);
    const W = Math.max(1, Math.round(width));
    const H = Math.max(1, Math.round((width * ph) / pw));
    const bmp = m.FPDFBitmap_Create(W, H, 1);
    try {
      m.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xffffffff);
      m.FPDF_RenderPageBitmap(bmp, page, 0, 0, W, H, 0, 0x01 | 0x10); // 주석도 · RGBA 순서로 (FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER — 캔버스와 같아 그대로 옮긴다)
      const buf = m.FPDFBitmap_GetBuffer(bmp);
      const stride = m.FPDFBitmap_GetStride(bmp);
      const src = m.pdfium.HEAPU8;
      const img = new ImageData(W, H);
      if (stride === W * 4) img.data.set(src.subarray(buf, buf + W * H * 4));
      else for (let y = 0; y < H; y++) img.data.set(src.subarray(buf + y * stride, buf + y * stride + W * 4), y * W * 4);
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
    for (const t of texts.values()) {
      if (t.tp) m.FPDFText_ClosePage(t.tp);
      m.FPDF_ClosePage(t.page);
    }
    texts.clear();
    m.FPDF_CloseDocument(doc);
    m.pdfium.wasmExports.free(ptr);
  };
  return { pageCount, size, render, takeInk, text, save, close };
}

/** 첫 쪽 썸네일 (PNG Blob, 폭 width px) — 주석까지 그린다 */
export async function pdfThumbnail(bytes, width = 600) {
  const pdf = await openPdf(bytes, { keepInk: true });
  try {
    return await thumbBlob(pdf.render(0, width), width);
  } finally {
    pdf.close();
  }
}

/** 쪽 캔버스 → PDF 에 담을 JPEG { bytes, w, h } */
export async function pageJpeg(canvas) {
  const blob = await new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('쪽 이미지를 만들지 못했어요'))), 'image/jpeg', 0.88));
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
