// 시트(아래에서 올라오는 창)·잠깐 알림·확인 대화 상자·시스템 막대 색
import { native } from './native.js';

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

/** 시트를 연다. close: 닫을 때 할 일 (기본은 숨기기) */
export function openSheet(el, { onClose } = {}) {
  if (sheets.some((s) => s.el === el)) return;
  el.hidden = false;
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

$('scrim').addEventListener('click', closeTopSheet);

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
export function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 4500 : 2600);
}

// ---------- 확인 ----------

let confirmResolve = null;
export function confirmDialog(message, okLabel = '지우기') {
  const dialog = $('confirm-dialog');
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    confirmResolve = resolve;
    dialog.addEventListener('close', () => {
      confirmResolve = null;
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
