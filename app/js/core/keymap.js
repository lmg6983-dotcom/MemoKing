// 메모 창 단축키 — 사용자가 바꿀 수 있는 기능 목록 · 기본 키 · 키 글자 (순수 데이터 · 규칙, 단위 테스트 대상)
//   키는 e.code 기준 글자: 'ctrl+shift+KeyP' (한글 입력 상태에서도 같은 키). 순서는 ctrl → shift → alt → 코드
//   설정(settings.keymap)에는 기본값과 다른 기능만 { id: ['ctrl+KeyH'] | [] } 로 둔다 ([] = 키 없음)
import { keyName } from './accelerators.js';

/**
 * 기능: id · 무리(group) · 이름(label) · 하는 일(help, 마우스를 올리면) · 기본 키(keys, 여럿이면 둘째부터는 같은 일을 하는 다른 키)
 *   run: 메모 창이 실제로 할 일 — ['cmd', 편집기 명령] · ['color', 'color'|'highlight'] · ['action', 넣기] · ['app', 창 기능] · ['menu', 메뉴 단추 id]
 */
export const KEYMAP_ACTIONS = [
  // ---------- 메모 창 ----------
  { id: 'new', group: '메모 창', label: '새 메모 창', help: '이 메모와 같은 색의 새 메모를 바로 열어요.', keys: ['ctrl+KeyN'], run: ['app', 'new'] },
  { id: 'close', group: '메모 창', label: '닫기', help: '메모 창(또는 지금 탭)을 닫아요. 적은 내용은 이미 저장되어 있어요.', keys: ['ctrl+KeyW'], run: ['app', 'close'] },
  { id: 'top', group: '메모 창', label: '늘 위에 두기 (왕관)', help: '왕관 스티커를 붙여 이 메모가 다른 창에 가려지지 않게 해요. 다시 누르면 떼어져요.', keys: ['ctrl+shift+KeyT'], run: ['app', 'top'] },
  { id: 'tape', group: '메모 창', label: '바탕화면에 붙이기 (테이프)', help: '테이프로 바탕화면에 붙여 다른 창 뒤에 두어요. 다시 누르면 떼어져요.', keys: ['ctrl+shift+KeyG'], run: ['app', 'tape'] },
  { id: 'reminders', group: '메모 창', label: '예약 알림', help: '원하는 날짜와 시간에 이 메모를 알려 주는 알림을 맞춰요.', keys: ['ctrl+shift+KeyA'], run: ['app', 'reminders'] },
  { id: 'links', group: '메모 창', label: '메모 연결', help: '관련된 메모를 이어 두거나, 이어 둔 메모를 봐요.', keys: ['ctrl+KeyK'], run: ['app', 'links'] },
  { id: 'pdf', group: '메모 창', label: 'PDF로 저장', help: '종이 크기, 여백, 글자 크기를 골라 이 메모를 PDF 파일로 저장해요.', keys: ['ctrl+shift+KeyP'], run: ['menu', 'pdf-btn'] },
  { id: 'versions', group: '메모 창', label: '이전 버전', help: '10분마다 남겨 둔 이 메모의 지난 모습을 보고, 되돌릴 수 있어요.', keys: ['ctrl+shift+KeyY'], run: ['menu', 'versions-btn'] },
  { id: 'list', group: '메모 창', label: '메모 목록 열기', help: '모든 메모가 모인 목록 창을 앞으로 가져와요.', keys: ['ctrl+shift+KeyM'], run: ['menu', 'show-list'] },
  { id: 'imageCopy', group: '메모 창', label: '그림으로 복사', help: '메모를 보이는 그대로 그림으로 복사해요. 메신저나 문서에 바로 붙여 넣을 수 있어요.', keys: [], run: ['menu', 'image-copy-btn'] },
  { id: 'imageSave', group: '메모 창', label: '그림으로 저장', help: '메모를 보이는 그대로 그림 파일(PNG)로 저장해요.', keys: [], run: ['menu', 'image-save-btn'] },
  { id: 'pin', group: '메모 창', label: '목록 맨 위에 고정', help: '이 메모를 메모 목록의 맨 위에 붙여 두거나 풀어요.', keys: [], run: ['menu', 'pin-toggle'] },
  { id: 'lock', group: '메모 창', label: '잠그기', help: '비밀번호로 이 메모를 잠가요. 잠근 메모는 비밀번호를 넣어야 볼 수 있어요.', keys: [], run: ['menu', 'lock-btn'] },
  { id: 'shortcuts', group: '메모 창', label: '단축키 보기', help: '지금 쓸 수 있는 단축키를 한눈에 보여 줘요.', keys: ['ctrl+Slash'], run: ['app', 'shortcuts'] },
  // ---------- 글자 ----------
  { id: 'bold', group: '글자', label: '굵게', help: '고른 글자를 굵게 하거나 되돌려요.', keys: ['ctrl+KeyB'], run: ['cmd', 'bold'] },
  { id: 'italic', group: '글자', label: '기울임', help: '고른 글자를 기울이거나 되돌려요.', keys: ['ctrl+KeyI'], run: ['cmd', 'italic'] },
  { id: 'underline', group: '글자', label: '밑줄', help: '고른 글자에 밑줄을 긋거나 지워요.', keys: ['ctrl+KeyU'], run: ['cmd', 'underline'] },
  { id: 'strike', group: '글자', label: '취소선', help: '고른 글자에 가운데 줄을 긋거나 지워요.', keys: ['ctrl+KeyT'], run: ['cmd', 'strike'] },
  { id: 'code', group: '글자', label: '코드', help: '고른 글자를 코드 모양(고정 폭 글꼴)으로 바꿔요.', keys: ['ctrl+KeyE'], run: ['cmd', 'code'] },
  { id: 'color', group: '글자', label: '글자 색 (마지막 색)', help: '마지막으로 쓴 글자 색을 고른 글자에 칠해요.', keys: ['ctrl+shift+KeyC'], run: ['color', 'color'] },
  { id: 'highlight', group: '글자', label: '형광펜 (마지막 색)', help: '마지막으로 쓴 형광펜 색으로 고른 글자를 칠해요.', keys: ['ctrl+shift+KeyH'], run: ['color', 'highlight'] },
  { id: 'clearFormat', group: '글자', label: '서식 지우기', help: '고른 글자의 굵게 · 색 같은 모양을 지워요. 고른 것이 없으면 커서가 있는 문단을 보통 글로 되돌려요 (표는 글로, 목록은 풀어서).', keys: ['ctrl+Backslash'], run: ['cmd', 'clearFormat'] },
  { id: 'h1', group: '글자', label: '제목 1', help: '지금 줄을 가장 큰 제목으로 바꿔요.', keys: ['ctrl+Digit1'], run: ['cmd', 'h1'] },
  { id: 'h2', group: '글자', label: '제목 2', help: '지금 줄을 중간 제목으로 바꿔요.', keys: ['ctrl+Digit2'], run: ['cmd', 'h2'] },
  { id: 'h3', group: '글자', label: '제목 3', help: '지금 줄을 작은 제목으로 바꿔요.', keys: ['ctrl+Digit3'], run: ['cmd', 'h3'] },
  { id: 'paragraph', group: '글자', label: '본문', help: '제목이나 인용으로 바꾼 줄을 보통 글로 되돌려요.', keys: ['ctrl+Digit0'], run: ['cmd', 'paragraph'] },
  { id: 'quote', group: '글자', label: '인용', help: '지금 줄을 인용(왼쪽에 세로줄) 모양으로 바꿔요.', keys: ['ctrl+shift+KeyB'], run: ['cmd', 'quote'] },
  // ---------- 목록 ----------
  { id: 'bullet', group: '목록', label: '글머리 목록', help: '줄 앞에 점(•)을 붙여 목록으로 만들어요.', keys: ['ctrl+shift+Digit8', 'ctrl+shift+KeyL'], run: ['cmd', 'bullet'] },
  { id: 'ordered', group: '목록', label: '번호 목록', help: '줄 앞에 1, 2, 3 번호를 붙여 목록으로 만들어요.', keys: ['ctrl+shift+Digit7'], run: ['cmd', 'ordered'] },
  { id: 'task', group: '목록', label: '체크리스트', help: '줄 앞에 네모 칸을 붙여 할 일 목록으로 만들어요. 모두 끝내면 CLEAR 도장!', keys: ['ctrl+shift+Digit9'], run: ['cmd', 'task'] },
  // ---------- 넣기 ----------
  { id: 'file', group: '넣기', label: '파일 넣기', help: '사진이나 문서 같은 파일을 골라 메모에 넣어요.', keys: ['ctrl+shift+KeyI'], run: ['action', 'file'] },
  { id: 'record', group: '넣기', label: '음성 녹음 시작, 끝내기', help: '말을 녹음하고, 말한 내용을 글로 받아 적어 함께 넣어요.', keys: ['ctrl+shift+KeyR'], run: ['action', 'record'] },
  { id: 'ink', group: '넣기', label: '손 메모', help: '펜으로 그린 그림을 메모에 넣어요.', keys: ['ctrl+shift+KeyD'], run: ['action', 'ink'] },
  { id: 'annotate', group: '넣기', label: '글 위에 그리기', help: '글자 위에 밑줄이나 동그라미를 바로 그려요. 글의 자리는 그대로예요.', keys: ['ctrl+shift+KeyE'], run: ['action', 'annotate'] },
];

/** 바꿀 수 없는 키 (메모 창 · 편집기가 늘 쓰는 것) — 화면에는 '단축키 보기'에 함께 보인다 */
export const FIXED_KEYS = [
  ['다음, 이전 탭 (스택)', 'Ctrl+Tab / Ctrl+Shift+Tab'],
  ['본문 확대, 축소', 'Ctrl+휠 / Ctrl+= / Ctrl+-'],
  ['항목, 줄 순서 바꾸기', 'Alt+↑ / Alt+↓'],
  ['표: 다음, 이전 칸', 'Tab / Shift+Tab'],
  ['서식 없이 붙여넣기', 'Ctrl+Shift+V'],
];

// 편집 · 창이 늘 쓰는 키 — 다른 기능에 줄 수 없다
const RESERVED = new Set([
  'ctrl+KeyC', 'ctrl+KeyV', 'ctrl+KeyX', 'ctrl+KeyZ', 'ctrl+KeyY', 'ctrl+KeyA', 'ctrl+shift+KeyZ', 'ctrl+shift+KeyV',
  'ctrl+Tab', 'ctrl+shift+Tab', 'ctrl+Equal', 'ctrl+shift+Equal', 'ctrl+Minus', 'ctrl+NumpadAdd', 'ctrl+NumpadSubtract',
  'alt+ArrowUp', 'alt+ArrowDown', 'alt+F4',
]);

// 글 사이를 움직이고 고르는 키(Ctrl+← 단어 건너뛰기, Ctrl+Home, Ctrl+Delete 등)는 편집기가 쓴다
const NAV = /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Delete|Insert|Space)$/;
// Ctrl+Alt+1~9 는 메모 불러오기 키(메뉴 › 불러오기 키 정하기)가 어디서든 쓴다
const MEMO_HOTKEY = /^ctrl\+alt\+Digit[1-9]$/;

/** 이 키를 왜 못 쓰는지 (쓸 수 있으면 '') */
function reservedWhy(combo) {
  const code = combo.split('+').pop();
  if (RESERVED.has(combo)) return `${comboLabel(combo)} 은(는) 복사 · 붙여넣기처럼 늘 쓰는 키라 줄 수 없어요`;
  if (NAV.test(code) && /^(ctrl|alt|shift)\+/.test(combo)) return `${comboLabel(combo)} 은(는) 글을 옮겨 다니고 고를 때 쓰는 키라 줄 수 없어요`;
  if (MEMO_HOTKEY.test(combo)) return `${comboLabel(combo)} 은(는) 메모 불러오기 키(Ctrl+Alt+1~9)라 줄 수 없어요`;
  return '';
}

const byId = new Map(KEYMAP_ACTIONS.map((a) => [a.id, a]));
const COMBO = /^(ctrl\+)?(shift\+)?(alt\+)?([A-Za-z0-9]+)$/;

/** 키 글자가 쓸 만한가: Ctrl 이나 Alt 와 함께(F1~F12 는 혼자도), 아는 키, 늘 쓰는 키가 아님 */
export function isValidCombo(combo) {
  const m = COMBO.exec(String(combo ?? ''));
  if (!m) return false;
  const [, ctrl, , alt, code] = m;
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code)) return false;
  const fkey = /^F([1-9]|1[0-2])$/.test(code);
  if (!keyName(code)) return false;
  if (!ctrl && !alt && !fkey) return false;
  return !reservedWhy(combo);
}

/** 누른 키(keydown) → { combo } · 조합 중이면 { pending } · 못 쓰면 { error } */
export function comboFromEvent(e) {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) return { pending: true };
  if (e.metaKey) return { error: 'Win 키는 Windows 가 쓰는 키라 메모 창 단축키에는 쓸 수 없어요. Ctrl 이나 Alt 와 함께 눌러 주세요' };
  const combo = `${e.ctrlKey ? 'ctrl+' : ''}${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.code}`;
  if (!keyName(e.code)) return { error: '이 키는 쓸 수 없어요. 글자, 숫자, F1~F12 같은 키와 함께 눌러 주세요' };
  const why = reservedWhy(combo);
  if (why) return { error: why };
  if (!isValidCombo(combo)) return { error: 'Ctrl 이나 Alt 와 함께 눌러 주세요 (글을 쓸 때 눌리지 않게). F1~F12 는 혼자도 돼요' };
  return { combo };
}

/** 전역 단축키 글자('Control+Shift+P') → 메모 창 키 글자('ctrl+shift+KeyP') — Win 키가 들면 겹칠 일이 없어 null */
export function comboFromAccelerator(acc) {
  const parts = String(acc ?? '').split('+');
  const key = parts.pop();
  if (!key || parts.includes('Super')) return null;
  const NAMED = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
  const PUNCT = { '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '`': 'Backquote' };
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : NAMED[key] ?? PUNCT[key] ?? key;
  return `${parts.includes('Control') ? 'ctrl+' : ''}${parts.includes('Shift') ? 'shift+' : ''}${parts.includes('Alt') ? 'alt+' : ''}${code}`;
}

/** 이 키를 쓰는 메모 창 기능 (없으면 null) */
export function actionUsing(overrides, combo) {
  if (!combo) return null;
  const keys = resolveKeymap(overrides);
  return KEYMAP_ACTIONS.find((a) => keys[a.id].includes(combo)) ?? null;
}

/** 'ctrl+shift+KeyP' → 'Ctrl+Shift+P' */
export function comboLabel(combo) {
  const m = COMBO.exec(String(combo ?? ''));
  if (!m) return '';
  const [, ctrl, shift, alt, code] = m;
  return [ctrl && 'Ctrl', shift && 'Shift', alt && 'Alt', keyName(code) ?? code].filter(Boolean).join('+');
}

/** 설정의 바꾼 키 → 기능마다 지금 키 { id: [combo…] } (모르는 기능 · 잘못된 키는 버리고, 같은 키가 둘이면 앞의 기능만) */
function rawKeys(overrides) {
  const out = {};
  for (const a of KEYMAP_ACTIONS) {
    const o = overrides?.[a.id];
    out[a.id] = Array.isArray(o) ? o.filter(isValidCombo).slice(0, 1) : [...a.keys];
  }
  return out;
}

export function resolveKeymap(overrides) {
  const out = rawKeys(overrides);
  const seen = new Set();
  for (const a of KEYMAP_ACTIONS) {
    out[a.id] = out[a.id].filter((k) => !seen.has(k) && seen.add(k));
  }
  return out;
}

/** 설정에 둘 것만: 기본값과 다른 기능 */
export function cleanOverrides(overrides) {
  const out = {};
  for (const [id, keys] of Object.entries(overrides ?? {})) {
    const a = byId.get(id);
    if (!a || !Array.isArray(keys)) continue;
    const k = keys.filter(isValidCombo).slice(0, 1);
    if (k.length === a.keys.length && k.every((x, i) => x === a.keys[i])) continue;
    if (!k.length && !a.keys.length) continue;
    out[id] = k;
  }
  return out;
}

/**
 * 기능 하나의 키를 바꾼다 (null = 기본값으로). 같은 키를 쓰던 다른 기능에서는 그 키를 뺀다
 * @returns {{ overrides: object, moved: string[] }} moved: 키를 빼앗긴 기능의 이름
 */
export function setActionKey(overrides, id, combo) {
  if (!byId.has(id)) return { overrides: cleanOverrides(overrides), moved: [] };
  const next = { ...cleanOverrides(overrides) };
  if (combo === null) delete next[id];
  else next[id] = combo ? [combo] : [];
  const now = rawKeys(next);
  const mine = now[id];
  const moved = [];
  for (const a of KEYMAP_ACTIONS) {
    if (a.id === id) continue;
    if (now[a.id].some((k) => mine.includes(k))) {
      next[a.id] = now[a.id].filter((k) => !mine.includes(k)).slice(0, 1);
      moved.push(a.label);
    }
  }
  return { overrides: cleanOverrides(next), moved };
}

/** 메모 창이 쓰는 표: { combo: run } */
export function keymapTable(overrides) {
  const keys = resolveKeymap(overrides);
  const table = {};
  for (const a of KEYMAP_ACTIONS) for (const k of keys[a.id]) table[k] ??= a.run;
  return table;
}

/** 무리별로 (단축키 보기 · 단축키 설정 창) */
export function keymapGroups(overrides) {
  const keys = resolveKeymap(overrides);
  const groups = [];
  for (const a of KEYMAP_ACTIONS) {
    let g = groups.find((x) => x.title === a.group);
    if (!g) groups.push((g = { title: a.group, items: [] }));
    g.items.push({ ...a, current: keys[a.id], changed: keys[a.id].join() !== a.keys.join() });
  }
  return groups;
}
