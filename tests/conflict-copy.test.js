import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictCopyBody, conflictLabel, extractTitle } from '../app/js/core/memo-file.js';

test('동시에 고친 메모: 사본 이름표는 "다른 기기 + 날짜·시각"', () => {
  assert.equal(conflictLabel(new Date(2026, 9, 5, 8, 4)), '다른 기기 10월 5일 08:04');
});

test('동시에 고친 메모: 사본은 제목 줄에 이름표를 붙이고 나머지 내용은 그대로', () => {
  const body = '# 회의 메모\n\n- [ ] 사과\n- [x] 배\n\n끝 #업무';
  const copy = conflictCopyBody(body, '다른 기기 10월 5일 08:04');
  assert.equal(extractTitle(copy), '회의 메모 (다른 기기 10월 5일 08:04)');
  assert.equal(copy.split('\n').slice(1).join('\n'), body.split('\n').slice(1).join('\n'));
});

test('동시에 고친 메모: 제목 줄이 없으면(첫 줄이 그냥 글) 제목 줄을 만든다', () => {
  const copy = conflictCopyBody('\n장보기 목록\n우유', 'L');
  assert.equal(extractTitle(copy), '장보기 목록 (L)');
  assert.ok(copy.includes('\n장보기 목록\n우유'));
});

test('같은 본문 비교: 줄바꿈 방식·끝 공백 차이는 같은 내용', async () => {
  const { sameBody } = await import('../app/js/core/memo-file.js');
  assert.ok(sameBody('# 제목\r\n\r\n내용\n', '# 제목\n\n내용'));
  assert.ok(!sameBody('# 제목\n\n내용', '# 제목\n\n다른 내용'));
});
