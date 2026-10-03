// 휴대폰 화면에만 쓰는 아이콘 (나머지는 app/js/icons.js 와 함께 씀)
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  back: `<path d="M15 5l-7 7 7 7" ${stroke} stroke-width="2.2"/>`,
  phone: `<rect x="6.5" y="2.5" width="11" height="19" rx="2.5" ${stroke}/><path d="M10.5 18.5h3" ${stroke}/>`,
  rows: `<rect x="3.5" y="4.5" width="17" height="6" rx="1.8" ${stroke}/><rect x="3.5" y="13.5" width="17" height="6" rx="1.8" ${stroke}/>`,
  grid: `<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.8" ${stroke}/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.8" ${stroke}/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.8" ${stroke}/><rect x="13" y="13" width="7.5" height="7.5" rx="1.8" ${stroke}/>`,
  share: `<circle cx="18" cy="5.5" r="2.5" ${stroke}/><circle cx="6" cy="12" r="2.5" ${stroke}/><circle cx="18" cy="18.5" r="2.5" ${stroke}/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" ${stroke}/>`,
  undo: `<path d="M9 14L4 9l5-5" ${stroke}/><path d="M4 9h10.5a5.5 5.5 0 010 11H11" ${stroke}/>`,
  redo: `<path d="M15 14l5-5-5-5" ${stroke}/><path d="M20 9H9.5a5.5 5.5 0 000 11H13" ${stroke}/>`,
  'keyboard-down': `<rect x="3" y="3.5" width="18" height="11" rx="2" ${stroke}/><path d="M7 7.5h.01M10.5 7.5h.01M14 7.5h.01M17.5 7.5h.01M8 11h8" ${stroke}/><path d="M9 18l3 3 3-3" ${stroke}/>`,
};

export function injectMobileIcons() {
  const symbols = Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
  document.body.insertAdjacentHTML('afterbegin', `<svg class="sprite" aria-hidden="true">${symbols}</svg>`);
}
