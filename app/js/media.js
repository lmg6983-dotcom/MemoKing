// 메모 폴더 안의 첨부 파일을 화면에 보여주기 위한 주소 변환.
// 파일에는 "attachments/a.png" 처럼 상대 경로로 저장하고, 화면에서만 memoking:// 주소로 바꾼다.
// (안드로이드는 window.memoking.vaultBase 로 자기 주소를 알려 준다)

export function vaultUrl(src) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src; // http:, data:, blob: 는 그대로
  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    // 이미 디코딩된 경로
  }
  const base = globalThis.memoking?.vaultBase ?? 'memoking://vault/';
  return `${base}${decoded.split('/').map(encodeURIComponent).join('/')}`;
}

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'image/svg+xml': 'svg', 'image/avif': 'avif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv', 'application/pdf': 'pdf', 'text/plain': 'txt',
};

// 넣으려는 파일의 종류: 이미지·소리·동영상은 화면에 바로 보이고/재생되며, 그 밖은 파일 칩(링크)이 된다.
export function mediaKind(file) {
  const type = file.type.split(';')[0];
  if (/^image\/(png|jpeg|gif|webp|bmp|svg\+xml|avif)$/.test(type)) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (/^video\/(mp4|webm|ogg|quicktime|x-m4v|x-matroska)$/.test(type)) return 'video';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name)) return 'image';
  if (/\.(weba|ogg|oga|opus|mp3|m4a|aac|wav|flac)$/i.test(file.name)) return 'audio';
  if (/\.(mp4|m4v|mov|ogv|mkv|webm)$/i.test(file.name)) return 'video';
  return 'file';
}

export function fileExtension(file) {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1];
  return (fromName ?? MIME_EXT[file.type.split(';')[0]] ?? 'bin').toLowerCase();
}

export function baseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}
