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
  const { bubble, timer, onDown } = current;
  current = null;
  clearTimeout(timer);
  document.removeEventListener('pointerdown', onDown, true);
  if (reduceMotion()) return bubble.remove();
  bubble.classList.add('leaving');
  setTimeout(() => bubble.remove(), 160);
}

/**
 * @param {string} name 힌트 이름 (한 번만)
 * @param {string} text
 * @param {{ anchor?: Element|null }} [o] anchor: 이 요소 가까이 (없으면 화면 아래 가운데)
 * @returns {boolean} 보여 줬는지
 */
export function hintOnce(name, text, { anchor = null } = {}) {
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
  if (r && r.width) {
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    const below = r.bottom + 8 + h < window.innerHeight - 8;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
  } else bubble.classList.add('bottom');
  const onDown = (e) => {
    if (!bubble.contains(e.target)) close();
  };
  // 이 힌트를 띄운 바로 그 누르기로 닫히지 않게 다음 틱부터
  setTimeout(() => current?.bubble === bubble && document.addEventListener('pointerdown', onDown, true), 0);
  current = { bubble, onDown, timer: setTimeout(close, SHOW_MS) };
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

