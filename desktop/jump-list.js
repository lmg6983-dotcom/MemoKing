// Windows 작업 표시줄 아이콘을 오른쪽 클릭했을 때의 목록 (점프 목록)
//   "작업": 메모 목록 열기 · 새 메모 / "최근에 연 메모": 최근에 연 메모들 (누르면 그 메모가 뜬다)
//   목록의 항목은 메모킹을 인자와 함께 다시 실행하는 것 — 이미 켜져 있으면 second-instance 로 그 인자가 전해진다
import { UI } from '../app/js/core/ui-text.js';

//   newMemoFile: MagicKey(따로 설치하는 매직키 앱)가 쓴 글로 새 메모 — 글은 임시 폴더의 magickey-*.txt 로 (명령줄 길이 · 따옴표 걱정 없게)
//     openNew 를 더하면 만든 메모를 열고, remind 를 더하면 첫 줄의 날짜로 알림도 맞춘다
export const LAUNCH = { list: '--open-list', newMemo: '--new-memo', memo: '--open-memo=', newMemoFile: '--new-memo-file=', openNew: '--open-new', remind: '--remind' };
const MAGICKEY_FILE = /^magickey-[\w-]{1,64}\.txt$/i;
const MAX_RECENT = 8;
const MAX_TITLE = 40;

const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const shortTitle = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim() || '제목 없음';
  return s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1)}…` : s;
};

/**
 * @param {{ id: string, title: string }[]} recent 최근에 연 순서
 * @param {{ program: string, prefix?: string[] }} o prefix: 개발 실행이면 [앱 폴더] (electron.exe <앱> <인자>)
 */
export function jumpListCategories(recent, { program, prefix = [] }) {
  const args = (...a) => [...prefix, ...a].map(quote).join(' ');
  const task = (title, description, arg) => ({ type: 'task', title, description, program, args: args(arg), iconPath: program, iconIndex: 0 });
  const categories = [{
    type: 'tasks',
    items: [
      task(UI.openList, '메모킹 메모 목록 창을 엽니다', LAUNCH.list),
      task('새 메모', '빈 메모를 새로 만듭니다', LAUNCH.newMemo),
    ],
  }];
  const items = recent.slice(0, MAX_RECENT).map((m) => task(shortTitle(m.title), shortTitle(m.title), `${LAUNCH.memo}${m.id}`));
  if (items.length) categories.push({ type: 'custom', name: '최근에 연 메모', items });
  return categories;
}

/** 실행 인자 → 할 일 (없으면 null) */
export function launchAction(argv = []) {
  const memo = argv.find((a) => typeof a === 'string' && a.startsWith(LAUNCH.memo))?.slice(LAUNCH.memo.length);
  if (memo && /^[\w-]{1,80}$/.test(memo)) return { kind: 'memo', id: memo };
  const file = argv.find((a) => typeof a === 'string' && a.startsWith(LAUNCH.newMemoFile))?.slice(LAUNCH.newMemoFile.length);
  if (file && MAGICKEY_FILE.test(file.split(/[\\/]/).pop())) return { kind: 'newFile', file, open: argv.includes(LAUNCH.openNew), remind: argv.includes(LAUNCH.remind) };
  if (argv.includes(LAUNCH.newMemo)) return { kind: 'new' };
  if (argv.includes(LAUNCH.list)) return { kind: 'list' };
  return null;
}

/** 최근에 연 메모 목록에 맨 앞으로 (중복 없이, 개수 제한) */
export function pushRecent(list, id, max = 20) {
  return [id, ...(list ?? []).filter((x) => x !== id)].slice(0, max);
}
