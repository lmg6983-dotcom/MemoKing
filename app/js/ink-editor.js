// 손 메모 그리기 (PC·휴대폰 함께) — 획 모양은 오픈소스 perfect-freehand (tldraw·Excalidraw 와 같은 엔진)
//   - 그리기판(createInkSurface): 펜 압력·기울어진 순간의 점들(getCoalescedEvents)까지 받아 매끄럽게
//     · 펜을 한 번 쓰면 그 뒤로 손가락은 화면 넘기기만 (손바닥이 닿아도 그려지지 않게 — 원노트처럼)
//     · 두 손가락은 언제나 넘기기, 펜 뒤쪽 지우개 단추도 지우개
//   - 도구 막대(createInkToolbar): 펜 · 형광펜 · 지우개 · 색 · 굵기 · 되돌리기 (· 바탕: 투명/흰색/검정)
//   - 콘텐츠로서 손 메모(openInkEditor): 메모 위에 덮는 그리기 화면 → 완료하면 그린 만큼의 SVG 한 칸
//   주석으로서 손 메모(메모 위에 겹쳐 그리기)는 ink-annotate.js 가 같은 그리기판·도구 막대를 쓴다
import { getStroke } from '../vendor/perfect-freehand.js';
import { point, strokePath, strokesHit, PEN_COLORS, HIGHLIGHT_COLORS, SIZES, normalizeInk, inkBounds, INK_BG } from './core/ink.js';
import { icon } from './icons.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const STATE_KEY = 'memoking.inkTools';
let penSeen = false; // 이 기기에서 펜을 쓴 적이 있으면 손가락은 넘기기

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
};

/** 고른 도구 (기기마다 기억): { tool, color: { pen, highlighter }, size: { pen, highlighter, eraser }, bg } */
export function inkTools() {
  const s = load();
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const idx = (v) => (Number.isInteger(v) && v >= 0 && v <= 2 ? v : 1);
  const state = {
    tool: pick(s.tool, ['pen', 'highlighter', 'eraser'], 'pen'),
    color: { pen: pick(s.color?.pen, PEN_COLORS, PEN_COLORS[0]), highlighter: pick(s.color?.highlighter, HIGHLIGHT_COLORS, HIGHLIGHT_COLORS[0]) },
    size: { pen: idx(s.size?.pen), highlighter: idx(s.size?.highlighter), eraser: idx(s.size?.eraser) },
    bg: pick(s.bg, Object.keys(INK_BG), 'none'),
  };
  state.save = () => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ tool: state.tool, color: state.color, size: state.size, bg: state.bg }));
    } catch {
      // 이번에만
    }
  };
  return state;
}

function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

function paint(g, strokes) {
  g.replaceChildren(...strokes.map((s) => {
    const p = svgEl('path', { d: strokePath(s, getStroke), fill: s.color });
    if (s.tool === 'highlighter') p.setAttribute('fill-opacity', '0.4');
    return p;
  }));
}

/**
 * 그리기판 — svg 위에서 그리고 지운다
 * @param {SVGSVGElement} svg
 * @param {{ tools: ReturnType<typeof inkTools>, getStrokes: () => object[], setStrokes: (next: object[], { undoable }) => void,
 *           scroller?: HTMLElement, scale?: () => number, onDrawStart?: () => void, enabled?: () => boolean }} o
 *   getStrokes·setStrokes 의 좌표는 svg 안 좌표(px)
 */
export function createInkSurface(svg, o) {
  const committed = svgEl('g', { class: 'ink-strokes' });
  const live = svgEl('path', { class: 'ink-live' });
  const eraserRing = svgEl('circle', { class: 'ink-eraser-ring', r: '0' });
  svg.append(committed, live, eraserRing);
  const pointers = new Map();
  let drawing = null; // { id, stroke } | { id, erase: true, before, removed }
  let pan = null; // { x, y }
  let frame = 0;

  const local = (e) => {
    const r = svg.getBoundingClientRect();
    const k = o.scale?.() ?? 1;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  };
  const isEraser = (e) => o.tools.tool === 'eraser' || (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) === 32));
  const size = (tool) => SIZES[tool][o.tools.size[tool]];

  function render() {
    paint(committed, o.getStrokes());
  }
  function drawLive() {
    frame = 0;
    live.setAttribute('d', drawing?.stroke ? strokePath(drawing.stroke, getStroke) : '');
    if (drawing?.stroke) {
      live.setAttribute('fill', drawing.stroke.color);
      live.setAttribute('fill-opacity', drawing.stroke.tool === 'highlighter' ? '0.4' : '1');
    }
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(drawLive);
  };

  function erase(x, y) {
    const strokes = o.getStrokes();
    const hit = strokesHit(strokes, x, y, size('eraser') / 2);
    if (!hit.length) return;
    drawing.removed = true;
    o.setStrokes(strokes.filter((_, i) => !hit.includes(i)), { undoable: false });
    render();
  }
  function showRing(x, y, on) {
    eraserRing.setAttribute('cx', String(x));
    eraserRing.setAttribute('cy', String(y));
    eraserRing.setAttribute('r', on ? String(size('eraser') / 2) : '0');
  }

  function cancelDrawing() {
    if (drawing?.erase && drawing.removed) o.setStrokes(drawing.before, { undoable: false });
    drawing = null;
    schedule();
    render();
  }

  svg.addEventListener('pointerdown', (e) => {
    if (o.enabled && !o.enabled()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'pen') penSeen = true;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const touches = [...pointers.values()].filter((p) => p.type === 'touch');
    // 손가락: 펜을 쓰는 기기이거나 두 손가락이면 넘기기
    if (e.pointerType === 'touch' && (penSeen || touches.length >= 2)) {
      if (drawing && pointers.get(drawing.id)?.type === 'touch') cancelDrawing();
      pan = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (drawing) return;
    e.preventDefault();
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // 합성 이벤트
    }
    const [x, y] = local(e);
    o.onDrawStart?.();
    if (isEraser(e)) {
      drawing = { id: e.pointerId, erase: true, before: o.getStrokes(), removed: false };
      showRing(x, y, true);
      erase(x, y);
      return;
    }
    const tool = o.tools.tool === 'highlighter' ? 'highlighter' : 'pen';
    const pen = e.pointerType === 'pen';
    drawing = { id: e.pointerId, stroke: { tool, color: o.tools.color[tool], size: size(tool), pen, pts: [point(x, y, pen ? e.pressure || 0.5 : 0.5)] } };
    schedule();
  });

  svg.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (p) Object.assign(p, { x: e.clientX, y: e.clientY });
    if (pan && e.pointerType === 'touch') {
      const touches = [...pointers.values()].filter((t) => t.type === 'touch');
      const cx = touches.reduce((s, t) => s + t.x, 0) / touches.length;
      const cy = touches.reduce((s, t) => s + t.y, 0) / touches.length;
      if (o.scroller) {
        o.scroller.scrollLeft -= cx - pan.x;
        o.scroller.scrollTop -= cy - pan.y;
      }
      pan = { x: cx, y: cy };
      return;
    }
    if (!drawing || e.pointerId !== drawing.id) {
      if (o.tools.tool === 'eraser' && e.pointerType !== 'touch') {
        const [x, y] = local(e);
        showRing(x, y, true);
      }
      return;
    }
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = local(ev);
      if (drawing.erase) {
        showRing(x, y, true);
        erase(x, y);
      } else {
        drawing.stroke.pts.push(point(x, y, drawing.stroke.pen ? ev.pressure || 0.5 : 0.5));
      }
    }
    if (!drawing.erase) schedule();
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pan && ![...pointers.values()].some((t) => t.type === 'touch')) pan = null;
    if (!drawing || e.pointerId !== drawing.id) return;
    const d = drawing;
    drawing = null;
    if (d.erase) {
      showRing(0, 0, false);
      if (d.removed) o.setStrokes(o.getStrokes(), { undoable: true, before: d.before });
      return;
    }
    if (e.type === 'pointercancel') return schedule();
    o.setStrokes([...o.getStrokes(), d.stroke], { undoable: true });
    schedule();
    render();
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !drawing) showRing(0, 0, false);
  });
  svg.addEventListener('contextmenu', (e) => e.preventDefault());

  return { render, cancel: cancelDrawing };
}

/** 되돌리기·다시 하기 기록 (획 목록의 앞뒤 모습) */
export function inkHistory(initial = []) {
  let strokes = initial;
  const undo = [];
  const redo = [];
  return {
    get: () => strokes,
    set(next, { undoable = true, before = strokes } = {}) {
      if (undoable) {
        undo.push(before);
        redo.length = 0;
      }
      strokes = next;
    },
    undo() {
      if (!undo.length) return false;
      redo.push(strokes);
      strokes = undo.pop();
      return true;
    },
    redo() {
      if (!redo.length) return false;
      undo.push(strokes);
      strokes = redo.pop();
      return true;
    },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    changed: () => undo.length > 0,
  };
}

/**
 * 도구 막대
 * @param {{ tools, onChange?: () => void, onUndo, onRedo, canUndo, canRedo, bg?: boolean, onBg?: (bg) => void }} o
 */
export function createInkToolbar(o) {
  const bar = el('div', 'ink-toolbar', { role: 'toolbar', 'aria-label': '손 메모 도구' });
  const btn = (cls, label, content, run) => {
    const b = el('button', `ink-btn ${cls}`, { type: 'button', title: label, 'aria-label': label });
    if (typeof content === 'string') b.append(icon(content));
    else b.append(content);
    b.addEventListener('click', run);
    return b;
  };
  const tools = el('div', 'ink-group ink-tools');
  const toolBtns = {
    pen: btn('', '펜', 'pen', () => setTool('pen')),
    highlighter: btn('', '형광펜', 'highlighter', () => setTool('highlighter')),
    eraser: btn('', '지우개 (획 지우기)', 'eraser', () => setTool('eraser')),
  };
  tools.append(...Object.values(toolBtns));
  const colors = el('div', 'ink-group ink-colors');
  const sizes = el('div', 'ink-group ink-sizes');
  const history = el('div', 'ink-group');
  const undoBtn = btn('', '되돌리기 (Ctrl+Z)', 'undo', () => o.onUndo());
  const redoBtn = btn('', '다시 하기 (Ctrl+Shift+Z)', 'redo', () => o.onRedo());
  history.append(undoBtn, redoBtn);
  bar.append(tools, colors, sizes, history);
  let bgGroup = null;
  if (o.bg) {
    bgGroup = el('div', 'ink-group ink-bgs', { role: 'radiogroup', 'aria-label': '바탕' });
    for (const [bg, label] of [['none', '투명'], ['white', '흰색'], ['black', '검정']]) {
      const b = el('button', `ink-bg ink-bg-${bg}`, { type: 'button', role: 'radio', title: `바탕 ${label}`, 'aria-label': `바탕 ${label}` });
      b.dataset.bg = bg;
      b.textContent = label;
      b.addEventListener('click', () => {
        o.tools.bg = bg;
        // 검은 바탕에 검은 펜(밝은 바탕에 흰 펜)은 안 보이므로 펜 색도 함께
        if (bg === 'black' && o.tools.color.pen === PEN_COLORS[0]) o.tools.color.pen = '#ffffff';
        else if (bg !== 'black' && o.tools.color.pen === '#ffffff') o.tools.color.pen = PEN_COLORS[0];
        o.tools.save();
        o.onBg?.(bg);
        update();
      });
      bgGroup.append(b);
    }
    bar.append(bgGroup);
  }

  function setTool(tool) {
    o.tools.tool = tool;
    o.tools.save();
    update();
    o.onChange?.();
  }

  function update() {
    const t = o.tools.tool;
    for (const [k, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(k === t));
    const list = t === 'highlighter' ? HIGHLIGHT_COLORS : PEN_COLORS;
    colors.hidden = t === 'eraser';
    colors.replaceChildren(...list.map((c) => {
      const b = el('button', 'ink-color', { type: 'button', title: c, 'aria-label': `색 ${c}`, 'aria-pressed': String(o.tools.color[t] === c) });
      b.style.setProperty('--c', c);
      b.addEventListener('click', () => {
        o.tools.color[t] = c;
        o.tools.save();
        update();
      });
      return b;
    }));
    sizes.replaceChildren(...SIZES[t].map((s, i) => {
      const b = el('button', 'ink-size', { type: 'button', title: `굵기 ${i + 1}`, 'aria-label': `굵기 ${i + 1}`, 'aria-pressed': String(o.tools.size[t] === i) });
      const dot = el('span');
      dot.style.width = dot.style.height = `${Math.min(20, 4 + i * 5)}px`;
      b.append(dot);
      b.addEventListener('click', () => {
        o.tools.size[t] = i;
        o.tools.save();
        update();
      });
      return b;
    }));
    undoBtn.disabled = !o.canUndo();
    redoBtn.disabled = !o.canRedo();
    if (bgGroup) for (const b of bgGroup.children) b.setAttribute('aria-checked', String(b.dataset.bg === o.tools.bg));
  }
  update();
  return { el: bar, update };
}

/** 그리기 단축키: Ctrl+Z · Ctrl+Shift+Z · Ctrl+Y, P 펜 · H 형광펜 · E 지우개 */
export function inkKeys(e, { undo, redo, setTool }) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') {
    (e.shiftKey ? redo : undo)();
    return true;
  }
  if (mod && e.code === 'KeyY') {
    redo();
    return true;
  }
  if (mod || e.altKey) return false;
  const tool = { KeyP: 'pen', KeyH: 'highlighter', KeyE: 'eraser' }[e.code];
  if (!tool) return false;
  setTool(tool);
  return true;
}

/**
 * 손 메모 그리기 화면 (콘텐츠로서): 메모 위를 덮고, 완료하면 onSave(자료)
 * @param {{ doc?: object|null, onSave: (doc: object|null) => Promise<void>|void, onClose?: () => void, title?: string }} opts
 *   onSave(null) = 다 지움 (고치던 손 메모를 지우기)
 * @returns {{ close: () => void }}
 */
export function openInkEditor({ doc = null, onSave, onClose, title = '손 메모' }) {
  const tools = inkTools();
  if (tools.tool === 'eraser' && !doc) tools.tool = 'pen';
  const start = normalizeInk(doc ?? { bg: tools.bg, strokes: [] });
  if (doc) tools.bg = start.bg;
  const hist = inkHistory(start.strokes);
  const editing = Boolean(doc);

  const sheet = el('div', 'ink-sheet', { role: 'dialog', 'aria-label': title });
  // 메모 색 바탕 그대로 (휴대폰은 메모 화면에, PC 는 body 에 색이 있다)
  sheet.dataset.color = document.querySelector('#note-screen[data-color]')?.dataset.color ?? document.body.dataset.color ?? 'yellow';
  const head = el('div', 'ink-head');
  const cancel = el('button', 'ink-head-btn', { type: 'button' });
  cancel.textContent = '취소';
  const name = el('b', 'ink-title');
  name.textContent = title;
  const hint = el('span', 'ink-hint');
  const done = el('button', 'ink-head-btn primary', { type: 'button' });
  done.textContent = '완료';
  head.append(cancel, name, hint, done);
  const scroller = el('div', 'ink-scroll');
  const page = el('div', 'ink-page');
  const svg = svgEl('svg', { class: 'ink-canvas' });
  page.append(svg);
  scroller.append(page);
  const toolbar = createInkToolbar({
    tools,
    bg: true,
    onUndo: () => hist.undo() && refresh(),
    onRedo: () => hist.redo() && refresh(),
    canUndo: hist.canUndo,
    canRedo: hist.canRedo,
    onBg: () => paintBg(),
  });
  sheet.append(head, scroller, toolbar.el);
  document.body.append(sheet);
  document.body.classList.add('inking');

  const surface = createInkSurface(svg, {
    tools,
    getStrokes: hist.get,
    setStrokes: (next, opts) => {
      hist.set(next, opts);
      if (opts.undoable) refresh();
    },
    scroller,
  });

  // 그리기판 크기: 화면을 채우고, 그린 것 아래·오른쪽으로 넉넉히 (아래쪽 가까이 그리면 늘어난다)
  function fit() {
    const b = inkBounds(hist.get());
    const w = Math.max(scroller.clientWidth, b ? Math.ceil(b.x + b.w + 40) : 0);
    const h = Math.max(scroller.clientHeight, b ? Math.ceil(b.y + b.h + scroller.clientHeight * 0.6) : 0);
    page.style.width = `${w}px`;
    page.style.height = `${h}px`;
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    Object.assign(svg.style, { width: `${w}px`, height: `${h}px` }); // 아이콘용 svg 크기 규칙을 이긴다
  }
  function paintBg() {
    sheet.dataset.bg = tools.bg;
  }
  function refresh() {
    surface.render();
    toolbar.update();
    fit();
  }
  paintBg();
  refresh();
  new ResizeObserver(() => requestAnimationFrame(fit)).observe(scroller); // 다음 화면에서 (크기를 바꾸며 생기는 고리 경고 없이)

  let warned = 0;
  async function finish(save) {
    if (!save && hist.changed() && Date.now() - warned > 2500) {
      warned = Date.now();
      hint.textContent = '그린 것을 버리려면 한 번 더 누르세요';
      setTimeout(() => (hint.textContent = ''), 2500);
      return;
    }
    if (save) {
      const strokes = hist.get();
      done.disabled = true;
      try {
        if (!strokes.length) await onSave(editing ? null : undefined);
        else {
          // 그린 곳이 왼쪽 위(여백 16)에서 시작하게 옮겨 저장 — 다시 열면 같은 모양으로
          const b = inkBounds(strokes);
          const dx = 16 - b.x;
          const dy = 16 - b.y;
          await onSave({ bg: tools.bg, strokes: strokes.map((s) => ({ ...s, pts: s.pts.map(([x, y, p]) => point(x + dx, y + dy, p)) })) });
        }
      } catch (err) {
        console.error(err);
        hint.textContent = '저장하지 못했어요';
        done.disabled = false;
        return;
      }
    }
    close();
  }
  function close() {
    document.removeEventListener('keydown', onKey, true);
    sheet.classList.add('closing');
    document.body.classList.remove('inking');
    setTimeout(() => sheet.remove(), 160);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      finish(true);
      return;
    }
    if (inkKeys(e, {
      undo: () => hist.undo() && refresh(),
      redo: () => hist.redo() && refresh(),
      setTool: (t) => {
        tools.tool = t;
        tools.save();
        toolbar.update();
      },
    })) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  document.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', () => finish(false));
  done.addEventListener('click', () => finish(true));
  return { close, sheet };
}
