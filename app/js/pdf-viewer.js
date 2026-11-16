// 앱 안 PDF 미리보기 (PC · 휴대폰 함께) — PDFium(pdf-engine.js)으로 쪽을 그린다.
//   쪽은 화면에 보일 때만 그리고(긴 PDF 도 바로 열림), 위아래로 넘겨 본다. 확대: − + 단추 · Ctrl+휠 · 두 손가락 벌리기
//   위 막대: 쪽 번호 · 확대 · 다른 앱으로 열기 · 닫기 (Esc · 휴대폰 뒤로 가기)
import { openPdf } from './pdf-engine.js';
import { icon } from './icons.js';

const el = (tag, cls, props = {}) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, props);
let current = null; // 열린 보기의 닫기
const PAGE_KEYS = { ArrowDown: 1, ArrowUp: -1, PageDown: 2, PageUp: -2, ' ': 2, Home: 'top', End: 'end' };

/** 떠 있는 미리보기를 닫는다 → 닫았는가 (휴대폰 뒤로 가기) */
export const closePdfViewer = () => {
  if (!current) return false;
  current();
  return true;
};
export const pdfViewerOpen = () => Boolean(current);

/**
 * @param {{ bytes: Uint8Array | ArrayBuffer | Promise<ArrayBuffer>, name?: string, onExternal?: () => void }} o
 *   bytes 가 Promise 면 보기를 먼저 띄우고 기다린다 (못 읽으면 보기 안에 알린다)
 *   onExternal: "다른 앱으로 열기" (없으면 단추 없음)
 */
export async function openPdfViewer({ bytes, name = 'PDF', onExternal = null }) {
  closePdfViewer();
  const view = el('div', 'mk-pdf-view', { role: 'dialog', ariaModal: 'true', ariaLabel: `${name} 미리보기` });
  const head = el('div', 'mk-pdf-head');
  const title = el('span', 'mk-pdf-title', { textContent: name });
  const count = el('span', 'mk-pdf-count');
  const btn = (label, iconName, text, run) => {
    const b = el('button', 'mk-pdf-btn', { type: 'button', title: label, ariaLabel: label });
    if (iconName) b.append(icon(iconName));
    if (text) b.append(el('span', '', { textContent: text }));
    b.addEventListener('click', run);
    return b;
  };
  const out = btn('작게', null, '−', () => setZoom(zoom / 1.25));
  const zoomLabel = el('span', 'mk-pdf-zoom');
  const inn = btn('크게', null, '+', () => setZoom(zoom * 1.25));
  const ext = onExternal ? btn('다른 앱으로 열기', null, '다른 앱으로', () => onExternal()) : null;
  const close = btn('닫기 (Esc)', 'close', '', () => shut());
  head.append(title, count, el('span', 'mk-pdf-gap'), out, zoomLabel, inn, ...(ext ? [ext] : []), close);
  const scroller = el('div', 'mk-pdf-scroll');
  const list = el('div', 'mk-pdf-pages');
  const note = el('div', 'mk-pdf-note', { role: 'status', textContent: 'PDF 를 여는 중이에요' });
  scroller.append(list, note);
  view.append(head, scroller);
  document.body.append(view);
  const restore = document.activeElement;
  close.focus();

  let pdf = null;
  let zoom = 1;
  let shutDown = false;
  const pages = []; // { box, canvas, drawnAt (그린 폭) }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.i);
      if (e.isIntersecting) near.add(i);
      else {
        near.delete(i);
        drop(i);
      }
    }
    pump();
    showCount();
  }, { root: scroller, rootMargin: '600px 0px' });

  // 그릴 쪽은 한 프레임에 하나씩, 화면 가운데에 가까운 쪽부터 — 한꺼번에 그리느라 스크롤 · 확대가 멈칫하지 않게
  const near = new Set();
  let pumping = 0;
  function pump() {
    if (pumping || shutDown || !pdf) return;
    pumping = requestAnimationFrame(() => {
      pumping = 0;
      const mid = scroller.scrollTop + scroller.clientHeight / 2;
      let best = -1;
      let gap = Infinity;
      for (const i of near) {
        const p = pages[i];
        if (!stale(p)) continue;
        const d = Math.abs(p.box.offsetTop + p.box.offsetHeight / 2 - mid);
        if (d < gap) [best, gap] = [i, d];
      }
      if (best < 0) return;
      draw(best);
      pump();
    });
  }
  const want = (p) => Math.min(4096, Math.round(p.box.clientWidth * Math.min(2.5, window.devicePixelRatio || 1))); // 크게 확대해도 캔버스는 4096px 까지 (메모리)
  const stale = (p) => !p.failed && !(p.drawnAt && Math.abs(p.drawnAt - want(p)) < 8);
  const baseWidth = () => Math.min(scroller.clientWidth - 24, 900); // 쪽 폭 (확대 1) — 화면 폭에 맞추되 PC 는 900px 까지
  const layout = () => {
    const w = Math.round(baseWidth() * zoom);
    for (const p of pages) {
      p.box.style.width = `${w}px`;
      p.box.style.height = `${Math.round((w * p.h) / p.w)}px`;
    }
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  };
  function draw(i) {
    const p = pages[i];
    if (!p || shutDown || !stale(p)) return;
    const w = want(p);
    try {
      const canvas = pdf.render(i, w);
      canvas.className = 'mk-pdf-canvas';
      const old = p.box.firstChild;
      if (old instanceof HTMLCanvasElement) old.width = old.height = 0;
      p.box.replaceChildren(canvas);
      p.drawnAt = w;
    } catch (err) {
      p.failed = true;
      p.box.textContent = '이 쪽을 그리지 못했어요';
      console.warn('[PDF 미리보기]', err);
    }
  }
  // 멀리 지나간 쪽은 그림을 놓는다 — 긴 PDF 를 끝까지 내려도 메모리가 쌓이지 않게 (쪽 하나 최대 수십 MB)
  function drop(i) {
    const p = pages[i];
    if (!p?.drawnAt) return;
    const c = p.box.firstChild;
    if (c instanceof HTMLCanvasElement) c.width = c.height = 0;
    p.box.replaceChildren();
    p.drawnAt = 0;
  }
  function showCount() {
    if (!pages.length) return;
    const mid = scroller.scrollTop + scroller.clientHeight / 3;
    let at = 0;
    for (let i = 0; i < pages.length; i++) if (pages[i].box.offsetTop <= mid) at = i;
    count.textContent = `${at + 1} / ${pages.length}`;
  }
  function setZoom(z) {
    const next = Math.max(0.5, Math.min(4, z));
    if (Math.abs(next - zoom) < 0.01) return;
    const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight); // 보던 자리를 지킨다
    zoom = next;
    layout();
    scroller.scrollTop = ratio * scroller.scrollHeight;
    // 보이는 쪽은 새 크기로 다시 그린다 (흐려지지 않게)
    clearTimeout(setZoom.t);
    setZoom.t = setTimeout(pump, 150); // 확대하는 동안은 있던 그림을 늘려 보여 주고, 멈추면 또렷하게
  }

  // 확대: Ctrl+휠 (터치패드 벌리기) · 두 손가락
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
  const touches = new Map();
  let pinch = null;
  scroller.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom };
    }
  });
  scroller.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
    }
  });
  const lift = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  };
  // 두 손가락일 때는 브라우저가 스크롤로 가져가지 않게 (가져가면 pointercancel 로 확대가 끊긴다)
  scroller.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  scroller.addEventListener('pointerup', lift);
  scroller.addEventListener('pointercancel', lift);
  scroller.addEventListener('scroll', showCount, { passive: true });

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      shut();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && PAGE_KEYS[e.key] && !(e.key === ' ' && e.target instanceof HTMLButtonElement)) {
      // 단추에 초점이 있어도 넘기기 (↑↓ 조금 · PageUp/Down · Space 한 화면 · Home/End) — 단추 위 Space 는 단추 누르기
      e.preventDefault();
      const k = PAGE_KEYS[e.key];
      if (k === 'top' || k === 'end') scroller.scrollTo({ top: k === 'top' ? 0 : scroller.scrollHeight });
      else scroller.scrollBy({ top: Math.abs(k) === 1 ? k * 60 : Math.sign(k) * scroller.clientHeight * 0.9 });
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      setZoom(zoom * 1.25);
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      setZoom(zoom / 1.25);
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      setZoom(1);
    }
  };
  document.addEventListener('keydown', onKey, true);
  const onResize = () => {
    layout();
    showCount();
    pump();
  };
  window.addEventListener('resize', onResize);

  function shut() {
    if (shutDown) return;
    shutDown = true;
    current = null;
    cancelAnimationFrame(pumping);
    clearTimeout(setZoom.t);
    io.disconnect();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    pdf?.close();
    view.remove();
    window.dispatchEvent(new Event('mk:pdf-closed'));
    if (restore instanceof HTMLElement && restore.isConnected) restore.focus({ preventScroll: true });
  }
  current = shut;

  try {
    const data = await bytes;
    if (shutDown) return shut;
    pdf = await openPdf(data instanceof Uint8Array ? data : new Uint8Array(data));
  } catch (err) {
    note.textContent = err?.message || 'PDF 를 열지 못했어요';
    return shut;
  }
  if (shutDown) {
    pdf.close();
    return shut;
  }
  note.remove();
  for (let i = 0; i < pdf.pageCount; i++) {
    const { width, height } = pdf.size(i);
    const box = el('div', 'mk-pdf-page', { ariaLabel: `${i + 1}쪽` });
    box.dataset.i = String(i);
    list.append(box);
    pages.push({ box, w: width || 595, h: height || 842, drawnAt: 0 });
    io.observe(box);
  }
  layout();
  showCount();
  pump();
  return shut;
}
