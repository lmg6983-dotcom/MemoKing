// 붙여넣은 인터넷 사진을 메모 폴더에 받아 두기 위한 순수 함수 (Node·브라우저 공용, 단위 테스트 대상)

export const MAX_REMOTE_IMAGE_BYTES = 50 * 1024 * 1024;

export const isHttpUrl = (src) => /^https?:\/\//i.test(String(src ?? ''));
export const isDataImage = (src) => /^data:image\/[a-z0-9.+-]+(;[^,]*)?,/i.test(String(src ?? ''));
// 붙여넣기 뒤 메모 폴더로 받아 와야 하는 사진 주소
export const needsLocalCopy = (src) => isHttpUrl(src) || isDataImage(src);

const TYPE_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
  'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
};

export function imageExtFromType(type) {
  return TYPE_EXT[String(type ?? '').split(';')[0].trim().toLowerCase()] ?? null;
}

// 서버가 형식을 안 알려 줄 때 주소 끝의 확장자로 짐작
export function imageExtFromUrl(url) {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const ext = /\.([a-z0-9]{2,5})$/i.exec(pathname)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (ext === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'].includes(ext) ? ext : null;
}

// data:image/png;base64,... → { type, ext, bytes }
export function decodeDataImage(uri) {
  const m = /^data:(image\/[a-z0-9.+-]+)((?:;[^,;]*)*?)(;base64)?,(.*)$/is.exec(String(uri ?? ''));
  if (!m) return null;
  const [, type, , base64, payload] = m;
  const ext = imageExtFromType(type);
  if (!ext) return null;
  let bytes;
  if (base64) {
    const bin = atob(payload.replace(/\s+/g, ''));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return { type: type.toLowerCase(), ext, bytes };
}

// "a.jpg 480w, b.jpg 1080w" / "a.jpg 1x, b.jpg 2x" → 가장 큰 사진 주소
export function largestFromSrcset(srcset) {
  let best = null;
  let bestScore = -1;
  for (const part of String(srcset ?? '').split(/,\s+(?=\S)/)) {
    const [url, descriptor = '1x'] = part.trim().split(/\s+/);
    if (!url) continue;
    const n = parseFloat(descriptor);
    const score = /w$/i.test(descriptor) ? n : /x$/i.test(descriptor) ? n * 1000 : 0;
    if (score > bestScore) {
      best = url;
      bestScore = score;
    }
  }
  return best;
}

// 아주 작은 자리표시 그림(지연 로딩용 1×1 gif 등)인지
const isPlaceholder = (src) => !src || src === 'about:blank' || (isDataImage(src) && src.length < 400);

/**
 * 웹페이지 <img> 의 속성에서 실제 사진 주소를 고른다. 지연 로딩 사진은 진짜 주소가 data-src·srcset 에 있다.
 * @param {Record<string, string|null|undefined>} attrs  src, srcset, data-src, data-original, data-lazy-src, data-srcset
 */
export function pickImageSource(attrs) {
  const src = attrs.src ?? '';
  if (!isPlaceholder(src)) return src;
  const candidates = [
    attrs['data-src'], attrs['data-original'], attrs['data-lazy-src'], attrs['data-url'],
    largestFromSrcset(attrs['data-srcset']), largestFromSrcset(attrs.srcset),
  ];
  return candidates.find((c) => c && !isPlaceholder(c)) ?? src;
}
