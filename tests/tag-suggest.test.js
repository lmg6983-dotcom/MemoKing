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

test('태그 추천: 뜻이 넓은 흔한 말로는 다른 태그를 확실하다고 하지 않는다 (저절로 엉뚱하게 달리지 않게)', () => {
  const ms = [
    { id: '1', body: '# 오늘\n\n산책하고 일찍 잤다 #일기' },
    { id: '2', body: '# 앱\n\n버그 고치기 #개발' },
    { id: '3', body: '# 주간\n\n월요일 회의 #일정' },
    { id: '4', body: '# 분기\n\n실적 정리 #보고서' },
  ];
  const got = suggestTagsFor('# 가게 정산\n\n하루 매출 정리하고 할인 코드 계획 세우기, 영화를 보고 쉬기', ms);
  for (const name of ['일기', '개발', '일정', '보고서']) assert.ok(!got.some((t) => t.name === name && t.sure), `${name}: ${JSON.stringify(got)}`);
});

test('unescapeTags: 줄 맨 앞 띄어쓰기를 버리고 태그를 살린다 (" #할일" → "#할일")', async () => {
  const { unescapeTags } = await import('../app/js/core/tags.js');
  assert.equal(unescapeTags('&#x20;\\#할일'), '#할일');
  assert.equal(unescapeTags('- [ ] &#x20;\\#장보기'), '- [ ] #장보기');
  assert.equal(unescapeTags('> &#x20;글'), '> 글');
  assert.equal(unescapeTags('가운데 &#x20; 그대로'), '가운데 &#x20; 그대로');
});

test('새 태그 핵심어에 움직임·꾸밈 말과 조사 붙은 말은 안 나옴', () => {
  const names = (body) => suggestTagsFor(body, []).map((t) => t.name);
  const bad = ['pc에서고침', '가서', '멋졌다', '읽은', '빠른', '재미있었고', '폰에서'];
  for (const body of ['# 출장\n\n부산으로 출장 가서 거래처를 만났다. 서울에서 기차 타고', '# 독후감\n\n어제 읽은 책은 정말 재미있었고 주인공이 멋졌다', '# 매직 카피\n\n급하게 PC에서 고침 폰에서도 확인했어요', '# 매직 카피\n\n급하게 PC에서고침 폰에서도 확인했어요']) {
    const got = names(body);
    assert.ok(!got.some((n) => bad.includes(n)), `${body.split('\n')[0]} → ${got}`);
  }
  assert.deepEqual(names('# 출장\n\n부산으로 출장 가서 거래처를 만났다. 서울에서 기차 타고').slice(0, 2), ['출장', '거래처']);
});

test('태그 추천: 웹 주소 속 낱말(example.com 의 com 등)은 추천하지 않음', () => {
  const body = '# 긴 낱말\n\nhttps://example.com/aaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb 와 https://www.example.com/menu 가나다라마바사아자차카타파하';
  const got = suggestTagsFor(body, memos).map((t) => t.name);
  for (const bad of ['com', 'example', 'www', 'restaurant', 'menu', 'https']) assert.ok(!got.includes(bad), `${bad} 가 추천됨: ${got}`);
});
