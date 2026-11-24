// 메모에 넣은 파일의 종류 — 파일 칩 아이콘, 크기 표시, 누르면 바로 열어도 되는지 (순수 함수, 단위 테스트 대상)

// 누르면 곧바로 프로그램이 실행되는 파일. 메모 폴더는 다른 PC 와 동기화되므로 열기 전에 한 번 묻는다.
const PROGRAM_EXT = new Set([
  'exe', 'msi', 'msix', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'jar', 'application', 'appref-ms',
  'inf', 'sct', 'chm', 'gadget', 'ws', 'settingcontent-ms',
  // 문제 해결사 · Excel 추가 기능 · 라이브러리 · 검색 바로가기 · 설치 패치 · Office 추가 기능 — 열면 코드가 돈다
  'diagcab', 'xll', 'library-ms', 'search-ms', 'msp', 'mst', 'vsto',
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
  // 끝의 점 · 빈칸은 뗀다 — Windows 는 "a.exe." 를 a.exe 로 연다 (그대로 보면 확장자가 없어 실행 경고를 건너뛰었다)
  const base = String(name ?? '').split(/[\\/]/).pop().split(/[?#]/)[0].replace(/[. ]+$/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// 메모에 넣으면 PDF 첫 쪽 썸네일과 짝이 되는 문서 (doc-pages.js 가 그린다)
export const DOC_EXTS = ['pdf', 'docx', 'pptx', 'hwp', 'hwpx', 'txt'];
// PC 의 Office 로만 PDF 가 되는 문서 (attachment:to-pdf) — 직접 그리지 못해 Office 가 있는 PC 에서만 짝을 짓는다 (휴대폰은 칩만)
export const OFFICE_ONLY_EXTS = ['doc', 'ppt', 'xls', 'xlsx'];
const officePdf = () => Boolean(globalThis.memoking?.attachments?.toPdf);
export const isDocumentFile = (file) => {
  const ext = extOf(file?.name);
  return DOC_EXTS.includes(ext) || (OFFICE_ONLY_EXTS.includes(ext) && officePdf());
};

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
