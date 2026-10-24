// 전역 단축키(매직 카피·매직키)를 사용자가 바꿀 수 있게 — 누른 키를 Electron 단축키 글자로, 그리고 화면에 보일 글자로.
//   저장: Electron accelerator ("Control+Alt+C") · 보이기: "Ctrl+Alt+C"
//   Ctrl·Alt·Win 중 하나는 꼭 함께 (Shift 만 또는 글자 하나만은 글을 쓸 때 눌리므로 안 됨), 흔한 편집 단축키는 막는다

export const DEFAULT_SHORTCUTS = { quickMemo: 'Control+Alt+C', magic: 'Control+Alt+Space' };
export const SHORTCUT_NAMES = { quickMemo: '매직 카피', magic: '매직키' };

const PUNCT = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
};
const NAMED = {
  Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
};
// 프로그램마다 쓰는 기본 단축키 — 전역으로 가져가면 다른 앱의 복사·붙여넣기 등이 망가진다
const RESERVED = new Set([
  'Control+C', 'Control+V', 'Control+X', 'Control+Z', 'Control+Y', 'Control+A', 'Control+S', 'Control+F', 'Control+P',
  'Control+N', 'Control+O', 'Control+W', 'Control+T', 'Control+Shift+Z', 'Alt+F4', 'Alt+Tab', 'Control+Alt+Delete',
  'Super+L', 'Super+D', 'Super+E', 'Super+R', 'Super+Tab',
]);

/** KeyboardEvent.code → 단축키의 키 이름 (지원하지 않는 키면 null) */
export function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return PUNCT[code] ?? NAMED[code] ?? null;
}

const isModifierCode = (code) => /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code);

/**
 * 누른 키(keydown) → { acc } 또는 아직 조합 중이면 { pending: true }, 쓸 수 없으면 { error }
 * @param {{ code: string, ctrlKey: boolean, altKey: boolean, shiftKey: boolean, metaKey: boolean }} e
 */
export function acceleratorFromKey(e) {
  if (isModifierCode(e.code)) return { pending: true }; // Ctrl 만 누른 채 — 나머지 키를 기다린다
  const key = keyName(e.code);
  if (!key) return { error: '이 키는 쓸 수 없어요. 글자, 숫자, F1~F24, Space 같은 키와 함께 눌러 주세요' };
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!mods.some((m) => m !== 'Shift')) return { error: 'Ctrl, Alt, Win 중 하나와 함께 눌러 주세요 (글을 쓸 때 눌리지 않게)' };
  const acc = [...mods, key].join('+');
  if (RESERVED.has(acc)) return { error: `${displayAccelerator(acc)} 키는 다른 프로그램들이 늘 쓰는 키라 쓸 수 없어요` };
  return { acc };
}

/** 저장된 단축키가 쓸 만한지 (설정 파일을 손으로 고쳤을 때 등) */
export function isValidAccelerator(acc) {
  if (typeof acc !== 'string') return false;
  const parts = acc.split('+');
  const key = parts.pop();
  const mods = new Set(parts);
  if (!parts.length || mods.size !== parts.length || ![...mods].every((m) => ['Control', 'Alt', 'Shift', 'Super'].includes(m))) return false;
  if (![...mods].some((m) => m !== 'Shift')) return false;
  const known = /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || Object.values(PUNCT).includes(key) || Object.values(NAMED).includes(key);
  return known && !RESERVED.has(acc);
}

/** "Control+Alt+C" → "Ctrl+Alt+C", "Super+Shift+M" → "Win+Shift+M" */
export function displayAccelerator(acc) {
  return String(acc ?? '').split('+').map((p) => ({ Control: 'Ctrl', Super: 'Win' }[p] ?? p)).join('+');
}

/** 설정의 단축키 묶음: 없거나 잘못된 것은 기본값으로, 둘이 같으면 매직키를 기본값으로 */
export function normalizeShortcuts(value) {
  const out = { ...DEFAULT_SHORTCUTS };
  for (const name of Object.keys(DEFAULT_SHORTCUTS)) {
    if (isValidAccelerator(value?.[name])) out[name] = value[name];
  }
  if (out.quickMemo === out.magic) out.magic = out.quickMemo === DEFAULT_SHORTCUTS.magic ? DEFAULT_SHORTCUTS.quickMemo : DEFAULT_SHORTCUTS.magic;
  return out;
}

/** 안내 글의 기본 단축키 표기를 지금 쓰는 키로 (튜토리얼·단축키 모음) */
export function withShortcuts(text, shortcuts) {
  const s = normalizeShortcuts(shortcuts);
  const map = {
    [displayAccelerator(DEFAULT_SHORTCUTS.quickMemo)]: displayAccelerator(s.quickMemo),
    [displayAccelerator(DEFAULT_SHORTCUTS.magic)]: displayAccelerator(s.magic),
  };
  // 한 번에 바꾼다 (바꾼 결과가 다른 기본 키와 같아도 다시 바뀌지 않게)
  const re = new RegExp(Object.keys(map).map((k) => k.replace(/[+]/g, '\\+')).join('|'), 'g');
  return String(text).replace(re, (m) => map[m]);
}
