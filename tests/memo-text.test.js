import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainLines, extractTitle, parseMemoFile } from '../app/js/core/memo-file.js';
import { shareText } from '../app/js/core/share-text.js';

// 맨주소·이메일은 편집기가 <https://…> 로 저장한다 — 제목·미리보기·검색·보내기 글에서 사라지지 않게
test('읽는 글: 자동 링크 <주소> 는 주소를 남기고, 서식 태그는 글자만', () => {
  assert.deepEqual(plainLines('그리고 <https://naver.com> 맨주소\n이메일 <a@b.com> 과\n<u>밑줄</u> <span style="color: #e5484d">빨강</span>'), ['그리고 https://naver.com 맨주소', '이메일 a@b.com 과', '밑줄 빨강']);
  assert.equal(extractTitle('<https://naver.com>\n\n본문'), 'https://naver.com');
});

test('보내기 글: 자동 링크는 괄호 없이', () => {
  assert.equal(shareText('그리고 <https://naver.com> 맨주소 <mailto:a@b.com> <a@b.com>').trim(), '그리고 https://naver.com 맨주소 a@b.com a@b.com');
});

test('파일 이름: 윈도우에서 만들 수 없거나 목록에서 빠지는 이름을 피한다', async () => {
  const { titleToFileName } = await import('../app/js/core/memo-file.js');
  assert.equal(titleToFileName('CON'), 'CON_');
  assert.equal(titleToFileName('con.txt'), 'con_.txt'); // 점 뒤가 있어도 장치 이름
  assert.equal(titleToFileName('Aux . log'), 'Aux_ . log');
  assert.equal(titleToFileName('console'), 'console');
  assert.equal(titleToFileName('~$임시'), '임시'); // ~$ 는 오피스 임시 파일로 보고 목록에서 뺀다
  assert.equal(titleToFileName('...'), '제목 없음');
  assert.equal(titleToFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(titleToFileName('회의 메모.'), '회의 메모');
});

// 머리말 없이 "---" 구분선으로 시작하는 글: 첫 문단을 머리말로 떼어 내 잃지 않게
test('파일 읽기: 키: 값 이 아닌 "---" 사이 글은 본문', () => {
  assert.equal(parseMemoFile('---\n오늘 회의\n---\n할 일\n').body, '---\n오늘 회의\n---\n할 일\n');
  assert.equal(parseMemoFile('---\ncolor: pink\n---\n본문\n').body, '본문\n');
});
