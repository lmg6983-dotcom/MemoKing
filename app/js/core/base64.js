// 바이트 · 글 → base64 (한글 그대로, 큰 것도 스택이 넘치지 않게 나눠서) — 내용 저장 · 잠금 메모 · 캘린더 내보내기가 함께
export function bytesBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const textBase64 = (text) => bytesBase64(new TextEncoder().encode(text));
