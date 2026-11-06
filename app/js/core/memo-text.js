// 다른 앱(MagicKey)이 넘긴 글 → 메모 본문 (순수 함수, 단위 테스트 대상) — 예전 매직키 창이 쓰던 것을 그대로 옮김

/** 넘긴 글 → 메모 본문. 앞뒤 빈 줄은 빼고, 줄바꿈은 그대로 (첫 줄이 메모 제목이 된다) */
export function memoBodyFromText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/^\s*\n+/, '').replace(/\s+$/, '');
}

/** 있는 메모 끝에 글을 덧붙인 본문 — 빈 줄 하나를 두고, 글의 줄바꿈은 그대로 (빈 글이면 null) */
export function appendToBody(body, text) {
  const add = memoBodyFromText(text);
  if (!add) return null;
  const base = String(body ?? '').replace(/\s+$/, '');
  return base ? `${base}\n\n${add}\n` : `${add}\n`;
}
