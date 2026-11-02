// 문서(PDF · Word · 파워포인트 · 한글 · 텍스트)를 장마다 그림(PNG)으로 — 원노트의 "인쇄물로 넣기" 처럼 메모에 묶음 사진으로 넣는다 (PC·휴대폰 함께)
//   PDF: pdf.js · DOCX: docx-preview · PPTX/HWPX: JSZip · HWP: hwp.js + OLE2 본문/미리보기 폴백 (모두 Apache-2.0, app/vendor/docpages.js — 넣을 때만 불러온다)
//   DOCX · PPTX · HWP · HWPX · TXT 는 화면 밖에 그린 장을 html-to-image 로 찍는다
import { toCanvas } from '../vendor/html-to-image.js';

export const DOC_EXTS = ['pdf', 'docx', 'pptx', 'hwp', 'hwpx', 'txt'];
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
  const ext = extOf(file.name);
  const data = new Uint8Array(await file.arrayBuffer());
  if (ext === 'txt') return domPages((box) => txtPages(data, box), onProgress);
  const lib = await import('../vendor/docpages.js');
  if (ext === 'pdf') return pdfPages(lib, data, onProgress);
  if (ext === 'docx') {
    return domPages(async (box) => {
      await lib.renderDocx(data, box, null, { inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, experimental: true });
      return fitDocxPages([...box.querySelectorAll('section.docx')]);
    }, onProgress);
  }
  if (ext === 'pptx') return domPages((box) => pptxPages(lib, data, box), onProgress);
  if (ext === 'hwp') return domPages((box) => hwpPages(lib, data, box), onProgress);
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
    for (const u of box.urls ?? []) URL.revokeObjectURL(u); // HWPX 그림 주소 (찍은 뒤에는 필요 없음)
  }
}

// ---------- DOCX 장 나누기 ----------
// docx-preview 는 문서에 저장된 쪽 나눔 표시(Word 가 저장할 때 남김)로만 장을 나눈다 — 다른 프로그램이 만든 문서는 한 장에 다 이어 그려져
//   장 높이를 넘는 장은 문단 · 표 단위로 다음 장에 옮긴다 (머리글 · 바닥글은 장마다 복사, 각주는 첫 장에)
export function fitDocxPages(sections) {
  const out = [];
  const tooTall = (p) => p.scrollHeight > p.clientHeight + 1;
  const articles = (p) => p.querySelectorAll(':scope > article');
  for (const sec of sections) {
    if (!sec.style.minHeight) {
      out.push(sec);
      continue;
    }
    Object.assign(sec.style, { height: sec.style.minHeight, overflow: 'hidden' });
    if (!tooTall(sec)) {
      out.push(sec);
      continue;
    }
    const blocks = [...articles(sec)].flatMap((a, i) => [...a.children].map((el) => ({ el, i })));
    const blank = sec.cloneNode(true);
    blank.querySelectorAll(':scope > :not(header, footer, article)').forEach((n) => n.remove());
    articles(blank).forEach((a) => a.replaceChildren());
    articles(sec).forEach((a) => a.replaceChildren());
    let page = sec;
    let count = 0;
    out.push(page);
    for (const { el, i } of blocks) {
      articles(page)[i].append(el);
      count++;
      // 한 덩어리가 장보다 크면 그 장에 잘린 채로 둔다
      if (count > 1 && tooTall(page)) {
        el.remove();
        const next = blank.cloneNode(true);
        page.after(next);
        out.push((page = next));
        articles(page)[i].append(el);
        count = 1;
      }
    }
  }
  return out;
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
  box.urls = []; // domPages 가 다 찍은 뒤 풀어 준다
  for (const n of Object.keys(zip.files).filter((x) => /^BinData\//i.test(x))) {
    const id = n.split('/').pop().replace(/\.[^.]+$/, '');
    const blob = await zip.file(n).async('blob');
    const url = URL.createObjectURL(blob);
    box.urls.push(url);
    images.set(id, url);
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

// ---------- TXT (UTF-8 / EUC-KR 자동 판별 · A4 장으로 나누기) ----------
export function decodeTxtBytes(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(u8);
    } catch {
      return new TextDecoder('utf-8').decode(u8);
    }
  }
}

function flowTextPages(lines, box) {
  const W = 794;
  const H = 1123;
  const PAD = 72;
  const pages = [];
  let page = null;
  const newPage = () => {
    page = document.createElement('div');
    Object.assign(page.style, { width: `${W}px`, height: `${H}px`, padding: `${PAD}px`, boxSizing: 'border-box', overflow: 'hidden', background: '#fff', color: '#111', font: '15px/1.65 "Malgun Gothic", sans-serif', marginBottom: '8px' });
    box.append(page);
    pages.push(page);
  };
  const list = lines.length ? lines : [''];
  for (const line of list) {
    if (!page) newPage();
    const para = document.createElement('p');
    Object.assign(para.style, { margin: '0 0 4px', minHeight: '1.65em', whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
    para.textContent = line;
    page.append(para);
    if (page.scrollHeight > H && page.childElementCount > 1) {
      para.remove();
      newPage();
      page.append(para);
    }
  }
  return pages;
}

function txtPages(data, box) {
  const text = decodeTxtBytes(data).replace(/\r\n?/g, '\n');
  return flowTextPages(text.split('\n'), box);
}

// ---------- HWP (hwp.js 렌더 + ZIP/HWPX 자동 감지 + OLE2 본문/미리보기 폴백) ----------
async function hwpPages(lib, data, box) {
  // 확장자만 .hwp 인 HWPX(ZIP) 파일은 HWPX 렌더러로 넘긴다
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return hwpxPages(lib, data, box);
  }
  try {
    new lib.HwpViewer(box, data, { type: 'array' }); // eslint-disable-line no-new
    const rendered = [...box.querySelectorAll('[data-page-number]:not(.hwpjs-observer)')];
    const hasContent = rendered.some((p) => p.textContent?.trim() || p.querySelector('canvas, img, svg, table, .hwpjs-shape, div'));
    if (rendered.length && hasContent) return rendered;
  } catch {
    // 비압축 HWP5 · 표/그림 구조 오류 등은 아래 OLE2 본문/미리보기 추출로 폴백
  }
  box.innerHTML = '';
  const paras = await extractHwpParagraphs(data);
  if (!paras.length) throw new Error('한글 문서의 내용을 찾지 못했어요');
  return flowTextPages(paras, box);
}

// OLE2(CFB) 구조에서 BodyText/Section* 레코드와 PrvText(미리보기 텍스트)를 읽어 문단 배열로 돌려준다
export async function extractHwpParagraphs(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < 512 || u8[0] !== 0xd0 || u8[1] !== 0xcf || u8[2] !== 0x11 || u8[3] !== 0xe0) return [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (off) => (off + 2 <= u8.length ? dv.getUint16(off, true) : 0);
  const u32 = (off) => (off + 4 <= u8.length ? dv.getUint32(off, true) : 0xfffffffe);
  const sectorSize = 1 << (u16(30) || 9);
  const miniSectorSize = 1 << (u16(32) || 6);
  const firstDir = u32(48);
  const miniCutoff = u32(56) || 4096;
  const firstMiniFat = u32(60);
  const numMiniFat = u32(64);
  let difatSec = u32(68);
  const numDifat = u32(72);
  const secOff = (s) => (s + 1) * sectorSize;

  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(76 + i * 4);
    if (s < 0xfffffffa) fatSectors.push(s);
  }
  for (let i = 0; i < numDifat && difatSec < 0xfffffffa; i++) {
    const base = secOff(difatSec);
    if (base + sectorSize > u8.length) break;
    const perSec = (sectorSize >> 2) - 1;
    for (let j = 0; j < perSec; j++) {
      const s = u32(base + j * 4);
      if (s < 0xfffffffa) fatSectors.push(s);
    }
    difatSec = u32(base + perSec * 4);
  }
  const fat = [];
  for (const s of fatSectors) {
    const base = secOff(s);
    if (base + sectorSize > u8.length) continue;
    for (let i = 0; i < sectorSize; i += 4) fat.push(u32(base + i));
  }
  const readChain = (start, totalBytes = 0) => {
    const chunks = [];
    let cur = start;
    let seen = 0;
    while (cur < 0xfffffffa && seen < fat.length + 1) {
      const base = secOff(cur);
      if (base + sectorSize > u8.length) break;
      chunks.push(u8.subarray(base, base + sectorSize));
      cur = fat[cur] ?? 0xfffffffe;
      seen++;
    }
    const total = totalBytes > 0 ? totalBytes : chunks.length * sectorSize;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      const n = Math.min(c.length, total - pos);
      if (n <= 0) break;
      out.set(c.subarray(0, n), pos);
      pos += n;
    }
    return out;
  };

  const dirBytes = readChain(firstDir);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const type = dirBytes[off + 66];
    if (!type) continue;
    const nameLen = Math.min(64, dirBytes[off + 64] | (dirBytes[off + 65] << 8));
    const name = nameLen >= 2 ? new TextDecoder('utf-16le').decode(dirBytes.subarray(off, off + nameLen - 2)) : '';
    const start = new DataView(dirBytes.buffer, dirBytes.byteOffset + off + 116, 8).getUint32(0, true);
    const size = new DataView(dirBytes.buffer, dirBytes.byteOffset + off + 120, 4).getUint32(0, true);
    entries.push({ name, type, start, size });
  }
  const root = entries.find((e) => e.type === 5) || entries[0];
  const miniStream = root && root.start < 0xfffffffa ? readChain(root.start) : new Uint8Array(0);
  const miniFatBytes = numMiniFat && firstMiniFat < 0xfffffffa ? readChain(firstMiniFat) : new Uint8Array(0);
  const miniFat = [];
  if (miniFatBytes.length >= 4) {
    const mdv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mdv.getUint32(i, true));
  }
  const readStream = (entry) => {
    if (!entry || !entry.size) return new Uint8Array(0);
    if (entry.size >= miniCutoff || !miniStream.length) return readChain(entry.start, entry.size);
    const out = new Uint8Array(entry.size);
    let cur = entry.start;
    let pos = 0;
    let seen = 0;
    while (cur < 0xfffffffa && pos < entry.size && seen <= miniFat.length + 1) {
      const base = cur * miniSectorSize;
      if (base >= miniStream.length) break;
      const slice = miniStream.subarray(base, Math.min(miniStream.length, base + miniSectorSize));
      const n = Math.min(slice.length, entry.size - pos);
      out.set(slice.subarray(0, n), pos);
      pos += n;
      cur = miniFat[cur] ?? 0xfffffffe;
      seen++;
    }
    return out;
  };

  const fileHeader = readStream(entries.find((e) => /^FileHeader$/i.test(e.name)));
  const compressed = fileHeader.length > 36 ? (fileHeader[36] & 1) !== 0 : false;
  const sections = entries.filter((e) => /^Section\d+$/i.test(e.name))
    .sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));

  const paras = [];
  for (const sec of sections) {
    let raw = readStream(sec);
    if (!raw.length) continue;
    if (compressed) {
      raw = await inflateRawBytes(raw);
    }
    for (const p of parseHwpSectionText(raw)) paras.push(p);
  }
  if (paras.some((p) => p.trim())) return paras;

  const prv = readStream(entries.find((e) => /^PrvText$/i.test(e.name)));
  if (prv.length >= 2) {
    const text = new TextDecoder('utf-16le').decode(prv).replace(/\0+$/g, '').replace(/\r\n?/g, '\n');
    if (text.trim()) return text.split('\n');
  }
  return [];
}

async function inflateRawBytes(u8) {
  if (typeof DecompressionStream === 'undefined') return new Uint8Array(0);
  try {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(u8).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: null }));
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

// HWP 5.0 레코드 스트림에서 HWPTAG_PARA_TEXT(67) 레코드의 문자열을 뽑는다
function parseHwpSectionText(buf) {
  const paras = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hdr = dv.getUint32(pos, true);
    pos += 4;
    const tagId = hdr & 0x3ff;
    let size = (hdr >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (pos + 4 > buf.length) break;
      size = dv.getUint32(pos, true);
      pos += 4;
    }
    if (pos + size > buf.length) break;
    if (tagId === 67 && size >= 2) {
      let s = '';
      for (let i = 0; i + 2 <= size; i += 2) {
        const ch = dv.getUint16(pos + i, true);
        if (ch === 13 || ch === 0) continue;
        if (ch === 10) s += '\n';
        else if (ch === 9) s += '\t';
        else if ([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23].includes(ch)) i += 14; // 8-word(16B) 확장/인라인 컨트롤
        else if (ch >= 32) s += String.fromCharCode(ch);
      }
      for (const line of s.split('\n')) paras.push(line);
    }
    pos += size;
  }
  return paras;
}

// ---------- PPTX (파워포인트 · 슬라이드마다 16:9 장으로 그리기) ----------
async function pptxPages(lib, data, box) {
  const zip = await lib.JSZip.loadAsync(data);
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!slideNames.length) throw new Error('파워포인트 슬라이드를 찾지 못했어요');

  box.urls = [];
  const mediaUrls = new Map();
  for (const n of Object.keys(zip.files).filter((x) => /^ppt\/media\//i.test(x))) {
    const blob = await zip.file(n).async('blob');
    const url = URL.createObjectURL(blob);
    box.urls.push(url);
    mediaUrls.set(n.toLowerCase(), url);
  }

  const W = 960;
  const H = 540;
  const pages = [];
  for (let idx = 0; idx < slideNames.length; idx++) {
    const name = slideNames[idx];
    const relPath = name.replace(/^ppt\/slides\/(slide\d+\.xml)$/i, 'ppt/slides/_rels/$1.rels');
    const relMap = new Map();
    if (zip.file(relPath)) {
      const relXml = new DOMParser().parseFromString(await zip.file(relPath).async('string'), 'application/xml');
      for (const r of [...relXml.getElementsByTagNameNS('*', 'Relationship')]) {
        const id = r.getAttribute('Id');
        const target = r.getAttribute('Target') || '';
        if (id && target) {
          const resolved = target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^(\.\.\/)+/, '')}`;
          relMap.set(id, resolved.toLowerCase());
        }
      }
    }

    const xml = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
    const slide = document.createElement('div');
    Object.assign(slide.style, {
      width: `${W}px`,
      minHeight: `${H}px`,
      padding: '36px 48px',
      boxSizing: 'border-box',
      background: '#fff',
      color: '#111',
      font: '18px/1.5 "Malgun Gothic", sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      position: 'relative',
      marginBottom: '8px',
    });

    const tree = xml.getElementsByTagNameNS('*', 'spTree')[0] ?? xml.documentElement;
    for (const child of [...tree.children]) {
      const tag = child.localName;
      if (tag === 'sp') {
        const ph = child.getElementsByTagNameNS('*', 'ph')[0];
        const phType = ph?.getAttribute('type') || '';
        const isTitle = phType === 'title' || phType === 'ctrTitle';
        const paras = [...child.getElementsByTagNameNS('*', 'p')];
        for (const p of paras) {
          const text = [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('').trim();
          if (!text) continue;
          const el = document.createElement(isTitle ? 'h2' : 'p');
          Object.assign(el.style, isTitle
            ? { margin: '0 0 6px', fontSize: '28px', fontWeight: '700', lineHeight: '1.3', color: '#111' }
            : { margin: '0', fontSize: '18px', lineHeight: '1.5', whiteSpace: 'pre-wrap' });
          el.textContent = text;
          slide.append(el);
        }
      } else if (tag === 'graphicFrame') {
        for (const tbl of [...child.getElementsByTagNameNS('*', 'tbl')]) {
          const t = document.createElement('table');
          Object.assign(t.style, { borderCollapse: 'collapse', width: '100%', margin: '6px 0', fontSize: '15px' });
          for (const tr of [...tbl.getElementsByTagNameNS('*', 'tr')]) {
            const row = t.insertRow();
            for (const tc of [...tr.children].filter((c) => c.localName === 'tc')) {
              const cell = row.insertCell();
              Object.assign(cell.style, { border: '1px solid #999', padding: '4px 8px', verticalAlign: 'top' });
              cell.textContent = [...tc.getElementsByTagNameNS('*', 't')].map((x) => x.textContent).join('');
            }
          }
          slide.append(t);
        }
      } else if (tag === 'pic') {
        const blip = child.getElementsByTagNameNS('*', 'blip')[0];
        const embed = blip?.getAttribute('r:embed') || blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
        const mediaPath = embed && relMap.get(embed);
        const src = mediaPath && mediaUrls.get(mediaPath);
        if (src) {
          const img = document.createElement('img');
          img.src = src;
          Object.assign(img.style, { display: 'block', maxWidth: '100%', maxHeight: '360px', objectFit: 'contain', margin: '4px auto' });
          await img.decode().catch(() => {});
          slide.append(img);
        }
      }
    }

    box.append(slide);
    pages.push(slide);
  }
  return pages;
}
