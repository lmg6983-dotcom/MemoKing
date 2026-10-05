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
  'cloud-alert': `<path d="M7 18.5h10.5a4 4 0 00.6-7.95A6 6 0 006.6 9.1 4.75 4.75 0 007 18.5z" ${stroke}/><path d="M12 10.5v3.2M12 16.2h.01" ${stroke} stroke-width="2.2"/>`,
  'cloud-check': `<path d="M7 18.5h10.5a4 4 0 00.6-7.95A6 6 0 006.6 9.1 4.75 4.75 0 007 18.5z" ${stroke}/><path d="M9.3 13.6l1.9 1.9 3.6-3.8" ${stroke}/>`,
  chevron: `<path d="M9 6l6 6-6 6" ${stroke} stroke-width="2"/>`,
  google: '<path d="M21.6 12.2c0-.7-.06-1.3-.18-1.9H12v3.6h5.4a4.6 4.6 0 01-2 3v2.5h3.24c1.9-1.75 2.96-4.32 2.96-7.2z" fill="#4285F4"/><path d="M12 22c2.7 0 4.97-.9 6.63-2.43l-3.24-2.5c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.6A10 10 0 0012 22z" fill="#34A853"/><path d="M6.4 13.9a6 6 0 010-3.8V7.5H3.06a10 10 0 000 9z" fill="#FBBC05"/><path d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.6 9.6 0 0012 2a10 10 0 00-8.94 5.5l3.34 2.6C7.2 7.74 9.4 5.98 12 5.98z" fill="#EA4335"/>',
  pen: `<path d="M4 20h4L19 9a2.83 2.83 0 00-4-4L4 16v4z" ${stroke}/><path d="M13.5 6.5l4 4" ${stroke}/>`,
  pause: '<rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/>',
  play: '<path d="M8 5.5v13a1 1 0 001.5.86l10.4-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z" fill="currentColor"/>',
  sigma: `<path d="M18 5H6l6.5 7L6 19h12" ${stroke} stroke-width="2"/>`,
  photo: `<rect x="3.5" y="5" width="17" height="14" rx="2.5" ${stroke}/><circle cx="9" cy="10" r="1.6" ${stroke}/><path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" ${stroke}/>`,
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>',
  text: `<path d="M5 6h14M5 10.5h14M5 15h9M5 19.5h6" ${stroke}/>`,
  'keyboard-down': `<rect x="3" y="3.5" width="18" height="11" rx="2" ${stroke}/><path d="M7 7.5h.01M10.5 7.5h.01M14 7.5h.01M17.5 7.5h.01M8 11h8" ${stroke}/><path d="M9 18l3 3 3-3" ${stroke}/>`,
};

export function injectMobileIcons() {
  const symbols = Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
  document.body.insertAdjacentHTML('afterbegin', `<svg class="sprite" aria-hidden="true">${symbols}</svg>`);
}
