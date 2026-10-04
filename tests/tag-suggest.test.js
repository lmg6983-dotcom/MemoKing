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

test('기존 태그와 정합성: 대소문자·같은 뜻·회의록↔회의·오타는 기존 태그로', async () => {
  const { matchExisting } = await import('../app/js/core/tag-suggest.js');
  const existing = [{ name: 'MemoKing', count: 3 }, { name: '회의', count: 5 }, { name: '장보기', count: 2 }, { name: '프로젝트', count: 2 }];
  assert.equal(matchExisting('memoking', existing).name, 'MemoKing');
  assert.equal(matchExisting('미팅', existing).name, '회의');
  assert.equal(matchExisting('회의록', existing).name, '회의');
  assert.equal(matchExisting('쇼핑', existing).name, '장보기');
  assert.equal(matchExisting('프로잭트', existing).name, '프로젝트');
  assert.equal(matchExisting('여행', existing), null);
});

test('태그 추천: 같은 뜻의 말이 나오면 새 태그 대신 기존 태그', () => {
  const got = suggestTagsFor('# 거래처 미팅\n\n다음 분기 계획 미팅 메모', memos);
  const hit = got.find((t) => t.name === '회의');
  assert.ok(hit);
  assert.equal(hit.existing, true);
  assert.ok(!got.some((t) => t.name === '미팅'));
});

test('태그 추천: 함께 다는 태그', () => {
  const ms = [
    { id: '1', body: '# 가\n\n견적 정리 #고객 #계약' },
    { id: '2', body: '# 나\n\n발주 요청 #고객 #계약' },
    { id: '3', body: '# 다\n\n방문 일정 #고객 #계약' },
  ];
  const got = suggestTagsFor('# 새 고객 응대\n\n고객 문의 응대 내역 기록', ms);
  assert.equal(got[0].name, '고객');
  assert.ok(got.some((t) => t.name === '계약'));
});
