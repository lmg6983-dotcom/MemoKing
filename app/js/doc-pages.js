// 문서(PDF · Word · 한글)를 장마다 그림(PNG)으로 — 원노트의 "인쇄물로 넣기" 처럼 메모에 묶음 사진으로 넣는다 (PC·휴대폰 함께)
//   PDF: pdf.js · DOCX: docx-preview · HWP: hwp.js (모두 Apache-2.0, app/vendor/docpages.js — 넣을 때만 불러온다)
//   DOCX · HWP 는 화면 밖에 그린 장을 html-to-image 로 찍는다
import { toCanvas } from '../vendor/html-to-image.js';

export const DOC_EXTS = ['pdf', 'docx', 'hwp', 'hwpx'];
const extOf = (name) => String(name ?? '').split('.').pop().toLowerCase();
export const isDocumentFile = (file) => DOC_EXTS.includes(extOf(file?.name));

const MAX_PAGES = 60; // shortcut: 아주 긴 문서는 앞 60장만, 더 필요하면 나눠 넣기 (메모 폴더 · 동기화 부담)
const PAGE_WIDTH = 1240; // A4 를 150dpi 쯤으로 — 글자가 또렷하면서 파일이 너무 크지 않게

const canvasBlob = (canvas) => new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('그림을 만들지 못했어요'))), 'image/png'));

/**
 * @param {File} file
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{ pages: Blob[], total: number }>} total: 문서 전체 장 수 (MAX_PAGES 보다 많으면 pages 는 앞부분만)
 */
export async function documentPages(file, onProgress) {
  const lib = await import('../vendor/docpages.js');
  const ext = extOf(file.name);
  const data = new Uint8Array(await file.arrayBuffer());
  if (ext === 'pdf') return pdfPages(lib, data, onProgress);
  if (ext === 'docx') {
    return domPages(async (box) => {
      await lib.renderDocx(data, box, null, { inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, experimental: true });
      return [...box.querySelectorAll('section.docx')];
    }, onProgress);
  }
  if (ext === 'hwp') {
    return domPages((box) => {
      new lib.HwpViewer(box, data, { type: 'array' }); // eslint-disable-line no-new
      return [...box.querySelectorAll('[data-page-number]:not(.hwpjs-observer)')];
    }, onProgress);
  }
  if (ext === 'hwpx') return domPages((box) => hwpxPages(lib, data, box), onProgress);
  throw new Error('그림으로 바꿀 수 없는 문서예요');
}

async function pdfPages(lib, data, onProgress) {
  lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.js', import.meta.url).href;
  const pdf = await lib.getDocument({ data, isEvalSupported: false }).promise; // 화면 규칙(CSP)이 eval 을 막는다
  const total = pdf.numPages;
  const n = Math.min(total, MAX_PAGES);
  const pages = [];
  try {
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, PAGE_WIDTH / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      pages.push(await canvasBlob(canvas));
      page.cleanup();
      onProgress?.(i, n);
    }
  } finally {
    pdf.destroy();
  }
  return { pages, total };
}

// 화면 밖 상자에 문서를 그리고 장마다 찍는다
async function domPages(render, onProgress) {
  const box = document.createElement('div');
  box.className = 'mk-doc-render';
  Object.assign(box.style, { position: 'fixed', left: '-20000px', top: '0', background: '#fff', color: '#000', zIndex: '-1' });
  document.body.append(box);
  try {
    const all = await render(box);
    if (!all.length) throw new Error('문서에서 장을 찾지 못했어요');
    const list = all.slice(0, MAX_PAGES);
    await document.fonts?.ready;
    const pages = [];
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      const w = el.offsetWidth || PAGE_WIDTH;
      const canvas = await toCanvas(el, { backgroundColor: '#ffffff', pixelRatio: Math.min(2.5, PAGE_WIDTH / w), skipFonts: true });
      pages.push(await canvasBlob(canvas));
      onProgress?.(i + 1, list.length);
    }
    return { pages, total: all.length };
  } finally {
    box.remove();
  }
}

// ---------- HWPX (한글 2014 이후 기본 형식 · 압축한 XML) ----------
// shortcut: 글 · 표 · 그림만 A4 장에 차례로 담는다 (글꼴 · 줄 간격 · 쪽 머리글 같은 꾸밈은 빠짐) — 똑같은 모양이 필요하면 PDF 로 저장해 넣기
async function hwpxPages(lib, data, box) {
  const zip = await lib.JSZip.loadAsync(data);
  const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!names.length) throw new Error('한글 문서의 내용을 찾지 못했어요');
  // 그림: BinData/<id>.<확장자> → 화면에 쓸 주소
  const images = new Map();
  for (const n of Object.keys(zip.files).filter((x) => /^BinData\//i.test(x))) {
    const id = n.split('/').pop().replace(/\.[^.]+$/, '');
    const blob = await zip.file(n).async('blob');
    images.set(id, URL.createObjectURL(blob));
  }
  const W = 794;
  const H = 1123; // A4 96dpi
  const PAD = 72;
  const pages = [];
  let page = null;
  const newPage = () => {
    page = document.createElement('div');
    Object.assign(page.style, { width: `${W}px`, height: `${H}px`, padding: `${PAD}px`, boxSizing: 'border-box', overflow: 'hidden', background: '#fff', font: '15px/1.6 "Malgun Gothic", sans-serif', marginBottom: '8px' });
    box.append(page);
    pages.push(page);
  };
  // 넣어 보고 넘치면 다음 장으로 (한 덩어리가 장보다 크면 그 장에 잘린 채로 둔다)
  const place = (el) => {
    if (!page) newPage();
    page.append(el);
    if (page.scrollHeight > H && page.childElementCount > 1) {
      el.remove();
      newPage();
      page.append(el);
    }
  };
  const textOf = (node) => [...node.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('');
  for (const name of names) {
    const xml = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
    const sec = xml.documentElement;
    for (const p of [...sec.children].filter((c) => c.localName === 'p')) {
      // 표 · 그림은 문단 안(run 안)에 든다
      const tbls = [...p.getElementsByTagNameNS('*', 'tbl')];
      const pics = [...p.getElementsByTagNameNS('*', 'pic')];
      for (const tbl of tbls) {
        const t = document.createElement('table');
        Object.assign(t.style, { borderCollapse: 'collapse', width: '100%', margin: '6px 0' });
        for (const tr of [...tbl.getElementsByTagNameNS('*', 'tr')]) {
          const row = t.insertRow();
          for (const tc of [...tr.children].filter((c) => c.localName === 'tc')) {
            const cell = row.insertCell();
            Object.assign(cell.style, { border: '1px solid #999', padding: '3px 6px', verticalAlign: 'top' });
            cell.textContent = textOf(tc);
          }
        }
        place(t);
      }
      for (const pic of pics) {
        const ref = pic.getElementsByTagNameNS('*', 'img')[0]?.getAttribute('binaryItemIDRef');
        const src = ref && images.get(ref);
        if (!src) continue;
        const img = document.createElement('img');
        img.src = src;
        Object.assign(img.style, { display: 'block', maxWidth: '100%', maxHeight: `${H - PAD * 2}px`, margin: '6px 0' });
        await img.decode().catch(() => {}); // 크기를 알고 나서 장에 담는다 (넘치면 다음 장)
        place(img);
      }
      if (tbls.length || pics.length) continue; // 표 · 그림 문단의 글은 위에서 담았다
      const para = document.createElement('p');
      Object.assign(para.style, { margin: '0 0 4px', minHeight: '1.6em', whiteSpace: 'pre-wrap' });
      para.textContent = textOf(p);
      place(para);
    }
  }
  return pages;
}
