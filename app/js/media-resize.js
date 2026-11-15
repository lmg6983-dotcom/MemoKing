// 사진 · 동영상 크기 조절 (편집기 플러그인, PC · 휴대폰 함께) — Notion 처럼 양옆의 손잡이를 끌어 크기를 바꾼다
//   PC: 마우스를 올리면 손잡이가 나타난다. 휴대폰: 내용을 눌러 단추 줄(복사 · 저장 · 지우기)이 뜰 때 함께 (delete-button.js 의 mk:tools)
//   크기는 그 줄 폭의 % 로 설명 끝에 "|50%" 로 저장 (core/memo-file.js withMediaWidth) — 25 · 33 · 50 · 66 · 75 · 100% 가까이에서 딱 붙는다
//   손잡이를 두 번 누르면 원래(줄 폭에 맞춤)로. 끄는 동안 위에 지금 크기 (50%)
import { Plugin, PluginKey } from '../vendor/milkdown.js';
import { haptic } from './dom.js';
import { mediaWidthOf, withMediaWidth, MIN_MEDIA_PCT } from './core/memo-file.js';

const SEL = '.mk-image:not(.mk-album-img), .mk-video';
const SNAPS = [25, 33, 50, 66, 75, 100];
export const mediaResizeKey = new PluginKey('memoking-media-resize');

const el = (tag, cls) => Object.assign(document.createElement(tag), { className: cls });

export function mediaResizePlugin() {
  return new Plugin({
    key: mediaResizeKey,
    view(view) {
      const layer = el('div', 'mk-resize');
      layer.hidden = true;
      const left = el('span', 'mk-resize-handle left');
      const right = el('span', 'mk-resize-handle right');
      const badge = el('span', 'mk-resize-badge');
      for (const h of [left, right]) {
        h.setAttribute('role', 'slider');
        h.setAttribute('aria-label', '크기 (끌어서 바꾸기, 두 번 누르면 원래대로)');
        h.title = '끌어서 크기 바꾸기 · 두 번 누르면 원래대로';
      }
      layer.append(left, right, badge);
      document.body.append(layer);
      let target = null; // 지금 손잡이가 붙은 그림 · 동영상
      let drag = null;
      let hideTimer = 0;

      const posOf = (dom) => {
        try {
          let pos = view.posAtDOM(dom, 0);
          for (const p of [pos, pos - 1]) if (view.state.doc.nodeAt(p)?.type.name === 'image') return p;
        } catch {
          // 이미 빠진 자리
        }
        return -1;
      };
      // 크기의 기준: 그림이 든 줄을 담은 칸의 글 폭 (목록 · 인용 · 음성 카드 안이면 그 안의 폭)
      const baseWidth = (dom) => {
        const line = dom.closest('p') ?? dom.parentElement;
        const box = line?.parentElement ?? view.dom;
        const cs = getComputedStyle(box);
        return Math.max(1, box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      };
      const place = () => {
        if (!target?.isConnected) return hide(true);
        const r = target.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight || !r.width) return hide(true);
        Object.assign(layer.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      };
      const show = (dom) => {
        clearTimeout(hideTimer);
        if (!view.editable || drag) return;
        if (target !== dom) {
          target?.classList.remove('mk-resize-on');
          target = dom;
          target.classList.add('mk-resize-on');
        }
        layer.hidden = false;
        place();
        requestAnimationFrame(() => layer.classList.add('in'));
      };
      function hide(now = false) {
        clearTimeout(hideTimer);
        if (drag) return;
        const go = () => {
          layer.classList.remove('in');
          layer.hidden = true;
          target?.classList.remove('mk-resize-on');
          target = null;
        };
        if (now) go();
        else hideTimer = setTimeout(go, 220);
      }

      // PC: 마우스를 올리면
      const onMove = (e) => {
        if (e.pointerType !== 'mouse' || drag) return;
        const t = e.target instanceof Element ? e.target.closest(SEL) : null;
        if (t && view.dom.contains(t)) show(t);
        else if (target && !layer.contains(e.target)) hide();
      };
      view.dom.addEventListener('pointermove', onMove);
      view.dom.addEventListener('pointerleave', (e) => !layer.contains(e.relatedTarget) && hide());
      layer.addEventListener('pointerleave', (e) => !(e.relatedTarget instanceof Node && target?.contains(e.relatedTarget)) && hide());
      // 휴대폰: 단추 줄이 그림 · 동영상에 뜨면 손잡이도 함께, 거둬지면 함께
      const onTools = (e) => {
        if (e.detail?.view !== view) return;
        const t = e.detail.target;
        const media = t?.matches?.(SEL) ? t : t?.querySelectorAll?.(SEL).length === 1 ? t.querySelector(SEL) : null;
        if (media) show(media);
      };
      const onToolsHide = () => !drag && hide(true);
      document.addEventListener('mk:tools', onTools);
      document.addEventListener('mk:tools-hide', onToolsHide);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);

      // 끌기: 그림은 왼쪽에 붙어 있으므로 오른쪽 손잡이는 끈 만큼, 왼쪽 손잡이는 반대로
      const start = (e, side) => {
        if (!target || !view.editable) return;
        e.preventDefault();
        e.stopPropagation();
        const pos = posOf(target);
        if (pos < 0) return;
        const base = baseWidth(target);
        drag = { side, x: e.clientX, w: target.getBoundingClientRect().width, base, pos, pct: null, snapped: null, id: e.pointerId };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        layer.classList.add('dragging');
        target.classList.add('mk-sized');
        document.body.classList.add('mk-resizing');
        badge.textContent = `${Math.round((drag.w / base) * 100)}%`;
      };
      const move = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = (e.clientX - drag.x) * (drag.side === 'right' ? 1 : -1);
        let pct = ((drag.w + dx) / drag.base) * 100;
        const snap = SNAPS.find((s) => Math.abs(s - pct) < 2.5);
        if (snap) pct = snap;
        pct = Math.round(Math.min(100, Math.max(MIN_MEDIA_PCT, pct)));
        if (snap && snap !== drag.snapped) haptic(6); // 딱 붙을 때 손끝에 (휴대폰)
        drag.snapped = snap ?? null;
        drag.pct = pct;
        target.style.width = `${pct}%`;
        badge.textContent = pct === 100 ? '꽉 차게' : `${pct}%`;
        place();
      };
      const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const { pos, pct } = drag;
        drag = null;
        layer.classList.remove('dragging');
        document.body.classList.remove('mk-resizing');
        if (pct == null) return;
        const node = view.state.doc.nodeAt(pos);
        if (node?.type.name !== 'image') return;
        const alt = withMediaWidth(node.attrs.alt, pct);
        if (alt !== node.attrs.alt) view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, alt }));
        requestAnimationFrame(place);
      };
      const reset = (e) => {
        e.preventDefault();
        if (!target) return;
        const pos = posOf(target);
        const node = pos >= 0 ? view.state.doc.nodeAt(pos) : null;
        if (!node || mediaWidthOf(node.attrs.alt) == null) return;
        view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, alt: withMediaWidth(node.attrs.alt, 100) }));
        requestAnimationFrame(place);
      };
      for (const [h, side] of [[left, 'left'], [right, 'right']]) {
        h.addEventListener('pointerdown', (e) => start(e, side));
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', end);
        h.addEventListener('pointercancel', end);
        h.addEventListener('dblclick', reset);
        h.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false }); // 끄는 동안 화면이 스크롤되지 않게
      }

      return {
        update() {
          // 다시 그려져 그림 칸이 바뀌었으면 새 칸에 붙인다
          if (target && !target.isConnected) hide(true);
          else if (target) place();
        },
        destroy() {
          view.dom.removeEventListener('pointermove', onMove);
          document.removeEventListener('mk:tools', onTools);
          document.removeEventListener('mk:tools-hide', onToolsHide);
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
          layer.remove();
        },
      };
    },
  });
}
