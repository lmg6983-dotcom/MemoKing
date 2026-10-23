// 묶음 사진 보기 (PC·휴대폰 함께) — 카카오톡 묶음 사진처럼 메모에는 몇 장만 모아 보이고, 누르면 크게 한 장씩 넘겨 본다
//   ← → · 밀기로 넘기기, Esc · 닫기. "그리기" 로 그 장 위에 펜 · 형광펜으로 쓰고 완료하면 그린 것을 그 장에 합쳐 저장
//   (원본 파일은 그대로 두고 새 그림 파일로 바꾼다 — 메모에서 되돌리기 Ctrl+Z 로 원래 장으로)
import { createInkSurface, createInkToolbar, inkHistory, inkTools, inkKeys, strokeEl } from './ink-editor.js';
import { icon } from './icons.js';

const SVGNS = 'http://www.w3.org/2000/svg';
let current = null; // 떠 있는 보기 (휴대폰 뒤로 가기가 닫는다)
/** 휴대폰 뒤로 가기: 떠 있으면 닫고 true */
export function closeAlbumViewer() {
  if (!current) return false;
  current();
  return true;
}
const el = (tag, cls, attrs = {}) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, attrs);

/**
 * @param {{ images: { src: string, alt: string }[], start: number, url: (src: string) => string,
 *           onDraw?: (index: number, png: Blob) => Promise<string|null> }} o
 *   onDraw: 그린 장(PNG)을 저장하고 새 src 를 돌려준다 (읽기 전용이면 없음 — 그리기 단추도 없음)
 */
export function openAlbumViewer({ images, start = 0, url, onDraw }) {
  let i = Math.max(0, Math.min(images.length - 1, start));
  const view = el('div', 'mk-album-view', { role: 'dialog', ariaModal: 'true', ariaLabel: '묶음 사진' });
  const head = el('div', 'mk-album-head');
  const count = el('span', 'mk-album-count');
  const draw = el('button', 'mk-album-btn', { type: 'button', title: '이 장 위에 그리기' });
  draw.append(icon('pen'), document.createTextNode('그리기'));
  const close = el('button', 'mk-album-btn', { type: 'button', title: '닫기 (Esc)', ariaLabel: '닫기' });
  close.append(icon('close'));
  head.append(count, ...(onDraw ? [draw] : []), close);
  const stage = el('div', 'mk-album-stage');
  const img = el('img', 'mk-album-big', { draggable: false });
  stage.append(img);
  const prev = el('button', 'mk-album-nav prev', { type: 'button', ariaLabel: '앞 장' });
  const next = el('button', 'mk-album-nav next', { type: 'button', ariaLabel: '다음 장' });
  prev.append(icon('chevrons'));
  next.append(icon('chevrons'));
  view.append(head, stage, prev, next);
  document.body.append(view);
  const restore = document.activeElement;

  function show() {
    const it = images[i];
    img.src = url(it.src);
    img.alt = it.alt ?? '';
    count.textContent = `${i + 1} / ${images.length}`;
    prev.hidden = i === 0;
    next.hidden = i === images.length - 1;
  }
  const go = (d) => {
    if (inking || i + d < 0 || i + d >= images.length) return;
    i += d;
    show();
  };
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));

  // 밀어서 넘기기 (손가락 · 마우스)
  let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!inking) swipe = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  });

  // ---------- 그리기 ----------
  let inking = null; // { svg, surface, toolbar, hist }
  function startInk() {
    if (inking || !img.naturalWidth) return;
    const r = img.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'mk-album-ink');
    Object.assign(svg.style, { left: `${r.left - sr.left}px`, top: `${r.top - sr.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    svg.setAttribute('width', String(r.width));
    svg.setAttribute('height', String(r.height));
    stage.append(svg);
    const tools = inkTools();
    if (tools.tool === 'eraser') tools.tool = 'pen';
    const hist = inkHistory([]);
    const surface = createInkSurface(svg, {
      tools,
      getStrokes: hist.get,
      setStrokes: (list, opts) => {
        hist.set(list, opts);
        if (opts.undoable) refresh();
      },
      onDrawStart: () => toolbar.closePopover(),
    });
    const toolbar = createInkToolbar({
      tools,
      onUndo: () => hist.undo() && refresh(),
      onRedo: () => hist.redo() && refresh(),
      canUndo: hist.canUndo,
      canRedo: hist.canRedo,
      onClear: () => {
        hist.set([], { undoable: true });
        refresh();
      },
      canClear: () => hist.get().length > 0,
      done: { label: '완료', run: () => finishInk() },
    });
    function refresh() {
      surface.render();
      toolbar.update();
    }
    view.append(toolbar.el);
    view.classList.add('inking');
    inking = { svg, surface, toolbar, hist, refresh, tools, w: r.width, h: r.height };
  }
  draw.addEventListener('click', startInk);

  // 그린 획을 그 장의 원래 크기에 합쳐 PNG 로 (그리지 않았으면 그대로)
  async function finishInk() {
    const k = inking;
    if (!k) return;
    inking = null;
    view.classList.remove('inking');
    const strokes = k.hist.get();
    k.surface.destroy();
    k.toolbar.el.remove();
    k.svg.remove();
    if (!strokes.length || !onDraw) return;
    try {
      const png = await flatten(strokes, k.w, k.h);
      const src = await onDraw(i, png);
      if (src) {
        images[i] = { ...images[i], src };
        show();
      }
    } catch (err) {
      console.warn('그린 장을 저장하지 못했어요', err);
    }
  }

  async function flatten(strokes, w, h) {
    const base = new Image();
    base.crossOrigin = 'anonymous'; // 메모 폴더 그림(다른 오리진)도 캔버스로 읽을 수 있게
    base.src = img.currentSrc || img.src;
    await base.decode();
    const W = base.naturalWidth;
    const H = base.naturalHeight;
    const canvas = el('canvas', '', { width: W, height: H });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(base, 0, 0, W, H);
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('xmlns', SVGNS);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    for (const s of strokes) {
      const p = strokeEl(s);
      p.removeAttribute('class'); // 어두운 화면용 색 바꾸기는 빼고 그린 색 그대로
      svg.append(p);
    }
    const layer = new Image();
    layer.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await layer.decode();
    ctx.drawImage(layer, 0, 0, W, H);
    return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('그림을 만들지 못했어요'))), 'image/png'));
  }

  // ---------- 닫기 · 키 ----------
  const onKey = (e) => {
    // 포커스는 이 화면 안에서만 돈다 (뒤의 메모로 빠져 보이지 않는 곳에 글이 써지지 않게)
    if (e.key === 'Tab') {
      const stops = [...view.querySelectorAll('button')].filter((b) => !b.hidden && b.offsetParent);
      const at = stops.indexOf(document.activeElement);
      e.preventDefault();
      stops[(at + (e.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length]?.focus();
      return;
    }
    if (inking) {
      const k = inking;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // 메모 창의 Esc(닫기 등)까지 가지 않게
        finishInk();
        return;
      }
      const setTool = (tool) => {
        k.tools.tool = tool;
        k.refresh();
      };
      if (inkKeys(e, { undo: () => k.hist.undo() && k.refresh(), redo: () => k.hist.redo() && k.refresh(), setTool })) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      shut();
    } else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  async function shut() {
    if (inking) await finishInk();
    document.removeEventListener('keydown', onKey, true);
    current = null;
    view.remove();
    if (restore instanceof HTMLElement && restore.isConnected) restore.focus({ preventScroll: true });
  }
  close.addEventListener('click', shut);
  document.addEventListener('keydown', onKey, true);
  current = shut;
  show();
  close.focus();
  return { close: shut };
}
