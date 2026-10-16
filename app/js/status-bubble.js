// 윗막대 상태 줄이 창이 좁아 잘리면 전문을 말풍선으로 — 왕관 · 테이프 스티커처럼 메모 창 위 가장자리 바깥에 매달린다
//   (메모 내용을 가리지 않게. 그리는 창은 메인이 띄운다 — desktop/status-bubble-window.js)
//   새 글이 오면 잠깐 (길이에 맞춰 3~8초), 상태 줄에 마우스를 올리면 다시. 다 보이면 띄우지 않는다.
//   말풍선이 떠 있는 동안 상태 줄의 잘린 글은 감춘다 (같은 말이 두 번 보이지 않게 — 읽어 주기는 그대로)
const api = window.memoking;
let anchorEl = null;
let timer = 0;
let shown = false;

const isClipped = (el) => el.scrollWidth > el.clientWidth + 1;

function hide() {
  clearTimeout(timer);
  anchorEl?.classList.remove('bubbled');
  if (!shown) return;
  shown = false;
  api.win.statusBubble?.(null);
}

function show(el, { stay = 0 } = {}) {
  const text = el.textContent.trim();
  if (!text || !isClipped(el) || !document.hasFocus()) return hide();
  clearTimeout(timer);
  shown = true;
  el.classList.add('bubbled');
  const r = el.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
  api.win.statusBubble?.({ text, error: el.classList.contains('error'), x: r.left + pad });
  timer = setTimeout(hide, stay || Math.min(8000, 3000 + text.length * 60));
}

/** 상태 줄을 맡긴다 — 이 뒤로는 글을 바꿀 때마다 statusChanged() */
export function attachStatusBubble(el) {
  anchorEl = el;
  el.addEventListener('mouseenter', () => show(el, { stay: 60_000 }));
  el.addEventListener('mouseleave', () => {
    if (shown) timer = (clearTimeout(timer), setTimeout(hide, 600));
  });
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide); // 다른 앱으로 가면 거둔다 (말풍선 창은 메모 창 밖에 떠 있어서)
}

/** 상태 줄 글이 바뀌었을 때 (그린 뒤에 잘렸는지 잰다) */
export function statusChanged() {
  if (!anchorEl) return;
  const el = anchorEl;
  requestAnimationFrame(() => show(el, { stay: el.matches(':hover') ? 60_000 : 0 })); // 읽으려고 올려 둔 동안은 그대로
}
