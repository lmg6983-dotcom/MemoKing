// 손 메모 그리기 (PC·휴대폰 함께) — 획 모양은 오픈소스 perfect-freehand (tldraw·Excalidraw 와 같은 엔진)
//   - 그리기판(createInkSurface): 펜 압력·기울어진 순간의 점들(getCoalescedEvents)까지 받아 매끄럽게
//     · 펜을 한 번 쓰면 그 뒤로 손가락은 화면 넘기기만 (손바닥이 닿아도 그려지지 않게 — 원노트처럼)
//     · 두 손가락은 언제나 넘기기, 펜 뒤쪽 지우개 단추도 지우개
//   - 도구 막대(createInkToolbar): 아래에 떠 있는 한 줄 — 펜 · 형광펜 · 지우개 · 색·굵기 · 되돌리기 (· 바탕) — 색·굵기·바탕은 위로 여는 작은 판
//   - 콘텐츠로서 손 메모(openInkEditor): 메모 위에 덮는 그리기 화면 → 완료(또는 Esc·뒤로)하면 그린 만큼의 SVG 한 칸. 취소는 없다
//   주석으로서 손 메모(메모 위에 겹쳐 그리기)는 ink-annotate.js 가 같은 그리기판·도구 막대를 쓴다
import { getStroke } from '../vendor/perfect-freehand.js';
import { point, strokePath, strokesHit, PEN_COLORS, HIGHLIGHT_COLORS, SIZES, normalizeInk, inkBounds, INK_BG, inkTone } from './core/ink.js';
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

/** 획 하나 → path (검은·흰 펜에는 ink-k·ink-w — 어두운 화면에서 CSS 가 서로 바꿔 칠한다) */
export function strokeEl(s) {
  const p = svgEl('path', { d: strokePath(s, getStroke), fill: s.color });
  if (s.tool === 'highlighter') p.setAttribute('fill-opacity', '0.4');
  const tone = inkTone(s);
  if (tone) p.setAttribute('class', tone);
  return p;
}
function paint(g, strokes) {
  g.replaceChildren(...strokes.map(strokeEl));
}
/** 색 표시(단추·점·붓 미리 보기)에도 같은 밝기 성질 */
function setTone(node, tool, color) {
  node.classList.remove('ink-k', 'ink-w');
  const tone = inkTone({ tool, color });
  if (tone) node.classList.add(tone);
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
  // 마우스·펜을 올려 두면 지금 도구의 굵기·색을 미리 보여 준다 (지우개는 점선 고리)
  const cursor = svgEl('circle', { class: 'ink-cursor', r: '0' });
  svg.append(committed, live, cursor);
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
      setTone(live, drawing.stroke.tool, drawing.stroke.color);
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
  function showRing(x, y, on, tool = 'eraser') {
    cursor.setAttribute('cx', String(x));
    cursor.setAttribute('cy', String(y));
    cursor.setAttribute('r', on ? String(Math.max(2, size(tool) / 2)) : '0');
    cursor.classList.toggle('erase', tool === 'eraser');
    if (tool !== 'eraser') {
      cursor.style.setProperty('--c', o.tools.color[tool]);
      setTone(cursor, tool, o.tools.color[tool]);
    } else setTone(cursor, 'highlighter', '');
    svg.classList.toggle('has-cursor', on);
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
    showRing(0, 0, false);
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
      if (!drawing && e.pointerType !== 'touch' && (!o.enabled || o.enabled())) {
        const [x, y] = local(e);
        showRing(x, y, true, isEraser(e) ? 'eraser' : o.tools.tool);
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
    if (e.pointerType !== 'touch' && !drawing) showRing(0, 0, false);
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

const TOOL_NAMES = { pen: '펜', highlighter: '형광펜', eraser: '지우개' };
const BG_NAMES = { none: '투명', white: '흰색', black: '검정' };
const haptic = () => {
  if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(6);
};

/**
 * 도구 막대 — 떠 있는 한 줄 (dock): [펜 · 형광펜 · 지우개] [색·굵기] [되돌리기 · 다시 하기] [바탕] [완료]
 *   - 고른 도구를 한 번 더 누르거나 색·굵기 단추를 누르면 위로 작은 판(popover)이 열린다
 *     (펜·형광펜: 색 + 굵기 · 지우개: 굵기 + 모두 지우기 · 바탕: 투명/흰색/검정). 그리기 시작하거나 밖을 누르면 닫힘
 * @param {{ tools, onChange?: () => void, onUndo, onRedo, canUndo, canRedo, bg?: boolean, onBg?: (bg) => void,
 *           onClear?: () => void, canClear?: () => boolean, done?: { label: string, run: () => void } }} o
 */
export function createInkToolbar(o) {
  const bar = el('div', 'ink-toolbar ink-dock', { role: 'toolbar', 'aria-label': '손 메모 도구' });
  const btn = (cls, label, content, run) => {
    const b = el('button', `ink-btn ${cls}`.trim(), { type: 'button', title: label, 'aria-label': label });
    if (typeof content === 'string') b.append(icon(content));
    else if (content) b.append(content);
    b.addEventListener('click', run);
    return b;
  };
  const group = (cls = '') => el('div', `ink-group ${cls}`.trim());

  const tools = group('ink-tools');
  const toolBtns = {};
  for (const [t, label, key] of [['pen', '펜', 'P'], ['highlighter', '형광펜', 'H'], ['eraser', '지우개 (획 지우기)', 'E']]) {
    const b = btn(`ink-tool ink-tool-${t}`, `${label} (${key}) — 한 번 더 누르면 ${t === 'eraser' ? '굵기·모두 지우기' : '색·굵기'}`, t, () => {
      if (o.tools.tool === t) togglePop('style');
      else setTool(t);
    });
    if (t !== 'eraser') b.append(el('span', 'ink-tool-color'));
    toolBtns[t] = b;
    tools.append(b);
  }
  const styleBtn = btn('ink-style', '색 · 굵기', el('span', 'ink-style-dot'), () => togglePop('style'));
  styleBtn.setAttribute('aria-haspopup', 'true');
  const styleGroup = group();
  styleGroup.append(styleBtn);
  const history = group();
  const undoBtn = btn('', '되돌리기 (Ctrl+Z)', 'undo', () => o.onUndo());
  const redoBtn = btn('', '다시 하기 (Ctrl+Shift+Z)', 'redo', () => o.onRedo());
  history.append(undoBtn, redoBtn);
  bar.append(tools, styleGroup, history);
  let bgBtn = null;
  if (o.bg) {
    bgBtn = btn('ink-bg-btn', '바탕 (투명 · 흰색 · 검정)', el('span', 'ink-bg-swatch'), () => togglePop('bg'));
    bgBtn.setAttribute('aria-haspopup', 'true');
    const g = group();
    g.append(bgBtn);
    bar.append(g);
  }
  let doneBtn = null;
  if (o.done) {
    doneBtn = el('button', 'ink-done', { type: 'button', title: `${o.done.label} (Esc)`, 'aria-label': o.done.label });
    const label = el('span', 'ink-done-label');
    label.textContent = o.done.label;
    doneBtn.append(icon('check'), label);
    doneBtn.addEventListener('click', () => o.done.run());
    bar.append(doneBtn);
  }

  // ---------- 작은 판 ----------
  const pop = el('div', 'ink-pop', { role: 'dialog' });
  pop.hidden = true;
  bar.append(pop);
  let popKind = null;
  function togglePop(kind) {
    if (popKind === kind) return closePop();
    popKind = kind;
    haptic();
    fillPop();
    pop.hidden = false;
    pop.classList.remove('in');
    void pop.offsetWidth; // 다시 열 때도 움직임이 보이게
    pop.classList.add('in');
    document.addEventListener('pointerdown', outside, true);
    update();
  }
  function closePop() {
    if (!popKind) return false;
    popKind = null;
    pop.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
    update();
    return true;
  }
  const outside = (e) => {
    if (!bar.contains(e.target)) closePop();
  };
  const row = (title, ...items) => {
    const r = el('div', 'ink-pop-row');
    if (title) {
      const h = el('div', 'ink-pop-title');
      h.textContent = title;
      r.append(h);
    }
    const body = el('div', 'ink-pop-items');
    body.append(...items);
    r.append(body);
    return r;
  };
  function fillPop() {
    const t = o.tools.tool;
    if (popKind === 'bg') {
      pop.setAttribute('aria-label', '바탕');
      const items = Object.keys(BG_NAMES).map((bg) => {
        const b = el('button', `ink-bg ink-bg-${bg}`, { type: 'button', role: 'radio', 'aria-label': `바탕 ${BG_NAMES[bg]}`, 'aria-checked': String(o.tools.bg === bg) });
        b.dataset.bg = bg;
        b.append(el('span', 'ink-bg-preview'), document.createTextNode(BG_NAMES[bg]));
        b.addEventListener('click', () => {
          o.tools.bg = bg;
          // 검은 바탕에 검은 펜(밝은 바탕에 흰 펜)은 안 보이므로 펜 색도 함께
          if (bg === 'black' && o.tools.color.pen === PEN_COLORS[0]) o.tools.color.pen = '#ffffff';
          else if (bg !== 'black' && o.tools.color.pen === '#ffffff') o.tools.color.pen = PEN_COLORS[0];
          o.tools.save();
          o.onBg?.(bg);
          haptic();
          fillPop();
          update();
        });
        return b;
      });
      const r = row('바탕', ...items);
      r.querySelector('.ink-pop-items').setAttribute('role', 'radiogroup');
      pop.replaceChildren(r, hintRow('투명이면 메모 바탕이 비쳐요'));
      return;
    }
    pop.setAttribute('aria-label', `${TOOL_NAMES[t]} 설정`);
    const sizes = SIZES[t].map((sz, i) => {
      const b = el('button', 'ink-size', { type: 'button', title: `굵기 ${i + 1}`, 'aria-label': `굵기 ${i + 1}`, 'aria-pressed': String(o.tools.size[t] === i) });
      const dot = el('span');
      const px = t === 'eraser' ? 8 + i * 6 : t === 'highlighter' ? 8 + i * 4 : Math.max(3, sz * 1.6);
      dot.style.width = dot.style.height = `${Math.min(24, px)}px`;
      if (t !== 'eraser') {
        dot.style.setProperty('--c', o.tools.color[t]);
        setTone(dot, t, o.tools.color[t]);
      }
      b.append(dot);
      b.addEventListener('click', () => {
        o.tools.size[t] = i;
        o.tools.save();
        haptic();
        fillPop();
        update();
      });
      return b;
    });
    if (t === 'eraser') {
      const clear = el('button', 'ink-clear', { type: 'button' });
      clear.append(icon('trash'), document.createTextNode('모두 지우기'));
      clear.disabled = !(o.canClear?.() ?? false);
      clear.addEventListener('click', () => {
        o.onClear?.();
        haptic();
        closePop();
      });
      pop.replaceChildren(row('지우개 굵기', ...sizes), ...(o.onClear ? [row('', clear)] : []), hintRow('닿은 획을 통째로 지워요 · 되돌리기로 살릴 수 있어요'));
      return;
    }
    const list = t === 'highlighter' ? HIGHLIGHT_COLORS : PEN_COLORS;
    const colors = list.map((c) => {
      const b = el('button', 'ink-color', { type: 'button', title: c, 'aria-label': `색 ${c}`, 'aria-pressed': String(o.tools.color[t] === c) });
      b.style.setProperty('--c', c);
      setTone(b, t, c);
      b.addEventListener('click', () => {
        o.tools.color[t] = c;
        o.tools.save();
        haptic();
        fillPop();
        update();
      });
      return b;
    });
    pop.replaceChildren(row(`${TOOL_NAMES[t]} 색`, ...colors), row('굵기', ...sizes));
  }
  function hintRow(text) {
    const h = el('div', 'ink-pop-hint');
    h.textContent = text;
    return h;
  }

  function setTool(tool) {
    o.tools.tool = tool;
    o.tools.save();
    haptic();
    if (popKind === 'style') fillPop();
    else closePop();
    update();
    o.onChange?.();
  }

  function update() {
    const t = o.tools.tool;
    for (const [k, b] of Object.entries(toolBtns)) {
      b.setAttribute('aria-pressed', String(k === t));
      const bar = b.querySelector('.ink-tool-color');
      if (bar) {
        bar.style.setProperty('--c', o.tools.color[k]);
        setTone(bar, k, o.tools.color[k]);
      }
    }
    const dot = styleBtn.firstElementChild;
    const sz = SIZES[t][o.tools.size[t]];
    styleBtn.dataset.tool = t;
    dot.style.setProperty('--c', t === 'eraser' ? 'transparent' : o.tools.color[t]);
    setTone(dot, t === 'eraser' ? 'highlighter' : t, o.tools.color[t]);
    dot.style.setProperty('--d', `${t === 'eraser' ? 8 + o.tools.size[t] * 5 : Math.min(20, Math.max(6, sz * (t === 'highlighter' ? 0.7 : 2.2)))}px`);
    styleBtn.setAttribute('aria-expanded', String(popKind === 'style'));
    styleBtn.title = t === 'eraser' ? '지우개 굵기 · 모두 지우기' : `${TOOL_NAMES[t]} 색 · 굵기`;
    if (bgBtn) {
      bgBtn.dataset.bg = o.tools.bg;
      bgBtn.setAttribute('aria-expanded', String(popKind === 'bg'));
    }
    undoBtn.disabled = !o.canUndo();
    redoBtn.disabled = !o.canRedo();
  }
  update();
  return { el: bar, update, closePopover: closePop, get popoverOpen() { return Boolean(popKind); } };
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

/** PC: 그리는 동안은 창을 끌어도 다른 메모와 합쳐지지 않게 (note.js 가 받아 본창에 알린다) */
export function inkMode(on) {
  window.dispatchEvent(new CustomEvent('memoking:inking', { detail: Boolean(on) }));
}

/**
 * 손 메모 그리기 화면 (콘텐츠로서): 메모 위를 덮고, 닫으면 저장 — 취소 단추는 없다 (실수는 되돌리기·모두 지우기로)
 *   완료 · Esc · Ctrl+Enter · (휴대폰) 뒤로 가기 = 저장하고 닫기. 바뀐 것이 없으면 그냥 닫는다
 * @param {{ doc?: object|null, onSave: (doc: object|null|undefined) => Promise<void>|void, onClose?: () => void, title?: string }} opts
 *   onSave(null) = 다 지움 (고치던 손 메모를 지우기) · onSave(undefined) = 새로 열었는데 아무것도 안 그림
 * @returns {{ close: () => void, sheet: HTMLElement }}
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
  // 머리: [손 메모 · 알림] ........ [✓ 완료] — PC 에서는 이 줄을 끌어 창을 옮긴다 (그리는 칸은 창을 끌지 않는다)
  const head = el('div', 'ink-head');
  const name = el('b', 'ink-title');
  name.append(icon('ink'), document.createTextNode(title));
  const hint = el('span', 'ink-hint', { 'aria-live': 'polite' });
  const done = el('button', 'ink-done', { type: 'button', title: '완료 — 메모에 넣기 (Esc)' });
  done.append(icon('check'), document.createTextNode('완료'));
  head.append(name, hint, done);
  const scroller = el('div', 'ink-scroll');
  const page = el('div', 'ink-page');
  const svg = svgEl('svg', { class: 'ink-canvas' });
  // 처음 열면 가운데에 안내 (그리기 시작하면 사라짐)
  const empty = el('div', 'ink-empty', { 'aria-hidden': 'true' });
  empty.append(icon('ink'));
  const emptyText = el('div');
  emptyText.innerHTML = '<b>여기에 그려 보세요</b><span>펜 · 손가락 · 마우스 — 두 손가락으로 화면 넘기기</span>';
  empty.append(emptyText);
  page.append(svg);
  scroller.append(page, empty);
  const toolbar = createInkToolbar({
    tools,
    bg: true,
    onUndo: () => hist.undo() && refresh(),
    onRedo: () => hist.redo() && refresh(),
    canUndo: hist.canUndo,
    canRedo: hist.canRedo,
    onBg: (bg) => {
      // 검은 바탕이면 이미 그린 검은 획을 흰색으로 (밝은 바탕이면 거꾸로) — 안 보이게 되지 않게. 되돌리기로 함께 돌아온다
      const [from, to] = bg === 'black' ? [PEN_COLORS[0], '#ffffff'] : ['#ffffff', PEN_COLORS[0]];
      const cur = hist.get();
      if (cur.some((x) => x.tool === 'pen' && x.color === from)) {
        hist.set(cur.map((x) => (x.tool === 'pen' && x.color === from ? { ...x, color: to } : x)), { undoable: true });
        refresh();
      }
      paintBg();
    },
    onClear: () => {
      hist.set([], { undoable: true });
      refresh();
      flash('모두 지웠어요 · 되돌리기로 살릴 수 있어요');
    },
    canClear: () => hist.get().length > 0,
  });
  sheet.append(head, scroller, toolbar.el);
  document.body.append(sheet);
  document.body.classList.add('inking');
  inkMode(true);

  const surface = createInkSurface(svg, {
    tools,
    getStrokes: hist.get,
    setStrokes: (next, opts) => {
      hist.set(next, opts);
      if (opts.undoable) refresh();
    },
    scroller,
    onDrawStart: () => {
      toolbar.closePopover();
      empty.classList.add('gone');
    },
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
    status();
  }
  const changed = () => hist.changed() || tools.bg !== start.bg;
  // 알림 줄: 지금 상태를 짧게 (닫으면 어떻게 되는지 늘 알 수 있게)
  let flashTimer = 0;
  function status() {
    if (flashTimer) return;
    const n = hist.get().length;
    hint.textContent = editing && !n ? '다 지웠어요 · 완료하면 이 손 메모를 메모에서 빼요'
      : !n ? '완료하면 그린 만큼 메모에 들어가요'
        : changed() ? '완료하면 메모에 저장돼요' : '';
    hint.classList.toggle('warn', editing && !n);
  }
  function flash(text) {
    clearTimeout(flashTimer);
    hint.textContent = text;
    hint.classList.remove('warn');
    flashTimer = setTimeout(() => {
      flashTimer = 0;
      status();
    }, 2400);
  }
  function refresh() {
    surface.render();
    toolbar.update();
    empty.classList.toggle('gone', hist.get().length > 0 || empty.classList.contains('gone'));
    fit();
    status();
  }
  paintBg();
  refresh();
  new ResizeObserver(() => requestAnimationFrame(fit)).observe(scroller); // 다음 화면에서 (크기를 바꾸며 생기는 고리 경고 없이)

  let closing = false;
  async function finish() {
    if (closing) return;
    closing = true;
    const strokes = hist.get();
    done.disabled = true;
    try {
      if (!changed()) {
        // 바뀐 것 없음: 새로 열고 안 그렸으면 아무것도, 고치던 것은 그대로
        if (!editing) await onSave(undefined);
      } else if (!strokes.length) await onSave(editing ? null : undefined);
      else {
        // 그린 곳이 왼쪽 위(여백 16)에서 시작하게 옮겨 저장 — 다시 열면 같은 모양으로
        const b = inkBounds(strokes);
        const dx = 16 - b.x;
        const dy = 16 - b.y;
        await onSave({ bg: tools.bg, strokes: strokes.map((s) => ({ ...s, pts: s.pts.map(([x, y, p]) => point(x + dx, y + dy, p)) })) });
      }
    } catch (err) {
      console.error(err);
      flash('저장하지 못했어요 · 다시 눌러 보세요');
      done.disabled = false;
      closing = false;
      return;
    }
    close();
  }
  function close() {
    document.removeEventListener('keydown', onKey, true);
    toolbar.closePopover();
    sheet.classList.add('closing');
    document.body.classList.remove('inking');
    inkMode(false);
    setTimeout(() => sheet.remove(), 160);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!toolbar.closePopover()) finish(); // 먼저 열린 작은 판을, 없으면 저장하고 닫기
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      finish();
      return;
    }
    if (inkKeys(e, {
      undo: () => hist.undo() && refresh(),
      redo: () => hist.redo() && refresh(),
      setTool: (t) => {
        tools.tool = t;
        tools.save();
        toolbar.update();
        flash(TOOL_NAMES[t]);
      },
    })) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  document.addEventListener('keydown', onKey, true);
  done.addEventListener('click', () => finish());
  return { close, sheet };
}

