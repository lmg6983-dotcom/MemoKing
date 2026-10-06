// 옮기기 틀 (block-move.js · list-drag.js 함께) — 사진·글·표·음성 카드·목록 모두 같은 모양으로
//   - 들어 올린 것(진한 실선) · 맞바꿀 상대(보라 점선) · 넣을 자리(노란 점선 칸)를 한 겹(.mk-drag-layer)에 그린다.
//     틀은 내용에서 FRAME_GAP 떨어져 감싼다 (사진이면 사진에 딱, 글이면 글 폭에). 내용 쪽의 접기·흐림과 상관없이 또렷하다
//   - 한 겹은 편집기와 같은 쌓임 안에서 "다른 줄 위, 들어 올린 줄 아래" — 점선이 들고 있는 사진 위를 긋지 않는다
//   - 다른 줄이 미끄러지는 동안 틀도 같은 빠르기로 미끄러진다 (들어 올린 틀만 손을 바로 따라옴)
//   - 안내 캡슐(⇅ 맞바꾸기 · ↳ 여기에 넣기)은 그 틀의 오른쪽에 같은 색으로 붙고, 틀이 움직이면 미끄러지듯 따라간다
//     (오른쪽에 자리가 없으면 틀 오른쪽 위 모서리에 걸치고, 손가락·커서나 들고 있는 내용에 가리면 몰래 비킨다)
import { FRAME_GAP, FRAME_LINE, inflate, placeBadge } from './core/drag-geometry.js';

const OUT = FRAME_GAP + FRAME_LINE;
const FINGER_R = { touch: 34, mouse: 14 };
// 메모 색(글자·바탕)은 편집기 쪽에 정해져 있어(휴대폰은 메모 화면) 한 겹과 안내 캡슐에 옮겨 둔다
const THEME_VARS = ['--note-text', '--note-bg', '--note-hover', '--brand-yellow'];

// 편집기를 담아 잘라 보여 주는 칸 (스크롤될 만큼 길지 않은 메모여도 그 칸) — 없으면 화면
function clipOf(host) {
  for (let e = host?.parentElement; e && e !== document.body; e = e.parentElement) {
    const oy = getComputedStyle(e).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'hidden') return e;
  }
  return null;
}

function boundsOf(clip) {
  if (!clip) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const r = clip.getBoundingClientRect();
  return { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(window.innerWidth, r.right), bottom: Math.min(window.innerHeight, r.bottom) };
}

// 편집기가 든 쌓임(stacking context)의 뿌리 — 한 겹을 여기에 두어야 들어 올린 줄(z-index 3·5)보다 아래가 된다
function stackRootOf(host) {
  for (let e = host?.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const c = getComputedStyle(e);
    if (c.position === 'fixed' || c.position === 'sticky' || (c.position !== 'static' && c.zIndex !== 'auto')
      || c.transform !== 'none' || c.filter !== 'none' || Number(c.opacity) < 1 || c.isolation === 'isolate'
      || /paint|layout|strict|content/.test(c.contain) || /transform|opacity|filter/.test(c.willChange)) return e;
  }
  return document.body;
}

function div(cls) {
  const el = document.createElement('div');
  el.className = cls;
  el.hidden = true;
  return el;
}

// 처음 보일 때는 미끄러지지 않고 그 자리에 바로 (사라졌다 나타날 때 엉뚱한 곳에서 날아오지 않게)
function jump(el) {
  el.style.transition = 'none';
  void el.offsetWidth;
  requestAnimationFrame(() => {
    el.style.transition = '';
  });
}

export class DragFrames {
  /** @param {Element} host 편집기 (메모 색·자리를 가져올 곳) */
  constructor(host) {
    this.clip = clipOf(host);
    this.layer = div('mk-drag-layer');
    this.layer.hidden = false;
    this.badge = div('mk-drag-badge');
    const cs = getComputedStyle(host);
    for (const v of THEME_VARS) {
      const value = cs.getPropertyValue(v).trim();
      if (value) {
        this.layer.style.setProperty(v, value);
        this.badge.style.setProperty(v, value);
      }
    }
    this.frames = { lift: div('mk-drag-frame lift'), target: div('mk-drag-frame target'), slot: div('mk-drag-frame mk-drop-slot') };
    this.rects = { lift: null, target: null, slot: null };
    this.layer.append(this.frames.slot, this.frames.target, this.frames.lift);
    stackRootOf(host).append(this.layer);
    document.body.append(this.badge); // 캡슐은 맨 위 (무엇에도 가리지 않게)
    this.fit();
  }

  // 한 겹은 스크롤되는 칸의 보이는 곳에만 (위 막대·도구막대 위로 넘치지 않게).
  // 감싼 화면이 움직이는 중(transform)이면 fixed 의 기준이 화면이 되므로 그 차이만큼 뺀다
  fit() {
    const b = boundsOf(this.clip);
    this.bounds = b;
    const st = this.layer.style;
    Object.assign(st, { left: '0px', top: '0px', width: `${b.right - b.left}px`, height: `${b.bottom - b.top}px` });
    const o = this.layer.getBoundingClientRect();
    st.left = `${b.left - o.left}px`;
    st.top = `${b.top - o.top}px`;
  }

  /**
   * @param {'lift'|'target'|'slot'} name
   * @param {{left:number, top:number, width:number, height:number} | null} rect 내용의 화면 상자 (틀은 그 바깥에)
   * @param {{ line?: boolean, outer?: boolean, draw?: boolean }} [opts]
   *   line: 다른 목록 사이에 넣을 때처럼 얇은 칸 · outer: rect 가 이미 틀 자리 (목록 항목은 체크 네모·글머리까지 감싼 틀)
   *   draw: false 면 그리지 않고 안내 캡슐의 기준으로만 (목록 항목의 테두리는 항목이 직접 그린다)
   */
  set(name, rect, { line = false, outer = false, draw = true } = {}) {
    const f = this.frames[name];
    if (!rect) {
      this.rects[name] = null;
      f.hidden = true;
      return;
    }
    const r = line
      ? { left: rect.left - OUT, top: rect.top - 3, width: rect.width + 2 * OUT, height: 6, right: rect.left + rect.width + OUT, bottom: rect.top + 3 }
      : outer ? { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height } : inflate(rect, OUT);
    this.rects[name] = r;
    if (!draw) {
      f.hidden = true;
      return;
    }
    const fresh = f.hidden || f.classList.contains('line') !== line;
    f.hidden = false;
    f.classList.toggle('line', line);
    if (fresh) jump(f);
    const { left, top } = this.bounds;
    // 반올림하지 않는다 (반 픽셀 틈으로 아래 줄이 비치지 않게)
    f.style.left = `${(r.left - left).toFixed(2)}px`;
    f.style.top = `${(r.top - top).toFixed(2)}px`;
    f.style.width = `${r.width.toFixed(2)}px`;
    f.style.height = `${r.height.toFixed(2)}px`;
  }

  /**
   * 안내 캡슐 — 맞바꾸기는 맞바꿀 상대의 틀, 넣기는 넣을 자리, 그 밖(하위·상위로)은 들어 올린 틀 오른쪽에
   * @param {string | null} kind swap · insert · indent · outdent · blocked
   * @param {string} text
   * @param {{x:number, y:number}} finger 지금 손가락·커서 자리
   * @param {'touch'|'mouse'} pointer
   */
  label(kind, text, finger, pointer) {
    const b = this.badge;
    const anchor = kind === 'swap' ? this.rects.target : kind === 'insert' ? this.rects.slot : this.rects.lift;
    if (!kind || !anchor) {
      b.hidden = true;
      return;
    }
    const fresh = b.hidden || b.dataset.kind !== kind;
    b.hidden = false;
    b.dataset.kind = kind;
    if (b.textContent !== text) b.textContent = text;
    const spot = placeBadge({
      frame: anchor,
      bw: b.offsetWidth || 96,
      bh: b.offsetHeight || 22,
      bounds: this.bounds,
      finger: { ...finger, r: FINGER_R[pointer] ?? 14 },
      avoid: anchor === this.rects.lift || !this.rects.lift ? [] : [this.rects.lift],
    });
    if (fresh) jump(b);
    b.dataset.side = spot.side;
    b.style.left = `${spot.x}px`;
    b.style.top = `${spot.y}px`;
  }

  destroy() {
    this.layer.remove();
    this.badge.remove();
  }
}
