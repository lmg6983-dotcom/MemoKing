import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextMenuTemplate } from '../desktop/context-menu.js';

const calls = [];
const act = {
  openLink: (u) => calls.push(['open', u]),
  copyText: (t) => calls.push(['copy', t]),
  copyImage: () => calls.push(['copyImage']),
  saveImage: () => calls.push(['saveImage']),
  replaceMisspelling: (w) => calls.push(['fix', w]),
  addToDictionary: (w) => calls.push(['dict', w]),
};
const labels = (t) => t.map((i) => i.type === 'separator' ? '—' : i.label);

test('오른쪽 클릭: 글 칸에서는 잘라내기 · 복사 · 붙여넣기 · 모두 선택', () => {
  const t = contextMenuTemplate({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }, act);
  assert.deepEqual(labels(t), ['잘라내기', '복사', '붙여넣기', '서식 없이 붙여넣기', '—', '모두 선택']);
  assert.equal(t[0].enabled, false); // 고른 글이 없으면 잘라내기는 흐리게
  assert.equal(t[2].role, 'paste');
  assert.equal(t[2].accelerator, 'CmdOrCtrl+V'); // 메뉴에 단축키 안내
  assert.equal(t[2].registerAccelerator, false);
});

test('오른쪽 클릭: 링크 위면 링크 열기 · 주소 복사 (http · https 만)', () => {
  calls.length = 0;
  const t = contextMenuTemplate({ isEditable: true, linkURL: 'https://example.com/a', editFlags: {} }, act);
  assert.deepEqual(labels(t).slice(0, 3), ['링크 열기', '링크 주소 복사', '—']);
  t[1].click();
  assert.deepEqual(calls, [['copy', 'https://example.com/a']]);
  assert.ok(!labels(contextMenuTemplate({ linkURL: 'javascript:alert(1)' }, act)).includes('링크 열기'));
});

test('오른쪽 클릭: 그림 위면 그림 복사 · 저장 (저장할 수 없으면 복사만)', () => {
  assert.deepEqual(labels(contextMenuTemplate({ mediaType: 'image', srcURL: 'memoking://vault/a.png' }, act)), ['그림 복사', '그림 저장…']);
  assert.deepEqual(labels(contextMenuTemplate({ mediaType: 'image', srcURL: 'https://x/a.png' }, { ...act, saveImage: null })), ['그림 복사']);
});

test('오른쪽 클릭: 맞춤법 밑줄이면 후보 · 사전에 추가가 맨 위', () => {
  calls.length = 0;
  const t = contextMenuTemplate({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], editFlags: {} }, act);
  assert.deepEqual(labels(t).slice(0, 4), ['the', 'ten', '사전에 추가', '—']);
  t[0].click();
  assert.deepEqual(calls, [['fix', 'the']]);
});

test('오른쪽 클릭: 글을 고르지 않은 보통 화면은 메뉴 없음 · 고른 글은 복사만', () => {
  assert.equal(contextMenuTemplate({}, act).length, 0);
  assert.deepEqual(labels(contextMenuTemplate({ selectionText: '안녕' }, act)), ['복사']);
});

test('오른쪽 클릭: 메모 편집기는 서식 없이 붙여넣기 · 서식 지우기를 직접 한다', () => {
  calls.length = 0;
  const mine = { ...act, pastePlain: () => calls.push(['plain']), clearFormat: () => calls.push(['clear']) };
  const t = contextMenuTemplate({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } }, mine);
  assert.deepEqual(labels(t), ['잘라내기', '복사', '붙여넣기', '서식 없이 붙여넣기', '—', '서식 지우기', '—', '모두 선택']);
  const plain = t.find((i) => i.label === '서식 없이 붙여넣기');
  assert.equal(plain.role, undefined); // 창의 기본 붙여넣기가 아니라 편집기가
  assert.equal(plain.accelerator, 'CmdOrCtrl+Shift+V');
  plain.click();
  t.find((i) => i.label === '서식 지우기').click();
  assert.deepEqual(calls, [['plain'], ['clear']]);
  // 편집기가 아닌 창은 서식 지우기가 없고 서식 없이 붙여넣기는 창 기본 동작
  const other = contextMenuTemplate({ isEditable: true, editFlags: {} }, act);
  assert.ok(!labels(other).includes('서식 지우기'));
  assert.equal(other.find((i) => i.label === '서식 없이 붙여넣기').role, 'pasteAndMatchStyle');
});
