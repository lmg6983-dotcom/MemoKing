// 시트(아래에서 올라오는 창)·잠깐 알림·확인 대화 상자·시스템 막대 색
import { native } from './native.js';
import { swipeDismiss } from '../../app/js/dom.js';

const $ = (id) => document.getElementById(id);

// ---------- 시트: 여러 개가 겹치면 위의 것부터 닫힌다 (뒤로 가기·바깥 누르기) ----------

const sheets = []; // [{ el, close }]

function syncScrim() {
  const scrim = $('scrim');
  scrim.hidden = sheets.length === 0;
  // 위에 있는 시트 바로 아래에 막을 둔다
  if (sheets.length) {
    scrim.style.zIndex = String(40 + sheets.length * 2 - 1);
    sheets.forEach((s, i) => (s.el.style.zIndex = String(41 + i * 2)));
  }
}

// 대화형 시트(설정 · 휴지통 · 모을 앱 · 메모 메뉴 …)에는 오른쪽 위 × — 손잡이 · 바깥 누르기 · 뒤로 가기 말고도 눈에 보이는 닫기
//   (화면 읽기 사용자에게도 분명한 출구). 시트가 길어 내려도 위에 붙어 있다
//   × 는 위쪽 띠(.sheet-bar)에 — 내려서 보면 띠가 바탕색으로 채워져 아래 줄의 단추(허용 등) 위에 × 가 겹쳐 보이지 않는다
function addCloseButton(el) {
  if (el.getAttribute('role') !== 'dialog' || el.querySelector(':scope > .sheet-bar')) return;
  el.setAttribute('aria-modal', 'true');
  const bar = document.createElement('div');
  bar.className = 'sheet-bar';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'icon-btn sheet-x';
  x.setAttribute('aria-label', '닫기');
  x.innerHTML = '<svg><use href="#i-close"/></svg>';
  x.addEventListener('click', () => closeSheet(el));
  // 내려서 보면 띠에 시트 제목을 (빈 흰 줄처럼 보이지 않게, 지금 어느 시트인지)
  const name = document.createElement('b');
  name.className = 'sheet-bar-title';
  name.setAttribute('aria-hidden', 'true');
  name.textContent = el.querySelector('.sheet-title')?.textContent.trim() || el.getAttribute('aria-label') || '';
  bar.append(name, x);
  el.prepend(bar);
  el.addEventListener('scroll', () => el.classList.toggle('scrolled', el.scrollTop > 4), { passive: true });
}

/** 시트를 연다. close: 닫을 때 할 일 (기본은 숨기기) */
export function openSheet(el, { onClose } = {}) {
  if (sheets.some((s) => s.el === el)) return;
  addCloseButton(el);
  el.hidden = false;
  openedAt = performance.now();
  sheets.push({
    el,
    close: () => {
      el.hidden = true;
      onClose?.();
    },
  });
  syncScrim();
}

/** 스스로 열고 닫는 패널(예약 알림 패널)을 시트 목록에 올린다 */
export function adoptSheet(el, close) {
  if (sheets.some((s) => s.el === el)) return;
  sheets.push({ el, close });
  syncScrim();
}

export function releaseSheet(el) {
  const i = sheets.findIndex((s) => s.el === el);
  if (i >= 0) sheets.splice(i, 1);
  syncScrim();
}

export function closeSheet(el) {
  const i = sheets.findIndex((s) => s.el === el);
  if (i < 0) return;
  const [s] = sheets.splice(i, 1);
  s.close();
  syncScrim();
}

export function closeTopSheet() {
  const s = sheets.at(-1);
  if (!s) return false;
  closeSheet(s.el);
  return true;
}

export function closeAllSheets() {
  while (closeTopSheet());
}

export const sheetOpen = () => sheets.length > 0;

// 열자마자 들어온 "눌림"(꾹 눌렀다 뗀 손가락이 바로 아래 바탕을 누른 것으로 잡힘)으로 닫히지 않게 잠깐은 무시
let openedAt = 0;
$('scrim').addEventListener('click', () => {
  if (performance.now() - openedAt < 350) return;
  closeTopSheet();
});

// 시트 손잡이를 아래로 끌면 닫힘
let drag = null;
document.addEventListener('touchstart', (e) => {
  const grip = e.target.closest?.('.sheet-grip');
  const sheet = grip?.closest('.sheet');
  if (!sheet) return;
  drag = { sheet, y: e.touches[0].clientY, dy: 0 };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!drag) return;
  drag.dy = Math.max(0, e.touches[0].clientY - drag.y);
  drag.sheet.style.transform = `translateY(${drag.dy}px)`;
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!drag) return;
  const { sheet, dy } = drag;
  drag = null;
  sheet.style.transform = '';
  if (dy > 80) closeSheet(sheet);
});

// ---------- 잠깐 알림 ----------

let toastTimer = null;
/**
 * @param {string} text
 * @param {boolean} [isError]
 * @param {{ label: string, run: () => void }} [action] 오른쪽 버튼 (예: 되돌리기) — 있으면 조금 더 오래 보인다
 */
export function toast(text, isError = false, action = null) {
  const el = $('toast');
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !action;
  btn.textContent = action?.label ?? '';
  btn.onclick = action ? () => {
    el.hidden = true;
    action.run();
  } : null;
  el.classList.toggle('error', isError);
  el.setAttribute('role', isError ? 'alert' : 'status'); // 잘못된 것은 화면 읽기가 바로 읽게
  el.classList.toggle('has-action', Boolean(action));
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  // 처음 몇 번: 살짝 옆으로 밀렸다 돌아와 "밀면 닫혀요"를 몸짓으로 알린다 (글로 쓰지 않고)
  el.classList.remove('swipe-teach');
  try {
    const taught = Number(localStorage.getItem('memoking.toastSwipeTaught') ?? 0);
    if (taught < 2 && !isError) {
      void el.offsetWidth;
      el.classList.add('swipe-teach');
      localStorage.setItem('memoking.toastSwipeTaught', String(taught + 1));
    }
  } catch {
    // 기억 못 하면 알리지 않음
  }
  clearTimeout(toastTimer);
  toastLife = action ? 5000 : isError ? 4500 : 2600;
  toastTimer = setTimeout(() => (el.hidden = true), toastLife);
  // 옆이나 위로 밀면 바로 닫힌다 (다 읽었는데 5초 기다리지 않게) · 손을 대고 있는 동안은 사라지지 않음
  swipeDismiss(el, () => {
    clearTimeout(toastTimer);
    el.hidden = true;
  }, {
    up: true,
    onHold: (holding) => {
      clearTimeout(toastTimer);
      if (!holding && !el.hidden) toastTimer = setTimeout(() => (el.hidden = true), Math.min(toastLife, 2400));
    },
  });
}
let toastLife = 2600;

// ---------- 넓은 화면 (펼친 폴더블 · 태블릿): 목록과 메모를 나란히 ----------

const wide = window.matchMedia('(min-width: 640px) and (min-height: 460px)');
export const isTwoPane = () => wide.matches;
function applyPane() {
  document.body.classList.toggle('two-pane', wide.matches);
}
applyPane();
wide.addEventListener('change', () => {
  applyPane();
  window.dispatchEvent(new Event('memoking:pane'));
});

// ---------- 확인 ----------

// danger: 지우기처럼 되돌릴 수 없는 일이면 빨간 단추 (아니면 보통 단추) · cancelLabel: "취소" 가 헷갈릴 때 (예: 남겨 두기)
export function confirmDialog(message, okLabel = '삭제', { cancelLabel = '취소', danger = true } = {}) {
  const dialog = $('confirm-dialog');
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = okLabel;
  $('confirm-ok').classList.toggle('danger', danger);
  $('confirm-ok').classList.toggle('primary', !danger);
  dialog.querySelector('button[value="cancel"]').textContent = cancelLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok');
    }, { once: true });
  });
}

export function closeConfirm() {
  const dialog = $('confirm-dialog');
  if (!dialog.open) return false;
  dialog.close('cancel');
  return true;
}

/** 맨 위에 열린 창(showModal 한 <dialog>)을 Esc 처럼 닫기 — 각 창의 cancel 처리(저장 안 함 · 일하는 중이면 그대로)를 따른다
 *  창은 열 때 body 끝에 붙이므로 DOM 순서의 마지막이 맨 위 (show() 로 연 비모달 창은 건드리지 않는다) */
export function cancelTopDialog() {
  const dialog = [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal')).at(-1);
  if (!dialog) return false;
  if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
  return true;
}

// ---------- 시스템 막대(상태 막대·내비게이션 막대) 색 ----------

function toHex(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) return /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim() : null;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

const isLight = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
};

/** 요소의 바탕색으로 막대 색을 맞춘다 */
export function matchChrome(el, property = 'background-color') {
  const hex = toHex(getComputedStyle(el).getPropertyValue(property));
  if (!hex) return;
  try {
    native.setChrome(hex, isLight(hex));
  } catch {
    // 미리보기(브라우저)
  }
}
