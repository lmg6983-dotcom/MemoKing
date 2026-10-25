// 처음 그 상황이 됐을 때 한 번만 뜨는 작은 힌트 (PC·휴대폰 함께).
// 꾹 누르기·옆으로 밀기처럼 눈에 안 보이는 동작을 튜토리얼 없이 알려 준다.
//   - 힌트마다 한 번만 (localStorage 'memoking.hints'), 한 번에 하나만, 튜토리얼 말풍선이 떠 있으면 뜨지 않음
//   - 6초 뒤 저절로 사라지고(마우스를 올리거나 단추에 포커스가 있는 동안은 멈춤), "알겠어요" 나 아무 곳을 눌러도 닫힘
import { reduceMotion } from './dom.js';

const KEY = 'memoking.hints';
const SHOW_MS = 6000;

function seen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function remember(name) {
  try {
    const s = seen();
    s.add(name);
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // 저장 못 해도 이번에는 보여 준다
  }
}

let current = null;

function close() {
  if (!current) return;
  const { bubble, timer, onDown, onKey } = current;
  current = null;
  clearTimeout(timer);
  document.removeEventListener('pointerdown', onDown, true);
  document.removeEventListener('keydown', onKey, true);
  if (reduceMotion()) return bubble.remove();
  bubble.classList.add('leaving');
  setTimeout(() => bubble.remove(), 160);
}

/** 떠 있는 힌트 닫기 (탭을 바꿨을 때 — 다른 화면의 안내가 남아 있지 않게) */
export function closeHint() {
  close();
}

/**
 * @param {string} name 힌트 이름 (한 번만)
 * @param {string} text
 * @param {{ anchor?: Element|null }} [o] anchor: 이 요소 가까이 (없으면 화면 아래 가운데)
 * @returns {boolean} 보여 줬는지
 */
/** avoid: 가리면 안 되는 상자 (예: 설명하는 표 막대) — 아래에 두면 겹칠 때는 위로 */
export function hintOnce(name, text, { anchor = null, avoid = null } = {}) {
  if (current || seen().has(name)) return false;
  if (document.querySelector('.coach-bubble:not([hidden])')) return false; // 튜토리얼 중에는 미룸
  remember(name);
  const bubble = document.createElement('div');
  bubble.className = 'hint-bubble';
  bubble.setAttribute('role', 'status');
  const p = document.createElement('p');
  p.textContent = text;
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'hint-ok';
  ok.textContent = '알겠어요';
  ok.addEventListener('click', close);
  bubble.append(p, ok);
  document.body.append(bubble);
  const r = anchor?.getBoundingClientRect?.();
  // 비출 것이 화면 밖(스크롤로 가려짐)이면 화면 아래 가운데에
  if (r && r.width && r.bottom > 0 && r.top < window.innerHeight) {
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    const a = avoid && !avoid.hidden ? avoid.getBoundingClientRect() : null;
    const coversAvoid = a && a.height && r.bottom + 8 + h > a.top && r.bottom + 8 < a.bottom;
    //   (위에 자리가 모자라도 위로 — 비추는 것의 위쪽을 조금 가리는 편이 단추를 가리는 것보다 낫다)
    const below = r.bottom + 8 + h < window.innerHeight - 8 && !coversAvoid;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
  } else if (avoid && !avoid.hidden && avoid.getBoundingClientRect().height) {
    // 비출 것이 화면 밖이면 가리면 안 되는 막대 바로 위에
    const a = avoid.getBoundingClientRect();
    bubble.style.left = `${Math.max(8, (window.innerWidth - bubble.offsetWidth) / 2)}px`;
    bubble.style.top = `${Math.max(8, a.top - bubble.offsetHeight - 8)}px`;
  } else bubble.classList.add('bottom');
  const onDown = (e) => {
    if (!bubble.contains(e.target)) close();
  };
  // 단축키(Ctrl · Alt 와 함께)나 Esc 로 다른 창 · 판을 열면 그 위에 남지 않게 닫는다 (글자를 치는 것으로는 닫지 않음)
  const onKey = (e) => {
    if (e.key === 'Escape' || e.ctrlKey || e.altKey || e.metaKey) close();
  };
  // 이 힌트를 띄운 바로 그 누르기로 닫히지 않게 다음 틱부터
  setTimeout(() => {
    if (current?.bubble !== bubble) return;
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  current = { bubble, onDown, onKey, timer: setTimeout(close, SHOW_MS) };
  // 읽는 동안에는 사라지지 않게: 올려 두거나(포커스) 하면 멈추고, 떠나면 다시 6초
  const hold = () => current?.bubble === bubble && clearTimeout(current.timer);
  const resume = () => {
    if (current?.bubble !== bubble || bubble.matches(':hover') || bubble.contains(document.activeElement)) return;
    clearTimeout(current.timer);
    current.timer = setTimeout(close, SHOW_MS);
  };
  bubble.addEventListener('pointerenter', hold);
  bubble.addEventListener('focusin', hold);
  bubble.addEventListener('pointerleave', resume);
  bubble.addEventListener('focusout', () => setTimeout(resume, 0));
  return true;
}

