import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseNotes, splitSentences, boldParts } from '../app/js/core/release-notes.js';

test('릴리스 노트: 한 덩어리 글을 제목 + 항목 줄로', () => {
  const notes = '**검수 · 화면 다듬기 (PC · 휴대폰)**: PC 에 **오른쪽 클릭 메뉴** (잘라내기·복사), 목록 카드 오른쪽 클릭. **메모가 많을 때 빠르게** (검색 4.6초 → 0.7초 안). 한글 낱말 단위 줄바꿈 등 (휴대폰 0.31.0)';
  assert.deepEqual(parseReleaseNotes(notes), [
    { type: 'head', text: '검수 · 화면 다듬기 (PC · 휴대폰)' },
    { type: 'item', text: 'PC 에 **오른쪽 클릭 메뉴** (잘라내기·복사), 목록 카드 오른쪽 클릭' },
    { type: 'item', text: '**메모가 많을 때 빠르게** (검색 4.6초 → 0.7초 안)' },
    { type: 'item', text: '한글 낱말 단위 줄바꿈 등 (휴대폰 0.31.0)' },
  ]);
});

test('릴리스 노트: 버전 번호 · 단축키 속 마침표에서는 나누지 않음', () => {
  assert.deepEqual(splitSentences('v0.45.0 을 받아요. Ctrl+Z 로 되돌려요. 끝'), ['v0.45.0 을 받아요', 'Ctrl+Z 로 되돌려요', '끝']);
  assert.deepEqual(splitSentences('1.5배 빨라졌어요'), ['1.5배 빨라졌어요']);
});

test('릴리스 노트: 줄바꿈이 있으면 줄마다 · 목록 표시와 링크 · 코드 표시는 벗김', () => {
  const notes = '- 첫째 고침\n* 둘째 [자세히](https://example.com) 고침\n\n`코드` 도 고침';
  assert.deepEqual(parseReleaseNotes(notes).map((b) => b.text), ['첫째 고침', '둘째 자세히 고침', '코드 도 고침']);
});

test('릴리스 노트: 비었거나 제목뿐이면', () => {
  assert.deepEqual(parseReleaseNotes(''), []);
  assert.deepEqual(parseReleaseNotes(undefined), []);
  assert.deepEqual(parseReleaseNotes('**제목만**'), [{ type: 'head', text: '제목만' }]);
});

test('굵은 글 표시 나누기', () => {
  assert.deepEqual(boldParts('앞 **굵게** 뒤'), [{ text: '앞 ', bold: false }, { text: '굵게', bold: true }, { text: ' 뒤', bold: false }]);
  assert.deepEqual(boldParts('그냥 글'), [{ text: '그냥 글', bold: false }]);
});

test('업데이트 뒤 개선된 점: 지난번 버전 다음부터 지금 버전까지, 버전마다 제목 한 줄 (새것부터 5개)', async () => {
  const { versionTitles } = await import('../app/js/core/release-notes.js');
  const readme = [
    '| `v0.68.0` | 2026-10-24 | 3. 개선 | **처음 쓰기가 가벼워졌어요**: 설치 파일을 열면 … |',
    '| `v0.67.0` | 2026-10-24 | 3. 개선 | **AI 화면 다듬기 (UI · UX 리뷰 반영)**: … |',
    '| `v0.63.0` | 2026-10-24 | 4. 기능 | **AI 기본 모델은 카나나2, AI 는 PC 에서만 (휴대폰 0.47.0)**: … |',
    '| `v0.12.0` | 2026-09-30 | 2. 생성 | 메모 스택(제목 없는 옛 행) |',
  ].join('\n');
  assert.deepEqual(versionTitles(readme, '0.66.0', '0.68.0'), [
    { version: '0.68.0', title: '처음 쓰기가 가벼워졌어요' },
    { version: '0.67.0', title: 'AI 화면 다듬기 (UI · UX 리뷰 반영)' },
  ]);
  assert.deepEqual(versionTitles(readme, null, '0.67.0').map((t) => t.title), ['AI 화면 다듬기 (UI · UX 리뷰 반영)', 'AI 기본 모델은 카나나2, AI 는 PC 에서만']);
  assert.deepEqual(versionTitles(readme, '0.68.0', '0.68.0'), []);
  assert.equal(versionTitles(readme, null, '0.68.0', 1).length, 1);
});
