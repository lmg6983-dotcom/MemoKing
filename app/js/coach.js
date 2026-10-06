// 튜토리얼 말풍선 — 비출 요소 둘레만 밝게 두고 나머지를 어둡게, 옆에 안내 말풍선. (PC·휴대폰 함께)
// 화면은 그대로 눌러지므로(따라 하기) 비춘 버튼을 실제로 눌러 볼 수 있다.
//   - 머리: 단계 이모지 · 진행 막대 · 몇 번째인지
//   - 직접 해 보기 단계: 비춘 곳이 두근두근 + "👉 이렇게 해 보세요" — 해 내면 다음 말풍선에 "🎉 잘했어요!" 와 꽃가루
//   - 실제 화면 사진(app/assets/tutorial/): 누르면 크게
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
    let left;
    let top;
    if (!r) {
      left = (vw - bw) / 2;
      top = (vh - bh) / 2;
    } else {
      left = Math.min(Math.max(12, r.left), vw - bw - 12);
      if (r.bottom + 12 + bh <= vh - 8) top = r.bottom + 12; // 아래
      else if (r.top - 12 - bh >= 8) top = r.top - 12 - bh; // 위
      else top = Math.max(8, vh - bh - 8); // 큰 요소(편집기 등): 아래쪽에 겹쳐서
    }
    bubble.style.left = `${Math.max(8, left)}px`;
    bubble.style.top = `${Math.max(8, top)}px`;
  }

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
    bubble.classList.remove('wide');
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
    if (b) api.tutorial.action(b.dataset.coachAction);
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
