// 목록 카드 오른쪽 클릭 메뉴 (PC) — Windows 11 탐색기 메뉴처럼
//   맨 위 한 줄: 자주 쓰는 한 번에 끝나는 일 (글 복사 · 공유 · PDF 저장 · 휴지통 — 메모 창 안의 내용 메뉴와 같은 자리 · 같은 순서, 지우기는 붉게 맨 끝)
//   그 아래 글 항목: 열기 · 고정 · 색(점을 누르면 바로) · 잠그기 · 이전 버전 (휴대폰의 카드 꾹 누르기 메뉴와 같은 일들)
//   네이티브 메뉴는 아이콘 줄을 못 그려서 화면(HTML)에서 그린다 (ctx-menu.js)
import { openContextMenu } from './ctx-menu.js';
import { COPY_ICON, SHARE_ICON, SAVE_ICON, TRASH_ICON } from './content-icons.js';
import { chooseShare, showSharePop, SHARE_DONE } from './share-menu.js';
import { COLORS } from './core/memo-file.js';

export const COLOR_LABEL = { yellow: '노랑', green: '초록', pink: '분홍', purple: '보라', blue: '파랑', gray: '회색', charcoal: '검정' };

/** 메뉴의 모양 (창 없이도 확인할 수 있게 따로) */
export function cardMenuSpec(memo) {
  const locked = memo.locked === true;
  return {
    icons: [
      { id: 'copy', icon: COPY_ICON, label: locked ? '글 복사 (잠긴 메모는 풀어야 해요)' : '글 복사', disabled: locked },
      { id: 'share', icon: SHARE_ICON, label: locked ? '공유 (잠긴 메모는 풀어야 해요)' : '공유…', disabled: locked },
      { id: 'pdf', icon: SAVE_ICON, label: 'PDF로 저장…' },
      { id: 'trash', icon: TRASH_ICON, label: '휴지통으로 옮기기 (Delete)', danger: true },
    ],
    items: [
      { id: 'open', label: '열기', hint: 'Enter' },
      { type: 'separator' },
      { id: 'pin', label: '목록 맨 위에 고정', checked: memo.pinned === true },
      { type: 'colors', label: '색', colors: COLORS.map((c) => ({ id: `color:${c}`, label: COLOR_LABEL[c] ?? c, color: c, checked: memo.color === c })) },
      { type: 'separator' },
      locked ? { id: 'unlock', label: '잠금 풀기…' } : { id: 'lock', label: '잠그기…' },
      { id: 'versions', label: '이전 버전…', disabled: locked },
    ],
  };
}

/**
 * @param {{ memo: object, at: { x: number, y: number }, api: object, run: { open(id), pin(memo), color(memo, color), trash(id), flash(text), setStatus?(text) } }} o
 */
export async function openCardMenu({ memo, at, api, run }) {
  const { icons, items } = cardMenuSpec(memo);
  const id = await openContextMenu({ x: at.x, y: at.y, icons, items, label: '메모 메뉴' });
  if (!id) return null;
  if (id.startsWith('color:')) return run.color(memo, id.slice(6)), id;
  switch (id) {
    case 'open': run.open(memo.id); break;
    case 'pin': run.pin(memo); break;
    case 'trash': run.trash(memo.id); break;
    case 'pdf': api.pdf.open(memo.id); break;
    case 'lock':
    case 'unlock':
    case 'versions': api.memo.cardCommand(memo.id, id); break;
    case 'copy': run.flash((await api.memo.copyText(memo.id)) ? '글을 복사했어요' : '복사하지 못했어요'); break;
    case 'share': await shareMemo(memo, at, api, run); break;
    default: break;
  }
  return id;
}

/** 메모 한 개를 공유: 방법 고르기 (Google Drive 링크 · LocalSend · 메일) → 글 파일로 보낸다 */
async function shareMemo(memo, at, api, run) {
  try {
    const file = await api.memo.shareFile(memo.id);
    if (file?.error) return run.flash(file.error);
    const targets = await api.attachments.shareTargets();
    const rect = { left: at.x, right: at.x, top: at.y, bottom: at.y, width: 0, height: 0 };
    const via = await chooseShare({ getBoundingClientRect: () => rect }, targets);
    if (!via) return undefined;
    if (via === 'drive') run.flash('Google Drive 에 올리는 중…');
    const r = await api.attachments.share({ ...file, via });
    if (r?.error) return run.flash(r.error);
    if (r?.missing) return run.flash(SHARE_DONE['localsend-missing']);
    if (via === 'drive') showSharePop({ title: '링크를 복사했어요', sub: '메신저나 메일에 Ctrl+V 로 붙여 넣으세요' });
    else run.flash(SHARE_DONE[{ localsend: 'localsend', mail: 'mail' }[via]]);
  } catch (err) {
    console.warn('card share', err);
    run.flash('공유하지 못했어요');
  }
  return undefined;
}
