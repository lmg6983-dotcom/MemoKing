// 메모 단축키 — 자주 쓰는 메모(안내 문구 등)를 Ctrl+Alt+1~9 로 어디서든 바로 불러오기
//   칸마다 { id, copy, show }: copy = 메모 내용을 클립보드로, show = 메모 창 띄우기 (둘 중 하나 이상)
//   이 PC 의 설정(settings.json)에 둔다 — 단축키는 PC 마다 다르게 쓸 수 있게
import { shareText } from './share-text.js';

export const HOTKEY_SLOTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
export const hotkeyAccelerator = (slot) => `Control+Alt+${slot}`;
export const hotkeyLabel = (slot) => `Ctrl+Alt+${slot}`;

const validSlot = (slot) => HOTKEY_SLOTS.includes(String(slot));

/** 설정 파일의 값 → 깨끗한 { 칸: { id, copy, show } } (둘 다 끈 칸 · 잘못된 칸은 버림) */
export function normalizeHotkeys(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [slot, v] of Object.entries(raw)) {
    if (!validSlot(slot) || !v || typeof v.id !== 'string' || !v.id) continue;
    const copy = v.copy !== false;
    const show = v.show === true;
    if (copy || show) out[slot] = { id: v.id, copy, show };
  }
  return out;
}

/** 그 메모가 쓰는 칸 (없으면 null) */
export function slotOf(hotkeys, id) {
  return Object.keys(hotkeys ?? {}).find((slot) => hotkeys[slot]?.id === id) ?? null;
}

/**
 * 메모에 칸을 정한다 (그 메모의 예전 칸은 비우고, 그 칸의 다른 메모는 빠진다). slot 이 null 이면 풀기
 * @returns {{ hotkeys: object, replaced: string|null }} replaced: 그 칸을 쓰던 다른 메모 id
 */
export function assignHotkey(hotkeys, id, slot, { copy = true, show = false } = {}) {
  const next = normalizeHotkeys(hotkeys);
  for (const s of Object.keys(next)) if (next[s].id === id) delete next[s];
  if (slot == null) return { hotkeys: next, replaced: null };
  if (!validSlot(slot)) throw new Error('1~9 중에서 골라 주세요');
  if (!copy && !show) throw new Error('복사하기와 띄우기 중 하나는 골라 주세요');
  const replaced = next[slot] && next[slot].id !== id ? next[slot].id : null;
  next[String(slot)] = { id, copy: Boolean(copy), show: Boolean(show) };
  return { hotkeys: next, replaced };
}

/**
 * 단축키로 복사할 글: 맨 위 제목 줄(# 제목)은 빼고 본문만, 서식 기호 없이 보이는 모양 그대로 (줄 앞 띄어쓰기도)
 *   제목 줄이 없거나(첫 줄이 그냥 글) 본문이 비면 전체
 */
export function hotkeyCopyText(markdown) {
  const body = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = body.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^\s{0,3}#{1,6}\s/.test(lines[first])) {
    const rest = shareText(lines.slice(first + 1).join('\n'));
    if (rest.trim()) return rest;
  }
  return shareText(body);
}
