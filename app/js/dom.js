// 화면 쪽 작은 도우미 — PC·휴대폰이 같이 쓴다

// 톡 하는 진동: 손가락으로 쓰는 기기만 (PC 크롬은 막고 경고를 남긴다)
export function haptic(pattern) {
  if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(pattern);
}

// 움직임 줄이기를 켠 사람에게는 날아다니는 효과를 쉬게
export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// 같은 애니메이션 클래스를 다시 붙여 처음부터 다시 돌린다
export function replayClass(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// 자리·크기가 바뀐 요소를 transform 으로만 옛 자리에서 미끄러져 오게 (FLIP).
//   width·left 같은 배치 속성을 애니메이션하지 않아 매 프레임 레이아웃을 다시 잡지 않는다.
//   prev: 바꾸기 전 getBoundingClientRect(). 요소의 인라인 transform(자리 잡기용 translate)은 끝값으로 지킨다
export function flipFrom(el, prev, { duration = 200, easing = 'cubic-bezier(0.23, 1, 0.32, 1)' } = {}) {
  const next = el.getBoundingClientRect();
  if (!prev?.width || !prev.height || !next.width || !next.height || reduceMotion()) return;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  const sx = prev.width / next.width;
  const sy = prev.height / next.height;
  if (!dx && !dy && sx === 1 && sy === 1) return;
  const base = el.style.transform || '';
  el.animate([
    { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) ${base} scale(${sx}, ${sy})` },
    { transformOrigin: '0 0', transform: base || 'none' },
  ], { duration, easing });
}

/**
 * 탭 줄(role=tablist)을 키보드로: ←→ 로 옆 탭, Home·End 로 처음·끝 (누른 것과 같게 click)
 * Tab 키로는 고른 탭 하나에만 들르게(나머지는 tabindex -1) — 고를 때마다 syncTabStops 를 부른다
 */
export function tabKeys(tablist) {
  tablist.addEventListener('keydown', (e) => {
    const tabs = [...tablist.querySelectorAll('[role="tab"]')].filter((t) => !t.hidden);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    t.focus();
    t.click();
  });
  syncTabStops(tablist);
}
export function syncTabStops(tablist) {
  for (const t of tablist.querySelectorAll('[role="tab"]')) t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1;
}

/**
 * 메뉴(펼친 단추 목록)를 키보드로: ↑↓(←→도) 로 다음·이전 항목, Home·End 로 처음·끝. 숨은 항목은 건너뛴다
 * @param {HTMLElement} menu
 * @param {string} items 항목 선택자
 */
export function menuKeys(menu, items) {
  menu.addEventListener('keydown', (e) => {
    const list = [...menu.querySelectorAll(items)].filter((b) => !b.hidden && !b.disabled && b.getClientRects().length);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    let next;
    if (step) next = i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else return;
    e.preventDefault();
    list[next].focus();
  });
}

/** 메뉴를 키보드로 열었으면(click 의 detail 0) 첫 항목에 포커스 — 마우스로 열면 그대로 */
export function focusFirstIfKeyboard(event, menu, items) {
  if (event?.detail !== 0) return;
  requestAnimationFrame(() => [...menu.querySelectorAll(items)].find((b) => !b.hidden && !b.disabled && b.getClientRects().length)?.focus());
}

/**
 * 화면의 모든 고르기 칸(role=radiogroup)을 제대로: 칸마다 role=radio, ←→↑↓ 로 옆 칸을 고르고(누른 것과 같게 click),
 * Tab 으로는 고른 칸 하나에만 들른다. 나중에 생긴 칸·바뀐 선택도 따라간다 (aria-checked 를 지켜봄)
 */
export function radioGroups(root = document) {
  const radios = (g) => [...g.children].filter((c) => c.matches('button[aria-checked], [role="radio"]') && !c.hidden && !c.disabled);
  const sync = (g) => {
    const list = radios(g);
    const on = list.find((r) => r.getAttribute('aria-checked') === 'true') ?? list[0];
    for (const r of list) {
      if (!r.hasAttribute('role')) r.setAttribute('role', 'radio');
      r.tabIndex = r === on ? 0 : -1;
    }
  };
  const seen = new WeakSet();
  const adopt = () => {
    for (const g of root.querySelectorAll('[role="radiogroup"]')) {
      sync(g);
      if (seen.has(g)) continue;
      seen.add(g);
      g.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        const list = radios(g);
        const i = list.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        const next = list[(i + step + list.length) % list.length];
        next.focus();
        next.click();
      });
    }
  };
  adopt();
  // 글을 쓰는 동안에도 바뀜이 많으므로 한 화면(프레임)에 한 번만
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      adopt();
    });
  }).observe(root.body ?? root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked', 'hidden'] });
}
