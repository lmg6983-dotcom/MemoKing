import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainLines, extractTitle } from '../app/js/core/memo-file.js';
import { shareText } from '../app/js/core/share-text.js';

// 맨주소·이메일은 편집기가 <https://…> 로 저장한다 — 제목·미리보기·검색·보내기 글에서 사라지지 않게
test('읽는 글: 자동 링크 <주소> 는 주소를 남기고, 서식 태그는 글자만', () => {
  assert.deepEqual(plainLines('그리고 <https://naver.com> 맨주소\n이메일 <a@b.com> 과\n<u>밑줄</u> <span style="color: #e5484d">빨강</span>'), ['그리고 https://naver.com 맨주소', '이메일 a@b.com 과', '밑줄 빨강']);
  assert.equal(extractTitle('<https://naver.com>\n\n본문'), 'https://naver.com');
});

test('보내기 글: 자동 링크는 괄호 없이', () => {
  assert.equal(shareText('그리고 <https://naver.com> 맨주소 <mailto:a@b.com> <a@b.com>').trim(), '그리고 https://naver.com 맨주소 a@b.com a@b.com');
});
