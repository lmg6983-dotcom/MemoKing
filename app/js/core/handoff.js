// 이어 쓰기 — 다른 기기(휴대폰·PC·AI 비서)에서 방금 고친 메모가 들어오면 "휴대폰에서 방금 고친 메모: 장보기 · 열기" 로 알린다.
//   메모 머리말의 device(마지막으로 내용을 고친 곳)와 updated 로 판단 (순수 함수, 단위 테스트 대상)
export const HANDOFF_MS = 15 * 60_000; // 이보다 오래전에 고친 것은 "방금" 이 아니다
export const DEVICE_NAMES = { pc: 'PC', phone: '휴대폰', ai: 'AI 비서' };

/**
 * 알릴 메모인지: 다른 곳에서, 최근에 고쳤고, 같은 고침을 이미 알리지 않았으면 그 곳 이름
 * @param {{ id: string, device?: string|null, updated?: string|null }} memo
 * @param {{ mine: 'pc'|'phone', now?: number, seen?: Set<string> }} o seen: 이미 알린 "id@updated" (여기서 더한다)
 */
export function handoffFrom(memo, { mine, now = Date.now(), seen = null }) {
  if (!memo?.device || memo.device === mine || !DEVICE_NAMES[memo.device]) return null;
  const at = Date.parse(memo.updated ?? '');
  if (!Number.isFinite(at) || now - at > HANDOFF_MS || at - now > 5 * 60_000) return null;
  const key = `${memo.id}@${memo.updated}`;
  if (seen?.has(key)) return null;
  seen?.add(key);
  return DEVICE_NAMES[memo.device];
}

/**
 * 이어 쓰기 안내를 띄울 메모 하나 (PC·휴대폰 같은 규칙): 지금 이 기기에서 열어 둔 메모는 화면이 새 내용을 보여 주므로
 * 본 것으로만 치고(창을 닫은 뒤 뒤늦게 뜨지 않게), 나머지 중 처음으로 알릴 만한 것
 * @param {object[]} memos 바뀐 메모들 (앞에서부터)
 * @returns {{ memo: object, from: string } | null}
 */
export function pickHandoff(memos, { mine, seen, isOpen = () => false, now = Date.now() }) {
  for (const memo of memos) {
    if (!memo?.file) continue;
    if (isOpen(memo.id)) {
      handoffFrom(memo, { mine, now, seen });
      continue;
    }
    const from = handoffFrom(memo, { mine, now, seen });
    if (from) return { memo, from };
  }
  return null;
}

/** 앱을 켤 때 살펴볼 메모: 가장 최근에 고친 5개 */
export const recentlyUpdated = (list, n = 5) => [...list].sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0)).slice(0, n);

export const handoffText = (deviceName, title) => `${deviceName}에서 방금 고친 메모: ${title}`;
