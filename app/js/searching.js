// 찾는 중 · 불러오는 중 표시 — 돋보기가 이리저리 흔들리며 살피고, 점 세 개가 차례로 (모두 찾기 · 매직키 OPMS · OPMS 창)
//   빈 화면 대신 "찾고 있다" 는 것을 보여 준다. 움직임 줄이기 설정이면 흔들지 않고 숨 쉬듯 흐려졌다 밝아진다 (base.css)
const SVG = 'http://www.w3.org/2000/svg';

function glass() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'mk-glass');
  svg.setAttribute('aria-hidden', 'true');
  const lens = document.createElementNS(SVG, 'circle');
  lens.setAttribute('cx', '10.5');
  lens.setAttribute('cy', '10.5');
  lens.setAttribute('r', '6');
  const shine = document.createElementNS(SVG, 'path');
  shine.setAttribute('d', 'M7.6 9.2a3.2 3.2 0 012.4-2.3');
  shine.setAttribute('class', 'mk-glass-shine');
  const handle = document.createElementNS(SVG, 'path');
  handle.setAttribute('d', 'M15 15l5 5');
  handle.setAttribute('class', 'mk-glass-handle');
  svg.append(lens, shine, handle);
  return svg;
}

/**
 * @param {string} [text] 예: '찾는 중이에요' (끝의 … 는 움직이는 점으로)
 * @param {{ inline?: boolean, tag?: string }} [options] inline: 한 줄 (목록 안) · 아니면 가운데 크게
 */
export function searchingNode(text = '찾는 중이에요', { inline = false, tag = 'div' } = {}) {
  const box = document.createElement(tag);
  box.className = `mk-searching${inline ? ' inline' : ''}`;
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  label.className = 'mk-searching-text';
  label.textContent = String(text).replace(/[.…]+$/, '');
  const dots = document.createElement('span');
  dots.className = 'mk-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.append(Object.assign(document.createElement('i'), { textContent: '.' }));
  label.append(dots);
  box.append(glass(), label);
  return box;
}
