import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareText } from '../app/js/core/share-text.js';
import { looksLikeMarkdown, importText, normalizeMath, stripFrontMatter, isTextDocument } from '../app/js/core/markdown-import.js';

test('보내기 글: 목록 서식이 보이는 모양 그대로 (점·번호·체크리스트·하위 항목)', () => {
  const md = '# 장보기\n\n- [ ] 우유\n- [x] 계란\n  - [ ] 대파\n\n1. 첫째\n2. 둘째\n   - 하위\n\n- 점 **굵게** <u>밑줄</u>\n';
  assert.equal(shareText(md), '장보기\n\n☐ 우유\n☑ 계란\n  ☐ 대파\n\n1. 첫째\n2. 둘째\n  • 하위\n\n• 점 굵게 밑줄');
});

test('보내기 글: 번호는 이어지고, 링크·카드·사진·표', () => {
  const md = '3. 셋\n1. 넷\n\n[구글](https://google.com) · [https://a.com](https://a.com "미리보기")\n\n![로고](attachments/a.png)\n\n| 품목 | 값 |\n| --- | --- |\n| 사과 | 1 |\n';
  assert.equal(shareText(md), '3. 셋\n4. 넷\n\n구글 (https://google.com) · https://a.com\n\n[사진 로고]\n\n품목 | 값\n사과 | 1');
});

test('보내기 글: 느슨한 목록(항목 사이 빈 줄)은 붙이고, 이스케이프는 푼다', () => {
  assert.equal(shareText('- 하나\n\n- 둘\n\n가격 \\$5 \\#아님'), '• 하나\n• 둘\n\n가격 $5 #아님');
});

test('보내기 글: 수식·인용·코드', () => {
  assert.equal(shareText('> 출처: 카톡\n\n$$x^2$$ 끝\n\n$$\n\\int x\n$$\n\n```\n- 코드\n```'), '│ 출처: 카톡\n\n$x^2$ 끝\n\n\\int x\n\n- 코드');
});

test('마크다운 알아보기', () => {
  assert.equal(looksLikeMarkdown('## 회의록\n내용'), true);
  assert.equal(looksLikeMarkdown('- 하나\n- 둘'), true);
  assert.equal(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), true);
  assert.equal(looksLikeMarkdown('**중요** [링크](https://a.com)'), true);
  assert.equal(looksLikeMarkdown('그냥 글이에요\n다음 줄'), false);
  assert.equal(looksLikeMarkdown('#태그 하나'), false);
  assert.equal(looksLikeMarkdown('가격은 $5 이고 - 표시'), false);
});

test('가져오기: 그냥 글은 줄마다 문단, 기호는 그대로 보이게', () => {
  assert.deepEqual(importText('첫 줄\n둘째 줄'), { markdown: '첫 줄\n\n둘째 줄', isMarkdown: false });
  assert.equal(importText('1. 그냥 번호처럼 보이는 줄').markdown, '1\\. 그냥 번호처럼 보이는 줄');
  assert.equal(importText('#태그 그대로\n둘').markdown, '#태그 그대로\n\n둘');
  assert.equal(importText('# 회의\n- 하나\n- 둘').isMarkdown, true);
  assert.equal(importText('# 회의\n- 하나\n- 둘').markdown, '# 회의\n- 하나\n- 둘');
});

test('가져오기: 다른 곳의 수식 표기를 $$ 로', () => {
  assert.equal(normalizeMath('넓이는 \\(\\pi r^2\\) 이고 $a+b$ 와 $5, $10'), '넓이는 $$\\pi r^2$$ 이고 $$a+b$$ 와 $5, $10');
  assert.equal(normalizeMath('식:\n\\[\nE = mc^2\n\\]\n끝'), '식:\n$$\nE = mc^2\n$$\n끝');
  assert.equal(normalizeMath('`$a$` 그대로'), '`$a$` 그대로');
  assert.equal(normalizeMath('$$x$$ 그대로'), '$$x$$ 그대로');
});

test('.md 파일: 머리말 빼기', () => {
  assert.equal(stripFrontMatter('---\nid: 1\n---\n# 제목\n본문'), '# 제목\n본문');
  assert.equal(isTextDocument('노트.md'), true);
  assert.equal(isTextDocument('a.bin', 'text/markdown'), true);
  assert.equal(isTextDocument('a.pdf', 'application/pdf'), false);
});
