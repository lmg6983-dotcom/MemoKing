import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTagsFor } from '../app/js/core/auto-tags.js';

const memos = [
  { id: 'a', body: '# 주간 회의\n\n프로젝트 일정 회의 안건 #업무 #회의' },
  { id: 'b', body: '# 기획 회의록\n\n출시 일정 디자인 검토 회의 #업무' },
  { id: 'c', body: '# 예전 화면\n\n오류 화면 #스크린샷' },
];

test('화면 캡처: 늘 캡처 태그 (이미 쓰는 같은 뜻 태그로)', () => {
  assert.deepEqual(autoTagsFor('![화면 캡처](attachments/a.png)', memos, { source: 'capture' }), ['스크린샷']);
  assert.deepEqual(autoTagsFor('![화면 캡처](attachments/a.png)', [], { source: 'capture' }), ['캡처']);
});

test('공유받은 글: 내용에 맞는 기존 태그, 없으면 들어온 곳 태그', () => {
  const got = autoTagsFor('# 회의 메모\n\n디자인 검토 회의 정리 내용', memos, { source: 'share' });
  assert.ok(got.includes('회의'));
  assert.ok(!got.includes('공유'));
  assert.deepEqual(autoTagsFor('# 요리\n\n김치찌개 끓이는 법 정리해 둔 것', memos, { source: 'link' }), ['링크']);
});

test('이미 단 태그는 다시 달지 않음', () => {
  assert.deepEqual(autoTagsFor('오류 화면 #스크린샷', memos, { source: 'capture' }), []);
});
