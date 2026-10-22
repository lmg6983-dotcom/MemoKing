// 매직키 (Ctrl+Alt+Space) — 어디서든 빠르게 입력하는 창. 여러 기능 모듈로 이루어지고, 설정에서 모듈마다 끄고 켠다.
// (순수 함수, 단위 테스트 대상) 모듈을 더할 때는 여기에 한 줄 + magic.js 의 render() 에 결과 줄.
import { WEB_ENGINES, AI_SITES, pickId } from './magic-tools.js';

// chip: 매직키 창 아래 캡슐의 짧은 이름 · ready: 지금 쓸 수 있는가 (false = 준비 중, 설정에서 켤 수 없음)
export const MAGIC_MODULES = [
  { id: 'memo', name: '메모 만들기', chip: '새 메모', description: '입력한 글을 새 메모로 바로 저장해요 (Enter 저장, Ctrl+Enter 저장하고 열기)', ready: true, defaultOn: true },
  { id: 'notes', name: '메모 검색', chip: '메모 검색', description: '입력하는 대로 메모의 제목과 내용에서 찾아 바로 열어요', ready: true, defaultOn: true },
  { id: 'files', name: '파일 검색', chip: '파일 검색', description: 'PC 의 파일, 폴더, 프로그램 이름을 바로 찾아 열어요. 따로 설치할 것 없이 메모킹이 이름 목록을 만들어 두어요 (이 PC 안에서만, 내용은 읽지 않음)', ready: true, defaultOn: true },
  { id: 'calc', name: '계산기', chip: '계산기', description: '식이나 날짜를 쓰면 바로 계산해요 (1,200 × 3, 15% * 80000, 3주 뒤, 12/25까지, 9:15부터 18:30까지). Enter 로 결과 복사', ready: true, defaultOn: true },
  { id: 'web', name: '웹 검색', chip: '웹 검색', description: '쓴 글을 검색 사이트에서 찾거나, 사이트 주소를 바로 열어요. 고르기 전에는 아무것도 보내지 않아요', ready: true, defaultOn: true },
  { id: 'ai', name: 'AI 에게 묻기', chip: 'AI', description: 'ChatGPT, Claude 등에 바로 물어봐요. 브라우저에서 로그인한 계정 그대로, API 키는 필요 없어요', ready: true, defaultOn: true },
  { id: 'opms', name: 'OPMS 검색', chip: 'OPMS', description: '관리번호나 출원번호를 쓰면 회사 OPMS 사건을 찾아 서지정보, 전자포대, 청구서를 봐요 (사내망에서만)', ready: true, defaultOn: true },
];

// 처음 캡슐 · 결과 묶음 순서 — 관리번호를 쓰면 OPMS 사건이 새 메모 바로 아래 (전에 늘 그랬듯)
export const DEFAULT_ORDER = ['memo', 'opms', 'notes', 'files', 'calc', 'web', 'ai'];

/**
 * 저장된 설정 → 쓸 수 있는 설정. 모르는 모듈은 버리고, 준비 중인 모듈은 늘 꺼 둔다.
 *   modules: 설정 창에서 켠 기능 (꺼 두면 매직키 창에 아예 나오지 않음)
 *   paused: 매직키 창 아래 캡슐로 잠깐 끈 기능 (설정에서 켠 것만, 다시 누르면 켜짐)
 *   engine: 웹 검색 기본 사이트, ai: AI 에게 묻기 기본 사이트 (Enter 로 열리는 것)
 *   order: 캡슐 · 결과 묶음 순서 (매직키 창에서 캡슐을 끌어 바꿈, 처음 보는 기능은 뒤에)
 * @param {any} raw
 * @returns {{ enabled: boolean, modules: Record<string, boolean>, paused: Record<string, boolean>, engine: string, ai: string, known: string[], order: string[] }}
 */
export function normalizeMagicSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const saved = src.modules && typeof src.modules === 'object' ? src.modules : {};
  const savedPaused = src.paused && typeof src.paused === 'object' ? src.paused : {};
  const modules = {};
  const paused = {};
  // known: 저장할 때 설정에 있던 기능. 예전 설정(known 없음)의 계산기는 "준비 중"이라 늘 false 로 저장됐으니 고른 값이 아니다
  const known = Array.isArray(src.known) ? src.known : MAGIC_MODULES.map((m) => m.id).filter((id) => id !== 'calc');
  for (const m of MAGIC_MODULES) {
    const chosen = typeof saved[m.id] === 'boolean' && known.includes(m.id);
    modules[m.id] = m.ready ? (chosen ? saved[m.id] : m.defaultOn) : false;
    if (modules[m.id] && savedPaused[m.id] === true) paused[m.id] = true;
  }
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : true, modules, paused,
    engine: pickId(WEB_ENGINES, src.engine), ai: pickId(AI_SITES, src.ai),
    known: MAGIC_MODULES.filter((m) => m.ready).map((m) => m.id),
    order: [...new Set([...(Array.isArray(src.order) ? src.order : []), ...DEFAULT_ORDER, ...MAGIC_MODULES.map((m) => m.id)])].filter((id) => MAGIC_MODULES.some((m) => m.id === id)),
  };
}

const inOrder = (s) => s.order.map((id) => MAGIC_MODULES.find((m) => m.id === id));

/** 캡슐을 끌어 놓은 순서 ids (보이는 캡슐만) — 안 보이는 기능은 그 뒤에 원래 순서대로 */
export function reorderMagicChips(settings, ids) {
  const s = normalizeMagicSettings(settings);
  return normalizeMagicSettings({ ...s, order: [...(Array.isArray(ids) ? ids : []), ...s.order] });
}

/** 매직키 창 아래 캡슐에 보일 기능: 설정에서 켠 것만 (켜짐 = 잠깐 끄지 않았음) */
export const magicChips = (settings) => {
  const s = normalizeMagicSettings(settings);
  return s.enabled ? inOrder(s).filter((m) => m.ready && s.modules[m.id]).map((m) => ({ ...m, on: !s.paused[m.id] })) : [];
};

/** 매직키 창에서 잠깐 끄고 켜기 — 설정에서 꺼 둔 기능은 그대로(켜지지 않음) */
export function toggleMagicChip(settings, id) {
  const s = normalizeMagicSettings(settings);
  if (!s.modules[id]) return s;
  const paused = { ...s.paused };
  if (paused[id]) delete paused[id];
  else paused[id] = true;
  return { ...s, paused };
}

// 지금 쓰는 모듈들: 설정에서 켜고, 매직키 창에서 잠깐 끄지 않은 것 (표시 순서대로)
export const activeModules = (settings) => {
  const s = normalizeMagicSettings(settings);
  return s.enabled ? inOrder(s).filter((m) => m.ready && s.modules[m.id] && !s.paused[m.id]) : [];
};

// 매직키 입력 → 메모 본문. 앞뒤 빈 줄은 빼고, 줄바꿈은 그대로 (첫 줄이 메모 제목이 된다)
export function memoBodyFromText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/^\s*\n+/, '').replace(/\s+$/, '');
}

// OPMS 로 찾아볼 만한 말인가: 관리번호·출원번호처럼 숫자가 든 4~40글자 한 줄 — 아무 글이나 회사 서버에 보내지 않게
export const looksLikeRef = (q) => {
  const s = String(q ?? '').trim();
  return s.length >= 4 && s.length <= 40 && /\d/.test(s) && !s.includes('\n');
};

/** 있는 메모 끝에 매직키 글을 덧붙인 본문 — 빈 줄 하나를 두고, 글의 줄바꿈은 그대로 (빈 글이면 null) */
export function appendToBody(body, text) {
  const add = memoBodyFromText(text);
  if (!add) return null;
  const base = String(body ?? '').replace(/\s+$/, '');
  return base ? `${base}\n\n${add}\n` : `${add}\n`;
}
