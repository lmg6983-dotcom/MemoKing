// 오른쪽 클릭 메뉴 (모든 창) — Electron 은 직접 만들지 않으면 오른쪽 클릭에 아무것도 뜨지 않는다.
//   누른 곳에 맞는 것만: 맞춤법 후보 · 링크 · 그림 · 글 칸(잘라내기 · 복사 · 붙여넣기 …) · 고른 글 복사
//   목록 카드처럼 화면이 따로 메뉴를 띄우는 곳은 화면이 오른쪽 클릭을 막아(preventDefault) 여기까지 오지 않는다.

/**
 * @param {object} p Electron 'context-menu' 의 params (isEditable, selectionText, editFlags, linkURL, mediaType, srcURL, misspelledWord, dictionarySuggestions)
 * @param {{ openLink: (url: string) => void, copyText: (text: string) => void, copyImage: () => void, saveImage?: (() => void) | null,
 *           replaceMisspelling: (word: string) => void, addToDictionary: (word: string) => void }} act
 * @returns {object[]} Menu.buildFromTemplate 에 넣을 항목 (비었으면 메뉴를 띄우지 않는다)
 */
export function contextMenuTemplate(p, act) {
  const groups = [];
  const flags = p.editFlags ?? {};

  if (p.isEditable && p.misspelledWord) {
    const fixes = (p.dictionarySuggestions ?? []).slice(0, 5).map((w) => ({ label: w, click: () => act.replaceMisspelling(w) }));
    groups.push([
      ...(fixes.length ? fixes : [{ label: '맞춤법 후보 없음', enabled: false }]),
      { label: '사전에 추가', click: () => act.addToDictionary(p.misspelledWord) },
    ]);
  }

  if (/^https?:\/\//i.test(p.linkURL ?? '')) {
    groups.push([
      { label: '링크 열기', click: () => act.openLink(p.linkURL) },
      { label: '링크 주소 복사', click: () => act.copyText(p.linkURL) },
    ]);
  }

  if (p.mediaType === 'image' && p.srcURL) {
    groups.push([
      { label: '그림 복사', click: () => act.copyImage() },
      ...(act.saveImage ? [{ label: '그림 저장…', click: () => act.saveImage() }] : []),
    ]);
  }

  if (p.isEditable) {
    groups.push([
      { label: '잘라내기', role: 'cut', enabled: flags.canCut !== false },
      { label: '복사', role: 'copy', enabled: flags.canCopy !== false },
      { label: '붙여넣기', role: 'paste', enabled: flags.canPaste !== false },
      { label: '서식 없이 붙여넣기', role: 'pasteAndMatchStyle', enabled: flags.canPaste !== false },
    ]);
    groups.push([{ label: '모두 선택', role: 'selectAll', enabled: flags.canSelectAll !== false }]);
  } else if (String(p.selectionText ?? '').trim()) {
    groups.push([{ label: '복사', role: 'copy' }]);
  }

  return groups.flatMap((g, i) => (i ? [{ type: 'separator' }, ...g] : g));
}
