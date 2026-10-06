// 튜토리얼 말풍선 — 비출 요소 둘레만 밝게 두고 나머지를 어둡게, 옆에 안내 말풍선. (PC·휴대폰 함께)
// 화면은 그대로 눌러지므로(따라 하기) 비춘 버튼을 실제로 눌러 볼 수 있다.
//   - 머리: 단계 이모지 · 진행 막대 · 몇 번째인지
//   - 직접 해 보기 단계: 비춘 곳이 두근두근 + "👉 이렇게 해 보세요" — 해 내면 다음 말풍선에 "🎉 잘했어요!" 와 꽃가루
//   - 실제 화면 사진(app/assets/tutorial/): 누르면 크게
//   - 말풍선은 비춘 곳 · 직접 해 볼 곳(step.keep)을 가장 덜 가리는 자리에, 해 보기 시작하면 작은 알약으로 접힘
// 단계 진행은 PC 는 메인 프로세스, 휴대폰은 tutorial.js 가 맡고(core/tutorial.js), 여기서는 보여 주고 버튼만 전한다.

const PRAISE = ['🎉 잘했어요!', '👏 완벽해요!', '✨ 멋져요!', '🙌 좋아요!', '💯 바로 그거예요!'];
const shotUrl = (name) => new URL(`../assets/tutorial/${name}`, import.meta.url).href;

/** @param {{ onStep?: (step: object|null) => void }} [o] onStep: 단계가 바뀔 때 (직접 해 보기 판정의 시작점) */
export function setupCoach(api, o = {}) {
  const spot = document.createElement('div');
  spot.className = 'coach-spot';
  const bubble = document.createElement('div');
  bubble.className = 'coach-bubble';
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-live', 'polite');
  spot.hidden = true;
  bubble.hidden = true;
  document.body.append(spot, bubble);

  let step = null;
  let timer = null;

  function targetEl() {
    for (const selector of step?.target ?? []) {
      const found = document.querySelector(selector);
      if (found && found.getClientRects().length) return found;
    }
    return null;
  }

  // 말풍선 자리: 비춘 곳(target)과 직접 해 볼 곳(step.keep — 본문 글, 열린 메뉴 등)을 가장 덜 가리는 곳.
  //   비춘 곳 아래 · 위 · 오른쪽 · 왼쪽 · 네 귀퉁이를 견주고, 메뉴가 열리고 닫히면 따라 옮긴다 (조금 나은 정도로는 안 움직임)
  const visibleRects = (selectors, limit = 60) => {
    const out = [];
    for (const sel of selectors ?? []) {
      for (const e of document.querySelectorAll(sel)) {
        if (!e.getClientRects().length) continue;
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push(r);
        if (out.length >= limit) return out;
      }
    }
    return out;
  };
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  let placedAt = null;

  function place() {
    if (!step) return;
    const target = targetEl();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;
    let r = null;
    if (target) {
      const t = target.getBoundingClientRect();
      r = {
        left: Math.max(2, t.left - pad), top: Math.max(2, t.top - pad),
        right: Math.min(vw - 2, t.right + pad), bottom: Math.min(vh - 2, t.bottom + pad),
      };
      Object.assign(spot.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
      spot.classList.remove('center');
    } else {
      // 비출 곳이 없으면 화면 전체를 어둡게 하고 가운데에 말풍선
      Object.assign(spot.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: '0px', height: '0px' });
      spot.classList.add('center');
    }
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const m = 8;
    const clampX = (x) => Math.min(Math.max(m, x), Math.max(m, vw - bw - m));
    const clampY = (y) => Math.min(Math.max(m, y), Math.max(m, vh - bh - m));
    let best;
    if (!r && !step.keep?.length) best = { left: (vw - bw) / 2, top: (vh - bh) / 2 };
    else {
      const avoid = visibleRects(step.keep);
      const candidates = [];
      if (r) {
        candidates.push(
          { left: clampX(r.left), top: r.bottom + 12 }, // 아래
          { left: clampX(r.left), top: r.top - 12 - bh }, // 위
          { left: r.right + 12, top: r.top }, // 오른쪽 (위 맞춤)
          { left: r.right + 12, top: r.bottom - bh }, // 오른쪽 (아래 맞춤)
          { left: r.left - 12 - bw, top: r.top }, // 왼쪽
          { left: r.left - 12 - bw, top: r.bottom - bh },
          { left: clampX(r.right - bw), top: r.top - 12 - bh }, // 위 (오른쪽 맞춤)
          { left: clampX(r.right - bw), top: r.bottom + 12 },
        );
      } else candidates.push({ left: (vw - bw) / 2, top: (vh - bh) / 2 });
      candidates.push({ left: vw - bw - m, top: m }, { left: m, top: m }, { left: vw - bw - m, top: vh - bh - m }, { left: m, top: vh - bh - m });
      const score = (c) => {
        const box = { left: c.left, top: c.top, right: c.left + bw, bottom: c.top + bh };
        let sum = r ? overlap(box, r) * 4 : 0; // 눌러야 할 곳은 절대 가리지 않게
        for (const k of avoid) sum += overlap(box, k);
        return sum;
      };
      let bestScore = Infinity;
      // 화면 안으로 당긴 자리끼리 견준다 (가리는 넓이가 같으면 비춘 곳 가까운 자리 먼저)
      for (const [i, c] of candidates.map((c) => ({ left: clampX(c.left), top: clampY(c.top) })).entries()) {
        const s = score(c) + i;
        if (s < bestScore) {
          bestScore = s;
          best = c;
        }
      }
      // 지금 자리가 거의 같은 정도면 그대로 (말풍선이 이리저리 뛰지 않게)
      if (placedAt) {
        const cur = { left: clampX(placedAt.left), top: clampY(placedAt.top) };
        if (score(cur) <= bestScore * 1.1 + 40) best = cur;
      }
    }
    placedAt = best;
    bubble.style.left = `${Math.max(m, best.left)}px`;
    bubble.style.top = `${Math.max(m, best.top)}px`;
  }

  // 직접 해 보는 동안: 말풍선을 작은 알약으로 접어 둔다 (밖을 누르거나 글을 치면 저절로, 누르면 다시 펼침)
  function setMini(on) {
    if (bubble.classList.contains('mini') === on) return;
    bubble.classList.toggle('mini', on);
    placedAt = null;
    place();
  }
  document.addEventListener('pointerdown', (e) => {
    if (step?.advance && !bubble.hidden && !bubble.contains(e.target)) setMini(true);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (step?.advance && !bubble.hidden && !bubble.contains(e.target) && !e.ctrlKey && !e.metaKey && e.key.length === 1) setMini(true);
  }, true);

  function button(label, className, action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.dataset.coachAction = action;
    return b;
  }

  function show(next) {
    const prevId = step?.id;
    step = next;
    clearInterval(timer);
    if (!step) {
      spot.hidden = true;
      bubble.hidden = true;
      document.body.classList.remove('coaching');
      if (prevId) o.onStep?.(null);
      return;
    }
    const el = (tag, className, text) => {
      const e = document.createElement(tag);
      if (className) e.className = className;
      if (text != null) e.textContent = text;
      return e;
    };
    // 머리: 이모지 · 진행 막대 · 몇 번째
    const head = el('div', 'coach-head');
    const emoji = el('span', 'coach-emoji', step.emoji ?? '💡');
    const bar = el('div', 'coach-progress');
    const fill = el('i');
    fill.style.width = `${Math.round(((step.index + 1) / step.total) * 100)}%`;
    bar.append(fill);
    head.append(emoji, bar, el('span', 'coach-count', `${step.index + 1} / ${step.total}`));
    if (step.advance) {
      // 접기·펴기 (직접 해 볼 때 가리지 않게)
      const fold = button('', 'coach-fold', 'fold');
      fold.title = '말풍선 접기 · 펴기';
      fold.setAttribute('aria-label', '말풍선 접기 · 펴기');
      head.append(fold);
    }
    const parts = [head];
    if (step.praise) parts.push(el('div', 'coach-praise', PRAISE[step.index % PRAISE.length]));
    parts.push(el('h3', '', step.title), el('p', '', step.text));
    if (step.image) {
      const img = el('img', 'coach-shot');
      img.src = shotUrl(step.image);
      img.alt = `${step.title} 화면`;
      img.title = '눌러서 크게 보기';
      img.addEventListener('click', () => {
        bubble.classList.toggle('wide');
        place();
      });
      img.addEventListener('load', place);
      parts.push(img);
    }
    if (step.advance) parts.push(el('div', 'coach-try', `👉 ${step.try ?? '직접 해 보세요'}`));
    const actions = el('div', 'coach-actions');
    actions.append(button(step.skip ?? '튜토리얼 그만하기', 'coach-skip', 'skip'));
    // 직접 해 보는 단계의 "다음"은 이 단계만 건너뛰기 (옅은 단추) — 안내만 하는 단계는 노란 다음
    if (step.next) actions.append(button(step.next, step.advance ? 'btn coach-next coach-later' : 'btn primary coach-next', 'next'));
    parts.push(actions);
    bubble.replaceChildren(...parts);
    bubble.dataset.step = step.id;
    bubble.classList.remove('wide', 'mini');
    if (step.id !== prevId) placedAt = null;
    bubble.classList.toggle('trying', Boolean(step.advance));
    spot.classList.toggle('pulse', Boolean(step.advance));
    spot.hidden = false;
    bubble.hidden = false;
    document.body.classList.add('coaching');
    if (step.praise) confetti();
    // 바뀐 단계마다 다시 나타나는 움직임
    bubble.classList.remove('enter');
    void bubble.offsetWidth;
    bubble.classList.add('enter');
    place();
    // 창 크기·목록 내용이 바뀌어도 따라가게
    timer = setInterval(place, 400);
    if (!step.advance) bubble.querySelector('.coach-next')?.focus({ preventScroll: true });
    if (step.id !== prevId) o.onStep?.(step);
  }

  // 해 냈을 때: 말풍선에서 이모지 꽃가루 (움직임 줄이기에서는 생략)
  function confetti() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const pieces = ['🎉', '✨', '⭐', '🎊', '💛', '👑'];
    for (let i = 0; i < 12; i++) {
      const p = document.createElement('span');
      p.className = 'coach-confetti';
      p.textContent = pieces[i % pieces.length];
      p.style.left = `${8 + Math.random() * 84}%`;
      p.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
      p.style.setProperty('--dy', `${-60 - Math.random() * 90}px`);
      p.style.setProperty('--r', `${(Math.random() - 0.5) * 220}deg`);
      p.style.animationDelay = `${Math.random() * 0.12}s`;
      bubble.append(p);
      setTimeout(() => p.remove(), 1300);
    }
    if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.([10, 40, 14]); // 휴대폰만 (PC 크롬은 막고 경고를 남긴다)
  }

  bubble.addEventListener('click', (e) => {
    const b = e.target.closest('[data-coach-action]');
    if (b?.dataset.coachAction === 'fold') return setMini(!bubble.classList.contains('mini'));
    if (b) return api.tutorial.action(b.dataset.coachAction);
    if (bubble.classList.contains('mini')) setMini(false); // 접힌 알약을 누르면 펼침
  });
  window.addEventListener('resize', place);
  api.on('tutorial:step', show);
  // 창이 늦게 열렸을 때: 지금 이 창의 단계가 있으면 이어서
  api.tutorial.current().then((s) => s && show(s));

  return {
    get step() {
      return step;
    },
  };
}
