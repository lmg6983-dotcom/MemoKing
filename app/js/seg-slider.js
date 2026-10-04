// 여럿 중 하나 고르기(탭·종류 고르기)의 선택 표시가 다음 칸으로 미끄러져 간다 — 데스크탑·휴대폰 함께
//   무엇이 바뀌었는지 눈으로 따라갈 수 있게. 칸의 aria-selected / aria-checked 가 바뀌면 저절로 따라간다
//   (각 화면의 고르기 코드는 그대로 두고, 이 표시만 얹는다). 움직임 줄이기 설정이면 바로 옮긴다

const SELECTED = '[aria-selected="true"], [aria-checked="true"]';

/**
 * @param {Element} box 칸들을 담은 상자 (.tabs, .seg …)
 * @param {{ className?: string }} [options] 표시 요소의 class (기본 seg-thumb)
 */
export function attachSlider(box, { className = 'seg-thumb' } = {}) {
  if (!box || box.dataset.slider) return null;
  box.dataset.slider = '1';
  box.classList.add('mk-slider');
  const thumb = document.createElement('span');
  thumb.className = className;
  thumb.setAttribute('aria-hidden', 'true');
  box.prepend(thumb);
  let first = true;

  function place() {
    const sel = box.querySelector(`:scope > ${SELECTED.split(', ').join(', :scope > ')}`);
    if (!sel || !sel.offsetWidth) {
      thumb.style.opacity = '0';
      return;
    }
    if (first) thumb.style.transition = 'none'; // 처음은 제자리에 바로
    thumb.style.opacity = '1';
    thumb.style.width = `${sel.offsetWidth}px`;
    thumb.style.height = `${sel.offsetHeight}px`;
    thumb.style.borderRadius = getComputedStyle(sel).borderRadius;
    thumb.style.transform = `translate(${sel.offsetLeft}px, ${sel.offsetTop}px)`;
    if (first) {
      void thumb.offsetWidth;
      thumb.style.transition = '';
      first = false;
    }
  }

  new MutationObserver(place).observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'aria-checked', 'hidden'] });
  new ResizeObserver(place).observe(box);
  place();
  return { place };
}

/** 문서 안의 고르기 상자들에 한꺼번에 (나중에 생기는 것은 attachSlider 로 따로) */
export function attachSliders(root = document, selector = '.tabs, .seg') {
  for (const box of root.querySelectorAll(selector)) attachSlider(box);
}
