// 목록 카드 오른쪽 클릭 메뉴 (PC) — Windows 11 탐색기 메뉴처럼
//   맨 위 한 줄: 자주 쓰는 한 번에 끝나는 일 (잘라내기 · 글 복사 · 공유 · PDF 저장 · 휴지통 — 메모 창 안의 내용 메뉴와 같은 자리 · 같은 순서, 지우기는 붉게 맨 끝)
//   그 아래 글 항목: 열기 · 고정 · 색(점을 누르면 바로) · 잠그기 · 이전 버전 (휴대폰의 카드 꾹 누르기 메뉴와 같은 일들)
//   네이티브 메뉴는 아이콘 줄을 못 그려서 화면(HTML)에서 그린다 (ctx-menu.js)
import { openContextMenu } from './ctx-menu.js';
import { CUT_ICON, COPY_ICON, SHARE_ICON, SAVE_ICON, TRASH_ICON } from './content-icons.js';
import { chooseShare, showSharePop, SHARE_DONE } from './share-menu.js';
import { COLORS, COLOR_NAMES } from './core/memo-file.js';
import { dayText } from './memory-day.js';
import { moveLabel } from './core/modes.js';
import { UI } from './core/ui-text.js';

/** 메뉴의 모양 (창 없이도 확인할 수 있게 따로) */
/** @param {{ workLife?: boolean }} [o] workLife: Work / Life 를 나눠 쓸 때만 "Work로 옮기기" */
export function cardMenuSpec(memo, { workLife = true } = {}) {
  const locked = memo.locked === true;
  return {
    icons: [
      // 메모 창 ⋯ 메뉴와 같은 자리: 글 복사 · 공유 · PDF 가 앞, 지우는 일(잘라내기 · 휴지통)은 끝에
      { id: 'copy', icon: COPY_ICON, label: locked ? '글 복사 (잠긴 메모는 풀어야 해요)' : '글 복사', short: '복사', disabled: locked },
      { id: 'share', icon: SHARE_ICON, label: locked ? '공유 (잠긴 메모는 풀어야 해요)' : '공유', short: '공유', disabled: locked },
      { id: 'pdf', icon: SAVE_ICON, label: UI.saveAsPdf, short: 'PDF' },
      { id: 'cut', icon: CUT_ICON, label: locked ? '잘라내기 (잠긴 메모는 풀어야 해요)' : '잘라내기 (글을 복사하고 휴지통으로)', short: '잘라내기', disabled: locked },
      { id: 'trash', icon: TRASH_ICON, label: UI.toTrash, short: '삭제', danger: true },
    ],
    items: [
      { type: 'colors', label: '색', colors: COLORS.map((c) => ({ id: `color:${c}`, label: COLOR_NAMES[c] ?? c, color: c, checked: memo.color === c })) }, // 메모 창 메뉴처럼 아이콘 바로 아래
      { id: 'open', label: '열기', hint: 'Enter' },
      { type: 'separator' },
      { id: 'pin', label: UI.pin, checked: memo.pinned === true },
      { id: 'day', label: UI.memoryDay, hint: memo.day ? dayText(memo.day) : UI.madeDay },
      ...(workLife ? [{ id: 'mode', label: moveLabel(memo) }] : []),
      { id: 'folder', label: '폴더로 옮기기', hint: memo.folder || '폴더 없음' }, // 메모킹 폴더 (folder-ui.js)
      { type: 'separator' },
      locked ? { id: 'unlock', label: '잠금 풀기' } : { id: 'lock', label: '잠그기' },
      { id: 'versions', label: '이전 버전', disabled: locked },
    ],
  };
}

/**
 * @param {{ memo: object, at: { x: number, y: number }, api: object, run: { openSettings?(), open(id), pin(memo), color(memo, color), day?(memo), mode?(memo), trash(id), flash(text), setStatus?(text) } }} o
 */
export async function openCardMenu({ memo, at, api, run, workLife = true }) {
  const { icons, items } = cardMenuSpec(memo, { workLife });
  const id = await openContextMenu({ x: at.x, y: at.y, icons, items, label: '메모 메뉴' });
  if (!id) return null;
  if (id.startsWith('color:')) return run.color(memo, id.slice(6)), id;
  switch (id) {
    case 'open': run.open(memo.id); break;
    case 'pin': run.pin(memo); break;
    case 'day': await run.day?.(memo); break;
    case 'mode': await run.mode?.(memo); break;
    case 'folder': await run.folder?.(memo); break;
    case 'trash': run.trash(memo.id); break;
    case 'pdf': api.pdf.open(memo.id); break;
    case 'lock':
    case 'unlock':
    case 'versions': api.memo.cardCommand(memo.id, id); break;
    case 'cut':
      // 복사가 된 뒤에만 휴지통으로 (복사하지 못했으면 메모를 그대로 둔다) — 휴지통으로 가면 되돌리기 띠가 뜬다
      if (await api.memo.copyText(memo.id)) run.trash(memo.id);
      else run.flash(UI.cutCopyFail);
      break;
    case 'copy': run.flash((await api.memo.copyText(memo.id)) ? UI.textCopied : UI.copyFail); break;
    case 'share': await shareMemo(memo, at, api, run); break;
    default: break;
  }
  return id;
}

/** 메모 한 개를 공유: 방법 고르기 (Google Drive 링크 · LocalSend · 메일) → 글 파일로 보낸다 */
export async function shareMemo(memo, at, api, run) {
  try {
    const file = await api.memo.shareFile(memo.id);
    if (file?.error) return run.flash(file.error);
    const targets = await api.attachments.shareTargets();
    const rect = { left: at.x, right: at.x, top: at.y, bottom: at.y, width: 0, height: 0 };
    const via = await chooseShare({ getBoundingClientRect: () => rect }, targets);
    if (!via) return undefined;
    if (!targets.find((t) => t.id === via)?.ready) {
      // Google Drive 를 아직 연결하지 않았다 → 설정으로 (연결하면 링크로 공유할 수 있다)
      run.flash(UI.driveFirst);
      run.openSettings?.();
      return undefined;
    }
    if (via === 'drive') run.flash(UI.driveUploading);
    const r = await api.attachments.share({ ...file, via });
    if (r?.error) return run.flash(r.error);
    if (r?.missing) return run.flash(SHARE_DONE['localsend-missing']);
    if (via === 'drive') showSharePop({ title: UI.linkCopied, sub: UI.pasteHint });
    else run.flash(SHARE_DONE[{ localsend: 'localsend', mail: 'mail' }[via]]);
  } catch (err) {
    console.warn('card share', err);
    run.flash(UI.shareFail);
  }
  return undefined;
}
