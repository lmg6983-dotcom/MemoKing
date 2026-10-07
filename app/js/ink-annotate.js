// 주석으로서 손 메모 (PC·휴대폰 함께) — 메모 글 위에 겹쳐 그린다. 칸을 차지하지 않는다
//   - 평소: 글 위에 그린 획이 보이기만 (누르면 글을 고친다)
//   - 주석 모드(+ › 주석, PC 는 Ctrl+Shift+E): 위에 그리기 · 아래에 떠 있는 도구 막대(펜·형광펜·지우개·색·굵기·되돌리기 · 완료)
//     완료 · Esc · 뒤로 가기 = 저장하고 끝내기 (취소는 없다 — 되돌리기·모두 지우기로)
//   - 획은 그 아래 문단을 따라간다 (core/ink.js anchorStroke·placeStroke): 글이 늘어 문단이 밀려도, 창 폭이 바뀌어도 같은 자리
//   - 저장: 완료할 때 JSON 파일 하나 → 메모 머리말 ink: (자료가 없으면 머리말에서 뺀다)
import { anchorStroke, placeStroke, normalizeInk } from './core/ink.js';
import { createInkSurface, createInkToolbar, inkHistory, inkTools, inkKeys, inkMode, strokeEl } from './ink-editor.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * @param {{ scroller: HTMLElement, docEl: () => HTMLElement|null, read: () => Promise<object|null>,
 *           save: (data: object|null) => Promise<void>, onMode?: (on: boolean) => void, notice?: (text: string, err?: boolean) => void }} o
 *   scroller: 본문이 스크롤되는 상자 (주석 층을 그 안에 둔다) · docEl: 편집기 본문(.ProseMirror)
 */
export function setupAnnotation(o) {
  const layer = document.createElementNS(SVGNS, 'svg');
  layer.setAttribute('class', 'mk-annot');
  layer.setAttribute('aria-hidden', 'true');
  const view = document.createElementNS(SVGNS, 'g');
  layer.append(view);
  let anchored = []; // 저장되는 모양 (문단에 붙인 획, 본문 폭 1/1000 단위)
  let hist = null; // 주석 모드 동안의 되돌리기 기록 (anchored 목록의 모습들)
  let placed = new Map(); // 화면 좌표 획 → 저장 모양 획 (지우기·되돌리기에서 짝 찾기)
  let surface = null;
  let toolbar = null;
  let bar = null;
  let on = false;
  let loaded = false;
  let frame = 0;
  let width = 1;
  const tools = inkTools();

  function blocks() {
    const doc = o.docEl();
    if (!doc) return [];
    const base = doc.getBoundingClientRect();
    return [...doc.children].map((el) => ({ top: el.getBoundingClientRect().top - base.top, text: el.textContent ?? '' }));
  }

  // 주석 층을 본문 자리·크기에 맞추고 획을 다시 놓는다 (글이 바뀌거나 창 크기가 바뀌면)
  function layout() {
    frame = 0;
    const doc = o.docEl();
    if (!doc || (!anchored.length && !on)) {
      layer.style.display = on ? '' : 'none';
      return;
    }
    if (!layer.isConnected) o.scroller.append(layer);
    const sb = o.scroller.getBoundingClientRect();
    const db = doc.getBoundingClientRect();
    width = Math.max(1, db.width); // 화면 크기 (본문 확대·축소도 그대로)
    Object.assign(layer.style, {
      display: '',
      left: `${db.left - sb.left + o.scroller.scrollLeft}px`,
      top: `${db.top - sb.top + o.scroller.scrollTop}px`,
      width: `${width}px`,
      height: `${Math.max(db.height, o.scroller.clientHeight - (db.top - sb.top) - 8)}px`,
    });
    layer.setAttribute('width', String(width));
    layer.setAttribute('height', layer.style.height.replace('px', ''));
    paint();
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(layout);
  };

  function screenStrokes() {
    const b = blocks();
    placed = new Map();
    return (hist ? hist.get() : anchored).map((a) => {
      const s = placeStroke(a, b, width);
      placed.set(s, a);
      return s;
    });
  }
  let cache = [];
  function paint() {
    cache = screenStrokes();
    if (surface) surface.render();
    else {
      view.replaceChildren(...cache.map(strokeEl));
    }
  }

  // 화면 좌표 획 목록(그리기판이 준 것) → 저장 모양: 원래 있던 것은 짝을, 새로 그린 것은 그 아래 문단에 붙여서
  function toAnchored(list) {
    const b = blocks();
    return list.map((s) => placed.get(s) ?? anchorStroke(s, b, width));
  }

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const data = await o.read();
      anchored = normalizeInk(data ?? {}).strokes.filter((s) => s.anchor);
    } catch (err) {
      console.warn('글 위에 그린 것을 읽지 못했어요', err);
      anchored = [];
    }
    schedule();
  }

  function onKey(e) {
    if (!on) return;
    if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Escape' || !toolbar?.closePopover()) exit(); // Esc 는 먼저 열린 작은 판부터
      return;
    }
    if (inkKeys(e, {
      undo: () => hist.undo() && afterChange(),
      redo: () => hist.redo() && afterChange(),
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
  function afterChange() {
    paint();
    toolbar?.update();
  }

  let entering = null; // 불러오는 동안 또 불려도 그리기판을 하나만 (둘이면 획이 두 번 저장된다)
  async function enter() {
    if (on) return;
    if (entering) return entering;
    entering = ensureLoaded();
    try {
      await entering;
    } finally {
      entering = null;
    }
    if (on) return;
    on = true;
    if (tools.tool === 'eraser' && !anchored.length) tools.tool = 'pen';
    hist = inkHistory(anchored);
    layer.classList.add('drawing');
    view.replaceChildren();
    surface = createInkSurface(layer, {
      tools,
      getStrokes: () => cache,
      setStrokes: (next, opts) => {
        const nextAnchored = toAnchored(next);
        const before = opts.before ? toAnchored(opts.before) : hist.get();
        hist.set(nextAnchored, { ...opts, before });
        cache = next;
        if (opts.undoable) afterChange();
      },
      scroller: o.scroller,
      onDrawStart: () => {
        toolbar?.closePopover();
        bar?.classList.add('quiet');
      },
    });
    bar = document.createElement('div');
    bar.className = 'mk-annot-bar';
    bar.dataset.color = document.querySelector('#note-screen[data-color]')?.dataset.color ?? document.body.dataset.color ?? 'yellow';
    toolbar = createInkToolbar({
      tools,
      onUndo: () => hist.undo() && afterChange(),
      onRedo: () => hist.redo() && afterChange(),
      canUndo: hist.canUndo,
      canRedo: hist.canRedo,
      onClear: () => {
        hist.set([], { undoable: true });
        afterChange();
      },
      canClear: () => hist.get().length > 0,
      // 휴대폰은 다이얼을 돌려 끝내므로 완료 단추가 없다 (o.done === false) — 뒤로 가기로도 끝난다
      done: o.done === false ? null : { label: '완료', run: () => exit() },
    });
    // 잠깐 보이는 안내: 무엇을 하는 중인지 (그리기 시작하면 사라짐)
    const caption = document.createElement('div');
    caption.className = 'mk-annot-caption';
    caption.textContent = '글 위에 밑줄·동그라미를 그려요 · 글은 그대로예요';
    bar.append(caption, toolbar.el);
    document.body.append(bar);
    document.body.classList.add('annotating');
    o.scroller.classList.add('mk-annot-scroller');
    document.addEventListener('keydown', onKey, true);
    inkMode(true);
    o.onMode?.(true);
    layout();
  }

  async function exit() {
    if (!on) return;
    on = false;
    document.removeEventListener('keydown', onKey, true);
    toolbar?.closePopover();
    const changed = hist.changed();
    anchored = hist.get();
    hist = null;
    surface?.destroy(); // 그림판(layer)은 다음에도 쓰므로 손 입력만 떼어 낸다
    surface = null;
    // 그리기판이 붙인 것들을 걷어 내고 보이기만 하는 층으로
    layer.replaceChildren(view);
    layer.classList.remove('drawing');
    bar?.remove();
    bar = null;
    toolbar = null;
    document.body.classList.remove('annotating');
    o.scroller.classList.remove('mk-annot-scroller');
    inkMode(false);
    o.onMode?.(false);
    layout();
    if (!changed) return;
    try {
      await o.save(anchored.length ? { v: 1, strokes: anchored } : null);
      o.notice?.(anchored.length ? '글 위에 그린 것을 저장했어요' : '글 위에 그린 것을 모두 지웠어요');
    } catch (err) {
      console.error(err);
      o.notice?.('글 위에 그린 것을 저장하지 못했어요', true);
    }
  }

  // 글이 바뀌거나(문단이 밀림) 크기가 바뀌면 다시 놓는다 — 메모를 열 때마다 그 본문을 지켜본다 (휴대폰은 편집기를 새로 만든다)
  let observers = [];
  const watch = () => {
    for (const ob of observers) ob.disconnect();
    observers = [];
    const doc = o.docEl();
    if (!doc) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(doc);
    ro.observe(o.scroller);
    const mo = new MutationObserver(schedule);
    mo.observe(doc, { childList: true, subtree: true, characterData: true });
    observers = [ro, mo];
  };

  return {
    /** 메모를 열 때: 저장된 주석이 있으면 보이게 */
    async load(hasInk) {
      watch();
      loaded = false;
      anchored = [];
      if (hasInk) await ensureLoaded();
      else {
        loaded = true;
        schedule();
      }
    },
    start: watch,
    toggle: () => (on ? exit() : enter()),
    enter,
    exit,
    get active() {
      return on;
    },
    get count() {
      return (hist ? hist.get() : anchored).length;
    },
    relayout: schedule,
  };
}
