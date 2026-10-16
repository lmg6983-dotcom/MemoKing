// 윗막대 상태 줄이 창이 좁아 잘리면 전문을 말풍선으로 — 왕관 · 테이프 스티커처럼 메모 창 바깥에 매달린다
//   (메모 내용을 가리지 않게. 그리는 창은 메인이 띄운다 — desktop/status-bubble-window.js)
//   · 새 글이 오면 잠깐 (길이에 맞춰 3~8초). 오류는 30초 (다음 말이 오거나 💬 단추를 다시 누르면 그 전에) — 놓치면 안 되니까
//   · "…중" 처럼 곧 바뀔 진행 안내는 말풍선 없이 상태 줄만 (떴다 바로 바뀌어 정신없지 않게)
//   · 잘린 상태 줄은 점선 밑줄 + 옆에 💬 단추 — 누르면 다시 뜬다 (1분, 다시 누르면 닫힘)
//     (상태 줄은 창을 끄는 자리라 Windows 에서 마우스가 닿지 않는다 — 그래서 따로 단추)
//   · 말풍선이 실제로 뜬 뒤에야 상태 줄의 잘린 글을 감춘다 (같은 말이 두 번 보이지 않게, 그 사이 빈칸이 생기지 않게)
const api = window.memoking;
let anchorEl = null;
let moreBtn = null;
let timer = 0;
let seq = 0; // 마지막으로 띄우려던 것 (늦게 온 대답이 지난 말에 상태 줄을 감추지 않게)
let shown = false;

const PROGRESS = /중\s*(…|\.\.\.)/; // "그림을 만드는 중…" · "받아쓰는 중… (1/3)" (줄인 제목 같은 … 는 아님)
const isClipped = (el) => el.scrollWidth > el.clientWidth + 1;

function hide() {
  clearTimeout(timer);
  seq++;
  anchorEl?.classList.remove('bubbled');
  moreBtn?.setAttribute('aria-pressed', 'false');
  if (!shown) return;
  shown = false;
  api.win.statusBubble?.(null);
}

function markClipped(el) {
  const clipped = Boolean(el.textContent.trim()) && isClipped(el);
  el.classList.toggle('clipped', clipped);
  if (moreBtn) moreBtn.hidden = !clipped;
}

/** hover: 💬 단추로 부른 것 — 1분 동안, 진행 안내도 */
function show(el, { hover = false } = {}) {
  const text = el.textContent.trim();
  markClipped(el);
  if (!text || !isClipped(el) || !document.hasFocus() || (PROGRESS.test(text) && !hover && !el.classList.contains('error'))) return hide();
  clearTimeout(timer);
  const mine = ++seq;
  const error = el.classList.contains('error');
  shown = true;
  const r = el.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
  const settle = (ok) => {
    if (mine !== seq) return;
    if (!ok) return void (shown = false); // 띄우지 못함 (바탕화면 층 메모가 뒤에 있음 등) — 다음 💬 은 한 번에 보이게
    el.classList.add('bubbled');
    moreBtn?.setAttribute('aria-pressed', 'true');
  };
  Promise.resolve(api.win.statusBubble?.({ text, error, x: r.left + pad })).then(settle, () => settle(false));
  // 오류는 오래 (놓치지 않게 — 그래도 30초면 거둔다), 💬 로 부른 것은 1분, 그 밖은 길이에 맞춰 3~8초
  timer = setTimeout(hide, error ? 30_000 : hover ? 60_000 : Math.min(8000, 3000 + text.length * 60));
}

/** 상태 줄을 맡긴다 — 이 뒤로는 글을 바꿀 때마다 statusChanged() */
export function attachStatusBubble(el, more = null) {
  anchorEl = el;
  moreBtn = more;
  more?.addEventListener('click', () => (shown ? hide() : show(el, { hover: true }))); // 누르면 보이고 다시 누르면 닫힘 (오류도)
  // 창 크기가 바뀌면 잘림 표시만 다시 (말풍선은 메인이 거둔다)
  new ResizeObserver(() => markClipped(el)).observe(el);
  // 확대 · 축소(Ctrl+휠)로 상태 줄이 옮겨 가면 거둔다 (창을 옮기거나 다른 앱으로 가는 것은 메인이 거두고 알려 준다)
  window.addEventListener('resize', hide);
  // 메인이 거뒀을 때 (창을 옮기거나 크기를 바꿈): 감춰 둔 상태 줄 글을 다시
  api.on?.('status-bubble:gone', () => {
    shown = false;
    hide();
  });
}

/** 상태 줄 글이 바뀌었을 때 (그린 뒤에 잘렸는지 잰다) */
export function statusChanged() {
  if (!anchorEl) return;
  const el = anchorEl;
  el.classList.remove('bubbled'); // 새 글은 일단 그대로 보이게 (말풍선이 뜨면 그때 감춘다)
  requestAnimationFrame(() => show(el));
}
