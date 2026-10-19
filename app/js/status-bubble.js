// 윗막대 상태 줄이 창이 좁아 잘리면 전문을 말풍선으로 — 왕관 · 테이프 스티커처럼 메모 창 바깥에 매달린다
//   (메모 내용을 가리지 않게. 그리는 창은 메인이 띄운다 — desktop/status-bubble-window.js)
//   · 새 글이 오면 잠깐 (길이에 맞춰 3~8초). 오류는 30초 (다음 말이 오기 전에는 놓치지 않게) — 놓치면 안 되니까
//   · "…중" 처럼 곧 바뀔 진행 안내는 말풍선 없이 상태 줄만 (떴다 바로 바뀌어 정신없지 않게)
//   · 잘린 상태 줄은 점선 밑줄 + 마우스를 올려 두면 전문이 뜬다 (Windows 가 단추에 "메뉴" 를 띄우는 것처럼 — title)
//     (상태 줄은 창을 끄는 자리(drag)라 마우스가 닿지 않는다 → 잘렸을 때만 no-drag 로 바꿔 마우스가 닿게 한다 — note.css)
//   · 말풍선이 실제로 뜬 뒤에야 상태 줄의 잘린 글을 감춘다 (같은 말이 두 번 보이지 않게, 그 사이 빈칸이 생기지 않게)
const api = window.memoking;
let anchorEl = null;
let timer = 0;
let seq = 0; // 마지막으로 띄우려던 것 (늦게 온 대답이 지난 말에 상태 줄을 감추지 않게)
let shown = false;

const PROGRESS = /중\s*(…|\.\.\.)/; // "그림을 만드는 중…" · "받아쓰는 중… (1/3)" (줄인 제목 같은 … 는 아님)
const isClipped = (el) => el.scrollWidth > el.clientWidth + 1;

function hide() {
  clearTimeout(timer);
  seq++;
  anchorEl?.classList.remove('bubbled');
  if (anchorEl) markClipped(anchorEl); // 말풍선이 거둬지면 마우스 안내로
  if (!shown) return;
  shown = false;
  api.win.statusBubble?.(null);
}

function markClipped(el) {
  const clipped = Boolean(el.textContent.trim()) && isClipped(el);
  el.classList.toggle('clipped', clipped);
  // 잘렸으면 마우스를 올려 두면 전문 (말풍선이 떠 있는 동안은 같은 말이 두 번 보이지 않게 비움)
  if (clipped && !el.classList.contains('bubbled')) el.title = el.textContent.trim();
  else el.removeAttribute('title');
}

function show(el) {
  const text = el.textContent.trim();
  markClipped(el);
  if (!text || !isClipped(el) || !document.hasFocus() || (PROGRESS.test(text) && !el.classList.contains('error'))) return hide();
  clearTimeout(timer);
  const mine = ++seq;
  const error = el.classList.contains('error');
  shown = true;
  const r = el.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
  const settle = (ok) => {
    if (mine !== seq) return;
    if (!ok) return void (shown = false); // 띄우지 못함 (바탕화면 층 메모가 뒤에 있음 등) — 마우스 안내(title)는 그대로 남는다
    el.classList.add('bubbled');
    el.removeAttribute('title');
  };
  Promise.resolve(api.win.statusBubble?.({ text, error, x: r.left + pad })).then(settle, () => settle(false));
  // 오류는 오래 (놓치지 않게 — 그래도 30초면 거둔다), 그 밖은 길이에 맞춰 3~8초
  timer = setTimeout(hide, error ? 30_000 : Math.min(8000, 3000 + text.length * 60));
}

/** 상태 줄을 맡긴다 — 이 뒤로는 글을 바꿀 때마다 statusChanged() */
export function attachStatusBubble(el) {
  anchorEl = el;
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
