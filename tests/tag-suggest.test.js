import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTagsFor, appendTags } from '../app/js/core/tag-suggest.js';

const memos = [
  { id: 'a', body: '# 주간 회의\n\n프로젝트 일정 회의 안건 정리 #업무 #회의' },
  { id: 'b', body: '# 기획 회의록\n\n출시 일정과 디자인 검토 회의 #업무' },
  { id: 'c', body: '# 장보기\n\n우유 계란 대파 두부 #장보기 #집' },
  { id: 'd', body: '# 마트\n\n두부 우유 사과 #장보기' },
];

test('태그 추천: 본문에 태그 이름이 나오면 확실한 추천', () => {
  const got = suggestTagsFor('# 내일 회의\n\n디자인 검토 회의 준비할 것', memos);
  assert.equal(got[0].name, '회의');
  assert.equal(got[0].reason, 'mention');
  assert.equal(got[0].sure, true);
  assert.ok(got.some((t) => t.name === '업무'));
  assert.ok(!got.some((t) => t.name === '장보기'));
});

test('태그 추천: 내용이 닮은 메모의 태그', () => {
  const got = suggestTagsFor('# 저녁거리\n\n우유 두부 계란 사오기', memos);
  assert.ok(got.slice(0, 2).some((t) => t.name === '장보기'));
  assert.ok(!got.some((t) => t.name === '업무'));
});

test('태그 추천: 이미 단 태그는 빼고, 짧은 메모는 추천 없음', () => {
  assert.deepEqual(suggestTagsFor('짧음', memos), []);
  const got = suggestTagsFor('# 회의 준비\n\n안건 회의 정리 #회의', memos);
  assert.ok(!got.some((t) => t.name === '회의'));
});

test('태그 추천: 쓰는 태그가 없으면 핵심어로', () => {
  const got = suggestTagsFor('# 여행 계획\n\n제주도 여행 숙소 예약 여행 일정', [{ id: 'x', body: '# 다른 메모\n\n아무 내용' }]);
  assert.ok(got.length > 0);
  assert.equal(got[0].reason, 'keyword');
  assert.ok(got.some((t) => t.name === '여행'));
});

test('태그 붙이기: 끝에 태그 줄', () => {
  assert.equal(appendTags('# 제목\n\n본문\n', ['회의', '업무']), '# 제목\n\n본문\n\n#회의 #업무\n');
  assert.equal(appendTags('# 제목\n\n#회의\n', ['업무']), '# 제목\n\n#회의 #업무\n');
});
