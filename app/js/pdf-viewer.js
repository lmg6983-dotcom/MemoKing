// 앱 안 PDF 미리보기 (PC · 휴대폰 함께) — PDFium(pdf-engine.js)으로 쪽을 그린다. 상용 PDF 앱(Acrobat · 미리보기 · 삼성 노트)의 모양을 따른다
//   - 위 막대(반투명): 닫기 · 제목(쪽 수) · 주석 · 다른 앱으로 열기
//   - 쪽은 화면에 보일 때만, 가운데에 가까운 쪽부터 한 프레임에 하나씩 그린다 (긴 PDF 도 바로 열림 · 멀리 지나간 쪽은 놓는다)
//   - 아래 쪽 번호 알약: 넘기는 동안 보이고 멈추면 사라진다 · 누르면 쪽 번호로 가기
//   - 확대: 두 손가락 · Ctrl+휠 · 두 번 누르기(100% ↔ 200%) · PC 는 오른쪽 아래 확대 막대
//   - 주석(onSave 가 있을 때): 쪽 위에 펜 · 형광펜 · 지우개 (메모 주석과 같은 도구 막대) — 완료하면 PDF 안에 잉크 주석으로 저장
//     (원본은 그대로, 주석을 넣은 새 PDF 를 onSave 로 넘긴다). 손가락 하나는 그리기, 두 손가락은 넘기기
//   Esc · 휴대폰 뒤로 가기: 주석 중이면 주석 끝내기(저장), 아니면 닫기
import { openPdf } from './pdf-engine.js';
import { icon } from './icons.js';
import { createInkSurface, createInkToolbar, inkHistory, inkTools, inkKeys, strokeEl } from './ink-editor.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, props = {}) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, props);
let current = null; // 열린 보기의 닫기 (뒤로 가기)
const PAGE_KEYS = { ArrowDown: 1, ArrowUp: -1, PageDown: 2, PageUp: -2, ' ': 2, Home: 'top', End: 'end' };
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

/** 떠 있는 미리보기를 닫는다 (주석 중이면 주석만 끝낸다) → 무언가 했는가 (휴대폰 뒤로 가기) */
export const closePdfViewer = () => {
  if (!current) return false;
  current();
  return true;
};
export const pdfViewerOpen = () => Boolean(current);

/**
 * @param {{ bytes: Uint8Array | ArrayBuffer | Promise<ArrayBuffer>, name?: string, onExternal?: () => void,
 *           onSave?: (pdf: Uint8Array) => Promise<void> }} o
 *   bytes 가 Promise 면 보기를 먼저 띄우고 기다린다 (못 읽으면 보기 안에 알린다)
 *   onExternal: "다른 앱으로 열기" (없으면 단추 없음) · onSave: 주석을 넣은 PDF 저장 (없으면 주석 단추 없음)
 */
export async function openPdfViewer({ bytes, name = 'PDF', onExternal = null, onSave = null }) {
  closePdfViewer();
  const view = el('div', 'mk-pdf-view', { role: 'dialog', ariaModal: 'true', ariaLabel: `${name} 미리보기` });
  view.dataset.mode = 'view';
  const iconBtn = (label, iconName, run, cls = '') => {
    const b = el('button', `mk-pdf-ibtn ${cls}`.trim(), { type: 'button', title: label, ariaLabel: label });
    b.append(icon(iconName));
    b.addEventListener('click', run);
    return b;
  };
  // 위 막대
  const bar = el('div', 'mk-pdf-bar');
  const close = iconBtn('닫기 (Esc)', 'close', () => shut());
  const heading = el('div', 'mk-pdf-heading');
  const title = el('div', 'mk-pdf-title', { textContent: name });
  const sub = el('div', 'mk-pdf-sub', { textContent: '여는 중' });
  heading.append(title, sub);
  const annotBtn = onSave ? iconBtn('주석 달기 (펜 · 형광펜)', 'pen', () => setInk(true), 'mk-pdf-annot') : null;
  const ext = onExternal ? iconBtn('다른 앱으로 열기', 'share', () => onExternal()) : null;
  const doneBtn = el('button', 'mk-pdf-done', { type: 'button', textContent: '완료', title: '주석 저장하고 끝내기 (Esc)' });
  doneBtn.addEventListener('click', () => setInk(false));
  bar.append(close, heading, ...(annotBtn ? [annotBtn] : []), ...(ext ? [ext] : []), doneBtn);
  // 쪽들
  const scroller = el('div', 'mk-pdf-scroll');
  const list = el('div', 'mk-pdf-pages');
  const note = el('div', 'mk-pdf-note', { role: 'status' });
  note.append(el('span', 'mk-pdf-spinner'), document.createTextNode('PDF 를 여는 중이에요'));
  scroller.append(list, note);
  // 아래: 쪽 번호 알약 · 확대 막대 (PC)
  const pill = el('button', 'mk-pdf-pill', { type: 'button', title: '쪽 번호로 가기' });
  const zoomBar = el('div', 'mk-pdf-zoombar');
  const zoomLabel = el('button', 'mk-pdf-zoomval', { type: 'button', title: '화면 폭에 맞추기 (Ctrl+0)' });
  zoomLabel.addEventListener('click', () => setZoom(1));
  const zoomBtn = (label, sym, run) => {
    const b = el('button', 'mk-pdf-ibtn mk-pdf-zsym', { type: 'button', title: label, ariaLabel: label, textContent: sym });
    b.addEventListener('click', run);
    return b;
  };
  zoomBar.append(zoomBtn('작게 (Ctrl+−)', '−', () => setZoom(zoom / 1.25)), zoomLabel, zoomBtn('크게 (Ctrl++)', '+', () => setZoom(zoom * 1.25)));
  const toast = el('div', 'mk-pdf-toast', { role: 'status' });
  view.append(bar, scroller, pill, zoomBar, toast);
  document.body.append(view);
  const restore = document.activeElement;
  close.focus();

  let pdf = null;
  let zoom = 1;
  let shutDown = false;
  const pages = []; // { box, svg, w, h (pt), drawnAt, failed }
  const near = new Set();
  let pumping = 0;

  // ---------- 주석 상태: 쪽 → 획들 (쪽 왼쪽 위 기준 pt). 되돌리기는 모든 쪽을 함께 ----------
  const base = new Map(); // PDF 에서 꺼낸 획
  let hist = inkHistory({}); // { [쪽]: 획들 } — 고친 쪽만
  const tools = inkTools();
  let inking = false;
  let surfaces = new Map(); // 쪽 → 그리기판
  let toolbar = null;
  let saving = null;
  const inkOf = (i) => hist.get()[i] ?? base.get(i) ?? [];
  const dirty = () => hist.changed();

  function paintInk(i) {
    const p = pages[i];
    if (!p) return;
    if (!p.svg) {
      p.svg = document.createElementNS(SVGNS, 'svg');
      p.svg.setAttribute('class', 'mk-pdf-ink');
      p.svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
      p.svg.setAttribute('preserveAspectRatio', 'none');
      p.box.append(p.svg);
    }
    if (surfaces.has(i)) return surfaces.get(i).render();
    const g = document.createElementNS(SVGNS, 'g');
    g.append(...inkOf(i).map(strokeEl));
    p.svg.replaceChildren(g);
  }
  function surfaceFor(i) {
    if (surfaces.has(i)) return;
    const p = pages[i];
    paintInk(i);
    p.svg.replaceChildren();
    const surface = createInkSurface(p.svg, {
      tools,
      scroller,
      scale: () => p.svg.getBoundingClientRect().width / p.w,
      getStrokes: () => inkOf(i),
      setStrokes: (next, { undoable, before }) => {
        const all = hist.get();
        hist.set({ ...all, [i]: next }, { undoable, before: before ? { ...all, [i]: before } : all });
        toolbar?.update();
      },
      onDrawStart: () => toolbar?.closePopover(),
    });
    surfaces.set(i, surface);
    surface.render();
  }
  const repaintAll = () => pages.forEach((p, i) => (p.svg || inkOf(i).length) && paintInk(i));

  async function setInk(on) {
    if (on === inking || !pdf) return;
    if (on) {
      inking = true;
      view.dataset.mode = 'ink';
      hist = inkHistory(hist.get());
      pages.forEach((_, i) => surfaceFor(i));
      toolbar = createInkToolbar({
        tools,
        onUndo: () => hist.undo() && afterUndo(),
        onRedo: () => hist.redo() && afterUndo(),
        canUndo: hist.canUndo,
        canRedo: hist.canRedo,
        onClear: () => {
          const all = {};
          pages.forEach((_, i) => { if (inkOf(i).length) all[i] = []; });
          hist.set({ ...hist.get(), ...all });
          afterUndo();
        },
        canClear: () => pages.some((_, i) => inkOf(i).length),
        done: { label: '완료', run: () => setInk(false) },
      });
      view.append(toolbar.el);
      showToast('손가락 하나로 그리고, 두 손가락으로 넘겨요');
      return;
    }
    // 끝내기: 바뀐 것이 있으면 PDF 에 넣어 저장
    inking = false;
    view.dataset.mode = 'view';
    for (const s of surfaces.values()) s.destroy();
    surfaces = new Map();
    toolbar?.el.remove();
    toolbar = null;
    repaintAll();
    if (dirty()) await persist();
  }
  function afterUndo() {
    for (const s of surfaces.values()) s.render();
    toolbar?.update();
  }
  /** 주석을 PDF 에 넣어 저장 → 새 PDF 로 다시 연다 (이어서 고칠 수 있게) */
  function persist() {
    saving ??= (async () => {
      const ink = new Map();
      for (const i of new Set([...base.keys(), ...Object.keys(hist.get()).map(Number)])) ink.set(i, inkOf(i));
      showToast('주석을 저장하는 중이에요', true);
      try {
        const out = pdf.save(ink);
        await onSave(out);
        pdf.close();
        pdf = await openPdf(out);
        base.clear();
        for (const i of ink.keys()) base.set(i, pdf.takeInk(i)); // 방금 넣은 주석을 다시 꺼내 위 층으로
        hist = inkHistory({});
        showToast('주석을 저장했어요');
      } catch (err) {
        console.warn('[PDF 주석]', err);
        showToast(err?.message || '주석을 저장하지 못했어요');
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  let toastTimer = 0;
  function showToast(text, stay = false) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    if (!stay) toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  // ---------- 쪽 그리기 ----------
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
  }, { root: scroller, rootMargin: '800px 0px' });

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
  const baseWidth = () => Math.min(scroller.clientWidth - (scroller.clientWidth < 600 ? 16 : 48), 920); // 쪽 폭 (확대 1) — 화면 폭에 맞추되 PC 는 920px 까지
  const layout = () => {
    const w = Math.round(baseWidth() * zoom);
    for (const p of pages) {
      p.box.style.width = `${w}px`;
      p.box.style.height = `${Math.round((w * p.h) / p.w)}px`;
    }
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    view.classList.toggle('zoomed', zoom > 1.01);
  };
  function draw(i) {
    const p = pages[i];
    if (!p || shutDown || !stale(p)) return;
    const w = want(p);
    try {
      if (!base.has(i)) base.set(i, pdf.takeInk(i)); // 이 쪽의 메모킹 주석은 꺼내서 위 층에 (그림에는 빼고)
      const canvas = pdf.render(i, w);
      canvas.className = 'mk-pdf-canvas';
      const old = p.box.querySelector('canvas');
      if (old) {
        old.width = old.height = 0;
        old.replaceWith(canvas);
      } else p.box.prepend(canvas);
      p.box.classList.add('drawn');
      p.drawnAt = w;
      if (inkOf(i).length || inking) {
        if (inking) surfaceFor(i);
        else paintInk(i);
      }
    } catch (err) {
      p.failed = true;
      p.box.classList.add('drawn', 'failed');
      p.box.dataset.msg = '이 쪽을 그리지 못했어요';
      console.warn('[PDF 미리보기]', err);
    }
  }
  // 멀리 지나간 쪽은 그림을 놓는다 — 긴 PDF 를 끝까지 내려도 메모리가 쌓이지 않게 (쪽 하나 최대 수십 MB)
  function drop(i) {
    const p = pages[i];
    if (!p?.drawnAt) return;
    const c = p.box.querySelector('canvas');
    if (c) {
      c.width = c.height = 0;
      c.remove();
    }
    p.box.classList.remove('drawn');
    p.drawnAt = 0;
  }

  // ---------- 쪽 번호 ----------
  let pillTimer = 0;
  let at = 0;
  function showCount() {
    if (!pages.length) return;
    const mid = scroller.scrollTop + scroller.clientHeight / 3;
    let k = 0;
    for (let i = 0; i < pages.length; i++) if (pages[i].box.offsetTop <= mid) k = i;
    at = k;
    if (!pill.classList.contains('editing')) pill.textContent = `${k + 1} / ${pages.length}`;
  }
  function flashPill() {
    pill.classList.add('show');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => pill.classList.remove('show'), 1400);
  }
  const goPage = (i) => {
    const p = pages[Math.max(0, Math.min(pages.length - 1, i))];
    if (p) scroller.scrollTo({ top: p.box.offsetTop - 12 });
  };
  // 알약을 누르면 쪽 번호 칸으로 바뀐다 (Enter 로 가기 · Esc 나 밖을 누르면 그대로)
  pill.addEventListener('click', () => {
    if (pill.querySelector('input')) return;
    const input = el('input', 'mk-pdf-goto', { type: 'number', min: '1', max: String(pages.length), value: String(at + 1), ariaLabel: '갈 쪽 번호' });
    pill.classList.add('show', 'editing');
    clearTimeout(pillTimer);
    pill.replaceChildren(input, document.createTextNode(` / ${pages.length}`));
    input.select();
    const end = (go) => {
      const n = Number.parseInt(input.value, 10);
      pill.classList.remove('editing');
      showCount();
      flashPill();
      if (go && Number.isFinite(n)) goPage(n - 1);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') end(true);
      else if (e.key === 'Escape') {
        e.stopPropagation();
        end(false);
      }
    });
    input.addEventListener('blur', () => pill.classList.contains('editing') && end(false));
  });

  // ---------- 확대 ----------
  function setZoom(z, anchor = null) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (Math.abs(next - zoom) < 0.01) return;
    // 보던 자리(또는 누른 자리)를 지킨다
    const r = scroller.getBoundingClientRect();
    const ax = anchor ? anchor.x - r.left : scroller.clientWidth / 2;
    const ay = anchor ? anchor.y - r.top : 0;
    const fx = (scroller.scrollLeft + ax) / Math.max(1, scroller.scrollWidth);
    const fy = (scroller.scrollTop + ay) / Math.max(1, scroller.scrollHeight);
    zoom = next;
    layout();
    scroller.scrollLeft = fx * scroller.scrollWidth - ax;
    scroller.scrollTop = fy * scroller.scrollHeight - ay;
    clearTimeout(setZoom.t);
    setZoom.t = setTimeout(pump, 150); // 확대하는 동안은 있던 그림을 늘려 보여 주고, 멈추면 또렷하게
  }
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  // 두 번 누르기: 100% ↔ 200% (누른 자리를 가운데로)
  let lastTap = null;
  scroller.addEventListener('pointerup', (e) => {
    if (inking || touches.size || e.button) return;
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null;
      setZoom(zoom > 1.2 ? 1 : 2, { x: e.clientX, y: e.clientY });
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  });
  // 두 손가락 벌리기 (주석 중에는 두 손가락이 넘기기)
  const touches = new Map();
  let pinch = null;
  scroller.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || inking) return;
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
      setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
  });
  const lift = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  };
  scroller.addEventListener('pointerup', lift);
  scroller.addEventListener('pointercancel', lift);
  // 두 손가락일 때는 브라우저가 스크롤로 가져가지 않게 (가져가면 pointercancel 로 확대가 끊긴다)
  scroller.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 && !inking) e.preventDefault();
  }, { passive: false });
  scroller.addEventListener('scroll', () => {
    showCount();
    if (!inking) flashPill();
  }, { passive: true });

  // ---------- 키 ----------
  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement) { // 쪽 번호 칸: Esc 는 칸만 닫는다
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.target.blur();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (toolbar?.popoverOpen) toolbar.closePopover();
      else if (inking) setInk(false);
      else shut();
      return;
    }
    if (inking && inkKeys(e, { undo: () => hist.undo() && afterUndo(), redo: () => hist.redo() && afterUndo(), setTool: (t) => { tools.tool = t; tools.save(); toolbar?.update(); } })) {
      e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && !e.altKey && PAGE_KEYS[e.key] && !(e.key === ' ' && e.target instanceof HTMLButtonElement)) {
      // 단추에 초점이 있어도 넘기기 (↑↓ 조금 · PageUp/Down · Space 한 화면 · Home/End) — 단추 위 Space 는 단추 누르기
      e.preventDefault();
      const k = PAGE_KEYS[e.key];
      if (k === 'top' || k === 'end') scroller.scrollTo({ top: k === 'top' ? 0 : scroller.scrollHeight });
      else scroller.scrollBy({ top: Math.abs(k) === 1 ? k * 60 : Math.sign(k) * scroller.clientHeight * 0.9 });
    } else if (mod && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      setZoom(zoom * 1.25);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      setZoom(zoom / 1.25);
    } else if (mod && e.key === '0') {
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

  // 닫기 — 주석 중이면 먼저 저장 (뒤로 가기 한 번은 주석만 끝낸다)
  let closing = false;
  async function shut() {
    if (shutDown || closing) return;
    if (inking) return setInk(false);
    closing = true;
    if (saving) await saving;
    shutDown = true;
    current = null;
    cancelAnimationFrame(pumping);
    clearTimeout(setZoom.t);
    io.disconnect();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    pdf?.close();
    view.classList.add('closing');
    setTimeout(() => view.remove(), 140);
    window.dispatchEvent(new Event('mk:pdf-closed'));
    if (restore instanceof HTMLElement && restore.isConnected) restore.focus({ preventScroll: true });
  }
  current = () => void shut();

  try {
    const data = await bytes;
    if (shutDown) return shut;
    pdf = await openPdf(data instanceof Uint8Array ? data : new Uint8Array(data));
  } catch (err) {
    note.replaceChildren(document.createTextNode(err?.message || 'PDF 를 열지 못했어요'));
    note.classList.add('error');
    sub.textContent = '열지 못함';
    return shut;
  }
  if (shutDown) {
    pdf.close();
    return shut;
  }
  note.remove();
  sub.textContent = `${pdf.pageCount}쪽`;
  for (let i = 0; i < pdf.pageCount; i++) {
    const { width, height } = pdf.size(i);
    const box = el('div', 'mk-pdf-page', { ariaLabel: `${i + 1}쪽` });
    box.dataset.i = String(i);
    list.append(box);
    pages.push({ box, svg: null, w: width || 595, h: height || 842, drawnAt: 0, failed: false });
    io.observe(box);
  }
  view.classList.add('ready');
  layout();
  showCount();
  flashPill();
  pump();
  return shut;
}
