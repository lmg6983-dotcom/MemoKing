// 매직키 (Ctrl+Alt+Space) — 어디서든 빠르게 입력하는 창. 여러 기능 모듈로 이루어지고, 설정에서 모듈마다 끄고 켠다.
// (순수 함수, 단위 테스트 대상) 모듈을 더할 때는 여기에 한 줄 + magic.js 의 처리기(HANDLERS)에 한 개.

// ready: 지금 쓸 수 있는가 (false = 준비 중, 설정에서 켤 수 없음)
export const MAGIC_MODULES = [
  { id: 'memo', name: '메모 만들기', description: '입력한 글을 새 메모로 바로 저장해요 (Enter 저장, Ctrl+Enter 저장하고 열기)', ready: true, defaultOn: true },
  { id: 'notes', name: '메모 검색', description: '입력하는 대로 메모의 제목과 내용에서 찾아 바로 열어요', ready: true, defaultOn: true },
  { id: 'files', name: '파일 검색', description: 'PC 의 파일, 폴더, 프로그램 이름을 바로 찾아 열어요. 따로 설치할 것 없이 메모킹이 이름 목록을 만들어 두어요 (이 PC 안에서만, 내용은 읽지 않음)', ready: true, defaultOn: true },
  { id: 'calc', name: '계산기', description: '수식을 입력하면 바로 계산해요', ready: false, defaultOn: false },
  { id: 'opms', name: 'OPMS 검색', description: '관리번호나 출원번호를 쓰면 회사 OPMS 사건을 찾아 서지정보, 전자포대, 청구서를 봐요 (사내망에서만)', ready: true, defaultOn: true },
];

/**
 * 저장된 설정 → 쓸 수 있는 설정. 모르는 모듈은 버리고, 준비 중인 모듈은 늘 꺼 둔다.
 *   modules: 설정 창에서 켠 기능 (꺼 두면 매직키 창에 아예 나오지 않음)
 *   paused: 매직키 창 아래 캡슐로 잠깐 끈 기능 (설정에서 켠 것만, 다시 누르면 켜짐)
 * @param {any} raw
 * @returns {{ enabled: boolean, modules: Record<string, boolean>, paused: Record<string, boolean> }}
 */
export function normalizeMagicSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const saved = src.modules && typeof src.modules === 'object' ? src.modules : {};
  const savedPaused = src.paused && typeof src.paused === 'object' ? src.paused : {};
  const modules = {};
  const paused = {};
  for (const m of MAGIC_MODULES) {
    modules[m.id] = m.ready ? (typeof saved[m.id] === 'boolean' ? saved[m.id] : m.defaultOn) : false;
    if (modules[m.id] && savedPaused[m.id] === true) paused[m.id] = true;
  }
  return { enabled: typeof src.enabled === 'boolean' ? src.enabled : true, modules, paused };
}

/** 매직키 창 아래 캡슐에 보일 기능: 설정에서 켠 것만 (켜짐 = 잠깐 끄지 않았음) */
export const magicChips = (settings) => {
  const s = normalizeMagicSettings(settings);
  return s.enabled ? MAGIC_MODULES.filter((m) => m.ready && s.modules[m.id]).map((m) => ({ ...m, on: !s.paused[m.id] })) : [];
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
  return s.enabled ? MAGIC_MODULES.filter((m) => m.ready && s.modules[m.id] && !s.paused[m.id]) : [];
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
