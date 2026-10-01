// 튜토리얼 말풍선 — 비출 요소 둘레만 밝게 두고 나머지를 어둡게, 옆에 안내 말풍선.
// 화면은 그대로 눌러지므로(따라 하기) 비춘 버튼을 실제로 눌러 볼 수 있다.
// 단계 진행은 메인 프로세스가 맡고(core/tutorial.js), 여기서는 보여 주고 버튼만 전한다.

export function setupCoach(api) {
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
    step = next;
    clearInterval(timer);
    if (!step) {
      spot.hidden = true;
      bubble.hidden = true;
      document.body.classList.remove('coaching');
      return;
    }
    const count = document.createElement('div');
    count.className = 'coach-count';
    count.textContent = `${step.index + 1} / ${step.total}`;
    const title = document.createElement('h3');
    title.textContent = step.title;
    const text = document.createElement('p');
    text.textContent = step.text;
    const actions = document.createElement('div');
    actions.className = 'coach-actions';
    if (step.advance) {
      const hint = document.createElement('span');
      hint.className = 'coach-try';
      hint.textContent = '직접 해 보세요';
      actions.append(hint);
    }
    actions.append(button(step.skip ?? '건너뛰기', 'coach-skip', 'skip'));
    if (step.next) actions.append(button(step.next, 'btn primary coach-next', 'next'));
    bubble.replaceChildren(count, title, text, actions);
    bubble.dataset.step = step.id;
    spot.hidden = false;
    bubble.hidden = false;
    document.body.classList.add('coaching');
    place();
    // 창 크기·목록 내용이 바뀌어도 따라가게
    timer = setInterval(place, 400);
    bubble.querySelector('.coach-next')?.focus();
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
