// 묶음 사진 보기 (PC·휴대폰 함께) — 카카오톡 묶음 사진처럼 메모에는 몇 장만 모아 보이고, 누르면 크게 한 장씩 넘겨 본다
//   ← → · 밀기로 넘기기, Esc · 닫기. 휠 · 두 손가락 · 두 번 누르기 · + - 0 으로 확대 · 축소 (크게 보면 끌어서 둘러보기). "그리기" 로 그 장 위에 펜 · 형광펜으로 쓰고 완료하면 그린 것을 그 장에 합쳐 저장
//   (원본 파일은 그대로 두고 새 그림 파일로 바꾼다 — 메모에서 되돌리기 Ctrl+Z 로 원래 장으로)
import { smallUrl } from './media.js';
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
 *           onDelete?: (index: number) => object[]|null, onUndo?: () => object[],
 *           onRotate?: (index: number) => Promise<string|null>, onSplit?: () => boolean }} o
 *   onRotate: 이 장을 오른쪽으로 90도 돌려 저장하고 새 src · onSplit: 묶음을 풀어 한 장씩 따로 (풀었으면 true — 보기를 닫는다)
 *   onDraw: 그린 장(PNG)을 저장하고 새 src 를 돌려준다 · onSave: 이 장 저장 (알릴 말) · onShare: 이 장 공유 (휴대폰)
 *   onDelete: 이 장을 묶음에서 빼고 남은 장들 · onUndo: 방금 뺀 것 되돌리기 → 장들. 없는 것은 단추도 없다 (읽기 전용)
 */
const ROTATE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
const SPLIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M14 7h4v4M10 17H6v-4"/></svg>';

export function openAlbumViewer({ images, start = 0, url, onDraw, onSave, onShare, onDelete, onUndo, onRotate, onSplit, onMove }) {
  let i = Math.max(0, Math.min(images.length - 1, start));
  const view = el('div', 'mk-album-view', { role: 'dialog', ariaModal: 'true', ariaLabel: images.length > 1 ? '묶음 사진' : '사진 크게 보기' });
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
  // 오른쪽으로 90도 돌리기 (돌린 그림을 새 파일로 저장 — 메모의 되돌리기로 원래대로)
  let turning = false;
  const rotate = onRotate ? svgBtn('오른쪽으로 90도 돌리기', ROTATE_ICON, async () => {
    if (inking || turning || moving) return;
    turning = true;
    rotate.disabled = true;
    // 누르자마자 화면에서 먼저 돌려 보이고(화면에 맞게 줄여), 새 파일은 그 뒤에서 만든다
    resetZoom();
    const fit = Math.min(stage.clientWidth / (img.offsetHeight || 1), stage.clientHeight / (img.offsetWidth || 1), 1 / Math.min(1, img.offsetWidth / (img.naturalWidth || img.offsetWidth || 1)));
    img.style.transformOrigin = '50% 50%';
    img.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.7, 0.3, 1)';
    img.style.transform = `rotate(90deg) scale(${fit})`;
    const at = i;
    try {
      const src = await onRotate(at);
      if (src) {
        images[at].src = src;
        const pre = new Image();
        pre.src = url(src);
        await pre.decode().catch(() => {}); // 새 그림이 준비된 뒤 바꿔야 깜빡이지 않는다
        paintStrip();
        if (i === at) show();
      }
    } catch (err) {
      say(err?.message || '돌리지 못했어요');
    } finally {
      img.style.transformOrigin = '';
      if (img.style.transform.startsWith('rotate')) {
        img.style.transition = '';
        img.style.transform = '';
      }
      turning = false;
      rotate.disabled = false;
    }
  }) : null;
  // 묶음 풀기: 한 장씩 따로 된 사진으로 (두 장 이상일 때 · 휴대폰 머리 줄이 넘치지 않게 그림 단추)
  const split = onSplit && images.length > 1 ? svgBtn('묶음 풀기 (한 장씩 따로)', SPLIT_ICON, () => {
    if (!inking && onSplit()) shut();
  }) : null;
  const draw = el('button', 'mk-album-btn', { type: 'button', title: '이 장 위에 그리기', ariaLabel: '이 장 위에 그리기' });
  draw.append(icon('pen'), el('span', 'mk-album-btn-text', { textContent: '그리기' })); // 좁은 화면에서는 글자를 숨기고 그림만 (note.css)
  const close = el('button', 'mk-album-btn', { type: 'button', title: '닫기 (Esc)', ariaLabel: '닫기' });
  close.append(icon('close'));
  // 확대해 보는 중이면 장 위쪽 가운데에 배율 단추 (누르면 원래 크기로 · 좁은 창의 머리 줄을 붐비게 하지 않게)
  const zoomBtn = el('button', 'mk-album-btn mk-album-zoom', { type: 'button', title: '원래 크기로 (0)', hidden: true });
  zoomBtn.addEventListener('click', () => resetZoom());
  head.append(count, inkedMark, el('span', 'mk-album-gap'), ...[rotate, split, save, share, del].filter(Boolean), ...(onDraw ? [draw] : []), close);
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
  view.append(stage, head, prev, next, zoomBtn, strip, note);
  document.body.append(view);
  const restore = document.activeElement;

  // 헤더 · 테일(장 목록) 오버레이: 열거나 누르면(마우스 움직임 포함) 이미지 위에 뜨고 2초 뒤 비활성화, 떠 있을 때 탭하면 바로 숨김
  let uiTimer = 0;
  function hideUI() {
    clearTimeout(uiTimer);
    uiTimer = 0;
    view.classList.remove('ui-active');
  }
  function wakeUI() {
    clearTimeout(uiTimer);
    view.classList.add('ui-active');
    uiTimer = setTimeout(() => {
      uiTimer = 0;
      view.classList.remove('ui-active');
    }, 2000);
  }
  // 숨어 있던 머리 줄 · 장 목록 · 화살표가 누르는 순간 떠오르면, 같은 누르기의 click 이 그 자리의 단추(다른 장 등)에 떨어졌다 →
  //   떠오른 직후 잠깐은 사진 밖 click 을 버린다 (사진 보기를 연 누르기도 같다)
  let guardUntil = Date.now() + 400;
  view.addEventListener('click', (e) => {
    if (e.pointerType === 'mouse') return; // 마우스는 누른 자리 그대로 (연 직후 바로 닫기를 눌러도 닫히게)
    if (Date.now() < guardUntil && !stage.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  for (const bar of [head, strip, prev, next]) {
    bar.addEventListener('pointerdown', () => wakeUI());
    bar.addEventListener('click', () => wakeUI());
  }
  view.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && !pts.size && !inking) wakeUI();
  });

  // ---------- 장 순서 바꾸기: 아래 장 목록의 장을 꾹 누르면(마우스는 끌면) 들리고, 놓은 자리로 ----------
  const reorder = { justDropped: false };
  if (onMove) {
    let d = null; // { thumb, from, to, x, y, armed, timer, id }
    const thumbs = () => [...strip.querySelectorAll('.mk-album-thumb')];
    const arm = () => {
      if (!d || inking || turning || moving) return;
      d.armed = true;
      d.thumb.classList.add('lifting');
      strip.setPointerCapture?.(d.id);
      if (navigator.vibrate) navigator.vibrate(10);
    };
    strip.addEventListener('pointerdown', (e) => {
      const thumb = e.target.closest('.mk-album-thumb');
      if (!thumb || images.length < 2) return;
      d = { thumb, from: thumbs().indexOf(thumb), x: e.clientX, y: e.clientY, armed: false, id: e.pointerId, mouse: e.pointerType === 'mouse' };
      d.to = d.from;
      if (!d.mouse) d.timer = setTimeout(arm, 300);
    });
    strip.addEventListener('pointermove', (e) => {
      if (!d) return;
      const far = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (!d.armed) {
        if (d.mouse && far > 6) arm();
        else if (!d.mouse && far > 10) { clearTimeout(d.timer); d = null; } // 밀면 장 목록 넘기기
        if (!d?.armed) return;
      }
      // 손가락 · 마우스 아래 장 앞(또는 뒤)으로 바로 옮겨 보인다
      const over = thumbs().find((t) => t !== d.thumb && (() => { const r = t.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right; })());
      if (!over) return;
      const list = thumbs();
      const before = list.indexOf(over) < list.indexOf(d.thumb);
      if (before) over.before(d.thumb);
      else over.after(d.thumb);
      d.to = thumbs().indexOf(d.thumb);
    });
    // 들린 동안은 장 목록이 스크롤되지 않게 (터치)
    strip.addEventListener('touchmove', (e) => d?.armed && e.cancelable && e.preventDefault(), { passive: false });
    const drop = () => {
      if (!d) return;
      clearTimeout(d.timer);
      const { armed, from, to, thumb } = d;
      d = null;
      if (!armed) return;
      thumb.classList.remove('lifting');
      reorder.justDropped = true; // 놓을 때 따라오는 click 으로 그 장이 열리지 않게
      setTimeout(() => (reorder.justDropped = false), 0);
      const next = from !== to ? onMove(from, to) : null;
      if (next?.length) {
        const showing = images[i];
        images.splice(0, images.length, ...next);
        i = Math.max(0, images.findIndex((it) => it.src === showing?.src));
        say('장 순서를 바꿨어요');
      }
      paintStrip();
      show();
    };
    strip.addEventListener('pointerup', drop);
    strip.addEventListener('pointercancel', drop);
  }

  function paintStrip() {
    strip.hidden = images.length < 2;
    strip.replaceChildren(...images.map((it, k) => {
      const b = el('button', `mk-album-thumb${k === i ? ' on' : ''}${it.inked ? ' inked' : ''}`, { type: 'button', role: 'tab', ariaLabel: `${k + 1}번째 장`, title: `${k + 1}번째 장${it.inked ? ' (그린 장)' : ''}` });
      b.setAttribute('aria-selected', String(k === i));
      const t = el('img', '', { src: smallUrl(url(it.src), it.src, 256), alt: '', loading: 'lazy', draggable: false }); // 아래 사진 줄은 작은 그림 (큰 그림은 원본)
      b.append(t);
      b.addEventListener('click', () => !reorder.justDropped && goTo(k));
      return b;
    }));
  }
  function show() {
    const it = images[i];
    img.style.transition = '';
    resetZoom();
    img.src = url(it.src);
    img.alt = it.alt ?? '';
    count.textContent = images.length > 1 ? `${i + 1} / ${images.length}` : ''; // 한 장이면 번호 없이
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
  // 장 넘기기: 지금 장은 미끄러져 나가고, 새 장은 반대쪽에서 들어온다
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let sliding = 0;
  let moving = false; // 지금 장이 미끄러져 나가는 중 (i 는 이미 새 장, 화면은 아직 앞 장) — 이 동안 장 단추는 받지 않는다
  const glide = (t, ms = 180) => {
    img.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.7, 0.3, 1), opacity ${ms}ms ease-out`;
    img.style.transform = `translateX(${t}px)`;
  };
  const goTo = (k) => {
    if (inking || turning || k < 0 || k >= images.length || k === i) return; // 돌리는 중에는 넘기지 않는다 (돌린 모양이 다른 장에 남았다)
    const dir = k > i ? 1 : -1;
    const w = stage.clientWidth;
    const job = ++sliding;
    moving = false; // 앞 미끄럼은 그만 (아래 timeout 이 job 이 달라 돌지 않으므로 여기서 푼다)
    i = k;
    count.textContent = `${i + 1} / ${images.length}`; // 장 번호는 누르자마자 (그림은 미끄러진 뒤에 바뀐다)
    if (still || z.s > 1) {
      show();
      return;
    }
    glide(-dir * w * 0.6);
    img.style.opacity = '0';
    moving = true;
    setTimeout(() => {
      if (job !== sliding) return;
      moving = false;
      show();
      img.style.transition = 'none';
      img.style.transform = `translateX(${dir * w * 0.35}px)`;
      img.style.opacity = '0';
      void img.offsetWidth;
      glide(0, 220);
      img.style.opacity = '';
      setTimeout(() => {
        if (job !== sliding) return;
        img.style.transition = '';
        img.style.transform = '';
      }, 240);
    }, 150);
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
    if (moving) return; // 넘어가는 중 — 보이는 장과 고르는 장이 다르다
    try {
      const msg = await fn(i);
      if (msg) say(msg);
    } catch (err) {
      say(err?.message || '하지 못했어요');
    }
  }
  // 이 장 빼기 → 남은 장으로 (다 빼면 닫힘) · 알림의 "되돌리기" 로 되살림
  function removePage() {
    if (inking || moving) return;
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

  // ---------- 확대 · 축소 ----------
  //   그림을 translate · scale 로 (기준점 왼쪽 위). 크게 본 그림은 화면 밖으로 빈틈이 생기지 않게, 작으면 가운데로
  const MAX_ZOOM = 5;
  let z = { s: 1, x: 0, y: 0 };
  function applyZoom() {
    img.style.transform = z.s === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
    view.classList.toggle('zoomed', z.s > 1);
    zoomBtn.hidden = z.s === 1;
    zoomBtn.textContent = `${Math.round(z.s * 100)}%`;
  }
  function clampZoom() {
    const fit = (t, off, size, room) => (size * z.s <= room ? (room - size * z.s) / 2 - off : Math.min(-off, Math.max(room - off - size * z.s, t)));
    z.x = fit(z.x, img.offsetLeft, img.offsetWidth, stage.clientWidth);
    z.y = fit(z.y, img.offsetTop, img.offsetHeight, stage.clientHeight);
  }
  // (cx, cy) 화면 자리가 그림의 같은 곳에 머물도록 배율을 바꾼다 (자리 없으면 가운데)
  function zoomTo(s, cx, cy) {
    if (inking || !img.naturalWidth) return;
    const r = stage.getBoundingClientRect();
    const s2 = Math.max(1, Math.min(MAX_ZOOM, s));
    const px = (cx ?? r.left + r.width / 2) - r.left - img.offsetLeft;
    const py = (cy ?? r.top + r.height / 2) - r.top - img.offsetTop;
    z = s2 === 1 ? { s: 1, x: 0, y: 0 } : { s: s2, x: px - (s2 / z.s) * (px - z.x), y: py - (s2 / z.s) * (py - z.y) };
    if (z.s > 1) clampZoom();
    applyZoom();
  }
  function resetZoom() {
    z = { s: 1, x: 0, y: 0 };
    applyZoom();
  }
  const onResize = () => {
    if (z.s === 1) return;
    clampZoom();
    applyZoom();
  };
  window.addEventListener('resize', onResize);
  // 휠 (터치패드 벌리기는 Ctrl+휠로 온다) — 뒤의 메모 창 글자 크기는 그대로
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY) zoomTo(z.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX, e.clientY);
  }, { passive: false });

  // 누르기: 한 손가락은 밀어 넘기기(크게 보면 끌어서 둘러보기), 두 손가락은 벌려 확대, 두 번 누르면 크게 ↔ 원래대로
  const pts = new Map();
  let gesture = null; // { kind: 'swipe' | 'pan' | 'pinch' | 'none', x, y, moved, d, m }
  let lastTap = null;
  const spread = () => {
    const [a, b] = [...pts.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (inking) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture?.(e.pointerId);
    if (pts.size === 2) gesture = { kind: 'pinch', moved: true, ...spread() };
    else if (pts.size === 1) gesture = { kind: z.s > 1 ? 'pan' : 'swipe', x: e.clientX, y: e.clientY, moved: false };
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p || !gesture) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (gesture.kind === 'pinch' && pts.size >= 2) {
      const { d, m } = spread();
      z.x += m.x - gesture.m.x;
      z.y += m.y - gesture.m.y;
      zoomTo(z.s * (d / gesture.d), m.x, m.y);
      gesture.d = d;
      gesture.m = m;
    } else if (gesture.kind === 'swipe' && !still && !turning && !moving) {
      const tx = e.clientX - gesture.x;
      const ty = e.clientY - gesture.y;
      // 처음 10px 로 방향을 정한다: 옆 = 넘기기, 아래 = 닫기 (휴대폰 사진 앱처럼)
      if (!gesture.axis && Math.hypot(tx, ty) > 10) gesture.axis = ty > 0 && Math.abs(ty) > Math.abs(tx) ? 'y' : 'x';
      if (gesture.axis) {
        if (!gesture.follow) sliding++; // 들어오는 움직임의 마무리(transform 비우기)가 끄는 그림을 제자리로 튕기지 않게
        gesture.follow = true;
        img.style.transition = 'none';
        if (gesture.axis === 'y') {
          const down = Math.max(0, ty);
          img.style.transform = `translate(${tx / 3}px, ${down}px) scale(${1 - Math.min(0.2, down / 1500)})`;
          view.style.backgroundColor = `rgba(0, 0, 0, ${1 - Math.min(0.7, down / 400)})`;
        } else {
          let t = tx;
          if ((t > 0 && i === 0) || (t < 0 && i === images.length - 1)) t /= 3; // 끝 장은 덜 따라온다
          img.style.transform = `translateX(${t}px)`;
        }
      }
    } else if (gesture.kind === 'pan') {
      z.x += dx;
      z.y += dy;
      clampZoom();
      applyZoom();
    }
    if (!gesture.moved && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 8) gesture.moved = true;
  });
  const lift = (e) => {
    if (!pts.delete(e.pointerId)) return;
    const g = gesture;
    if (pts.size) {
      // 두 손가락 중 하나를 떼면 남은 손가락으로 이어서 둘러보기
      const [p] = pts.values();
      gesture = { kind: z.s > 1 ? 'pan' : 'none', x: p.x, y: p.y, moved: true };
      return;
    }
    gesture = null;
    if (!g) return;
    if (e.type === 'pointercancel') {
      // 휴대폰이 누름을 거둬 가면(뒤로 가기 몸짓 등) 밀던 장을 제자리로 (예전: 옆으로 밀린 채 남았다)
      if (g.follow && !moving) {
        img.style.transition = '';
        img.style.transform = '';
        view.style.backgroundColor = '';
      }
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    // 아래로 충분히 밀었으면 닫는다 (그림이 내려가며 사라진다)
    if (g.kind === 'swipe' && g.axis === 'y' && dy > 110 && !moving) {
      img.style.transition = 'transform 0.18s ease-in, opacity 0.18s ease-in';
      img.style.transform = `translate(${dx / 3}px, ${dy + 160}px) scale(0.85)`;
      img.style.opacity = '0';
      view.style.transition = 'background-color 0.18s ease-in';
      view.style.backgroundColor = 'rgba(0, 0, 0, 0)';
      setTimeout(() => shut(), 170);
      return;
    }
    if (g.kind === 'swipe' && g.axis === 'y') view.style.backgroundColor = ''; // 모자라면 제자리로 (아래에서 그림도)
    if (g.kind === 'swipe' && g.axis !== 'y' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && images[i + (dx < 0 ? 1 : -1)]) {
      go(dx < 0 ? 1 : -1);
      return;
    }
    if (g.kind === 'swipe' && img.style.transform && !moving) { // 넘어가는 중이면 그 움직임에 맡긴다 (여기서 끊으면 새 장이 뜨지 않았다)
      glide(0); // 넘기지 않으면 제자리로
      const job = ++sliding;
      setTimeout(() => {
        if (job !== sliding) return;
        img.style.transition = '';
        img.style.transform = '';
      }, 200);
    }
    if (g.moved) return;
    const now = Date.now();
    if (lastTap && now - lastTap.at < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null;
      if (z.s > 1) resetZoom();
      else zoomTo(2.5, e.clientX, e.clientY);
    } else {
      lastTap = { at: now, x: e.clientX, y: e.clientY };
      if (view.classList.contains('ui-active')) hideUI();
      else {
        guardUntil = Date.now() + 400;
        wakeUI();
      }
    }
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);

  // ---------- 그리기 ----------
  let inking = null; // { svg, surface, toolbar, hist }
  function startInk() {
    if (inking || turning || moving || !img.naturalWidth) return;
    sliding++; // 넘기는 움직임이 남아 있으면 멈춘다 (그리기판이 움직이는 그림 자리에 맞춰지지 않게)
    img.style.transition = '';
    img.style.opacity = '';
    resetZoom(); // 그리기판은 원래 크기의 장 위에
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
    const at = i; // 저장하는 동안 다른 장으로 넘겨도 그린 장에 (예전: 넘긴 장에 저장됐다)
    try {
      const png = await flatten(strokes, k.w, k.h);
      const src = await onDraw(at, png);
      if (src) {
        images[at] = { ...images[at], src, inked: true };
        paintStrip();
        if (i === at) show();
        say('그린 것을 이 장에 저장했어요');
      }
    } catch (err) {
      console.warn('그린 장을 저장하지 못했어요', err);
    }
  }

  async function flatten(strokes, w, h) {
    const photo = /\.(jpe?g|heic|heif)$/i.test(images[i].src); // 사진 위에 그린 것은 JPEG, 그 밖(투명할 수 있는 그림)은 WebP — PNG 보다 몇 배 빨리 만들고 작다
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
    return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('그림을 만들지 못했어요'))), photo ? 'image/jpeg' : 'image/webp', 0.92));
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
    else if (e.key === '+' || e.key === '=') zoomTo(z.s * 1.25);
    else if (e.key === '-') zoomTo(z.s / 1.25);
    else if (e.key === '0') resetZoom();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  async function shut() {
    clearTimeout(uiTimer);
    if (inking) await finishInk();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    current = null;
    view.remove();
    window.dispatchEvent(new Event('mk:album-closed')); // 휴대폰: 닫은 뒤 그 그림의 단추 줄 (block-move.js)
    if (restore instanceof HTMLElement && restore.isConnected) restore.focus({ preventScroll: true });
  }
  close.addEventListener('click', shut);
  document.addEventListener('keydown', onKey, true);
  current = shut;
  paintStrip();
  show();
  wakeUI();
  // 처음 한 번: 넘기는 법 · 그리기 (손가락 화면은 밀기, PC 는 화살표)
  try {
    if (!localStorage.getItem(HINT_KEY) && images.length > 1) {
      localStorage.setItem(HINT_KEY, '1');
      const coarse = matchMedia('(pointer: coarse)').matches;
      say(coarse ? '옆으로 밀어 넘기고, 아래로 밀면 닫혀요. 아래 장을 꾹 눌러 끌면 순서가 바뀌어요' : '← → 나 아래 장을 눌러 넘겨요. 아래 장을 끌면 순서가 바뀌어요');
    }
  } catch {
    // 저장소를 못 써도 보기는 그대로
  }
  close.focus();
  return { close: shut };
}
