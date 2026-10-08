// 두 창(목록·스티커)이 함께 쓰는 SVG 아이콘. <svg><use href="#i-이름"/></svg> 로 쓴다.
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  crown: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z" fill="currentColor"/>',
  // 목록 늘 위에 두기 버튼: 선 왕관 (누르면 이 왕관이 창 위 가장자리 스티커가 된다)
  'crown-line': `<path d="M4 8.5l4 3.5L12 5.5l4 6.5 4-3.5-1.6 9H5.6L4 8.5z" ${stroke}/><circle cx="4" cy="7" r="1.3" fill="currentColor"/><circle cx="12" cy="4" r="1.3" fill="currentColor"/><circle cx="20" cy="7" r="1.3" fill="currentColor"/><path d="M6 20.5h12" ${stroke}/>`,
  plus: `<path d="M12 5v14M5 12h14" ${stroke} stroke-width="2.2"/>`,
  search: `<circle cx="11" cy="11" r="6.5" ${stroke}/><path d="M16 16l4 4" ${stroke}/>`,
  gear: `<circle cx="12" cy="12" r="3" ${stroke}/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" ${stroke}/>`,
  close: `<path d="M6 6l12 12M18 6L6 18" ${stroke} stroke-width="2"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5" ${stroke} stroke-width="2.2"/>`,
  more: '<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>',
  pin: `<path d="M9 4h6l-1 6 3 3v2h-4v5l-1 1-1-1v-5H7v-2l3-3-1-6z" ${stroke}/>`,
  'pin-fill': '<path d="M9 4h6l-1 6 3 3v2h-4v5l-1 1-1-1v-5H7v-2l3-3-1-6z" fill="currentColor"/>',
  link: `<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" ${stroke}/>`,
  trash: `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" ${stroke}/>`,
  bullet: `<circle cx="5" cy="7" r="1.4" fill="currentColor"/><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="5" cy="17" r="1.4" fill="currentColor"/><path d="M10 7h10M10 12h10M10 17h10" ${stroke}/>`,
  ordered: `<path d="M10 7h10M10 12h10M10 17h10" ${stroke}/><path d="M4 5.5l1.5-1V9M3.8 14.2c.3-.8 2.4-.9 2.4.4 0 1-2.4 2-2.4 3.2h2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
  task: `<rect x="3.5" y="4.5" width="6" height="6" rx="1.2" ${stroke}/><path d="M4.8 7.6l1.3 1.3 2.3-2.6" ${stroke} stroke-width="1.4"/><rect x="3.5" y="13.5" width="6" height="6" rx="1.2" ${stroke}/><path d="M13 7.5h7M13 16.5h7" ${stroke}/>`,
  quote: '<path d="M5 17c0-4 1-7 5-9l.8 1.4C8.6 10.6 8 12 8 13.5h2.5V18H5v-1zm9 0c0-4 1-7 5-9l.8 1.4c-2.2 1.2-2.8 2.6-2.8 4.1h2.5V18H14v-1z" fill="currentColor"/>',
  image: `<rect x="3.5" y="4.5" width="17" height="15" rx="2" ${stroke}/><circle cx="9" cy="10" r="1.8" ${stroke}/><path d="M20.5 16l-5-5-8.5 8.5" ${stroke}/>`,
  mic: `<rect x="9" y="3.5" width="6" height="11" rx="3" ${stroke}/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v2.5" ${stroke}/>`,
  photo: `<rect x="3.5" y="5" width="17" height="14" rx="2.5" ${stroke}/><circle cx="9" cy="10" r="1.6" ${stroke}/><path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" ${stroke}/>`,
  sigma: `<path d="M18 5H6l6.5 7L6 19h12" ${stroke} stroke-width="2"/>`,
  // 이전 버전: 거꾸로 도는 시계
  history: `<path d="M3.5 12a8.5 8.5 0 102.5-6" ${stroke}/><path d="M3 4v4h4" ${stroke}/><path d="M12 7.5V12l3 2" ${stroke}/>`,
  // 단축키 한눈에 보기: 자판
  keyboard: `<rect x="2.5" y="6" width="19" height="12" rx="2" ${stroke}/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" ${stroke} stroke-width="2"/>`,
  undo: `<path d="M9 14L4 9l5-5" ${stroke}/><path d="M4 9h10.5a5.5 5.5 0 010 11H11" ${stroke}/>`,
  redo: `<path d="M15 14l5-5-5-5" ${stroke}/><path d="M20 9H9.5a5.5 5.5 0 000 11H13" ${stroke}/>`,
  eraser: `<path d="M8.5 19.5h11" ${stroke}/><path d="M4.6 14.6l9.2-9.2a2 2 0 012.8 0l3 3a2 2 0 010 2.8l-7.8 7.8a2 2 0 01-1.4.5H8.3a2 2 0 01-1.4-.6l-2.3-2.3a1.4 1.4 0 010-2z" ${stroke}/><path d="M9.5 9.7l4.8 4.8" ${stroke}/>`,
  ink: `<path d="M3.5 17c2.2-4.4 4.1-9.5 6.3-9.5 2.6 0-1.6 9.8 1.4 9.8 2.3 0 3.3-6.1 5.6-6.1 1.7 0 .9 4.3 3.7 4.3" ${stroke}/>`,
  rows: `<rect x="3.5" y="4.5" width="17" height="6" rx="1.8" ${stroke}/><rect x="3.5" y="13.5" width="17" height="6" rx="1.8" ${stroke}/>`,
  grid: `<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.8" ${stroke}/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.8" ${stroke}/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.8" ${stroke}/><rect x="13" y="13" width="7.5" height="7.5" rx="1.8" ${stroke}/>`,
  pen: `<path d="M4 20h4L19 9a2.83 2.83 0 00-4-4L4 16v4z" ${stroke}/><path d="M13.5 6.5l4 4" ${stroke}/>`,
  pause: '<rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/>',
  play: '<path d="M8 5.5v13a1 1 0 001.5.86l10.4-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>',
  audio: `<path d="M9 18V6l11-2v12" ${stroke}/><circle cx="6.5" cy="18" r="2.5" ${stroke}/><circle cx="17.5" cy="16" r="2.5" ${stroke}/>`,
  video: `<rect x="3" y="6" width="13" height="12" rx="2" ${stroke}/><path d="M16 10.5l5-3v9l-5-3" ${stroke}/>`,
  clip: `<path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" ${stroke}/>`,
  highlighter: `<path d="M15 4l5 5-8.5 8.5H7V13L15 4z" ${stroke}/><path d="M7 17.5L4.5 20H9" ${stroke}/>`,
  file: `<path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5l-5-5z" ${stroke}/><path d="M14 3.5v5h5" ${stroke}/>`,
  bell: `<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15L6 16z" ${stroke}/><path d="M10 20.5a2 2 0 004 0" ${stroke}/>`,
  timer: `<circle cx="12" cy="13" r="7.5" ${stroke}/><path d="M12 9v4l2.5 2M9.5 3h5" ${stroke}/>`,
  calendar: `<rect x="3.5" y="5" width="17" height="15" rx="2" ${stroke}/><path d="M3.5 10h17M8 3v4M16 3v4" ${stroke}/>`,
  repeat: `<path d="M17 3l3 3-3 3M20 6H8a4 4 0 00-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 004-4v-1" ${stroke}/>`,
  power: `<path d="M12 3v8M7.1 6.3a7.5 7.5 0 109.8 0" ${stroke}/>`,
  copy: `<rect x="8" y="8" width="12" height="12" rx="2" ${stroke}/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" ${stroke}/>`,
  note: `<path d="M5 4.5h14v10l-5 5H5z" ${stroke}/><path d="M14 19.5v-5h5M8.5 9h7M8.5 12.5h4" ${stroke}/>`,
  inbox: `<path d="M3.5 13.5l2.5-8h12l2.5 8v5a1.5 1.5 0 01-1.5 1.5h-14a1.5 1.5 0 01-1.5-1.5z" ${stroke}/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5" ${stroke}/>`,
  chevrons: `<path d="M6 7l5 5-5 5M13 7l5 5-5 5" ${stroke} stroke-width="2"/>`,
  list: `<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" ${stroke} stroke-width="2.2"/>`,
  filter: `<path d="M4 5.5h16l-6.2 7.3V19l-3.6-1.8v-4.4L4 5.5z" ${stroke}/>`,
  tag: `<path d="M3.5 12.2V4.5a1 1 0 011-1h7.7l8.3 8.3a1.5 1.5 0 010 2.1l-6.6 6.6a1.5 1.5 0 01-2.1 0l-8.3-8.3z" ${stroke}/><circle cx="8" cy="8" r="1.4" fill="currentColor"/>`,
  tabs: `<path d="M3.5 9.5V18a1.5 1.5 0 001.5 1.5h14a1.5 1.5 0 001.5-1.5V9.5M3.5 9.5V6A1.5 1.5 0 015 4.5h4.5l1.5 5M3.5 9.5h17M11 9.5l1.2-3.5H18a1.5 1.5 0 011.5 1.5v2" ${stroke}/>`,
  table: `<rect x="3.5" y="4.5" width="17" height="15" rx="2" ${stroke}/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M15 9.5v10" ${stroke}/>`,
  pdf: `<path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5l-5-5z" ${stroke}/><path d="M14 3.5v5h5" ${stroke}/><path d="M12 11v6M9.5 14.5L12 17l2.5-2.5" ${stroke}/>`,
  // 앱 알림 그만 모으기
  block: `<circle cx="12" cy="12" r="8.5" ${stroke}/><path d="M6 6l12 12" ${stroke}/>`,
  cloud: `<path d="M7 18.5h10.5a4 4 0 00.6-7.95A6 6 0 006.6 9.1 4.75 4.75 0 007 18.5z" ${stroke}/>`,
  folder: `<path d="M3.5 7a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2V7z" ${stroke}/>`,
  // (예전) 다른 창보다 늘 위에 두기: 창 + 위 화살표 — 지금은 왕관. 압정은 "목록 맨 위에 고정" 에만, "고정" 이라는 말도 그쪽에만 쓴다
  ontop: `<rect x="3.5" y="4.5" width="17" height="15" rx="2" ${stroke}/><path d="M3.5 8.5h17" ${stroke}/><path d="M12 17v-5.5M9.2 14l2.8-2.8 2.8 2.8" ${stroke} stroke-width="2"/>`,
  // (예전) 기울어진 압정
  pushpin: `<g transform="rotate(40 12 12)"><path d="M9 3h6l-1 6 3 3v2h-4v6l-1 1.5-1-1.5v-6H7v-2l3-3-1-6z" ${stroke}/></g>`,
};

export function injectIcons() {
  const symbols = Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
  document.body.insertAdjacentHTML('afterbegin', `<svg class="sprite" aria-hidden="true">${symbols}</svg>`);
}

export function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
