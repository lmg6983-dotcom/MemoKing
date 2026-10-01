// 메모에 넣은 파일의 종류 — 파일 칩 아이콘, 크기 표시, 누르면 바로 열어도 되는지 (순수 함수, 단위 테스트 대상)

// 누르면 곧바로 프로그램이 실행되는 파일. 메모 폴더는 다른 PC 와 동기화되므로 열기 전에 한 번 묻는다.
const PROGRAM_EXT = new Set([
  'exe', 'msi', 'msix', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'jar', 'application', 'appref-ms',
  'inf', 'sct', 'chm', 'gadget', 'ws', 'settingcontent-ms',
]);

const KINDS = [
  ['pdf', ['pdf']],
  ['doc', ['doc', 'docx', 'hwp', 'hwpx', 'odt', 'rtf', 'txt', 'md', 'pages']],
  ['sheet', ['xls', 'xlsx', 'xlsm', 'csv', 'ods', 'numbers', 'cell']],
  ['slide', ['ppt', 'pptx', 'odp', 'key', 'show']],
  ['archive', ['zip', '7z', 'rar', 'alz', 'egg', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso']],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'ico', 'tif', 'tiff', 'psd', 'ai']],
  ['audio', ['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'opus', 'wma']],
  ['video', ['mp4', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'm4v']],
  ['code', ['json', 'xml', 'html', 'htm', 'css', 'py', 'ts', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'sql', 'yaml', 'yml', 'sh']],
];

export function extOf(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().split(/[?#]/)[0];
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isProgramFile(name) {
  return PROGRAM_EXT.has(extOf(name));
}

// 'pdf' | 'doc' | 'sheet' | 'slide' | 'archive' | 'image' | 'audio' | 'video' | 'code' | 'program' | 'file'
export function fileKind(name) {
  const ext = extOf(name);
  if (PROGRAM_EXT.has(ext)) return 'program';
  for (const [kind, exts] of KINDS) if (exts.includes(ext)) return kind;
  return 'file';
}

// 1234 → "1.2KB", 5_300_000 → "5.1MB"
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${units[i]}`;
}
