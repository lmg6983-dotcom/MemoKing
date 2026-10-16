// 공유 방법 고르기 — 내용 단추 › 공유(PC) 를 누르면 단추 옆에 작은 메뉴
//   방법: Windows 공유 · Google Drive 링크 · LocalSend · 메일에 첨부 (main 의 share:targets 가 지금 쓸 수 있는지 알려 줌)
//   지난번에 고른 방법이 맨 위. Esc · 바깥을 누르면 그만 (null)
const ICONS = {
  sheet: '<path d="M8 2v8M5 5l3-3 3 3"/><path d="M3 9v4h10V9"/>',
  drive: '<path d="M5.5 2.5h5l3.5 6-2.5 4.5h-7L2 8.5z"/><path d="M5.5 2.5 9 8.5h5M2 8.5h7l2.5 4.5"/>',
  localsend: '<circle cx="8" cy="8" r="1.6"/><path d="M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4.5 5.5-4.5"/>',
};
const LAST_KEY = 'memoking.shareVia';

let open = null; // { el, done }

function close(result = null) {
  if (!open) return;
  const { el, done, cleanup } = open;
  open = null;
  cleanup();
  el.remove();
  done(result);
}

/**
 * 공유 방법을 고른다 → 고른 id | null
 * @param {HTMLElement} anchor 메뉴를 붙일 단추 · @param {{ id: string, label: string, sub: string, ready: boolean }[]} targets
 */
export function chooseShare(anchor, targets) {
  close();
  let last = null;
  try {
    last = localStorage.getItem(LAST_KEY);
  } catch {
    // 기억 못 해도 괜찮음
  }
  const list = [...targets].sort((a, b) => (b.id === last) - (a.id === last));
  const el = document.createElement('div');
  el.className = 'mk-share-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', '공유 방법');
  const head = document.createElement('p');
  head.className = 'mk-share-head';
  head.textContent = '어떻게 보낼까요?';
  el.append(head);
  for (const t of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.dataset.via = t.id;
    b.disabled = !t.ready;
    b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[t.id] ?? ICONS.sheet}</svg><span><b></b><small></small></span>`;
    b.querySelector('b').textContent = t.label;
    b.querySelector('small').textContent = t.sub;
    b.addEventListener('click', () => {
      try {
        localStorage.setItem(LAST_KEY, t.id);
      } catch {
        // 기억 못 해도 괜찮음
      }
      close(t.id);
    });
    el.append(b);
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'mk-share-cancel';
  cancel.setAttribute('role', 'menuitem');
  cancel.textContent = '취소';
  cancel.addEventListener('click', () => close());
  el.append(cancel);
  document.body.append(el);
  // 단추 아래(자리가 없으면 위), 화면 밖으로 나가지 않게
  const r = anchor.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  const below = r.bottom + 6 + m.height <= window.innerHeight - 8;
  el.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8)))}px`;
  el.style.top = `${Math.round(below ? r.bottom + 6 : Math.max(8, r.top - m.height - 6))}px`;
  el.querySelector('button:not(:disabled)')?.focus();
  return new Promise((done) => {
    const onDown = (e) => !el.contains(e.target) && close();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...el.querySelectorAll('button:not(:disabled)')];
        const i = items.indexOf(document.activeElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0); // 지금 누른 공유 단추로 바로 닫히지 않게
    window.addEventListener('keydown', onKey, true);
    open = {
      el,
      done,
      cleanup: () => {
        document.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('keydown', onKey, true);
      },
    };
  });
}

/** 공유 결과 → 상태 줄 안내 */
export const SHARE_DONE = {
  shared: '공유 창을 열었어요',
  link: 'Google Drive 링크를 복사했어요. 메신저나 메일에 붙여 넣으세요',
  localsend: 'LocalSend 에 넘겼어요. 받을 기기를 골라 보내세요',
  'localsend-missing': 'LocalSend 가 없어 내려받기 페이지를 열었어요. 설치한 뒤 다시 눌러 주세요',
  mail: '새 메일에 첨부했어요',
  fallback: '공유 창을 열지 못해 탐색기에서 파일을 골라 두었어요. 마우스 오른쪽 › 공유',
};
