// 휴대폰 화면에만 쓰는 아이콘 (나머지는 app/js/icons.js 와 함께 씀)
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  back: `<path d="M15 5l-7 7 7 7" ${stroke} stroke-width="2.2"/>`,
  phone: `<rect x="6.5" y="2.5" width="11" height="19" rx="2.5" ${stroke}/><path d="M10.5 18.5h3" ${stroke}/>`,
  share: `<circle cx="18" cy="5.5" r="2.5" ${stroke}/><circle cx="6" cy="12" r="2.5" ${stroke}/><circle cx="18" cy="18.5" r="2.5" ${stroke}/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" ${stroke}/>`,
  'cloud-alert': `<path d="M7 18.5h10.5a4 4 0 00.6-7.95A6 6 0 006.6 9.1 4.75 4.75 0 007 18.5z" ${stroke}/><path d="M12 10.5v3.2M12 16.2h.01" ${stroke} stroke-width="2.2"/>`,
  chevron: `<path d="M9 6l6 6-6 6" ${stroke} stroke-width="2"/>`,
  google: '<path d="M21.6 12.2c0-.7-.06-1.3-.18-1.9H12v3.6h5.4a4.6 4.6 0 01-2 3v2.5h3.24c1.9-1.75 2.96-4.32 2.96-7.2z" fill="#4285F4"/><path d="M12 22c2.7 0 4.97-.9 6.63-2.43l-3.24-2.5c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.6A10 10 0 0012 22z" fill="#34A853"/><path d="M6.4 13.9a6 6 0 010-3.8V7.5H3.06a10 10 0 000 9z" fill="#FBBC05"/><path d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.6 9.6 0 0012 2a10 10 0 00-8.94 5.5l3.34 2.6C7.2 7.74 9.4 5.98 12 5.98z" fill="#EA4335"/>',
  widget: `<rect x="3.5" y="3.5" width="17" height="17" rx="3.5" ${stroke}/><path d="M7.5 9h9M7.5 12.5h6M7.5 16h4" ${stroke}/>`,
  text: `<path d="M5 6h14M5 10.5h14M5 15h9M5 19.5h6" ${stroke}/>`,
  // 다루기 방식 다이얼 (mode-knob.js): 글자 커서 · 네 방향 화살표
  type: `<path d="M9 4.5h6M9 19.5h6M12 4.5v15" ${stroke} stroke-width="2"/>`,
  move: `<path d="M12 3.5v17M3.5 12h17" ${stroke}/><path d="M9.5 6L12 3.5 14.5 6M9.5 18l2.5 2.5 2.5-2.5M6 9.5L3.5 12 6 14.5M18 9.5l2.5 2.5-2.5 2.5" ${stroke}/>`,
  keyboard: `<rect x="3" y="6" width="18" height="12" rx="2" ${stroke}/><path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M8 14h8" ${stroke}/>`,
  'keyboard-down': `<rect x="3" y="3.5" width="18" height="11" rx="2" ${stroke}/><path d="M7 7.5h.01M10.5 7.5h.01M14 7.5h.01M17.5 7.5h.01M8 11h8" ${stroke}/><path d="M9 18l3 3 3-3" ${stroke}/>`,
};

export function injectMobileIcons() {
  const symbols = Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
  document.body.insertAdjacentHTML('afterbegin', `<svg class="sprite" aria-hidden="true">${symbols}</svg>`);
}
