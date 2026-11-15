// 사진 · 동영상 크기 조절 (편집기 플러그인, PC · 휴대폰 함께) — 오른쪽 아래 모서리의 동그란 손잡이 하나를 끌어 크기를 바꾼다 (Apple 메모 · Google Docs 의 모서리 손잡이처럼)
//   PC: 마우스를 올리면 손잡이가 나타난다. 휴대폰: 내용을 눌러 단추 줄(복사 · 저장 · 지우기)이 뜰 때 함께 (delete-button.js 의 mk:tools)
//   크기는 그 줄 폭의 % 로 설명 끝에 "|50%" 로 저장 (core/memo-file.js withMediaWidth) — 25 · 33 · 50 · 66 · 75 · 100% 가까이에서 딱 붙는다
//   손잡이를 두 번 누르면 원래(줄 폭에 맞춤)로. 끄는 동안 위에 지금 크기 (50%)
import { Plugin, PluginKey } from '../vendor/milkdown.js';
import { haptic } from './dom.js';
import { mediaWidthOf, withMediaWidth, MIN_MEDIA_PCT } from './core/memo-file.js';

const SEL = '.mk-image:not(.mk-album-img), .mk-video';
const SNAPS = [25, 33, 50, 66, 75, 100];
const mediaResizeKey = new PluginKey('memoking-media-resize');

const el = (tag, cls) => Object.assign(document.createElement(tag), { className: cls });

export function mediaResizePlugin() {
  return new Plugin({
    key: mediaResizeKey,
    view(view) {
      const layer = el('div', 'mk-resize');
      layer.hidden = true;
      const grip = el('span', 'mk-resize-handle');
      const badge = el('span', 'mk-resize-badge');
      layer.setAttribute('aria-hidden', 'true'); // 마우스 · 손가락으로 끄는 손잡이 (키보드 · 화면 읽기 프로그램에는 값 없는 슬라이더로 잡히지 않게)
      grip.title = '끌어서 크기 바꾸기, 두 번 누르면 원래대로';
      layer.append(grip, badge);
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
      // 메모 글이 스크롤되는 칸 — 손잡이가 그 밖(위 막대 · 아래 서식 막대 위)에 떠서 막대 단추를 가리지 않게
      let scroller = null;
      const scrollerOf = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
        return null;
      };
      const place = () => {
        if (!target) return; // 숨어 있으면 스크롤마다 재지 않는다
        if (!target.isConnected) return hide(true);
        const r = target.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight || !r.width) return hide(true);
        Object.assign(layer.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
        layer.classList.toggle('clipped', !drag && (r.bottom > box.bottom - 4 || r.bottom < box.top + 12)); // 모서리가 보이는 칸 밖이면 손잡이만 숨긴다
      };
      const show = (dom) => {
        clearTimeout(hideTimer);
        if (!view.editable || drag) return;
        if (target !== dom) {
          target?.classList.remove('mk-resize-on');
          target = dom;
          target.classList.add('mk-resize-on');
          layer.classList.toggle('video', dom.classList.contains('mk-video')); // 동영상: 오른쪽 아래의 전체 화면 단추와 겹치지 않게 손잡이를 바깥으로
          scroller = scrollerOf(dom);
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
      // 단추 줄이 시간이 지나 저절로 사라질 때는 손잡이를 남긴다 (사진을 보다가 잡을 수 있게) — 바로 거둘 때(시트 열기 등)만 함께
      const onToolsHide = (e) => e.detail?.now && !drag && hide(true);
      // 손잡이 · 사진 밖을 누르면 숨긴다
      const onDown = (e) => {
        if (!target || drag || layer.contains(e.target) || target.contains(e.target)) return;
        hide(true);
      };
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('mk:tools', onTools);
      document.addEventListener('mk:tools-hide', onToolsHide);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);

      // 끌기: 그림은 왼쪽 위에 붙어 있으므로 모서리를 오른쪽 · 아래로 끌면 커진다 (비율은 그대로 — 가로 · 세로 중 더 많이 끈 쪽으로)
      const start = (e) => {
        if (!target || !view.editable) return;
        e.preventDefault();
        e.stopPropagation();
        const pos = posOf(target);
        if (pos < 0) return;
        const base = baseWidth(target);
        const r = target.getBoundingClientRect();
        drag = { x: e.clientX, y: e.clientY, w: r.width, ratio: r.height ? r.width / r.height : 1, base, pos, pct: null, snapped: null, id: e.pointerId };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        layer.classList.add('dragging');
        target.classList.add('mk-sized');
        document.body.classList.add('mk-resizing');
        badge.textContent = `${Math.round((drag.w / base) * 100)}%`;
      };
      const move = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (drag.pct == null && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return; // 누르기만 한 손가락의 떨림은 끌기가 아니다 (크기를 저장하지 않게)
        const byX = e.clientX - drag.x;
        const byY = (e.clientY - drag.y) * drag.ratio; // 세로로 끈 만큼을 가로로 바꿔 (비율 유지)
        const dx = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
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
        reattach(pos);
      };
      // 크기를 바꾸면 그 그림이 새로 그려진다 — 새 그림에 손잡이를 다시 붙여 이어서 맞출 수 있게 (휴대폰에서 다시 꾹 누르지 않게)
      const reattach = (pos) => {
        const dom = view.nodeDOM(pos);
        const media = dom?.matches?.(SEL) ? dom : dom?.querySelector?.(SEL);
        if (media) show(media);
      };
      const reset = (e) => {
        e.preventDefault();
        if (!target) return;
        const pos = posOf(target);
        const node = pos >= 0 ? view.state.doc.nodeAt(pos) : null;
        if (!node || mediaWidthOf(node.attrs.alt) == null) return;
        view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, alt: withMediaWidth(node.attrs.alt, 100) }));
        reattach(pos);
      };
      grip.addEventListener('pointerdown', start);
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
      grip.addEventListener('lostpointercapture', end); // 끄는 중 캡처를 잃어도 끄기 상태가 남지 않게
      grip.addEventListener('dblclick', reset);
      grip.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false }); // 끄는 동안 화면이 스크롤되지 않게

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
          document.removeEventListener('pointerdown', onDown, true);
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
          layer.remove();
        },
      };
    },
  });
}
