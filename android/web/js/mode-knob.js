// 메모 화면 오른쪽 아래(엄지 자리) 다루기 방식 다이얼 — 글 고치기 · 옮기기 · 글 위에 그리기
//   - 다이얼을 누르면 다음 방식으로 한 칸 돌아가고, 둘레의 아이콘을 누르면 그 방식으로 바로
//   - 다이얼을 손가락으로 돌리면(끌면) 가까운 칸에 딸깍 맞춰진다
//   - 둘레의 칸은 다이얼을 누르거나 돌리는 동안(과 잠깐 뒤)만 펼친다 — 방식과 상관없이 늘 같게
//   - 바뀔 때마다 톡 진동. 무엇을 하는지·안내 문구는 note-view.js 의 onChange 가 정한다 (늘 같은 자리의 안내)
import { haptic } from '../../app/js/dom.js';

export const MODES = [
  { id: 'edit', label: '글 고치기', hint: '글자를 꾹 누르면 골라서 복사하거나 고칠 수 있어요', icon: 'type', angle: 180 },
  { id: 'move', label: '옮기기', hint: '줄이나 사진을 짧게 눌러 끌어요', icon: 'move', angle: 225 },
  { id: 'draw', label: '글 위에 그리기', hint: '밑줄이나 동그라미를 그려요. 글은 그대로예요', icon: 'highlighter', angle: 270 },
];
const byId = (id) => MODES.find((m) => m.id === id) ?? MODES[0];

function svg(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  s.append(use);
  return s;
}

/**
 * @param {HTMLElement} host 다이얼을 넣을 곳 (메모 화면)
 * @param {{ value: string, onChange: (mode: string, o: { quiet: boolean }) => void }} o
 */
export function setupModeKnob(host, { value, onChange }) {
  let mode = byId(value).id;
  const root = document.createElement('div');
  root.className = 'mode-knob';
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', '다루기 방식');

  // 둘레의 세 칸 (누르면 바로 그 방식)
  const stops = MODES.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `mk-stop mk-stop-${m.id}`;
    b.dataset.mode = m.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', m.label);
    b.style.setProperty('--a', `${m.angle}deg`);
    b.append(svg(m.icon));
    return b;
  });
  // 가운데 다이얼 (눈금이 고른 칸을 가리킨다)
  const dial = document.createElement('button');
  dial.type = 'button';
  dial.className = 'mk-dial';
  const notch = document.createElement('span');
  notch.className = 'mk-notch';
  const face = document.createElement('span');
  face.className = 'mk-dial-face';
  dial.append(face, notch);
  root.append(...stops, dial);
  host.append(root);

  // 둘레 칸 펼치기: 누르는 동안 + 손을 뗀 뒤 잠깐 (그 사이 칸을 바로 누를 수 있게)
  let foldTimer = 0;
  function unfold(hold = false) {
    clearTimeout(foldTimer);
    root.classList.add('open');
    if (!hold) foldTimer = setTimeout(() => root.classList.remove('open'), 2200);
  }

  function render() {
    const m = byId(mode);
    root.dataset.mode = mode;
    // 눈금: 0° 가 오른쪽(3시) — 칸의 각도로 돌린다 (CSS 전환이 이어서 돌려 주므로 중간에 바꿔도 부드럽다)
    root.style.setProperty('--turn', `${m.angle}deg`);
    face.replaceChildren(svg(m.icon));
    for (const b of stops) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    dial.setAttribute('aria-label', `다루기 방식: ${m.label} (누르면 다음 방식)`);
  }

  function choose(next, { quiet = false } = {}) {
    next = byId(next).id;
    if (next === mode) return;
    mode = next;
    render();
    if (!quiet) haptic(10);
    onChange(mode, { quiet });
  }

  // 손가락으로 다이얼을 톡 누르면 pointerup 다음에 click 이 한 번 더 온다 — 그 사이 방식이 바뀌어 화면이 움직이면
  //   (도구막대가 생기며 녹음 판이 올라오는 등) 손가락 밑에 온 다른 것(펼친 칸 · 녹음 "끝내기")이 눌린 것이 되므로,
  //   다이얼을 뗀 직후의 click 은 다이얼 말고는 받지 않는다
  let dialUpAt = 0;
  document.addEventListener('click', (e) => {
    if (performance.now() - dialUpAt >= 400 || dial.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  for (const b of stops) {
    b.addEventListener('click', () => {
      choose(b.dataset.mode);
      unfold();
    });
  }

  // 누르기 = 다음 칸 · 돌리기(끌기) = 가까운 칸
  let turn = null;
  dial.addEventListener('pointerdown', (e) => {
    const r = dial.getBoundingClientRect();
    turn = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
    dial.setPointerCapture?.(e.pointerId);
    unfold(true);
  });
  dial.addEventListener('pointermove', (e) => {
    if (!turn || e.pointerId !== turn.id) return;
    if (!turn.moved && Math.hypot(e.clientX - turn.x, e.clientY - turn.y) < 12) return;
    turn.moved = true;
    // 손가락이 있는 방향(화면 각도, 0° = 오른쪽, 시계 방향) → 가장 가까운 칸
    const deg = (Math.atan2(e.clientY - turn.cy, e.clientX - turn.cx) * 180) / Math.PI;
    const a = (deg + 360) % 360;
    const near = MODES.reduce((best, m) => (Math.abs(m.angle - a) < Math.abs(best.angle - a) ? m : best));
    if (near.id !== mode) choose(near.id);
  });
  const end = (e) => {
    if (!turn || e.pointerId !== turn.id) return;
    const tapped = !turn.moved;
    turn = null;
    dialUpAt = performance.now();
    unfold();
    if (tapped && e.type === 'pointerup') {
      const i = MODES.findIndex((m) => m.id === mode);
      choose(MODES[(i + 1) % MODES.length].id);
    }
  };
  dial.addEventListener('click', (e) => {
    if (e.detail !== 0) return; // 손가락·마우스는 pointerup 이 맡는다 — 키보드 Enter·Space 만
    unfold();
    const i = MODES.findIndex((m) => m.id === mode);
    choose(MODES[(i + 1) % MODES.length].id);
  });
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  root.addEventListener('focusin', () => turn || unfold()); // Tab 으로 왔을 때도 칸이 보이게
  // 키보드(블루투스 키보드 등): 화살표로 칸 옮기기
  root.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    unfold();
    const i = MODES.findIndex((m) => m.id === mode);
    choose(MODES[(i + dir + MODES.length) % MODES.length].id);
  });

  render();
  return {
    get mode() {
      return mode;
    },
    /** 바깥에서 바뀐 때 (그리기를 뒤로 가기로 끝냄 · 새 메모는 고치기로) — quiet 면 안내·진동 없이 */
    set: (next, opts) => choose(next, opts),
    el: root,
  };
}
