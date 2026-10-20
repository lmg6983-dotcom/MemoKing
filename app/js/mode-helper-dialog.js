// 정리 도우미 창 — Life 메모 중 일 이야기 같은 것을 보여 주고, 고른 것만 Work로 옮긴다 (PC 목록 · 휴대폰 같이 씀)
//   권하는 규칙은 core/mode-helper.js. 점수가 높은 것(태그 · 제목에 일 낱말)은 미리 골라 둔다.
import { suggestWork } from './core/mode-helper.js';
import { icon } from './icons.js';

function el(tag, className = '', text = '') {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/**
 * @param {{ memos: object[], move: (ids: string[]) => Promise<number> | number }} o move: 옮긴 수를 돌려준다
 * @returns {Promise<number>} 옮긴 수 (그만두면 0)
 */
export function openModeHelper({ memos, move }) {
  return new Promise((resolve) => {
    const found = suggestWork(memos);
    const picked = new Set(found.filter((f) => f.score >= 3).map((f) => f.memo.id));

    const dialog = el('dialog', 'dialog mode-helper');
    dialog.setAttribute('aria-labelledby', 'mh-h');
    const head = el('div', 'dialog-head');
    const h = el('h2', '', '정리 도우미');
    h.id = 'mh-h';
    const x = el('button', 'icon-btn dialog-x');
    x.type = 'button';
    x.setAttribute('aria-label', '닫기');
    x.append(icon('close'));
    head.append(h, x);
    const lead = el('p', 'mh-lead', found.length
      ? `Life 메모 중에 일 이야기 같은 메모 ${found.length}개를 찾았어요.\nWork로 옮길 메모를 고르세요. 나중에 메모 메뉴에서 언제든 되돌릴 수 있어요.`
      : 'Work로 옮길 만한 메모를 찾지 못했어요.\n일할 때 쓰는 메모는 메모 메뉴의 "Work로 옮기기"로 하나씩 옮길 수 있어요.');

    const list = el('div', 'mh-list');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Work로 옮길 메모');
    for (const f of found) {
      const row = el('label', 'mh-row');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = picked.has(f.memo.id);
      box.addEventListener('change', () => {
        if (box.checked) picked.add(f.memo.id);
        else picked.delete(f.memo.id);
        sync();
      });
      const dot = el('span', 'mh-dot');
      dot.dataset.color = f.memo.color ?? 'yellow';
      const words = el('span', 'mh-words');
      words.append(el('b', 'mh-title', f.memo.title || '제목 없음'), el('small', 'mh-why', f.reasons.join(', ')));
      row.append(box, dot, words);
      list.append(row);
    }

    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'btn', found.length ? '취소' : '닫기');
    cancel.type = 'button';
    const ok = el('button', 'btn primary');
    ok.type = 'button';
    if (found.length) actions.append(cancel, ok);
    else actions.append(cancel);
    dialog.append(head, lead, ...(found.length ? [list] : []), actions);

    function sync() {
      ok.textContent = picked.size ? `Work로 옮기기 (${picked.size})` : 'Work로 옮기기';
      ok.disabled = !picked.size;
    }

    let done = false;
    const finish = (n) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(n);
    };
    x.addEventListener('click', () => finish(0));
    cancel.addEventListener('click', () => finish(0));
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      const n = await move([...picked]);
      finish(n);
    });
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(0);
    });
    dialog.addEventListener('close', () => finish(0));
    sync();
    document.body.append(dialog);
    dialog.showModal();
    (found.length ? ok : cancel).focus();
  });
}
