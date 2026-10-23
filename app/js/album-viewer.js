// 묶음 사진 보기 (PC·휴대폰 함께) — 카카오톡 묶음 사진처럼 메모에는 몇 장만 모아 보이고, 누르면 크게 한 장씩 넘겨 본다
//   ← → · 밀기로 넘기기, Esc · 닫기. "그리기" 로 그 장 위에 펜 · 형광펜으로 쓰고 완료하면 그린 것을 그 장에 합쳐 저장
//   (원본 파일은 그대로 두고 새 그림 파일로 바꾼다 — 메모에서 되돌리기 Ctrl+Z 로 원래 장으로)
import { createInkSurface, createInkToolbar, inkHistory, inkTools, inkKeys, strokeEl } from './ink-editor.js';
import { icon } from './icons.js';
import { SAVE_ICON, SHARE_ICON, TRASH_ICON } from './content-icons.js';

const HINT_KEY = 'memoking.albumHint'; // 처음 한 번 안내 (이 기기)

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
 * @param {{ images: { src: string, alt: string, inked?: boolean }[], start: number, url: (src: string) => string,
 *           onDraw?: (index: number, png: Blob) => Promise<string|null>,
 *           onSave?: (index: number) => Promise<string|null>, onShare?: (index: number) => Promise<void>,
 *           onDelete?: (index: number) => object[]|null, onUndo?: () => object[] }} o
 *   onDraw: 그린 장(PNG)을 저장하고 새 src 를 돌려준다 · onSave: 이 장 저장 (알릴 말) · onShare: 이 장 공유 (휴대폰)
 *   onDelete: 이 장을 묶음에서 빼고 남은 장들 · onUndo: 방금 뺀 것 되돌리기 → 장들. 없는 것은 단추도 없다 (읽기 전용)
 */
export function openAlbumViewer({ images, start = 0, url, onDraw, onSave, onShare, onDelete, onUndo }) {
  let i = Math.max(0, Math.min(images.length - 1, start));
  const view = el('div', 'mk-album-view', { role: 'dialog', ariaModal: 'true', ariaLabel: '묶음 사진' });
  const head = el('div', 'mk-album-head');
  const count = el('span', 'mk-album-count');
  const inkedMark = el('span', 'mk-album-inked');
  inkedMark.append(icon('pen'), document.createTextNode('그린 장'));
  const svgBtn = (label, svg, run) => {
    const b = el('button', 'mk-album-btn mk-album-icon', { type: 'button', title: label, ariaLabel: label });
    b.innerHTML = svg;
    b.addEventListener('click', run);
    return b;
  };
  const save = onSave ? svgBtn('이 장 저장', SAVE_ICON, () => act(onSave)) : null;
  const share = onShare ? svgBtn('이 장 공유', SHARE_ICON, () => act(onShare)) : null;
  const del = onDelete ? svgBtn('이 장 삭제', TRASH_ICON, () => removePage()) : null;
  const draw = el('button', 'mk-album-btn', { type: 'button', title: '이 장 위에 그리기' });
  draw.append(icon('pen'), document.createTextNode('그리기'));
  const close = el('button', 'mk-album-btn', { type: 'button', title: '닫기 (Esc)', ariaLabel: '닫기' });
  close.append(icon('close'));
  head.append(count, inkedMark, el('span', 'mk-album-gap'), ...[save, share, del].filter(Boolean), ...(onDraw ? [draw] : []), close);
  const stage = el('div', 'mk-album-stage');
  const img = el('img', 'mk-album-big', { draggable: false });
  stage.append(img);
  const prev = el('button', 'mk-album-nav prev', { type: 'button', ariaLabel: '앞 장' });
  const next = el('button', 'mk-album-nav next', { type: 'button', ariaLabel: '다음 장' });
  prev.append(icon('chevrons'));
  next.append(icon('chevrons'));
  // 아래 쪽 목록: 장이 많은 문서도 원하는 장으로 바로 (지금 장은 테두리, 그린 장은 펜 표시)
  const strip = el('div', 'mk-album-strip', { role: 'tablist', ariaLabel: '장 목록' });
  const note = el('div', 'mk-album-note', { role: 'status' }); // 알림 (저장했어요 · 삭제 되돌리기 · 처음 한 번 안내)
  view.append(head, stage, prev, next, strip, note);
  document.body.append(view);
  const restore = document.activeElement;

  function paintStrip() {
    strip.hidden = images.length < 2;
    strip.replaceChildren(...images.map((it, k) => {
      const b = el('button', `mk-album-thumb${k === i ? ' on' : ''}${it.inked ? ' inked' : ''}`, { type: 'button', role: 'tab', ariaLabel: `${k + 1}번째 장`, title: `${k + 1}번째 장${it.inked ? ' (그린 장)' : ''}` });
      b.setAttribute('aria-selected', String(k === i));
      const t = el('img', '', { src: url(it.src), alt: '', loading: 'lazy', draggable: false });
      b.append(t);
      b.addEventListener('click', () => goTo(k));
      return b;
    }));
  }
  function show() {
    const it = images[i];
    img.src = url(it.src);
    img.alt = it.alt ?? '';
    count.textContent = `${i + 1} / ${images.length}`;
    inkedMark.hidden = !it.inked;
    prev.hidden = i === 0;
    next.hidden = i === images.length - 1;
    strip.querySelectorAll('.mk-album-thumb').forEach((b, k) => {
      b.classList.toggle('on', k === i);
      b.classList.toggle('inked', Boolean(images[k]?.inked));
      b.setAttribute('aria-selected', String(k === i));
    });
    strip.children[i]?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  const goTo = (k) => {
    if (inking || k < 0 || k >= images.length) return;
    i = k;
    show();
  };
  const go = (d) => goTo(i + d);

  // 알림 한 줄 (몇 초 뒤 사라짐) — action: { label, run } 단추 하나
  let noteTimer = 0;
  function say(text, action = null) {
    clearTimeout(noteTimer);
    note.replaceChildren(document.createTextNode(text));
    if (action) {
      const b = el('button', 'mk-album-note-btn', { type: 'button', textContent: action.label });
      b.addEventListener('click', () => {
        note.hidden = true;
        action.run();
      });
      note.append(b);
    }
    note.hidden = false;
    noteTimer = setTimeout(() => (note.hidden = true), action ? 6000 : 2600);
  }
  note.hidden = true;
  async function act(fn) {
    try {
      const msg = await fn(i);
      if (msg) say(msg);
    } catch (err) {
      say(err?.message || '하지 못했어요');
    }
  }
  // 이 장 빼기 → 남은 장으로 (다 빼면 닫힘) · 알림의 "되돌리기" 로 되살림
  function removePage() {
    if (inking) return;
    const left = onDelete(i);
    if (!left) return;
    if (!left.length) {
      shut();
      return;
    }
    images.splice(0, images.length, ...left);
    i = Math.min(i, images.length - 1);
    paintStrip();
    show();
    say('이 장을 묶음에서 삭제했어요', onUndo && {
      label: '되돌리기',
      run: () => {
        const back = onUndo();
        if (!back?.length) return;
        images.splice(0, images.length, ...back);
        i = Math.min(i, images.length - 1);
        paintStrip();
        show();
      },
    });
  }
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
    view.classList.add('inking'); // 도구 막대 자리를 비운 뒤에 그림 크기를 잰다 (그리기판이 그림에 꼭 맞게)
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
        images[i] = { ...images[i], src, inked: true };
        paintStrip();
        show();
        say('그린 것을 이 장에 저장했어요');
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
    else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(images.length - 1);
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
  paintStrip();
  show();
  // 처음 한 번: 넘기는 법 · 그리기 (손가락 화면은 밀기, PC 는 화살표)
  try {
    if (!localStorage.getItem(HINT_KEY) && images.length > 1) {
      localStorage.setItem(HINT_KEY, '1');
      const coarse = matchMedia('(pointer: coarse)').matches;
      say(coarse ? '옆으로 밀거나 아래 장을 눌러 넘겨요. 그리기로 이 장 위에 쓸 수 있어요' : '← → 나 아래 장을 눌러 넘겨요. 그리기로 이 장 위에 쓸 수 있어요');
    }
  } catch {
    // 저장소를 못 써도 보기는 그대로
  }
  close.focus();
  return { close: shut };
}
