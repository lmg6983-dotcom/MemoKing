// 매직키 · 전체 결과 창이 함께 쓰는 줄마다 할 일 (PowerToys Run 처럼) — 고른 줄 오른쪽에 단추로 늘어선다
//   ← → 로 단추를 옮겨 다니고(글 끝에서 → 를 누르면 첫 단추 다음으로) Enter 로 실행, 단추를 눌러도 된다
//   Ctrl+Shift+C 경로 복사 · Ctrl+Shift+E 폴더 열기 (PowerToys Run 과 같은 단축키)

const ICONS = {
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  copyPath: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  reveal: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  copyFile: 'M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M5 8h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
  copyText: 'M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M7 12h6M7 16h4M5 8h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
  save: 'M5 12l5 5L20 7',
  saveOpen: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  more: 'M4 6h16M4 12h16M4 18h10',
  wrapper: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  copyOur: 'M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M5 8h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
  copyApp: 'M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M7 12h6M7 16h4M5 8h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
};

/** 이 줄에서 할 수 있는 일 (첫 번째가 Enter) */
export function actionsFor(r) {
  switch (r?.kind) {
    case 'new':
      return [{ id: 'save', label: '저장' }, { id: 'saveOpen', label: '저장하고 열기' }];
    case 'note':
      return [{ id: 'open', label: '열기' }, { id: 'copyText', label: '내용 복사' }];
    case 'folder':
      return [{ id: 'open', label: '열기' }, { id: 'copyPath', label: '경로 복사', key: 'Ctrl+Shift+C' }, { id: 'reveal', label: '위 폴더에서 보기', key: 'Ctrl+Shift+E' }, { id: 'copyFile', label: '폴더 복사' }];
    case 'file':
      return [{ id: 'open', label: r.app ? '실행' : '열기' }, { id: 'copyPath', label: '경로 복사', key: 'Ctrl+Shift+C' }, { id: 'reveal', label: '폴더 열기', key: 'Ctrl+Shift+E' }, { id: 'copyFile', label: '파일 복사' }];
    case 'more':
      return [{ id: 'more', label: '모두 보기' }];
    case 'opms':
      return [{ id: 'open', label: '사건 보기' }, { id: 'wrapper', label: '전자포대' }, { id: 'copyOur', label: '관리번호 복사' }, { id: 'copyApp', label: '출원번호 복사' }];
    default:
      return [];
  }
}

function icon(id) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[id] ?? ICONS.open);
  s.append(p);
  return s;
}

/**
 * 고른 줄의 단추들
 * @param {object} r 줄
 * @param {number} active 지금 고른 단추
 * @param {(i: number) => void} onRun 단추를 눌렀을 때
 */
export function actionButtons(r, active, onRun) {
  const wrap = document.createElement('span');
  wrap.className = 'acts';
  wrap.setAttribute('role', 'toolbar');
  wrap.setAttribute('aria-label', '할 일 (← → 로 고르기)');
  actionsFor(r).forEach((a, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `act-btn${i === active ? ' on' : ''}`;
    b.dataset.action = a.id;
    b.tabIndex = -1; // 키보드는 입력 칸에서 ← → 로
    b.title = a.key ? `${a.label} (${a.key})` : a.label;
    b.setAttribute('aria-label', a.label);
    b.setAttribute('aria-pressed', String(i === active));
    b.append(icon(a.id));
    // 고른 단추는 이름도 보인다 (다른 단추는 그림만 — 자리가 좁으니)
    const label = document.createElement('span');
    label.className = 'act-label';
    label.textContent = a.label;
    b.append(label);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 입력 칸 포커스 유지
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onRun(i);
    });
    wrap.append(b);
  });
  return wrap;
}

/**
 * 입력 칸의 키: ← → 단추 옮기기 · 단축키. 처리했으면 { move } 또는 { run: actionId } 를, 아니면 null
 * @param {KeyboardEvent} e
 * @param {{ row: object, active: number, input: HTMLInputElement|HTMLTextAreaElement }} o
 */
export function actionKey(e, { row, active, input }) {
  const acts = actionsFor(row);
  if (!acts.length) return null;
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    const id = k === 'c' ? 'copyPath' : k === 'e' ? 'reveal' : null;
    if (id && acts.some((a) => a.id === id)) return { run: id };
    return null;
  }
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const caretAtEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  if (e.key === 'ArrowRight' && acts.length > 1 && (active > 0 || caretAtEnd)) {
    return { move: Math.min(acts.length - 1, active + 1) };
  }
  if (e.key === 'ArrowLeft' && active > 0) return { move: active - 1 }; // 첫 단추에서는 글자 사이로 (평소처럼)
  return null;
}
