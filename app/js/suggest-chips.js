// 빈 메모 안내 문구 · 추천 태그 칩 — PC 메모 창과 휴대폰 메모 화면이 같이 쓴다

/**
 * 빈 메모 안내 문구: 편집기 내용이 바뀌는 즉시 끄고 켠다. 한글 조합 중에는 글자가 아직 문서에 안 들어왔어도 끈다.
 * @returns {(empty?: boolean) => void} 편집기의 onEmpty 로 넘길 함수 (인자 없이 부르면 지금 상태로 다시)
 */
export function trackPlaceholder(root) {
  let docEmpty = true;
  let composing = false;
  const show = (empty = docEmpty) => {
    docEmpty = empty;
    root.classList.toggle('is-empty', empty && !composing);
  };
  root.addEventListener('compositionstart', () => {
    composing = true;
    show();
  });
  root.addEventListener('compositionend', () => {
    composing = false;
    show();
  });
  root.addEventListener('beforeinput', (e) => {
    if (e.inputType.startsWith('insert') && docEmpty) root.classList.remove('is-empty');
  });
  return show;
}

const plainChip = (name, onClick) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tag-chip';
  b.textContent = `+ #${name}`;
  b.addEventListener('click', onClick);
  return b;
};

/**
 * 추천 태그 칩을 채운다: 확실한 것(sure)·새 태그(new) 표시, 둘 이상이면 "모두 달기"
 * @param {HTMLElement} box
 * @param {{name: string, sure?: boolean, existing?: boolean, why?: string}[]} list
 * @param {(names: string[]) => void} addTags
 * @param {(name: string, onClick: () => void) => HTMLElement} [makeChip]
 */
export function fillSuggestChips(box, list, addTags, makeChip = plainChip) {
  box.replaceChildren(...list.map((t) => {
    const b = makeChip(t.name, () => addTags([t.name]));
    b.classList.toggle('sure', Boolean(t.sure));
    b.classList.toggle('new', !t.existing);
    if (t.why) b.title = t.why;
    return b;
  }));
  if (list.length > 1) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'link-btn';
    all.textContent = '모두 달기';
    all.addEventListener('click', () => addTags(list.map((t) => t.name)));
    box.append(all);
  }
}
