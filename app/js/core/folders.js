// 메모 폴더 (PC · 휴대폰 같은 규칙) — 메모 폴더 안의 맨 위 하위 폴더 하나가 메모킹 폴더 하나
//   메모 파일이 "업무/회의.md" 면 그 메모의 폴더는 "업무", 맨 위에 있으면 "" (폴더 없음).
//   더 깊은 폴더("업무/2026/회의.md")의 메모도 맨 위 폴더("업무")로 센다 (메모킹은 한 단계만 보여 준다).
//   첨부는 폴더와 상관없이 늘 맨 위 attachments/ 에 두고 본문에도 "attachments/..." 로 적는다 (옮겨도 고칠 것이 없게).

import { parseMemoFile, serializeMemoFile } from './memo-file.js';

// 메모킹이 쓰는 폴더 — 메모 폴더로 보이지 않게
const RESERVED = new Set(['_memoking', 'attachments']);
// Windows · 안드로이드 파일 이름에 못 쓰는 글자와 줄바꿈 같은 보이지 않는 글자
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
export const MAX_FOLDER_NAME = 40;

/** 메모 파일(메모 폴더 기준 경로) → 그 메모의 폴더 이름 ("" = 폴더 없음) */
export const folderOf = (file) => {
  const f = String(file ?? '');
  const i = f.indexOf('/');
  return i > 0 ? f.slice(0, i) : '';
};

/** 쓴 폴더 이름 → 파일 이름으로 쓸 수 있는 이름, 못 쓰면 "" */
export function cleanFolderName(raw) {
  const name = String(raw ?? '').replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME)
    .replace(/[\uD800-\uDBFF]$/, '') // 그림 글자(😀)를 반만 자르지 않게 — Rust slice16 과 같게
    .replace(/[.\s]+$/, '');
  if (!name || name.startsWith('.') || name.startsWith('~$') || RESERVED.has(name.toLowerCase())) return '';
  // Windows 가 장치 이름으로 쓰는 이름 (CON, NUL, COM1 …)
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return '';
  return name;
}

/** 폴더 목록의 "미분류" (어느 폴더에도 넣지 않은 메모) — 폴더 이름으로 쓸 수 없는 글자라 진짜 폴더와 겹치지 않는다 */
export const UNFILED = ':unfiled';
export const UNFILED_LABEL = '미분류';

/** 고른 폴더(이름 · "" 전체 · UNFILED)의 메모만 */
export const memosInFolder = (memos, folder) => (!folder ? memos : folder === UNFILED ? memos.filter((m) => !m.folder) : memos.filter((m) => m.folder === folder));

/** 폴더 목록 앞에 "미분류" 를 더한다 — 폴더가 하나라도 있을 때만 (없으면 모든 메모가 미분류라 전체와 같다) */
export const withUnfiled = (list, memos) => (list.length ? [{ name: UNFILED, label: UNFILED_LABEL, count: (memos ?? []).filter((m) => !m.folder).length }, ...list] : list);

/** 메모 폴더 맨 위의 하위 폴더 이름 중 메모킹 폴더로 보일 것 */
export const isFolderName = (name) => Boolean(name) && cleanFolderName(name) === name;

/**
 * 폴더 목록 [{ name, count, pinned? }] (상단 고정한 폴더가 먼저 — 나중에 고정한 것이 위, 나머지는 이름순) — 디스크의 폴더 + 메모가 든 폴더, count 는 넘긴 메모(지금 모드) 중 그 폴더의 수
 * @param {string[]} dirs 디스크의 맨 위 하위 폴더 이름
 * @param {{ folder?: string }[]} memos
 * @param {string[]} [pinned] 상단 고정한 폴더 (고정한 차례대로)
 */
export function folderList(dirs, memos, pinned = []) {
  const counts = new Map();
  for (const d of dirs ?? []) if (isFolderName(d)) counts.set(d, 0);
  for (const m of memos ?? []) if (m.folder) counts.set(m.folder, (counts.get(m.folder) ?? 0) + 1);
  const order = new Map((pinned ?? []).map((n, i) => [n, i])); // 파일에는 고정한 차례대로 (뒤가 나중)
  const rank = (f) => order.get(f.name) ?? -1;
  return [...counts]
    .map(([name, count]) => (order.has(name) ? { name, count, pinned: true } : { name, count }))
    .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'ko'));
}

// 상단 고정한 폴더 (_memoking/pinned-folders.json — 기기끼리 함께. desktop-rs/core/src/vault.rs 와 같음)
//   지운 폴더의 이름은 남겨 둔다: 지우기를 되돌려 다시 만들면 그대로 고정 (목록에는 있는 폴더만 나온다)
export const PINNED_FOLDERS_FILE = '_memoking/pinned-folders.json';

/** 파일 글 → 고정한 폴더 이름들 (망가졌으면 없음) */
export function parsePinned(text) {
  try {
    const v = JSON.parse(text ?? '[]');
    return Array.isArray(v) ? [...new Set(v.filter(isFolderName))].slice(0, 200) : [];
  } catch {
    return [];
  }
}

/** 고정 · 풀기 → 새 목록 */
export const pinFolder = (list, name, on) => (on ? [...list.filter((n) => n !== name), name] : list.filter((n) => n !== name));

/** 폴더 이름을 바꾸면 고정도 새 이름으로 */
export const renamePinned = (list, from, to) => (list.includes(from) ? pinFolder(pinFolder(list, from, false), to, true) : list);

const time = (v) => Date.parse(v ?? '') || 0;

/**
 * 휴지통으로 보내는 같은 id 의 남은 파일: id 를 지운 글로 — 되살리면 새 id 를 받은 따로인 메모(사본)가 된다
 *   (id 가 그대로면 되살리자마자 다시 "같은 id 의 두 파일" 로 보여 휴지통으로 돌아갔다)
 */
export function withoutId(text) {
  const { meta, body } = parseMemoFile(String(text ?? ''));
  return serializeMemoFile({ ...meta, id: undefined }, body);
}

/** 옮긴 뒤 안내: "업무 폴더로 옮겼어요" · "메모 3개를 폴더에서 뺐어요" */
export function movedText(moved, to) {
  const many = moved > 1 ? `메모 ${moved}개를 ` : '';
  return to ? `${many}${to} 폴더로 옮겼어요` : `${many}폴더에서 뺐어요`;
}

/**
 * 같은 id 의 메모 파일이 둘 — 한 기기에서 폴더를 옮긴 사이 다른 기기가 옛 자리의 메모를 고쳐 동기화가 되살린 경우.
 *   옮긴 메모는 머리말에 moved(옮긴 때)를 남기므로: 자리는 더 나중에 옮긴 쪽, 내용은 더 나중에 고친(updated) 쪽.
 *   남는 파일 하나만 두고 다른 하나는 휴지통으로 (지우지 않는다 — 혹시 몰라 되살릴 수 있게).
 *   옮긴 기록이 없거나 같으면(사용자가 탐색기에서 복사한 파일) null → 예전처럼 사본으로 둔다.
 * @param {{ file: string, meta: { updated?: string, extra?: { moved?: string } } }} a
 * @param {{ file: string, meta: { updated?: string, extra?: { moved?: string } } }} b
 * @returns {{ target: string, source: string, drop: string } | null} target: 남길 자리, source: 남길 내용이 든 파일, drop: 휴지통으로
 */
export function resolveMovedTwin(a, b) {
  const ma = time(a.meta?.extra?.moved);
  const mb = time(b.meta?.extra?.moved);
  if (ma === mb || a.file === b.file) return null;
  const [place, other] = ma > mb ? [a, b] : [b, a];
  const source = time(other.meta?.updated) > time(place.meta?.updated) ? other : place;
  return { target: place.file, source: source.file, drop: other.file };
}
